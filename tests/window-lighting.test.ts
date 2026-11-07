import { afterEach, describe, expect, it } from 'vitest';
import {
  LugnEngine,
  type EngineOptions,
} from '../src/application/lugn-engine.js';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { FakeClock } from '../src/core/clock.js';
import type { WindowLighting } from '../src/core/window-lighting.js';

const windowTarget = 'lighting.window';
const desk = 'lighting.desk';
const engines: LugnEngine[] = [];
afterEach(() => engines.splice(0).forEach((engine) => engine.dispose()));
function setup(
  presenceMode: WindowLighting['presenceMode'] = 'home',
  extra: Partial<EngineOptions> = {},
) {
  const clock = new FakeClock(0);
  const adapter = new SimulatedLightingAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: [windowTarget, desk],
    adapter,
    scenes: [
      {
        id: 'scene.white',
        name: 'White',
        lighting: {
          [windowTarget]: {
            power: true,
            brightness: 60,
            colorTemperature: 2700,
          },
          [desk]: { power: true, brightness: 60, colorTemperature: 2700 },
        },
      },
      {
        id: 'scene.rgb',
        name: 'RGB',
        lighting: {
          [windowTarget]: { power: true, brightness: 60, rgb: [100, 20, 200] },
          [desk]: { power: true, brightness: 60 },
        },
      },
      {
        id: 'scene.all_off',
        name: 'Off',
        lighting: {
          [windowTarget]: { power: false },
          [desk]: { power: false },
        },
      },
      {
        id: 'scene.partial_off',
        name: 'Window off',
        lighting: {
          [windowTarget]: { power: false },
          [desk]: { power: true, brightness: 60 },
        },
      },
      {
        id: 'scene.omitted_rgb',
        name: 'Red',
        lighting: { [desk]: { power: true, brightness: 60, rgb: [200, 0, 0] } },
      },
    ],
    defaultSceneId: 'scene.white',
    windowLighting: {
      target: windowTarget,
      brightness: 35,
      presenceMode,
      maxSunElevation: -2,
    },
    ...extra,
  });
  engines.push(engine);
  return {
    clock,
    adapter,
    engine,
    power: () => adapter.observed.get(windowTarget)?.power,
  };
}
const occupied = { type: 'presence.changed', presence: 'occupied' } as const;
const empty = {
  type: 'presence.changed',
  presence: 'confirmed_empty',
} as const;

