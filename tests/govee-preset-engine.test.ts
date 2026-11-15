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
import type { LightingScene } from '../src/core/schemas.js';

const ceiling = 'lighting.govee_ceiling';
const table = 'lighting.govee_table';
const user = { type: 'user' as const, id: 'govee-preset-test' };
const capabilities = {
  [ceiling]: {
    effects: ['Aurora', 'Forest'],
    zones: true,
    colorTemperature: { min: 2700, max: 6500 },
  },
  [table]: { effects: ['Forest'], zones: false },
};
const scenes: LightingScene[] = [
  {
    id: 'scene.ring',
    name: 'Ring',
    lighting: {
      [ceiling]: { power: true, brightness: 20 },
      [table]: { power: true, brightness: 25 },
    },
    govee: {
      [ceiling]: { effect: 'Aurora', zones: { main: false, ring: true } },
      [table]: { effect: 'Forest' },
    },
  },
  {
    id: 'scene.white',
    name: 'White',
    lighting: {
      [ceiling]: { power: true, brightness: 20, colorTemperature: 4000 },
      [table]: { power: true, brightness: 25, colorTemperature: 4000 },
    },
  },
  {
    id: 'scene.table',
    name: 'Table',
    lighting: {
      [table]: { power: true, brightness: 30, rgb: [10, 20, 30] },
    },
  },
  {
    id: 'scene.all_off',
    name: 'Off',
    lighting: { [ceiling]: { power: false }, [table]: { power: false } },
  },
];
const engines: LugnEngine[] = [];
afterEach(() => engines.splice(0).forEach((engine) => engine.dispose()));

