import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { HomeAssistantLightingAdapter } from '../src/adapters/home-assistant-lighting.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import { CommandLedger } from '../src/execution/command-ledger.js';
import { lightingFeedbackBrowserScript } from '../src/runtime/lighting-feedback-script.js';

const target = 'lighting.bar';
const commandInput = {
  target,
  controller: target,
  revision: 1,
  source: 'test',
  reason: 'test',
  actor: { type: 'user' as const },
};
const engines: LugnEngine[] = [];
afterEach(() => engines.splice(0).forEach((engine) => engine.dispose()));
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
function setup(enforce = false, prelight = false) {
  const clock = new FakeClock(Date.parse('2026-10-13T12:00:00+02:00'));
  const requests: Array<Record<string, unknown>> = [];
  const adapter = new HomeAssistantLightingAdapter(
    {
      baseUrl: 'http://ha.test',
      token: 'test',
      entities: { [target]: 'light.bar' },
    },
    async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response('[]', { status: 200 });
    },
    clock,
  );
  const engine = new LugnEngine(clock, {
    adapter,
    deviceIds: [target],
    scenes: [2700, 4000].map((kelvin) => ({
      id: `scene.k${kelvin}`,
      name: String(kelvin),
      lighting: {
        [target]: { power: true, brightness: 3, colorTemperature: kelvin },
      },
    })),
    lightingControlModes: enforce ? { [target]: 'enforce' } : {},
    retryDelayMs: 250,
    ...(prelight
      ? {
          prelight: {
            targets: {
              [target]: { power: true, brightness: 3, colorTemperature: 2700 },
            },
            maxDurationMs: 5000,
          },
        }
      : {}),
  });
  engines.push(engine);
  const report = (kelvin: number) =>
    adapter.acceptStateChangedEvent({
      entity_id: 'light.bar',
      new_state: {
        entity_id: 'light.bar',
        state: 'on',
        attributes: {
          brightness: 8,
          color_mode: 'color_temp',
          color_temp_kelvin: kelvin,
        },
      },
    });
  return { clock, requests, engine, report };
}

