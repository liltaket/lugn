import { expect, it, vi } from 'vitest';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import type { ComputerPlaybackControl } from '../src/application/computer-playback-controller.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import { unknownComputerReadings } from '../src/core/computer.js';
import type {
  MusicCommandRecord,
  MusicObservationValues,
  MusicRequest,
  Provenance,
} from '../src/core/schemas.js';

const target = 'music.room';
const user = { actor: { type: 'user' as const }, source: 'nest' };
const physical = {
  playback: 'playing' as const,
  source: 'Optical In',
  volume: 0.3,
  title: '4',
};

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function setup() {
  const clock = new FakeClock(Date.parse('2026-10-17T12:00:00+02:00'));
  const adapter = new SimulatedMusicAdapter(clock);
  const refs: { engine?: LugnEngine } = {};
  let playback: MusicObservationValues['playback'] = 'playing';
  let owned = false;
  const commands: MusicCommandRecord[] = [];
  const computerPlayback: ComputerPlaybackControl = {
    handles: () =>
      refs.engine?.state.music.devices[target]?.observed.source ===
      'Optical In',
    getPlayback: () => playback,
    canResume: () => owned,
    request: vi.fn(
      async (
        musicTarget: string,
        requested: Extract<MusicRequest, { property: 'playback' }>,
        provenance: Provenance,
      ): Promise<MusicCommandRecord> => {
        const command: MusicCommandRecord = {
          id: `computer-${commands.length + 1}`,
          target: musicTarget,
          requested,
          provenance,
          issuedAt: clock.now(),
          status: 'pending',
          acceptedAt: clock.now(),
        };
        commands.push(command);
        if (provenance.actor.type === 'automation') {
          if (requested.value === 'paused' && playback === 'playing')
            owned = true;
          if (requested.value === 'playing') owned = false;
        } else owned = false;
        return command;
      },
    ),
    observe: vi.fn(),
    invalidate: vi.fn(() => {
      owned = false;
    }),
    dispose: vi.fn(),
  };
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    music: {
      targets: { [target]: ['Optical In', 'Spotify'] },
      adapter,
    },
    computerPlayback,
  });
  refs.engine = engine;
  adapter.observe(target, physical);
  const presence = async (
    presence: 'occupied' | 'confirmed_empty' | 'unknown',
  ) => {
    await engine.handlePresence({ type: 'presence.changed', presence });
    await flush();
  };
  return {
    engine,
    adapter,
    clock,
    commands,
    computerPlayback,
    presence,
    setPlayback: (value: MusicObservationValues['playback']) => {
      playback = value;
    },
  };
}

it('pauses and resumes desktop playback on a short return, preserving physical receiver observations', async () => {
  const s = setup();
  try {
    await s.presence('occupied');
    await s.presence('confirmed_empty');
    // A return can precede the desktop pause result or its telemetry feedback.
    expect(s.commands.map((command) => command.requested.value)).toEqual([
      'paused',
    ]);
    await s.presence('unknown');
    s.clock.advanceBy(10_000);
    await s.presence('occupied');
    expect(s.commands.map((command) => command.requested.value)).toEqual([
      'paused',
      'playing',
    ]);
    expect(s.engine.getMusicState(target).observed).toEqual(physical);
    expect(s.engine.getMusicState(target).requested.playback).toBeUndefined();
    expect(
      s.adapter.dispatched.filter(
        (command) => command.requested.property !== 'volume',
      ),
    ).toEqual([]);
  } finally {
    s.engine.dispose();
  }
});

it.each(['paused', 'unknown'] as const)(
  'does not use receiver Playing as desktop resume permission when desktop is %s',
  async (playback) => {
    const s = setup();
    try {
      s.setPlayback(playback);
      await s.presence('occupied');
      await s.presence('confirmed_empty');
      await s.presence('occupied');
      expect(s.commands.map((command) => command.requested.value)).toEqual([
        'paused',
      ]);
      expect(
        s.adapter.dispatched.filter(
          (command) => command.requested.property !== 'volume',
        ),
      ).toEqual([]);
    } finally {
      s.engine.dispose();
    }
  },
);

