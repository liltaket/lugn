import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HomeAssistantLightingAdapter } from '../src/adapters/home-assistant-lighting.js';
import type {
  HomeAssistantSocket,
  HomeAssistantSocketMessageEvent,
} from '../src/adapters/home-assistant-websocket.js';
import type {
  Stl27lMqttMessageMetadata,
  Stl27lPresenceMqttSubscriber,
} from '../src/adapters/stl27l-mqtt-presence.js';
import { startRuntime } from '../src/runtime/main.js';
import type { MqttSubscriberStatus } from '../src/runtime/mqttjs-subscriber.js';
import type { StateUpdate } from '../src/core/schemas.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import {
  ComputerPlaybackCommandSchema,
  ComputerPlaybackStateSchema,
  type ComputerPlaybackCommand,
} from '../src/adapters/computer-playback-mqtt.js';

type MqttMessageHandler = (
  topic: string,
  payload: unknown,
  metadata: Stl27lMqttMessageMetadata,
) => void;

class FakeMqttSubscriber implements Stl27lPresenceMqttSubscriber {
  private readonly handlers = new Map<string, Set<MqttMessageHandler>>();
  private readonly statusListeners = new Set<
    (status: MqttSubscriberStatus) => void
  >();
  status: MqttSubscriberStatus = 'stopped';
  onStart: (() => void) | undefined;
  readonly publications: Array<{
    topic: string;
    payload: string;
    options: { qos: 1; retain: false };
  }> = [];
  onPublish: ((command: ComputerPlaybackCommand) => void) | undefined;

