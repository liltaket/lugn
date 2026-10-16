import { afterEach, expect, it, vi } from 'vitest';
import type {
  ComputerPlaybackAck,
  ComputerPlaybackCommand,
  ComputerPlaybackControlSnapshot,
  ComputerPlaybackPlayer,
} from '../src/adapters/computer-playback-mqtt.js';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import { ComputerPlaybackController } from '../src/application/computer-playback-controller.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import { unknownComputerReadings } from '../src/core/computer.js';

const target = 'music.room';
const uuid = (number: number) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const spotify = 'org.mpris.MediaPlayer2.spotify';
const firefox = 'org.mpris.MediaPlayer2.firefox';
const automation = {
  actor: { type: 'automation' as const, id: 'lugn.music' },
  source: 'presence_music_automation',
};
const pause = { property: 'playback' as const, value: 'paused' as const };
const resume = { property: 'playback' as const, value: 'playing' as const };
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function setup() {
  const clock = new FakeClock(Date.parse('2026-10-17T12:00:00+02:00'));
  const musicAdapter = new SimulatedMusicAdapter(clock);
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    music: {
      targets: { [target]: ['Optical In', 'Spotify'] },
      adapter: musicAdapter,
    },
  });
  musicAdapter.observe(target, {
    playback: 'playing',
    source: 'Optical In',
    volume: 0.3,
    title: '4',
  });
  engine.acceptComputerObservation({
    deviceId: 'kuffe',
    availability: 'online',
    freshness: 'fresh',
    reason: 'live',
    observedAt: clock.now(),
    receivedAt: clock.now(),
    sessionId: uuid(1),
    sequence: 1,
    observed: {
      ...unknownComputerReadings(),
      activeApplication: { id: 'spotify', resourceClass: 'spotify' },
      media: [firefox, spotify].map((name) => ({
        player: name,
        identity: name === spotify ? 'Spotify' : 'Firefox',
        desktopEntry: name === spotify ? 'spotify' : 'firefox',
        playback: 'playing',
        title: name === spotify ? 'Selected song' : 'Background video',
        artists: null,
        album: null,
        contentType: null,
      })),
    },
    activity: {
      classification: 'desktop',
      source: 'desktop-agent',
      basis: 'active_application',
    },
    lastEvent: null,
  });
  const players: ComputerPlaybackPlayer[] = [firefox, spotify].map(
    (name, index) => ({
      player: name,
      player_instance_id: uuid(10 + index),
      content_id: uuid(20 + index),
      playback_status: 'Playing',
      can_pause: true,
      can_play: true,
      pause_lease: null,
    }),
  );
  const live: ComputerPlaybackControlSnapshot = {
    fresh: true,
    receivedAtMs: clock.now(),
    state: {
      schema_version: 1,
      device_id: 'kuffe',
      session_id: uuid(1),
      connection_id: uuid(2),
      sequence: 1,
      timestamp_ms: clock.now(),
      heartbeat_interval_ms: 30_000,
      players,
    },
  };
  const refs = {
    snapshot: live as ComputerPlaybackControlSnapshot | undefined,
    trusted: true,
    resumeAllowed: true,
    pauseAllowed: true,
  };
  let nextCommand = 100;
  function ack(command: ComputerPlaybackCommand): ComputerPlaybackAck {
    return {
      schema_version: 1,
      device_id: command.device_id,
      session_id: command.session_id,
      connection_id: command.connection_id,
      command_id: command.command_id,
      action: command.action,
      player: command.player,
      player_instance_id: command.player_instance_id,
      content_id: command.content_id,
      timestamp_ms: clock.now(),
      outcome: 'applied',
      reason: command.action === 'pause' ? 'paused' : 'resumed',
      resume_token: command.action === 'pause' ? uuid(90) : null,
      lease_expires_at_ms:
        command.action === 'pause' ? clock.now() + 20 * 60_000 : null,
    };
  }
  function apply(command: ComputerPlaybackCommand) {
    const player = players.find((player) => player.player === command.player)!;
    player.playback_status = command.action === 'pause' ? 'Paused' : 'Playing';
    const applied = ack(command);
    player.pause_lease =
      command.action === 'pause'
        ? {
            pause_command_id: command.command_id,
            resume_token: applied.resume_token!,
            expires_at_ms: applied.lease_expires_at_ms!,
          }
        : null;
    const media = engine.state.computer.devices['kuffe']!.observed.media!;
    media.find((player) => player.player === command.player)!.playback =
      command.action === 'pause' ? 'paused' : 'playing';
    live.state.sequence++;
    live.state.timestamp_ms = clock.now();
    return applied;
  }
  const sendCommand = vi.fn(
    async (command: ComputerPlaybackCommand): Promise<ComputerPlaybackAck> =>
      apply(command),
  );
  const controller = new ComputerPlaybackController({
    routes: { [target]: { deviceId: 'kuffe', source: 'Optical In' } },
    clock,
    getState: () => engine.state,
    observationTrusted: () => refs.trusted,
    automaticResumeAllowed: () => refs.resumeAllowed,
    automaticPauseAllowed: () => refs.pauseAllowed,
    adapterForDevice: (deviceId) =>
      deviceId === 'kuffe'
        ? {
            getSnapshot: () => refs.snapshot && structuredClone(refs.snapshot),
            sendCommand,
          }
        : undefined,
    uuid: () => uuid(nextCommand++),
  });
  cleanup.push(() => {
    controller.dispose();
    engine.dispose();
  });
  controller.observe();
  return {
    clock,
    engine,
    controller,
    players,
    live,
    refs,
    sendCommand,
    ack,
    apply,
    player: players[1]!,
  };
}

