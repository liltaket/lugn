/** Small seeded generators so every workload and latency sample replays. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash for keyed samples (FNV-1a). */
export function hashKey(...parts: Array<string | number>): number {
  let hash = 0x811c9dc5;
  for (const char of parts.join('\u0000')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Keyed uniform sample: the value depends only on the key, never on how many
 * other samples were drawn. Candidates that send fewer or reordered commands
 * still see the same latency for the same (entity, nth command) pair.
 */
export function keyedUniform(...parts: Array<string | number>): number {
  return mulberry32(hashKey(...parts))();
}

/** A latency distribution in milliseconds. */
export type LatencyDistribution =
  | { kind: 'fixed'; ms: number }
  | { kind: 'uniform'; minMs: number; maxMs: number }
  /** Log-normal parameterized by median and P95 (both > 0). */
  | { kind: 'lognormal'; medianMs: number; p95Ms: number; maxMs?: number }
  | {
      kind: 'mixture';
      parts: Array<{ weight: number; distribution: LatencyDistribution }>;
    };

export function sampleLatency(
  distribution: LatencyDistribution,
  uniform: () => number,
): number {
  switch (distribution.kind) {
    case 'fixed':
      return distribution.ms;
    case 'uniform':
      return (
        distribution.minMs +
        (distribution.maxMs - distribution.minMs) * uniform()
      );
    case 'lognormal': {
      const sigma =
        Math.log(distribution.p95Ms / distribution.medianMs) / 1.645;
      // Box-Muller with guarded logarithm.
      const u1 = Math.max(uniform(), 1e-12);
      const u2 = uniform();
      const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const value = distribution.medianMs * Math.exp(sigma * normal);
      return Math.min(value, distribution.maxMs ?? Number.POSITIVE_INFINITY);
    }
    case 'mixture': {
      const total = distribution.parts.reduce(
        (sum, part) => sum + part.weight,
        0,
      );
      let pick = uniform() * total;
      for (const part of distribution.parts) {
        pick -= part.weight;
        if (pick <= 0) return sampleLatency(part.distribution, uniform);
      }
      return sampleLatency(distribution.parts.at(-1)!.distribution, uniform);
    }
  }
}

/** Sample keyed by stable parts; see keyedUniform. */
export function keyedLatency(
  distribution: LatencyDistribution,
  ...parts: Array<string | number>
): number {
  return sampleLatency(distribution, mulberry32(hashKey(...parts)));
}
