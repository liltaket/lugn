// Run after npm run build. Uses an in-memory adapter and never contacts devices.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { LugnEngine } from '../dist/application/lugn-engine.js';
import { FakeClock } from '../dist/core/clock.js';

const targets = Array.from({ length: 7 }, (_, i) => `lighting.entry_${i}`);
const lighting = Object.fromEntries(
  targets.map((target) => [
    target,
    { power: true, brightness: 42, colorTemperature: 2700 },
  ]),
);
const runs = [];

for (let run = 0; run < 5; run += 1) {
  const clock = new FakeClock(Date.parse('2026-10-18T12:00:00+02:00'));
  const requests = [];
  let startedAt;
  const engine = new LugnEngine(clock, {
    deviceIds: [...targets, 'lighting.ceiling'],
    scenes: [
      {
        id: 'scene.entry',
        name: 'Entry',
        lighting: { ...lighting, 'lighting.ceiling': { power: false } },
      },
    ],
    defaultSceneId: 'scene.entry',
    prelight: { targets: {} },
    adapter: {
      async dispatch(command) {
        requests.push({
          target: command.target,
          ms: performance.now() - startedAt,
        });
      },
      subscribe: () => () => {},
    },
  });

  // Model a long-running engine with full, terminal command/diagnostic history.
  // These records belong only to this throwaway engine, not the live service.
  for (let i = 0; i < 256; i += 1) {
    engine.state.commands.push({
      id: `benchmark-history-${i}`,
      target: targets[i % targets.length],
      controller: targets[i % targets.length],
      revision: 0,
      desired: { power: false },
      source: 'benchmark',
      reason: 'Historical confirmed command in isolated prelight benchmark',
      actor: { type: 'automation', id: 'benchmark' },
      issuedAt: clock.now() - 60_000,
      confirmedAt: clock.now() - 59_000,
      status: 'confirmed',
      confirmedProperties: ['power'],
    });
    engine.state.diagnostics.push({
      id: i,
      at: clock.now() - 59_000,
      kind: 'benchmark.history',
      message: 'Historical diagnostic in isolated prelight benchmark',
      details: {},
    });
  }
  for (let i = 0; i < 128; i += 1) {
    engine.state.timings.push({
      eventId: `benchmark-${i}`,
      eventReceivedAt: clock.now() - 60_000,
      decisionCompletedAt: clock.now() - 60_000,
      eventToDecisionMs: 0,
    });
  }

  startedAt = performance.now();
  const work = engine.handlePrelight({
    type: 'presence.prelight',
    active: true,
  });
  const kickoffMs = performance.now() - startedAt;
  assert.deepEqual(
    requests.map(({ target }) => target),
    targets,
  );
  runs.push({
    firstRequestMs: requests[0].ms,
    lastRequestMs: requests.at(-1).ms,
    requestSpreadMs: requests.at(-1).ms - requests[0].ms,
    kickoffMs,
  });
  await work;
  engine.dispose();
}

const median = (key) =>
  runs.map((run) => run[key]).sort((a, b) => a - b)[
    Math.floor(runs.length / 2)
  ];
console.log(
  JSON.stringify(
    {
      mode: 'isolated in-memory adapter; no device requests',
      runs,
      medianMs: Object.fromEntries(
        Object.keys(runs[0]).map((key) => [key, median(key)]),
      ),
    },
    null,
    2,
  ),
);
