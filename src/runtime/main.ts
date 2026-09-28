import { HomeAssistantMusicAdapter } from '../adapters/home-assistant-music.js';
import { HomeAssistantBilresaAdapter } from '../adapters/home-assistant-bilresa.js';
import { HomeAssistantEnvironmentAdapter } from '../adapters/home-assistant-environment.js';
import { HomeAssistantHomePresenceAdapter } from '../adapters/home-assistant-home-presence.js';
import { HomeAssistantButtonAdapter } from '../adapters/home-assistant-button.js';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DashCastAdapter } from '../adapters/dashcast.js';
import { HomeAssistantLightingAdapter } from '../adapters/home-assistant-lighting.js';
import { HomeAssistantSwitchAdapter } from '../adapters/home-assistant-switch.js';
import {
  HomeAssistantWebSocketTransport,
  type HomeAssistantSocketFactory,
} from '../adapters/home-assistant-websocket.js';
import { PresenceEventIngress } from '../adapters/presence-event-ingress.js';
import {
  Stl27lMqttPresenceAdapter,
  type Stl27lPresenceMqttSubscriber,
} from '../adapters/stl27l-mqtt-presence.js';
import { CapabilityRegistry } from '../application/capabilities.js';
import { withRoomPresets } from '../application/dashboard-scenes.js';
import { defaultScenes, LugnEngine } from '../application/lugn-engine.js';
import { systemClock } from '../core/clock.js';
import { LugnDisplayServer } from './display-server.js';
import { DashCastManager } from './dashcast-manager.js';
import { LightingIntentStore } from './lighting-intent-store.js';
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
  readonly status: MqttSubscriberStatus;
  onStatus(listener: (status: MqttSubscriberStatus) => void): () => void;
  start(): void;
  stop(): Promise<void>;
};

