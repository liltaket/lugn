import { expect, it } from 'vitest';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import { FakeClock } from '../src/core/clock.js';
import type { MusicIntentSnapshot } from '../src/core/schemas.js';

const start = Date.parse('2026-10-04T12:00:00+02:00');
const user = { actor: { type: 'user' as const }, source: 'test' };
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
  return {
    clock,
    adapter,
    engine,
    presence,
    mode: () => engine.getMusicVolumePolicySnapshots()['music.room']!.mode,
  };
}

it('retains manual volume on a short absence and resets exactly at 20 minutes without an empty-room volume command', async () => {
  const s = setup();
  try {
    s.adapter.observe('music.room', {
      playback: 'paused',
      volume: 0.4,
      source: 'Spotify',
      title: null,
    });
    await s.presence('occupied');
    await s.engine.requestMusic(
      'music.room',
      { property: 'volume', value: 0.45 },
      user,
    );
    await s.presence('confirmed_empty');
    const count = s.adapter.dispatched.filter(
      (c) => c.requested.property === 'volume',
    ).length;
    s.clock.advanceBy(20 * 60_000 - 1);
    expect(s.mode()).toBe('manual');
    s.clock.advanceBy(1);
    expect(s.mode()).toBe('auto');
    expect(
      s.adapter.dispatched.filter((c) => c.requested.property === 'volume'),
    ).toHaveLength(count);
  } finally {
    s.engine.dispose();
  }
});

it('restores the original absence deadline after restart', async () => {
  const s = setup();
  let r: ReturnType<typeof setup> | undefined;
  try {
    s.adapter.observe('music.room', {
      playback: 'paused',
      volume: 0.4,
      source: 'Spotify',
      title: null,
    });
    await s.presence('occupied');
    await s.engine.requestMusic(
      'music.room',
      { property: 'volume', value: 0.45 },
      user,
    );
    await s.presence('confirmed_empty');
    r = setup(start + 19 * 60_000, s.engine.getMusicIntentSnapshot());
    expect(r.mode()).toBe('manual');
    r.clock.advanceBy(60_000);
    expect(r.mode()).toBe('auto');
  } finally {
    s.engine.dispose();
    r?.engine.dispose();
  }
});

it('preserves a newer manual volume adjustment made while the room is empty', async () => {
  const s = setup();
  try {
    s.adapter.observe('music.room', {
      playback: 'paused',
      volume: 0.4,
      source: 'Spotify',
      title: null,
    });
    await s.presence('occupied');
    await s.engine.requestMusic(
      'music.room',
      { property: 'volume', value: 0.45 },
      user,
    );
    await s.presence('confirmed_empty');
    s.clock.advanceBy(1_000);
    await s.engine.requestMusic(
      'music.room',
      { property: 'volume', value: 0.5 },
      user,
    );
    s.clock.advanceBy(20 * 60_000 - 1_000);
    expect(s.mode()).toBe('manual');
    s.clock.advanceBy(1_000);
    expect(s.mode()).toBe('auto');
  } finally {
    s.engine.dispose();
  }
});

it('cancels the first deadline on a short return and starts a fresh one on the next exit', async () => {
  const s = setup();
  try {
    s.adapter.observe('music.room', {
      playback: 'paused',
      volume: 0.4,
      source: 'Spotify',
      title: null,
    });
    await s.presence('occupied');
    await s.engine.requestMusic(
      'music.room',
      { property: 'volume', value: 0.45 },
      user,
    );
    await s.presence('confirmed_empty');
    s.clock.advanceBy(10 * 60_000);
    await s.presence('occupied');
    s.clock.advanceBy(15 * 60_000);
    expect(s.mode()).toBe('manual');
    await s.presence('confirmed_empty');
    s.clock.advanceBy(20 * 60_000 - 1);
    expect(s.mode()).toBe('manual');
    s.clock.advanceBy(1);
    expect(s.mode()).toBe('auto');
  } finally {
    s.engine.dispose();
  }
});