it('pauses the exact selected desktop player and resumes with only its owned lease, without mutating HA state', async () => {
  const s = setup();
  const receiver = structuredClone(s.engine.state.music);
  const paused = await s.controller.request(target, pause, automation);
  const pauseCommand = s.sendCommand.mock.calls[0]![0];
  expect(paused.status).toBe('confirmed');
  expect(pauseCommand).toMatchObject({
    player: spotify,
    player_instance_id: uuid(11),
    content_id: uuid(21),
    action: 'pause',
    session_id: uuid(1),
    connection_id: uuid(2),
    pause_command_id: null,
    resume_token: null,
    lease_ttl_ms: 20 * 60_000,
  });
  expect(s.controller.getPlayback(target)).toBe('paused');
  expect(s.controller.canResume(target)).toBe(true);
  const resumed = await s.controller.request(target, resume, automation);
  expect(resumed.status).toBe('confirmed');
  expect(s.sendCommand.mock.calls[1]![0]).toMatchObject({
    action: 'resume',
    player: spotify,
    player_instance_id: pauseCommand.player_instance_id,
    content_id: pauseCommand.content_id,
    pause_command_id: pauseCommand.command_id,
    resume_token: uuid(90),
    lease_ttl_ms: null,
  });
  expect(s.controller.canResume(target)).toBe(false);
  await expect(
    s.controller.request(target, resume, automation),
  ).rejects.toThrow();
  expect(s.sendCommand).toHaveBeenCalledTimes(2);
  expect(s.engine.state.music).toEqual(receiver);
});

it.each([
  'unknown',
  'offline',
  'stale_computer',
  'missing_control',
  'stale_control',
  'untrusted_receiver',
  'unavailable_receiver',
  'source_changed',
  'old_session',
  'new_session',
  'new_connection',
  'player_missing',
  'player_instance_changed',
  'content_changed',
  'stopped',
  'externally_playing',
  'revoked_lease',
  'different_pause_owner',
  'different_token',
  'expired_lease',
  'expired_ownership',
] as const)('cannot resume after %s', async (change) => {
  const s = setup();
  await s.controller.request(target, pause, automation);
  expect(s.controller.canResume(target)).toBe(true);
  const computer = s.engine.state.computer.devices['kuffe']!;
  const device = s.engine.state.music.devices[target]!;
  switch (change) {
    case 'unknown':
      computer.availability = 'unknown';
      break;
    case 'offline':
      computer.availability = 'offline';
      break;
    case 'stale_computer':
      computer.freshness = 'stale';
      break;
    case 'missing_control':
      s.refs.snapshot = undefined;
      break;
    case 'stale_control':
      s.live.fresh = false;
      break;
    case 'untrusted_receiver':
      s.refs.trusted = false;
      break;
    case 'unavailable_receiver':
      device.availability = 'unavailable';
      break;
    case 'source_changed':
      device.observed.source = 'Spotify';
      break;
    case 'old_session':
      s.live.state.session_id = uuid(3);
      break;
    case 'new_session':
      s.live.state.session_id = computer.sessionId = uuid(3);
      break;
    case 'new_connection':
      s.live.state.connection_id = uuid(3);
      break;
    case 'player_missing':
      s.live.state.players = [s.players[0]!];
      break;
    case 'player_instance_changed':
      s.player.player_instance_id = uuid(3);
      break;
    case 'content_changed':
      s.player.content_id = uuid(3);
      break;
    case 'stopped':
      s.player.playback_status = 'Stopped';
      break;
    case 'externally_playing':
      s.player.playback_status = 'Playing';
      break;
    case 'revoked_lease':
      s.player.pause_lease = null;
      break;
    case 'different_pause_owner':
      s.player.pause_lease!.pause_command_id = uuid(3);
      break;
    case 'different_token':
      s.player.pause_lease!.resume_token = uuid(3);
      break;
    case 'expired_lease':
      s.player.pause_lease!.expires_at_ms = s.clock.now();
      break;
    case 'expired_ownership':
      s.clock.advanceBy(20 * 60_000);
      break;
  }
  s.controller.observe();
  expect(s.controller.canResume(target)).toBe(false);
  const rejected = expect(
    s.controller.request(target, resume, automation),
  ).rejects.toThrow();
  await flush();
  s.clock.advanceBy(2_000);
  await rejected;
  expect(s.sendCommand).toHaveBeenCalledTimes(1);
});