/** Optional transport factories keep the composed runtime deterministic in tests. */
export type LugnRuntimeDependencies = {
  lightingIntentPath?: string;
  homeAssistantFetch?: typeof fetch;
  createMqttSubscriber?: (
    config: MqttSubscriberConfig,
    onError: () => void,
  ) => RuntimeMqttSubscriber;
  createHomeAssistantSocket?: HomeAssistantSocketFactory;
  createDashCastAdapter?: () => DashCastAdapter;
};

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
    },
    homeAssistantFetch,
    systemClock,
  );
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
  const homeAssistantEnvironment = new HomeAssistantEnvironmentAdapter(
    config.homeAssistant.environment,
    systemClock,
  );
  const deviceIds = Object.keys(config.homeAssistant.entities);
  const scenes = withRoomPresets(config.scenes ?? defaultScenes, deviceIds);
  const stateDirectory =
    process.env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state');
  const lightingIntentPath =
    dependencies.lightingIntentPath ??
    process.env['LUGN_LIGHTING_INTENT_PATH'] ??
    join(stateDirectory, 'lugn', 'lighting-intent.json');
  const lightingIntentStore = new LightingIntentStore({
    filePath: lightingIntentPath,
    expectedDeviceIds: deviceIds,
    knownSceneIds: scenes.map((scene) => scene.id),
    onWarning: (message) => console.warn(`[lugn] ${message}`),
  });
  const restoredLightingIntent = await lightingIntentStore.load();
  const engine = new LugnEngine(systemClock, {
    adapter: homeAssistantLighting,
    deviceIds,
    scenes,
    ...(config.defaultSceneId === undefined
      ? {}
      : { defaultSceneId: config.defaultSceneId }),
    ...(restoredLightingIntent === undefined ? {} : { restoredLightingIntent }),
    prelight: config.prelight,
    ...(homeAssistantMusic === undefined
      ? {}
      : {
          music: {
            targets: Object.fromEntries(
              Object.entries(config.homeAssistant.music).map(
                ([target, mapping]) => [target, mapping.sources],
              ),
            ),
            adapter: homeAssistantMusic,
          },
        }),
    ...(homeAssistantSwitch === undefined
      ? {}
      : {
          switchDeviceIds: Object.keys(config.homeAssistant.switches),
          switchAdapter: homeAssistantSwitch,
        }),
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
  const capabilities = new CapabilityRegistry(engine, {
    ...(homeAssistantButton === undefined
      ? {}
      : { buttonAdapter: homeAssistantButton }),
  });
  const homeAssistantSocket = new HomeAssistantWebSocketTransport(
    {
      baseUrl: config.homeAssistant.baseUrl,
      token: config.homeAssistant.token,
    },
    (event) => {
      homeAssistantLighting.acceptStateChangedEvent(event);
      homeAssistantSwitch?.acceptStateChangedEvent(event);
      homeAssistantMusic?.acceptStateChangedEvent(event);
      homeAssistantEnvironment.acceptStateChangedEvent(event);
      homeAssistantHomePresence.acceptStateChangedEvent(event);
      homeAssistantBilresa.acceptStateChangedFrame(event);
    },
    dependencies.createHomeAssistantSocket === undefined
      ? {}
      : { createSocket: dependencies.createHomeAssistantSocket },
  );
  let mqttSubscriber: RuntimeMqttSubscriber | undefined;
  let sensorAdapter: Stl27lMqttPresenceAdapter | undefined;
  let unsubscribeMqttStatus: (() => void) | undefined;

  if (config.mqtt) {
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
    };
    mqttSubscriber = (
      dependencies.createMqttSubscriber ??
      ((subscriberConfig, onError) =>
        new MqttJsSubscriber(subscriberConfig, onError))
    )(mqttConfig, () => console.warn('[lugn] MQTT operation failed'));
    const ingress = new PresenceEventIngress((event) =>
      engine.handleEvent(event),
    );
    sensorAdapter = new Stl27lMqttPresenceAdapter(
      mqttSubscriber satisfies Stl27lPresenceMqttSubscriber,
      (event) => {
        void ingress.accept(event).catch(() => {
          console.warn('[lugn] rejected normalized sensor event');
        });
      },
      {
        baseTopic: config.mqtt.baseTopic,
        maxAgeMs: config.mqtt.maxAgeMs,
        clock: systemClock,
      },
    );
    unsubscribeMqttStatus = mqttSubscriber.onStatus((status) => {
      sensorAdapter?.setBrokerConnected(status === 'connected');
    });
    sensorAdapter.start();
  }

  const http = new LugnHttpServer({
    ...config.http,
    webAssetsDirectory: join(process.cwd(), 'dist', 'web'),
    engine,
    capabilities,
    integrations: () => ({
      home_assistant: homeAssistantSocket.status,
      mqtt: mqttSubscriber?.status ?? 'not_configured',
    }),
  });
  let castManager: DashCastManager | undefined;
  let displayServer: LugnDisplayServer | undefined;
  displayServer = config.display
    ? new LugnDisplayServer({
        host: config.display.host,
        port: config.display.port,
        allowedHosts: [new URL(config.display.publicUrl).host],
        hubs: config.display.hubs.map(({ id, role, castHost, token }) => ({
          id,
          role,
          castHost,
          token,
        })),
        capabilities,
        scenes: Array.from(engine.scenes.values()),
        stateProvider: () => engine.state,
        musicVolumePoliciesProvider: () =>
          engine.getMusicVolumePolicySnapshots(),
        environmentProvider: () => homeAssistantEnvironment.snapshot(),
        castStatus: (hubId) => {
          const lastHubPollAt = displayServer?.lastHubHeartbeatAt(hubId);
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
            castManager?.statusForHub(hubId) ?? {
              state: 'starting',
              message: 'Lugn ansluter till DashCast.',
            }
          );
        },
      })
    : undefined;
  castManager = config.display
    ? new DashCastManager({
        publicUrl: config.display.publicUrl,
        hubs: config.display.hubs.map(({ id, castHost }) => ({
          id,
          castHost,
        })),
        dashboardPath: (hubId) => displayServer!.pathForHub(hubId),
        dashboardActive: (hubId) => {
          const lastHubPollAt = displayServer?.lastHubHeartbeatAt(hubId);
          return (
            lastHubPollAt !== undefined && Date.now() - lastHubPollAt < 12_000
          );
        },
        ...(dependencies.createDashCastAdapter === undefined
          ? {}
          : { createAdapter: dependencies.createDashCastAdapter }),
      })
    : undefined;

  try {
    if (mqttSubscriber) mqttSubscriber.start();
    await seedHomeAssistantObservations(
      config.homeAssistant.baseUrl,
      config.homeAssistant.token,
      homeAssistantLighting,
      homeAssistantSwitch,
      homeAssistantMusic,
      homeAssistantEnvironment,
      homeAssistantHomePresence,
      homeAssistantFetch,
    );
    homeAssistantSocket.start();
    await http.start();
    await displayServer?.start();
    castManager?.start();
  } catch (error) {
    await castManager?.stop();
    await displayServer?.stop();
    await http.stop();
    sensorAdapter?.stop();
    unsubscribeMqttStatus?.();
    homeAssistantSocket.stop();
    await lightingIntentStore.stop();
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
      await castManager?.stop();
      await displayServer?.stop();
      await http.stop();
      sensorAdapter?.stop();
      unsubscribeMqttStatus?.();
      homeAssistantSocket.stop();
      await lightingIntentStore.stop();
      engine.dispose();
      await mqttSubscriber?.stop();
    },
  };
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
): Promise<void> {
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
      return;
    }
    const states: unknown = await response.json();
    if (!Array.isArray(states)) {
      console.warn(
        '[lugn] initial Home Assistant state query returned an unexpected response',
      );
      return;
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
  } catch {
    console.warn(
      '[lugn] initial Home Assistant state query failed; waiting for WebSocket observations',
    );
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
