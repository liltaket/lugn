import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomeAssistantLightingAdapter } from '../src/adapters/home-assistant-lighting.js';
import {
  LugnEngine,
  type EngineOptions,
} from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';

const enforced = 'lighting.cleverio_bar';
const manual = 'lighting.desk';
const engines: LugnEngine[] = [];
afterEach(() => engines.splice(0).forEach((engine) => engine.dispose()));

function setup(options: Partial<EngineOptions> = {}) {
  const clock = new FakeClock(Date.parse('2026-10-04T03:00:00+02:00'));
  const requests: Array<{
    entity: string;
    service: string;
    brightness?: number;
  }> = [];
  const transport = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requests.push({
        entity: body.entity_id,
        service: String(input).split('/').at(-1)!,
        brightness: body.brightness_pct,
      });
      return new Response(null, { status: 200 });
    },
  );
  const adapter = new HomeAssistantLightingAdapter(
    {
      baseUrl: 'http://ha.test',
      token: 'test',
      entities: { [enforced]: 'light.bar', [manual]: 'light.desk' },
    },
    transport,
    clock,
  );
  const engine = new LugnEngine(clock, {
    adapter,
    deviceIds: [enforced, manual],
    lightingControlModes: { [enforced]: 'enforce' },
    scenes: [
      {
        id: 'scene.entry',
        name: 'Entry',
        lighting: {
          [enforced]: { power: true, brightness: 60 },
          [manual]: { power: true, brightness: 60 },
        },
      },
      {
        id: 'scene.off',
        name: 'Off',
        lighting: { [enforced]: { power: false }, [manual]: { power: false } },
      },
    ],
    defaultSceneId: 'scene.entry',
    retryDelayMs: 250,
    convergenceTimeoutMs: 2000,
    ...options,
  });
  engines.push(engine);
  function report(
    target: string,
    state: 'on' | 'off' | 'unavailable',
    brightness = 153,
  ) {
    const entity = target === enforced ? 'light.bar' : 'light.desk';
    adapter.acceptStateChangedEvent({
      entity_id: entity,
      new_state: {
        entity_id: entity,
        state,
        attributes: state === 'on' ? { brightness } : {},
        context: { user_id: 'ha-user' },
      },
    });
  }
  return { clock, engine, requests, report, transport };
}

async function flush() {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}
async function exhaust(clock: FakeClock) {
  for (let i = 0; i < 3; i++) {
    clock.advanceBy(250);
    await flush();
  }
}

