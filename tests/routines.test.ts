import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoutineService } from '../src/application/routines.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import {
  LugnEngine,
  type EngineOptions,
} from '../src/application/lugn-engine.js';
import { RoutineStore } from '../src/runtime/routine-store.js';
import { FakeClock, type Clock } from '../src/core/clock.js';
import {
  createRoutineTemplates,
  nextRoutineOccurrence,
  previewRoutine,
  RoutineDefinitionSchema,
  type RoutineDefinition,
  type RoutineStep,
} from '../src/core/routines.js';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';

const user = {
  actor: { type: 'user' as const, id: 'test' },
  source: 'test-ui',
};
const light = (brightness = 10, durationMs = 0): RoutineStep => ({
  type: 'light',
  targets: ['lighting.desk'],
  brightness,
  durationMs,
});
const delay = (durationMs = 5_000): RoutineStep => ({
  type: 'delay',
  durationMs,
});
const definition = (
  steps: RoutineStep[] = [delay()],
  extra: Partial<RoutineDefinition> = {},
): RoutineDefinition => ({
  id: 'test',
  name: 'Test',
  kind: 'custom',
  enabled: true,
  schedule: null,
  steps,
  ...extra,
});
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
class WallClock implements Clock {
  offset = 0;
  constructor(readonly fake: FakeClock) {}
  now() {
    return this.fake.now() + this.offset;
  }
  monotonicNow() {
    return this.fake.monotonicNow();
  }
  setTimeout(callback: () => void, ms: number) {
    return this.fake.setTimeout(callback, ms);
  }
  clearTimeout(handle: ReturnType<Clock['setTimeout']>) {
    this.fake.clearTimeout(handle);
  }
}
async function setup(
  definitions: RoutineDefinition[] = [definition()],
  start = '2026-10-19T12:00:00+02:00',
  engineOptions: EngineOptions = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'lugn-routines-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const fake = new FakeClock(Date.parse(start));
  const clock = new WallClock(fake);
  const lighting = new SimulatedLightingAdapter(clock);
  const music = new SimulatedMusicAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: ['lighting.desk', 'lighting.other'],
    adapter: lighting,
    scenes: [
      {
        id: 'scene.all_off',
        name: 'Off',
        lighting: {
          'lighting.desk': { power: false },
          'lighting.other': { power: false },
        },
      },
      {
        id: 'scene.soft',
        name: 'Soft',
        lighting: { 'lighting.desk': { power: true, brightness: 15 } },
      },
    ],
    music: {
      adapter: music,
      targets: { 'music.room': ['Spotify', 'Optical'] },
    },
    ...engineOptions,
  });
  await engine.handlePresence({
    type: 'presence.changed',
    presence: 'occupied',
    personCount: 1,
  });
  await engine.handleHomePresence('home');
  lighting.externalChange('lighting.desk', { power: false, brightness: 70 });
  lighting.externalChange('lighting.other', { power: true, brightness: 30 });
  music.observe('music.room', {
    playback: 'paused',
    volume: 0.2,
    source: 'Spotify',
    title: 'Test',
  });
  await flush();
  const registry = new CapabilityRegistry(engine);
  const store = new RoutineStore(join(dir, 'routines.json'), definitions);
  await store.load();
  const service = new RoutineService(clock, {
    engine,
    capabilities: registry,
    store,
  });
  const dispose = () => {
    service.dispose();
    engine.dispose();
    expect(fake.pendingTimers()).toBe(0);
  };
  cleanups.push(dispose);
  music.dispatched.length = 0;
  lighting.dispatched.length = 0;
  const advance = async (ms: number, quantum = 250) => {
    for (let elapsed = 0; elapsed < ms; elapsed += quantum) {
      fake.advanceBy(Math.min(quantum, ms - elapsed));
      await flush();
    }
  };
  const action = (action: string, extra = {}) =>
    service.action({ id: 'test', action, ...extra }, user);
  const run = () => service.snapshot().runs.at(-1)!;
  return {
    dir,
    fake,
    clock,
    lighting,
    music,
    engine,
    registry,
    store,
    service,
    advance,
    action,
    run,
    dispose,
  };
}

describe('routine definitions, templates and pure preview', () => {
  it('provides disabled templates with gradual morning lighting and no automatic music opt-in', () => {
    const templates = createRoutineTemplates({
      lightTargets: ['lighting.desk'],
      musicTarget: 'music.room',
    });
    expect(templates.every((d) => !d.enabled && d.schedule === null)).toBe(
      true,
    );
    expect(
      templates.find((d) => d.kind === 'good_morning')?.steps,
    ).toContainEqual(light(40, 1_200_000));
    expect(createRoutineTemplates()).toHaveLength(2);
  });
  it('rejects unbounded, malformed or unsupported definitions', () => {
    for (const input of [
      definition([delay(3_600_001)]),
      definition(Array.from({ length: 33 }, () => delay())),
      definition([
        { type: 'volume', target: 'music.room', volume: 2, durationMs: 0 },
      ]),
      definition([light()], { schedule: { time: '24:00', weekdays: [1] } }),
      definition([light()], { schedule: { time: '07:00', weekdays: [0, 1] } }),
      definition([light()], { schedule: { time: '07:00', weekdays: [1, 1] } }),
      definition([{ type: 'condition', condition: 'music_idle' }]),
      { ...definition(), extra: true },
    ])
      expect(RoutineDefinitionSchema.safeParse(input).success).toBe(false);
  });
  it('previews timing without dispatch, persistence or mutation', async () => {
    const s = await setup([
      definition([
        delay(2_000),
        light(30, 10_000),
        { type: 'playback', target: 'music.room', state: 'playing' },
      ]),
    ]);
    const before = s.store.snapshot();
    const preview = s.service.preview(before.definitions[0]);
    expect(preview.durationMs).toBe(12_000);
    expect(preview.timeline.map((t) => t.atMs)).toEqual([0, 2_000, 12_000]);
    expect(s.lighting.dispatched).toEqual([]);
    expect(s.music.dispatched).toEqual([]);
    expect(s.store.snapshot()).toEqual(before);
    expect(
      previewRoutine(createRoutineTemplates()[0]).warnings.join(' '),
    ).toContain('disabled');
  });
});

