import { performance } from 'node:perf_hooks';
import type { Clock, TimerHandle } from '../../src/core/clock.js';

type Timer = { id: number; at: number; callback: () => void };

/**
 * Main-thread CPU time in ms. Unlike wall time it does not advance while the
 * thread waits for a core, so measurements survive a loaded machine (other
 * benchmarks, simulators). Falls back to wall time on older runtimes.
 */
function threadCpuMs(): number {
  const usage = process.threadCpuUsage();
  return (usage.user + usage.system) / 1000;
}

/**
 * A clock whose elapsed time is the CPU time Lugn's thread really spends plus
 * skipped idle time. Synchronous work is therefore measured as it runs
 * (optionally scaled to model a slower CPU), while modeled network/device
 * delays and idle gaps between workload steps cost no wall time.
 */
export class SimClock implements Clock {
  private readonly source: () => number =
    typeof process.threadCpuUsage === 'function'
      ? threadCpuMs
      : () => performance.now();
  private readonly realOrigin = this.source();
  private skippedMs = 0;
  private excludedMs = 0;
  private nextId = 1;
  private readonly timers = new Map<number, Timer>();

  constructor(
    private readonly wallOrigin = Date.parse('2026-11-09T18:00:00+01:00'),
    /** Multiplies measured CPU time, e.g. ~12 for a Raspberry Pi 3. */
    readonly cpuScale = 1,
  ) {
    if (!Number.isFinite(cpuScale) || cpuScale <= 0)
      throw new Error('cpuScale must be positive');
  }

  now(): number {
    return this.wallOrigin + this.monotonicNow();
  }

  /** Converts a wall timestamp from this clock to its monotonic scale. */
  toMonotonic(wallAt: number): number {
    return wallAt - this.wallOrigin;
  }

  monotonicNow(): number {
    return (
      (this.source() - this.realOrigin - this.excludedMs) * this.cpuScale +
      this.skippedMs
    );
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const id = this.nextId++;
    const delay = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
    this.timers.set(id, { id, at: this.monotonicNow() + delay, callback });
    return id as unknown as TimerHandle;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as unknown as number);
  }

  /** Run simulator-side work (mock HA, broker) without charging it to Lugn. */
  excluded<T>(work: () => T): T {
    const started = this.source();
    try {
      return work();
    } finally {
      this.excludedMs += this.source() - started;
    }
  }

  /**
   * Charge modeled client CPU that the simulator does not execute itself,
   * such as undici request encoding. `referenceMs` is on the reference CPU
   * and is scaled like measured time.
   */
  chargeCpu(referenceMs: number): void {
    if (referenceMs > 0) this.skippedMs += referenceMs * this.cpuScale;
  }

  nextDueAt(): number | undefined {
    let next: number | undefined;
    for (const timer of this.timers.values())
      if (next === undefined || timer.at < next) next = timer.at;
    return next;
  }

  /** Skip idle time; never moves backwards. */
  skipTo(monotonicAt: number): void {
    const now = this.monotonicNow();
    if (monotonicAt > now) this.skippedMs += monotonicAt - now;
  }

  /** Fire the earliest due timer, if any. */
  runNextDue(): boolean {
    const now = this.monotonicNow();
    let next: Timer | undefined;
    for (const timer of this.timers.values())
      if (
        timer.at <= now &&
        (next === undefined ||
          timer.at < next.at ||
          (timer.at === next.at && timer.id < next.id))
      )
        next = timer;
    if (!next) return false;
    this.timers.delete(next.id);
    next.callback();
    return true;
  }

  pendingTimers(): number {
    return this.timers.size;
  }
}
