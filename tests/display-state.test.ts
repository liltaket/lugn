import { describe, expect, it } from 'vitest';
import { FakeClock } from '../src/core/clock.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import {
  unknownComputerReadings,
  type ComputerObservation,
} from '../src/core/computer.js';
import type { MusicCommandRecord } from '../src/core/schemas.js';
import {
  DISPLAY_DECISIONS_PER_TARGET,
  displayPayloadKey,
  displayState,
  musicTrackControl,
} from '../src/runtime/display-state.js';

function engineState() {
  const engine = new LugnEngine(new FakeClock(1_000_000), {
    music: { targets: { 'music.room': [], 'music.other': [] } },
  });
  return { engine, state: structuredClone(engine.state) };
}

describe('displayState', () => {
  it('drops the logs a Hub never reads and keeps only pending commands', () => {
    const { state } = engineState();
    state.diagnostics = [{ at: 1 } as never];
    state.timings = [{ at: 1 } as never];
    state.commands = [
      { id: 'a', status: 'confirmed' } as never,
      { id: 'b', status: 'pending' } as never,
      { id: 'c', status: 'superseded' } as never,
    ];
    const shown = displayState(state);
    expect('diagnostics' in shown).toBe(false);
    expect('timings' in shown).toBe(false);
    expect(shown.commands.map((command) => command.id)).toEqual(['b']);
    // Everything else is the same state.
    expect(shown.lighting).toBe(state.lighting);
    expect(shown.presence).toBe(state.presence);
    expect(shown.revision).toBe(state.revision);
    // The source is untouched.
    expect(state.commands).toHaveLength(3);
  });

  it('keeps the latest decisions of each music target, in order', () => {
    const { state } = engineState();
    const decision = (target: string, at: number) =>
      ({
        target,
        at,
        reason: { kind: 'volume', value: 'automatic' },
      }) as never;
    state.music.decisions = [
      ...Array.from({ length: 12 }, (_, index) =>
        decision('music.room', index),
      ),
      decision('music.other', 100),
      ...Array.from({ length: 12 }, (_, index) =>
        decision('music.room', 200 + index),
      ),
    ];
    const kept = displayState(state).music.decisions!;
    const room = kept.filter((item) => item.target === 'music.room');
    expect(room).toHaveLength(DISPLAY_DECISIONS_PER_TARGET);
    expect(room.map((item) => item.at)).toEqual([
      204, 205, 206, 207, 208, 209, 210, 211,
    ]);
    expect(kept.filter((item) => item.target === 'music.other')).toHaveLength(
      1,
    );
    const times = kept.map((item) => item.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(state.music.decisions).toHaveLength(25);
  });

  it('keeps only the music commands a Hub can show, in ledger order', () => {
    const { state } = engineState();
    const room = state.music.devices['music.room']!;
    room.observedAt = 1_000;
    const command = (
      id: string,
      issuedAt: number,
      over: Partial<MusicCommandRecord> = {},
    ): MusicCommandRecord => ({
      id,
      target: 'music.room',
      requested: { property: 'volume', value: 0.3 },
      issuedAt,
      status: 'confirmed',
      provenance: {
        actor: { type: 'user', id: 'user' },
        source: 'test',
        reason: 'test',
      },
      ...over,
    });
    const readBack = (
      verifiedAt: number,
      reported = true,
    ): Partial<MusicCommandRecord> => ({
      recovery: {
        stage: 'stopped',
        attemptCount: 1,
        lastAttemptAt: 1,
        deadlineAt: 2,
        nextAttemptAt: null,
        stopReason: 'newer_report',
        verifiedAt,
        ...(reported ? { reported: { ...room.observed, volume: 0.5 } } : {}),
      },
    });
    state.music.commands = [
      command('old', 1),
      command('pending', 2, { status: 'pending' }),
      command('read-back', 3, readBack(1_001)),
      command('stale-read-back', 4, readBack(1_000)),
      command('read-without-report', 5, readBack(1_001, false)),
      command('latest', 9, { status: 'failed' }),
      command('later-in-ledger', 8),
      command('skip', 10, { requested: { property: 'track', value: 'next' } }),
      command('seek', 11, { requested: { property: 'seek', value: 5 } }),
      command('other-first', 7, { target: 'music.other' }),
      command('other-tie', 7, { target: 'music.other' }),
    ];
    const ids = () => displayState(state).music.commands.map((item) => item.id);
    expect(ids()).toEqual(['pending', 'read-back', 'latest', 'other-tie']);
    // A player never observed is older than any read-back.
    room.observedAt = null;
    expect(ids()).toEqual([
      'pending',
      'read-back',
      'stale-read-back',
      'latest',
      'other-tie',
    ]);
    // The ledger itself is untouched.
    expect(state.music.commands).toHaveLength(11);
  });

  it('sends desktop media without its inline cover', () => {
    const { state } = engineState();
    const media = {
      player: 'browser',
      identity: 'Browser',
      desktopEntry: 'browser',
      playback: 'playing' as const,
      title: 'A video',
      artists: ['Channel'],
      album: null,
      contentType: null,
    };
    const device = (
      list: ComputerObservation['observed']['media'],
    ): ComputerObservation => ({
      deviceId: 'desktop',
      availability: 'online',
      freshness: 'fresh',
      reason: 'live',
      observedAt: 1,
      receivedAt: 1,
      sessionId: 'session',
      sequence: 1,
      observed: { ...unknownComputerReadings(), media: list },
      activity: {
        classification: 'video',
        source: 'desktop-agent',
        basis: null,
      },
      lastEvent: null,
    });
    state.computer.devices = {
      desktop: device([
        { ...media, artwork: { provider: 'inline', data: 'aGVsbG8=' } },
      ]),
      unknown: device(null),
    };
    const shown = displayState(state).computer.devices;
    expect(shown['desktop']!.observed.media).toEqual([media]);
    // Unknown media stays unknown, which the page tells apart from none.
    expect(shown['unknown']!.observed.media).toBeNull();
    expect(
      state.computer.devices['desktop']!.observed.media![0],
    ).toHaveProperty('artwork');
    // Without covers there is nothing to copy.
    state.computer.devices = { desktop: device([media]) };
    expect(displayState(state).computer).toBe(state.computer);
  });

  it('leaves a state without decisions alone', () => {
    const { state } = engineState();
    delete state.music.decisions;
    expect(displayState(state).music).toBe(state.music);
  });
});

describe('displayPayloadKey', () => {
  it('ignores counters and evaluation clocks only', () => {
    const payload = (revision: number, evaluatedAt: number, title: string) =>
      JSON.stringify({
        deliveryRevision: revision,
        generatedAt: revision * 1000,
        state: { revision, updatedAt: revision * 7, sceneRevision: 3 },
        intelligence: { optical: [{ evaluatedAt }] },
        title,
      });
    expect(displayPayloadKey(payload(1, 10, 'a'))).toBe(
      displayPayloadKey(payload(2, 20, 'a')),
    );
    expect(displayPayloadKey(payload(1, 10, 'a'))).not.toBe(
      displayPayloadKey(payload(1, 10, 'b')),
    );
    // sceneRevision is real state, not a counter of the stream.
    expect(displayPayloadKey('{"sceneRevision":3}')).toBe(
      '{"sceneRevision":3}',
    );
  });
});

describe('musicTrackControl', () => {
  it('offers Nästa låt for an available player that is not on a computer input', () => {
    const { state } = engineState();
    const room = state.music.devices['music.room']!;
    const other = state.music.devices['music.other']!;
    room.availability = 'available';
    room.observed.source = 'Spotify';
    other.availability = 'available';
    other.observed.source = 'Optical';
    const routes = { 'music.other': { deviceId: 'kuffe', source: 'Optical' } };
    expect(musicTrackControl(state, routes)).toEqual({
      'music.room': true,
      'music.other': false,
    });
    // Off the computer's input the player skips again; unavailable never.
    other.observed.source = 'Spotify';
    room.availability = 'unavailable';
    expect(musicTrackControl(state, routes)).toEqual({
      'music.room': false,
      'music.other': true,
    });
    // An unknown source on a computer-routed player counts as the computer.
    other.observed.source = null;
    expect(musicTrackControl(state, routes)['music.other']).toBe(false);
  });
});
