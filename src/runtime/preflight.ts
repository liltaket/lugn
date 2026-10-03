import { randomUUID } from 'node:crypto';
import {
  Stl27lMqttPresenceAdapter,
  type Stl27lPresenceMqttSubscriber,
} from '../adapters/stl27l-mqtt-presence.js';
import {
  discoverHomeAssistant,
  HaDiscoverError,
  isDirectExecution,
} from './ha-discover.js';
import { loadRuntimeConfig, type RuntimeConfig } from './config.js';
import {
  MqttJsSubscriber,
  type MqttSubscriberStatus,
} from './mqttjs-subscriber.js';

const MQTT_CONNECT_TIMEOUT_MS = 5_000;
const MQTT_SENSOR_WAIT_TIMEOUT_MS = 10_000;

export type HomeAssistantPreflight =
  | {
      status: 'authenticated';
      configuredEntities: number;
      presentEntities: number;
      missingEntities: number;
    }
  | {
      status: 'authentication_failed' | 'unavailable' | 'invalid_response';
      configuredEntities: number;
    };

export type MqttPreflight =
  | { broker: 'not_configured'; sensor: 'not_configured' }
  | {
      broker: 'connected' | 'unavailable' | 'timed_out' | 'error';
      sensor: 'fresh' | 'not_fresh' | 'not_checked';
    };

export type RuntimePreflightReport = {
  homeAssistant: HomeAssistantPreflight;
  mqtt: MqttPreflight;
};

export interface PreflightMqttSubscriber extends Stl27lPresenceMqttSubscriber {
  readonly status: MqttSubscriberStatus;
  onStatus(listener: (status: MqttSubscriberStatus) => void): () => void;
  start(): void;
  stop(): Promise<void>;
}

export type PreflightDependencies = {
  fetcher?: typeof fetch;
  createMqttSubscriber?: (
    config: NonNullable<RuntimeConfig['mqtt']>,
    onError: () => void,
  ) => PreflightMqttSubscriber;
  mqttWaitTimeoutMs?: number;
  loadConfig?: (
    configPath: string | undefined,
    environment: NodeJS.ProcessEnv,
  ) => RuntimeConfig;
};

/** Checks configured links without invoking Home Assistant services or devices. */
export async function runRuntimePreflight(
  config: RuntimeConfig,
  dependencies: PreflightDependencies = {},
): Promise<RuntimePreflightReport> {
  const [homeAssistant, mqtt] = await Promise.all([
    checkHomeAssistant(config, dependencies.fetcher ?? fetch),
    checkMqtt(config, dependencies),
  ]);
  return { homeAssistant, mqtt };
}

async function checkHomeAssistant(
  config: RuntimeConfig,
  fetcher: typeof fetch,
): Promise<HomeAssistantPreflight> {
  const configuredEntityIds = [
    ...Object.values(config.homeAssistant.buttons),
    ...Object.values(config.homeAssistant.entities),
    ...Object.values(config.homeAssistant.switches),
    ...Object.values(config.homeAssistant.music).map(
      (mapping) => mapping.entityId,
    ),
  ];
  const uniqueConfiguredEntityIds = [...new Set(configuredEntityIds)];

  try {
    const candidates = await discoverHomeAssistant(
      config.homeAssistant.baseUrl,
      config.homeAssistant.token,
      fetcher,
    );
    const availableEntityIds = new Set([
      ...candidates.button,
      ...candidates.light,
      ...candidates.switch,
      ...candidates.media_player.map((candidate) => candidate.entity_id),
    ]);
    const presentEntities = uniqueConfiguredEntityIds.filter((entityId) =>
      availableEntityIds.has(entityId),
    ).length;

    return {
      status: 'authenticated',
      configuredEntities: uniqueConfiguredEntityIds.length,
      presentEntities,
      missingEntities: uniqueConfiguredEntityIds.length - presentEntities,
    };
  } catch (error) {
    return {
      status: classifyHomeAssistantFailure(error),
      configuredEntities: uniqueConfiguredEntityIds.length,
    };
  }
}

function classifyHomeAssistantFailure(
  error: unknown,
): Exclude<HomeAssistantPreflight['status'], 'authenticated'> {
  if (!(error instanceof HaDiscoverError)) return 'unavailable';
  if (/HTTP (401|403)\b/.test(error.message)) return 'authentication_failed';
  if (error.message.includes('invalid state list')) return 'invalid_response';
  return 'unavailable';
}

