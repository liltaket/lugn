import { MusicController, type MusicOptions } from './music-controller.js';
import type {
  MusicCommandRecord,
  MusicRequest,
  DeviceMusicState,
} from '../core/schemas.js';
import {
  SimulatedLightingAdapter,
  type LightingAdapter,
  type LightingObservation,
} from '../adapters/simulated-lighting.js';
import {
  SimulatedSwitchAdapter,
  type SwitchAdapter,
  type SwitchObservation,
} from '../adapters/simulated-switch.js';
import type { Clock, TimerHandle } from '../core/clock.js';
import { StateEventStream } from '../core/event-stream.js';
import {
  LightingProperties,
  LightingValuesSchema,
  PresenceEventSchema,
  PrelightEventSchema,
  RoomStateSchema,
  SceneSchema,
  SemanticLightingIdSchema,
  SemanticSwitchIdSchema,
  ProvenanceSchema,
  type DeviceSwitchState,
  type Provenance,
  type SwitchCommandRecord,
  type Actor,
  type Diagnostic,
  type FastPathTiming,
  type LightingScene,
  type LightingValues,
  type PresenceEvent,
  type PresenceInputEvent,
  type PrelightEvent,
  type RoomState,
  type StateUpdate,
} from '../core/schemas.js';
import { CommandLedger } from '../execution/command-ledger.js';

export type EngineOptions = {
  deviceIds?: string[];
  scenes?: LightingScene[];
  convergenceTimeoutMs?: number;
  retryDelayMs?: number;
  continuityMs?: number;
  commandAttributionWindowMs?: number;
  adapter?: LightingAdapter;
  switchDeviceIds?: string[];
  switchAdapter?: SwitchAdapter;
  switchFeedbackTimeoutMs?: number;
  music?: MusicOptions;
  stateHistoryLimit?: number;
  prelight?: {
    targets: Record<string, LightingValues>;
    maxDurationMs?: number;
  };
};

const systemActor: Actor = { type: 'automation', id: 'lugn.core' };

export const defaultScenes: LightingScene[] = [
  {
    id: 'scene.cozy',
    name: 'Cozy',
    lighting: {
      'lighting.ceiling': {
        power: true,
        brightness: 60,
        colorTemperature: 2400,
      },
      'lighting.desk': { power: true, brightness: 30, colorTemperature: 2400 },
    },
  },
  {
    id: 'scene.movie',
    name: 'Movie',
    lighting: {
      'lighting.ceiling': {
        power: true,
        brightness: 18,
        colorTemperature: 2200,
      },
      'lighting.desk': { power: false, brightness: 0, colorTemperature: 2200 },
    },
  },
];

type DeviceRuntime = RoomState['lighting']['devices'][string];
type IntentProvenance = {
  actor: Actor;
  source: string;
  requestId?: string;
  reason: string;
};

export class LugnEngine {
  readonly stream: StateEventStream;
  readonly ledger: CommandLedger;
  readonly adapter: LightingAdapter;
  readonly switchAdapter: SwitchAdapter;
  readonly scenes: ReadonlyMap<string, LightingScene>;
  readonly state: RoomState;
  private readonly musicController: MusicController;
  private readonly convergenceTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly continuityMs: number;
  private readonly switchFeedbackTimeoutMs: number;
  private readonly switchFeedbackTimers = new Map<string, TimerHandle>();
  private nextSwitchCommandId = 0;
  private readonly prelightTargets: Readonly<Record<string, LightingValues>>;
  private readonly prelightMaxDurationMs: number;
  private nextDiagnosticId = 0;
  private nextEventId = 0;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly retryTimers = new Map<string, TimerHandle>();
  private readonly convergenceStartedAt = new Map<number, number>();
  private readonly intentByRevision = new Map<number, IntentProvenance>();
  private readonly fastPathEventByCommand = new Map<string, string>();
  private prelightActive = false;
  private prelightTimer: TimerHandle | undefined;
  private prelightSnapshot = new Map<string, LightingValues>();