it.each(['already_paused', 'ambiguous', 'no_content', 'not_capable'] as const)(
  'does not create ownership when initial media is %s',
  async (condition) => {
    const s = setup();
    if (condition === 'already_paused') {
      s.player.playback_status = 'Paused';
      s.engine.state.computer.devices['kuffe']!.observed.media!.forEach(
        (player) => {
          player.playback = 'paused';
        },
      );
    }
    if (condition === 'ambiguous') {
      s.engine.state.computer.devices['kuffe']!.observed.activeApplication =
        null;
      // Clear presentation history so a prior unique focus cannot provide a stable winner.
      s.engine.state.computer.devices['kuffe']!.sessionId = uuid(4);
      s.live.state.session_id = uuid(4);
    }
    if (condition === 'no_content') s.player.content_id = null;
    if (condition === 'not_capable') s.player.can_pause = false;
    s.controller.observe();
    await expect(
      s.controller.request(target, pause, automation),
    ).rejects.toThrow();
    expect(s.controller.canResume(target)).toBe(false);
    expect(s.sendCommand).not.toHaveBeenCalled();
  },
);

it.each(['rejected', 'uncertain', 'timeout'] as const)(
  'never owns a pause after a %s result',
  async (outcome) => {
    const s = setup();
    s.sendCommand.mockImplementationOnce((command) => {
      if (outcome === 'timeout')
        return new Promise((_, reject) => {
          s.clock.setTimeout(
            () => reject(new Error('Acknowledgement timed out')),
            10_000,
          );
        });
      return Promise.resolve({
        ...s.ack(command),
        outcome,
        reason: 'unconfirmed',
        resume_token: null,
        lease_expires_at_ms: null,
      });
    });
    const pending = s.controller.request(target, pause, automation);
    if (outcome === 'timeout') s.clock.advanceBy(10_000);
    const result = await pending;
    expect(result.status).toBe('failed');
    expect(s.controller.canResume(target)).toBe(false);
    await expect(
      s.controller.request(target, resume, automation),
    ).rejects.toThrow();
    expect(s.sendCommand).toHaveBeenCalledTimes(1);
  },
);

it('waits for the exact pending pause before a rapid return resumes it', async () => {
  const s = setup();
  let finishPause: ((ack: ComputerPlaybackAck) => void) | undefined;
  s.sendCommand.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishPause = resolve;
      }),
  );
  const pendingPause = s.controller.request(target, pause, automation);
  expect(s.controller.canResume(target)).toBe(true);
  const pendingResume = s.controller.request(target, resume, automation);
  await flush();
  expect(s.sendCommand).toHaveBeenCalledTimes(1);
  finishPause!(s.apply(s.sendCommand.mock.calls[0]![0]));
  await pendingPause;
  await flush();
  s.controller.observe();
  s.clock.advanceBy(100);
  await flush();
  expect((await pendingResume).status).toBe('confirmed');
  expect(s.sendCommand).toHaveBeenCalledTimes(2);
});

