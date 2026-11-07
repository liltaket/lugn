import { afterEach, describe, expect, it } from 'vitest';
import {
  LugnEngine,
  type EngineOptions,
} from '../src/application/lugn-engine.js';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { FakeClock } from '../src/core/clock.js';
const windowTarget = 'lighting.window';
const desk = 'lighting.desk';
const engines: LugnEngine[] = [];
afterEach(() => engines.splice(0).forEach((engine) => engine.dispose()));
const occupied = { type: 'presence.changed', presence: 'occupied' } as const;
const empty = {
  type: 'presence.changed',
  presence: 'confirmed_empty',
} as const;
function setup(extra: Partial<EngineOptions> = {}) {
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
    ],
    defaultSceneId: 'scene.white',
    continuityMs: 1000,
    windowLighting: {
      target: windowTarget,
      presenceMode: 'home',
      brightness: 35,
      maxSunElevation: 0,
    },
    ...extra,
  });
  engines.push(engine);
  return { engine, clock, adapter };
}
describe('window lighting restart review regressions', () => {
  it.each(['before entry', 'after continuity expiry'])(
    'preserves default room entry after restart %s',
    async (when) => {
      const original = setup();
      await original.engine.handleSunElevation(-5);
      if (when === 'after continuity expiry') {
        await original.engine.handlePresence(occupied);
        await original.engine.handlePresence(empty);
        original.clock.advanceBy(1001);
      }
      const restarted = setup({
        restoredLightingIntent: original.engine.getLightingIntentSnapshot(),
      });
      await restarted.engine.handleSunElevation(-5);
      expect(restarted.adapter.observed.get(desk)?.power).not.toBe(true);
      await restarted.engine.handlePresence(occupied);
      expect(restarted.adapter.observed.get(desk)?.power).toBe(true);
    },
  );
  it('promptly turns off a restored room-mode light without sun data or occupancy', async () => {
    const original = setup();
    await original.engine.handleSunElevation(-5);
    await original.engine.handlePresence(occupied);
    const restarted = setup({
      restoredLightingIntent: original.engine.getLightingIntentSnapshot(),
      windowLighting: {
        target: windowTarget,
        presenceMode: 'room',
        brightness: 35,
        maxSunElevation: 0,
      },
    });
    restarted.adapter.externalChange(windowTarget, {
      power: true,
      brightness: 35,
      colorTemperature: 2700,
    });
    await Promise.resolve();
    expect(restarted.adapter.observed.get(windowTarget)?.power).toBe(false);
    expect(
      restarted.adapter.dispatched.filter((command) => command.target === desk),
    ).toEqual([]);
  });
  it('returns an expired window colour to the configured default', async () => {
    const { engine, clock, adapter } = setup({
      scenes: [
        {
          id: 'scene.white',
          name: 'White',
          lighting: {
            [windowTarget]: { power: true, colorTemperature: 2700 },
            [desk]: { power: true, colorTemperature: 2700 },
          },
        },
        {
          id: 'scene.party',
          name: 'Party',
          lighting: {
            [windowTarget]: { power: true, rgb: [200, 0, 100] },
            [desk]: { power: true, rgb: [200, 0, 100] },
          },
        },
      ],
    });
    await engine.handleSunElevation(-5);
    await engine.handlePresence(occupied);
    await engine.activateScene('scene.party', { type: 'user' });
    await engine.handlePresence(empty);
    clock.advanceBy(1001);
    await engine.handleSunElevation(5);
    await engine.handleSunElevation(-5);
    expect(adapter.observed.get(windowTarget)?.colorTemperature).toBe(2700);
    expect(adapter.observed.get(windowTarget)?.rgb).toBeUndefined();
  });
});
