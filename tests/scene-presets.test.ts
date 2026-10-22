import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { withRoomPresets } from '../src/application/dashboard-scenes.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import type { LightingScene } from '../src/core/schemas.js';
import { LugnHttpServer } from '../src/runtime/http-server.js';
import { LightingIntentStore } from '../src/runtime/lighting-intent-store.js';
import { ScenePresetStore } from '../src/runtime/scene-preset-store.js';
import { startRuntime } from '../src/runtime/main.js';

const deviceIds = ['lighting.ceiling', 'lighting.wled'];
const baseScenes = withRoomPresets([], deviceIds);
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
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(filePath?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'lugn-scenes-'));
  directories.push(directory);
  const clock = new FakeClock();
  const adapter = new SimulatedLightingAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds,
    scenes: baseScenes,
    adapter,
    defaultSceneId: 'scene.everyday_light',
  });
  engines.push(engine);
  const path = filePath ?? join(directory, 'presets.json');
  const store = new ScenePresetStore({
    filePath: path,
    deviceIds,
    defaultSceneId: 'scene.everyday_light',
  });
  return { directory, path, clock, adapter, engine, store };
}
const input = {
  name: 'Min kväll',
  lighting: {
    'lighting.ceiling': { power: false, brightness: 0 },
    'lighting.wled': { power: true, brightness: 23, colorTemperature: 2700 },
  },
};

