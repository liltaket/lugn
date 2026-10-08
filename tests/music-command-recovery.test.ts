import { expect, it, vi } from 'vitest';
import { LugnEngine } from '../src/application/lugn-engine.js';
import {
  SimulatedMusicAdapter,
  type MusicObservation,
} from '../src/adapters/simulated-music.js';
import { FakeClock } from '../src/core/clock.js';

const target = 'music.room';
const human = { actor: { type: 'user' as const }, source: 'dashboard' };
const start = Date.parse('2026-10-04T12:00:00+02:00');
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(feedbackTimeoutMs = 1_000, clockStart = start) {
  const clock = new FakeClock(clockStart);
  class Adapter extends SimulatedMusicAdapter {
    readStatus = vi.fn(async (): Promise<MusicObservation> => report());
  }
  const adapter = new Adapter(clock);
  const report = (
    volume = 0.3,
    playback: 'playing' | 'paused' = 'playing',
  ): MusicObservation => ({
    target,
    observedAt: clock.now(),
    available: true,
    sourceUpdatedAt: start - 1,
    playbackChangedAt: start - 1,
    values: { volume, playback, source: 'Optical', title: null },
  });
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [
      { id: 'scene.everyday_light', name: 'Everyday', lighting: {} },
      { id: 'scene.all_off', name: 'Off', lighting: {} },
    ],
    music: { targets: { [target]: ['Optical'] }, adapter, feedbackTimeoutMs },
  });
  adapter.observe(
    target,
    report().values,
    true,
    undefined,
    start - 1,
    start - 1,
  );
  const issue = (
    property: 'volume' | 'playback',
    value: number | 'playing' | 'paused',
  ) =>
    engine.requestMusic(
      target,
      property === 'volume'
        ? { property, value: value as number }
        : { property, value: value as 'playing' | 'paused' },
      human,
    );
  const advance = async (ms: number) => {
    clock.advanceBy(ms);
    await flush();
  };
  const record = (id: string) =>
    engine.state.music.commands.find((command) => command.id === id)!;
  return { clock, adapter, engine, report, issue, advance, record };
}

it.each([60_000, 63_000])(
  'a retry publication consuming monotonic time until %i ms cannot cross the recovery deadline',
  async (elapsed) => {
    const s = setup();
    const monotonic = s.clock.monotonicNow.bind(s.clock);
    let offset = 0;
    vi.spyOn(s.clock, 'monotonicNow').mockImplementation(
      () => monotonic() + offset,
    );
    try {
      const command = await s.issue('volume', 0.4);
      const unsubscribe = s.engine.stream.subscribe((update) => {
        const record = update.patch.music?.commands.find(
          (item) => item.id === command.id,
        );
        if (record?.recovery?.stage === 'retrying')
          offset = elapsed - monotonic();
      });
      await s.advance(1_000);
      await s.advance(2_000);
      unsubscribe();
      expect(s.adapter.dispatched).toHaveLength(1);
      expect(s.record(command.id).recovery?.stopReason).toBe('deadline');
      expect(s.clock.pendingTimers()).toBe(0);
    } finally {
      s.engine.dispose();
    }
  },
);

it('source supersession stops recovery without inventing a manual Pause from accepted automatic feedback', async () => {
  const s = setup();
  try {
    await s.engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    await s.engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
    });
    await flush();
    const pause = s.adapter.dispatched[0]!;
    s.clock.advanceBy(1);
    await s.engine.requestMusic(
      target,
      { property: 'source', value: 'Optical' },
      human,
    );
    s.clock.advanceBy(1);
    s.adapter.observe(
      target,
      s.report(0.3, 'paused').values,
      true,
      undefined,
      s.clock.now(),
      s.clock.now(),
    );
    expect(s.engine.state.intent.holds).toEqual([]);
    expect(s.record(pause.id)).toMatchObject({
      status: 'confirmed',
      recovery: { stopReason: 'superseded' },
    });
    await s.engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    await flush();
    expect(s.adapter.dispatched.at(-1)?.requested).toEqual({
      property: 'playback',
      value: 'playing',
    });
    expect(
      s.adapter.dispatched.filter((command) => command.id === pause.id),
    ).toHaveLength(1);
  } finally {
    s.engine.dispose();
  }
});