describe('one percent Kelvin feedback tolerance', () => {
  it.each([
    [2699, 'good'],
    [2727, 'good'],
    [2728, 'warn'],
  ])(
    'uses the same tolerance for dashboard status and summary at %i K',
    (reported, tone) => {
      const source = readFileSync(
        new URL('../web/app.js', import.meta.url),
        'utf8',
      );
      const status = source.match(
        /function convergenceStatus\([^)]*\) \{[\s\S]*?\n\}/,
      )![0];
      const summary = source.match(
        /function renderMappingSummary\([^)]*\) \{[\s\S]*?\n\}/,
      )![0];
      const device = {
        availability: 'available',
        effectiveDesired: {
          power: true,
          brightness: 3,
          colorTemperature: 2700,
        },
        observed: { power: true, brightness: 3, colorTemperature: reported },
      };
      const context = createContext({
        device,
        mappingSummary: { textContent: '' },
      });
      runInContext(
        lightingFeedbackBrowserScript + status + '\n' + summary,
        context,
      );
      expect(
        runInContext("convergenceStatus(device, 'occupied').tone", context),
      ).toBe(tone);
      runInContext(
        "renderMappingSummary({ bar: device }, 'occupied')",
        context,
      );
      expect(runInContext('mappingSummary.textContent', context)).toContain(
        tone === 'good' ? 'rapporterade värden stämmer' : 'avviker',
      );
    },
  );
  it.each([
    [2700, 2699, true],
    [2700, 2702, true],
    [2700, 2673, true],
    [2700, 2727, true],
    [2700, 2672, false],
    [2700, 2728, false],
    [4000, 3960, true],
    [4000, 4040, true],
    [4000, 4041, false],
    [6500, 6565, true],
    [6500, 6566, false],
  ])(
    'attributes %i K feedback %i K only within tolerance (%s)',
    (wanted, reported, matches) => {
      const ledger = new CommandLedger(new FakeClock(1000));
      const command = ledger.issue({
        ...commandInput,
        desired: { colorTemperature: wanted },
      });
      expect(
        !!ledger.attributeObservation(
          target,
          'colorTemperature',
          reported,
          1000,
        ),
      ).toBe(matches);
      expect(command.status).toBe(matches ? 'confirmed' : 'pending');
      expect(command.desired.colorTemperature).toBe(wanted);
    },
  );

  it('uses tolerance for explicit command feedback and superseded observations, but exact pending intent', () => {
    const clock = new FakeClock(1000);
    const ledger = new CommandLedger(clock);
    const old = ledger.issue({
      ...commandInput,
      desired: { colorTemperature: 2700 },
    });
    expect(
      ledger.latestPending(target, 'colorTemperature', 2720),
    ).toBeUndefined();
    ledger.supersedePending('New scene');
    const current = ledger.issue({
      ...commandInput,
      desired: { colorTemperature: 4000 },
    });
    expect(
      ledger.recentSupersededMatch(
        target,
        'colorTemperature',
        2702,
        clock.now(),
      ),
    ).toBe(old);
    expect(
      ledger.attributeObservation(
        target,
        'colorTemperature',
        3960,
        clock.now(),
        current.id,
      ),
    ).toBe(current);
    expect(current.status).toBe('confirmed');
    clock.advanceBy(10001);
    expect(
      ledger.recentSupersededMatch(
        target,
        'colorTemperature',
        2702,
        clock.now(),
      ),
    ).toBeUndefined();
  });

  it('still requires exact power and brightness feedback', () => {
    const ledger = new CommandLedger(new FakeClock(1000));
    const command = ledger.issue({
      ...commandInput,
      desired: { power: true, brightness: 100 },
    });
    expect(
      ledger.attributeObservation(target, 'power', false, 1000),
    ).toBeUndefined();
    expect(
      ledger.attributeObservation(target, 'brightness', 99, 1000),
    ).toBeUndefined();
    expect(command.status).toBe('pending');
  });

  it.each([false, true])(
    'confirms rounded Kelvin, retains actual readback and stops retries/enforcement (%s)',
    async (enforce) => {
      const { engine, clock, requests, report } = setup(enforce);
      await engine.activateScene('scene.k2700', { type: 'user' });
      report(2699);
      await flush();
      expect(engine.state.commands.at(-1)?.status).toBe('confirmed');
      expect(
        engine.state.lighting.devices[target]?.observed.colorTemperature,
      ).toBe(2699);
      expect(
        engine.state.lighting.devices[target]?.effectiveDesired
          .colorTemperature,
      ).toBe(2700);
      expect(engine.state.lighting.devices[target]?.availability).toBe(
        'available',
      );
      clock.advanceBy(90000);
      await flush();
      report(2702);
      await flush();
      clock.advanceBy(30000);
      await flush();
      expect(requests).toHaveLength(1);
      expect(
        engine.state.lighting.devices[target]?.ownership.colorTemperature?.kind,
      ).toBe('scene');
      expect(
        engine.state.diagnostics.some(
          (d) => d.kind === 'lighting.color_temperature_reasserted',
        ),
      ).toBe(false);
    },
  );

  it('retries genuinely different Kelvin without changing the scene goal', async () => {
    const { engine, clock, requests, report } = setup();
    await engine.activateScene('scene.k2700', { type: 'user' });
    report(2728);
    await flush();
    expect(engine.state.commands.at(-1)?.status).toBe('pending');
    clock.advanceBy(250);
    await flush();
    expect(requests).toHaveLength(2);
    expect(requests.at(-1)?.['color_temp_kelvin']).toBe(2700);
  });

  it('recognizes rounded delayed feedback for a superseded scene', async () => {
    const { engine, clock, requests, report } = setup();
    await engine.activateScene('scene.k2700', { type: 'user' });
    await engine.activateScene('scene.k4000', { type: 'user' });
    report(2702);
    await flush();
    clock.advanceBy(250);
    await flush();
    expect(requests.at(-1)?.['color_temp_kelvin']).toBe(4000);
    expect(
      engine.state.lighting.devices[target]?.effectiveDesired.colorTemperature,
    ).toBe(4000);
    report(3960);
    await flush();
    expect(engine.state.commands.at(-1)?.status).toBe('confirmed');
  });

  it('finishes prelight timing when rounded Kelvin reaches the goal', async () => {
    const { engine, report } = setup(false, true);
    await engine.handlePrelight({ type: 'presence.prelight', active: true });
    report(2699);
    await flush();
    expect(engine.state.timings.at(-1)?.fullConvergenceAt).toBeDefined();
  });
});
