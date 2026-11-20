import type { Clock, TimerHandle } from '../core/clock.js';
import type {
  DisplayPowerEvidence,
  DisplayPowerInhibitReason,
  DisplayPowerSnapshot,
} from '../core/display-power.js';
import type { RoomState } from '../core/schemas.js';
import type { ComputerDisplayTransport } from '../adapters/computer-display-mqtt.js';

export type DisplayPowerPolicy = {
  /** Confirmed-empty time before the first sleep request. */
  offAfterEmptyMs: number;
  /** While the room stays empty the sleep request is repeated this often. */
  reassertOffMs: number;
  /** Wake the display when someone is confirmed back after Lugn put it to sleep. */
  wakeOnEntry: boolean;
  /** Automatic wake is skipped from 23:00 to 06:00 unless this is set. */
  wakeInQuietHours: boolean;
  /** Hold sleep while the computer reports recent input or a game/video. */
  inhibitOnActivity: boolean;
  /** Activity can postpone sleep for at most this long after the room emptied. */
  activeInhibitMaxMs: number;
};

export const defaultDisplayPowerPolicy: DisplayPowerPolicy = {
  offAfterEmptyMs: 120_000,
  reassertOffMs: 900_000,
  wakeOnEntry: true,
  wakeInQuietHours: false,
  inhibitOnActivity: true,
  activeInhibitMaxMs: 1_800_000,
};

/** Evidence-driven timing. Without evidence only `reassertOffMs` applies. */
const EVIDENCE_OFF_GRACE_MS = 60_000;
/** Evidence flips are debounced by the sensor; look only after they could land. */
const EVIDENCE_SETTLE_MARGIN_MS = 15_000;
const EVIDENCE_ON_REASSERT_MIN_MS = 120_000;
const EVIDENCE_STANDBY_BACKSTOP_MS = 6 * 60 * 60_000;
const WAKE_RETRY_MS = 15_000;
const WAKE_VERIFY_MS = 20_000;
const WAKE_MAX_ATTEMPTS = 3;
const FAILURE_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
const MAX_TIMER_MS = 2 ** 31 - 1;

type Options = {
  deviceId: string;
  clock: Clock;
  policy: DisplayPowerPolicy;
  getState: () => RoomState | undefined;
  transport: ComputerDisplayTransport;
  evidence?: () => DisplayPowerEvidence;
  isQuietHours: () => boolean;
  /** How long the evidence source debounces a change; verification waits for it. */
  evidenceSettleMs?: number;
  publish: (snapshot: DisplayPowerSnapshot) => void;
};

/**
 * Presence-driven display sleep and wake for one computer.
 *
 * The monitor gives no feedback, so the policy works from intent: once the
 * room is confirmed empty (and the computer is not visibly in use) it requests
 * sleep, and it repeats that request at a low rate because a sleeping display
 * can be woken again by anything. Wake is sent once per confirmed return and
 * only for a sleep Lugn itself requested; it is never repeated to "make sure",
 * and tracking loss (`unknown` presence) triggers neither. An optional power
 * sensor, when present, only shortens or lengthens those repeats and verifies a
 * wake; it never starts one.
 */
export class DisplayPowerController {
  private emptySince: number | null = null;
  private epoch = 0;
  /** A sleep request applied (or possibly applied) in this empty period. */
  private offRequested = false;
  private offAppliedAt: number | null = null;
  private lastOffAttemptAt = 0;
  private wakeNeeded = false;
  private wakeAttempts = 0;
  private lastWakeAttemptAt = 0;
  private wakeVerifyAt: number | null = null;
  private failures = 0;
  private lastFailureAt = 0;
  private lastRequest: DisplayPowerSnapshot['lastRequest'] = null;
  private sending = false;
  private evaluating = false;
  private again = false;
  private disposed = false;
  private timer: TimerHandle | undefined;
  private published: string | undefined;

  constructor(private readonly options: Options) {}