describe('Stockholm scheduling', () => {
  const scheduled = (time = '07:00', weekdays = [1, 2, 3, 4, 5, 6, 7]) =>
    definition([delay()], { schedule: { time, weekdays } });
  const next = (d: RoutineDefinition, after: string) =>
    new Date(nextRoutineOccurrence(d, Date.parse(after))!.at).toISOString();
  it('uses ISO weekdays and a strictly future civil time', () => {
    expect(next(scheduled('07:00', [1]), '2026-10-18T20:00:00Z')).toBe(
      '2026-10-19T05:00:00.000Z',
    );
    expect(next(scheduled('07:00', [1]), '2026-10-19T05:00:00Z')).toBe(
      '2026-10-26T06:00:00.000Z',
    );
    expect(
      nextRoutineOccurrence({ ...scheduled(), enabled: false }, Date.now()),
    ).toBeNull();
  });
  it('skips the spring DST gap, including a schedule only on Sundays', () => {
    expect(next(scheduled('02:30'), '2026-03-28T23:00:00Z')).toBe(
      '2026-03-30T00:30:00.000Z',
    );
    expect(next(scheduled('02:30', [7]), '2026-03-28T23:00:00Z')).toBe(
      '2026-04-05T00:30:00.000Z',
    );
  });
  it('selects the first fold instant and never the second', () => {
    expect(next(scheduled('02:30'), '2026-10-24T23:00:00Z')).toBe(
      '2026-10-25T00:30:00.000Z',
    );
    expect(next(scheduled('02:30'), '2026-10-25T00:30:00Z')).toBe(
      '2026-10-26T01:30:00.000Z',
    );
    expect(next(scheduled('02:30'), '2026-10-25T01:00:00Z')).toBe(
      '2026-10-26T01:30:00.000Z',
    );
  });
  it('triggers once and advances next before dispatching', async () => {
    const s = await setup([scheduled('12:01')]);
    await s.advance(60_000);
    expect(s.service.snapshot().runs).toHaveLength(1);
    expect(s.service.snapshot().next[0]!.at).toBe(
      Date.parse('2026-10-20T12:01:00+02:00'),
    );
    await s.advance(10_000);
    expect(s.run().status).toBe('completed');
    expect(s.service.snapshot().runs).toHaveLength(1);
  });
  it('restarts with future occurrences and drops active/snoozed work', async () => {
    const d = scheduled('12:01');
    const s = await setup([d]);
    s.action('start');
    await flush();
    s.service.dispose();
    await s.advance(65_000);
    const restarted = new RoutineService(s.clock, {
      engine: s.engine,
      capabilities: s.registry,
      store: s.store,
    });
    cleanups.push(() => restarted.dispose());
    expect(restarted.snapshot().runs).toEqual([]);
    expect(restarted.snapshot().next[0]!.at).toBe(
      Date.parse('2026-10-20T12:01:00+02:00'),
    );
  });
  it.each([3_600_000, -3_600_000])(
    'cancels active work and never replays after wall clock shift %s',
    async (shift) => {
      const s = await setup([scheduled('12:01')]);
      s.action('start');
      await flush();
      s.clock.offset += shift;
      await s.advance(1_000);
      expect(s.run().status).toBe('cancelled');
      expect(s.run().reason).toBe('Clock changed');
      expect(s.service.snapshot().runs).toHaveLength(1);
      expect(s.service.snapshot().next[0]!.at).toBeGreaterThan(
        Math.max(s.clock.now(), Date.parse('2026-10-19T12:00:00+02:00')),
      );
    },
  );
  it('skip and snooze require an actual occurrence and preserve scheduled provenance', async () => {
    const s = await setup([scheduled('12:01')]);
    const original = s.service.snapshot().next[0]!.at;
    s.action('skip');
    expect(s.service.snapshot().next[0]!.at).toBeGreaterThan(original);
    s.action('snooze', { minutes: 1, requestId: 'snooze-1' });
    const snoozed = s.service.snapshot().next[0]!.at;
    s.action('snooze', { minutes: 1, requestId: 'snooze-1' });
    expect(s.service.snapshot().next[0]!.at).toBe(snoozed);
    await s.advance(60_000);
    expect(s.service.snapshot().runs).toHaveLength(1);
    s.action('skip');
    expect(s.run().status).toBe('cancelled');
    const noSchedule = await setup();
    expect(() => noSchedule.action('snooze')).toThrow(
      'routine_occurrence_unknown',
    );
  });
  it('does not catch up stale delayed actions after a suspended event loop', async () => {
    const s = await setup([definition([delay(2_000), light(80)])]);
    s.action('start');
    await flush();
    // Let timer callbacks run normally, but withhold microtasks until well past due.
    s.fake.advanceBy(20_000);
    await flush();
    expect(s.lighting.dispatched).toEqual([]);
    expect(s.run().status).toBe('failed');
  });
});

