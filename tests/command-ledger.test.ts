import { describe, expect, it } from 'vitest';
import { FakeClock } from '../src/core/clock.js';
import { CommandLedger } from '../src/execution/command-ledger.js';

describe('CommandLedger', () => {
  const input = {
    target: 'lighting.desk',
    controller: 'lighting.desk',
    revision: 3,
    desired: { power: true },
    source: 'test',
    reason: 'test command',
    actor: { type: 'automation' as const },
  };

  it('bounds terminal history while retaining and attributing every pending command', () => {
    const clock = new FakeClock(10);
    const ledger = new CommandLedger(clock, 60_000, 2);
    const pending = ledger.issue({ ...input, target: 'lighting.ceiling' });
    const retired = ledger.issue(input);
    ledger.cancel(retired.id, 'finished');
    for (let index = 0; index < 10; index += 1) {
      const command = ledger.issue(input);
      ledger.cancel(command.id, 'finished');
    }
    expect(ledger.records).toHaveLength(3);
    expect(ledger.records).toContain(pending);
    expect(ledger.records).not.toContain(retired);
    expect(ledger.isKnownCommandId(retired.id)).toBe(true);
    expect(
      ledger.attributeObservation(
        'lighting.ceiling',
        'power',
        true,
        clock.now(),
      ),
    ).toBe(pending);
    expect(pending.status).toBe('confirmed');
    expect(ledger.records).toHaveLength(2);
  });

  it('recognizes retired IDs precisely and retains latest IDs for quiet targets', () => {
    const ledger = new CommandLedger(new FakeClock(10), 60_000, 1);
    const quiet = ledger.issue({ ...input, target: 'lighting.ceiling' });
    ledger.cancel(quiet.id, 'finished');
    const newest = ledger.issue(input);
    ledger.cancel(newest.id, 'finished');
    expect(ledger.records).toEqual([newest]);
    expect(ledger.latestCommandId('lighting.ceiling')).toBe(quiet.id);
    expect(ledger.isKnownCommandId(quiet.id)).toBe(true);
    expect(ledger.isKnownCommandId(quiet.id + 'x')).toBe(false);
    expect(ledger.isKnownCommandId(newest.id.replace(/-2$/, '-3'))).toBe(false);
    expect(ledger.isKnownCommandId(newest.id.replace(/-2$/, '-02'))).toBe(
      false,
    );
    expect(
      ledger.isKnownCommandId(
        new CommandLedger(new FakeClock()).issue(input).id,
      ),
    ).toBe(false);
    expect(ledger.isKnownCommandId('cmd-unrecognized')).toBe(false);
  });

  it('supports cancellation and invalidation with diagnostic reasons', () => {
    const ledger = new CommandLedger(new FakeClock(10));
    const input = {
      target: 'lighting.desk',
      controller: 'lighting.desk',
      revision: 3,
      desired: { power: true },
      source: 'test',
      reason: 'test command',
      actor: { type: 'automation' as const },
    };
    const cancelled = ledger.issue(input);
    const invalidated = ledger.issue(input);

    expect(ledger.cancel(cancelled.id, 'test cancellation')).toBe(true);
    expect(ledger.invalidate(invalidated.id, 'new intent arrived')).toBe(true);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.diagnosticReason).toBe('test cancellation');
    expect(invalidated.status).toBe('invalidated');
    expect(invalidated.diagnosticReason).toBe('new intent arrived');
    expect(ledger.cancel(cancelled.id, 'duplicate cancellation')).toBe(false);
  });

  it('does not mistake a manual value matching a superseded command for its feedback', () => {
    const clock = new FakeClock(10);
    const ledger = new CommandLedger(clock);
    const old = ledger.issue({ ...input, desired: { brightness: 20 } });
    ledger.supersedePending('A newer scene was selected');
    ledger.issue({ ...input, desired: { brightness: 60 } });

    expect(
      ledger.attributeObservation(
        input.target,
        'brightness',
        20,
        clock.now() + 2_000,
      ),
    ).toBeUndefined();
    expect(old.status).toBe('superseded');
  });

  it('only exposes a recent superseded match within a short feedback window', () => {
    const clock = new FakeClock(10);
    const ledger = new CommandLedger(clock);
    const old = ledger.issue({ ...input, desired: { brightness: 20 } });
    clock.advanceBy(30_000);
    ledger.supersedePending('Superseded by scene revision 4');

    expect(
      ledger.recentSupersededMatch(
        input.target,
        'brightness',
        20,
        clock.now() + 2_000,
      ),
    ).toBe(old);
    expect(
      ledger.recentSupersededMatch(
        input.target,
        'brightness',
        20,
        clock.now() + 10_001,
      ),
    ).toBeUndefined();
    expect(
      ledger.recentSupersededMatch(
        input.target,
        'brightness',
        30,
        clock.now() + 2_000,
      ),
    ).toBeUndefined();
  });
});
