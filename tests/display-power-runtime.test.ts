import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  HomeAssistantSocket,
  HomeAssistantSocketMessageEvent,
} from '../src/adapters/home-assistant-websocket.js';
import type {
  Stl27lMqttMessageMetadata,
  Stl27lPresenceMqttSubscriber,
} from '../src/adapters/stl27l-mqtt-presence.js';
import { ComputerDisplayCommandSchema } from '../src/adapters/computer-display-mqtt.js';
import { startRuntime } from '../src/runtime/main.js';
import type { MqttSubscriberStatus } from '../src/runtime/mqttjs-subscriber.js';

type Handler = (
  topic: string,
  payload: unknown,
  metadata: Stl27lMqttMessageMetadata,
) => void;

class FakeMqtt implements Stl27lPresenceMqttSubscriber {
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly listeners = new Set<
    (status: MqttSubscriberStatus) => void
  >();
  status: MqttSubscriberStatus = 'stopped';
  readonly publications: Array<{ topic: string; payload: string }> = [];
  onPublish: ((topic: string, payload: string) => void) | undefined;

  async publish(
    topic: string,
    payload: string,
    options: { qos: 1; retain: false },
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.status !== 'connected' || signal?.aborted)
      throw new Error('Fake MQTT publication unavailable');
    expect(options).toEqual({ qos: 1, retain: false });
    this.publications.push({ topic, payload });
    await Promise.resolve();
    this.onPublish?.(topic, payload);
  }
  subscribe(topic: string, _options: { qos: 0 | 1 }, handler: Handler) {
    const set = this.handlers.get(topic) ?? new Set();
    set.add(handler);
    this.handlers.set(topic, set);
    return () => set.delete(handler);
  }
  onStatus(listener: (status: MqttSubscriberStatus) => void) {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }
  start(): void {
    this.status = 'connected';
    for (const listener of this.listeners) listener(this.status);
  }
  async stop(): Promise<void> {
    this.status = 'stopped';
    this.handlers.clear();
  }
  emit(topic: string, payload: unknown): void {
    for (const handler of this.handlers.get(topic) ?? [])
      handler(topic, payload, { retain: false });
  }
}

class InertSocket implements HomeAssistantSocket {
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

const SESSION = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';
const ROOT = 'lugn/computers/kuffe';
const MINUTE = 60_000;

describe('display power in the composed runtime', () => {
  it('sleeps and wakes the display from room presence, with plug evidence from Home Assistant', async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'],
    });
    vi.setSystemTime(Date.parse('2026-10-04T12:00:00+02:00'));
    const directory = await mkdtemp(join(tmpdir(), 'lugn-runtime-display-'));
    vi.stubEnv('LUGN_TEST_HA_TOKEN', 'test-ha-token');
    vi.stubEnv('LUGN_TEST_MQTT_USERNAME', 'test-mqtt-user');
    vi.stubEnv('LUGN_TEST_MQTT_PASSWORD', 'test-mqtt-password');
    const mqtt = new FakeMqtt();
    const socket = new InertSocket();
    let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
    let displaySequence = 0;
    let observationSequence = 0;
    let lastDisplayCommand: string | undefined;
    const observation = JSON.parse(
      readFileSync(
        new URL('./fixtures/computer-mqtt/state.example.json', import.meta.url),
        'utf8',
      ),
    ) as Record<string, unknown>;
    observation['device_id'] = 'kuffe';
    observation['session_id'] = SESSION;
    (observation['observations'] as Record<string, unknown>)['idle'] = true;
    observation['inference'] = { activity: 'idle', basis: 'locked_or_idle' };
    const lastCommand = { value: null as unknown };
    const heartbeat = () => {
      observation['sequence'] = ++observationSequence;
      observation['timestamp_ms'] = Date.now();
      mqtt.emit(`${ROOT}/state`, JSON.stringify(observation));
      mqtt.emit(
        `${ROOT}/display/state`,
        JSON.stringify({
          schema_version: 1,
          device_id: 'kuffe',
          session_id: SESSION,
          connection_id: CONNECTION,
          sequence: ++displaySequence,
          timestamp_ms: Date.now(),
          heartbeat_interval_ms: 30_000,
          backend: 'kscreen',
          last_command: lastCommand.value,
        }),
      );
    };
    const advance = async (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 30_000) {
        await vi.advanceTimersByTimeAsync(Math.min(30_000, ms - elapsed));
        heartbeat();
        await vi.advanceTimersByTimeAsync(0);
      }
    };
    mqtt.onPublish = (topic, payload) => {
      if (topic !== `${ROOT}/display/command`) return;
      lastDisplayCommand = payload;
      const command = ComputerDisplayCommandSchema.parse(JSON.parse(payload));
      const ack = {
        schema_version: 1,
        device_id: 'kuffe',
        session_id: command.session_id,
        connection_id: command.connection_id,
        command_id: command.command_id,
        action: command.action,
        timestamp_ms: Date.now(),
        outcome: 'applied',
        reason: command.action === 'off' ? 'display_off' : 'display_on',
      };
      lastCommand.value = {
        command_id: command.command_id,
        action: command.action,
        outcome: 'applied',
        reason: ack.reason,
        timestamp_ms: ack.timestamp_ms,
      };
      mqtt.emit(`${ROOT}/display/ack`, JSON.stringify(ack));
    };
    try {
      const configPath = join(directory, 'runtime.json');
      await writeFile(
        configPath,
        JSON.stringify({
          http: { host: '127.0.0.1', port: await findEphemeralLoopbackPort() },
          homeAssistant: {
            baseUrl: 'http://home-assistant.invalid:8123',
            tokenEnv: 'LUGN_TEST_HA_TOKEN',
            entities: { 'lighting.entry': 'light.entry' },
          },
          mqtt: {
            url: 'mqtt://mqtt.invalid:1883',
            usernameEnv: 'LUGN_TEST_MQTT_USERNAME',
            passwordEnv: 'LUGN_TEST_MQTT_PASSWORD',
            computers: [
              {
                deviceId: 'kuffe',
                display: {
                  powerSensor: {
                    entityId: 'sensor.monitor_plug_power',
                    onAboveWatts: 15,
                    standbyBelowWatts: 3,
                  },
                },
              },
            ],
          },
          scenes: [],
        }),
      );
      runtime = await startRuntime(configPath, {
        lightingIntentPath: join(directory, 'state.json'),
        createMqttSubscriber: () => mqtt,
        createHomeAssistantSocket: () => socket,
        homeAssistantFetch: async (input) =>
          String(input).endsWith('/api/states')
            ? Response.json([
                {
                  entity_id: 'sensor.monitor_plug_power',
                  state: '31.5',
                  attributes: { unit_of_measurement: 'W' },
                  last_updated: new Date().toISOString(),
                },
              ])
            : new Response(null, { status: 200 }),
      });
      socket.receive({ type: 'auth_required' });
      socket.receive({ type: 'auth_ok' });
      const subscription = JSON.parse(socket.sent.at(-1)!) as { id: number };
      socket.receive({ type: 'result', id: subscription.id, success: true });
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 30; i++) await Promise.resolve();
      mqtt.emit(
        `${ROOT}/availability`,
        JSON.stringify({
          schema_version: 1,
          device_id: 'kuffe',
          session_id: SESSION,
          status: 'online',
        }),
      );
      heartbeat();
      const engine = runtime.engine;
      // Lighting work triggered by presence waits on fake timers, so presence
      // is delivered without awaiting it and time is advanced explicitly.
      const presence = async (state: 'occupied' | 'confirmed_empty') => {
        void engine
          .handlePresence({
            type: 'presence.changed',
            presence: state,
            occurredAt: Date.now(),
            source: 'test',
          })
          .catch(() => undefined);
        await vi.advanceTimersByTimeAsync(0);
      };