  constructor(
    private readonly clock: Clock,
    options: EngineOptions = {},
  ) {
    this.convergenceTimeoutMs = options.convergenceTimeoutMs ?? 60_000;
    this.retryDelayMs = options.retryDelayMs ?? 2_000;
    this.continuityMs = options.continuityMs ?? 20 * 60_000;
    this.switchFeedbackTimeoutMs = options.switchFeedbackTimeoutMs ?? 10_000;
    if (
      !Number.isFinite(this.switchFeedbackTimeoutMs) ||
      this.switchFeedbackTimeoutMs < 1 ||
      this.switchFeedbackTimeoutMs > 60_000
    )
      throw new Error('switchFeedbackTimeoutMs must be between 1 and 60000');
    this.prelightTargets = Object.fromEntries(
      Object.entries(options.prelight?.targets ?? {}).map(
        ([target, values]) => [
          SemanticLightingIdSchema.parse(target),
          LightingValuesSchema.parse(values),
        ],
      ),
    );
    this.prelightMaxDurationMs = options.prelight?.maxDurationMs ?? 5_000;
    if (
      !Number.isFinite(this.prelightMaxDurationMs) ||
      this.prelightMaxDurationMs < 1_000 ||
      this.prelightMaxDurationMs > 30_000
    )
      throw new Error('prelight.maxDurationMs must be between 1000 and 30000');
    this.adapter = options.adapter ?? new SimulatedLightingAdapter(clock);
    this.switchAdapter =
      options.switchAdapter ?? new SimulatedSwitchAdapter(clock);
    this.stream = new StateEventStream(options.stateHistoryLimit);
    this.ledger = new CommandLedger(clock, options.commandAttributionWindowMs);
    const scenes = (options.scenes ?? defaultScenes).map((scene) =>
      SceneSchema.parse(scene),
    );
    this.scenes = new Map(scenes.map((scene) => [scene.id, scene]));
    const devices: Record<string, DeviceRuntime> = {};
    for (const id of options.deviceIds ?? [
      'lighting.ceiling',
      'lighting.desk',
    ]) {
      const semanticId = SemanticLightingIdSchema.parse(id);
      devices[semanticId] = {
        observed: {},
        baselineDesired: {},
        effectiveDesired: {},
        ownership: {},
        availability: 'available',
      };
    }
    for (const target of Object.keys(this.prelightTargets))
      if (!devices[target])
        throw new Error(
          `Prelight target is not a configured device: ${target}`,
        );
    const switches: Record<string, DeviceSwitchState> = {};
    for (const id of options.switchDeviceIds ?? []) {
      const target = SemanticSwitchIdSchema.parse(id);
      if (switches[target])
        throw new Error(`Duplicate semantic switch: ${target}`);
      switches[target] = {
        observed: null,
        requested: null,
        availability: 'unavailable',
        observedAt: null,
        observedProvenance: null,
        requestedProvenance: null,
        latestCommandId: null,
      };
    }
    this.musicController = new MusicController(clock, options.music ?? {}, () =>
      this.publish(['music']),
    );
    this.state = {
      revision: 0,
      updatedAt: clock.now(),
      presence: {
        state: 'unknown',
        personCount: null,
        continuityExpiresAt: null,
      },
      lighting: { currentScene: null, sceneRevision: 0, devices },
      switches: { devices: switches, commands: [] },
      music: this.musicController.state,
      commands: this.ledger.records,
      diagnostics: [],
      timings: [],
    };
    this.unsubscribers.push(
      this.adapter.subscribe((observation) =>
        this.handleObservation(observation),
      ),
      this.switchAdapter.subscribe((observation) =>
        this.handleSwitchObservation(observation),
      ),
    );
    this.publish([
      'presence',
      'lighting',
      'switches',
      'music',
      'commands',
      'diagnostics',
      'timings',
    ]);
  }

  getMusicState(target: string): DeviceMusicState {
    return this.musicController.getState(target);
  }

  requestMusic(
    target: string,
    requested: MusicRequest,
    provenance: Provenance,
  ): Promise<MusicCommandRecord> {
    return this.musicController.request(target, requested, provenance);
  }

  getSwitchState(target: string): DeviceSwitchState {
    return structuredClone(this.requireSwitch(target));
  }

