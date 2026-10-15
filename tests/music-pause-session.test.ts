import { afterEach, expect, it } from 'vitest';
import {
  SimulatedMusicAdapter,
  type MusicObservation,
} from '../src/adapters/simulated-music.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock, type Clock } from '../src/core/clock.js';
import { applyStateUpdate } from '../src/core/event-stream.js';
import type {
  MusicIntentSnapshot,
  Presence,
  StateUpdate,
} from '../src/core/schemas.js';

const start = Date.parse('2026-10-04T12:00:00+02:00');
const minute = 60_000;
const target = 'music.room';
const user = { actor: { type: 'user' as const }, source: 'test' };
const values = {
  playback: 'playing' as const,
  volume: 0.4,
  source: 'Optical',
  title: 'Track',
};
const engines: LugnEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});
async function flush() {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

function setup(
  options: {
    now?: number;
    sessionMs?: number;
    feedbackTimeoutMs?: number;
    restore?: MusicIntentSnapshot;
    delayedTimers?: boolean;
  } = {},
) {
  const time = new FakeClock(options.now ?? start);
  const clock: Clock = options.delayedTimers
    ? {
        now: () => time.now(),
        monotonicNow: () => time.monotonicNow(),
        setTimeout: (cb, ms) => time.setTimeout(cb, ms + 1_000),
        clearTimeout: (handle) => time.clearTimeout(handle),
      }
    : time;
  const adapter = new SimulatedMusicAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    roomSessionContinuityMs: options.sessionMs ?? 20 * minute,
    music: {
      targets: { [target]: [] },
      adapter,
      ...(options.feedbackTimeoutMs === undefined
        ? {}
        : { feedbackTimeoutMs: options.feedbackTimeoutMs }),
    },
    ...(options.restore ? { restoredMusicIntent: options.restore } : {}),
  });
  engines.push(engine);
  const presence = (presence: Presence) =>
    engine.handlePresence({ type: 'presence.changed', presence });
  const pause = () =>
    engine.requestMusic(
      target,
      { property: 'playback', value: 'paused' },
      user,
    );
  const playback = () => engine.getMusicPlaybackPolicySnapshots()[target]!;
  const volume = () => engine.getMusicVolumePolicySnapshots()[target]!;
  const observe = (
    playback: 'playing' | 'paused',
    changedAt?: number,
    commandId?: string,
  ) =>
    adapter.observe(
      target,
      { ...values, playback },
      true,
      commandId,
      undefined,
      changedAt,
    );
  const positives = (from = 0) =>
    adapter.dispatched
      .slice(from)
      .filter(
        (c) =>
          c.requested.property === 'preset' ||
          (c.requested.property === 'playback' &&
            c.requested.value === 'playing'),
      );
  return {
    engine,
    time,
    adapter,
    presence,
    pause,
    playback,
    volume,
    observe,
    positives,
  };
}

async function pausedVisit(s: ReturnType<typeof setup>) {
  s.observe('playing', s.time.now());
  await s.presence('occupied');
  await s.engine.requestMusic(target, { property: 'volume', value: 0.4 }, user);
  const pause = await s.pause();
  s.time.advanceBy(1);
  s.observe('paused', s.time.now(), pause.id);
  await s.presence('confirmed_empty');
  await flush();
  return s.engine.state.session!.id;
}

it.each([5 * minute, 20 * minute - 1, 20 * minute, 20 * minute + 1])(
  'uses the room deadline for a return after %i ms, independently of volume',
  async (absence) => {
    const s = setup();
    const id = await pausedVisit(s);
    const before = s.adapter.dispatched.length;
    s.time.advanceBy(absence);
    const retained = absence < 20 * minute;
    expect(s.playback().manualPause !== null).toBe(retained);
    expect(s.positives(before)).toEqual([]); // Expiry never starts playback.
    await s.presence('occupied');
    await flush();
    expect(s.engine.state.session!.id === id).toBe(retained);
    expect(s.positives(before).map((c) => c.requested)).toEqual(
      retained ? [] : [{ property: 'preset', value: 'spotify_dj' }],
    );
    expect(s.volume().baseline).toBe(0.4);
    expect(s.volume().manualHold !== null).toBe(retained);
  },
);