it('source supersession preserves the complete durable human Pause intent through late accepted feedback', async () => {
  const s = setup();
  try {
    const pause = await s.issue('playback', 'paused');
    const intent = s.engine.getMusicIntentSnapshot();
    s.clock.advanceBy(1);
    await s.engine.requestMusic(
      target,
      { property: 'source', value: 'Optical' },
      human,
    );
    expect(s.engine.getMusicIntentSnapshot()).toEqual(intent);
    s.clock.advanceBy(1);
    s.adapter.observe(
      target,
      s.report(0.3, 'paused').values,
      true,
      undefined,
      s.clock.now(),
      s.clock.now(),
    );
    expect(s.engine.getMusicIntentSnapshot()).toEqual(intent);
    expect(s.engine.state.intent.holds).toMatchObject([
      { createdAt: pause.issuedAt, provenance: human },
    ]);
    expect(s.record(pause.id)).toMatchObject({
      status: 'confirmed',
      recovery: { stopReason: 'superseded' },
    });
    // Attribution is consumed: genuinely newer physical Play/Pause remains
    // meaningful and the later Pause receives its own age and provenance.
    s.clock.advanceBy(1);
    s.adapter.observe(
      target,
      s.report().values,
      true,
      undefined,
      s.clock.now(),
      s.clock.now(),
    );
    expect(s.engine.state.intent.holds).toEqual([]);
    s.clock.advanceBy(1);
    s.adapter.observe(
      target,
      s.report(0.3, 'paused').values,
      true,
      undefined,
      s.clock.now(),
      s.clock.now(),
    );
    expect(s.engine.state.intent.holds).toMatchObject([
      {
        createdAt: s.clock.now(),
        provenance: {
          actor: { type: 'home_assistant' },
          source: 'external_observation',
        },
      },
    ]);
  } finally {
    s.engine.dispose();
  }
});

it('source-superseded automatic Pause attribution preserves newer Play and a genuinely later physical Pause', async () => {
  const s = setup();
  try {
    await s.engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    await s.engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
    });
    await flush();
    const pause = s.adapter.dispatched[0]!;
    s.clock.advanceBy(1);
    await s.engine.requestMusic(
      target,
      { property: 'source', value: 'Optical' },
      human,
    );
    s.clock.advanceBy(2);
    const play = await s.issue('playback', 'playing');
    s.clock.advanceBy(1);
    s.adapter.observe(
      target,
      s.report(0.3, 'paused').values,
      true,
      undefined,
      s.clock.now(),
      play.issuedAt - 1,
    );
    expect(s.record(pause.id).status).toBe('confirmed');
    expect(s.engine.state.intent.holds).toEqual([]);
    s.clock.advanceBy(1);
    s.adapter.observe(
      target,
      s.report().values,
      true,
      play.id,
      s.clock.now(),
      s.clock.now(),
    );
    expect(s.engine.state.intent.holds).toEqual([]);
    s.clock.advanceBy(1);
    s.adapter.observe(
      target,
      s.report(0.3, 'paused').values,
      true,
      undefined,
      s.clock.now(),
      s.clock.now(),
    );
    expect(s.engine.state.intent.holds).toHaveLength(1);
  } finally {
    s.engine.dispose();
  }
});