  async setSwitch(
    target: string,
    state: boolean,
    provenance: Provenance,
  ): Promise<SwitchCommandRecord> {
    const device = this.requireSwitch(target);
    if (typeof state !== 'boolean')
      throw new Error('Switch state must be a boolean');
    const normalizedProvenance = ProvenanceSchema.parse(provenance);
    for (const prior of this.state.switches.commands) {
      if (prior.target === target && prior.status === 'pending') {
        prior.status = 'superseded';
        this.clearSwitchFeedbackTimer(prior.id);
      }
    }
    const command: SwitchCommandRecord = {
      id: `switch-command-${++this.nextSwitchCommandId}`,
      target,
      requested: state,
      issuedAt: this.clock.now(),
      status: 'pending',
      provenance: {
        ...normalizedProvenance,
        source: normalizedProvenance.source ?? 'capability',
        reason: normalizedProvenance.reason ?? 'Explicit switch adjustment',
      },
    };
    device.requested = state;
    device.requestedProvenance = structuredClone(command.provenance);
    device.latestCommandId = command.id;
    this.state.switches.commands.push(command);
    this.switchFeedbackTimers.set(
      command.id,
      this.clock.setTimeout(() => {
        this.switchFeedbackTimers.delete(command.id);
        if (command.status !== 'pending') return;
        command.status = 'unconfirmed';
        command.diagnosticReason = 'No matching switch feedback before timeout';
        this.addDiagnostic(
          'switch.unconfirmed',
          `Switch command for ${target} was not confirmed before timeout`,
          { commandId: command.id, target },
        );
        this.publish(['switches', 'diagnostics']);
      }, this.switchFeedbackTimeoutMs),
    );
    this.publish(['switches']);
    try {
      await this.switchAdapter.dispatch({ id: command.id, target, state });
      command.acceptedAt = this.clock.now();
    } catch {
      // Adapters may include tokens in thrown request errors. Keep diagnostics fixed.
      if (command.status === 'pending' || command.status === 'unconfirmed') {
        command.status = 'failed';
        command.diagnosticReason =
          'Switch adapter rejected or failed the request';
        this.clearSwitchFeedbackTimer(command.id);
      }
      this.addDiagnostic(
        'switch.failed',
        `Switch command for ${target} failed`,
        { commandId: command.id, target },
      );
      this.publish(['switches', 'diagnostics']);
      throw new Error(`Switch command failed for ${target}`);
    }
    this.publish(['switches']);
    return structuredClone(command);
  }

  async activateScene(
    sceneId: string,
    actor: Actor = systemActor,
    source = 'capability',
    requestId?: string,
  ): Promise<number> {
    const scene = this.scenes.get(sceneId);
    if (!scene) throw new Error(`Unknown scene: ${sceneId}`);
    if (this.prelightActive) await this.finishPrelight(true, scene);
    this.beginScene(scene, {
      actor,
      source,
      ...(requestId === undefined ? {} : { requestId }),
      reason: 'Scene explicitly selected',
    });
    await this.reconcileScene(this.state.lighting.sceneRevision);
    return this.state.lighting.sceneRevision;
  }

  async reapplyScene(
    actor: Actor = systemActor,
    source = 'capability',
    requestId?: string,
  ): Promise<number> {
    const sceneId = this.state.lighting.currentScene;
    if (!sceneId) throw new Error('There is no active scene to reapply');
    return this.activateScene(sceneId, actor, source, requestId);
  }

  async setLighting(
    target: string,
    values: LightingValues,
    provenance: {
      actor: Actor;
      source?: string;
      reason?: string;
      requestId?: string;
    },
  ): Promise<void> {
    const device = this.requireDevice(target);
    await this.finishPrelight(
      true,
      undefined,
      new Map([[target, new Set(Object.keys(values))]]),
    );
    const source = provenance.source ?? 'capability';
    const reason = provenance.reason ?? 'Explicit lighting adjustment';
    this.ledger.supersedePending(
      'Superseded by explicit property adjustment',
      target,
    );
    const now = this.clock.now();
    for (const property of LightingProperties) {
      const value = values[property];
      if (value === undefined) continue;
      Object.assign(device.effectiveDesired, { [property]: value });
      device.ownership[property] = {
        kind: 'override',
        actor: provenance.actor,
        ...(provenance.source === undefined
          ? {}
          : { source: provenance.source }),
        reason,
        createdAt: now,
      };
    }
    this.addDiagnostic(
      'lighting.set',
      `Explicit property adjustment for ${target}`,
      { target, values, source, reason },
    );
    this.publish(['lighting', 'commands', 'diagnostics']);
    if (this.state.presence.state !== 'confirmed_empty')
      await this.dispatch(
        target,
        values,
        this.state.lighting.sceneRevision,
        source,
        reason,
        provenance.actor,
        provenance.requestId,
      );
  }