it('discards owned pause permission on explicit invalidation and disposal', async () => {
  const s = setup();
  await s.controller.request(target, pause, automation);
  s.controller.invalidate(target);
  expect(s.controller.canResume(target)).toBe(false);
  await expect(
    s.controller.request(target, resume, automation),
  ).rejects.toThrow();
  expect(s.sendCommand).toHaveBeenCalledTimes(1);
  s.controller.dispose();
  expect(s.controller.getPlayback(target)).toBe('unknown');
});

it('allows a rapid return after pause acknowledgement while waiting for its exact control lease snapshot', async () => {
  const s = setup();
  s.sendCommand.mockImplementationOnce(async (command) => s.ack(command));
  await s.controller.request(target, pause, automation);
  // The agent acknowledged pause, but control telemetry is still the baseline Playing snapshot.
  expect(s.controller.canResume(target)).toBe(true);
  const result = s.controller.request(target, resume, automation).then(
    (record) => record,
    (error: unknown) => error,
  );
  await flush();
  expect(s.sendCommand).toHaveBeenCalledTimes(1);
  s.apply(s.sendCommand.mock.calls[0]![0]);
  s.controller.observe();
  await flush();
  expect(await result).toMatchObject({ status: 'confirmed' });
  expect(s.sendCommand).toHaveBeenCalledTimes(2);
});

it('bounds the rapid-return control-state wait and never sends resume without the exact lease', async () => {
  const s = setup();
  let finishPause: ((ack: ComputerPlaybackAck) => void) | undefined;
  s.sendCommand.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishPause = resolve;
      }),
  );
  const pendingPause = s.controller.request(target, pause, automation);
  const result = s.controller.request(target, resume, automation).then(
    (record) => record,
    (error: unknown) => error,
  );
  finishPause!(s.ack(s.sendCommand.mock.calls[0]![0]));
  await pendingPause;
  await flush();
  s.clock.advanceBy(1_999);
  await flush();
  expect(s.sendCommand).toHaveBeenCalledTimes(1);
  s.clock.advanceBy(1);
  await flush();
  expect(await result).toBeInstanceOf(Error);
  expect(s.sendCommand).toHaveBeenCalledTimes(1);
  expect(s.clock.pendingTimers()).toBe(0);
});

it.each(['invalidated', 'unavailable', 'policy_blocked'] as const)(
  'does not resume after pending pause delivery becomes %s',
  async (change) => {
    const s = setup();
    let finishPause: ((ack: ComputerPlaybackAck) => void) | undefined;
    s.sendCommand.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPause = resolve;
        }),
    );
    const pendingPause = s.controller.request(target, pause, automation);
    const result = s.controller.request(target, resume, automation).then(
      (record) => record,
      (error: unknown) => error,
    );
    if (change === 'invalidated') s.controller.invalidate(target);
    if (change === 'unavailable') {
      s.refs.snapshot = undefined;
      s.controller.observe();
    }
    if (change === 'policy_blocked') s.refs.resumeAllowed = false;
    finishPause!(s.apply(s.sendCommand.mock.calls[0]![0]));
    await pendingPause;
    await flush();
    expect(await result).toBeInstanceOf(Error);
    expect(s.sendCommand).toHaveBeenCalledTimes(1);
    if (change !== 'policy_blocked')
      expect(s.controller.canResume(target)).toBe(false);
  },
);

it('serializes an opposite Pause behind an in-flight Resume and targets the exact resumed player despite lagging v1 media', async () => {
  const s = setup();
  await s.controller.request(target, pause, automation);
  let finishResume: ((ack: ComputerPlaybackAck) => void) | undefined;
  s.sendCommand.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishResume = resolve;
      }),
  );
  const pendingResume = s.controller.request(target, resume, automation);
  expect(s.controller.getPlayback(target)).toBe('playing');
  const pendingPause = s.controller.request(target, pause, automation);
  await flush();
  expect(s.sendCommand).toHaveBeenCalledTimes(2);
  finishResume!(s.ack(s.sendCommand.mock.calls[1]![0]));
  await pendingResume;
  await flush();
  // A resume acknowledgement alone does not authorize the opposite Pause.
  expect(s.sendCommand).toHaveBeenCalledTimes(2);
  s.apply(s.sendCommand.mock.calls[1]![0]);
  s.engine.state.computer.devices['kuffe']!.observed.media!.find(
    (player) => player.player === spotify,
  )!.playback = 'paused';
  s.controller.observe();
  const result = await pendingPause;
  expect(result.requested).toEqual(pause);
  expect(result.status).toBe('confirmed');
  expect(s.sendCommand).toHaveBeenCalledTimes(3);
  expect(s.sendCommand.mock.calls[2]![0]).toMatchObject({
    action: 'pause',
    player: spotify,
    player_instance_id: uuid(11),
    content_id: uuid(21),
  });
  expect(s.controller.canResume(target)).toBe(true);
});