describe('execution and cancellation', () => {
  it('requires explicit enablement and a human action provenance', async () => {
    const s = await setup([definition([light()], { enabled: false })]);
    expect(() => s.action('start')).toThrow('routine_disabled');
    expect(() =>
      s.service.action(
        { id: 'test', action: 'start' },
        { actor: { type: 'automation' } },
      ),
    ).toThrow('human_actor_required');
    await s.advance(60_000);
    expect(s.lighting.dispatched).toEqual([]);
  });
  it('starts from off at zero and increases gradually without an initial bright scene', async () => {
    const s = await setup([definition([light(10, 10_000)])]);
    s.action('start');
    await flush();
    expect(s.lighting.dispatched).toEqual([]);
    await s.advance(1_000);
    expect(s.lighting.dispatched.map((c) => c.values.brightness)).toEqual([1]);
    await s.advance(9_000);
    expect(s.lighting.dispatched.map((c) => c.values.brightness)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(s.run().status).toBe('completed');
  });
  it('fades down to actual off and composes scene and delay capabilities', async () => {
    const s = await setup([
      definition([
        { type: 'scene', sceneId: 'scene.soft' },
        delay(1_000),
        light(0, 3_000),
      ]),
    ]);
    s.action('start');
    await flush();
    expect(s.engine.state.lighting.currentScene).toBe('scene.soft');
    await s.advance(4_000);
    expect(s.lighting.dispatched.at(-1)!.values).toEqual({
      power: false,
      brightness: 0,
    });
    expect(s.run().status).toBe('completed');
  });
  it('cancels delayed work, publishes status, and idempotently retries cancel', async () => {
    const s = await setup([definition([delay(), light(80)])]);
    const snapshots: string[] = [];
    s.service.subscribe((snapshot) =>
      snapshots.push(snapshot.runs.at(-1)?.status ?? 'none'),
    );
    s.action('start');
    await flush();
    s.action('cancel', { requestId: 'cancel' });
    s.action('cancel', { requestId: 'cancel' });
    await s.advance(10_000);
    expect(s.lighting.dispatched).toEqual([]);
    expect(s.run().status).toBe('cancelled');
    expect(snapshots).toContain('cancelled');
  });
  it('idempotent start does not create another run, even after completion', async () => {
    const s = await setup([definition([light()])]);
    s.action('start', { requestId: 'same' });
    await flush();
    s.action('start', { requestId: 'same' });
    expect(s.service.snapshot().runs).toHaveLength(1);
    expect(s.lighting.dispatched).toHaveLength(1);
    expect(() => s.action('cancel', { requestId: 'same' })).toThrow(
      'routine_request_reused',
    );
  });
  it('concurrent starts replace overlapping runs; disjoint targets continue', async () => {
    const s = await setup([
      definition([delay(), light()]),
      definition(
        [delay(), { ...light(), targets: ['lighting.other'] } as RoutineStep],
        { id: 'other' },
      ),
    ]);
    s.action('start');
    s.service.action({ id: 'other', action: 'start' }, user);
    s.action('start');
    await flush();
    expect(s.service.snapshot().runs.map((r) => r.status)).toEqual([
      'cancelled',
      'running',
      'running',
    ]);
    await s.advance(5_000);
    expect(s.service.snapshot().runs.map((r) => r.status)).toEqual([
      'cancelled',
      'completed',
      'completed',
    ]);
  });
  it.each(['ui', 'external', 'bilresa'] as const)(
    'human %s cancels affected light fades and pending actions',
    async (origin) => {
      const s = await setup([
        definition([light(10, 10_000), delay(), light(80)]),
      ]);
      s.action('start');
      await s.advance(2_000);
      if (origin === 'ui')
        await s.registry.invoke(
          'lighting.set',
          { target: 'lighting.desk', values: { power: true, brightness: 35 } },
          user,
        );
      if (origin === 'external')
        s.lighting.externalChange('lighting.desk', { brightness: 35 });
      if (origin === 'bilresa')
        await s.engine.handleBilresaPress('1', 'multi_press_1');
      const before = s.lighting.dispatched.length;
      await s.advance(20_000);
      expect(s.run().status).toBe('cancelled');
      expect(s.lighting.dispatched).toHaveLength(before);
    },
  );
  it('unrelated manual light changes do not cancel a run', async () => {
    const s = await setup([definition([delay(), light()])]);
    s.action('start');
    await flush();
    s.lighting.externalChange('lighting.other', { brightness: 45 });
    expect(s.run().status).toBe('running');
    await s.advance(5_000);
    expect(s.run().status).toBe('completed');
  });
  it('a manual scene cancels overlapping light fades while disjoint fades continue', async () => {
    const s = await setup([
      definition([light(10, 10_000), light(80)]),
      definition(
        [
          {
            type: 'light',
            targets: ['lighting.other'],
            brightness: 10,
            durationMs: 10_000,
          },
        ],
        { id: 'other' },
      ),
    ]);
    s.action('start');
    s.service.action({ id: 'other', action: 'start' }, user);
    await s.advance(2_000);
    await s.registry.invoke(
      'lighting.activateScene',
      { sceneId: 'scene.soft' },
      user,
    );
    expect(s.service.snapshot().runs.map((r) => r.status)).toEqual([
      'cancelled',
      'running',
    ]);
    const before = s.lighting.dispatched.length;
    await s.advance(20_000);
    expect(s.service.snapshot().runs.map((r) => r.status)).toEqual([
      'cancelled',
      'completed',
    ]);
    const later = s.lighting.dispatched.slice(before);
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((c) => c.target === 'lighting.other')).toBe(true);
    expect(later.at(-1)?.values.brightness).toBe(10);
    expect(
      s.engine.state.lighting.devices['lighting.desk']?.observed.brightness,
    ).toBe(15);
  });
  it('matching scene intent still cancels pending work on the selected target', async () => {
    const s = await setup([definition([delay(), light(80)])]);
    await s.registry.invoke(
      'lighting.activateScene',
      { sceneId: 'scene.soft' },
      user,
    );
    s.action('start');
    await flush();
    s.lighting.dispatched.length = 0;
    await s.registry.invoke(
      'lighting.activateScene',
      { sceneId: 'scene.soft' },
      user,
    );
    expect(s.run().status).toBe('cancelled');
    await s.advance(10_000);
    expect(s.lighting.dispatched).toEqual([]);
  });
  it.each(['lighting.desk', 'lighting.other'])(
    'a manual scene cancels native music fade work only when routine lighting overlaps (%s)',
    async (target) => {
      const s = await setup([
        definition([
          {
            type: 'volume',
            target: 'music.room',
            volume: 0.1,
            durationMs: 5_000,
          },
          { type: 'light', targets: [target], brightness: 80, durationMs: 0 },
        ]),
      ]);
      const original = s.music.dispatch.bind(s.music);
      vi.spyOn(s.music, 'dispatch').mockImplementation(async (command) => {
        await original(command);
        if (command.requested.property === 'volume')
          s.music.observe(
            command.target,
            {
              ...s.engine.getMusicState(command.target).observed,
              volume: command.requested.value,
            },
            true,
            command.id,
          );
      });
      s.action('start');
      await s.advance(1_000);
      const fadeId = s.engine.state.music.fades['music.room']?.id;
      expect(s.engine.state.music.fades['music.room']?.status).toBe('active');
      await s.registry.invoke(
        'lighting.activateScene',
        { sceneId: 'scene.soft' },
        user,
      );
      const overlaps = target === 'lighting.desk';
      expect(s.run().status).toBe(overlaps ? 'cancelled' : 'running');
      expect(s.engine.state.music.fades['music.room']).toMatchObject({
        id: fadeId,
        status: overlaps ? 'cancelled' : 'active',
      });
      const musicBefore = s.music.dispatched.length;
      const lightingBefore = s.lighting.dispatched.length;
      await s.advance(10_000);
      expect(s.run().status).toBe(overlaps ? 'cancelled' : 'completed');
      expect(s.engine.state.music.fades['music.room']).toMatchObject({
        id: fadeId,
        status: overlaps ? 'cancelled' : 'completed',
      });
      if (overlaps) {
        expect(s.music.dispatched).toHaveLength(musicBefore);
        expect(s.lighting.dispatched).toHaveLength(lightingBefore);
      } else {
        expect(s.music.dispatched.length).toBeGreaterThan(musicBefore);
        expect(s.lighting.dispatched.at(-1)).toMatchObject({
          target: 'lighting.other',
          values: { brightness: 80 },
        });
      }
    },
  );
  it('disable/delete invalidates running work; saving a different definition preserves it', async () => {
    const s = await setup([definition([delay(), light()])]);
    s.action('start');
    await flush();
    await s.store.save(
      definition([delay()], { id: 'other' }),
      s.store.snapshot().generation,
    );
    expect(s.run().status).toBe('running');
    await s.store.save(
      definition([delay(), light()], { enabled: false }),
      s.store.snapshot().generation,
    );
    expect(s.run().status).toBe('cancelled');
    await s.advance(10_000);
    expect(s.lighting.dispatched).toEqual([]);
    await s.store.delete('test', s.store.snapshot().generation);
    expect(() => s.action('start')).toThrow('routine_not_found');
  });
  it('condition false stops without side effects', async () => {
    const s = await setup([
      definition([
        { type: 'condition', condition: 'music_idle', target: 'music.room' },
        light(),
      ]),
    ]);
    s.music.observe('music.room', {
      playback: 'playing',
      volume: 0.2,
      source: 'Spotify',
      title: 'Test',
    });
    s.action('start');
    await flush();
    expect(s.run().status).toBe('cancelled');
    expect(s.lighting.dispatched).toEqual([]);
  });
  it('bounded dispatch timeout prevents later steps and late completion cannot revive a run', async () => {
    const s = await setup([definition([light(), light(80)])]);
    let release!: () => void;
    vi.spyOn(s.lighting, 'dispatch').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    s.action('start');
    await flush();
    await s.advance(15_000);
    expect(s.run().status).toBe('failed');
    expect(s.run().reason).toContain('timed out');
    release();
    await flush();
    await s.advance(60_000);
    expect(s.lighting.dispatch).toHaveBeenCalledTimes(1);
  });
  it('cancel while lighting preparation awaits prevents dispatch after it resumes', async () => {
    const s = await setup([definition([light()])]);
    s.action('start');
    // execute begins, then setLighting awaits finishPrelight; cancellation runs first.
    await Promise.resolve();
    s.action('cancel');
    await flush();
    expect(s.lighting.dispatched).toEqual([]);
    expect(s.run().status).toBe('cancelled');
  });
  it('dispose clears pending work and every owned/engine timer', async () => {
    const s = await setup([definition([light(20, 20_000)])]);
    s.action('start');
    await s.advance(1_000);
    s.dispose();
    await s.advance(60_000);
    expect(s.fake.pendingTimers()).toBe(0);
    expect(s.run().status).toBe('cancelled');
  });
});