it('completed matching-read recoveries retain at most 128 terminal records and no timers', async () => {
  const s = setup();
  try {
    let latestId = '';
    for (let index = 0; index < 140; index++) {
      const volume = index % 2 === 0 ? 0.4 : 0.5;
      s.adapter.readStatus.mockImplementation(async () => s.report(volume));
      latestId = (await s.issue('volume', volume)).id;
      await s.advance(1_000);
    }
    expect(s.engine.state.music.commands).toHaveLength(128);
    expect(s.record(latestId).recovery?.stage).toBe('matched');
    expect(
      s.engine.state.music.commands.every(
        (command) =>
          command.status === 'unconfirmed' &&
          command.recovery?.stage === 'matched',
      ),
    ).toBe(true);
    expect(s.clock.pendingTimers()).toBe(0);
  } finally {
    s.engine.dispose();
  }
});

it('reads fresh status after accepted timeout without manufacturing feedback or ownership', async () => {
  const s = setup();
  try {
    s.adapter.readStatus.mockImplementation(async () => s.report(0.4));
    const command = await s.issue('volume', 0.4);
    const intent = s.engine.getMusicIntentSnapshot();
    await s.advance(999);
    expect(s.adapter.readStatus).not.toHaveBeenCalled();
    await s.advance(1);
    expect(s.adapter.readStatus).toHaveBeenCalledTimes(1);
    expect(s.record(command.id)).toMatchObject({
      status: 'unconfirmed',
      recovery: {
        stage: 'matched',
        attemptCount: 1,
        reported: { volume: 0.4 },
      },
    });
    expect(s.engine.getMusicState(target).observed.volume).toBe(0.3);
    expect(s.engine.getMusicIntentSnapshot()).toEqual(intent);
    expect(s.adapter.dispatched).toHaveLength(1);
  } finally {
    s.engine.dispose();
  }
});

it.each(['playing', 'preset', 'source'] as const)(
  'orders equal-issuedAt Pause and newer %s intent independently from clock timestamps',
  async (kind) => {
    const s = setup();
    const accepted = deferred<void>();
    const originalDispatch = s.adapter.dispatch.bind(s.adapter);
    try {
      s.adapter.dispatch = async (command) => {
        if (
          command.requested.property === 'playback' &&
          command.requested.value === 'paused'
        ) {
          s.adapter.dispatched.push(command);
          await accepted.promise;
        } else await originalDispatch(command);
      };
      const pausePromise = s.issue('playback', 'paused');
      const newer =
        kind === 'playing'
          ? await s.issue('playback', 'playing')
          : await s.engine.requestMusic(
              target,
              kind === 'preset'
                ? { property: 'preset', value: 'optical' }
                : { property: 'source', value: 'Optical' },
              human,
            );
      accepted.resolve();
      const pause = await pausePromise;
      expect(pause.issuedAt).toBe(newer.issuedAt);
      await s.advance(1_000);
      await s.advance(10_000);
      expect(
        s.adapter.dispatched.filter(
          (command) =>
            command.requested.property === 'playback' &&
            command.requested.value === 'paused',
        ),
      ).toHaveLength(1);
      expect(s.record(pause.id).recovery).toMatchObject({
        stage: 'stopped',
        stopReason: 'superseded',
      });
    } finally {
      s.engine.dispose();
    }
  },
);

it.each(['volume', 'playback'] as const)(
  'yields to genuine physical %s intent while a read is in flight',
  async (property) => {
    const s = setup();
    const read = deferred<MusicObservation>();
    try {
      s.adapter.readStatus.mockReturnValue(read.promise);
      const command = await s.issue(
        property,
        property === 'volume' ? 0.4 : 'paused',
      );
      await s.advance(1_000);
      s.adapter.observe(
        target,
        s.report(0.45, 'playing').values,
        true,
        undefined,
        s.clock.now(),
        s.clock.now(),
      );
      const intent = s.engine.getMusicIntentSnapshot();
      read.resolve(s.report());
      await flush();
      await s.advance(10_000);
      expect(s.adapter.dispatched).toHaveLength(1);
      expect(s.record(command.id).recovery).toMatchObject({
        stage: 'stopped',
        stopReason: 'superseded',
      });
      expect(s.engine.getMusicIntentSnapshot()).toEqual(intent);
      if (property === 'volume')
        expect(
          s.engine.getMusicVolumePolicySnapshots()[target]!.effectiveTarget,
        ).toBe(0.45);
      else expect(s.engine.state.intent.holds).toEqual([]);
    } finally {
      s.engine.dispose();
    }
  },
);

