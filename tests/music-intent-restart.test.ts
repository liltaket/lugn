import { expect, it, vi } from 'vitest';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import type { MusicIntentSnapshot } from '../src/core/schemas.js';

const start = Date.parse('2026-10-04T12:00:00+02:00');
const continuity = 20 * 60_000;
const user = { actor: { type: 'user' as const }, source: 'dashboard' };
const playing = {
  playback: 'playing' as const,
  volume: 0.3,
  title: 'Track',
  source: 'Spotify',
};

function setup(now = start, restoredMusicIntent?: MusicIntentSnapshot) {
  const clock = new FakeClock(now);
  const adapter = new SimulatedMusicAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    music: { targets: { 'music.room': [] }, adapter },
    ...(restoredMusicIntent ? { restoredMusicIntent } : {}),
  });
  const presence = (presence: 'occupied' | 'confirmed_empty' | 'unknown') =>
    engine.handlePresence({
      type: 'presence.changed',
      presence,
      personCount: 1,
    });
  const policy = () => engine.getMusicVolumePolicySnapshots()['music.room']!;
  return { clock, adapter, engine, presence, policy };
}

it('restores manual intent before observations without replaying state, commands or positive Play', async () => {
  const s = setup();
  let r: ReturnType<typeof setup> | undefined;
  try {
    s.adapter.observe('music.room', playing);
    await s.presence('occupied');
    await s.engine.requestMusic(
      'music.room',
      { property: 'volume', value: 0.95 },
      user,
    );
    const snapshot = s.engine.getMusicIntentSnapshot();
    r = setup(start + 1_000, snapshot);
    expect(r.policy()).toMatchObject({
      activeOwner: 'manual',
      effectiveTarget: 0.95,
      baseline: 0.95,
    });
    expect(r.engine.getMusicState('music.room')).toMatchObject({
      observed: { playback: 'unknown', volume: null },
      requested: {},
      availability: 'unavailable',
    });
    expect(r.engine.state.music).toMatchObject({ commands: [], fades: {} });
    expect(r.adapter.dispatched).toEqual([]);
    r.adapter.observe('music.room', { ...playing, volume: 0.3 });
    await r.presence('unknown');
    await r.presence('occupied');
    r.clock.advanceBy(60_000);
    expect(r.adapter.dispatched).toEqual([]);
    expect(r.policy().manualHold?.volume).toBe(0.95);
  } finally {
    s.engine.dispose();
    r?.engine.dispose();
  }
});

it.each([-1, 0, 1])(
  'honors saved absence expiry at boundary %+d without renewal or startup commands',
  async (delta) => {
    const s = setup();
    let r: ReturnType<typeof setup> | undefined;
    let again: ReturnType<typeof setup> | undefined;
    try {
      s.adapter.observe('music.room', playing);
      await s.presence('occupied');
      await s.engine.requestMusic(
        'music.room',
        { property: 'volume', value: 0.4 },
        user,
      );
      await s.presence('confirmed_empty');
      const expiry = start + continuity;
      r = setup(expiry + delta, s.engine.getMusicIntentSnapshot());
      expect(r.policy().manualHold !== null).toBe(delta < 0);
      expect(r.adapter.dispatched).toEqual([]);
      await r.presence('unknown');
      await r.presence('confirmed_empty');
      expect(r.policy().manualHold?.expiresAt ?? null).toBe(
        delta < 0 ? expiry : null,
      );
      again = setup(expiry + delta, r.engine.getMusicIntentSnapshot());
      await again.presence('confirmed_empty');
      expect(again.policy().manualHold?.expiresAt ?? null).toBe(
        delta < 0 ? expiry : null,
      );
      if (delta < 0) {
        again.clock.advanceBy(1);
        expect(again.policy().manualHold).toBeNull();
      }
    } finally {
      s.engine.dispose();
      r?.engine.dispose();
      again?.engine.dispose();
    }
  },
);

