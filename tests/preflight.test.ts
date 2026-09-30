import { describe, expect, it } from 'vitest';
import type { Stl27lMqttMessageMetadata } from '../src/adapters/stl27l-mqtt-presence.js';
import type { RuntimeConfig } from '../src/runtime/config.js';
import {
  runPreflightCli,
  runRuntimePreflight,
  type PreflightMqttSubscriber,
} from '../src/runtime/preflight.js';
import type { MqttSubscriberStatus } from '../src/runtime/mqttjs-subscriber.js';

type MessageHandler = (
  topic: string,
  payload: unknown,
  metadata: Stl27lMqttMessageMetadata,
) => void;

const secret = 'test-private-token';
const sensorSnapshot = JSON.stringify({
  schema_version: 1,
  count: 0,
  quality: 'CERTAIN',
  confidence: 1,
  updated_at: '2026-09-27T09:00:00.000Z',
});

const stateList = [
  { entity_id: 'button.pc_lock', state: 'unknown', attributes: {} },
  { entity_id: 'light.desk', state: 'on', attributes: {} },
  { entity_id: 'switch.desk', state: 'off', attributes: {} },
  {
    entity_id: 'media_player.room',
    state: 'playing',
    attributes: { media_title: 'private media title' },
  },
];

function runtimeConfig(withMqtt = true, clientId?: string): RuntimeConfig {
  return {
    http: { host: '127.0.0.1', port: 8787, trustedOrigins: [] },
    statePath: '/tmp/lugn-state/lighting-intent.json',
    homeAssistant: {
      baseUrl: 'http://private-host.test:8123',
      token: secret,
      entities: { 'lighting.desk': 'light.desk' },
      buttons: { 'button.pc_lock': 'button.pc_lock' },
      switches: { 'switch.desk': 'switch.desk' },
      music: {
        'music.room': {
          entityId: 'media_player.room',
          sources: ['Spotify'],
          presets: { spotify_dj: 1, optical: 4 },
        },
      },
      environment: {
        temperature: 'sensor.temperature',
        humidity: 'sensor.humidity',
        co2: 'sensor.co2',
        pm25: 'sensor.pm25',
      },
    },
    ...(withMqtt
      ? {
          mqtt: {
            url: 'mqtt://private-host.test:1883',
            username: 'private-user',
            password: 'private-password',
            ...(clientId === undefined ? {} : { clientId }),
            baseTopic: 'bruno/doorway',
            maxAgeMs: 7_000,
          },
        }
      : {}),
    prelight: { targets: {}, maxDurationMs: 5_000 },
  };
}

class FakeMqttSubscriber implements PreflightMqttSubscriber {
  status: MqttSubscriberStatus = 'stopped';
  stopCalls = 0;
  readonly subscribedTopics: string[] = [];
  readonly subscriptions = new Map<string, MessageHandler>();
  private readonly statusListeners = new Set<
    (status: MqttSubscriberStatus) => void
  >();

  constructor(
    private readonly onError: () => void,
    private readonly publishFreshSensorOnConnect: boolean,
    private readonly failOnStart = false,
  ) {}

  subscribe(
    topic: string,
    _options: { qos: 0 | 1 },
    onMessage: MessageHandler,
  ): () => void {
    this.subscribedTopics.push(topic);
    this.subscriptions.set(topic, onMessage);
    return () => this.subscriptions.delete(topic);
  }