it('a publication subscriber can replace intent immediately before retry dispatch', async () => {
  const s = setup();
  let replacement: ReturnType<typeof s.issue> | undefined;
  try {
    const command = await s.issue('volume', 0.4);
    const unsubscribe = s.engine.stream.subscribe((update) => {
      const record = update.patch.music?.commands.find(
        (item) => item.id === command.id,
      );
      if (
        !replacement &&
        record?.recovery?.stage === 'retrying' &&
        record.status === 'pending'
      ) {
        // Set the sentinel before re-entering publication.
        replacement = Promise.resolve(record);
        replacement = s.issue('volume', 0.6);
      }
    });
    await s.advance(1_000);
    await s.advance(2_000);
    await replacement;
    unsubscribe();
    expect(s.adapter.dispatched.map((item) => item.requested)).toEqual([
      { property: 'volume', value: 0.4 },
      { property: 'volume', value: 0.6 },
    ]);
    expect(
      s.engine.getMusicVolumePolicySnapshots()[target]!.effectiveTarget,
    ).toBe(0.6);
  } finally {
    s.engine.dispose();
  }
});

it.each(['unknown', 'occupied', 'unknown_then_empty'] as const)(
  'does not recover obsolete empty-room Pause after %s',
  async (state) => {
    const s = setup();
    const read = deferred<MusicObservation>();
    try {
      s.adapter.readStatus.mockReturnValue(read.promise);
      await s.engine.handlePresence({
        type: 'presence.changed',
        presence: 'occupied',
        personCount: 1,
      });
      await s.engine.handlePresence({
        type: 'presence.changed',
        presence: 'confirmed_empty',
      });
      await flush();
      const pause = s.adapter.dispatched.find(
        (item) => item.requested.property === 'playback',
      )!;
      await s.advance(1_000);
      await s.engine.handlePresence({
        type: 'presence.changed',
        presence: state === 'occupied' ? 'occupied' : 'unknown',
      });
      if (state === 'unknown_then_empty')
        await s.engine.handlePresence({
          type: 'presence.changed',
          presence: 'confirmed_empty',
        });
      read.resolve(s.report());
      await flush();
      await s.advance(10_000);
      expect(
        s.adapter.dispatched.filter(
          (item) =>
            item.requested.property === 'playback' &&
            item.requested.value === 'paused',
        ),
      ).toHaveLength(1);
      expect(s.record(pause.id).recovery).toMatchObject({
        stage: 'stopped',
        stopReason: state === 'occupied' ? 'superseded' : 'policy_changed',
      });
    } finally {
      s.engine.dispose();
    }
  },
);

it.each(['home', 'unknown'] as const)(
  'home %s cancels a stale away Pause even without a new command',
  async (home) => {
    const s = setup();
    try {
      await s.engine.handleHomePresence('away');
      await flush();
      await s.engine.handleHomePresence(home);
      await s.advance(1_000);
      await s.advance(10_000);
      expect(s.adapter.readStatus).not.toHaveBeenCalled();
      expect(s.adapter.dispatched).toHaveLength(1);
    } finally {
      s.engine.dispose();
    }
  },
);

