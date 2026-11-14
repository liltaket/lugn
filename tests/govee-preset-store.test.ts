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
