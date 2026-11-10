import { describe, expect, it } from 'vitest';
import { PresenceExitGrace } from '../src/application/presence-exit-grace.js';
import { FakeClock } from '../src/core/clock.js';
import type { PresenceInputEvent } from '../src/core/schemas.js';

const changed = (
  presence: 'occupied' | 'confirmed_empty' | 'unknown',
  extra: { localReceivedMonotonicAt?: number } = {},
): PresenceInputEvent => ({
  type: 'presence.changed',
  presence,
  personCount: presence === 'occupied' ? 1 : presence === 'unknown' ? null : 0,
  source: 'stl27l',
  ...extra,
});

function fixture(graceSeconds = 20) {
  const clock = new FakeClock(1_000);
  const forwarded: PresenceInputEvent[] = [];
  const holds: Array<{ startedAt: number; until: number }> = [];
  let graceMs = graceSeconds * 1000;
  const grace = new PresenceExitGrace({
    clock,
    graceMs: () => graceMs,
    forward: (event) => forwarded.push(event),
    onHold: (pending) => holds.push(pending),
  });
  return {
    clock,
    forwarded,
    holds,
    grace,
    setGraceMs: (value: number) => {
      graceMs = value;
      grace.settingsChanged();
    },
  };
}

const presences = (events: PresenceInputEvent[]) =>
  events.map((event) =>
    event.type === 'presence.changed' ? event.presence : event.type,
  );

describe('presence exit grace', () => {
  it('forwards entry immediately and delays confirmed empty', () => {
    const { clock, forwarded, grace } = fixture();
    grace.accept(changed('occupied'));
    expect(presences(forwarded)).toEqual(['occupied']);
    grace.accept(changed('confirmed_empty'));
    expect(presences(forwarded)).toEqual(['occupied']);
    clock.advanceBy(19_999);
    expect(presences(forwarded)).toEqual(['occupied']);
    clock.advanceBy(1);
    expect(presences(forwarded)).toEqual(['occupied', 'confirmed_empty']);
  });

  it('cancels the wait when the person returns, so nothing is forwarded', () => {
    const { clock, forwarded, grace } = fixture();
    grace.accept(changed('occupied'));
    grace.accept(changed('confirmed_empty'));
    clock.advanceBy(8_000);
    grace.accept(changed('occupied'));
    clock.advanceBy(60_000);
    expect(presences(forwarded)).toEqual(['occupied', 'occupied']);
    expect(clock.pendingTimers()).toBe(0);
    // The next exit gets a full wait of its own.
    grace.accept(changed('confirmed_empty'));
    clock.advanceBy(19_999);
    expect(presences(forwarded)).toHaveLength(2);
    clock.advanceBy(1);
    expect(presences(forwarded).at(-1)).toBe('confirmed_empty');
  });

  it('does not stretch the wait when the sensor repeats empty', () => {
    const { clock, forwarded, grace } = fixture();
    grace.accept(changed('occupied'));
    grace.accept(changed('confirmed_empty'));
    clock.advanceBy(10_000);
    grace.accept(changed('confirmed_empty'));
    clock.advanceBy(10_000);
    expect(presences(forwarded)).toEqual(['occupied', 'confirmed_empty']);
  });

  it('treats unknown as never shutting a room down', () => {
    const { clock, forwarded, grace } = fixture();
    grace.accept(changed('occupied'));
    grace.accept(changed('confirmed_empty'));
    clock.advanceBy(5_000);
    grace.accept(changed('unknown'));
    clock.advanceBy(60_000);
    expect(presences(forwarded)).toEqual(['occupied', 'unknown']);
    // Occupied then unknown then empty is still one exit, with the wait.
    grace.accept(changed('confirmed_empty'));
    expect(presences(forwarded)).toEqual(['occupied', 'unknown']);
    clock.advanceBy(20_000);
    expect(presences(forwarded).at(-1)).toBe('confirmed_empty');
  });

  it('acts immediately when no wait is configured or no exit follows an entry', () => {
    const none = fixture(0);
    none.grace.accept(changed('occupied'));
    none.grace.accept(changed('confirmed_empty'));
    expect(presences(none.forwarded)).toEqual(['occupied', 'confirmed_empty']);

    // After a restart the first report may be empty; there is no exit to wait on.
    const cold = fixture();
    cold.grace.accept(changed('confirmed_empty'));
    expect(presences(cold.forwarded)).toEqual(['confirmed_empty']);
    cold.grace.accept(changed('confirmed_empty'));
    expect(presences(cold.forwarded)).toEqual([
      'confirmed_empty',
      'confirmed_empty',
    ]);
  });

  it('passes prelight through and leaves the wait alone', () => {
    const { clock, forwarded, grace } = fixture();
    grace.accept(changed('occupied'));
    grace.accept(changed('confirmed_empty'));
    grace.accept({ type: 'presence.prelight', active: true });
    expect(presences(forwarded)).toEqual(['occupied', 'presence.prelight']);
    clock.advanceBy(20_000);
    expect(presences(forwarded).at(-1)).toBe('confirmed_empty');
  });

  it('does not report the wait as sensor receipt latency', () => {
    const { clock, forwarded, grace } = fixture();
    grace.accept(changed('occupied', { localReceivedMonotonicAt: 5 }));
    grace.accept(changed('confirmed_empty', { localReceivedMonotonicAt: 6 }));
    clock.advanceBy(20_000);
    expect(forwarded[0]).toMatchObject({ localReceivedMonotonicAt: 5 });
    expect(forwarded[1]).not.toHaveProperty('localReceivedMonotonicAt');
  });

  it('re-times a held exit from its start when the setting changes', () => {
    const { clock, forwarded, grace, setGraceMs } = fixture(60);
    grace.accept(changed('occupied'));
    grace.accept(changed('confirmed_empty'));
    clock.advanceBy(30_000);
    expect(grace.pendingUntil).toBe(61_000);
    setGraceMs(40_000);
    expect(grace.pendingUntil).toBe(41_000);
    clock.advanceBy(9_999);
    expect(presences(forwarded)).toEqual(['occupied']);
    clock.advanceBy(1);
    expect(presences(forwarded)).toEqual(['occupied', 'confirmed_empty']);
    expect(grace.pendingUntil).toBeNull();
  });

  it('releases a held exit at once when the wait is switched off', () => {
    const { clock, forwarded, grace, setGraceMs } = fixture(60);
    grace.accept(changed('occupied'));
    grace.accept(changed('confirmed_empty'));
    setGraceMs(0);
    clock.advanceBy(0);
    expect(presences(forwarded)).toEqual(['occupied', 'confirmed_empty']);
  });

  it('announces a wait when it starts and when it is re-timed, never for a repeat', () => {
    const { clock, grace, holds, setGraceMs } = fixture(60);
    grace.accept(changed('occupied'));
    expect(holds).toEqual([]);
    grace.accept(changed('confirmed_empty'));
    grace.accept(changed('confirmed_empty'));
    expect(holds).toEqual([{ startedAt: 1_000, until: 61_000 }]);
    clock.advanceBy(10_000);
    setGraceMs(30_000);
    expect(holds.at(-1)).toEqual({ startedAt: 1_000, until: 31_000 });
    expect(holds).toHaveLength(2);
  });

  it('drops a held exit on dispose', () => {
    const { clock, forwarded, grace } = fixture();
    grace.accept(changed('occupied'));
    grace.accept(changed('confirmed_empty'));
    grace.dispose();
    clock.advanceBy(60_000);
    expect(presences(forwarded)).toEqual(['occupied']);
  });
});