  async adjustBrightness(
    target: string,
    delta: number,
    actor: Actor,
    source = 'capability',
    requestId?: string,
  ): Promise<number> {
    const current =
      this.state.lighting.devices[target]?.observed.brightness ?? 0;
    const next = Math.min(100, Math.max(0, current + delta));
    await this.setLighting(
      target,
      { brightness: next },
      {
        actor,
        source,
        reason: `Brightness adjusted by ${delta}`,
        ...(requestId === undefined ? {} : { requestId }),
      },
    );
    return next;
  }

  async deviceBecameAvailable(target: string): Promise<void> {
    const device = this.requireDevice(target);
    device.availability = 'available';
    this.convergenceStartedAt.set(
      this.state.lighting.sceneRevision,
      this.clock.now(),
    );
    this.addDiagnostic(
      'device.available',
      `${target} is available again; reconciling current desired state`,
      { target },
    );
    this.publish(['lighting', 'diagnostics']);
    await this.reconcileScene(this.state.lighting.sceneRevision);
  }

  async handlePresence(event: PresenceEvent): Promise<void> {
    const normalizedEvent = PresenceEventSchema.parse(event);
    const receivedAt = this.clock.now();
    const previous = this.state.presence.state;
    const prelightWasActive = this.prelightActive;
    if (
      normalizedEvent.presence === 'confirmed_empty' ||
      normalizedEvent.presence === 'occupied'
    )
      this.clearPrelight();
    this.state.presence.state = normalizedEvent.presence;
    if (normalizedEvent.personCount !== undefined)
      this.state.presence.personCount = normalizedEvent.personCount;
    if (
      normalizedEvent.presence === 'confirmed_empty' &&
      (previous !== 'confirmed_empty' || prelightWasActive)
    ) {
      const fastPathEventId = `presence-${++this.nextEventId}`;
      this.state.timings.push({
        eventId: fastPathEventId,
        eventReceivedAt: receivedAt,
        decisionCompletedAt: this.clock.now(),
      });
      this.state.presence.continuityExpiresAt = receivedAt + this.continuityMs;
      this.cancelRetryTimers();
      this.ledger.supersedePending('Room became confirmed empty');
      this.addDiagnostic(
        'presence.empty',
        'Room confirmed empty; physical lights are switching off while logical state is retained',
        {
          currentScene: this.state.lighting.currentScene,
          expiresAt: this.state.presence.continuityExpiresAt,
        },
      );
      this.publish(['presence', 'commands', 'diagnostics', 'timings']);
      await Promise.all(
        Object.entries(this.state.lighting.devices).map(
          async ([target, device]) => {
            if (device.observed.power === false && !prelightWasActive) return;
            await this.dispatch(
              target,
              { power: false },
              this.state.lighting.sceneRevision,
              'presence',
              'Confirmed empty: physical off',
              systemActor,
              undefined,
              fastPathEventId,
            );
          },
        ),
      );
      const timing = this.state.timings.find(
        (entry) => entry.eventId === fastPathEventId,
      );
      const lightsAreOff = Object.values(this.state.lighting.devices).every(
        (device) => device.observed.power === false,
      );
      if (timing && lightsAreOff) timing.fullConvergenceAt = this.clock.now();
      this.publish(['commands', 'diagnostics', 'timings']);
      return;
    }
    if (normalizedEvent.presence === 'unknown') {
      this.addDiagnostic(
        'presence.unknown',
        'Presence is unknown; logical state and continuity were left unchanged',
        { previous },
      );
      this.publish(['presence', 'diagnostics']);
      return;
    }
    if (normalizedEvent.presence === 'occupied') {
      const expiry = this.state.presence.continuityExpiresAt;
      const withinContinuity = expiry !== null && receivedAt < expiry;
      if (expiry !== null && receivedAt >= expiry) this.expireContinuity();
      const returned = withinContinuity;
      this.state.presence.continuityExpiresAt = null;
      this.addDiagnostic(
        returned ? 'presence.returned' : 'presence.occupied',
        returned
          ? 'Room occupied again; restoring remembered effective lighting'
          : 'Room is occupied',
        { restoredContinuity: returned },
      );
      const timing: FastPathTiming = {
        eventId: `presence-${++this.nextEventId}`,
        eventReceivedAt: receivedAt,
        decisionCompletedAt: this.clock.now(),
      };
      this.state.timings.push(timing);
      this.publish(['presence', 'diagnostics', 'timings']);
      await this.reconcileScene(
        this.state.lighting.sceneRevision,
        timing.eventId,
      );
      return;
    }
    this.publish(['presence']);
  }

