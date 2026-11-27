import { expect, it } from 'vitest';
import { HomeAssistantMusicAdapter } from '../src/adapters/home-assistant-music.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';

// A Pause hold makes the Hub offer Spela even while the player reports
// playing, so a resume that goes unnoticed leaves the Hub showing "paused".
// A player resumes through `buffering`, which reports no playback of its own.

const user = { actor: { type: 'user' as const }, source: 'dashboard' };
const target = 'music.room';

type State = 'playing' | 'paused' | 'buffering' | 'on' | 'unavailable';

async function setup() {
  const clock = new FakeClock(Date.parse('2026-10-04T12:00:00+02:00'));
  const adapter = new HomeAssistantMusicAdapter(
    {
      baseUrl: 'http://home-assistant.test:8123',
      token: 'test-token',
      entities: { [target]: { entityId: 'media_player.wiim_room' } },
    },
    async () => new Response(null, { status: 200 }),
    clock,
  );
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    music: { targets: { [target]: [] }, adapter, feedbackTimeoutMs: 10_000 },
  });
  // As Home Assistant sends it: `last_changed` moves with the state alone.
  let state: State | undefined;
  let changedAt = 0;
  const report = (next: State) => {
    clock.advanceBy(1_000);
    if (next !== state) changedAt = clock.now();
    state = next;
    adapter.acceptState({
      entity_id: 'media_player.wiim_room',
      state: next,
      last_changed: new Date(changedAt).toISOString(),
      last_updated: new Date(clock.now()).toISOString(),
      attributes: { volume_level: 0.3, source: 'Spotify', media_title: 'Song' },
    });
  };
  const held = () =>
    engine.getMusicPlaybackPolicySnapshots()[target]!.manualPause !== null;
  report('playing');
  await engine.handlePresence({
    type: 'presence.changed',
    presence: 'occupied',
  });
  const pause = async () => {
    clock.advanceBy(1_000);
    await engine.requestMusic(
      target,
      { property: 'playback', value: 'paused' },
      user,
    );
  };
  return { engine, report, held, pause };
}

it.each(['buffering', 'on'] as const)(
  'releases a Pause made on the Hub when the player resumes through %s',
  async (between) => {
    const { engine, report, held, pause } = await setup();
    try {
      await pause();
      report('paused');
      expect(held()).toBe(true);
      report(between);
      report('playing');
      expect(held()).toBe(false);
    } finally {
      engine.dispose();
    }
  },
);

it('releases a Pause made at the player when it resumes through buffering', async () => {
  const { engine, report, held } = await setup();
  try {
    report('paused');
    expect(held()).toBe(true);
    report('buffering');
    report('buffering');
    report('playing');
    expect(held()).toBe(false);
  } finally {
    engine.dispose();
  }
});

it('keeps a pending Pause through buffering between two Playing reports', async () => {
  const { engine, report, held, pause } = await setup();
  try {
    await pause();
    report('buffering');
    report('playing');
    expect(held()).toBe(true);
    expect(engine.getMusicState(target).requested.playback).toBe('paused');
  } finally {
    engine.dispose();
  }
});

it('keeps Pause when the player was unavailable before it buffered', async () => {
  const { engine, report, held, pause } = await setup();
  try {
    await pause();
    report('paused');
    report('unavailable');
    report('buffering');
    report('playing');
    expect(held()).toBe(true);
  } finally {
    engine.dispose();
  }
});

it('keeps Pause when buffering ends paused again', async () => {
  const { engine, report, held, pause } = await setup();
  try {
    await pause();
    report('paused');
    report('buffering');
    report('paused');
    expect(held()).toBe(true);
  } finally {
    engine.dispose();
  }
});

it('keeps a Pause made while the player was already buffering', async () => {
  const { engine, report, held, pause } = await setup();
  try {
    report('paused');
    report('buffering');
    await pause();
    report('playing');
    expect(held()).toBe(true);
  } finally {
    engine.dispose();
  }
});
