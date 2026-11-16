import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PhoneIngress } from '../../src/adapters/phone-ingress.js';
import {
  CapabilityRegistry,
  type CapabilityInvocation,
} from '../../src/application/capabilities.js';
import { withRoomPresets } from '../../src/application/dashboard-scenes.js';
import {
  defaultScenes,
  LugnEngine,
} from '../../src/application/lugn-engine.js';
import { PresenceFeedback } from '../../src/application/presence-feedback.js';
import { RoutineService } from '../../src/application/routines.js';
import {
  buildStateView,
  type StateViewSources,
} from '../../src/application/state-view.js';
import { systemClock } from '../../src/core/clock.js';
import {
  unknownComputerReadings,
  type ComputerObservation,
} from '../../src/core/computer.js';
import type {
  StateView,
  StateViewSections,
} from '../../src/core/device-api.js';
import { defaultPresenceFeedbackSettings } from '../../src/core/presence-feedback.js';
import { createRoutineTemplates } from '../../src/core/routines.js';
import type { PresenceEvent } from '../../src/core/schemas.js';
import { createComputerIntelligenceRuntime } from '../../src/runtime/computer-intelligence-runtime.js';
import { DeviceCommandService } from '../../src/runtime/device-commands.js';
import {
  DeviceApiConfigSchema,
  phoneConfigResponse,
} from '../../src/runtime/device-config.js';
import { DeviceRequestError } from '../../src/runtime/device-http.js';
import { DeviceRegistry } from '../../src/runtime/device-registry.js';
import { LugnDeviceServer } from '../../src/runtime/device-server.js';
import { LugnHttpServer } from '../../src/runtime/http-server.js';
import { IntelligenceApi } from '../../src/runtime/intelligence-api.js';
import { IntelligenceSettingsStore } from '../../src/runtime/intelligence-settings-store.js';
import { RoutineApi } from '../../src/runtime/routine-api.js';
import { RoutineStore } from '../../src/runtime/routine-store.js';
import type { SimClock } from './sim-clock.js';
import {
  seededRandom,
  SimLights,
  SimSpeaker,
  type Random,
} from './sim-devices.js';

export const SIM_LIGHTS = [
  'lighting.bed',
  'lighting.ceiling',
  'lighting.desk',
] as const;
export const SIM_MUSIC = 'music.room';
export const SIM_COMPUTER = 'desktop';
/** A simulated phone that is not paired; its hints still reach the engine. */
export const SIM_PHONE_ID = 'dev_simulatedphone22';
export const SIM_PHONE_NAME = 'Simulerad iPhone';

/** Scenario actions arrive as Hub taps, so the why feed shows `Hub`. */
export const SIM_INVOCATION: CapabilityInvocation = {
  actor: { type: 'user', id: 'device-sim' },
  source: 'lugn.display.device-sim',
};

export type SimRoomOptions = {
  clock: SimClock;
  stateDir: string;
  /** Device API bind address. */
  host: string;
  port: number;
  allowedHosts: readonly string[];
  /** Loopback control-panel API port, or null to leave it off. */
  controlPanelPort: number | null;
  webAssetsDirectory?: string;
  seed?: number;
  /** A well-known code that always pairs, for scripted tests. */
  fixedPairingCode?: string;
  /** Shift paired phones' observation timestamps onto the virtual clock. */
  shiftPhoneClock?: boolean;
  log?: (line: string) => void;
};

type AckFault = { kind: 'slow'; delayMs: number } | { kind: 'fail' };

/** Pending command-response faults; each command consumes one. */
export class AckFaults {
  private readonly queue: AckFault[] = [];
  add(fault: AckFault, count = 1): void {
    for (let i = 0; i < count; i++) this.queue.push(fault);
  }
  take(): AckFault | undefined {
    return this.queue.shift();
  }
  clear(): void {
    this.queue.length = 0;
  }
  get size(): number {
    return this.queue.length;
  }
}

/** Phone commands with injectable slow or failed acknowledgements. */
class SimCommandService extends DeviceCommandService {
  constructor(
    options: ConstructorParameters<typeof DeviceCommandService>[0],
    private readonly faults: AckFaults,
    private readonly log: (line: string) => void,
  ) {
    super(options);
  }

