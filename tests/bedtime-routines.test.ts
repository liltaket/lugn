import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoutineService } from '../src/application/routines.js';
import { RoutineApi } from '../src/runtime/routine-api.js';
import { RoutineStore } from '../src/runtime/routine-store.js';
import {
  LugnEngine,
  type EngineOptions,
} from '../src/application/lugn-engine.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import { FakeClock } from '../src/core/clock.js';
import { defaultMusicVolumeSettings } from '../src/core/music-volume-settings.js';
import {
  createRoutineTemplates,
  tomorrowStockholm,
  type RoutineSnapshot,
} from '../src/core/routines.js';

const human = {
  actor: { type: 'user' as const, id: 'hub' },
  source: 'display',
};
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function flush() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
async function fixture(
  start = '2026-10-19T23:59:00+02:00',
  options: EngineOptions = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'bedtime-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'routines.json');
  const fake = new FakeClock(Date.parse(start));
  let wallOffset = 0;
  const clock = {
    now: () => fake.now() + wallOffset,
    monotonicNow: () => fake.monotonicNow(),
    setTimeout: fake.setTimeout.bind(fake),
    clearTimeout: fake.clearTimeout.bind(fake),
  };
  const lighting = new SimulatedLightingAdapter(clock);
  const music = new SimulatedMusicAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: [
      'lighting.accent',
      'lighting.second',
      'lighting.strip1',
      'lighting.ceiling',
    ],
    adapter: lighting,
    scenes: [
      {
        id: 'scene.soft_light',
        name: 'Soft',
        lighting: {
          'lighting.accent': { power: true, brightness: 20 },
          'lighting.second': { power: true, brightness: 20 },
          'lighting.strip1': { power: true, brightness: 20 },
          'lighting.ceiling': { power: false },
        },
      },
      {
        id: 'scene.all_off',
        name: 'Off',
        lighting: {
          'lighting.accent': { power: false },
          'lighting.second': { power: false },
        },
      },
    ],
    music: {
      adapter: music,
      targets: { 'music.room': ['Spotify', 'Optical'] },
    },
    musicVolumeSettings: { ...defaultMusicVolumeSettings, enabled: false },
    ...options,
  });
  await engine.handlePresence({
    type: 'presence.changed',
    presence: 'occupied',
    personCount: 1,
  });
  await engine.handleHomePresence('home');
  lighting.externalChange('lighting.accent', {
    power: false,
    brightness: 80,
    rgb: [255, 0, 30],
  });
  lighting.externalChange('lighting.second', { power: true, brightness: 20 });
  engine.state.lighting.devices['lighting.second']!.availability = 'degraded';
  engine.state.lighting.devices['lighting.strip1']!.availability = 'degraded';
  engine.state.lighting.devices['lighting.ceiling']!.availability = 'available';
  music.observe('music.room', {
    playback: 'paused',
    volume: 0.27,
    source: 'Spotify',
    title: 'Existing song',
  });
  await flush();
  const capabilities = new CapabilityRegistry(engine);
  const bedtime = {
    lightTargets: Object.entries(
      engine.scenes.get('scene.soft_light')!.lighting,
    )
      .filter(([, v]) => v.power !== false)
      .map(([id]) => id),
    musicTarget: 'music.room',
  };
  let store = new RoutineStore(
    path,
    createRoutineTemplates({
      lightTargets: Object.keys(engine.state.lighting.devices),
      musicTarget: 'music.room',
    }),
  );
  await store.load();
  let service = new RoutineService(clock, {
    engine,
    capabilities,
    store,
    bedtime,
  });
  let api = new RoutineApi(service, store);
  cleanups.push(() => {
    service.dispose();
    engine.dispose();
  });
  let serial = 0;
  const request = (body: object) =>
    api.request(
      'routines/bedtime',
      {
        expectedGeneration: store.snapshot().generation,
        requestId: `request-${++serial}`,
        ...body,
      },
      human,
    ) as Promise<RoutineSnapshot>;
  const advance = async (ms: number, quantum = 1_000) => {
    for (let elapsed = 0; elapsed < ms; elapsed += quantum) {
      fake.advanceBy(Math.min(quantum, ms - elapsed));
      await store.whenIdle();
      await flush();
    }
  };
  const restart = async () => {
    service.dispose();
    store = new RoutineStore(path);
    await store.load();
    service = new RoutineService(clock, {
      engine,
      capabilities,
      store,
      bedtime,
    });
    api = new RoutineApi(service, store);
  };
  lighting.dispatched.length = 0;
  music.dispatched.length = 0;
  const jump = (ms: number) => {
    wallOffset += ms;
    fake.advanceBy(1_000);
  };
  return {
    directory,
    path,
    clock,
    engine,
    lighting,
    music,
    capabilities,
    request,
    advance,
    restart,
    jump,
    rawAdvance: (ms: number) => fake.advanceBy(ms),
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    get api() {
      return api;
    },
  };
}
const plan = { action: 'plan', wakeTime: '00:00', mode: 'auto' };