describe('music policies', () => {
  const play: RoutineStep = {
    type: 'playback',
    target: 'music.room',
    state: 'playing',
  };
  it.each(['23:00', '02:00', '05:58'])(
    'scheduled playback stays blocked at %s',
    async (time) => {
      const s = await setup(
        [
          definition([play], {
            schedule: { time, weekdays: [1, 2, 3, 4, 5, 6, 7] },
          }),
        ],
        `2026-10-19T${time}:00+02:00`,
      );
      s.action('snooze', { minutes: 1 });
      await s.advance(60_000);
      expect(
        s.music.dispatched.filter(
          (c) =>
            c.requested.property === 'playback' &&
            c.requested.value === 'playing',
        ),
      ).toEqual([]);
      expect(s.run().status).toBe('failed');
    },
  );
  it('scheduled playback at day respects human Pause, while a human start can request Play', async () => {
    const s = await setup([
      definition([play], { schedule: { time: '12:01', weekdays: [1] } }),
    ]);
    await s.registry.invoke('music.pause', { target: 'music.room' }, user);
    s.music.dispatched.length = 0;
    await s.advance(60_000);
    expect(s.run().status).toBe('failed');
    expect(s.music.dispatched).toEqual([]);
    s.action('start');
    await flush();
    expect(s.music.dispatched.at(-1)?.requested).toEqual({
      property: 'playback',
      value: 'playing',
    });
    expect(s.run().status).toBe('completed');
  });
  it.each(['away', 'empty'] as const)(
    'scheduled run is cancelled when context becomes %s',
    async (context) => {
      const s = await setup([
        definition([delay(5_000), play], {
          schedule: { time: '12:01', weekdays: [1] },
        }),
      ]);
      await s.advance(60_000);
      expect(s.run().status).toBe('running');
      if (context === 'away') await s.engine.handleHomePresence('away');
      else
        await s.engine.handlePresence({
          type: 'presence.changed',
          presence: 'confirmed_empty',
        });
      s.music.dispatched.length = 0;
      await s.advance(10_000);
      expect(s.run().status).toBe('cancelled');
      expect(s.music.dispatched).toEqual([]);
    },
  );
  it('a human-started routine never takes manual volume authority', async () => {
    const s = await setup([
      definition([
        { type: 'volume', target: 'music.room', volume: 0.1, durationMs: 0 },
        play,
      ]),
    ]);
    await s.registry.invoke(
      'music.setVolume',
      { target: 'music.room', volume: 0.4 },
      user,
    );
    s.music.dispatched.length = 0;
    s.action('start');
    await flush();
    expect(s.run().status).toBe('failed');
    expect(s.music.dispatched).toEqual([]);
    expect(s.engine.getMusicPolicySnapshot('music.room').volume.mode).toBe(
      'manual',
    );
  });
  it('manual Pause or volume adjustment cancels a running music routine', async () => {
    const s = await setup([definition([delay(), play])]);
    s.action('start');
    await flush();
    await s.registry.invoke('music.pause', { target: 'music.room' }, user);
    s.music.dispatched.length = 0;
    await s.advance(10_000);
    expect(s.run().status).toBe('cancelled');
    expect(s.music.dispatched).toEqual([]);
  });
  it('an attributed external music change cancels delayed music work', async () => {
    const s = await setup([definition([delay(), play])]);
    s.action('start');
    await flush();
    s.clock.fake.advanceBy(1);
    s.music.observe('music.room', {
      playback: 'paused',
      volume: 0.6,
      source: 'Spotify',
      title: 'Test',
    });
    await flush();
    expect(s.run().status).toBe('cancelled');
  });
  it('cancels native volume fade work with the routine', async () => {
    const s = await setup([
      definition([
        {
          type: 'volume',
          target: 'music.room',
          volume: 0.1,
          durationMs: 5_000,
        },
        play,
      ]),
    ]);
    s.action('start');
    await flush();
    expect(s.engine.state.music.fades['music.room']?.status).toBe('active');
    await s.advance(1_000);
    s.action('cancel');
    const before = s.music.dispatched.length;
    await s.advance(30_000);
    expect(s.run().status).toBe('cancelled');
    expect(s.engine.state.music.fades['music.room']?.status).toBe('cancelled');
    expect(s.music.dispatched).toHaveLength(before);
  });
});

