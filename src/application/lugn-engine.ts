import {
  SimulatedLightingAdapter,
  type LightingAdapter,
  type LightingObservation,
} from '../adapters/simulated-lighting.js';
import type { Clock, TimerHandle } from '../core/clock.js';
import { StateEventStream } from '../core/event-stream.js';
import {
  LightingProperties,
  PresenceEventSchema,
  RoomStateSchema,
  SceneSchema,
  SemanticLightingIdSchema,
  type Actor,
  type Diagnostic,
  type FastPathTiming,
  type LightingScene,
  type LightingValues,
  type PresenceEvent,
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
  stateHistoryLimit?: number;
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
  readonly scenes: ReadonlyMap<string, LightingScene>;
  readonly state: RoomState;
  private readonly convergenceTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly continuityMs: number;
  private nextDiagnosticId = 0;
  private nextEventId = 0;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly retryTimers = new Map<string, TimerHandle>();
  private readonly convergenceStartedAt = new Map<number, number>();
  private readonly intentByRevision = new Map<number, IntentProvenance>();
  private readonly fastPathEventByCommand = new Map<string, string>();

  constructor(
    private readonly clock: Clock,
    options: EngineOptions = {},
  ) {
    this.convergenceTimeoutMs = options.convergenceTimeoutMs ?? 60_000;
    this.retryDelayMs = options.retryDelayMs ?? 2_000;
    this.continuityMs = options.continuityMs ?? 20 * 60_000;
    this.adapter = options.adapter ?? new SimulatedLightingAdapter(clock);
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
    this.state = {
      revision: 0,
      updatedAt: clock.now(),
      presence: {
        state: 'unknown',
        personCount: null,
        continuityExpiresAt: null,
      },
      lighting: { currentScene: null, sceneRevision: 0, devices },
      commands: this.ledger.records,
      diagnostics: [],
      timings: [],
    };
    this.unsubscribers.push(
      this.adapter.subscribe((observation) =>
        this.handleObservation(observation),
      ),
    );
    this.publish([
      'presence',
      'lighting',
      'commands',
      'diagnostics',
      'timings',
    ]);
  }

  async activateScene(
    sceneId: string,
    actor: Actor = systemActor,
    source = 'capability',
    requestId?: string,
  ): Promise<number> {
    const scene = this.scenes.get(sceneId);
    if (!scene) throw new Error(`Unknown scene: ${sceneId}`);
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
    this.state.presence.state = normalizedEvent.presence;
    if (normalizedEvent.personCount !== undefined)
      this.state.presence.personCount = normalizedEvent.personCount;
    if (
      normalizedEvent.presence === 'confirmed_empty' &&
      previous !== 'confirmed_empty'
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
            if (device.observed.power === false) return;
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
    for (const unsubscribe of this.unsubscribers) unsubscribe();
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
      'presence' | 'lighting' | 'commands' | 'diagnostics' | 'timings'
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