  /** Re-evaluate after any input changed: presence, computer, transport, evidence. */
  observe(): void {
    if (this.disposed) return;
    if (this.evaluating) {
      this.again = true;
      return;
    }
    this.evaluating = true;
    try {
      do {
        this.again = false;
        this.evaluate();
      } while (this.again && !this.disposed);
    } finally {
      this.evaluating = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private evaluate(): void {
    const state = this.options.getState();
    if (!state) return;
    const { clock, policy } = this.options;
    const now = clock.now();
    const evidence = this.options.evidence?.() ?? null;
    const away = state.presence.home.state === 'away';
    const empty = state.presence.state === 'confirmed_empty' || away;
    const occupied = state.presence.state === 'occupied' && !away;

    if (empty) {
      this.emptySince ??= now;
      this.wakeNeeded = false;
      this.wakeVerifyAt = null;
    } else if (occupied && this.emptySince !== null) {
      // Back in the room. Only a sleep Lugn itself requested earns a wake.
      if (this.offRequested && policy.wakeOnEntry) {
        this.wakeNeeded = true;
        this.wakeAttempts = 0;
      }
      this.leaveEmpty();
    }

    const ready = this.ready(state);
    const inhibited =
      empty && this.emptySince !== null
        ? this.inhibitReason(state, now, this.emptySince)
        : null;
    let dueAt: number | null = null;
    let action: 'off' | 'on' | null = null;

    if (this.wakeVerifyAt !== null && occupied) {
      if (now >= this.wakeVerifyAt) {
        this.wakeVerifyAt = null;
        if (evidence?.state === 'standby') this.wakeNeeded = true;
      } else dueAt = this.wakeVerifyAt;
    }
    if (this.wakeNeeded && occupied) {
      if (
        !policy.wakeOnEntry ||
        this.wakeAttempts >= WAKE_MAX_ATTEMPTS ||
        // The display is already drawing power: nothing to wake.
        evidence?.state === 'on' ||
        (!policy.wakeInQuietHours && this.options.isQuietHours())
      )
        this.wakeNeeded = false;
      else {
        const due = this.afterBackoff(
          Math.max(now, this.lastWakeAttemptAt + WAKE_RETRY_MS),
        );
        dueAt = minDue(dueAt, due);
        if (due <= now) action = 'on';
      }
    } else if (empty && this.emptySince !== null) {
      if (inhibited) {
        // Re-evaluate when the inhibit window ends; input changes arrive as
        // computer observations.
        dueAt = minDue(dueAt, this.emptySince + policy.activeInhibitMaxMs);
      } else if (this.offAppliedAt === null && evidence?.state === 'standby') {
        // Already dark by the plug's account. A change in evidence re-evaluates.
      } else {
        const due = this.afterBackoff(this.offDue(this.emptySince, evidence));
        dueAt = minDue(dueAt, due);
        if (due <= now) action = 'off';
      }
    }

    if (action && ready && !this.sending) void this.send(action);
    // A due request that cannot be sent waits for the transport, not a timer.
    const armAt = this.sending || (action && !ready) ? null : dueAt;
    this.rearm(armAt, now);
    this.emit(empty ? 'off' : occupied ? 'on' : null, inhibited, ready, armAt);
  }

  private offDue(
    emptySince: number,
    evidence: DisplayPowerEvidence | null,
  ): number {
    const { policy } = this.options;
    if (this.offAppliedAt === null) return emptySince + policy.offAfterEmptyMs;
    if (evidence?.state === 'on')
      // Still drawing power after a sleep request: try again soon, but never in
      // a tight loop.
      return Math.max(
        this.offAppliedAt + this.offGraceMs(),
        this.lastOffAttemptAt + EVIDENCE_ON_REASSERT_MIN_MS,
      );
    if (evidence?.state === 'standby')
      return (
        this.offAppliedAt +
        Math.max(policy.reassertOffMs, EVIDENCE_STANDBY_BACKSTOP_MS)
      );
    return this.offAppliedAt + policy.reassertOffMs;
  }

  private wakeVerifyMs(): number {
    return Math.max(
      WAKE_VERIFY_MS,
      (this.options.evidenceSettleMs ?? 0) + EVIDENCE_SETTLE_MARGIN_MS,
    );
  }

  private offGraceMs(): number {
    return Math.max(
      EVIDENCE_OFF_GRACE_MS,
      (this.options.evidenceSettleMs ?? 0) + 2 * EVIDENCE_SETTLE_MARGIN_MS,
    );
  }

  private afterBackoff(due: number): number {
    if (this.failures === 0) return due;
    const wait =
      FAILURE_BACKOFF_MS[
        Math.min(this.failures, FAILURE_BACKOFF_MS.length) - 1
      ]!;
    return Math.max(due, this.lastFailureAt + wait);
  }

  private inhibitReason(
    state: RoomState,
    now: number,
    emptySince: number,
  ): DisplayPowerInhibitReason | null {
    const { policy } = this.options;
    if (!policy.inhibitOnActivity) return null;
    if (now - emptySince >= policy.activeInhibitMaxMs) return null;
    const computer = state.computer.devices[this.options.deviceId];
    if (
      !computer ||
      computer.availability !== 'online' ||
      computer.freshness !== 'fresh'
    )
      return null;
    if (computer.observed.idle === false) return 'recent_activity';
    if (['gaming', 'video'].includes(computer.activity.classification))
      return 'video_or_game';
    return null;
  }

  /** Requests need a live, matching computer observation and display transport. */
  private ready(state: RoomState): boolean {
    const snapshot = this.options.transport.getSnapshot();
    const computer = state.computer.devices[this.options.deviceId];
    return (
      !!snapshot?.fresh &&
      snapshot.state.backend !== null &&
      !!computer &&
      computer.availability === 'online' &&
      computer.freshness === 'fresh' &&
      computer.sessionId === snapshot.state.session_id
    );
  }

  private async send(action: 'off' | 'on'): Promise<void> {
    this.sending = true;
    const epoch = this.epoch;
    let outcome: 'applied' | 'rejected' | 'uncertain' | 'failed' = 'failed';
    try {
      outcome = (await this.options.transport.sendCommand(action)).outcome;
    } catch {
      outcome = 'failed';
    }
    this.sending = false;
    if (this.disposed) return;
    const now = this.options.clock.now();
    this.lastRequest = { action, outcome, at: now };
    if (action === 'off') this.lastOffAttemptAt = now;
    else {
      this.lastWakeAttemptAt = now;
      this.wakeAttempts += 1;
    }
    if (outcome === 'applied') {
      this.failures = 0;
      if (action === 'off') {
        if (epoch === this.epoch) {
          this.offRequested = true;
          this.offAppliedAt = now;
        } else if (this.options.policy.wakeOnEntry) {
          // Someone came back while the request was in flight.
          this.wakeNeeded = true;
          this.wakeAttempts = 0;
        }
      } else {
        this.wakeNeeded = false;
        this.wakeVerifyAt = now + this.wakeVerifyMs();
      }
    } else {
      this.failures += 1;
      this.lastFailureAt = now;
      // An uncertain sleep request may still have landed.
      if (action === 'off' && outcome === 'uncertain') {
        if (epoch === this.epoch) this.offRequested = true;
        else if (this.options.policy.wakeOnEntry) {
          this.wakeNeeded = true;
          this.wakeAttempts = 0;
        }
      }
    }
    this.observe();
  }

  private leaveEmpty(): void {
    this.emptySince = null;
    this.offRequested = false;
    this.offAppliedAt = null;
    this.failures = 0;
    this.epoch += 1;
  }

  private rearm(dueAt: number | null, now: number): void {
    this.clearTimer();
    if (dueAt === null || this.disposed) return;
    this.timer = this.options.clock.setTimeout(
      () => this.observe(),
      Math.min(MAX_TIMER_MS, Math.max(0, dueAt - now)),
    );
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.options.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private emit(
    desired: 'on' | 'off' | null,
    inhibited: DisplayPowerInhibitReason | null,
    ready: boolean,
    armAt: number | null,
  ): void {
    const snapshot: DisplayPowerSnapshot = {
      deviceId: this.options.deviceId,
      control: ready ? 'available' : 'unavailable',
      desired,
      inhibited,
      lastRequest: this.lastRequest,
      nextAttemptAt: inhibited ? null : armAt,
      evidence: this.options.evidence?.() ?? null,
    };
    const key = JSON.stringify(snapshot);
    if (key === this.published) return;
    this.published = key;
    this.options.publish(snapshot);
  }
}

function minDue(current: number | null, next: number): number {
  return current === null ? next : Math.min(current, next);
}