describe('bedtime atomic API and ownership', () => {
  it('projects usable IDs before setup and preserves disabled templates and custom definitions', async () => {
    const f = await fixture();
    expect(f.service.snapshot().bedtime).toMatchObject({
      nightRoutineId: 'bedtime-night',
      morningRoutineId: 'bedtime-morning',
      nightAvailable: true,
      morningAvailable: true,
      plan: null,
      skippedTargets: ['lighting.strip1'],
    });
    const custom = {
      id: 'custom',
      name: 'Mine',
      kind: 'custom',
      enabled: false,
      schedule: null,
      steps: [{ type: 'delay', durationMs: 0 }],
    };
    await f.store.save(custom, f.store.snapshot().generation);
    const before = f.store.snapshot().definitions;
    const result = await f.request({ ...plan, action: 'start' });
    expect(result.definitions).toEqual(expect.arrayContaining(before));
    const night = result.definitions.find(
      (d) => d.id === result.bedtime!.nightRoutineId,
    )!;
    expect(night.steps).toEqual([
      {
        type: 'light',
        targets: ['lighting.accent', 'lighting.second'],
        brightness: 0,
        durationMs: 900_000,
        colorTemperature: 3000,
      },
    ]);
    expect(result.bedtime!.plan).toMatchObject({ mode: 'auto', music: false });
    const disk = JSON.parse(await readFile(f.path, 'utf8'));
    expect(disk.definitions).toContainEqual(night);
    expect(f.lighting.dispatched).toEqual([]); // first fade increment is delayed
    expect(f.music.dispatched).toEqual([]);
    await expect(
      f.api.request(
        'routines/save',
        { definition: night, expectedGeneration: result.generation },
        human,
      ),
    ).rejects.toMatchObject({ code: 'bedtime_definition_owned' });
  });
  it('deduplicates concurrent and retried starts, including after restart', async () => {
    const f = await fixture();
    const body = {
      ...plan,
      action: 'start',
      expectedGeneration: f.store.snapshot().generation,
      requestId: 'one-confirmation',
    };
    const [a, b] = await Promise.all([
      f.api.request('routines/bedtime', body, human),
      f.api.request('routines/bedtime', body, human),
    ]);
    expect(a).toEqual(b);
    expect(f.service.snapshot().runs).toHaveLength(1);
    await f.api.request('routines/bedtime', body, human);
    expect(f.service.snapshot().runs).toHaveLength(1);
    await expect(
      f.api.request('routines/bedtime', { ...body, music: true }, human),
    ).rejects.toMatchObject({ code: 'routine_request_reused' });
    await f.restart();
    await f.api.request('routines/bedtime', body, human);
    expect(f.service.snapshot().runs).toEqual([]);
  });
  it('rejects uncommitted pre-restart requests rather than replaying them in a new process', async () => {
    const f = await fixture();
    await f.request(plan);
    const input = {
      ...plan,
      action: 'start',
      expectedGeneration: f.store.snapshot().generation,
      requestId: 'never-committed',
    };
    await f.restart();
    await expect(
      f.api.request('routines/bedtime', input, human),
    ).rejects.toMatchObject({ code: 'routines_changed' });
    expect(f.service.snapshot().runs).toEqual([]);
  });
  it('rejects stale generations, nonhumans and strict-union extras before effects', async () => {
    const f = await fixture();
    const before = f.store.snapshot();
    await expect(
      f.request({
        ...plan,
        expectedGeneration: '11111111-1111-4111-8111-111111111111',
      }),
    ).rejects.toMatchObject({ code: 'routines_changed' });
    await expect(
      f.api.request(
        'routines/bedtime',
        { ...plan, expectedGeneration: before.generation, requestId: 'robot' },
        { actor: { type: 'routine', id: 'robot' } },
      ),
    ).rejects.toMatchObject({ code: 'human_actor_required' });
    await expect(
      f.request({ action: 'clear', wakeTime: '07:00' }),
    ).rejects.toThrow();
    expect(f.store.snapshot()).toEqual(before);
    expect(f.lighting.dispatched).toEqual([]);
  });
  it('does not save an orphan plan when start validation or persistence fails', async () => {
    const f = await fixture();
    const before = f.store.snapshot();
    const validate = vi
      .spyOn(f.service, 'validateStart')
      .mockImplementation(() => {
        throw new Error('cannot start');
      });
    await expect(f.request({ ...plan, action: 'start' })).rejects.toThrow(
      'cannot start',
    );
    expect(f.store.snapshot()).toEqual(before);
    validate.mockRestore();
    const update = vi
      .spyOn(f.store, 'update')
      .mockRejectedValue(new Error('disk full'));
    await expect(f.request({ ...plan, action: 'start' })).rejects.toThrow(
      'disk full',
    );
    update.mockRestore();
    expect(f.store.snapshot()).toEqual(before);
    expect(f.service.snapshot().runs).toEqual([]);
    expect(f.lighting.dispatched).toEqual([]);
  });
  it('revalidates start immediately before replacing the durable document', async () => {
    const f = await fixture();
    const before = f.store.snapshot();
    let validations = 0;
    vi.spyOn(f.service, 'validateStart').mockImplementation(() => {
      if (++validations >= 3)
        throw new (class extends Error {})('became unavailable');
    });
    await expect(f.request({ ...plan, action: 'start' })).rejects.toMatchObject(
      { code: 'routine_save_failed' },
    );
    expect(f.store.snapshot()).toEqual(before);
    expect(f.service.snapshot().runs).toEqual([]);
  });
  it('refuses an unavailable-only start and never commandeers the ceiling', async () => {
    const f = await fixture();
    f.engine.state.lighting.devices['lighting.accent']!.availability =
      'unavailable';
    f.engine.state.lighting.devices['lighting.second']!.availability =
      'unavailable';
    expect(f.service.snapshot().bedtime!.nightAvailable).toBe(false);
    await expect(f.request({ ...plan, action: 'start' })).rejects.toMatchObject(
      { code: 'bedtime_lights_unavailable' },
    );
    expect(f.store.snapshot().definitions).toHaveLength(2);
    expect(f.lighting.dispatched).toEqual([]);
  });
  it('none and clear remove the one-off plan without activating legacy definitions', async () => {
    const f = await fixture();
    await f.request(plan);
    const none = await f.request({ ...plan, mode: 'none' });
    expect(none.bedtime!.plan).toBeNull();
    expect(none.next).toEqual([]);
    await f.request(plan);
    const cleared = await f.request({ action: 'clear' });
    expect(cleared.bedtime!.plan).toBeNull();
    expect(cleared.next).toEqual([]);
    expect(
      cleared.definitions.filter((d) => !d.bedtime).every((d) => !d.enabled),
    ).toBe(true);
    await f.advance(70_000);
    expect(f.service.snapshot().runs).toEqual([]);
  });
});