it('preserves original Pause age and protects stale startup Playing while accepting genuinely newer physical Play', async () => {
  const s = setup();
  let r: ReturnType<typeof setup> | undefined;
  try {
    s.adapter.observe('music.room', playing);
    await s.engine.requestMusic(
      'music.room',
      { property: 'playback', value: 'paused' },
      user,
    );
    r = setup(start + continuity + 1, s.engine.getMusicIntentSnapshot());
    expect(r.engine.state.intent.holds).toContainEqual(
      expect.objectContaining({
        scope: 'music.playback',
        createdAt: start,
        provenance: user,
      }),
    );
    r.adapter.observe(
      'music.room',
      playing,
      true,
      undefined,
      undefined,
      start - 1,
    );
    r.adapter.observe(
      'music.room',
      { ...playing, title: 'Metadata' },
      true,
      undefined,
      undefined,
      start - 1,
    );
    await r.presence('occupied');
    await r.presence('confirmed_empty');
    await r.presence('occupied');
    expect(
      r.adapter.dispatched.some(
        (c) =>
          c.requested.property === 'preset' ||
          (c.requested.property === 'playback' &&
            c.requested.value === 'playing'),
      ),
    ).toBe(false);
    r.clock.advanceBy(1);
    r.adapter.observe(
      'music.room',
      playing,
      true,
      undefined,
      undefined,
      r.clock.now(),
    );
    expect(
      r.engine.state.intent.holds.filter((h) => h.scope === 'music.playback'),
    ).toEqual([]);
  } finally {
    s.engine.dispose();
    r?.engine.dispose();
  }
});

it('saves failed human request intent independently from adapter confirmation', async () => {
  const s = setup();
  let r: ReturnType<typeof setup> | undefined;
  try {
    vi.spyOn(s.adapter, 'dispatch').mockRejectedValue(new Error('offline'));
    await expect(
      s.engine.requestMusic(
        'music.room',
        { property: 'volume', value: 0.5 },
        user,
      ),
    ).rejects.toThrow();
    await expect(
      s.engine.requestMusic(
        'music.room',
        { property: 'playback', value: 'paused' },
        user,
      ),
    ).rejects.toThrow();
    r = setup(start + 100, s.engine.getMusicIntentSnapshot());
    expect(r.policy()).toMatchObject({
      activeOwner: 'manual',
      effectiveTarget: 0.5,
    });
    expect(
      r.engine.state.intent.holds.some((h) => h.scope === 'music.playback'),
    ).toBe(true);
    expect(r.adapter.dispatched).toEqual([]);
  } finally {
    s.engine.dispose();
    r?.engine.dispose();
    vi.restoreAllMocks();
  }
});

it.each([-1, 0, 1])(
  'short Optical restart resumes and expiry %s starts a fresh preset after confirmed entry',
  async (delta) => {
    const s = setup();
    let r: ReturnType<typeof setup> | undefined;
    try {
      s.adapter.observe('music.room', { ...playing, source: 'Optical' });
      await s.presence('occupied');
      await s.engine.requestMusic(
        'music.room',
        { property: 'volume', value: 0.4 },
        user,
      );
      await s.presence('confirmed_empty');
      const snapshot = s.engine.getMusicIntentSnapshot();
      r = setup(start + continuity + delta, snapshot);
      expect(r.adapter.dispatched).toEqual([]);
      r.adapter.observe('music.room', {
        ...playing,
        playback: 'paused',
        volume: 0.4,
        source: 'Optical',
      });
      expect(r.adapter.dispatched).toEqual([]);
      await r.presence('unknown');
      await r.presence('confirmed_empty');
      expect(
        r.engine.getMusicIntentSnapshot().targets['music.room']?.resumeUntil,
      ).toBe(start + continuity);
      const before = r.adapter.dispatched.length;
      await r.presence('occupied');
      const requests = r.adapter.dispatched
        .slice(before)
        .map((c) => c.requested);
      expect(requests).toContainEqual(
        delta < 0
          ? { property: 'playback', value: 'playing' }
          : { property: 'preset', value: 'spotify_dj' },
      );
      expect(
        requests.some(
          (c) => c.property === (delta < 0 ? 'preset' : 'playback'),
        ),
      ).toBe(false);
    } finally {
      s.engine.dispose();
      r?.engine.dispose();
    }
  },
);

it('saved short resume eligibility cannot dispatch against unavailable startup feedback', async () => {
  const s = setup();
  let r: ReturnType<typeof setup> | undefined;
  try {
    s.adapter.observe('music.room', playing);
    await s.presence('occupied');
    await s.presence('confirmed_empty');
    r = setup(start + 1_000, s.engine.getMusicIntentSnapshot());
    await r.presence('occupied');
    expect(r.adapter.dispatched).toEqual([]);
    r.adapter.observe('music.room', playing);
    expect(r.adapter.dispatched).toEqual([]);
  } finally {
    s.engine.dispose();
    r?.engine.dispose();
  }
});

