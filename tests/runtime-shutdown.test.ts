import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HomeAssistantSocket } from '../src/adapters/home-assistant-websocket.js';
import type { LugnRuntimeDependencies } from '../src/runtime/main.js';
import { startRuntime } from '../src/runtime/main.js';
import { exitWhenLingering } from '../src/runtime/exit-when-lingering.js';

type Subscriber = ReturnType<
  NonNullable<LugnRuntimeDependencies['createMqttSubscriber']>
>;

const silentSocket = (): HomeAssistantSocket => ({
  addEventListener: () => undefined,
  send: () => undefined,
  close: () => undefined,
});

/** A connected broker; `publish` decides whether it acknowledges. */
function fakeBroker(publish: NonNullable<Subscriber['publish']>): Subscriber {
  return {
    status: 'connected',
    publish,
    subscribe: () => () => undefined,
    onStatus: (listener) => {
      listener('connected');
      return () => undefined;
    },
    start: () => undefined,
    stop: async () => undefined,
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

let directory: string | undefined;

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function writeConfig(extra: Record<string, unknown>): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), 'lugn-runtime-shutdown-'));
  vi.stubEnv('LUGN_TEST_HA_TOKEN', 'test-ha-token');
  const path = join(directory, 'runtime.json');
  await writeFile(
    path,
    JSON.stringify({
      http: { host: '127.0.0.1', port: await freePort() },
      scenes: [],
      ...extra,
    }),
  );
  return path;
}

describe('runtime shutdown', () => {
  it('leaves no timer running with the Govee companion and a WLED CCT strip', async () => {
    const config = await writeConfig({
      homeAssistant: {
        baseUrl: 'http://home-assistant.invalid:8123',
        tokenEnv: 'LUGN_TEST_HA_TOKEN',
        entities: { 'lighting.strip': 'light.strip' },
        wledCct: { 'lighting.strip': { baseUrl: 'http://wled.invalid' } },
      },
      govee: { socketPath: '/run/lugn-test/govee.sock' },
    });
    vi.useFakeTimers();
    let stripReads = 0;
    const runtime = await startRuntime(config, {
      lightingIntentPath: join(directory!, 'state.json'),
      createHomeAssistantSocket: silentSocket,
      goveeControlClient: {
        capabilities: async () => ({}),
        apply: async () => undefined,
        cancel: async () => undefined,
      },
      homeAssistantFetch: async (input) => {
        if (String(input).startsWith('http://wled.invalid')) stripReads += 1;
        return Response.json([]);
      },
    });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(stripReads).toBeGreaterThan(0);

    await runtime.stop();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('saves its state when the broker never acknowledges the offline message', async () => {
    vi.stubEnv('LUGN_TEST_MQTT_USERNAME', 'test-mqtt-user');
    vi.stubEnv('LUGN_TEST_MQTT_PASSWORD', 'test-mqtt-password');
    const config = await writeConfig({
      homeAssistant: {
        baseUrl: 'http://home-assistant.invalid:8123',
        tokenEnv: 'LUGN_TEST_HA_TOKEN',
        entities: { 'lighting.entry': 'light.entry' },
      },
      mqtt: {
        url: 'mqtt://mqtt.invalid:1883',
        usernameEnv: 'LUGN_TEST_MQTT_USERNAME',
        passwordEnv: 'LUGN_TEST_MQTT_PASSWORD',
        assistantEntities: {
          lights: [{ id: 'entry', name: 'Entry', target: 'lighting.entry' }],
        },
      },
    });
    const state = join(directory!, 'state.json');
    let offlineSent = false;
    vi.useFakeTimers();
    const runtime = await startRuntime(config, {
      lightingIntentPath: state,
      createHomeAssistantSocket: silentSocket,
      createMqttSubscriber: () =>
        fakeBroker((_topic, payload) => {
          if (payload !== 'offline') return Promise.resolve();
          offlineSent = true;
          return new Promise<void>(() => undefined);
        }),
      homeAssistantFetch: async () => Response.json([]),
    });
    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(offlineSent).toBe(true);
    expect(stopped).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    vi.useRealTimers();
    await stopping;

    expect(JSON.parse(await readFile(state, 'utf8'))).toHaveProperty('version');
  });
});

describe('exit after stopping', () => {
  it('ends a process that outlives the grace period and names what was left', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const exit = vi.fn<(code?: number | string | null) => never>();

    exitWhenLingering(5_000, {
      exit,
      getActiveResourcesInfo: () => ['TCPSocketWrap'],
    });
    vi.advanceTimersByTime(4_999);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(exit).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('TCPSocketWrap'));
  });
});