describe('one-off lifecycle and light fades', () => {
  it('honors the confirmed 09:30 morning after Släck at 00:57, with routine provenance and target-only intent', async () => {
    const f = await fixture('2026-10-20T00:50:00+02:00');
    await f.request({ action: 'start', wakeTime: '09:30', mode: 'auto' });
    await flush();
    await f.advance(7 * 60_000);
    f.engine.saveSceneDefinition({
      ...f.engine.scenes.get('scene.all_off')!,
      lighting: {
        ...f.engine.scenes.get('scene.all_off')!.lighting,
        'lighting.ceiling': { power: false },
      },
    });
    await f.capabilities.invoke(
      'lighting.activateScene',
      { sceneId: 'scene.all_off' },
      human,
    );
    expect(
      f.engine.state.intent.holds.filter(
        (h) => h.scope === 'lighting.activation',
      ),
    ).toHaveLength(3);
    const invoke = vi.spyOn(f.capabilities, 'invoke');
    f.lighting.dispatched.length = 0;
    await f.advance((8 * 60 + 33) * 60_000, 60_000);
    await f.advance(30_000);
    expect(f.lighting.dispatched.map((c) => [c.target, c.values])).toEqual([
      [
        'lighting.accent',
        { power: true, brightness: 1, colorTemperature: 3000 },
      ],
      [
        'lighting.second',
        { power: true, brightness: 1, colorTemperature: 3000 },
      ],
    ]);
    expect(
      invoke.mock.calls
        .filter(([name]) => name === 'lighting.set')
        .every(
          ([, input, provenance]) =>
            (input as { temperatureScope: string }).temperatureScope ===
              'target' && provenance?.actor.type === 'routine',
        ),
    ).toBe(true);
    await f.engine.reconcileScene();
    await f.advance(1_170_000);
    expect(f.service.snapshot().runs.at(-1)).toMatchObject({
      status: 'completed',
    });
    expect(
      f.engine.state.lighting.devices['lighting.accent']!.observed,
    ).toMatchObject({ power: true, brightness: 40, colorTemperature: 3000 });
    expect(
      f.lighting.dispatched.every(
        (c) =>
          c.values.power === true &&
          ['lighting.accent', 'lighting.second'].includes(c.target),
      ),
    ).toBe(true);
    expect(
      f.engine.state.intent.holds
        .filter((h) => h.scope === 'lighting.activation')
        .map((h) => h.target),
    ).toEqual(['lighting.ceiling']);
    await expect(
      f.capabilities.invoke(
        'lighting.set',
        { target: 'lighting.ceiling', values: { power: true } },
        { actor: { type: 'routine', id: 'other' } },
      ),
    ).rejects.toThrow('held by explicit human off intent');
    expect(f.music.dispatched).toEqual([]);
  });
  it.each(['cancel', 'skip', 'off'] as const)(
    '%s wins during an authorized morning fade',
    async (action) => {
      const f = await fixture();
      await f.request(plan);
      await f.capabilities.invoke(
        'lighting.activateScene',
        { sceneId: 'scene.all_off' },
        human,
      );
      f.lighting.dispatched.length = 0;
      await f.advance(90_000);
      expect(f.lighting.dispatched.length).toBeGreaterThan(0);
      if (action === 'off')
        await f.capabilities.invoke(
          'lighting.activateScene',
          { sceneId: 'scene.all_off' },
          human,
        );
      else f.service.action({ id: 'bedtime-morning', action }, human);
      const count = f.lighting.dispatched.length;
      await f.advance(90_000);
      await f.engine.reconcileScene();
      expect(f.lighting.dispatched).toHaveLength(count);
      expect(f.service.snapshot().runs.at(-1)).toMatchObject({
        status: 'cancelled',
      });
      if (action === 'off') {
        expect(
          f.engine.state.lighting.devices['lighting.accent']!.observed.power,
        ).toBe(false);
        expect(
          f.engine.state.intent.holds.filter(
            (h) => h.scope === 'lighting.activation',
          ),
        ).toHaveLength(2);
      }
    },
  );
  it('a snoozed consumed morning retains only its selected light authority', async () => {
    const f = await fixture();
    await f.request(plan);
    await f.capabilities.invoke(
      'lighting.activateScene',
      { sceneId: 'scene.all_off' },
      human,
    );
    await f.advance(60_000);
    f.service.action(
      { id: 'bedtime-morning', action: 'snooze', minutes: 1 },
      human,
    );
    expect(f.lighting.dispatched.every((c) => c.values.power === false)).toBe(
      true,
    );
    f.lighting.dispatched.length = 0;
    await f.advance(90_000);
    expect(f.lighting.dispatched.map((c) => c.target)).toEqual([
      'lighting.accent',
      'lighting.second',
    ]);
    expect(f.service.snapshot().runs.map((r) => r.status)).toEqual([
      'cancelled',
      'running',
    ]);
  });
  it('Släck while the engine yields before replacing a held target invalidates the morning grant', async () => {
    const f = await fixture();
    await f.request(plan);
    await f.capabilities.invoke(
      'lighting.activateScene',
      { sceneId: 'scene.all_off' },
      human,
    );
    f.lighting.dispatched.length = 0;
    const setLighting = f.engine.setLighting.bind(f.engine);
    let manualOff: Promise<unknown> | undefined;
    vi.spyOn(f.engine, 'setLighting').mockImplementationOnce((...args) => {
      const pending = setLighting(...args);
      manualOff = f.capabilities.invoke(
        'lighting.activateScene',
        { sceneId: 'scene.all_off' },
        human,
      );
      return pending;
    });
    await f.advance(90_000);
    expect(manualOff).toBeDefined();
    await manualOff;
    await f.advance(60_000);
    expect(f.lighting.dispatched.every((c) => c.values.power === false)).toBe(
      true,
    );
    expect(f.service.snapshot().runs.at(-1)).toMatchObject({
      status: 'cancelled',
    });
    expect(
      f.engine.state.intent.holds.filter(
        (h) => h.scope === 'lighting.activation',
      ),
    ).toHaveLength(2);
  });
  it.each(['away', 'empty'] as const)(
    'an authorized morning still yields to %s before its first increment',
    async (context) => {
      const f = await fixture();
      await f.request(plan);
      await f.capabilities.invoke(
        'lighting.activateScene',
        { sceneId: 'scene.all_off' },
        human,
      );
      await f.advance(60_000);
      expect(f.service.snapshot().runs.at(-1)).toMatchObject({
        status: 'running',
      });
      if (context === 'away') await f.engine.handleHomePresence('away');
      else
        await f.engine.handlePresence({
          type: 'presence.changed',
          presence: 'confirmed_empty',
        });
      f.lighting.dispatched.length = 0;
      await f.advance(60_000);
      expect(f.lighting.dispatched).toEqual([]);
      expect(f.service.snapshot().runs.at(-1)).toMatchObject({
        status: 'cancelled',
      });
      expect(
        f.engine.state.intent.holds.filter(
          (h) => h.scope === 'lighting.activation',
        ),
      ).toHaveLength(2);
    },
  );
  it('automatic morning light authority gives no authority over explicit Pause or quiet hours', async () => {
    const f = await fixture();
    await f.capabilities.invoke('music.pause', { target: 'music.room' }, human);
    await f.request({ ...plan, music: true });
    await f.capabilities.invoke(
      'lighting.activateScene',
      { sceneId: 'scene.all_off' },
      human,
    );
    const settings = f.engine.getMusicVolumeSettings();
    f.lighting.dispatched.length = 0;
    f.music.dispatched.length = 0;
    await f.advance(90_000);
    expect(f.lighting.dispatched.length).toBeGreaterThan(0);
    expect(f.music.dispatched).toEqual([]);
    expect(f.engine.getMusicVolumeSettings()).toEqual(settings);
    expect(f.engine.automaticMusicPlaybackAllowed('music.room')).toBe(false);
    expect(f.engine.state.intent.holds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'music.playback',
          target: 'music.room',
        }),
      ]),
    );
    expect(f.service.snapshot().runs.at(-1)).toMatchObject({
      status: 'running',
      warnings: [expect.stringContaining('blocked')],
    });
  });
  it.each([
    'custom',
    'unowned-morning',
    'wrong-owned-id',
    'owned-night',
  ] as const)(
    '%s scheduled lighting cannot supersede human OFF holds',
    async (variant) => {
      const f = await fixture();
      await f.store.save(
        {
          id: variant === 'unowned-morning' ? 'bedtime-morning' : variant,
          name: 'Scheduled lighting',
          kind: variant === 'custom' ? 'custom' : 'good_morning',
          enabled: true,
          schedule: { time: '00:00', weekdays: [1, 2, 3, 4, 5, 6, 7] },
          ...(['wrong-owned-id', 'owned-night'].includes(variant)
            ? {
                bedtime: {
                  owner: 'bedtime',
                  role: variant === 'owned-night' ? 'night' : 'morning',
                  plan: {
                    at: f.clock.now() + 60_000,
                    time: '00:00',
                    mode: 'auto',
                    music: false,
                  },
                },
              }
            : {}),
          steps: [
            {
              type: 'light',
              targets: ['lighting.accent'],
              brightness: 40,
              durationMs: 0,
              colorTemperature: 3000,
            },
          ],
        },
        f.store.snapshot().generation,
      );
      await f.capabilities.invoke(
        'lighting.activateScene',
        { sceneId: 'scene.all_off' },
        human,
      );
      f.lighting.dispatched.length = 0;
      await f.advance(60_000);
      expect(f.lighting.dispatched).toEqual([]);
      expect(f.service.snapshot().runs.at(-1)).toMatchObject({
        status: 'failed',
        reason: expect.stringContaining(
          'Automatic lighting is held by explicit human off intent',
        ),
      });
      expect(
        f.engine.state.intent.holds.filter(
          (h) => h.scope === 'lighting.activation',
        ),
      ).toHaveLength(2);
      if (variant === 'wrong-owned-id')
        expect(f.service.snapshot().runs.at(-1)!.warnings).toEqual([
          expect.stringContaining(
            'lighting.accent: Automatic lighting is held',
          ),
        ]);
    },
  );
  it('future confirmed morning survives restart over OFF holds, consumed morning never replays', async () => {
    const f = await fixture();
    const body = {
      ...plan,
      expectedGeneration: f.store.snapshot().generation,
      requestId: 'one-morning',
    };
    await f.request(body);
    await f.capabilities.invoke(
      'lighting.activateScene',
      { sceneId: 'scene.all_off' },
      human,
    );
    await f.restart();
    f.lighting.dispatched.length = 0;
    await f.advance(90_000);
    expect(f.lighting.dispatched.length).toBeGreaterThan(0);
    const count = f.lighting.dispatched.length;
    await f.request(body);
    expect(f.service.snapshot().runs).toHaveLength(1);
    f.jump(-60_000);
    await f.restart();
    await f.advance(120_000);
    expect(f.service.snapshot().runs).toEqual([]);
    expect(f.service.snapshot().next).toEqual([]);
    expect(f.lighting.dispatched).toHaveLength(count);
  });
  it('restores only future plans and auto executes exactly once without catchup or next-day repetition', async () => {
    const f = await fixture();
    await f.request(plan);
    await f.restart();
    expect(f.service.snapshot().next).toHaveLength(1);
    await f.advance(60_000);
    expect(f.service.snapshot().runs).toHaveLength(1);
    expect(f.service.snapshot().next).toEqual([]);
    expect(f.service.snapshot().bedtime!.plan).toBeNull();
    await f.advance(30_000);
    expect(
      f.lighting.dispatched.filter((c) => c.target === 'lighting.accent')[0]!
        .values,
    ).toEqual({ power: true, brightness: 1, colorTemperature: 3000 });
    expect(
      f.lighting.dispatched.some(
        (c) =>
          c.target === 'lighting.ceiling' || c.target === 'lighting.strip1',
      ),
    ).toBe(false);
    await f.restart();
    await f.advance(90_000);
    expect(f.service.snapshot().runs).toEqual([]);
    expect(f.service.snapshot().next).toEqual([]);
    f.jump(24 * 60 * 60_000);
    await flush();
    expect(f.service.snapshot().runs).toEqual([]);
  });
  it('button mode presents one hour, never commands, and never reappears on expiry or restart', async () => {
    const f = await fixture();
    await f.request({ ...plan, mode: 'button', music: true });
    await f.advance(60_000);
    expect(f.service.snapshot().bedtime!.ready).toEqual({
      until: f.clock.now() + 3_600_000,
      music: true,
    });
    expect(f.service.snapshot().runs).toEqual([]);
    expect(f.music.dispatched).toEqual([]);
    expect(f.lighting.dispatched).toEqual([]);
    await f.restart();
    expect(f.service.snapshot().bedtime!.ready).toBeNull();
    await f.advance(3_601_000);
    expect(f.service.snapshot().bedtime!.ready).toBeNull();
    expect(f.service.snapshot().runs).toEqual([]);
  });
  it('does not catch up a button window after a clock jump across its chosen time', async () => {
    const f = await fixture();
    await f.request({ ...plan, mode: 'button' });
    f.jump(120_000);
    await flush();
    expect(f.service.snapshot().bedtime!.ready).toBeNull();
    expect(f.service.snapshot().next).toEqual([]);
    expect(f.lighting.dispatched).toEqual([]);
  });
  it('reports an unavailable scheduled start as failed without queueing or retrying it', async () => {
    const f = await fixture();
    await f.request(plan);
    f.engine.state.lighting.devices['lighting.accent']!.availability =
      'unavailable';
    f.engine.state.lighting.devices['lighting.second']!.availability =
      'unavailable';
    await f.advance(60_000);
    expect(f.service.snapshot().runs).toEqual([
      expect.objectContaining({
        status: 'failed',
        reason: 'bedtime_lights_unavailable',
      }),
    ]);
    expect(f.service.snapshot().next).toEqual([]);
    expect(f.lighting.dispatched).toEqual([]);
  });
  it.each(['auto', 'button'] as const)(
    'durably consumes %s plans before effects and does not replay after restart with a rewound wall clock',
    async (mode) => {
      const f = await fixture();
      await f.request({ ...plan, mode });
      await f.advance(60_000);
      const stored = JSON.parse(await readFile(f.path, 'utf8'));
      expect(
        stored.definitions.find(
          (d: { id: string }) => d.id === 'bedtime-morning',
        ).bedtime.plan.consumedAt,
      ).toBe(f.clock.now());
      expect(f.service.snapshot().runs).toHaveLength(mode === 'auto' ? 1 : 0);
      f.jump(-60_000);
      await f.restart();
      await f.advance(60_000);
      expect(f.service.snapshot().runs).toEqual([]);
      expect(f.service.snapshot().next).toEqual([]);
      expect(f.service.snapshot().bedtime!.plan).toBeNull();
    },
  );
  it('manual lighting intent during the durable consumption write prevents any later routine commands', async () => {
    const f = await fixture();
    await f.request(plan);
    await f.capabilities.invoke(
      'lighting.activateScene',
      { sceneId: 'scene.all_off' },
      human,
    );
    f.lighting.dispatched.length = 0;
    const update = f.store.update.bind(f.store);
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writing: ReturnType<typeof update> | undefined;
    vi.spyOn(f.store, 'update').mockImplementation((...args) => {
      writing = paused.then(() => update(...args));
      return writing;
    });
    f.rawAdvance(60_000);
    await flush();
    expect(writing).toBeDefined();
    await f.capabilities.invoke(
      'lighting.set',
      { target: 'lighting.accent', values: { power: false } },
      human,
    );
    const manualCount = f.lighting.dispatched.length;
    release();
    await writing;
    await flush();
    await f.advance(60_000);
    expect(f.service.snapshot().runs).toEqual([]);
    expect(f.lighting.dispatched).toHaveLength(manualCount);
    expect(
      f.store.snapshot().definitions.find((d) => d.id === 'bedtime-morning')!
        .bedtime!.plan!.consumedAt,
    ).toBeDefined();
  });
  it.each(['service', 'api', 'skip'] as const)(
    'cancel/skip through %s during consumption suppresses the start and retains its durable receipt',
    async (path) => {
      const f = await fixture();
      await f.request(plan);
      await f.capabilities.invoke(
        'lighting.activateScene',
        { sceneId: 'scene.all_off' },
        human,
      );
      f.lighting.dispatched.length = 0;
      const update = f.store.update.bind(f.store);
      let release!: () => void;
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      let writing: ReturnType<typeof update> | undefined;
      vi.spyOn(f.store, 'update').mockImplementation((...args) => {
        writing = paused.then(() => update(...args));
        return writing;
      });
      f.rawAdvance(60_000);
      await flush();
      expect(writing).toBeDefined();
      const cancel = {
        id: 'bedtime-morning',
        action: path === 'skip' ? 'skip' : 'cancel',
        requestId: 'cancel-writing',
      };
      if (path === 'service') f.service.action(cancel, human);
      else await f.api.request('routines/action', cancel, human);
      release();
      await writing;
      await flush();
      await f.advance(30_000);
      expect(f.service.snapshot().runs).toEqual([]);
      expect(f.lighting.dispatched).toEqual([]);
      expect(
        f.engine.state.intent.holds.filter(
          (h) => h.scope === 'lighting.activation',
        ),
      ).toHaveLength(2);
      expect(
        f.store.snapshot().definitions.find((d) => d.id === 'bedtime-morning')!
          .bedtime!.plan!.consumedAt,
      ).toBeDefined();
    },
  );
  it('cancelling another routine does not invalidate a pending morning occurrence', async () => {
    const f = await fixture();
    await f.request(plan);
    const update = f.store.update.bind(f.store);
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writing: ReturnType<typeof update> | undefined;
    vi.spyOn(f.store, 'update').mockImplementation((...args) => {
      writing = paused.then(() => update(...args));
      return writing;
    });
    f.rawAdvance(60_000);
    await flush();
    expect(writing).toBeDefined();
    await f.api.request(
      'routines/action',
      { id: 'bedtime-night', action: 'cancel' },
      human,
    );
    release();
    await writing;
    await flush();
    await f.advance(30_000);
    expect(f.service.snapshot().runs).toEqual([
      expect.objectContaining({
        routineId: 'bedtime-morning',
        status: 'running',
      }),
    ]);
    expect(f.lighting.dispatched.length).toBeGreaterThan(0);
  });
  it.each([
    'lighting.second',
    'lighting.ceiling',
    'music.room',
    'scene.all_off',
  ] as const)(
    'explicit bedtime persistence respects intervening intent scoped to %s',
    async (target) => {
      const f = await fixture();
      const update = f.store.update.bind(f.store);
      let release!: () => void;
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(f.store, 'update').mockImplementation((...args) =>
        paused.then(() => update(...args)),
      );
      const request = f.request({ ...plan, action: 'start' });
      await flush();
      if (target === 'music.room')
        await f.capabilities.invoke('music.pause', { target }, human);
      else if (target === 'scene.all_off')
        await f.capabilities.invoke(
          'lighting.activateScene',
          { sceneId: target },
          human,
        );
      else
        await f.capabilities.invoke(
          'lighting.set',
          { target, values: { power: true, brightness: 80 } },
          human,
        );
      const manualCount = f.lighting.dispatched.length;
      release();
      const result = await request;
      await flush();
      await f.advance(45_000);
      const relevant =
        target === 'lighting.second' || target === 'scene.all_off';
      expect(result.bedtime!.plan).not.toBeNull();
      expect(
        f.service
          .snapshot()
          .runs.filter((run) => run.routineId === 'bedtime-night'),
      ).toHaveLength(relevant ? 0 : 1);
      if (relevant) expect(f.lighting.dispatched).toHaveLength(manualCount);
      else expect(f.lighting.dispatched.length).toBeGreaterThan(manualCount);
      expect(
        f.store.snapshot().definitions.find((d) => d.id === 'bedtime-morning')!
          .bedtime!.plan,
      ).toMatchObject({ music: false, mode: 'auto' });
    },
  );
  it.each(['bedtime-night', 'bedtime-morning'] as const)(
    'cancel API scopes an explicit start waiting for persistence to %s',
    async (id) => {
      const f = await fixture();
      await f.request(plan);
      const update = f.store.update.bind(f.store);
      let release!: () => void;
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(f.store, 'update').mockImplementation((...args) =>
        paused.then(() => update(...args)),
      );
      const request = f.request({ ...plan, action: 'start' });
      await flush();
      await f.api.request('routines/action', { id, action: 'cancel' }, human);
      release();
      const result = await request;
      await flush();
      await f.advance(45_000);
      expect(result.bedtime!.plan).not.toBeNull();
      expect(
        f.service
          .snapshot()
          .runs.filter((run) => run.routineId === 'bedtime-night'),
      ).toHaveLength(id === 'bedtime-night' ? 0 : 1);
      if (id === 'bedtime-night') expect(f.lighting.dispatched).toEqual([]);
      else expect(f.lighting.dispatched.length).toBeGreaterThan(0);
    },
  );
  it('handles a removed persisted target after restart without throwing from the scheduler callback', async () => {
    const f = await fixture();
    await f.request(plan);
    delete f.engine.state.lighting.devices['lighting.accent'];
    delete f.engine.state.lighting.devices['lighting.second'];
    await f.restart();
    await expect(f.advance(60_000)).resolves.toBeUndefined();
    expect(f.service.snapshot().runs).toEqual([
      expect.objectContaining({
        status: 'failed',
        reason: 'bedtime_lights_unavailable',
      }),
    ]);
    expect(f.service.snapshot().next).toEqual([]);
    expect(f.lighting.dispatched).toEqual([]);
    expect(
      f.store.snapshot().definitions.find((d) => d.id === 'bedtime-morning')!
        .bedtime!.plan!.consumedAt,
    ).toBeDefined();
  });
  it('manual morning works before first setup and turns RGB into 3000K white at the first gradual increment', async () => {
    const f = await fixture('2026-10-19T12:00:00+02:00');
    await f.request({ action: 'morning' });
    await flush();
    expect(f.lighting.dispatched).toEqual([]);
    await f.advance(30_000);
    expect(
      f.lighting.dispatched.find((c) => c.target === 'lighting.accent')!.values,
    ).toEqual({ power: true, brightness: 1, colorTemperature: 3000 });
    await f.advance(1_170_000);
    expect(
      f.engine.state.lighting.devices['lighting.accent']!.observed,
    ).toMatchObject({ power: true, brightness: 40, colorTemperature: 3000 });
    expect(
      f.engine.state.lighting.devices['lighting.accent']!.observed.rgb,
    ).toBeUndefined();
    expect(f.service.snapshot().runs.at(-1)!.status).toBe('completed');
    expect(f.music.dispatched).toEqual([]);
  });
  it('night stays light-only, completes at off, and evening cancellation preserves tomorrow', async () => {
    const f = await fixture();
    await f.request({ ...plan, action: 'start' });
    await flush();
    await f.advance(45_000);
    expect(f.music.dispatched).toEqual([]);
    await f.capabilities.invoke(
      'lighting.set',
      { target: 'lighting.second', values: { power: true, brightness: 60 } },
      human,
    );
    expect(f.service.snapshot().runs[0]!.status).toBe('cancelled');
    expect(f.service.snapshot().bedtime!.plan).not.toBeNull();
    const g = await fixture();
    await g.request({ ...plan, action: 'start', mode: 'none' });
    await flush();
    await g.advance(900_000);
    expect(
      g.engine.state.lighting.devices['lighting.second']!.observed.power,
    ).toBe(false);
    expect(g.service.snapshot().runs[0]!.status).toBe('completed');
    expect(g.music.dispatched).toEqual([]);
  });
  it('rechecks persisted targets on scheduled start without adding newly online lights', async () => {
    const f = await fixture();
    await f.request(plan);
    f.engine.state.lighting.devices['lighting.second']!.availability =
      'unavailable';
    f.lighting.externalChange('lighting.strip1', {
      power: false,
      brightness: 50,
    });
    await f.advance(90_000);
    expect(f.lighting.dispatched.map((c) => c.target)).toEqual([
      'lighting.accent',
    ]);
    expect(f.service.snapshot().runs[0]!.status).toBe('running');
  });
  it('bounds a per-light dispatch failure and continues with the remaining known targets', async () => {
    const f = await fixture('2026-10-19T12:00:00+02:00');
    const invoke = f.capabilities.invoke.bind(f.capabilities);
    vi.spyOn(f.capabilities, 'invoke').mockImplementation(
      (name, input, provenance, guard) =>
        name === 'lighting.set' &&
        (input as { target: string }).target === 'lighting.second'
          ? Promise.reject(new Error('offline'))
          : invoke(name, input, provenance, guard),
    );
    await f.request({ action: 'morning' });
    await flush();
    await f.advance(60_000);
    expect(
      f.lighting.dispatched.filter((c) => c.target === 'lighting.accent'),
    ).toHaveLength(2);
    expect(f.service.snapshot().runs.at(-1)!).toMatchObject({
      status: 'running',
      warnings: [expect.stringContaining('lighting.second')],
    });
  });
  it('cancels snoozed continuation on manual off and skip never advances a one-off to tomorrow', async () => {
    const f = await fixture();
    await f.request(plan);
    await f.advance(60_000);
    f.service.action(
      { id: 'bedtime-morning', action: 'snooze', minutes: 1 },
      human,
    );
    await f.capabilities.invoke(
      'lighting.activateScene',
      { sceneId: 'scene.all_off' },
      human,
    );
    const count = f.lighting.dispatched.length;
    await f.advance(90_000);
    expect(f.lighting.dispatched).toHaveLength(count);
    expect(f.service.snapshot().next).toEqual([]);
    const g = await fixture();
    await g.request(plan);
    await g.advance(60_000);
    g.service.action({ id: 'bedtime-morning', action: 'skip' }, human);
    expect(g.service.snapshot().next).toEqual([]);
    expect(g.service.snapshot().runs[0]!.status).toBe('cancelled');
  });
  it('snoozes a button appearance once, and supports skipping its ready window', async () => {
    const f = await fixture();
    await f.request({ ...plan, mode: 'button' });
    await f.advance(60_000);
    f.service.action(
      { id: 'bedtime-morning', action: 'snooze', minutes: 1 },
      human,
    );
    expect(f.service.snapshot().bedtime!.ready).toBeNull();
    await f.advance(60_000);
    expect(f.service.snapshot().bedtime!.ready).not.toBeNull();
    expect(f.service.snapshot().runs).toEqual([]);
    f.service.action({ id: 'bedtime-morning', action: 'skip' }, human);
    expect(f.service.snapshot().bedtime!.ready).toBeNull();
    expect(f.service.snapshot().next).toEqual([]);
  });
});