  async handleEvent(event: PresenceInputEvent): Promise<void> {
    const normalizedEvent = PrelightEventSchema.safeParse(event);
    if (normalizedEvent.success) {
      await this.handlePrelight(normalizedEvent.data);
      return;
    }
    await this.handlePresence(PresenceEventSchema.parse(event));
  }

  async handlePrelight(event: PrelightEvent): Promise<void> {
    const normalizedEvent = PrelightEventSchema.parse(event);
    if (normalizedEvent.active === this.prelightActive) return;

    if (!normalizedEvent.active) {
      await this.finishPrelight(this.state.presence.state !== 'occupied');
      return;
    }

    this.prelightActive = true;
    const eventId = `prelight-${++this.nextEventId}`;
    const receivedAt = this.clock.now();
    this.state.timings.push({
      eventId,
      eventReceivedAt: receivedAt,
      decisionCompletedAt: this.clock.now(),
    });
    this.prelightSnapshot = new Map();
    const dispatches: Promise<void>[] = [];
    for (const [target, values] of Object.entries(this.prelightTargets)) {
      const device = this.requireDevice(target);
      const snapshot = { ...device.observed, ...device.effectiveDesired };
      this.prelightSnapshot.set(target, snapshot);
      dispatches.push(
        this.dispatch(
          target,
          values,
          this.state.lighting.sceneRevision,
          normalizedEvent.source ?? 'prelight',
          'Possible entry: temporary prelight',
          systemActor,
          undefined,
          eventId,
        ),
      );
    }
    this.addDiagnostic(
      'presence.prelight',
      'Possible entry; temporary prelight dispatched',
      {
        source: normalizedEvent.source,
        targets: Object.keys(this.prelightTargets),
      },
    );
    this.publish(['diagnostics', 'timings']);
    this.prelightTimer = this.clock.setTimeout(() => {
      void this.finishPrelight(this.state.presence.state !== 'occupied');
    }, this.prelightMaxDurationMs);
    await Promise.all(dispatches);
  }

  async reconcileScene(
    revision = this.state.lighting.sceneRevision,
    eventId?: string,
  ): Promise<void> {
    if (
      revision !== this.state.lighting.sceneRevision ||
      this.state.presence.state === 'confirmed_empty'
    )
      return;
    const startedAt =
      this.convergenceStartedAt.get(revision) ?? this.clock.now();
    this.convergenceStartedAt.set(revision, startedAt);
    const dispatches: Promise<void>[] = [];
    const now = this.clock.now();
    let timedOut = false;
    for (const [target, device] of Object.entries(
      this.state.lighting.devices,
    )) {
      const desired: LightingValues = {};
      for (const property of LightingProperties) {
        const value = device.effectiveDesired[property];
        if (value === undefined || value === device.observed[property])
          continue;
        const pending = this.ledger.latestPending(target, property, value);
        if (pending && now - pending.issuedAt < this.retryDelayMs) continue;
        Object.assign(desired, { [property]: value });
      }
      if (Object.keys(desired).length === 0) continue;
      if (now - startedAt >= this.convergenceTimeoutMs) {
        device.availability = 'degraded';
        timedOut = true;
        this.ledger.cancelRevision(revision, 'Convergence timeout reached');
        this.addDiagnostic(
          'convergence.degraded',
          `${target} did not converge before timeout`,
          { target, revision },
        );
        continue;
      }
      if (device.availability === 'unavailable') continue;
      this.ledger.supersedePending(
        'Retrying an unconfirmed property command',
        target,
      );
      const intent = this.intentByRevision.get(revision) ?? {
        actor: systemActor,
        source: 'convergence',
        reason: 'Converge current desired state',
      };
      dispatches.push(
        this.dispatch(
          target,
          desired,
          revision,
          intent.source,
          intent.reason,
          intent.actor,
          intent.requestId,
          eventId,
        ),
      );
    }
    if (dispatches.length > 0) await Promise.all(dispatches);
    const converged = Object.values(this.state.lighting.devices).every(
      (device) =>
        LightingProperties.every((property) => {
          const desired = device.effectiveDesired[property];
          return desired === undefined || desired === device.observed[property];
        }),
    );
    if (converged) {
      this.clearRetryTimer(revision);
      this.addDiagnostic(
        'convergence.complete',
        'Effective lighting state matches observed state',
        { revision },
      );
      if (eventId) {
        const timing = this.state.timings.find(
          (candidate) => candidate.eventId === eventId,
        );
        if (timing) timing.fullConvergenceAt = this.clock.now();
      }
      this.publish(['lighting', 'commands', 'diagnostics', 'timings']);
      return;
    }
    if (!timedOut) {
      const remaining = Math.max(
        0,
        this.convergenceTimeoutMs - (this.clock.now() - startedAt),
      );
      this.scheduleRetry(revision, Math.min(this.retryDelayMs, remaining));
    } else {
      this.clearRetryTimer(revision);
    }
    this.publish(['lighting', 'commands', 'diagnostics']);
  }

