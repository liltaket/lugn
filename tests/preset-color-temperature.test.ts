import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HomeAssistantLightingAdapter } from '../src/adapters/home-assistant-lighting.js';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import type { LightingScene } from '../src/core/schemas.js';
import { ScenePresetStore } from '../src/runtime/scene-preset-store.js';

const bar = 'lighting.cleverio_bar';
const strip = 'lighting.wled_cct';
const everyday: LightingScene = {
  id: 'scene.everyday_light',
  name: 'Vardagsljus',
  lighting: {
    [bar]: { power: true, brightness: 55, colorTemperature: 2700 },
    [strip]: { power: true, brightness: 61, colorTemperature: 2700 },
  },
};
const movie: LightingScene = {
  id: 'scene.movie_light',
  name: 'Filmkväll',
  lighting: {
    [bar]: { power: true, brightness: 3 },
    [strip]: { power: true, brightness: 21, colorTemperature: 2700 },
  },
};
const directories: string[] = [];
const engines: LugnEngine[] = [];
afterEach(async () => {
  engines.splice(0).forEach((engine) => engine.dispose());
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function storeFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lugn-preset-cct-'));
  directories.push(directory);
  const path = join(directory, 'presets.json');
  const store = new ScenePresetStore({
    filePath: path,
    deviceIds: [bar, strip],
  });
  return { path, store };
}
async function flush() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

describe('preset white-light control', () => {
  it('completes legacy saved Kelvin without changing brightness or writing on load', async () => {
    const { path, store } = await storeFixture();
    const original = JSON.stringify({
      version: 1,
      scenes: [movie],
      deletedSceneIds: [],
    });
    await writeFile(path, original);
    const loaded = (await store.load([everyday])).find(
      (scene) => scene.id === movie.id,
    )!;
    expect(loaded.lighting[bar]).toEqual({
      power: true,
      brightness: 3,
      colorTemperature: 2700,
    });
    expect(loaded.lighting[strip]?.brightness).toBe(21);
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('fills Kelvin when creating and editing a preset with brightness-only entries', async () => {
    const { store } = await storeFixture();
    const engine = new LugnEngine(new FakeClock(), {
      deviceIds: [bar, strip],
      scenes: [everyday],
    });
    engines.push(engine);
    const created = await store.create(engine, {
      name: 'Low',
      lighting: { [bar]: { power: true, brightness: 3 } },
    });
    expect(created.lighting[bar]?.colorTemperature).toBe(2700);
    const edited = await store.update(engine, created.id, {
      name: 'Edited',
      lighting: {
        [bar]: { power: true, brightness: 3 },
        [strip]: { power: true, brightness: 21, colorTemperature: 4000 },
      },
      expectedScene: created,
    });
    expect(edited.lighting[bar]?.colorTemperature).toBe(4000);
    expect(edited.lighting[strip]?.brightness).toBe(21);
    expect(engine.state.commands).toHaveLength(0);
  });

  it('keeps Kelvin in same-temperature scene transitions and brightness retries with stale Tuya colour cache', async () => {
    const clock = new FakeClock(1000);
    const requests: Array<Record<string, unknown>> = [];
    // The integration's cached work_mode remains colour even after a white
    // command succeeds physically. A later brightness-only command selects
    // that cached colour again, as in HA Tuya 2026.6.3.
    let physicalMode = 'colour';
    const adapter = new HomeAssistantLightingAdapter(
      {
        baseUrl: 'http://home-assistant.test',
        token: 'test',
        entities: { [bar]: 'light.cleverio_lb100' },
      },
      async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push(body);
        physicalMode =
          body['color_temp_kelvin'] === undefined ? 'colour' : 'white';
        return new Response('[]', { status: 200 });
      },
      clock,
    );
    const engine = new LugnEngine(clock, {
      adapter,
      deviceIds: [bar],
      scenes: [
        { ...everyday, lighting: { [bar]: everyday.lighting[bar]! } },
        {
          ...movie,
          lighting: {
            [bar]: { ...movie.lighting[bar]!, colorTemperature: 2700 },
          },
        },
      ],
    });
    engines.push(engine);
    await engine.activateScene(everyday.id, { type: 'user' });
    const feedback = () =>
      adapter.acceptStateChangedEvent({
        entity_id: 'light.cleverio_lb100',
        new_state: {
          entity_id: 'light.cleverio_lb100',
          state: 'on',
          attributes: {
            brightness: 140,
            color_mode: 'color_temp',
            color_temp_kelvin: 2700,
          },
        },
      });
    feedback();
    await flush();
    expect(physicalMode).toBe('white');
    await engine.activateScene(movie.id, { type: 'user' });
    expect(requests.at(-1)).toEqual({
      entity_id: 'light.cleverio_lb100',
      brightness_pct: 3,
      color_temp_kelvin: 2700,
    });
    expect(physicalMode).toBe('white');
    feedback(); // Kelvin matches while brightness feedback remains stale.
    clock.advanceBy(2000);
    await flush();
    expect(requests.at(-1)).toEqual({
      entity_id: 'light.cleverio_lb100',
      brightness_pct: 3,
      color_temp_kelvin: 2700,
    });
    expect(engine.state.commands.at(-1)?.desired).toEqual({
      brightness: 3,
      colorTemperature: 2700,
    });
    expect(physicalMode).toBe('white');
  });

  it('completes missing applied Kelvin on restart without applying newly edited brightness', async () => {
    const clock = new FakeClock(1000);
    const old = new LugnEngine(clock, {
      deviceIds: [bar, strip],
      scenes: [movie],
    });
    engines.push(old);
    await old.activateScene(movie.id, { type: 'user' });
    const snapshot = old.getLightingIntentSnapshot();
    const adapter = new SimulatedLightingAdapter(clock);
    const restored = new LugnEngine(clock, {
      adapter,
      deviceIds: [bar, strip],
      scenes: [
        {
          ...movie,
          lighting: {
            [bar]: { power: true, brightness: 80, colorTemperature: 4000 },
            [strip]: movie.lighting[strip]!,
          },
        },
      ],
      preserveRestoredSceneIds: [movie.id],
      restoredLightingIntent: snapshot,
    });
    engines.push(restored);
    expect(adapter.dispatched).toHaveLength(0);
    expect(restored.state.lighting.devices[bar]?.effectiveDesired).toEqual({
      power: true,
      brightness: 3,
      colorTemperature: 2700,
    });
    await restored.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    expect(
      adapter.dispatched.find((command) => command.target === bar)?.values,
    ).toEqual({ power: true, brightness: 3, colorTemperature: 2700 });
  });
});
