import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as prettier from 'prettier';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import {
  MeResponseSchema,
  PairResponseSchema,
  type DeviceScope,
  type PairResponse,
} from '../src/core/device-api.js';
import { validateRuntimeFileConfig } from '../src/runtime/config.js';
import { DeviceApiConfigSchema } from '../src/runtime/device-config.js';
import { buildOpenApiDocument, toYaml } from '../src/runtime/device-openapi.js';
import { DeviceRegistry } from '../src/runtime/device-registry.js';
import { LugnDeviceServer } from '../src/runtime/device-server.js';
import { LugnHttpServer } from '../src/runtime/http-server.js';
import { call, findAvailablePort } from './device-api-helpers.js';

const directories: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function tempPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'lugn-device-'));
  directories.push(directory);
  return join(directory, 'lighting-intent.json.devices.json');
}

async function registry(clock = new FakeClock(1_000_000)) {
  const path = tempPath();
  const value = new DeviceRegistry(path, { clock });
  await value.load();
  return { registry: value, path, clock };
}

async function pairDevice(
  value: DeviceRegistry,
  scopes?: DeviceScope[],
): Promise<PairResponse> {
  const { code } = value.createPairingCode(scopes ? { scopes } : {});
  return value.pair({ code, name: 'Brunos iPhone', platform: 'ios' });
}

describe('device registry', () => {
  it('exchanges a one-time code for a token and persists only its digest', async () => {
    const { registry: value, path } = await registry();
    const { code, scopes } = value.createPairingCode();
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(scopes).toEqual(['state:read', 'commands:write', 'phone:ingest']);
    const paired = PairResponseSchema.parse(
      await value.pair({
        code: code.toLowerCase(),
        name: ' Brunos iPhone ',
        platform: 'ios',
        appVersion: '1.0.0',
      }),
    );
    await expect(
      value.pair({ code, name: 'Second', platform: 'ios' }),
    ).rejects.toMatchObject({ code: 'invalid_pairing_code', status: 401 });

    const stored = readFileSync(path, 'utf8');
    const secret = paired.token.split('.')[2]!;
    expect(stored).not.toContain(secret);
    expect(stored).toContain(paired.deviceId);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    expect(value.authenticate(paired.token)).toMatchObject({
      id: paired.deviceId,
      name: 'Brunos iPhone',
    });
    expect(value.authenticate(`${paired.token.slice(0, -1)}A`)).toBeUndefined();
    expect(value.authenticate('garbage')).toBeUndefined();
    expect(value.list()[0]).toMatchObject({
      id: paired.deviceId,
      appVersion: '1.0.0',
      revokedAt: null,
    });

    const reloaded = new DeviceRegistry(path);
    await reloaded.load();
    expect(reloaded.authenticate(paired.token)?.id).toBe(paired.deviceId);
    expect(reloaded.list()[0]?.lastSeenAt).not.toBeNull();
  });

  it('expires codes, limits guesses and grants only the requested scopes', async () => {
    const { registry: value, clock } = await registry();
    const expiring = value.createPairingCode({ ttlSeconds: 60 });
    clock.advanceBy(60_000);
    await expect(
      value.pair({ code: expiring.code, name: 'Late', platform: 'ios' }),
    ).rejects.toMatchObject({ code: 'invalid_pairing_code' });

    const guarded = value.createPairingCode();
    for (let attempt = 0; attempt < 10; attempt += 1)
      await expect(
        value.pair({ code: 'ZZZZ-ZZZZ', name: 'Guess', platform: 'ios' }),
      ).rejects.toMatchObject({ code: 'invalid_pairing_code' });
    await expect(
      value.pair({ code: guarded.code, name: 'Real', platform: 'ios' }),
    ).rejects.toMatchObject({ code: 'invalid_pairing_code' });

    const readOnly = await pairDevice(value, ['state:read']);
    expect(readOnly.scopes).toEqual(['state:read']);
    expect(value.authenticate(readOnly.token)?.scopes).toEqual(['state:read']);
  });

  it('revokes a device durably and fails closed on an unreadable file', async () => {
    const { registry: value, path } = await registry();
    const paired = await pairDevice(value);
    const events: string[] = [];
    value.subscribe((event) => events.push(`${event.type}:${event.deviceId}`));
    const revoked = await value.revoke(paired.deviceId);
    expect(revoked.revokedAt).not.toBeNull();
    expect(events).toEqual([`revoked:${paired.deviceId}`]);
    expect(value.authenticate(paired.token)).toBeUndefined();
    await expect(value.revoke('dev_aaaaaaaaaaaaaaaa')).rejects.toMatchObject({
      status: 404,
    });

    const reloaded = new DeviceRegistry(path);
    await reloaded.load();
    expect(reloaded.authenticate(paired.token)).toBeUndefined();

    writeFileSync(path, '{"version":1,"devices":"broken"}');
    const warnings: string[] = [];
    const broken = new DeviceRegistry(path, {
      onWarning: (message) => warnings.push(message),
    });
    await broken.load();
    expect(warnings).toHaveLength(1);
    expect(() => broken.createPairingCode()).toThrow(
      'device_registry_unavailable',
    );
    expect(readFileSync(path, 'utf8')).toContain('broken');
  });
});