it.each(['disable', 'person', 'night'] as const)(
  'revalidates automatic volume target and authority after %s',
  async (transition) => {
    const s = setup(
      1_000,
      transition === 'night' ? Date.parse('2026-10-04T22:59:59+02:00') : start,
    );
    try {
      await s.engine.handlePresence({
        type: 'presence.changed',
        presence: 'occupied',
        personCount: 1,
      });
      await s.engine.handlePresence({
        type: 'presence.changed',
        presence: 'occupied',
        personCount: 2,
      });
      await flush();
      const original = s.adapter.dispatched[0]!;
      if (transition === 'disable')
        await s.engine.handleBilresaPress('2', 'multi_press_1');
      else if (transition === 'person')
        await s.engine.handlePresence({
          type: 'presence.changed',
          presence: 'occupied',
          personCount: 1,
        });
      await s.advance(1_000);
      expect(s.record(original.id).recovery?.stopReason).toMatch(
        /policy_changed|superseded/,
      );
      expect(
        s.adapter.dispatched.filter((item) => item.id === original.id),
      ).toHaveLength(1);
    } finally {
      s.engine.dispose();
    }
  },
);

it.each(['explicit', 'temporary'] as const)(
  'human volume recovery distinguishes %s automation handback',
  async (kind) => {
    const s = setup();
    try {
      const command = await s.issue('volume', 0.4);
      if (kind === 'explicit') {
        await s.engine.handleBilresaPress('2', 'multi_press_1');
        await s.engine.handleBilresaPress('2', 'multi_press_1');
      } else {
        await s.engine.handleBilresaPress('2', 'long_press');
        await s.engine.handleBilresaPress('2', 'long_press');
      }
      await s.advance(1_000);
      await s.advance(2_000);
      expect(s.adapter.dispatched).toHaveLength(kind === 'explicit' ? 1 : 2);
      expect(s.record(command.id).recovery?.stage).toBe(
        kind === 'explicit' ? 'stopped' : 'awaiting_feedback',
      );
    } finally {
      s.engine.dispose();
    }
  },
);

it.each(['read', 'dispatch'] as const)(
  'bounds pending %s at the original absolute60s deadline',
  async (io) => {
    const s = setup(55_000);
    const pendingRead = deferred<MusicObservation>();
    const pendingDispatch = deferred<void>();
    let signal: AbortSignal | undefined;
    try {
      const command = await s.issue('volume', 0.4);
      if (io === 'read')
        s.adapter.readStatus
          .mockImplementationOnce(async () => s.report())
          .mockImplementationOnce(() => pendingRead.promise);
      else
        s.adapter.dispatch = async (item, requestSignal?: AbortSignal) => {
          signal = requestSignal;
          s.adapter.dispatched.push(item);
          await pendingDispatch.promise;
        };
      await s.advance(55_000);
      await s.advance(2_000);
      await s.advance(2_999);
      expect(s.record(command.id).recovery?.stage).not.toBe('stopped');
      await s.advance(1);
      expect(s.record(command.id).recovery).toMatchObject({
        stage: 'stopped',
        stopReason: 'deadline',
        deadlineAt: start + 60_000,
      });
      if (io === 'dispatch') expect(signal?.aborted).toBe(true);
      const calls = s.adapter.dispatched.length;
      pendingRead.resolve(s.report());
      pendingDispatch.resolve();
      await flush();
      await s.advance(60_000);
      expect(s.adapter.dispatched).toHaveLength(calls);
      expect(s.clock.pendingTimers()).toBe(0);
    } finally {
      s.engine.dispose();
    }
  },
);

it.each(['failure', 'timeout', 'newer', 'stale'] as const)(
  'stops on %s verification rather than blindly resending',
  async (kind) => {
    const s = setup();
    try {
      if (kind === 'failure')
        s.adapter.readStatus.mockRejectedValue(new Error('network'));
      else if (kind === 'timeout')
        s.adapter.readStatus.mockReturnValue(new Promise(() => {}));
      else
        s.adapter.readStatus.mockImplementation(async () => ({
          ...s.report(),
          ...(kind === 'newer'
            ? { sourceUpdatedAt: s.clock.now() }
            : { observedAt: start - 1 }),
        }));
      const command = await s.issue('volume', 0.4);
      await s.advance(1_000);
      await s.advance(5_000);
      await s.advance(60_000);
      expect(s.adapter.dispatched).toHaveLength(1);
      expect(s.record(command.id).recovery).toMatchObject({
        stage: 'stopped',
        stopReason: {
          failure: 'read_failed',
          timeout: 'read_timeout',
          newer: 'newer_report',
          stale: 'invalid_readback',
        }[kind],
      });
    } finally {
      s.engine.dispose();
    }
  },
);

