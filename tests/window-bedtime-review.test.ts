import { afterEach, describe, expect, it } from 'vitest';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { FakeClock } from '../src/core/clock.js';

const windowTarget = 'lighting.window';
const desk = 'lighting.desk';
const engines: LugnEngine[] = [];
afterEach(() => engines.splice(0).forEach((engine) => engine.dispose()));
function setup() {
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
        id: 'scene.all_off',
        name: 'Off',
        lighting: {
          [windowTarget]: { power: false },
          [desk]: { power: false },
        },
      },
      {
        id: 'scene.custom',
        name: 'Custom',
        lighting: {
          [desk]: { power: true, brightness: 60, rgb: [180, 0, 30] },
        },
      },
      {
        id: 'scene.window_off',
        name: 'Window off',
        lighting: {
          [windowTarget]: { power: false },
          [desk]: { power: true, brightness: 60, colorTemperature: 3000 },
        },
      },
    ],
    defaultSceneId: 'scene.white',
    windowLighting: {
      target: windowTarget,
      brightness: 35,
      presenceMode: 'always',
      maxSunElevation: -2,
    },
  });
  engines.push(engine);
  return { clock, adapter, engine };
}

describe('window light explicit intent and bedtime regressions', () => {
  it.each(['user', 'routine'] as const)(
    'retains %s OFF through feedback, enforcement and sun changes',
    async (type) => {
      const { engine, adapter, clock } = setup();
      await engine.handleSunElevation(-5);
      await engine.activateScene('scene.white', { type: 'user' });
      await engine.setLighting(
        windowTarget,
        { power: false, brightness: 0 },
        {
          actor: {
            type,
            ...(type === 'routine' ? { id: 'bedtime-night' } : {}),
          },
        },
      );
      clock.advanceBy(30001);
      await engine.handleSunElevation(5);
      await engine.handleSunElevation(-5);
      expect(adapter.observed.get(windowTarget)?.power).toBe(false);
      expect(
        engine.state.intent.holds.some(
          (hold) =>
            hold.scope === 'lighting.activation' &&
            hold.target === windowTarget,
        ),
      ).toBe(true);
      expect(
        engine.state.intent.holds.some(
          (hold) =>
            hold.scope === 'lighting.property' &&
            hold.target === windowTarget &&
            hold.property === 'power' &&
            hold.intent === true,
        ),
      ).toBe(false);
      await engine.activateScene('scene.custom', { type: 'user' });
      expect(adapter.observed.get(windowTarget)).toMatchObject({
        power: true,
        brightness: 35,
        rgb: [180, 0, 30],
      });
    },
  );
  it('clears all-off activation hold for a new scene omitting the window', async () => {
    const { engine, adapter } = setup();
    await engine.handleSunElevation(-5);
    await engine.activateScene('scene.all_off', { type: 'user' });
    expect(adapter.observed.get(windowTarget)?.power).toBe(false);
    await engine.activateScene('scene.custom', { type: 'user' });
    expect(adapter.observed.get(windowTarget)).toMatchObject({
      power: true,
      rgb: [180, 0, 30],
    });
  });
  it('releases a finished bedtime guard on a new scene omitting the window', async () => {
    const { engine, adapter } = setup();
    let current = true;
    await engine.handleSunElevation(-5);
    await engine.activateScene('scene.white', { type: 'user' });
    await engine.setLighting(
      windowTarget,
      { power: false, brightness: 0 },
      { actor: { type: 'routine', id: 'bedtime-night' } },
      () => current,
    );
    current = false;
    await engine.activateScene('scene.custom', { type: 'user' });
    expect(adapter.observed.get(windowTarget)?.power).toBe(true);
  });
  it('allows explicit ON to restore configured brightness after bedtime OFF', async () => {
    const { engine, adapter } = setup();
    await engine.handleSunElevation(-5);
    await engine.activateScene('scene.white', { type: 'user' });
    await engine.setLighting(
      windowTarget,
      { power: false, brightness: 0 },
      { actor: { type: 'user' } },
    );
    await engine.setLighting(
      windowTarget,
      { power: true },
      { actor: { type: 'user' } },
    );
    expect(adapter.observed.get(windowTarget)).toMatchObject({
      power: true,
      brightness: 35,
    });
  });
  it('allows routine brightness fades before final OFF', async () => {
    const { engine, adapter } = setup();
    await engine.handleSunElevation(-5);
    await engine.activateScene('scene.white', { type: 'user' });
    await engine.setLighting(
      windowTarget,
      { brightness: 10 },
      { actor: { type: 'routine', id: 'bedtime-night' } },
    );
    await engine.handleSunElevation(-6);
    expect(adapter.observed.get(windowTarget)).toMatchObject({
      power: true,
      brightness: 10,
    });
    await engine.setLighting(
      windowTarget,
      { power: false, brightness: 0 },
      { actor: { type: 'routine', id: 'bedtime-night' } },
    );
    expect(adapter.observed.get(windowTarget)?.power).toBe(false);
  });
  it('does not bypass daylight for explicit power or brightness updates', async () => {
    const { engine, adapter } = setup();
    await engine.handleSunElevation(10);
    await engine.setLighting(
      windowTarget,
      { power: true, brightness: 90 },
      { actor: { type: 'user' } },
    );
    expect(adapter.observed.get(windowTarget)?.power).toBe(false);
    await engine.handleSunElevation(-5);
    expect(adapter.observed.get(windowTarget)).toMatchObject({
      power: true,
      brightness: 90,
    });
  });
  it('synchronizes the active window Kelvin while empty even if its scene entry is OFF', async () => {
    const { engine, adapter } = setup();
    await engine.handleSunElevation(-5);
    await engine.activateScene('scene.window_off', { type: 'user' });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
    });
    await engine.setLighting(
      desk,
      { colorTemperature: 4000 },
      { actor: { type: 'user' } },
    );
    expect(adapter.observed.get(windowTarget)?.colorTemperature).toBe(4000);
  });
});