describe('publication and acquisition races', () => {
  it.each(['lighting', 'music'] as const)(
    'cancellation from engine %s publication blocks the transport',
    async (domain) => {
      const step: RoutineStep =
        domain === 'lighting'
          ? light()
          : { type: 'playback', target: 'music.room', state: 'playing' };
      const s = await setup([definition([step])]);
      const unsubscribe = s.engine.stream.subscribe((update) => {
        const issued =
          domain === 'lighting'
            ? update.patch.commands?.some((c) => c.source === 'routine.test')
            : update.patch.music?.commands.some(
                (c) => c.provenance.source === 'routine.test',
              );
        if (issued) s.action('cancel');
      });
      s.action('start');
      await flush();
      unsubscribe();
      expect(s.run().status).toBe('cancelled');
      expect(s.lighting.dispatched).toEqual([]);
      expect(s.music.dispatched).toEqual([]);
    },
  );
  it('cancellation inside fade startup publication leaves no native fade work', async () => {
    const s = await setup([
      definition([
        {
          type: 'volume',
          target: 'music.room',
          volume: 0.1,
          durationMs: 5_000,
        },
      ]),
    ]);
    const unsubscribe = s.engine.stream.subscribe((update) => {
      if (update.patch.music?.fades['music.room']?.status === 'active')
        s.action('cancel');
    });
    s.action('start');
    await flush();
    unsubscribe();
    expect(s.run().status).toBe('cancelled');
    expect(s.engine.state.music.fades['music.room']?.status).toBe('cancelled');
    const before = s.music.dispatched.length;
    await s.advance(30_000);
    expect(s.music.dispatched).toHaveLength(before);
  });
  it('cancellation between native fade acquisition and awaited response cancels that fade', async () => {
    const s = await setup([
      definition([
        {
          type: 'volume',
          target: 'music.room',
          volume: 0.1,
          durationMs: 5_000,
        },
      ]),
    ]);
    s.action('start');
    await Promise.resolve();
    await Promise.resolve();
    expect(s.engine.state.music.fades['music.room']?.status).toBe('active');
    s.action('cancel');
    await flush();
    expect(s.engine.state.music.fades['music.room']?.status).toBe('cancelled');
    await s.advance(30_000);
    expect(s.music.dispatched).toEqual([]);
  });
  it('an external source-only choice cancels pending routine playback', async () => {
    const s = await setup([
      definition([
        delay(),
        { type: 'playback', target: 'music.room', state: 'playing' },
      ]),
    ]);
    s.action('start');
    await flush();
    s.fake.advanceBy(1);
    s.music.observe('music.room', {
      playback: 'paused',
      volume: 0.2,
      source: 'Optical',
      title: 'Test',
    });
    await flush();
    expect(s.run().status).toBe('cancelled');
    await s.advance(10_000);
    expect(s.music.dispatched).toEqual([]);
  });
});

it('external control cancels fades even for an explicitly enforced lighting target', async () => {
  const s = await setup([definition([light(10, 10_000)])], undefined, {
    lightingControlModes: { 'lighting.desk': 'enforce' },
  });
  s.action('start');
  await s.advance(2_000);
  s.lighting.externalChange('lighting.desk', { brightness: 65 });
  await flush();
  expect(s.run().status).toBe('cancelled');
  const before = s.lighting.dispatched.length;
  await s.advance(60_000);
  expect(s.lighting.dispatched).toHaveLength(before);
});

it('composes source, preset and playback while attributing its own source feedback', async () => {
  const s = await setup([
    definition([
      { type: 'source', target: 'music.room', source: 'Optical' },
      { type: 'preset', target: 'music.room', preset: 'spotify_dj' },
      { type: 'playback', target: 'music.room', state: 'paused' },
    ]),
  ]);
  const original = s.music.dispatch.bind(s.music);
  vi.spyOn(s.music, 'dispatch').mockImplementation(async (command) => {
    await original(command);
    const observed = structuredClone(
      s.engine.getMusicState(command.target).observed,
    );
    if (command.requested.property === 'source')
      observed.source = command.requested.value;
    if (command.requested.property === 'preset') {
      observed.source = 'Spotify';
      observed.playback = 'playing';
    }
    if (command.requested.property === 'playback')
      observed.playback = command.requested.value;
    s.music.observe(command.target, observed, true, command.id);
  });
  s.action('start');
  await flush();
  expect(s.run()).toMatchObject({ status: 'completed', reason: null });
  expect(s.music.dispatched.map((c) => c.requested.property)).toEqual([
    'source',
    'preset',
    'playback',
  ]);
});

