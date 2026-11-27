import { afterEach, describe, expect, it } from 'vitest';
import {
  SimulatedLightingAdapter,
  type LightingCommand,
} from '../src/adapters/simulated-lighting.js';
import {
  GoveePresetLightingAdapter,
  type GoveeControlClient,
} from '../src/adapters/govee-preset-lighting.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import type { LightingScene } from '../src/core/schemas.js';

const desk = 'lighting.desk';
const table = 'lighting.govee_table';
const user = { type: 'user' as const, id: 'prelight-test' };
const occupied = { type: 'presence.changed', presence: 'occupied' } as const;
const empty = {
  type: 'presence.changed',
  presence: 'confirmed_empty',
} as const;
const approaching = { type: 'presence.prelight', active: true } as const;
const scenes: LightingScene[] = [
  {
    id: 'scene.default',
    name: 'Default',
    lighting: {
      [desk]: { power: true, brightness: 55 },
      [table]: { power: true, brightness: 55 },
    },
  },
  {
    id: 'scene.evening',
    name: 'Evening',
    lighting: {
      [desk]: { power: true, brightness: 20 },
      [table]: { power: true, brightness: 25 },
    },
  },
];
const engines: LugnEngine[] = [];
afterEach(() => engines.splice(0).forEach((engine) => engine.dispose()));

async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** The real Govee composite around a simulated Home Assistant transport. */
function fixture(cancel: () => Promise<void> = async () => {}) {
  const clock = new FakeClock(Date.parse('2026-11-09T18:00:00+01:00'));
  const lamps = new SimulatedLightingAdapter(clock);
  const client: GoveeControlClient = {
    capabilities: async () => ({}),
    apply: async () => {},
    cancel,
  };
  const adapter = new GoveePresetLightingAdapter(lamps, client, {
    [table]: { effects: [], zones: false },
  });
  const engine = new LugnEngine(clock, {
    adapter,
    deviceIds: [desk, table],
    scenes: structuredClone(scenes),
    defaultSceneId: 'scene.default',
    continuityMs: 1_000,
    prelight: { targets: {}, maxDurationMs: 5_000 },
  });
  engines.push(engine);
  return { clock, lamps, engine };
}

async function leaveForHours(
  engine: LugnEngine,
  clock: FakeClock,
): Promise<void> {
  await engine.handlePresence(empty);
  await flush();
  clock.advanceBy(3 * 60 * 60_000);
  await flush();
}

const writes = (commands: LightingCommand[]) =>
  Object.fromEntries(commands.map(({ target, values }) => [target, values]));

describe('prelight of the remembered light', () => {
  it('lights every lamp as it was left, including Govee lamps, at once', async () => {
    const { clock, lamps, engine } = fixture();
    await engine.handlePresence(occupied);
    await engine.activateScene('scene.evening', user);
    await engine.setLighting(desk, { brightness: 33 }, { actor: user });
    await flush();
    await leaveForHours(engine, clock);
    lamps.dispatched.length = 0;

    await engine.handlePrelight(approaching);
    await flush();

    expect(writes(lamps.dispatched)).toMatchObject({
      [desk]: { power: true, brightness: 33 },
      [table]: { power: true, brightness: 25 },
    });
    expect(lamps.dispatched.map(({ immediate }) => immediate)).toEqual([
      true,
      true,
    ]);
    expect(lamps.observed.get(table)?.power).toBe(true);

    lamps.dispatched.length = 0;
    await engine.handlePresence(occupied);
    await flush();
    // The preview already is the entry light: nothing changes on arrival.
    expect(lamps.dispatched).toEqual([]);
    expect(engine.state.lighting.currentScene).toBe('scene.evening');
  });

  it('drops a delayed Govee write once the preview has ended', async () => {
    let release: (() => void) | undefined;
    let hold = false;
    const { clock, lamps, engine } = fixture(() =>
      hold
        ? new Promise<void>((resolve) => {
            hold = false;
            release = resolve;
          })
        : Promise.resolve(),
    );
    await engine.handlePresence(occupied);
    await flush();
    await leaveForHours(engine, clock);
    lamps.dispatched.length = 0;

    hold = true;
    const preview = engine.handlePrelight(approaching);
    await flush();
    // An approach that never ends in an entry is held for at most 15 seconds.
    clock.advanceBy(15_000);
    await flush();
    release?.();
    await preview;
    await flush();

    expect(
      lamps.dispatched.filter(
        ({ target, values }) => target === table && values.power === true,
      ),
    ).toEqual([]);
    expect(lamps.observed.get(table)?.power).not.toBe(true);
  });
});
