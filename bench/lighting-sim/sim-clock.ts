import { performance } from 'node:perf_hooks';
import type { Clock, TimerHandle } from '../../src/core/clock.js';

type Timer = { id: number; at: number; callback: () => void };

/** Main-thread CPU time in ms; coarse (sub-ms steps) but load-independent. */
function threadCpuMs(): number {
  const usage = process.threadCpuUsage();
  return (usage.user + usage.system) / 1000;
}

/** Wall time may lead thread CPU time by at most this before it is trimmed. */
const cpuSlackMs = 2;

/**
 * A clock whose elapsed time is the time Lugn's thread really runs plus
 * skipped idle time. Synchronous work is therefore measured as it runs
 * (optionally scaled to model a slower CPU), while modeled network/device
 * delays and idle gaps between workload steps cost no wall time.
 *
 * Measured time follows wall time for fine resolution but never runs more
 * than `cpuSlackMs` ahead of main-thread CPU time, so periods in which the
 * thread waits for a core on a loaded machine are not counted.
 */
export class SimClock implements Clock {
  private readonly cpu: () => number =
    typeof process.threadCpuUsage === 'function'
      ? threadCpuMs
      : () => performance.now();
  private cpuBase = this.cpu();
  private lastWall = performance.now();
  private measuredMs = 0;
  private skippedMs = 0;
  private nextId = 1;
  private readonly timers = new Map<number, Timer>();

  constructor(
    private readonly wallOrigin = Date.parse('2026-11-09T18:00:00+01:00'),
    /** Multiplies measured time, e.g. ~12 for a Raspberry Pi 3. */
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
    return this.sample() * this.cpuScale + this.skippedMs;
  }

  private sample(): number {
    const wall = performance.now();
    const ceiling = this.cpu() - this.cpuBase + cpuSlackMs;
    const candidate = this.measuredMs + Math.max(0, wall - this.lastWall);
    this.measuredMs = Math.max(this.measuredMs, Math.min(candidate, ceiling));
    this.lastWall = wall;
    return this.measuredMs;
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
    this.sample();
    const wallStarted = performance.now();
    const cpuStarted = this.cpu();
    try {
      return work();
    } finally {
      this.lastWall += performance.now() - wallStarted;
      this.cpuBase += this.cpu() - cpuStarted;
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