it('waits for a confirmed native music fade before continuing', async () => {
  const s = await setup([
    definition([
      { type: 'volume', target: 'music.room', volume: 0.1, durationMs: 5_000 },
      { type: 'playback', target: 'music.room', state: 'paused' },
    ]),
  ]);
  const original = s.music.dispatch.bind(s.music);
  vi.spyOn(s.music, 'dispatch').mockImplementation(async (command) => {
    await original(command);
    const observed = structuredClone(
      s.engine.getMusicState(command.target).observed,
    );
    if (command.requested.property === 'volume')
      observed.volume = command.requested.value;
    if (command.requested.property === 'playback')
      observed.playback = command.requested.value;
    s.music.observe(command.target, observed, true, command.id);
  });
  s.action('start');
  await flush();
  await s.advance(10_000);
  expect(s.engine.state.music.fades['music.room']?.status).toBe('completed');
  expect(s.run().status).toBe('completed');
  expect(s.music.dispatched.at(-1)?.requested).toEqual({
    property: 'playback',
    value: 'paused',
  });
  expect(s.engine.getMusicPolicySnapshot('music.room').volume.mode).toBe(
    'auto',
  );
});

it('reserves idempotency before publication so synchronous retries cannot reenter', async () => {
  const s = await setup([definition([light()])]);
  const unsubscribe = s.service.subscribe(() => {
    s.action('start', { requestId: 'publication-retry' });
  });
  s.action('start', { requestId: 'publication-retry' });
  await flush();
  unsubscribe();
  expect(s.service.snapshot().runs).toHaveLength(1);
  expect(s.lighting.dispatched).toHaveLength(1);
});

it('does not acquire human playback permission from scheduled preset feedback', async () => {
  const s = await setup([
    definition(
      [{ type: 'preset', target: 'music.room', preset: 'spotify_dj' }, delay()],
      { schedule: { time: '12:01', weekdays: [1] } },
    ),
  ]);
  const original = s.music.dispatch.bind(s.music);
  vi.spyOn(s.music, 'dispatch').mockImplementation(async (command) => {
    await original(command);
    if (command.requested.property === 'preset')
      s.music.observe(
        command.target,
        { playback: 'playing', source: 'Spotify', volume: 0.2, title: 'Test' },
        true,
        command.id,
      );
  });
  await s.advance(60_000);
  expect(s.run().status).toBe('running');
  expect(
    s.engine.getMusicIntentSnapshot().targets['music.room']?.lastIntentActor,
  ).not.toBe('manual');
  expect(
    s.engine.getMusicPolicySnapshot('music.room').playback.manualPause,
  ).toBeNull();
});

it('a light becoming unavailable during a fade stops further requested increments', async () => {
  const s = await setup([definition([light(10, 10_000)])]);
  s.action('start');
  await flush();
  await s.advance(1_000);
  s.engine.state.lighting.devices['lighting.desk']!.availability =
    'unavailable';
  await s.advance(2_000);
  expect(s.run().status).toBe('failed');
  expect(s.lighting.dispatched).toHaveLength(1);
});

it('the scheduler does not execute the repeated Stockholm fold occurrence twice', async () => {
  const s = await setup(
    [definition([delay(0)], { schedule: { time: '02:30', weekdays: [7] } })],
    '2026-10-25T02:29:59+02:00',
  );
  await s.advance(1_000);
  expect(s.service.snapshot().runs).toHaveLength(1);
  expect(s.run().status).toBe('completed');
  await s.advance(60 * 60_000, 60_000);
  expect(s.service.snapshot().runs).toHaveLength(1);
});

it('the scheduler skips the nonexistent Stockholm spring occurrence', async () => {
  const s = await setup(
    [definition([delay(0)], { schedule: { time: '02:30', weekdays: [7] } })],
    '2026-03-29T01:59:59+01:00',
  );
  await s.advance(60 * 60_000, 60_000);
  expect(s.service.snapshot().runs).toEqual([]);
  expect(s.service.snapshot().next[0]!.at).toBe(
    Date.parse('2026-04-05T02:30:00+02:00'),
  );
});

it('a denied routine fade preserves an existing human fade', async () => {
  const s = await setup([
    definition([
      { type: 'volume', target: 'music.room', volume: 0.1, durationMs: 5_000 },
    ]),
  ]);
  const human = await s.registry.invoke(
    'music.fadeVolume',
    { target: 'music.room', volume: 0.4, durationMs: 10_000 },
    user,
  );
  s.action('start');
  await flush();
  expect(s.run().status).toBe('failed');
  expect(s.engine.state.music.fades['music.room']).toMatchObject({
    id: human.fade.id,
    status: 'active',
  });
});

it('recent source selection cannot swallow a later physical Pause with the same source', async () => {
  const s = await setup([
    definition([
      { type: 'source', target: 'music.room', source: 'Spotify' },
      delay(),
    ]),
  ]);
  s.music.observe('music.room', {
    playback: 'playing',
    source: 'Spotify',
    volume: 0.2,
    title: 'Test',
  });
  const original = s.music.dispatch.bind(s.music);
  vi.spyOn(s.music, 'dispatch').mockImplementation(async (command) => {
    await original(command);
    s.music.observe(
      command.target,
      structuredClone(s.engine.getMusicState(command.target).observed),
    );
  });
  s.action('start');
  await flush();
  expect(s.run().status).toBe('running');
  s.fake.advanceBy(1);
  s.music.observe('music.room', {
    playback: 'paused',
    source: 'Spotify',
    volume: 0.2,
    title: 'Test',
  });
  expect(s.run().status).toBe('cancelled');
  expect(
    s.engine.getMusicPolicySnapshot('music.room').playback.manualPause,
  ).not.toBeNull();
});