async function checkMqtt(
  config: RuntimeConfig,
  dependencies: PreflightDependencies,
): Promise<MqttPreflight> {
  const mqttConfig = config.mqtt;
  if (!mqttConfig)
    return { broker: 'not_configured', sensor: 'not_configured' };

  const probeConfig = {
    ...mqttConfig,
    clientId: createPreflightClientId(mqttConfig.clientId),
  };
  let failed = false;
  let completeWait:
    | ((result: 'fresh' | 'disconnected' | 'error' | 'timeout') => void)
    | undefined;
  const createSubscriber =
    dependencies.createMqttSubscriber ?? createDefaultMqttSubscriber;
  let subscriber: PreflightMqttSubscriber;
  try {
    subscriber = createSubscriber(probeConfig, () => {
      failed = true;
      completeWait?.('error');
    });
  } catch {
    return { broker: 'error', sensor: 'not_checked' };
  }

  let sawConnection = false;
  let currentStatus = subscriber.status;
  let outcome: 'fresh' | 'disconnected' | 'error' | 'timeout' = 'timeout';
  let unsubscribeStatus: (() => void) | undefined;
  let sensor: Stl27lMqttPresenceAdapter | undefined;

  try {
    sensor = new Stl27lMqttPresenceAdapter(
      subscriber,
      (event) => {
        if (event.type !== 'presence.changed') return;
        if (event.presence !== 'unknown') completeWait?.('fresh');
      },
      {
        baseTopic: mqttConfig.baseTopic,
        maxAgeMs: mqttConfig.maxAgeMs,
      },
    );

    outcome = await new Promise((resolve) => {
      let settled = false;
      const timeout = setTimeout(
        () => completeWait?.('timeout'),
        dependencies.mqttWaitTimeoutMs ?? MQTT_SENSOR_WAIT_TIMEOUT_MS,
      );
      const finish = (result: typeof outcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };
      completeWait = finish;

      try {
        unsubscribeStatus = subscriber.onStatus((status) => {
          currentStatus = status;
          if (status === 'connected') {
            sawConnection = true;
            sensor?.setBrokerConnected(true);
          } else if (status === 'disconnected' || status === 'reconnecting') {
            sensor?.setBrokerConnected(false);
            if (settled) return;
            if (status === 'disconnected') finish('disconnected');
          }
        });
        sensor?.start();
        subscriber.start();
        if (failed) finish('error');
      } catch {
        finish('error');
      }
    });
  } catch {
    outcome = 'error';
  } finally {
    completeWait = undefined;
    unsubscribeStatus?.();
    try {
      sensor?.stop();
    } catch {
      // A shutdown failure is reported through the bounded preflight result.
    }
    try {
      await subscriber.stop();
    } catch {
      // Never surface a raw MQTT library or transport error to the operator.
    }
  }

  if (outcome === 'fresh') return { broker: 'connected', sensor: 'fresh' };
  if (outcome === 'error' || failed)
    return {
      broker: 'error',
      sensor: sawConnection ? 'not_fresh' : 'not_checked',
    };
  if (outcome === 'disconnected')
    return {
      broker: 'unavailable',
      sensor: sawConnection ? 'not_fresh' : 'not_checked',
    };
  if (sawConnection && currentStatus === 'connected')
    return { broker: 'connected', sensor: 'not_fresh' };
  return { broker: 'timed_out', sensor: 'not_checked' };
}

function createDefaultMqttSubscriber(
  config: NonNullable<RuntimeConfig['mqtt']>,
  onError: () => void,
): PreflightMqttSubscriber {
  return new MqttJsSubscriber(
    {
      url: config.url,
      connectTimeoutMs: MQTT_CONNECT_TIMEOUT_MS,
      reconnectPeriodMs: 0,
      ...(config.username === undefined ? {} : { username: config.username }),
      ...(config.password === undefined ? {} : { password: config.password }),
      ...(config.clientId === undefined ? {} : { clientId: config.clientId }),
    },
    onError,
  );
}

/** Keep each read-only probe on its own broker connection. */
function createPreflightClientId(
  configuredClientId: string | undefined,
): string {
  const candidate = `lugn-preflight-${randomUUID()}`;

  // Config accepts any ID up to 128 characters, including this candidate.
  // Extend the probe ID on the exact-collision edge case.
  return candidate === configuredClientId ? `${candidate}-probe` : candidate;
}

