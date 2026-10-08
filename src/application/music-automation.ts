import type { Clock, TimerHandle } from '../core/clock.js';
import { AutomationHolds, isHumanActor } from '../core/automation-holds.js';
import type {
  DeviceMusicState,
  HomePresence,
  MusicFadeRequest,
  MusicRequest,
  Presence,
  Provenance,
} from '../core/schemas.js';
import type { MusicFadeLifecycleEvent } from './music-controller.js';

const automationActor = { type: 'automation' as const, id: 'lugn.music' };
const minimumAutomatedVolume = 0.05;
const maximumAutomatedVolume = 0.8;
const twoPersonReduction = 0.1;
const musicContinuityMs = 20 * 60_000;

type ActiveFade = {
  id: string;
  targetVolume: number;
  isUser: boolean;
  manualRevision: number;
};

export type ManualVolumeHold = {
  volume: number;
  createdAt: number;
  expiresAt: number | null;
  provenance: Provenance;
};

export type VolumeActivityReason =
  | 'manual_hold'
  | 'automation_disabled'
  | 'presence_unknown'
  | 'confirmed_empty'
  | 'home_away'
  | 'fade_active'
  | 'volume_unavailable'
  | 'active';

export type MusicVolumePolicySnapshot = {
  activeOwner: 'manual' | 'lugn' | 'none';
  lastIntentActor: 'manual' | 'lugn' | 'unknown';
  policyEnabled: boolean;
  policyActive: boolean;
  activityReason: VolumeActivityReason;
  manualHold: ManualVolumeHold | null;
  controller: 'you' | 'lugn';
  automatic: boolean;
  baselineSource: 'user' | 'inferred' | 'unknown';
  baseline: number | null;
  target: number | null;
  effectiveTarget: number | null;
  dailyOffset: number;
  personOffset: number;
};

export type MusicAutomationOptions = {
  targets: string[];
  clock: Clock;
  holds?: AutomationHolds;
  getState: (target: string) => DeviceMusicState;
  request: (
    target: string,
    request: MusicRequest,
    provenance: Provenance,
  ) => Promise<unknown>;
  onError?: (target: string, operation: string) => void;
  cancelAutomaticFade?: (target: string) => void;
  onChange?: () => void;
};

/** Presence-driven playback and volume policy for configured room players. */
export class MusicAutomation {
  private readonly baselines = new Map<string, number>();
  private readonly explicitBaselines = new Set<string>();
  private readonly volumeControllers = new Map<string, 'you' | 'lugn'>();
  private readonly resumeUntil = new Map<string, number>();
  private readonly activeFades = new Map<string, ActiveFade>();
  private readonly manualVolumeHolds = new Map<string, ManualVolumeHold>();
  private readonly manualRevisions = new Map<string, number>();
  private absenceExpiresAt: number | null = null;
  private absenceTimer: TimerHandle | undefined;
  private readonly holds: AutomationHolds;
  private timer: TimerHandle | undefined;
  private presence: Presence = 'unknown';
  private homePresence: HomePresence = 'unknown';
  private personCount: number | null = null;
  private volumeAutomationEnabled = true;
  private disposed = false;
  private lastConfirmedPresence: Presence = 'unknown';

  constructor(private readonly options: MusicAutomationOptions) {
    this.holds = options.holds ?? new AutomationHolds(options.clock);
  }