  override async execute(
    deviceId: string,
    raw: unknown,
  ): ReturnType<DeviceCommandService['execute']> {
    const fault = this.faults.take();
    if (fault?.kind === 'fail') {
      // Nothing ran, so a retry with the same requestId acts normally.
      this.log('ack: failing this command with 502 command_failed (injected)');
      throw new DeviceRequestError(502, 'command_failed');
    }
    const result = await super.execute(deviceId, raw);
    if (fault?.kind === 'slow') {
      // The command already ran; state patches overtake the late answer.
      this.log(`ack: holding the response for ${fault.delayMs} ms (injected)`);
      await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
    }
    return result;
  }
}

/** Device registry that also accepts one fixed, reusable development code. */
export class SimDeviceRegistry extends DeviceRegistry {
  autoCode: string | undefined;
  onAutoCodeUsed: (() => void) | undefined;

  constructor(
    filePath: string,
    private readonly fixedCode: string | undefined,
    onWarning: (message: string) => void,
  ) {
    // Pairing codes expire in wall time, whatever the simulation speed.
    super(filePath, { clock: systemClock, onWarning });
  }

  override async pair(rawInput: unknown): ReturnType<DeviceRegistry['pair']> {
    const code =
      rawInput && typeof rawInput === 'object' && 'code' in rawInput
        ? normalizeCode(rawInput.code)
        : undefined;
    if (this.fixedCode !== undefined && code === this.fixedCode) {
      const issued = this.createPairingCode({ ttlSeconds: 60 });
      return super.pair({ ...(rawInput as object), code: issued.code });
    }
    const result = await super.pair(rawInput);
    if (code !== undefined && code === this.autoCode) this.onAutoCodeUsed?.();
    return result;
  }
}

export function normalizeCode(code: unknown): string | undefined {
  return typeof code === 'string'
    ? code.trim().replace('-', '').toUpperCase()
    : undefined;
}

/** Air in a small bedroom: CO₂ follows people, temperature drifts slowly. */
export class SimEnvironment {
  co2 = 520;
  temperature = 21.2;
  humidity = 39;
  pm25 = 4;
  observedAt: number;
  windowOpen = false;

  constructor(
    now: number,
    private readonly random: Random,
  ) {
    this.observedAt = now;
  }

  step(now: number, people: number): void {
    // Integrate in one-minute slices so long jumps stay stable.
    let remaining = Math.min(
      24 * 60,
      Math.max(0, (now - this.observedAt) / 60_000),
    );
    if (remaining === 0) return;
    const hour = stockholmHour(now);
    while (remaining > 0) {
      const minutes = Math.min(1, remaining);
      remaining -= minutes;
      const outdoor = this.windowOpen ? 420 : 460;
      // About 25 ppm per person-minute in a closed room, minus ventilation.
      const decay = (this.windowOpen ? 0.25 : 0.03) * (this.co2 - outdoor);
      this.co2 = clamp(this.co2 + minutes * (people * 25 - decay), 410, 2_400);
      const base = 20.4 + 1.2 * Math.sin(((hour - 9) / 24) * 2 * Math.PI);
      const targetTemperature =
        base + people * 0.35 - (this.windowOpen ? 1.8 : 0);
      this.temperature +=
        (targetTemperature - this.temperature) * Math.min(1, minutes * 0.05);
      const targetHumidity = 37 + people * 3 + (this.windowOpen ? 6 : 0);
      this.humidity +=
        (targetHumidity - this.humidity) * Math.min(1, minutes * 0.04);
    }
    this.co2 = clamp(this.co2 + this.noise(4), 410, 2_400);
    this.temperature = clamp(this.temperature + this.noise(0.05), 15, 28);
    this.humidity = clamp(this.humidity + this.noise(0.3), 20, 70);
    this.pm25 = clamp(this.pm25 + this.noise(0.6), 1, 35);
    this.observedAt = now;
  }