it.each(['expired', 'quiet', 'away', 'manual'] as const)(
  'retains the existing %s playback gate on the desktop route',
  async (gate) => {
    const s = setup();
    try {
      if (gate === 'quiet') s.clock.advanceBy((10 * 60 + 59) * 60_000);
      await s.presence('occupied');
      await s.presence('confirmed_empty');
      if (gate === 'expired') s.clock.advanceBy(20 * 60_000);
      if (gate === 'quiet') s.clock.advanceBy(60_000);
      if (gate === 'away') await s.engine.handleHomePresence('away');
      if (gate === 'manual')
        await s.engine.requestMusic(
          target,
          { property: 'playback', value: 'paused' },
          user,
        );
      const before = s.commands.length;
      await s.presence('occupied');
      expect(s.commands).toHaveLength(before);
      expect(
        s.adapter.dispatched.filter(
          (command) => command.requested.property !== 'volume',
        ),
      ).toEqual([]);
    } finally {
      s.engine.dispose();
    }
  },
);

it('requires retained desktop pause ownership even within the receiver resume window', async () => {
  const s = setup();
  try {
    await s.presence('occupied');
    await s.presence('confirmed_empty');
    s.computerPlayback.invalidate(target);
    await s.presence('occupied');
    expect(s.commands.map((command) => command.requested.value)).toEqual([
      'paused',
    ]);
  } finally {
    s.engine.dispose();
  }
});

it('routes manual Nest playback through the desktop controller and keeps its Pause through receiver feedback', async () => {
  const s = setup();
  try {
    await s.presence('occupied');
    await s.engine.requestMusic(
      target,
      { property: 'playback', value: 'paused' },
      user,
    );
    s.clock.advanceBy(1);
    s.adapter.observe(target, { ...physical, playback: 'paused' });
    s.clock.advanceBy(1);
    s.adapter.observe(target, physical);
    expect(
      s.engine.getMusicPlaybackPolicySnapshots()[target]!.manualPause,
    ).not.toBeNull();
    await s.presence('confirmed_empty');
    const before = s.commands.length;
    await s.presence('occupied');
    expect(s.commands).toHaveLength(before);
    await s.engine.requestMusic(
      target,
      { property: 'playback', value: 'playing' },
      user,
    );
    expect(
      s.engine.getMusicPlaybackPolicySnapshots()[target]!.manualPause,
    ).toBeNull();
    expect(s.commands.at(-1)!.provenance).toEqual(user);
  } finally {
    s.engine.dispose();
  }
});

it('invalidates desktop ownership for explicit receiver changes and uses HA playback after leaving Optical', async () => {
  const s = setup();
  try {
    await s.engine.requestMusic(
      target,
      { property: 'source', value: 'Spotify' },
      user,
    );
    await s.engine.requestMusic(
      target,
      { property: 'preset', value: 'spotify_dj' },
      user,
    );
    expect(s.computerPlayback.invalidate).toHaveBeenCalledTimes(2);
    s.adapter.observe(target, { ...physical, source: 'Spotify' });
    await s.engine.requestMusic(
      target,
      { property: 'playback', value: 'paused' },
      user,
    );
    expect(s.commands).toEqual([]);
    expect(s.adapter.dispatched.at(-1)!.requested).toEqual({
      property: 'playback',
      value: 'paused',
    });
  } finally {
    s.engine.dispose();
  }
});

it('notifies the desktop controller for computer/receiver observations and disposes it', () => {
  const s = setup();
  const before = vi.mocked(s.computerPlayback.observe).mock.calls.length;
  s.engine.acceptComputerObservation({
    deviceId: 'kuffe',
    availability: 'online',
    freshness: 'fresh',
    reason: 'live',
    observedAt: s.clock.now(),
    receivedAt: s.clock.now(),
    sessionId: 'session',
    sequence: 1,
    observed: unknownComputerReadings(),
    activity: {
      classification: 'unknown',
      source: 'desktop-agent',
      basis: null,
    },
    lastEvent: null,
  });
  expect(s.computerPlayback.observe).toHaveBeenCalledTimes(before + 1);
  s.adapter.observe(target, { ...physical, source: 'Spotify' });
  expect(s.computerPlayback.observe).toHaveBeenCalledTimes(before + 2);
  s.engine.dispose();
  expect(s.computerPlayback.dispose).toHaveBeenCalledOnce();
});