  async publish(
    topic: string,
    payload: string,
    options: { qos: 1; retain: false },
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.status !== 'connected' || signal?.aborted)
      throw new Error('Fake MQTT publication unavailable');
    this.publications.push({ topic, payload, options });
    // Broker messages arrive after publish returns to the controller.
    await Promise.resolve();
    this.onPublish?.(ComputerPlaybackCommandSchema.parse(JSON.parse(payload)));
  }

  subscribe(
    topic: string,
    _options: { qos: 0 | 1 },
    onMessage: MqttMessageHandler,
  ): () => void {
    const topicHandlers = this.handlers.get(topic) ?? new Set();
    topicHandlers.add(onMessage);
    this.handlers.set(topic, topicHandlers);
    return () => {
      topicHandlers.delete(onMessage);
      if (topicHandlers.size === 0) this.handlers.delete(topic);
    };
  }

  onStatus(listener: (status: MqttSubscriberStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  start(): void {
    this.setStatus('connected');
    this.onStart?.();
  }

  async stop(): Promise<void> {
    this.setStatus('stopped');
    this.handlers.clear();
  }

  emit(topic: string, payload: unknown, retain: boolean): void {
    for (const handler of this.handlers.get(topic) ?? [])
      handler(topic, payload, { retain });
  }

  private setStatus(status: MqttSubscriberStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

class InertHomeAssistantSocket implements HomeAssistantSocket {
  readonly sent: string[] = [];
  private readonly messages: Array<
    (event: HomeAssistantSocketMessageEvent) => void
  > = [];
  addEventListener(
    type: 'message',
    listener: (event: HomeAssistantSocketMessageEvent) => void,
  ): void;
  addEventListener(type: 'close' | 'error', listener: () => void): void;
  addEventListener(
    type: 'message' | 'close' | 'error',
    listener: ((event: HomeAssistantSocketMessageEvent) => void) | (() => void),
  ): void {
    if (type === 'message')
      this.messages.push(
        listener as (event: HomeAssistantSocketMessageEvent) => void,
      );
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}

  receive(message: unknown): void {
    for (const listener of this.messages)
      listener({ data: JSON.stringify(message) });
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('composed runtime integration', () => {
  it('routes manual Optical pause and resume through targeted computer MQTT while preserving physical HA observation and streaming intent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.parse('2026-10-04T12:00:00+02:00');
    vi.setSystemTime(now);
    const directory = await mkdtemp(
      join(tmpdir(), 'lugn-runtime-computer-control-'),
    );
    const configPath = join(directory, 'runtime.json');
    vi.stubEnv('LUGN_TEST_HA_TOKEN', 'test-ha-token');
    vi.stubEnv('LUGN_TEST_MQTT_USERNAME', 'test-mqtt-user');
    vi.stubEnv('LUGN_TEST_MQTT_PASSWORD', 'test-mqtt-password');
    const mqtt = new FakeMqttSubscriber();
    const socket = new InertHomeAssistantSocket();
    const requests: string[] = [];
    let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
    const control = ComputerPlaybackStateSchema.parse(
      JSON.parse(
        readFileSync(
          new URL(
            './fixtures/computer-control/control-state.example.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ),
    );
    control.device_id = 'kuffe';
    control.timestamp_ms = now;
    const player = control.players[0]!;
    player.playback_status = 'Playing';
    player.pause_lease = null;
    const token = '66666666-6666-4666-8666-666666666666';
    const root = 'lugn/computers/kuffe';
    const publishState = () =>
      mqtt.emit(`${root}/control/state`, JSON.stringify(control), false);
    mqtt.onPublish = (command) => {
      const paused = command.action === 'pause';
      player.playback_status = paused ? 'Paused' : 'Playing';
      player.pause_lease = paused
        ? {
            pause_command_id: command.command_id,
            resume_token: token,
            expires_at_ms: now + command.lease_ttl_ms!,
          }
        : null;
      control.sequence++;
      publishState();
      mqtt.emit(
        `${root}/control/ack`,
        JSON.stringify({
          schema_version: 1,
          device_id: command.device_id,
          session_id: command.session_id,
          connection_id: command.connection_id,
          command_id: command.command_id,
          action: command.action,
          player: command.player,
          player_instance_id: command.player_instance_id,
          content_id: command.content_id,
          timestamp_ms: now,
          outcome: 'applied',
          reason: paused ? 'paused' : 'resumed',
          resume_token: paused ? token : null,
          lease_expires_at_ms: player.pause_lease?.expires_at_ms ?? null,
        }),
        false,
      );
    };
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          http: { host: '127.0.0.1', port: await findEphemeralLoopbackPort() },
          homeAssistant: {
            baseUrl: 'http://home-assistant.invalid:8123',
            tokenEnv: 'LUGN_TEST_HA_TOKEN',
            entities: { 'lighting.entry': 'light.entry' },
            music: {
              'music.room': {
                entityId: 'media_player.room',
                computerAudio: {
                  deviceId: 'kuffe',
                  source: 'Optical In',
                  playbackControl: true,
                },
              },
            },
          },
          mqtt: {
            url: 'mqtt://mqtt.invalid:1883',
            usernameEnv: 'LUGN_TEST_MQTT_USERNAME',
            passwordEnv: 'LUGN_TEST_MQTT_PASSWORD',
            computers: [{ deviceId: 'kuffe' }],
          },
          scenes: [],
        }),
      );
      runtime = await startRuntime(configPath, {
        lightingIntentPath: join(directory, 'state.json'),
        createMqttSubscriber: () => mqtt,
        createHomeAssistantSocket: () => socket,
        homeAssistantFetch: async (input) => {
          const url = String(input);
          requests.push(url);
          return url.endsWith('/api/states')
            ? Response.json([
                {
                  entity_id: 'media_player.room',
                  state: 'playing',
                  attributes: {
                    volume_level: 0.3,
                    source: 'Optical In',
                    media_title: '4',
                  },
                  last_updated: new Date(now).toISOString(),
                  last_changed: new Date(now).toISOString(),
                },
              ])
            : new Response(null, { status: 200 });
        },
      });
      socket.receive({ type: 'auth_required' });
      socket.receive({ type: 'auth_ok' });
      const subscription = JSON.parse(socket.sent.at(-1)!) as { id: number };
      socket.receive({ type: 'result', id: subscription.id, success: true });
      // Complete the subscription's HTTP reconciliation before issuing control.
      for (let i = 0; i < 30; i++) await Promise.resolve();
      expect(
        requests.filter((url) => url.endsWith('/api/states')),
      ).toHaveLength(2);
      const observation = JSON.parse(
        readFileSync(
          new URL(
            './fixtures/computer-mqtt/state.example.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as Record<string, unknown>;
      observation['device_id'] = 'kuffe';
      observation['session_id'] = control.session_id;
      observation['timestamp_ms'] = now;
      const observed = observation['observations'] as Record<string, unknown>;
      observed['media'] = [
        {
          player: player.player,
          identity: 'Fixture',
          desktop_entry: 'fixture',
          playback_status: 'Playing',
          title: 'Computer song',
          artists: ['Computer artist'],
          album: null,
          content_type: 'music',
        },
      ];
      mqtt.emit(
        `${root}/availability`,
        JSON.stringify({
          schema_version: 1,
          device_id: 'kuffe',
          session_id: control.session_id,
          status: 'online',
        }),
        false,
      );
      mqtt.emit(`${root}/state`, JSON.stringify(observation), false);
      publishState();
      expect(
        runtime.engine.state.music.computerPlayback?.['music.room'],
      ).toMatchObject({ active: true, playback: 'playing', canPause: true });
      const updates: StateUpdate[] = [];
      const unsubscribe = runtime.engine.stream.subscribe((update) =>
        updates.push(update),
      );
      try {
        const user = { actor: { type: 'user' as const }, source: 'dashboard' };
        const pause = await runtime.engine.requestMusic(
          'music.room',
          { property: 'playback', value: 'paused' },
          user,
        );
        expect(pause.status, JSON.stringify(pause)).toBe('confirmed');
        expect(
          runtime.engine.state.music.computerPlayback?.['music.room'],
        ).toMatchObject({
          playback: 'paused',
          canResume: true,
          lastCommand: { status: 'confirmed' },
        });
        const resume = await runtime.engine.requestMusic(
          'music.room',
          { property: 'playback', value: 'playing' },
          user,
        );
        expect(resume.status).toBe('confirmed');
        expect(
          runtime.engine.state.music.computerPlayback?.['music.room'],
        ).toMatchObject({
          playback: 'playing',
          canResume: false,
          lastCommand: { status: 'confirmed' },
        });
        expect(
          runtime.engine.getMusicState('music.room').observed,
        ).toMatchObject({
          playback: 'playing',
          source: 'Optical In',
          title: '4',
        });
        expect(mqtt.publications).toHaveLength(2);
        const [pausePublication, resumePublication] = mqtt.publications;
        for (const publication of mqtt.publications) {
          expect(publication.topic).toBe(`${root}/control/command`);
          expect(publication.options).toEqual({ qos: 1, retain: false });
          expect(JSON.parse(publication.payload)).toMatchObject({
            player: player.player,
            player_instance_id: player.player_instance_id,
            content_id: player.content_id,
            session_id: control.session_id,
            connection_id: control.connection_id,
          });
        }
        const pauseCommand = ComputerPlaybackCommandSchema.parse(
          JSON.parse(pausePublication!.payload),
        );
        expect(pauseCommand).toMatchObject({
          action: 'pause',
          pause_command_id: null,
          resume_token: null,
        });
        expect(JSON.parse(resumePublication!.payload)).toMatchObject({
          action: 'resume',
          pause_command_id: pauseCommand.command_id,
          resume_token: token,
          lease_ttl_ms: null,
        });
        expect(
          requests.filter((url) => /\/media_(?:pause|play)$/.test(url)),
        ).toEqual([]);
        expect(
          updates.some(
            (update) =>
              update.domains.includes('music') &&
              update.patch.music?.computerPlayback?.['music.room']?.playback ===
                'paused',
          ),
        ).toBe(true);
        expect(
          updates.some(
            (update) =>
              update.domains.includes('music') &&
              update.patch.music?.computerPlayback?.['music.room']?.playback ===
                'playing',
          ),
        ).toBe(true);
      } finally {
        unsubscribe();
      }
    } finally {
      await runtime?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('restores music intent before fresh HA seeding and first MQTT occupancy without replay', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.parse('2026-10-04T12:00:00+02:00');
    vi.setSystemTime(now);
    const directory = await mkdtemp(join(tmpdir(), 'lugn-runtime-music-'));
    const configPath = join(directory, 'runtime.json');
    const statePath = join(directory, 'state.json');
    let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
    const original = new LugnEngine(new FakeClock(now - 1_000), {
      deviceIds: ['lighting.entry'],
      scenes: [],
      music: { targets: { 'music.room': [] } },
    });
    try {
      const user = { actor: { type: 'user' as const }, source: 'dashboard' };
      await original.requestMusic(
        'music.room',
        { property: 'volume', value: 0.95 },
        user,
      );
      await original.requestMusic(
        'music.room',
        { property: 'playback', value: 'paused' },
        user,
      );
      await writeFile(
        statePath,
        JSON.stringify({
          version: 2,
          snapshot: original.getLightingIntentSnapshot(),
          music: original.getMusicIntentSnapshot(),
        }),
      );
      vi.stubEnv('LUGN_TEST_HA_TOKEN', 'test-ha-token');
      await writeFile(
        configPath,
        JSON.stringify({
          http: { host: '127.0.0.1', port: await findEphemeralLoopbackPort() },
          homeAssistant: {
            baseUrl: 'http://home-assistant.invalid:8123',
            tokenEnv: 'LUGN_TEST_HA_TOKEN',
            entities: { 'lighting.entry': 'light.entry' },
            music: { 'music.room': { entityId: 'media_player.room' } },
          },
          scenes: [],
          mqtt: { url: 'mqtt://mqtt.invalid:1883', baseTopic: 'bruno/doorway' },
        }),
      );
      const mqtt = new FakeMqttSubscriber();
      mqtt.onStart = () => {
        mqtt.emit('bruno/doorway/availability', 'online', true);
        mqtt.emit(
          'bruno/doorway/snapshot',
          JSON.stringify({
            schema_version: 1,
            count: 1,
            quality: 'CERTAIN',
            confidence: 1,
            updated_at: new Date(now).toISOString(),
          }),
          false,
        );
      };
      const requests: string[] = [];
      runtime = await startRuntime(configPath, {
        lightingIntentPath: statePath,
        createMqttSubscriber: () => mqtt,
        createHomeAssistantSocket: () => new InertHomeAssistantSocket(),
        homeAssistantFetch: async (input) => {
          const url = String(input);
          requests.push(url);
          return url.endsWith('/api/states')
            ? new Response(
                JSON.stringify([
                  {
                    entity_id: 'media_player.room',
                    state: 'playing',
                    attributes: { volume_level: 0.3, source: 'Optical' },
                    // Availability recovery can advance this; first seed still is not Play intent.
                    last_updated: new Date(now).toISOString(),
                    last_changed: new Date(now).toISOString(),
                  },
                ]),
              )
            : new Response(null, { status: 200 });
        },
      });
      expect(runtime.engine.state.presence.state).toBe('occupied');
      expect(runtime.engine.getMusicState('music.room')).toMatchObject({
        observed: { playback: 'playing', volume: 0.3, source: 'Optical' },
        requested: {},
      });
      expect(
        runtime.engine.getMusicVolumePolicySnapshots()['music.room'],
      ).toMatchObject({
        activeOwner: 'manual',
        effectiveTarget: 0.95,
        baseline: 0.3,
        manualReference: 0.95,
      });
      expect(
        runtime.engine.state.intent.holds.some(
          (h) => h.scope === 'music.playback',
        ),
      ).toBe(true);
      expect(runtime.engine.state.music.commands).toEqual([]);
      expect(requests.filter((url) => url.includes('/api/services/'))).toEqual(
        [],
      );
    } finally {
      original.dispose();
      await runtime?.stop();
      vi.useRealTimers();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('seeds Home Assistant before MQTT startup processes cached and live occupancy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lugn-runtime-'));
    const port = await findEphemeralLoopbackPort();
    vi.stubEnv('LUGN_TEST_HA_TOKEN', 'test-ha-token');
    const configPath = join(directory, 'runtime.json');
    await writeFile(
      configPath,
      JSON.stringify({
        http: { host: '127.0.0.1', port },
        homeAssistant: {
          baseUrl: 'http://home-assistant.invalid:8123',
          tokenEnv: 'LUGN_TEST_HA_TOKEN',
          entities: { 'lighting.entry': 'light.entry' },
        },
        mqtt: {
          url: 'mqtt://mqtt.invalid:1883',
          baseTopic: 'bruno/doorway',
        },
        scenes: [
          {
            id: 'scene.everyday',
            name: 'Everyday',
            lighting: { 'lighting.entry': { power: true } },
          },
        ],
        defaultSceneId: 'scene.everyday',
      }),
      'utf8',
    );

    const mqtt = new FakeMqttSubscriber();
    const mqttStarted = vi.fn();
    mqtt.onStart = () => {
      mqttStarted();
      mqtt.emit('bruno/doorway/availability', 'online', true);
      mqtt.emit(
        'bruno/doorway/snapshot',
        JSON.stringify({
          schema_version: 1,
          count: 1,
          quality: 'CERTAIN',
          confidence: 1,
          updated_at: new Date().toISOString(),
        }),
        true,
      );
      // A live heartbeat establishes freshness and exposes the startup race.
      mqtt.emit(
        'bruno/doorway/snapshot',
        JSON.stringify({
          schema_version: 1,
          count: 1,
          quality: 'CERTAIN',
          confidence: 1,
          updated_at: new Date().toISOString(),
        }),
        false,
      );
    };

    let signalStatesRequestStarted!: () => void;
    const statesRequestStarted = new Promise<void>((resolve) => {
      signalStatesRequestStarted = resolve;
    });
    let resolveStatesResponse!: (response: Response) => void;
    const statesResponse = new Promise<Response>((resolve) => {
      resolveStatesResponse = resolve;
    });
    let statesFullySeeded = false;
    const serviceCallsBeforeSeed: string[] = [];
    const serviceCalls: string[] = [];
    const homeAssistantFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/api/states')) {
        signalStatesRequestStarted();
        return statesResponse;
      }
      if (url.includes('/api/services/')) {
        serviceCalls.push(url);
        if (!statesFullySeeded) serviceCallsBeforeSeed.push(url);
      }
      return new Response(null, { status: 200 });
    };

    const startup = startRuntime(configPath, {
      homeAssistantFetch,
      createMqttSubscriber: () => mqtt,
      createHomeAssistantSocket: () => new InertHomeAssistantSocket(),
      lightingIntentPath: join(directory, 'state', 'lighting-intent.json'),
    });

    let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
    try {
      await statesRequestStarted;
      expect(mqttStarted).not.toHaveBeenCalled();

      const response = {
        ok: true,
        status: 200,
        async json() {
          const states = [
            {
              entity_id: 'light.entry',
              state: 'off',
              attributes: {},
            },
          ];
          const iterate = states[Symbol.iterator].bind(states);
          Object.defineProperty(states, Symbol.iterator, {
            value: function* () {
              yield* iterate();
              statesFullySeeded = true;
            },
          });
          return states;
        },
      } as unknown as Response;
      resolveStatesResponse(response);

      runtime = await startup;
      expect(mqttStarted).toHaveBeenCalledTimes(1);
      expect(statesFullySeeded).toBe(true);
      expect(serviceCallsBeforeSeed).toEqual([]);
      expect(serviceCalls).toEqual([
        'http://home-assistant.invalid:8123/api/services/light/turn_on',
      ]);
      expect(
        runtime.engine.state.lighting.devices['lighting.entry']?.observed.power,
      ).toBe(false);
      expect(runtime.engine.state.presence.state).toBe('occupied');
    } finally {
      resolveStatesResponse(new Response('[]'));
      try {
        if (runtime) await runtime.stop();
        else
          await startup.then(
            (startedRuntime) => startedRuntime.stop(),
            () => undefined,
          );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it('selects the configured default scene without startup commands and applies it on confirmed occupancy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lugn-runtime-'));
    const port = await findEphemeralLoopbackPort();
    vi.stubEnv('LUGN_TEST_HA_TOKEN', 'test-ha-token');
    const configPath = join(directory, 'runtime.json');
    await writeFile(
      configPath,
      JSON.stringify({
        http: { host: '127.0.0.1', port },
        homeAssistant: {
          baseUrl: 'http://home-assistant.invalid:8123',
          tokenEnv: 'LUGN_TEST_HA_TOKEN',
          entities: { 'lighting.entry': 'light.entry' },
        },
        lightingControlModes: { 'lighting.entry': 'enforce' },
        mqtt: {
          url: 'mqtt://mqtt.invalid:1883',
          baseTopic: 'bruno/doorway',
        },
        scenes: [
          {
            id: 'scene.everyday',
            name: 'Everyday',
            lighting: { 'lighting.entry': { power: true } },
          },
        ],
        defaultSceneId: 'scene.everyday',
      }),
      'utf8',
    );

    const mqtt = new FakeMqttSubscriber();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const homeAssistantFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, ...(init === undefined ? {} : { init }) });
      return url.endsWith('/api/states')
        ? Response.json([
            {
              entity_id: 'light.entry',
              state: 'off',
              attributes: {},
            },
          ])
        : new Response(null, { status: 200 });
    };

    const runtime = await startRuntime(configPath, {
      homeAssistantFetch,
      createMqttSubscriber: () => mqtt,
      createHomeAssistantSocket: () => new InertHomeAssistantSocket(),
      lightingIntentPath: join(directory, 'state', 'lighting-intent.json'),
    });

    try {
      expect(runtime.engine.state.lighting.currentScene).toBe(
        'scene.everyday_light',
      );
      expect(
        requests.filter(({ url }) => url.includes('/api/services/')),
      ).toEqual([]);

      mqtt.emit('bruno/doorway/availability', 'online', true);
      mqtt.emit(
        'bruno/doorway/snapshot',
        JSON.stringify({
          schema_version: 1,
          count: 1,
          quality: 'CERTAIN',
          confidence: 1,
          updated_at: new Date().toISOString(),
        }),
        false,
      );
      await vi.waitFor(() => {
        expect(
          requests.filter(({ url }) => url.includes('/api/services/')),
        ).toHaveLength(1);
      });

      expect(
        requests.find(({ url }) => url.includes('/api/services/'))?.url,
      ).toBe('http://home-assistant.invalid:8123/api/services/light/turn_on');
      expect(runtime.engine.state.presence.state).toBe('occupied');
      const lighting = runtime.engine.adapter as HomeAssistantLightingAdapter;
      const desired =
        runtime.engine.state.lighting.devices['lighting.entry']!
          .effectiveDesired;
      lighting.acceptStateChangedEvent({
        entity_id: 'light.entry',
        new_state: {
          entity_id: 'light.entry',
          state: 'on',
          attributes: {
            brightness: Math.round(((desired.brightness ?? 55) * 255) / 100),
            color_temp_kelvin: desired.colorTemperature,
          },
        },
      });
      lighting.acceptStateChangedEvent({
        entity_id: 'light.entry',
        new_state: { entity_id: 'light.entry', state: 'off', attributes: {} },
      });
      expect(
        runtime.engine.state.lighting.devices['lighting.entry']
          ?.effectiveDesired.power,
      ).toBe(true);
      expect(
        runtime.engine.state.lighting.devices['lighting.entry']?.ownership.power
          ?.kind,
      ).toBe('scene');
    } finally {
      await runtime.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('hydrates logical intent before HA seeding and waits for confirmed occupancy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lugn-runtime-'));
    const port = await findEphemeralLoopbackPort();
    vi.stubEnv('LUGN_TEST_HA_TOKEN', 'test-ha-token');
    const configPath = join(directory, 'runtime.json');
    const statePath = join(directory, 'state', 'lighting-intent.json');
    await writeFile(
      configPath,
      JSON.stringify({
        http: { host: '127.0.0.1', port },
        homeAssistant: {
          baseUrl: 'http://home-assistant.invalid:8123',
          tokenEnv: 'LUGN_TEST_HA_TOKEN',
          entities: { 'lighting.entry': 'light.entry' },
        },
        scenes: [
          {
            id: 'scene.everyday',
            name: 'Everyday',
            lighting: { 'lighting.entry': { power: true } },
          },
        ],
        defaultSceneId: 'scene.everyday',
      }),
      'utf8',
    );
    await mkdir(join(directory, 'state'), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        intent: {
          currentScene: 'scene.everyday',
          sceneRevision: 1,
          continuityExpiresAt: null,
          devices: {
            'lighting.entry': {
              baselineDesired: { power: true },
              effectiveDesired: { power: true },
              ownership: { power: { kind: 'scene', revision: 1 } },
            },
          },
        },
      }),
      'utf8',
    );

    const serviceCalls: string[] = [];
    const runtime = await startRuntime(configPath, {
      homeAssistantFetch: async (input) => {
        const url = String(input);
        if (url.endsWith('/api/states'))
          return Response.json([
            { entity_id: 'light.entry', state: 'off', attributes: {} },
          ]);
        serviceCalls.push(url);
        return new Response(null, { status: 200 });
      },
      createHomeAssistantSocket: () => new InertHomeAssistantSocket(),
      lightingIntentPath: statePath,
    });

    try {
      expect(runtime.engine.state.lighting.currentScene).toBe(
        'scene.everyday_light',
      );
      expect(runtime.engine.state.presence.state).toBe('unknown');
      expect(runtime.engine.state.commands).toEqual([]);
      expect(serviceCalls).toEqual([]);

      await runtime.engine.handlePresence({
        type: 'presence.changed',
        presence: 'unknown',
      });
      expect(serviceCalls).toEqual([]);

      await runtime.engine.handlePresence({
        type: 'presence.changed',
        presence: 'occupied',
      });
      expect(serviceCalls).toEqual([
        'http://home-assistant.invalid:8123/api/services/light/turn_on',
      ]);
      expect(runtime.engine.state.commands).toHaveLength(1);
    } finally {
      await runtime.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps an expired persisted sleep scene from lighting during HA state seeding', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lugn-runtime-'));
    const port = await findEphemeralLoopbackPort();
    vi.stubEnv('LUGN_TEST_HA_TOKEN', 'test-ha-token');
    const configPath = join(directory, 'runtime.json');
    const statePath = join(directory, 'state', 'lighting-intent.json');
    await writeFile(
      configPath,
      JSON.stringify({
        http: { host: '127.0.0.1', port },
        homeAssistant: {
          baseUrl: 'http://home-assistant.invalid:8123',
          tokenEnv: 'LUGN_TEST_HA_TOKEN',
          entities: { 'lighting.entry': 'light.entry' },
        },
        scenes: [
          {
            id: 'scene.default',
            name: 'Default',
            lighting: { 'lighting.entry': { power: true, brightness: 50 } },
          },
          {
            id: 'scene.sleep',
            name: 'Sleep',
            lighting: { 'lighting.entry': { power: true, brightness: 2 } },
          },
        ],
        defaultSceneId: 'scene.default',
      }),
      'utf8',
    );
    await mkdir(join(directory, 'state'), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        snapshot: {
          currentScene: 'scene.sleep',
          sceneRevision: 4,
          continuityExpiresAt: Date.now() - 60_000,
          devices: {
            'lighting.entry': {
              baselineDesired: { power: true, brightness: 2 },
              effectiveDesired: { power: true, brightness: 17 },
              ownership: {
                power: { kind: 'scene', revision: 4 },
                brightness: {
                  kind: 'override',
                  actor: { type: 'user', id: 'test-user' },
                  reason: 'temporary',
                  createdAt: Date.now() - 120_000,
                },
              },
            },
          },
        },
      }),
      'utf8',
    );

    const serviceCalls: Array<{ url: string; body: string | undefined }> = [];
    const runtime = await startRuntime(configPath, {
      homeAssistantFetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith('/api/states'))
          return Response.json([
            { entity_id: 'light.entry', state: 'off', attributes: {} },
          ]);
        serviceCalls.push({ url, body: init?.body?.toString() });
        return new Response(null, { status: 200 });
      },
      createHomeAssistantSocket: () => new InertHomeAssistantSocket(),
      lightingIntentPath: statePath,
    });

    try {
      expect(runtime.engine.state.presence.state).toBe('unknown');
      expect(runtime.engine.state.lighting.currentScene).toBe('scene.sleep');
      expect(
        runtime.engine.state.lighting.devices['lighting.entry']
          ?.effectiveDesired,
      ).toEqual({ power: true, brightness: 2 });
      expect(serviceCalls).toEqual([]);

      await runtime.engine.handlePresence({
        type: 'presence.changed',
        presence: 'unknown',
      });
      expect(serviceCalls).toEqual([]);

      await runtime.engine.handlePresence({
        type: 'presence.changed',
        presence: 'occupied',
        personCount: 1,
      });
      expect(serviceCalls).toEqual([
        {
          url: 'http://home-assistant.invalid:8123/api/services/light/turn_on',
          body: JSON.stringify({ entity_id: 'light.entry', brightness_pct: 2 }),
        },
      ]);
    } finally {
      await runtime.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('routes a live STL27L preview through prelight to the mapped HA light service', async () => {
    // Keep real I/O/timers, but make the daytime prelight assertion independent
    // of the developer machine's current Stockholm quiet-hours window.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-04T12:00:00+02:00'));
    const directory = await mkdtemp(join(tmpdir(), 'lugn-runtime-'));
    const port = await findEphemeralLoopbackPort();
    vi.stubEnv('LUGN_TEST_HA_TOKEN', 'test-ha-token');
    const configPath = join(directory, 'runtime.json');
    await writeFile(
      configPath,
      JSON.stringify({
        http: { host: '127.0.0.1', port },
        homeAssistant: {
          baseUrl: 'http://home-assistant.invalid:8123',
          tokenEnv: 'LUGN_TEST_HA_TOKEN',
          entities: { 'lighting.entry': 'light.entry' },
        },
        mqtt: {
          url: 'mqtt://mqtt.invalid:1883',
          baseTopic: 'bruno/doorway',
        },
        prelight: {
          targets: {
            'lighting.entry': {
              power: true,
              brightness: 32,
              colorTemperature: 2700,
            },
          },
        },
        scenes: [],
      }),
      'utf8',
    );

    const mqtt = new FakeMqttSubscriber();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const homeAssistantFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, ...(init === undefined ? {} : { init }) });
      return url.endsWith('/api/states')
        ? new Response('[]', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response(null, { status: 200 });
    };

    const runtime = await startRuntime(configPath, {
      homeAssistantFetch,
      createMqttSubscriber: () => mqtt,
      createHomeAssistantSocket: () => new InertHomeAssistantSocket(),
      lightingIntentPath: join(directory, 'state', 'lighting-intent.json'),
    });

    try {
      mqtt.emit('bruno/doorway/preview', 'ON', false);
      await vi.waitFor(() => {
        expect(
          requests.filter(({ url }) => url.includes('/api/services/')),
        ).toHaveLength(1);
      });

      const serviceRequests = requests.filter(({ url }) =>
        url.includes('/api/services/'),
      );
      expect(serviceRequests).toHaveLength(1);
      expect(serviceRequests[0]?.url).toBe(
        'http://home-assistant.invalid:8123/api/services/light/turn_on',
      );
      expect(serviceRequests[0]?.init?.method).toBe('POST');
      expect(
        new Headers(serviceRequests[0]?.init?.headers).get('Authorization'),
      ).toBe('Bearer test-ha-token');
      expect(serviceRequests[0]?.init?.body).toBe(
        JSON.stringify({
          entity_id: 'light.entry',
          brightness_pct: 55,
          color_temp_kelvin: 2700,
        }),
      );
    } finally {
      await runtime.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('subscribes configured computers before starting the shared MQTT client', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lugn-runtime-computer-'));
    const port = await findEphemeralLoopbackPort();
    vi.stubEnv('LUGN_TEST_HA_TOKEN', 'test-ha-token');
    vi.stubEnv('LUGN_TEST_API_TOKEN', 'test-api-token');
    const configPath = join(directory, 'runtime.json');
    await writeFile(
      configPath,
      JSON.stringify({
        http: {
          host: '127.0.0.1',
          port,
          bearerTokenEnv: 'LUGN_TEST_API_TOKEN',
        },
        homeAssistant: {
          baseUrl: 'http://home-assistant.invalid:8123',
          tokenEnv: 'LUGN_TEST_HA_TOKEN',
          entities: { 'lighting.entry': 'light.entry' },
        },
        mqtt: {
          url: 'mqtt://mqtt.invalid:1883',
          computers: [
            {
              deviceId: 'workstation',
              baseTopic: 'lab/computers/',
            },
          ],
        },
        scenes: [],
      }),
      'utf8',
    );

    const mqtt = new FakeMqttSubscriber();
    mqtt.onStart = () => {
      const state = JSON.parse(
        readFileSync(
          new URL(
            './fixtures/computer-mqtt/state.example.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as Record<string, unknown>;
      const sessionId = String(state['session_id']);
      mqtt.emit(
        `lab/computers/workstation/availability`,
        JSON.stringify({
          schema_version: 1,
          device_id: 'workstation',
          session_id: sessionId,
          status: 'online',
        }),
        true,
      );
      state['device_id'] = 'workstation';
      state['timestamp_ms'] = Date.now();
      state['inference'] = {
        activity: 'gaming',
        basis: 'application_rule',
      };
      const observations = state['observations'] as Record<string, unknown>;
      const activeApplication = observations['active_application'] as Record<
        string,
        unknown
      >;
      activeApplication['app_id'] = 'game.exe';
      activeApplication['resource_class'] = 'game';
      activeApplication['fullscreen'] = true;
      mqtt.emit(
        `lab/computers/workstation/state`,
        JSON.stringify(state),
        false,
      );
    };

    let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
    try {
      runtime = await startRuntime(configPath, {
        homeAssistantFetch: async (input) =>
          String(input).endsWith('/api/states')
            ? Response.json([])
            : new Response(null, { status: 200 }),
        createMqttSubscriber: () => mqtt,
        createHomeAssistantSocket: () => new InertHomeAssistantSocket(),
        lightingIntentPath: join(directory, 'state', 'lighting-intent.json'),
      });

      expect(
        runtime.engine.state.computer.devices['workstation'],
      ).toMatchObject({
        availability: 'online',
        freshness: 'fresh',
        observed: {
          activeApplication: { id: 'game.exe', resourceClass: 'game' },
          fullscreen: true,
        },
        activity: { classification: 'gaming' },
      });
      expect(runtime.engine.state.presence.state).toBe('unknown');
      expect(
        runtime.engine.state.lighting.devices['lighting.entry']
          ?.effectiveDesired,
      ).toEqual({});

      const httpStateResponse = await fetch(`http://127.0.0.1:${port}/state`, {
        headers: { Authorization: 'Bearer test-api-token' },
      });
      expect(httpStateResponse.status).toBe(200);
      const httpState = (await httpStateResponse.json()) as {
        computer: { devices: Record<string, { availability: string }> };
      };
      expect(httpState.computer.devices['workstation']?.availability).toBe(
        'online',
      );

      const streamedUpdates: StateUpdate[] = [];
      const unsubscribe = runtime.engine.stream.subscribe((update) =>
        streamedUpdates.push(update),
      );
      const beforeEventRevision = runtime.engine.state.revision;
      const event = JSON.parse(
        readFileSync(
          new URL(
            './fixtures/computer-mqtt/events.example.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as Record<string, unknown>;
      event['device_id'] = 'workstation';
      event['timestamp_ms'] = Date.now();
      mqtt.emit(
        'lab/computers/workstation/events',
        JSON.stringify(event),
        false,
      );
      expect(streamedUpdates.at(-1)?.domains).toEqual(['computer']);
      expect(streamedUpdates.at(-1)?.patch.computer?.devices).toHaveProperty(
        'workstation',
      );
      const replay = runtime.engine.stream.resume(
        beforeEventRevision,
        runtime.engine.state,
      );
      expect(replay.kind).toBe('updates');
      if (replay.kind !== 'updates') throw new Error('Expected replay updates');
      expect(replay.updates.at(-1)?.patch.computer?.devices).toHaveProperty(
        'workstation',
      );
      unsubscribe();

      await mqtt.stop();
      expect(
        runtime.engine.state.computer.devices['workstation'],
      ).toMatchObject({
        availability: 'unknown',
        freshness: 'unknown',
        reason: 'broker_disconnected',
      });
    } finally {
      await runtime?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function findEphemeralLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}
