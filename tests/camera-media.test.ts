import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CameraDashboardService } from '../src/application/camera-dashboard.js';
import {
  createCameraSettings,
  type CameraDashboardConfig,
} from '../src/core/cameras.js';
import { FakeClock } from '../src/core/clock.js';
import { CameraMediaProvider } from '../src/runtime/camera-media.js';
import { CameraSettingsStore } from '../src/runtime/camera-settings-store.js';

const jpeg = new Uint8Array([255, 216, 255, 224, 0, 2, 255, 217]);
const config: CameraDashboardConfig = {
  cameras: [
    { id: 'entry', name: 'Entré', entityId: 'camera.private_entry' },
    { id: 'front', name: 'Framsida', entityId: 'camera.private_front' },
  ],
  triggers: [],
};
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const image = () =>
  new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } });
async function setup(implementation: typeof fetch = async () => image()) {
  const directory = await mkdtemp(join(tmpdir(), 'camera-media-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const clock = new FakeClock(100_000);
  const store = new CameraSettingsStore(join(directory, 'cameras.json'), {
    ...createCameraSettings(config),
    enabled: true,
  });
  await store.load();
  const service = new CameraDashboardService(config, store, clock);
  cleanups.push(() => service.dispose());
  service.setConnected(true);
  service.seedStates(
    config.cameras.map((c) => ({ entity_id: c.entityId, state: 'idle' })),
  );
  const upstream = vi.fn<typeof fetch>(implementation);
  const media = new CameraMediaProvider(
    service,
    config,
    'http://ha.test',
    'private-ha-token',
    upstream,
    clock,
  );
  cleanups.push(() => media.dispose());
  const view = service.show('bed', 'entry').active!;
  return {
    clock,
    store,
    service,
    media,
    upstream,
    view,
    read: () => media.read('bed', view.id, 'entry'),
  };
}
it('requests only the configured HA endpoint and exposes no private metadata', async () => {
  const s = await setup();
  const result = await s.read();
  expect(result.body).toEqual(jpeg);
  expect(s.upstream.mock.calls[0]?.[0]).toBe(
    'http://ha.test/api/camera_proxy/camera.private_entry?width=640&height=360',
  );
  expect(s.upstream.mock.calls[0]?.[1]).toMatchObject({
    method: 'GET',
    redirect: 'manual',
    headers: { Authorization: 'Bearer private-ha-token', Accept: 'image/jpeg' },
  });
  const snapshot = s.media.snapshot('bed', '/protected/cameras/');
  expect(snapshot.active?.imageUrl).toBe(
    `/protected/cameras/${s.view.id}/entry/image`,
  );
  expect(JSON.stringify(snapshot)).not.toMatch(
    /private_entry|private-ha-token|ha\.test/,
  );
  await expect(
    s.media.read('bed', s.view.id, 'http://evil.test'),
  ).rejects.toMatchObject({ status: 404 });
  expect(s.upstream).toHaveBeenCalledTimes(1);
});
it.each([
  'http://bad.test/',
  '//bad.test/',
  '/safe/?url=',
  '/safe/../',
  '/safe/#',
  '/safe/%2f/',
])('rejects unsafe public prefix %s', async (prefix) => {
  const s = await setup();
  expect(() => s.media.snapshot('bed', prefix)).toThrow('Invalid camera route');
});
it.each([
  'file:///tmp/x',
  'http://user:password@ha.test',
  'http://ha.test?secret=x',
  'http://ha.test#secret',
])('rejects unsafe HA base %s', async (base) => {
  const s = await setup();
  expect(
    () =>
      new CameraMediaProvider(
        s.service,
        config,
        base,
        'token',
        s.upstream,
        s.clock,
      ),
  ).toThrow();
});
it('deduplicates concurrent reads, briefly caches, and returns independent byte copies', async () => {
  let finish!: (response: Response) => void;
  const s = await setup(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = s.read();
  const second = s.read();
  expect(s.upstream).toHaveBeenCalledTimes(1);
  finish(image());
  const [a, b] = await Promise.all([first, second]);
  a.body[0] = 0;
  expect(b.body[0]).toBe(255);
  expect((await s.read()).body[0]).toBe(255);
  expect(s.upstream).toHaveBeenCalledTimes(1);
  s.clock.advanceBy(750);
  const next = s.read();
  expect(s.upstream).toHaveBeenCalledTimes(2);
  finish(image());
  await next;
});
it.each([
  [
    'redirect',
    () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://evil.test/private' },
      }),
  ],
  [
    'wrong MIME',
    () => new Response(jpeg, { headers: { 'content-type': 'image/svg+xml' } }),
  ],
  [
    'invalid JPEG',
    () =>
      new Response('<script>bad</script>', {
        headers: { 'content-type': 'image/jpeg' },
      }),
  ],
  [
    'oversize declared',
    () =>
      new Response(jpeg, {
        headers: { 'content-type': 'image/jpeg', 'content-length': '1048577' },
      }),
  ],
  [
    'invalid length',
    () =>
      new Response(jpeg, {
        headers: { 'content-type': 'image/jpeg', 'content-length': '-1' },
      }),
  ],
  [
    'oversize streamed',
    () =>
      new Response(new Uint8Array(1048577), {
        headers: { 'content-type': 'image/jpeg' },
      }),
  ],
  [
    'upstream error',
    () => new Response('private upstream failure', { status: 500 }),
  ],
] as const)(
  'rejects %s, conceals upstream errors, and negatively caches',
  async (_name, response) => {
    const s = await setup(async () => response());
    await expect(s.read()).rejects.toMatchObject({
      status: 503,
      message: 'camera_image_unavailable',
    });
    await expect(s.read()).rejects.toMatchObject({ status: 503 });
    expect(s.upstream).toHaveBeenCalledTimes(1);
    s.clock.advanceBy(1000);
    await expect(s.read()).rejects.toMatchObject({ status: 503 });
    expect(s.upstream).toHaveBeenCalledTimes(2);
  },
);
it('bounds a transport that ignores AbortSignal to four seconds', async () => {
  const s = await setup(() => new Promise(() => {}));
  const read = s.read();
  const rejected = expect(read).rejects.toMatchObject({ status: 503 });
  s.clock.advanceBy(4000);
  await rejected;
  expect((s.upstream.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(
    true,
  );
  expect(s.clock.pendingTimers()).toBe(1); // only the presentation expiry remains
});
it.each(['dismiss', 'expiry', 'disconnect', 'disabled', 'dispose'] as const)(
  'revokes an in-flight image on %s',
  async (reason) => {
    let finish!: (response: Response) => void;
    const s = await setup(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const read = s.read();
    const rejected = expect(read).rejects.toMatchObject({ status: 503 });
    if (reason === 'dismiss') s.service.dismiss('bed');
    if (reason === 'expiry') s.clock.advanceBy(30_000);
    if (reason === 'disconnect') s.service.setConnected(false);
    if (reason === 'disabled')
      await s.service.updateSettings(
        { ...s.store.snapshot().settings, enabled: false },
        s.store.snapshot().generation,
      );
    if (reason === 'dispose') s.media.dispose();
    await rejected;
    finish(image());
    await expect(s.read()).rejects.toMatchObject({ status: 404 });
  },
);
it('requires the viewer-specific active view and rechecks it after a shared fetch', async () => {
  let finish!: (response: Response) => void;
  const s = await setup(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const desk = s.service.show('desk', 'entry').active!;
  await expect(s.media.read('desk', s.view.id, 'entry')).rejects.toMatchObject({
    status: 404,
  });
  const bedRead = s.read();
  const rejected = expect(bedRead).rejects.toMatchObject({ status: 404 });
  const deskRead = s.media.read('desk', desk.id, 'entry');
  s.service.dismiss('bed'); // desk still owns the transport, so it must not be aborted
  expect((s.upstream.mock.calls[0]?.[1]?.signal as AbortSignal).aborted).toBe(
    false,
  );
  finish(image());
  await rejected;
  expect((await deskRead).body).toEqual(jpeg);
  expect(s.upstream).toHaveBeenCalledTimes(1);
});

// ── Camera grid: every allowed camera at once, under a lease ──
const gridConfig: CameraDashboardConfig = {
  cameras: [
    { id: 'entry', name: 'Entré', entityId: 'camera.private_entry' },
    { id: 'front', name: 'Framsida', entityId: 'camera.private_front' },
    { id: 'north', name: 'Norr', entityId: 'camera.private_north' },
    { id: 'south', name: 'Syd', entityId: 'camera.private_south' },
    { id: 'back', name: 'Baksida', entityId: 'camera.private_back' },
  ],
  triggers: [],
};
async function gridSetup(
  implementation: typeof fetch = async () => image(),
  settings: Partial<ReturnType<typeof createCameraSettings>> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'camera-grid-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const clock = new FakeClock(100_000);
  const store = new CameraSettingsStore(join(directory, 'cameras.json'), {
    ...createCameraSettings(gridConfig),
    enabled: true,
    ...settings,
  });
  await store.load();
  const service = new CameraDashboardService(gridConfig, store, clock);
  cleanups.push(() => service.dispose());
  service.setConnected(true);
  service.seedStates(
    gridConfig.cameras.map((c) => ({ entity_id: c.entityId, state: 'idle' })),
  );
  const upstream = vi.fn<typeof fetch>(implementation);
  const media = new CameraMediaProvider(
    service,
    gridConfig,
    'http://ha.test',
    'private-ha-token',
    upstream,
    clock,
  );
  cleanups.push(() => media.dispose());
  return { clock, store, service, media, upstream };
}

it('opens a grid of every allowed camera and reads their frames at once', async () => {
  const s = await gridSetup();
  const lease = s.media.openGrid('bed', '/k/token/display-api/camera-grid/');
  expect(lease.cameras.map((c) => c.id)).toEqual([
    'entry',
    'front',
    'north',
    'south',
    'back',
  ]);
  expect(lease.cameras[2]).toEqual({
    id: 'north',
    name: 'Norr',
    imageUrl: '/k/token/display-api/camera-grid/north/image',
  });
  // No upstream address, entity or token reaches the screen.
  expect(JSON.stringify(lease)).not.toMatch(/private|ha\.test|token"/);
  const frames = await Promise.all(
    lease.cameras.map((camera) => s.media.readGrid('bed', camera.id)),
  );
  expect(frames.every((frame) => frame.body.length === jpeg.length)).toBe(true);
  expect(s.upstream).toHaveBeenCalledTimes(5);
});

it('refuses grid frames without a lease, after it lapses and for a disabled camera', async () => {
  const s = await gridSetup(undefined, {
    cameras: {
      entry: true,
      front: true,
      north: false,
      south: true,
      back: true,
    },
  });
  await expect(s.media.readGrid('bed', 'entry')).rejects.toMatchObject({
    status: 404,
  });
  const lease = s.media.openGrid('bed', '/k/token/display-api/camera-grid/');
  // A camera switched off in settings is not offered and cannot be read.
  expect(lease.cameras.map((c) => c.id)).not.toContain('north');
  await expect(s.media.readGrid('bed', 'north')).rejects.toMatchObject({
    status: 404,
  });
  await expect(s.media.readGrid('bed', 'unknown')).rejects.toMatchObject({
    status: 404,
  });
  // Another screen has no lease of its own.
  await expect(s.media.readGrid('desk', 'entry')).rejects.toMatchObject({
    status: 404,
  });
  await s.media.readGrid('bed', 'entry');
  // The lease lapses by itself when it is not renewed, and renewing extends it.
  s.clock.advanceBy(40_000);
  s.media.openGrid('bed', '/k/token/display-api/camera-grid/');
  s.clock.advanceBy(40_000);
  await s.media.readGrid('bed', 'entry');
  s.clock.advanceBy(10_000);
  await expect(s.media.readGrid('bed', 'entry')).rejects.toMatchObject({
    status: 404,
  });
});

it('ends a grid when it is closed, settings change or Home Assistant disconnects', async () => {
  const s = await gridSetup();
  const open = () => s.media.openGrid('bed', '/k/t/display-api/camera-grid/');
  open();
  s.media.closeGrid('bed');
  await expect(s.media.readGrid('bed', 'entry')).rejects.toMatchObject({
    status: 404,
  });
  open();
  await s.service.updateSettings(
    { ...s.store.snapshot().settings, durationSeconds: 45 },
    s.store.snapshot().generation,
  );
  await expect(s.media.readGrid('bed', 'entry')).rejects.toMatchObject({
    status: 404,
  });
  open();
  s.service.setConnected(false);
  await expect(s.media.readGrid('bed', 'entry')).rejects.toMatchObject({
    status: 404,
  });
  expect(() => open()).toThrow('camera_unavailable_or_disabled');
});

it('refuses a grid while previews are off or the screen is not allowed', async () => {
  const off = await gridSetup(undefined, { enabled: false });
  expect(() =>
    off.media.openGrid('bed', '/k/t/display-api/camera-grid/'),
  ).toThrow('camera_unavailable_or_disabled');
  const desk = await gridSetup(undefined, { viewers: ['desk'] });
  expect(() =>
    desk.media.openGrid('bed', '/k/t/display-api/camera-grid/'),
  ).toThrow('camera_unavailable_or_disabled');
  expect(
    desk.media.openGrid('desk', '/k/t/display-api/camera-grid/').cameras,
  ).toHaveLength(5);
});

it('shares a frame between screens looking at the same camera', async () => {
  const s = await gridSetup();
  s.media.openGrid('bed', '/k/a/display-api/camera-grid/');
  s.media.openGrid('desk', '/k/b/display-api/camera-grid/');
  // Bed and desk both look at the entrance: one upstream fetch for both.
  await Promise.all([
    s.media.readGrid('bed', 'entry'),
    s.media.readGrid('desk', 'entry'),
  ]);
  expect(s.upstream).toHaveBeenCalledTimes(1);
  // A second look within the cache time is no new fetch either.
  await s.media.readGrid('desk', 'entry');
  expect(s.upstream).toHaveBeenCalledTimes(1);
  s.clock.advanceBy(1_000);
  await s.media.readGrid('desk', 'entry');
  expect(s.upstream).toHaveBeenCalledTimes(2);
});

it('limits a grid to six fetches at once and keeps it from crowding out a single view', async () => {
  const eight: CameraDashboardConfig = {
    cameras: Array.from({ length: 8 }, (_, i) => ({
      id: `cam${i + 1}`,
      name: `Kamera ${i + 1}`,
      entityId: `camera.private_${i + 1}`,
    })),
    triggers: [],
  };
  const directory = await mkdtemp(join(tmpdir(), 'camera-grid-8-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const clock = new FakeClock(100_000);
  const store = new CameraSettingsStore(join(directory, 'cameras.json'), {
    ...createCameraSettings(eight),
    enabled: true,
  });
  await store.load();
  const service = new CameraDashboardService(eight, store, clock);
  cleanups.push(() => service.dispose());
  service.setConnected(true);
  service.seedStates(
    eight.cameras.map((c) => ({ entity_id: c.entityId, state: 'idle' })),
  );
  const releases: Array<() => void> = [];
  const upstream = vi.fn<typeof fetch>(
    () =>
      new Promise<Response>((resolve) => releases.push(() => resolve(image()))),
  );
  const media = new CameraMediaProvider(
    service,
    eight,
    'http://ha.test',
    'private-ha-token',
    upstream,
    clock,
  );
  cleanups.push(() => media.dispose());
  media.openGrid('bed', '/k/a/display-api/camera-grid/');
  const first = eight.cameras
    .slice(0, 6)
    .map((camera) => media.readGrid('bed', camera.id));
  await Promise.resolve();
  expect(upstream).toHaveBeenCalledTimes(6);
  // The seventh waits for a free fetch: busy, not queued.
  await expect(media.readGrid('bed', 'cam7')).rejects.toMatchObject({
    status: 503,
    code: 'camera_image_busy',
  });
  // A single view on another screen still gets its own fetch.
  const view = service.show('desk', 'cam7').active!;
  const single = media.read('desk', view.id, 'cam7');
  await Promise.resolve();
  expect(upstream).toHaveBeenCalledTimes(7);
  for (const release of releases.splice(0)) release();
  await Promise.all([...first, single]);
});
