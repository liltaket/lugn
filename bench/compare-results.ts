/**
 * Compares benchmark result files (from bench/lighting-latency.ts --out).
 *
 *   node dist-bench/bench/compare-results.js [--runs=train|test] baseline.json candidate.json ...
 *
 * `--runs` keeps only workloads whose name starts with that prefix.
 */
import { readFileSync } from 'node:fs';
import {
  checkpointDifferences,
  segments,
  summarize,
  type SimulationResult,
  type Summary,
} from './lighting-sim/index.js';

type ResultFile = { summary: Summary; results: SimulationResult[] };
const args = process.argv.slice(2);
const runs = args.find((arg) => arg.startsWith('--runs='))?.slice(7);
const files = args
  .filter((arg) => !arg.startsWith('--'))
  .map((path) => {
    const file = JSON.parse(readFileSync(path, 'utf8')) as ResultFile;
    if (!runs) return file;
    const results = file.results.filter((result) =>
      result.workload.startsWith(runs),
    );
    return { summary: summarize(file.summary.label, results), results };
  });
if (files.length < 2)
  throw new Error('Pass a baseline and at least one candidate');
const [baseline] = files as [ResultFile, ...ResultFile[]];
const format = (value: number | undefined): string =>
  value === undefined || Number.isNaN(value)
    ? '–'
    : value >= 100
      ? value.toFixed(0)
      : value.toFixed(1);

const labels = files.map((file) => file.summary.label);
for (const kind of ['prelight', 'occupied', 'empty', 'all']) {
  console.log(`\n### ${kind}\n`);
  console.log(
    `| segment | ${labels.map((label) => `${label} P50 / P95 / P99`).join(' | ')} |`,
  );
  console.log(`| --- |${labels.map(() => ' ---: |').join('')}`);
  for (const segment of segments) {
    const cells = files.map((file) => {
      const value = file.summary.segments[kind]?.[segment];
      return value && value.n > 0
        ? `${format(value.p50)} / ${format(value.p95)} / ${format(value.p99)}`
        : '–';
    });
    console.log(`| ${segment} | ${cells.join(' | ')} |`);
  }
}
console.log('\n### commands\n');
const totalKeys = Object.keys(baseline.summary.totals) as Array<
  keyof Summary['totals']
>;
console.log(`| total | ${labels.join(' | ')} |`);
console.log(`| --- |${labels.map(() => ' ---: |').join('')}`);
for (const key of totalKeys)
  console.log(
    `| ${key} | ${files.map((file) => String(file.summary.totals[key])).join(' | ')} |`,
  );
console.log('\n### settled checkpoints differing from the first file\n');
for (const file of files.slice(1)) {
  const differences = checkpointDifferences(baseline.results, file.results);
  const checkpoints = file.results.reduce(
    (sum, result) => sum + result.checkpoints.length,
    0,
  );
  console.log(
    `- ${file.summary.label}: ${differences.length} of ${checkpoints} checkpoints differ`,
  );
  for (const difference of differences.slice(0, 12))
    console.log(
      `  - ${difference.workload} episode ${difference.episode} (${difference.label}): ${JSON.stringify(difference.baseline)} vs ${JSON.stringify(difference.candidate)}`,
    );
}
