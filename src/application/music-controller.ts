import {
  SimulatedMusicAdapter,
  type MusicAdapter,
  type MusicObservation,
} from '../adapters/simulated-music.js';
import type { Clock, TimerHandle } from '../core/clock.js';
import { isHumanActor } from '../core/automation-holds.js';
import {
  MusicRequestSchema,
  MusicFadeRequestSchema,
  MusicObservationValuesSchema,
  SemanticMusicIdSchema,
  ProvenanceSchema,
  type MusicCommandRecord,
  type MusicFadeRequest,
  type MusicFadeState,
  type MusicRequest,
  type MusicState,
  type DeviceMusicState,
  type Provenance,
  type MusicRecoveryStopReason,
} from '../core/schemas.js';
import { MusicCommandRecovery } from './music-command-recovery.js';

const MAX_RETAINED_TERMINAL_COMMANDS = 128;
const MUSIC_FADE_TOLERANCE = 0.02;
const MUSIC_FADE_STEP_SIZE = 0.02;
const MUSIC_FADE_MIN_STEP_INTERVAL_MS = 250;
const MUSIC_FADE_SETTLING_MS = 2_000;
const MUSIC_FADE_MAX_EXTENSION_MS = 30_000;
// HA can report a service-driven playback transition after its command has
// already timed out. Retain a short attribution window for accepted pauses;
// HA REST does not expose a causal command context for exact correlation.
const LATE_PAUSE_ATTRIBUTION_MS = 30_000;
const LATE_VOLUME_ATTRIBUTION_MS = 30_000;

export type MusicOptions = {
  targets?: Record<string, string[]>;
  adapter?: MusicAdapter;
  feedbackTimeoutMs?: number;
};

export class MusicFadeUnavailableError extends Error {
  constructor() {
    super('A recent observed volume is required to start a fade');
    this.name = 'MusicFadeUnavailableError';
  }
}

export class MusicFadeDurationError extends Error {
  constructor() {
    super('The requested fade is too short for bounded volume steps');
    this.name = 'MusicFadeDurationError';
  }
}

type MusicFadeRuntime = {
  state: MusicFadeState;
  provenance: Provenance;
  stepCount: number;
  stepIndex: number;
  intervalMs: number;
  previousObservedVolume: number;
  latestSequence: number;
  baselineSequence: number;
  commandId: string | undefined;
  accepted: boolean;
  timer: TimerHandle | undefined;
  deadlineTimer: TimerHandle | undefined;
};

export type MusicFadeLifecycleEvent = {
  phase: 'started' | 'terminal';
  target: string;
  state: MusicFadeState;
  actualVolume: number | null;
  provenance: Provenance;
};

