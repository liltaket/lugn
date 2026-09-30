import { MusicController, type MusicOptions } from './music-controller.js';
import {
  MusicAutomation,
  type MusicVolumePolicySnapshot,
} from './music-automation.js';
import type {
  MusicCommandRecord,
  MusicFadeRequest,
  MusicFadeState,
  MusicRequest,
  DeviceMusicState,
} from '../core/schemas.js';
import {
  isLightingDeliveryUnknownError,
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
  LightingIntentSnapshotSchema,
  LightingValuesSchema,
  PresenceEventSchema,
  HomePresenceSchema,
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
  type LightingIntentSnapshot,
  type LightingValues,
  type PresenceEvent,
  type HomePresence,
  type PresenceInputEvent,
  type PrelightEvent,
  type RoomState,
  type StateUpdate,
} from '../core/schemas.js';
import { CommandLedger } from '../execution/command-ledger.js';

export type EngineOptions = {
  deviceIds?: string[];
  scenes?: LightingScene[];
  defaultSceneId?: string;
  restoredLightingIntent?: LightingIntentSnapshot;
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
const maxLightingDeliveryAttempts = 3;

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
  allowWhileEmpty?: boolean;
};
type LightingRetryMode = 'scene' | 'confirmed_empty_off';
type ScheduledRetry = {
  handle: TimerHandle;
  modes: Set<LightingRetryMode>;
  fastPathEventId?: string;
};

const runtimeHistoryLimit = 256;

export class LugnEngine {
  readonly stream: StateEventStream;
  readonly ledger: CommandLedger;
  readonly adapter: LightingAdapter;
  readonly switchAdapter: SwitchAdapter;
  readonly scenes: ReadonlyMap<string, LightingScene>;
  readonly state: RoomState;
  private readonly musicController: MusicController;
  private readonly musicAutomation: MusicAutomation;
  private lastNonOffSceneId: string | null = null;
  private bilresaPriorVolumeAutomation: boolean | null = null;
  private readonly convergenceTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly continuityMs: number;
  private readonly switchFeedbackTimeoutMs: number;
  private readonly lightingFeedbackTimers = new Map<string, TimerHandle>();
  private readonly lightingDeliveryAttempts = new Map<string, number>();
  private readonly exhaustedLightingDeliveryKeys = new Set<string>();
  private readonly forceOffTargetsByRevision = new Map<number, Set<string>>();
  private readonly switchFeedbackTimers = new Map<string, TimerHandle>();
  private nextSwitchCommandId = 0;
  private readonly prelightTargets: Readonly<Record<string, LightingValues>>;
  private readonly prelightMaxDurationMs: number;
  private readonly normalDefaultScene: LightingScene | undefined;
  private defaultSceneOnOccupancy: LightingScene | undefined;
  private nextDiagnosticId = 0;
  private nextEventId = 0;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly retryTimers = new Map<string, ScheduledRetry>();
  private continuityTimer: TimerHandle | undefined;
  private continuityTimerGeneration = 0;
  private readonly convergenceStartedAt = new Map<number, number>();
  private readonly targetConvergenceStartedAt = new Map<string, number>();
  private readonly manualLightingWhileEmpty = new Set<string>();
  private lastConfirmedPresence: 'occupied' | 'confirmed_empty' | 'unknown' =
    'unknown';
  private quietHoursSuppressedForCurrentVisit = false;
  private readonly intentByRevision = new Map<number, IntentProvenance>();
  private readonly fastPathEventByCommand = new Map<string, string>();
  private readonly fastPathMonotonicOrigins = new Map<string, number>();
  private readonly fastPathTimeoutTimers = new Map<string, TimerHandle>();
  private readonly fastPathPrelightExpectedValues = new Map<
    string,
    Readonly<Record<string, LightingValues>>
  >();
  private activePrelightFastPathEventId: string | undefined;
  private confirmedEmptyFastPathEventId: string | undefined;
  private prelightActive = false;
  private prelightTimer: TimerHandle | undefined;
  private prelightSnapshot = new Map<string, LightingValues>();
  private prelightAppliedValues = new Map<string, LightingValues>();
  private restoredIntentAwaitingOccupancy = false;
  private restoredContinuityPending = false;
  private suppressInitialEmptyContinuity = false;

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
    const restoredIntent =
      options.restoredLightingIntent === undefined
        ? undefined
        : LightingIntentSnapshotSchema.parse(options.restoredLightingIntent);
    if (
      restoredIntent &&
      restoredIntent.currentScene !== null &&
      !this.scenes.has(restoredIntent.currentScene)
    )
      throw new Error(`Unknown restored scene: ${restoredIntent.currentScene}`);
    this.normalDefaultScene =
      options.defaultSceneId === undefined
        ? undefined
        : this.scenes.get(options.defaultSceneId);
    if (options.defaultSceneId !== undefined) {
      if (!this.normalDefaultScene)
        throw new Error(`Unknown default scene: ${options.defaultSceneId}`);
    }
    this.defaultSceneOnOccupancy = this.normalDefaultScene;
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
    if (
      restoredIntent &&
      Object.keys(restoredIntent.devices).sort().join('\0') !==
        Object.keys(devices).sort().join('\0')
    )
      throw new Error('Restored lighting devices do not match engine devices');
    const restoredContinuityExpired =
      restoredIntent?.continuityExpiresAt !== null &&
      restoredIntent?.continuityExpiresAt !== undefined &&
      restoredIntent.continuityExpiresAt <= clock.now();
    const expiredRestoredScene =
      restoredContinuityExpired && restoredIntent?.currentScene
        ? this.scenes.get(restoredIntent.currentScene)
        : undefined;
    const expiredRestoredSceneIsExplicitlyOffOrSleep =
      expiredRestoredScene !== undefined &&
      (expiredRestoredScene.id === 'scene.all_off' ||
        expiredRestoredScene.id === 'scene.sleep' ||
        (Object.keys(devices).length > 0 &&
          Object.keys(devices).every(
            (target) => expiredRestoredScene.lighting[target]?.power === false,
          )));
    const expiredRestoredSceneToPreserve =
      expiredRestoredSceneIsExplicitlyOffOrSleep
        ? expiredRestoredScene
        : undefined;
    const expiredRestoredSceneHasPositiveOutput =
      expiredRestoredSceneToPreserve !== undefined &&
      Object.values(expiredRestoredSceneToPreserve.lighting).some(
        (values) => values.power === true || (values.brightness ?? 0) > 0,
      );
    if (expiredRestoredSceneToPreserve)
      this.defaultSceneOnOccupancy = undefined;
    const hasRestoredIntent =
      restoredIntent !== undefined &&
      !restoredContinuityExpired &&
      ((restoredIntent.sceneRevision > 0 &&
        restoredIntent.currentScene !== null) ||
        Object.values(restoredIntent.devices).some(
          (device) =>
            Object.keys(device.baselineDesired).length > 0 ||
            Object.keys(device.effectiveDesired).length > 0 ||
            Object.keys(device.ownership).length > 0,
        ));
    if (hasRestoredIntent || expiredRestoredSceneHasPositiveOutput)
      this.restoredIntentAwaitingOccupancy = true;
    this.restoredContinuityPending =
      restoredIntent !== undefined &&
      !restoredContinuityExpired &&
      restoredIntent.continuityExpiresAt !== null;
    this.suppressInitialEmptyContinuity = restoredContinuityExpired;
    if (restoredIntent && !restoredContinuityExpired) {
      for (const [target, intent] of Object.entries(restoredIntent.devices)) {
        const device = devices[target];
        if (!device)
          throw new Error(`Unknown restored lighting device: ${target}`);
        if (
          Object.values(intent.ownership).some(
            (ownership) =>
              ownership.kind === 'scene' &&
              ownership.revision > restoredIntent.sceneRevision,
          )
        )
          throw new Error('Restored ownership exceeds its scene revision');
        if (hasRestoredIntent) {
          device.baselineDesired = { ...intent.baselineDesired };
          device.effectiveDesired = { ...intent.effectiveDesired };
          device.ownership = structuredClone(intent.ownership);
        }
      }
      if (hasRestoredIntent) {
        const restoredScene = restoredIntent.currentScene
          ? this.scenes.get(restoredIntent.currentScene)
          : undefined;
        for (const [target, values] of Object.entries(
          restoredScene?.lighting ?? {},
        )) {
          const device = devices[target];
          if (!device) continue;
          for (const property of LightingProperties) {
            const sceneValue = values[property];
            const ownsSceneValue = device.ownership[property]?.kind === 'scene';
            const synchronizeCct =
              property === 'colorTemperature' &&
              values.power !== false &&
              sceneValue !== undefined;
            if (
              sceneValue === undefined ||
              (!ownsSceneValue && !synchronizeCct)
            )
              continue;
            // Migrate stale scene values after preset changes. CCT is stricter:
            // older per-light overrides cannot split an active room scene.
            Object.assign(device.baselineDesired, { [property]: sceneValue });
            Object.assign(device.effectiveDesired, { [property]: sceneValue });
            device.ownership[property] = {
              kind: 'scene',
              revision: restoredIntent.sceneRevision,
            };
          }
        }
      }
    }
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
    this.musicAutomation = new MusicAutomation({
      targets: Object.keys(options.music?.targets ?? {}),
      clock,
      getState: (target) => this.musicController.getState(target),
      request: (target, request, provenance) =>
        this.musicController.request(target, request, provenance),
      onError: (target, operation) => {
        this.addDiagnostic(
          'music.automation_unconfirmed',
          `Music automation could not ${operation} for ${target}`,
          { target, operation },
        );
        this.publish(['music', 'diagnostics']);
      },
    });
    this.musicController.setExternalVolumeChangeHandler((target, volume) =>
      this.musicAutomation.noteExternalVolumeChange(target, volume),
    );
    this.musicController.setExternalPlaybackChangeHandler((target, playback) =>
      this.musicAutomation.noteExternalPlaybackChange(target, playback),
    );
    this.musicController.setFadeLifecycleHandler((event) =>
      this.musicAutomation.handleFadeLifecycle(event),
    );
    this.state = {
      revision: 0,
      updatedAt: clock.now(),
      presence: {
        state: 'unknown',
        personCount: null,
        continuityExpiresAt:
          restoredContinuityExpired || restoredIntent === undefined
            ? null
            : restoredIntent.continuityExpiresAt,
        home: { state: 'unknown', observedAt: null },
      },
      lighting: {
        currentScene:
          restoredIntent !== undefined
            ? hasRestoredIntent
              ? restoredIntent.currentScene
              : (expiredRestoredSceneToPreserve?.id ?? null)
            : (this.defaultSceneOnOccupancy?.id ?? null),
        sceneRevision:
          restoredIntent === undefined
            ? 0
            : restoredContinuityExpired
              ? restoredIntent.sceneRevision + 1
              : restoredIntent.sceneRevision,
        devices,
      },
      switches: { devices: switches, commands: [] },
      music: this.musicController.state,
      commands: this.ledger.records,
      diagnostics: [],
      timings: [],
    };
    if (expiredRestoredSceneToPreserve) {
      const revision = this.state.lighting.sceneRevision;
      this.intentByRevision.set(revision, {
        actor: systemActor,
        source: 'continuity',
        reason:
          'Explicit all-off or sleep scene retained after continuity expiry',
      });
      for (const [target, values] of Object.entries(
        expiredRestoredSceneToPreserve.lighting,
      )) {
        const device = devices[target];
        if (!device) continue;
        device.baselineDesired = { ...values };
        device.effectiveDesired = { ...values };
        for (const property of LightingProperties) {
          if (values[property] !== undefined)
            device.ownership[property] = { kind: 'scene', revision };
        }
      }
    }
    const restoredScene = this.state.lighting.currentScene;
    if (
      restoredScene !== null &&
      restoredScene !== 'scene.all_off' &&
      restoredScene !== 'scene.sleep'
    )
      this.lastNonOffSceneId = restoredScene;
    if (this.state.presence.continuityExpiresAt !== null)
      this.scheduleContinuityExpiry(this.state.presence.continuityExpiresAt);
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