  snapshot(): StateViewSections['environment'] {
    const at = this.observedAt;
    return {
      temperature: {
        value: round(this.temperature, 1),
        unit: '°C',
        observedAt: at,
      },
      humidity: { value: Math.round(this.humidity), unit: '%', observedAt: at },
      co2: { value: Math.round(this.co2), unit: 'ppm', observedAt: at },
      pm25: { value: round(this.pm25, 1), unit: 'µg/m³', observedAt: at },
    };
  }

  private noise(amplitude: number): number {
    return (this.random() * 2 - 1) * amplitude;
  }
}

/** A desktop agent that reports the computer's activity every few seconds. */
class SimDesktop {
  private activity: ComputerObservation['activity']['classification'] | 'off' =
    'off';
  private sequence = 0;
  private sessionId = newSessionId();
  private timer: ReturnType<SimClock['setTimeout']> | undefined;

  constructor(
    private readonly clock: SimClock,
    private readonly engine: LugnEngine,
  ) {}

  get current(): string {
    return this.activity;
  }

  set(
    activity: ComputerObservation['activity']['classification'] | 'off',
  ): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    if (
      this.activity === 'off' &&
      activity !== 'off' &&
      activity !== 'desktop'
    ) {
      // A new agent session starts with a baseline report; suggestions only
      // follow an activity change seen after it, as with the real agent.
      this.sessionId = newSessionId();
      this.activity = 'desktop';
      this.report();
      if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
      this.timer = this.clock.setTimeout(() => {
        this.activity = activity;
        this.report();
      }, 1_000);
      return;
    }
    if (this.activity === 'off') this.sessionId = newSessionId();
    this.activity = activity;
    this.report();
  }

  dispose(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private report(): void {
    const now = this.clock.now();
    const online = this.activity !== 'off';
    const classification = online ? this.activity : 'unknown';
    const playing = classification === 'music' || classification === 'video';
    this.engine.acceptComputerObservation({
      deviceId: SIM_COMPUTER,
      availability: online ? 'online' : 'offline',
      freshness: 'fresh',
      reason: online ? 'live' : 'offline',
      observedAt: now,
      receivedAt: now,
      sessionId: this.sessionId,
      sequence: this.sequence++,
      lastEvent: null,
      observed: online
        ? {
            ...unknownComputerReadings(),
            networkOnline: true,
            locked: false,
            idle: classification === 'idle',
            fullscreen:
              classification === 'gaming' || classification === 'video',
            activeApplication: null,
            audio: {
              playing,
              applications: playing ? ['simulated'] : [],
              roles: playing ? ['music'] : [],
            },
            media: [],
          }
        : unknownComputerReadings(),
      activity: {
        classification,
        source: 'desktop-agent',
        basis: 'device-sim',
      },
    } as ComputerObservation);
    if (online) this.timer = this.clock.setTimeout(() => this.report(), 5_000);
  }
}

/**
 * The real Lugn engine, routines, computer suggestions, phone ingress, device
 * listener and loopback control-panel API, wired to simulated lights, speaker,
 * presence sensor, desktop agent and air sensor. Nothing reaches the network
 * except the listeners themselves.
 */
export class SimRoom {
  readonly clock: SimClock;
  readonly random: Random;
  readonly lights: SimLights;
  readonly speaker: SimSpeaker;
  readonly engine: LugnEngine;
  readonly capabilities: CapabilityRegistry;
  readonly presence: PresenceFeedback;
  readonly environment: SimEnvironment;
  readonly ackFaults = new AckFaults();
  readonly integrations: Record<string, string> = {
    home_assistant: 'connected',
    mqtt: 'connected',
  };
  instanceId = newInstanceId();
  restarts = 0;
  pairingCode: { code: string; expiresAt: number } | undefined;

  private readonly options: SimRoomOptions;
  private readonly log: (line: string) => void;
  private readonly signalListeners = new Set<() => void>();
  private readonly disposers: Array<() => void> = [];
  private registry!: SimDeviceRegistry;
  private routines!: RoutineService;
  private experience!: IntelligenceApi;
  private phoneIngress!: PhoneIngress;
  private intelligence!: ReturnType<typeof createComputerIntelligenceRuntime>;
  private desktop!: SimDesktop;
  private deviceServer: LugnDeviceServer | undefined;
  private controlPanel: LugnHttpServer | undefined;
  private transition: Promise<void> = Promise.resolve();
  private deviceOnline = false;
  private phoneSequence = 0;
  private readonly phoneSession = randomUUID();
  private pairingTimer: ReturnType<typeof setTimeout> | undefined;
  private environmentTimer: ReturnType<SimClock['setTimeout']> | undefined;
  private trackTimer: ReturnType<SimClock['setTimeout']> | undefined;

