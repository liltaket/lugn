import { describe, expect, it, vi } from 'vitest';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import {
  CapabilityInputError,
  CapabilityRegistry,
} from '../src/application/capabilities.js';
import type { ComputerPlaybackControl } from '../src/application/computer-playback-controller.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import type { MusicCommandRecord } from '../src/core/schemas.js';

const target = 'music.room';
const human = {
  actor: { type: 'user' as const },
  source: 'dashboard',
  requestId: 'seek-1',
};

function setup({
  source = 'Spotify',
  computer,
}: { source?: string; computer?: ComputerPlaybackControl } = {}) {
  const clock = new FakeClock(Date.parse('2026-10-04T12:00:00+02:00'));
  const adapter = new SimulatedMusicAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    music: { targets: { [target]: ['Spotify', 'Optical'] }, adapter },
    musicAutomaticFades: false,
    computerAudioInputs: { [target]: { source: 'Optical' } },
    ...(computer ? { computerPlayback: computer } : {}),
  });
  const observe = (durationSeconds?: number) =>
    adapter.observe(target, {
      volume: 0.3,
      playback: 'playing',
      source,
      title: 'First song',
      ...(durationSeconds
        ? {
            durationSeconds,
            positionSeconds: 10,
            positionUpdatedAt: clock.now(),
          }
        : {}),
    });
  const registry = new CapabilityRegistry(engine);
  const seek = (positionSeconds: number) =>
    registry.invoke('music.seek', { target, positionSeconds }, human);
  return { engine, adapter, observe, registry, seek };
}

describe('music.seek', () => {
  it('sends the position to the player, once, inside the track', async () => {
    const s = setup();
    s.observe(200);
    await s.seek(120);
    expect(s.adapter.dispatched.map((command) => command.requested)).toEqual([
      { property: 'seek', value: 120 },
    ]);
  });

  it('refuses a position past the track, or a track without a length', async () => {
    const s = setup();
    s.observe();
    for (const position of [1, 500]) {
      await expect(s.seek(position)).rejects.toBeInstanceOf(
        CapabilityInputError,
      );
      s.observe(200);
    }
    await expect(s.seek(-1)).rejects.toThrow();
    expect(s.adapter.dispatched).toEqual([]);
  });

  it("sends a computer input's steps and seeks to the computer", async () => {
    const record = { id: 'computer-1', status: 'confirmed' };
    const transport = vi.fn(async () => record as MusicCommandRecord);
    const canTransport = vi.fn(() => true);
    const s = setup({
      source: 'Optical',
      computer: {
        handles: () => true,
        getPlayback: () => 'playing',
        canResume: () => false,
        request: vi.fn(),
        canTransport,
        transport,
        observe: () => undefined,
        invalidate: () => undefined,
        dispose: () => undefined,
      },
    });
    s.observe();
    await s.seek(900);
    await s.registry.invoke(
      'music.skipTrack',
      { target, step: 'previous' },
      human,
    );
    expect(transport.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      { property: 'seek', value: 900 },
      { property: 'track', value: 'previous' },
    ]);
    // The receiver is not asked, and a step the computer cannot take is
    // refused before anything is sent.
    expect(s.adapter.dispatched).toEqual([]);
    canTransport.mockReturnValue(false);
    await expect(s.seek(1)).rejects.toBeInstanceOf(CapabilityInputError);
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
