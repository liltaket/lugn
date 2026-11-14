import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { HomeAssistantLightingAdapter } from '../src/adapters/home-assistant-lighting.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import {
  lightingFeedbackMatches,
  lightingIntentMatches,
} from '../src/core/lighting-feedback.js';
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
function setup(enforce = false, noScenes = false) {
  const clock = new FakeClock(Date.parse('2026-11-14T12:00:00+01:00'));
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
    scenes: noScenes
      ? []
      : [
          {
            id: 'scene.bright',
            name: 'Bright',
            lighting: {
              [target]: {
                power: true,
                brightness: 55,
                colorTemperature: 2700,
              },
            },
          },
        ],
    lightingControlModes: enforce ? { [target]: 'enforce' } : {},
    retryDelayMs: 250,
  });
  engines.push(engine);
  const reportRaw = (brightness: number) =>
    adapter.acceptStateChangedEvent({
      entity_id: 'light.bar',
      new_state: {
        entity_id: 'light.bar',
        state: 'on',
        attributes: {
          brightness,
          color_mode: 'color_temp',
          color_temp_kelvin: 2700,
        },
      },
    });
  const report = (brightness: number) =>
    reportRaw(Math.round((brightness / 100) * 255));
  return { clock, requests, engine, reportRaw, report };
}

