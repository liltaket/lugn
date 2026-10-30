import { describe, expect, it } from 'vitest';
import { HomeAssistantLightingAdapter } from '../src/adapters/home-assistant-lighting.js';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import {
  LightingIntentSnapshotSchema,
  LightingValuesSchema,
  type LightingScene,
} from '../src/core/schemas.js';
import { lightingFeedbackMatches } from '../src/core/lighting-feedback.js';

const target = 'lighting.desk';
const user = { type: 'user' as const };
const party: LightingScene = {
  id: 'scene.party',
  name: 'Party',
  lighting: { [target]: { power: true, brightness: 40, rgb: [255, 30, 110] } },
};
function white(id = 'scene.everyday_light', power = true): LightingScene {
  return {
    id,
    name: id,
    lighting: {
      [target]: { power, brightness: power ? 55 : 0, colorTemperature: 3000 },
    },
  };
}
function setup(scenes = [party, white()]) {
  const clock = new FakeClock(1000);
  const adapter = new SimulatedLightingAdapter(clock);
  const engine = new LugnEngine(clock, {
    adapter,
    deviceIds: [target],
    scenes,
  });
  return { clock, adapter, engine };
}
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('explicit RGB lighting modes', () => {
  it('validates exclusive bounded RGB and compares channel values rather than references', () => {
    expect(LightingValuesSchema.safeParse({ rgb: [256, 0, 0] }).success).toBe(
      false,
    );
    expect(
      LightingValuesSchema.safeParse({ rgb: [1, 2, 3], colorTemperature: 2700 })
        .success,
    ).toBe(false);
    expect(lightingFeedbackMatches('rgb', [1, 2, 3], [1, 2, 3])).toBe(true);
    expect(lightingFeedbackMatches('rgb', [255, 30, 110], [254, 32, 108])).toBe(
      true,
    );
    expect(lightingFeedbackMatches('rgb', [1, 2, 3], [1, 2, 6])).toBe(false);
  });

  it.each(['scene.soft_light', 'scene.everyday_light', 'scene.focus_light'])(
    'restores white and removes all RGB intent when leaving Party for %s',
    async (id) => {
      const { engine, adapter } = setup([party, white(id)]);
      await engine.activateScene(party.id, user);
      expect(engine.state.commands.at(-1)?.status).toBe('confirmed');
      await engine.activateScene(id, user);
      expect(adapter.dispatched.at(-1)?.values).toEqual({
        brightness: 55,
        colorTemperature: 3000,
      });
      const device = engine.state.lighting.devices[target]!;
      expect(device.effectiveDesired.rgb).toBeUndefined();
      expect(device.baselineDesired.rgb).toBeUndefined();
      expect(device.observed.rgb).toBeUndefined();
      expect(device.ownership.rgb).toBeUndefined();
      engine.dispose();
    },
  );

  it('restores explicit white when a lamp excluded by the white scene is manually enabled', async () => {
    const { engine, adapter } = setup([
      party,
      white('scene.soft_light', false),
    ]);
    await engine.activateScene(party.id, user);
    await engine.activateScene('scene.soft_light', user);
    await engine.setLighting(target, { power: true }, { actor: user });
    expect(adapter.dispatched.at(-1)?.values).toEqual({
      power: true,
      colorTemperature: 3000,
    });
    expect(engine.state.lighting.devices[target]?.effectiveDesired).toEqual({
      power: true,
      colorTemperature: 3000,
    });
    expect(adapter.observed.get(target)?.rgb).toBeUndefined();
    engine.dispose();
  });

  it('uses configured white rather than remembered Party color after explicit all-off', async () => {
    const off: LightingScene = {
      id: 'scene.all_off',
      name: 'Off',
      lighting: { [target]: { power: false } },
    };
    const { engine, adapter } = setup([party, white(), off]);
    await engine.activateScene(party.id, user);
    await engine.activateScene(off.id, user);
    await engine.setLighting(target, { power: true }, { actor: user });
    expect(adapter.dispatched.at(-1)?.values).toEqual({
      power: true,
      colorTemperature: 3000,
    });
    engine.dispose();
  });

  it('gives manual RGB and CCT changes priority and carries the chosen mode on brightness corrections', async () => {
    const { engine, adapter } = setup();
    await engine.activateScene(white().id, user);
    await engine.setLighting(target, { rgb: [12, 34, 56] }, { actor: user });
    expect(
      engine.state.lighting.devices[target]?.effectiveDesired.colorTemperature,
    ).toBeUndefined();
    await engine.setLighting(target, { brightness: 30 }, { actor: user });
    adapter.externalChange(target, { brightness: 20 });
    await flush();
    expect(engine.state.lighting.devices[target]?.effectiveDesired.rgb).toEqual(
      [12, 34, 56],
    );
    await engine.setLighting(
      target,
      { colorTemperature: 4000 },
      { actor: user },
    );
    expect(
      engine.state.lighting.devices[target]?.effectiveDesired.rgb,
    ).toBeUndefined();
    expect(
      engine.state.lighting.devices[target]?.ownership.rgb,
    ).toBeUndefined();
    expect(
      engine.state.lighting.devices[target]?.effectiveDesired.colorTemperature,
    ).toBe(4000);
    adapter.externalChange(target, { rgb: [80, 90, 100] });
    await flush();
    expect(engine.state.lighting.devices[target]?.effectiveDesired.rgb).toEqual(
      [80, 90, 100],
    );
    expect(
      engine.state.lighting.devices[target]?.effectiveDesired.colorTemperature,
    ).toBeUndefined();
    engine.dispose();
  });

  it('abandons unavailable Party deliveries when white is selected before reconnect', async () => {
    const { engine, adapter, clock } = setup();
    adapter.available = false;
    await engine.activateScene(party.id, user);
    await engine.activateScene(white().id, user);
    const beforeReconnect = adapter.dispatched.length;
    adapter.available = true;
    await engine.deviceBecameAvailable(target);
    clock.advanceBy(5000);
    await flush();
    expect(adapter.dispatched.slice(beforeReconnect).length).toBeGreaterThan(0);
    expect(
      adapter.dispatched
        .slice(beforeReconnect)
        .every((command) => command.values.rgb === undefined),
    ).toBe(true);
    expect(adapter.observed.get(target)).toMatchObject({
      power: true,
      colorTemperature: 3000,
    });
    engine.dispose();
  });

  it.each(['rgb-to-white', 'white-to-rgb'])(
    'migrates scene-owned saved color modes without combining them (%s)',
    async (direction) => {
      const initial = direction === 'rgb-to-white' ? party : white();
      const replacement: LightingScene = {
        ...(direction === 'rgb-to-white' ? white() : party),
        id: initial.id,
      };
      const { engine } = setup([initial]);
      await engine.activateScene(initial.id, user);
      const restored = new LugnEngine(new FakeClock(2000), {
        deviceIds: [target],
        scenes: [replacement],
        restoredLightingIntent: engine.getLightingIntentSnapshot(),
      });
      expect(restored.state.lighting.devices[target]?.effectiveDesired).toEqual(
        replacement.lighting[target],
      );
      restored.dispose();
      engine.dispose();
    },
  );

  it.each([false, true])(
    'restores a manual RGB override of a white applied scene without injecting legacy Kelvin (saved edit %s)',
    async (edit) => {
      const { engine } = setup();
      await engine.activateScene(white().id, user);
      await engine.setLighting(target, { rgb: [12, 34, 56] }, { actor: user });
      const snapshot = LightingIntentSnapshotSchema.parse(
        JSON.parse(JSON.stringify(engine.getLightingIntentSnapshot())),
      );
      const edited = white();
      if (edit) edited.lighting[target] = { power: true, rgb: [100, 20, 40] };
      const restored = new LugnEngine(new FakeClock(2000), {
        deviceIds: [target],
        scenes: [party, edited],
        restoredLightingIntent: snapshot,
      });
      expect(
        restored.state.lighting.devices[target]?.effectiveDesired.rgb,
      ).toEqual([12, 34, 56]);
      expect(
        restored.state.lighting.devices[target]?.effectiveDesired
          .colorTemperature,
      ).toBeUndefined();
      expect(
        restored.state.lighting.devices[target]?.baselineDesired,
      ).toMatchObject(
        edit ? { rgb: [100, 20, 40] } : { colorTemperature: 3000 },
      );
      restored.dispose();
      engine.dispose();
    },
  );

  it('round-trips RGB ownership and scene through validated persisted intent', async () => {
    const { engine } = setup();
    await engine.activateScene(party.id, user);
    const snapshot = LightingIntentSnapshotSchema.parse(
      JSON.parse(JSON.stringify(engine.getLightingIntentSnapshot())),
    );
    const restored = new LugnEngine(new FakeClock(2000), {
      deviceIds: [target],
      scenes: [party, white()],
      restoredLightingIntent: snapshot,
    });
    expect(
      restored.state.lighting.devices[target]?.effectiveDesired.rgb,
    ).toEqual([255, 30, 110]);
    expect(
      restored.state.lighting.devices[target]?.effectiveDesired
        .colorTemperature,
    ).toBeUndefined();
    restored.dispose();
    engine.dispose();
  });
});

