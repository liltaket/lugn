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
const target = 'lighting.govee_ceiling';
const capabilities = {
  [target]: {
    effects: ['Aurora', 'Forest'],
    zones: true,
    colorTemperature: { min: 2700, max: 6500 },
  },
};
const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
it('runs engine -> actual socket client/server -> fake device, including rapid effect/white/effect and drained OFF', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lugn-preset-e2e-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const socketPath = join(directory, 'control.sock');
  const events: string[] = [];
  const blocked = gate();
  const entered = gate();
  let blockNext = false;
  const server = await startGoveeControlServer({
    socketPath,
    capabilities: () => capabilities,
    owns: (id, controlId) => {
      const device = engine?.state.lighting.devices[id];
      return (
        device?.govee?.controlId === controlId &&
        !device.externalControl &&
        device.effectiveDesired.power === true
      );
    },
    apply: async (request, guard) => {
      await guard();
      events.push(`effect:${request.effect ?? 'static'}`);
      if (blockNext) {
        blockNext = false;
        entered.release();
        await blocked.promise;
      }
      if (request.zones) {
        // Fake device mirrors the required transport ordering, with guard before every write.
        for (const value of [false, true])
          for (const zone of ['main', 'ring'] as const)
            if (request.zones[zone] === value) {
              await guard();
              events.push(`${zone}:${value}`);
            }
      }
      return {
        transport: 'mixed',
        ...(request.effect ? { effect: 'udp_sent' } : {}),
        ...(request.zones ? { zones: 'cloud_accepted' } : {}),
      };
    },
  });
  cleanups.push(() => server.stop());
  const client = new GoveeSocketClient(socketPath);
  const clock = new FakeClock(1000);
  const ordinary = new SimulatedLightingAdapter(clock);
  const dispatch = ordinary.dispatch.bind(ordinary);
  ordinary.dispatch = async (command) => {
    events.push(
      `ordinary:${command.values.power === false ? 'off' : (command.values.colorTemperature ?? 'baseline')}`,
    );
    await dispatch(command);
  };
  const adapter = new GoveePresetLightingAdapter(
    ordinary,
    client,
    await client.capabilities(),
  );
  const engine = new LugnEngine(clock, {
    adapter,
    deviceIds: [target],
    scenes: [
      {
        id: 'scene.ring',
        name: 'Ring',
        lighting: { [target]: { power: true, brightness: 20 } },
        govee: {
          [target]: { effect: 'Aurora', zones: { main: false, ring: true } },
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
        id: 'scene.both',
        name: 'Both',
        lighting: { [target]: { power: true, brightness: 30 } },
        govee: {
          [target]: { effect: 'Forest', zones: { main: true, ring: true } },
        },
      },
    ],
  });
  cleanups.push(() => engine.dispose());
  const user = { type: 'user' as const };
  await engine.handlePresence({
    type: 'presence.changed',
    presence: 'occupied',
  });
  await engine.activateScene('scene.ring', user);
  expect(events.slice(-4)).toEqual([
    'ordinary:baseline',
    'effect:Aurora',
    'main:false',
    'ring:true',
  ]);
  await engine.activateScene('scene.white', user);
  expect(events.at(-1)).toBe('ordinary:4000');
  await engine.activateScene('scene.both', user);
  expect(events.slice(-4)).toEqual([
    'ordinary:baseline',
    'effect:Forest',
    'main:true',
    'ring:true',
  ]);
  blockNext = true;
  const old = engine.activateScene('scene.ring', user);
  await entered.promise;
  const cut = events.length;
  const off = engine.handlePresence({
    type: 'presence.changed',
    presence: 'confirmed_empty',
  });
  expect(
    engine.state.lighting.devices[target]?.govee?.controlId,
  ).toBeUndefined();
  blocked.release();
  await Promise.all([old, off]);
  expect(events.slice(cut)).toContain('ordinary:off');
  expect(
    events
      .slice(cut)
      .some((event) => event === 'ring:true' || event === 'main:true'),
  ).toBe(false);
  expect(ordinary.observed.get(target)?.power).toBe(false);
});
