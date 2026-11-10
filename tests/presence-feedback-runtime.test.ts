import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Stl27lMqttMessageMetadata } from '../src/adapters/stl27l-mqtt-presence.js';
import { startRuntime } from '../src/runtime/main.js';
import type { MqttSubscriberStatus } from '../src/runtime/mqttjs-subscriber.js';
import { defaultPresenceFeedbackSettings } from '../src/core/presence-feedback.js';

type Handler = (
  topic: string,
  payload: unknown,
  metadata: Stl27lMqttMessageMetadata,
) => void;

class FakeMqtt {
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly listeners = new Set<(s: MqttSubscriberStatus) => void>();
  status: MqttSubscriberStatus = 'stopped';
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
  start() {
    this.status = 'connected';
    for (const listener of this.listeners) listener(this.status);
    this.emit('bruno/doorway/availability', 'online', true);
  }
  async stop() {
    this.status = 'stopped';
  }
  count(count: number) {
    this.emit(
      'bruno/doorway/snapshot',
      JSON.stringify({
        schema_version: 1,
        count,
        quality: 'CERTAIN',
        confidence: 1,
        updated_at: new Date().toISOString(),
      }),
      false,
    );
  }
  private emit(topic: string, payload: unknown, retain: boolean) {
    for (const handler of this.handlers.get(topic) ?? [])
      handler(topic, payload, { retain });
  }
}

afterEach(() => vi.unstubAllEnvs());

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it('holds a sensor-reported exit for the saved grace and applies setting changes live', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lugn-feedback-runtime-'));
  const statePath = join(directory, 'state.json');
  const feedbackPath = `${statePath}.presence-feedback.json`;
  const saved = {
    ...defaultPresenceFeedbackSettings,
    exitGraceSeconds: 1,
  };
  await writeFile(
    feedbackPath,
    JSON.stringify({ version: 1, settings: saved }),
  );
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
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
      mqtt: { url: 'mqtt://mqtt.invalid:1883', baseTopic: 'bruno/doorway' },
      scenes: [],
    }),
  );
  const mqtt = new FakeMqtt();
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  const capability = async (name: string, input: unknown) => {
    const response = await fetch(
      `http://127.0.0.1:${port}/capabilities/${name}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input }),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  try {
    runtime = await startRuntime(configPath, {
      lightingIntentPath: statePath,
      createMqttSubscriber: () => mqtt as never,
      createHomeAssistantSocket: () => ({
        addEventListener: () => {},
        send: () => {},
        close: () => {},
      }),
      homeAssistantFetch: async (input) =>
        String(input).endsWith('/api/states')
          ? Response.json([])
          : new Response(null, { status: 200 }),
    });
    const state = () => runtime!.engine.state.presence.state;
    expect(await capability('presence.getFeedbackSettings', {})).toMatchObject({
      status: 200,
      body: { settings: saved },
    });

    mqtt.count(1);
    await vi.waitFor(() => expect(state()).toBe('occupied'));
    mqtt.count(0);
    await wait(300);
    expect(state()).toBe('occupied');
    // The wait is visible to the panel while it lasts, and gone once it ends.
    const pending = runtime.engine.state.presence.exitPending;
    expect(pending).toBeDefined();
    expect(pending!.until - pending!.startedAt).toBe(1_000);
    await vi.waitFor(() => expect(state()).toBe('confirmed_empty'), {
      timeout: 2_000,
    });
    expect(runtime.engine.state.presence.exitPending).toBeUndefined();

    // Back and forth within the wait never reaches the engine.
    mqtt.count(1);
    await vi.waitFor(() => expect(state()).toBe('occupied'));
    mqtt.count(0);
    await wait(300);
    expect(state()).toBe('occupied');
    mqtt.count(1);
    expect(runtime.engine.state.presence.exitPending).toBeUndefined();
    await wait(1_300);
    expect(state()).toBe('occupied');

    // Switching the wait off applies at once and is saved.
    const update = await capability('presence.updateFeedbackSettings', {
      settings: { ...saved, exitGraceSeconds: 0 },
    });
    expect(update.status).toBe(200);
    expect(JSON.parse(await readFile(feedbackPath, 'utf8'))).toMatchObject({
      settings: { exitGraceSeconds: 0 },
    });
    mqtt.count(0);
    await vi.waitFor(() => expect(state()).toBe('confirmed_empty'), {
      timeout: 500,
    });
  } finally {
    await runtime?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
