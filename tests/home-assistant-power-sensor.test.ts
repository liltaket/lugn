import { describe, expect, it } from 'vitest';
import { HomeAssistantPowerSensorAdapter } from '../src/adapters/home-assistant-power-sensor.js';
import { FakeClock } from '../src/core/clock.js';
import { classifyPower } from '../src/core/display-power.js';

const ENTITY = 'sensor.monitor_plug_power';
const thresholds = { onAboveWatts: 15, standbyBelowWatts: 3, settleMs: 20_000 };
const state = (
  value: string | number,
  extra: Record<string, unknown> = {},
) => ({
  entity_id: ENTITY,
  state: value,
  attributes: { unit_of_measurement: 'W' },
  ...extra,
});
function make() {
  const clock = new FakeClock(1_000_000);
  let changes = 0;
  const sensor = new HomeAssistantPowerSensorAdapter({
    entityId: ENTITY,
    thresholds,
    clock,
    onChange: () => (changes += 1),
  });
  return { clock, sensor, changes: () => changes };
}

describe('classifyPower', () => {
  it('uses hysteresis between the thresholds', () => {
    expect(classifyPower(30, thresholds, 'unknown')).toBe('on');
    expect(classifyPower(1, thresholds, 'unknown')).toBe('standby');
    expect(classifyPower(8, thresholds, 'on')).toBe('on');
    expect(classifyPower(8, thresholds, 'standby')).toBe('standby');
    expect(classifyPower(8, thresholds, 'unknown')).toBe('unknown');
    expect(classifyPower(null, thresholds, 'on')).toBe('unknown');
    expect(classifyPower(-1, thresholds, 'on')).toBe('unknown');
  });
});

describe('HomeAssistantPowerSensorAdapter', () => {
  it('starts unknown and trusts the first usable reading immediately', () => {
    const { sensor, changes } = make();
    expect(sensor.getEvidence().state).toBe('unknown');
    sensor.acceptState(state('32.4'));
    expect(sensor.getEvidence()).toMatchObject({ state: 'on', watts: 32.4 });
    expect(changes()).toBe(1);
  });

  it('reports a flip only after it has settled, ignoring transients', () => {
    const { sensor, clock } = make();
    sensor.acceptState(state(30));
    sensor.acceptState(state(1));
    expect(sensor.getEvidence().state).toBe('on');
    clock.advanceBy(19_999);
    expect(sensor.getEvidence().state).toBe('on');
    clock.advanceBy(1);
    expect(sensor.getEvidence()).toMatchObject({ state: 'standby', watts: 1 });
    // A spike back above the threshold that falls away again never commits.
    sensor.acceptState(state(25));
    clock.advanceBy(5_000);
    sensor.acceptState(state(1.5));
    clock.advanceBy(60_000);
    expect(sensor.getEvidence().state).toBe('standby');
  });

  it('treats unavailable, non-numeric and energy readings as unknown at once', () => {
    const { sensor } = make();
    sensor.acceptState(state(30));
    sensor.acceptState(state('unavailable'));
    expect(sensor.getEvidence()).toMatchObject({
      state: 'unknown',
      watts: null,
    });
    sensor.acceptState(state(30));
    sensor.acceptState(
      state(30, { attributes: { unit_of_measurement: 'kWh' } }),
    );
    expect(sensor.getEvidence().state).toBe('unknown');
  });

  it('normalises kW and mW', () => {
    const { sensor } = make();
    sensor.acceptState(
      state(0.03, { attributes: { unit_of_measurement: 'kW' } }),
    );
    expect(sensor.getEvidence()).toMatchObject({ state: 'on', watts: 30 });
    sensor.acceptState(
      state(1500, { attributes: { unit_of_measurement: 'mW' } }),
    );
    expect(sensor.getEvidence().watts).toBe(30);
  });

  it('accepts state_changed events, removal as unavailable, and ignores other entities', () => {
    const { sensor } = make();
    expect(
      sensor.acceptStateChangedEvent({
        type: 'event',
        event: {
          event_type: 'state_changed',
          data: { entity_id: ENTITY, new_state: state(40) },
        },
      }),
    ).toBe(true);
    expect(sensor.getEvidence().state).toBe('on');
    expect(
      sensor.acceptStateChangedEvent({
        entity_id: 'sensor.other',
        new_state: { entity_id: 'sensor.other', state: '1' },
      }),
    ).toBe(false);
    sensor.acceptStateChangedEvent({ entity_id: ENTITY, new_state: null });
    expect(sensor.getEvidence().state).toBe('unknown');
  });

  it('ignores out-of-order updates and forgets everything on invalidate', () => {
    const { sensor } = make();
    sensor.acceptState(state(30, { last_updated: '2026-11-20T10:00:10Z' }));
    sensor.acceptState(state(1, { last_updated: '2026-11-20T10:00:00Z' }));
    expect(sensor.getEvidence().state).toBe('on');
    sensor.invalidate();
    expect(sensor.getEvidence()).toMatchObject({
      state: 'unknown',
      watts: null,
      observedAt: null,
    });
  });
});
