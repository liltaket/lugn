import { expect, it } from 'vitest';
import { HomeAssistantMusicAdapter } from '../src/adapters/home-assistant-music.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';

const user = { actor: { type: 'user' as const }, source: 'dashboard' };
const target = 'music.room';

async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

async function setup() {
  const clock = new FakeClock(Date.parse('2026-10-04T12:00:00+02:00'));
  const services: string[] = [];
  const adapter = new HomeAssistantMusicAdapter(
    {
      baseUrl: 'http://home-assistant.test:8123',
      token: 'test-token',
      entities: { [target]: { entityId: 'media_player.wiim_room' } },
    },
    async (input) => {
      services.push(String(input).split('/').at(-1) ?? '');
      return new Response(null, { status: 200 });
    },
    clock,
  );
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    music: { targets: { [target]: [] }, adapter, feedbackTimeoutMs: 10_000 },
  });
  // Isolate playback policy from periodic volume adjustments.
  await engine.handleBilresaPress('2', 'multi_press_1');
  const report = (
    playback: 'playing' | 'paused' | 'unavailable',
    changedAt: number,
    volume = 0.3,
  ) => {
    expect(
      adapter.acceptStateChangedEvent({
        event_type: 'state_changed',
        data: {
          entity_id: 'media_player.wiim_room',
          new_state: {
            entity_id: 'media_player.wiim_room',
            state: playback,
            last_changed: new Date(changedAt).toISOString(),
            last_updated: new Date(clock.now()).toISOString(),
            attributes: {
              volume_level: volume,
              media_title: `Metadata update at ${clock.now()}`,
            },
          },
        },
      }),
    ).toBe(true);
  };
  const presence = (state: 'occupied' | 'confirmed_empty') =>
    engine.handlePresence({ type: 'presence.changed', presence: state });
  const playingAt = clock.now() - 5_000;
  report('playing', playingAt);
  await presence('occupied');
  clock.advanceBy(1);
  const pause = await engine.requestMusic(
    target,
    { property: 'playback', value: 'paused' },
    user,
  );
  expect(services).toEqual(['media_pause']);
  return { clock, engine, services, report, presence, playingAt, pause };
}

it.each([
  'pending',
  'timed-out',
  'confirmed',
  'pruned-timeout',
  'pruned-confirmed',
] as const)(
  'keeps an explicit Pause through historical Playing feedback while %s',
  async (phase) => {
    const { clock, engine, services, report, presence, playingAt, pause } =
      await setup();
    try {
      let playback: 'playing' | 'paused' = 'playing';
      let changedAt = playingAt;
      if (phase === 'confirmed' || phase === 'pruned-confirmed') {
        clock.advanceBy(1);
        changedAt = clock.now();
        playback = 'paused';
        report(playback, changedAt);
        expect(
          engine.state.music.commands.find((c) => c.id === pause.id)?.status,
        ).toBe('confirmed');
      } else if (phase === 'timed-out' || phase === 'pruned-timeout') {
        clock.advanceBy(10_001);
        expect(
          engine.state.music.commands.find((c) => c.id === pause.id)?.status,
        ).toBe('unconfirmed');
      }

      if (phase.startsWith('pruned')) {
        for (let index = 0; index < 130; index += 1) {
          const volume = index % 2 === 0 ? 0.4 : 0.3;
          await engine.requestMusic(
            target,
            { property: 'volume', value: volume },
            user,
          );
          clock.advanceBy(1);
          report(playback, changedAt, volume);
        }
        expect(engine.state.music.commands.some((c) => c.id === pause.id)).toBe(
          false,
        );
      }

      // HA changes only metadata/last_updated; its Playing transition predates
      // the user Pause. Keep the reported playback truthful without treating
      // this snapshot as a new physical Play or cancelling manual pause policy.
      clock.advanceBy(1);
      report('playing', playingAt);
      expect(engine.getMusicState(target).observed.playback).toBe('playing');
      if (phase === 'pending') {
        expect(
          engine.state.music.commands.find((c) => c.id === pause.id)?.status,
        ).toBe('pending');
        expect(engine.getMusicState(target).requested.playback).toBe('paused');
      }
      await presence('confirmed_empty');
      await flush();
      const beforeReturn = services.length;
      clock.advanceBy(1);
      report('playing', playingAt);
      await presence('occupied');
      await flush();
      expect(services.slice(beforeReturn)).toEqual([]);
      expect(services).not.toContain('media_play');
      expect(services).not.toContain('play_preset');
    } finally {
      engine.dispose();
    }
  },
);

it.each(['confirmed-pause', 'missed-pause-feedback'] as const)(
  'permits a genuinely newer physical Playing transition after %s',
  async (phase) => {
    const { clock, engine, services, report, presence } = await setup();
    try {
      if (phase === 'confirmed-pause') {
        clock.advanceBy(1);
        report('paused', clock.now());
      } else {
        // The Pause command timed out while the HA cache still said Playing.
        clock.advanceBy(10_001);
      }
      clock.advanceBy(1);
      report('playing', clock.now());
      await presence('confirmed_empty');
      await flush();
      clock.advanceBy(1);
      report('paused', clock.now());
      const beforeReturn = services.length;
      await presence('occupied');
      await flush();
      expect(services.slice(beforeReturn)).toEqual(['media_play']);
    } finally {
      engine.dispose();
    }
  },
);

it('ignores Playing feedback that predates the confirmed Pause transition even when it follows the request', async () => {
  const { clock, engine, services, report, presence, pause } = await setup();
  try {
    clock.advanceBy(2);
    report('paused', clock.now());
    clock.advanceBy(1);
    report('playing', pause.issuedAt + 1);
    expect(engine.getMusicState(target).observed.playback).toBe('playing');
    await presence('confirmed_empty');
    await flush();
    const beforeReturn = services.length;
    await presence('occupied');
    await flush();
    expect(services.slice(beforeReturn)).toEqual([]);
  } finally {
    engine.dispose();
  }
});

it('keeps manual Pause through an availability recovery snapshot without a known physical playback transition', async () => {
  const { clock, engine, services, report, presence, pause } = await setup();
  try {
    clock.advanceBy(1);
    report('unavailable', clock.now());
    clock.advanceBy(1);
    // HA's last_changed advances on availability recovery as well. The
    // transition from an unavailable cache is not evidence of physical Play.
    report('playing', clock.now());
    expect(
      engine.state.music.commands.find((c) => c.id === pause.id)?.status,
    ).toBe('pending');
    await presence('confirmed_empty');
    await flush();
    const beforeReturn = services.length;
    await presence('occupied');
    await flush();
    expect(services.slice(beforeReturn)).toEqual([]);
  } finally {
    engine.dispose();
  }
});

it.each(['play', 'preset'] as const)(
  'permits explicit %s after stale metadata without leaving manual pause latched',
  async (restart) => {
    const { clock, engine, services, report, presence, playingAt } =
      await setup();
    try {
      clock.advanceBy(1);
      report('playing', playingAt);
      await engine.requestMusic(
        target,
        restart === 'play'
          ? { property: 'playback', value: 'playing' }
          : { property: 'preset', value: 'spotify_dj' },
        user,
      );
      expect(services.at(-1)).toBe(
        restart === 'play' ? 'media_play' : 'play_preset',
      );
      clock.advanceBy(1);
      report('playing', clock.now());
      await presence('confirmed_empty');
      await flush();
      clock.advanceBy(1);
      report('paused', clock.now());
      const beforeReturn = services.length;
      await presence('occupied');
      await flush();
      expect(services.slice(beforeReturn)).toEqual(['media_play']);
    } finally {
      engine.dispose();
    }
  },
);
