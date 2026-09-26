import {
  SimulatedMusicAdapter,
  type MusicAdapter,
  type MusicObservation,
} from '../adapters/simulated-music.js';
import type { Clock, TimerHandle } from '../core/clock.js';
import {
  MusicRequestSchema,
  MusicObservationValuesSchema,
  SemanticMusicIdSchema,
  ProvenanceSchema,
  type MusicCommandRecord,
  type MusicRequest,
  type MusicState,
  type DeviceMusicState,
  type Provenance,
} from '../core/schemas.js';

export type MusicOptions = {
  targets?: Record<string, string[]>;
  adapter?: MusicAdapter;
  feedbackTimeoutMs?: number;
};

/** Explicit music requests; no presence automation or ownership inference. */
export class MusicController {
  readonly state: MusicState = { devices: {}, commands: [] };
  private readonly adapter: MusicAdapter;
  private readonly timeoutMs: number;
  private readonly timers = new Map<string, TimerHandle>();
  private readonly observedSequence = new Map<string, number>();
  private readonly issuedSequence = new Map<string, number>();
  private readonly lastObservations = new Map<string, MusicObservation>();
  private readonly unsubscribe: () => void;
  private nextCommandId = 0;
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
  async request(
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
    for (const prior of this.state.commands) {
      if (
        prior.target === target &&
        prior.requested.property === requested.property &&
        prior.status === 'pending'
      ) {
        prior.status = 'superseded';
        this.clearTimer(prior.id);
      }
    }
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
        this.publish();
      }, this.timeoutMs),
    );
    this.publish();
    try {
      await this.adapter.dispatch({ id: command.id, target, requested });
      command.acceptedAt = this.clock.now();
      const observation = this.lastObservations.get(target);
      if (observation) this.confirm(command, observation);
    } catch {
      if (command.status === 'pending' || command.status === 'unconfirmed') {
        command.status = 'failed';
        command.diagnosticReason =
          'Music adapter rejected or failed the request';
        this.clearTimer(command.id);
      }
      this.publish();
      throw new Error(`Music command failed for ${target}`);
    }
    this.publish();
    return structuredClone(command);
  }
  dispose(): void {
    this.unsubscribe();
    for (const timer of this.timers.values()) this.clock.clearTimeout(timer);
    this.timers.clear();
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
    device.observed = structuredClone(observation.values);
    device.observedAt = observation.observedAt;
    device.availability = observation.available ? 'available' : 'unavailable';
    device.observedProvenance = ProvenanceSchema.parse(
      observation.provenance ?? {
        actor: { type: 'home_assistant' },
        source: 'external_observation',
      },
    );
    this.observedSequence.set(
      observation.target,
      (this.observedSequence.get(observation.target) ?? 0) + 1,
    );
    this.lastObservations.set(observation.target, structuredClone(observation));
    for (const command of this.state.commands)
      if (command.target === observation.target)
        this.confirm(command, observation);
    this.publish();
  }
  private confirm(
    command: MusicCommandRecord,
    observation: MusicObservation,
  ): void {
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
      return;
    const { property, value } = command.requested;
    const actual = observation.values[property];
    const matches =
      property === 'volume'
        ? typeof actual === 'number' &&
          Math.abs(actual - Number(value)) <= 0.005 + Number.EPSILON
        : actual === value;
    if (!matches) return;
    command.status = 'confirmed';
    command.confirmedAt = observation.observedAt;
    command.diagnosticReason =
      'Matching Home Assistant observation; attribution is not guaranteed';
    this.clearTimer(command.id);
  }
}
