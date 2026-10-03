import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import { LightingIntentStore } from '../src/runtime/lighting-intent-store.js';

const scene = {
  id: 'scene.everyday',
  name: 'Everyday',
  lighting: {
    'lighting.entry': { power: true, brightness: 60 },
  },
};
const scenes = [scene];
const deviceIds = ['lighting.entry'];
const user = { type: 'user' as const, id: 'tester' };
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('lighting intent persistence', () => {
  it('restores scene and manual property ownership without replaying startup observations or commands', async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, 'lighting-intent.json');
    const startingAt = Date.parse('2026-09-28T12:00:00+02:00');
    const initialClock = new FakeClock(startingAt);
    const initialAdapter = new SimulatedLightingAdapter(initialClock);
    const initialEngine = new LugnEngine(initialClock, {
      deviceIds,
      scenes,
      continuityMs: 20_000,
      adapter: initialAdapter,
    });
    const initialStore = createStore(filePath, { debounceMs: 60_000 });
    await initialStore.load();
    initialStore.start(initialEngine);

    await initialEngine.activateScene(scene.id, user);
    initialAdapter.externalChange('lighting.entry', { brightness: 47 });
    await initialEngine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
    });
    await initialStore.stop();
    initialEngine.dispose();

    const stored = JSON.parse(await readFile(filePath, 'utf8')) as {
      version: number;
      snapshot: Record<string, unknown>;
    };
    expect(stored.version).toBe(1);
    expect(Object.keys(stored.snapshot).sort()).toEqual([
      'continuityExpiresAt',
      'currentScene',
      'devices',
      'sceneRevision',
    ]);
    expect(stored.snapshot['currentScene']).toBe(scene.id);
    expect(stored.snapshot['continuityExpiresAt']).toBe(startingAt + 20_000);
    const fileMode = (await stat(filePath)).mode & 0o777;
    expect(fileMode).toBe(0o600);

    const restoreStore = createStore(filePath, { onWarning: vi.fn() });
    const restored = await restoreStore.load();
    expect(restored).toBeDefined();
    const restartedClock = new FakeClock(startingAt + 1_000);
    const restartedAdapter = new SimulatedLightingAdapter(restartedClock);
    const restartedEngine = new LugnEngine(restartedClock, {
      deviceIds,
      scenes,
      defaultSceneId: scene.id,
      adapter: restartedAdapter,
      ...(restored === undefined ? {} : { restoredLightingIntent: restored }),
    });
    const restartedStore = createStore(filePath, { debounceMs: 60_000 });
    await restartedStore.load();
    restartedStore.start(restartedEngine);

    restartedAdapter.externalChange('lighting.entry', {
      power: false,
      brightness: 10,
    });
    await restartedEngine.handlePresence({
      type: 'presence.changed',
      presence: 'unknown',
    });
    expect(restartedAdapter.dispatched).toEqual([]);
    expect(
      restartedEngine.state.lighting.devices['lighting.entry']
        ?.effectiveDesired,
    ).toEqual({ power: true, brightness: 47 });

    await restartedEngine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    expect(restartedAdapter.dispatched).toHaveLength(1);
    expect(restartedAdapter.dispatched[0]).toMatchObject({
      target: 'lighting.entry',
      values: { power: true, brightness: 47 },
    });
    expect(
      restartedEngine.state.lighting.devices['lighting.entry']?.ownership
        .brightness?.kind,
    ).toBe('override');
    await restartedStore.stop();
    const persistedAgain = await createStore(filePath).load();
    expect(persistedAgain?.currentScene).toBe(scene.id);
    restartedEngine.dispose();
  });

  it('keeps a restored absolute expiry and does not renew it on the sensor startup empty heartbeat', async () => {
    const clock = new FakeClock(2_000);
    const adapter = new SimulatedLightingAdapter(clock);
    const engine = new LugnEngine(clock, {
      deviceIds,
      scenes,
      adapter,
      restoredLightingIntent: {
        currentScene: scene.id,
        sceneRevision: 1,
        continuityExpiresAt: 5_000,
        devices: {
          'lighting.entry': {
            baselineDesired: { power: true, brightness: 60 },
            effectiveDesired: { power: true, brightness: 47 },
            ownership: {
              power: { kind: 'scene', revision: 1 },
              brightness: {
                kind: 'override',
                actor: user,
                reason: 'manual brightness',
                createdAt: 1_500,
              },
            },
          },
        },
      },
      continuityMs: 10_000,
    });

    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'unknown',
    });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
    });
    expect(engine.state.presence.continuityExpiresAt).toBe(5_000);
    expect(adapter.observed.get('lighting.entry')?.power).toBe(false);

    clock.advanceBy(3_000);
    expect(engine.state.presence.continuityExpiresAt).toBeNull();
    expect(engine.state.lighting.currentScene).toBeNull();
    engine.dispose();
  });

  it('does not recreate already-expired continuity from the first empty heartbeat', async () => {
    const clock = new FakeClock(5_000);
    const adapter = new SimulatedLightingAdapter(clock);
    const engine = new LugnEngine(clock, {
      deviceIds,
      scenes,
      adapter,
      continuityMs: 10_000,
      restoredLightingIntent: {
        currentScene: scene.id,
        sceneRevision: 1,
        continuityExpiresAt: 5_000,
        devices: {
          'lighting.entry': {
            baselineDesired: { power: true },
            effectiveDesired: { power: true },
            ownership: { power: { kind: 'scene', revision: 1 } },
          },
        },
      },
    });

    expect(engine.state.lighting.currentScene).toBeNull();
    expect(
      engine.state.lighting.devices['lighting.entry']?.effectiveDesired,
    ).toEqual({});
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
    });
    expect(engine.state.presence.continuityExpiresAt).toBeNull();
    expect(adapter.observed.get('lighting.entry')?.power).toBe(false);
    engine.dispose();
  });

  it('keeps the default scene pending across repeated restarts after expiry', async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, 'lighting-intent.json');
    const daytime = Date.parse('2026-09-28T12:00:00+02:00');
    const expiredIntent = {
      currentScene: scene.id,
      sceneRevision: 1,
      continuityExpiresAt: daytime,
      devices: {
        'lighting.entry': {
          baselineDesired: { power: true },
          effectiveDesired: { power: true },
          ownership: { power: { kind: 'scene' as const, revision: 1 } },
        },
      },
    };

    const firstClock = new FakeClock(daytime + 1);
    const firstEngine = new LugnEngine(firstClock, {
      deviceIds,
      scenes,
      defaultSceneId: scene.id,
      restoredLightingIntent: expiredIntent,
    });
    const firstStore = createStore(filePath, { debounceMs: 60_000 });
    await firstStore.load();
    firstStore.start(firstEngine);
    await firstEngine.handlePresence({
      type: 'presence.changed',
      presence: 'unknown',
    });
    await firstStore.stop();
    firstEngine.dispose();

    const firstRestore = await createStore(filePath).load();
    expect(firstRestore?.currentScene).toBeNull();
    if (!firstRestore) throw new Error('First restored intent is missing');

    const secondClock = new FakeClock(daytime + 2);
    const secondAdapter = new SimulatedLightingAdapter(secondClock);
    const secondEngine = new LugnEngine(secondClock, {
      deviceIds,
      scenes,
      defaultSceneId: scene.id,
      adapter: secondAdapter,
      restoredLightingIntent: firstRestore,
    });
    const secondStore = createStore(filePath, { debounceMs: 60_000 });
    await secondStore.load();
    secondStore.start(secondEngine);
    secondAdapter.externalChange('lighting.entry', { power: false });
    expect(secondAdapter.dispatched).toEqual([]);
    await secondStore.stop();
    secondEngine.dispose();

    const secondRestore = await createStore(filePath).load();
    expect(secondRestore?.currentScene).toBeNull();
    if (!secondRestore) throw new Error('Second restored intent is missing');

    const thirdClock = new FakeClock(daytime + 3);
    const thirdAdapter = new SimulatedLightingAdapter(thirdClock);
    const thirdEngine = new LugnEngine(thirdClock, {
      deviceIds,
      scenes,
      defaultSceneId: scene.id,
      adapter: thirdAdapter,
      restoredLightingIntent: secondRestore,
    });
    await thirdEngine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    expect(thirdAdapter.dispatched).toMatchObject([
      { target: 'lighting.entry', values: { power: true } },
    ]);
    thirdEngine.dispose();
  });

  it('ignores corrupt, unsupported, and topology-mismatched state', async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, 'lighting-intent.json');
    const warn = vi.fn();
    const store = createStore(filePath, { onWarning: warn });
    await writeFile(filePath, '{');
    await expect(store.load()).resolves.toBeUndefined();

    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        snapshot: {
          currentScene: scene.id,
          sceneRevision: 1,
          continuityExpiresAt: null,
          presence: 'occupied',
          devices: {
            'lighting.entry': {
              observed: { power: true },
              baselineDesired: { power: true },
              effectiveDesired: { power: true },
              ownership: {},
              availability: 'available',
            },
          },
          commands: [],
        },
      }),
    );
    await expect(store.load()).resolves.toBeUndefined();

    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        snapshot: {
          currentScene: scene.id,
          sceneRevision: 1,
          continuityExpiresAt: null,
          devices: {
            'lighting.missing': {
              baselineDesired: { power: true },
              effectiveDesired: { power: true },
              ownership: {},
            },
          },
        },
      }),
    );
    await expect(store.load()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'lugn-intent-'));
  directories.push(directory);
  return directory;
}

function createStore(
  filePath: string,
  options: {
    debounceMs?: number;
    onWarning?: (message: string) => void;
  } = {},
): LightingIntentStore {
  return new LightingIntentStore({
    filePath,
    expectedDeviceIds: deviceIds,
    knownSceneIds: scenes.map(({ id }) => id),
    ...(options.debounceMs === undefined
      ? {}
      : { debounceMs: options.debounceMs }),
    ...(options.onWarning === undefined
      ? {}
      : { onWarning: options.onWarning }),
  });
}