describe('routine temperature target scope', () => {
  const focus = {
    id: 'scene.focus',
    name: 'Fokus',
    lighting: {
      'lighting.accent': {
        power: true,
        brightness: 70,
        colorTemperature: 4000,
      },
      'lighting.ceiling': {
        power: true,
        brightness: 80,
        colorTemperature: 4000,
      },
    },
  };
  it.each(['morning', 'start'] as const)(
    '%s never sends temperature commands outside its configured accent targets',
    async (action) => {
      const f = await fixture('2026-10-19T12:00:00+02:00', {
        scenes: [
          {
            id: 'scene.soft_light',
            name: 'Soft',
            lighting: {
              'lighting.accent': {
                power: true,
                brightness: 20,
                colorTemperature: 3000,
              },
              'lighting.ceiling': { power: false },
            },
          },
          focus,
        ],
      });
      await f.capabilities.invoke(
        'lighting.activateScene',
        { sceneId: focus.id },
        human,
      );
      await flush();
      f.lighting.dispatched.length = 0;
      const ceiling = structuredClone(
        f.engine.state.lighting.devices['lighting.ceiling'],
      );
      await f.request(
        action === 'morning' ? { action } : { ...plan, action, mode: 'none' },
      );
      await flush();
      await f.advance(60_000);
      expect(
        f.lighting.dispatched.some(
          (command) =>
            command.target === 'lighting.accent' &&
            command.values.colorTemperature === 3000,
        ),
      ).toBe(true);
      expect(
        f.lighting.dispatched.some(
          (command) => command.target === 'lighting.ceiling',
        ),
      ).toBe(false);
      expect(f.engine.state.lighting.devices['lighting.ceiling']).toEqual(
        ceiling,
      );
    },
  );
  it.each(['scene', 'target'] as const)(
    'pending bedtime respects the actual targets of a manual %s temperature change',
    async (scope) => {
      const f = await fixture('2026-10-19T12:00:00+02:00', {
        scenes: [
          {
            id: 'scene.soft_light',
            name: 'Soft',
            lighting: {
              'lighting.accent': {
                power: true,
                brightness: 20,
                colorTemperature: 3000,
              },
              'lighting.ceiling': { power: false },
            },
          },
          focus,
        ],
      });
      await f.capabilities.invoke(
        'lighting.activateScene',
        { sceneId: focus.id },
        human,
      );
      await flush();
      f.lighting.dispatched.length = 0;
      const update = f.store.update.bind(f.store);
      let release!: () => void;
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(f.store, 'update').mockImplementation((...args) =>
        paused.then(() => update(...args)),
      );
      const request = f.request({ ...plan, action: 'start', mode: 'none' });
      await flush();
      const manual = f.capabilities.invoke(
        'lighting.set',
        {
          target: 'lighting.ceiling',
          values: { colorTemperature: 5000 },
          ...(scope === 'target' ? { temperatureScope: 'target' } : {}),
        },
        human,
      );
      // Attribution must be synchronous: persistence is released before awaiting manual delivery.
      release();
      await Promise.all([request, manual]);
      await flush();
      const manualCount = f.lighting.dispatched.length;
      await f.advance(45_000);
      expect(f.service.snapshot().runs).toHaveLength(scope === 'scene' ? 0 : 1);
      if (scope === 'scene') {
        expect(f.lighting.dispatched).toHaveLength(manualCount);
        expect(
          f.engine.state.lighting.devices['lighting.accent']!.observed
            .colorTemperature,
        ).toBe(5000);
      } else {
        expect(f.lighting.dispatched.length).toBeGreaterThan(manualCount);
        expect(
          f.engine.state.lighting.devices['lighting.accent']!.observed
            .colorTemperature,
        ).toBe(3000);
      }
      expect(
        f.engine.state.lighting.devices['lighting.ceiling']!.observed
          .colorTemperature,
      ).toBe(5000);
    },
  );
  it.each(['scene', 'target'] as const)(
    'a manual %s temperature change cancels running routines only on affected targets',
    async (scope) => {
      const f = await fixture('2026-10-19T12:00:00+02:00', {
        scenes: [
          {
            id: 'scene.soft_light',
            name: 'Soft',
            lighting: {
              'lighting.accent': {
                power: true,
                brightness: 20,
                colorTemperature: 3000,
              },
              'lighting.ceiling': { power: false },
            },
          },
          focus,
        ],
      });
      await f.capabilities.invoke(
        'lighting.activateScene',
        { sceneId: focus.id },
        human,
      );
      await flush();
      await f.request({ ...plan, action: 'start', mode: 'none' });
      await flush();
      await f.advance(15_000);
      expect(f.service.snapshot().runs.at(-1)!.status).toBe('running');
      const manual = f.capabilities.invoke(
        'lighting.set',
        {
          target: 'lighting.ceiling',
          values: { colorTemperature: 5000 },
          ...(scope === 'target' ? { temperatureScope: 'target' } : {}),
        },
        human,
      );
      expect(f.service.snapshot().runs.at(-1)!.status).toBe(
        scope === 'scene' ? 'cancelled' : 'running',
      );
      await manual;
      const manualCount = f.lighting.dispatched.length;
      await f.advance(45_000);
      if (scope === 'scene') {
        expect(f.lighting.dispatched).toHaveLength(manualCount);
        expect(
          f.engine.state.lighting.devices['lighting.accent']!.observed
            .colorTemperature,
        ).toBe(5000);
      } else expect(f.lighting.dispatched.length).toBeGreaterThan(manualCount);
    },
  );
  it('keeps scene-wide temperature synchronization for existing capability callers', async () => {
    const f = await fixture('2026-10-19T12:00:00+02:00', {
      scenes: [{ ...focus, id: 'scene.soft_light' }, focus],
    });
    await f.capabilities.invoke(
      'lighting.activateScene',
      { sceneId: focus.id },
      human,
    );
    await flush();
    f.lighting.dispatched.length = 0;
    await f.capabilities.invoke(
      'lighting.set',
      { target: 'lighting.accent', values: { colorTemperature: 3000 } },
      human,
    );
    expect(
      [
        ...new Set(f.lighting.dispatched.map((command) => command.target)),
      ].sort(),
    ).toEqual(['lighting.accent', 'lighting.ceiling']);
    expect(
      f.engine.state.lighting.devices['lighting.ceiling']!.effectiveDesired
        .colorTemperature,
    ).toBe(3000);
  });
});