  dispose(): void {
    this.cancelRetryTimers();
    this.clearPrelight();
    this.musicController.dispose();
    for (const handle of this.switchFeedbackTimers.values())
      this.clock.clearTimeout(handle);
    this.switchFeedbackTimers.clear();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
  }

  private requireSwitch(target: string): DeviceSwitchState {
    SemanticSwitchIdSchema.parse(target);
    const device = this.state.switches.devices[target];
    if (!device) throw new Error(`Unknown semantic switch: ${target}`);
    return device;
  }

  private clearSwitchFeedbackTimer(id: string): void {
    const timer = this.switchFeedbackTimers.get(id);
    if (timer !== undefined) this.clock.clearTimeout(timer);
    this.switchFeedbackTimers.delete(id);
  }

  private handleSwitchObservation(observation: SwitchObservation): void {
    const device = this.state.switches.devices[observation.target];
    if (!device) return;
    const now = this.clock.now();
    if (
      !Number.isFinite(observation.observedAt) ||
      observation.observedAt < 0 ||
      observation.observedAt > now ||
      (device.observedAt !== null && observation.observedAt < device.observedAt)
    )
      return;
    device.availability =
      observation.available && typeof observation.state === 'boolean'
        ? 'available'
        : 'unavailable';
    device.observed =
      device.availability === 'available' ? observation.state : null;
    device.observedAt = observation.observedAt;
    const command = this.state.switches.commands.find(
      (candidate) => candidate.id === device.latestCommandId,
    );
    const matches =
      command?.status === 'pending' &&
      command.requested === device.observed &&
      device.availability === 'available' &&
      observation.observedAt >= command.issuedAt &&
      now - command.issuedAt < this.switchFeedbackTimeoutMs &&
      (observation.commandId === undefined ||
        observation.commandId === command.id);
    if (matches && command) {
      command.status = 'confirmed';
      command.confirmedAt = observation.observedAt;
      device.observedProvenance = structuredClone(command.provenance);
      this.clearSwitchFeedbackTimer(command.id);
      this.addDiagnostic(
        'switch.confirmed',
        `Switch command for ${observation.target} confirmed by feedback`,
        { commandId: command.id, target: observation.target },
      );
    } else {
      device.observedProvenance = ProvenanceSchema.parse(
        observation.provenance ?? {
          actor: { type: 'home_assistant' },
          source: 'external_observation',
        },
      );
    }
    this.publish(['switches', 'diagnostics']);
  }

  private clearPrelight(): void {
    if (this.prelightTimer !== undefined)
      this.clock.clearTimeout(this.prelightTimer);
    this.prelightTimer = undefined;
    this.prelightActive = false;
    this.prelightSnapshot.clear();
  }

  private async finishPrelight(
    restore: boolean,
    scene?: LightingScene,
    excludedProperties: Map<string, Set<string>> = new Map(),
  ): Promise<void> {
    if (!this.prelightActive) return;
    if (this.prelightTimer !== undefined)
      this.clock.clearTimeout(this.prelightTimer);
    this.prelightTimer = undefined;
    this.prelightActive = false;
    const snapshot = this.prelightSnapshot;
    this.prelightSnapshot = new Map();
    if (!restore) return;

    const dispatches: Promise<void>[] = [];
    for (const [target, previousValues] of snapshot) {
      const device = this.state.lighting.devices[target];
      if (!device) continue;
      const values: LightingValues = {};
      const excluded = excludedProperties.get(target) ?? new Set<string>();
      const sceneValues = scene?.lighting[target] ?? {};
      const prelightValues = this.prelightTargets[target] ?? {};
      for (const property of LightingProperties) {
        if (
          excluded.has(property) ||
          sceneValues[property] !== undefined ||
          previousValues[property] === undefined
        )
          continue;
        const current = device.observed[property];
        if (current !== undefined && current !== prelightValues[property])
          continue;
        Object.assign(values, { [property]: previousValues[property] });
      }
      if (Object.keys(values).length > 0)
        dispatches.push(
          this.dispatch(
            target,
            values,
            this.state.lighting.sceneRevision,
            'prelight.restore',
            'Prelight ended before confirmed entry; restoring prior observed intent',
            systemActor,
          ),
        );
    }
    await Promise.all(dispatches);
  }

