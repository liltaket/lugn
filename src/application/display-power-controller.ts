import type { Clock, TimerHandle } from '../core/clock.js';
import type {
  DisplayPowerEvidence,
  DisplayPowerInhibitReason,
  DisplayPowerSnapshot,
} from '../core/display-power.js';
import type { RoomState } from '../core/schemas.js';
import type {
  ComputerDisplayState,
  ComputerDisplayTransport,
} from '../adapters/computer-display-mqtt.js';

export type DisplayPowerPolicy = {
  /** Confirmed-empty time before the first sleep request. */
  offAfterEmptyMs: number;
  /**
   * Only for agents that cannot report the display state: while the room stays
   * empty the sleep request is repeated this often. Not used with feedback.
   */
  reassertOffMs: number;
  /**
   * While nobody is home, keep ensuring the display is off: no cap on applied
   * sleeps, rechecked at a low rate instead of giving up.
   */
  ensureOffWhenAway: boolean;
  /** Wake the display when someone is confirmed back after Lugn put it to sleep. */
  wakeOnEntry: boolean;
  /** Automatic wake is skipped from 23:00 to 06:00 unless this is set. */
  wakeInQuietHours: boolean;
  /**
   * In quiet hours the display is still woken after a short absence: when the
   * room was empty (or you were away) at most this long. 0 never wakes then.
   */
  quietWakeMaxAbsenceMs: number;
  /** Hold sleep while the computer reports recent input or a game/video. */
  inhibitOnActivity: boolean;
  /** Game/video (and idle-less activity) can postpone sleep for at most this long. */
  activeInhibitMaxMs: number;
  /**
   * Sleep after this long without keyboard or pointer input, whatever presence
   * says, unless video, a game or an unexplained idle blocker is active; music
   * never holds it. Needs the agent's display feedback. `null` turns it off.
   */
  idleSleepAfterMs: number | null;
  /** Idle blockers (by application name) that never hold the display on. */
  ignoreIdleBlockers: readonly string[];
};

export const defaultDisplayPowerPolicy: DisplayPowerPolicy = {
  offAfterEmptyMs: 120_000,
  reassertOffMs: 900_000,
  ensureOffWhenAway: true,
  wakeOnEntry: true,
  wakeInQuietHours: false,
  quietWakeMaxAbsenceMs: 1_200_000,
  inhibitOnActivity: true,
  activeInhibitMaxMs: 1_800_000,
  idleSleepAfterMs: 1_800_000,
  ignoreIdleBlockers: [],
};

/** Plug evidence timing, used only when the agent reports no display state. */
const EVIDENCE_OFF_GRACE_MS = 60_000;
/** Evidence flips are debounced by the sensor; look only after they could land. */
const EVIDENCE_SETTLE_MARGIN_MS = 15_000;
const EVIDENCE_ON_REASSERT_MIN_MS = 120_000;
const EVIDENCE_STANDBY_BACKSTOP_MS = 6 * 60 * 60_000;
const WAKE_RETRY_MS = 15_000;
const WAKE_VERIFY_MS = 20_000;
/** At most this many wake requests per return, counting failed ones. */
const WAKE_MAX_ATTEMPTS = 3;
/** At most this many unconfirmed sleep requests per empty period. */
const OFF_MAX_ATTEMPTS = 3;
/**
 * After a sleep request took effect, a display that reads lit again is either
 * state still catching up, a bump, or a presence miss. Do not send another
 * for this long, and give up after a few applied requests per empty period.
 */
const REPEAT_HOLD_MS = 10 * 60_000;
const OFF_APPLICATIONS_MAX = 4;
/** While nobody is home the display is rechecked this often, without a cap. */
const AWAY_RECHECK_MS = 60 * 60_000;
const FAILURE_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
/** Nobody home and nothing works: back off to an hourly try, never give up. */
const AWAY_FAILURE_BACKOFF_MS = [...FAILURE_BACKOFF_MS, 1_800_000, 3_600_000];
const MAX_TIMER_MS = 2 ** 31 - 1;