it.each(['source', 'preset'] as const)(
  'verifies %s without resending or inventing preset confirmation',
  async (property) => {
    const s = setup();
    try {
      const command = await s.engine.requestMusic(
        target,
        property === 'source'
          ? { property, value: 'Optical' }
          : { property, value: 'optical' },
        human,
      );
      await s.advance(1_000);
      await s.advance(60_000);
      expect(s.adapter.readStatus).toHaveBeenCalledTimes(1);
      expect(s.adapter.dispatched).toHaveLength(1);
      expect(s.record(command.id).status).toBe('unconfirmed');
      expect(s.record(command.id).recovery?.stage).toBe(
        property === 'source' ? 'matched' : 'stopped',
      );
    } finally {
      s.engine.dispose();
    }
  },
);

it('ordinary retry feedback confirms normally and preserves independent Pause safety', async () => {
  const s = setup();
  try {
    const command = await s.issue('playback', 'paused');
    const pause = structuredClone(s.engine.state.intent.holds);
    await s.advance(1_000);
    await s.advance(2_000);
    s.clock.advanceBy(1);
    s.adapter.observe(
      target,
      s.report(0.3, 'paused').values,
      true,
      undefined,
      s.clock.now(),
      s.clock.now(),
    );
    expect(s.record(command.id).status).toBe('confirmed');
    expect(s.engine.state.intent.holds).toEqual(pause);
    await s.advance(60_000);
    expect(s.adapter.dispatched).toHaveLength(2);
  } finally {
    s.engine.dispose();
  }
});

it('rechecks before two non-overlapping retries at 2s and 5s and then stops', async () => {
  const s = setup();
  try {
    const command = await s.issue('volume', 0.4);
    await s.advance(1_000);
    await s.advance(1_999);
    expect(s.adapter.dispatched).toHaveLength(1);
    await s.advance(1);
    expect(s.adapter.dispatched).toHaveLength(2);
    await s.advance(1_000);
    await s.advance(4_999);
    expect(s.adapter.dispatched).toHaveLength(2);
    await s.advance(1);
    expect(s.adapter.dispatched).toHaveLength(3);
    await s.advance(1_000);
    expect(s.record(command.id)).toMatchObject({
      status: 'unconfirmed',
      recovery: {
        stage: 'stopped',
        attemptCount: 3,
        stopReason: 'attempt_limit',
      },
    });
    expect(s.adapter.readStatus).toHaveBeenCalledTimes(5);
    await s.advance(60_000);
    expect(s.adapter.dispatched).toHaveLength(3);
  } finally {
    s.engine.dispose();
  }
});

it('a newer Play vetoes an in-flight old Pause read', async () => {
  const s = setup();
  const read = deferred<MusicObservation>();
  try {
    s.adapter.readStatus.mockReturnValue(read.promise);
    const pause = await s.issue('playback', 'paused');
    await s.advance(1_000);
    await s.issue('playback', 'playing');
    read.resolve(s.report(0.3, 'playing'));
    await flush();
    await s.advance(2_000);
    expect(
      s.adapter.dispatched.filter(
        (command) =>
          command.requested.property === 'playback' &&
          command.requested.value === 'paused',
      ),
    ).toHaveLength(1);
    expect(s.record(pause.id)).toMatchObject({
      recovery: { stage: 'stopped', stopReason: 'superseded' },
    });
  } finally {
    s.engine.dispose();
  }
});

