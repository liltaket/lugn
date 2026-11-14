import { describe, expect, it } from 'vitest';
import {
  LightingDeliveryUnknownError,
  SimulatedLightingAdapter,
} from '../src/adapters/simulated-lighting.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';

const user = { type: 'user' as const, id: 'test' };
function setup() {
  const clock = new FakeClock(1000);
  const adapter = new SimulatedLightingAdapter(clock);
  const engine = new LugnEngine(clock, {
    adapter,
    defaultSceneId: 'scene.cozy',
  });
  return { clock, adapter, engine };
}
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

describe('explicit external lighting ownership', () => {
  it('keeps effect frames out of desired values and preserves other lamps and durable intent', async () => {
    const { clock, adapter, engine } = setup();
    try {
      await engine.activateScene('scene.cozy', user);
      const target = 'lighting.desk';
      const saved = engine.getLightingIntentSnapshot().devices[target];
      const other = structuredClone(
        engine.state.lighting.devices['lighting.ceiling'],
      );
      await engine.beginExternalLightingControl(target, user, 'govee');
      const count = adapter.dispatched.length;
      adapter.externalChange(target, {
        power: true,
        rgb: [10, 20, 30],
        brightness: 44,
      });
      adapter.externalChange(target, {
        colorTemperature: 4000,
      });
      clock.advanceBy(20000);
      await flush();
      const device = engine.state.lighting.devices[target]!;
      expect(device.externalControl?.source).toBe('govee');
      expect(device.effectiveDesired).toEqual({ power: true });
      expect(device.observed.brightness).toBe(44);
      expect(
        adapter.dispatched.slice(count).filter((c) => c.target === target),
      ).toEqual([]);
      expect(engine.state.lighting.devices['lighting.ceiling']).toEqual(other);
      expect(engine.getLightingIntentSnapshot().devices[target]).toEqual(saved);
    } finally {
      engine.dispose();
    }
  });

  it('ends ownership on explicit adjustment, scene selection and explicit resume', async () => {
    const { adapter, engine } = setup();
    try {
      await engine.activateScene('scene.cozy', user);
      await engine.beginExternalLightingControl('lighting.desk', user);
      await engine.setLighting(
        'lighting.desk',
        { brightness: 20 },
        { actor: user },
      );
      expect(
        engine.state.lighting.devices['lighting.desk']?.externalControl,
      ).toBeUndefined();
      expect(
        engine.state.lighting.devices['lighting.desk']?.effectiveDesired
          .brightness,
      ).toBe(20);
      await engine.beginExternalLightingControl('lighting.desk', user);
      await engine.endExternalLightingControl('lighting.desk', user);
      expect(
        engine.state.lighting.devices['lighting.desk']?.externalControl,
      ).toBeUndefined();
      await engine.beginExternalLightingControl('lighting.desk', user);
      await engine.activateScene('scene.cozy', user);
      expect(
        engine.state.lighting.devices['lighting.desk']?.externalControl,
      ).toBeUndefined();
      expect(adapter.observed.get('lighting.desk')?.power).toBe(true);
    } finally {
      engine.dispose();
    }
  });

  it('allows manual effects while empty but switches off at the next confirmed exit', async () => {
    const { adapter, engine } = setup();
    try {
      await engine.handlePresence({
        type: 'presence.changed',
        presence: 'confirmed_empty',
      });
      await engine.beginExternalLightingControl('lighting.desk', user);
      expect(adapter.observed.get('lighting.desk')?.power).toBe(true);
      await engine.handlePresence({
        type: 'presence.changed',
        presence: 'occupied',
      });
      await engine.handlePresence({
        type: 'presence.changed',
        presence: 'confirmed_empty',
      });
      await flush();
      expect(adapter.observed.get('lighting.desk')?.power).toBe(false);
    } finally {
      engine.dispose();
    }
  });

  it('does not broaden another target temperature change into the external lamp', async () => {
    const { adapter, engine } = setup();
    try {
      await engine.activateScene('scene.cozy', user);
      await engine.beginExternalLightingControl('lighting.desk', user);
      const start = adapter.dispatched.length;
      const other = Object.keys(engine.state.lighting.devices).find(
        (t) =>
          t !== 'lighting.desk' &&
          engine.state.lighting.devices[t]?.effectiveDesired
            .colorTemperature !== undefined,
      )!;
      await engine.setLighting(
        other,
        { colorTemperature: 3300 },
        { actor: user },
      );
      expect(
        adapter.dispatched
          .slice(start)
          .filter((c) => c.target === 'lighting.desk'),
      ).toEqual([]);
      expect(
        engine.state.lighting.devices['lighting.desk']?.externalControl,
      ).toBeDefined();
    } finally {
      engine.dispose();
    }
  });

  it('requires a human actor and validates the target through capabilities', async () => {
    const { engine } = setup();
    try {
      const capabilities = new CapabilityRegistry(engine);
      await expect(
        capabilities.invoke(
          'lighting.beginExternalControl',
          { target: 'lighting.desk' },
          { actor: { type: 'automation' } },
        ),
      ).rejects.toThrow('human_actor_required');
      await expect(
        capabilities.invoke(
          'lighting.beginExternalControl',
          { target: 'lighting.unknown' },
          { actor: user },
        ),
      ).rejects.toThrow('target_not_configured');
      await capabilities.invoke(
        'lighting.beginExternalControl',
        { target: 'lighting.desk' },
        { actor: user },
      );
      expect(
        engine.state.lighting.devices['lighting.desk']?.externalControl,
      ).toBeDefined();
    } finally {
      engine.dispose();
    }
  });
  it('waits for an older transport before acknowledging a control generation', async () => {
    const { clock, adapter, engine } = setup();
    try {
      adapter.feedbackDelayMs = 500;
      const scene = engine.activateScene('scene.cozy', user);
      await flush();
      let acknowledged = false;
      const handoff = engine
        .beginExternalLightingControl('lighting.desk', user)
        .then((id) => {
          acknowledged = true;
          return id;
        });
      await flush();
      expect(acknowledged).toBe(false);
      adapter.feedbackDelayMs = 0;
      clock.advanceBy(500);
      await scene;
      const id = await handoff;
      expect(
        engine.state.lighting.devices['lighting.desk']?.externalControl?.id,
      ).toBe(id);
      expect(
        engine.state.lighting.devices['lighting.desk']?.effectiveDesired,
      ).toEqual({ power: true });
      await engine.setLighting(
        'lighting.desk',
        { brightness: 42 },
        { actor: user },
      );
      await expect(
        engine.endExternalLightingControl('lighting.desk', user, id),
      ).rejects.toThrow('superseded');
      expect(
        engine.state.lighting.devices['lighting.desk']?.effectiveDesired
          .brightness,
      ).toBe(42);
    } finally {
      engine.dispose();
    }
  });

  it('fails a handoff whose prior transport does not settle within ten seconds', async () => {
    const { clock, adapter, engine } = setup();
    try {
      adapter.feedbackDelayMs = 20000;
      const scene = engine.activateScene('scene.cozy', user);
      await flush();
      const saved = engine.getLightingIntentSnapshot().devices['lighting.desk'];
      const handoff = engine.beginExternalLightingControl(
        'lighting.desk',
        user,
      );
      const rejected = expect(handoff).rejects.toThrow('drain timed out');
      await flush();
      clock.advanceBy(10000);
      await rejected;
      expect(
        engine.state.lighting.devices['lighting.desk']?.externalControl,
      ).toBeUndefined();
      expect(
        engine.state.lighting.devices['lighting.desk']?.effectiveDesired,
      ).toEqual(saved?.effectiveDesired);
      expect(
        engine.getLightingIntentSnapshot().devices['lighting.desk'],
      ).toEqual(saved);
      clock.advanceBy(10000);
      await scene;
    } finally {
      engine.dispose();
    }
  });
  it('preserves external ownership through an automatic non-off scene', async () => {
    const { adapter, engine } = setup();
    try {
      await engine.beginExternalLightingControl('lighting.desk', user);
      const count = adapter.dispatched.length;
      await engine.activateScene('scene.cozy', {
        type: 'automation',
        id: 'test',
      });
      expect(
        engine.state.lighting.devices['lighting.desk']?.externalControl,
      ).toBeDefined();
      expect(
        adapter.dispatched
          .slice(count)
          .filter((command) => command.target === 'lighting.desk'),
      ).toEqual([]);
    } finally {
      engine.dispose();
    }
  });
  it('does not leave a late handoff ON after a confirmed exit', async () => {
    const { clock, adapter, engine } = setup();
    try {
      await engine.handlePresence({
        type: 'presence.changed',
        presence: 'occupied',
      });
      adapter.feedbackDelayMs = 500;
      const handoff = engine.beginExternalLightingControl(
        'lighting.desk',
        user,
      );
      const rejected = expect(handoff).rejects.toThrow('confirmed exit');
      await flush();
      adapter.feedbackDelayMs = 0;
      await engine.handlePresence({
        type: 'presence.changed',
        presence: 'confirmed_empty',
      });
      clock.advanceBy(500);
      await rejected;
      expect(adapter.observed.get('lighting.desk')?.power).toBe(false);
    } finally {
      engine.dispose();
    }
  });
  it('resumes the exact pre-effect overrides and repeated resume does not reset them', async () => {
    const { adapter, engine } = setup();
    try {
      await engine.activateScene('scene.cozy', user);
      await engine.setLighting(
        'lighting.desk',
        { power: true, brightness: 17, rgb: [7, 8, 9] },
        { actor: user },
        undefined,
        'target',
      );
      const saved = structuredClone(
        engine.state.lighting.devices['lighting.desk'],
      );
      const id = await engine.beginExternalLightingControl(
        'lighting.desk',
        user,
      );
      adapter.externalChange('lighting.desk', {
        rgb: [90, 80, 70],
        brightness: 80,
      });
      await engine.endExternalLightingControl('lighting.desk', user, id);
      expect(
        engine.state.lighting.devices['lighting.desk']?.effectiveDesired,
      ).toEqual(saved?.effectiveDesired);
      expect(engine.state.lighting.devices['lighting.desk']?.ownership).toEqual(
        saved?.ownership,
      );
      const count = adapter.dispatched.length;
      await engine.endExternalLightingControl('lighting.desk', user);
      expect(adapter.dispatched).toHaveLength(count);
      expect(
        engine.state.lighting.devices['lighting.desk']?.effectiveDesired,
      ).toEqual(saved?.effectiveDesired);
    } finally {
      engine.dispose();
    }
  });
  it('preserves explicit OFF activation holds in the durable snapshot and after resume', async () => {
    const clock = new FakeClock(1000);
    const adapter = new SimulatedLightingAdapter(clock);
    const engine = new LugnEngine(clock, {
      adapter,
      defaultSceneId: 'scene.cozy',
      scenes: [
        {
          id: 'scene.cozy',
          name: 'Cozy',
          lighting: { 'lighting.desk': { power: true, brightness: 50 } },
        },
        {
          id: 'scene.all_off',
          name: 'Off',
          lighting: { 'lighting.desk': { power: false } },
        },
      ],
    });
    try {
      await engine.activateScene('scene.all_off', user);
      const saved = engine.getLightingIntentSnapshot();
      expect(saved.activationHolds).toHaveLength(1);
      const id = await engine.beginExternalLightingControl(
        'lighting.desk',
        user,
      );
      expect(engine.getLightingIntentSnapshot()).toEqual(saved);
      await engine.endExternalLightingControl('lighting.desk', user, id);
      expect(engine.getLightingIntentSnapshot()).toEqual(saved);
      expect(adapter.observed.get('lighting.desk')?.power).toBe(false);
      await expect(
        engine.activateScene('scene.cozy', { type: 'automation' }),
      ).rejects.toThrow('held');
    } finally {
      engine.dispose();
    }
  });
  it.each(['failed', 'unknown'])(
    'rolls back when the handoff power delivery is %s',
    async (outcome) => {
      const { adapter, engine } = setup();
      try {
        await engine.activateScene('scene.cozy', user);
        await engine.setLighting(
          'lighting.desk',
          { brightness: 19 },
          { actor: user },
        );
        const saved = engine.getLightingIntentSnapshot();
        if (outcome === 'failed') adapter.available = false;
        else
          adapter.dispatch = async () => {
            throw new LightingDeliveryUnknownError(
              'No delivery acknowledgement',
            );
          };
        await expect(
          engine.beginExternalLightingControl('lighting.desk', user),
        ).rejects.toThrow('not accepted');
        expect(
          engine.state.lighting.devices['lighting.desk']?.externalControl,
        ).toBeUndefined();
        expect(engine.getLightingIntentSnapshot()).toEqual(saved);
        expect(
          engine.state.lighting.devices['lighting.desk']?.effectiveDesired
            .brightness,
        ).toBe(19);
      } finally {
        engine.dispose();
      }
    },
  );
  it('restores physical OFF when a handoff ON applied but its acknowledgement was lost', async () => {
    const { adapter, engine } = setup();
    try {
      await engine.setLighting(
        'lighting.desk',
        { power: false },
        { actor: user },
      );
      let physicalPower = false;
      const dispatch = adapter.dispatch.bind(adapter);
      let lost = true;
      adapter.dispatch = async (command) => {
        if (command.values.power !== undefined)
          physicalPower = command.values.power;
        if (lost && command.values.power === true) {
          lost = false;
          throw new LightingDeliveryUnknownError(
            'Applied ON but lost acknowledgement',
          );
        }
        return dispatch(command);
      };
      await expect(
        engine.beginExternalLightingControl('lighting.desk', user),
      ).rejects.toThrow('not accepted');
      expect(physicalPower).toBe(false);
      expect(
        engine.state.lighting.devices['lighting.desk']?.externalControl,
      ).toBeUndefined();
      expect(adapter.dispatched.at(-1)?.values).toEqual({ power: false });
    } finally {
      engine.dispose();
    }
  });
  it('hands a window strip to effects without daylight or automatic scenes overwriting it', async () => {
    const clock = new FakeClock(1000);
    const adapter = new SimulatedLightingAdapter(clock);
    const engine = new LugnEngine(clock, {
      adapter,
      defaultSceneId: 'scene.cozy',
      windowLighting: {
        target: 'lighting.desk',
        presenceMode: 'always',
        brightness: 55,
        maxSunElevation: 6,
      },
    });
    try {
      await engine.handlePresence({
        type: 'presence.changed',
        presence: 'occupied',
        personCount: 1,
      });
      await engine.handleSunElevation(-10);
      await engine.activateScene('scene.cozy', user);
      await engine.beginExternalLightingControl('lighting.desk', user, 'govee');
      const count = adapter.dispatched.length;
      await engine.handleSunElevation(20);
      await engine.activateScene('scene.cozy', { type: 'automation' });
      expect(
        engine.state.lighting.devices['lighting.desk']?.externalControl,
      ).toBeDefined();
      expect(
        engine.state.lighting.devices['lighting.desk']?.effectiveDesired,
      ).toEqual({ power: true });
      expect(
        adapter.dispatched
          .slice(count)
          .filter((c) => c.target === 'lighting.desk'),
      ).toEqual([]);
      await engine.handlePresence({
        type: 'presence.changed',
        presence: 'confirmed_empty',
        personCount: 0,
      });
      expect(adapter.observed.get('lighting.desk')?.power).toBe(false);
      await engine.activateScene('scene.cozy', user);
      expect(
        engine.state.lighting.devices['lighting.desk']?.externalControl,
      ).toBeUndefined();
      await engine.handleSunElevation(-10);
      expect(
        engine.state.lighting.devices['lighting.desk']?.effectiveDesired
          .brightness,
      ).toBe(55);
    } finally {
      engine.dispose();
    }
  });
  it('reasserts restored OFF on resume before HA has reported the effect power', async () => {
    const { adapter, engine } = setup();
    try {
      await engine.setLighting(
        'lighting.desk',
        { power: false },
        { actor: user },
      );
      const commands: boolean[] = [];
      adapter.dispatch = async (command) => {
        if (command.values.power !== undefined)
          commands.push(command.values.power);
        // HA service acceptance can precede its next state observation.
      };
      const id = await engine.beginExternalLightingControl(
        'lighting.desk',
        user,
      );
      expect(
        engine.state.lighting.devices['lighting.desk']?.observed.power,
      ).toBe(false);
      await engine.endExternalLightingControl('lighting.desk', user, id);
      expect(commands).toEqual([true, false]);
    } finally {
      engine.dispose();
    }
  });
  it('ends a manually activated effect while already empty with a physical OFF', async () => {
    const { adapter, engine } = setup();
    try {
      await engine.handlePresence({
        type: 'presence.changed',
        presence: 'occupied',
        personCount: 1,
      });
      await engine.activateScene('scene.cozy', user);
      await engine.handlePresence({
        type: 'presence.changed',
        presence: 'confirmed_empty',
        personCount: 0,
      });
      const id = await engine.beginExternalLightingControl(
        'lighting.desk',
        user,
      );
      expect(adapter.observed.get('lighting.desk')?.power).toBe(true);
      await engine.endExternalLightingControl('lighting.desk', user, id);
      expect(adapter.observed.get('lighting.desk')?.power).toBe(false);
      expect(
        engine.state.lighting.devices['lighting.desk']?.effectiveDesired.power,
      ).toBe(true);
    } finally {
      engine.dispose();
    }
  });
  it('hands off a fixture without global power when a zone controller owns activation', async () => {
    const { adapter, engine } = setup();
    try {
      await engine.setLighting(
        'lighting.desk',
        { power: false },
        { actor: user },
      );
      const before = adapter.dispatched.length;
      const registry = new CapabilityRegistry(engine);
      const result = await registry.invoke(
        'lighting.beginExternalControl',
        { target: 'lighting.desk', activate: false },
        { actor: user, source: 'zone-test' },
      );
      expect(result).toMatchObject({
        accepted: true,
        controlId: expect.any(String),
      });
      expect(adapter.dispatched).toHaveLength(before);
      expect(adapter.observed.get('lighting.desk')?.power).toBe(false);
      expect(
        engine.state.lighting.devices['lighting.desk']?.externalControl,
      ).toBeDefined();
      adapter.externalChange('lighting.desk', {
        power: true,
        rgb: [0, 10, 100],
      });
      expect(
        engine.state.lighting.devices['lighting.desk']?.effectiveDesired,
      ).toEqual({ power: true });
      expect(adapter.dispatched).toHaveLength(before);
      await engine.handlePresence({
        type: 'presence.changed',
        presence: 'occupied',
        personCount: 1,
      });
      await engine.handlePresence({
        type: 'presence.changed',
        presence: 'confirmed_empty',
        personCount: 0,
      });
      expect(adapter.observed.get('lighting.desk')?.power).toBe(false);
    } finally {
      engine.dispose();
    }
  });
  it('remembers a whole-fixture external OFF during an effect instead of restoring its old ON after restart', async () => {
    const { adapter, engine } = setup();
    try {
      await engine.activateScene('scene.cozy', user);
      await engine.beginExternalLightingControl('lighting.desk', user);
      adapter.externalChange('lighting.desk', { power: false });
      const device = engine.state.lighting.devices['lighting.desk'];
      expect(device?.externalControl).toBeUndefined();
      expect(device?.effectiveDesired.power).toBe(false);
      const saved = engine.getLightingIntentSnapshot();
      expect(saved.devices['lighting.desk']?.effectiveDesired.power).toBe(
        false,
      );
      expect(
        saved.activationHolds?.some((h) => h.target === 'lighting.desk'),
      ).toBe(true);
    } finally {
      engine.dispose();
    }
  });
});
