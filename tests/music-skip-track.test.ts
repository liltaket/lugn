import { describe, expect, it, vi } from 'vitest';
import {
  SimulatedMusicAdapter,
  type MusicObservation,
} from '../src/adapters/simulated-music.js';
import {
  CapabilityInputError,
  CapabilityRegistry,
} from '../src/application/capabilities.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';

const target = 'music.room';
const human = {
  actor: { type: 'user' as const },
  source: 'dashboard',
  requestId: 'skip-1',
};
const start = Date.parse('2026-10-04T12:00:00+02:00');

async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** A player with a status read, so recovery verifies as it does with HA. */
function setup({
  source = 'Spotify',
  computerAudioInputs = {},
}: {
  source?: string;
  computerAudioInputs?: Record<string, { source: string }>;
} = {}) {
  const clock = new FakeClock(start);
  let title = 'First song';
  let playback: 'playing' | 'paused' = 'playing';
  class Adapter extends SimulatedMusicAdapter {
    readStatus = vi.fn(async (): Promise<MusicObservation> => ({
      target,
      observedAt: clock.now(),
      available: true,
      values: { volume: 0.3, playback, source, title },
    }));
  }
  const adapter = new Adapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    music: {
      targets: { [target]: ['Spotify', 'Optical'] },
      adapter,
      feedbackTimeoutMs: 1_000,
    },
    musicAutomaticFades: false,
    computerAudioInputs,
  });
  const observe = () =>
    adapter.observe(target, { volume: 0.3, playback, source, title });
  observe();
  const advance = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 250) {
      clock.advanceBy(250);
      await flush();
    }
  };
  return {
    clock,
    adapter,
    engine,
    registry: new CapabilityRegistry(engine),
    advance,
    setTitle(next: string) {
      title = next;
      observe();
    },
    setPlayback(next: 'playing' | 'paused') {
      playback = next;
    },
    record: (id: string) =>
      engine.state.music.commands.find((command) => command.id === id)!,
    tracks: () =>
      adapter.dispatched.filter(
        (command) => command.requested.property === 'track',
      ),
  };
}

describe('music.skipTrack', () => {
  it('sends one step, verifies without confirming it, and never sends it again', async () => {
    const s = setup();
    const result = (await s.registry.invoke(
      'music.skipTrack',
      { target, step: 'next' },
      human,
    )) as { accepted: true; commandId: string };
    expect(s.tracks().map((command) => command.requested)).toEqual([
      { property: 'track', value: 'next' },
    ]);
    s.setTitle('Second song');
    await s.advance(30_000);
    const command = s.record(result.commandId);
    expect(command.status).not.toBe('confirmed');
    // The status read ran, and the step stopped as one that is not retried.
    expect(s.adapter.readStatus).toHaveBeenCalled();
    expect(command.recovery?.stopReason).toBe('non_retryable');
    expect(s.tracks()).toHaveLength(1);
    // Nothing is left requested, and playback intent is untouched.
    expect(s.engine.state.music.devices[target]?.requested).toEqual({});
  });

  it('leaves a pending Play and its recovery alone', async () => {
    const s = setup();
    s.setPlayback('paused');
    s.adapter.observe(target, {
      volume: 0.3,
      playback: 'paused',
      source: 'Spotify',
      title: 'First song',
    });
    const play = await s.engine.requestMusic(
      target,
      { property: 'playback', value: 'playing' },
      { ...human, requestId: 'play-1' },
    );
    await s.registry.invoke(
      'music.skipTrack',
      { target, step: 'next' },
      { ...human, requestId: 'skip-2' },
    );
    const record = s.record(play.id);
    expect(record.status).toBe('pending');
    expect(record.recovery?.stopReason ?? null).not.toBe('superseded');
    expect(s.engine.state.music.devices[target]?.requested.playback).toBe(
      'playing',
    );
  });

  it('refuses a player on a computer input before sending or noting anything', async () => {
    const s = setup({
      source: 'Optical',
      computerAudioInputs: { [target]: { source: 'Optical' } },
    });
    const before = structuredClone(s.engine.state.music.devices[target]);
    const error = await s.registry
      .invoke('music.skipTrack', { target, step: 'next' }, human)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CapabilityInputError);
    expect((error as CapabilityInputError).code).toBe(
      'music_track_unavailable',
    );
    expect(s.tracks()).toHaveLength(0);
    expect(s.engine.state.music.devices[target]).toEqual(before);
  });

  it('rejects an unknown step or target', async () => {
    const s = setup();
    await expect(
      s.registry.invoke('music.skipTrack', { target, step: 'random' }, human),
    ).rejects.toThrow();
    await expect(
      s.registry.invoke(
        'music.skipTrack',
        { target: 'music.other', step: 'next' },
        human,
      ),
    ).rejects.toThrow();
  });
});
