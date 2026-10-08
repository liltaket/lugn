import type { Clock, TimerHandle } from '../core/clock.js';
import type {
  MusicAdapter,
  MusicObservation,
} from '../adapters/simulated-music.js';
import type {
  MusicCommandRecord,
  MusicRecoveryStopReason,
} from '../core/schemas.js';

const RECOVERY_WINDOW_MS = 60_000;
const READ_TIMEOUT_MS = 5_000;
const RETRY_DELAYS = [2_000, 5_000] as const;
type Runtime = {
  command: MusicCommandRecord;
  sourceAtIssue?: string;
  valid: () => MusicRecoveryStopReason | null;
  accepted: boolean;
  deadline: number;
  deadlineTimer: TimerHandle;
  timer?: TimerHandle;
  io?: AbortController;
};
type Options = {
  clock: Clock;
  adapter: MusicAdapter;
  feedbackTimeoutMs: number;
  publish: () => void;
  onTimeout: (command: MusicCommandRecord, publish?: boolean) => void;
  onRetry: (
    command: MusicCommandRecord,
    signal: AbortSignal,
    isAllowed: () => boolean,
  ) => Promise<void>;
  onAccepted: (command: MusicCommandRecord) => void;
  validateRead: (
    command: MusicCommandRecord,
    observation: MusicObservation,
  ) => MusicRecoveryStopReason | null;
};