it.each(['policy_cancelled', 'newer_human_play', 'newer_pause'] as const)(
  'supersedes queued reverse Pause when %s while Resume is in flight',
  async (change) => {
    const s = setup();
    await s.controller.request(target, pause, automation);
    let finishResume: ((ack: ComputerPlaybackAck) => void) | undefined;
    s.sendCommand.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishResume = resolve;
        }),
    );
    const pendingResume = s.controller.request(target, resume, automation);
    const oldPause = s.controller
      .request(target, pause, automation)
      .catch((error: unknown) => error);
    let newest: Promise<unknown> | undefined;
    if (change === 'policy_cancelled') s.refs.pauseAllowed = false;
    if (change === 'newer_human_play')
      newest = s.controller
        .request(target, resume, { actor: { type: 'user' }, source: 'nest' })
        .catch((error: unknown) => error);
    if (change === 'newer_pause')
      newest = s.controller.request(target, pause, automation);
    finishResume!(s.apply(s.sendCommand.mock.calls[1]![0]));
    await pendingResume;
    await flush();
    expect(await oldPause).toBeInstanceOf(Error);
    if (newest) await newest;
    expect(s.sendCommand).toHaveBeenCalledTimes(
      change === 'newer_pause' ? 3 : 2,
    );
    expect(
      s.sendCommand.mock.calls.filter(
        ([command]) => command.action === 'resume',
      ),
    ).toHaveLength(1);
  },
);

it.each([false, true])(
  'after uncertain Resume, a new Pause requires fresh actual Playing (reported=%s)',
  async (reported) => {
    const s = setup();
    await s.controller.request(target, pause, automation);
    let finishResume: ((ack: ComputerPlaybackAck) => void) | undefined;
    s.sendCommand.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishResume = resolve;
        }),
    );
    const pendingResume = s.controller.request(target, resume, automation);
    const pendingPause = s.controller.request(target, pause, automation).then(
      (record) => record,
      (error: unknown) => error,
    );
    const resumeCommand = s.sendCommand.mock.calls[1]![0];
    if (reported) s.apply(resumeCommand);
    finishResume!({
      ...s.ack(resumeCommand),
      outcome: 'uncertain',
      reason: 'unconfirmed',
    });
    expect((await pendingResume).status).toBe('failed');
    await flush();
    if (!reported) s.clock.advanceBy(2_000);
    await flush();
    if (reported)
      expect(await pendingPause).toMatchObject({
        requested: pause,
        status: 'confirmed',
      });
    else expect(await pendingPause).toBeInstanceOf(Error);
    expect(s.sendCommand).toHaveBeenCalledTimes(reported ? 3 : 2);
    expect(
      s.sendCommand.mock.calls.filter(
        ([command]) => command.action === 'resume',
      ),
    ).toHaveLength(1);
  },
);

it('coalesces duplicate in-flight Pauses while cancelling an older queued automatic Resume', async () => {
  const s = setup();
  let finishPause: ((ack: ComputerPlaybackAck) => void) | undefined;
  s.sendCommand.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishPause = resolve;
      }),
  );
  const firstPause = s.controller.request(target, pause, automation);
  expect(s.controller.state[target]!.pending).toBe(true);
  const oldResume = s.controller
    .request(target, resume, automation)
    .catch((error: unknown) => error);
  const humanPause = s.controller.request(target, pause, {
    actor: { type: 'user' },
    source: 'nest',
  });
  finishPause!(s.apply(s.sendCommand.mock.calls[0]![0]));
  expect((await firstPause).requested).toEqual(pause);
  expect((await humanPause).requested).toEqual(pause);
  expect(await oldResume).toBeInstanceOf(Error);
  expect(s.sendCommand).toHaveBeenCalledTimes(1);
  expect(s.controller.state[target]!.pending).toBe(false);
});

