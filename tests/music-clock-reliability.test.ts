import { expect, it } from 'vitest';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import type { Presence } from '../src/core/schemas.js';

const target = 'music.room';
const human = { actor: { type: 'user' as const }, source: 'test.clock' };
const values = {
  playback: 'playing' as const,
  volume: 0.5,
  source: 'Optical',
  title: null,
};
const continuityMs = 20 * 60_000;

async function flush() {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

function setup(start: string, playback: 'playing' | 'idle' = 'playing') {
  const clock = new FakeClock(Date.parse(start));
  const adapter = new SimulatedMusicAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    music: { targets: { [target]: [] }, adapter },
  });
  adapter.observe(target, { ...values, playback });
  const presence = (presence: Presence) =>
    engine.handlePresence({
      type: 'presence.changed',
      presence,
      personCount:
        presence === 'occupied' ? 1 : presence === 'confirmed_empty' ? 0 : null,
    });
  const policy = () => engine.getMusicVolumePolicySnapshots()[target]!;
  const volumeCommands = () =>
    adapter.dispatched.filter((c) => c.requested.property === 'volume');
  const manual = async (volume = 0.5) => {
    const command = await engine.requestMusic(
      target,
      { property: 'volume', value: volume },
      human,
    );
    adapter.observe(target, { ...values, playback, volume }, true, command.id);
  };
  return { clock, adapter, engine, presence, policy, manual, volumeCommands };
}

const clockCases = [
  { time: '2026-10-04T22:59:59.999+02:00', quiet: false, offset: -0.07375 },
  { time: '2026-10-04T23:00:00+02:00', quiet: true, offset: -0.075 },
  { time: '2026-10-05T00:00:00+02:00', quiet: true, offset: -0.15 },
  {
    time: '2026-10-05T05:59:59.999+02:00',
    quiet: true,
    offset: -0.0004166666666666763,
  },
  { time: '2026-10-05T06:00:00+02:00', quiet: false, offset: 0 },
  {
    time: '2026-03-29T00:59:59.999Z',
    quiet: true,
    offset: -0.10041666666666665,
  },
  { time: '2026-03-29T01:00:00Z', quiet: true, offset: -0.075 },
  {
    time: '2026-10-25T00:59:59.999Z',
    quiet: true,
    offset: -0.07541666666666666,
  },
  { time: '2026-10-25T01:00:00Z', quiet: true, offset: -0.1 },
];

it.each(clockCases)(
  'uses Stockholm wall time for fresh-entry gates and offsets at $time',
  async ({ time, quiet, offset }) => {
    const s = setup(time, 'idle');
    try {
      // A manual destination is de-offset into its baseline. Choose the
      // destination that establishes a 50% baseline at this wall-clock time.
      await s.manual(0.5 + offset);
      await s.engine.handleBilresaPress('2', 'multi_press_1');
      await s.engine.handleBilresaPress('2', 'multi_press_1');
      await s.presence('confirmed_empty');
      expect(s.engine.getMusicPlaybackPolicySnapshots()[target]).toMatchObject({
        quietHours: quiet,
        entryEligible: !quiet,
      });
      expect(s.policy().dailyOffset).toBeCloseTo(offset, 10);
      const before = s.adapter.dispatched.length;
      await s.presence('occupied');
      await flush();
      const positive = s.adapter.dispatched
        .slice(before)
        .filter(
          (c) =>
            c.requested.property === 'preset' ||
            (c.requested.property === 'playback' &&
              c.requested.value === 'playing'),
        );
      expect(positive.map((c) => c.requested)).toEqual(
        quiet ? [] : [{ property: 'preset', value: 'spotify_dj' }],
      );
      expect(s.policy().target).toBeCloseTo(0.5 + offset, 10);
    } finally {
      s.engine.dispose();
      expect(s.clock.pendingTimers()).toBe(0);
    }
  },
);

it.each([
  [
    'evening, midnight and morning',
    '2026-10-04T22:59:00+02:00',
    7 * 60 * 60_000 + 61_000,
  ],
  ['spring skipped hour', '2026-03-29T00:59:00Z', 2 * 60_000],
  ['autumn repeated hour', '2026-10-25T00:59:00Z', 2 * 60_000],
] as const)(
  'never sends automatic volume under manual ownership across %s',
  async (_name, start, duration) => {
    const s = setup(start);
    try {
      await s.presence('occupied');
      await s.manual(0.4);
      const count = s.volumeCommands().length;
      s.clock.advanceBy(duration);
      await flush();
      expect(s.volumeCommands()).toHaveLength(count);
      expect(s.policy()).toMatchObject({
        activeOwner: 'manual',
        policyActive: false,
        effectiveTarget: 0.4,
        manualHold: { volume: 0.4, expiresAt: null },
      });
      expect(s.engine.getMusicState(target).observed.volume).toBe(0.4);
    } finally {
      s.engine.dispose();
      expect(s.clock.pendingTimers()).toBe(0);
    }
  },
);

it.each([
  ['spring', '2026-03-29T00:50:00Z'],
  ['autumn', '2026-10-25T00:50:00Z'],
] as const)(
  'preserves a return one millisecond before continuity expiry across %s DST',
  async (_name, start) => {
    const s = setup(start);
    try {
      await s.presence('occupied');
      await s.manual(0.4);
      await s.presence('confirmed_empty');
      const count = s.volumeCommands().length;
      s.clock.advanceBy(continuityMs - 1);
      await s.presence('occupied');
      s.clock.advanceBy(2 * 60_000);
      await flush();
      expect(s.policy()).toMatchObject({
        activeOwner: 'manual',
        effectiveTarget: 0.4,
        manualHold: { expiresAt: null },
      });
      expect(s.volumeCommands()).toHaveLength(count);
    } finally {
      s.engine.dispose();
      expect(s.clock.pendingTimers()).toBe(0);
    }
  },
);

it.each([
  ['spring', '2026-03-29T00:50:00Z'],
  ['autumn', '2026-10-25T00:50:00Z'],
] as const)(
  'expires confirmed-absence ownership after exactly twenty elapsed minutes across %s DST',
  async (_name, start) => {
    const s = setup(start);
    try {
      await s.presence('occupied');
      await s.manual(0.4);
      await s.presence('confirmed_empty');
      const deadline = s.clock.now() + continuityMs;
      const count = s.volumeCommands().length;
      s.clock.advanceBy(10 * 60_000);
      await s.presence('unknown');
      await s.engine.handleHomePresence('away');
      await s.engine.handleHomePresence('home');
      await s.presence('confirmed_empty');
      expect(s.policy().manualHold?.expiresAt).toBe(deadline);
      s.clock.advanceBy(10 * 60_000 - 1);
      expect(s.policy().activeOwner).toBe('manual');
      s.clock.advanceBy(1);
      expect(s.policy().manualHold).toBeNull();
      expect(s.policy().activeOwner).toBe('none');
      expect(s.volumeCommands()).toHaveLength(count);
      await s.presence('occupied');
      await flush();
      expect(s.policy().activeOwner).toBe('lugn');
      expect(s.volumeCommands()).toHaveLength(count + 1);
      // Volume may regain authority at night, but automatic positive playback may not.
      expect(
        s.adapter.dispatched.some(
          (c) =>
            c.requested.property === 'preset' ||
            (c.requested.property === 'playback' &&
              c.requested.value === 'playing'),
        ),
      ).toBe(false);
    } finally {
      s.engine.dispose();
      expect(s.clock.pendingTimers()).toBe(0);
    }
  },
);