it.each([5 * minute, 25 * minute])(
  'keeps room-session %i ms independent from music continuity',
  async (sessionMs) => {
    const s = setup({ sessionMs });
    await pausedVisit(s);
    const enabled = s.volume().policyEnabled;
    s.time.advanceBy(20 * minute);
    expect(s.playback().manualPause !== null).toBe(sessionMs > 20 * minute);
    expect(s.volume().manualHold).toBeNull();
    expect(s.volume().baseline).toBe(0.4);
    expect(s.volume().policyEnabled).toBe(enabled);
    if (sessionMs > 20 * minute) s.time.advanceBy(5 * minute);
    expect(s.playback().manualPause).toBeNull();
  },
);

it('releases only playback at a short session boundary and publishes policy/history for Hub explanations', async () => {
  const s = setup({ sessionMs: minute });
  await pausedVisit(s);
  await s.engine.handleBilresaPress('2', 'multi_press_1');
  const beforeVolume = s.volume();
  const beforeState = structuredClone(s.engine.state);
  const updates: StateUpdate[] = [];
  const unsubscribe = s.engine.stream.subscribe((update) =>
    updates.push(update),
  );
  s.time.advanceBy(minute);
  unsubscribe();
  expect(s.playback()).toMatchObject({
    manualPause: null,
    activityReason: 'confirmed_empty',
    entryEligible: true,
  });
  expect(s.volume()).toEqual(beforeVolume);
  expect(
    s.engine.state.intent.holds.some((h) => h.scope === 'music.playback'),
  ).toBe(false);
  expect(s.engine.state.diagnostics.at(-1)?.kind).toBe('session.ended');
  expect(
    s.engine.state.diagnostics.some((d) => d.kind === 'music.pause_released'),
  ).toBe(true);
  expect(updates.reduce(applyStateUpdate, beforeState)).toEqual(s.engine.state);
  expect(s.engine.state.music.decisions).toContainEqual(
    expect.objectContaining({
      reason: { kind: 'playback', value: 'confirmed_empty' },
    }),
  );
});

it('unknown gaps, duplicate empty and home/away changes neither release early nor extend the boundary', async () => {
  const s = setup();
  s.observe('playing');
  await s.presence('occupied');
  await s.pause();
  await s.presence('unknown');
  s.time.advanceBy(30 * minute);
  expect(s.playback().manualPause).not.toBeNull();
  await s.presence('confirmed_empty');
  const deadline = s.engine.state.session!.expiresAt;
  s.time.advanceBy(5 * minute);
  await s.presence('unknown');
  await s.presence('confirmed_empty');
  await s.engine.handleHomePresence('away');
  await s.engine.handleHomePresence('home');
  expect(s.engine.state.session!.expiresAt).toBe(deadline);
  expect(s.playback().manualPause).not.toBeNull();
  s.time.advanceBy(15 * minute);
  expect(s.playback().manualPause).toBeNull();
});

it.each([-1, 0, 1])(
  'orders entry %+i ms from deadline before a delayed timer callback',
  async (delta) => {
    const s = setup({ sessionMs: minute, delayedTimers: true });
    const id = await pausedVisit(s);
    s.time.advanceBy(minute + delta);
    await s.presence('occupied');
    expect(s.engine.state.session!.id === id).toBe(delta < 0);
    expect(s.playback().manualPause !== null).toBe(delta < 0);
    if (delta >= 0) await s.pause(); // Old callback must not erase a later visit's Pause.
    s.time.advanceBy(1_001);
    expect(s.playback().manualPause).not.toBeNull();
  },
);

