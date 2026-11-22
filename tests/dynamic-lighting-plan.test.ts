import { describe, expect, it } from 'vitest';
import {
  blockersShowVideo,
  DynamicLightingConfigSchema,
  classifySituation,
  planDynamicLighting,
  sameDynamicValues,
  type DynamicComputerInput,
  type DynamicInputs,
} from '../src/core/dynamic-lighting.js';

const config = DynamicLightingConfigSchema.parse({
  targets: {
    'lighting.ceiling': 'main',
    'lighting.desk': 'desk',
    'lighting.strip_a': 'accent',
    'lighting.strip_b': 'accent',
    'lighting.monitor': 'backlight',
    'lighting.front': 'front',
    'lighting.under_bed': 'decor',
  },
});
const working: DynamicComputerInput = {
  locked: false,
  idle: false,
  fullscreen: false,
  activity: 'desktop',
  idleForMs: null,
};
const inputs = (over: Partial<DynamicInputs> = {}): DynamicInputs => ({
  roomOccupied: true,
  computer: working,
  palette: [],
  musicPlaying: false,
  ...over,
});
const computer = (over: Partial<DynamicComputerInput>) => ({
  ...working,
  ...over,
});

describe('situation', () => {
  it.each([
    [
      'full-screen video',
      { fullscreen: true, activity: 'video' as const },
      'cinema',
    ],
    [
      'full-screen game',
      { fullscreen: true, activity: 'gaming' as const },
      'cinema',
    ],
    ['full-screen but only desktop', { fullscreen: true }, 'desk'],
    [
      'video in a window, no input for an hour',
      { activity: 'video' as const, idle: true, idleForMs: 3_600_000 },
      'desk',
    ],
    ['active use', {}, 'desk'],
    ['idle for less than the limit', { idle: true, idleForMs: 60_000 }, 'desk'],
    ['idle past the limit', { idle: true, idleForMs: 300_000 }, 'lounge'],
    ['locked', { locked: true }, 'lounge'],
    [
      'locked behind a full-screen video',
      { locked: true, fullscreen: true, activity: 'video' as const },
      'lounge',
    ],
    ['nothing reported', { idle: null, locked: null }, 'unknown'],
  ])('%s -> %s', (_name, over, expected) => {
    expect(
      classifySituation(inputs({ computer: computer(over) }), config).situation,
    ).toBe(expected);
  });

  it('is unknown without a trusted computer', () => {
    expect(classifySituation(inputs({ computer: null }), config)).toMatchObject(
      {
        situation: 'unknown',
        reason: 'computer_unavailable',
      },
    );
  });
});

describe('adaptive plan', () => {
  const adaptive = (over: Partial<DynamicInputs>) =>
    planDynamicLighting('adaptive', inputs(over), config);

  it('dims everything but a low bias light in cinema', () => {
    const plan = adaptive({
      computer: computer({ fullscreen: true, activity: 'video' }),
    });
    expect(plan.situation).toBe('cinema');
    expect(plan.targets['lighting.ceiling']).toEqual({ power: false });
    expect(plan.targets['lighting.desk']).toEqual({ power: false });
    expect(plan.targets['lighting.strip_a']).toMatchObject({
      power: true,
      brightness: config.cinemaBrightness,
    });
    expect(plan.targets['lighting.monitor']).toMatchObject({ power: true });
  });

  it('keeps the front light on except for a film, and decoration white-only', () => {
    const watching = adaptive({
      computer: computer({ fullscreen: true, activity: 'video' }),
    });
    expect(watching.targets['lighting.front']).toEqual({ power: false });
    const working = adaptive({ palette: [[255, 0, 0]], musicPlaying: true });
    expect(working.targets['lighting.front']).toMatchObject({ power: true });
    const lounge = adaptive({
      computer: computer({ locked: true }),
      palette: [[255, 0, 0]],
      musicPlaying: true,
    });
    expect(lounge.targets['lighting.front']).toMatchObject({ power: true });
    for (const plan of [watching, working, lounge])
      expect(plan.targets['lighting.under_bed']).toMatchObject({
        power: true,
        colorTemperature: expect.any(Number),
      });
    expect(
      (lounge.targets['lighting.under_bed'] as { rgb?: unknown }).rgb,
    ).toBeUndefined();
  });

  it('lights the desk for work and keeps colour subdued', () => {
    const plan = adaptive({
      palette: [[255, 0, 0]],
      musicPlaying: true,
    });
    expect(plan.situation).toBe('desk');
    expect(plan.targets['lighting.desk']).toMatchObject({
      power: true,
      colorTemperature: 4000,
    });
    expect(
      (plan.targets['lighting.strip_a'] as { brightness: number }).brightness,
    ).toBeLessThanOrEqual(35);
  });

  it('relaxes in the lounge: whites off, accents warm or coloured', () => {
    const plan = adaptive({ computer: computer({ locked: true }) });
    expect(plan.situation).toBe('lounge');
    expect(plan.targets['lighting.ceiling']).toEqual({ power: false });
    expect(plan.targets['lighting.strip_a']).toMatchObject({
      power: true,
      colorTemperature: 2700,
    });
    const coloured = adaptive({
      computer: computer({ locked: true }),
      palette: [[0, 255, 0]],
      musicPlaying: true,
    });
    expect(coloured.targets['lighting.strip_a']).toMatchObject({
      rgb: [0, 255, 0],
    });
  });

  it('releases every lamp when the computer cannot be trusted or the room is empty', () => {
    for (const plan of [
      adaptive({ computer: null }),
      adaptive({ roomOccupied: false }),
    ])
      expect(Object.values(plan.targets).every((t) => t === 'release')).toBe(
        true,
      );
    expect(adaptive({ roomOccupied: false }).situation).toBe('inactive');
  });
});