function parseArgs(
  args: string[],
): { help: true } | { help: false; configPath?: string } {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  if (args.length > 1 || args.some((argument) => argument.startsWith('--')))
    throw new Error('invalid arguments');
  return {
    help: false,
    ...(args[0] === undefined ? {} : { configPath: args[0] }),
  };
}

const HELP_TEXT = [
  'Usage: npm run preflight -- [config-path]',
  '',
  'Read-only checks: one Home Assistant GET /api/states request, then an MQTT',
  'connection and STL27L feed freshness check when MQTT is configured.',
  'The command never calls Home Assistant device services or changes devices.',
  'Secrets are read from the environment and are never printed.',
].join('\n');

export function formatPreflightReport(report: RuntimePreflightReport): string {
  const homeAssistant = report.homeAssistant;
  const homeAssistantLine =
    homeAssistant.status === 'authenticated'
      ? `Home Assistant: authenticated; entities ${homeAssistant.presentEntities}/${homeAssistant.configuredEntities} present, ${homeAssistant.missingEntities} missing`
      : `Home Assistant: ${formatHaStatus(homeAssistant.status)}; ${homeAssistant.configuredEntities} configured entities, presence unverified`;

  let mqttLines: string[];
  if (report.mqtt.broker === 'not_configured') {
    mqttLines = ['MQTT: not configured', 'STL27L feed: not configured'];
  } else {
    mqttLines = [
      `MQTT broker: ${formatMqttStatus(report.mqtt.broker)}`,
      `STL27L feed: ${formatSensorStatus(report.mqtt.sensor)}`,
    ];
  }
  return [homeAssistantLine, ...mqttLines].join('\n');
}

function formatHaStatus(
  status: Exclude<HomeAssistantPreflight['status'], 'authenticated'>,
): string {
  switch (status) {
    case 'authentication_failed':
      return 'authentication failed';
    case 'invalid_response':
      return 'invalid response';
    case 'unavailable':
      return 'unavailable';
  }
}

function formatMqttStatus(
  status: Exclude<MqttPreflight['broker'], 'not_configured'>,
): string {
  switch (status) {
    case 'connected':
      return 'connected';
    case 'unavailable':
      return 'unavailable';
    case 'timed_out':
      return 'timed out';
    case 'error':
      return 'error';
  }
}

function formatSensorStatus(
  status: Exclude<MqttPreflight['sensor'], 'not_configured'>,
): string {
  switch (status) {
    case 'fresh':
      return 'online and fresh';
    case 'not_fresh':
      return 'not fresh or unavailable';
    case 'not_checked':
      return 'not verified';
  }
}

export async function runPreflightCli(
  args: string[],
  environment: NodeJS.ProcessEnv,
  dependencies: PreflightDependencies,
  writeOutput: (value: string) => void,
  writeError: (value: string) => void,
): Promise<number> {
  let parsedArgs: ReturnType<typeof parseArgs>;
  try {
    parsedArgs = parseArgs(args);
  } catch {
    writeError('Usage: npm run preflight -- [config-path]');
    return 2;
  }
  if (parsedArgs.help) {
    writeOutput(HELP_TEXT);
    return 0;
  }

  let config: RuntimeConfig;
  try {
    config = (dependencies.loadConfig ?? loadRuntimeConfig)(
      parsedArgs.configPath,
      environment,
    );
  } catch {
    writeError('Configuration: invalid or missing required values.');
    return 2;
  }

  const report = await runRuntimePreflight(config, dependencies);
  writeOutput(formatPreflightReport(report));

  const homeAssistantReady =
    report.homeAssistant.status === 'authenticated' &&
    report.homeAssistant.missingEntities === 0;
  const mqttReady =
    report.mqtt.broker === 'not_configured' ||
    (report.mqtt.broker === 'connected' && report.mqtt.sensor === 'fresh');
  return homeAssistantReady && mqttReady ? 0 : 1;
}

if (isDirectExecution(process.argv[1], import.meta.url)) {
  void runPreflightCli(
    process.argv.slice(2),
    process.env,
    {},
    (value) => console.log(value),
    (value) => console.error(`[lugn] ${value}`),
  ).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