  constructor(options: SimRoomOptions) {
    this.options = options;
    this.log = options.log ?? (() => undefined);
    this.clock = options.clock;
    this.random = seededRandom(options.seed ?? 20_261_116);
    this.lights = new SimLights(this.clock, this.random);
    this.speaker = new SimSpeaker(this.clock, this.random, [SIM_MUSIC]);
    this.engine = new LugnEngine(this.clock, {
      adapter: this.lights,
      deviceIds: [...SIM_LIGHTS],
      scenes: withRoomPresets(defaultScenes, [...SIM_LIGHTS]),
      music: {
        targets: { [SIM_MUSIC]: ['Spotify', 'Optical'] },
        adapter: this.speaker,
        observationTrusted: () => this.speaker.available,
      },
    });
    this.presence = new PresenceFeedback({
      clock: this.clock,
      forward: (event) => {
        void this.engine
          .handleEvent(event)
          .catch((error: unknown) =>
            this.log(`presence event rejected: ${String(error)}`),
          );
      },
      save: async (settings) => settings,
      onExitPending: (pending) => this.engine.setPresenceExitPending(pending),
      initial: { ...defaultPresenceFeedbackSettings, exitGraceSeconds: 45 },
    });
    this.capabilities = new CapabilityRegistry(this.engine, {
      presenceFeedback: this.presence,
    });
    this.environment = new SimEnvironment(this.clock.now(), this.random);
  }

  get statePath(): string {
    return this.options.stateDir;
  }

  get deviceAddress(): { host: string; port: number } | undefined {
    return this.deviceServer?.address;
  }

  /** The loopback control-panel API, when enabled. */
  get controlPanelUrl(): string | undefined {
    return this.controlPanel
      ? `http://127.0.0.1:${this.options.controlPanelPort}`
      : undefined;
  }

  get online(): boolean {
    return this.deviceOnline;
  }

  get desktopActivity(): string {
    return this.desktop.current;
  }

