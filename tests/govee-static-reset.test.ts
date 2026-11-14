import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  GoveePresetLightingAdapter,
  GoveeSocketClient,
} from '../src/adapters/govee-preset-lighting.js';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import { startGoveeControlServer } from '../src/runtime/govee-control-server.js';

const target = 'lighting.desk';
const user = { type: 'user' as const };
const caps = {
  [target]: {
    effects: ['Party'],
    zones: false,
    staticColor: true,
    colorTemperature: { min: 2700, max: 6500 },
  },
};
const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'govee-static-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const clock = new FakeClock(1000);
  const ordinary = new SimulatedLightingAdapter(clock);
  // Reproduce H600D: Matter reports white correctly but leaves the vendor scene running.
  const physical = { mode: 'Party' };
  const requests: unknown[] = [];
  const entered = gate(),
    blocked = gate();
  let blockNext = false;
  const server = await startGoveeControlServer({
    socketPath: join(dir, 'control.sock'),
    capabilities: () => caps,
    owns: (id, controlId) => {
      const d = engine.state.lighting.devices[id];
      return (
        !!d &&
        !d.externalControl &&
        d.effectiveDesired.power === true &&
        (d.govee?.controlId === controlId ||
          (!d.govee && d.goveeStaticControlId === controlId))
      );
    },
    apply: async (request, guard) => {
      requests.push(request);
      if (request.staticColor && blockNext) {
        blockNext = false;
        entered.release();
        await blocked.promise;
      }
      await guard();
      if (request.effect) physical.mode = request.effect;
      if (request.staticColor)
        physical.mode = request.staticColor.rgb
          ? 'rgb:' + request.staticColor.rgb.join(',')
          : 'white:' + request.staticColor.colorTemperature;
      return {
        transport: 'platform',
        ...(request.effect ? { effect: 'cloud_accepted' } : {}),
        ...(request.staticColor ? { staticColor: 'cloud_accepted' } : {}),
      };
    },
  });
  cleanups.push(() => server.stop());
  const adapter = new GoveePresetLightingAdapter(
    ordinary,
    new GoveeSocketClient(server.socketPath),
    caps,
  );
  const engine = new LugnEngine(clock, {
    adapter,
    deviceIds: [target],
    scenes: [
      {
        id: 'scene.party',
        name: 'Party',
        lighting: { [target]: { power: true, brightness: 35 } },
        govee: { [target]: { effect: 'Party' } },
      },
      {
        id: 'scene.focus',
        name: 'Focus',
        lighting: {
          [target]: { power: true, brightness: 100, colorTemperature: 4000 },
        },
      },
      {
        id: 'scene.off',
        name: 'Off',
        lighting: { [target]: { power: false } },
      },
    ],
  });
  cleanups.push(() => engine.dispose());
  await engine.handlePresence({
    type: 'presence.changed',
    presence: 'occupied',
  });
  return {
    engine,
    ordinary,
    physical,
    requests,
    entered,
    blocked,
    block: () => {
      blockNext = true;
    },
  };
}

it('clears the vendor scene through the real socket on Party -> Focus, after Matter baseline', async () => {
  const f = await fixture();
  await f.engine.activateScene('scene.party', user);
  expect(f.physical.mode).toBe('Party');
  await f.engine.activateScene('scene.focus', user);
  expect(f.ordinary.observed.get(target)).toMatchObject({
    power: true,
    brightness: 100,
    colorTemperature: 4000,
  });
  expect(f.physical.mode).toBe('white:4000');
  expect(f.requests.at(-1)).toMatchObject({
    staticColor: { colorTemperature: 4000 },
  });
  expect(f.engine.state.lighting.devices[target]?.govee).toBeUndefined();
  const id = f.engine.state.lighting.devices[target]?.goveeStaticControlId;
  expect(id).toBeTruthy();
  expect(JSON.stringify(f.engine.getLightingIntentSnapshot())).not.toContain(
    id!,
  );
});

it('resets retained firmware scenes with no in-memory history, including OFF -> Focus and RGB', async () => {
  const f = await fixture();
  await f.engine.activateScene('scene.off', user);
  expect(f.requests).toHaveLength(0);
  // A fresh process/adapter has never sent Party, but the bulb still remembers it.
  expect(f.physical.mode).toBe('Party');
  await f.engine.activateScene('scene.focus', user);
  expect(f.physical.mode).toBe('white:4000');
  await f.engine.setLighting(target, { rgb: [1, 2, 3] }, { actor: user });
  expect(f.physical.mode).toBe('rgb:1,2,3');
  await f.engine.setLighting(target, { brightness: 50 }, { actor: user });
  expect(f.physical.mode).toBe('rgb:1,2,3');
});

it('resets an explicit Focus selection even when Matter already claims all requested values', async () => {
  const f = await fixture();
  f.ordinary.externalChange(target, {
    power: true,
    brightness: 100,
    colorTemperature: 4000,
  });
  expect(f.physical.mode).toBe('Party');
  await f.engine.activateScene('scene.focus', user);
  expect(f.physical.mode).toBe('white:4000');
  f.physical.mode = 'Party';
  await f.engine.reapplyScene(user);
  expect(f.physical.mode).toBe('white:4000');
});

it('does not apply old white after a genuine external RGB takeover', async () => {
  const f = await fixture();
  f.block();
  const white = f.engine.activateScene('scene.focus', user);
  await f.entered.promise;
  f.physical.mode = 'rgb:1,2,3';
  f.ordinary.externalChange(target, { rgb: [1, 2, 3] });
  expect(
    f.engine.state.lighting.devices[target]?.goveeStaticControlId,
  ).toBeUndefined();
  expect(f.engine.state.lighting.devices[target]?.effectiveDesired.rgb).toEqual(
    [1, 2, 3],
  );
  f.blocked.release();
  await white;
  expect(f.physical.mode).toBe('rgb:1,2,3');
});

it.each(['off', 'exit'] as const)(
  'revokes a blocked static reset synchronously on %s and drains before OFF',
  async (kind) => {
    const f = await fixture();
    await f.engine.activateScene('scene.party', user);
    f.block();
    const white = f.engine.activateScene('scene.focus', user);
    await f.entered.promise;
    expect(
      f.engine.state.lighting.devices[target]?.goveeStaticControlId,
    ).toBeTruthy();
    const off =
      kind === 'off'
        ? f.engine.setLighting(target, { power: false }, { actor: user })
        : f.engine.handlePresence({
            type: 'presence.changed',
            presence: 'confirmed_empty',
          });
    expect(
      f.engine.state.lighting.devices[target]?.goveeStaticControlId,
    ).toBeUndefined();
    f.blocked.release();
    await Promise.all([white, off]);
    expect(f.physical.mode).toBe('Party');
    expect(f.ordinary.observed.get(target)?.power).toBe(false);
  },
);