  private beginScene(scene: LightingScene, intent: IntentProvenance): void {
    const priorRevision = this.state.lighting.sceneRevision;
    this.clearRetryTimer(priorRevision);
    this.ledger.supersedePending(
      `Superseded by scene revision ${priorRevision + 1}`,
    );
    this.state.lighting.sceneRevision += 1;
    this.state.lighting.currentScene = scene.id;
    const revision = this.state.lighting.sceneRevision;
    this.convergenceStartedAt.set(revision, this.clock.now());
    this.intentByRevision.set(revision, intent);
    for (const device of Object.values(this.state.lighting.devices)) {
      device.baselineDesired = {};
      device.effectiveDesired = {};
      device.ownership = {};
    }
    for (const [target, values] of Object.entries(scene.lighting)) {
      const device = this.requireDevice(target);
      device.baselineDesired = { ...values };
      device.effectiveDesired = { ...values };
      device.ownership = {};
      for (const property of LightingProperties) {
        if (values[property] !== undefined)
          device.ownership[property] = { kind: 'scene', revision };
      }
    }
    this.addDiagnostic('scene.selected', `Scene ${scene.name} selected`, {
      scene: scene.id,
      revision,
      ...intent,
    });
    this.publish(['lighting', 'commands', 'diagnostics']);
  }

  private async dispatch(
    target: string,
    values: LightingValues,
    revision: number,
    source: string,
    reason: string,
    actor: Actor,
    requestId?: string,
    eventId?: string,
  ): Promise<void> {
    if (Object.keys(values).length === 0) return;
    const command = this.ledger.issue({
      target,
      controller: target,
      revision,
      desired: values,
      source,
      ...(requestId === undefined ? {} : { requestId }),
      reason,
      actor,
    });
    this.state.commands = this.ledger.records;
    this.publish(['commands']);
    if (eventId) {
      this.fastPathEventByCommand.set(command.id, eventId);
      const timing = this.state.timings.find(
        (entry) => entry.eventId === eventId,
      );
      if (timing && timing.commandDispatchedAt === undefined)
        timing.commandDispatchedAt = this.clock.now();
      this.publish(['timings']);
    }
    try {
      await this.adapter.dispatch({ id: command.id, target, values });
    } catch (error) {
      command.status = 'failed';
      command.diagnosticReason =
        error instanceof Error ? error.message : String(error);
      const device = this.state.lighting.devices[target];
      if (device) device.availability = 'unavailable';
      this.addDiagnostic('command.failed', `Command for ${target} failed`, {
        commandId: command.id,
        error: command.diagnosticReason,
      });
      this.publish(['commands', 'lighting', 'diagnostics']);
    }
  }