describe('device API configuration', () => {
  const minimal = {
    homeAssistant: {
      baseUrl: 'http://ha.local',
      tokenEnv: 'HA_TOKEN',
      entities: { 'lighting.ceiling': 'light.ceiling' },
    },
    scenes: [],
  };
  const device = {
    enabled: true,
    host: '100.64.0.10',
    port: 8789,
    allowedHosts: ['100.64.0.10:8789', 'lugn.example.ts.net:8789'],
  };

  it('is absent by default and requires an explicit interface, port and Host allowlist', () => {
    expect(() => validateRuntimeFileConfig(minimal)).not.toThrow();
    expect(() =>
      validateRuntimeFileConfig({ ...minimal, device }),
    ).not.toThrow();
    for (const broken of [
      { ...device, host: undefined },
      { ...device, port: undefined },
      { ...device, allowedHosts: [] },
      { ...device, enabled: undefined },
      { ...device, host: 'lugn.local' },
      { ...device, host: '0.0.0.0' },
      { ...device, allowedHosts: ['100.64.0.10:9999'] },
      { ...device, allowedHosts: ['100.64.0.10'] },
      { ...device, allowedHosts: ['user@100.64.0.10:8789'] },
      { ...device, port: 8787 },
      { ...device, unexpected: true },
    ])
      expect(() =>
        validateRuntimeFileConfig({ ...minimal, device: broken }),
      ).toThrow();
    expect(
      DeviceApiConfigSchema.parse({
        ...device,
        host: '0.0.0.0',
        allowAllInterfaces: true,
      }).allowAllInterfaces,
    ).toBe(true);
  });
});