  getMusicVolumePolicySnapshots(): Record<string, MusicVolumePolicySnapshot> {
    return Object.fromEntries(
      Object.keys(this.state.music.devices).map((target) => [
        target,
        this.musicAutomation.getVolumePolicySnapshot(target),
      ]),
    );
  }

  async handleBilresaPress(
    button: '1' | '2',
    gesture: 'multi_press_1' | 'multi_press_2' | 'long_press',
  ): Promise<void> {
    const actor: Actor = { type: 'physical_remote', id: `bilresa-${button}` };
    const source = `bilresa.button_${button}.${gesture}`;
    if (button === '1' && gesture === 'multi_press_1') {
      const sceneId =
        this.state.lighting.currentScene === 'scene.all_off' ||
        this.state.lighting.currentScene === 'scene.sleep'
          ? (this.lastNonOffSceneId ?? this.fallbackRemoteSceneId())
          : 'scene.all_off';
      await this.activateScene(sceneId, actor, source);
      return;
    }
    if (button === '2' && gesture === 'multi_press_1') {
      const enabled = !this.musicAutomation.isVolumeAutomationEnabled;
      this.musicAutomation.setVolumeAutomationEnabled(enabled);
      this.addDiagnostic(
        'music.volume_automation_changed',
        enabled
          ? 'Automatic music volume control enabled from BILRESA'
          : 'Automatic music volume control paused from BILRESA',
        { enabled, source },
      );
      this.publish(['music', 'diagnostics']);
      return;
    }
    if (button === '1' && gesture === 'long_press') {
      const sleepScene = this.scenes.has('scene.sleep')
        ? 'scene.sleep'
        : 'scene.all_off';
      const sceneId =
        this.state.lighting.currentScene === sleepScene ||
        this.state.lighting.currentScene === 'scene.all_off'
          ? (this.lastNonOffSceneId ?? this.fallbackRemoteSceneId())
          : sleepScene;
      await this.activateScene(sceneId, actor, source);
      return;
    }
    if (button === '2' && gesture === 'long_press') {
      if (this.bilresaPriorVolumeAutomation === null) {
        this.bilresaPriorVolumeAutomation =
          this.musicAutomation.isVolumeAutomationEnabled;
        this.musicAutomation.setVolumeAutomationEnabled(false);
        await this.activateScene('scene.all_off', actor, source);
      } else {
        const restoreVolumeAutomation = this.bilresaPriorVolumeAutomation;
        this.bilresaPriorVolumeAutomation = null;
        this.musicAutomation.setVolumeAutomationEnabled(
          restoreVolumeAutomation,
        );
        await this.activateScene(
          this.lastNonOffSceneId ?? this.fallbackRemoteSceneId(),
          actor,
          source,
        );
      }
      this.publish(['music', 'diagnostics']);
      return;
    }
    if (button === '1' && gesture === 'multi_press_2') {
      await this.activateScene(
        this.lastNonOffSceneId ?? this.fallbackRemoteSceneId(),
        actor,
        source,
      );
      return;
    }
    if (button === '2' && gesture === 'multi_press_2') {
      await this.activateScene('scene.all_off', actor, source);
    }
  }

  private fallbackRemoteSceneId(): string {
    for (const sceneId of ['scene.everyday_light', 'scene.soft_light'])
      if (this.scenes.has(sceneId)) return sceneId;
    const firstUsableScene = [...this.scenes.keys()].find(
      (sceneId) => sceneId !== 'scene.all_off' && sceneId !== 'scene.sleep',
    );
    if (firstUsableScene) return firstUsableScene;
    throw new Error('BILRESA needs at least one restorable lighting scene');
  }

  getLightingIntentSnapshot(): LightingIntentSnapshot {
    return LightingIntentSnapshotSchema.parse({
      currentScene: this.state.lighting.currentScene,
      sceneRevision: this.state.lighting.sceneRevision,
      continuityExpiresAt: this.state.presence.continuityExpiresAt,
      devices: Object.fromEntries(
        Object.entries(this.state.lighting.devices).map(([id, device]) => [
          id,
          {
            baselineDesired: device.baselineDesired,
            effectiveDesired: device.effectiveDesired,
            ownership: device.ownership,
          },
        ]),
      ),
    });
  }

  /** True while the configured default is waiting for the first confirmed entry. */
  get defaultScenePending(): boolean {
    return (
      this.defaultSceneOnOccupancy !== undefined &&
      !this.restoredIntentAwaitingOccupancy
    );
  }

  requestMusic(
    target: string,
    requested: MusicRequest,
    provenance: Provenance,
  ): Promise<MusicCommandRecord> {
    const command = this.musicController.request(target, requested, provenance);
    this.musicAutomation.noteExplicitRequest(target, requested, provenance);
    return command;
  }

  startMusicFade(
    request: MusicFadeRequest,
    provenance: Provenance,
  ): MusicFadeState {
    const fade = this.musicController.startFade(request, provenance);
    this.musicAutomation.noteExplicitFade(request, provenance);
    return fade;
  }