  async start(): Promise<void> {
    const { stateDir } = this.options;
    this.registry = new SimDeviceRegistry(
      join(stateDir, 'devices.json'),
      this.options.fixedPairingCode,
      (message) => this.log(message),
    );
    await this.registry.load();
    this.registry.onAutoCodeUsed = () => {
      this.log('pairing code used; issuing a fresh one');
      this.issuePairingCode();
    };
    const routineStore = new RoutineStore(
      join(stateDir, 'routines.json'),
      createRoutineTemplates({
        lightTargets: [...SIM_LIGHTS],
        musicTarget: SIM_MUSIC,
      }),
      (message) => this.log(message),
    );
    await routineStore.load();
    const soft = this.engine.scenes.get('scene.soft_light')?.lighting ?? {};
    this.routines = new RoutineService(this.clock, {
      engine: this.engine,
      capabilities: this.capabilities,
      store: routineStore,
      bedtime: {
        lightTargets: Object.entries(soft)
          .filter(([, values]) => values.power !== false)
          .map(([target]) => target),
        musicTarget: SIM_MUSIC,
      },
    });
    const intelligenceStore = new IntelligenceSettingsStore(
      join(stateDir, 'intelligence.json'),
      (message) => this.log(message),
    );
    await intelligenceStore.load();
    this.intelligence = createComputerIntelligenceRuntime({
      clock: this.clock,
      engine: this.engine,
      capabilities: this.capabilities,
      settingsStore: intelligenceStore,
      computerDeviceIds: [SIM_COMPUTER],
      computerAudio: {},
      observationTrusted: () => this.speaker.available,
    });
    const document = intelligenceStore.snapshot();
    await this.intelligence.service.updateSettings(
      {
        ...document.settings,
        suggestions: {
          enabled: true,
          cooldownMs: 60_000,
          sceneMappings: {
            gaming: 'scene.focus_light',
            video: 'scene.movie_light',
          },
        },
      },
      document.generation,
    );
    this.experience = new IntelligenceApi(
      new RoutineApi(this.routines, routineStore),
      this.intelligence.service,
    );
    this.desktop = new SimDesktop(this.clock, this.engine);
    // Only the phone section matters here; the listener itself is built below.
    const phoneConfig = DeviceApiConfigSchema.parse({
      enabled: true,
      host: '127.0.0.1',
      port: 8789,
      allowedHosts: ['127.0.0.1:8789'],
      phone: { arrivalPrelight: { enabled: true } },
    }).phone;
    this.phoneIngress = new PhoneIngress({
      clock: this.clock,
      signals: phoneConfig.signals,
      maxObservationAgeMs: phoneConfig.maxObservationAgeSeconds * 1000,
      arrivalPrelight: {
        enabled: phoneConfig.arrivalPrelight.enabled,
        zoneId: phoneConfig.arrivalPrelight.zoneId,
        windowMs: phoneConfig.arrivalPrelight.windowSeconds * 1000,
      },
      onState: (state) => this.engine.acceptPhoneState(state),
      onArrivalHint: (hint) => this.engine.setPrelightArrivalHint(hint),
    });
    this.phoneConfig = phoneConfigResponse(phoneConfig);

    // What Home Assistant would report at startup: everything off and idle.
    for (const target of SIM_LIGHTS) {
      this.lights.observed.set(target, {
        power: false,
        brightness: 0,
        colorTemperature: 2700,
      });
      this.lights.report(target);
    }
    this.speaker.report(SIM_MUSIC);
    await this.engine.handleHomePresence('home', this.clock.now());
    this.scheduleEnvironment();
    this.scheduleTracks();

    if (this.options.controlPanelPort !== null) {
      this.controlPanel = new LugnHttpServer({
        host: '127.0.0.1',
        port: this.options.controlPanelPort,
        engine: this.engine,
        capabilities: this.capabilities,
        experience: this.experience,
        deviceRegistry: this.registry,
        integrations: () => ({ ...this.integrations }),
        musicObservationTrustProvider: () => ({
          [SIM_MUSIC]: this.speaker.available,
        }),
        ...(this.options.webAssetsDirectory === undefined
          ? {}
          : { webAssetsDirectory: this.options.webAssetsDirectory }),
      });
      await this.controlPanel.start();
    }
    this.deviceServer = this.createDeviceServer();
    await this.deviceServer.start();
    this.deviceOnline = true;
    this.issuePairingCode();
  }

  private phoneConfig!: ReturnType<typeof phoneConfigResponse>;

  private sources(): StateViewSources {
    return {
      engine: this.engine,
      instanceId: this.instanceId,
      now: () => this.clock.now(),
      integrations: () => ({ ...this.integrations }),
      scenePresetsEditable: false,
      experience: this.experience,
      environment: () => this.environment.snapshot(),
    };
  }

  /** The state view a client would receive right now. */
  view(): StateView {
    return buildStateView(this.sources());
  }

  private createDeviceServer(): LugnDeviceServer {
    const phone = this.phoneIngress;
    const shift = this.options.shiftPhoneClock ?? true;
    return new LugnDeviceServer({
      host: this.options.host,
      port: this.deviceAddress?.port ?? this.options.port,
      allowedHosts: this.options.allowedHosts,
      registry: this.registry,
      clock: this.clock,
      room: {
        sources: this.sources(),
        stream: this.engine.stream,
        subscribeAuxiliary: [
          (listener) => this.experience.subscribe(listener),
          (listener) => this.subscribeSignals(listener),
        ],
        commands: new SimCommandService(
          {
            capabilities: this.capabilities,
            experience: this.experience,
            revision: () => this.engine.state.revision,
            clock: this.clock,
          },
          this.ackFaults,
          this.log,
        ),
      },
      phone: {
        ingress: {
          accept: (deviceId, name, body) =>
            phone.accept(
              deviceId,
              name,
              shift
                ? shiftObservations(body, this.clock.offsetFromWallClock())
                : body,
            ),
          forget: (deviceId) => phone.forget(deviceId),
        },
        config: this.phoneConfig,
      },
    });
  }

