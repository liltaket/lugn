import type { Clock, TimerHandle } from '../core/clock.js';
import type { PresenceInputEvent } from '../core/schemas.js';

type ConfirmedPresence = 'occupied' | 'confirmed_empty';

/**
 * Holds back a confirmed-empty report so a short trip out of the room does
 * not turn lights off and music down just to restore them. The sensor still
 * reports the truth immediately; only the decision to act on it waits.
 *
 * Anything other than confirmed-empty ends the wait: a return cancels it, and
 * `unknown` never shuts a room down, so it cancels it too. A fresh empty
 * report then starts a new wait. Prelight and other event types pass through.
 */
export class PresenceExitGrace {
  private lastConfirmed: ConfirmedPresence | undefined;
  private pending:
    | { event: PresenceInputEvent; startedAt: number; timer: TimerHandle }
    | undefined;

  constructor(
    private readonly options: {
      clock: Clock;
      graceMs: () => number;
      forward: (event: PresenceInputEvent) => void;
      /** A wait started, or was re-timed after a settings change. */
      onHold?: (pending: { startedAt: number; until: number }) => void;
    },
  ) {}

  /** When the held exit will be acted on, or null when nothing is waiting. */
  get pendingUntil(): number | null {
    return this.pending
      ? this.pending.startedAt + this.options.graceMs()
      : null;
  }

  accept(event: PresenceInputEvent): void {
    if (event.type !== 'presence.changed') {
      this.options.forward(event);
      return;
    }
    if (
      event.presence === 'confirmed_empty' &&
      this.lastConfirmed === 'occupied' &&
      this.options.graceMs() > 0
    ) {
      // A repeated empty report must not stretch the wait.
      if (!this.pending) this.hold(event);
      return;
    }
    this.cancel();
    if (event.presence !== 'unknown') this.lastConfirmed = event.presence;
    this.options.forward(event);
  }

  /** Re-times a held exit after the grace setting changed. */
  settingsChanged(): void {
    const pending = this.pending;
    if (!pending) return;
    this.options.clock.clearTimeout(pending.timer);
    this.schedule(pending.event, pending.startedAt);
  }

  dispose(): void {
    this.cancel();
  }

  private hold(event: PresenceInputEvent): void {
    this.schedule(event, this.options.clock.now());
  }

  private schedule(event: PresenceInputEvent, startedAt: number): void {
    const delay = Math.max(
      0,
      startedAt + this.options.graceMs() - this.options.clock.now(),
    );
    const timer = this.options.clock.setTimeout(() => {
      this.pending = undefined;
      this.lastConfirmed = 'confirmed_empty';
      // Receipt timing would otherwise report the wait as sensor latency.
      const delivered = { ...event };
      delete delivered.localReceivedMonotonicAt;
      this.options.forward(delivered);
    }, delay);
    this.pending = { event, startedAt, timer };
    this.options.onHold?.({
      startedAt,
      until: startedAt + this.options.graceMs(),
    });
  }

  private cancel(): void {
    if (!this.pending) return;
    this.options.clock.clearTimeout(this.pending.timer);
    this.pending = undefined;
  }
}