      await presence('occupied');
      await advance(5 * MINUTE);
      expect(mqtt.publications).toEqual([]);
      const plug = async (watts: number) => {
        socket.receive({
          type: 'event',
          id: subscription.id,
          event: {
            event_type: 'state_changed',
            data: {
              entity_id: 'sensor.monitor_plug_power',
              new_state: {
                entity_id: 'sensor.monitor_plug_power',
                state: String(watts),
                attributes: { unit_of_measurement: 'W' },
                last_updated: new Date().toISOString(),
              },
            },
          },
        });
        await vi.advanceTimersByTimeAsync(0);
      };
      expect(engine.state.computer.displays?.['kuffe']).toMatchObject({
        control: 'available',
        desired: 'on',
        evidence: { state: 'on', watts: 31.5 },
      });

      // The room empties: sleep is requested once after the configured wait.
      await presence('confirmed_empty');
      await advance(MINUTE);
      expect(mqtt.publications).toEqual([]);
      await advance(MINUTE + 30_000);
      expect(mqtt.publications).toHaveLength(1);
      const sleep = ComputerDisplayCommandSchema.parse(
        JSON.parse(mqtt.publications[0]!.payload),
      );
      expect(mqtt.publications[0]!.topic).toBe(`${ROOT}/display/command`);
      expect(sleep).toMatchObject({
        action: 'off',
        session_id: SESSION,
        connection_id: CONNECTION,
      });
      expect(engine.state.computer.displays?.['kuffe']).toMatchObject({
        desired: 'off',
        lastRequest: { action: 'off', outcome: 'applied' },
      });

      // The plug still shows draw, so the request is repeated after a couple of
      // minutes rather than after the usual quarter hour.
      await advance(2 * MINUTE);
      expect(mqtt.publications).toHaveLength(2);

      // Now the plug settles at standby: no more repeats for hours.
      await plug(1.2);
      await advance(MINUTE);
      expect(engine.state.computer.displays?.['kuffe']?.evidence).toMatchObject(
        { state: 'standby', watts: 1.2 },
      );
      await advance(3 * 60 * MINUTE);
      expect(mqtt.publications).toHaveLength(2);

      // Someone is back: exactly one wake, verified by the plug.
      await presence('occupied');
      await advance(5_000);
      expect(mqtt.publications).toHaveLength(3);
      expect(
        ComputerDisplayCommandSchema.parse(JSON.parse(lastDisplayCommand!))
          .action,
      ).toBe('on');
      await plug(32);
      await advance(30 * MINUTE);
      expect(mqtt.publications).toHaveLength(3);
    } finally {
      await runtime?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function findEphemeralLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