describe('outward-facing window lighting', () => {
  it('waits for sun data, follows dusk and dawn, and keeps scene colour with its own brightness', async () => {
    const { engine, adapter, power } = setup();
    await engine.handlePresence(occupied);
    expect(power()).toBe(false);
    await engine.handleSunElevation(10);
    expect(power()).toBe(false);
    await engine.handleSunElevation(-2);
    expect(power()).toBe(true);
    expect(adapter.observed.get(windowTarget)).toMatchObject({
      brightness: 35,
      colorTemperature: 2700,
    });
    await engine.activateScene('scene.rgb', { type: 'user' });
    expect(adapter.observed.get(windowTarget)).toMatchObject({
      brightness: 35,
      rgb: [100, 20, 200],
    });
    await engine.handleSunElevation(-1);
    expect(power()).toBe(false);
    await engine.handleSunElevation(-3);
    expect(power()).toBe(true);
  });
  it.each(['home', 'always'] as const)(
    'keeps the window on in an empty room in %s mode and updates at daylight',
    async (mode) => {
      const { engine, adapter, power } = setup(mode);
      await engine.handleSunElevation(-5);
      await engine.handlePresence(occupied);
      await engine.handlePresence(empty);
      expect(power()).toBe(true);
      expect(adapter.observed.get(desk)?.power).toBe(false);
      await engine.handleSunElevation(5);
      expect(power()).toBe(false);
      await engine.handleSunElevation(-5);
      expect(power()).toBe(true);
    },
  );
  it('room mode follows confirmed occupancy and remembers it while unknown', async () => {
    const { engine, power } = setup('room');
    await engine.handleSunElevation(-5);
    await engine.handlePresence(occupied);
    expect(power()).toBe(true);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'unknown',
    });
    expect(power()).toBe(true);
    await engine.handlePresence(empty);
    expect(power()).toBe(false);
    await engine.handlePresence(occupied);
    expect(power()).toBe(true);
  });
  it('room mode follows occupancy even when home presence reports away', async () => {
    const { engine, power } = setup('room');
    await engine.handleSunElevation(-5);
    await engine.handlePresence(occupied);
    await engine.handleHomePresence('away');
    expect(power()).toBe(true);
  });
  it('follows scene colour when the scene omits the window', async () => {
    const { engine, adapter } = setup('always');
    await engine.handleSunElevation(-5);
    await engine.activateScene('scene.white', { type: 'user' });
    await engine.activateScene('scene.omitted_rgb', { type: 'user' });
    expect(adapter.observed.get(windowTarget)?.rgb).toEqual([200, 0, 0]);
  });
  it.each(['home', 'always'] as const)(
    '%s mode applies its home-presence rule and retains daylight through brief outages',
    async (mode) => {
      const { engine, power } = setup(mode);
      await engine.handleSunElevation(-5);
      await engine.handlePresence(occupied);
      await engine.handlePresence(empty);
      await engine.handleHomePresence('away');
      expect(power()).toBe(mode === 'always');
      await engine.handleHomePresence('unknown');
      expect(power()).toBe(true);
      await engine.handleSunElevation(null);
      expect(power()).toBe(true);
    },
  );
  it.each(['scene.all_off'])(
    'respects %s across sun and presence changes',
    async (scene) => {
      const { engine, power } = setup('always');
      await engine.handleSunElevation(-5);
      await engine.activateScene('scene.white', { type: 'user' });
      await engine.activateScene(scene, { type: 'user' });
      await engine.handlePresence(empty);
      await engine.handleSunElevation(-10);
      await engine.handleHomePresence('home');
      expect(power()).toBe(false);
      await engine.activateScene('scene.white', { type: 'user' });
      expect(power()).toBe(true);
    },
  );
  it('uses its own power and brightness in a scene with the window off', async () => {
    const { engine, adapter, power } = setup('always');
    await engine.handleSunElevation(-5);
    await engine.activateScene('scene.partial_off', { type: 'user' });
    expect(power()).toBe(true);
    expect(adapter.observed.get(windowTarget)?.brightness).toBe(35);
  });
  it('starts the window from the default scene without any room entry', async () => {
    const { engine, adapter, power } = setup('home');
    await engine.handleSunElevation(-5);
    expect(power()).toBe(true);
    expect(adapter.observed.get(desk)?.power).not.toBe(true);
  });
  it('keeps the window intent through long room absence', async () => {
    const { engine, adapter, clock, power } = setup('home', {
      continuityMs: 1000,
    });
    await engine.handleSunElevation(-5);
    await engine.handlePresence(occupied);
    await engine.handlePresence(empty);
    clock.advanceBy(1001);
    await engine.handleSunElevation(5);
    expect(power()).toBe(false);
    await engine.handleSunElevation(-5);
    expect(power()).toBe(true);
    expect(adapter.observed.get(desk)?.power).toBe(false);
  });
  it('restores window lighting before room occupancy without activating the other lights', async () => {
    const initial = setup('home');
    await initial.engine.handleSunElevation(-5);
    await initial.engine.handlePresence(occupied);
    const { engine, adapter, power } = setup('home', {
      restoredLightingIntent: initial.engine.getLightingIntentSnapshot(),
    });
    await engine.handleSunElevation(-5);
    expect(power()).toBe(true);
    expect(adapter.observed.get(desk)?.power).not.toBe(true);
  });
  it('preserves a window-only zero brightness override across restart', async () => {
    const first = setup('always');
    await first.engine.handleSunElevation(-5);
    await first.engine.setLighting(
      windowTarget,
      { brightness: 0 },
      { actor: { type: 'user' } },
    );
    const restarted = setup('always', {
      restoredLightingIntent: first.engine.getLightingIntentSnapshot(),
    });
    await restarted.engine.handleSunElevation(-5);
    expect(restarted.power()).toBe(false);
    await restarted.engine.handlePresence(occupied);
    expect(restarted.adapter.observed.get(desk)?.power).toBe(true);
  });
  it('applies daylight after a routine guard expires', async () => {
    const { engine, adapter } = setup('always');
    let current = true;
    await engine.handleSunElevation(-5);
    await engine.setLighting(
      windowTarget,
      { brightness: 20 },
      { actor: { type: 'routine', id: 'fade' } },
      () => current,
    );
    current = false;
    await engine.handleSunElevation(10);
    expect(adapter.observed.get(windowTarget)?.power).toBe(false);
  });
});