  onStatus(listener: (status: MqttSubscriberStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  start(): void {
    this.setStatus('connecting');
    if (this.failOnStart) {
      this.onError();
      return;
    }
    this.setStatus('connected');
    if (!this.publishFreshSensorOnConnect) return;
    this.publish('bruno/doorway/availability', 'online', true);
    this.publish('bruno/doorway/snapshot', sensorSnapshot, false);
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.subscriptions.clear();
    this.setStatus('stopped');
  }

  publish(topic: string, payload: string, retain: boolean): void {
    this.subscriptions.get(topic)?.(topic, payload, { retain });
  }

  private setStatus(status: MqttSubscriberStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  fail(): void {
    this.onError();
  }
}

function fakeFetch(states: unknown = stateList): typeof fetch {
  return async () => Response.json(states);
}

describe('read-only preflight', () => {
  it('uses one authenticated states GET, counts missing configured entities, and hides sensitive data', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), ...(init ? { init } : {}) });
      return Response.json(stateList.slice(0, 2));
    };
    const output: string[] = [];
    const errors: string[] = [];
    let loadedPath: string | undefined;
    const exitCode = await runPreflightCli(
      ['/private/path/config.json'],
      {},
      {
        loadConfig: (path) => {
          loadedPath = path;
          return runtimeConfig(false);
        },
        fetcher,
      },
      (value) => output.push(value),
      (value) => errors.push(value),
    );

    expect(exitCode).toBe(1);
    expect(loadedPath).toBe('/private/path/config.json');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('http://private-host.test:8123/api/states');
    expect(requests[0]?.init?.method).toBe('GET');
    expect(new Headers(requests[0]?.init?.headers).get('authorization')).toBe(
      `Bearer ${secret}`,
    );
    expect(output).toEqual([
      'Home Assistant: authenticated; entities 2/4 present, 2 missing\n' +
        'MQTT: not configured\n' +
        'STL27L feed: not configured',
    ]);
    expect(errors).toEqual([]);
    const emittedText = `${output.join('\n')} ${errors.join('\n')}`;
    for (const privateValue of [
      secret,
      'private-host.test',
      'light.desk',
      'switch.desk',
      'media_player.room',
      'private media title',
      '/private/path/config.json',
      'private-user',
      'private-password',
      'bruno/doorway',
      sensorSnapshot,
    ]) {
      expect(emittedText).not.toContain(privateValue);
    }
  });

  it('confirms fresh sensor status through the runtime STL27L adapter and stops MQTT', async () => {
    const subscriber = new FakeMqttSubscriber(() => undefined, true);
    let requestCount = 0;
    let mqttClientId: string | undefined;
    const report = await runRuntimePreflight(runtimeConfig(), {
      fetcher: async () => {
        requestCount += 1;
        return Response.json(stateList);
      },
      createMqttSubscriber: (config) => {
        mqttClientId = config.clientId;
        return subscriber;
      },
    });

    expect(report).toEqual({
      homeAssistant: {
        status: 'authenticated',
        configuredEntities: 4,
        presentEntities: 4,
        missingEntities: 0,
      },
      mqtt: { broker: 'connected', sensor: 'fresh' },
    });
    expect(requestCount).toBe(1);
    expect(mqttClientId).toMatch(
      /^lugn-preflight-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(mqttClientId).not.toBe(undefined);
    expect(mqttClientId?.length).toBeLessThanOrEqual(128);
    expect(subscriber.subscribedTopics).toEqual([
      'bruno/doorway/snapshot',
      'bruno/doorway/availability',
      'bruno/doorway/preview',
    ]);
    expect(subscriber.stopCalls).toBe(1);
  });

  it('uses a unique bounded preflight client ID for each probe', async () => {
    const runtimeClientId = 'runtime-' + 'x'.repeat(120);
    expect(runtimeClientId).toHaveLength(128);

    const readPreflightClientId = async (): Promise<string | undefined> => {
      let clientId: string | undefined;
      const subscriber = new FakeMqttSubscriber(() => undefined, false);
      await runRuntimePreflight(runtimeConfig(true, runtimeClientId), {
        fetcher: fakeFetch(),
        createMqttSubscriber: (config) => {
          clientId = config.clientId;
          return subscriber;
        },
        mqttWaitTimeoutMs: 1,
      });
      return clientId;
    };

    const firstClientId = await readPreflightClientId();
    const secondClientId = await readPreflightClientId();

    expect(firstClientId).toMatch(/^lugn-preflight-[0-9a-f-]{36}$/);
    expect(firstClientId).not.toBe(secondClientId);
    expect(firstClientId).not.toBe(runtimeClientId);
    expect(firstClientId?.length).toBeLessThanOrEqual(128);
  });

  it('reports a connected broker with no fresh sensor heartbeat and stops MQTT on timeout', async () => {
    const subscriber = new FakeMqttSubscriber(() => undefined, false);
    const report = await runRuntimePreflight(runtimeConfig(), {
      fetcher: fakeFetch(),
      createMqttSubscriber: () => subscriber,
      mqttWaitTimeoutMs: 1,
    });

    expect(report.mqtt).toEqual({ broker: 'connected', sensor: 'not_fresh' });
    expect(subscriber.stopCalls).toBe(1);
    expect(subscriber.subscriptions.size).toBe(0);
  });

  it('stops MQTT after a connection error without exposing its details', async () => {
    let subscriber: FakeMqttSubscriber | undefined;
    const report = await runRuntimePreflight(runtimeConfig(), {
      fetcher: fakeFetch(),
      createMqttSubscriber: (_config, onError) => {
        subscriber = new FakeMqttSubscriber(onError, false, true);
        return subscriber;
      },
      mqttWaitTimeoutMs: 100,
    });

    expect(report.mqtt).toEqual({ broker: 'error', sensor: 'not_checked' });
    expect(subscriber?.stopCalls).toBe(1);
  });

  it('reduces unauthorized responses and raw transport failures to categories', async () => {
    const unauthorized = await runRuntimePreflight(runtimeConfig(false), {
      fetcher: async () => new Response(`contains ${secret}`, { status: 401 }),
    });
    expect(unauthorized.homeAssistant).toEqual({
      status: 'authentication_failed',
      configuredEntities: 4,
    });

    const transportFailure = await runRuntimePreflight(runtimeConfig(false), {
      fetcher: async () => {
        throw new Error(`raw URL http://private-host.test token ${secret}`);
      },
    });
    expect(transportFailure.homeAssistant).toEqual({
      status: 'unavailable',
      configuredEntities: 4,
    });
  });

  it('returns success only for authenticated complete mappings and a fresh configured feed', async () => {
    const output: string[] = [];
    const subscriber = new FakeMqttSubscriber(() => undefined, true);
    const exitCode = await runPreflightCli(
      [],
      {},
      {
        loadConfig: () => runtimeConfig(),
        fetcher: fakeFetch(),
        createMqttSubscriber: () => subscriber,
      },
      (value) => output.push(value),
      () => undefined,
    );

    expect(exitCode).toBe(0);
    expect(output[0]).toContain('Home Assistant: authenticated');
    expect(output[0]).toContain('MQTT broker: connected');
    expect(output[0]).toContain('STL27L feed: online and fresh');
    expect(output.join('\n')).not.toContain(secret);
    expect(subscriber.stopCalls).toBe(1);
  });

  it('does not create an MQTT connection when the adapter is not configured', async () => {
    const report = await runRuntimePreflight(runtimeConfig(false), {
      fetcher: fakeFetch(),
      createMqttSubscriber: () => {
        throw new Error('should not be called');
      },
    });

    expect(report.mqtt).toEqual({
      broker: 'not_configured',
      sensor: 'not_configured',
    });
  });
});