describe('music plan', () => {
  const music = (over: Partial<DynamicInputs>) =>
    planDynamicLighting('music', inputs(over), config);

  it('gives accent lamps distinct colours and leaves other lamps alone', () => {
    const plan = music({
      musicPlaying: true,
      palette: [
        [255, 0, 0],
        [0, 0, 255],
      ],
    });
    expect(plan.targets['lighting.strip_a']).toMatchObject({
      rgb: [255, 0, 0],
    });
    expect(plan.targets['lighting.strip_b']).toMatchObject({
      rgb: [0, 0, 255],
    });
    expect(plan.targets['lighting.ceiling']).toBeUndefined();
    expect(plan.targets['lighting.desk']).toBeUndefined();
  });

  it('derives a neighbouring hue for a single-colour cover', () => {
    const plan = music({ musicPlaying: true, palette: [[255, 0, 0]] });
    const a = (plan.targets['lighting.strip_a'] as { rgb: number[] }).rgb;
    const b = (plan.targets['lighting.strip_b'] as { rgb: number[] }).rgb;
    expect(a).toEqual([255, 0, 0]);
    expect(b).not.toEqual(a);
  });

  it('returns to the scene when nothing plays or the cover has no colours', () => {
    for (const plan of [
      music({ musicPlaying: false }),
      music({ musicPlaying: true, palette: [] }),
    ])
      expect(Object.values(plan.targets).every((t) => t === 'release')).toBe(
        true,
      );
  });

  it('does not depend on a computer at all', () => {
    expect(
      music({ computer: null, musicPlaying: true, palette: [[9, 200, 9]] })
        .situation,
    ).toBe('music');
  });
});

describe('config and comparison', () => {
  it('requires at least one role and rejects unknown keys', () => {
    expect(() => DynamicLightingConfigSchema.parse({ targets: {} })).toThrow();
    expect(() =>
      DynamicLightingConfigSchema.parse({
        targets: { 'lighting.a': 'accent' },
        surprise: 1,
      }),
    ).toThrow();
  });

  it('treats near-identical settings as unchanged', () => {
    expect(
      sameDynamicValues(
        { power: true, brightness: 50, rgb: [100, 100, 100] },
        { power: true, brightness: 51, rgb: [104, 98, 100] },
      ),
    ).toBe(true);
    expect(
      sameDynamicValues(
        { power: true, brightness: 50, rgb: [100, 100, 100] },
        { power: true, brightness: 50, rgb: [200, 100, 100] },
      ),
    ).toBe(false);
    expect(sameDynamicValues(undefined, { power: false })).toBe(false);
  });
});

describe('video from idle blockers', () => {
  it('sees a playing video but not audio, and honours the ignore list', () => {
    expect(
      blockersShowVideo([{ app: 'firefox', reason: 'Playing video' }]),
    ).toBe(true);
    expect(
      blockersShowVideo([{ app: 'firefox', reason: 'Playing audio' }]),
    ).toBe(false);
    expect(
      blockersShowVideo([{ app: 'Zen', reason: 'Playing video' }], ['zen']),
    ).toBe(false);
    expect(blockersShowVideo(null)).toBe(false);
  });

  it('dims music colours to the cinema level during full-screen video', () => {
    const plan = planDynamicLighting(
      'music',
      inputs({
        musicPlaying: true,
        palette: [[255, 0, 0]],
        computer: computer({ fullscreen: true, activity: 'video' }),
      }),
      config,
    );
    expect(plan.reason).toBe('artwork_colours_dimmed');
    for (const target of Object.values(plan.targets))
      expect(target).toMatchObject({ brightness: config.cinemaBrightness });
  });
});
