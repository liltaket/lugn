import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { CameraDashboardService } from '../src/application/camera-dashboard.js';
import { FakeClock } from '../src/core/clock.js';
import {
  createCameraSettings,
  type CameraDashboardConfig,
} from '../src/core/cameras.js';
import { CameraSettingsStore } from '../src/runtime/camera-settings-store.js';
import { CameraMediaProvider } from '../src/runtime/camera-media.js';
import { LugnHttpServer } from '../src/runtime/http-server.js';
import { LugnDisplayServer } from '../src/runtime/display-server.js';

const hubToken = 'a'.repeat(32);
const deskToken = 'b'.repeat(32);
const jpeg = new Uint8Array([255, 216, 255, 224, 0, 2, 255, 217]);
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing loopback port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'camera-http-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const clock = new FakeClock(100_000);
  const engine = new LugnEngine(clock);
  cleanups.push(() => engine.dispose());
  const config: CameraDashboardConfig = {
    cameras: [{ id: 'entry', name: 'Entré', entityId: 'camera.private_entry' }],
    triggers: [],
  };
  const store = new CameraSettingsStore(join(directory, 'cameras.json'), {
    ...createCameraSettings(config),
    enabled: true,
  });
  await store.load();
  const service = new CameraDashboardService(config, store, clock);
  cleanups.push(() => service.dispose());
  service.setConnected(true);
  service.seedStates([{ entity_id: 'camera.private_entry', state: 'idle' }]);
  const upstream = vi.fn<typeof fetch>(
    async () =>
      new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }),
  );
  const media = new CameraMediaProvider(
    service,
    config,
    'http://ha.test',
    'private-ha-token',
    upstream,
    clock,
  );
  cleanups.push(() => media.dispose());
  const webPort = await freePort();
  const displayPort = await freePort();
  const web = new LugnHttpServer({
    host: '127.0.0.1',
    port: webPort,
    bearerToken: 'private-ui-token',
    engine,
    capabilities: new CapabilityRegistry(engine),
    integrations: () => ({}),
    cameraService: service,
    cameraMedia: media,
  });
  await web.start();
  cleanups.push(() => web.stop());
  const display = new LugnDisplayServer({
    host: '127.0.0.1',
    port: displayPort,
    hubs: [
      { id: 'bed', role: 'bed', token: hubToken, castHost: '127.0.0.1' },
      { id: 'desk', role: 'desk', token: deskToken, castHost: '127.0.0.1' },
    ],
    capabilities: new CapabilityRegistry(engine),
    scenes: [...engine.scenes.values()],
    stateProvider: () => engine.state,
    cameraService: service,
    cameraMedia: media,
  });
  await display.start();
  cleanups.push(() => display.stop());
  const origin = `http://127.0.0.1:${webPort}`;
  const displayOrigin = `http://127.0.0.1:${displayPort}`;
  const login = await fetch(origin + '/ui/api/session', {
    method: 'POST',
    headers: { Origin: origin, 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'private-ui-token' }),
  });
  expect(login.status).toBe(200);
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const headers = {
    Origin: origin,
    Cookie: cookie,
    'X-Lugn-CSRF': csrfToken,
    'content-type': 'application/json',
  };
  return {
    service,
    media,
    store,
    upstream,
    origin,
    displayOrigin,
    cookie,
    headers,
    hubBase: displayOrigin + `/k/${hubToken}`,
    deskBase: displayOrigin + `/k/${deskToken}`,
  };
}
it('requires a UI session, same origin and CSRF for camera actions/settings', async () => {
  const s = await setup();
  const body = JSON.stringify({ action: 'show', cameraId: 'entry' });
  expect(
    (
      await fetch(s.origin + '/ui/api/cameras/action', {
        method: 'POST',
        headers: { Origin: s.origin, 'content-type': 'application/json' },
        body,
      })
    ).status,
  ).toBe(401);
  const noCsrf = { ...s.headers, 'X-Lugn-CSRF': '' };
  expect(
    (
      await fetch(s.origin + '/ui/api/cameras/action', {
        method: 'POST',
        headers: noCsrf,
        body,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(s.origin + '/ui/api/cameras/action', {
        method: 'POST',
        headers: { ...s.headers, Origin: 'http://evil.test' },
        body,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(s.origin + '/ui/api/cameras/settings', {
        method: 'PUT',
        headers: noCsrf,
        body: '{}',
      })
    ).status,
  ).toBe(403);
  expect(s.service.snapshot('web').active).toBeNull();
  const shown = await fetch(s.origin + '/ui/api/cameras/action', {
    method: 'POST',
    headers: s.headers,
    body,
  });
  expect(shown.status).toBe(200);
  const snapshot = await shown.json();
  expect(JSON.stringify(snapshot)).not.toMatch(
    /private-ha-token|camera\.private_entry|ha\.test/,
  );
  expect(s.service.snapshot('web').active?.cameraId).toBe('entry');
  expect(s.service.snapshot('bed').active).toBeNull();
  const invalid = await fetch(s.origin + '/ui/api/cameras/action', {
    method: 'POST',
    headers: s.headers,
    body: JSON.stringify({
      action: 'show',
      cameraId: 'entry',
      url: 'http://evil.test',
    }),
  });
  expect(invalid.status).toBe(400);
  const before = s.store.snapshot();
  const updated = await fetch(s.origin + '/ui/api/cameras/settings', {
    method: 'PUT',
    headers: s.headers,
    body: JSON.stringify({
      generation: before.generation,
      settings: { ...before.settings, enabled: false },
    }),
  });
  expect(updated.status).toBe(200);
  expect(s.service.snapshot('web').active).toBeNull();
  expect(s.upstream).not.toHaveBeenCalled();
});
it('protects UI images, applies privacy headers, and revokes old image paths on dismissal', async () => {
  const s = await setup();
  s.service.show('web', 'entry');
  const path = s.media.snapshot('web', '/ui/api/cameras/').active!.imageUrl!;
  expect((await fetch(s.origin + path)).status).toBe(401);
  expect(
    (
      await fetch(s.origin + path, {
        headers: { Cookie: s.cookie, Origin: 'http://evil.test' },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(s.origin + path, {
        headers: { Cookie: s.cookie, 'sec-fetch-site': 'cross-site' },
      })
    ).status,
  ).toBe(403);
  const good = await fetch(s.origin + path, { headers: { Cookie: s.cookie } });
  expect(good.status).toBe(200);
  expect(good.headers.get('cache-control')).toContain('no-store');
  expect(good.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  expect(good.headers.get('x-content-type-options')).toBe('nosniff');
  expect(new Uint8Array(await good.arrayBuffer())).toEqual(jpeg);
  s.service.dismiss('web');
  expect(
    (await fetch(s.origin + path, { headers: { Cookie: s.cookie } })).status,
  ).toBe(404);
  expect(s.upstream).toHaveBeenCalledTimes(1);
});
it('binds Hub image capabilities to its credential and role, with origin checks on image/actions', async () => {
  const s = await setup();
  const action = '/display-api/camera';
  const body = JSON.stringify({ action: 'show', cameraId: 'entry' });
  expect(
    (
      await fetch(s.hubBase + action, {
        method: 'POST',
        headers: {
          Origin: 'http://evil.test',
          'content-type': 'application/json',
        },
        body,
      })
    ).status,
  ).toBe(403);
  const shown = await fetch(s.hubBase + action, {
    method: 'POST',
    headers: { Origin: s.displayOrigin, 'content-type': 'application/json' },
    body,
  });
  expect(shown.status).toBe(200);
  const { cameraDashboard } = (await shown.json()) as {
    cameraDashboard: { active: { imageUrl: string } };
  };
  const path = cameraDashboard.active.imageUrl as string;
  expect(
    (await fetch(s.displayOrigin + path.replace(hubToken, 'c'.repeat(32))))
      .status,
  ).toBe(404);
  expect(
    (await fetch(s.displayOrigin + path.replace(hubToken, deskToken))).status,
  ).toBe(404);
  expect(
    (
      await fetch(s.displayOrigin + path, {
        headers: { Origin: 'http://evil.test' },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(s.displayOrigin + path, {
        headers: { 'sec-fetch-site': 'cross-site' },
      })
    ).status,
  ).toBe(403);
  const good = await fetch(s.displayOrigin + path);
  expect(good.status).toBe(200);
  expect(new Uint8Array(await good.arrayBuffer())).toEqual(jpeg);
  const hidden = await fetch(s.hubBase + action, {
    method: 'POST',
    headers: { Origin: s.displayOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'hide' }),
  });
  expect(hidden.status).toBe(200);
  expect((await fetch(s.displayOrigin + path)).status).toBe(404);
});