it('does not start recovery when original dispatch acceptance arrives after feedback timeout', async () => {
  const s = setup();
  const accepted = deferred<void>();
  try {
    s.adapter.dispatch = async (command) => {
      s.adapter.dispatched.push(command);
      await accepted.promise;
    };
    const request = s.issue('volume', 0.4);
    await s.advance(1_000);
    accepted.resolve();
    await request;
    await s.advance(60_000);
    expect(s.adapter.readStatus).not.toHaveBeenCalled();
    expect(s.adapter.dispatched).toHaveLength(1);
  } finally {
    s.engine.dispose();
  }
});

it('disposal invalidates deferred verification and releases every recovery timer', async () => {
  const s = setup();
  const read = deferred<MusicObservation>();
  s.adapter.readStatus.mockReturnValue(read.promise);
  await s.issue('volume', 0.4);
  await s.advance(1_000);
  s.engine.dispose();
  read.resolve(s.report());
  await flush();
  await s.advance(60_000);
  expect(s.adapter.dispatched).toHaveLength(1);
  expect(s.clock.pendingTimers()).toBe(0);
});

it('fade steps retain their own feedback lifecycle and never enter generic recovery', async () => {
  const s = setup();
  try {
    s.engine.startMusicFade({ target, volume: 0.32, durationMs: 1_000 }, human);
    await s.advance(1_000);
    await s.advance(1_000);
    await s.advance(60_000);
    expect(s.adapter.dispatched).toHaveLength(1);
    expect(s.adapter.readStatus).not.toHaveBeenCalled();
  } finally {
    s.engine.dispose();
  }
});

it('supersession ordering survives ledger pruning and an old deferred read completion', async () => {
  const s = setup();
  const read = deferred<MusicObservation>();
  try {
    s.adapter.readStatus.mockReturnValue(read.promise);
    const pause = await s.issue('playback', 'paused');
    await s.advance(1_000);
    await s.issue('playback', 'playing');
    // Same timestamp, no retained Pause/Play record left to consult afterward.
    for (let index = 0; index < 130; index++) {
      const volume = index % 2 === 0 ? 0.4 : 0.3;
      await s.issue('volume', volume);
      s.adapter.observe(
        target,
        s.report(volume).values,
        true,
        undefined,
        start - 1,
        start - 1,
      );
    }
    expect(
      s.engine.state.music.commands.some((command) => command.id === pause.id),
    ).toBe(false);
    read.resolve(s.report());
    await flush();
    await s.advance(10_000);
    expect(
      s.adapter.dispatched.filter(
        (command) =>
          command.requested.property === 'playback' &&
          command.requested.value === 'paused',
      ),
    ).toHaveLength(1);
    expect(s.engine.state.intent.holds).toEqual([]);
  } finally {
    s.engine.dispose();
  }
});

it('a human fade supersedes recovery without its verification read interrupting the fade', async () => {
  const s = setup();
  const read = deferred<MusicObservation>();
  try {
    s.adapter.readStatus.mockReturnValue(read.promise);
    await s.issue('volume', 0.4);
    await s.advance(1_000);
    s.engine.startMusicFade({ target, volume: 0.32, durationMs: 1_000 }, human);
    read.resolve(s.report(0.4));
    await flush();
    await s.advance(1_000);
    expect(s.adapter.dispatched).toHaveLength(2);
    expect(s.adapter.dispatched.at(-1)?.requested).toMatchObject({
      property: 'volume',
    });
    expect(s.engine.state.music.fades[target]?.startVolume).toBe(0.3);
    expect(s.engine.state.music.fades[target]?.status).toBe('active');
  } finally {
    s.engine.dispose();
  }
});