it('protects newer Pause while absent from the previous visit expiry and binds it to the next visit', async () => {
  const s = setup({ sessionMs: minute });
  await pausedVisit(s);
  s.time.advanceBy(10_000);
  await s.pause();
  const newer = s.playback().manualPause;
  expect(newer?.resetPolicy).toBe('explicit_playback');
  s.time.advanceBy(50_000);
  expect(s.playback().manualPause).toEqual(newer);
  const before = s.adapter.dispatched.length;
  await s.presence('occupied');
  expect(s.positives(before)).toEqual([]);
  expect(s.playback().manualPause?.resetPolicy).toBe(
    'room_session_or_explicit_playback',
  );
  await s.presence('confirmed_empty');
  s.time.advanceBy(minute);
  expect(s.playback().manualPause).toBeNull();
});

it.each([-1, 0, 1])(
  'restores the saved session deadline %+i ms from expiry without replay or renewal',
  async (delta) => {
    const s = setup({ sessionMs: 5 * minute });
    await pausedVisit(s);
    const snapshot = s.engine.getMusicIntentSnapshot();
    const deadline =
      snapshot.targets[target]!.pause!.sessionBoundary!.expiresAt!;
    s.engine.dispose();
    const r = setup({
      now: deadline + delta,
      sessionMs: 30 * minute,
      restore: snapshot,
    });
    expect(r.engine.state.session).toBeNull();
    expect(r.engine.state.presence.state).toBe('unknown');
    expect(r.adapter.dispatched).toEqual([]);
    expect(r.playback().manualPause !== null).toBe(delta < 0);
    r.observe('paused', start + 1);
    await r.presence('unknown');
    await r.presence('confirmed_empty');
    const again = setup({
      now: deadline + delta,
      restore: r.engine.getMusicIntentSnapshot(),
    });
    expect(again.playback().manualPause !== null).toBe(delta < 0);
    const before = r.adapter.dispatched.length;
    await r.presence('occupied');
    expect(r.positives(before).length).toBe(delta < 0 ? 0 : 1);
    if (delta < 0) {
      expect(
        r.engine.getMusicIntentSnapshot().targets[target]!.pause
          ?.sessionBoundary?.expiresAt,
      ).toBeNull();
      again.time.advanceBy(1);
      expect(again.playback().manualPause).toBeNull();
    }
  },
);

it('does not infer an exit during active/unknown startup; first confirmed empty establishes a safe deadline', async () => {
  const s = setup({ sessionMs: minute });
  await s.presence('occupied');
  await s.pause();
  const snapshot = s.engine.getMusicIntentSnapshot();
  expect(
    snapshot.targets[target]!.pause?.sessionBoundary?.expiresAt,
  ).toBeNull();
  s.engine.dispose();
  const r = setup({
    now: start + 60 * minute,
    sessionMs: minute,
    restore: snapshot,
  });
  await r.presence('unknown');
  r.time.advanceBy(60 * minute);
  expect(r.playback().manualPause).not.toBeNull();
  await r.presence('confirmed_empty');
  expect(r.engine.state.session).toBeNull();
  expect(
    r.engine.getMusicIntentSnapshot().targets[target]!.pause?.sessionBoundary
      ?.expiresAt,
  ).toBe(r.time.now() + minute);
  r.time.advanceBy(minute);
  expect(r.playback().manualPause).toBeNull();
  expect(r.positives()).toEqual([]);
});

it('preserves a newer absent Pause across restart even after the old session deadline', async () => {
  const s = setup({ sessionMs: minute });
  await pausedVisit(s);
  s.time.advanceBy(10_000);
  await s.pause();
  const snapshot = s.engine.getMusicIntentSnapshot();
  expect(snapshot.targets[target]!.pause).not.toHaveProperty('sessionBoundary');
  s.engine.dispose();
  const r = setup({ now: start + 2 * minute, restore: snapshot });
  expect(r.playback().manualPause?.createdAt).toBe(start + 10_001);
  r.observe('paused');
  await r.presence('occupied');
  expect(r.positives()).toEqual([]);
});