function fixture(options: EngineOptions = {}, clock = new FakeClock(1000)) {
  const adapter = Object.assign(new SimulatedLightingAdapter(clock), {
    goveeCapabilities: structuredClone(capabilities),
  });
  const engine = new LugnEngine(clock, {
    adapter,
    deviceIds: [ceiling, table],
    scenes: structuredClone(scenes),
    ...options,
  });
  engines.push(engine);
  return { clock, adapter, engine };
}
async function presence(
  engine: LugnEngine,
  value: 'occupied' | 'confirmed_empty',
) {
  await engine.handlePresence({ type: 'presence.changed', presence: value });
}
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Govee scene intent in the lighting engine', () => {
  it('propagates exact effect names and ring-only masks with delivery-only state', async () => {
    const { engine, adapter } = fixture();
    await engine.activateScene('scene.ring', user);
    const command = adapter.dispatched.find(
      (entry) => entry.target === ceiling,
    )!;
    const device = engine.state.lighting.devices[ceiling]!;
    expect(command.values).toEqual({ power: true, brightness: 20 });
    expect(command.govee).toEqual({
      effect: 'Aurora',
      zones: { main: false, ring: true },
      controlId: device.govee?.controlId,
    });
    expect(device.govee?.controlId).toBeTypeOf('string');
    expect(device.govee?.status).toBe('sent');
    expect(device.externalControl).toBeUndefined();
    expect(engine.getLightingIntentSnapshot().devices[ceiling]?.govee).toEqual({
      effect: 'Aurora',
      zones: { main: false, ring: true },
    });
    expect(JSON.stringify(engine.getLightingIntentSnapshot())).not.toContain(
      device.govee!.controlId!,
    );
  });

  it('stages a partial mask from a dark fixture and sends ring white only without an effect', async () => {
    const { engine, adapter } = fixture({
      scenes: [
        ...structuredClone(scenes),
        {
          id: 'scene.ring_white',
          name: 'Ring white',
          lighting: {
            [ceiling]: { power: true, brightness: 20, colorTemperature: 3000 },
          },
          govee: { [ceiling]: { zones: { main: false, ring: true } } },
        },
        {
          id: 'scene.both_white',
          name: 'Both white',
          lighting: {
            [ceiling]: { power: true, brightness: 60, colorTemperature: 4000 },
          },
          govee: { [ceiling]: { zones: { main: true, ring: true } } },
        },
      ],
    });
    Object.assign(adapter.goveeCapabilities[ceiling]!, { staticColor: true });
    await engine.activateScene('scene.all_off', user);
    expect(engine.state.lighting.devices[ceiling]?.observed.power).toBe(false);
    await engine.activateScene('scene.ring_white', user);
    const device = engine.state.lighting.devices[ceiling]!;
    expect(adapter.dispatched.at(-1)).toMatchObject({
      target: ceiling,
      values: { power: true, brightness: 20, colorTemperature: 3000 },
      govee: {
        zones: { main: false, ring: true },
        staticColor: { colorTemperature: 3000 },
        stageZones: true,
        controlId: device.govee?.controlId,
      },
    });
    // Already lit: Lugn's last delivered mask lets the adapter send only changes.
    await engine.activateScene('scene.both_white', user);
    expect(adapter.dispatched.at(-1)?.govee).toMatchObject({
      zones: { main: true, ring: true },
      staticColor: { colorTemperature: 4000 },
      knownZones: { main: false, ring: true },
    });
    expect(adapter.dispatched.at(-1)?.govee?.stageZones).toBeUndefined();
    await engine.activateScene('scene.ring_white', user);
    expect(adapter.dispatched.at(-1)?.govee).toMatchObject({
      zones: { main: false, ring: true },
      knownZones: { main: true, ring: true },
    });
    await engine.activateScene('scene.all_off', user);
    await engine.activateScene('scene.ring', user);
    const effect = adapter.dispatched
      .filter((entry) => entry.target === ceiling)
      .at(-1)!;
    expect(effect.govee).toMatchObject({ effect: 'Aurora', stageZones: true });
    // The vendor scene supplies its own colors.
    expect(effect.govee?.staticColor).toBeUndefined();
  });

  it('restores both remembered zones once when an ordinary scene follows a ring-only mask', async () => {
    const { engine, adapter } = fixture();
    Object.assign(adapter.goveeCapabilities[ceiling]!, { staticColor: true });
    const ceilingCommands = () =>
      adapter.dispatched.filter((entry) => entry.target === ceiling);
    await engine.activateScene('scene.white', user);
    // Unknown startup mask: the first ordinary white also lights both zones.
    expect(ceilingCommands().at(-1)?.goveeStatic?.zones).toEqual({
      main: true,
      ring: true,
    });
    await engine.activateScene('scene.all_off', user);
    await engine.activateScene('scene.white', user);
    expect(ceilingCommands().at(-1)?.goveeStatic).toBeDefined();
    expect(ceilingCommands().at(-1)?.goveeStatic?.zones).toBeUndefined();
    await engine.activateScene('scene.ring', user);
    await engine.activateScene('scene.white', user);
    expect(ceilingCommands().at(-1)?.goveeStatic).toMatchObject({
      color: { colorTemperature: 4000 },
      zones: { main: true, ring: true },
    });
  });

  it('combines static ceiling white with main plus ring and clamps the authoritative model range', async () => {
    const { engine, adapter } = fixture({
      scenes: [
        {
          id: 'scene.ceiling_white',
          name: 'Ceiling white',
          lighting: {
            [ceiling]: { power: true, brightness: 60, colorTemperature: 2200 },
          },
          govee: { [ceiling]: { zones: { main: true, ring: true } } },
        },
      ],
    });
    await engine.activateScene('scene.ceiling_white', user);
    expect(adapter.dispatched.at(-1)).toMatchObject({
      target: ceiling,
      values: { power: true, brightness: 60, colorTemperature: 2700 },
      govee: { zones: { main: true, ring: true } },
    });
    expect(
      engine.state.lighting.devices[ceiling]?.effectiveDesired.colorTemperature,
    ).toBe(2700);
    expect(adapter.dispatched.at(-1)?.govee?.effect).toBeUndefined();
    await engine.setLighting(
      ceiling,
      { colorTemperature: 9000 },
      { actor: user },
    );
    expect(adapter.dispatched.at(-1)?.values.colorTemperature).toBe(6500);
    expect(
      engine.state.lighting.devices[ceiling]?.effectiveDesired.colorTemperature,
    ).toBe(6500);
  });

  it('forces static white after an effect even when cached power, brightness and Kelvin already match', async () => {
    const { engine, adapter } = fixture();
    await engine.activateScene('scene.white', user);
    await engine.activateScene('scene.ring', user);
    const start = adapter.dispatched.length;
    await engine.activateScene('scene.white', user);
    expect(
      adapter.dispatched.slice(start).find((entry) => entry.target === ceiling),
    ).toMatchObject({
      values: { power: true, brightness: 20, colorTemperature: 4000 },
    });
    expect(
      adapter.dispatched
        .slice(start)
        .every((entry) => entry.govee === undefined),
    ).toBe(true);
    expect(engine.state.lighting.devices[ceiling]?.govee).toBeUndefined();
  });

  it('reclaims an effect through an ordinary brightness adjustment and selects static white', async () => {
    const { engine, adapter } = fixture();
    await engine.activateScene('scene.ring', user);
    await engine.setLighting(ceiling, { brightness: 35 }, { actor: user });
    expect(engine.state.lighting.devices[ceiling]?.govee).toBeUndefined();
    expect(adapter.dispatched.at(-1)?.values).toMatchObject({
      brightness: 35,
      colorTemperature: 2700,
    });
    expect(adapter.dispatched.at(-1)?.govee).toBeUndefined();
  });

  it('observes moving colors without turning them into static overrides or replaying the effect', async () => {
    const { clock, engine, adapter } = fixture();
    await engine.activateScene('scene.ring', user);
    const before = structuredClone(
      engine.state.lighting.devices[ceiling]?.effectiveDesired,
    );
    const count = adapter.dispatched.length;
    adapter.externalChange(ceiling, {
      power: true,
      rgb: [100, 20, 30],
      brightness: 44,
    });
    adapter.externalChange(ceiling, { rgb: [20, 100, 30], brightness: 55 });
    clock.advanceBy(10_000);
    await flush();
    const device = engine.state.lighting.devices[ceiling]!;
    expect(device.observed.rgb).toEqual([20, 100, 30]);
    expect(device.effectiveDesired).toEqual(before);
    expect(
      Object.values(device.ownership).every((owner) => owner.kind === 'scene'),
    ).toBe(true);
    expect(
      adapter.dispatched
        .slice(count)
        .filter((entry) => entry.target === ceiling),
    ).toEqual([]);
  });

  it('suspends the exposed generation at confirmed exit, sends OFF, and resumes under a new generation', async () => {
    const { engine, adapter } = fixture();
    await presence(engine, 'occupied');
    await engine.activateScene('scene.ring', user);
    const originalId = engine.state.lighting.devices[ceiling]?.govee?.controlId;
    await presence(engine, 'confirmed_empty');
    expect(
      engine.state.lighting.devices[ceiling]?.govee?.controlId,
    ).toBeUndefined();
    expect(
      adapter.dispatched.filter((entry) => entry.target === ceiling).at(-1)
        ?.values,
    ).toEqual({ power: false });
    expect(
      engine.getLightingIntentSnapshot().devices[ceiling]?.govee?.effect,
    ).toBe('Aurora');
    await presence(engine, 'occupied');
    const resumed = engine.state.lighting.devices[ceiling]?.govee;
    expect(resumed?.controlId).toBeTypeOf('string');
    expect(resumed?.controlId).not.toBe(originalId);
    expect(resumed?.status).toBe('sent');
    expect(
      adapter.dispatched.filter((entry) => entry.target === ceiling).at(-1)
        ?.govee?.effect,
    ).toBe('Aurora');
  });

  it('keeps restored effect intent dormant until confirmed occupancy', async () => {
    const old = fixture();
    await old.engine.activateScene('scene.ring', user);
    const oldId = old.engine.state.lighting.devices[ceiling]?.govee?.controlId;
    const restored = fixture(
      {
        restoredLightingIntent: old.engine.getLightingIntentSnapshot(),
        preserveRestoredSceneIds: ['scene.ring'],
      },
      old.clock,
    );
    expect(restored.adapter.dispatched).toEqual([]);
    expect(
      restored.engine.state.lighting.devices[ceiling]?.govee?.controlId,
    ).toBeUndefined();
    expect(
      restored.engine.state.lighting.devices[ceiling]?.govee?.intent.effect,
    ).toBe('Aurora');
    await restored.engine.deviceBecameAvailable(ceiling);
    expect(restored.adapter.dispatched).toEqual([]);
    await presence(restored.engine, 'occupied');
    expect(
      restored.engine.state.lighting.devices[ceiling]?.govee?.controlId,
    ).toBeTypeOf('string');
    expect(
      restored.engine.state.lighting.devices[ceiling]?.govee?.controlId,
    ).not.toBe(oldId);
    expect(
      restored.adapter.dispatched.find((entry) => entry.target === ceiling)
        ?.govee?.effect,
    ).toBe('Aurora');
  });

  it('keeps a restored effect dormant when companion capabilities are unavailable', async () => {
    const old = fixture();
    await old.engine.activateScene('scene.ring', user);
    const unavailable = new SimulatedLightingAdapter(old.clock);
    const { engine } = fixture(
      {
        adapter: unavailable,
        restoredLightingIntent: old.engine.getLightingIntentSnapshot(),
        preserveRestoredSceneIds: ['scene.ring'],
      },
      old.clock,
    );
    expect(unavailable.dispatched).toEqual([]);
    // Failure may be explicit or represented in state, but cannot silently fall
    // back to a whole-fixture static ON for a saved ring-only effect.
    await presence(engine, 'occupied').catch(() => undefined);
    expect(
      unavailable.dispatched.filter((command) => command.values.power === true),
    ).toEqual([]);
    expect(engine.state.lighting.devices[ceiling]?.govee?.status).not.toBe(
      'sent',
    );
    expect(engine.state.lighting.devices[table]?.govee?.status).not.toBe(
      'sent',
    );
  });

  it.each([{ power: false }, { power: true, colorTemperature: 4000 }])(
    'does not replay an effect after a manual adjustment and restart: %j',
    async (values) => {
      const old = fixture();
      await old.engine.activateScene('scene.ring', user);
      await old.engine.setLighting(ceiling, values, { actor: user });
      const snapshot = old.engine.getLightingIntentSnapshot();
      expect(snapshot.devices[ceiling]?.govee).toBeNull();
      const restored = fixture(
        {
          restoredLightingIntent: snapshot,
          preserveRestoredSceneIds: ['scene.ring'],
        },
        old.clock,
      );
      await presence(restored.engine, 'occupied');
      expect(
        restored.engine.state.lighting.devices[ceiling]?.govee,
      ).toBeUndefined();
      expect(
        restored.adapter.dispatched
          .filter((entry) => entry.target === ceiling)
          .every((entry) => entry.govee === undefined),
      ).toBe(true);
      if (values.power === false)
        expect(restored.adapter.observed.get(ceiling)?.power).not.toBe(true);
    },
  );

  it('turns an externally observed whole-fixture OFF into a durable hold', async () => {
    const { engine, adapter } = fixture();
    await presence(engine, 'occupied');
    await engine.activateScene('scene.ring', user);
    adapter.externalChange(ceiling, { power: false });
    await flush();
    expect(engine.state.lighting.devices[ceiling]?.govee).toBeUndefined();
    expect(
      engine.getLightingIntentSnapshot().devices[ceiling]?.govee,
    ).toBeNull();
    expect(
      engine.getLightingIntentSnapshot().devices[ceiling]?.effectiveDesired
        .power,
    ).toBe(false);
    expect(engine.getLightingIntentSnapshot().activationHolds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: ceiling, intent: 'off' }),
      ]),
    );
  });

  it('retains an omitted effect target through a partial scene and restart', async () => {
    const old = fixture();
    await old.engine.activateScene('scene.ring', user);
    const id = old.engine.state.lighting.devices[ceiling]?.govee?.controlId;
    await old.engine.activateScene('scene.table', user);
    expect(
      old.engine.state.lighting.devices[ceiling]?.govee?.intent.effect,
    ).toBe('Aurora');
    expect(old.engine.state.lighting.devices[ceiling]?.govee?.controlId).toBe(
      id,
    );
    const restored = fixture(
      {
        restoredLightingIntent: old.engine.getLightingIntentSnapshot(),
        preserveRestoredSceneIds: ['scene.table'],
      },
      old.clock,
    );
    await presence(restored.engine, 'occupied');
    expect(
      restored.adapter.dispatched.find((entry) => entry.target === ceiling)
        ?.govee?.effect,
    ).toBe('Aurora');
  });

  it('preserves an omitted target generation while its effect dispatch is still in flight', async () => {
    const clock = new FakeClock(1000);
    const adapter = Object.assign(new SimulatedLightingAdapter(clock), {
      goveeCapabilities: capabilities,
    });
    const blocked = deferred();
    const entered = deferred();
    let captured: LightingCommand | undefined;
    const ordinaryDispatch = adapter.dispatch.bind(adapter);
    adapter.dispatch = async (command) => {
      if (command.target === ceiling && command.govee) {
        captured = command;
        entered.resolve();
        await blocked.promise;
      }
      await ordinaryDispatch(command);
    };
    const { engine } = fixture({ adapter }, clock);
    const first = engine.activateScene('scene.ring', user);
    await entered.promise;
    const originalId = engine.state.lighting.devices[ceiling]?.govee?.controlId;
    await engine.activateScene('scene.table', user);
    const guardSurvived = captured?.isCurrent?.();
    blocked.resolve();
    await first;
    expect(guardSurvived).toBe(true);
    expect(engine.state.lighting.devices[ceiling]?.govee?.controlId).toBe(
      originalId,
    );
    expect(engine.state.lighting.devices[ceiling]?.govee?.status).toBe('sent');
    expect(adapter.observed.get(ceiling)?.power).toBe(true);
  });

  it('applies window power and brightness policy to effects and static selection', async () => {
    const { engine, adapter } = fixture({
      windowLighting: {
        target: ceiling,
        presenceMode: 'always',
        brightness: 55,
        maxSunElevation: 6,
      },
    });
    await engine.handleSunElevation(-5);
    await engine.activateScene('scene.ring', user);
    expect(
      engine.state.lighting.devices[ceiling]?.effectiveDesired.brightness,
    ).toBe(55);
    const count = adapter.dispatched.length;
    await engine.handleSunElevation(15);
    expect(adapter.dispatched.slice(count).at(-1)).toMatchObject({
      target: ceiling,
      values: { power: false },
    });
    expect(engine.state.lighting.devices[ceiling]?.effectiveDesired.power).toBe(
      false,
    );
    await engine.activateScene('scene.white', user);
    expect(engine.state.lighting.devices[ceiling]?.govee).toBeUndefined();
    expect(engine.state.lighting.devices[ceiling]?.effectiveDesired.power).toBe(
      false,
    );
    await engine.handleSunElevation(-5);
    expect(
      engine.state.lighting.devices[ceiling]?.effectiveDesired,
    ).toMatchObject({ power: true, brightness: 55, colorTemperature: 4000 });
  });

  it('invalidates an in-flight effect guard immediately at confirmed exit', async () => {
    const clock = new FakeClock(1000);
    const adapter = Object.assign(new SimulatedLightingAdapter(clock), {
      goveeCapabilities: capabilities,
    });
    const blocked = deferred();
    const entered = deferred();
    let captured: LightingCommand | undefined;
    const ordinaryDispatch = adapter.dispatch.bind(adapter);
    adapter.dispatch = async (command) => {
      if (command.target === ceiling && command.govee) {
        captured = command;
        entered.resolve();
        await blocked.promise;
      }
      await ordinaryDispatch(command);
    };
    const { engine } = fixture({ adapter }, clock);
    await presence(engine, 'occupied');
    const first = engine.activateScene('scene.ring', user);
    await entered.promise;
    const exit = presence(engine, 'confirmed_empty');
    expect(captured?.isCurrent?.()).toBe(false);
    expect(
      engine.state.lighting.devices[ceiling]?.govee?.controlId,
    ).toBeUndefined();
    await exit;
    blocked.resolve();
    await first;
    expect(adapter.observed.get(ceiling)?.power).toBe(false);
  });

  it('invalidates a delayed effect dispatch guard before a newer static scene', async () => {
    const clock = new FakeClock(1000);
    const adapter = Object.assign(new SimulatedLightingAdapter(clock), {
      goveeCapabilities: capabilities,
    });
    const blocked = deferred();
    const entered = deferred();
    let captured: LightingCommand | undefined;
    const ordinaryDispatch = adapter.dispatch.bind(adapter);
    adapter.dispatch = async (command) => {
      if (command.target === ceiling && command.govee) {
        captured = command;
        entered.resolve();
        await blocked.promise;
      }
      await ordinaryDispatch(command);
    };
    const { engine } = fixture({ adapter }, clock);
    const first = engine.activateScene('scene.ring', user);
    await entered.promise;
    expect(captured?.isCurrent?.()).toBe(true);
    await engine.activateScene('scene.white', user);
    expect(captured?.isCurrent?.()).toBe(false);
    blocked.resolve();
    await first;
    expect(adapter.observed.get(ceiling)).toMatchObject({
      power: true,
      colorTemperature: 4000,
    });
    expect(engine.state.lighting.devices[ceiling]?.govee).toBeUndefined();
  });
});

it('clamps synchronized scene white independently for each model', async () => {
  const clock = new FakeClock(1000);
  const adapter = Object.assign(new SimulatedLightingAdapter(clock), {
    goveeCapabilities: {
      ...capabilities,
      [table]: {
        effects: ['Forest'],
        zones: false,
        colorTemperature: { min: 2000, max: 6500 },
      },
    },
  });
  const { engine } = fixture({ adapter }, clock);
  await engine.activateScene('scene.white', user);
  await engine.setLighting(table, { colorTemperature: 2200 }, { actor: user });
  expect(
    engine.state.lighting.devices[table]?.effectiveDesired.colorTemperature,
  ).toBe(2200);
  expect(
    engine.state.lighting.devices[ceiling]?.effectiveDesired.colorTemperature,
  ).toBe(2700);
  expect(
    adapter.dispatched.filter((command) => command.target === ceiling).at(-1)
      ?.values.colorTemperature,
  ).toBe(2700);
});
