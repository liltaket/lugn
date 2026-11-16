import type { Clock, TimerHandle } from '../../src/core/clock.js';

type Timer = { at: number; callback: () => void };

/**
 * Virtual time for the device simulator. It runs `speed` times faster than
 * wall time, can jump forward while firing every due timer in order, and never
 * goes backwards, so the engine sees one consistent, monotonic clock.
 *
 * In `manual` mode time only moves through `advanceBy`, which keeps the
 * scenario tests deterministic.
 */
export class SimClock implements Clock {
  private baseVirtual: number;
  private baseReal: number;
  private speedFactor: number;
  private frozenAt: number | undefined;
  private readonly origin: number;
  private readonly manual: boolean;
  private readonly timers = new Map<number, Timer>();
  private nextId = 1;
  private realTimer: ReturnType<typeof setTimeout> | undefined;
  private jumping = false;
  private jumpTarget = 0;
  private jumpDone: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly realNow: () => number;

  constructor(
    options: {
      startAt?: number;
      speed?: number;
      manual?: boolean;
      /** Wall-clock source, for tests. */
      realNow?: () => number;
    } = {},
  ) {
    this.realNow = options.realNow ?? (() => performance.now());
    this.baseVirtual = options.startAt ?? Date.now();
    this.baseReal = this.realNow();
    this.origin = this.baseVirtual;
    this.speedFactor = validSpeed(options.speed ?? 1);
    this.manual = options.manual ?? false;
    if (this.manual) this.frozenAt = this.baseVirtual;
  }

  /** True while `advanceBy` is firing timers. */
  get isJumping(): boolean {
    return this.jumping;
  }

  get speed(): number {
    return this.speedFactor;
  }

  now(): number {
    if (this.frozenAt !== undefined) return Math.floor(this.frozenAt);
    return Math.floor(
      this.baseVirtual + (this.realNow() - this.baseReal) * this.speedFactor,
    );
  }

  monotonicNow(): number {
    return this.now() - this.origin;
  }

  /** Virtual minus wall time, in milliseconds. */
  offsetFromWallClock(): number {
    return this.now() - Date.now();
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, {
      at: this.now() + Math.max(0, Number.isFinite(delayMs) ? delayMs : 0),
      callback,
    });
    this.arm();
    return id as unknown as TimerHandle;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as unknown as number);
  }

  /** Resolves after `delayMs` of virtual time. */
  sleep(delayMs: number): Promise<void> {
    return new Promise((resolve) => this.setTimeout(resolve, delayMs));
  }

  setSpeed(speed: number): void {
    const now = this.now();
    this.speedFactor = validSpeed(speed);
    if (this.frozenAt === undefined) {
      this.baseVirtual = now;
      this.baseReal = this.realNow();
    }
    this.arm();
  }

  /**
   * Jumps forward, firing due timers in order and yielding to the event loop
   * between them so promise chains started by one timer settle before the
   * next fires.
   */
  advanceBy(durationMs: number): Promise<void> {
    const target = this.now() + Math.max(0, durationMs);
    // A jump requested while jumping (a scenario step inside a test's
    // advance) extends the running jump instead of starting a second one.
    if (this.jumping) {
      this.jumpTarget = Math.max(this.jumpTarget, target);
      return this.jumpDone;
    }
    this.jumping = true;
    this.jumpTarget = target;
    this.jumpDone = this.runJump();
    return this.jumpDone;
  }

  private async runJump(): Promise<void> {
    this.frozenAt = this.now();
    this.disarm();
    try {
      for (;;) {
        await yieldToEventLoop();
        const next = this.nextDue(this.jumpTarget);
        if (!next) {
          this.frozenAt = Math.max(this.frozenAt, this.jumpTarget);
          // Let work started by the last timers request a longer jump.
          await yieldToEventLoop();
          if (this.nextDue(this.jumpTarget) || this.frozenAt < this.jumpTarget)
            continue;
          break;
        }
        this.timers.delete(next[0]);
        this.frozenAt = Math.max(this.frozenAt, next[1].at);
        runTimer(next[1]);
      }
    } finally {
      this.jumping = false;
      if (!this.manual) {
        this.baseVirtual = this.frozenAt ?? this.jumpTarget;
        this.baseReal = this.realNow();
        this.frozenAt = undefined;
      }
      this.arm();
    }
  }

  /** Jumps to an absolute virtual time; times in the past are ignored. */
  advanceTo(at: number): Promise<void> {
    return this.advanceBy(Math.max(0, at - this.now()));
  }

  pendingTimers(): number {
    return this.timers.size;
  }

  dispose(): void {
    this.disposed = true;
    this.disarm();
    this.timers.clear();
  }

  private nextDue(limit: number): [number, Timer] | undefined {
    let best: [number, Timer] | undefined;
    for (const entry of this.timers)
      if (
        entry[1].at <= limit &&
        (!best ||
          entry[1].at < best[1].at ||
          (entry[1].at === best[1].at && entry[0] < best[0]))
      )
        best = entry;
    return best;
  }

  private disarm(): void {
    if (this.realTimer !== undefined) clearTimeout(this.realTimer);
    this.realTimer = undefined;
  }

  private arm(): void {
    this.disarm();
    if (this.manual || this.jumping || this.disposed) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const timer of this.timers.values())
      earliest = Math.min(earliest, timer.at);
    if (earliest === Number.POSITIVE_INFINITY) return;
    const wait = Math.max(0, (earliest - this.now()) / this.speedFactor);
    this.realTimer = setTimeout(() => this.fire(), Math.min(wait, 2 ** 31 - 1));
    this.realTimer.unref();
  }

  private fire(): void {
    this.realTimer = undefined;
    const now = this.now();
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.at <= now)
      .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
    for (const [id, timer] of due) {
      if (!this.timers.delete(id)) continue;
      runTimer(timer);
    }
    this.arm();
  }
}

function runTimer(timer: Timer): void {
  try {
    timer.callback();
  } catch (error) {
    console.error('[device-sim] timer callback failed', error);
  }
}

function validSpeed(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0 || speed > 1000)
    throw new RangeError('speed must be greater than 0 and at most 1000');
  return speed;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
