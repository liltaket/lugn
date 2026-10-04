import { expect, it } from 'vitest';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';

const user = { actor: { type: 'user' as const }, source: 'dashboard' };
const playing = {
  playback: 'playing' as const,
  volume: 0.3,
  source: 'Spotify',
  title: 'Track',
};

async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

it.each([
  'confirmed-before-exit',
  'pending-before-exit',
  'after-exit',
] as const)('keeps the explicit Pause for %s', async (ordering) => {
  const clock = new FakeClock(Date.parse('2026-10-03T12:00:00+02:00'));
  const adapter = new SimulatedMusicAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    music: {
      targets: { 'music.room': [] },
      adapter,
      feedbackTimeoutMs: 10_000,
    },
  });
  const occupy = () =>
    engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
  const leave = () =>
    engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
      personCount: 0,
    });
  try {
    adapter.observe('music.room', playing);
    await occupy();

    if (ordering === 'after-exit') {
      await leave();
      await flush();
      clock.advanceBy(2_000);
    }

    const pause = await engine.requestMusic(
      'music.room',
      { property: 'playback', value: 'paused' },
      user,
    );
    expect(pause.acceptedAt).toBeDefined();
    if (ordering === 'pending-before-exit') {
      clock.advanceBy(500);
      await leave();
      await flush();
    }

    const latestPause = adapter.dispatched.at(-1);
    expect(latestPause?.requested).toEqual({
      property: 'playback',
      value: 'paused',
    });
    clock.advanceBy(1_000);
    adapter.observe('music.room', { ...playing, playback: 'paused' });
    expect(
      engine.state.music.commands.find((c) => c.id === latestPause?.id)?.status,
    ).toBe('confirmed');

    if (ordering === 'confirmed-before-exit') {
      await leave();
      await flush();
      clock.advanceBy(2_000);
      adapter.observe('music.room', { ...playing, playback: 'paused' });
    }

    const beforeReturn = adapter.dispatched.length;
    clock.advanceBy(5_000);
    await occupy();
    await flush();
    expect(
      adapter.dispatched.slice(beforeReturn).map((c) => c.requested),
    ).toEqual([]);
  } finally {
    engine.dispose();
  }
});

it.each(['playing', 'spotify_dj'] as const)(
  'keeps a newer user pause through late automatic feedback, then permits explicit %s',
  async (restart) => {
    const clock = new FakeClock(Date.parse('2026-10-03T12:00:00+02:00'));
    const adapter = new SimulatedMusicAdapter(clock);
    const engine = new LugnEngine(clock, {
      deviceIds: [],
      scenes: [],
      music: { targets: { 'music.room': [] }, adapter },
    });
    const presence = (state: 'occupied' | 'confirmed_empty') =>
      engine.handlePresence({ type: 'presence.changed', presence: state });
    try {
      adapter.observe('music.room', playing);
      await presence('occupied');
      await presence('confirmed_empty');
      await flush();
      clock.advanceBy(11_000);
      expect(engine.state.music.commands.at(-1)?.status).toBe('unconfirmed');
      const pause = await engine.requestMusic(
        'music.room',
        { property: 'playback', value: 'paused' },
        user,
      );
      clock.advanceBy(500);
      // HA's delayed automatic-pause state arrives after the newer user intent.
      adapter.observe('music.room', { ...playing, playback: 'paused' });
      expect(
        engine.state.music.commands.find((c) => c.id === pause.id)?.status,
      ).toBe('confirmed');
      const beforeReturn = adapter.dispatched.length;
      await presence('occupied');
      await flush();
      expect(adapter.dispatched).toHaveLength(beforeReturn);

      await engine.requestMusic(
        'music.room',
        restart === 'playing'
          ? { property: 'playback', value: restart }
          : { property: 'preset', value: restart },
        user,
      );
      clock.advanceBy(1);
      adapter.observe('music.room', playing);
      await presence('confirmed_empty');
      await flush();
      clock.advanceBy(1);
      adapter.observe('music.room', { ...playing, playback: 'paused' });
      const beforeNextReturn = adapter.dispatched.length;
      await presence('occupied');
      await flush();
      expect(
        adapter.dispatched.slice(beforeNextReturn).map((c) => c.requested),
      ).toEqual([{ property: 'playback', value: 'playing' }]);
    } finally {
      engine.dispose();
    }
  },
);
