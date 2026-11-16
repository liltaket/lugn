import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import {
  GoveePresetLightingAdapter,
  GoveeSocketClient,
  type GoveeControlClient,
} from '../src/adapters/govee-preset-lighting.js';
import type {
  LightingAdapter,
  LightingCommand,
  LightingObservation,
} from '../src/adapters/simulated-lighting.js';
const target = 'lighting.govee_ceiling';
const capabilities = {
  [target]: {
    effects: ['Aurora'],
    zones: true,
    colorTemperature: { min: 2700, max: 6500 },
  },
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const events: string[] = [];
  const writes: LightingCommand[] = [];
  const ordinary: LightingAdapter = {
    subscribe: () => () => undefined,
    dispatch: async (command) => {
      writes.push(command);
      events.push(`static:${JSON.stringify(command.values)}`);
    },
  };
  const client: GoveeControlClient = {
    capabilities: async () => capabilities,
    cancel: async (_target, id) => {
      events.push(`cancel:${id ?? 'all'}`);
    },
    apply: async () => {
      events.push('apply');
    },
  };
  const adapter = new GoveePresetLightingAdapter(
    ordinary,
    client,
    structuredClone(capabilities),
    // This fake never reports native power; staging uses its short fallback.
    20,
  );
  return { adapter, client, events, writes };
}
const effect: LightingCommand = {
  id: 'c1',
  target,
  values: { power: true, brightness: 25 },
  govee: {
    controlId: 'g1',
    effect: 'Aurora',
    zones: { main: false, ring: true },
  },
};
afterEach(() => vi.useRealTimers());
it('drains before baseline and applies effect/mask afterward without inventing static color', async () => {
  const f = fixture();
  const apply = vi.spyOn(f.client, 'apply');
  await f.adapter.dispatch(effect);
  expect(f.events).toEqual([
    'cancel:all',
    'static:{"power":true,"brightness":25}',
    'apply',
  ]);
  expect(apply).toHaveBeenCalledWith({
    requestId: 'c1',
    target,
    ...effect.govee,
  });
});
it('drains a guarded rotation step without rewriting ordinary power or brightness', async () => {
  const f = fixture();
  const apply = vi.spyOn(f.client, 'apply');
  await f.adapter.dispatch({
    ...effect,
    values: {},
    goveeOnly: true,
    isCurrent: () => true,
  });
  expect(f.events).toEqual(['cancel:all', 'apply']);
  expect(f.writes).toHaveLength(0);
  expect(apply).toHaveBeenCalledWith({
    requestId: effect.id,
    target,
    ...effect.govee,
    modeOnly: true,
  });
});
it('rejects rotation-only steps without an effect, live guard or empty baseline', async () => {
  const f = fixture();
  for (const command of [
    { ...effect, goveeOnly: true as const },
    { ...effect, goveeOnly: true as const, isCurrent: () => true },
    {
      ...effect,
      values: {},
      goveeOnly: true as const,
      govee: { controlId: 'bad', zones: { main: true, ring: false } },
      isCurrent: () => true,
    },
  ])
    await expect(f.adapter.dispatch(command)).rejects.toThrow('rotation step');
  expect(f.events).toEqual([]);
});
it('rejects an unflattened rotation before physical writes instead of silently applying only zones', async () => {
  const f = fixture();
  await expect(
    f.adapter.dispatch({
      ...effect,
      govee: {
        controlId: 'bad',
        rotation: { effects: ['Aurora', 'Forest'], intervalSeconds: 30 },
        zones: { main: false, ring: true },
      },
    }),
  ).rejects.toThrow('Unsupported');
  expect(f.events).toEqual([]);
});
it('cancels an obsolete in-flight effect and keeps newer static white behind its drain', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const applying = deferred();
  const draining = deferred();
  let current = true;
  f.client.apply = async () => {
    f.events.push('apply');
    await applying.promise;
  };
  f.client.cancel = async (_target, id) => {
    f.events.push(`cancel:${id ?? 'all'}`);
    if (id) await draining.promise;
  };
  const old = f.adapter.dispatch({ ...effect, isCurrent: () => current });
  await vi.advanceTimersByTimeAsync(0);
  current = false;
  const next = f.adapter.dispatch({
    id: 'c2',
    target,
    values: { power: true, colorTemperature: 4000 },
  });
  await vi.advanceTimersByTimeAsync(20);
  expect(f.events).toContain('cancel:g1');
  applying.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.writes).toHaveLength(1);
  draining.resolve();
  await Promise.all([old, next]);
  expect(f.events.at(-1)).toBe('static:{"power":true,"colorTemperature":4000}');
});
it('drains and compensates a partial zone failure with OFF before surfacing failure', async () => {
  const f = fixture();
  f.client.apply = async () => {
    throw new Error('zone unavailable');
  };
  await expect(f.adapter.dispatch(effect)).rejects.toThrow('zone unavailable');
  expect(f.events.at(-2)).toBe('cancel:g1');
  expect(f.writes.at(-1)?.values).toEqual({ power: false });
});
it('does not compensate a failed obsolete request over newer intent', async () => {
  const f = fixture();
  let current = true;
  f.client.apply = async () => {
    current = false;
    throw new Error('stale');
  };
  await f.adapter
    .dispatch({ ...effect, isCurrent: () => current })
    .catch(() => undefined);
  expect(f.writes).toHaveLength(1);
});
it('attempts local OFF during companion outage, rejects positive writes, and recovers capabilities', async () => {
  const f = fixture();
  f.client.cancel = async () => {
    throw new Error('offline');
  };
  await expect(
    f.adapter.dispatch({ id: 'off', target, values: { power: false } }),
  ).rejects.toThrow('offline');
  expect(f.writes[0]?.values).toEqual({ power: false });
  await expect(f.adapter.dispatch(effect)).rejects.toThrow('offline');
  expect(f.writes).toHaveLength(1);
  f.client.capabilities = async () => {
    throw new Error('offline');
  };
  await expect(f.adapter.refreshCapabilities()).rejects.toThrow();
  expect(f.adapter.goveeCapabilities).toEqual(capabilities);
  f.client.capabilities = async () => ({
    ...capabilities,
    'lighting.table': { effects: ['Forest'], zones: false },
  });
  await f.adapter.refreshCapabilities();
  expect(f.adapter.goveeCapabilities['lighting.table']?.effects).toEqual([
    'Forest',
  ]);
});
it('clamps static Kelvin to authoritative model bounds', async () => {
  const f = fixture();
  await f.adapter.dispatch({
    id: 'white',
    target,
    values: { power: true, colorTemperature: 15 },
  });
  expect(f.writes[0]?.values.colorTemperature).toBe(2700);
});
it('rejects unknown effects before any physical write', async () => {
  const f = fixture();
  await expect(
    f.adapter.dispatch({
      ...effect,
      govee: { controlId: 'g', effect: 'invented' },
    }),
  ).rejects.toThrow('Unsupported');
  expect(f.events).toEqual([]);
});
const servers: Server[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.close(() => done());
          server.closeAllConnections();
        }),
    ),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