describe('two percentage-point brightness readback tolerance', () => {
  it.each([
    [55, 55, true],
    [55, 53, true],
    [55, 57, true],
    [55, 52, false],
    [55, 58, false],
    [0, 2, true],
    [100, 98, true],
    [0, -1, false],
    [-1, 0, false],
    [100, 101, false],
    [101, 100, false],
    [NaN, 55, false],
    [55, NaN, false],
    [Infinity, Infinity, false],
    [-Infinity, -Infinity, false],
    [undefined, 55, false],
    [55, undefined, false],
    [true, 55, false],
  ] as const)(
    'matches desired %s and observed %s only within valid bounds (%s)',
    (desired, observed, matches) => {
      expect(lightingFeedbackMatches('brightness', desired, observed)).toBe(
        matches,
      );
    },
  );

  it.each([false, true])(
    'attributes rounded feedback with explicit command ID %s while keeping intent exact',
    (explicit) => {
      const clock = new FakeClock(1000);
      const ledger = new CommandLedger(clock);
      const command = ledger.issue({
        ...commandInput,
        desired: { brightness: 55 },
      });
      expect(ledger.latestPending(target, 'brightness', 54)).toBeUndefined();
      expect(ledger.latestPending(target, 'brightness', 55)).toBe(command);
      expect(lightingIntentMatches('brightness', 55, 54)).toBe(false);
      expect(
        ledger.attributeObservation(
          target,
          'brightness',
          54,
          clock.now(),
          explicit ? command.id : undefined,
        ),
      ).toBe(command);
      expect(command.status).toBe('confirmed');
      expect(command.desired.brightness).toBe(55);
    },
  );

  it('recognizes rounded superseded feedback only inside its bounded attribution window', () => {
    const clock = new FakeClock(1000);
    const ledger = new CommandLedger(clock);
    const old = ledger.issue({ ...commandInput, desired: { brightness: 55 } });
    ledger.supersedePending('New brightness');
    ledger.issue({ ...commandInput, desired: { brightness: 80 } });
    expect(
      ledger.recentSupersededMatch(target, 'brightness', 53, clock.now()),
    ).toBe(old);
    clock.advanceBy(10001);
    expect(
      ledger.recentSupersededMatch(target, 'brightness', 53, clock.now()),
    ).toBeUndefined();
  });

  it.each([
    [false, 137],
    [false, 138],
    [true, 137],
    [true, 138],
  ] as const)(
    'confirms actual HA readback %s/enforce, %i/255 without retries or degradation',
    async (enforce, raw) => {
      const { engine, clock, requests, reportRaw } = setup(enforce);
      await engine.activateScene('scene.bright', { type: 'user' });
      expect(requests.at(-1)?.['brightness_pct']).toBe(55);
      reportRaw(raw);
      await flush();
      expect(engine.state.commands.at(-1)?.status).toBe('confirmed');
      expect(engine.state.lighting.devices[target]?.observed.brightness).toBe(
        54,
      );
      expect(
        engine.state.lighting.devices[target]?.effectiveDesired.brightness,
      ).toBe(55);
      clock.advanceBy(90000);
      await flush();
      reportRaw(raw === 137 ? 138 : 137);
      await flush();
      clock.advanceBy(30000);
      await flush();
      const device = engine.state.lighting.devices[target];
      expect(requests).toHaveLength(1);
      expect(device?.availability).toBe('available');
      expect(device?.ownership.brightness?.kind).toBe('scene');
      expect(device?.effectiveDesired.brightness).toBe(55);
      expect(
        engine.state.diagnostics.some((d) => d.kind === 'command.retry_limit'),
      ).toBe(false);
    },
  );

  it('preserves manual intent through rounded reports and recognizes drift across the intent boundary', async () => {
    const { engine, clock, requests, report } = setup(false, true);
    await engine.setLighting(
      target,
      { power: true, brightness: 55, colorTemperature: 2700 },
      { actor: { type: 'user' }, source: 'manual-brightness' },
    );
    report(55);
    await flush();
    const ownership = structuredClone(
      engine.state.lighting.devices[target]?.ownership.brightness,
    );
    clock.advanceBy(61000);
    for (const brightness of [53, 57, 54, 55, 57]) {
      report(brightness);
      await flush();
      const device = engine.state.lighting.devices[target];
      expect(device?.observed.brightness).toBe(brightness);
      expect(device?.effectiveDesired.brightness).toBe(55);
      expect(device?.ownership.brightness).toEqual(ownership);
    }
    report(58);
    await flush();
    expect(
      engine.state.lighting.devices[target]?.effectiveDesired.brightness,
    ).toBe(58);
    expect(
      engine.state.lighting.devices[target]?.ownership.brightness,
    ).not.toEqual(ownership);
    expect(requests).toHaveLength(1);
  });

  it('does not turn intermediate or rounded pending HA feedback into a manual override', async () => {
    const { engine, report } = setup();
    await engine.activateScene('scene.bright', { type: 'user' });
    report(52);
    await flush();
    expect(engine.state.commands.at(-1)?.status).toBe('pending');
    expect(
      engine.state.lighting.devices[target]?.effectiveDesired.brightness,
    ).toBe(55);
    expect(
      engine.state.lighting.devices[target]?.ownership.brightness?.kind,
    ).toBe('scene');
    report(54);
    await flush();
    expect(engine.state.commands.at(-1)?.status).toBe('confirmed');
    expect(
      engine.state.lighting.devices[target]?.ownership.brightness?.kind,
    ).toBe('scene');
  });

  it('accepts genuine outside-tolerance scene changes after the pending window', async () => {
    const { engine, clock, report } = setup();
    await engine.activateScene('scene.bright', { type: 'user' });
    report(54);
    await flush();
    clock.advanceBy(61000);
    report(52);
    await flush();
    const device = engine.state.lighting.devices[target];
    expect(device?.effectiveDesired.brightness).toBe(52);
    expect(device?.ownership.brightness?.kind).toBe('override');
  });

  it('retries a genuine brightness mismatch without changing the command goal', async () => {
    const { engine, clock, requests, report } = setup();
    await engine.activateScene('scene.bright', { type: 'user' });
    report(52);
    await flush();
    expect(engine.state.commands.at(-1)?.status).toBe('pending');
    clock.advanceBy(250);
    await flush();
    expect(requests).toHaveLength(2);
    expect(requests.at(-1)?.['brightness_pct']).toBe(55);
    expect(
      engine.state.lighting.devices[target]?.effectiveDesired.brightness,
    ).toBe(55);
  });

  it.each([
    [53, 'good'],
    [57, 'good'],
    [52, 'warn'],
    [58, 'warn'],
  ])(
    'shares the readback boundary with web status at %i%%',
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
        effectiveDesired: { power: true, brightness: 55 },
        observed: { power: true, brightness: reported },
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
});
