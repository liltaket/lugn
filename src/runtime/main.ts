import { CameraDashboardService } from '../application/camera-dashboard.js';
import { createCameraSettings } from '../core/cameras.js';
import { CameraSettingsStore } from './camera-settings-store.js';
import { CameraMediaProvider } from './camera-media.js';
import type { PhotoLibrary } from './photo-library.js';
import { MusicVolumeSettingsStore } from './music-volume-settings-store.js';
import { HomeAssistantArtworkService } from './artwork-service.js';
import { ComputerNowPlayingSelector } from '../application/computer-now-playing.js';
import { RoutineService } from '../application/routines.js';
import { createRoutineTemplates } from '../core/routines.js';
import { RoutineStore } from './routine-store.js';
import { RoutineApi } from './routine-api.js';
import { IntelligenceSettingsStore } from './intelligence-settings-store.js';
import { IntelligenceApi } from './intelligence-api.js';
import { createComputerIntelligenceRuntime } from './computer-intelligence-runtime.js';
import { ArtworkPaletteService } from './artwork-palette-service.js';
import { SteamCoverPaletteService } from './steam-cover-palette-service.js';
import { DynamicLightingController } from '../application/dynamic-lighting.js';
import { CompositeMusicAdapter } from '../adapters/composite-music.js';
import { HomeAssistantMusicAdapter } from '../adapters/home-assistant-music.js';
import {
  WiimMusicAdapter,
  createWiimHttpsTransport,
  type WiimTransport,
  type WiimUpnpSubscriber,
} from '../adapters/wiim-music.js';
import { HomeAssistantBilresaAdapter } from '../adapters/home-assistant-bilresa.js';
import { AssistantEntitiesMqttAdapter } from '../adapters/assistant-entities-mqtt.js';
import { HomeAssistantEnvironmentAdapter } from '../adapters/home-assistant-environment.js';
import { HomeAssistantPrinterAdapter } from '../adapters/home-assistant-printer.js';
import { PrinterActivityService } from './printer-activity-service.js';
import { HomeAssistantHomePresenceAdapter } from '../adapters/home-assistant-home-presence.js';
import { HomeAssistantSunAdapter } from '../adapters/home-assistant-sun.js';
import { HomeAssistantButtonAdapter } from '../adapters/home-assistant-button.js';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DashCastAdapter } from '../adapters/dashcast.js';
import {
  GoveePresetLightingAdapter,
  GoveeSocketClient,
  type GoveeControlClient,
} from '../adapters/govee-preset-lighting.js';
import { HomeAssistantLightingAdapter } from '../adapters/home-assistant-lighting.js';
import { HomeAssistantSwitchAdapter } from '../adapters/home-assistant-switch.js';
import {
  HomeAssistantWebSocketTransport,
  type HomeAssistantSocketFactory,
  type HomeAssistantConnection,
} from '../adapters/home-assistant-websocket.js';
import { PresenceEventIngress } from '../adapters/presence-event-ingress.js';
import { ChimePlayer, warmChimes } from '../adapters/chime-player.js';
import { PresenceFeedback } from '../application/presence-feedback.js';
import { PresenceFeedbackSettingsStore } from './presence-feedback-settings-store.js';
import {
  Stl27lMqttPresenceAdapter,
  type Stl27lPresenceMqttSubscriber,
} from '../adapters/stl27l-mqtt-presence.js';
import { ComputerPlaybackController } from '../application/computer-playback-controller.js';
import {
  ComputerPlaybackMqttAdapter,
  type ComputerPlaybackMqttPort,
} from '../adapters/computer-playback-mqtt.js';
import { ComputerMqttAdapter } from '../adapters/computer-mqtt.js';
import { ComputerDisplayMqttAdapter } from '../adapters/computer-display-mqtt.js';
import { HomeAssistantPowerSensorAdapter } from '../adapters/home-assistant-power-sensor.js';
import {
  DisplayPowerController,
  type DisplayPowerPolicy,
} from '../application/display-power-controller.js';
import { DisplayPowerApi } from '../application/display-power-api.js';
import {
  DisplayPowerSettingsService,
  settingsFromConfig,
} from '../application/display-power-settings-service.js';
import { DisplayPowerSettingsStore } from './display-power-settings-store.js';
import {
  OpticalSwitchApi,
  type OpticalAgentSource,
} from '../application/optical-switch-api.js';
import { OpticalSwitchSettingsService } from '../application/optical-switch-settings-service.js';
import { ComputerOpticalMqttAdapter } from '../adapters/computer-optical-mqtt.js';
import { OpticalSwitchSettingsStore } from './optical-switch-settings-store.js';
import { CapabilityRegistry } from '../application/capabilities.js';
import { Stl27lPresenceControlAdapter } from '../adapters/stl27l-presence-control.js';
import {
  Stl27lSensorStream,
  type SensorSocketFactory,
} from '../adapters/stl27l-sensor-stream.js';
import { PresenceBlackbox } from './presence-blackbox.js';
import {
  resolveRoomDefaultSceneId,
  withRoomPresets,
} from '../application/dashboard-scenes.js';
import { defaultScenes, LugnEngine } from '../application/lugn-engine.js';
import { systemClock, type TimerHandle } from '../core/clock.js';
import { LugnDisplayServer } from './display-server.js';
import { DashCastManager } from './dashcast-manager.js';
import { LightingIntentStore } from './lighting-intent-store.js';
import { ScenePresetStore } from './scene-preset-store.js';
import { LugnHttpServer } from './http-server.js';
import {
  MqttJsSubscriber,
  type MqttSubscriberConfig,
  type MqttSubscriberStatus,
} from './mqttjs-subscriber.js';
import { loadRuntimeConfig, RuntimeConfigError } from './config.js';

export type LugnRuntime = {
  engine: LugnEngine;
  stop(): Promise<void>;
};

type RuntimeMqttSubscriber = Stl27lPresenceMqttSubscriber & {
  publish?: ComputerPlaybackMqttPort['publish'];
  readonly status: MqttSubscriberStatus;
  onStatus(listener: (status: MqttSubscriberStatus) => void): () => void;
  start(): void;
  stop(): Promise<void>;
};

/** Optional transport factories keep the composed runtime deterministic in tests. */
export type LugnRuntimeDependencies = {
  goveeControlClient?: GoveeControlClient;
  lightingIntentPath?: string;
  homeAssistantFetch?: typeof fetch;
  createMqttSubscriber?: (
    config: MqttSubscriberConfig,
    onError: () => void,
  ) => RuntimeMqttSubscriber;
  createHomeAssistantSocket?: HomeAssistantSocketFactory;
  createDashCastAdapter?: () => DashCastAdapter;
  createSensorSocket?: SensorSocketFactory;
  wiimTransport?: WiimTransport;
  wiimUpnpSubscriber?: WiimUpnpSubscriber;
};

/** Upper bound on the post-connect state query, beyond its own fetch timeout. */
const homeAssistantSyncDeadlineMs = 15_000;

