import { describe, expect, it } from 'vitest';
import {
  AssistantEntitiesConfigSchema,
  AssistantEntitiesMqttAdapter,
  type AssistantCommand,
  type AssistantEntitiesConfig,
} from '../src/adapters/assistant-entities-mqtt.js';
import type { RoomState } from '../src/core/schemas.js';

type Handler = (
  topic: string,
  payload: unknown,
  metadata: { retain: boolean },
) => void;

class FakeMqtt {
  readonly handlers = new Map<string, Handler>();
  readonly published: Array<{
    topic: string;
    payload: string;
    retain: boolean;
  }> = [];
  failPublish = false;

  subscribe(topic: string, _options: { qos: 0 | 1 }, onMessage: Handler) {
    this.handlers.set(topic, onMessage);
    return () => this.handlers.delete(topic);
  }

  publish(
    topic: string,
    payload: string,
    options: { qos: 1; retain: boolean },
  ): Promise<void> {
    if (this.failPublish) return Promise.reject(new Error('offline'));
    this.published.push({ topic, payload, retain: options.retain });
    return Promise.resolve();
  }

  send(topic: string, payload: string, retain = false): void {
    this.handlers.get(topic)?.(topic, Buffer.from(payload), { retain });
  }

  last(topic: string): string | undefined {
    return this.published.filter((entry) => entry.topic === topic).at(-1)
      ?.payload;
  }
}

type Lamp = { power?: boolean; brightness?: number };

function room(
  devices: Record<string, { observed?: Lamp; desired?: Lamp }>,
  currentScene: string | null = null,
): RoomState {
  return {
    lighting: {
      currentScene,
      sceneRevision: 1,
      devices: Object.fromEntries(
        Object.entries(devices).map(([id, device]) => [
          id,
          {
            observed: device.observed ?? {},
            baselineDesired: device.desired ?? {},
            effectiveDesired: device.desired ?? {},
          },
        ]),
      ),
    },
  } as unknown as RoomState;
}

