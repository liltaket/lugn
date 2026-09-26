import { describe, expect, it } from 'vitest';
import { FakeClock } from '../src/core/clock.js';
import { CommandLedger } from '../src/execution/command-ledger.js';

describe('CommandLedger', () => {
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
});