/** Starts the local Lugn host and its configured Home Assistant/MQTT links. */
export async function startRuntime(
  configPath?: string,
  dependencies: LugnRuntimeDependencies = {},
): Promise<LugnRuntime> {
  const config = configPath
    ? loadRuntimeConfig(configPath)
    : loadRuntimeConfig();
  const fetchTransport = dependencies.homeAssistantFetch ?? fetch;
  const homeAssistantFetch: typeof fetch = (input, init) =>
    fetchTransport(input, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(10_000),
    });
  const homeAssistantLighting = new HomeAssistantLightingAdapter(
    {
      baseUrl: config.homeAssistant.baseUrl,
      token: config.homeAssistant.token,
      entities: config.homeAssistant.entities,
      ...(config.homeAssistant.wledCct === undefined
        ? {}
        : { wledCct: config.homeAssistant.wledCct }),
    },
    homeAssistantFetch,
    systemClock,
  );
  const goveeLighting = config.govee
    ? new GoveePresetLightingAdapter(
        homeAssistantLighting,
        dependencies.goveeControlClient ??
          new GoveeSocketClient(config.govee.socketPath),
        {},
      )
    : undefined;
  let goveeConnected = false;
  if (goveeLighting) {
    await goveeLighting
      .refreshCapabilities()
      .then(() => {
        goveeConnected = true;
      })
      .catch(() =>
        console.warn(
          '[lugn] Govee companion unavailable; effects will recover when it returns.',
        ),
      );
  }
  let goveeRefreshTimer: ReturnType<typeof setInterval> | undefined;
  const homeAssistantButton =
    Object.keys(config.homeAssistant.buttons).length > 0
      ? new HomeAssistantButtonAdapter(
          {
            baseUrl: config.homeAssistant.baseUrl,
            token: config.homeAssistant.token,
            entities: config.homeAssistant.buttons,
          },
          homeAssistantFetch,
        )
      : undefined;
  const homeAssistantSwitch =
    Object.keys(config.homeAssistant.switches).length > 0
      ? new HomeAssistantSwitchAdapter(
          {
            baseUrl: config.homeAssistant.baseUrl,
            token: config.homeAssistant.token,
            entities: config.homeAssistant.switches,
          },
          homeAssistantFetch,
          systemClock,
        )
      : undefined;
  const homeAssistantMusic =
    Object.keys(config.homeAssistant.music).length > 0
      ? new HomeAssistantMusicAdapter(
          {
            baseUrl: config.homeAssistant.baseUrl,
            token: config.homeAssistant.token,
            entities: config.homeAssistant.music,
          },
          homeAssistantFetch,
          systemClock,
        )
      : undefined;
  const wiimMusicMappings = config.wiim?.music ?? {};
  const wiimMusic =
    Object.keys(wiimMusicMappings).length > 0
      ? new WiimMusicAdapter(
          { targets: wiimMusicMappings },
          dependencies.wiimTransport ?? createWiimHttpsTransport(),
          systemClock,
          dependencies.wiimUpnpSubscriber
            ? { subscribeUpnp: dependencies.wiimUpnpSubscriber }
            : {},
        )
      : undefined;
  const allMusicMappings = {
    ...config.homeAssistant.music,
    ...wiimMusicMappings,
  };
  const allMusicTargetIds = Object.keys(allMusicMappings);
  const musicAdapter =
    homeAssistantMusic && wiimMusic
      ? new CompositeMusicAdapter([
          {
            targets: Object.keys(config.homeAssistant.music),
            adapter: homeAssistantMusic,
          },
          {
            targets: Object.keys(wiimMusicMappings),
            adapter: wiimMusic,
          },
        ])
      : (wiimMusic ?? homeAssistantMusic);
  const homeAssistantEnvironment = new HomeAssistantEnvironmentAdapter(
    config.homeAssistant.environment,
    systemClock,
  );
  const homeAssistantPrinter = config.homeAssistant.printer
    ? new HomeAssistantPrinterAdapter(config.homeAssistant.printer, systemClock)
    : undefined;
  const deviceIds = Object.keys(config.homeAssistant.entities);
  const baseScenes = withRoomPresets(config.scenes ?? defaultScenes, deviceIds);
  const defaultSceneId = resolveRoomDefaultSceneId(
    config.defaultSceneId,
    baseScenes,
  );
  const lightingIntentPath =
    dependencies.lightingIntentPath ?? config.statePath;
  const scenePresetStore = new ScenePresetStore({
    filePath: join(
      dirname(lightingIntentPath),
      `${basename(lightingIntentPath)}.scenes.json`,
    ),
    deviceIds,
    ...(defaultSceneId === undefined ? {} : { defaultSceneId }),
    onWarning: (message) => console.warn(`[lugn] ${message}`),
    onSaved: (ids) => lightingIntentStore.setKnownSceneIds(ids),
  });
  const scenes = await scenePresetStore.load(baseScenes);
  const lightingIntentStore = new LightingIntentStore({
    filePath: lightingIntentPath,
    expectedDeviceIds: deviceIds,
    // Tombstones let a crash between deleting a preset and saving intent retain
    // its lamp values; the obsolete scene label is detached immediately below.
    knownSceneIds: [
      ...scenes.map((scene) => scene.id),
      ...scenePresetStore.deletedSceneIds,
    ],
    ...(allMusicTargetIds.length === 0
      ? {}
      : {
          expectedMusicTargetIds: allMusicTargetIds,
        }),
    onWarning: (message) => console.warn(`[lugn] ${message}`),
  });
  const restoredLightingIntent = await lightingIntentStore.load();
  if (
    restoredLightingIntent?.currentScene &&
    !scenes.some((scene) => scene.id === restoredLightingIntent.currentScene)
  ) {
    restoredLightingIntent.currentScene = null;
    if (
      deviceIds.length > 0 &&
      Object.values(restoredLightingIntent.devices).every(
        (device) => device.effectiveDesired.power === false,
      )
    )
      restoredLightingIntent.detachedOffScene = true;
  }
  lightingIntentStore.setKnownSceneIds(scenes.map((scene) => scene.id));
  const volumeSettingsStore = new MusicVolumeSettingsStore(
    `${lightingIntentPath}.volume.json`,
    (message) => console.warn(`[lugn] ${message}`),
  );
  const savedVolumeSettings = await volumeSettingsStore.load();
  const restoredMusicIntent = lightingIntentStore.restoredMusicIntent;
  // The engine can request policy snapshots during construction, before the
  // subscription and reconciliation lifecycle below has been established.
  let isMusicObservationTrusted: (target: string) => boolean = () => false;
  const engineRef: { current?: LugnEngine } = {};
  const playbackAdapters = new Map<string, ComputerPlaybackMqttAdapter>();
  const displayAdapters = new Map<string, ComputerDisplayMqttAdapter>();
  const displayControllers = new Map<string, DisplayPowerController>();
  const opticalAdapters = new Map<string, ComputerOpticalMqttAdapter>();
  const powerSensors = new Map<string, HomeAssistantPowerSensorAdapter>();
  const controlRoutes = Object.fromEntries(
    Object.entries(allMusicMappings).flatMap(([target, mapping]) =>
      mapping.computerAudio?.playbackControl
        ? [[target, mapping.computerAudio]]
        : [],
    ),
  );
  const computerPlayback =
    Object.keys(controlRoutes).length > 0
      ? new ComputerPlaybackController({
          routes: controlRoutes,
          clock: systemClock,
          getState: () => engineRef.current?.state,
          observationTrusted: (target) => isMusicObservationTrusted(target),
          adapterForDevice: (deviceId) => playbackAdapters.get(deviceId),
          automaticPauseAllowed: () => {
            const state = engineRef.current?.state;
            return (
              !!state &&
              (state.presence.state === 'confirmed_empty' ||
                state.presence.home.state === 'away')
            );
          },
          automaticResumeAllowed: (target) => {
            const engine = engineRef.current;
            if (
              !engine ||
              engine.state.presence.state !== 'occupied' ||
              engine.state.presence.home.state === 'away'
            )
              return false;
            const policy = engine.getMusicPlaybackPolicySnapshots()[target];
            return !!policy && !policy.manualPause && !policy.quietHours;
          },
          onChange: () => engineRef.current?.notifyComputerPlaybackChanged(),
        })
      : undefined;
  const engine = new LugnEngine(systemClock, {
    ...(computerPlayback ? { computerPlayback } : {}),
    // Every computer-audio input, with or without playback control: the
    // same rule the Hub's Nästa låt follows (musicTrackControl).
    computerAudioInputs: Object.fromEntries(
      Object.entries(allMusicMappings).flatMap(([target, mapping]) =>
        mapping.computerAudio ? [[target, mapping.computerAudio]] : [],
      ),
    ),
    adapter: goveeLighting ?? homeAssistantLighting,
    deviceIds,
    scenes,
    preserveRestoredSceneIds: scenePresetStore.managedSceneIds,
    ...(defaultSceneId === undefined ? {} : { defaultSceneId }),
    ...(restoredLightingIntent === undefined ? {} : { restoredLightingIntent }),
    ...(restoredMusicIntent === undefined ? {} : { restoredMusicIntent }),
    ...(savedVolumeSettings === undefined
      ? {}
      : { musicVolumeSettings: savedVolumeSettings }),
    ...(volumeSettingsStore.generation === undefined
      ? {}
      : { musicVolumeSettingsGeneration: volumeSettingsStore.generation }),
    prelight: config.prelight,
    ...(config.windowLighting === undefined
      ? {}
      : { windowLighting: config.windowLighting }),
    ...(config.lightingControlModes === undefined
      ? {}
      : { lightingControlModes: config.lightingControlModes }),
    ...(musicAdapter === undefined
      ? {}
      : {
          music: {
            targets: Object.fromEntries(
              Object.entries(allMusicMappings).map(([target, mapping]) => [
                target,
                mapping.sources,
              ]),
            ),
            adapter: musicAdapter,
            observationTrusted: (target) => isMusicObservationTrusted(target),
          },
        }),
    ...(homeAssistantSwitch === undefined
      ? {}
      : {
          switchDeviceIds: Object.keys(config.homeAssistant.switches),
          switchAdapter: homeAssistantSwitch,
        }),
  });
  engineRef.current = engine;
  if (goveeLighting) {
    let refreshing = false;
    goveeRefreshTimer = setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void goveeLighting
        .refreshCapabilities()
        .then(() => {
          goveeConnected = true;
          engine.refreshGoveeCapabilities();
        })
        .catch(() => {
          goveeConnected = false;
          engine.refreshGoveeCapabilities();
        })
        .finally(() => {
          refreshing = false;
        });
    }, 30_000);
    goveeRefreshTimer.unref();
  }
  const homeAssistantSun = new HomeAssistantSunAdapter((elevation) => {
    void engine.handleSunElevation(elevation);
  });
  const homeAssistantHomePresence = new HomeAssistantHomePresenceAdapter(
    config.homeAssistant.homePresence ?? {
      entity: 'device_tracker.lustigkurre',
    },
    systemClock,
    (state, observedAt) => {
      void engine.handleHomePresence(state, observedAt);
    },
  );
  const homeAssistantBilresa = new HomeAssistantBilresaAdapter(
    config.homeAssistant.bilresa ?? {},
    systemClock,
    ({ button, gesture }) => {
      void engine.handleBilresaPress(button, gesture).catch(() => {
        console.warn('[lugn] BILRESA action could not be applied');
      });
    },
  );
  lightingIntentStore.start(engine);
  const presenceBlackbox = config.presenceControl
    ? new PresenceBlackbox(`${lightingIntentPath}.presence-captures`)
    : undefined;
  const presenceControl =
    config.presenceControl === undefined
      ? undefined
      : new Stl27lPresenceControlAdapter(
          config.presenceControl.baseUrl,
          fetch,
          () => presenceBlackbox!.beginCapture(),
        );
  const presenceSensorStream = presenceControl
    ? new Stl27lSensorStream(
        presenceControl.streamUrl,
        dependencies.createSensorSocket,
      )
    : undefined;
  const presenceIngress = new PresenceEventIngress((event) =>
    engine.handleEvent(event),
  );
  // Render the chimes now, so a sensor event never waits for one.
  warmChimes();
  const presenceFeedbackStore = new PresenceFeedbackSettingsStore(
    `${lightingIntentPath}.presence-feedback.json`,
    (message) => console.warn(`[lugn] ${message}`),
  );
  const savedPresenceFeedback = await presenceFeedbackStore.load();
  const presenceFeedback = new PresenceFeedback({
    clock: systemClock,
    forward: (event) => {
      const rejected = () =>
        console.warn('[lugn] rejected normalized sensor event');
      // A held exit is forwarded from a timer, where a throw would be uncaught.
      try {
        void presenceIngress.accept(event).catch(rejected);
      } catch {
        rejected();
      }
    },
    save: (settings) => presenceFeedbackStore.save(settings),
    onExitPending: (pending) => engine.setPresenceExitPending(pending),
    chime: new ChimePlayer({
      ...(config.presenceFeedback?.audioDevice === undefined
        ? {}
        : { audioDevice: config.presenceFeedback.audioDevice }),
      onWarning: (message) => console.warn(`[lugn] ${message}`),
    }),
    ...(savedPresenceFeedback === undefined
      ? {}
      : { initial: savedPresenceFeedback }),
  });
  const capabilities = new CapabilityRegistry(engine, {
    presenceFeedback,
    ...(presenceControl === undefined
      ? {}
      : { presenceCountAdapter: presenceControl }),
    ...(homeAssistantButton === undefined
      ? {}
      : { buttonAdapter: homeAssistantButton }),
  });
  const routineStore = new RoutineStore(
    `${lightingIntentPath}.routines.json`,
    createRoutineTemplates({
      lightTargets: deviceIds,
      ...(allMusicTargetIds[0] === undefined
        ? {}
        : { musicTarget: allMusicTargetIds[0] }),
    }),
    (message) => console.warn(`[lugn] ${message}`),
  );
  await routineStore.load();
  const routines = new RoutineService(systemClock, {
    engine,
    capabilities,
    store: routineStore,
    bedtime: {
      lightTargets: Object.entries(
        scenes.find((scene) => scene.id === 'scene.soft_light')?.lighting ??
          scenes.find((scene) => scene.id === 'scene.everyday_light')
            ?.lighting ??
          {},
      )
        .filter(([, values]) => values.power !== false)
        .map(([target]) => target),
      ...(allMusicTargetIds[0] === undefined
        ? {}
        : { musicTarget: allMusicTargetIds[0] }),
    },
  });
  const intelligenceStore = new IntelligenceSettingsStore(
    `${lightingIntentPath}.intelligence.json`,
    (message) => console.warn(`[lugn] ${message}`),
  );
  await intelligenceStore.load();
  const computerIntelligence = createComputerIntelligenceRuntime({
    clock: systemClock,
    engine,
    capabilities,
    settingsStore: intelligenceStore,
    computerDeviceIds: (config.mqtt?.computers ?? []).map(
      ({ deviceId }) => deviceId,
    ),
    computerAudio: Object.fromEntries(
      Object.entries(allMusicMappings).flatMap(([target, mapping]) =>
        mapping.computerAudio ? [[target, mapping.computerAudio]] : [],
      ),
    ),
    observationTrusted: (target) => isMusicObservationTrusted(target),
  });
  // Display power: the configured `display` entries say which computers have
  // the feature and give the defaults; the control panel's saved values win.
  const displayPowerStore = new DisplayPowerSettingsStore(
    `${lightingIntentPath}.display-power.json`,
    (message) => console.warn(`[lugn] ${message}`),
  );
  await displayPowerStore.load();
  const displayConfigs = Object.fromEntries(
    (config.mqtt?.computers ?? []).flatMap((computer) =>
      computer.display ? [[computer.deviceId, computer.display]] : [],
    ),
  );
  const displaySettings = new DisplayPowerSettingsService({
    repository: displayPowerStore,
    defaults: Object.fromEntries(
      Object.entries(displayConfigs).map(([deviceId, display]) => [
        deviceId,
        settingsFromConfig(display),
      ]),
    ),
  });
  // Fast WiiM Optical switching: every configured computer gets it, on by
  // default. Lugn only holds and publishes the settings; the agent switches.
  const opticalSwitchStore = new OpticalSwitchSettingsStore(
    `${lightingIntentPath}.optical-switch.json`,
    (message) => console.warn(`[lugn] ${message}`),
  );
  await opticalSwitchStore.load();
  const opticalSwitchSettings = new OpticalSwitchSettingsService({
    repository: opticalSwitchStore,
    defaults: Object.fromEntries(
      (config.mqtt?.computers ?? []).map((computer) => [
        computer.deviceId,
        computer.opticalSwitch,
      ]),
    ),
  });
  const opticalAgents = new Map<string, OpticalAgentSource>();
  const experience = new OpticalSwitchApi(
    new DisplayPowerApi(
      new IntelligenceApi(
        new RoutineApi(routines, routineStore),
        computerIntelligence.service,
      ),
      displaySettings,
    ),
    opticalSwitchSettings,
    opticalAgents,
  );
  let syncingHomeAssistantStates = false;
  let homeAssistantConnection: HomeAssistantConnection | undefined;
  const trustedMusicTargets = new Set<string>();
  const reconciledMusicTargets = new Set<string>();
  isMusicObservationTrusted = (target) =>
    wiimMusic?.hasTarget(target)
      ? wiimMusic.isTargetTrusted(target)
      : homeAssistantConnection?.isCurrent() === true &&
        trustedMusicTargets.has(target);
  // Only actual adapter emissions count; rejected old/invalid reports cannot
  // restore trust. Seeding emissions remain provisional until the query succeeds.
  homeAssistantMusic?.subscribe(({ target }) => {
    if (!homeAssistantConnection?.isCurrent()) return;
    (syncingHomeAssistantStates
      ? reconciledMusicTargets
      : trustedMusicTargets
    ).add(target);
    if (!syncingHomeAssistantStates) computerPlayback?.observe();
  });
  wiimMusic?.subscribe(() => {
    computerPlayback?.observe();
  });
  const musicObservationTrust = (): Record<string, boolean> =>
    Object.fromEntries(
      allMusicTargetIds.map((target) => [
        target,
        isMusicObservationTrusted(target),
      ]),
    );
  const computerAudioMappings = Object.fromEntries(
    Object.entries(allMusicMappings).flatMap(([target, mapping]) =>
      mapping.computerAudio ? [[target, mapping.computerAudio]] : [],
    ),
  );
  const computerNowPlaying = new ComputerNowPlayingSelector(
    computerAudioMappings,
  );
  computerNowPlaying.observe(engine.state.computer.devices);
  const unsubscribeComputerNowPlaying = engine.stream.subscribe((update) => {
    if (update.patch.computer)
      computerNowPlaying.observe(update.patch.computer.devices);
  });
  // Presence and computer changes re-evaluate display power; the controller's
  // own status updates re-enter harmlessly and publish only on change.
  const unsubscribeOpticalSettings = opticalSwitchSettings.subscribe(() => {
    // A saved change reaches the agent at once, retained for its next connection.
    for (const adapter of opticalAdapters.values())
      void adapter.publishSettings();
  });
  const unsubscribeDisplaySettings = displaySettings.subscribe(() => {
    for (const controller of displayControllers.values()) controller.observe();
  });
  const unsubscribeDisplayPower = engine.stream.subscribe((update) => {
    if (
      update.domains.some(
        (domain) =>
          domain === 'presence' ||
          domain === 'computer' ||
          domain === 'session',
      )
    )
      for (const controller of displayControllers.values())
        controller.observe();
  });
  const artwork =
    homeAssistantMusic || wiimMusic
      ? new HomeAssistantArtworkService(
          {
            baseUrl: config.homeAssistant.baseUrl,
            token: config.homeAssistant.token,
            entities: Object.fromEntries(
              Object.entries(config.homeAssistant.music).map(
                ([target, mapping]) => [target, mapping.entityId],
              ),
            ),
            metadataProvider: (target) =>
              homeAssistantMusic?.artworkMetadata(target) ?? null,
            observationTrusted: (target) => isMusicObservationTrusted(target),
            computer: {
              selector: computerNowPlaying,
              routes: Object.fromEntries(
                Object.entries(computerAudioMappings).filter(
                  ([, mapping]) => mapping.artwork === true,
                ),
              ),
            },
            excludedSources: Object.fromEntries(
              Object.entries(allMusicMappings).flatMap(([target, mapping]) =>
                mapping.computerAudio
                  ? [[target, [mapping.computerAudio.source]]]
                  : [],
              ),
            ),
          },
          homeAssistantFetch,
          systemClock,
        )
      : undefined;
  // Music and adaptive scenes follow the same artwork the dashboards show.
  const artworkPalette = config.dynamicLighting
    ? new ArtworkPaletteService({
        artwork,
        observationTrusted: (target) => isMusicObservationTrusted(target),
      })
    : undefined;
  // A game's cover colours the adaptive mode's accent lamps (public Steam CDN).
  const gameCoverPalette = config.dynamicLighting?.gameCovers
    ? new SteamCoverPaletteService()
    : undefined;
  const dynamicLighting =
    config.dynamicLighting && artworkPalette
      ? new DynamicLightingController({
          clock: systemClock,
          engine,
          config: config.dynamicLighting,
          palette: artworkPalette,
          ...(gameCoverPalette ? { gameCover: gameCoverPalette } : {}),
          idleBlockers: (id) => {
            const snapshot = displayAdapters.get(id)?.getSnapshot();
            if (!snapshot?.fresh) return null;
            return {
              blockers: snapshot.state.idle_blockers,
              ignored:
                displaySettings.effective(id)?.ignoreIdleBlockers ??
                displayConfigs[id]?.ignoreIdleBlockers ??
                [],
            };
          },
          onDecision: (message) => console.info(`[lugn] ${message}`),
        })
      : undefined;
  const cameraStore = config.cameraDashboard
    ? new CameraSettingsStore(
        `${lightingIntentPath}.cameras.json`,
        createCameraSettings(config.cameraDashboard),
        (message) => console.warn(`[lugn] ${message}`),
      )
    : undefined;
  await cameraStore?.load();
  const cameraService =
    config.cameraDashboard && cameraStore
      ? new CameraDashboardService(
          config.cameraDashboard,
          cameraStore,
          systemClock,
        )
      : undefined;
  const cameraMedia =
    config.cameraDashboard && cameraService
      ? new CameraMediaProvider(
          cameraService,
          config.cameraDashboard,
          config.homeAssistant.baseUrl,
          config.homeAssistant.token,
          homeAssistantFetch,
          systemClock,
        )
      : undefined;
  // Loaded only when configured: it needs the native image library, and a
  // machine where that is missing must still run Lugn.
  let photoLibrary: PhotoLibrary | undefined;
  if (config.photoFrame) {
    try {
      const { createPhotoFrame } = await import('./photo-frame.js');
      photoLibrary = createPhotoFrame(
        {
          albumUrl: config.photoFrame.albumUrl,
          refreshMinutes: config.photoFrame.refreshMinutes,
          maxPhotos: config.photoFrame.maxPhotos,
          cacheDir:
            config.photoFrame.cacheDir ??
            join(dirname(lightingIntentPath), 'photo-frame'),
          ...(config.photoFrame.intelligence
            ? {
                intelligence: {
                  enabled: config.photoFrame.intelligence.enabled,
                  ...(config.photoFrame.intelligence.home
                    ? {
                        home: {
                          lat: config.photoFrame.intelligence.home.latitude,
                          lon: config.photoFrame.intelligence.home.longitude,
                        },
                      }
                    : {}),
                },
              }
            : {}),
        },
        {
          warn: (message) => console.warn(`[lugn] ${message}`),
          log: (message) => console.info(`[lugn] ${message}`),
        },
      );
    } catch (error) {
      console.warn(
        `[lugn] photo frame disabled: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const bufferedHomeAssistantEvents: unknown[] = [];
  const forwardHomeAssistantEvent = (
    event: unknown,
    allowCamera = true,
  ): void => {
    if (
      allowCamera &&
      typeof event === 'object' &&
      event !== null &&
      'event' in event
    )
      cameraService?.acceptEvent(event.event);
    homeAssistantLighting.acceptStateChangedEvent(event);
    homeAssistantSwitch?.acceptStateChangedEvent(event);
    homeAssistantMusic?.acceptStateChangedEvent(event);
    homeAssistantEnvironment.acceptStateChangedEvent(event);
    homeAssistantPrinter?.acceptStateChangedEvent(event);
    for (const sensor of powerSensors.values())
      sensor.acceptStateChangedEvent(event);
    homeAssistantHomePresence.acceptStateChangedEvent(event);
    homeAssistantSun.acceptEvent(event);
    homeAssistantBilresa.acceptStateChangedFrame(event);
  };
  const refreshHomeAssistantStates = async (
    connection: HomeAssistantConnection,
  ): Promise<void> => {
    computerPlayback?.invalidate();
    cameraService?.setConnected(false);
    homeAssistantConnection = connection;
    trustedMusicTargets.clear();
    reconciledMusicTargets.clear();
    syncingHomeAssistantStates = true;
    bufferedHomeAssistantEvents.length = 0;
    let cameraSeed: unknown[] | undefined;
    // A stalled query must not leave live events buffered forever: after the
    // deadline the connection continues on WebSocket observations, exactly as
    // after a failed query, and a late response can no longer be applied.
    let queryExpired = false;
    let deadline: TimerHandle | undefined;
    const reconciled = await Promise.race([
      seedHomeAssistantObservations(
        config.homeAssistant.baseUrl,
        config.homeAssistant.token,
        homeAssistantLighting,
        homeAssistantSwitch,
        homeAssistantMusic,
        homeAssistantEnvironment,
        homeAssistantHomePresence,
        homeAssistantFetch,
        () => !queryExpired && connection.isCurrent(),
        (states) => {
          cameraSeed = states;
          for (const state of states) {
            homeAssistantSun.acceptState(state);
            homeAssistantPrinter?.acceptState(state);
            for (const sensor of powerSensors.values())
              if (
                typeof state === 'object' &&
                state !== null &&
                (state as { entity_id?: unknown }).entity_id === sensor.entityId
              )
                sensor.acceptState(state);
          }
        },
      ),
      new Promise<boolean>((resolve) => {
        deadline = systemClock.setTimeout(() => {
          queryExpired = true;
          console.warn(
            '[lugn] initial Home Assistant state query did not finish in time; waiting for WebSocket observations',
          );
          resolve(false);
        }, homeAssistantSyncDeadlineMs);
      }),
    ]);
    if (deadline !== undefined) systemClock.clearTimeout(deadline);
    if (homeAssistantConnection !== connection || !connection.isCurrent())
      return;
    try {
      if (reconciled && cameraSeed) {
        cameraService?.setConnected(true);
        cameraService?.seedStates(cameraSeed);
      }
      if (reconciled)
        for (const target of reconciledMusicTargets)
          trustedMusicTargets.add(target);
    } catch {
      console.warn(
        '[lugn] applying the Home Assistant state query failed; waiting for WebSocket observations',
      );
    } finally {
      // Whatever happened above, live events must flow again.
      reconciledMusicTargets.clear();
      syncingHomeAssistantStates = false;
    }
    for (const event of bufferedHomeAssistantEvents.splice(0))
      forwardHomeAssistantEvent(event, false);
    computerPlayback?.observe();
  };
  const homeAssistantSocket = new HomeAssistantWebSocketTransport(
    {
      baseUrl: config.homeAssistant.baseUrl,
      token: config.homeAssistant.token,
    },
    (event) => {
      if (syncingHomeAssistantStates) {
        bufferedHomeAssistantEvents.push(event);
        return;
      }
      forwardHomeAssistantEvent(event);
    },
    {
      ...(dependencies.createHomeAssistantSocket === undefined
        ? {}
        : { createSocket: dependencies.createHomeAssistantSocket }),
      additionalEventTypes: [
        ...new Set(
          (config.cameraDashboard?.triggers ?? []).flatMap((trigger) =>
            trigger.kind === 'automation'
              ? ['automation_triggered' as const]
              : trigger.kind === 'service'
                ? ['call_service' as const]
                : [],
          ),
        ),
      ],
      onConnected: refreshHomeAssistantStates,
      onDisconnected: () => {
        cameraService?.setConnected(false);
        // A stale wattage must not keep steering display policy.
        for (const sensor of powerSensors.values()) sensor.invalidate();
      },
      onError: (kind) => {
        if (kind !== 'socket') return;
        trustedMusicTargets.clear();
        computerPlayback?.invalidate();
        computerPlayback?.observe();
      },
    },
  );
  // Light services reuse the authenticated socket; REST covers reconnects.
  homeAssistantLighting.attachWebSocket(homeAssistantSocket);
  let mqttSubscriber: RuntimeMqttSubscriber | undefined;
  let sensorAdapter: Stl27lMqttPresenceAdapter | undefined;
  const computerAdapters: ComputerMqttAdapter[] = [];
  let unsubscribeMqttStatus: (() => void) | undefined;
  let assistantEntities: AssistantEntitiesMqttAdapter | undefined;
  let unsubscribeAssistantEntities: (() => void) | undefined;

  if (config.mqtt) {
    const assistantConfig = config.mqtt.assistantEntities;
    const mqttConfig: MqttSubscriberConfig = {
      url: config.mqtt.url,
      ...(config.mqtt.username === undefined
        ? {}
        : { username: config.mqtt.username }),
      ...(config.mqtt.password === undefined
        ? {}
        : { password: config.mqtt.password }),
      ...(config.mqtt.clientId === undefined
        ? {}
        : { clientId: config.mqtt.clientId }),
      ...(assistantConfig === undefined
        ? {}
        : {
            // Assistant entities read unavailable when Lugn is gone.
            will: {
              topic: `${assistantConfig.baseTopic}/availability`,
              payload: AssistantEntitiesMqttAdapter.offlinePayload,
              qos: 1 as const,
              retain: true,
            },
          }),
    };
    mqttSubscriber = (
      dependencies.createMqttSubscriber ??
      ((subscriberConfig, onError) =>
        new MqttJsSubscriber(subscriberConfig, onError))
    )(mqttConfig, () => console.warn('[lugn] MQTT operation failed'));
    sensorAdapter = new Stl27lMqttPresenceAdapter(
      mqttSubscriber satisfies Stl27lPresenceMqttSubscriber,
      (event) => presenceFeedback.accept(event),
      {
        baseTopic: config.mqtt.baseTopic,
        maxAgeMs: config.mqtt.maxAgeMs,
        clock: systemClock,
      },
    );
    for (const computer of config.mqtt.computers ?? []) {
      computerAdapters.push(
        new ComputerMqttAdapter(
          mqttSubscriber,
          (observation) => engine.acceptComputerObservation(observation),
          {
            deviceId: computer.deviceId,
            baseTopic: computer.baseTopic,
            maxAgeMs: computer.maxAgeMs,
            clock: systemClock,
          },
        ),
      );
    }
    if (computerPlayback) {
      const publish = mqttSubscriber.publish;
      if (!publish)
        throw new Error('Computer playback requires MQTT publication support');
      for (const computer of config.mqtt.computers ?? []) {
        if (
          !Object.values(controlRoutes).some(
            (route) => route.deviceId === computer.deviceId,
          )
        )
          continue;
        const adapter = new ComputerPlaybackMqttAdapter({
          deviceId: computer.deviceId,
          baseTopic: computer.baseTopic,
          maxAgeMs: Math.min(90_000, computer.maxAgeMs),
          clock: systemClock,
          mqtt: {
            subscribe: mqttSubscriber.subscribe.bind(mqttSubscriber),
            publish: publish.bind(mqttSubscriber),
          },
          onChange: () => computerPlayback.observe(),
        });
        playbackAdapters.set(computer.deviceId, adapter);
      }
      computerPlayback.observe();
    }
    for (const computer of config.mqtt.computers ?? []) {
      const displayConfig = computer.display;
      if (!displayConfig) continue;
      const publish = mqttSubscriber.publish;
      if (!publish)
        throw new Error(
          'Computer display control requires MQTT publication support',
        );
      const deviceId = computer.deviceId;
      const sensor = displayConfig.powerSensor
        ? new HomeAssistantPowerSensorAdapter({
            entityId: displayConfig.powerSensor.entityId,
            thresholds: displayConfig.powerSensor,
            clock: systemClock,
            onChange: () => displayControllers.get(deviceId)?.observe(),
          })
        : undefined;
      if (sensor) powerSensors.set(deviceId, sensor);
      const adapter = new ComputerDisplayMqttAdapter({
        deviceId,
        baseTopic: computer.baseTopic,
        maxAgeMs: Math.min(90_000, computer.maxAgeMs),
        clock: systemClock,
        mqtt: {
          subscribe: mqttSubscriber.subscribe.bind(mqttSubscriber),
          publish: publish.bind(mqttSubscriber),
        },
        onChange: () => {
          displayControllers.get(deviceId)?.observe();
          dynamicLighting?.observe();
        },
      });
      displayAdapters.set(deviceId, adapter);
      displayControllers.set(
        deviceId,
        new DisplayPowerController({
          deviceId,
          clock: systemClock,
          policy: (): DisplayPowerPolicy => {
            const saved = displaySettings.effective(deviceId);
            return {
              // Only the open-loop fallback uses this; not editable in the panel.
              reassertOffMs: displayConfig.reassertOffMs,
              offAfterEmptyMs:
                saved?.offAfterEmptyMs ?? displayConfig.offAfterEmptyMs,
              ensureOffWhenAway:
                saved?.ensureOffWhenAway ?? displayConfig.ensureOffWhenAway,
              wakeOnEntry: saved?.wakeOnEntry ?? displayConfig.wakeOnEntry,
              wakeInQuietHours:
                saved?.wakeInQuietHours ?? displayConfig.wakeInQuietHours,
              quietWakeMaxAbsenceMs:
                saved?.quietWakeMaxAbsenceMs ??
                displayConfig.quietWakeMaxAbsenceMs,
              inhibitOnActivity:
                saved?.inhibitOnActivity ?? displayConfig.inhibitOnActivity,
              activeInhibitMaxMs:
                saved?.activeInhibitMaxMs ?? displayConfig.activeInhibitMaxMs,
              idleSleepAfterMs: saved
                ? saved.idleSleepAfterMs
                : displayConfig.idleSleepAfterMs,
              ignoreIdleBlockers:
                saved?.ignoreIdleBlockers ?? displayConfig.ignoreIdleBlockers,
            };
          },
          enabled: () => displaySettings.effective(deviceId)?.enabled ?? true,
          getState: () => engineRef.current?.state,
          transport: adapter,
          ...(sensor ? { evidence: () => sensor.getEvidence() } : {}),
          isQuietHours: () => isStockholmQuietHour(systemClock.now()),
          ...(displayConfig.powerSensor
            ? { evidenceSettleMs: displayConfig.powerSensor.settleMs }
            : {}),
          publish: (snapshot) => engine.acceptComputerDisplay(snapshot),
        }),
      );
    }
    const opticalPublish = mqttSubscriber.publish;
    if (opticalPublish)
      for (const computer of config.mqtt.computers ?? []) {
        const deviceId = computer.deviceId;
        const adapter = new ComputerOpticalMqttAdapter({
          deviceId,
          baseTopic: computer.baseTopic,
          maxAgeMs: Math.min(300_000, computer.maxAgeMs),
          clock: systemClock,
          mqtt: {
            subscribe: mqttSubscriber.subscribe.bind(mqttSubscriber),
            publish: opticalPublish.bind(mqttSubscriber),
          },
          settings: () => {
            const settings = opticalSwitchSettings.effective(deviceId);
            return settings
              ? { settings, generation: opticalSwitchSettings.generation() }
              : undefined;
          },
          onWarning: (message) => console.warn(`[lugn] ${message}`),
        });
        opticalAdapters.set(deviceId, adapter);
        opticalAgents.set(deviceId, {
          status: () => adapter.status(),
          subscribe: (listener) => adapter.subscribe(listener),
        });
      }
    const assistantPublish = mqttSubscriber.publish;
    if (assistantConfig) {
      if (!assistantPublish)
        throw new Error('Assistant entities require MQTT publication support');
      const adapter = new AssistantEntitiesMqttAdapter({
        config: assistantConfig,
        mqtt: {
          subscribe: mqttSubscriber.subscribe.bind(mqttSubscriber),
          publish: (topic, payload, options) =>
            assistantPublish.call(mqttSubscriber, topic, payload, options),
        },
        getState: () => engine.state,
        invoke: ({ capability, input }) =>
          capabilities.invoke(capability, input, {
            actor: { type: 'home_assistant', id: 'assistant_entities' },
            source: 'assistant_entities',
            reason: 'Voice assistant command through Home Assistant',
          }),
        onWarning: (message) => console.warn(`[lugn] ${message}`),
      });
      assistantEntities = adapter;
      unsubscribeAssistantEntities = engine.stream.subscribe((update) => {
        if (update.domains.includes('lighting')) adapter.observe();
      });
    }
    unsubscribeMqttStatus = mqttSubscriber.onStatus((status) => {
      assistantEntities?.setBrokerConnected(status === 'connected');
      for (const adapter of opticalAdapters.values())
        adapter.setBrokerConnected(status === 'connected');
      for (const adapter of displayAdapters.values())
        adapter.setBrokerConnected(status === 'connected');
      for (const adapter of playbackAdapters.values())
        adapter.setBrokerConnected(status === 'connected');
      sensorAdapter?.setBrokerConnected(status === 'connected');
      for (const adapter of computerAdapters)
        adapter.setBrokerConnected(status === 'connected');
    });
  }

  const http = new LugnHttpServer({
    ...config.http,
    engine,
    scenePresetStore,
    volumeSettingsStore,
    capabilities,
    ...(artwork ? { artworkProvider: artwork } : {}),
    ...(cameraService && cameraMedia ? { cameraService, cameraMedia } : {}),
    ...(presenceSensorStream ? { presenceSensorStream } : {}),
    ...(photoLibrary ? { photoLibrary } : {}),
    experience,
    musicObservationTrustProvider: musicObservationTrust,
    webAssetsDirectory: join(dirname(fileURLToPath(import.meta.url)), '../web'),
    integrations: () => ({
      home_assistant: homeAssistantSocket.status,
      ...(goveeLighting
        ? { govee: goveeConnected ? 'connected' : 'disconnected' }
        : {}),
      ...(wiimMusic
        ? { wiim: wiimMusic.isConnected() ? 'connected' : 'disconnected' }
        : {}),
      mqtt: mqttSubscriber?.status ?? 'not_configured',
    }),
  });
  const displayRefs: {
    castManager: DashCastManager | undefined;
    displayServer: LugnDisplayServer | undefined;
  } = { castManager: undefined, displayServer: undefined };
  const displayServer = config.display
    ? new LugnDisplayServer({
        host: config.display.host,
        port: config.display.port,
        allowedHosts: [new URL(config.display.publicUrl).host],
        hubs: config.display.hubs.map(
          ({ id, role, castHost, token, pointerBridge }) => ({
            id,
            role,
            castHost,
            token,
            ...(pointerBridge ? { pointerBridge } : {}),
          }),
        ),
        capabilities,
        ...(artwork ? { artworkProvider: artwork } : {}),
        ...(cameraService && cameraMedia ? { cameraService, cameraMedia } : {}),
        ...(photoLibrary ? { photoLibrary } : {}),
        experience,
        presenceCountCorrectionAvailable: config.presenceControl !== undefined,
        scenes: Array.from(engine.scenes.values()),
        scenesProvider: () => Array.from(engine.scenes.values()),
        stateProvider: () => engine.state,
        musicObservationConnectedProvider: () =>
          homeAssistantSocket.status === 'connected' ||
          (wiimMusic?.isConnected() ?? false),
        musicObservationTrustProvider: musicObservationTrust,
        stateStream: engine.stream,
        computerAudioMappings,
        computerNowPlayingSelector: computerNowPlaying,
        musicVolumePoliciesProvider: () =>
          engine.getMusicVolumePolicySnapshots(),
        musicPlaybackPoliciesProvider: () =>
          engine.getMusicPlaybackPolicySnapshots(),
        environmentProvider: () => homeAssistantEnvironment.snapshot(),
        ...(homeAssistantPrinter
          ? {
              printer: new PrinterActivityService(
                homeAssistantPrinter,
                {
                  baseUrl: config.homeAssistant.baseUrl,
                  token: config.homeAssistant.token,
                },
                homeAssistantFetch,
              ),
            }
          : {}),
        castStatus: (hubId) => {
          const lastHubPollAt =
            displayRefs.displayServer?.lastHubHeartbeatAt(hubId);
          if (
            lastHubPollAt !== undefined &&
            Date.now() - lastHubPollAt < 12_000
          ) {
            return {
              state: 'live',
              message: 'Den här Hubben hämtar rumsstatus från Lugn.',
            };
          }
          return (
            displayRefs.castManager?.statusForHub(hubId) ?? {
              state: 'starting',
              message: 'Lugn ansluter till DashCast.',
            }
          );
        },
      })
    : undefined;
  displayRefs.displayServer = displayServer;
  const castManager = config.display
    ? new DashCastManager({
        publicUrl: config.display.publicUrl,
        hubs: config.display.hubs.map(({ id, castHost }) => ({
          id,
          castHost,
        })),
        dashboardPath: (hubId) => displayRefs.displayServer!.pathForHub(hubId),
        dashboardActive: (hubId) => {
          const lastHubPollAt =
            displayRefs.displayServer?.lastHubHeartbeatAt(hubId);
          return (
            lastHubPollAt !== undefined && Date.now() - lastHubPollAt < 12_000
          );
        },
        ...(dependencies.createDashCastAdapter === undefined
          ? {}
          : { createAdapter: dependencies.createDashCastAdapter }),
      })
    : undefined;
  displayRefs.castManager = castManager;

  try {
    sensorAdapter?.start();
    for (const adapter of computerAdapters) adapter.start();
    for (const adapter of playbackAdapters.values()) adapter.start();
    for (const adapter of displayAdapters.values()) adapter.start();
    for (const adapter of opticalAdapters.values()) adapter.start();
    await seedHomeAssistantObservations(
      config.homeAssistant.baseUrl,
      config.homeAssistant.token,
      homeAssistantLighting,
      homeAssistantSwitch,
      homeAssistantMusic,
      homeAssistantEnvironment,
      homeAssistantHomePresence,
      homeAssistantFetch,
      undefined,
      (states) => {
        for (const state of states) homeAssistantSun.acceptState(state);
      },
    );
    if (mqttSubscriber) mqttSubscriber.start();
    wiimMusic?.start();
    homeAssistantSocket.start();
    await http.start();
    await displayServer?.start();
    await photoLibrary?.start();
    castManager?.start();
    // One shared upstream connection keeps the retrospective window warm even
    // when no browser is open; viewers reuse this same validated frame stream.
    presenceSensorStream?.subscribe((message) =>
      presenceBlackbox!.accept(message),
    );
  } catch (error) {
    unsubscribeComputerNowPlaying();
    unsubscribeDisplayPower();
    unsubscribeDisplaySettings();
    unsubscribeOpticalSettings();
    routines.dispose();
    computerIntelligence.dispose();
    photoLibrary?.dispose();
    dynamicLighting?.dispose();
    artworkPalette?.dispose();
    gameCoverPalette?.dispose();
    cameraMedia?.dispose();
    cameraService?.dispose();
    artwork?.dispose();
    await castManager?.stop();
    await displayServer?.stop();
    await http.stop();
    presenceSensorStream?.close();
    await presenceBlackbox?.flush();
    sensorAdapter?.stop();
    presenceFeedback.dispose();
    for (const adapter of playbackAdapters.values()) adapter.stop();
    for (const adapter of displayAdapters.values()) adapter.stop();
    for (const adapter of opticalAdapters.values()) adapter.stop();
    for (const controller of displayControllers.values()) controller.dispose();
    for (const sensor of powerSensors.values()) sensor.dispose();
    for (const adapter of computerAdapters) adapter.stop();
    unsubscribeAssistantEntities?.();
    await assistantEntities?.stop();
    unsubscribeMqttStatus?.();
    if (goveeRefreshTimer) clearInterval(goveeRefreshTimer);
    await wiimMusic?.stop();
    homeAssistantSocket.stop();
    await lightingIntentStore.stop().catch(() => undefined);
    engine.dispose();
    await mqttSubscriber?.stop();
    throw error;
  }

  console.info(
    `[lugn] listening at http://${config.http.host}:${config.http.port}`,
  );
  if (config.display) {
    console.info(
      `[lugn] custom Nest display surface listening at http://${config.display.host}:${config.display.port} (${config.display.hubs.length} Hub${config.display.hubs.length === 1 ? '' : 's'} monitored via DashCast)`,
    );
  }
  return {
    engine,
    async stop() {
      unsubscribeComputerNowPlaying();
      unsubscribeDisplayPower();
      unsubscribeDisplaySettings();
      unsubscribeOpticalSettings();
      routines.dispose();
      computerIntelligence.dispose();
      photoLibrary?.dispose();
      dynamicLighting?.dispose();
      artworkPalette?.dispose();
      gameCoverPalette?.dispose();
      cameraMedia?.dispose();
      cameraService?.dispose();
      artwork?.dispose();
      await castManager?.stop();
      await displayServer?.stop();
      await http.stop();
      presenceSensorStream?.close();
      await presenceBlackbox?.flush();
      sensorAdapter?.stop();
      presenceFeedback.dispose();
      for (const adapter of playbackAdapters.values()) adapter.stop();
      for (const adapter of displayAdapters.values()) adapter.stop();
      for (const adapter of opticalAdapters.values()) adapter.stop();
      for (const controller of displayControllers.values())
        controller.dispose();
      for (const sensor of powerSensors.values()) sensor.dispose();
      for (const adapter of computerAdapters) adapter.stop();
      unsubscribeAssistantEntities?.();
      await assistantEntities?.stop();
      unsubscribeMqttStatus?.();
      if (goveeRefreshTimer) clearInterval(goveeRefreshTimer);
      await wiimMusic?.stop();
      homeAssistantSocket.stop();
      try {
        await mqttSubscriber?.stop();
      } finally {
        try {
          await lightingIntentStore.stop();
        } finally {
          engine.dispose();
        }
      }
    },
  };
}

const stockholmHour = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Stockholm',
  hour: '2-digit',
  hourCycle: 'h23',
});
/** Same 23:00-06:00 night as music automation. */
function isStockholmQuietHour(now: number): boolean {
  const hour = Number(stockholmHour.format(now));
  return hour < 6 || hour >= 23;
}

