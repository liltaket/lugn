import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startRuntime } from '../src/runtime/main.js';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import {
  calculateMusicVolume,
  defaultMusicVolumeSettings,
  MusicVolumeSettingsSchema,
} from '../src/core/music-volume-settings.js';
import { FakeClock } from '../src/core/clock.js';
import { MusicVolumeSettingsStore } from '../src/runtime/music-volume-settings-store.js';
import { LugnHttpServer } from '../src/runtime/http-server.js';

const directories: string[] = [];
const engines: LugnEngine[] = [];
const servers: LugnHttpServer[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  engines.splice(0).forEach((engine) => engine.dispose());
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lugn-volume-settings-'));
  directories.push(directory);
  const clock = new FakeClock(Date.parse('2026-10-04T12:00:00+02:00'));
  const adapter = new SimulatedMusicAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [
      { id: 'scene.cozy', name: 'Cozy', lighting: {} },
      { id: 'scene.all_off', name: 'Off', lighting: {} },
    ],
    music: { targets: { 'music.room': [] }, adapter },
  });
  engines.push(engine);
  const path = join(directory, 'volume.json');
  const store = new MusicVolumeSettingsStore(path);
  await store.load();
  adapter.observe('music.room', {
    playback: 'paused',
    volume: 0.4,
    source: 'Spotify',
    title: null,
  });
  await engine.handlePresence({
    type: 'presence.changed',
    presence: 'occupied',
    personCount: 1,
  });
  return { directory, clock, adapter, engine, path, store };
}