describe('device API listener', () => {
  async function start() {
    const port = await findAvailablePort();
    const { registry: value } = await registry(new FakeClock(5_000_000));
    const server = new LugnDeviceServer({
      host: '127.0.0.1',
      port,
      allowedHosts: [`127.0.0.1:${port}`, `lugn.test:${port}`],
      registry: value,
    });
    await server.start();
    cleanups.push(() => server.stop());
    return { port, registry: value, server };
  }

  it('pairs over HTTP and serves only allowed Hosts to non-browser clients', async () => {
    const { port, registry: value } = await start();
    const { code } = value.createPairingCode();
    const paired = await call(port, {
      path: '/api/v1/pair',
      body: { code, name: 'iPhone', platform: 'ios' },
    });
    expect(paired.status).toBe(201);
    expect(paired.headers['access-control-allow-origin']).toBeUndefined();
    expect(paired.headers['cache-control']).toBe('no-store');
    const { token } = PairResponseSchema.parse(paired.json());

    const me = await call(port, {
      path: '/api/v1/me',
      host: `lugn.test:${port}`,
      token,
    });
    expect(me.status).toBe(200);
    expect(MeResponseSchema.parse(me.json()).device.scopes).toContain(
      'state:read',
    );

    expect(
      (await call(port, { path: '/api/v1/me', host: 'evil.test', token }))
        .status,
    ).toBe(421);
    const browser = await call(port, {
      path: '/api/v1/me',
      token,
      headers: { origin: 'http://evil.test' },
    });
    expect(browser.status).toBe(403);
    expect(browser.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await call(port, {
      method: 'OPTIONS',
      path: '/api/v1/me',
    });
    expect(preflight.status).toBe(405);
    expect(preflight.headers['access-control-allow-methods']).toBeUndefined();
    expect((await call(port, { path: '/api/v1/unknown', token })).status).toBe(
      404,
    );
  });

  it('rejects unauthenticated, oversized and mistyped requests and rate limits guesses', async () => {
    const { port, registry: value } = await start();
    const unauthenticated = await call(port, { path: '/api/v1/me' });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers['www-authenticate']).toContain('Bearer');

    const { code } = value.createPairingCode();
    expect(
      (
        await call(port, {
          path: '/api/v1/pair',
          rawBody: JSON.stringify({
            code,
            name: 'x'.repeat(4096),
            platform: 'ios',
          }),
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await call(port, {
          path: '/api/v1/pair',
          rawBody: '{}',
          headers: { 'content-type': 'text/plain' },
        })
      ).status,
    ).toBe(415);
    expect(
      (await call(port, { path: '/api/v1/pair', body: { code } })).status,
    ).toBe(400);

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1)
      statuses.push(
        (await call(port, { path: '/api/v1/me', token: 'lgn1.wrong' })).status,
      );
    expect(statuses.slice(0, 8).every((status) => status === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('enforces scopes and stops accepting a revoked token', async () => {
    const { port, registry: value } = await start();
    const paired = await pairDevice(value, ['phone:ingest']);
    expect(
      (await call(port, { path: '/api/v1/me', token: paired.token })).status,
    ).toBe(200);
    await value.revoke(paired.deviceId);
    expect(
      (await call(port, { path: '/api/v1/me', token: paired.token })).status,
    ).toBe(401);
  });
});

describe('operator device administration', () => {
  it('creates pairing codes, lists and revokes devices behind machine and panel authentication', async () => {
    const port = await findAvailablePort();
    const engine = new LugnEngine(new FakeClock(), {
      deviceIds: ['lighting.ceiling'],
      scenes: [],
    });
    cleanups.push(() => engine.dispose());
    const { registry: value } = await registry();
    const server = new LugnHttpServer({
      host: '127.0.0.1',
      port,
      bearerToken: 'operator-test',
      engine,
      capabilities: new CapabilityRegistry(engine),
      integrations: () => ({}),
      deviceRegistry: value,
    });
    await server.start();
    cleanups.push(() => server.stop());
    const token = 'operator-test';

    expect(
      (await call(port, { path: '/devices/pairing', body: {} })).status,
    ).toBe(401);
    const created = await call(port, {
      path: '/devices/pairing',
      token,
      body: { scopes: ['state:read'], ttlSeconds: 120 },
    });
    expect(created.status).toBe(201);
    const { code } = created.json() as { code: string };
    const paired = await value.pair({ code, name: 'iPad', platform: 'ios' });
    expect(paired.scopes).toEqual(['state:read']);
    const listed = (await call(port, { path: '/devices', token })).json() as {
      devices: Array<{ id: string }>;
    };
    expect(listed.devices.map((device) => device.id)).toEqual([
      paired.deviceId,
    ]);
    const revoked = await call(port, {
      path: `/devices/${paired.deviceId}/revoke`,
      token,
      body: {},
    });
    expect(revoked.status).toBe(200);
    expect(value.authenticate(paired.token)).toBeUndefined();
    expect(
      (
        await call(port, {
          path: '/devices/pairing',
          token,
          body: { ttlSeconds: 5 },
        })
      ).status,
    ).toBe(400);

    // The panel route needs a cookie session and CSRF token.
    expect(
      (await call(port, { path: '/ui/api/devices/pairing', body: {} })).status,
    ).toBe(401);
    const session = await call(port, {
      path: '/ui/api/session',
      body: { token },
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    const cookie = String(session.headers['set-cookie']).split(';')[0]!;
    const { csrfToken } = session.json() as { csrfToken: string };
    const withoutCsrf = await call(port, {
      path: '/ui/api/devices/pairing',
      body: {},
      headers: { origin: `http://127.0.0.1:${port}`, cookie },
    });
    expect(withoutCsrf.status).toBe(403);
    const panel = await call(port, {
      path: '/ui/api/devices/pairing',
      body: {},
      headers: {
        origin: `http://127.0.0.1:${port}`,
        cookie,
        'x-lugn-csrf': csrfToken,
      },
    });
    expect(panel.status).toBe(201);
    expect(
      (
        await call(port, {
          path: '/ui/api/devices',
          headers: { cookie },
        })
      ).status,
    ).toBe(200);
  });

  it('reports the device API as disabled without a registry', async () => {
    const port = await findAvailablePort();
    const engine = new LugnEngine(new FakeClock(), {
      deviceIds: ['lighting.ceiling'],
      scenes: [],
    });
    cleanups.push(() => engine.dispose());
    const server = new LugnHttpServer({
      host: '127.0.0.1',
      port,
      engine,
      capabilities: new CapabilityRegistry(engine),
      integrations: () => ({}),
    });
    await server.start();
    cleanups.push(() => server.stop());
    expect((await call(port, { path: '/devices' })).status).toBe(404);
  });
});

describe('published device API contract', () => {
  it('matches the committed OpenAPI document and is valid YAML', async () => {
    const generated = toYaml(buildOpenApiDocument());
    const committed = await readFile(
      new URL('../docs/api/openapi.v1.yaml', import.meta.url),
      'utf8',
    );
    // Run `npm run api:generate` after changing src/core/device-api.ts.
    expect(committed).toBe(generated);
    await expect(
      prettier.format(generated, { parser: 'yaml' }),
    ).resolves.toContain('openapi');
  });
});