  handlePresence(
    _previous: Presence,
    presence: Presence,
    personCount: number | null,
  ): void {
    if (this.disposed) return;
    this.expireManualVolumeHolds();
    this.presence = presence;
    this.personCount = personCount;

    const lastConfirmedBeforeEvent = this.lastConfirmedPresence;
    if (presence === 'confirmed_empty') {
      this.lastConfirmedPresence = 'confirmed_empty';
      if (lastConfirmedBeforeEvent !== 'confirmed_empty') {
        this.absenceExpiresAt = this.options.clock.now() + musicContinuityMs;
        for (const hold of this.manualVolumeHolds.values())
          hold.expiresAt = this.absenceExpiresAt;
        this.scheduleAbsenceExpiry();
        for (const target of this.options.targets) {
          const device = this.options.getState(target);
          const wasPlaying =
            device.observed.playback === 'playing' ||
            device.requested.playback === 'playing';
          this.resumeUntil.set(
            target,
            wasPlaying && !this.holds.blocks('music.playback', target)
              ? this.options.clock.now() + musicContinuityMs
              : 0,
          );
          this.send(target, { property: 'playback', value: 'paused' }, 'pause');
        }
      }
      this.cancelTimer();
      this.cancelAutomaticFades();
      return;
    }

    if (presence === 'occupied') {
      this.absenceExpiresAt = null;
      this.cancelAbsenceTimer();
      for (const hold of this.manualVolumeHolds.values()) hold.expiresAt = null;
      this.lastConfirmedPresence = 'occupied';
      // Unknown samples do not erase the last confirmed room transition.
      const returningFromEmpty = lastConfirmedBeforeEvent === 'confirmed_empty';
      if (
        this.homePresence !== 'away' &&
        returningFromEmpty &&
        this.localHour() >= 6 &&
        this.localHour() < 23
      ) {
        for (const target of this.options.targets) {
          if (this.holds.blocks('music.playback', target)) continue;
          if ((this.resumeUntil.get(target) ?? 0) > this.options.clock.now()) {
            this.send(
              target,
              { property: 'playback', value: 'playing' },
              'resume',
            );
          } else if (
            !this.holds.blocks('music.playback', target) &&
            !this.isPlaying(this.options.getState(target))
          ) {
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
    this.cancelAutomaticFades();
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
      this.cancelAutomaticFades();
      return;
    }
    if (this.presence === 'occupied') {
      this.applyVolumePolicy();
      if (this.volumeAutomationEnabled) this.scheduleNextMinute();
    }
  }

  /** Human volume intent owns volume independently from explicit Pause. */
  noteExplicitRequest(
    target: string,
    request: MusicRequest,
    provenance: Provenance,
  ): void {
    if (request.property === 'volume' && isHumanActor(provenance.actor)) {
      const offset = this.currentOffset();
      this.baselines.set(target, this.clampBaseline(request.value - offset));
      this.claimManualVolume(target, request.value, provenance);
    } else if (request.property === 'volume') {
      this.volumeControllers.set(target, 'lugn');
    } else if (
      request.property === 'playback' &&
      isHumanActor(provenance.actor)
    ) {
      if (request.value === 'paused') {
        this.holds.set('music.playback', target, provenance);
        this.resumeUntil.set(target, 0);
      } else this.holds.clear('music.playback', target);
    } else if (
      request.property === 'preset' &&
      isHumanActor(provenance.actor)
    ) {
      this.holds.clear('music.playback', target);
    }
  }

  /** Record the user's intended destination while a bounded volume fade runs. */
  noteExplicitFade(request: MusicFadeRequest, provenance: Provenance): void {
    if (
      this.disposed ||
      !Number.isFinite(request.volume) ||
      !Number.isFinite(request.durationMs) ||
      request.durationMs < 0
    )
      return;

    const activeFade = this.activeFades.get(request.target);
    if (!activeFade) return;
    activeFade.targetVolume = request.volume;
    activeFade.isUser = isHumanActor(provenance.actor);
  }

  /** Follow the controller's actual fade lifetime, including settling and terminal paths. */
  handleFadeLifecycle(event: MusicFadeLifecycleEvent): void {
    if (this.disposed) return;
    if (event.phase === 'started') {
      const isUser = isHumanActor(event.provenance.actor);
      if (isUser)
        this.claimManualVolume(
          event.target,
          event.state.targetVolume,
          event.provenance,
        );
      else this.volumeControllers.set(event.target, 'lugn');
      this.activeFades.set(event.target, {
        id: event.state.id,
        targetVolume: event.state.targetVolume,
        isUser,
        manualRevision: this.manualRevisions.get(event.target) ?? 0,
      });
      return;
    }

    const activeFade = this.activeFades.get(event.target);
    if (!activeFade || activeFade.id !== event.state.id) return;
    this.activeFades.delete(event.target);
    // An interrupted/superseded automatic fade cannot commit its stale actual
    // volume over newer human intent. External intent can also replace a user fade.
    if (
      activeFade.manualRevision !==
      (this.manualRevisions.get(event.target) ?? 0)
    )
      return;
    const terminalVolume =
      event.state.status === 'completed'
        ? activeFade.targetVolume
        : event.actualVolume;
    if (terminalVolume === null) return;

    this.baselines.set(
      event.target,
      this.clampBaseline(terminalVolume - this.currentOffset()),
    );
    if (activeFade.isUser) {
      const hold = this.getManualVolumeHold(event.target);
      if (hold) hold.volume = terminalVolume;
      this.explicitBaselines.add(event.target);
      this.volumeControllers.set(event.target, 'you');
    } else {
      this.explicitBaselines.delete(event.target);
    }
  }

  /** Preserve a physical pause so room re-entry cannot restart music over it. */
  noteExternalPlaybackChange(
    target: string,
    playback: DeviceMusicState['observed']['playback'],
    provenance: Provenance = {
      actor: { type: 'home_assistant' },
      source: 'external_observation',
    },
  ): void {
    if (this.disposed) return;
    if (playback === 'playing') {
      this.holds.clear('music.playback', target);
      return;
    }
    if (playback === 'paused') {
      this.holds.set('music.playback', target, provenance);
      this.resumeUntil.set(target, 0);
    }
  }

  /** Keep WiiM or Home Assistant volume changes as the user's baseline. */
  noteExternalVolumeChange(
    target: string,
    volume: number,
    provenance: Provenance = {
      actor: { type: 'home_assistant' },
      source: 'external_observation',
    },
  ): void {
    if (this.disposed || !Number.isFinite(volume)) return;
    this.baselines.set(
      target,
      this.clampBaseline(volume - this.currentOffset()),
    );
    this.claimManualVolume(target, volume, provenance);
  }

  getVolumePolicySnapshot(target: string): MusicVolumePolicySnapshot {
    const offsets = this.currentOffsets();
    const device = this.options.getState(target);
    const offset = offsets.daily + offsets.person;
    const baseline =
      this.baselines.get(target) ?? this.inferBaseline(device, offset);
    const targetVolume =
      baseline === undefined ? null : this.clamp(baseline + offset);
    const activityReason = this.volumeActivityReason(target, baseline);
    const automatic = activityReason === 'active';
    const hold = this.getManualVolumeHold(target);
    const activeFade = this.activeFades.get(target);
    return {
      activeOwner:
        hold || activeFade?.isUser
          ? 'manual'
          : automatic || activeFade
            ? 'lugn'
            : 'none',
      lastIntentActor:
        this.volumeControllers.get(target) === 'you'
          ? 'manual'
          : this.volumeControllers.has(target)
            ? 'lugn'
            : 'unknown',
      policyEnabled: this.volumeAutomationEnabled,
      policyActive: automatic,
      activityReason,
      manualHold: hold ? structuredClone(hold) : null,
      controller: hold || activeFade?.isUser ? 'you' : 'lugn',
      automatic,
      baselineSource:
        baseline === undefined
          ? 'unknown'
          : this.explicitBaselines.has(target)
            ? 'user'
            : 'inferred',
      baseline: baseline ?? null,
      target: targetVolume,
      effectiveTarget:
        hold?.volume ??
        activeFade?.targetVolume ??
        (automatic ? targetVolume : null),
      dailyOffset: offsets.daily,
      personOffset: offsets.person,
    };
  }

  setVolumeAutomationEnabled(
    enabled: boolean,
    intent: 'explicit' | 'restore' = 'explicit',
  ): void {
    if (this.disposed || this.volumeAutomationEnabled === enabled) return;
    this.volumeAutomationEnabled = enabled;
    if (!enabled) {
      this.cancelTimer();
      this.cancelAutomaticFades();
      return;
    }
    if (intent === 'explicit') this.manualVolumeHolds.clear();
    if (this.presence === 'occupied' && this.homePresence !== 'away') {
      this.applyVolumePolicy();
      this.scheduleNextMinute();
    }
  }

  get isVolumeAutomationEnabled(): boolean {
    return this.volumeAutomationEnabled;
  }

  /** Shared authority gate for capability commands and every automatic fade step. */
  assertVolumeRequestAllowed(target: string, provenance: Provenance): void {
    if (isHumanActor(provenance.actor)) return;
    this.expireManualVolumeHolds();
    if (
      this.manualVolumeHolds.has(target) ||
      this.activeFades.get(target)?.isUser
    )
      throw new Error(
        'Automatic volume is held by explicit human volume intent',
      );
    if (
      !this.volumeAutomationEnabled ||
      this.presence !== 'occupied' ||
      this.homePresence === 'away'
    )
      throw new Error('Automatic volume is suppressed by room policy');
  }

  private claimManualVolume(
    target: string,
    volume: number,
    provenance: Provenance,
  ): void {
    this.manualRevisions.set(
      target,
      (this.manualRevisions.get(target) ?? 0) + 1,
    );
    this.manualVolumeHolds.set(target, {
      volume,
      createdAt: this.options.clock.now(),
      expiresAt:
        this.absenceExpiresAt !== null &&
        this.absenceExpiresAt > this.options.clock.now()
          ? this.absenceExpiresAt
          : this.lastConfirmedPresence === 'confirmed_empty'
            ? this.options.clock.now() + musicContinuityMs
            : null,
      provenance: structuredClone(provenance),
    });
    this.explicitBaselines.add(target);
    this.volumeControllers.set(target, 'you');
    this.scheduleAbsenceExpiry();
  }

  private volumeActivityReason(
    target: string,
    baseline: number | undefined,
  ): VolumeActivityReason {
    if (this.getManualVolumeHold(target)) return 'manual_hold';
    if (!this.volumeAutomationEnabled) return 'automation_disabled';
    if (this.homePresence === 'away') return 'home_away';
    if (this.presence === 'unknown') return 'presence_unknown';
    if (this.presence === 'confirmed_empty') return 'confirmed_empty';
    if (this.activeFades.has(target)) return 'fade_active';
    if (
      baseline === undefined ||
      this.options.getState(target).availability !== 'available' ||
      this.options.getState(target).observed.volume === null
    )
      return 'volume_unavailable';
    return 'active';
  }

  private cancelAutomaticFades(): void {
    for (const [target, fade] of this.activeFades)
      if (!fade.isUser) this.options.cancelAutomaticFade?.(target);
  }

  private getManualVolumeHold(target: string): ManualVolumeHold | undefined {
    const hold = this.manualVolumeHolds.get(target);
    return hold &&
      (hold.expiresAt === null || this.options.clock.now() < hold.expiresAt)
      ? hold
      : undefined;
  }

  private scheduleAbsenceExpiry(): void {
    this.cancelAbsenceTimer();
    const deadlines = [...this.manualVolumeHolds.values()].flatMap((hold) =>
      hold.expiresAt === null ? [] : [hold.expiresAt],
    );
    if (deadlines.length === 0) return;
    this.absenceTimer = this.options.clock.setTimeout(
      () => {
        this.absenceTimer = undefined;
        this.expireManualVolumeHolds();
        this.scheduleAbsenceExpiry();
      },
      Math.max(0, Math.min(...deadlines) - this.options.clock.now()),
    );
  }

  private expireManualVolumeHolds(): void {
    let changed = false;
    for (const [target, hold] of this.manualVolumeHolds) {
      if (
        hold.expiresAt !== null &&
        this.options.clock.now() >= hold.expiresAt
      ) {
        this.manualVolumeHolds.delete(target);
        changed = true;
      }
    }
    if (changed) this.options.onChange?.();
  }

  private cancelAbsenceTimer(): void {
    if (this.absenceTimer !== undefined)
      this.options.clock.clearTimeout(this.absenceTimer);
    this.absenceTimer = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    this.cancelAbsenceTimer();
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
      if (
        this.volumeActivityReason(target, baseline) !== 'active' ||
        baseline === undefined
      )
        continue;
      this.baselines.set(target, baseline);
      const desired = this.clamp(baseline + offset);
      const current = device.requested.volume ?? device.observed.volume;
      if (current !== null && Math.abs(current - desired) < 0.005) continue;
      this.volumeControllers.set(target, 'lugn');
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
    return current === null ? undefined : this.clampBaseline(current - offset);
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
    if (
      this.holds.blocks('music.playback', target) &&
      (request.property === 'preset' ||
        (request.property === 'playback' && request.value === 'playing'))
    )
      return;
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

  /** Keep baseline math independent from the physical automated volume cap. */
  private clampBaseline(value: number): number {
    return Math.min(1, Math.max(0, value));
  }
}
