import { afterEach, describe, expect, it } from 'vitest';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import type { LightingScene } from '../src/core/schemas.js';

const engines: LugnEngine[] = [];
afterEach(() => engines.splice(0).forEach((engine) => engine.dispose()));
const targets = ['lighting.ceiling', 'lighting.desk'];
const full: LightingScene = {
  id: 'scene.full',
  name: 'Full',
  lighting: {
    'lighting.ceiling': { power: true, brightness: 60, colorTemperature: 2700 },
    'lighting.desk': { power: true, brightness: 20, colorTemperature: 2700 },
  },
};
const partial: LightingScene = {
  id: 'scene.partial',
  name: 'Desk only',
  lighting: {
    'lighting.desk': { power: true, brightness: 80, colorTemperature: 4000 },
  },
};
const off: LightingScene = {
  id: 'scene.all_off',
  name: 'Off',
  lighting: Object.fromEntries(targets.map((id) => [id, { power: false }])),
};
function setup() {
  const clock = new FakeClock(Date.parse('2026-10-04T12:00:00+02:00'));
  const adapter = new SimulatedLightingAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: targets,
    adapter,
    scenes: [full, partial, off],
    defaultSceneId: full.id,
  });
  engines.push(engine);
  return { clock, adapter, engine };
}
async function presence(
  engine: LugnEngine,
  state: 'occupied' | 'confirmed_empty',
) {
  await engine.handlePresence({ type: 'presence.changed', presence: state });
}