it('retains only a bounded first-lease phase across out-of-order pre-pause Playing snapshots after the acknowledgement', async () => {
  const s = setup();
  s.sendCommand.mockImplementationOnce(async (command) => s.ack(command));
  await s.controller.request(target, pause, automation);
  s.live.state.sequence += 2;
  s.controller.observe();
  expect(s.controller.canResume(target)).toBe(true);
  s.clock.advanceBy(1_999);
  expect(s.controller.canResume(target)).toBe(true);
  s.clock.advanceBy(1);
  expect(s.controller.canResume(target)).toBe(false);
  await expect(
    s.controller.request(target, resume, automation),
  ).rejects.toThrow();
  expect(s.sendCommand).toHaveBeenCalledTimes(1);
});

it('unknown receiver source blocks HA fallback but cannot authorize a desktop command', async () => {
  const s = setup();
  s.engine.state.music.devices[target]!.observed.source = null;
  s.engine.state.music.devices[target]!.availability = 'unavailable';
  s.controller.observe();
  expect(s.controller.handles(target)).toBe(true);
  expect(s.controller.getPlayback(target)).toBe('unknown');
  await expect(
    s.controller.request(target, pause, automation),
  ).rejects.toThrow();
  await expect(
    s.controller.request(target, resume, automation),
  ).rejects.toThrow();
  expect(s.sendCommand).not.toHaveBeenCalled();
});

it('waits for a lease after intermediate Paused/no-lease telemetry and an applied pause ACK', async () => {
  const s = setup();
  s.sendCommand.mockImplementationOnce(async (command) => {
    s.player.playback_status = 'Paused';
    s.live.state.sequence++;
    return s.ack(command);
  });
  await s.controller.request(target, pause, automation);
  s.controller.observe();
  expect(s.controller.canResume(target)).toBe(true);
  const pendingResume = s.controller.request(target, resume, automation);
  await flush();
  expect(s.sendCommand).toHaveBeenCalledTimes(1);
  s.apply(s.sendCommand.mock.calls[0]![0]);
  s.controller.observe();
  expect((await pendingResume).status).toBe('confirmed');
  expect(s.sendCommand).toHaveBeenCalledTimes(2);
});

it.each(['Stopped', null] as const)(
  'rejects %s before the first lease without extending the ownership phase',
  async (playback) => {
    const s = setup();
    s.sendCommand.mockImplementationOnce(async (command) => s.ack(command));
    await s.controller.request(target, pause, automation);
    s.player.playback_status = playback;
    s.live.state.sequence++;
    s.controller.observe();
    expect(s.controller.canResume(target)).toBe(false);
    await expect(
      s.controller.request(target, resume, automation),
    ).rejects.toThrow();
    expect(s.sendCommand).toHaveBeenCalledTimes(1);
  },
);

it('expires the first-lease phase on monotonic elapsed time even when the wall clock moves backward', async () => {
  const s = setup();
  s.sendCommand.mockImplementationOnce(async (command) => s.ack(command));
  await s.controller.request(target, pause, automation);
  const backwards = s.clock.now() - 60_000;
  s.clock.now = () => backwards;
  s.clock.advanceBy(2_000);
  expect(s.controller.canResume(target)).toBe(false);
  expect(s.sendCommand).toHaveBeenCalledTimes(1);
  expect(s.clock.pendingTimers()).toBe(0);
});

it('keeps only the latest exit intent through exit-return-exit while Resume is in flight', async () => {
  const s = setup();
  await s.controller.request(target, pause, automation);
  let finishResume: ((ack: ComputerPlaybackAck) => void) | undefined;
  s.sendCommand.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishResume = resolve;
      }),
  );
  const initialResume = s.controller.request(target, resume, automation);
  const firstExit = s.controller
    .request(target, pause, automation)
    .catch((error: unknown) => error);
  const returnAgain = s.controller
    .request(target, resume, automation)
    .catch((error: unknown) => error);
  const finalExit = s.controller.request(target, pause, automation);
  finishResume!(s.apply(s.sendCommand.mock.calls[1]![0]));
  await initialResume;
  expect(await firstExit).toBeInstanceOf(Error);
  expect(await returnAgain).toBeInstanceOf(Error);
  expect((await finalExit).requested).toEqual(pause);
  expect(s.sendCommand.mock.calls.map(([command]) => command.action)).toEqual([
    'pause',
    'resume',
    'pause',
  ]);
});