type Problem = NonNullable<DisplayPowerSnapshot['problem']>;
type IdleSleep = NonNullable<DisplayPowerSnapshot['idleSleep']>;
type HeldBy = NonNullable<IdleSleep['heldBy']>;
type Power = ComputerDisplayState['power'];
type Options = {
  deviceId: string;
  clock: Clock;
  /** Read on every evaluation so saved settings apply at once. */
  policy: () => DisplayPowerPolicy;
  /** Master switch; when false nothing is sent. Defaults to on. */
  enabled?: () => boolean;
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
 * With an agent that reports the GPU's display state ("feedback mode") the
 * observed state drives everything: sleep is sent only while the display is
 * observed on, the agent acknowledges only after the state followed, and there
 * are no blind repeats. Retries are few and spaced (a request that exited
 * successfully without effect is `not_observed`), and a display that wakes by
 * itself while the room reads empty is left alone for a while instead of being
 * fought. Without that report the policy falls back to the cautious open-loop
 * mode: one sleep request, repeated at a low rate, optionally informed by a
 * power-metering plug.
 *
 * In both modes sleep never starts while real input is recent, `unknown`
 * presence sends nothing, and a wake is sent once per confirmed return, only
 * after Lugn itself put the display to sleep.
 */
export class DisplayPowerController {
  private emptySince: number | null = null;
  /**
   * How long the room was empty before the last return; Infinity when that is
   * not known (Lugn restarted while the room was already empty).
   */
  private lastAbsenceMs = 0;
  private absenceKnown = true;
  private epoch = 0;
  /** A sleep request applied (or possibly applied) in this empty period. */
  private offRequested = false;
  private offAppliedAt: number | null = null;
  private lastOffAttemptAt = 0;
  private offAttempts = 0;
  private offApplications = 0;
  /** State of the current stretch without input (idle sleep). */
  private idleEpisode: number | null = null;
  private idleApplications = 0;
  private idleAttempts = 0;
  private idleAppliedAt = 0;
  private idleWakeAt = 0;
  private idleFailures = 0;
  private idleFailureAt = 0;
  private lastExternalWakeAt = 0;
  private prevPower: Power | null = null;
  private startupChecked = false;
  private wakeNeeded = false;
  private wakeAttempts = 0;
  private lastWakeAttemptAt = 0;
  private wakeVerifyAt: number | null = null;
  private problem: Problem | null = null;
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

  private policy(): DisplayPowerPolicy {
    return this.options.policy();
  }

  private enabled(): boolean {
    return this.options.enabled?.() ?? true;
  }

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
    const { clock } = this.options;
    const policy = this.policy();
    const now = clock.now();
    const snapshot = this.options.transport.getSnapshot();
    const observation = snapshot?.fresh ? snapshot.state : null;
    const power =
      observation && observation.power !== 'unknown' ? observation.power : null;
    const feedback = power !== null;
    const inputIdle = observation?.input_idle ?? null;
    const evidence = this.options.evidence?.() ?? null;
    const away = state.presence.home.state === 'away';
    const empty = state.presence.state === 'confirmed_empty' || away;
    const occupied = state.presence.state === 'occupied' && !away;
    this.problem = null;

    const previousPower = this.prevPower;
    // A display that lights up while the room reads empty and we did not ask.
    if (power !== null) {
      if (
        empty &&
        this.prevPower === 'off' &&
        (power === 'on' || power === 'partial')
      )
        this.lastExternalWakeAt = now;
      this.prevPower = power;
    }

    if (empty) {
      this.emptySince ??= now;
      this.wakeNeeded = false;
      this.wakeVerifyAt = null;
    } else if (occupied && this.emptySince !== null) {
      // Back in the room. Only a sleep Lugn requested because the room emptied
      // earns a wake. A display that went dark for inactivity (or for any other
      // reason) is left for the keyboard to wake.
      if (this.offRequested && policy.wakeOnEntry) {
        this.wakeNeeded = true;
        this.wakeAttempts = 0;
      }
      this.leaveEmpty(now);
    }
    if (!this.startupChecked && observation) {
      // After a restart of Lugn nothing remembers why the display went dark.
      // If the room is empty now and the agent's last request was a sleep, it
      // was almost certainly the presence rule (inactivity sleep only happens
      // with someone in the room), so it still earns a wake on return.
      this.startupChecked = true;
      if (empty && power === 'off' && lastCommandWasOurSleep(observation)) {
        this.offRequested = true;
        // When the room really emptied is unknown; Lugn only saw it just now.
        this.absenceKnown = false;
      }
    }

    const ready = this.ready(state, snapshot, observation);
    const inhibited =
      empty && this.emptySince !== null
        ? this.inhibitReason(state, now, this.emptySince, inputIdle)
        : null;
    let dueAt: number | null = null;
    let action: 'off' | 'on' | null = null;
    let kind: 'empty' | 'idle' = 'empty';
    let idleSleep: IdleSleep | null = null;

    if (!feedback && this.wakeVerifyAt !== null && occupied) {
      if (now >= this.wakeVerifyAt) {
        this.wakeVerifyAt = null;
        if (evidence?.state === 'standby') this.wakeNeeded = true;
      } else dueAt = this.wakeVerifyAt;
    }
    if (this.wakeNeeded && occupied) {
      if (
        !policy.wakeOnEntry ||
        // Already lit, by the agent's account or the plug's.
        power === 'on' ||
        (!feedback && evidence?.state === 'on') ||
        (!policy.wakeInQuietHours &&
          this.options.isQuietHours() &&
          (policy.quietWakeMaxAbsenceMs <= 0 ||
            this.lastAbsenceMs > policy.quietWakeMaxAbsenceMs))
      )
        this.wakeNeeded = false;
      else if (power === 'none') {
        // The monitor is not on the bus; a wake request has nothing to act on.
        this.wakeNeeded = false;
        this.problem = 'wake_unavailable';
      } else if (this.wakeAttempts >= WAKE_MAX_ATTEMPTS) {
        this.wakeNeeded = false;
        this.problem = 'wake_failed';
      } else {
        const due = this.afterBackoff(
          Math.max(now, this.lastWakeAttemptAt + WAKE_RETRY_MS),
        );
        dueAt = minDue(dueAt, due);
        if (due <= now) action = 'on';
      }
    } else if (empty && this.emptySince !== null) {
      if (inhibited) {
        // Capped inhibits end by themselves; real input arrives as an update.
        if (inhibited !== 'recent_input')
          dueAt = minDue(dueAt, this.emptySince + policy.activeInhibitMaxMs);
      } else if (feedback) {
        const due = this.feedbackOffDue(
          power,
          this.emptySince,
          away && policy.ensureOffWhenAway,
        );
        if (due !== null) {
          dueAt = minDue(dueAt, due);
          if (due <= now) action = 'off';
        }
      } else if (this.offAppliedAt === null && evidence?.state === 'standby') {
        // Already dark by the plug's account. A change in evidence re-evaluates.
      } else {
        const due = this.afterBackoff(this.offDue(this.emptySince, evidence));
        dueAt = minDue(dueAt, due);
        if (due <= now) action = 'off';
      }
    } else if (!empty) {
      const step = this.idleSleepStep(
        state,
        observation,
        power,
        previousPower,
        now,
      );
      idleSleep = step.info;
      if (step.due !== null) {
        dueAt = minDue(dueAt, step.due);
        if (step.due <= now) {
          action = 'off';
          kind = 'idle';
        }
      }
    }

    const enabled = this.enabled();
    if (!enabled) {
      action = null;
      dueAt = null;
    }
    if (action && ready && !this.sending)
      void this.send(action, feedback, kind);
    // A due request that cannot be sent waits for the transport, not a timer.
    const armAt = this.sending || (action && !ready) ? null : dueAt;
    this.rearm(armAt, now);
    this.emit(
      empty ? 'off' : occupied ? 'on' : null,
      inhibited,
      ready,
      armAt,
      observation,
      idleSleep,
      enabled,
    );
  }

  /**
   * Sleep after a long stretch without input. Positive evidence is required
   * that nobody is watching something: music never holds it, video, a game or
   * a blocker nobody can explain does, and anything unreadable counts as held.
   */
  private idleSleepStep(
    state: RoomState,
    observation: ComputerDisplayState | null,
    power: Power | null,
    previousPower: Power | null,
    now: number,
  ): { info: IdleSleep | null; due: number | null } {
    const after = this.policy().idleSleepAfterMs;
    if (after === null || !observation) return { info: null, due: null };
    const since =
      observation.input_idle === true ? observation.input_idle_since_ms : null;
    if (since === null) {
      // Someone used the computer; the next stretch of inactivity starts fresh.
      this.idleEpisode = null;
      this.idleApplications = 0;
      this.idleAttempts = 0;
      this.idleAppliedAt = 0;
      this.idleWakeAt = 0;
      this.idleFailures = 0;
      return {
        info: { inactiveSince: null, dueAt: null, heldBy: null },
        due: null,
      };
    }
    if (this.idleEpisode !== since) {
      this.idleEpisode = since;
      this.idleApplications = 0;
      this.idleAttempts = 0;
      this.idleAppliedAt = 0;
      this.idleWakeAt = 0;
      this.idleFailures = 0;
    }
    // Lit again without input in this stretch: a bump, not a person.
    if (previousPower === 'off' && (power === 'on' || power === 'partial'))
      this.idleWakeAt = now;
    const held = (heldBy: HeldBy | null, dueAt: number | null = null) => ({
      info: { inactiveSince: since, dueAt, heldBy },
      due: dueAt,
    });
    if (power === null) return held('no_feedback');
    // Already dark, or no monitor on the bus: nothing to do.
    if (power === 'off' || power === 'none') return held(null);
    const blocker = this.visualMediaBlocker(state, observation);
    if (blocker) return held(blocker);
    if (this.idleApplications >= OFF_APPLICATIONS_MAX)
      return held('keeps_waking');
    if (this.idleAttempts >= OFF_MAX_ATTEMPTS) return held('off_failed');
    let due = since + after;
    const last = Math.max(this.idleAppliedAt, this.idleWakeAt);
    if (last > 0) due = Math.max(due, last + REPEAT_HOLD_MS);
    if (this.idleFailures > 0)
      due = Math.max(
        due,
        this.idleFailureAt +
          FAILURE_BACKOFF_MS[
            Math.min(this.idleFailures, FAILURE_BACKOFF_MS.length) - 1
          ]!,
      );
    return held(null, due);
  }

  /** Why someone may be watching, or null when nothing visual is going on. */
  private visualMediaBlocker(
    state: RoomState,
    observation: ComputerDisplayState,
  ): HeldBy | null {
    const computer = state.computer.devices[this.options.deviceId];
    if (
      !computer ||
      computer.availability !== 'online' ||
      computer.freshness !== 'fresh'
    )
      return 'computer_unknown';
    if (computer.activity.classification === 'gaming') return 'game';
    if (computer.activity.classification === 'video') return 'video';
    // A full-screen window with a player that is playing and sound running on
    // this computer is a film even when no blocker is listed (a native player).
    // Running streams alone prove little, since browsers keep silent ones for
    // their tabs, and a player that claims to be playing alone proves nothing
    // about this screen, so all three are needed.
    if (
      computer.observed.fullscreen === true &&
      computer.observed.audio?.playing === true &&
      computer.observed.media?.some((player) => player.playback === 'playing')
    )
      return 'fullscreen_playback';
    const blockers = observation.idle_blockers;
    if (blockers === null) return 'blockers_unknown';
    const ignored = new Set(
      this.policy().ignoreIdleBlockers.map((name) => name.toLowerCase()),
    );
    for (const blocker of blockers) {
      if (ignored.has(blocker.app.toLowerCase())) continue;
      const video = /video/i.test(blocker.reason);
      // "Playing audio" is music, which never holds the display on.
      if (!video && /audio/i.test(blocker.reason)) continue;
      return video ? 'video' : 'other_blocker';
    }
    // The compositor says something blocks idle yet nothing is listed.
    if (blockers.length === 0 && computer.observed.idle === false)
      return 'unexplained_inhibitor';
    return null;
  }

  /** When the display should next be put to sleep, or null for never (now). */
  private feedbackOffDue(
    power: Power | null,
    emptySince: number,
    ensureAway: boolean,
  ): number | null {
    // Dark already (or no monitor on the bus): there is nothing to do.
    if (power === 'off' || power === 'none') return null;
    // Nobody is home: never give up, just recheck slowly.
    if (!ensureAway) {
      if (this.offAttempts >= OFF_MAX_ATTEMPTS) {
        this.problem = 'off_failed';
        return null;
      }
      if (this.offApplications >= OFF_APPLICATIONS_MAX) {
        this.problem = 'keeps_waking';
        return null;
      }
    }
    let due = emptySince + this.policy().offAfterEmptyMs;
    // The agent's state can lag its acknowledgement by a moment, so a display
    // still reading lit right after an applied request is not a reason to send
    // another. The same hold covers a wake by input or by a presence miss.
    const last = Math.max(this.offAppliedAt ?? 0, this.lastExternalWakeAt);
    if (last > 0)
      due = Math.max(
        due,
        last + (ensureAway ? AWAY_RECHECK_MS : REPEAT_HOLD_MS),
      );
    return this.afterBackoff(due, ensureAway);
  }

  private offDue(
    emptySince: number,
    evidence: DisplayPowerEvidence | null,
  ): number {
    const policy = this.policy();
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

  private afterBackoff(due: number, long = false): number {
    if (this.failures === 0) return due;
    const steps = long ? AWAY_FAILURE_BACKOFF_MS : FAILURE_BACKOFF_MS;
    const wait = steps[Math.min(this.failures, steps.length) - 1]!;
    return Math.max(due, this.lastFailureAt + wait);
  }

  private inhibitReason(
    state: RoomState,
    now: number,
    emptySince: number,
    inputIdle: boolean | null,
  ): DisplayPowerInhibitReason | null {
    const policy = this.policy();
    if (!policy.inhibitOnActivity) return null;
    // Real keyboard or pointer input means a person is at the computer, however
    // the presence sensor sees the room. Never capped.
    if (inputIdle === false) return 'recent_input';
    if (now - emptySince >= policy.activeInhibitMaxMs) return null;
    const computer = state.computer.devices[this.options.deviceId];
    if (
      !computer ||
      computer.availability !== 'online' ||
      computer.freshness !== 'fresh'
    )
      return null;
    // Without input-only idle, "not idle" may be a video or an idle inhibitor.
    if (inputIdle === null && computer.observed.idle === false)
      return 'recent_activity';
    if (['gaming', 'video'].includes(computer.activity.classification))
      return 'video_or_game';
    return null;
  }

  /** Requests need a live, matching computer observation and display transport. */
  private ready(
    state: RoomState,
    snapshot: ReturnType<ComputerDisplayTransport['getSnapshot']>,
    observation: ComputerDisplayState | null,
  ): boolean {
    const computer = state.computer.devices[this.options.deviceId];
    return (
      !!snapshot?.fresh &&
      !!observation &&
      observation.backend !== null &&
      !!computer &&
      computer.availability === 'online' &&
      computer.freshness === 'fresh' &&
      computer.sessionId === observation.session_id
    );
  }

  private async send(
    action: 'off' | 'on',
    feedback: boolean,
    kind: 'empty' | 'idle',
  ): Promise<void> {
    this.sending = true;
    const epoch = this.epoch;
    let outcome: 'applied' | 'rejected' | 'uncertain' | 'failed' = 'failed';
    let reason: string | null = null;
    try {
      const ack = await this.options.transport.sendCommand(action);
      outcome = ack.outcome;
      reason = ack.reason;
    } catch {
      outcome = 'failed';
    }
    this.sending = false;
    if (this.disposed) return;
    const now = this.options.clock.now();
    this.lastRequest = { action, outcome, reason, at: now };
    if (kind === 'idle') {
      // Sleep for inactivity touches none of the empty-room bookkeeping.
      if (outcome === 'applied') {
        this.idleApplications += 1;
        this.idleAppliedAt = now;
        this.idleAttempts = 0;
        this.idleFailures = 0;
      } else {
        this.idleAttempts += 1;
        this.idleFailures += 1;
        this.idleFailureAt = now;
      }
      this.observe();
      return;
    }
    if (action === 'off') this.lastOffAttemptAt = now;
    else {
      this.lastWakeAttemptAt = now;
      this.wakeAttempts += 1;
    }
    if (outcome === 'applied') {
      this.failures = 0;
      if (action === 'off') {
        this.offAttempts = 0;
        if (epoch === this.epoch) {
          this.offRequested = true;
          this.offAppliedAt = now;
          this.offApplications += 1;
        } else if (this.policy().wakeOnEntry) {
          // Someone came back while the request was in flight.
          this.wakeNeeded = true;
          this.wakeAttempts = 0;
        }
      } else {
        this.wakeNeeded = false;
        // The agent confirmed the display state; only open-loop wakes need a check.
        if (!feedback) this.wakeVerifyAt = now + this.wakeVerifyMs();
      }
    } else {
      this.failures += 1;
      this.lastFailureAt = now;
      if (action === 'off' && feedback) this.offAttempts += 1;
      // An unconfirmed sleep request may still have landed, unless the agent
      // watched and saw nothing happen.
      if (
        action === 'off' &&
        outcome === 'uncertain' &&
        reason !== 'not_observed'
      ) {
        if (epoch === this.epoch) this.offRequested = true;
        else if (this.policy().wakeOnEntry) {
          this.wakeNeeded = true;
          this.wakeAttempts = 0;
        }
      }
    }
    this.observe();
  }

  private leaveEmpty(now: number): void {
    this.lastAbsenceMs =
      this.emptySince !== null && this.absenceKnown
        ? now - this.emptySince
        : Number.POSITIVE_INFINITY;
    this.absenceKnown = true;
    this.emptySince = null;
    this.offRequested = false;
    this.offAppliedAt = null;
    this.failures = 0;
    this.offAttempts = 0;
    this.offApplications = 0;
    this.lastExternalWakeAt = 0;
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
    observation: ComputerDisplayState | null,
    idleSleep: IdleSleep | null,
    enabled: boolean,
  ): void {
    const snapshot: DisplayPowerSnapshot = {
      deviceId: this.options.deviceId,
      enabled,
      control: ready ? 'available' : 'unavailable',
      desired,
      inhibited,
      lastRequest: this.lastRequest,
      observed: observation
        ? {
            power: observation.power,
            inputIdle: observation.input_idle,
            changedAt: observation.power_changed_at_ms,
          }
        : null,
      problem: this.problem,
      idleSleep,
      nextAttemptAt: inhibited ? null : armAt,
      evidence: this.options.evidence?.() ?? null,
    };
    const key = JSON.stringify(snapshot);
    if (key === this.published) return;
    this.published = key;
    this.options.publish(snapshot);
  }
}

/** The agent's last request was a sleep that took effect (or may have). */
function lastCommandWasOurSleep(
  observation: ComputerDisplayState | null,
): boolean {
  const last = observation?.last_command;
  return (
    !!last &&
    last.action === 'off' &&
    (last.outcome === 'applied' ||
      (last.outcome === 'uncertain' && last.reason !== 'not_observed'))
  );
}

function minDue(current: number | null, next: number): number {
  return current === null ? next : Math.min(current, next);
}
