import type { Clock, TimerHandle } from '../core/clock.js';
import type {
  DeviceMusicState,
  HomePresence,
  MusicRequest,
  Presence,
  Provenance,
} from '../core/schemas.js';

const automationActor = { type: 'automation' as const, id: 'lugn.music' };
const minimumAutomatedVolume = 0.05;
const maximumAutomatedVolume = 0.8;
const twoPersonReduction = 0.1;
const musicContinuityMs = 20 * 60_000;

export type MusicVolumePolicySnapshot = {
  controller: 'you' | 'lugn';
  automatic: boolean;
  baselineSource: 'user' | 'inferred' | 'unknown';
  baseline: number | null;
  target: number | null;
  dailyOffset: number;
  personOffset: number;
};

export type MusicAutomationOptions = {
  targets: string[];
  clock: Clock;
  getState: (target: string) => DeviceMusicState;
  request: (
    target: string,
    request: MusicRequest,
    provenance: Provenance,
  ) => Promise<unknown>;
  onError?: (target: string, operation: string) => void;
};

/** Presence-driven playback and volume policy for configured room players. */
export class MusicAutomation {
  private readonly baselines = new Map<string, number>();
  private readonly explicitBaselines = new Set<string>();
  private readonly resumeUntil = new Map<string, number>();
  private timer: TimerHandle | undefined;
  private presence: Presence = 'unknown';
  private homePresence: HomePresence = 'unknown';
  private personCount: number | null = null;
  private volumeAutomationEnabled = true;
  private disposed = false;

  constructor(private readonly options: MusicAutomationOptions) {}

  handlePresence(
    previous: Presence,
    presence: Presence,
    personCount: number | null,
  ): void {
    if (this.disposed) return;
    this.presence = presence;
    this.personCount = personCount;

    if (presence === 'confirmed_empty' && previous !== 'confirmed_empty') {
      for (const target of this.options.targets) {
        const device = this.options.getState(target);
        const wasPlaying =
          device.observed.playback === 'playing' ||
          device.requested.playback === 'playing';
        this.resumeUntil.set(
          target,
          wasPlaying ? this.options.clock.now() + musicContinuityMs : 0,
        );
        this.send(target, { property: 'playback', value: 'paused' }, 'pause');
      }
      this.cancelTimer();
      return;
    }

    if (presence === 'occupied') {
      if (
        this.homePresence !== 'away' &&
        previous === 'confirmed_empty' &&
        this.localHour() < 23
      ) {
        for (const target of this.options.targets) {
          if ((this.resumeUntil.get(target) ?? 0) > this.options.clock.now()) {
            this.send(
              target,
              { property: 'playback', value: 'playing' },
              'resume',
            );
          } else if (!this.isPlaying(this.options.getState(target))) {
            this.send(
              target,
              { property: 'preset', value: 'spotify_dj' },
              'start Spotify DJ preset',
            );
          }
        }
      }
      this.applyVolumePolicy();
      if (this.homePresence === 'away' || !this.volumeAutomationEnabled)
        this.cancelTimer();
      else this.scheduleNextMinute();
      return;
    }

    this.cancelTimer();
  }

  handleHomePresence(homePresence: HomePresence): void {
    if (this.disposed) return;
    this.homePresence = homePresence;
    if (homePresence === 'away') {
      for (const target of this.options.targets) {
        if (this.isPlaying(this.options.getState(target)))
          this.send(
            target,
            { property: 'playback', value: 'paused' },
            'pause while away',
          );
      }
      this.cancelTimer();
      return;
    }
    if (homePresence === 'home' && this.presence === 'occupied') {
      this.applyVolumePolicy();
      if (this.volumeAutomationEnabled) this.scheduleNextMinute();
    }
  }

  /** Keep an explicit dashboard volume adjustment as the new user baseline. */
  noteExplicitRequest(
    target: string,
    request: MusicRequest,
    provenance: Provenance,
  ): void {
    if (request.property === 'volume') {
      const offset = this.currentOffset();
      this.baselines.set(target, this.clamp(request.value - offset));
      if (provenance.actor.type === 'user') this.explicitBaselines.add(target);
      else this.explicitBaselines.delete(target);
    }
  }