it('recent preset selection cannot swallow an unrelated physical source choice', async () => {
  const s = await setup([
    definition([
      { type: 'preset', target: 'music.room', preset: 'spotify_dj' },
      delay(),
    ]),
  ]);
  s.music.observe('music.room', {
    playback: 'playing',
    source: 'Spotify',
    volume: 0.2,
    title: 'Test',
  });
  s.action('start');
  await flush();
  expect(s.run().status).toBe('running');
  s.fake.advanceBy(1);
  s.music.observe('music.room', {
    playback: 'playing',
    source: 'Optical',
    volume: 0.2,
    title: 'Test',
  });
  expect(s.run().status).toBe('cancelled');
});

it.each(['cancel', 'timeout'] as const)(
  'invalidates queued computer playback on routine %s before mocked send',
  async (outcome) => {
    let enabled = false;
    let invalidated = false;
    let release!: () => void;
    const sends: string[] = [];
    const computer = {
      handles: () => enabled,
      getPlayback: () => 'paused' as const,
      canResume: () => false,
      observe: () => undefined,
      dispose: () => undefined,
      invalidate: vi.fn(() => {
        invalidated = true;
      }),
      request: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        if (invalidated) throw new Error('Computer work invalidated');
        sends.push('play');
        return {
          id: 'mock-computer-play',
          target: 'music.room',
          requested: {
            property: 'playback' as const,
            value: 'playing' as const,
          },
          issuedAt: 0,
          status: 'confirmed' as const,
          provenance: user,
        };
      }),
    };
    const s = await setup(
      [
        definition([
          { type: 'playback', target: 'music.room', state: 'playing' },
        ]),
      ],
      undefined,
      { computerPlayback: computer },
    );
    enabled = true;
    invalidated = false;
    computer.invalidate.mockClear();
    s.action('start');
    await flush();
    expect(computer.request).toHaveBeenCalledOnce();
    if (outcome === 'cancel') s.action('cancel');
    else await s.advance(15_000);
    expect(computer.invalidate).toHaveBeenCalledWith('music.room');
    release();
    await flush();
    expect(sends).toEqual([]);
    expect(s.run().status).toBe(outcome === 'cancel' ? 'cancelled' : 'failed');
  },
);

it('cancelling an acquiring routine fade preserves a newer human replacement fade', async () => {
  const s = await setup([
    definition([
      { type: 'volume', target: 'music.room', volume: 0.1, durationMs: 5_000 },
    ]),
  ]);
  let replaced = false;
  let replacementId = '';
  let replacement: Promise<void> | undefined;
  const unsubscribe = s.engine.stream.subscribe((update) => {
    if (
      replaced ||
      update.patch.music?.fades['music.room']?.status !== 'active'
    )
      return;
    replaced = true;
    replacement = s.registry
      .invoke(
        'music.fadeVolume',
        { target: 'music.room', volume: 0.4, durationMs: 10_000 },
        user,
      )
      .then((result) => {
        replacementId = result.fade.id;
      });
  });
  s.action('start');
  await flush();
  unsubscribe();
  await replacement;
  expect(s.run().status).toBe('cancelled');
  expect(s.engine.state.music.fades['music.room']).toMatchObject({
    id: replacementId,
    status: 'active',
  });
});

it('a human scene selected during property publication blocks the original routine values', async () => {
  const s = await setup([definition([light(10)])]);
  let newer: Promise<unknown> | undefined;
  let started = false;
  const unsubscribe = s.engine.stream.subscribe((update) => {
    if (
      started ||
      !update.patch.diagnostics?.some((d) => d.kind === 'lighting.set')
    )
      return;
    started = true;
    newer = s.registry.invoke(
      'lighting.activateScene',
      { sceneId: 'scene.soft' },
      user,
    );
  });
  s.action('start');
  await flush();
  unsubscribe();
  await newer;
  expect(s.run().status).toBe('cancelled');
  expect(
    s.lighting.dispatched.map((command) => command.values.brightness),
  ).not.toContain(10);
  expect(
    s.engine.state.lighting.devices['lighting.desk']?.observed.brightness,
  ).toBe(15);
  await s.advance(10_000);
  expect(
    s.lighting.dispatched.map((command) => command.values.brightness),
  ).not.toContain(10);
});

it('editing a referenced scene cannot add targets outside the captured routine scope', async () => {
  const s = await setup([
    definition([delay(), { type: 'scene', sceneId: 'scene.soft' }]),
  ]);
  s.action('start');
  await flush();
  s.engine.saveSceneDefinition({
    id: 'scene.soft',
    name: 'Soft',
    lighting: {
      'lighting.desk': { power: true, brightness: 15 },
      'lighting.other': { power: true, brightness: 80 },
    },
  });
  await s.registry.invoke(
    'lighting.set',
    { target: 'lighting.other', values: { brightness: 5 } },
    user,
  );
  s.lighting.dispatched.length = 0;
  await s.advance(5_000);
  expect(s.run().status).toBe('cancelled');
  expect(s.lighting.dispatched).toEqual([]);
  expect(
    s.engine.state.lighting.devices['lighting.other']?.observed.brightness,
  ).toBe(5);
});