  cancelMusicFade(target: string): MusicFadeState | null {
    return this.musicController.cancelFade(target);
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
    this.quietHoursSuppressedForCurrentVisit = false;
    if (sceneId !== 'scene.all_off' && sceneId !== 'scene.sleep')
      this.lastNonOffSceneId = sceneId;
    if (this.prelightActive) await this.finishPrelight(true, scene);
    this.beginScene(scene, {
      actor,
      source,
      ...(requestId === undefined ? {} : { requestId }),
      reason: 'Scene explicitly selected',
      allowWhileEmpty: this.shouldRemainPhysicallyEmpty(),
    });
    if (sceneId === 'scene.all_off')
      this.forceOffTargetsByRevision.set(
        this.state.lighting.sceneRevision,
        new Set(
          Object.entries(scene.lighting)
            .filter(([, values]) => values.power === false)
            .map(([target]) => target),
        ),
      );
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
    this.requireDevice(target);
    const scene = this.state.lighting.currentScene
      ? this.scenes.get(this.state.lighting.currentScene)
      : undefined;
    const physicallyEmpty = this.shouldRemainPhysicallyEmpty();
    const synchronizedTemperatureTargets =
      values.colorTemperature === undefined
        ? []
        : Object.entries(scene?.lighting ?? {})
            .filter(
              ([sceneTarget, sceneValues]) =>
                sceneValues.power !== false &&
                sceneValues.colorTemperature !== undefined &&
                (!physicallyEmpty ||
                  this.manualLightingWhileEmpty.has(sceneTarget)),
            )
            .map(([sceneTarget]) => sceneTarget);
    const targets = synchronizedTemperatureTargets.includes(target)
      ? synchronizedTemperatureTargets
      : [target];
    const updates = new Map<string, LightingValues>(
      targets.map((lightingTarget) => [
        lightingTarget,
        lightingTarget === target
          ? { ...values }
          : { colorTemperature: values.colorTemperature },
      ]),
    );
    await this.finishPrelight(
      true,
      undefined,
      new Map(
        [...updates].map(([lightingTarget, targetValues]) => [
          lightingTarget,
          new Set(Object.keys(targetValues)),
        ]),
      ),
    );
    this.terminateAllFastPathEvents();
    const source = provenance.source ?? 'capability';
    const reason = provenance.reason ?? 'Explicit lighting adjustment';
    for (const lightingTarget of targets) {
      this.ledger.supersedePending(
        'Superseded by explicit property adjustment',
        lightingTarget,
      );
      this.clearLightingDeliveryAttempts(lightingTarget);
      const device = this.requireDevice(lightingTarget);
      if (device.availability === 'degraded') device.availability = 'available';
    }
    const now = this.clock.now();
    if (this.shouldRemainPhysicallyEmpty() && provenance.actor.type === 'user')
      for (const [lightingTarget, targetValues] of updates) {
        if (targetValues.power === true)
          this.manualLightingWhileEmpty.add(lightingTarget);
        else if (targetValues.power === false)
          this.manualLightingWhileEmpty.delete(lightingTarget);
      }
    for (const lightingTarget of targets)
      this.targetConvergenceStartedAt.set(
        this.lightingDeliveryKey(
          this.state.lighting.sceneRevision,
          lightingTarget,
        ),
        now,
      );
    for (const [lightingTarget, targetValues] of updates) {
      const device = this.requireDevice(lightingTarget);
      for (const property of LightingProperties) {
        const value = targetValues[property];
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
    }
    this.addDiagnostic(
      'lighting.set',
      `Explicit property adjustment for ${target}`,
      {
        target,
        values,
        source,
        reason,
        ...(targets.length > 1 ? { synchronizedTargets: targets } : {}),
      },
    );
    this.publish(['lighting', 'commands', 'diagnostics']);
    await Promise.all(
      [...updates].map(([lightingTarget, targetValues]) =>
        !this.shouldRemainPhysicallyEmpty() ||
        targetValues.power === false ||
        (provenance.actor.type === 'user' &&
          (targetValues.power === true ||
            (targetValues.power === undefined &&
              this.manualLightingWhileEmpty.has(lightingTarget))))
          ? this.dispatch(
              lightingTarget,
              targetValues,
              this.state.lighting.sceneRevision,
              source,
              reason,
              provenance.actor,
              provenance.requestId,
            )
          : Promise.resolve(),
      ),
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
    this.clearLightingDeliveryAttempts(target);
    this.targetConvergenceStartedAt.set(
      this.lightingDeliveryKey(this.state.lighting.sceneRevision, target),
      this.clock.now(),
    );
    this.addDiagnostic(
      'device.available',
      this.restoredIntentAwaitingOccupancy
        ? `${target} is available again; restored intent waits for confirmed occupancy`
        : `${target} is available again; reconciling current desired state`,
      { target },
    );
    this.publish(['lighting', 'diagnostics']);
    if (!this.restoredIntentAwaitingOccupancy)
      await this.reconcileScene(this.state.lighting.sceneRevision);
  }

  async handlePresence(event: PresenceEvent): Promise<void> {
    const normalizedEvent = PresenceEventSchema.parse(event);
    const receivedAt = this.clock.now();
    const previous = this.state.presence.state;
    const lastConfirmedBeforeEvent = this.lastConfirmedPresence;
    const prelightWasActive = this.prelightActive;
    const createsEmptyTiming =
      normalizedEvent.presence === 'confirmed_empty' &&
      (lastConfirmedBeforeEvent !== 'confirmed_empty' || prelightWasActive);
    if (normalizedEvent.presence === 'confirmed_empty') {
      if (lastConfirmedBeforeEvent !== 'confirmed_empty')
        this.manualLightingWhileEmpty.clear();
      this.clearPrelight();
      this.quietHoursSuppressedForCurrentVisit = false;
    } else if (normalizedEvent.presence === 'occupied' && this.prelightActive) {
      const scene =
        this.scenes.get(
          this.state.lighting.currentScene ?? this.lastNonOffSceneId ?? '',
        ) ?? this.scenes.get('scene.everyday_light');
      await this.finishPrelight(true, scene);
    }
    if (normalizedEvent.presence === 'occupied' || createsEmptyTiming)
      this.terminateAllFastPathEvents();
    this.state.presence.state = normalizedEvent.presence;
    if (
      normalizedEvent.presence === 'occupied' ||
      normalizedEvent.presence === 'confirmed_empty'
    )
      this.lastConfirmedPresence = normalizedEvent.presence;
    this.state.presence.personCount =
      normalizedEvent.personCount ??
      (normalizedEvent.presence === 'confirmed_empty' ? 0 : null);
    this.musicAutomation.handlePresence(
      previous,
      normalizedEvent.presence,
      this.state.presence.personCount,
    );
    if (createsEmptyTiming) {
      const fastPathEventId = `presence-${++this.nextEventId}`;
      this.confirmedEmptyFastPathEventId = fastPathEventId;
      this.state.timings.push(
        this.createFastPathTiming(
          fastPathEventId,
          receivedAt,
          normalizedEvent.localReceivedMonotonicAt,
        ),
      );
      const keepRestoredExpiry =
        this.restoredContinuityPending &&
        this.state.presence.continuityExpiresAt !== null;
      if (this.suppressInitialEmptyContinuity) {
        this.state.presence.continuityExpiresAt = null;
        this.suppressInitialEmptyContinuity = false;
      } else if (!keepRestoredExpiry) {
        this.state.presence.continuityExpiresAt =
          receivedAt + this.continuityMs;
        this.scheduleContinuityExpiry(this.state.presence.continuityExpiresAt);
      }
      this.restoredContinuityPending = false;
      this.cancelRetryTimers();
      this.clearLightingDeliveryAttempts();
      const pendingOnTargets = new Set(
        this.ledger.records
          .filter(
            (command) =>
              command.status === 'pending' && command.desired.power === true,
          )
          .map((command) => command.target),
      );
      const currentSceneIntent = this.intentByRevision.get(
        this.state.lighting.sceneRevision,
      );
      if (currentSceneIntent) currentSceneIntent.allowWhileEmpty = false;
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
            if (
              device.observed.power === false &&
              !prelightWasActive &&
              !pendingOnTargets.has(target)
            )
              return;
            await this.dispatch(
              target,
              { power: false },
              this.state.lighting.sceneRevision,
              'presence',
              'Confirmed empty: physical off',
              systemActor,
              undefined,
              fastPathEventId,
              'confirmed_empty_off',
            );
          },
        ),
      );
      this.tryCompleteConfirmedEmptyFastPath();
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
      this.manualLightingWhileEmpty.clear();
      if (lastConfirmedBeforeEvent !== 'occupied')
        this.quietHoursSuppressedForCurrentVisit = this.isLightingQuietHours();
      this.suppressInitialEmptyContinuity = false;
      this.restoredContinuityPending = false;
      const expiry = this.state.presence.continuityExpiresAt;
      const withinContinuity = expiry !== null && receivedAt < expiry;
      this.cancelContinuityTimer();
      if (expiry !== null && receivedAt >= expiry) this.expireContinuity();
      const returned = withinContinuity;
      this.state.presence.continuityExpiresAt = null;
      if (this.restoredIntentAwaitingOccupancy) {
        this.defaultSceneOnOccupancy = undefined;
        this.restoredIntentAwaitingOccupancy = false;
      }
      this.addDiagnostic(
        returned ? 'presence.returned' : 'presence.occupied',
        returned
          ? 'Room occupied again; restoring remembered effective lighting'
          : 'Room is occupied',
        { restoredContinuity: returned },
      );
      const eventId = `presence-${++this.nextEventId}`;
      const timing = this.createFastPathTiming(
        eventId,
        receivedAt,
        normalizedEvent.localReceivedMonotonicAt,
      );
      this.state.timings.push(timing);
      this.publish(['presence', 'diagnostics', 'timings']);
      if (this.isLightingQuietHours()) {
        this.quietHoursSuppressedForCurrentVisit = true;
        this.addDiagnostic(
          'presence.lighting_suppressed_quiet_hours',
          'Automatic lighting was suppressed during quiet hours',
          { currentScene: this.state.lighting.currentScene },
        );
        this.publish(['diagnostics']);
        return;
      }
      if (this.state.presence.home.state === 'away') {
        this.addDiagnostic(
          'presence.lighting_suppressed_home_away',
          'Automatic lighting was suppressed because Home Assistant reports that the resident is away',
          { currentScene: this.state.lighting.currentScene },
        );
        this.publish(['diagnostics']);
        return;
      }
      const newConfirmedEntry = lastConfirmedBeforeEvent !== 'occupied';
      if (newConfirmedEntry)
        this.startConvergenceAttempt(this.state.lighting.sceneRevision);
      if (!newConfirmedEntry && this.quietHoursSuppressedForCurrentVisit) {
        this.addDiagnostic(
          'presence.lighting_waiting_for_new_entry',
          'Lighting remains suppressed for this visit after quiet hours; a new confirmed entry is required',
          {},
        );
        this.publish(['diagnostics']);
        return;
      }
      const defaultScene = newConfirmedEntry
        ? this.defaultSceneOnOccupancy
        : undefined;
      if (defaultScene) {
        this.defaultSceneOnOccupancy = undefined;
        this.beginScene(defaultScene, {
          actor: systemActor,
          source: 'presence',
          reason: 'Configured default scene activated on confirmed occupancy',
        });
      }
      await this.reconcileScene(
        this.state.lighting.sceneRevision,
        timing.eventId,
      );
      return;
    }
    this.publish(['presence']);
  }

  async handleHomePresence(
    state: HomePresence,
    observedAt = this.clock.now(),
  ): Promise<void> {
    const normalized = HomePresenceSchema.parse(state);
    const previous = this.state.presence.home.state;
    this.state.presence.home = {
      state: normalized,
      observedAt: normalized === 'unknown' ? null : observedAt,
    };
    this.musicAutomation.handleHomePresence(normalized);
    if (normalized === 'away' && previous !== 'away') {
      if (this.prelightActive) await this.finishPrelight(true);
      this.terminateAllFastPathEvents();
      const currentIntent = this.intentByRevision.get(
        this.state.lighting.sceneRevision,
      );
      if (currentIntent?.source === 'presence')
        this.clearRetryTimer(this.state.lighting.sceneRevision);
      this.addDiagnostic(
        'home_presence.away',
        'Home Assistant reports that the resident is away; automatic room activation is blocked',
        {},
      );
    } else if (normalized !== previous) {
      this.addDiagnostic(
        'home_presence.changed',
        `Home Assistant home presence changed to ${normalized}`,
        {},
      );
    }
    this.publish(['presence', 'music', 'diagnostics']);
    if (
      normalized === 'home' &&
      previous === 'away' &&
      this.state.presence.state === 'occupied' &&
      !this.quietHoursSuppressedForCurrentVisit &&
      !this.isLightingQuietHours()
    ) {
      const defaultScene = this.defaultSceneOnOccupancy;
      if (defaultScene) {
        this.defaultSceneOnOccupancy = undefined;
        this.beginScene(defaultScene, {
          actor: systemActor,
          source: 'presence',
          reason: 'Configured default scene activated after returning home',
        });
      }
      this.startConvergenceAttempt(this.state.lighting.sceneRevision);
      await this.reconcileScene(this.state.lighting.sceneRevision);
    }
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

    const scene =
      this.scenes.get(
        this.state.lighting.currentScene ??
          this.defaultSceneOnOccupancy?.id ??
          this.lastNonOffSceneId ??
          '',
      ) ?? this.scenes.get('scene.everyday_light');
    const targetValues = scene
      ? Object.fromEntries(
          Object.entries(scene.lighting).filter(
            ([, values]) => values.power === true,
          ),
        )
      : this.prelightTargets;
    const allLightsOffScene =
      this.hasExplicitAllLightsOffScene() ||
      (scene !== undefined && Object.keys(targetValues).length === 0);
    const quietHours = this.isLightingQuietHours();
    const roomAlreadyLit = this.hasAnyLightOn();
    const homeAway = this.state.presence.home.state === 'away';
    const suppressedVisit =
      this.quietHoursSuppressedForCurrentVisit &&
      this.state.presence.state === 'occupied';
    if (
      allLightsOffScene ||
      quietHours ||
      suppressedVisit ||
      roomAlreadyLit ||
      homeAway
    ) {
      this.addDiagnostic(
        'presence.prelight_suppressed',
        'Temporary prelight was suppressed by the active lighting policy',
        {
          currentScene: this.state.lighting.currentScene,
          reason: allLightsOffScene
            ? 'all_lights_off_scene'
            : quietHours
              ? 'quiet_hours'
              : suppressedVisit
                ? 'quiet_hours_visit'
                : roomAlreadyLit
                  ? 'room_already_lit'
                  : 'home_away',
        },
      );
      this.publish(['diagnostics']);
      return;
    }

    this.terminateAllFastPathEvents();
    this.prelightActive = true;
    const eventId = `prelight-${++this.nextEventId}`;
    this.activePrelightFastPathEventId = eventId;
    const receivedAt = this.clock.now();
    this.state.timings.push(
      this.createFastPathTiming(
        eventId,
        receivedAt,
        normalizedEvent.localReceivedMonotonicAt,
      ),
    );
    this.fastPathPrelightExpectedValues.set(
      eventId,
      structuredClone(targetValues),
    );
    this.prelightSnapshot = new Map();
    this.prelightAppliedValues = new Map();
    const dispatches: Promise<void>[] = [];
    for (const [target, values] of Object.entries(targetValues)) {
      const device = this.requireDevice(target);
      const snapshot = { ...device.effectiveDesired, ...device.observed };
      this.prelightSnapshot.set(target, snapshot);
      this.prelightAppliedValues.set(target, { ...values });
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
        targets: Object.keys(targetValues),
      },
    );
    this.publish(['diagnostics', 'timings']);
    this.prelightTimer = this.clock.setTimeout(() => {
      void this.finishPrelight(this.state.presence.state !== 'occupied');
    }, this.prelightMaxDurationMs);
    await Promise.all(dispatches);
    this.tryCompletePrelightFastPath(eventId);
  }

  private startConvergenceAttempt(revision: number, target?: string): void {
    const now = this.clock.now();
    if (target === undefined) this.convergenceStartedAt.set(revision, now);
    const targets = target
      ? [target]
      : Object.keys(this.state.lighting.devices);
    for (const lightingTarget of targets) {
      const device = this.state.lighting.devices[lightingTarget];
      if (!device) continue;
      this.clearLightingDeliveryAttempts(lightingTarget);
      this.targetConvergenceStartedAt.set(
        this.lightingDeliveryKey(revision, lightingTarget),
        now,
      );
      if (device.availability === 'degraded') device.availability = 'available';
    }
  }

  async reconcileScene(
    revision = this.state.lighting.sceneRevision,
    eventId?: string,
  ): Promise<void> {
    if (
      revision !== this.state.lighting.sceneRevision ||
      (this.state.presence.home.state === 'away' &&
        this.intentByRevision.get(revision)?.source === 'presence') ||
      (this.shouldRemainPhysicallyEmpty() &&
        !this.sceneIntentCanRunWhileEmpty(revision) &&
        this.manualLightingWhileEmpty.size === 0)
    )
      return;
    const retryEventId = this.retryTimers.get(
      String(revision),
    )?.fastPathEventId;
    const candidateEventId =
      eventId && this.fastPathMonotonicOrigins.has(eventId)
        ? eventId
        : retryEventId;
    const timingEventId =
      candidateEventId && this.fastPathMonotonicOrigins.has(candidateEventId)
        ? candidateEventId
        : undefined;
    const startedAt =
      this.convergenceStartedAt.get(revision) ?? this.clock.now();
    this.convergenceStartedAt.set(revision, startedAt);
    const dispatches: Promise<void>[] = [];
    const now = this.clock.now();
    let timedOut = false;
    for (const [target, device] of Object.entries(
      this.state.lighting.devices,
    )) {
      if (
        this.shouldRemainPhysicallyEmpty() &&
        !this.sceneIntentCanRunWhileEmpty(revision) &&
        !this.manualLightingWhileEmpty.has(target)
      )
        continue;
      const targetStartedAt =
        this.targetConvergenceStartedAt.get(
          this.lightingDeliveryKey(revision, target),
        ) ?? startedAt;
      const desired: LightingValues = {};
      const forceOffTargets = this.forceOffTargetsByRevision.get(revision);
      const forceOff = forceOffTargets?.has(target) === true;
      for (const property of LightingProperties) {
        if (device.effectiveDesired.power === false && property !== 'power')
          continue;
        const value = device.effectiveDesired[property];
        if (
          value === undefined ||
          (value === device.observed[property] &&
            !(forceOff && property === 'power' && value === false))
        )
          continue;
        const pending = this.ledger.latestPending(target, property, value);
        if (pending && now - pending.issuedAt < this.retryDelayMs) continue;
        Object.assign(desired, { [property]: value });
      }
      if (Object.keys(desired).length === 0) continue;
      if (device.availability === 'degraded') continue;
      if (now - targetStartedAt >= this.convergenceTimeoutMs) {
        device.availability = 'degraded';
        timedOut = true;
        this.ledger.cancelTargetRevision(
          revision,
          target,
          'Target convergence timeout reached',
        );
        this.addDiagnostic(
          'convergence.degraded',
          `${target} did not converge before timeout`,
          { target, revision },
        );
        continue;
      }
      if (forceOffTargets && forceOff) {
        forceOffTargets.delete(target);
        if (forceOffTargets.size === 0)
          this.forceOffTargetsByRevision.delete(revision);
      }
      const deliveryKey = this.lightingDeliveryKey(revision, target);
      const deliveryAttempts =
        this.lightingDeliveryAttempts.get(deliveryKey) ?? 0;
      if (deliveryAttempts >= maxLightingDeliveryAttempts) {
        this.markLightingDeliveryExhausted(
          deliveryKey,
          target,
          deliveryAttempts,
        );
        continue;
      }
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
          timingEventId,
        ),
      );
    }
    if (dispatches.length > 0) await Promise.all(dispatches);
    const converged = Object.values(this.state.lighting.devices).every(
      (device) =>
        device.effectiveDesired.power === false
          ? device.observed.power === false
          : LightingProperties.every((property) => {
              const desired = device.effectiveDesired[property];
              return (
                desired === undefined || desired === device.observed[property]
              );
            }),
    );
    if (converged) {
      this.clearRetryTimer(revision);
      this.addDiagnostic(
        'convergence.complete',
        'Effective lighting state matches observed state',
        { revision },
      );
      if (timingEventId && this.isFastPathEventConverged(timingEventId)) {
        this.recordFastPathStage(
          timingEventId,
          'fullConvergenceAt',
          'eventToFullConvergenceMs',
        );
        this.terminateFastPathEvent(timingEventId);
      }
      this.publish(['lighting', 'commands', 'diagnostics', 'timings']);
      return;
    }
    const hasRetryableMismatch = this.hasRetryableLightingMismatch(revision);
    const hasUnavailableMismatch =
      this.hasUnavailableLightingMismatch(revision);
    if (hasRetryableMismatch || hasUnavailableMismatch) {
      const remaining = this.minimumRemainingConvergenceMs(revision, startedAt);
      this.scheduleRetry(
        revision,
        Math.min(this.retryDelayMs, remaining),
        timingEventId,
      );
    } else {
      this.clearRetryTimer(revision);
      if (timedOut && timingEventId) this.terminateFastPathEvent(timingEventId);
    }
    this.publish(['lighting', 'commands', 'diagnostics']);
  }

  dispose(): void {
    this.cancelRetryTimers();
    this.cancelContinuityTimer();
    this.clearPrelight();
    this.terminateAllFastPathEvents();
    this.musicAutomation.dispose();
    this.musicController.dispose();
    for (const handle of this.lightingFeedbackTimers.values())
      this.clock.clearTimeout(handle);
    this.lightingFeedbackTimers.clear();
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
    this.prelightAppliedValues.clear();
    if (this.activePrelightFastPathEventId)
      this.terminateFastPathEvent(this.activePrelightFastPathEventId);
    this.activePrelightFastPathEventId = undefined;
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
    if (this.activePrelightFastPathEventId)
      this.terminateFastPathEvent(this.activePrelightFastPathEventId);
    this.activePrelightFastPathEventId = undefined;
    const snapshot = this.prelightSnapshot;
    this.prelightSnapshot = new Map();
    const appliedValues = this.prelightAppliedValues;
    this.prelightAppliedValues = new Map();
    if (!restore) return;

    const dispatches: Promise<void>[] = [];
    for (const [target, previousValues] of snapshot) {
      const device = this.state.lighting.devices[target];
      if (!device) continue;
      const values: LightingValues = {};
      const excluded = excludedProperties.get(target) ?? new Set<string>();
      const sceneValues = scene?.lighting[target] ?? {};
      const prelightValues = appliedValues.get(target) ?? {};
      for (const property of LightingProperties) {
        if (
          excluded.has(property) ||
          sceneValues[property] !== undefined ||
          previousValues[property] === undefined
        )
          continue;
        const current = device.observed[property];
        if (
          current !== undefined &&
          current !== prelightValues[property] &&
          current !== previousValues[property]
        )
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
    this.manualLightingWhileEmpty.clear();
    this.defaultSceneOnOccupancy = undefined;
    this.restoredIntentAwaitingOccupancy = false;
    this.terminateAllFastPathEvents();
    const priorRevision = this.state.lighting.sceneRevision;
    this.clearRetryTimer(priorRevision);
    this.clearLightingDeliveryAttempts();
    this.ledger.supersedePending(
      `Superseded by scene revision ${priorRevision + 1}`,
    );
    this.state.lighting.sceneRevision += 1;
    this.state.lighting.currentScene = scene.id;
    const revision = this.state.lighting.sceneRevision;
    this.convergenceStartedAt.set(revision, this.clock.now());
    for (const target of Object.keys(this.state.lighting.devices))
      this.targetConvergenceStartedAt.set(
        this.lightingDeliveryKey(revision, target),
        this.clock.now(),
      );
    this.intentByRevision.set(revision, intent);
    for (const device of Object.values(this.state.lighting.devices)) {
      device.baselineDesired = {};
      device.effectiveDesired = {};
      device.ownership = {};
      if (device.availability === 'degraded') device.availability = 'available';
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
    retryMode: LightingRetryMode = 'scene',
  ): Promise<void> {
    if (Object.keys(values).length === 0) return;
    const deliveryKey = this.lightingDeliveryKey(revision, target);
    const deliveryAttempt =
      (this.lightingDeliveryAttempts.get(deliveryKey) ?? 0) + 1;
    this.lightingDeliveryAttempts.set(deliveryKey, deliveryAttempt);
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
    this.lightingFeedbackTimers.set(
      command.id,
      this.clock.setTimeout(() => {
        this.lightingFeedbackTimers.delete(command.id);
        if (
          !this.ledger.cancel(
            command.id,
            'No matching lighting feedback before command timeout',
          )
        )
          return;
        this.addDiagnostic(
          'command.unconfirmed',
          `Lighting command for ${target} was not confirmed before timeout`,
          { commandId: command.id, target },
        );
        this.publish(['commands', 'diagnostics']);
      }, this.convergenceTimeoutMs),
    );
    this.state.commands = this.ledger.records;
    this.publish(['commands']);
    if (eventId && this.fastPathMonotonicOrigins.has(eventId)) {
      this.fastPathEventByCommand.set(command.id, eventId);
      this.recordFastPathStage(
        eventId,
        'commandDispatchedAt',
        'eventToFirstDispatchMs',
      );
      this.publish(['timings']);
    }
    let dispatchFailed = false;
    let dispatchError: unknown;
    try {
      await this.adapter.dispatch({ id: command.id, target, values });
    } catch (error) {
      dispatchFailed = true;
      dispatchError = error;
    }
    if (dispatchFailed && isLightingDeliveryUnknownError(dispatchError)) {
      if (command.status === 'pending')
        command.diagnosticReason =
          'Lighting adapter did not confirm delivery; the requested state may still have taken effect';
      const currentIntent = this.isCurrentLightingDeliveryIntent(
        command,
        retryMode,
      );
      const retryScheduled =
        currentIntent && deliveryAttempt < maxLightingDeliveryAttempts;
      if (currentIntent && !retryScheduled)
        this.markLightingDeliveryExhausted(
          deliveryKey,
          target,
          deliveryAttempt,
        );
      this.addDiagnostic(
        'command.delivery_unknown',
        `Lighting adapter did not confirm the command for ${target}; it may still have taken effect`,
        {
          commandId: command.id,
          target,
          values,
          attempt: deliveryAttempt,
          attemptLimit: maxLightingDeliveryAttempts,
          retryScheduled,
        },
      );
      if (retryScheduled)
        this.scheduleRetry(revision, this.retryDelayMs, eventId, retryMode);
      if (eventId) this.terminateFastPathEvent(eventId);
      this.publish(['commands', 'lighting', 'diagnostics']);
      return;
    }
    if (dispatchFailed) {
      command.status = 'failed';
      command.diagnosticReason =
        dispatchError instanceof Error
          ? dispatchError.message
          : String(dispatchError);
      const device = this.state.lighting.devices[target];
      if (device) device.availability = 'unavailable';
      if (this.isCurrentLightingDeliveryIntent(command, retryMode)) {
        if (retryMode === 'confirmed_empty_off') {
          if (deliveryAttempt < maxLightingDeliveryAttempts)
            this.scheduleRetry(revision, this.retryDelayMs, eventId, retryMode);
          else
            this.markLightingDeliveryExhausted(
              deliveryKey,
              target,
              deliveryAttempt,
            );
        }
      }
      this.addDiagnostic('command.failed', `Command for ${target} failed`, {
        commandId: command.id,
        error: command.diagnosticReason,
      });
      if (eventId) this.terminateFastPathEvent(eventId);
      this.publish(['commands', 'lighting', 'diagnostics']);
      return;
    }
    if (this.isCurrentLightingDeliveryIntent(command, retryMode)) {
      command.diagnosticReason =
        'Lighting adapter accepted the request; device state has not yet been observed';
      const retryScheduled = deliveryAttempt < maxLightingDeliveryAttempts;
      if (retryScheduled)
        this.scheduleRetry(revision, this.retryDelayMs, eventId, retryMode);
      else
        this.markLightingDeliveryExhausted(
          deliveryKey,
          target,
          deliveryAttempt,
        );
      this.addDiagnostic(
        'command.sent_unconfirmed',
        `Command for ${target} was sent, but matching device feedback has not arrived`,
        {
          commandId: command.id,
          target,
          values,
          attempt: deliveryAttempt,
          attemptLimit: maxLightingDeliveryAttempts,
          retryScheduled,
        },
      );
      this.publish(['commands', 'lighting', 'diagnostics']);
    }
  }

  private handleObservation(observation: LightingObservation): void {
    const device = this.state.lighting.devices[observation.target];
    if (!device) return;
    if (observation.availability === 'unavailable') {
      const changed = device.availability !== 'unavailable';
      device.availability = 'unavailable';
      device.observed = {};
      if (changed)
        this.addDiagnostic(
          'device.unavailable',
          `${observation.target} is unavailable in Home Assistant`,
          {
            target: observation.target,
            source: observation.provenance?.source ?? 'lighting_observation',
          },
        );
      const revision = this.state.lighting.sceneRevision;
      if (
        changed &&
        this.shouldRemainPhysicallyEmpty() &&
        !this.manualLightingWhileEmpty.has(observation.target)
      ) {
        void this.dispatch(
          observation.target,
          { power: false },
          revision,
          'presence',
          'Confirmed empty: unavailable light remains physically off',
          systemActor,
          undefined,
          this.confirmedEmptyFastPathEventId,
          'confirmed_empty_off',
        );
      } else if (
        !this.restoredIntentAwaitingOccupancy &&
        this.hasUnavailableLightingMismatch(revision)
      ) {
        const startedAt =
          this.targetConvergenceStartedAt.get(
            this.lightingDeliveryKey(revision, observation.target),
          ) ??
          this.convergenceStartedAt.get(revision) ??
          this.clock.now();
        const remaining = Math.max(
          0,
          this.convergenceTimeoutMs - (this.clock.now() - startedAt),
        );
        this.scheduleRetry(revision, Math.min(this.retryDelayMs, remaining));
      }
      this.publish(['lighting', 'commands', 'diagnostics']);
      return;
    }
    const recovered = device.availability !== 'available';
    device.availability = 'available';
    if (recovered) {
      this.startConvergenceAttempt(
        this.state.lighting.sceneRevision,
        observation.target,
      );
      this.addDiagnostic(
        'device.available',
        `${observation.target} responded with a valid lighting state observation`,
        {
          target: observation.target,
          source: observation.provenance?.source ?? 'lighting_observation',
        },
      );
    }
    const feedbackTime = this.clock.now();
    let fastPathEventId = observation.commandId
      ? this.fastPathEventByCommand.get(observation.commandId)
      : undefined;
    let effectiveIntentChanged = false;
    let attributedStaleCommand = false;
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
      const supersededCommand =
        !command &&
        !observation.commandId &&
        device.effectiveDesired[property] !== value
          ? this.ledger.recentSupersededMatch(
              observation.target,
              property,
              value,
              feedbackTime,
            )
          : undefined;
      if (supersededCommand) attributedStaleCommand = true;
      if (
        command &&
        command.id !== this.latestCommandId(observation.target) &&
        command.status !== 'pending' &&
        command.status !== 'confirmed'
      )
        attributedStaleCommand = true;
      if (command && !fastPathEventId)
        fastPathEventId = this.fastPathEventByCommand.get(command.id);
      if (
        !command &&
        !supersededCommand &&
        !(
          property === 'power' &&
          value === true &&
          this.shouldRemainPhysicallyEmpty()
        ) &&
        !(
          observation.commandId &&
          this.ledger.isKnownCommandId(observation.commandId)
        ) &&
        previouslyObserved !== undefined &&
        previouslyObserved !== value
      ) {
        this.terminateAllFastPathEvents();
        const synchronizedTemperature =
          property === 'colorTemperature'
            ? this.expectedSceneColorTemperature(observation.target, device)
            : undefined;
        if (synchronizedTemperature !== undefined) {
          // A room scene owns Kelvin as a shared value. Keep the external
          // observation visible, but do not turn a single lamp's drift into a
          // permanent per-light override.
          device.effectiveDesired.colorTemperature = synchronizedTemperature;
          if (device.ownership.colorTemperature?.kind !== 'override')
            device.ownership.colorTemperature = {
              kind: 'scene',
              revision: this.state.lighting.sceneRevision,
            };
          effectiveIntentChanged = true;
          this.addDiagnostic(
            'lighting.color_temperature_reasserted',
            `${observation.target} color temperature will return to the room setting`,
            {
              target: observation.target,
              observed: value,
              desired: synchronizedTemperature,
            },
          );
        } else {
          Object.assign(device.effectiveDesired, { [property]: value });
          effectiveIntentChanged = true;
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
        }
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
    const currentIntentConfirmed =
      (this.shouldRemainPhysicallyEmpty() &&
        !this.targetIntentCanRunWhileEmpty(
          this.state.lighting.sceneRevision,
          observation.target,
        )) ||
      device.effectiveDesired.power === false
        ? device.observed.power === false
        : LightingProperties.every((property) => {
            const desired = device.effectiveDesired[property];
            return (
              desired === undefined || desired === device.observed[property]
            );
          });
    if (effectiveIntentChanged || currentIntentConfirmed)
      this.clearLightingDeliveryAttempts(observation.target);
    if (fastPathEventId) {
      this.recordFastPathStage(
        fastPathEventId,
        'feedbackObservedAt',
        'eventToFirstFeedbackMs',
        feedbackTime,
      );
      this.tryCompletePrelightFastPath(fastPathEventId);
    }
    this.tryCompleteConfirmedEmptyFastPath();
    const isStaleCommand =
      attributedStaleCommand ||
      (observation.commandId !== undefined &&
        observation.commandId !== this.latestCommandId(observation.target));
    if (isStaleCommand)
      this.addDiagnostic(
        'command.stale_feedback',
        'Feedback arrived for a superseded command; current intent remains authoritative',
        { commandId: observation.commandId },
      );
    this.publish(['lighting', 'commands', 'diagnostics', 'timings']);
    if (
      (!this.shouldRemainPhysicallyEmpty() ||
        this.manualLightingWhileEmpty.has(observation.target)) &&
      !this.restoredIntentAwaitingOccupancy
    ) {
      void this.reconcileScene(
        this.state.lighting.sceneRevision,
        fastPathEventId,
      );
    } else if (
      this.shouldRemainPhysicallyEmpty() &&
      observation.values.power === true &&
      !this.manualLightingWhileEmpty.has(observation.target)
    ) {
      void this.dispatch(
        observation.target,
        { power: false },
        this.state.lighting.sceneRevision,
        'presence',
        'Reassert physical off while the room may be empty',
        systemActor,
        undefined,
        this.confirmedEmptyFastPathEventId,
        'confirmed_empty_off',
      );
    }
  }

  private expectedSceneColorTemperature(
    target: string,
    device: DeviceRuntime,
  ): number | undefined {
    const sceneId = this.state.lighting.currentScene;
    const sceneValues = sceneId
      ? this.scenes.get(sceneId)?.lighting[target]
      : undefined;
    if (
      !sceneValues ||
      sceneValues.power === false ||
      sceneValues.colorTemperature === undefined
    )
      return undefined;
    return (
      device.effectiveDesired.colorTemperature ?? sceneValues.colorTemperature
    );
  }

  private latestCommandId(target: string): string | undefined {
    return this.ledger.latestCommandId(target);
  }

  private expireContinuity(): void {
    if (this.state.presence.state === 'unknown')
      this.suppressInitialEmptyContinuity = true;
    this.cancelContinuityTimer();
    this.restoredContinuityPending = false;
    this.restoredIntentAwaitingOccupancy = false;
    const previousRevision = this.state.lighting.sceneRevision;
    const retainedExplicitScene = this.continuitySceneToPreserve();
    this.state.lighting.sceneRevision = previousRevision + 1;
    this.ledger.cancelRevision(previousRevision, 'Continuity expired');
    this.forceOffTargetsByRevision.delete(previousRevision);
    if (retainedExplicitScene) {
      this.defaultSceneOnOccupancy = undefined;
      this.intentByRevision.set(this.state.lighting.sceneRevision, {
        actor: systemActor,
        source: 'continuity',
        reason:
          'Explicit all-off or sleep scene retained after continuity expiry',
      });
    } else {
      this.state.lighting.currentScene = null;
      this.defaultSceneOnOccupancy = this.normalDefaultScene;
      this.lastNonOffSceneId = null;
    }
    for (const device of Object.values(this.state.lighting.devices)) {
      device.baselineDesired = {};
      device.effectiveDesired = {};
      device.ownership = {};
    }
    if (retainedExplicitScene) {
      const revision = this.state.lighting.sceneRevision;
      for (const [target, values] of Object.entries(
        retainedExplicitScene.lighting,
      )) {
        const device = this.state.lighting.devices[target];
        if (!device) continue;
        device.baselineDesired = { ...values };
        device.effectiveDesired = { ...values };
        for (const property of LightingProperties) {
          if (values[property] !== undefined)
            device.ownership[property] = { kind: 'scene', revision };
        }
      }
    }
    this.state.presence.continuityExpiresAt = null;
    this.addDiagnostic(
      'continuity.expired',
      retainedExplicitScene
        ? 'Temporary lighting overrides expired; explicit all-off or sleep scene remains active'
        : 'Remembered scene and lighting overrides expired; the configured default will apply on the next confirmed entry',
      {
        retainedScene: retainedExplicitScene?.id ?? null,
        nextDefaultScene: this.defaultSceneOnOccupancy?.id ?? null,
      },
    );
    this.publish(['presence', 'lighting', 'commands', 'diagnostics']);
  }

  private createFastPathTiming(
    eventId: string,
    eventReceivedAt: number,
    localReceivedMonotonicAt?: number,
  ): FastPathTiming {
    const monotonicOrigin =
      localReceivedMonotonicAt !== undefined &&
      Number.isFinite(localReceivedMonotonicAt) &&
      localReceivedMonotonicAt >= 0
        ? localReceivedMonotonicAt
        : this.clock.monotonicNow();
    this.fastPathMonotonicOrigins.set(eventId, monotonicOrigin);
    const timeout = this.clock.setTimeout(() => {
      this.fastPathTimeoutTimers.delete(eventId);
      this.terminateFastPathEvent(eventId);
    }, this.convergenceTimeoutMs);
    this.fastPathTimeoutTimers.set(eventId, timeout);

    return {
      eventId,
      eventReceivedAt,
      decisionCompletedAt: this.clock.now(),
      eventToDecisionMs: this.elapsedSince(monotonicOrigin),
    };
  }

  private recordFastPathStage(
    eventId: string,
    wallField:
      'commandDispatchedAt' | 'feedbackObservedAt' | 'fullConvergenceAt',
    elapsedField:
      | 'eventToFirstDispatchMs'
      | 'eventToFirstFeedbackMs'
      | 'eventToFullConvergenceMs',
    wallAt = this.clock.now(),
  ): void {
    const timing = this.state.timings.find(
      (entry) => entry.eventId === eventId,
    );
    if (!timing || !this.fastPathMonotonicOrigins.has(eventId)) return;

    if (timing[wallField] === undefined) timing[wallField] = wallAt;
    if (timing[elapsedField] === undefined) {
      const origin = this.fastPathMonotonicOrigins.get(eventId);
      if (origin !== undefined)
        timing[elapsedField] = this.elapsedSince(origin);
    }
  }

  private elapsedSince(monotonicOrigin: number): number {
    return Math.max(0, this.clock.monotonicNow() - monotonicOrigin);
  }

  private isFastPathEventConverged(eventId: string): boolean {
    const expected = this.fastPathPrelightExpectedValues.get(eventId);
    if (expected) {
      return Object.entries(expected).every(([target, values]) => {
        const observed = this.state.lighting.devices[target]?.observed;
        if (!observed) return false;
        if (values.power === false) return observed.power === false;
        return LightingProperties.every((property) => {
          const value = values[property];
          return value === undefined || observed[property] === value;
        });
      });
    }
    return true;
  }

  private tryCompletePrelightFastPath(eventId: string | undefined): void {
    if (!eventId || !this.fastPathPrelightExpectedValues.has(eventId)) return;
    if (!this.isFastPathEventConverged(eventId)) return;
    this.recordFastPathStage(
      eventId,
      'fullConvergenceAt',
      'eventToFullConvergenceMs',
    );
    this.terminateFastPathEvent(eventId);
  }

  private tryCompleteConfirmedEmptyFastPath(): void {
    const eventId = this.confirmedEmptyFastPathEventId;
    if (!eventId) return;
    const lightsAreOff = Object.values(this.state.lighting.devices).every(
      (device) => device.observed.power === false,
    );
    if (!lightsAreOff) return;
    this.recordFastPathStage(
      eventId,
      'fullConvergenceAt',
      'eventToFullConvergenceMs',
    );
    this.terminateFastPathEvent(eventId);
  }

  private terminateFastPathEvent(eventId: string): void {
    this.fastPathMonotonicOrigins.delete(eventId);
    const timeout = this.fastPathTimeoutTimers.get(eventId);
    if (timeout !== undefined) this.clock.clearTimeout(timeout);
    this.fastPathTimeoutTimers.delete(eventId);
    this.fastPathPrelightExpectedValues.delete(eventId);
    if (this.activePrelightFastPathEventId === eventId)
      this.activePrelightFastPathEventId = undefined;
    if (this.confirmedEmptyFastPathEventId === eventId)
      this.confirmedEmptyFastPathEventId = undefined;
    for (const [commandId, mappedEventId] of this.fastPathEventByCommand) {
      if (mappedEventId === eventId)
        this.fastPathEventByCommand.delete(commandId);
    }
    for (const [revision, retry] of this.retryTimers) {
      if (retry.fastPathEventId === eventId)
        this.retryTimers.set(revision, {
          handle: retry.handle,
          modes: retry.modes,
        });
    }
  }

  private terminateAllFastPathEvents(): void {
    const eventIds = new Set([
      ...this.fastPathMonotonicOrigins.keys(),
      ...this.fastPathEventByCommand.values(),
      ...this.fastPathPrelightExpectedValues.keys(),
      ...[...this.retryTimers.values()]
        .map((retry) => retry.fastPathEventId)
        .filter((eventId): eventId is string => eventId !== undefined),
      ...(this.activePrelightFastPathEventId === undefined
        ? []
        : [this.activePrelightFastPathEventId]),
      ...(this.confirmedEmptyFastPathEventId === undefined
        ? []
        : [this.confirmedEmptyFastPathEventId]),
    ]);
    for (const eventId of eventIds) this.terminateFastPathEvent(eventId);
  }

  private scheduleContinuityExpiry(expiresAt: number): void {
    this.cancelContinuityTimer();
    const generation = this.continuityTimerGeneration;
    this.continuityTimer = this.clock.setTimeout(
      () => this.handleContinuityExpiry(generation, expiresAt),
      Math.max(0, expiresAt - this.clock.now()),
    );
  }

  private handleContinuityExpiry(generation: number, expiresAt: number): void {
    if (generation !== this.continuityTimerGeneration) return;
    this.continuityTimer = undefined;
    if (this.state.presence.continuityExpiresAt !== expiresAt) return;

    const remainingMs = expiresAt - this.clock.now();
    if (remainingMs > 0) {
      this.continuityTimer = this.clock.setTimeout(
        () => this.handleContinuityExpiry(generation, expiresAt),
        remainingMs,
      );
      return;
    }
    this.expireContinuity();
  }

  private cancelContinuityTimer(): void {
    this.continuityTimerGeneration += 1;
    if (this.continuityTimer !== undefined)
      this.clock.clearTimeout(this.continuityTimer);
    this.continuityTimer = undefined;
  }

  private requireDevice(target: string): DeviceRuntime {
    const device = this.state.lighting.devices[target];
    if (!device) throw new Error(`Unknown semantic lighting device: ${target}`);
    return device;
  }

  private hasExplicitAllLightsOffScene(): boolean {
    const sceneId = this.state.lighting.currentScene;
    if (sceneId === null) return false;
    const scene = this.scenes.get(sceneId);
    const targets = Object.keys(this.state.lighting.devices);
    return (
      scene !== undefined &&
      targets.length > 0 &&
      targets.every((target) => scene.lighting[target]?.power === false)
    );
  }

  private continuitySceneToPreserve(): LightingScene | undefined {
    const sceneId = this.state.lighting.currentScene;
    if (sceneId === null) return undefined;
    const scene = this.scenes.get(sceneId);
    if (!scene) return undefined;
    if (sceneId === 'scene.all_off' || sceneId === 'scene.sleep') return scene;
    const targets = Object.keys(this.state.lighting.devices);
    return targets.length > 0 &&
      targets.every((target) => scene.lighting[target]?.power === false)
      ? scene
      : undefined;
  }

  private hasAnyLightOn(): boolean {
    return Object.values(this.state.lighting.devices).some(
      (device) => device.observed.power === true,
    );
  }

  private isLightingQuietHours(): boolean {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Stockholm',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(this.clock.now()));
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
    return hour >= 23 || hour < 6;
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
    if (this.state.diagnostics.length > runtimeHistoryLimit)
      this.state.diagnostics.splice(
        0,
        this.state.diagnostics.length - runtimeHistoryLimit,
      );
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
    const pendingLightingIds = new Set(
      this.ledger.records
        .filter((command) => command.status === 'pending')
        .map((command) => command.id),
    );
    for (const [commandId, timer] of this.lightingFeedbackTimers) {
      if (!pendingLightingIds.has(commandId)) {
        this.clock.clearTimeout(timer);
        this.lightingFeedbackTimers.delete(commandId);
      }
    }
    if (this.ledger.pruneTerminalRecords() && !domains.includes('commands'))
      domains.push('commands');
    let remainingTerminalSwitches = runtimeHistoryLimit;
    const retainedSwitchCommands = [...this.state.switches.commands]
      .reverse()
      .filter((command) => {
        if (command.status === 'pending') return true;
        if (remainingTerminalSwitches === 0) return false;
        remainingTerminalSwitches -= 1;
        return true;
      })
      .reverse();
    if (retainedSwitchCommands.length !== this.state.switches.commands.length) {
      this.state.switches.commands = retainedSwitchCommands;
      if (!domains.includes('switches')) domains.push('switches');
    }
    if (this.state.timings.length > runtimeHistoryLimit) {
      const retired = this.state.timings.splice(
        0,
        this.state.timings.length - runtimeHistoryLimit,
      );
      for (const timing of retired) this.terminateFastPathEvent(timing.eventId);
      if (!domains.includes('timings')) domains.push('timings');
    }
    // Only the current revision can reconcile. Older async continuations are guarded.
    for (const revision of this.convergenceStartedAt.keys())
      if (revision !== this.state.lighting.sceneRevision)
        this.convergenceStartedAt.delete(revision);
    const currentRevisionPrefix = `${this.state.lighting.sceneRevision}:`;
    for (const key of this.targetConvergenceStartedAt.keys())
      if (!key.startsWith(currentRevisionPrefix))
        this.targetConvergenceStartedAt.delete(key);
    for (const revision of this.intentByRevision.keys())
      if (revision !== this.state.lighting.sceneRevision)
        this.intentByRevision.delete(revision);
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

  private scheduleRetry(
    revision: number,
    delayMs: number,
    fastPathEventId?: string,
    mode: LightingRetryMode = 'scene',
  ): void {
    const key = String(revision);
    const existing = this.retryTimers.get(key);
    if (existing !== undefined) this.clock.clearTimeout(existing.handle);
    const modes = new Set(existing?.modes ?? []);
    modes.add(mode);
    const scheduledEventId = fastPathEventId ?? existing?.fastPathEventId;
    const handle = this.clock.setTimeout(() => {
      const retry = this.retryTimers.get(key);
      if (!retry || retry.handle !== handle) return;
      this.retryTimers.delete(key);
      const activeEventId =
        retry.fastPathEventId &&
        this.fastPathMonotonicOrigins.has(retry.fastPathEventId)
          ? retry.fastPathEventId
          : undefined;
      void (async () => {
        for (const retryMode of retry.modes)
          await this.runScheduledLightingRetry(
            revision,
            retryMode,
            activeEventId,
          );
      })();
    }, delayMs);
    this.retryTimers.set(key, {
      handle,
      modes,
      ...(scheduledEventId === undefined
        ? {}
        : { fastPathEventId: scheduledEventId }),
    });
  }

  private clearRetryTimer(revision: number): void {
    const key = String(revision);
    const retry = this.retryTimers.get(key);
    if (retry !== undefined) this.clock.clearTimeout(retry.handle);
    this.retryTimers.delete(key);
  }

  private cancelRetryTimers(): void {
    for (const retry of this.retryTimers.values())
      this.clock.clearTimeout(retry.handle);
    this.retryTimers.clear();
  }

  private lightingDeliveryKey(revision: number, target: string): string {
    return `${revision}:${target}`;
  }

  private sceneIntentCanRunWhileEmpty(revision: number): boolean {
    return this.intentByRevision.get(revision)?.allowWhileEmpty === true;
  }

  private targetIntentCanRunWhileEmpty(
    revision: number,
    target: string,
  ): boolean {
    return (
      this.sceneIntentCanRunWhileEmpty(revision) ||
      this.manualLightingWhileEmpty.has(target)
    );
  }

  private shouldRemainPhysicallyEmpty(): boolean {
    return (
      this.state.presence.state === 'confirmed_empty' ||
      (this.state.presence.state === 'unknown' &&
        this.lastConfirmedPresence === 'confirmed_empty')
    );
  }

  private clearLightingDeliveryAttempts(target?: string): void {
    if (target === undefined) {
      this.lightingDeliveryAttempts.clear();
      this.exhaustedLightingDeliveryKeys.clear();
      return;
    }
    for (const key of this.lightingDeliveryAttempts.keys()) {
      if (key.endsWith(`:${target}`)) this.lightingDeliveryAttempts.delete(key);
    }
    for (const key of this.exhaustedLightingDeliveryKeys) {
      if (key.endsWith(`:${target}`))
        this.exhaustedLightingDeliveryKeys.delete(key);
    }
  }

  private markLightingDeliveryExhausted(
    key: string,
    target: string,
    attempts: number,
  ): void {
    if (this.exhaustedLightingDeliveryKeys.has(key)) return;
    this.exhaustedLightingDeliveryKeys.add(key);
    const device = this.state.lighting.devices[target];
    if (device) device.availability = 'degraded';
    this.addDiagnostic(
      'command.retry_limit',
      `Stopped retrying ${target} after ${attempts} absolute-state delivery attempts without confirmation`,
      { target, attempts, attemptLimit: maxLightingDeliveryAttempts },
    );
  }

  private hasRetryableLightingMismatch(revision: number): boolean {
    if (
      revision !== this.state.lighting.sceneRevision ||
      (this.shouldRemainPhysicallyEmpty() &&
        !this.sceneIntentCanRunWhileEmpty(revision) &&
        this.manualLightingWhileEmpty.size === 0)
    )
      return false;
    for (const [target, device] of Object.entries(
      this.state.lighting.devices,
    )) {
      if (
        this.shouldRemainPhysicallyEmpty() &&
        !this.sceneIntentCanRunWhileEmpty(revision) &&
        !this.manualLightingWhileEmpty.has(target)
      )
        continue;
      const hasMismatch = LightingProperties.some((property) => {
        if (device.effectiveDesired.power === false && property !== 'power')
          return false;
        const desired = device.effectiveDesired[property];
        return desired !== undefined && desired !== device.observed[property];
      });
      if (
        !hasMismatch ||
        device.availability === 'unavailable' ||
        device.availability === 'degraded'
      )
        continue;
      const key = this.lightingDeliveryKey(revision, target);
      const attempts = this.lightingDeliveryAttempts.get(key) ?? 0;
      if (attempts < maxLightingDeliveryAttempts) return true;
      this.markLightingDeliveryExhausted(key, target, attempts);
    }
    return false;
  }

  private minimumRemainingConvergenceMs(
    revision: number,
    fallbackStartedAt: number,
  ): number {
    const remaining = Object.entries(this.state.lighting.devices)
      .filter(([target, device]) => {
        const key = this.lightingDeliveryKey(revision, target);
        return (
          (!this.shouldRemainPhysicallyEmpty() ||
            this.sceneIntentCanRunWhileEmpty(revision) ||
            this.manualLightingWhileEmpty.has(target)) &&
          (this.lightingDeliveryAttempts.get(key) ?? 0) <
            maxLightingDeliveryAttempts &&
          device.availability !== 'degraded' &&
          LightingProperties.some((property) => {
            if (device.effectiveDesired.power === false && property !== 'power')
              return false;
            const desired = device.effectiveDesired[property];
            return (
              desired !== undefined && desired !== device.observed[property]
            );
          })
        );
      })
      .map(([target]) => {
        const startedAt =
          this.targetConvergenceStartedAt.get(
            this.lightingDeliveryKey(revision, target),
          ) ?? fallbackStartedAt;
        return this.convergenceTimeoutMs - (this.clock.now() - startedAt);
      });
    return Math.max(0, remaining.length ? Math.min(...remaining) : 0);
  }

  private hasUnavailableLightingMismatch(revision: number): boolean {
    if (
      revision !== this.state.lighting.sceneRevision ||
      (this.shouldRemainPhysicallyEmpty() &&
        !this.sceneIntentCanRunWhileEmpty(revision) &&
        this.manualLightingWhileEmpty.size === 0)
    )
      return false;
    for (const [target, device] of Object.entries(
      this.state.lighting.devices,
    )) {
      if (
        this.shouldRemainPhysicallyEmpty() &&
        !this.sceneIntentCanRunWhileEmpty(revision) &&
        !this.manualLightingWhileEmpty.has(target)
      )
        continue;
      if (device.availability !== 'unavailable') continue;
      const hasMismatch = LightingProperties.some((property) => {
        if (device.effectiveDesired.power === false && property !== 'power')
          return false;
        const desired = device.effectiveDesired[property];
        return desired !== undefined && desired !== device.observed[property];
      });
      if (!hasMismatch) continue;
      const key = this.lightingDeliveryKey(revision, target);
      const attempts = this.lightingDeliveryAttempts.get(key) ?? 0;
      if (attempts < maxLightingDeliveryAttempts) return true;
      this.markLightingDeliveryExhausted(key, target, attempts);
    }
    return false;
  }

  private isCurrentLightingDeliveryIntent(
    command: {
      id: string;
      target: string;
      revision: number;
      desired: LightingValues;
    },
    retryMode: LightingRetryMode,
  ): boolean {
    if (
      command.revision !== this.state.lighting.sceneRevision ||
      this.ledger.latestCommandId(command.target) !== command.id
    )
      return false;
    const device = this.state.lighting.devices[command.target];
    if (!device) return false;
    if (retryMode === 'confirmed_empty_off')
      return (
        this.shouldRemainPhysicallyEmpty() &&
        command.desired.power === false &&
        Object.keys(command.desired).length === 1 &&
        device.observed.power !== false
      );
    if (
      this.shouldRemainPhysicallyEmpty() &&
      !this.targetIntentCanRunWhileEmpty(command.revision, command.target)
    )
      return false;
    const stillDesired = LightingProperties.every((property) => {
      const value = command.desired[property];
      return value === undefined || device.effectiveDesired[property] === value;
    });
    if (!stillDesired) return false;
    return LightingProperties.some((property) => {
      const value = command.desired[property];
      return value !== undefined && device.observed[property] !== value;
    });
  }

  private async runScheduledLightingRetry(
    revision: number,
    mode: LightingRetryMode,
    eventId?: string,
  ): Promise<void> {
    if (revision !== this.state.lighting.sceneRevision) return;
    if (mode === 'scene') {
      if (
        this.shouldRemainPhysicallyEmpty() &&
        !this.sceneIntentCanRunWhileEmpty(revision) &&
        this.manualLightingWhileEmpty.size === 0
      )
        return;
      await this.reconcileScene(revision, eventId);
      return;
    }
    if (!this.shouldRemainPhysicallyEmpty()) return;
    const dispatches: Promise<void>[] = [];
    for (const [target, device] of Object.entries(
      this.state.lighting.devices,
    )) {
      if (
        device.observed.power === false ||
        this.manualLightingWhileEmpty.has(target) ||
        (device.availability === 'unavailable' &&
          mode !== 'confirmed_empty_off')
      )
        continue;
      const key = this.lightingDeliveryKey(revision, target);
      const attempts = this.lightingDeliveryAttempts.get(key) ?? 0;
      if (attempts >= maxLightingDeliveryAttempts) {
        this.markLightingDeliveryExhausted(key, target, attempts);
        continue;
      }
      dispatches.push(
        this.dispatch(
          target,
          { power: false },
          revision,
          'presence',
          'Confirmed empty: retry physical off after uncertain delivery',
          systemActor,
          undefined,
          eventId,
          'confirmed_empty_off',
        ),
      );
    }
    if (dispatches.length > 0) await Promise.all(dispatches);
    this.publish(['commands', 'lighting', 'diagnostics']);
  }
}