it.each(['older', 'newer', 'missing'] as const)(
  'first Playing seed with %s transition time cannot surrender restored Pause',
  async (time) => {
    const s = setup();
    let r: ReturnType<typeof setup> | undefined;
    try {
      await s.engine.requestMusic(
        'music.room',
        { property: 'playback', value: 'paused' },
        user,
      );
      r = setup(start + 10_000, s.engine.getMusicIntentSnapshot());
      r.adapter.observe(
        'music.room',
        playing,
        true,
        undefined,
        undefined,
        time === 'missing'
          ? undefined
          : time === 'newer'
            ? start + 5_000
            : start - 1,
      );
      expect(
        r.engine.state.intent.holds.some((h) => h.scope === 'music.playback'),
      ).toBe(true);
      r.adapter.observe(
        'music.room',
        { ...playing, volume: null, playback: 'unknown' },
        false,
      );
      r.adapter.observe(
        'music.room',
        playing,
        true,
        undefined,
        undefined,
        r.clock.now(),
      );
      expect(
        r.engine.state.intent.holds.some((h) => h.scope === 'music.playback'),
      ).toBe(true);
      await r.engine.requestMusic(
        'music.room',
        { property: 'playback', value: 'playing' },
        user,
      );
      expect(
        r.engine.state.intent.holds.some((h) => h.scope === 'music.playback'),
      ).toBe(false);
    } finally {
      s.engine.dispose();
      r?.engine.dispose();
    }
  },
);

it('restart interrupts a human fade without replaying or claiming its destination was observed', async () => {
  const s = setup();
  let r: ReturnType<typeof setup> | undefined;
  try {
    s.adapter.observe('music.room', playing);
    await s.presence('occupied');
    s.engine.startMusicFade(
      { target: 'music.room', volume: 0.6, durationMs: 5_000 },
      user,
    );
    r = setup(start + 1_000, s.engine.getMusicIntentSnapshot());
    expect(r.policy()).toMatchObject({
      activeOwner: 'manual',
      baseline: 0.3,
      effectiveTarget: 0.6,
    });
    expect(r.engine.state.music.fades).toEqual({});
    expect(r.engine.getMusicState('music.room').observed.volume).toBeNull();
    r.clock.advanceBy(30_000);
    expect(r.adapter.dispatched).toEqual([]);
  } finally {
    s.engine.dispose();
    r?.engine.dispose();
  }
});

it.each([true, false])(
  'preserves temporary BILRESA restore=%s across restart without releasing manual hold',
  async (priorEnabled) => {
    const clock = new FakeClock(start);
    const scenes = [
      { id: 'scene.everyday_light', name: 'Day', lighting: {} },
      { id: 'scene.all_off', name: 'Off', lighting: {} },
    ];
    const adapter = new SimulatedMusicAdapter(clock);
    const s = new LugnEngine(clock, {
      deviceIds: [],
      scenes,
      music: { targets: { 'music.room': [] }, adapter },
    });
    let r: LugnEngine | undefined;
    try {
      if (!priorEnabled) await s.handleBilresaPress('2', 'multi_press_1');
      await s.requestMusic(
        'music.room',
        { property: 'volume', value: 0.4 },
        user,
      );
      await s.handleBilresaPress('2', 'long_press');
      const snapshot = s.getMusicIntentSnapshot();
      expect(snapshot).toMatchObject({
        volumeAutomationEnabled: false,
        temporaryVolumeAutomationRestore: priorEnabled,
      });
      r = new LugnEngine(clock, {
        deviceIds: [],
        scenes,
        restoredMusicIntent: snapshot,
        restoredLightingIntent: s.getLightingIntentSnapshot(),
        music: { targets: { 'music.room': [] } },
      });
      await r.handleBilresaPress('2', 'long_press');
      expect(r.getMusicIntentSnapshot()).toMatchObject({
        volumeAutomationEnabled: priorEnabled,
        temporaryVolumeAutomationRestore: null,
        targets: { 'music.room': { manualVolume: { volume: 0.4 } } },
      });
    } finally {
      s.dispose();
      r?.dispose();
    }
  },
);
