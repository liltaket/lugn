import { describe, expect, it } from 'vitest';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { LugnEngine, defaultScenes } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';

const user = { type: 'user' as const, id: 'test-user' };

function setup(options: ConstructorParameters<typeof LugnEngine>[1] = {}) {
  const clock = new FakeClock(Date.parse('2026-09-28T12:00:00+02:00'));
  const adapter = new SimulatedLightingAdapter(clock);
  const engine = new LugnEngine(clock, { adapter, ...options });
  return { clock, adapter, engine };
}

const occupied = { type: 'presence.changed', presence: 'occupied' } as const;
const empty = {
  type: 'presence.changed',
  presence: 'confirmed_empty',
} as const;

/** Regression guards for the batched presence fast path. */
describe('presence lighting fast path', () => {
  it('restores a manual override after a short absence instead of the scene value', async () => {
    const { adapter, engine } = setup();
    await engine.activateScene('scene.cozy', user);
    await engine.handlePresence(occupied);
    adapter.externalChange('lighting.desk', { brightness: 80 });
    expect(
      engine.state.lighting.devices['lighting.desk']?.ownership.brightness
        ?.kind,
    ).toBe('override');

    await engine.handlePresence(empty);
    expect(adapter.observed.get('lighting.desk')?.power).toBe(false);
    adapter.dispatched.length = 0;
    await engine.handlePresence(occupied);

    const desk = adapter.dispatched.filter(
      ({ target }) => target === 'lighting.desk',
    );
    expect(desk.at(-1)?.values).toMatchObject({ power: true, brightness: 80 });
    expect(adapter.observed.get('lighting.ceiling')).toMatchObject({
      power: true,
      brightness: 60,
    });
    engine.dispose();
  });

  it('sends entry lighting to lamps whose state was never observed', async () => {
    const { adapter, engine } = setup({ defaultSceneId: 'scene.cozy' });
    await engine.handlePresence(occupied);
    expect(adapter.dispatched.map(({ target }) => target).sort()).toEqual([
      'lighting.ceiling',
      'lighting.desk',
    ]);
    engine.dispose();
  });

  it('turns off a lamp whose on command is unconfirmed even if HA last said off', async () => {
    const { clock, adapter, engine } = setup({ defaultSceneId: 'scene.cozy' });
    adapter.externalChange('lighting.ceiling', { power: false });
    adapter.externalChange('lighting.desk', { power: false });
    adapter.feedbackDelayMs = 1_000;
    const entry = engine.handlePresence(occupied);
    expect(
      engine.state.lighting.devices['lighting.ceiling']?.observed.power,
    ).toBe(false);

    adapter.dispatched.length = 0;
    adapter.feedbackDelayMs = 0;
    const exit = engine.handlePresence(empty);
    // The stale "off" observation must not suppress the physical off.
    expect(
      adapter.dispatched
        .filter(({ values }) => values.power === false)
        .map(({ target }) => target)
        .sort(),
    ).toEqual(['lighting.ceiling', 'lighting.desk']);
    clock.advanceBy(1_000);
    await Promise.all([entry, exit]);
    engine.dispose();
  });

  it('retries a command whose feedback never arrives', async () => {
    const { clock, adapter, engine } = setup({ defaultSceneId: 'scene.cozy' });
    adapter.ignoreNextForTargets.add('lighting.desk');
    await engine.handlePresence(occupied);
    const sentToDesk = (): number =>
      adapter.dispatched.filter(({ target }) => target === 'lighting.desk')
        .length;
    expect(sentToDesk()).toBe(1);
    clock.advanceBy(2_000);
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    expect(sentToDesk()).toBe(2);
    expect(adapter.observed.get('lighting.desk')).toMatchObject({
      power: true,
      brightness: 30,
    });
    engine.dispose();
  });

  it('keeps away-mode suppression on the batched entry path', async () => {
    const { adapter, engine } = setup({ defaultSceneId: 'scene.cozy' });
    await engine.handleHomePresence('away');
    const published: string[][] = [];
    const unsubscribe = engine.stream.subscribe((update) =>
      published.push([...update.domains]),
    );
    await engine.handlePresence(occupied);
    expect(adapter.dispatched).toEqual([]);
    expect(engine.state.presence.state).toBe('occupied');
    expect(published.some((domains) => domains.includes('presence'))).toBe(
      true,
    );
    expect(
      engine.state.diagnostics.some(
        (entry) => entry.kind === 'presence.lighting_suppressed_home_away',
      ),
    ).toBe(true);
    unsubscribe();
    engine.dispose();
  });
});

