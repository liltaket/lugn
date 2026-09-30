import {
  SimulatedMusicAdapter,
  type MusicAdapter,
  type MusicObservation,
} from '../adapters/simulated-music.js';
import type { Clock, TimerHandle } from '../core/clock.js';
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
} from '../core/schemas.js';

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
  private readonly timers = new Map<string, TimerHandle>();
  private readonly observedSequence = new Map<string, number>();
  private readonly issuedSequence = new Map<string, number>();
  private readonly lastObservations = new Map<string, MusicObservation>();
  private onExternalVolumeChange:
    ((target: string, volume: number) => void) | undefined;
  private onExternalPlaybackChange:
    | ((
        target: string,
        playback: MusicObservation['values']['playback'],
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
    handler: (target: string, volume: number) => void,
  ): void {
    this.onExternalVolumeChange = handler;
  }
  setExternalPlaybackChangeHandler(
    handler: (
      target: string,
      playback: MusicObservation['values']['playback'],
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
  ): Promise<MusicCommandRecord> {
    const device = this.requireTarget(target);
    const requested = MusicRequestSchema.parse(rawRequest);
    const normalizedProvenance = ProvenanceSchema.parse(provenance);
    if (
      requested.property === 'source' &&
      !device.allowedSources.includes(requested.value)
    )
      throw new Error(`Source is not allowed for ${target}`);
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
    Object.assign(device.requested, { [requested.property]: requested.value });
    this.state.commands.push(command);
    this.issuedSequence.set(command.id, this.observedSequence.get(target) ?? 0);
    this.timers.set(
      command.id,
      this.clock.setTimeout(() => {
        this.timers.delete(command.id);
        if (command.status !== 'pending') return;
        command.status = 'unconfirmed';
        command.diagnosticReason = 'No matching music feedback before timeout';
        this.issuedSequence.delete(command.id);
        this.clearRequestedIfSettled(command);
        this.pruneHistory(new Set([command.id]));
        this.publish();
      }, this.timeoutMs),
    );
    this.publish();
    let confirmedFromDispatch = false;
    try {
      await this.adapter.dispatch({ id: command.id, target, requested });
      command.acceptedAt = this.clock.now();
      const observation = this.lastObservations.get(target);
      if (observation)
        confirmedFromDispatch = this.confirm(command, observation);
    } catch {
      if (command.status === 'pending' || command.status === 'unconfirmed') {
        command.status = 'failed';
        command.diagnosticReason =
          'Music adapter rejected or failed the request';
        this.releaseTracking(command.id);
        this.clearRequestedIfSettled(command);
        this.pruneHistory(new Set([command.id]));
      }
      this.publish();
      throw new Error(`Music command failed for ${target}`);
    }
    this.pruneHistory(
      confirmedFromDispatch ? new Set([command.id]) : undefined,
    );
    this.publish();
    return structuredClone(command);
  }
  dispose(): void {
    this.unsubscribe();
    for (const timer of this.timers.values()) this.clock.clearTimeout(timer);
    this.timers.clear();
    for (const fade of this.fades.values()) this.clearFadeTimer(fade);
    this.fades.clear();
    this.issuedSequence.clear();
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

  private clearFadeTimer(runtime: MusicFadeRuntime): void {
    if (runtime.timer !== undefined) this.clock.clearTimeout(runtime.timer);
    runtime.timer = undefined;
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
      if (latest && sequence > runtime.baselineSequence)
        this.acceptFadeObservation(runtime, latest, sequence);
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
        this.clearFadeTimer(runtime);
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
    this.clearFadeTimer(runtime);
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
    this.clearFadeTimer(runtime);
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
    this.clearFadeTimer(runtime);
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
  private releaseTracking(id: string): void {
    this.clearTimer(id);
    this.issuedSequence.delete(id);
  }
  private pruneHistory(protectedIds: ReadonlySet<string> = new Set()): void {
    let terminalCount = this.state.commands.reduce(
      (count, command) => count + (command.status === 'pending' ? 0 : 1),
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
        !protectedIds.has(command.id)
      ) {
        this.state.commands.splice(index, 1);
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
      if (command && command.status !== 'pending') {
        this.state.commands.splice(index, 1);
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
    const observedVolume = observation.values.volume;
    const observedPlayback = observation.values.playback;
    const latePausePredatesNewerIntent =
      this.attributeLatePauseBeforeNewerIntent(observation, observedPlayback);
    const externalVolumeChange =
      observation.available &&
      previousVolume !== null &&
      observedVolume !== null &&
      Math.abs(observedVolume - previousVolume) > 0.005 + Number.EPSILON &&
      !this.matchesRecentPendingVolumeCommand(observation, observedVolume);
    const externalPlaybackChange =
      observation.available &&
      previousPlayback !== 'unknown' &&
      observedPlayback !== 'unknown' &&
      observedPlayback !== previousPlayback &&
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
    const sequence = (this.observedSequence.get(observation.target) ?? 0) + 1;
    this.observedSequence.set(observation.target, sequence);
    this.lastObservations.set(observation.target, structuredClone(observation));
    const confirmedIds = new Set<string>();
    for (const command of [...this.state.commands])
      if (
        command.target === observation.target &&
        this.confirm(command, observation)
      )
        confirmedIds.add(command.id);
    if (externalVolumeChange && observedVolume !== null) {
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
      this.onExternalVolumeChange?.(observation.target, observedVolume);
    }
    if (externalPlaybackChange) {
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
      this.onExternalPlaybackChange?.(observation.target, observedPlayback);
    } else if (
      !latePausePredatesNewerIntent &&
      device.requested.playback !== undefined &&
      observedPlayback !== device.requested.playback &&
      this.state.commands.some(
        (command) =>
          command.target === observation.target &&
          command.requested.property === 'playback' &&
          command.status === 'pending' &&
          command.acceptedAt !== undefined,
      )
    ) {
      // Once HA accepted a playback request, a newer contradictory state is
      // authoritative even when the transition's previous value was unknown.
      for (const command of this.state.commands) {
        if (
          command.target !== observation.target ||
          command.requested.property !== 'playback' ||
          command.status !== 'pending'
        )
          continue;
        command.status = 'superseded';
        command.diagnosticReason =
          'Observed playback state superseded this request';
        this.releaseTracking(command.id);
        confirmedIds.add(command.id);
      }
      delete device.requested.playback;
      this.onExternalPlaybackChange?.(observation.target, observedPlayback);
    }
    const fade = this.fades.get(observation.target);
    if (fade) this.acceptFadeObservation(fade, observation, sequence);
    this.pruneHistory(confirmedIds);
    this.publish();
  }
  private matchesRecentPendingVolumeCommand(
    observation: MusicObservation,
    observedVolume: number,
  ): boolean {
    return this.state.commands.some(
      (command) =>
        command.target === observation.target &&
        command.requested.property === 'volume' &&
        command.status === 'pending' &&
        observation.observedAt >= command.issuedAt &&
        this.clock.now() - command.issuedAt < this.timeoutMs &&
        Math.abs(observedVolume - command.requested.value) <=
          0.005 + Number.EPSILON,
    );
  }
  private attributeLatePauseBeforeNewerIntent(
    observation: MusicObservation,
    observedPlayback: MusicObservation['values']['playback'],
  ): boolean {
    const sourceUpdatedAt = observation.sourceUpdatedAt;
    if (
      observedPlayback !== 'paused' ||
      sourceUpdatedAt === undefined ||
      !Number.isFinite(sourceUpdatedAt)
    )
      return false;
    const pause = [...this.state.commands]
      .reverse()
      .find(
        (command) =>
          command.target === observation.target &&
          command.requested.property === 'playback' &&
          command.requested.value === 'paused' &&
          command.status === 'unconfirmed' &&
          command.acceptedAt !== undefined &&
          sourceUpdatedAt >= command.issuedAt &&
          this.clock.now() - command.issuedAt < LATE_PAUSE_ATTRIBUTION_MS,
      );
    if (!pause) return false;
    const newerIntent = this.state.commands
      .slice(this.state.commands.indexOf(pause) + 1)
      .find(
        (command) =>
          command.target === observation.target &&
          (command.requested.property === 'playback' ||
            command.requested.property === 'preset') &&
          sourceUpdatedAt <= command.issuedAt,
      );
    if (!newerIntent) return false;
    pause.status = 'confirmed';
    pause.confirmedAt = sourceUpdatedAt;
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
      const age = this.clock.now() - command.issuedAt;
      const matches =
        command.status === 'pending'
          ? age < this.timeoutMs
          : command.status === 'unconfirmed' &&
            command.acceptedAt !== undefined &&
            command.requested.value === 'paused' &&
            age < LATE_PAUSE_ATTRIBUTION_MS;
      if (matches) {
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
    if (command.status === 'unconfirmed') {
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
      this.clock.now() - command.issuedAt >= this.timeoutMs ||
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
      actualVolume:
        this.state.devices[runtime.state.target]?.observed.volume ?? null,
      provenance: structuredClone(runtime.provenance),
    });
  }
}
