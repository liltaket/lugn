import { HomeAssistantMusicAdapter } from '../adapters/home-assistant-music.js';
import { pathToFileURL } from 'node:url';
import { HomeAssistantLightingAdapter } from '../adapters/home-assistant-lighting.js';
import { HomeAssistantSwitchAdapter } from '../adapters/home-assistant-switch.js';
import { HomeAssistantWebSocketTransport } from '../adapters/home-assistant-websocket.js';
import { PresenceEventIngress } from '../adapters/presence-event-ingress.js';
import {
  Stl27lMqttPresenceAdapter,
  type Stl27lPresenceMqttSubscriber,
} from '../adapters/stl27l-mqtt-presence.js';
import { CapabilityRegistry } from '../application/capabilities.js';
import { LugnEngine } from '../application/lugn-engine.js';
import { systemClock } from '../core/clock.js';
import { LugnHttpServer } from './http-server.js';
import { MqttJsSubscriber } from './mqttjs-subscriber.js';
import { loadRuntimeConfig, RuntimeConfigError } from './config.js';

export type LugnRuntime = {
  engine: LugnEngine;
  stop(): Promise<void>;
};

/** Starts the local Lugn host and its configured Home Assistant/MQTT links. */
export async function startRuntime(configPath?: string): Promise<LugnRuntime> {
  const config = configPath
    ? loadRuntimeConfig(configPath)
    : loadRuntimeConfig();
  const homeAssistantFetch: typeof fetch = (input, init) =>
    fetch(input, {
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
  const engine = new LugnEngine(systemClock, {
    adapter: homeAssistantLighting,
    deviceIds: Object.keys(config.homeAssistant.entities),
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
    ...(config.scenes === undefined ? {} : { scenes: config.scenes }),
  });
  const capabilities = new CapabilityRegistry(engine);
  const homeAssistantSocket = new HomeAssistantWebSocketTransport(
    {
      baseUrl: config.homeAssistant.baseUrl,
      token: config.homeAssistant.token,
    },
    (event) => {
      homeAssistantLighting.acceptStateChangedEvent(event);
      homeAssistantSwitch?.acceptStateChangedEvent(event);
      homeAssistantMusic?.acceptStateChangedEvent(event);
    },
  );
  let mqttSubscriber: MqttJsSubscriber | undefined;
  let sensorAdapter: Stl27lMqttPresenceAdapter | undefined;
  let unsubscribeMqttStatus: (() => void) | undefined;

  if (config.mqtt) {
    mqttSubscriber = new MqttJsSubscriber(
      {
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
      },
      () => console.warn('[lugn] MQTT operation failed'),
    );
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
    engine,
    capabilities,
    integrations: () => ({
      home_assistant: homeAssistantSocket.status,
      mqtt: mqttSubscriber?.status ?? 'not_configured',
    }),
  });

  try {
    if (mqttSubscriber) mqttSubscriber.start();
    await seedHomeAssistantObservations(
      config.homeAssistant.baseUrl,
      config.homeAssistant.token,
      homeAssistantLighting,
      homeAssistantSwitch,
      homeAssistantMusic,
    );
    homeAssistantSocket.start();
    await http.start();
  } catch (error) {
    sensorAdapter?.stop();
    unsubscribeMqttStatus?.();
    homeAssistantSocket.stop();
    engine.dispose();
    await mqttSubscriber?.stop();
    throw error;
  }

  console.info(
    `[lugn] listening at http://${config.http.host}:${config.http.port}`,
  );
  return {
    engine,
    async stop() {
      await http.stop();
      sensorAdapter?.stop();
      unsubscribeMqttStatus?.();
      homeAssistantSocket.stop();
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
): Promise<void> {
  try {
    const response = await fetch(`${baseUrl}/api/states`, {
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