const CONFIG: AssistantEntitiesConfig = {
  lights: [{ id: 'taklampan', name: 'Taklampan', target: 'lighting.ceiling' }],
  scenes: [
    { id: 'mysljus', name: 'Mysljus', sceneId: 'scene.soft_light' },
    { id: 'fokus', name: 'Fokus', sceneId: 'scene.focus_light' },
  ],
  room: {
    id: 'belysningen',
    name: 'Belysningen',
    onSceneId: 'scene.everyday_light',
  },
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(initial: RoomState) {
  const mqtt = new FakeMqtt();
  const calls: AssistantCommand[] = [];
  let state = initial;
  const warnings: string[] = [];
  const adapter = new AssistantEntitiesMqttAdapter({
    config: CONFIG,
    mqtt,
    getState: () => state,
    invoke: (command) => {
      calls.push(command);
      return Promise.resolve({});
    },
    onWarning: (message) => warnings.push(message),
  });
  return {
    mqtt,
    calls,
    adapter,
    warnings,
    setState(next: RoomState) {
      state = next;
    },
  };
}

describe('AssistantEntitiesMqttAdapter', () => {
  it('announces discovery, state and availability on connect', async () => {
    const { mqtt, adapter } = setup(
      room(
        {
          'lighting.ceiling': { observed: { power: true, brightness: 40 } },
          'lighting.desk': { observed: { power: false } },
        },
        'scene.soft_light',
      ),
    );
    adapter.setBrokerConnected(true);
    await settle();

    const light = JSON.parse(
      mqtt.last('homeassistant/light/lugn_assistant_taklampan/config')!,
    );
    expect(light).toMatchObject({
      unique_id: 'lugn_assistant_taklampan',
      default_entity_id: 'light.lugn_taklampan',
      command_topic: 'lugn/assistant/taklampan/set',
      state_topic: 'lugn/assistant/taklampan/state',
      availability_topic: 'lugn/assistant/availability',
      schema: 'json',
      supported_color_modes: ['brightness'],
      brightness_scale: 100,
      optimistic: false,
      device: { name: 'Taklampan' },
    });
    expect(
      JSON.parse(
        mqtt.last('homeassistant/switch/lugn_assistant_mysljus/config')!,
      ),
    ).toMatchObject({ payload_on: 'ON', payload_off: 'OFF' });
    expect(
      JSON.parse(
        mqtt.last('homeassistant/light/lugn_assistant_belysningen/config')!,
      ),
    ).toMatchObject({ supported_color_modes: ['onoff'] });

    expect(JSON.parse(mqtt.last('lugn/assistant/taklampan/state')!)).toEqual({
      state: 'ON',
      color_mode: 'brightness',
      brightness: 40,
    });
    expect(mqtt.last('lugn/assistant/mysljus/state')).toBe('ON');
    expect(mqtt.last('lugn/assistant/fokus/state')).toBe('OFF');
    expect(JSON.parse(mqtt.last('lugn/assistant/belysningen/state')!)).toEqual({
      state: 'ON',
      color_mode: 'onoff',
    });
    // Availability last, so Home Assistant never shows entities without state.
    expect(mqtt.published.at(-1)).toEqual({
      topic: 'lugn/assistant/availability',
      payload: 'online',
      retain: true,
    });
    expect(mqtt.published.every((entry) => entry.retain)).toBe(true);
  });

  it('turns light commands into lighting.set', async () => {
    const { mqtt, adapter, calls } = setup(
      room({ 'lighting.ceiling': { observed: { power: false } } }),
    );
    adapter.setBrokerConnected(true);
    mqtt.send('lugn/assistant/taklampan/set', '{"state":"ON"}');
    mqtt.send(
      'lugn/assistant/taklampan/set',
      '{"state":"ON","brightness":30.4}',
    );
    mqtt.send(
      'lugn/assistant/taklampan/set',
      '{"state":"OFF","brightness":30}',
    );
    mqtt.send('lugn/assistant/taklampan/set', '{"state":"ON","brightness":0}');
    await settle();
    expect(calls).toEqual([
      {
        capability: 'lighting.set',
        input: { target: 'lighting.ceiling', values: { power: true } },
      },
      {
        capability: 'lighting.set',
        input: {
          target: 'lighting.ceiling',
          values: { power: true, brightness: 30 },
        },
      },
      {
        capability: 'lighting.set',
        input: { target: 'lighting.ceiling', values: { power: false } },
      },
      {
        capability: 'lighting.set',
        input: {
          target: 'lighting.ceiling',
          values: { power: true, brightness: 1 },
        },
      },
    ]);
  });

  it('ignores retained, malformed and oversized commands', async () => {
    const { mqtt, adapter, calls } = setup(room({}));
    adapter.setBrokerConnected(true);
    mqtt.send('lugn/assistant/taklampan/set', '{"state":"ON"}', true);
    mqtt.send('lugn/assistant/taklampan/set', 'ON');
    mqtt.send('lugn/assistant/taklampan/set', '{"state":"on"}');
    mqtt.send('lugn/assistant/mysljus/set', '{"state":"ON"}');
    mqtt.send('lugn/assistant/mysljus/set', `ON${' '.repeat(2000)}`);
    await settle();
    expect(calls).toEqual([]);
  });

  it('activates a scene and turns off only the current scene', async () => {
    const { mqtt, adapter, calls } = setup(
      room(
        { 'lighting.ceiling': { observed: { power: true } } },
        'scene.focus_light',
      ),
    );
    adapter.setBrokerConnected(true);
    mqtt.send('lugn/assistant/mysljus/set', 'ON');
    mqtt.send('lugn/assistant/mysljus/set', 'OFF');
    mqtt.send('lugn/assistant/fokus/set', 'OFF');
    await settle();
    expect(calls).toEqual([
      {
        capability: 'lighting.activateScene',
        input: { sceneId: 'scene.soft_light' },
      },
      {
        capability: 'lighting.activateScene',
        input: { sceneId: 'scene.all_off' },
      },
    ]);
  });

  it('lights the room only when everything is off', async () => {
    const lit = room({
      'lighting.ceiling': { observed: { power: false } },
      'lighting.desk': { observed: { power: true } },
    });
    const { mqtt, adapter, calls, setState } = setup(lit);
    adapter.setBrokerConnected(true);
    mqtt.send('lugn/assistant/belysningen/set', '{"state":"ON"}');
    await settle();
    expect(calls).toEqual([]);

    setState(
      room({
        'lighting.ceiling': { observed: { power: false } },
        'lighting.desk': { observed: { power: false } },
      }),
    );
    mqtt.send('lugn/assistant/belysningen/set', '{"state":"ON"}');
    mqtt.send('lugn/assistant/belysningen/set', '{"state":"OFF"}');
    await settle();
    expect(calls).toEqual([
      {
        capability: 'lighting.activateScene',
        input: { sceneId: 'scene.everyday_light' },
      },
      {
        capability: 'lighting.activateScene',
        input: { sceneId: 'scene.all_off' },
      },
    ]);
  });

  it('does not light the room when a light state is unknown', async () => {
    const { mqtt, adapter, calls } = setup(
      room({
        'lighting.ceiling': {},
        'lighting.desk': { observed: { power: false } },
      }),
    );
    adapter.setBrokerConnected(true);
    mqtt.send('lugn/assistant/belysningen/set', '{"state":"ON"}');
    await settle();
    expect(calls).toEqual([]);
    expect(JSON.parse(mqtt.last('lugn/assistant/belysningen/state')!)).toEqual({
      state: null,
    });
  });

  it('answers a no-op command with the current state', async () => {
    const { mqtt, adapter } = setup(
      room(
        { 'lighting.ceiling': { observed: { power: true } } },
        'scene.focus_light',
      ),
    );
    adapter.setBrokerConnected(true);
    await settle();
    const before = mqtt.published.length;
    mqtt.send('lugn/assistant/mysljus/set', 'OFF');
    await settle();
    expect(mqtt.published.slice(before)).toEqual([
      { topic: 'lugn/assistant/mysljus/state', payload: 'OFF', retain: true },
    ]);
  });

  it('publishes only changed states and republishes everything after a reconnect', async () => {
    const { mqtt, adapter, setState } = setup(
      room({ 'lighting.ceiling': { observed: { power: false } } }),
    );
    adapter.setBrokerConnected(true);
    await settle();
    const before = mqtt.published.length;
    adapter.observe();
    await settle();
    expect(mqtt.published.length).toBe(before);

    setState(
      room(
        { 'lighting.ceiling': { observed: { power: true } } },
        'scene.soft_light',
      ),
    );
    adapter.observe();
    await settle();
    expect(mqtt.published.slice(before).map((entry) => entry.topic)).toEqual([
      'lugn/assistant/taklampan/state',
      'lugn/assistant/mysljus/state',
      'lugn/assistant/belysningen/state',
    ]);

    adapter.setBrokerConnected(false);
    adapter.setBrokerConnected(true);
    await settle();
    expect(mqtt.last('lugn/assistant/taklampan/state')).toBeDefined();
    expect(mqtt.published.at(-1)?.payload).toBe('online');
  });

  it('falls back to intent until the lamp reports', async () => {
    const { mqtt, adapter } = setup(
      room({
        'lighting.ceiling': { desired: { power: true, brightness: 55 } },
      }),
    );
    adapter.setBrokerConnected(true);
    await settle();
    expect(JSON.parse(mqtt.last('lugn/assistant/taklampan/state')!)).toEqual({
      state: 'ON',
      color_mode: 'brightness',
      brightness: 55,
    });
  });

  it('reports a failed command and keeps serving later ones', async () => {
    const mqtt = new FakeMqtt();
    const warnings: string[] = [];
    const calls: AssistantCommand[] = [];
    const adapter = new AssistantEntitiesMqttAdapter({
      config: CONFIG,
      mqtt,
      getState: () => room({}),
      invoke: (command) => {
        calls.push(command);
        return calls.length === 1
          ? Promise.reject(new Error('scene_not_found'))
          : Promise.resolve({});
      },
      onWarning: (message) => warnings.push(message),
    });
    adapter.setBrokerConnected(true);
    mqtt.send('lugn/assistant/mysljus/set', 'ON');
    mqtt.send('lugn/assistant/fokus/set', 'ON');
    await settle();
    expect(calls).toHaveLength(2);
    expect(warnings).toEqual(['Assistant command for mysljus failed']);
  });

  it('marks the entities offline on stop and stops listening', async () => {
    const { mqtt, adapter, calls } = setup(room({}));
    adapter.setBrokerConnected(true);
    await settle();
    await adapter.stop();
    expect(mqtt.published.at(-1)).toEqual({
      topic: 'lugn/assistant/availability',
      payload: 'offline',
      retain: true,
    });
    expect(mqtt.handlers.size).toBe(0);
    mqtt.send('lugn/assistant/mysljus/set', 'ON');
    await settle();
    expect(calls).toEqual([]);
  });

  it('rejects duplicate entity IDs', () => {
    expect(
      AssistantEntitiesConfigSchema.safeParse({
        lights: [{ id: 'tak', name: 'Tak', target: 'lighting.ceiling' }],
        scenes: [{ id: 'tak', name: 'Tak', sceneId: 'scene.soft_light' }],
      }).success,
    ).toBe(false);
  });
});