it('uses the agreed Unix socket wire protocol, ignores extra truthful feedback, and sanitizes errors', async () => {
  const path = await mkdtemp(join(tmpdir(), 'lugn-govee-ipc-'));
  directories.push(path);
  const socket = join(path, 'control.sock');
  const requests: unknown[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length
      ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<
          string,
          unknown
        >)
      : undefined;
    requests.push({ path: req.url, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/capabilities')
      res.end(JSON.stringify({ targets: capabilities }));
    else if (req.url === '/cancel')
      res.end(JSON.stringify({ status: 'drained' }));
    else if (body?.['effect'] === 'error') {
      res.statusCode = 502;
      res.end('protected details');
    } else
      res.end(
        JSON.stringify({
          ...body,
          status: 'sent',
          delivery: {
            transport: 'mixed',
            effect: 'udp_sent',
            zones: 'cloud_accepted',
          },
        }),
      );
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(socket, done));
  const client = new GoveeSocketClient(socket);
  expect(await client.capabilities()).toEqual(capabilities);
  await client.apply({
    requestId: 'r',
    target,
    controlId: 'g',
    effect: 'Aurora',
    zones: { main: false, ring: true },
  });
  await client.cancel(target, 'g');
  expect(requests).toEqual([
    { path: '/capabilities', body: undefined },
    {
      path: '/apply',
      body: {
        requestId: 'r',
        target,
        controlId: 'g',
        effect: 'Aurora',
        zones: { main: false, ring: true },
      },
    },
    { path: '/cancel', body: { target, controlId: 'g' } },
  ]);
  await expect(
    client.apply({ requestId: 'r', target, controlId: 'g', effect: 'error' }),
  ).rejects.toThrow('Govee control request failed (502)');
});

it('releases queued OFF after an acknowledged drain even if the obsolete apply response never arrives', async () => {
  vi.useFakeTimers();
  const f = fixture();
  let current = true;
  f.client.apply = () => new Promise<void>(() => undefined);
  const old = f.adapter.dispatch({ ...effect, isCurrent: () => current });
  await vi.advanceTimersByTimeAsync(0);
  current = false;
  const off = f.adapter.dispatch({
    id: 'off',
    target,
    values: { power: false },
  });
  await vi.advanceTimersByTimeAsync(20);
  await Promise.all([old, off]);
  expect(f.writes.at(-1)?.values).toEqual({ power: false });
  expect(f.events).toContain('cancel:g1');
});

it('rejects effect intent during missing companion capabilities without baseline activation', async () => {
  const f = fixture();
  const empty = new GoveePresetLightingAdapter(
    {
      subscribe: () => () => undefined,
      dispatch: async () => {
        f.events.push('unsafe');
      },
    },
    f.client,
    {},
  );
  await expect(empty.dispatch(effect)).rejects.toThrow(
    'capabilities unavailable',
  );
  expect(f.events).toEqual([]);
});
const ringOnly: LightingCommand = {
  id: 'c-ring',
  target,
  isCurrent: () => true,
  values: { power: true, brightness: 20, colorTemperature: 2200 },
  govee: { controlId: 'g-ring', zones: { main: false, ring: true } },
};
function staticFixture() {
  const f = fixture();
  f.adapter.goveeCapabilities[target]!.staticColor = true;
  const bodies: unknown[] = [];
  vi.spyOn(f.client, 'apply').mockImplementation(async (body) => {
    bodies.push(body);
    f.events.push('apply');
  });
  return { ...f, bodies };
}
const dim = 'static:{"power":true,"brightness":1,"colorTemperature":2700}';
const scene = 'static:{"power":true,"brightness":20,"colorTemperature":2700}';
it('lights a dark fixture dimly before the scene when its stored mask is unknown', async () => {
  const f = staticFixture();
  await f.adapter.dispatch({
    ...ringOnly,
    govee: {
      ...ringOnly.govee!,
      stageZones: true,
      staticColor: { colorTemperature: 2200 },
    },
  });
  // This fake never reports native ON, so the mask falls back to the final apply.
  expect(f.events).toEqual(['cancel:all', dim, scene, 'apply']);
  expect(f.bodies).toEqual([
    {
      requestId: 'c-ring',
      target,
      controlId: 'g-ring',
      zones: { main: false, ring: true },
      // The vendor API rejects out-of-range Kelvin; clamping keeps the lamp lit.
      staticColor: { colorTemperature: 2700 },
    },
  ]);
});
it('stops before the baseline when staging outlives its generation', async () => {
  const f = staticFixture();
  let live = true;
  const dispatch = f.adapter['ordinary'].dispatch;
  vi.spyOn(f.adapter['ordinary'], 'dispatch').mockImplementation(
    async (command) => {
      await dispatch(command);
      live = false;
    },
  );
  await f.adapter.dispatch({
    ...ringOnly,
    isCurrent: () => live,
    govee: { ...ringOnly.govee!, stageZones: true },
  });
  expect(f.events).toEqual(['cancel:all', dim]);
  expect(f.bodies).toEqual([]);
});
it('rejects static white on effects or incapable targets and staging of a whole mask', async () => {
  const f = fixture();
  for (const command of [
    {
      ...ringOnly,
      govee: { ...ringOnly.govee!, staticColor: { colorTemperature: 3000 } },
    },
    {
      ...ringOnly,
      govee: {
        ...ringOnly.govee!,
        zones: { main: true, ring: true },
        stageZones: true as const,
      },
    },
    {
      ...ringOnly,
      values: { brightness: 20 },
      govee: { ...ringOnly.govee!, stageZones: true as const },
    },
  ])
    await expect(f.adapter.dispatch(command)).rejects.toThrow('Invalid Govee');
  f.adapter.goveeCapabilities[target]!.staticColor = true;
  await expect(
    f.adapter.dispatch({
      ...ringOnly,
      govee: {
        ...effect.govee!,
        staticColor: { colorTemperature: 3000 },
      },
    }),
  ).rejects.toThrow('Invalid Govee static reset');
  expect(f.events).toEqual([]);
});
function poweredFixture(timeoutMs = 4_000, settleMs = 400) {
  const events: string[] = [];
  const bodies: unknown[] = [];
  let listener: ((observation: LightingObservation) => void) | undefined;
  const ordinary: LightingAdapter = {
    subscribe: (next) => {
      listener = next;
      return () => undefined;
    },
    dispatch: async (command) => {
      events.push(`static:${JSON.stringify(command.values)}`);
    },
  };
  const client: GoveeControlClient = {
    capabilities: async () => capabilities,
    cancel: async (_target, id) => {
      events.push(`cancel:${id ?? 'all'}`);
    },
    apply: async (body) => {
      bodies.push(body);
      events.push('apply');
    },
  };
  const adapter = new GoveePresetLightingAdapter(
    ordinary,
    client,
    structuredClone(capabilities),
    timeoutMs,
    settleMs,
  );
  const observe = (power: boolean) =>
    listener!({ target, values: { power }, observedAt: Date.now() });
  return { adapter, client, events, bodies, observe };
}
it('masks a dimly lit fixture once natively ON and settles before the scene', async () => {
  const f = poweredFixture();
  const done = f.adapter.dispatch({
    ...ringOnly,
    govee: {
      ...ringOnly.govee!,
      stageZones: true as const,
      knownZones: { main: true, ring: true },
    },
  });
  await vi.waitFor(() => expect(f.events).toEqual(['cancel:all', dim]));
  await new Promise((resolve) => setTimeout(resolve, 60));
  // HA acceptance alone must not release the mask: the H60A6 ignores it while dark.
  expect(f.events).toEqual(['cancel:all', dim]);
  f.observe(false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(f.events).toHaveLength(2);
  f.observe(true);
  await vi.waitFor(() => expect(f.events).toHaveLength(3));
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(f.events).toHaveLength(3);
  await done;
  expect(f.events).toEqual(['cancel:all', dim, 'apply', scene]);
  // The stored mask already has the ring: only the main OFF is sent. A ring
  // ON while lit would relight the main light, so no later toggle follows.
  expect(f.bodies).toEqual([
    {
      requestId: 'c-ring',
      target,
      controlId: 'g-ring',
      zones: { main: false, ring: true },
      zoneOrder: 'disable-only',
    },
  ]);
});
it('sends the full mask once lit when the stored mask is unknown', async () => {
  const f = poweredFixture();
  const done = f.adapter.dispatch({
    ...ringOnly,
    govee: { ...ringOnly.govee!, stageZones: true },
  });
  await vi.waitFor(() => expect(f.events).toEqual(['cancel:all', dim]));
  f.observe(true);
  await done;
  expect(f.events).toEqual(['cancel:all', dim, 'apply', scene]);
  expect(f.bodies).toEqual([
    {
      requestId: 'c-ring',
      target,
      controlId: 'g-ring',
      zones: { main: false, ring: true },
    },
  ]);
});
it('continues to the scene and the final mask when the lit mask fails', async () => {
  const f = poweredFixture();
  let calls = 0;
  vi.spyOn(f.client, 'apply').mockImplementation(async (body) => {
    f.bodies.push(body);
    f.events.push('apply');
    if (++calls === 1) throw new Error('cloud unavailable');
  });
  const done = f.adapter.dispatch({
    ...ringOnly,
    govee: { ...ringOnly.govee!, stageZones: true },
  });
  await vi.waitFor(() => expect(f.events).toEqual(['cancel:all', dim]));
  f.observe(true);
  await done;
  expect(f.events).toEqual([
    'cancel:all',
    dim,
    'apply',
    'cancel:g-ring',
    scene,
    'apply',
  ]);
  expect(f.bodies[1]).toEqual(f.bodies[0]);
});
it('powers a matching stored mask with the wanted cloud ON, then repeats the OFF once lit', async () => {
  const f = poweredFixture();
  const done = f.adapter.dispatch({
    ...ringOnly,
    govee: {
      ...ringOnly.govee!,
      stageZones: true,
      knownZones: { main: false, ring: true },
    },
  });
  // A local Matter ON would light the whole fixture; the ring ON keeps its mask.
  await vi.waitFor(() => expect(f.events).toEqual(['cancel:all', 'apply']));
  f.observe(true);
  await done;
  expect(f.events).toEqual(['cancel:all', 'apply', 'apply', scene]);
  const mask = {
    requestId: 'c-ring',
    target,
    controlId: 'g-ring',
    zones: { main: false, ring: true },
  };
  expect(f.bodies).toEqual([
    { ...mask, zoneOrder: 'enable-only' },
    { ...mask, zoneOrder: 'disable-only' },
  ]);
});
it('falls back to the scene when dim power is never reported', async () => {
  const f = poweredFixture(40);
  await f.adapter.dispatch({
    ...ringOnly,
    govee: { ...ringOnly.govee!, stageZones: true },
  });
  expect(f.events).toEqual(['cancel:all', dim, scene, 'apply']);
});
it('restores both zones alongside the baseline, then sends the white', async () => {
  const f = staticFixture();
  const gate = deferred();
  vi.spyOn(f.client, 'apply').mockImplementation(async (body) => {
    f.bodies.push(body);
    f.events.push('apply');
    if (f.bodies.length === 1) await gate.promise;
  });
  const done = f.adapter.dispatch({
    id: 'c-white',
    target,
    isCurrent: () => true,
    values: { power: true, brightness: 100, colorTemperature: 4000 },
    goveeStatic: {
      controlId: 's1',
      color: { colorTemperature: 4000 },
      zones: { main: true, ring: true },
    },
  });
  const white =
    'static:{"power":true,"brightness":100,"colorTemperature":4000}';
  // The main ON does not wait for the local baseline, nor the baseline for it.
  await vi.waitFor(() =>
    expect(f.events).toEqual(['cancel:all', 'apply', white]),
  );
  gate.resolve();
  await done;
  const base = { requestId: 'c-white', target, controlId: 's1' };
  expect(f.events).toEqual(['cancel:all', 'apply', white, 'apply']);
  expect(f.bodies).toEqual([
    { ...base, zones: { main: true, ring: true } },
    { ...base, staticColor: { colorTemperature: 4000 } },
  ]);
});
it('surfaces a failed restore without switching the fixture off', async () => {
  const f = staticFixture();
  vi.spyOn(f.client, 'apply').mockRejectedValueOnce(new Error('cloud down'));
  await expect(
    f.adapter.dispatch({
      id: 'c-white',
      target,
      isCurrent: () => true,
      values: { power: true, brightness: 100, colorTemperature: 4000 },
      goveeStatic: {
        controlId: 's1',
        color: { colorTemperature: 4000 },
        zones: { main: true, ring: true },
      },
    }),
  ).rejects.toThrow('cloud down');
  expect(f.writes.map((write) => write.values.power)).toEqual([true]);
});
it('sends only changed toggles for a lit fixture with a known mask', async () => {
  const f = staticFixture();
  const lit = (
    zones: { main: boolean; ring: boolean },
    knownZones: { main: boolean; ring: boolean },
  ): LightingCommand => ({
    ...ringOnly,
    values: { power: true, brightness: 20, colorTemperature: 3000 },
    govee: {
      controlId: 'g-lit',
      zones,
      knownZones,
      staticColor: { colorTemperature: 3000 },
    },
  });
  const base = { requestId: 'c-ring', target, controlId: 'g-lit' };
  const white = { staticColor: { colorTemperature: 3000 } };
  await f.adapter.dispatch(
    lit({ main: false, ring: true }, { main: true, ring: true }),
  );
  await f.adapter.dispatch(
    lit({ main: false, ring: true }, { main: false, ring: true }),
  );
  await f.adapter.dispatch(
    lit({ main: true, ring: true }, { main: true, ring: true }),
  );
  await f.adapter.dispatch(
    lit({ main: true, ring: true }, { main: false, ring: true }),
  );
  expect(f.bodies).toEqual([
    // Both lit to ring only: just the main OFF, never a ring ON.
    {
      ...base,
      zones: { main: false, ring: true },
      zoneOrder: 'disable-only',
      ...white,
    },
    {
      ...base,
      zones: { main: false, ring: true },
      zoneOrder: 'disable-only',
      ...white,
    },
    // Already both lit: no toggle at all.
    { ...base, ...white },
    // A dark wanted zone still needs the enable-first mask.
    { ...base, zones: { main: true, ring: true }, ...white },
  ]);
});
