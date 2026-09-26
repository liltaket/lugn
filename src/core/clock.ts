export type TimerHandle = ReturnType<typeof setTimeout>;

export interface Clock {
  now(): number;
  monotonicNow(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonicNow: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

export class FakeClock implements Clock {
  private currentTime: number;
  private currentMonotonicTime = 0;
  private nextId = 1;
  private readonly timers = new Map<
    number,
    { at: number; callback: () => void }
  >();

  constructor(startAt = 0) {
    this.currentTime = startAt;
  }

  now(): number {
    return this.currentTime;
  }

  monotonicNow(): number {
    return this.currentMonotonicTime;
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, {
      at: this.currentTime + Math.max(0, delayMs),
      callback,
    });
    return id as unknown as TimerHandle;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as unknown as number);
  }

  advanceBy(durationMs: number): void {
    const target = this.currentTime + durationMs;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.currentMonotonicTime += timer.at - this.currentTime;
      this.currentTime = timer.at;
      timer.callback();
    }
    this.currentMonotonicTime += target - this.currentTime;
    this.currentTime = target;
  }

  pendingTimers(): number {
    return this.timers.size;
  }
}