describe('preset intent boundaries', () => {
  it.each(['legacy', 'save-crash', 'current'])(
    'saving an active managed preset does not apply its edits after %s restart',
    async (mode) => {
      const { engine, clock } = setup();
      await engine.activateScene(full.id, { type: 'user' });
      const beforeSave = engine.getLightingIntentSnapshot();
      const edited = {
        ...full,
        lighting: {
          'lighting.ceiling': {
            power: true,
            brightness: 80,
            colorTemperature: 4000,
          },
          'lighting.desk': {
            power: true,
            brightness: 80,
            colorTemperature: 4000,
          },
        },
      };
      engine.saveSceneDefinition(edited);
      const snapshot =
        mode === 'current' ? engine.getLightingIntentSnapshot() : beforeSave;
      if (mode === 'legacy') delete snapshot.appliedScene;
      const adapter = new SimulatedLightingAdapter(clock);
      const restored = new LugnEngine(clock, {
        deviceIds: targets,
        scenes: [edited, partial, off],
        adapter,
        restoredLightingIntent: snapshot,
        preserveRestoredSceneIds: [full.id],
      });
      engines.push(restored);
      expect(
        restored.state.lighting.devices['lighting.ceiling']?.effectiveDesired,
      ).toEqual(full.lighting['lighting.ceiling']);
      expect(adapter.dispatched).toHaveLength(0);
      await presence(restored, 'occupied');
      expect(
        adapter.dispatched.find(
          (command) => command.target === 'lighting.ceiling',
        )?.values,
      ).toEqual(full.lighting['lighting.ceiling']);
      await restored.reapplyScene({ type: 'user' });
      expect(
        restored.state.lighting.devices['lighting.ceiling']?.effectiveDesired,
      ).toEqual(edited.lighting['lighting.ceiling']);
    },
  );

  it('keeps existing configuration preset migration for unmanaged IDs', async () => {
    const { engine, clock } = setup();
    await engine.activateScene(full.id, { type: 'user' });
    const edited = {
      ...full,
      lighting: {
        'lighting.ceiling': {
          power: true,
          brightness: 80,
          colorTemperature: 4000,
        },
      },
    };
    const restored = new LugnEngine(clock, {
      deviceIds: targets,
      scenes: [edited, off],
      restoredLightingIntent: engine.getLightingIntentSnapshot(),
    });
    engines.push(restored);
    expect(
      restored.state.lighting.devices['lighting.ceiling']?.effectiveDesired,
    ).toEqual(edited.lighting['lighting.ceiling']);
  });

  it('carries omitted scene intent through a partial activation, restart and return', async () => {
    const { engine, adapter, clock } = setup();
    await engine.activateScene(full.id, { type: 'user' });
    const count = adapter.dispatched.length;
    const revision = await engine.activateScene(partial.id, { type: 'user' });
    expect(
      engine.state.lighting.devices['lighting.ceiling']?.effectiveDesired,
    ).toEqual(full.lighting['lighting.ceiling']);
    expect(
      engine.state.lighting.devices['lighting.ceiling']?.ownership.brightness,
    ).toEqual({ kind: 'scene', revision });
    expect(
      adapter.dispatched
        .slice(count)
        .some((command) => command.target === 'lighting.ceiling'),
    ).toBe(false);
    await presence(engine, 'confirmed_empty');
    await presence(engine, 'occupied');
    expect(adapter.observed.get('lighting.ceiling')).toEqual(
      full.lighting['lighting.ceiling'],
    );
    const restoredAdapter = new SimulatedLightingAdapter(clock);
    const restored = new LugnEngine(clock, {
      deviceIds: targets,
      scenes: [full, partial, off],
      adapter: restoredAdapter,
      restoredLightingIntent: engine.getLightingIntentSnapshot(),
      preserveRestoredSceneIds: [partial.id],
    });
    engines.push(restored);
    await presence(restored, 'occupied');
    expect(restoredAdapter.observed.get('lighting.ceiling')).toEqual(
      full.lighting['lighting.ceiling'],
    );
  });

  it('keeps omitted manual ownership and off activation holds across partial activation and restart', async () => {
    const { engine, clock } = setup();
    await engine.activateScene(off.id, { type: 'user', id: 'manual-off' });
    const ceilingHold = engine
      .getLightingIntentSnapshot()
      .activationHolds?.find(
        (hold) =>
          hold.target === 'lighting.ceiling' &&
          hold.scope === 'lighting.activation',
      );
    await engine.setLighting(
      'lighting.ceiling',
      { brightness: 37 },
      { actor: { type: 'user', id: 'manual-level' }, source: 'test' },
    );
    const original = structuredClone(
      engine.state.lighting.devices['lighting.ceiling'],
    );
    await engine.activateScene(partial.id, { type: 'user' });
    expect(
      engine.state.lighting.devices['lighting.ceiling']?.effectiveDesired,
    ).toEqual(original?.effectiveDesired);
    expect(
      engine.state.lighting.devices['lighting.ceiling']?.ownership.brightness,
    ).toEqual(original?.ownership.brightness);
    expect(
      engine.state.intent.holds.find(
        (hold) =>
          hold.target === 'lighting.ceiling' &&
          hold.scope === 'lighting.activation',
      ),
    ).toMatchObject(ceilingHold!);
    expect(
      engine.state.intent.holds.some(
        (hold) =>
          hold.target === 'lighting.desk' &&
          hold.scope === 'lighting.activation',
      ),
    ).toBe(false);
    const restored = new LugnEngine(clock, {
      deviceIds: targets,
      scenes: [full, partial, off],
      restoredLightingIntent: engine.getLightingIntentSnapshot(),
      preserveRestoredSceneIds: [partial.id],
    });
    engines.push(restored);
    expect(
      restored.state.intent.holds.find(
        (hold) =>
          hold.target === 'lighting.ceiling' &&
          hold.scope === 'lighting.activation',
      ),
    ).toMatchObject(ceilingHold!);
    await presence(restored, 'occupied');
    expect(
      restored.state.lighting.devices['lighting.ceiling']?.effectiveDesired
        .power,
    ).toBe(false);
    await restored.activateScene(off.id, { type: 'user' });
    expect(
      Object.values(restored.state.lighting.devices).every(
        (device) => device.effectiveDesired.power === false,
      ),
    ).toBe(true);
  });

  it('does not turn omitted remembered lights on when activating a partial preset in an empty room', async () => {
    const { engine, adapter, clock } = setup();
    await engine.activateScene(full.id, { type: 'user' });
    await presence(engine, 'confirmed_empty');
    const count = adapter.dispatched.length;
    await engine.activateScene(partial.id, { type: 'user' });
    clock.advanceBy(10_000);
    await Promise.resolve();
    expect(
      adapter.dispatched
        .slice(count)
        .some(
          (command) =>
            command.target === 'lighting.ceiling' &&
            command.values.power === true,
        ),
    ).toBe(false);
    expect(adapter.observed.get('lighting.ceiling')?.power).toBe(false);
    expect(
      engine.state.lighting.devices['lighting.ceiling']?.effectiveDesired,
    ).toEqual(full.lighting['lighting.ceiling']);
    await presence(engine, 'occupied');
    expect(adapter.observed.get('lighting.ceiling')).toEqual(
      full.lighting['lighting.ceiling'],
    );
  });
});