it('matching readback cannot consume the next genuine physical observation or clear Pause', async () => {
  const s = setup();
  try {
    await s.issue('playback', 'paused');
    s.adapter.readStatus.mockImplementation(async () =>
      s.report(0.4, 'paused'),
    );
    await s.issue('volume', 0.4);
    await s.advance(1_000);
    const pause = structuredClone(s.engine.state.intent.holds);
    expect(s.engine.getMusicState(target).observed.volume).toBe(0.3);
    s.adapter.observe(
      target,
      s.report(0.45).values,
      true,
      undefined,
      s.clock.now(),
      start - 1,
    );
    expect(
      s.engine.getMusicVolumePolicySnapshots()[target]!.effectiveTarget,
    ).toBe(0.45);
    expect(s.engine.state.intent.holds).toEqual(pause);
  } finally {
    s.engine.dispose();
  }
});

it('an eligible automatic resume yields when the 23:00 quiet-hours gate starts', async () => {
  const s = setup(1_000, Date.parse('2026-10-04T22:59:59+02:00'));
  try {
    await s.engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    await s.engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
    });
    await flush();
    s.adapter.observe(
      target,
      s.report(0.3, 'paused').values,
      true,
      undefined,
      s.clock.now(),
      s.clock.now(),
    );
    await s.engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    await flush();
    const play = s.adapter.dispatched.find(
      (command) =>
        command.requested.property === 'playback' &&
        command.requested.value === 'playing',
    )!;
    await s.advance(1_000);
    await s.advance(10_000);
    expect(s.record(play.id).recovery?.stopReason).toBe('policy_changed');
    expect(
      s.adapter.dispatched.filter((command) => command.id === play.id),
    ).toHaveLength(1);
  } finally {
    s.engine.dispose();
  }
});

it('late automatic retry feedback cannot replace a newer manual baseline after the original attribution window', async () => {
  const s = setup(35_000);
  try {
    await s.engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    await s.engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 2,
    });
    await flush();
    await s.advance(35_000);
    await s.advance(2_000);
    expect(s.adapter.dispatched).toHaveLength(2);
    s.adapter.observe(
      target,
      s.report(0.2).values,
      true,
      undefined,
      s.clock.now(),
      start - 1,
    );
    const manual = await s.issue('volume', 0.6);
    s.adapter.observe(
      target,
      s.report(0.6).values,
      true,
      manual.id,
      s.clock.now(),
      start - 1,
    );
    const intent = s.engine.getMusicIntentSnapshot();
    s.clock.advanceBy(1);
    s.adapter.observe(
      target,
      s.report(0.2).values,
      true,
      undefined,
      s.clock.now(),
      start - 1,
    );
    expect(
      s.engine.getMusicVolumePolicySnapshots()[target]!.effectiveTarget,
    ).toBe(0.6);
    expect(s.engine.getMusicIntentSnapshot()).toEqual(intent);
    expect(s.engine.getMusicState(target).observed.volume).toBe(0.2);
  } finally {
    s.engine.dispose();
  }
});

it('late automatic Pause retry feedback retains attribution before a newer manual Play', async () => {
  const s = setup(10_000);
  try {
    await s.engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
    });
    await s.engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
    });
    await flush();
    const pause = s.adapter.dispatched[0]!;
    await s.advance(10_000);
    await s.advance(2_000);
    await s.advance(10_000);
    await s.advance(5_000);
    await s.advance(10_000);
    expect(s.record(pause.id)).toMatchObject({
      status: 'unconfirmed',
      recovery: { attemptCount: 3, stopReason: 'attempt_limit' },
    });
    await s.advance(1_000);
    await s.issue('playback', 'playing');
    s.clock.advanceBy(1);
    s.adapter.observe(
      target,
      s.report(0.3, 'paused').values,
      true,
      undefined,
      s.clock.now(),
      s.clock.now() - 2,
    );
    expect(s.record(pause.id).status).toBe('confirmed');
    expect(s.engine.state.intent.holds).toEqual([]);
    expect(
      s.adapter.dispatched.filter(
        (command) =>
          command.requested.property === 'playback' &&
          command.requested.value === 'paused',
      ),
    ).toHaveLength(3);
  } finally {
    s.engine.dispose();
  }
});