  private handleObservation(observation: LightingObservation): void {
    const device = this.state.lighting.devices[observation.target];
    if (!device) return;
    const feedbackTime = this.clock.now();
    for (const property of LightingProperties) {
      const value = observation.values[property];
      if (value === undefined) continue;
      const previouslyObserved = device.observed[property];
      Object.assign(device.observed, { [property]: value });
      const command = this.ledger.attributeObservation(
        observation.target,
        property,
        value,
        feedbackTime,
        observation.commandId,
      );
      if (
        !command &&
        previouslyObserved !== undefined &&
        previouslyObserved !== value
      ) {
        Object.assign(device.effectiveDesired, { [property]: value });
        device.ownership[property] = {
          kind: 'override',
          actor: observation.provenance?.actor ?? { type: 'user' },
          source: observation.provenance?.source ?? 'external_observation',
          reason: 'Observed change did not match a recent Lugn command',
          createdAt: feedbackTime,
        };
        this.addDiagnostic(
          'lighting.override',
          `${observation.target}.${property} externally changed`,
          {
            target: observation.target,
            property,
            value,
            reason: 'No matching recent command in ledger',
          },
        );
      } else if (command?.status === 'confirmed') {
        this.addDiagnostic(
          'command.confirmed',
          `Command ${command.id} confirmed by device feedback`,
          {
            commandId: command.id,
            target: command.target,
            revision: command.revision,
          },
        );
      }
    }
    const fastPathEventId = observation.commandId
      ? this.fastPathEventByCommand.get(observation.commandId)
      : undefined;
    const timing = fastPathEventId
      ? this.state.timings.find((entry) => entry.eventId === fastPathEventId)
      : undefined;
    if (timing && timing.feedbackObservedAt === undefined)
      timing.feedbackObservedAt = feedbackTime;
    const isStaleCommand =
      observation.commandId !== undefined &&
      observation.commandId !== this.latestCommandId(observation.target);
    if (isStaleCommand)
      this.addDiagnostic(
        'command.stale_feedback',
        'Feedback arrived for a superseded command; current intent remains authoritative',
        { commandId: observation.commandId },
      );
    this.publish(['lighting', 'commands', 'diagnostics', 'timings']);
    if (this.state.presence.state !== 'confirmed_empty') {
      void this.reconcileScene(
        this.state.lighting.sceneRevision,
        timing?.eventId,
      );
    } else if (isStaleCommand && observation.values.power === true) {
      const emptyTiming = [...this.state.timings]
        .reverse()
        .find((entry) => entry.commandDispatchedAt !== undefined);
      void this.dispatch(
        observation.target,
        { power: false },
        this.state.lighting.sceneRevision,
        'presence',
        'Reassert physical off after stale command feedback',
        systemActor,
        undefined,
        emptyTiming?.eventId,
      );
    }
  }

  private latestCommandId(target: string): string | undefined {
    return [...this.ledger.records]
      .reverse()
      .find((command) => command.target === target)?.id;
  }

  private expireContinuity(): void {
    this.state.lighting.currentScene = null;
    this.state.lighting.sceneRevision += 1;
    this.ledger.cancelRevision(
      this.state.lighting.sceneRevision - 1,
      'Continuity expired',
    );
    for (const device of Object.values(this.state.lighting.devices)) {
      device.baselineDesired = {};
      device.effectiveDesired = {};
      device.ownership = {};
    }
    this.state.presence.continuityExpiresAt = null;
    this.addDiagnostic(
      'continuity.expired',
      'Remembered scene and lighting overrides expired after confirmed absence',
      {},
    );
  }

  private requireDevice(target: string): DeviceRuntime {
    const device = this.state.lighting.devices[target];
    if (!device) throw new Error(`Unknown semantic lighting device: ${target}`);
    return device;
  }

  private addDiagnostic(
    kind: string,
    message: string,
    details: Record<string, unknown>,
  ): void {
    const record: Diagnostic = {
      id: this.nextDiagnosticId++,
      at: this.clock.now(),
      kind,
      message,
      details,
    };
    this.state.diagnostics.push(record);
  }

  private publish(
    domains: Array<
      | 'presence'
      | 'lighting'
      | 'switches'
      | 'music'
      | 'commands'
      | 'diagnostics'
      | 'timings'
    >,
  ): void {
    this.state.commands = this.ledger.records;
    this.state.revision += 1;
    this.state.updatedAt = this.clock.now();
    RoomStateSchema.parse(this.state);
    const patch: StateUpdate['patch'] = {};
    for (const domain of domains) {
      Object.assign(patch, {
        [domain]: structuredClone(this.state[domain]),
      });
    }
    this.stream.publish({
      revision: this.state.revision,
      at: this.state.updatedAt,
      domains,
      patch,
    });
  }

  private scheduleRetry(revision: number, delayMs: number): void {
    this.clearRetryTimer(revision);
    const handle = this.clock.setTimeout(() => {
      this.retryTimers.delete(String(revision));
      void this.reconcileScene(revision);
    }, delayMs);
    this.retryTimers.set(String(revision), handle);
  }

  private clearRetryTimer(revision: number): void {
    const key = String(revision);
    const handle = this.retryTimers.get(key);
    if (handle !== undefined) this.clock.clearTimeout(handle);
    this.retryTimers.delete(key);
  }

  private cancelRetryTimers(): void {
    for (const handle of this.retryTimers.values())
      this.clock.clearTimeout(handle);
    this.retryTimers.clear();
  }
}