/** Bounded verification and retry lifetime, independent from ordinary observations. */
export class MusicCommandRecovery {
  private readonly active = new Map<string, Runtime>();
  constructor(private readonly options: Options) {}
  start(
    command: MusicCommandRecord,
    valid: Runtime['valid'],
    sourceAtIssue?: string,
  ): void {
    const { clock } = this.options;
    command.recovery = {
      stage: 'awaiting_feedback',
      attemptCount: 1,
      lastAttemptAt: command.issuedAt,
      deadlineAt: clock.now() + RECOVERY_WINDOW_MS,
      nextAttemptAt: null,
      stopReason: null,
    };
    const runtime: Runtime = {
      command,
      ...(sourceAtIssue === undefined ? {} : { sourceAtIssue }),
      valid,
      accepted: false,
      deadline: clock.monotonicNow() + RECOVERY_WINDOW_MS,
      deadlineTimer: clock.setTimeout(
        () => this.stop(command.id, 'deadline'),
        RECOVERY_WINDOW_MS,
      ),
    };
    this.active.set(command.id, runtime);
    this.awaitFeedback(runtime);
  }
  has(id: string): boolean {
    return this.active.has(id);
  }
  accepted(id: string): void {
    const runtime = this.active.get(id);
    if (runtime) runtime.accepted = true;
  }
  stop(id: string, reason: MusicRecoveryStopReason, publish = true): void {
    const runtime = this.active.get(id);
    if (!runtime) return;
    this.active.delete(id);
    this.clearTimer(runtime);
    this.options.clock.clearTimeout(runtime.deadlineTimer);
    runtime.io?.abort();
    const recovery = runtime.command.recovery!;
    recovery.stage = 'stopped';
    recovery.nextAttemptAt = null;
    recovery.stopReason = reason;
    // Once removed from active, an unconfirmed completion must also settle the
    // bounded ledger. Confirmed feedback keeps its caller's batched pruning.
    if (
      runtime.command.status === 'pending' ||
      (runtime.command.status === 'unconfirmed' &&
        reason !== 'feedback_confirmed')
    ) {
      if (['superseded', 'disposed'].includes(reason))
        runtime.command.status = 'superseded';
      this.options.onTimeout(runtime.command, publish);
    }
    if (publish) this.options.publish();
  }
  dispose(): void {
    for (const id of [...this.active.keys()]) this.stop(id, 'disposed');
  }
  private allowed(runtime: Runtime): boolean {
    if (this.active.get(runtime.command.id) !== runtime) return false;
    const reason =
      this.options.clock.monotonicNow() >= runtime.deadline
        ? 'deadline'
        : runtime.valid();
    if (reason) {
      this.stop(runtime.command.id, reason);
      return false;
    }
    return true;
  }
  private clearTimer(runtime: Runtime): void {
    if (runtime.timer !== undefined)
      this.options.clock.clearTimeout(runtime.timer);
    delete runtime.timer;
  }
  private awaitFeedback(runtime: Runtime): void {
    this.clearTimer(runtime);
    runtime.timer = this.options.clock.setTimeout(() => {
      delete runtime.timer;
      if (!this.allowed(runtime)) return;
      this.options.onTimeout(runtime.command);
      if (!runtime.accepted) {
        this.stop(runtime.command.id, 'acceptance_pending');
        return;
      }
      void this.verify(runtime, false);
    }, this.options.feedbackTimeoutMs);
  }
  private async verify(runtime: Runtime, beforeRetry: boolean): Promise<void> {
    if (!this.allowed(runtime)) return;
    const read = this.options.adapter.readStatus;
    if (!read) {
      this.stop(runtime.command.id, 'read_unavailable');
      return;
    }
    const command = runtime.command;
    const recovery = command.recovery!;
    recovery.stage = 'verifying';
    recovery.nextAttemptAt = null;
    runtime.io = new AbortController();
    this.options.publish();
    if (!this.allowed(runtime)) return;
    runtime.timer = this.options.clock.setTimeout(() => {
      delete runtime.timer;
      this.stop(command.id, 'read_timeout');
    }, READ_TIMEOUT_MS);
    let observation: MusicObservation;
    try {
      observation = await read.call(
        this.options.adapter,
        command.target,
        runtime.io.signal,
      );
    } catch {
      if (this.allowed(runtime)) this.stop(command.id, 'read_failed');
      return;
    }
    if (!this.allowed(runtime)) return;
    this.clearTimer(runtime);
    delete runtime.io;
    const invalid = this.options.validateRead(command, observation);
    if (invalid) {
      this.stop(command.id, invalid);
      return;
    }
    recovery.reported = structuredClone(observation.values);
    recovery.verifiedAt = this.options.clock.now();
    if (!observation.available) {
      this.stop(command.id, 'reported_unavailable');
      return;
    }
    // Source selection can leave HA playback/last_changed untouched. Compare
    // against the original request's known source, including on the first read.
    // The GET remains separate from subscription intent and ownership.
    const sourceChanged =
      command.requested.property === 'playback' &&
      runtime.sourceAtIssue !== undefined &&
      observation.values.source !== null &&
      observation.values.source.length > 0 &&
      observation.values.source !== runtime.sourceAtIssue;
    if (sourceChanged) {
      this.stop(command.id, 'newer_report');
      return;
    }
    if (command.requested.property === 'preset') {
      this.stop(command.id, 'non_retryable');
      return;
    }
    const { property, value } = command.requested;
    const actual = observation.values[property];
    if (
      (property === 'volume' && actual === null) ||
      (property === 'playback' && actual === 'unknown')
    ) {
      this.stop(command.id, 'invalid_readback');
      return;
    }
    const matches =
      property === 'volume'
        ? typeof actual === 'number' &&
          Math.abs(actual - Number(value)) <= 0.005 + Number.EPSILON
        : actual === value;
    if (matches) {
      this.stop(command.id, 'non_retryable', false);
      recovery.stage = 'matched';
      recovery.stopReason = null;
      command.diagnosticReason =
        'Fresh Home Assistant read reports requested state; causal attribution unknown';
      this.options.publish();
      return;
    }
    if (property !== 'volume' && property !== 'playback') {
      this.stop(command.id, 'non_retryable');
      return;
    }
    // A different report changed after the original intent may be a physical
    // choice that has not reached the subscription yet. Yield conservatively.
    const changedAt =
      property === 'playback'
        ? observation.playbackChangedAt
        : observation.sourceUpdatedAt;
    if (changedAt !== undefined && changedAt > command.issuedAt) {
      this.stop(command.id, 'newer_report');
      return;
    }
    if (recovery.attemptCount >= 3) {
      this.stop(command.id, 'attempt_limit');
      return;
    }
    if (beforeRetry) {
      await this.retry(runtime);
      return;
    }
    const delay = RETRY_DELAYS[recovery.attemptCount - 1]!;
    recovery.stage = 'waiting_retry';
    recovery.nextAttemptAt = this.options.clock.now() + delay;
    runtime.timer = this.options.clock.setTimeout(() => {
      delete runtime.timer;
      if (this.allowed(runtime)) void this.verify(runtime, true);
    }, delay);
    this.options.publish();
  }
  private async retry(runtime: Runtime): Promise<void> {
    if (!this.allowed(runtime)) return;
    const command = runtime.command;
    const recovery = command.recovery!;
    recovery.attemptCount++;
    recovery.lastAttemptAt = this.options.clock.now();
    recovery.stage = 'retrying';
    recovery.nextAttemptAt = null;
    runtime.accepted = false;
    runtime.io = new AbortController();
    this.awaitFeedback(runtime);
    try {
      // onRetry rechecks authority synchronously before adapter dispatch.
      await this.options.onRetry(command, runtime.io.signal, () =>
        this.allowed(runtime),
      );
      if (!this.allowed(runtime)) return;
      runtime.accepted = true;
      command.acceptedAt = this.options.clock.now();
      recovery.stage = 'awaiting_feedback';
      delete runtime.io;
      this.options.onAccepted(command);
      this.options.publish();
    } catch {
      if (this.allowed(runtime)) this.stop(command.id, 'dispatch_failed');
    }
  }
}