  /** Listener for environment and health changes outside the engine revision. */
  subscribeSignals(listener: () => void): () => void {
    this.signalListeners.add(listener);
    return () => this.signalListeners.delete(listener);
  }

  private signal(): void {
    for (const listener of [...this.signalListeners]) listener();
  }

  issuePairingCode(): { code: string; expiresAt: number } | undefined {
    if (this.pairingTimer) clearTimeout(this.pairingTimer);
    try {
      const issued = this.registry.createPairingCode({ ttlSeconds: 900 });
      this.pairingCode = { code: issued.code, expiresAt: issued.expiresAt };
      this.registry.autoCode = normalizeCode(issued.code);
      this.pairingTimer = setTimeout(
        () => {
          this.log('pairing code expired; issuing a fresh one');
          this.issuePairingCode();
        },
        Math.max(1_000, issued.expiresAt - Date.now()),
      );
      this.pairingTimer.unref();
      this.onPairingCode?.(this.pairingCode);
      return this.pairingCode;
    } catch (error) {
      this.log(`could not issue a pairing code: ${String(error)}`);
      return undefined;
    }
  }

  onPairingCode:
    ((code: { code: string; expiresAt: number }) => void) | undefined;

  /** Creates a device token directly, for the recorder and tests. */
  async pairInternal(name: string): Promise<string> {
    const issued = this.registry.createPairingCode({ ttlSeconds: 60 });
    const paired = await this.registry.pair({
      code: issued.code,
      name,
      platform: 'ios',
    });
    return paired.token;
  }

  // --- Room events -------------------------------------------------------

  async sensor(
    presence: PresenceEvent['presence'],
    personCount?: number | null,
  ): Promise<void> {
    this.presence.accept({
      type: 'presence.changed',
      presence,
      ...(personCount === undefined ? {} : { personCount }),
      occurredAt: this.clock.now(),
      source: 'presence.device-sim',
    });
    await settle();
  }

  async prelight(active: boolean): Promise<void> {
    this.presence.accept({
      type: 'presence.prelight',
      active,
      occurredAt: this.clock.now(),
      source: 'presence.device-sim',
    });
    await settle();
  }

  async home(state: 'home' | 'away' | 'unknown'): Promise<void> {
    await this.engine.handleHomePresence(state, this.clock.now());
  }

  async invoke(name: string, input: unknown): Promise<unknown> {
    return this.capabilities.invoke(
      name as Parameters<CapabilityRegistry['invoke']>[0],
      input as never,
      SIM_INVOCATION,
    );
  }

  async experienceRequest(
    route: Parameters<IntelligenceApi['request']>[0],
    body: unknown,
  ): Promise<unknown> {
    return this.experience.request(route, body, {
      ...SIM_INVOCATION,
      requestId: `device-sim:${randomUUID()}`,
    });
  }

  routinesGeneration(): string | null {
    return this.view().routines?.generation ?? null;
  }

  setDesktop(activity: Parameters<SimDesktop['set']>[0]): void {
    this.desktop.set(activity);
  }

  setHealth(integration: string, status: string): void {
    this.integrations[integration] = status;
    this.signal();
  }

  setWindowOpen(open: boolean): void {
    this.environment.windowOpen = open;
    this.updateEnvironment();
  }

  /** The simulated phone reports something, as a paired iPhone would. */
  phoneObservation(
    observation: Record<string, unknown> & { type: string },
  ): string {
    const now = this.clock.now();
    const result = this.phoneIngress.accept(SIM_PHONE_ID, SIM_PHONE_NAME, {
      sessionId: this.phoneSession,
      observations: [
        {
          eventId: randomUUID(),
          sequence: ++this.phoneSequence,
          observedAt: now,
          ...observation,
        },
      ],
    });
    return result.results[0]?.status ?? 'unknown';
  }

  // --- Server lifecycle ----------------------------------------------------