it.each([
  [0, -0.15],
  [180, -0.075],
  [360, 0],
  [720, 0],
  [1320, 0],
  [1380, -0.075],
  [1440, -0.15],
])('preserves the default curve at minute %s', (minute, expected) => {
  expect(
    calculateMusicVolume(defaultMusicVolumeSettings, 0.4, minute!, 1)
      .dailyOffset,
  ).toBeCloseTo(expected!);
});
it('interpolates custom points, occupancy and caps, including unknown baseline/count', () => {
  const settings = {
    ...defaultMusicVolumeSettings,
    dailyCurve: [
      { minute: 0, offset: -0.2 },
      { minute: 600, offset: 0.2 },
      { minute: 1440, offset: -0.2 },
    ],
    personOffset: -0.2,
    minimum: 0.1,
    maximum: 0.6,
  };
  expect(calculateMusicVolume(settings, 0.5, 300, 2)).toMatchObject({
    dailyOffset: 0,
    personOffset: -0.2,
    target: 0.3,
  });
  expect(calculateMusicVolume(settings, 0.5, 600, null).target).toBe(0.6);
  expect(calculateMusicVolume(settings, 0, 0, 2).target).toBe(0.1);
  expect(calculateMusicVolume(settings, null, 600, 1).target).toBeNull();
});
it.each([
  { minimum: 0.9, maximum: 0.1 },
  { maximum: 1.01 },
  { personOffset: 0.1 },
  { enabled: 'yes' },
  { minimum: NaN },
  {
    dailyCurve: [
      { minute: 0, offset: 0 },
      { minute: 0, offset: 0 },
      { minute: 1440, offset: 0 },
    ],
  },
  {
    dailyCurve: [
      { minute: 1, offset: 0 },
      { minute: 1440, offset: 0 },
    ],
  },
  {
    dailyCurve: [
      { minute: 0, offset: 0 },
      { minute: 1440, offset: -0.1 },
    ],
  },
  {
    dailyCurve: [
      { minute: 0, offset: 0 },
      { minute: 1441, offset: 0 },
    ],
  },
  {
    dailyCurve: [
      { minute: 0, offset: 0 },
      { minute: 400.5, offset: 0 },
      { minute: 1440, offset: 0 },
    ],
  },
  { extra: true },
])('rejects invalid settings %j', (invalid) => {
  expect(
    MusicVolumeSettingsSchema.safeParse({
      ...defaultMusicVolumeSettings,
      ...invalid,
    }).success,
  ).toBe(false);
});
it('persists and applies edits, preserves baseline, and uses them after restart', async () => {
  const { engine, adapter, clock, store, path } = await fixture();
  const settings = {
    ...engine.getMusicVolumeSettings(),
    dailyCurve: [
      { minute: 0, offset: -0.1 },
      { minute: 1440, offset: -0.1 },
    ],
    personOffset: -0.2,
    maximum: 0.25,
  };
  await store.save(engine, settings, engine.getMusicVolumeSettings());
  expect(adapter.dispatched.at(-1)?.requested).toEqual({
    property: 'volume',
    value: 0.25,
  });
  expect(engine.getMusicVolumePolicySnapshots()['music.room']?.baseline).toBe(
    0.4,
  );
  const saved = await new MusicVolumeSettingsStore(path).load();
  expect(saved).toEqual(settings);
  const restoredAdapter = new SimulatedMusicAdapter(clock);
  const restored = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    music: { targets: { 'music.room': [] }, adapter: restoredAdapter },
    restoredMusicIntent: engine.getMusicIntentSnapshot(),
  });
  engines.push(restored);
  restored.applyMusicVolumeSettings(saved!);
  restoredAdapter.observe('music.room', {
    playback: 'paused',
    volume: 0.25,
    source: null,
    title: null,
  });
  await restored.handlePresence({
    type: 'presence.changed',
    presence: 'occupied',
    personCount: 2,
  });
  expect(
    restored.getMusicVolumePolicySnapshots()['music.room']?.target,
  ).toBeCloseTo(0.1);
  expect(
    restoredAdapter.dispatched.every(
      (command) => command.requested.property === 'volume',
    ),
  ).toBe(true);
});
it('saving disabled/enabled, caps and offsets preserves manual volume and Pause without playback commands', async () => {
  const { engine, adapter, store, clock } = await fixture();
  const user = { actor: { type: 'user' as const }, source: 'test' };
  await engine.requestMusic(
    'music.room',
    { property: 'volume', value: 0.95 },
    user,
  );
  await engine.requestMusic(
    'music.room',
    { property: 'playback', value: 'paused' },
    user,
  );
  const before = adapter.dispatched.length;
  const hold = engine.getMusicVolumePolicySnapshots()['music.room']?.manualHold;
  for (const enabled of [false, true]) {
    const settings = {
      ...engine.getMusicVolumeSettings(),
      enabled,
      maximum: 0.1,
      personOffset: -0.5,
    };
    await store.save(engine, settings, engine.getMusicVolumeSettings());
    expect(engine.getMusicVolumePolicySnapshots()['music.room']).toMatchObject({
      manualHold: hold,
      effectiveTarget: 0.95,
      activeOwner: 'manual',
      policyEnabled: enabled,
    });
    expect(
      engine.getMusicPolicySnapshot('music.room').playback.manualPause,
    ).not.toBeNull();
  }
  clock.advanceBy(60_000);
  expect(adapter.dispatched).toHaveLength(before);
});
it('disabling and reenabling without a manual hold changes only volume', async () => {
  const { engine, adapter, store } = await fixture();
  await store.save(
    engine,
    { ...engine.getMusicVolumeSettings(), enabled: false, maximum: 0.1 },
    engine.getMusicVolumeSettings(),
  );
  expect(adapter.dispatched).toHaveLength(0);
  await store.save(
    engine,
    { ...engine.getMusicVolumeSettings(), enabled: true },
    engine.getMusicVolumeSettings(),
  );
  expect(adapter.dispatched).toHaveLength(1);
  expect(adapter.dispatched[0]?.requested).toEqual({
    property: 'volume',
    value: 0.1,
  });
});
it('serializes writes and rejects stale settings without replacing durable data', async () => {
  const { engine, store, path } = await fixture();
  const original = engine.getMusicVolumeSettings();
  const changed = { ...original, minimum: 0.2 };
  const results = await Promise.allSettled([
    store.save(engine, changed, original),
    store.save(engine, { ...original, maximum: 0.5 }, original),
  ]);
  expect(results.map((result) => result.status)).toEqual([
    'fulfilled',
    'rejected',
  ]);
  expect(JSON.parse(await readFile(path, 'utf8')).settings).toEqual(changed);
});
it('keeps malformed persisted settings and rejects writes rather than overwriting them', async () => {
  const { engine, path } = await fixture();
  await writeFile(path, 'broken');
  const store = new MusicVolumeSettingsStore(path);
  expect(await store.load()).toBeUndefined();
  await expect(
    store.save(
      engine,
      engine.getMusicVolumeSettings(),
      engine.getMusicVolumeSettings(),
    ),
  ).rejects.toMatchObject({ code: 'volume_settings_save_failed' });
  expect(await readFile(path, 'utf8')).toBe('broken');
});
it('reports persistence errors without changing the running policy', async () => {
  const { directory, engine } = await fixture();
  const blocker = join(directory, 'blocker');
  await writeFile(blocker, 'file');
  const store = new MusicVolumeSettingsStore(join(blocker, 'settings.json'));
  const original = engine.getMusicVolumeSettings();
  await expect(
    store.save(engine, { ...original, enabled: false }, original),
  ).rejects.toMatchObject({ code: 'volume_settings_save_failed' });
  expect(engine.getMusicVolumeSettings()).toEqual(original);
});
it('authenticates preview/save with existing session, origin and CSRF boundaries; preview sends no commands', async () => {
  const { engine, adapter, store, path } = await fixture();
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const server = new LugnHttpServer({
    host: '127.0.0.1',
    port,
    bearerToken: 'test-token',
    engine,
    volumeSettingsStore: store,
    capabilities: new CapabilityRegistry(engine),
    integrations: () => ({}),
  });
  servers.push(server);
  await server.start();
  const base = `http://127.0.0.1:${port}`;
  const settings = engine.getMusicVolumeSettings();
  const body = { settings, target: 'music.room', minute: 0, personCount: 2 };
  expect(
    (
      await fetch(`${base}/ui/api/music-settings/preview`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', origin: base },
      })
    ).status,
  ).toBe(401);
  const session = await fetch(`${base}/ui/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ token: 'test-token' }),
  });
  const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
  const { csrfToken } = (await session.json()) as { csrfToken: string };
  const headers = {
    cookie,
    'content-type': 'application/json',
    origin: base,
    'x-lugn-csrf': csrfToken,
  };
  const post = (
    suffix: string,
    data: unknown,
    override: Record<string, string> = {},
  ) =>
    fetch(`${base}/ui/api/music-settings${suffix}`, {
      method: 'POST',
      headers: { ...headers, ...override },
      body: JSON.stringify(data),
    });
  expect(
    (await post('/preview', body, { 'x-lugn-csrf': 'wrong' })).status,
  ).toBe(403);
  expect(
    (
      await post(
        '',
        { settings, expectedSettings: settings },
        { origin: 'http://localhost:1234' },
      )
    ).status,
  ).toBe(403);
  const before = engine.getMusicIntentSnapshot();
  const preview = await post('/preview', body);
  expect(preview.status).toBe(200);
  expect(await preview.json()).toMatchObject({
    dailyOffset: -0.15,
    personOffset: -0.1,
    observedVolume: 0.4,
  });
  expect(engine.getMusicIntentSnapshot()).toEqual(before);
  expect(adapter.dispatched).toHaveLength(0);
  expect(await new MusicVolumeSettingsStore(path).load()).toBeUndefined();
  expect(
    (await post('/preview', { ...body, target: 'music.other' })).status,
  ).toBe(400);
  const invalid = await post('', {
    settings: { ...settings, minimum: 0.9 },
    expectedSettings: settings,
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({
    issues: [
      {
        path: 'settings.minimum',
        message: 'Minimum must not exceed maximum.',
      },
    ],
  });
  expect(
    (
      await post('', {
        settings: { ...settings, enabled: false },
        expectedSettings: settings,
      })
    ).status,
  ).toBe(200);
  expect(
    (await post('', { settings, expectedSettings: settings })).status,
  ).toBe(409);
  expect((await new MusicVolumeSettingsStore(path).load())?.enabled).toBe(
    false,
  );
  const overview = await fetch(`${base}/ui/api/overview`, {
    headers: { cookie },
  });
  expect(await overview.json()).toMatchObject({
    musicSettings: { enabled: false },
    musicSettingsDefaults: defaultMusicVolumeSettings,
    musicSettingsEnabled: true,
  });
});

it.each([false, true])(
  'retains later BILRESA enable/suspension after restoring matching preferences (%s)',
  async (temporary) => {
    const { engine, store, clock } = await fixture();
    const settings = { ...engine.getMusicVolumeSettings(), maximum: 0.6 };
    await store.save(engine, settings, engine.getMusicVolumeSettings());
    await engine.handleBilresaPress(
      '2',
      temporary ? 'long_press' : 'multi_press_1',
    );
    const intent = engine.getMusicIntentSnapshot();
    expect(intent.volumeAutomationEnabled).toBe(false);
    const restored = new LugnEngine(clock, {
      deviceIds: [],
      scenes: [...engine.scenes.values()],
      music: { targets: { 'music.room': [] } },
      restoredMusicIntent: intent,
      musicVolumeSettings: settings,
    });
    engines.push(restored);
    expect(restored.getMusicVolumeSettings().enabled).toBe(false);
    if (temporary) {
      await restored.handleBilresaPress('2', 'long_press');
      expect(restored.getMusicVolumeSettings().enabled).toBe(true);
    }
  },
);
it('new durable preferences win over stale intent after a save/crash window while retaining holds', async () => {
  const { engine, store, clock } = await fixture();
  await engine.requestMusic(
    'music.room',
    { property: 'volume', value: 0.95 },
    { actor: { type: 'user' }, source: 'test' },
  );
  const staleIntent = engine.getMusicIntentSnapshot();
  const settings = {
    ...engine.getMusicVolumeSettings(),
    enabled: false,
    maximum: 0.2,
  };
  await store.save(engine, settings, engine.getMusicVolumeSettings());
  const restored = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    music: { targets: { 'music.room': [] } },
    restoredMusicIntent: staleIntent,
    musicVolumeSettings: settings,
  });
  engines.push(restored);
  expect(restored.getMusicVolumeSettings()).toEqual(settings);
  expect(restored.getMusicVolumePolicySnapshots()['music.room']).toMatchObject({
    activeOwner: 'manual',
    manualHold: { volume: 0.95 },
    policyEnabled: false,
  });
});

it('runtime loads the persisted policy before HA seeding and publishes it after restart', async () => {
  const { directory, engine, path, store } = await fixture();
  const saved = {
    ...engine.getMusicVolumeSettings(),
    enabled: false,
    minimum: 0.12,
    maximum: 0.55,
  };
  await store.save(engine, saved, engine.getMusicVolumeSettings());
  const statePath = join(directory, 'intent.json');
  await writeFile(`${statePath}.volume.json`, await readFile(path));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  vi.stubEnv('LUGN_TEST_VOLUME_TOKEN', 'fixture-only');
  const configPath = join(directory, 'runtime.json');
  await writeFile(
    configPath,
    JSON.stringify({
      http: { host: '127.0.0.1', port },
      scenes: [],
      homeAssistant: {
        baseUrl: 'http://home-assistant.invalid:8123',
        tokenEnv: 'LUGN_TEST_VOLUME_TOKEN',
        entities: { 'lighting.ceiling': 'light.ceiling' },
        music: { 'music.room': { entityId: 'media_player.room' } },
      },
    }),
  );
  const runtime = await startRuntime(configPath, {
    lightingIntentPath: statePath,
    homeAssistantFetch: async () => new Response('[]', { status: 200 }),
    createHomeAssistantSocket: () => ({
      addEventListener() {},
      send() {},
      close() {},
    }),
  });
  try {
    expect(runtime.engine.getMusicVolumeSettings()).toEqual(saved);
  } finally {
    await runtime.stop();
  }
});
