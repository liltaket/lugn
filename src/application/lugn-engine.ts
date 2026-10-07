import { MusicController, type MusicOptions } from './music-controller.js';
import { AutomationHolds, isHumanActor } from '../core/automation-holds.js';
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
import { RoomSessions } from './room-sessions.js';
import {
  LightingProperties,
  LightingControlModesSchema,
  type LightingControlModes,
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
  type CommandRecord,
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
  MusicRequestSchema,
} from '../core/schemas.js';
import { CommandLedger } from '../execution/command-ledger.js';

export type EngineOptions = {
  deviceIds?: string[];
  lightingControlModes?: LightingControlModes;
  scenes?: LightingScene[];
  defaultSceneId?: string;
  restoredLightingIntent?: LightingIntentSnapshot;
  convergenceTimeoutMs?: number;
  retryDelayMs?: number;
  continuityMs?: number;
  roomSessionContinuityMs?: number;
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
const lightingEnforcementIntervalMs = 30_000;

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
type ScheduledRetryMode = {
  dueAt: number;
  fastPathEventId?: string;
};
type ScheduledRetry = {
  handle?: TimerHandle;
  armedAt?: number;
  modes: Map<LightingRetryMode, ScheduledRetryMode>;
};
const prelightCommandReason = 'Possible entry: temporary prelight';
const prelightRestoreReason =
  'Prelight ended before confirmed entry; restoring prior observed intent';
const prelightHandoffGraceMs = 1_000;

const runtimeHistoryLimit = 256;

export class LugnEngine {
  readonly stream: StateEventStream;
  readonly ledger: CommandLedger;
  readonly adapter: LightingAdapter;
  readonly switchAdapter: SwitchAdapter;
  readonly scenes: ReadonlyMap<string, LightingScene>;
  readonly state: RoomState;
  private readonly holds: AutomationHolds;
  private readonly musicController: MusicController;
  private readonly musicAutomation: MusicAutomation;
  private readonly roomSessions: RoomSessions;
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
  private presenceTransitionGeneration = 0;
  private readonly enforcedLightingTargets = new Set<string>();
  private lightingEnforcementTimer: TimerHandle | undefined;
  private disposed = false;
  private readonly intentByRevision = new Map<number, IntentProvenance>();
  private readonly fastPathEventByCommand = new Map<string, string>();
  private readonly acceptedLightingCommandIds = new Set<string>();
  private readonly inFlightLightingCommandIds = new Set<string>();
  private readonly lightingTransportsInFlight = new Map<string, string>();
  private readonly fastPathMonotonicOrigins = new Map<string, number>();
  private readonly fastPathTimeoutTimers = new Map<string, TimerHandle>();
  private readonly fastPathPrelightExpectedValues = new Map<
    string,
    Readonly<Record<string, LightingValues>>
  >();
  private activePrelightFastPathEventId: string | undefined;
  private confirmedEmptyFastPathEventId: string | undefined;
  private prelightActive = false;
  private prelightPreviewActive = false;
  private prelightTimer: TimerHandle | undefined;
  private prelightFinishPromise: Promise<Set<string>> | undefined;
  private prelightFinishTargets = new Set<string>();
  private prelightSnapshot = new Map<string, LightingValues>();
  private prelightAppliedValues = new Map<string, LightingValues>();
  private restoredIntentAwaitingOccupancy = false;
  private readonly explicitPowerWhileAwaitingOccupancy = new Set<string>();
  private restoredContinuityPending = false;
  private suppressInitialEmptyContinuity = false;

  constructor(
    private readonly clock: Clock,
    options: EngineOptions = {},
  ) {
    this.convergenceTimeoutMs = options.convergenceTimeoutMs ?? 60_000;
    this.retryDelayMs = options.retryDelayMs ?? 2_000;
    this.holds = new AutomationHolds(clock);
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
    const controlModes = LightingControlModesSchema.parse(
      options.lightingControlModes ?? {},
    );
    for (const [target, mode] of Object.entries(controlModes)) {
      if (!devices[target])
        throw new Error(
          `Lighting control target is not a configured device: ${target}`,
        );
      if (mode === 'enforce') this.enforcedLightingTargets.add(target);
    }
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
      holds: this.holds,
      getState: (target) => this.musicController.getState(target),
      request: (target, request, provenance) =>
        this.musicController.request(target, request, provenance),
      cancelAutomaticFade: (target) => this.musicController.cancelFade(target),
      onChange: () => this.publish(['music', 'intent']),
      onError: (target, operation) => {
        this.addDiagnostic(
          'music.automation_unconfirmed',
          `Music automation could not ${operation} for ${target}`,
          { target, operation },
        );
        this.publish(['music', 'diagnostics']);
      },
    });
    this.musicController.setVolumeRequestGuard((target, provenance) =>
      this.musicAutomation.assertVolumeRequestAllowed(target, provenance),
    );
    this.musicController.setExternalVolumeChangeHandler(
      (target, volume, provenance) =>
        this.musicAutomation.noteExternalVolumeChange(
          target,
          volume,
          provenance,
        ),
    );
    this.musicController.setExternalPlaybackChangeHandler(
      (target, playback, provenance) =>
        this.musicAutomation.noteExternalPlaybackChange(
          target,
          playback,
          provenance,
        ),
    );
    this.musicController.setFadeLifecycleHandler((event) =>
      this.musicAutomation.handleFadeLifecycle(event),
    );
    this.state = {
      revision: 0,
      updatedAt: clock.now(),
      session: null,
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
      intent: { holds: [] },
      commands: this.ledger.records,
      diagnostics: [],
      timings: [],
    };
    this.roomSessions = new RoomSessions(
      clock,
      options.roomSessionContinuityMs ?? 20 * 60_000,
      (session, transition) => {
        this.state.session = session;
        if (transition)
          this.addDiagnostic(
            `session.${transition}`,
            `Room session ${transition}`,
            { ...session },
          );
        this.publish(['presence', 'session', 'diagnostics']);
      },
    );
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
    if (restoredScene === 'scene.all_off' || restoredScene === 'scene.sleep') {
      for (const [target, device] of Object.entries(devices)) {
        if (device.effectiveDesired.power === false)
          this.holds.set('lighting.activation', target, {
            actor: { type: 'automation', id: 'lugn.restore' },
            source: 'restored_lighting_intent',
            reason: 'Retained off scene; original actor is not persisted',
          });
      }
    }
    this.unsubscribers.push(
      this.adapter.subscribe((observation) =>
        this.handleObservation(observation),
      ),
      this.switchAdapter.subscribe((observation) =>
        this.handleSwitchObservation(observation),
      ),
    );
    this.scheduleLightingEnforcement();
    this.publish([
      'presence',
      'session',
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
          'restore',
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
    requested = MusicRequestSchema.parse(requested);
    provenance = ProvenanceSchema.parse(provenance);
    this.musicController.getState(target);
    if (
      !isHumanActor(provenance.actor) &&
      this.holds.blocks('music.playback', target) &&
      (requested.property === 'preset' ||
        (requested.property === 'playback' && requested.value === 'playing'))
    )
      throw new Error('Automatic playback is held by explicit human pause');
    if (requested.property === 'volume')
      this.musicAutomation.assertVolumeRequestAllowed(target, provenance);
    this.musicAutomation.noteExplicitRequest(target, requested, provenance);
    const command = this.musicController.request(target, requested, provenance);
    this.publish(['intent']);
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
    if (
      !isHumanActor(actor) &&
      Object.entries(scene.lighting).some(
        ([target, values]) =>
          Object.keys(values).length > 0 &&
          values.power !== false &&
          this.holds.blocks('lighting.activation', target),
      )
    )
      throw new Error(
        'Automatic lighting is held by explicit human off intent',
      );
    if (sceneId !== 'scene.all_off' && sceneId !== 'scene.sleep')
      this.lastNonOffSceneId = sceneId;
    const restoredTargets =
      this.prelightActive || this.prelightFinishPromise
        ? await this.finishPrelight(true, scene)
        : new Set<string>();
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
    await this.reconcileScene(
      this.state.lighting.sceneRevision,
      undefined,
      restoredTargets,
      { allowInFlight: isHumanActor(actor) },
    );
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
    if (
      !isHumanActor(provenance.actor) &&
      Object.keys(values).length > 0 &&
      values.power !== false &&
      this.holds.blocks('lighting.activation', target)
    )
      throw new Error(
        'Automatic lighting is held by explicit human off intent',
      );
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
    const deviceBeforeUpdate = this.requireDevice(target);
    if (
      isHumanActor(provenance.actor) &&
      values.power === true &&
      deviceBeforeUpdate.effectiveDesired.power === false
    ) {
      for (const property of ['brightness', 'colorTemperature'] as const) {
        if (
          values[property] === undefined &&
          deviceBeforeUpdate.ownership[property]?.kind === 'scene'
        ) {
          delete deviceBeforeUpdate.effectiveDesired[property];
          delete deviceBeforeUpdate.ownership[property];
        }
      }
    }
    if (this.shouldRemainPhysicallyEmpty() && isHumanActor(provenance.actor))
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
      if (isHumanActor(provenance.actor) && targetValues.power !== undefined) {
        this.holds.clear('lighting.activation', lightingTarget);
        if (this.restoredIntentAwaitingOccupancy)
          this.explicitPowerWhileAwaitingOccupancy.add(lightingTarget);
      }
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
        (isHumanActor(provenance.actor) &&
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
    const transitionGeneration =
      normalizedEvent.presence === 'occupied' ||
      normalizedEvent.presence === 'confirmed_empty'
        ? ++this.presenceTransitionGeneration
        : this.presenceTransitionGeneration;
    const receivedAt = this.clock.now();
    const previous = this.state.presence.state;
    const lastConfirmedBeforeEvent = this.lastConfirmedPresence;
    const prelightWasActive = this.prelightActive;
    let restoredTargets = new Set<string>();
    const createsEmptyTiming =
      normalizedEvent.presence === 'confirmed_empty' &&
      (lastConfirmedBeforeEvent !== 'confirmed_empty' || prelightWasActive);
    if (normalizedEvent.presence === 'confirmed_empty') {
      if (lastConfirmedBeforeEvent !== 'confirmed_empty')
        this.manualLightingWhileEmpty.clear();
      this.state.presence.state = normalizedEvent.presence;
      this.state.presence.personCount = normalizedEvent.personCount ?? 0;
      this.lastConfirmedPresence = normalizedEvent.presence;
      this.roomSessions.handlePresence(normalizedEvent.presence);
      this.clearPrelight();
      if (this.prelightFinishPromise) await this.prelightFinishPromise;
    } else if (normalizedEvent.presence === 'occupied') {
      // Publish occupancy to concurrent event handlers before waiting for
      // any prelight restoration already in flight.
      this.state.presence.state = normalizedEvent.presence;
      this.state.presence.personCount = normalizedEvent.personCount ?? null;
      this.lastConfirmedPresence = normalizedEvent.presence;
      this.roomSessions.handlePresence(normalizedEvent.presence);
      this.prelightPreviewActive = false;
      const scene =
        this.scenes.get(
          this.defaultSceneOnOccupancy?.id ??
            this.state.lighting.currentScene ??
            this.lastNonOffSceneId ??
            '',
        ) ?? this.scenes.get('scene.everyday_light');
      if (this.prelightActive || this.prelightFinishPromise) {
        void this.finishPrelight(true, scene);
        restoredTargets = new Set(this.prelightFinishTargets);
      }
    }
    if (transitionGeneration !== this.presenceTransitionGeneration) return;
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
          sessionId: this.state.session?.id ?? null,
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
      if (transitionGeneration !== this.presenceTransitionGeneration) return;
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
        {
          restoredContinuity: returned,
          sessionId: this.state.session?.id ?? null,
        },
      );
      const eventId = `presence-${++this.nextEventId}`;
      const timing = this.createFastPathTiming(
        eventId,
        receivedAt,
        normalizedEvent.localReceivedMonotonicAt,
      );
      this.state.timings.push(timing);
      this.publish(['presence', 'diagnostics', 'timings']);
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
      const defaultScene = this.defaultSceneOnOccupancy;
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
        restoredTargets,
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
      normalized !== 'away' &&
      previous === 'away' &&
      this.state.presence.state === 'occupied'
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
    if (normalizedEvent.active === this.prelightPreviewActive) return;

    this.prelightPreviewActive = normalizedEvent.active;

    if (!normalizedEvent.active) {
      if (!this.prelightActive) return;
      if (this.state.presence.state === 'occupied') {
        await this.finishPrelight(false);
        return;
      }
      this.addDiagnostic(
        'presence.prelight_waiting_for_confirmation',
        'Preview ended; holding temporary lighting until entry is confirmed or its existing maximum duration expires',
        { maximumDurationMs: this.prelightMaxDurationMs },
      );
      this.publish(['diagnostics']);
      return;
    }

    if (this.prelightActive) return;
    if (this.prelightFinishPromise) {
      this.addDiagnostic(
        'presence.prelight_suppressed',
        'Temporary prelight was suppressed while a prior prelight restore is still completing',
        { reason: 'prelight_restore_pending' },
      );
      this.publish(['diagnostics']);
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
    const quietHours = this.isPrelightQuietHours();
    const roomAlreadyLit = this.hasAnyLightOn();
    const homeAway = this.state.presence.home.state === 'away';
    if (
      allLightsOffScene ||
      quietHours ||
      roomAlreadyLit ||
      homeAway ||
      this.state.presence.state === 'occupied'
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
              : roomAlreadyLit
                ? 'room_already_lit'
                : homeAway
                  ? 'home_away'
                  : 'already_occupied',
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
          prelightCommandReason,
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
    forceTargets: ReadonlySet<string> = new Set(),
    options: {
      onlyTargets?: ReadonlySet<string>;
      allowInFlight?: boolean;
    } = {},
  ): Promise<void> {
    if (
      revision !== this.state.lighting.sceneRevision ||
      (this.shouldRemainPhysicallyEmpty() &&
        !this.sceneIntentCanRunWhileEmpty(revision) &&
        this.manualLightingWhileEmpty.size === 0)
    )
      return;
    const retryEventId = this.retryTimers
      .get(String(revision))
      ?.modes.get('scene')?.fastPathEventId;
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
      if (!this.canReconcileLightingTarget(target)) continue;
      if (options.onlyTargets && !options.onlyTargets.has(target)) continue;
      if (!options.allowInFlight && this.hasEnforcedLightingTransport(target))
        continue;
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
            !forceTargets.has(target) &&
            !(forceOff && property === 'power' && value === false))
        )
          continue;
        const pending = this.ledger.latestPending(target, property, value);
        const acceptedPrelightHandoff =
          pending?.reason === prelightCommandReason &&
          (this.acceptedLightingCommandIds.has(pending.id) ||
            this.inFlightLightingCommandIds.has(pending.id));
        const prelightGraceRemaining = acceptedPrelightHandoff
          ? Math.max(0, prelightHandoffGraceMs - (now - pending.issuedAt))
          : 0;
        if (
          pending &&
          (prelightGraceRemaining > 0 ||
            (!acceptedPrelightHandoff &&
              (now - pending.issuedAt < this.retryDelayMs ||
                this.inFlightLightingCommandIds.has(pending.id))))
        )
          continue;
        Object.assign(desired, { [property]: value });
      }
      if (Object.keys(desired).length === 0) continue;
      // Off observations deliberately omit brightness/CCT. The remembered
      // values are not evidence of what a lamp will restore on its next ON.
      if (desired.power === true)
        Object.assign(desired, device.effectiveDesired);
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
      const handoffGraceRemaining = this.ledger.records.reduce(
        (minimum, command) => {
          if (
            command.status !== 'pending' ||
            command.reason !== prelightCommandReason ||
            (!this.acceptedLightingCommandIds.has(command.id) &&
              !this.inFlightLightingCommandIds.has(command.id))
          )
            return minimum;
          return Math.min(
            minimum,
            Math.max(0, prelightHandoffGraceMs - (now - command.issuedAt)),
          );
        },
        Number.POSITIVE_INFINITY,
      );
      this.scheduleRetry(
        revision,
        Math.min(this.retryDelayMs, remaining, handoffGraceRemaining),
        timingEventId,
      );
    } else {
      this.clearRetryTimer(revision);
      if (timedOut && timingEventId) this.terminateFastPathEvent(timingEventId);
    }
    this.publish(['lighting', 'commands', 'diagnostics']);
  }

  dispose(): void {
    this.disposed = true;
    if (this.lightingEnforcementTimer !== undefined)
      this.clock.clearTimeout(this.lightingEnforcementTimer);
    this.lightingEnforcementTimer = undefined;
    this.roomSessions.dispose();
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
    this.prelightPreviewActive = false;
    this.prelightSnapshot.clear();
    this.prelightAppliedValues.clear();
    if (this.activePrelightFastPathEventId)
      this.terminateFastPathEvent(this.activePrelightFastPathEventId);
    this.activePrelightFastPathEventId = undefined;
  }

  private finishPrelight(
    restore: boolean,
    scene?: LightingScene,
    excludedProperties: Map<string, Set<string>> = new Map(),
  ): Promise<Set<string>> {
    if (this.prelightFinishPromise) return this.prelightFinishPromise;
    if (!this.prelightActive) return Promise.resolve(new Set());
    if (this.prelightTimer !== undefined)
      this.clock.clearTimeout(this.prelightTimer);
    this.prelightTimer = undefined;
    this.prelightActive = false;
    this.prelightPreviewActive = false;
    if (this.activePrelightFastPathEventId)
      this.terminateFastPathEvent(this.activePrelightFastPathEventId);
    this.activePrelightFastPathEventId = undefined;
    const snapshot = this.prelightSnapshot;
    this.prelightSnapshot = new Map();
    const appliedValues = this.prelightAppliedValues;
    this.prelightAppliedValues = new Map();
    const restoredTargets = new Set<string>();
    this.prelightFinishTargets = restoredTargets;
    const finish = this.restorePrelightSnapshot(
      restore,
      scene,
      excludedProperties,
      snapshot,
      appliedValues,
      restoredTargets,
    );
    this.prelightFinishPromise = finish.finally(() => {
      this.prelightFinishPromise = undefined;
      if (this.prelightFinishTargets === restoredTargets)
        this.prelightFinishTargets = new Set();
    });
    return this.prelightFinishPromise;
  }

  private async restorePrelightSnapshot(
    restore: boolean,
    scene: LightingScene | undefined,
    excludedProperties: Map<string, Set<string>>,
    snapshot: Map<string, LightingValues>,
    appliedValues: Map<string, LightingValues>,
    restoredTargets: Set<string>,
  ): Promise<Set<string>> {
    if (!restore) return restoredTargets;
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
      if (Object.keys(values).length > 0) {
        restoredTargets.add(target);
        dispatches.push(
          this.dispatch(
            target,
            values,
            this.state.lighting.sceneRevision,
            'prelight.restore',
            prelightRestoreReason,
            systemActor,
          ),
        );
      }
    }
    await Promise.all(dispatches);
    return restoredTargets;
  }

  private beginScene(scene: LightingScene, intent: IntentProvenance): void {
    this.explicitPowerWhileAwaitingOccupancy.clear();
    if (isHumanActor(intent.actor)) {
      for (const target of Object.keys(this.state.lighting.devices))
        this.holds.clear('lighting.activation', target);
      if (scene.id === 'scene.all_off' || scene.id === 'scene.sleep')
        for (const [target, values] of Object.entries(scene.lighting))
          if (values.power === false)
            this.holds.set('lighting.activation', target, intent);
    }
    this.manualLightingWhileEmpty.clear();
    this.defaultSceneOnOccupancy = undefined;
    this.restoredIntentAwaitingOccupancy = false;
    this.terminateAllFastPathEvents();
    const priorRevision = this.state.lighting.sceneRevision;
    this.clearRetryTimer(priorRevision);
    this.clearLightingDeliveryAttempts();
    this.ledger.supersedePending(
      `Superseded by scene revision ${priorRevision + 1}`,
      undefined,
      (command) => {
        if (command.reason !== prelightCommandReason) return false;
        const sceneValues = scene.lighting[command.target];
        return (
          sceneValues !== undefined &&
          LightingProperties.some(
            (property) => command.desired[property] !== undefined,
          ) &&
          LightingProperties.every(
            (property) =>
              command.desired[property] === undefined ||
              command.desired[property] === sceneValues[property],
          )
        );
      },
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
    if (
      values.power !== false &&
      this.holds.blocks('lighting.activation', target)
    )
      return;
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
        this.inFlightLightingCommandIds.delete(command.id);
        this.acceptedLightingCommandIds.delete(command.id);
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
        if (command.reason === prelightCommandReason)
          void this.reconcileScene(this.state.lighting.sceneRevision);
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
    this.inFlightLightingCommandIds.add(command.id);
    this.lightingTransportsInFlight.set(command.id, target);
    try {
      await this.adapter.dispatch({ id: command.id, target, values });
    } catch (error) {
      dispatchFailed = true;
      dispatchError = error;
    }
    this.inFlightLightingCommandIds.delete(command.id);
    this.lightingTransportsInFlight.delete(command.id);
    this.reassertAfterStalePrelightRestore(command);
    if (dispatchFailed && isLightingDeliveryUnknownError(dispatchError)) {
      this.acceptedLightingCommandIds.delete(command.id);
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
      this.acceptedLightingCommandIds.delete(command.id);
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
    if (command.status === 'pending')
      this.acceptedLightingCommandIds.add(command.id);
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

  private reassertAfterStalePrelightRestore(
    command: Pick<
      CommandRecord,
      'id' | 'target' | 'revision' | 'desired' | 'reason'
    >,
  ): void {
    if (command.reason !== prelightRestoreReason) return;
    const isStale =
      command.revision !== this.state.lighting.sceneRevision ||
      this.ledger.latestCommandId(command.target) !== command.id;
    if (!isStale) return;
    const device = this.state.lighting.devices[command.target];
    if (!device) return;
    const conflictsWithCurrentIntent = LightingProperties.some((property) => {
      const restored = command.desired[property];
      const current = device.effectiveDesired[property];
      return (
        restored !== undefined &&
        current !== undefined &&
        restored !== current &&
        device.observed[property] !== current
      );
    });
    if (conflictsWithCurrentIntent)
      void this.reconcileScene(
        this.state.lighting.sceneRevision,
        undefined,
        new Set([command.target]),
      );
  }

  private handleObservation(observation: LightingObservation): void {
    const device = this.state.lighting.devices[observation.target];
    if (!device) return;
    if (observation.commandId) {
      this.inFlightLightingCommandIds.delete(observation.commandId);
      this.acceptedLightingCommandIds.delete(observation.commandId);
    }
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
        !this.manualLightingWhileEmpty.has(observation.target) &&
        !this.hasEnforcedLightingTransport(observation.target)
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
    const feedbackTime = this.clock.now();
    // Capture before attributing any properties: an ON echo can confirm power
    // while the same HA event still contains an intermediate brightness.
    const pendingHaProperties = new Set(
      observation.commandId === undefined &&
        observation.provenance?.actor.type === 'home_assistant'
        ? LightingProperties.filter((property) => {
            const desired = device.effectiveDesired[property];
            if (desired === undefined) return false;
            const pending = this.ledger.latestPending(
              observation.target,
              property,
              desired,
            );
            return (
              pending !== undefined &&
              pending.id === this.latestCommandId(observation.target) &&
              feedbackTime - pending.issuedAt < this.convergenceTimeoutMs
            );
          })
        : [],
    );
    const recovered =
      device.availability !== 'available' &&
      !(
        device.availability === 'degraded' &&
        (pendingHaProperties.size > 0 ||
          this.enforcedLightingTargets.has(observation.target))
      );
    // Partial feedback for our final attempt is not an independent recovery
    // event: it must not grant another three deliveries or remove degradation.
    if (device.availability !== 'degraded' || recovered)
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
    let fastPathEventId = observation.commandId
      ? this.fastPathEventByCommand.get(observation.commandId)
      : undefined;
    let effectiveIntentChanged = false;
    let attributedStaleCommand = false;
    let activePrelightPowerFeedback = false;
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
      if (command) {
        this.inFlightLightingCommandIds.delete(command.id);
        this.acceptedLightingCommandIds.delete(command.id);
      }
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
        property === 'power' &&
        value === true &&
        this.prelightActive &&
        command?.reason === prelightCommandReason
      )
        activePrelightPowerFeedback = true;
      if (
        !this.enforcedLightingTargets.has(observation.target) &&
        !command &&
        !supersededCommand &&
        !pendingHaProperties.has(property) &&
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
        if (property === 'power' && value === true)
          this.holds.clear('lighting.activation', observation.target);
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
    if (currentIntentConfirmed) device.availability = 'available';
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
    if (activePrelightPowerFeedback)
      this.addDiagnostic(
        'presence.prelight_feedback_honored',
        'Prelight ON feedback is allowed while the preview is awaiting occupancy confirmation',
        { target: observation.target },
      );
    this.publish(['lighting', 'commands', 'diagnostics', 'timings']);
    if (
      (!this.shouldRemainPhysicallyEmpty() ||
        this.targetIntentCanRunWhileEmpty(
          this.state.lighting.sceneRevision,
          observation.target,
        )) &&
      !this.restoredIntentAwaitingOccupancy
    ) {
      void this.reconcileScene(
        this.state.lighting.sceneRevision,
        fastPathEventId,
      );
    } else if (
      this.shouldRemainPhysicallyEmpty() &&
      observation.values.power === true &&
      !this.targetIntentCanRunWhileEmpty(
        this.state.lighting.sceneRevision,
        observation.target,
      ) &&
      !activePrelightPowerFeedback &&
      !this.hasEnforcedLightingTransport(observation.target) &&
      (!this.enforcedLightingTargets.has(observation.target) ||
        (!this.ledger.records.some(
          (command) =>
            command.target === observation.target &&
            command.status === 'pending',
        ) &&
          (this.lightingDeliveryAttempts.get(
            this.lightingDeliveryKey(
              this.state.lighting.sceneRevision,
              observation.target,
            ),
          ) ?? 0) < maxLightingDeliveryAttempts))
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
        sessionId: this.state.session?.id ?? null,
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
    for (const retry of this.retryTimers.values()) {
      for (const [mode, scheduled] of retry.modes) {
        if (scheduled.fastPathEventId === eventId) {
          retry.modes.set(mode, { dueAt: scheduled.dueAt });
        }
      }
    }
  }

  private terminateAllFastPathEvents(): void {
    const eventIds = new Set([
      ...this.fastPathMonotonicOrigins.keys(),
      ...this.fastPathEventByCommand.values(),
      ...this.fastPathPrelightExpectedValues.keys(),
      ...[...this.retryTimers.values()]
        .flatMap((retry) => [...retry.modes.values()])
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

  private isPrelightQuietHours(): boolean {
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
      | 'session'
      | 'lighting'
      | 'switches'
      | 'music'
      | 'intent'
      | 'commands'
      | 'diagnostics'
      | 'timings'
    >,
  ): void {
    // Property holds are views of existing ownership, never a second ledger.
    const activeHolds = [
      ...this.holds.snapshot(),
      ...Object.entries(this.state.lighting.devices).flatMap(
        ([target, device]) =>
          LightingProperties.flatMap((property) => {
            const owner = device.ownership[property];
            const value = device.effectiveDesired[property];
            return owner?.kind === 'override' && value !== undefined
              ? [
                  {
                    scope: 'lighting.property' as const,
                    target,
                    property,
                    intent: value,
                    provenance: {
                      actor: owner.actor,
                      source: owner.source,
                      reason: owner.reason,
                    },
                    createdAt: owner.createdAt,
                    resetPolicy: 'lighting_continuity' as const,
                  },
                ]
              : [];
          }),
      ),
    ];
    if (
      JSON.stringify(activeHolds) !== JSON.stringify(this.state.intent.holds)
    ) {
      this.state.intent.holds = activeHolds;
      if (!domains.includes('intent')) domains.push('intent');
    }
    const pendingLightingIds = new Set(
      this.ledger.records
        .filter((command) => command.status === 'pending')
        .map((command) => command.id),
    );
    for (const commandId of this.acceptedLightingCommandIds)
      if (!pendingLightingIds.has(commandId))
        this.acceptedLightingCommandIds.delete(commandId);
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
    const retry = this.retryTimers.get(key) ?? { modes: new Map() };
    const existingMode = retry.modes.get(mode);
    const dueAt = Math.min(
      existingMode?.dueAt ?? Number.POSITIVE_INFINITY,
      this.clock.now() + Math.max(0, delayMs),
    );
    const eventId =
      existingMode?.fastPathEventId &&
      this.fastPathMonotonicOrigins.has(existingMode.fastPathEventId)
        ? existingMode.fastPathEventId
        : fastPathEventId && this.fastPathMonotonicOrigins.has(fastPathEventId)
          ? fastPathEventId
          : undefined;
    retry.modes.set(mode, {
      dueAt,
      ...(eventId === undefined ? {} : { fastPathEventId: eventId }),
    });
    this.retryTimers.set(key, retry);
    this.armRetryTimer(revision, retry);
  }

  private armRetryTimer(revision: number, retry: ScheduledRetry): void {
    const key = String(revision);
    if (retry.modes.size === 0) {
      if (retry.handle !== undefined) this.clock.clearTimeout(retry.handle);
      if (this.retryTimers.get(key) === retry) this.retryTimers.delete(key);
      return;
    }
    const dueAt = Math.min(
      ...[...retry.modes.values()].map((scheduled) => scheduled.dueAt),
    );
    if (
      retry.handle !== undefined &&
      retry.armedAt !== undefined &&
      retry.armedAt <= dueAt
    )
      return;
    if (retry.handle !== undefined) this.clock.clearTimeout(retry.handle);
    retry.armedAt = dueAt;
    const handle = this.clock.setTimeout(
      () => {
        const current = this.retryTimers.get(key);
        if (!current || current !== retry || current.handle !== handle) return;
        delete current.handle;
        delete current.armedAt;
        const now = this.clock.now();
        const dueModes = [...current.modes].filter(
          ([, scheduled]) => scheduled.dueAt <= now,
        );
        for (const [mode] of dueModes) current.modes.delete(mode);
        this.armRetryTimer(revision, current);
        void (async () => {
          for (const [mode, scheduled] of dueModes) {
            const eventId = scheduled.fastPathEventId;
            await this.runScheduledLightingRetry(
              revision,
              mode,
              eventId && this.fastPathMonotonicOrigins.has(eventId)
                ? eventId
                : undefined,
            );
          }
        })();
      },
      Math.max(0, dueAt - this.clock.now()),
    );
    retry.handle = handle;
  }

  private clearRetryTimer(revision: number): void {
    const key = String(revision);
    const retry = this.retryTimers.get(key);
    if (retry?.handle !== undefined) this.clock.clearTimeout(retry.handle);
    this.retryTimers.delete(key);
  }

  private cancelRetryTimers(): void {
    for (const retry of this.retryTimers.values())
      if (retry.handle !== undefined) this.clock.clearTimeout(retry.handle);
    this.retryTimers.clear();
  }

  private lightingDeliveryKey(revision: number, target: string): string {
    return `${revision}:${target}`;
  }

  private scheduleLightingEnforcement(): void {
    if (this.disposed || this.enforcedLightingTargets.size === 0) return;
    this.lightingEnforcementTimer = this.clock.setTimeout(() => {
      this.lightingEnforcementTimer = undefined;
      this.scheduleLightingEnforcement();
      void this.enforceLighting();
    }, lightingEnforcementIntervalMs);
  }

  /** Start another bounded attempt for opted-in lights without changing intent. */
  private async enforceLighting(): Promise<void> {
    if (this.disposed || this.prelightActive || this.prelightFinishPromise)
      return;
    const revision = this.state.lighting.sceneRevision;
    const sceneTargets = new Set<string>();
    const dispatches: Promise<void>[] = [];
    for (const target of this.enforcedLightingTargets) {
      const device = this.requireDevice(target);
      const emptyOff =
        this.shouldRemainPhysicallyEmpty() &&
        !this.targetIntentCanRunWhileEmpty(revision, target);
      if (!emptyOff && !this.canReconcileLightingTarget(target)) continue;
      const desired = emptyOff ? { power: false } : device.effectiveDesired;
      const mismatch = LightingProperties.some((property) => {
        if (desired.power === false && property !== 'power') return false;
        const value = desired[property];
        return value !== undefined && value !== device.observed[property];
      });
      if (!mismatch) continue;
      // Never overlap a transport call or interrupt a still-active retry batch.
      const pending = this.ledger.records.filter(
        (command) => command.target === target && command.status === 'pending',
      );
      if (
        this.hasEnforcedLightingTransport(target) ||
        (device.availability !== 'degraded' &&
          pending.some(
            (command) =>
              this.clock.now() - command.issuedAt < this.convergenceTimeoutMs,
          ))
      )
        continue;
      this.ledger.supersedePending(
        'Starting periodic lighting enforcement',
        target,
      );
      this.startConvergenceAttempt(revision, target);
      if (emptyOff)
        dispatches.push(
          this.dispatch(
            target,
            { power: false },
            revision,
            'presence',
            'Confirmed empty: periodic physical off enforcement',
            systemActor,
            undefined,
            undefined,
            'confirmed_empty_off',
          ),
        );
      else sceneTargets.add(target);
    }
    if (sceneTargets.size > 0)
      dispatches.push(
        this.reconcileScene(revision, undefined, new Set(), {
          onlyTargets: sceneTargets,
        }),
      );
    await Promise.all(dispatches);
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
      this.enforcedLightingTargets.has(target)
        ? `Paused retries for ${target} after ${attempts} attempts; periodic enforcement remains active`
        : `Stopped retrying ${target} after ${attempts} absolute-state delivery attempts without confirmation`,
      { target, attempts, attemptLimit: maxLightingDeliveryAttempts },
    );
  }

  private canReconcileLightingTarget(target: string): boolean {
    const device = this.requireDevice(target);
    // OFF never needs permission to activate a remembered scene.
    if (device.effectiveDesired.power === false) return true;
    if (this.holds.blocks('lighting.activation', target)) return false;
    if (
      this.restoredIntentAwaitingOccupancy &&
      !this.explicitPowerWhileAwaitingOccupancy.has(target)
    )
      return false;
    const powerOwner = device.ownership.power;
    const explicitPower =
      powerOwner?.kind === 'override' && isHumanActor(powerOwner.actor);
    return (
      this.state.presence.home.state !== 'away' ||
      this.intentByRevision.get(this.state.lighting.sceneRevision)?.source !==
        'presence' ||
      explicitPower
    );
  }

  private hasEnforcedLightingTransport(target: string): boolean {
    return (
      this.enforcedLightingTargets.has(target) &&
      [...this.lightingTransportsInFlight.values()].includes(target)
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
      if (!this.canReconcileLightingTarget(target)) continue;
      if (this.hasEnforcedLightingTransport(target)) continue;
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
          this.canReconcileLightingTarget(target) &&
          !this.hasEnforcedLightingTransport(target) &&
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
      if (!this.canReconcileLightingTarget(target)) continue;
      if (this.hasEnforcedLightingTransport(target)) continue;
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
    if (!this.canReconcileLightingTarget(command.target)) return false;
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
        this.hasEnforcedLightingTransport(target) ||
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
