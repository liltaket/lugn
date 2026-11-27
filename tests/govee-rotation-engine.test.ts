import { afterEach, describe, expect, it } from 'vitest';
import {
  SimulatedLightingAdapter,
  type LightingCommand,
} from '../src/adapters/simulated-lighting.js';
import {
  LugnEngine,
  type EngineOptions,
} from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import { SceneSchema, type LightingScene } from '../src/core/schemas.js';

const target = 'lighting.govee_strip_2';
const other = 'lighting.govee_table';
const user = { type: 'user' as const };
const rotation = { effects: ['Aurora', 'Forest'], intervalSeconds: 15 };
const scenes: LightingScene[] = [
  {
    id: 'scene.loop',
    name: 'Loop',
    lighting: { [target]: { power: true, brightness: 30 } },
    govee: { [target]: { rotation } },
  },
  {
    id: 'scene.other',
    name: 'Other',
    lighting: {
      [other]: { power: true, brightness: 20, colorTemperature: 3000 },
    },
  },
  {
    id: 'scene.white',
    name: 'White',
    lighting: {
      [target]: { power: true, brightness: 30, colorTemperature: 4000 },
    },
  },
  {
    id: 'scene.all_off',
    name: 'Off',
    lighting: { [target]: { power: false }, [other]: { power: false } },
  },
];
const engines: LugnEngine[] = [];
afterEach(() => engines.splice(0).forEach((engine) => engine.dispose()));
function fixture(options: EngineOptions = {}, clock = new FakeClock(1000)) {
  const adapter = Object.assign(new SimulatedLightingAdapter(clock), {
    goveeCapabilities: {
      [target]: { effects: ['Aurora', 'Forest'], zones: false },
      [other]: { effects: ['Forest'], zones: false },
    },
  });
  const engine = new LugnEngine(clock, {
    adapter,
    deviceIds: [target, other],
    scenes: structuredClone(scenes),
    ...options,
  });
  engines.push(engine);
  return { engine, adapter, clock };
}
async function flush() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
async function tick(clock: FakeClock, duration = 15_000) {
  clock.advanceBy(duration);
  await flush();
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
function blockNextStep(adapter: SimulatedLightingAdapter) {
  const blocked = deferred();
  const entered = deferred();
  let command: LightingCommand | undefined;
  const ordinary = adapter.dispatch.bind(adapter);
  adapter.dispatch = async (next) => {
    if (next.goveeOnly && !command) {
      command = next;
      entered.resolve();
      await blocked.promise;
    }
    await ordinary(next);
  };
  return {
    blocked,
    entered,
    get command() {
      return command;
    },
  };
}
async function presence(
  engine: LugnEngine,
  value: 'occupied' | 'confirmed_empty',
) {
  await engine.handlePresence({ type: 'presence.changed', presence: value });
}

it('validates bounded distinct playlists without static color or a simultaneous effect', () => {
  const base = scenes[0]!;
  expect(SceneSchema.parse(base).govee?.[target]?.rotation).toEqual(rotation);
  for (const intent of [
    { rotation: { ...rotation, effects: ['Aurora'] } },
    { rotation: { ...rotation, effects: ['Aurora', 'Aurora'] } },
    { rotation: { ...rotation, intervalSeconds: 14 } },
    { rotation: { ...rotation, intervalSeconds: 3601 } },
    { effect: 'Aurora', rotation },
  ])
    expect(
      SceneSchema.safeParse({ ...base, govee: { [target]: intent } }).success,
    ).toBe(false);
  for (const color of [{ colorTemperature: 3000 }, { rgb: [1, 2, 3] }])
    expect(
      SceneSchema.safeParse({
        ...base,
        lighting: { [target]: { power: true, ...color } },
      }).success,
    ).toBe(false);
});

describe('engine-owned Govee rotation', () => {
  function windowFixture(presenceMode: 'always' | 'home' | 'room' = 'always') {
    return fixture({
      windowLighting: {
        target,
        presenceMode,
        brightness: 55,
        maxSunElevation: 6,
      },
    });
  }

  it('keeps the outward-facing effect and its rotation through exit, even when away', async () => {
    const { engine, adapter, clock } = windowFixture();
    await engine.handleSunElevation(-5);
    await presence(engine, 'occupied');
    await engine.activateScene('scene.other', user);
    await engine.activateScene('scene.loop', user);
    expect(adapter.observed.get(other)?.power).toBe(true);
    const id = engine.state.lighting.devices[target]?.govee?.controlId;
    await engine.handleHomePresence('away');
    await presence(engine, 'confirmed_empty');
    expect(adapter.observed.get(target)).toMatchObject({
      power: true,
      brightness: 55,
    });
    expect(engine.state.lighting.devices[target]?.govee?.controlId).toBe(id);
    expect(adapter.observed.get(other)?.power).toBe(false);
    await tick(clock);
    expect(adapter.dispatched.at(-1)).toMatchObject({
      target,
      goveeOnly: true,
      govee: { effect: 'Forest' },
    });
    await engine.activateScene('scene.all_off', user);
    const count = adapter.dispatched.length;
    await tick(clock, 60_000);
    expect(adapter.observed.get(target)?.power).toBe(false);
    expect(
      adapter.dispatched.slice(count).some((command) => command.govee),
    ).toBe(false);
  });

  it('stops an effect at daylight and resumes it at dusk without room entry', async () => {
    const { engine, adapter, clock } = windowFixture();
    await engine.handleSunElevation(-5);
    await engine.activateScene('scene.loop', user);
    await presence(engine, 'confirmed_empty');
    await engine.handleSunElevation(10);
    expect(adapter.observed.get(target)?.power).toBe(false);
    expect(
      engine.state.lighting.devices[target]?.govee?.controlId,
    ).toBeUndefined();
    const count = adapter.dispatched.length;
    await tick(clock);
    expect(
      adapter.dispatched.slice(count).some((command) => command.govee),
    ).toBe(false);
    await engine.handleSunElevation(-5);
    expect(adapter.observed.get(target)?.power).toBe(true);
    expect(engine.state.lighting.devices[target]?.govee).toMatchObject({
      status: 'sent',
      activeEffect: 'Aurora',
    });
    await tick(clock);
    expect(adapter.dispatched.at(-1)?.govee?.effect).toBe('Forest');
  });

  it('revokes a queued rotation at dawn before it can write', async () => {
    const { engine, adapter, clock } = windowFixture();
    await engine.handleSunElevation(-5);
    await engine.activateScene('scene.loop', user);
    const b = blockNextStep(adapter);
    await tick(clock);
    await b.entered.promise;
    const dawn = engine.handleSunElevation(10);
    expect(b.command?.isCurrent?.()).toBe(false);
    b.blocked.resolve();
    await dawn;
    await flush();
    expect(adapter.observed.get(target)?.power).toBe(false);
    expect(
      adapter.dispatched.filter((command) => command.goveeOnly),
    ).toHaveLength(0);
  });

  it.each(['home', 'room'] as const)(
    'preserves %s presence restrictions for window effects',
    async (mode) => {
      const { engine, adapter, clock } = windowFixture(mode);
      await engine.handleSunElevation(-5);
      await presence(engine, 'occupied');
      await engine.activateScene('scene.loop', user);
      if (mode === 'home') await engine.handleHomePresence('away');
      await presence(engine, 'confirmed_empty');
      expect(adapter.observed.get(target)?.power).toBe(false);
      const count = adapter.dispatched.length;
      await tick(clock);
      expect(
        adapter.dispatched.slice(count).some((command) => command.govee),
      ).toBe(false);
    },
  );

  it('restores only the window animation at dusk before room occupancy', async () => {
    const first = windowFixture();
    await first.engine.handleSunElevation(-5);
    await first.engine.activateScene('scene.loop', user);
    const { engine, adapter } = fixture({
      windowLighting: {
        target,
        presenceMode: 'always',
        brightness: 55,
        maxSunElevation: 6,
      },
      restoredLightingIntent: first.engine.getLightingIntentSnapshot(),
    });
    expect(adapter.dispatched).toHaveLength(0);
    await engine.handleSunElevation(-5);
    expect(adapter.observed.get(target)).toMatchObject({
      power: true,
      brightness: 55,
    });
    expect(engine.state.lighting.devices[target]?.govee?.status).toBe('sent');
    expect(adapter.observed.get(other)?.power).not.toBe(true);
  });

  it('keeps only the window rotation through room continuity expiry and restart', async () => {
    const settings = {
      target,
      presenceMode: 'always' as const,
      brightness: 55,
      maxSunElevation: 6,
    };
    const first = fixture({ windowLighting: settings, continuityMs: 1000 });
    await first.engine.handleSunElevation(-5);
    await presence(first.engine, 'occupied');
    await first.engine.activateScene('scene.loop', user);
    await presence(first.engine, 'confirmed_empty');
    await tick(first.clock, 1001);
    expect(first.engine.state.lighting.currentScene).toBe('scene.loop');
    await tick(first.clock, 13_999);
    expect(
      first.engine.state.lighting.devices[target]?.govee?.activeEffect,
    ).toBe('Forest');
    const snapshot = first.engine.getLightingIntentSnapshot();
    const restarted = fixture({
      windowLighting: settings,
      restoredLightingIntent: snapshot,
    });
    await restarted.engine.handleSunElevation(-5);
    expect(restarted.engine.state.lighting.devices[target]?.govee?.status).toBe(
      'sent',
    );
    expect(restarted.adapter.observed.get(other)?.power).not.toBe(true);
  });

  it('retains an animation saved during daylight so it can resume at dusk after restart', async () => {
    const first = windowFixture();
    await first.engine.handleSunElevation(10);
    await first.engine.activateScene('scene.loop', user);
    const snapshot = first.engine.getLightingIntentSnapshot();
    const restarted = fixture({
      windowLighting: {
        target,
        presenceMode: 'always',
        brightness: 55,
        maxSunElevation: 6,
      },
      restoredLightingIntent: snapshot,
    });
    await restarted.engine.handleSunElevation(10);
    expect(restarted.adapter.observed.get(target)?.power).not.toBe(true);
    await restarted.engine.handleSunElevation(-5);
    expect(
      restarted.engine.state.lighting.devices[target]?.govee,
    ).toMatchObject({ status: 'sent', activeEffect: 'Aurora' });
  });

  it.each(['expired while stopped', 'daylight after expiry'] as const)(
    'restores window animation independently of room continuity: %s',
    async (when) => {
      const settings = {
        target,
        presenceMode: 'always' as const,
        brightness: 55,
        maxSunElevation: 6,
      };
      const first = fixture({
        windowLighting: settings,
        continuityMs: 1000,
        defaultSceneId: 'scene.other',
      });
      await first.engine.handleSunElevation(-5);
      await presence(first.engine, 'occupied');
      await first.engine.activateScene('scene.loop', user);
      await presence(first.engine, 'confirmed_empty');
      let snapshot = first.engine.getLightingIntentSnapshot();
      if (when === 'daylight after expiry') {
        await tick(first.clock, 1001);
        await first.engine.handleSunElevation(10);
        snapshot = first.engine.getLightingIntentSnapshot();
      }
      const restarted = fixture(
        {
          windowLighting: settings,
          restoredLightingIntent: snapshot,
          defaultSceneId: 'scene.other',
        },
        new FakeClock(10_000),
      );
      await restarted.engine.handleSunElevation(10);
      expect(restarted.adapter.observed.get(target)?.power).not.toBe(true);
      await restarted.engine.handleSunElevation(-5);
      expect(
        restarted.engine.state.lighting.devices[target]?.govee,
      ).toMatchObject({ status: 'sent', activeEffect: 'Aurora' });
      expect(restarted.adapter.observed.get(other)?.power).not.toBe(true);
      await presence(restarted.engine, 'occupied');
      expect(restarted.adapter.observed.get(other)?.power).toBe(true);
    },
  );

  it('cycles and wraps after delivery, without baseline writes or lighting ledger growth', async () => {
    const { engine, adapter, clock } = fixture();
    await engine.activateScene('scene.loop', user);
    const initial = adapter.dispatched.at(-1)!;
    expect(initial.values).toEqual({ power: true, brightness: 30 });
    expect(initial.govee).toEqual({
      effect: 'Aurora',
      controlId: expect.any(String),
    });
    const count = engine.state.commands.length;
    const ids = new Set([initial.govee!.controlId]);
    for (let i = 0; i < 6; i++) {
      await tick(clock);
      const command = adapter.dispatched.at(-1)!;
      expect(command).toMatchObject({
        values: {},
        goveeOnly: true,
        govee: { effect: i % 2 === 0 ? 'Forest' : 'Aurora' },
      });
      expect(command.govee).not.toHaveProperty('rotation');
      expect(ids.has(command.govee!.controlId)).toBe(false);
      ids.add(command.govee!.controlId);
      expect(engine.state.lighting.devices[target]?.govee).toMatchObject({
        status: 'sent',
        activeEffect: command.govee!.effect,
      });
    }
    expect(
      adapter.dispatched.filter((command) => command.target === target),
    ).toHaveLength(7);
    expect(engine.state.commands.length).toBe(count);
    const saved = engine.getLightingIntentSnapshot();
    expect(saved.devices[target]?.govee).toEqual({ rotation });
    expect(JSON.stringify(saved)).not.toContain('activeEffect');
    expect(JSON.stringify(saved)).not.toContain(
      adapter.dispatched.at(-1)!.govee!.controlId,
    );
  });

  it('waits for an in-flight step before scheduling another interval', async () => {
    const { engine, adapter, clock } = fixture();
    await engine.activateScene('scene.loop', user);
    const b = blockNextStep(adapter);
    await tick(clock);
    await b.entered.promise;
    await tick(clock, 90_000);
    expect(adapter.dispatched).toHaveLength(1);
    expect(engine.state.lighting.devices[target]?.govee?.status).toBe(
      'pending',
    );
    b.blocked.resolve();
    await flush();
    expect(adapter.dispatched).toHaveLength(2);
    await tick(clock, 14_999);
    expect(adapter.dispatched).toHaveLength(2);
    await tick(clock, 1);
    expect(adapter.dispatched).toHaveLength(3);
  });

  it.each(['scene.white', 'scene.all_off'])(
    'cancels a delayed step before %s',
    async (scene) => {
      const { engine, adapter, clock } = fixture();
      await engine.activateScene('scene.loop', user);
      const b = blockNextStep(adapter);
      await tick(clock);
      await engine.activateScene(scene, user);
      expect(b.command?.isCurrent?.()).toBe(false);
      b.blocked.resolve();
      await flush();
      const count = adapter.dispatched.length;
      await tick(clock, 120_000);
      expect(adapter.dispatched).toHaveLength(count);
      expect(engine.state.lighting.devices[target]?.govee).toBeUndefined();
      expect(adapter.observed.get(target)).toMatchObject(
        scene === 'scene.white'
          ? { power: true, colorTemperature: 4000 }
          : { power: false },
      );
    },
  );

  it('honors manual and externally observed OFF without a later playlist tick', async () => {
    for (const external of [false, true]) {
      const { engine, adapter, clock } = fixture();
      await engine.activateScene('scene.loop', user);
      if (external) adapter.externalChange(target, { power: false });
      else await engine.setLighting(target, { power: false }, { actor: user });
      await flush();
      const count = adapter.dispatched.length;
      await tick(clock, 120_000);
      expect(adapter.dispatched).toHaveLength(count);
      expect(
        engine.getLightingIntentSnapshot().devices[target]?.govee,
      ).toBeNull();
      expect(
        engine.getLightingIntentSnapshot().devices[target]?.effectiveDesired
          .power,
      ).toBe(false);
    }
  });

  it('revokes an in-flight tick on exit and starts a fresh rotation on permitted return', async () => {
    const { engine, adapter, clock } = fixture();
    await presence(engine, 'occupied');
    await engine.activateScene('scene.loop', user);
    const b = blockNextStep(adapter);
    await tick(clock);
    await presence(engine, 'confirmed_empty');
    expect(b.command?.isCurrent?.()).toBe(false);
    expect(
      engine.state.lighting.devices[target]?.govee?.controlId,
    ).toBeUndefined();
    b.blocked.resolve();
    await flush();
    const count = adapter.dispatched.length;
    await tick(clock, 30_000);
    expect(adapter.dispatched).toHaveLength(count);
    expect(adapter.observed.get(target)?.power).toBe(false);
    await presence(engine, 'occupied');
    expect(adapter.dispatched.at(-1)?.govee?.effect).toBe('Aurora');
    expect(adapter.dispatched.at(-1)?.govee?.controlId).not.toBe(
      b.command?.govee?.controlId,
    );
    await tick(clock);
    expect(adapter.dispatched.at(-1)?.govee?.effect).toBe('Forest');
  });

  it.each([false, true])(
    'preserves an omitted target through partial scene changes (empty=%s)',
    async (empty) => {
      const { engine, adapter, clock } = fixture();
      await presence(engine, empty ? 'confirmed_empty' : 'occupied');
      await engine.activateScene('scene.loop', user);
      await engine.activateScene('scene.other', user);
      await tick(clock);
      expect(
        adapter.dispatched
          .filter((command) => command.target === target)
          .at(-1),
      ).toMatchObject({ goveeOnly: true, govee: { effect: 'Forest' } });
      expect(engine.state.lighting.devices[target]?.govee?.status).toBe('sent');
    },
  );

  it('keeps an in-flight omitted rotation generation across a partial scene', async () => {
    const { engine, adapter, clock } = fixture();
    await presence(engine, 'confirmed_empty');
    await engine.activateScene('scene.loop', user);
    const b = blockNextStep(adapter);
    await tick(clock);
    const id = b.command?.govee?.controlId;
    await engine.activateScene('scene.other', user);
    expect(b.command?.isCurrent?.()).toBe(true);
    b.blocked.resolve();
    await flush();
    expect(engine.state.lighting.devices[target]?.govee).toMatchObject({
      controlId: id,
      status: 'sent',
      activeEffect: 'Forest',
    });
    await tick(clock);
    expect(
      adapter.dispatched.filter((command) => command.target === target).at(-1)
        ?.govee?.effect,
    ).toBe('Aurora');
  });

  it('restores only intent, dormant until occupancy, with no timer/index/control ID replay', async () => {
    const old = fixture();
    await old.engine.activateScene('scene.loop', user);
    await tick(old.clock);
    const snapshot = old.engine.getLightingIntentSnapshot();
    old.engine.dispose();
    const restored = fixture(
      {
        restoredLightingIntent: snapshot,
        preserveRestoredSceneIds: ['scene.loop'],
      },
      old.clock,
    );
    await tick(restored.clock, 45_000);
    expect(restored.adapter.dispatched).toEqual([]);
    expect(restored.engine.state.lighting.devices[target]?.govee).toEqual({
      intent: { rotation },
      status: 'pending',
    });
    await presence(restored.engine, 'occupied');
    expect(restored.adapter.dispatched.at(-1)?.govee?.effect).toBe('Aurora');
    expect(restored.adapter.dispatched.at(-1)?.values).toEqual({
      power: true,
      brightness: 30,
    });
  });

  it('validates every playlist label on activation and restored recovery', async () => {
    const invalid = structuredClone(scenes);
    invalid[0]!.govee![target]!.rotation!.effects[1] = 'Missing';
    const bad = fixture({ scenes: invalid });
    await expect(bad.engine.activateScene('scene.loop', user)).rejects.toThrow(
      'Unsupported Govee',
    );
    expect(bad.adapter.dispatched).toEqual([]);
    const old = fixture();
    await old.engine.activateScene('scene.loop', user);
    const snapshot = old.engine.getLightingIntentSnapshot();
    snapshot.devices[target]!.govee = {
      rotation: { ...rotation, effects: ['Aurora', 'Missing'] },
    };
    const restored = fixture(
      {
        restoredLightingIntent: snapshot,
        preserveRestoredSceneIds: ['scene.loop'],
      },
      old.clock,
    );
    await presence(restored.engine, 'occupied');
    expect(
      restored.adapter.dispatched.filter(
        (command) => command.target === target && command.values.power === true,
      ),
    ).toEqual([]);
    expect(restored.engine.state.lighting.devices[target]?.govee?.status).toBe(
      'failed',
    );
  });

  it('stops a failed step without blindly retrying until explicitly reapplied', async () => {
    const { engine, adapter, clock } = fixture();
    await engine.activateScene('scene.loop', user);
    let attempts = 0;
    const original = adapter.dispatch.bind(adapter);
    adapter.dispatch = async (command) => {
      if (command.goveeOnly) {
        attempts++;
        throw new Error('unavailable');
      }
      await original(command);
    };
    await tick(clock);
    expect(engine.state.lighting.devices[target]?.govee?.status).toBe('failed');
    await tick(clock, 120_000);
    expect(attempts).toBe(1);
    await engine.activateScene('scene.loop', user);
    expect(engine.state.lighting.devices[target]?.govee?.status).toBe('sent');
    expect(engine.state.lighting.devices[target]?.govee?.activeEffect).toBe(
      'Aurora',
    );
  });

  it('tracks the in-flight tick so external handoff drains it before granting control', async () => {
    const { engine, adapter, clock } = fixture();
    await engine.activateScene('scene.loop', user);
    const b = blockNextStep(adapter);
    await tick(clock);
    let handedOff = false;
    const handoff = engine
      .beginExternalLightingControl(target, user, 'selector', false)
      .then((id) => {
        handedOff = true;
        return id;
      });
    await flush();
    expect(b.command?.isCurrent?.()).toBe(false);
    expect(handedOff).toBe(false);
    b.blocked.resolve();
    await handoff;
    expect(handedOff).toBe(true);
    const count = adapter.dispatched.length;
    await tick(clock, 30_000);
    expect(adapter.dispatched).toHaveLength(count);
  });

  it('clears timers and invalidates pending rotation writes on dispose', async () => {
    const { engine, adapter, clock } = fixture();
    await engine.activateScene('scene.loop', user);
    const b = blockNextStep(adapter);
    await tick(clock);
    engine.dispose();
    expect(b.command?.isCurrent?.()).toBe(false);
    b.blocked.resolve();
    await tick(clock, 120_000);
    expect(adapter.dispatched).toHaveLength(1);
  });
});
