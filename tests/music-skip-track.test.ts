import { describe, expect, it } from 'vitest';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';

const provenance = {
  actor: { type: 'user' as const },
  source: 'operator',
  requestId: 'skip-1',
};

function setup() {
  const clock = new FakeClock();
  const adapter = new SimulatedMusicAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    music: {
      targets: { 'music.room': ['Spotify'] },
      adapter,
      feedbackTimeoutMs: 100,
    },
  });
  adapter.observe('music.room', {
    playback: 'playing',
    volume: 0.3,
    source: 'Spotify',
    title: 'First song',
  });
  return { clock, adapter, engine, registry: new CapabilityRegistry(engine) };
}

describe('music.skipTrack', () => {
  it('sends one track step, never confirms it from playback and never repeats it', async () => {
    const { clock, adapter, engine, registry } = setup();
    const result = (await registry.invoke(
      'music.skipTrack',
      { target: 'music.room', step: 'next' },
      provenance,
    )) as { accepted: true; commandId: string; status: string };
    expect(result.accepted).toBe(true);
    expect(adapter.dispatched.map((command) => command.requested)).toEqual([
      { property: 'track', value: 'next' },
    ]);
    // The new song plays: there is still nothing that says "next" happened.
    adapter.observe('music.room', {
      playback: 'playing',
      volume: 0.3,
      source: 'Spotify',
      title: 'Second song',
    });
    for (let i = 0; i < 20; i += 1) {
      clock.advanceBy(1_000);
      await Promise.resolve();
    }
    const command = engine.state.music.commands.find(
      (candidate) => candidate.id === result.commandId,
    );
    expect(command).toBeDefined();
    expect(command?.status).not.toBe('confirmed');
    expect(
      adapter.dispatched.filter((c) => c.requested.property === 'track'),
    ).toHaveLength(1);
    // Playback is left as it was.
    expect(engine.state.music.devices['music.room']?.requested.playback).toBe(
      undefined,
    );
  });

  it('rejects an unknown step or target', async () => {
    const { registry } = setup();
    await expect(
      registry.invoke(
        'music.skipTrack',
        { target: 'music.room', step: 'random' },
        provenance,
      ),
    ).rejects.toThrow();
    await expect(
      registry.invoke(
        'music.skipTrack',
        { target: 'music.other', step: 'next' },
        provenance,
      ),
    ).rejects.toThrow();
  });
});