it.each(['older', 'equal', 'missing'] as const)(
  'rejects %s late Pause feedback after release, including restart',
  async (timestamp) => {
    const s = setup({ sessionMs: minute });
    await pausedVisit(s);
    s.time.advanceBy(minute);
    const releasedAt =
      s.engine.getMusicIntentSnapshot().targets[target]!.playbackReleasedAt!;
    for (const current of [
      s,
      setup({
        now: releasedAt + 1_000,
        restore: s.engine.getMusicIntentSnapshot(),
      }),
    ]) {
      current.time.advanceBy(10 * minute); // Older than the command attribution window.
      current.observe('playing', releasedAt - 10);
      current.observe(
        'paused',
        timestamp === 'missing'
          ? undefined
          : releasedAt + (timestamp === 'older' ? -1 : 0),
      );
      expect(current.playback().manualPause).toBeNull();
      current.time.advanceBy(1);
      current.observe('paused', current.time.now()); // Attributable new physical Pause is respected.
      expect(current.playback().manualPause).not.toBeNull();
    }
  },
);

it.each(['playing', 'preset', 'physical'] as const)(
  'still releases a current Pause immediately for %s without changing volume',
  async (action) => {
    const s = setup();
    await pausedVisit(s);
    const volume = s.volume();
    if (action === 'physical') {
      s.time.advanceBy(1);
      s.observe('playing', s.time.now());
    } else
      await s.engine.requestMusic(
        target,
        action === 'preset'
          ? { property: 'preset', value: 'spotify_dj' }
          : { property: 'playback', value: 'playing' },
        user,
      );
    expect(s.playback().manualPause).toBeNull();
    expect(s.volume()).toEqual(volume);
  },
);

it.each(['quiet', 'away', 'unavailable'] as const)(
  'session expiry retains the %s entry guard',
  async (guard) => {
    const s = setup({
      sessionMs: minute,
      ...(guard === 'quiet'
        ? { now: Date.parse('2026-10-04T23:00:00+02:00') }
        : {}),
    });
    await pausedVisit(s);
    s.time.advanceBy(minute);
    if (guard === 'away') await s.engine.handleHomePresence('away');
    const r =
      guard === 'unavailable'
        ? setup({
            now: s.time.now(),
            restore: s.engine.getMusicIntentSnapshot(),
          })
        : s;
    const before = r.adapter.dispatched.length;
    await r.presence('occupied');
    expect(r.playback().manualPause).toBeNull();
    expect(r.positives(before)).toEqual([]);
  },
);

// Feedback arriving during absence still belongs to the visit when HA dates it there.
it('does not turn a delayed visit Pause into newer absent intent before expiry', async () => {
  const s = setup();
  s.observe('playing', start);
  await s.presence('occupied');
  await s.pause();
  s.time.advanceBy(2);
  await s.presence('confirmed_empty');
  s.time.advanceBy(19 * minute);
  s.observe('paused', start + 1);
  expect(s.playback().manualPause?.resetPolicy).toBe(
    'room_session_or_explicit_playback',
  );
  s.time.advanceBy(minute);
  expect(s.playback().manualPause).toBeNull();
});

it.each([-1, 0, 1])(
  'protects physical Pause %+i ms from confirmed exit across restart',
  async (delta) => {
    const s = setup({ sessionMs: minute });
    s.observe('playing', start);
    await s.presence('occupied');
    await s.pause();
    s.time.advanceBy(1_000);
    await s.presence('confirmed_empty');
    const snapshot = s.engine.getMusicIntentSnapshot();
    s.engine.dispose();
    const r = setup({
      now: start + 10_000,
      sessionMs: minute,
      restore: snapshot,
    });
    r.observe('playing', start);
    r.observe('paused', start + 1_000 + delta);
    const deadline = start + 1_000 + minute;
    r.time.advanceBy(deadline - r.time.now());
    expect(r.playback().manualPause !== null).toBe(delta >= 0);
  },
);

it('keeps a short-return Pause until the following full absence, without an old timer clearing it', async () => {
  const s = setup({ sessionMs: minute });
  await pausedVisit(s);
  s.time.advanceBy(minute - 1);
  await s.presence('occupied');
  s.time.advanceBy(minute);
  expect(s.playback().manualPause).not.toBeNull();
  await s.presence('confirmed_empty');
  s.time.advanceBy(minute - 1);
  expect(s.playback().manualPause).not.toBeNull();
  s.time.advanceBy(1);
  expect(s.playback().manualPause).toBeNull();
});

