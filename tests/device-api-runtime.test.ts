import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { StateViewSchema } from '../src/core/device-api.js';
import { startRuntime } from '../src/runtime/main.js';
import { call, findAvailablePort } from './device-api-helpers.js';

afterEach(() => vi.unstubAllEnvs());

async function boot(device: Record<string, unknown> | undefined) {
  const directory = await mkdtemp(join(tmpdir(), 'lugn-device-runtime-'));
  const statePath = join(directory, 'state.json');
  const httpPort = await findAvailablePort();
  const devicePort = await findAvailablePort();
  vi.stubEnv('LUGN_TEST_HA_TOKEN', 'test-ha-token');
  const configPath = join(directory, 'runtime.json');
  await writeFile(
    configPath,
    JSON.stringify({
      http: { host: '127.0.0.1', port: httpPort },
      homeAssistant: {
        baseUrl: 'http://home-assistant.invalid:8123',
        tokenEnv: 'LUGN_TEST_HA_TOKEN',
        entities: { 'lighting.entry': 'light.entry' },
      },
      ...(device
        ? {
            device: {
              host: '127.0.0.1',
              port: devicePort,
              allowedHosts: [`127.0.0.1:${devicePort}`],
              ...device,
            },
          }
        : {}),
      scenes: [],
    }),
  );
  const runtime = await startRuntime(configPath, {
    lightingIntentPath: statePath,
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
  return {
    runtime,
    statePath,
    httpPort,
    devicePort,
    cleanup: async () => {
      await runtime.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it('starts the paired-device listener only when enabled and wires state, commands and phone hints', async () => {
  const { runtime, statePath, httpPort, devicePort, cleanup } = await boot({
    enabled: true,
  });
  try {
    const created = await call(httpPort, {
      path: '/devices/pairing',
      body: {},
    });
    expect(created.status).toBe(201);
    const { code } = created.json() as { code: string };
    const paired = await call(devicePort, {
      path: '/api/v1/pair',
      body: { code, name: 'iPhone', platform: 'ios' },
    });
    expect(paired.status).toBe(201);
    const { token } = paired.json() as { token: string };
    expect((await stat(`${statePath}.devices.json`)).mode & 0o777).toBe(0o600);

    const state = StateViewSchema.parse(
      (await call(devicePort, { path: '/api/v1/state', token })).json(),
    );
    expect(state.presence.state).toBe('unknown');
    expect(state.health.integrations).toHaveProperty('home_assistant');

    const observed = await call(devicePort, {
      path: '/api/v1/phone/observations',
      token,
      body: {
        sessionId: '5d0c4b9a-8e7f-4a6b-9c1d-2e3f4a5b6c7d',
        observations: [
          {
            eventId: '1a2b3c4d-0001-4e5f-8a9b-0c1d2e3f4a5b',
            sequence: 1,
            observedAt: Date.now(),
            type: 'geofence',
            zoneId: 'home',
            transition: 'enter',
          },
        ],
      },
    });
    expect(observed.json()).toMatchObject({ results: [{ status: 'applied' }] });
    const phones = Object.values(runtime.engine.state.phone.devices);
    expect(phones[0]?.signals.geofence['home']?.inside).toBe(true);
    expect(runtime.engine.state.presence.state).toBe('unknown');

    const command = await call(devicePort, {
      path: '/api/v1/commands',
      token,
      body: {
        requestId: '3c1f6a2e-0d4b-4e8a-9f7c-2a1b3c4d5e6f',
        command: 'lighting.set',
        input: { target: 'lighting.entry', values: { power: false } },
      },
    });
    expect(command.status).toBe(200);
    expect(command.json()).toMatchObject({ status: 'accepted' });
  } finally {
    await cleanup();
  }
});

it('keeps the listener off without an enabled device section', async () => {
  const disabled = await boot({ enabled: false });
  try {
    expect((await call(disabled.httpPort, { path: '/devices' })).status).toBe(
      404,
    );
    await expect(
      call(disabled.devicePort, { path: '/api/v1/me' }),
    ).rejects.toThrow();
  } finally {
    await disabled.cleanup();
  }
});