async function seedHomeAssistantObservations(
  baseUrl: string,
  token: string,
  lightingAdapter: HomeAssistantLightingAdapter,
  switchAdapter?: HomeAssistantSwitchAdapter,
  musicAdapter?: HomeAssistantMusicAdapter,
  environmentAdapter?: HomeAssistantEnvironmentAdapter,
  homePresenceAdapter?: HomeAssistantHomePresenceAdapter,
  fetcher: typeof fetch = fetch,
  shouldApply: () => boolean = () => true,
  onStates?: (states: unknown[]) => void,
): Promise<boolean> {
  try {
    const response = await fetcher(`${baseUrl}/api/states`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      console.warn(
        `[lugn] initial Home Assistant state query failed (HTTP ${response.status}); waiting for WebSocket observations`,
      );
      return false;
    }
    const states: unknown = await response.json();
    if (!shouldApply()) return false;
    if (!Array.isArray(states)) {
      console.warn(
        '[lugn] initial Home Assistant state query returned an unexpected response',
      );
      return false;
    }
    for (const state of states) {
      if (typeof state !== 'object' || state === null) continue;
      const candidate = state as Record<string, unknown>;
      if (typeof candidate['entity_id'] !== 'string') continue;
      lightingAdapter.acceptStateChangedEvent({
        entity_id: candidate['entity_id'],
        new_state: candidate,
      });
      switchAdapter?.acceptState(candidate);
      musicAdapter?.acceptState(candidate);
      environmentAdapter?.acceptState(candidate);
      homePresenceAdapter?.acceptState(candidate);
    }
    onStates?.(states);
    return true;
  } catch {
    console.warn(
      '[lugn] initial Home Assistant state query failed; waiting for WebSocket observations',
    );
    return false;
  }
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  let runtime: LugnRuntime;
  try {
    runtime = await startRuntime(configPath);
  } catch (error) {
    if (error instanceof RuntimeConfigError) {
      console.error(`[lugn] ${error.message}`);
    } else {
      console.error('[lugn] runtime startup failed');
    }
    process.exitCode = 1;
    return;
  }

  let shutdownStarted = false;
  const shutdown = (): void => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    void runtime
      .stop()
      .then(() => console.info('[lugn] stopped'))
      .catch(() => {
        console.error('[lugn] shutdown encountered an error');
        process.exitCode = 1;
      });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href)
  void main();