describe('optional morning music leaves music policy and saved volume authoritative', () => {
  it('opt-in resumes the existing source without any volume, source, preset or authority commands', async () => {
    const f = await fixture('2026-10-19T12:00:00+02:00', {
      musicVolumeSettings: defaultMusicVolumeSettings,
    });
    const before = f.engine.getMusicVolumeSettings();
    const invoke = vi.spyOn(f.capabilities, 'invoke');
    await f.request({ action: 'morning', music: true });
    await flush();
    await f.advance(30_000);
    const musicCalls = invoke.mock.calls.filter(([name]) =>
      name.startsWith('music.'),
    );
    expect(musicCalls.map(([name]) => name)).toEqual(['music.play']);
    expect(musicCalls[0]![2]!.actor).toEqual({
      type: 'routine',
      id: 'bedtime-morning',
    });
    expect(f.engine.getMusicVolumeSettings()).toEqual(before);
    expect(f.engine.state.music.devices['music.room']!.observed).toMatchObject({
      source: 'Spotify',
      volume: 0.27,
    });
    expect(f.lighting.dispatched.length).toBeGreaterThan(0);
  });
  it.each(['quiet', 'pause'] as const)(
    '%s blocks optional playback while lights continue and Pause remains intact',
    async (block) => {
      const f = await fixture(
        block === 'quiet'
          ? '2026-10-19T23:59:00+02:00'
          : '2026-10-19T12:00:00+02:00',
      );
      if (block === 'pause')
        await f.capabilities.invoke(
          'music.pause',
          { target: 'music.room' },
          human,
        );
      f.music.dispatched.length = 0;
      const invoke = vi.spyOn(f.capabilities, 'invoke');
      await f.request({ action: 'morning', music: true });
      await flush();
      await f.advance(30_000);
      expect(
        invoke.mock.calls.filter(([name]) => name === 'music.play'),
      ).toEqual([]);
      expect(f.music.dispatched).toEqual([]);
      expect(f.lighting.dispatched.length).toBeGreaterThan(0);
      expect(f.service.snapshot().runs.at(-1)!).toMatchObject({
        status: 'running',
        warnings: [expect.stringContaining('blocked')],
      });
      expect(f.engine.automaticMusicPlaybackAllowed('music.room')).toBe(false);
    },
  );
  it('a failed optional play dispatch does not abort the light fade', async () => {
    const f = await fixture('2026-10-19T12:00:00+02:00');
    const invoke = f.capabilities.invoke.bind(f.capabilities);
    vi.spyOn(f.capabilities, 'invoke').mockImplementation(
      (name, input, provenance, guard) =>
        name === 'music.play'
          ? Promise.reject(new Error('music offline'))
          : invoke(name, input, provenance, guard),
    );
    await f.request({ action: 'morning', music: true });
    await flush();
    await f.advance(30_000);
    expect(f.lighting.dispatched.length).toBeGreaterThan(0);
    expect(f.service.snapshot().runs.at(-1)!).toMatchObject({
      status: 'running',
      warnings: [expect.stringContaining('failed')],
    });
  });
});