it.each(['scene', 'command', 'retry'] as const)(
  'a replacement human scene invalidates the original scene scope during %s publication',
  async (stage) => {
    const s = await setup([
      definition([{ type: 'scene', sceneId: 'scene.soft' }, delay(10_000)]),
    ]);
    s.engine.saveSceneDefinition({
      id: 'scene.soft',
      name: 'Soft',
      lighting: {
        'lighting.desk': { power: true, brightness: 15 },
        'lighting.other': { power: true, brightness: 80 },
      },
    });
    s.engine.saveSceneDefinition({
      id: 'scene.manual',
      name: 'Manual',
      lighting: {
        'lighting.desk': { power: true, brightness: 25 },
        'lighting.other': { power: true, brightness: 5 },
      },
    });
    if (stage === 'retry') s.lighting.ignoreNextForTargets.add('lighting.desk');
    let newer: Promise<unknown> | undefined;
    let replaced = false;
    const unsubscribe = s.engine.stream.subscribe((update) => {
      if (replaced) return;
      const commands =
        update.patch.commands?.filter(
          (command) =>
            command.source === 'routine.test' &&
            command.target === 'lighting.desk',
        ) ?? [];
      const ready =
        stage === 'scene'
          ? update.patch.diagnostics?.some(
              (d) =>
                d.kind === 'scene.selected' &&
                d.details['scene'] === 'scene.soft',
            )
          : commands.length >= (stage === 'retry' ? 2 : 1);
      if (!ready) return;
      replaced = true;
      newer = s.registry.invoke(
        'lighting.activateScene',
        { sceneId: 'scene.manual' },
        user,
      );
    });
    s.action('start');
    await flush();
    if (stage === 'retry') await s.advance(2_000);
    unsubscribe();
    await newer;
    expect(replaced).toBe(true);
    expect(s.run().status).toBe('cancelled');
    const routineCommands = () =>
      s.lighting.dispatched.filter(
        (command) =>
          s.engine.ledger.records.find((record) => record.id === command.id)
            ?.source === 'routine.test',
      );
    // Only transports already sent before the retry publication may remain.
    expect(routineCommands()).toHaveLength(stage === 'retry' ? 2 : 0);
    expect(s.engine.state.lighting.currentScene).toBe('scene.manual');
    expect(
      s.engine.state.lighting.devices['lighting.desk']?.observed.brightness,
    ).toBe(25);
    expect(
      s.engine.state.lighting.devices['lighting.other']?.observed.brightness,
    ).toBe(5);
    const count = s.lighting.dispatched.length;
    await s.advance(15_000);
    expect(s.lighting.dispatched).toHaveLength(count);
  },
);

it.each(['edit', 'delete', 'restore'] as const)(
  'referenced scene %s immediately invalidates delayed work',
  async (change) => {
    const s = await setup([
      definition([delay(), { type: 'scene', sceneId: 'scene.soft' }]),
    ]);
    const original = structuredClone(s.engine.scenes.get('scene.soft')!);
    s.action('start');
    await flush();
    if (change === 'delete') s.engine.deleteSceneDefinition('scene.soft');
    else
      s.engine.saveSceneDefinition({
        ...original,
        lighting: { 'lighting.desk': { power: true, brightness: 80 } },
      });
    expect(s.run()).toMatchObject({
      status: 'cancelled',
      reason: 'Referenced scene changed or deleted',
    });
    if (change === 'restore') s.engine.saveSceneDefinition(original);
    await s.advance(10_000);
    expect(s.lighting.dispatched).toEqual([]);
  },
);

it('editing a referenced scene cannot introduce an overlap with an independent run', async () => {
  const s = await setup([
    definition([delay(), { type: 'scene', sceneId: 'scene.soft' }]),
    definition(
      [
        {
          type: 'light',
          targets: ['lighting.other'],
          brightness: 5,
          durationMs: 10_000,
        },
      ],
      { id: 'other' },
    ),
  ]);
  s.action('start');
  s.service.action({ id: 'other', action: 'start' }, user);
  await flush();
  s.engine.saveSceneDefinition({
    id: 'scene.soft',
    name: 'Soft',
    lighting: {
      'lighting.desk': { power: true, brightness: 15 },
      'lighting.other': { power: true, brightness: 80 },
    },
  });
  expect(s.service.snapshot().runs.map((run) => run.status)).toEqual([
    'cancelled',
    'running',
  ]);
  await s.advance(10_000);
  expect(s.service.snapshot().runs.map((run) => run.status)).toEqual([
    'cancelled',
    'completed',
  ]);
  expect(
    s.lighting.dispatched.some((command) => command.values.brightness === 80),
  ).toBe(false);
  expect(
    s.engine.state.lighting.devices['lighting.other']?.observed.brightness,
  ).toBe(5);
});

it('unrelated scene edits preserve captured scene execution', async () => {
  const s = await setup([
    definition([delay(), { type: 'scene', sceneId: 'scene.soft' }]),
  ]);
  s.action('start');
  await flush();
  s.engine.saveSceneDefinition({
    id: 'scene.unrelated',
    name: 'Other',
    lighting: { 'lighting.other': { power: true, brightness: 80 } },
  });
  expect(s.run().status).toBe('running');
  await s.advance(5_000);
  expect(s.run().status).toBe('completed');
  expect(s.lighting.dispatched.map((command) => command.target)).toEqual([
    'lighting.desk',
  ]);
});

it('scene edits during scene activation publication invalidate the pending transport', async () => {
  const s = await setup([
    definition([{ type: 'scene', sceneId: 'scene.soft' }]),
  ]);
  let edited = false;
  const unsubscribe = s.engine.stream.subscribe((update) => {
    if (
      edited ||
      !update.patch.diagnostics?.some((d) => d.kind === 'scene.selected')
    )
      return;
    edited = true;
    s.engine.saveSceneDefinition({
      id: 'scene.soft',
      name: 'Changed',
      lighting: { 'lighting.other': { power: true, brightness: 80 } },
    });
  });
  s.action('start');
  await flush();
  unsubscribe();
  expect(s.run().status).toBe('cancelled');
  expect(s.lighting.dispatched).toEqual([]);
});

it.each(['lighting.adjust', 'lighting.reapplyScene'] as const)(
  '%s keeps the invocation guard through its underlying lighting operation',
  async (name) => {
    const s = await setup();
    await s.registry.invoke(
      'lighting.activateScene',
      { sceneId: 'scene.soft' },
      user,
    );
    s.lighting.dispatched.length = 0;
    let current = true;
    const unsubscribe = s.engine.stream.subscribe(() => {
      current = false;
    });
    const result = s.registry.invoke(
      name,
      name === 'lighting.adjust'
        ? { target: 'lighting.desk', brightnessDelta: -5 }
        : {},
      user,
      () => current,
    );
    if (name === 'lighting.reapplyScene')
      await expect(result).rejects.toThrow('Capability execution cancelled');
    else await result;
    unsubscribe();
    expect(s.lighting.dispatched).toEqual([]);
    await s.advance(10_000);
    expect(s.lighting.dispatched).toEqual([]);
  },
);