  getVolumePolicySnapshot(target: string): MusicVolumePolicySnapshot {
    const offsets = this.currentOffsets();
    const device = this.options.getState(target);
    const offset = offsets.daily + offsets.person;
    const baseline =
      this.baselines.get(target) ?? this.inferBaseline(device, offset);
    if (baseline !== undefined) this.baselines.set(target, baseline);
    const targetVolume =
      baseline === undefined ? null : this.clamp(baseline + offset);
    const automatic =
      this.volumeAutomationEnabled &&
      this.presence === 'occupied' &&
      this.homePresence !== 'away' &&
      targetVolume !== null;
    return {
      controller: automatic ? 'lugn' : 'you',
      automatic,
      baselineSource:
        baseline === undefined
          ? 'unknown'
          : this.explicitBaselines.has(target)
            ? 'user'
            : 'inferred',
      baseline: baseline ?? null,
      target: targetVolume,
      dailyOffset: offsets.daily,
      personOffset: offsets.person,
    };
  }

  setVolumeAutomationEnabled(enabled: boolean): void {
    if (this.disposed || this.volumeAutomationEnabled === enabled) return;
    this.volumeAutomationEnabled = enabled;
    if (!enabled) {
      this.cancelTimer();
      return;
    }
    if (this.presence === 'occupied' && this.homePresence !== 'away') {
      this.applyVolumePolicy();
      this.scheduleNextMinute();
    }
  }

  get isVolumeAutomationEnabled(): boolean {
    return this.volumeAutomationEnabled;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  private applyVolumePolicy(): void {
    if (
      !this.volumeAutomationEnabled ||
      this.presence !== 'occupied' ||
      this.homePresence === 'away'
    )
      return;
    const offsets = this.currentOffsets();
    const offset = offsets.daily + offsets.person;
    for (const target of this.options.targets) {
      const device = this.options.getState(target);
      const baseline =
        this.baselines.get(target) ?? this.inferBaseline(device, offset);
      if (baseline === undefined) continue;
      this.baselines.set(target, baseline);
      const desired = this.clamp(baseline + offset);
      const current = device.requested.volume ?? device.observed.volume;
      if (current !== null && Math.abs(current - desired) < 0.005) continue;
      this.send(
        target,
        { property: 'volume', value: desired },
        'set room volume',
      );
    }
  }

  private inferBaseline(
    device: DeviceMusicState,
    offset: number,
  ): number | undefined {
    const current = device.requested.volume ?? device.observed.volume;
    return current === null ? undefined : this.clamp(current - offset);
  }

  /** -15pp at midnight, rising to baseline at 06:00, flat through 22:00. */
  private currentOffsets(): { daily: number; person: number } {
    const decimalHour = this.localHour();
    let dayOffset: number;
    if (decimalHour < 6) dayOffset = -0.15 + (0.15 * decimalHour) / 6;
    else if (decimalHour < 22) dayOffset = 0;
    else dayOffset = (-0.15 * (decimalHour - 22)) / 2;
    return {
      daily: dayOffset,
      person:
        this.personCount !== null && this.personCount > 1
          ? -twoPersonReduction
          : 0,
    };
  }

  private currentOffset(): number {
    const offsets = this.currentOffsets();
    return offsets.daily + offsets.person;
  }

  private localHour(): number {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Stockholm',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(this.options.clock.now()));
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
    const minute = Number(
      parts.find((part) => part.type === 'minute')?.value ?? 0,
    );
    return hour + minute / 60;
  }

  private scheduleNextMinute(): void {
    this.cancelTimer();
    const now = this.options.clock.now();
    const delay = 60_000 - (now % 60_000) + 25;
    this.timer = this.options.clock.setTimeout(() => {
      this.timer = undefined;
      this.applyVolumePolicy();
      this.scheduleNextMinute();
    }, delay);
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) this.options.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private isPlaying(device: DeviceMusicState): boolean {
    return (
      device.observed.playback === 'playing' ||
      device.requested.playback === 'playing'
    );
  }

  private send(target: string, request: MusicRequest, operation: string): void {
    void this.options
      .request(target, request, {
        actor: automationActor,
        source: 'presence_music_automation',
        reason: operation,
      })
      .catch(() => this.options.onError?.(target, operation));
  }

  private clamp(value: number): number {
    return Math.min(
      maximumAutomatedVolume,
      Math.max(minimumAutomatedVolume, value),
    );
  }
}
