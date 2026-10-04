import { randomUUID } from 'node:crypto';
import type { Clock, TimerHandle } from '../core/clock.js';
import type { Presence, RoomSession } from '../core/schemas.js';

export type RoomSessionTransition =
  'started' | 'suspended' | 'resumed' | 'ended';

/** Process-local visits; domain intent and reset policies remain independent. */
export class RoomSessions {
  private session: RoomSession | null = null;
  private timer: TimerHandle | undefined;
  private disposed = false;

  constructor(
    private readonly clock: Clock,
    private readonly continuityMs: number,
    private readonly onChange: (
      session: RoomSession,
      transition?: RoomSessionTransition,
    ) => void,
  ) {
    if (
      !Number.isFinite(continuityMs) ||
      continuityMs < 1 ||
      continuityMs > 24 * 60 * 60_000
    )
      throw new Error('roomSessionContinuityMs must be between 1 and 86400000');
  }

  handlePresence(presence: Presence): void {
    if (this.disposed || presence === 'unknown') return;
    const now = this.clock.now();
    if (presence === 'occupied') {
      // An occupied event at the deadline belongs to a new session even if a
      // delayed timer callback has not run yet.
      if (this.session?.state === 'suspended') this.expire(this.session.id);
      if (this.session === null || this.session.state === 'ended') {
        this.session = {
          id: randomUUID(),
          state: 'active',
          startedAt: now,
          lastActiveAt: now,
          suspendedAt: null,
          expiresAt: null,
          endedAt: null,
        };
        this.emit('started');
      } else if (this.session.state === 'suspended') {
        this.clearTimer();
        this.session.state = 'active';
        this.session.lastActiveAt = now;
        this.session.suspendedAt = null;
        this.session.expiresAt = null;
        this.emit('resumed');
      } else if (this.session.lastActiveAt !== now) {
        this.session.lastActiveAt = now;
        this.emit();
      }
    } else if (this.session?.state === 'active') {
      this.session.state = 'suspended';
      this.session.suspendedAt = now;
      this.session.expiresAt = now + this.continuityMs;
      this.armExpiry(this.session.id, this.continuityMs);
      this.emit('suspended');
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private expire(id: string): void {
    if (
      this.disposed ||
      this.session?.id !== id ||
      this.session.state !== 'suspended' ||
      this.session.expiresAt === null
    )
      return;
    const remainingMs = this.session.expiresAt - this.clock.now();
    if (remainingMs > 0) return;
    this.clearTimer();
    this.session.state = 'ended';
    this.session.endedAt = this.session.expiresAt;
    this.emit('ended');
  }

  private armExpiry(id: string, delayMs: number): void {
    this.clearTimer();
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      this.expire(id);
      // Wall-clock adjustment must not end a session ahead of its deadline.
      if (
        !this.disposed &&
        this.session?.id === id &&
        this.session.state === 'suspended' &&
        this.session.expiresAt !== null
      )
        this.armExpiry(id, this.session.expiresAt - this.clock.now());
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private emit(transition?: RoomSessionTransition): void {
    if (this.session) this.onChange(structuredClone(this.session), transition);
  }
}
