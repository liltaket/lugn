import { describe, expect, it } from 'vitest';
import { parseJump } from '../scripts/device-sim/commands.js';
import { nextStockholmTime } from '../scripts/device-sim/scenario.js';
import { SimClock } from '../scripts/device-sim/sim-clock.js';
import {
  shiftObservations,
  stockholmHour,
} from '../scripts/device-sim/sim-room.js';
import { allowedHostsFor } from '../scripts/device-sim/app.js';

const START = Date.parse('2026-11-16T18:00:00+01:00');

describe('SimClock', () => {
  it('scales wall time by the speed factor and stays continuous across speed changes', () => {
    let real = 1_000;
    const clock = new SimClock({
      startAt: START,
      speed: 20,
      realNow: () => real,
    });
    real += 1_000;
    expect(clock.now()).toBe(START + 20_000);
    clock.setSpeed(2);
    expect(clock.now()).toBe(START + 20_000);
    real += 500;
    expect(clock.now()).toBe(START + 21_000);
    expect(clock.monotonicNow()).toBe(21_000);
    expect(() => clock.setSpeed(0)).toThrow(RangeError);
    clock.dispose();
  });

  it('fires due timers in order during a jump, including timers they schedule', async () => {
    const clock = new SimClock({ startAt: START, manual: true });
    const fired: Array<[string, number]> = [];
    clock.setTimeout(() => fired.push(['b', clock.now() - START]), 2_000);
    clock.setTimeout(() => {
      fired.push(['a', clock.now() - START]);
      clock.setTimeout(() => fired.push(['a2', clock.now() - START]), 500);
    }, 1_000);
    const late = clock.setTimeout(() => fired.push(['late', 0]), 10_000);
    await clock.advanceBy(3_000);
    expect(fired).toEqual([
      ['a', 1_000],
      ['a2', 1_500],
      ['b', 2_000],
    ]);
    expect(clock.now()).toBe(START + 3_000);
    clock.clearTimeout(late);
    await clock.advanceBy(10_000);
    expect(fired).toHaveLength(3);
    clock.dispose();
  });

  it('lets a timer extend the running jump instead of failing', async () => {
    const clock = new SimClock({ startAt: START, manual: true });
    let nested: Promise<void> | undefined;
    clock.setTimeout(() => {
      nested = clock.advanceBy(60_000);
    }, 1_000);
    await clock.advanceBy(2_000);
    await nested;
    expect(clock.now()).toBe(START + 61_000);
    clock.dispose();
  });
});

describe('device-sim helpers', () => {
  it('finds the next Stockholm wall-clock time and parses jumps', () => {
    const at = nextStockholmTime(START, '22:44');
    expect(at - START).toBe((4 * 60 + 44) * 60_000);
    expect(stockholmHour(nextStockholmTime(START, '06:50'))).toBeCloseTo(
      6 + 50 / 60,
    );
    expect(nextStockholmTime(START, '18:00') - START).toBe(24 * 3_600_000);
    expect(parseJump('90s', START)).toBe(90_000);
    expect(parseJump('2h', START)).toBe(7_200_000);
    expect(parseJump('23:00', START)).toBe(5 * 3_600_000);
    expect(() => parseJump('soon', START)).toThrow();
  });

  it('moves phone timestamps onto the virtual clock without touching other fields', () => {
    const body = {
      sessionId: 's',
      observations: [
        { type: 'app', observedAt: 1_000, state: 'foreground' },
        { type: 'wake_alarm', observedAt: 2_000, at: 9_000, source: 'manual' },
        'malformed',
      ],
    };
    expect(shiftObservations(body, 500)).toEqual({
      sessionId: 's',
      observations: [
        { type: 'app', observedAt: 1_500, state: 'foreground' },
        { type: 'wake_alarm', observedAt: 2_500, at: 9_500, source: 'manual' },
        'malformed',
      ],
    });
    expect(shiftObservations(body, 0)).toBe(body);
    expect(shiftObservations('nope', 500)).toBe('nope');
  });

  it('accepts loopback Host values and, for a wildcard bind, LAN names too', () => {
    expect(allowedHostsFor('127.0.0.1', 8789)).toEqual([
      '127.0.0.1:8789',
      'localhost:8789',
    ]);
    expect(allowedHostsFor('192.168.1.20', 8789, ['lugn.lan'])).toEqual([
      '127.0.0.1:8789',
      'localhost:8789',
      '192.168.1.20:8789',
      'lugn.lan:8789',
    ]);
    const wildcard = allowedHostsFor('0.0.0.0', 8789);
    expect(wildcard).toContain('127.0.0.1:8789');
    expect(wildcard.some((host) => host.endsWith('.local:8789'))).toBe(true);
  });
});