describe('persistent dashboard presets', () => {
  it('keeps a deleted active all-off preset off across prelight, expiry and restart', async () => {
    const { store } = await fixture();
    const clock = new FakeClock(Date.parse('2026-10-04T12:00:00+02:00'));
    const adapter = new SimulatedLightingAdapter(clock);
    const engine = new LugnEngine(clock, {
      deviceIds,
      scenes: baseScenes,
      adapter,
      defaultSceneId: 'scene.everyday_light',
      continuityMs: 1000,
    });
    engines.push(engine);
    const off = await store.create(engine, {
      name: 'Min natt',
      lighting: Object.fromEntries(
        deviceIds.map((id) => [id, { power: false, brightness: 0 }]),
      ),
    });
    await engine.activateScene(off.id, { type: 'user' });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
    });
    const before = adapter.dispatched.length;
    await store.delete(engine, off.id, off);
    expect(adapter.dispatched).toHaveLength(before);
    await engine.handlePrelight({ type: 'presence.prelight', active: true });
    expect(engine.state.diagnostics.at(-1)?.details?.['reason']).toBe(
      'all_lights_off_scene',
    );
    clock.advanceBy(1500);
    await engine.handlePrelight({ type: 'presence.prelight', active: true });
    expect(adapter.dispatched).toHaveLength(before);
    expect(engine.state.lighting.currentScene).toBeNull();
    const restoredAdapter = new SimulatedLightingAdapter(clock);
    const restored = new LugnEngine(clock, {
      deviceIds,
      scenes: [...engine.scenes.values()],
      adapter: restoredAdapter,
      defaultSceneId: 'scene.everyday_light',
      restoredLightingIntent: engine.getLightingIntentSnapshot(),
    });
    engines.push(restored);
    await restored.handlePrelight({ type: 'presence.prelight', active: true });
    expect(restoredAdapter.dispatched).toHaveLength(0);
    expect(restored.state.diagnostics.at(-1)?.details?.['reason']).toBe(
      'all_lights_off_scene',
    );
    expect(
      restored.state.intent.holds.filter(
        (hold) => hold.scope === 'lighting.activation',
      ),
    ).toHaveLength(deviceIds.length);
    await restored.activateScene('scene.everyday_light', { type: 'user' });
    expect(
      restored.state.lighting.devices['lighting.wled']?.effectiveDesired.power,
    ).toBe(true);
  });
  it.each([false, true])(
    'restores saved presets before intent and safely detaches a deleted active scene (%s)',
    async (deleted) => {
      const { directory, engine, store, path } = await fixture();
      const statePath = join(directory, 'intent.json');
      const created = await store.create(engine, input);
      const soft = engine.scenes.get('scene.soft_light')!;
      await store.update(engine, soft.id, { ...input, expectedScene: soft });
      await engine.activateScene(created.id, { type: 'user' });
      // Keep an older intent snapshot to exercise the crash window after saving
      // a tombstone but before lighting intent persistence catches up.
      await writeFile(
        statePath,
        JSON.stringify({
          version: 1,
          snapshot: engine.getLightingIntentSnapshot(),
        }),
      );
      if (deleted) await store.delete(engine, created.id, created);
      await writeFile(`${statePath}.scenes.json`, await readFile(path));
      const configPath = join(directory, 'runtime.json');
      vi.stubEnv('LUGN_TEST_PRESET_HA_TOKEN', 'test-token');
      await writeFile(
        configPath,
        JSON.stringify({
          http: { host: '127.0.0.1', port: await findAvailablePort() },
          homeAssistant: {
            baseUrl: 'http://home-assistant.invalid:8123',
            tokenEnv: 'LUGN_TEST_PRESET_HA_TOKEN',
            entities: {
              'lighting.ceiling': 'light.ceiling',
              'lighting.wled': 'light.wled',
            },
          },
          scenes: [],
        }),
      );
      const requests: string[] = [];
      const runtime = await startRuntime(configPath, {
        lightingIntentPath: statePath,
        homeAssistantFetch: async (url) => {
          requests.push(String(url));
          return new Response('[]', { status: 200 });
        },
        createHomeAssistantSocket: () => ({
          addEventListener() {},
          send() {},
          close() {},
        }),
      });
      try {
        expect(runtime.engine.scenes.has(created.id)).toBe(!deleted);
        expect(
          runtime.engine.scenes.get(soft.id)?.lighting['lighting.wled']
            ?.brightness,
        ).toBe(23);
        expect(runtime.engine.state.lighting.currentScene).toBe(
          deleted ? null : created.id,
        );
        expect(
          runtime.engine.state.lighting.devices['lighting.wled']
            ?.effectiveDesired.brightness,
        ).toBe(23);
        expect(
          requests.filter((url) => url.includes('/services/')),
        ).toHaveLength(0);
      } finally {
        await runtime.stop();
      }
    },
  );
  it('persists exact edits and tombstones after generated presets, without lighting commands', async () => {
    const { path, adapter, engine, store } = await fixture();
    const original = structuredClone(engine.scenes.get('scene.soft_light')!);
    const edited = await store.update(engine, original.id, {
      ...input,
      expectedScene: original,
    });
    const created = await store.create(engine, input);
    const movie = engine.scenes.get('scene.movie_light')!;
    await store.delete(engine, movie.id, movie);
    expect(adapter.dispatched).toHaveLength(0);
    const loaded = await new ScenePresetStore({
      filePath: path,
      deviceIds,
    }).load(withRoomPresets([], deviceIds));
    expect(loaded.find((scene) => scene.id === original.id)).toEqual(edited);
    expect(loaded.find((scene) => scene.id === created.id)).toEqual(created);
    expect(loaded.some((scene) => scene.id === movie.id)).toBe(false);
    expect(
      loaded.find((scene) => scene.id === original.id)?.lighting[
        'lighting.wled'
      ]?.brightness,
    ).toBe(23);
  });

  it('keeps current lamp intent during edit/delete and applies edits on reapply', async () => {
    const { adapter, engine, store, clock } = await fixture();
    const created = await store.create(engine, input);
    await engine.activateScene(created.id, { type: 'user' });
    const before = structuredClone(engine.state.lighting.devices);
    const commands = adapter.dispatched.length;
    const edited = await store.update(engine, created.id, {
      ...input,
      name: 'Ändrad',
      lighting: {
        'lighting.wled': {
          power: true,
          brightness: 79,
          colorTemperature: 4000,
        },
      },
      expectedScene: created,
    });
    clock.advanceBy(10_000);
    expect(adapter.dispatched).toHaveLength(commands);
    expect(engine.state.lighting.devices).toEqual(before);
    await engine.reapplyScene({ type: 'user' });
    expect(
      engine.state.lighting.devices['lighting.wled']?.effectiveDesired
        .brightness,
    ).toBe(79);
    const after = structuredClone(engine.state.lighting.devices);
    const afterCommands = adapter.dispatched.length;
    await store.delete(engine, edited.id, edited);
    expect(engine.state.lighting.currentScene).toBeNull();
    expect(engine.state.lighting.devices).toEqual(after);
    expect(adapter.dispatched).toHaveLength(afterCommands);
    await expect(engine.reapplyScene()).rejects.toThrow(
      'There is no active scene',
    );
  });

  it('updates queued automation default, protects mandatory presets, and rejects stale concurrent edits', async () => {
    const { store, engine } = await fixture();
    const allOff = engine.scenes.get('scene.all_off')!;
    await expect(
      store.update(engine, allOff.id, { ...input, expectedScene: allOff }),
    ).rejects.toMatchObject({ code: 'scene_protected' });
    await expect(store.delete(engine, allOff.id, allOff)).rejects.toMatchObject(
      { code: 'scene_protected' },
    );
    const defaultScene = engine.scenes.get('scene.everyday_light')!;
    await expect(
      store.delete(engine, defaultScene.id, defaultScene),
    ).rejects.toMatchObject({ code: 'scene_protected' });
    const edits = await Promise.allSettled([
      store.update(engine, defaultScene.id, {
        ...input,
        expectedScene: defaultScene,
      }),
      store.update(engine, defaultScene.id, {
        ...input,
        name: 'Later edit',
        expectedScene: defaultScene,
      }),
    ]);
    expect(edits[0]?.status).toBe('fulfilled');
    expect(edits[1]).toMatchObject({
      status: 'rejected',
      reason: { code: 'scene_changed' },
    });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    expect(
      engine.state.lighting.devices['lighting.wled']?.effectiveDesired
        .brightness,
    ).toBe(23);
  });

  it('rejects unknown targets and preserves engine/store when saving fails', async () => {
    const { store, engine, adapter, path } = await fixture();
    await expect(
      store.create(engine, {
        name: 'Bad',
        lighting: { 'lighting.unknown': { brightness: 20 } },
      }),
    ).rejects.toMatchObject({ code: 'target_not_configured' });
    await mkdir(path);
    const before = [...engine.scenes.values()];
    await expect(store.create(engine, input)).rejects.toMatchObject({
      code: 'scene_save_failed',
      status: 503,
    });
    expect([...engine.scenes.values()]).toEqual(before);
    expect(adapter.dispatched).toHaveLength(0);
  });

  it('keeps custom scene intent valid after creation and removal', async () => {
    const { directory, store, engine } = await fixture();
    const filePath = join(directory, 'intent.json');
    const intents = new LightingIntentStore({
      filePath,
      expectedDeviceIds: deviceIds,
      knownSceneIds: baseScenes.map((scene) => scene.id),
      debounceMs: 60_000,
    });
    const created = await store.create(engine, input);
    intents.setKnownSceneIds([...engine.scenes.keys()]);
    await engine.activateScene(created.id, { type: 'user' });
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        snapshot: engine.getLightingIntentSnapshot(),
      }),
    );
    expect((await intents.load())?.currentScene).toBe(created.id);
    await store.delete(engine, created.id, created);
    intents.setKnownSceneIds([...engine.scenes.keys()]);
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        snapshot: engine.getLightingIntentSnapshot(),
      }),
    );
    const restored = await intents.load();
    expect(restored?.currentScene).toBeNull();
    expect(
      restored?.devices['lighting.wled']?.effectiveDesired.brightness,
    ).toBe(23);
  });

  it('ignores invalid saved preset files', async () => {
    const { path } = await fixture();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        scenes: [],
        deletedSceneIds: ['scene.all_off'],
      }),
    );
    const warnings: string[] = [];
    const store = new ScenePresetStore({
      filePath: path,
      deviceIds,
      onWarning: (message) => warnings.push(message),
    });
    expect(await store.load(baseScenes)).toEqual(baseScenes);
    expect(warnings).toHaveLength(1);
    const engine = new LugnEngine(new FakeClock(), {
      deviceIds,
      scenes: baseScenes,
    });
    engines.push(engine);
    await expect(store.create(engine, input)).rejects.toMatchObject({
      code: 'scene_save_failed',
    });
    expect(JSON.parse(await readFile(path, 'utf8')).deletedSceneIds).toEqual([
      'scene.all_off',
    ]);
  });

  it('requires UI session, same origin, CSRF and validated fields for all CRUD routes', async () => {
    const { store, engine, adapter } = await fixture();
    const port = await findAvailablePort();
    const base = `http://127.0.0.1:${port}`;
    const server = new LugnHttpServer({
      host: '127.0.0.1',
      port,
      bearerToken: 'test-token',
      engine,
      scenePresetStore: store,
      capabilities: new CapabilityRegistry(engine),
      integrations: () => ({}),
    });
    servers.push(server);
    await server.start();
    const login = await fetch(`${base}/ui/api/session`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'test-token' }),
    });
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const headers = {
      Cookie: cookie,
      Origin: base,
      'X-Lugn-CSRF': csrfToken,
      'Content-Type': 'application/json',
    };
    const write = (
      path: string,
      method: string,
      body: unknown,
      extra: Record<string, string> = {},
    ) =>
      fetch(`${base}${path}`, {
        method,
        headers: { ...headers, ...extra },
        body: JSON.stringify(body),
      });
    for (const [path, method, body] of [
      ['/ui/api/scenes', 'POST', input],
      [
        '/ui/api/scenes/scene.soft_light',
        'POST',
        { ...input, expectedScene: engine.scenes.get('scene.soft_light') },
      ],
      [
        '/ui/api/scenes/scene.soft_light',
        'DELETE',
        { expectedScene: engine.scenes.get('scene.soft_light') },
      ],
    ] as const) {
      expect((await write(path, method, body, { Cookie: '' })).status).toBe(
        401,
      );
      expect(
        (await write(path, method, body, { Origin: 'http://evil.example' }))
          .status,
      ).toBe(403);
      expect(
        (await write(path, method, body, { 'X-Lugn-CSRF': '' })).status,
      ).toBe(403);
      expect(
        (await write(path, method, body, { 'Content-Type': 'text/plain' }))
          .status,
      ).toBe(415);
    }
    expect(
      (
        await write('/ui/api/scenes', 'POST', {
          ...input,
          lighting: { 'lighting.wled': { brightness: 101 } },
        })
      ).status,
    ).toBe(400);
    expect(
      (await write('/ui/api/scenes', 'POST', { ...input, extra: true })).status,
    ).toBe(400);
    expect(
      (
        await write('/ui/api/scenes', 'POST', {
          ...input,
          lighting: { 'lighting.wled': {} },
        })
      ).status,
    ).toBe(400);
    const create = await write('/ui/api/scenes', 'POST', input);
    expect(create.status).toBe(201);
    const scene = definition(
      ((await create.json()) as { scene: LightingScene }).scene,
    );
    const overview = await fetch(`${base}/ui/api/overview`, {
      headers: { Cookie: cookie },
    });
    const data = (await overview.json()) as {
      presetsEnabled: boolean;
      scenes: Array<
        LightingScene & {
          canEdit: boolean;
          canDelete: boolean;
          protectionReason?: string;
        }
      >;
    };
    expect(data.presetsEnabled).toBe(true);
    expect(data.scenes.find((entry) => entry.id === scene.id)).toMatchObject({
      ...scene,
      canEdit: true,
      canDelete: true,
    });
    expect(
      data.scenes.find((entry) => entry.id === 'scene.all_off'),
    ).toMatchObject({
      canEdit: false,
      canDelete: false,
      protectionReason: 'all_off',
    });
    expect(
      data.scenes.find((entry) => entry.id === 'scene.everyday_light'),
    ).toMatchObject({
      canEdit: true,
      canDelete: false,
      protectionReason: 'automation_default',
    });
    const update = await write(`/ui/api/scenes/${scene.id}`, 'POST', {
      ...input,
      name: 'Ny kväll',
      expectedScene: scene,
    });
    expect(update.status).toBe(200);
    const edited = definition(
      ((await update.json()) as { scene: LightingScene }).scene,
    );
    expect(
      (
        await write(`/ui/api/scenes/${scene.id}`, 'DELETE', {
          expectedScene: scene,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await write(`/ui/api/scenes/${scene.id}`, 'DELETE', {
          expectedScene: edited,
        })
      ).status,
    ).toBe(200);
    expect(adapter.dispatched).toHaveLength(0);
  });
});

function definition(scene: LightingScene): LightingScene {
  return { id: scene.id, name: scene.name, lighting: scene.lighting };
}

async function findAvailablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

it('round-trips RGB presets and detects concurrent color-only edits', async () => {
  const { store, engine, path } = await fixture();
  await store.load(baseScenes);
  const created = await store.create(engine, {
    name: 'Party',
    lighting: {
      'lighting.ceiling': { power: true, brightness: 50, rgb: [150, 20, 255] },
    },
  });
  expect(
    created.lighting['lighting.ceiling']?.colorTemperature,
  ).toBeUndefined();
  const edited = await store.update(engine, created.id, {
    name: 'Party',
    lighting: {
      'lighting.ceiling': { power: true, brightness: 50, rgb: [20, 150, 255] },
    },
    expectedScene: structuredClone(created),
  });
  await expect(
    store.update(engine, created.id, {
      name: 'Stale color',
      lighting: created.lighting,
      expectedScene: structuredClone(created),
    }),
  ).rejects.toMatchObject({ status: 409 });
  const restarted = new ScenePresetStore({ filePath: path, deviceIds });
  const loaded = (await restarted.load(baseScenes)).find(
    (scene) => scene.id === created.id,
  );
  expect(loaded).toEqual(edited);
});