describe('dark-room off delivery', () => {
  it('retries a failed prelight restore off while the room stays empty', async () => {
    const clock = new FakeClock(Date.parse('2026-09-28T12:00:00+02:00'));
    const inner = new SimulatedLightingAdapter(clock);
    let failNextDeskOff = false;
    const adapter = {
      subscribe: inner.subscribe.bind(inner),
      dispatch: async (command: Parameters<typeof inner.dispatch>[0]) => {
        if (
          failNextDeskOff &&
          command.target === 'lighting.desk' &&
          command.values.power === false
        ) {
          failNextDeskOff = false;
          throw new Error('Home Assistant integration error');
        }
        return inner.dispatch(command);
      },
    };
    const engine = new LugnEngine(clock, {
      adapter,
      defaultSceneId: 'scene.cozy',
    });
    // Leaving after an active scene keeps its remembered values, so the later
    // restore off carries brightness/Kelvin and is not a bare power-off.
    await engine.handlePresence(occupied);
    await engine.handlePresence(empty);
    expect(inner.observed.get('lighting.desk')?.power).toBe(false);

    await engine.handlePrelight({ type: 'presence.prelight', active: true });
    expect(inner.observed.get('lighting.desk')?.power).toBe(true);
    await engine.handlePrelight({ type: 'presence.prelight', active: false });
    failNextDeskOff = true;
    clock.advanceBy(5_000);
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    expect(inner.observed.get('lighting.ceiling')?.power).toBe(false);
    expect(inner.observed.get('lighting.desk')?.power).toBe(true);

    clock.advanceBy(2_000);
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    expect(inner.observed.get('lighting.desk')?.power).toBe(false);
    expect(engine.state.presence.state).toBe('confirmed_empty');
    expect(
      engine.state.lighting.devices['lighting.desk']?.effectiveDesired,
    ).toMatchObject({ brightness: 30 });
    engine.dispose();
  });
});

/** Prelight lights a room that is dark because nobody is there, at any hour. */
describe('prelight policy', () => {
  const prelight = { type: 'presence.prelight', active: true } as const;
  const suppressedReason = (engine: LugnEngine): unknown =>
    engine.state.diagnostics
      .filter(({ kind }) => kind === 'presence.prelight_suppressed')
      .at(-1)?.details['reason'];

  function nightSetup() {
    const clock = new FakeClock(Date.parse('2026-11-09T23:20:00+01:00'));
    const adapter = new SimulatedLightingAdapter(clock);
    const engine = new LugnEngine(clock, {
      adapter,
      defaultSceneId: 'scene.cozy',
      scenes: [
        ...defaultScenes,
        {
          id: 'scene.all_off',
          name: 'Helt släckt',
          lighting: {
            'lighting.ceiling': { power: false },
            'lighting.desk': { power: false },
          },
        },
      ],
    });
    return { clock, adapter, engine };
  }

  it('prelights an empty dark room late at night', async () => {
    const { adapter, engine } = nightSetup();
    await engine.handlePresence(occupied);
    await engine.handlePresence(empty);
    adapter.dispatched.length = 0;
    await engine.handlePrelight(prelight);
    expect(
      adapter.dispatched
        .filter(({ values }) => values.power === true)
        .map(({ target }) => target)
        .sort(),
    ).toEqual(['lighting.ceiling', 'lighting.desk']);
    engine.dispose();
  });

  it('leaves a lamp the resident switched off by hand dark', async () => {
    const { adapter, engine } = nightSetup();
    await engine.handlePresence(occupied);
    adapter.externalChange('lighting.desk', { power: false });
    await engine.handlePresence(empty);
    adapter.dispatched.length = 0;
    await engine.handlePrelight(prelight);
    expect(adapter.dispatched.map(({ target }) => target)).toEqual([
      'lighting.ceiling',
    ]);
    engine.dispose();
  });

  it('does not prelight when the resident switched every lamp off', async () => {
    const { adapter, engine } = nightSetup();
    await engine.handlePresence(occupied);
    adapter.externalChange('lighting.desk', { power: false });
    adapter.externalChange('lighting.ceiling', { power: false });
    await engine.handlePresence(empty);
    adapter.dispatched.length = 0;
    await engine.handlePrelight(prelight);
    expect(adapter.dispatched).toEqual([]);
    expect(suppressedReason(engine)).toBe('explicitly_off');
    engine.dispose();
  });

  it('does not prelight after the room was switched off from a remote or bedtime scene', async () => {
    const { adapter, engine } = nightSetup();
    await engine.handlePresence(occupied);
    await engine.activateScene('scene.all_off', user, 'bed-hub');
    await engine.handlePresence(empty);
    adapter.dispatched.length = 0;
    await engine.handlePrelight(prelight);
    expect(adapter.dispatched).toEqual([]);
    expect(suppressedReason(engine)).toBe('all_lights_off_scene');
    engine.dispose();
  });

  it('does not prelight while the resident is in the room', async () => {
    const { adapter, engine } = nightSetup();
    await engine.handlePresence(occupied);
    adapter.externalChange('lighting.desk', { power: false });
    adapter.externalChange('lighting.ceiling', { power: false });
    adapter.dispatched.length = 0;
    await engine.handlePrelight(prelight);
    expect(adapter.dispatched).toEqual([]);
    engine.dispose();
  });
});