function haState(mode: string, supported = ['rgb', 'color_temp']) {
  return {
    entity_id: 'light.desk',
    new_state: {
      entity_id: 'light.desk',
      state: 'on',
      attributes: {
        brightness: 140,
        supported_color_modes: supported,
        color_mode: mode,
        rgb_color: [255, 30, 110],
        color_temp_kelvin: 3000,
      },
    },
  };
}
function haSetup(wled = false) {
  const clock = new FakeClock(1000);
  const requests: RequestInit[] = [];
  const adapter = new HomeAssistantLightingAdapter(
    {
      baseUrl: 'http://ha.test',
      token: 'test-only',
      entities: { [target]: 'light.desk' },
      ...(wled
        ? { wledCct: { [target]: { baseUrl: 'http://wled.test' } } }
        : {}),
    },
    async (_input, init) => {
      if (init) requests.push(init);
      return Response.json([]);
    },
    clock,
  );
  return { clock, requests, adapter };
}

describe('Home Assistant RGB mode safety', () => {
  it.each(['rgb', 'hs', 'xy'])(
    'sends RGB through confirmed %s capability and explicitly restores Kelvin',
    async (mode) => {
      const { adapter, requests } = haSetup();
      adapter.acceptStateChangedEvent(haState(mode, [mode, 'color_temp']));
      await adapter.dispatch({
        id: 'party',
        target,
        values: { power: true, rgb: [255, 30, 110] },
      });
      await adapter.dispatch({
        id: 'white',
        target,
        values: { power: true, colorTemperature: 3000 },
      });
      expect(JSON.parse(String(requests[0]?.body))).toEqual({
        entity_id: 'light.desk',
        rgb_color: [255, 30, 110],
      });
      expect(JSON.parse(String(requests[1]?.body))).toEqual({
        entity_id: 'light.desk',
        color_temp_kelvin: 3000,
      });
    },
  );

  it('rejects unknown, CCT-only and dedicated WLED RGB requests without transport', async () => {
    for (const kind of ['unknown', 'cct', 'wled']) {
      const { adapter, requests } = haSetup(kind === 'wled');
      if (kind === 'cct')
        adapter.acceptStateChangedEvent(haState('color_temp', ['color_temp']));
      await expect(
        adapter.dispatch({ id: kind, target, values: { rgb: [1, 2, 3] } }),
      ).rejects.toThrow();
      expect(requests).toEqual([]);
    }
  });

  it('does not confirm a white request using cached Kelvin while the actual mode remains RGB', async () => {
    const { adapter, clock, requests } = haSetup();
    const engine = new LugnEngine(clock, {
      adapter,
      deviceIds: [target],
      scenes: [party, white()],
    });
    adapter.acceptStateChangedEvent(haState('rgb'));
    await engine.activateScene(white().id, user);
    expect(JSON.parse(String(requests.at(-1)?.body))).toMatchObject({
      color_temp_kelvin: 3000,
    });
    adapter.acceptStateChangedEvent(haState('rgb'));
    expect(
      engine.state.lighting.devices[target]?.observed.colorTemperature,
    ).toBeUndefined();
    expect(engine.state.commands.at(-1)?.confirmedProperties).not.toContain(
      'colorTemperature',
    );
    adapter.acceptStateChangedEvent(haState('color_temp'));
    expect(engine.state.lighting.devices[target]?.observed.rgb).toBeUndefined();
    expect(engine.state.commands.at(-1)?.status).toBe('confirmed');
    engine.dispose();
  });
});