it('rejects stale feedback without clearing a newer Pause after the previous visit ended', async () => {
  const s = setup({ sessionMs: minute });
  await pausedVisit(s);
  s.time.advanceBy(minute);
  const boundary = s.time.now();
  s.time.advanceBy(1);
  await s.pause();
  const newer = s.playback().manualPause;
  s.observe('playing', boundary);
  s.observe('paused', start + 1);
  expect(s.playback().manualPause).toEqual(newer);
});

async function unconfirmedPausedVisit(s: ReturnType<typeof setup>) {
  Object.assign(s.adapter, {
    readStatus: async (): Promise<MusicObservation> => ({
      target,
      values,
      available: true,
      observedAt: s.time.now(),
      playbackChangedAt: start,
    }),
  });
  s.observe('playing', start);
  await s.presence('occupied');
  await s.pause();
  await s.presence('confirmed_empty');
  await flush();
}

it('retains fresh away Pause recovery when the default room session ends', async () => {
  const s = setup();
  await unconfirmedPausedVisit(s);
  s.time.advanceBy(20 * minute - 1_000);
  await flush();
  await s.engine.handleHomePresence('away');
  await flush();
  const command = s.engine.state.music.commands.at(-1)!;
  expect(command.provenance.reason).toBe('pause while away');
  expect(command.recovery?.stage).toBe('awaiting_feedback');
  const before = s.adapter.dispatched.length;

  s.time.advanceBy(1_000);
  await flush();
  expect(s.engine.state.session?.state).toBe('ended');
  expect(s.playback().manualPause).toBeNull();
  expect(command).toMatchObject({
    status: 'pending',
    recovery: { stage: 'awaiting_feedback', stopReason: null },
  });
  expect(s.adapter.dispatched).toHaveLength(before);
  s.time.advanceBy(9_000);
  await flush();
  expect(command.recovery?.stage).toBe('waiting_retry');
  s.time.advanceBy(2_000);
  await flush();
  expect(s.adapter.dispatched.slice(before)).toEqual([
    {
      id: command.id,
      target,
      requested: { property: 'playback', value: 'paused' },
    },
  ]);
  expect(command.recovery).toMatchObject({
    stage: 'awaiting_feedback',
    attemptCount: 2,
    stopReason: null,
  });
  s.observe('paused', start, command.id);
  expect(command.status).toBe('confirmed');
  expect(s.playback().manualPause).toBeNull();
});

it('retains a scheduled empty-room Pause retry across a five-second session end', async () => {
  const s = setup({ sessionMs: 5_000, feedbackTimeoutMs: 4_000 });
  await unconfirmedPausedVisit(s);
  const command = s.engine.state.music.commands.at(-1)!;
  expect(command.provenance.reason).toBe('pause');
  s.time.advanceBy(4_000);
  await flush();
  expect(command.recovery).toMatchObject({
    stage: 'waiting_retry',
    nextAttemptAt: start + 6_000,
  });
  const before = s.adapter.dispatched.length;
  s.time.advanceBy(1_000);
  await flush();
  expect(s.engine.state.session?.state).toBe('ended');
  expect(s.playback().manualPause).toBeNull();
  expect(command).toMatchObject({
    status: 'unconfirmed',
    recovery: {
      stage: 'waiting_retry',
      nextAttemptAt: start + 6_000,
      stopReason: null,
    },
  });
  expect(s.adapter.dispatched).toHaveLength(before);
  s.time.advanceBy(1_000);
  await flush();
  expect(s.adapter.dispatched.slice(before)).toEqual([
    {
      id: command.id,
      target,
      requested: { property: 'playback', value: 'paused' },
    },
  ]);
  expect(command.recovery).toMatchObject({
    stage: 'awaiting_feedback',
    attemptCount: 2,
    stopReason: null,
  });
  s.observe('paused', start, command.id);
  expect(command.status).toBe('confirmed');
  expect(s.playback().manualPause).toBeNull();
});
