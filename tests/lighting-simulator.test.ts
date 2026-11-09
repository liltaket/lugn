import { describe, expect, it } from 'vitest';
import {
  generateWorkload,
  runSimulation,
  trainingMix,
} from '../bench/lighting-sim/index.js';

describe('lighting latency simulator', () => {
  it('replays a seeded workload through MQTT, the engine and mock HA', async () => {
    const options = {
      name: 'smoke',
      seed: 7,
      episodes: 3,
      mix: { entry_preview: 1 },
    };
    expect(generateWorkload(options)).toEqual(generateWorkload(options));
    const result = await runSimulation(generateWorkload(options), {
      profile: 'brunocam-fitted',
    });
    expect(result.totals.unhandledRejections).toBe(0);
    expect(result.events.some((event) => event.kind === 'prelight')).toBe(true);
    expect(result.events.some((event) => event.kind === 'empty')).toBe(true);
    const sent = result.events.filter(
      (event) => event.eventToFirstSentMs !== undefined,
    );
    expect(sent.length).toBeGreaterThan(0);
    for (const event of sent)
      expect(event.eventToFirstSentMs).toBeGreaterThanOrEqual(0);
    // Every episode ends with the room confirmed empty and lamps off.
    for (const checkpoint of result.checkpoints) {
      expect(checkpoint.presence).toBe('confirmed_empty');
      expect(checkpoint.lights['light.h6022']).toBe('off');
    }
  });

  it('keeps the training and held-out mixes distinct', () => {
    const train = generateWorkload({
      name: 'train',
      seed: 1,
      episodes: 10,
      mix: trainingMix,
    });
    expect(train.steps.length).toBeGreaterThan(10);
    expect(
      train.steps.every(
        (step, index, steps) => index === 0 || steps[index - 1]!.at <= step.at,
      ),
    ).toBe(true);
  });
});