  /** Stops the device listener and starts it again with a new instanceId. */
  restart(downMs = 2_000): Promise<void> {
    return this.serialize(async () => {
      await this.deviceServer?.stop();
      this.deviceOnline = false;
      const previous = this.instanceId;
      this.instanceId = newInstanceId();
      this.restarts += 1;
      this.log(
        `restart: listener down for ${downMs} ms; instanceId ${previous} → ${this.instanceId}`,
      );
      await wallSleep(downMs);
      this.deviceServer = this.createDeviceServer();
      await this.deviceServer.start();
      this.deviceOnline = true;
      this.log('restart: listener back; clients must take a fresh snapshot');
    });
  }

  /** Makes the listener unreachable without restarting Lugn. */
  offline(durationMs: number): Promise<void> {
    return this.serialize(async () => {
      await this.deviceServer?.stop();
      this.deviceOnline = false;
      this.log(`offline: listener unreachable for ${durationMs} ms`);
      await wallSleep(durationMs);
      await this.deviceServer?.start();
      this.deviceOnline = true;
      this.log('offline: listener reachable again; resume with Last-Event-ID');
    });
  }

  async stop(): Promise<void> {
    await this.transition.catch(() => undefined);
    if (this.pairingTimer) clearTimeout(this.pairingTimer);
    if (this.environmentTimer !== undefined)
      this.clock.clearTimeout(this.environmentTimer);
    if (this.trackTimer !== undefined) this.clock.clearTimeout(this.trackTimer);
    for (const dispose of this.disposers.splice(0)) dispose();
    await this.deviceServer?.stop();
    this.deviceOnline = false;
    await this.controlPanel?.stop();
    this.desktop?.dispose();
    this.routines?.dispose();
    this.intelligence?.dispose();
    this.phoneIngress?.dispose();
    this.presence.dispose();
    this.engine.dispose();
    this.signalListeners.clear();
  }

  private serialize(work: () => Promise<void>): Promise<void> {
    const next = this.transition.then(work, work);
    this.transition = next.catch(() => undefined);
    return next;
  }

  private personCount(): number {
    const presence = this.engine.state.presence;
    if (presence.state !== 'occupied') return 0;
    return presence.personCount ?? 1;
  }

  updateEnvironment(): void {
    this.environment.step(this.clock.now(), this.personCount());
    this.signal();
  }

  private scheduleEnvironment(): void {
    this.environmentTimer = this.clock.setTimeout(() => {
      // A time jump updates once at the end instead of flooding clients.
      if (!this.clock.isJumping) this.updateEnvironment();
      this.scheduleEnvironment();
    }, 30_000);
  }

  private scheduleTracks(): void {
    this.trackTimer = this.clock.setTimeout(() => {
      this.speaker.advanceTrack(SIM_MUSIC);
      this.scheduleTracks();
    }, 3 * 60_000);
  }
}

/**
 * Moves wall-clock observation timestamps onto the virtual clock so a real
 * phone's events are judged consistently when the simulation runs fast or
 * has jumped ahead. Malformed bodies pass through for normal validation.
 */
export function shiftObservations(body: unknown, offsetMs: number): unknown {
  if (offsetMs === 0 || !body || typeof body !== 'object') return body;
  const observations = (body as { observations?: unknown }).observations;
  if (!Array.isArray(observations)) return body;
  return {
    ...body,
    observations: observations.map((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return entry;
      const shifted: Record<string, unknown> = { ...entry };
      if (typeof shifted['observedAt'] === 'number')
        shifted['observedAt'] = (shifted['observedAt'] as number) + offsetMs;
      if (shifted['type'] === 'wake_alarm' && typeof shifted['at'] === 'number')
        shifted['at'] = (shifted['at'] as number) + offsetMs;
      return shifted;
    }),
  };
}

function newSessionId(): string {
  return `sim-${randomBytes(4).toString('hex')}`;
}

function newInstanceId(): string {
  return randomBytes(6).toString('hex');
}

/** Lets promise chains started by an event finish. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function wallSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const hourFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Stockholm',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function stockholmHour(at: number): number {
  const [hour, minute] = hourFormat.format(at).split(':').map(Number) as [
    number,
    number,
  ];
  return hour + minute / 60;
}
