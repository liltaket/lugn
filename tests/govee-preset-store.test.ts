import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import { ScenePresetStore } from '../src/runtime/scene-preset-store.js';

const target = 'lighting.govee_ceiling';
const other = 'lighting.govee_table';
const directories: string[] = [];
const engines: LugnEngine[] = [];
afterEach(async () => {
  engines.splice(0).forEach((engine) => engine.dispose());
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lugn-govee-preset-'));
  directories.push(directory);
  const clock = new FakeClock();
  const adapter = Object.assign(new SimulatedLightingAdapter(clock), {
    goveeCapabilities: {
      [target]: {
        effects: ['Aurora', 'Forest'],
        zones: true,
        colorTemperature: { min: 2700, max: 6500 },
      },
      [other]: { effects: ['Forest B'], zones: false },
    },
  });
  const engine = new LugnEngine(clock, {
    adapter,
    deviceIds: [target, other],
    scenes: [],
  });
  engines.push(engine);
  const path = join(directory, 'presets.json');
  const store = new ScenePresetStore({
    filePath: path,
    deviceIds: [target, other],
  });
  await store.load([]);
  return { store, engine, adapter, path };
}
const input = {
  name: 'Ring och bord',
  lighting: {
    [target]: { power: true, brightness: 20 },
    [other]: { power: true, brightness: 25 },
  },
  govee: {
    [target]: { effect: 'Aurora', zones: { main: false, ring: true } },
    [other]: { effect: 'Forest B' },
  },
};

it('persists effects and zone masks without actuation and reloads them without a live catalog', async () => {
  const s = await fixture();
  const created = await s.store.create(s.engine, input);
  expect(created.govee).toEqual(input.govee);
  expect(created.lighting[target]?.colorTemperature).toBeUndefined();
  expect(created.lighting[other]?.colorTemperature).toBeUndefined();
  expect(s.adapter.dispatched).toEqual([]);
  const original = await readFile(s.path, 'utf8');
  const loaded = await new ScenePresetStore({
    filePath: s.path,
    deviceIds: [target, other],
  }).load([]);
  expect(loaded).toEqual([created]);
  expect(await readFile(s.path, 'utf8')).toBe(original);
  const white = await s.store.update(s.engine, created.id, {
    name: 'Takljus',
    lighting: {
      [target]: { power: true, brightness: 60, colorTemperature: 4000 },
    },
    govee: { [target]: { zones: { main: true, ring: true } } },
    expectedScene: created,
  });
  expect(white.lighting[target]?.colorTemperature).toBe(4000);
  expect(white.govee?.[target]?.effect).toBeUndefined();
  expect(s.adapter.dispatched).toEqual([]);
});

it('detects effect-only and mask-only concurrent edits, including stale deletion', async () => {
  const s = await fixture();
  const original = await s.store.create(s.engine, input);
  const changedEffect = await s.store.update(s.engine, original.id, {
    ...input,
    govee: {
      ...input.govee,
      [target]: { ...input.govee[target]!, effect: 'Forest' },
    },
    expectedScene: original,
  });
  await expect(
    s.store.update(s.engine, original.id, {
      ...input,
      expectedScene: original,
    }),
  ).rejects.toMatchObject({ code: 'scene_changed' });
  const changedMask = await s.store.update(s.engine, original.id, {
    ...input,
    govee: {
      ...changedEffect.govee,
      [target]: { effect: 'Forest', zones: { main: true, ring: false } },
    },
    expectedScene: changedEffect,
  });
  await expect(
    s.store.delete(s.engine, original.id, changedEffect),
  ).rejects.toMatchObject({ code: 'scene_changed' });
  await s.store.delete(s.engine, original.id, changedMask);
  expect(s.engine.scenes.has(original.id)).toBe(false);
});

it('rejects unsupported targets, effects and masks before saving or dispatching', async () => {
  const s = await fixture();
  for (const govee of [
    { [target]: { effect: 'Missing animation' } },
    { [other]: { effect: 'Forest B', zones: { main: false, ring: true } } },
  ]) {
    await expect(
      s.store.create(s.engine, { ...input, govee }),
    ).rejects.toMatchObject({ code: 'govee_unsupported' });
  }
  await expect(
    s.store.create(s.engine, {
      ...input,
      lighting: { [other]: { power: true, brightness: 20 } },
    }),
  ).rejects.toMatchObject({ code: 'invalid_govee_scene' });
  await expect(
    s.store.create(s.engine, {
      ...input,
      lighting: { ...input.lighting, [target]: { power: false } },
    }),
  ).rejects.toMatchObject({ code: 'invalid_govee_scene' });
  await expect(
    s.store.create(s.engine, {
      ...input,
      lighting: {
        ...input.lighting,
        [target]: { power: true, colorTemperature: 4000 },
      },
    }),
  ).rejects.toMatchObject({ code: 'invalid_govee_scene' });
  expect(s.engine.scenes.size).toBe(0);
  expect(s.adapter.dispatched).toEqual([]);
});

it('persists ordered rotations without normalizing them into static white', async () => {
  const s = await fixture();
  const rotation = { effects: ['Aurora', 'Forest'], intervalSeconds: 60 };
  const scene = await s.store.create(s.engine, {
    name: 'Loop',
    lighting: { [target]: { power: true, brightness: 30 } },
    govee: { [target]: { rotation, zones: { main: false, ring: true } } },
  });
  expect(scene.lighting[target]).toEqual({ power: true, brightness: 30 });
  expect(scene.govee?.[target]?.rotation).toEqual(rotation);
  const loaded = await new ScenePresetStore({
    filePath: s.path,
    deviceIds: [target, other],
  }).load([]);
  expect(loaded).toEqual([scene]);
  expect(s.adapter.dispatched).toEqual([]);
});

it('detects concurrent rotation interval and ordering edits', async () => {
  const s = await fixture();
  const definition = {
    name: 'Loop',
    lighting: { [target]: { power: true, brightness: 30 } },
    govee: {
      [target]: {
        rotation: { effects: ['Aurora', 'Forest'], intervalSeconds: 60 },
      },
    },
  };
  const original = await s.store.create(s.engine, definition);
  const changedInterval = await s.store.update(s.engine, original.id, {
    ...definition,
    govee: {
      [target]: {
        rotation: {
          ...definition.govee[target]!.rotation,
          intervalSeconds: 120,
        },
      },
    },
    expectedScene: original,
  });
  await expect(
    s.store.delete(s.engine, original.id, original),
  ).rejects.toMatchObject({ code: 'scene_changed' });
  const changedOrder = await s.store.update(s.engine, original.id, {
    ...definition,
    govee: {
      [target]: {
        rotation: { effects: ['Forest', 'Aurora'], intervalSeconds: 120 },
      },
    },
    expectedScene: changedInterval,
  });
  await expect(
    s.store.update(s.engine, original.id, {
      ...definition,
      expectedScene: changedInterval,
    }),
  ).rejects.toMatchObject({ code: 'scene_changed' });
  await s.store.delete(s.engine, original.id, changedOrder);
  expect(s.engine.scenes.has(original.id)).toBe(false);
});

it('rejects any unsupported rotation label before saving', async () => {
  const s = await fixture();
  await expect(
    s.store.create(s.engine, {
      name: 'Invalid loop',
      lighting: { [target]: { power: true, brightness: 30 } },
      govee: {
        [target]: {
          rotation: { effects: ['Aurora', 'Missing'], intervalSeconds: 60 },
        },
      },
    }),
  ).rejects.toMatchObject({ code: 'govee_unsupported' });
  expect(s.engine.scenes.size).toBe(0);
  expect(s.adapter.dispatched).toEqual([]);
});

it('turns a saved Party preset into Musik without losing its lamps or Govee animation', async () => {
  const s = await fixture();
  const created = await s.store.create(s.engine, input);
  const { readFile: read, writeFile: write } = await import('node:fs/promises');
  const stored = JSON.parse(await read(s.path, 'utf8'));
  stored.scenes[0].id = 'scene.party';
  stored.scenes[0].name = 'Party';
  await write(s.path, JSON.stringify(stored));
  const reloaded = new ScenePresetStore({
    filePath: s.path,
    deviceIds: [target, other],
  });
  const scenes = await reloaded.load([]);
  expect(scenes).toHaveLength(1);
  expect(scenes[0]).toMatchObject({
    id: 'scene.music',
    name: 'Musik',
    dynamic: 'music',
    lighting: created.lighting,
    govee: created.govee,
  });
});

it('keeps an existing Musik preset and leaves Party alone beside it', async () => {
  const s = await fixture();
  await s.store.create(s.engine, input);
  const { readFile: read, writeFile: write } = await import('node:fs/promises');
  const stored = JSON.parse(await read(s.path, 'utf8'));
  stored.scenes.push({ ...stored.scenes[0], id: 'scene.music', name: 'Musik' });
  stored.scenes[0].id = 'scene.party';
  await write(s.path, JSON.stringify(stored));
  const reloaded = new ScenePresetStore({
    filePath: s.path,
    deviceIds: [target, other],
  });
  const ids = (await reloaded.load([])).map((scene) => scene.id).sort();
  expect(ids).toEqual(['scene.music', 'scene.party']);
});

it('keeps what drives a dynamic scene when its lamps are edited', async () => {
  const s = await fixture();
  s.engine.saveSceneDefinition({
    id: 'scene.music',
    name: 'Musik',
    dynamic: 'music',
    lighting: input.lighting,
  });
  const updated = await s.store.update(s.engine, 'scene.music', {
    name: 'Musik',
    lighting: { [target]: { power: true, brightness: 30 } },
    expectedScene: s.engine.scenes.get('scene.music')!,
  });
  expect(updated.dynamic).toBe('music');
  expect(s.engine.scenes.get('scene.music')?.dynamic).toBe('music');
  const reloaded = new ScenePresetStore({
    filePath: s.path,
    deviceIds: [target, other],
  });
  expect((await reloaded.load([]))[0]?.dynamic).toBe('music');
});
