import type { EventMeasurement, SimulationResult } from './simulation.js';

export type Percentiles = {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
};

/** Nearest-rank percentiles; NaN when there are no samples. */
export function percentiles(values: readonly number[]): Percentiles {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const rank = (p: number): number =>
    sorted.length === 0
      ? Number.NaN
      : sorted[
          Math.min(
            sorted.length - 1,
            Math.max(0, Math.ceil(p * sorted.length) - 1),
          )
        ]!;
  return {
    n: sorted.length,
    p50: rank(0.5),
    p95: rank(0.95),
    p99: rank(0.99),
    max: sorted.at(-1) ?? Number.NaN,
  };
}

export const segments = [
  'eventToDecisionMs',
  'decisionToFirstSentMs',
  'decisionToLastSentMs',
  'eventToLastSentMs',
  'eventToFirstPhysicalMs',
  'eventToLastPhysicalMs',
] as const satisfies ReadonlyArray<keyof EventMeasurement>;

export type Summary = {
  label: string;
  runs: Array<{
    workload: string;
    profile: string;
    seed: number;
    cpuScale: number;
  }>;
  /** kind -> segment -> percentiles. "all" pools every fast-path event. */
  segments: Record<string, Record<string, Percentiles>>;
  commandSent: Percentiles;
  commandPhysical: Percentiles;
  totals: SimulationResult['totals'] & { events: number; episodes: number };
};

export function summarize(
  label: string,
  results: readonly SimulationResult[],
): Summary {
  const events = results.flatMap((result) => result.events);
  const kinds = ['all', ...new Set(events.map((event) => event.kind))].sort();
  const bySegment: Summary['segments'] = {};
  for (const kind of kinds) {
    const selected =
      kind === 'all' ? events : events.filter((event) => event.kind === kind);
    bySegment[kind] = Object.fromEntries(
      segments.map((segment) => [
        segment,
        percentiles(
          selected
            .map((event) => event[segment])
            .filter((value): value is number => value !== undefined),
        ),
      ]),
    );
  }
  const totals = results.reduce(
    (sum, result) => {
      for (const key of Object.keys(result.totals) as Array<
        keyof SimulationResult['totals']
      >)
        sum[key] += result.totals[key];
      return sum;
    },
    {
      serviceCalls: 0,
      entityCommands: 0,
      noopEntityCommands: 0,
      restCalls: 0,
      websocketCalls: 0,
      wledRequests: 0,
      failedCalls: 0,
      unhandledRejections: 0,
    },
  );
  return {
    label,
    runs: results.map(({ workload, profile, seed, cpuScale }) => ({
      workload,
      profile,
      seed,
      cpuScale,
    })),
    segments: bySegment,
    commandSent: percentiles(results.flatMap((result) => result.commandSentMs)),
    commandPhysical: percentiles(
      results.flatMap((result) => result.commandPhysicalMs),
    ),
    totals: {
      ...totals,
      events: events.length,
      episodes: results.reduce(
        (sum, result) => sum + result.checkpoints.length,
        0,
      ),
    },
  };
}

/** Checkpoints whose settled light/presence state differs between runs. */
export function checkpointDifferences(
  baseline: readonly SimulationResult[],
  candidate: readonly SimulationResult[],
): Array<{
  workload: string;
  profile: string;
  episode: number;
  label: string;
  baseline: unknown;
  candidate: unknown;
}> {
  const differences = [];
  for (const base of baseline) {
    const other = candidate.find(
      (result) =>
        result.workload === base.workload &&
        result.profile === base.profile &&
        result.cpuScale === base.cpuScale,
    );
    if (!other) continue;
    for (const checkpoint of base.checkpoints) {
      const match = other.checkpoints.find(
        (entry) => entry.episode === checkpoint.episode,
      );
      if (JSON.stringify(match) !== JSON.stringify(checkpoint))
        differences.push({
          workload: base.workload,
          profile: base.profile,
          episode: checkpoint.episode,
          label: checkpoint.label,
          baseline: checkpoint,
          candidate: match,
        });
    }
  }
  return differences;
}

const format = (value: number): string =>
  Number.isNaN(value)
    ? '–'
    : value >= 100
      ? value.toFixed(0)
      : value.toFixed(1);

export function formatSummaryTable(
  summary: Summary,
  kinds = Object.keys(summary.segments),
): string {
  const lines = [
    `| kind | segment | n | P50 ms | P95 ms | P99 ms |`,
    `| --- | --- | ---: | ---: | ---: | ---: |`,
  ];
  for (const kind of kinds)
    for (const segment of segments) {
      const value = summary.segments[kind]?.[segment];
      if (!value || value.n === 0) continue;
      lines.push(
        `| ${kind} | ${segment} | ${value.n} | ${format(value.p50)} | ${format(value.p95)} | ${format(value.p99)} |`,
      );
    }
  return lines.join('\n');
}
