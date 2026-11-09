/**
 * Lighting latency benchmark: MQTT presence event -> Lugn decision -> Home
 * Assistant light command, against simulated MQTT/HA. Offline only; never
 * contacts devices or a real Home Assistant.
 *
 *   npm run bench:lighting -- --label baseline --set all --out results.json
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  formatSummaryTable,
  generateWorkload,
  runSimulation,
  summarize,
  testMix,
  trainingMix,
  type SimulationResult,
  type WorkloadOptions,
} from './lighting-sim/index.js';

const { values } = parseArgs({
  options: {
    label: { type: 'string', default: 'run' },
    set: { type: 'string', default: 'train' },
    episodes: { type: 'string', default: '120' },
    'cpu-scale': { type: 'string', default: '1' },
    'adapter-options': { type: 'string' },
    transport: { type: 'string', default: 'websocket' },
    out: { type: 'string' },
  },
});

type RunSpec = { workload: WorkloadOptions; profile: string };
const episodes = Number(values.episodes);
const train: RunSpec[] = [101, 102].map((seed) => ({
  workload: { name: `train-${seed}`, seed, episodes, mix: trainingMix },
  profile: 'brunocam-fitted',
}));
const test: RunSpec[] = [
  {
    workload: { name: 'test-201', seed: 201, episodes, mix: testMix },
    profile: 'unseen-slow-ha',
  },
  {
    workload: { name: 'test-202', seed: 202, episodes, mix: testMix },
    profile: 'unseen-wifi-jitter',
  },
];
const specs =
  values.set === 'train'
    ? train
    : values.set === 'test'
      ? test
      : [...train, ...test];
const cpuScale = Number(values['cpu-scale']);
const adapterOptions = values['adapter-options']
  ? (JSON.parse(values['adapter-options']) as Record<string, unknown>)
  : undefined;

const results: SimulationResult[] = [];
for (const spec of specs) {
  const workload = generateWorkload(spec.workload);
  const result = await runSimulation(workload, {
    profile: spec.profile,
    cpuScale,
    commandTransport: values.transport === 'rest' ? 'rest' : 'websocket',
    ...(adapterOptions ? { adapterOptions } : {}),
  });
  results.push(result);
  console.error(
    `${spec.workload.name}/${spec.profile}: ${result.events.length} events, ${result.totals.serviceCalls} calls, ${result.wallMs.toFixed(0)} ms wall`,
  );
}
const summary = summarize(values.label, results);
console.log(`\n## ${values.label} (${values.set}, cpuScale ${cpuScale})\n`);
console.log(formatSummaryTable(summary));
console.log(`\ntotals: ${JSON.stringify(summary.totals)}`);
if (values.out)
  writeFileSync(values.out, JSON.stringify({ summary, results }, null, 1));