it('tomorrow Stockholm rejects a DST gap and picks only the first fold instant', () => {
  expect(() =>
    tomorrowStockholm('02:30', Date.parse('2026-03-28T12:00:00+01:00')),
  ).toThrow('bedtime_time_missing');
  expect(
    new Date(
      tomorrowStockholm('02:30', Date.parse('2026-10-24T12:00:00+02:00')),
    ).toISOString(),
  ).toBe('2026-10-25T00:30:00.000Z');
  expect(
    new Date(
      tomorrowStockholm('07:00', Date.parse('2026-10-24T23:59:00+02:00')),
    ).toISOString(),
  ).toBe('2026-10-25T06:00:00.000Z');
});

it('after midnight selects the coming morning, while a passed time advances to the next date', () => {
  expect(
    new Date(
      tomorrowStockholm('07:30', Date.parse('2026-10-20T00:15:00+02:00')),
    ).toISOString(),
  ).toBe('2026-10-20T05:30:00.000Z');
  expect(
    new Date(
      tomorrowStockholm('07:30', Date.parse('2026-10-20T08:15:00+02:00')),
    ).toISOString(),
  ).toBe('2026-10-21T05:30:00.000Z');
  expect(() =>
    tomorrowStockholm('02:30', Date.parse('2026-03-29T00:15:00+01:00')),
  ).toThrow('bedtime_time_missing');
  expect(
    new Date(
      tomorrowStockholm('02:30', Date.parse('2026-10-25T00:15:00+02:00')),
    ).toISOString(),
  ).toBe('2026-10-25T00:30:00.000Z');
});
