import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  HomeAssistantSocket,
  HomeAssistantSocketMessageEvent,
} from '../src/adapters/home-assistant-websocket.js';
import type {
  Stl27lMqttMessageMetadata,
  Stl27lPresenceMqttSubscriber,
} from '../src/adapters/stl27l-mqtt-presence.js';
import { startRuntime } from '../src/runtime/main.js';
import type { MqttSubscriberStatus } from '../src/runtime/mqttjs-subscriber.js';

type MqttMessageHandler = (
  topic: string,
  payload: unknown,
  metadata: Stl27lMqttMessageMetadata,
) => void;

class FakeMqttSubscriber implements Stl27lPresenceMqttSubscriber {
  private readonly handlers = new Map<string, Set<MqttMessageHandler>>();
  private readonly statusListeners = new Set<
    (status: MqttSubscriberStatus) => void
  >();
  status: MqttSubscriberStatus = 'stopped';

  subscribe(
    topic: string,
    _options: { qos: 0 | 1 },
    onMessage: MqttMessageHandler,
  ): () => void {
    const topicHandlers = this.handlers.get(topic) ?? new Set();
    topicHandlers.add(onMessage);
    this.handlers.set(topic, topicHandlers);
    return () => {
      topicHandlers.delete(onMessage);
      if (topicHandlers.size === 0) this.handlers.delete(topic);
    };
  }

  onStatus(listener: (status: MqttSubscriberStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  start(): void {
    this.setStatus('connected');
  }

  async stop(): Promise<void> {
    this.setStatus('stopped');
    this.handlers.clear();
  }

  publish(topic: string, payload: unknown, retain: boolean): void {
    for (const handler of this.handlers.get(topic) ?? [])
      handler(topic, payload, { retain });
  }

  private setStatus(status: MqttSubscriberStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

class InertHomeAssistantSocket implements HomeAssistantSocket {
  addEventListener(
    type: 'message',
    listener: (event: HomeAssistantSocketMessageEvent) => void,
  ): void;
  addEventListener(type: 'close' | 'error', listener: () => void): void;
  addEventListener(
    type: 'message' | 'close' | 'error',
    listener: ((event: HomeAssistantSocketMessageEvent) => void) | (() => void),
  ): void {
    void type;
    void listener;
  }

  send(data: string): void {
    void data;
  }

  close(): void {}
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('composed runtime integration', () => {
  it('routes a live STL27L preview through prelight to the mapped HA light service', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lugn-runtime-'));
    const port = await findEphemeralLoopbackPort();
    vi.stubEnv('LUGN_TEST_HA_TOKEN', 'test-ha-token');
    const configPath = join(directory, 'runtime.json');
    await writeFile(
      configPath,
      JSON.stringify({
        http: { host: '127.0.0.1', port },
        homeAssistant: {
          baseUrl: 'http://home-assistant.invalid:8123',
          tokenEnv: 'LUGN_TEST_HA_TOKEN',
          entities: { 'lighting.entry': 'light.entry' },
        },
        mqtt: {
          url: 'mqtt://mqtt.invalid:1883',
          baseTopic: 'bruno/doorway',
        },
        prelight: {
          targets: {
            'lighting.entry': {
              power: true,
              brightness: 32,
              colorTemperature: 2700,
            },
          },
        },
        scenes: [],
      }),
      'utf8',
    );

    const mqtt = new FakeMqttSubscriber();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const homeAssistantFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, ...(init === undefined ? {} : { init }) });
      return url.endsWith('/api/states')
        ? new Response('[]', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response(null, { status: 200 });
    };

    const runtime = await startRuntime(configPath, {
      homeAssistantFetch,
      createMqttSubscriber: () => mqtt,
      createHomeAssistantSocket: () => new InertHomeAssistantSocket(),
    });

    try {
      mqtt.publish('bruno/doorway/preview', 'ON', false);
      await vi.waitFor(() => {
        expect(
          requests.filter(({ url }) => url.includes('/api/services/')),
        ).toHaveLength(1);
      });

      const serviceRequests = requests.filter(({ url }) =>
        url.includes('/api/services/'),
      );
      expect(serviceRequests).toHaveLength(1);
      expect(serviceRequests[0]?.url).toBe(
        'http://home-assistant.invalid:8123/api/services/light/turn_on',
      );
      expect(serviceRequests[0]?.init?.method).toBe('POST');
      expect(
        new Headers(serviceRequests[0]?.init?.headers).get('Authorization'),
      ).toBe('Bearer test-ha-token');
      expect(serviceRequests[0]?.init?.body).toBe(
        JSON.stringify({
          entity_id: 'light.entry',
          brightness_pct: 32,
          color_temp_kelvin: 2700,
        }),
      );
    } finally {
      await runtime.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function findEphemeralLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}
