import { describe, expect, it } from 'vitest';
import { HomeAssistantLightingAdapter } from '../src/adapters/home-assistant-lighting.js';
import {
  LightingDeliveryUnknownError,
  type LightingObservation,
} from '../src/adapters/simulated-lighting.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';

const target = 'lighting.wled_cct';
const config = {
  baseUrl: 'http://ha.test:8123',
  token: 'secret-ha-token',
  entities: { [target]: 'light.wled' },
  wledCct: { [target]: { baseUrl: 'http://wled.test' } },
};

function state() {
  return {
    on: true,
    bri: 156,
    seg: [
      {
        id: 0,
        lc: 6,
        on: true,
        bri: 255,
        cct: 39,
        col: [[255, 255, 255, 255]],
        fx: 0,
      },
    ],
  };
}

function setup(ignoreWrites = false) {
  let current = state();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const clock = new FakeClock(1_000);
  const adapter = new HomeAssistantLightingAdapter(
    config,
    async (input, init) => {
      requests.push({ url: String(input), ...(init ? { init } : {}) });
      if (init?.method === 'POST' && !ignoreWrites) {
        const body = JSON.parse(String(init.body)) as ReturnType<typeof state>;
        current = {
          ...current,
          ...body,
          seg: body.seg
            ? [{ ...current.seg[0]!, ...body.seg[0] }]
            : current.seg,
        };
      }
      return Response.json(current);
    },
    clock,
  );
  const observations: LightingObservation[] = [];
  const unsubscribe = adapter.subscribe((observation) =>
    observations.push(observation),
  );
  return {
    adapter,
    clock,
    requests,
    observations,
    unsubscribe,
    get current() {
      return current;
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}

function haEvent(state: string) {
  return {
    entity_id: 'light.wled',
    new_state: {
      entity_id: 'light.wled',
      state,
      attributes: { brightness: 156, color_temp_kelvin: 2693 },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('dedicated WLED CCT control', () => {
  it.each([false, true])(
    'serializes an older ON before a newer OFF, including a failed predecessor (%s)',
    async (fail) => {
      let current = state();
      let posts = 0;
      const gate = deferred<void>();
      const adapter = new HomeAssistantLightingAdapter(
        config,
        async (_input, init) => {
          if (init?.method === 'POST') {
            posts += 1;
            if (posts === 1) await gate.promise;
            const body = JSON.parse(String(init.body)) as ReturnType<
              typeof state
            >;
            current = {
              ...current,
              ...body,
              seg: body.seg
                ? [{ ...current.seg[0]!, ...body.seg[0] }]
                : current.seg,
            };
          }
          return Response.json(current);
        },
        new FakeClock(),
      );
      const observations: LightingObservation[] = [];
      const unsubscribe = adapter.subscribe((observation) =>
        observations.push(observation),
      );
      const on = adapter
        .dispatch({
          id: 'old-on',
          target,
          values: { power: true, brightness: 100 },
        })
        .catch((error: unknown) => error);
      await flush();
      expect(posts).toBe(1);
      const off = adapter.dispatch({
        id: 'new-off',
        target,
        values: { power: false },
      });
      await flush();
      expect(posts).toBe(1);
      if (fail) gate.reject(new Error(config.token));
      else gate.resolve();
      const result: unknown = await on;
      await off;
      if (fail) expect(result).toBeInstanceOf(LightingDeliveryUnknownError);
      expect(posts).toBe(2);
      expect(current.on).toBe(false);
      expect(observations.map((observation) => observation.values)).toEqual([
        { power: false },
      ]);
      unsubscribe();
    },
  );

  it('ignores superseded reads and prevents a pending read from writing after shutdown', async () => {
    const replies = [
      deferred<Response>(),
      deferred<Response>(),
      deferred<Response>(),
    ];
    let reads = 0;
    let posts = 0;
    const adapter = new HomeAssistantLightingAdapter(
      config,
      async (_input, init) => {
        if (init?.method === 'POST') posts += 1;
        return replies[reads++]!.promise;
      },
      new FakeClock(),
    );
    const observations: LightingObservation[] = [];
    const unsubscribe = adapter.subscribe((observation) =>
      observations.push(observation),
    );
    adapter.acceptStateChangedEvent(haEvent('on'));
    adapter.acceptStateChangedEvent(haEvent('off'));
    replies[1]!.resolve(Response.json({ ...state(), on: false }));
    await flush();
    replies[0]!.resolve(Response.json(state()));
    await flush();
    expect(observations.map((observation) => observation.values)).toEqual([
      { power: false },
    ]);
    const pending = adapter.dispatch({
      id: 'pending',
      target,
      values: { power: true },
    });
    await flush();
    unsubscribe();
    replies[2]!.resolve(Response.json(state()));
    await pending;
    expect(posts).toBe(0);
  });

  it('restores white and segment levels while setting global brightness and CCT atomically', async () => {
    const s = setup();
    s.current.seg[0]!.col[0]![3] = 0;
    s.current.seg[0]!.bri = 0;
    await s.adapter.dispatch({
      id: 'on',
      target,
      values: { power: true, brightness: 61, colorTemperature: 2700 },
    });
    expect(s.requests.map((request) => request.url)).toEqual([
      'http://wled.test/json/state',
      'http://wled.test/json/state',
    ]);
    expect(JSON.parse(String(s.requests[1]!.init?.body))).toEqual({
      on: true,
      v: true,
      bri: 156,
      seg: [
        { id: 0, on: true, bri: 255, col: [[0, 0, 0, 255]], fx: 0, cct: 39 },
      ],
    });
    expect(
      s.requests.every(
        (request) =>
          !JSON.stringify(request.init?.headers).includes(config.token),
      ),
    ).toBe(true);
    expect(s.observations.at(-1)?.values).toEqual({
      power: true,
      brightness: 61,
      colorTemperature: 2700,
    });
    // Quantized CCT feedback must still confirm 2700 K without endless retries.
    s.adapter.acceptStateChangedEvent(haEvent('on'));
    await flush();
    expect(s.observations.at(-1)?.values.colorTemperature).toBe(2700);
    s.unsubscribe();
  });

  it.each([{ power: false }, { brightness: 0 }])(
    'turns off without erasing remembered white/CCT for %o',
    async (values) => {
      const s = setup();
      await s.adapter.dispatch({ id: 'off', target, values });
      expect(JSON.parse(String(s.requests[1]!.init?.body))).toEqual({
        on: false,
        v: true,
      });
      expect(s.current.seg[0]!.col[0]![3]).toBe(255);
      expect(s.current.seg[0]!.cct).toBe(39);
      expect(s.observations.at(-1)?.values).toEqual({ power: false });
      s.unsubscribe();
    },
  );

  it('preserves effective brightness for a temperature-only request', async () => {
    const s = setup();
    s.current.seg[0]!.col[0]![3] = 128;
    await s.adapter.dispatch({
      id: 'cct',
      target,
      values: { colorTemperature: 4000 },
    });
    expect(JSON.parse(String(s.requests[1]!.init?.body)).bri).toBe(78);
    expect(s.observations.at(-1)?.values).toEqual({
      power: true,
      brightness: 31,
      colorTemperature: 4000,
    });
    s.unsubscribe();
  });

  it('does not let HA confirm a zero white channel, and periodically reads hidden changes', async () => {
    const s = setup();
    s.current.seg[0]!.col[0]![3] = 0;
    s.adapter.acceptStateChangedEvent(haEvent('on'));
    await flush();
    expect(s.observations.at(-1)).toMatchObject({
      values: {},
      availability: 'unavailable',
    });
    s.current.seg[0]!.col[0]![3] = 128;
    s.clock.advanceBy(30_000);
    await flush();
    expect(s.observations.at(-1)?.values.brightness).toBe(31);
    s.unsubscribe();
    expect(s.clock.pendingTimers()).toBe(0);
  });

  it('repairs a hidden white-channel fault without replacing the scene with a manual zero override', async () => {
    const s = setup();
    const engine = new LugnEngine(s.clock, {
      adapter: s.adapter,
      deviceIds: [target],
      scenes: [
        {
          id: 'scene.test',
          name: 'Test',
          lighting: {
            [target]: { power: true, brightness: 61, colorTemperature: 2700 },
          },
        },
      ],
    });
    await engine.activateScene('scene.test', { type: 'user' });
    await flush();
    expect(engine.state.lighting.devices[target]?.observed.brightness).toBe(61);
    const writesBefore = s.requests.filter(
      (request) => request.init?.method === 'POST',
    ).length;
    // A channel can fail hours after a scene converged, not only during its
    // initial 60-second retry window.
    for (let i = 0; i < 3; i++) {
      s.clock.advanceBy(30_000);
      await flush();
    }
    s.current.seg[0]!.col[0]![3] = 0;
    s.clock.advanceBy(30_000);
    await flush();
    s.clock.advanceBy(5_000);
    await flush();
    expect(
      s.requests.filter((request) => request.init?.method === 'POST').length,
    ).toBeGreaterThan(writesBefore);
    expect(s.current.seg[0]!.col[0]![3]).toBe(255);
    expect(engine.state.lighting.devices[target]?.effectiveDesired).toEqual({
      power: true,
      brightness: 61,
      colorTemperature: 2700,
    });
    engine.dispose();
    s.unsubscribe();
  });

  it('keeps recovery bounded when the device repeatedly ignores white-channel repairs', async () => {
    const s = setup(true);
    const engine = new LugnEngine(s.clock, {
      adapter: s.adapter,
      deviceIds: [target],
      scenes: [
        {
          id: 'scene.test',
          name: 'Test',
          lighting: {
            [target]: { power: true, brightness: 61, colorTemperature: 2700 },
          },
        },
      ],
    });
    await engine.activateScene('scene.test', { type: 'user' });
    await flush();
    for (let i = 0; i < 3; i++) {
      s.clock.advanceBy(30_000);
      await flush();
    }
    const beforeFault = s.requests.filter(
      (request) => request.init?.method === 'POST',
    ).length;
    s.current.seg[0]!.col[0]![3] = 0;
    s.clock.advanceBy(30_000);
    await flush();
    for (let i = 0; i < 6; i++) {
      s.clock.advanceBy(2_000);
      await flush();
    }
    expect(
      s.requests.filter((request) => request.init?.method === 'POST').length,
    ).toBe(beforeFault + 3);
    for (let i = 0; i < 4; i++) {
      s.clock.advanceBy(30_000);
      await flush();
      s.clock.advanceBy(2_000);
      await flush();
    }
    expect(
      s.requests.filter((request) => request.init?.method === 'POST').length,
    ).toBe(beforeFault + 3);
    engine.dispose();
    s.unsubscribe();
  });

  it.each(['extra segment', 'wrong segment', 'RGB output'])(
    'refuses to write to an incompatible device: %s',
    async (kind) => {
      const s = setup();
      if (kind === 'extra segment')
        s.current.seg.push({ ...s.current.seg[0]!, id: 1 });
      if (kind === 'wrong segment') s.current.seg[0]!.id = 1;
      if (kind === 'RGB output') s.current.seg[0]!.lc = 7;
      await expect(
        s.adapter.dispatch({ id: 'on', target, values: { power: true } }),
      ).rejects.toThrow('requires one existing');
      expect(s.requests).toHaveLength(1);
      s.unsubscribe();
    },
  );

  it('sanitizes unknown write failures and requires usable device feedback', async () => {
    for (const result of ['timeout', 'bad state', 'server failure']) {
      const adapter = new HomeAssistantLightingAdapter(
        config,
        async (_input, init) => {
          if (init?.method !== 'POST') return Response.json(state());
          if (result === 'timeout') throw new Error(config.token);
          return result === 'bad state'
            ? Response.json({ success: true })
            : new Response(null, { status: 503 });
        },
        new FakeClock(),
      );
      const error: unknown = await adapter
        .dispatch({ id: 'on', target, values: { power: true } })
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(LightingDeliveryUnknownError);
      expect(String(error)).not.toContain(config.token);
    }
  });
});
