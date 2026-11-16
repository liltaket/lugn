import type { Clock } from '../core/clock.js';

/** Bounded per-key token buckets; the oldest key is evicted beyond `maxKeys`. */
export class TokenBucketLimiter {
  private readonly buckets = new Map<
    string,
    { tokens: number; updatedAt: number }
  >();

  constructor(
    private readonly clock: Pick<Clock, 'monotonicNow'>,
    private readonly options: {
      capacity: number;
      refillPerMinute: number;
      maxKeys?: number;
    },
  ) {}

  /** Returns 0 when allowed, otherwise the whole seconds until one token is available. */
  take(key: string, cost = 1): number {
    const now = this.clock.monotonicNow();
    const existing = this.buckets.get(key);
    const ratePerMs = this.options.refillPerMinute / 60_000;
    const bucket = existing ?? {
      tokens: this.options.capacity,
      updatedAt: now,
    };
    bucket.tokens = Math.min(
      this.options.capacity,
      bucket.tokens + Math.max(0, now - bucket.updatedAt) * ratePerMs,
    );
    bucket.updatedAt = now;
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    if (this.buckets.size > (this.options.maxKeys ?? 256))
      this.buckets.delete(this.buckets.keys().next().value!);
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return 0;
    }
    return Math.max(1, Math.ceil((cost - bucket.tokens) / ratePerMs / 1000));
  }
}