describe('opt-in lighting enforcement', () => {
  it('immediately dispatches a human OFF scene while an old ON transport is pending', async () => {
    const { engine, report, transport, requests } = setup();
    let resolve!: (response: Response) => void;
    transport.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const entry = engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    report(manual, 'on');
    await flush();
    const before = transport.mock.calls.length;
    await engine.activateScene('scene.off', { type: 'user' });
    expect(transport).toHaveBeenCalledTimes(before + 2);
    expect(requests).toContainEqual({
      entity: 'light.bar',
      service: 'turn_off',
      brightness: undefined,
    });
    resolve(new Response(null, { status: 200 }));
    await entry;
    expect(engine.state.lighting.currentScene).toBe('scene.off');
    expect(
      engine.state.lighting.devices[enforced]?.effectiveDesired.power,
    ).toBe(false);
  });

  it.each([
    ['away', false],
    ['away', true],
    ['restored', false],
    ['restored', true],
  ] as const)(
    'continues explicit power=%s/%s without releasing other automatic lights',
    async (gate, power) => {
      const initial = setup();
      await initial.engine.handlePresence({
        type: 'presence.changed',
        presence: 'occupied',
      });
      const active =
        gate === 'restored'
          ? setup({
              restoredLightingIntent:
                initial.engine.getLightingIntentSnapshot(),
              lightingControlModes: {
                [enforced]: 'enforce',
                [manual]: 'enforce',
              },
            })
          : initial;
      const { clock, engine, report, requests } = active;
      report(enforced, 'on');
      report(manual, 'on');
      await flush();
      if (gate === 'away') await engine.handleHomePresence('away');
      if (power) report(enforced, 'off');
      // The other light retains automatic ON intent only in restored mode;
      // either way an explicit command to the bar must not activate it.
      if (gate === 'restored') report(manual, 'off');
      await flush();
      const before = requests.length;
      await engine.setLighting(
        enforced,
        { power },
        { actor: { type: 'user' }, source: 'dashboard' },
      );
      await exhaust(clock);
      expect(requests.slice(before)).toHaveLength(3);
      clock.advanceBy(30_000 - 750);
      await flush();
      expect(requests.slice(before)).toHaveLength(4);
      expect(
        requests
          .slice(before)
          .every(
            (r) =>
              r.entity === 'light.bar' &&
              r.service === (power ? 'turn_on' : 'turn_off'),
          ),
      ).toBe(true);
      expect(
        engine.state.lighting.devices[enforced]?.effectiveDesired.power,
      ).toBe(power);
    },
  );

  it.each(['scene', 'empty'] as const)(
    'does not overlap %s OFF transports when feedback confirms before the response',
    async (mode) => {
      const { clock, engine, report, transport, requests } = setup();
      await engine.handlePresence({
        type: 'presence.changed',
        presence: 'occupied',
      });
      report(enforced, 'on');
      report(manual, 'on');
      await flush();
      let resolve!: (response: Response) => void;
      transport.mockImplementationOnce(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      );
      const before = transport.mock.calls.length;
      const off =
        mode === 'scene'
          ? engine.activateScene('scene.off', { type: 'user' })
          : engine.handlePresence({
              type: 'presence.changed',
              presence: 'confirmed_empty',
            });
      report(manual, 'off');
      report(enforced, 'off');
      await flush();
      report(enforced, 'on');
      await flush();
      clock.advanceBy(30_000);
      await flush();
      expect(transport).toHaveBeenCalledTimes(before + 2);
      resolve(new Response(null, { status: 200 }));
      await off;
      // An expired scene batch may wait for the next periodic check.
      clock.advanceBy(30_000);
      await flush();
      expect(transport).toHaveBeenCalledTimes(before + 3);
      expect(requests.at(-1)).toMatchObject({
        entity: 'light.bar',
        service: 'turn_off',
      });
    },
  );
  it('waits for occupancy after restart but continues empty-room OFF enforcement', async () => {
    const initial = setup();
    await initial.engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    const { clock, engine, report, requests } = setup({
      restoredLightingIntent: initial.engine.getLightingIntentSnapshot(),
    });
    report(enforced, 'on');
    report(manual, 'on');
    clock.advanceBy(60_000);
    await flush();
    expect(requests).toEqual([]);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
    });
    report(manual, 'off');
    await exhaust(clock);
    expect(requests.filter((r) => r.entity === 'light.bar')).toHaveLength(3);
    clock.advanceBy(30_000 - 750);
    await flush();
    expect(requests.filter((r) => r.entity === 'light.bar')).toHaveLength(4);
    expect(requests.at(-1)?.service).toBe('turn_off');
    expect(
      engine.state.lighting.devices[enforced]?.effectiveDesired.power,
    ).toBe(true);
  });
  it('rejects external power and brightness drift while other lights keep manual overrides', async () => {
    const { engine, report, requests } = setup();
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    report(enforced, 'on');
    report(manual, 'on');
    await flush();
    report(enforced, 'on', 51);
    report(manual, 'on', 51);
    await flush();
    expect(
      engine.state.lighting.devices[enforced]?.effectiveDesired.brightness,
    ).toBe(60);
    expect(
      engine.state.lighting.devices[manual]?.effectiveDesired.brightness,
    ).toBe(20);
    report(enforced, 'on');
    await flush();
    report(enforced, 'off');
    report(manual, 'off');
    await flush();
    expect(
      engine.state.lighting.devices[enforced]?.effectiveDesired.power,
    ).toBe(true);
    expect(engine.state.lighting.devices[enforced]?.ownership.power?.kind).toBe(
      'scene',
    );
    expect(engine.state.lighting.devices[manual]?.effectiveDesired.power).toBe(
      false,
    );
    expect(requests.at(-1)).toMatchObject({
      entity: 'light.bar',
      service: 'turn_on',
      brightness: 60,
    });
  });

  it.each(['scene', 'empty'] as const)(
    'keeps retrying an ignored %s OFF after the delivery budget expires',
    async (mode) => {
      const { clock, engine, report, requests } = setup();
      await engine.handlePresence({
        type: 'presence.changed',
        presence: 'occupied',
      });
      report(enforced, 'on');
      report(manual, 'on');
      await flush();
      if (mode === 'scene')
        await engine.activateScene('scene.off', { type: 'user' });
      else
        await engine.handlePresence({
          type: 'presence.changed',
          presence: 'confirmed_empty',
        });
      report(manual, 'off');
      await flush();
      await exhaust(clock);
      const barOff = () =>
        requests.filter(
          (r) => r.entity === 'light.bar' && r.service === 'turn_off',
        );
      expect(barOff()).toHaveLength(3);
      expect(engine.state.lighting.devices[enforced]?.availability).toBe(
        'degraded',
      );
      // Repeated incorrect observations do not grant an unlimited rapid retry budget.
      for (let i = 0; i < 20; i++) report(enforced, 'on', 3);
      await flush();
      expect(barOff()).toHaveLength(3);
      clock.advanceBy(30_000 - 750);
      await flush();
      expect(barOff()).toHaveLength(4);
      await exhaust(clock);
      expect(barOff()).toHaveLength(6);
      clock.advanceBy(30_000 - 750);
      await flush();
      expect(barOff()).toHaveLength(7);
      report(enforced, 'off');
      await flush();
      const converged = requests.length;
      clock.advanceBy(90_000);
      await flush();
      expect(requests).toHaveLength(converged);
      expect(engine.state.lighting.devices[enforced]?.availability).toBe(
        'available',
      );
      // A confirmed empty room retains the remembered ON scene for a later return.
      if (mode === 'empty')
        expect(
          engine.state.lighting.devices[enforced]?.effectiveDesired.power,
        ).toBe(true);
    },
  );

  it('retries unavailable lights and stops using the old goal after a scene change', async () => {
    const { clock, engine, report, requests } = setup();
    report(enforced, 'unavailable');
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    report(manual, 'on');
    await flush();
    await exhaust(clock);
    clock.advanceBy(30_000 - 750);
    await flush();
    expect(requests.filter((r) => r.entity === 'light.bar')).toHaveLength(4);
    await engine.activateScene('scene.off', { type: 'user' });
    report(manual, 'off');
    await flush();
    await exhaust(clock);
    const before = requests.length;
    clock.advanceBy(30_000 - 750);
    await flush();
    expect(requests.slice(before)).toEqual([
      { entity: 'light.bar', service: 'turn_off', brightness: undefined },
    ]);
  });

  it('enforces explicit Lugn adjustments and preserves the away gate for automatic entry', async () => {
    const { clock, engine, requests, report } = setup();
    await engine.handleHomePresence('away');
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    clock.advanceBy(60_000);
    await flush();
    expect(requests).toEqual([]);
    await engine.handleHomePresence('home');
    report(enforced, 'on');
    report(manual, 'on');
    await flush();
    await engine.setLighting(
      enforced,
      { brightness: 20 },
      { actor: { type: 'user' }, source: 'dashboard' },
    );
    report(enforced, 'on', 51);
    await flush();
    report(enforced, 'on', 153);
    await flush();
    expect(
      engine.state.lighting.devices[enforced]?.effectiveDesired.brightness,
    ).toBe(20);
    await exhaust(clock);
    const before = requests.length;
    clock.advanceBy(30_000 - 750);
    await flush();
    expect(requests.slice(before)).toEqual([
      { entity: 'light.bar', service: 'turn_on', brightness: 20 },
    ]);
    engine.dispose();
    clock.advanceBy(90_000);
    await flush();
    expect(requests).toHaveLength(before + 1);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('does not overlap an in-flight transport call', async () => {
    const { clock, engine, transport, requests } = setup();
    let resolve!: (response: Response) => void;
    transport.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const entry = engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    clock.advanceBy(30_000);
    await flush();
    expect(transport).toHaveBeenCalledTimes(2);
    resolve(new Response(null, { status: 200 }));
    await entry;
    clock.advanceBy(30_000);
    await flush();
    expect(requests.some((r) => r.entity === 'light.bar')).toBe(true);
  });
});