/** Explicit music requests; no presence automation or ownership inference. */
export class MusicController {
  readonly state: MusicState = { devices: {}, commands: [], fades: {} };
  private readonly adapter: MusicAdapter;
  private readonly timeoutMs: number;
  private readonly recovery: MusicCommandRecovery;
  private disposed = false;
  private readonly intentGenerations = new Map<
    string,
    { volume: number; playback: number }
  >();
  private readonly recoveryGuards = new Map<
    string,
    () => MusicRecoveryStopReason | null
  >();
  private recoveryPolicyGuard:
    ((command: MusicCommandRecord) => string | null) | undefined;
  private readonly timers = new Map<string, TimerHandle>();
  private readonly observedSequence = new Map<string, number>();
  private readonly issuedSequence = new Map<string, number>();
  private readonly attributedSupersededVolumeCommands = new Set<string>();
  private readonly lastObservations = new Map<
    string,
    { observation: MusicObservation; staleVolumeFeedback: boolean }
  >();
  // Intent/transition ordering must outlive command timeout and bounded ledger
  // history. A metadata-only HA snapshot cannot cancel a user's playback intent.
  private readonly latestPlaybackIntentAt = new Map<string, number>();
  private readonly latestPlaybackChangedAt = new Map<string, number>();
  private readonly latestHumanVolumeIntent = new Map<
    string,
    { sequence: number; at: number }
  >();
  private readonly latestExternalPlaybackIntent = new Map<
    string,
    {
      sequence: number;
      changedAt: number | undefined;
      playback: 'playing' | 'paused';
    }
  >();
  private readonly commandSequences = new Map<string, number>();
  private readonly dispatchingCommands = new Set<string>();
  private readonly attributedOlderAutomaticVolumeCommands = new Set<string>();
  private onExternalVolumeChange:
    | ((target: string, volume: number, provenance: Provenance) => void)
    | undefined;
  private volumeRequestGuard:
    ((target: string, provenance: Provenance) => void) | undefined;
  private onExternalPlaybackChange:
    | ((
        target: string,
        playback: MusicObservation['values']['playback'],
        provenance: Provenance,
      ) => void)
    | undefined;
  private onFadeLifecycle:
    ((event: MusicFadeLifecycleEvent) => void) | undefined;
  private readonly fades = new Map<string, MusicFadeRuntime>();
  private readonly fadeDispatching = new Set<string>();
  private readonly unsubscribe: () => void;
  private nextCommandId = 0;
  private nextFadeId = 0;
  constructor(
    private readonly clock: Clock,
    options: MusicOptions,
    private readonly publish: () => void,
  ) {
    this.timeoutMs = options.feedbackTimeoutMs ?? 10_000;
    if (
      !Number.isFinite(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 60_000
    )
      throw new Error('musicFeedbackTimeoutMs must be between 1 and 60000');
    this.adapter = options.adapter ?? new SimulatedMusicAdapter(clock);
    this.recovery = new MusicCommandRecovery({
      clock,
      adapter: this.adapter,
      feedbackTimeoutMs: this.timeoutMs,
      publish: () => {
        if (!this.disposed) this.publish();
      },
      onTimeout: (command, publish) => this.timeoutCommand(command, publish),
      onRetry: async (command, signal, isAllowed) => {
        if (this.recoveryGuards.get(command.id)?.() !== null)
          throw new Error('Recovery intent is no longer valid');
        command.status = 'pending';
        Object.assign(this.requireTarget(command.target).requested, {
          [command.requested.property]: command.requested.value,
        });
        this.issuedSequence.set(
          command.id,
          this.observedSequence.get(command.target) ?? 0,
        );
        this.dispatchingCommands.add(command.id);
        this.publish();
        try {
          if (!isAllowed() || this.recoveryGuards.get(command.id)?.() !== null)
            throw new Error(
              'Recovery intent was superseded during publication',
            );
          await this.adapter.dispatch(
            {
              id: command.id,
              target: command.target,
              requested: command.requested,
            },
            signal,
          );
        } finally {
          this.dispatchingCommands.delete(command.id);
        }
      },
      onAccepted: (command) => {
        const observation = this.lastObservations.get(
          command.target,
        )?.observation;
        if (observation) this.confirm(command, observation);
      },
      validateRead: (command, observation) => {
        const latest = this.lastObservations.get(command.target)?.observation
          .sourceUpdatedAt;
        if (
          observation.target !== command.target ||
          !MusicObservationValuesSchema.safeParse(observation.values).success ||
          typeof observation.available !== 'boolean' ||
          !Number.isFinite(observation.observedAt) ||
          observation.observedAt > clock.now() ||
          observation.observedAt <
            (command.recovery?.lastAttemptAt ?? command.issuedAt) ||
          (observation.sourceUpdatedAt !== undefined &&
            (!Number.isFinite(observation.sourceUpdatedAt) ||
              observation.sourceUpdatedAt < 0 ||
              observation.sourceUpdatedAt > clock.now() ||
              (latest !== undefined &&
                observation.sourceUpdatedAt < latest))) ||
          (observation.playbackChangedAt !== undefined &&
            (!Number.isFinite(observation.playbackChangedAt) ||
              observation.playbackChangedAt < 0 ||
              observation.playbackChangedAt > clock.now()))
        )
          return 'invalid_readback';
        return null;
      },
    });
    for (const [id, sources] of Object.entries(options.targets ?? {})) {
      const target = SemanticMusicIdSchema.parse(id);
      if (
        sources.some(
          (source) => typeof source !== 'string' || source.length === 0,
        ) ||
        new Set(sources).size !== sources.length
      )
        throw new Error(`Invalid allowed sources for ${target}`);
      this.state.devices[target] = {
        observed: {
          playback: 'unknown',
          volume: null,
          source: null,
          title: null,
        },
        requested: {},
        availability: 'unavailable',
        observedAt: null,
        observedProvenance: null,
        allowedSources: [...sources],
      };
    }
    this.unsubscribe = this.adapter.subscribe((observation) =>
      this.observe(observation),
    );
  }
  getState(target: string): DeviceMusicState {
    return structuredClone(this.requireTarget(target));
  }
  setExternalVolumeChangeHandler(
    handler: (target: string, volume: number, provenance: Provenance) => void,
  ): void {
    this.onExternalVolumeChange = handler;
  }
  setVolumeRequestGuard(
    handler: (target: string, provenance: Provenance) => void,
  ): void {
    this.volumeRequestGuard = handler;
  }
  setRecoveryPolicyGuard(
    handler: (command: MusicCommandRecord) => string | null,
  ): void {
    this.recoveryPolicyGuard = handler;
  }
  private intentDomain(request: MusicRequest): 'volume' | 'playback' {
    return request.property === 'volume' ? 'volume' : 'playback';
  }
  private bumpIntent(target: string, domain: 'volume' | 'playback'): void {
    const generations = this.intentGenerations.get(target) ?? {
      volume: 0,
      playback: 0,
    };
    generations[domain]++;
    this.intentGenerations.set(target, generations);
    for (const command of this.state.commands)
      if (
        command.target === target &&
        this.intentDomain(command.requested) === domain
      )
        this.recovery.stop(command.id, 'superseded', false);
  }
  restorePauseIntent(target: string, createdAt: number): void {
    this.requireTarget(target);
    this.latestPlaybackIntentAt.set(target, createdAt);
  }
  setExternalPlaybackChangeHandler(
    handler: (
      target: string,
      playback: MusicObservation['values']['playback'],
      provenance: Provenance,
    ) => void,
  ): void {
    this.onExternalPlaybackChange = handler;
  }
  setFadeLifecycleHandler(
    handler: (event: MusicFadeLifecycleEvent) => void,
  ): void {
    this.onFadeLifecycle = handler;
  }
  async request(
    target: string,
    rawRequest: MusicRequest,
    provenance: Provenance,
  ): Promise<MusicCommandRecord> {
    const requested = MusicRequestSchema.parse(rawRequest);
    if (requested.property === 'volume')
      this.volumeRequestGuard?.(target, provenance);
    if (requested.property === 'volume')
      this.stopFade(
        target,
        'Superseded by a direct volume request',
        'cancelled',
      );
    return this.issueRequest(target, requested, provenance);
  }

  startFade(
    rawRequest: MusicFadeRequest,
    provenance: Provenance,
  ): MusicFadeState {
    const request = MusicFadeRequestSchema.parse(rawRequest);
    const device = this.requireTarget(request.target);
    const normalizedProvenance = ProvenanceSchema.parse(provenance);
    this.volumeRequestGuard?.(request.target, normalizedProvenance);
    const observationAt = device.observedAt;
    const startVolume = device.observed.volume;
    if (
      device.availability !== 'available' ||
      startVolume === null ||
      observationAt === null ||
      this.clock.now() - observationAt > this.timeoutMs
    )
      throw new MusicFadeUnavailableError();

    const stepCount = Math.max(
      1,
      Math.ceil(Math.abs(request.volume - startVolume) / MUSIC_FADE_STEP_SIZE),
    );
    if (
      stepCount > 50 ||
      request.durationMs < stepCount * MUSIC_FADE_MIN_STEP_INTERVAL_MS
    )
      throw new MusicFadeDurationError();
    if (isHumanActor(normalizedProvenance.actor))
      this.latestHumanVolumeIntent.set(request.target, {
        sequence: this.nextCommandId,
        at: this.clock.now(),
      });
    this.bumpIntent(request.target, 'volume');
    this.stopFade(
      request.target,
      'Replaced by a newer volume fade',
      'cancelled',
      false,
    );
    const now = this.clock.now();
    const state: MusicFadeState = {
      id: `music-fade-${++this.nextFadeId}`,
      target: request.target,
      startVolume,
      targetVolume: request.volume,
      durationMs: request.durationMs,
      startedAt: now,
      expectedVolume: startVolume,
      observedVolume: startVolume,
      issuedVolume: null,
      status: 'active',
    };
    const runtime: MusicFadeRuntime = {
      state,
      provenance: {
        ...normalizedProvenance,
        source: normalizedProvenance.source ?? 'music.fadeVolume',
        reason: normalizedProvenance.reason ?? 'Explicit volume fade',
      },
      stepCount,
      stepIndex: 0,
      intervalMs: request.durationMs / stepCount,
      previousObservedVolume: startVolume,
      latestSequence: this.observedSequence.get(request.target) ?? 0,
      baselineSequence: this.observedSequence.get(request.target) ?? 0,
      commandId: undefined,
      accepted: false,
      timer: undefined,
      deadlineTimer: undefined,
    };
    this.state.fades[request.target] = state;
    this.fades.set(request.target, runtime);
    this.notifyFadeLifecycle(runtime, 'started');
    if (Math.abs(request.volume - startVolume) <= Number.EPSILON) {
      this.beginSettling(runtime);
    } else {
      this.scheduleFade(runtime, runtime.intervalMs, () => {
        void this.issueFadeStep(runtime);
      });
      runtime.deadlineTimer = this.clock.setTimeout(() => {
        runtime.deadlineTimer = undefined;
        this.finishFade(
          runtime,
          'unconfirmed',
          'Fade exceeded its bounded completion window',
        );
      }, request.durationMs + MUSIC_FADE_MAX_EXTENSION_MS);
    }
    this.publish();
    return structuredClone(state);
  }

  cancelFade(target: string): MusicFadeState | null {
    SemanticMusicIdSchema.parse(target);
    this.bumpIntent(target, 'volume');
    const runtime = this.fades.get(target);
    if (!runtime) {
      const current = this.state.fades[target];
      return current ? structuredClone(current) : null;
    }
    this.stopFade(target, 'Cancelled by request', 'cancelled');
    this.publish();
    return structuredClone(runtime.state);
  }

  private async issueRequest(
    target: string,
    rawRequest: MusicRequest,
    provenance: Provenance,
    recover = true,
  ): Promise<MusicCommandRecord> {
    const device = this.requireTarget(target);
    const requested = MusicRequestSchema.parse(rawRequest);
    const normalizedProvenance = ProvenanceSchema.parse(provenance);
    if (requested.property === 'volume')
      this.volumeRequestGuard?.(target, normalizedProvenance);
    if (
      requested.property === 'source' &&
      !device.allowedSources.includes(requested.value)
    )
      throw new Error(`Source is not allowed for ${target}`);
    if (recover) this.bumpIntent(target, this.intentDomain(requested));
    const supersededIds = new Set<string>();
    for (const prior of this.state.commands) {
      if (
        prior.target === target &&
        prior.requested.property === requested.property &&
        prior.status === 'pending'
      ) {
        prior.status = 'superseded';
        this.releaseTracking(prior.id);
        supersededIds.add(prior.id);
      }
    }
    this.pruneHistory(supersededIds);
    const command: MusicCommandRecord = {
      id: `music-command-${++this.nextCommandId}`,
      target,
      requested,
      issuedAt: this.clock.now(),
      status: 'pending',
      provenance: {
        ...normalizedProvenance,
        source: normalizedProvenance.source ?? 'capability',
        reason: normalizedProvenance.reason ?? 'Explicit music adjustment',
      },
    };
    this.commandSequences.set(command.id, this.nextCommandId);
    if (
      requested.property === 'volume' &&
      isHumanActor(normalizedProvenance.actor)
    )
      this.latestHumanVolumeIntent.set(target, {
        sequence: this.nextCommandId,
        at: command.issuedAt,
      });
    if (requested.property === 'playback' || requested.property === 'preset')
      this.latestPlaybackIntentAt.set(target, command.issuedAt);
    Object.assign(device.requested, { [requested.property]: requested.value });
    this.state.commands.push(command);
    this.issuedSequence.set(command.id, this.observedSequence.get(target) ?? 0);
    if (recover) {
      const domain = this.intentDomain(requested);
      const generation = this.intentGenerations.get(target)![domain];
      const authorization =
        this.recoveryPolicyGuard?.(command) ??
        (this.recoveryPolicyGuard ? null : 'controller');
      const valid = (): MusicRecoveryStopReason | null => {
        if (this.disposed) return 'disposed';
        if (this.intentGenerations.get(target)?.[domain] !== generation)
          return 'superseded';
        if (
          authorization === null ||
          (this.recoveryPolicyGuard &&
            this.recoveryPolicyGuard(command) !== authorization)
        )
          return 'policy_changed';
        return null;
      };
      this.recoveryGuards.set(command.id, valid);
      this.recovery.start(
        command,
        valid,
        requested.property === 'playback' &&
          device.availability === 'available' &&
          device.observed.source !== null &&
          device.observed.source.length > 0
          ? device.observed.source
          : undefined,
      );
    } else
      this.timers.set(
        command.id,
        this.clock.setTimeout(() => {
          this.timers.delete(command.id);
          if (command.status !== 'pending') return;
          this.timeoutCommand(command);
        }, this.timeoutMs),
      );
    this.publish();
    let confirmedFromDispatch = false;
    try {
      if (this.disposed || (recover && command.status !== 'pending'))
        return structuredClone(command);
      if (requested.property === 'volume')
        this.volumeRequestGuard?.(target, normalizedProvenance);
      this.dispatchingCommands.add(command.id);
      await this.adapter.dispatch({ id: command.id, target, requested });
      if (this.disposed) return structuredClone(command);
      command.acceptedAt = this.clock.now();
      this.recovery.accepted(command.id);
      const observation = this.lastObservations.get(target)?.observation;
      if (observation)
        confirmedFromDispatch = this.confirm(command, observation);
    } catch {
      if (this.disposed) throw new Error(`Music command failed for ${target}`);
      if (command.status === 'pending' || command.status === 'unconfirmed') {
        command.status = 'failed';
        this.recovery.stop(command.id, 'dispatch_failed');
        command.diagnosticReason =
          'Music adapter rejected or failed the request';
        this.releaseTracking(command.id);
        this.clearRequestedIfSettled(command);
        this.pruneHistory(new Set([command.id]));
      }
      this.publish();
      throw new Error(`Music command failed for ${target}`);
    } finally {
      this.dispatchingCommands.delete(command.id);
    }
    this.pruneHistory(
      confirmedFromDispatch ? new Set([command.id]) : undefined,
    );
    this.publish();
    return structuredClone(command);
  }
  dispose(): void {
    this.disposed = true;
    this.recovery.dispose();
    this.unsubscribe();
    this.attributedSupersededVolumeCommands.clear();
    for (const timer of this.timers.values()) this.clock.clearTimeout(timer);
    this.timers.clear();
    for (const fade of this.fades.values()) this.clearFadeTimers(fade);
    this.fades.clear();
    this.issuedSequence.clear();
    this.latestPlaybackIntentAt.clear();
    this.latestPlaybackChangedAt.clear();
    this.latestHumanVolumeIntent.clear();
    this.latestExternalPlaybackIntent.clear();
    this.commandSequences.clear();
    this.dispatchingCommands.clear();
    this.attributedOlderAutomaticVolumeCommands.clear();
    this.intentGenerations.clear();
    this.recoveryGuards.clear();
  }

  private scheduleFade(
    runtime: MusicFadeRuntime,
    delayMs: number,
    callback: () => void,
  ): void {
    if (runtime.timer !== undefined) this.clock.clearTimeout(runtime.timer);
    runtime.timer = undefined;
    runtime.timer = this.clock.setTimeout(() => {
      runtime.timer = undefined;
      if (this.fades.get(runtime.state.target) === runtime) callback();
    }, delayMs);
  }

  private clearFadeStepTimer(runtime: MusicFadeRuntime): void {
    if (runtime.timer !== undefined) this.clock.clearTimeout(runtime.timer);
    runtime.timer = undefined;
  }

  private clearFadeTimers(runtime: MusicFadeRuntime): void {
    this.clearFadeStepTimer(runtime);
    if (runtime.deadlineTimer !== undefined)
      this.clock.clearTimeout(runtime.deadlineTimer);
    runtime.deadlineTimer = undefined;
  }

  private async issueFadeStep(runtime: MusicFadeRuntime): Promise<void> {
    if (this.fades.get(runtime.state.target) !== runtime) return;
    if (this.fadeDispatching.has(runtime.state.target)) {
      this.scheduleFade(runtime, MUSIC_FADE_MIN_STEP_INTERVAL_MS, () => {
        void this.issueFadeStep(runtime);
      });
      return;
    }
    this.fadeDispatching.add(runtime.state.target);
    const step = runtime.stepIndex + 1;
    const volume =
      step === runtime.stepCount
        ? runtime.state.targetVolume
        : runtime.state.startVolume +
          ((runtime.state.targetVolume - runtime.state.startVolume) * step) /
            runtime.stepCount;
    runtime.baselineSequence =
      this.observedSequence.get(runtime.state.target) ?? 0;
    runtime.commandId = undefined;
    runtime.accepted = false;
    runtime.state.issuedVolume = volume;
    runtime.state.expectedVolume = volume;
    try {
      const command = await this.issueRequest(
        runtime.state.target,
        { property: 'volume', value: volume },
        this.fadeProvenance(runtime, step),
        false,
      );
      if (this.fades.get(runtime.state.target) !== runtime) return;
      runtime.commandId = command.id;
      runtime.accepted = true;
      if (command.status === 'failed') {
        this.finishFade(
          runtime,
          'failed',
          'Home Assistant rejected a fade step',
        );
        return;
      }
      this.scheduleFade(runtime, this.timeoutMs, () => {
        this.finishFade(
          runtime,
          'unconfirmed',
          'No matching volume feedback before the fade step timeout',
        );
      });
      const latest = this.lastObservations.get(runtime.state.target);
      const sequence = this.observedSequence.get(runtime.state.target) ?? 0;
      if (
        latest &&
        !latest.staleVolumeFeedback &&
        sequence > runtime.baselineSequence
      )
        this.acceptFadeObservation(runtime, latest.observation, sequence);
    } catch {
      this.finishFade(
        runtime,
        'failed',
        'Home Assistant could not dispatch a fade step',
      );
    } finally {
      this.fadeDispatching.delete(runtime.state.target);
    }
    this.publish();
  }

  private fadeProvenance(runtime: MusicFadeRuntime, step: number): Provenance {
    return ProvenanceSchema.parse({
      ...runtime.provenance,
      reason: `Volume fade step ${step}/${runtime.stepCount}`,
    });
  }

  private acceptFadeObservation(
    runtime: MusicFadeRuntime,
    observation: MusicObservation,
    sequence: number,
  ): void {
    const state = runtime.state;
    const volume = observation.values.volume;
    if (
      this.fades.get(state.target) !== runtime ||
      sequence <= runtime.latestSequence
    )
      return;
    state.observedVolume = volume;
    // HA can publish the requested value before its service call returns.
    // Defer consuming that observation until the command is accepted so the
    // regular command ledger remains the authority for confirmation.
    if (!runtime.accepted && state.issuedVolume !== null) return;
    runtime.latestSequence = sequence;
    if (!observation.available || volume === null) {
      this.finishFade(
        runtime,
        'interrupted',
        'Music target became unavailable during the fade',
      );
      return;
    }
    if (state.status === 'settling') {
      if (Math.abs(volume - state.targetVolume) > MUSIC_FADE_TOLERANCE)
        this.finishFade(
          runtime,
          'interrupted',
          'Observed volume moved away from the fade target while settling',
        );
      return;
    }
    if (runtime.accepted && runtime.commandId && state.issuedVolume !== null) {
      const low = Math.min(runtime.previousObservedVolume, state.issuedVolume);
      const high = Math.max(runtime.previousObservedVolume, state.issuedVolume);
      if (
        volume < low - MUSIC_FADE_TOLERANCE ||
        volume > high + MUSIC_FADE_TOLERANCE
      ) {
        this.finishFade(
          runtime,
          'interrupted',
          'Observed volume left the expected fade trajectory',
        );
        return;
      }
      const command = this.state.commands.find(
        (candidate) => candidate.id === runtime.commandId,
      );
      if (
        command?.status === 'confirmed' &&
        Math.abs(volume - state.issuedVolume) <= MUSIC_FADE_TOLERANCE
      ) {
        this.clearFadeStepTimer(runtime);
        runtime.stepIndex += 1;
        runtime.previousObservedVolume = volume;
        runtime.commandId = undefined;
        runtime.accepted = false;
        state.issuedVolume = null;
        if (runtime.stepIndex >= runtime.stepCount) {
          this.beginSettling(runtime);
        } else {
          state.expectedVolume = volume;
          this.scheduleFade(runtime, runtime.intervalMs, () => {
            void this.issueFadeStep(runtime);
          });
        }
      }
      return;
    }

    if (
      Math.abs(volume - runtime.previousObservedVolume) > MUSIC_FADE_TOLERANCE
    ) {
      this.finishFade(
        runtime,
        'interrupted',
        'Observed volume changed while the fade was waiting to dispatch',
      );
    }
    runtime.previousObservedVolume = volume;
    state.expectedVolume = volume;
  }

  private beginSettling(runtime: MusicFadeRuntime): void {
    this.clearFadeStepTimer(runtime);
    runtime.state.status = 'settling';
    runtime.state.expectedVolume = runtime.state.targetVolume;
    runtime.state.settlingUntil = this.clock.now() + MUSIC_FADE_SETTLING_MS;
    this.scheduleFade(runtime, MUSIC_FADE_SETTLING_MS, () => {
      this.finishFade(runtime, 'completed');
    });
  }

  private finishFade(
    runtime: MusicFadeRuntime,
    status: MusicFadeState['status'],
    diagnosticReason?: string,
  ): void {
    if (this.fades.get(runtime.state.target) !== runtime) return;
    this.clearFadeTimers(runtime);
    runtime.state.status = status;
    delete runtime.state.settlingUntil;
    if (diagnosticReason === undefined) delete runtime.state.diagnosticReason;
    else runtime.state.diagnosticReason = diagnosticReason;
    this.fades.delete(runtime.state.target);
    this.notifyFadeLifecycle(runtime, 'terminal');
    this.publish();
  }

  private stopFade(
    target: string,
    reason: string,
    status: 'cancelled' | 'interrupted',
    publish = false,
  ): void {
    const runtime = this.fades.get(target);
    if (!runtime) return;
    this.clearFadeTimers(runtime);
    runtime.state.status = status;
    runtime.state.diagnosticReason = reason;
    delete runtime.state.settlingUntil;
    this.fades.delete(target);
    this.notifyFadeLifecycle(runtime, 'terminal');
    if (publish) this.publish();
  }
  private requireTarget(target: string): DeviceMusicState {
    SemanticMusicIdSchema.parse(target);
    const device = this.state.devices[target];
    if (!device) throw new Error(`Unknown semantic music target: ${target}`);
    return device;
  }
  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) this.clock.clearTimeout(timer);
    this.timers.delete(id);
  }
  private timeoutCommand(command: MusicCommandRecord, publish = true): void {
    if (command.status === 'pending') {
      command.status = 'unconfirmed';
      command.diagnosticReason = 'No matching music feedback before timeout';
    }
    this.issuedSequence.delete(command.id);
    this.clearRequestedIfSettled(command);
    this.pruneHistory(new Set([command.id]));
    if (publish && !this.disposed) this.publish();
  }
  private releaseTracking(id: string): void {
    this.recovery.stop(id, 'feedback_confirmed', false);
    this.recoveryGuards.delete(id);
    this.clearTimer(id);
    this.issuedSequence.delete(id);
    this.attributedSupersededVolumeCommands.delete(id);
  }
  private pruneHistory(protectedIds: ReadonlySet<string> = new Set()): void {
    let terminalCount = this.state.commands.reduce(
      (count, command) =>
        count +
        (command.status === 'pending' || this.recovery.has(command.id) ? 0 : 1),
      0,
    );
    for (
      let index = 0;
      terminalCount > MAX_RETAINED_TERMINAL_COMMANDS &&
      index < this.state.commands.length;
    ) {
      const command = this.state.commands[index];
      if (
        command &&
        command.status !== 'pending' &&
        !this.recovery.has(command.id) &&
        !protectedIds.has(command.id)
      ) {
        this.state.commands.splice(index, 1);
        this.commandSequences.delete(command.id);
        this.attributedOlderAutomaticVolumeCommands.delete(command.id);
        this.releaseTracking(command.id);
        terminalCount -= 1;
      } else {
        index += 1;
      }
    }
    // A completion can arrive for a command that was old but still pending.
    // If every retained terminal was protected in this batch, enforce the cap
    // by dropping the oldest terminal record as a last resort.
    for (let index = 0; terminalCount > MAX_RETAINED_TERMINAL_COMMANDS;) {
      const command = this.state.commands[index];
      if (
        command &&
        command.status !== 'pending' &&
        !this.recovery.has(command.id)
      ) {
        this.state.commands.splice(index, 1);
        this.commandSequences.delete(command.id);
        this.attributedOlderAutomaticVolumeCommands.delete(command.id);
        this.releaseTracking(command.id);
        terminalCount -= 1;
      } else {
        index += 1;
      }
    }
  }
  private observe(observation: MusicObservation): void {
    const device = this.state.devices[observation.target];
    if (
      !device ||
      !MusicObservationValuesSchema.safeParse(observation.values).success ||
      !Number.isFinite(observation.observedAt) ||
      observation.observedAt < 0 ||
      observation.observedAt > this.clock.now() ||
      (device.observedAt !== null && observation.observedAt < device.observedAt)
    )
      return;
    const previousVolume = device.observed.volume;
    const previousPlayback = device.observed.playback;
    const sourceChanged =
      device.availability === 'available' &&
      observation.available &&
      device.observed.source !== null &&
      device.observed.source.length > 0 &&
      observation.values.source !== null &&
      observation.values.source.length > 0 &&
      device.observed.source !== observation.values.source;
    const observedVolume = observation.values.volume;
    const observedPlayback = observation.values.playback;
    const newPlaybackTransition = this.isNewPlaybackTransition(
      observation,
      previousPlayback,
    );
    const playbackChangedAt = observation.playbackChangedAt;
    if (
      observation.available &&
      observedPlayback !== 'unknown' &&
      playbackChangedAt !== undefined &&
      Number.isFinite(playbackChangedAt) &&
      playbackChangedAt >= 0 &&
      playbackChangedAt <= this.clock.now()
    )
      this.latestPlaybackChangedAt.set(
        observation.target,
        Math.max(
          this.latestPlaybackChangedAt.get(observation.target) ?? 0,
          playbackChangedAt,
        ),
      );
    const latePausePredatesNewerIntent =
      this.attributeLatePauseBeforeNewerIntent(observation, observedPlayback);
    const volumeChanged =
      observation.available &&
      previousVolume !== null &&
      observedVolume !== null &&
      Math.abs(observedVolume - previousVolume) > 0.005 + Number.EPSILON;
    // Report actual differences independently from the ownership noise tolerance.
    const reportedVolumeChanged =
      observation.available &&
      previousVolume !== null &&
      observedVolume !== null &&
      observedVolume !== previousVolume;
    const currentCorrelatedVolumeFeedback =
      observedVolume !== null &&
      this.matchesCurrentCorrelatedVolumeCommand(observation, observedVolume);
    const pendingVolumeCommand =
      observedVolume === null
        ? undefined
        : this.matchesRecentPendingVolumeCommand(observation, observedVolume);
    const olderVolumeCommand =
      volumeChanged && !currentCorrelatedVolumeFeedback
        ? this.attributeOlderAutomaticVolumeObservation(
            observation,
            observedVolume!,
          )
        : undefined;
    const supersededVolumeCommand =
      volumeChanged &&
      !currentCorrelatedVolumeFeedback &&
      !olderVolumeCommand &&
      !pendingVolumeCommand
        ? this.attributeSupersededVolumeObservation(
            observation,
            observedVolume!,
          )
        : undefined;
    const staleVolumeFeedback =
      !currentCorrelatedVolumeFeedback &&
      ((observation.available &&
        observedVolume !== null &&
        previousVolume !== null &&
        !volumeChanged &&
        this.lastObservations.get(observation.target)?.staleVolumeFeedback ===
          true &&
        !pendingVolumeCommand) ||
        (volumeChanged &&
          Boolean(olderVolumeCommand || supersededVolumeCommand)));
    const externalVolumeChange =
      volumeChanged &&
      !staleVolumeFeedback &&
      !currentCorrelatedVolumeFeedback &&
      !pendingVolumeCommand;
    const externalPlaybackChange =
      observation.available &&
      previousPlayback !== 'unknown' &&
      observedPlayback !== 'unknown' &&
      newPlaybackTransition &&
      !latePausePredatesNewerIntent &&
      !this.matchesRecentPendingPlaybackCommand(observation, observedPlayback);
    device.observed = structuredClone(observation.values);
    device.observedAt = observation.observedAt;
    device.availability = observation.available ? 'available' : 'unavailable';
    device.observedProvenance = ProvenanceSchema.parse(
      observation.provenance ?? {
        actor: { type: 'home_assistant' },
        source: 'external_observation',
      },
    );
    if (reportedVolumeChanged) {
      const correlated =
        observation.commandId === undefined
          ? undefined
          : this.state.commands.find(
              (candidate) =>
                candidate.id === observation.commandId &&
                candidate.target === observation.target &&
                candidate.requested.property === 'volume' &&
                (candidate.acceptedAt !== undefined ||
                  this.dispatchingCommands.has(candidate.id)) &&
                observation.observedAt >= candidate.issuedAt &&
                Math.abs(candidate.requested.value - observedVolume!) <=
                  0.005 + Number.EPSILON,
            );
      const command =
        correlated ??
        olderVolumeCommand ??
        supersededVolumeCommand ??
        (observation.commandId === undefined ||
        observation.commandId === pendingVolumeCommand?.id
          ? pendingVolumeCommand
          : undefined);
      this.state.volumeChanges ??= {};
      this.state.volumeChanges[observation.target] = {
        volume: observedVolume!,
        observedAt: observation.observedAt,
        provenance: structuredClone(
          command?.provenance ?? device.observedProvenance,
        ),
        attribution: command
          ? observation.commandId === command.id
            ? 'correlated'
            : 'matched'
          : 'external',
      };
    }
    const sequence = (this.observedSequence.get(observation.target) ?? 0) + 1;
    this.observedSequence.set(observation.target, sequence);
    this.lastObservations.set(observation.target, {
      observation: structuredClone(observation),
      staleVolumeFeedback,
    });
    const confirmedIds = new Set<string>();
    for (const command of [...this.state.commands])
      if (
        command.target === observation.target &&
        this.confirm(command, observation)
      )
        confirmedIds.add(command.id);
    // Source is in the playback ordering domain but is not a Play/Pause
    // request. Preserve ordinary feedback matching, then cancel old recovery
    // without manufacturing or releasing a Pause hold.
    if (sourceChanged) this.bumpIntent(observation.target, 'playback');
    if (externalVolumeChange && observedVolume !== null) {
      this.bumpIntent(observation.target, 'volume');
      this.latestHumanVolumeIntent.set(observation.target, {
        sequence: this.nextCommandId,
        at: this.clock.now(),
      });
      for (const command of this.state.commands) {
        if (
          command.target !== observation.target ||
          command.requested.property !== 'volume' ||
          command.status !== 'pending'
        )
          continue;
        command.status = 'superseded';
        command.diagnosticReason =
          'A newer external volume change superseded this request';
        this.releaseTracking(command.id);
        confirmedIds.add(command.id);
      }
      // An external adjustment is now the freshest desired value. Retaining a
      // prior request here would make the automation prefer stale state over
      // this observation when it calculates the next target.
      delete device.requested.volume;
      this.onExternalVolumeChange?.(
        observation.target,
        observedVolume,
        device.observedProvenance,
      );
      // External human intent cancels every future step even when the new value
      // happens to remain inside the previous fade's trajectory tolerance.
      this.stopFade(
        observation.target,
        'External volume intent interrupted the fade',
        'interrupted',
      );
    }
    if (externalPlaybackChange) {
      this.latestExternalPlaybackIntent.set(observation.target, {
        sequence: this.nextCommandId,
        changedAt: observation.playbackChangedAt,
        playback: observedPlayback as 'playing' | 'paused',
      });
      this.bumpIntent(observation.target, 'playback');
      for (const command of this.state.commands) {
        if (
          command.target !== observation.target ||
          command.requested.property !== 'playback' ||
          command.status !== 'pending'
        )
          continue;
        command.status = 'superseded';
        command.diagnosticReason =
          'A newer external playback change superseded this request';
        this.releaseTracking(command.id);
        confirmedIds.add(command.id);
      }
      delete device.requested.playback;
      this.onExternalPlaybackChange?.(
        observation.target,
        observedPlayback,
        device.observedProvenance,
      );
    }
    const fade = this.fades.get(observation.target);
    if (fade && !staleVolumeFeedback)
      this.acceptFadeObservation(fade, observation, sequence);
    this.pruneHistory(confirmedIds);
    this.publish();
  }
  private isNewPlaybackTransition(
    observation: MusicObservation,
    previousPlayback: MusicObservation['values']['playback'],
  ): boolean {
    const changedAt = observation.playbackChangedAt;
    if (changedAt === undefined)
      return observation.values.playback !== previousPlayback;
    if (
      !Number.isFinite(changedAt) ||
      changedAt < 0 ||
      changedAt > this.clock.now()
    )
      return false;
    // HA timestamps lose sub-millisecond ordering when parsed. A known
    // Playing -> Paused transition tied with the last request must yield to
    // Pause; the reverse tie must never release a manual Pause hold.
    if (
      previousPlayback === 'playing' &&
      observation.values.playback === 'paused' &&
      changedAt === this.latestPlaybackIntentAt.get(observation.target) &&
      changedAt >=
        (this.latestPlaybackChangedAt.get(observation.target) ??
          Number.NEGATIVE_INFINITY)
    )
      return true;
    const external = this.latestExternalPlaybackIntent.get(observation.target);
    // Equal HA timestamps can hide the ordering of physical Play then Pause.
    // Yield to the later paused report without letting equal-time Playing
    // feedback clear a manual Pause.
    if (
      previousPlayback === 'playing' &&
      observation.values.playback === 'paused' &&
      external?.playback === 'playing' &&
      changedAt === external.changedAt &&
      changedAt === this.latestPlaybackChangedAt.get(observation.target) &&
      changedAt >
        (this.latestPlaybackIntentAt.get(observation.target) ??
          Number.NEGATIVE_INFINITY)
    )
      return true;
    // last_updated advances for title/volume/availability snapshots too.
    // Only a playback transition newer than both the last intent and previous
    // transition can supersede intent, even if an intermediate state was missed.
    return (
      changedAt >
        (this.latestPlaybackIntentAt.get(observation.target) ??
          Number.NEGATIVE_INFINITY) &&
      changedAt >
        (this.latestPlaybackChangedAt.get(observation.target) ??
          Number.NEGATIVE_INFINITY)
    );
  }
  private matchesRecentPendingVolumeCommand(
    observation: MusicObservation,
    observedVolume: number,
  ): MusicCommandRecord | undefined {
    return [...this.state.commands]
      .reverse()
      .find(
        (command) =>
          command.target === observation.target &&
          command.requested.property === 'volume' &&
          command.status === 'pending' &&
          observation.observedAt >= command.issuedAt &&
          this.clock.now() -
            (command.recovery?.lastAttemptAt ?? command.issuedAt) <
            this.timeoutMs &&
          Math.abs(observedVolume - command.requested.value) <=
            0.005 + Number.EPSILON,
      );
  }
  private matchesCurrentCorrelatedVolumeCommand(
    observation: MusicObservation,
    volume: number,
  ): boolean {
    if (observation.commandId === undefined) return false;
    const command = [...this.state.commands]
      .reverse()
      .find(
        (candidate) =>
          candidate.target === observation.target &&
          candidate.requested.property === 'volume',
      );
    const intent = this.latestHumanVolumeIntent.get(observation.target);
    return (
      command !== undefined &&
      command.requested.property === 'volume' &&
      command.id === observation.commandId &&
      command.acceptedAt !== undefined &&
      (command.status === 'pending' || command.status === 'confirmed') &&
      observation.observedAt >= command.issuedAt &&
      Math.abs(volume - command.requested.value) <= 0.005 + Number.EPSILON &&
      !(
        intent !== undefined &&
        !isHumanActor(command.provenance.actor) &&
        (this.commandSequences.get(command.id) ?? Infinity) <= intent.sequence
      )
    );
  }

  private attributeOlderAutomaticVolumeObservation(
    observation: MusicObservation,
    observedVolume: number,
  ): MusicCommandRecord | undefined {
    const intent = this.latestHumanVolumeIntent.get(observation.target);
    const latestVolume = [...this.state.commands]
      .reverse()
      .find(
        (candidate) =>
          candidate.target === observation.target &&
          candidate.requested.property === 'volume',
      );
    // Correlated feedback remains feedback, regardless of delay or command
    // status. HA REST has no correlation: retain one bounded attribution for
    // an older accepted/in-flight automatic command after newer human intent.
    const command = [...this.state.commands]
      .reverse()
      .find(
        (candidate) =>
          candidate.target === observation.target &&
          candidate.requested.property === 'volume' &&
          (candidate.acceptedAt !== undefined ||
            this.dispatchingCommands.has(candidate.id)) &&
          Math.abs(observedVolume - candidate.requested.value) <=
            0.005 + Number.EPSILON &&
          (observation.commandId !== undefined
            ? observation.commandId === candidate.id &&
              (candidate.id !== latestVolume?.id ||
                candidate.status !== 'pending' ||
                (intent !== undefined &&
                  !isHumanActor(candidate.provenance.actor) &&
                  (this.commandSequences.get(candidate.id) ?? Infinity) <=
                    intent.sequence))
            : intent !== undefined &&
              !isHumanActor(candidate.provenance.actor) &&
              (this.commandSequences.get(candidate.id) ?? Infinity) <=
                intent.sequence &&
              this.clock.now() - intent.at < LATE_VOLUME_ATTRIBUTION_MS &&
              this.clock.now() -
                (candidate.recovery?.lastAttemptAt ?? candidate.issuedAt) <
                LATE_VOLUME_ATTRIBUTION_MS &&
              !this.attributedOlderAutomaticVolumeCommands.has(candidate.id)),
      );
    if (!command) return undefined;
    if (observation.commandId === undefined)
      this.attributedOlderAutomaticVolumeCommands.add(command.id);
    return command;
  }
  private attributeSupersededVolumeObservation(
    observation: MusicObservation,
    observedVolume: number,
  ): MusicCommandRecord | undefined {
    const superseded = [...this.state.commands]
      .reverse()
      .find(
        (command) =>
          command.target === observation.target &&
          command.requested.property === 'volume' &&
          command.status === 'superseded' &&
          command.acceptedAt !== undefined &&
          observation.observedAt >= command.issuedAt &&
          this.clock.now() -
            (command.recovery?.lastAttemptAt ?? command.issuedAt) <
            this.timeoutMs &&
          (observation.commandId === undefined ||
            observation.commandId === command.id) &&
          !this.attributedSupersededVolumeCommands.has(command.id) &&
          !this.attributedOlderAutomaticVolumeCommands.has(command.id) &&
          Math.abs(observedVolume - command.requested.value) <=
            0.005 + Number.EPSILON,
      );
    if (!superseded) return undefined;
    // HA may report an accepted older step after it has been superseded. Consume
    // that attribution once, without confirming or discarding the newer target.
    // A later physical adjustment to the same level remains external.
    this.attributedSupersededVolumeCommands.add(superseded.id);
    return superseded;
  }
  private pauseAttributionPredatesExternalIntent(
    command: MusicCommandRecord,
    observation: MusicObservation,
  ): boolean {
    const external = this.latestExternalPlaybackIntent.get(command.target);
    if (
      !external ||
      (this.commandSequences.get(command.id) ?? Infinity) > external.sequence
    )
      return true;
    // Ordering survives equal issue times and bounded command history. Only
    // explicitly historical feedback may still describe the older Pause.
    return (
      observation.playbackChangedAt !== undefined &&
      external.changedAt !== undefined &&
      observation.playbackChangedAt < external.changedAt
    );
  }
  private attributeLatePauseBeforeNewerIntent(
    observation: MusicObservation,
    observedPlayback: MusicObservation['values']['playback'],
  ): boolean {
    const playbackChangedAt = observation.playbackChangedAt;
    if (
      observedPlayback !== 'paused' ||
      playbackChangedAt === undefined ||
      !Number.isFinite(playbackChangedAt)
    )
      return false;
    const pause = [...this.state.commands]
      .reverse()
      .find(
        (command) =>
          command.target === observation.target &&
          command.requested.property === 'playback' &&
          command.requested.value === 'paused' &&
          (command.status === 'unconfirmed' ||
            command.status === 'superseded') &&
          command.acceptedAt !== undefined &&
          this.pauseAttributionPredatesExternalIntent(command, observation) &&
          playbackChangedAt >= command.issuedAt &&
          this.clock.now() -
            (command.recovery?.lastAttemptAt ?? command.issuedAt) <
            LATE_PAUSE_ATTRIBUTION_MS,
      );
    if (!pause) return false;
    const newerIntent = this.state.commands
      .slice(this.state.commands.indexOf(pause) + 1)
      .find(
        (command) =>
          command.target === observation.target &&
          (command.requested.property === 'playback' ||
            command.requested.property === 'preset') &&
          playbackChangedAt <= command.issuedAt,
      );
    if (!newerIntent) return false;
    pause.status = 'confirmed';
    pause.confirmedAt = playbackChangedAt;
    pause.diagnosticReason =
      'Paused state timestamp predates a newer playback request';
    this.releaseTracking(pause.id);
    this.clearRequestedIfSettled(pause);
    return true;
  }
  private matchesRecentPendingPlaybackCommand(
    observation: MusicObservation,
    observedPlayback: MusicObservation['values']['playback'],
  ): boolean {
    let commandIndex = -1;
    for (let index = this.state.commands.length - 1; index >= 0; index -= 1) {
      const command = this.state.commands[index];
      if (!command) continue;
      if (
        command.target !== observation.target ||
        command.requested.property !== 'playback' ||
        observation.observedAt < command.issuedAt ||
        observedPlayback !== command.requested.value
      )
        continue;
      const age =
        this.clock.now() -
        (command.recovery?.lastAttemptAt ?? command.issuedAt);
      const matches =
        command.status === 'pending'
          ? age < this.timeoutMs
          : (command.status === 'unconfirmed' ||
              command.status === 'superseded') &&
            command.acceptedAt !== undefined &&
            command.requested.value === 'paused' &&
            age < LATE_PAUSE_ATTRIBUTION_MS;
      if (
        matches &&
        (command.requested.value !== 'paused' ||
          this.pauseAttributionPredatesExternalIntent(command, observation))
      ) {
        commandIndex = index;
        break;
      }
    }
    if (commandIndex < 0) return false;
    const command = this.state.commands[commandIndex];
    if (!command) return false;
    const newerPlaybackIntent = this.state.commands
      .slice(commandIndex + 1)
      .some(
        (candidate) =>
          candidate.target === observation.target &&
          (candidate.requested.property === 'playback' ||
            candidate.requested.property === 'preset'),
      );
    if (newerPlaybackIntent) return false;
    // A source selection cancels retries, but does not request Play/Pause.
    // Consume accepted Pause feedback once, rather than creating or replacing a
    // durable manual Pause. Newer playback/preset intent still takes priority.
    if (command.status === 'unconfirmed' || command.status === 'superseded') {
      command.status = 'confirmed';
      command.confirmedAt = observation.observedAt;
      command.diagnosticReason =
        'Late Home Assistant pause feedback matched the latest accepted playback intent';
      this.releaseTracking(command.id);
      this.clearRequestedIfSettled(command);
    }
    return true;
  }
  private confirm(
    command: MusicCommandRecord,
    observation: MusicObservation,
  ): boolean {
    if (
      command.status !== 'pending' ||
      command.acceptedAt === undefined ||
      !observation.available ||
      observation.observedAt < command.issuedAt ||
      this.clock.now() -
        (command.recovery?.lastAttemptAt ?? command.issuedAt) >=
        this.timeoutMs ||
      (this.observedSequence.get(command.target) ?? 0) <=
        (this.issuedSequence.get(command.id) ?? 0) ||
      (observation.commandId !== undefined &&
        observation.commandId !== command.id)
    )
      return false;
    // Home Assistant does not expose WiiM's selected preset in the state
    // snapshot, so playback state alone must never claim a preset confirmed.
    if (command.requested.property === 'preset') return false;
    const { property, value } = command.requested;
    const actual = observation.values[property];
    const matches =
      property === 'volume'
        ? typeof actual === 'number' &&
          Math.abs(actual - Number(value)) <= 0.005 + Number.EPSILON
        : actual === value;
    if (!matches) return false;
    command.status = 'confirmed';
    command.confirmedAt = observation.observedAt;
    command.diagnosticReason =
      'Matching Home Assistant observation; attribution is not guaranteed';
    this.releaseTracking(command.id);
    this.clearRequestedIfSettled(command);
    return true;
  }

  private clearRequestedIfSettled(command: MusicCommandRecord): void {
    if (
      this.state.commands.some(
        (candidate) =>
          candidate.target === command.target &&
          candidate.requested.property === command.requested.property &&
          candidate.status === 'pending',
      )
    )
      return;
    const device = this.state.devices[command.target];
    if (!device) return;
    const current = device.requested[command.requested.property];
    if (current === command.requested.value)
      delete device.requested[command.requested.property];
  }

  private notifyFadeLifecycle(
    runtime: MusicFadeRuntime,
    phase: MusicFadeLifecycleEvent['phase'],
  ): void {
    this.onFadeLifecycle?.({
      phase,
      target: runtime.state.target,
      state: structuredClone(runtime.state),
      actualVolume: this.lastObservations.get(runtime.state.target)
        ?.staleVolumeFeedback
        ? runtime.state.observedVolume
        : (this.state.devices[runtime.state.target]?.observed.volume ?? null),
      provenance: structuredClone(runtime.provenance),
    });
  }
}
