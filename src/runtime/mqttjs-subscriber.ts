import { connect, type MqttClient } from 'mqtt';

export type PresenceMqttSubscriber = {
  subscribe(
    topic: string,
    options: { qos: 0 | 1 },
    onMessage: (
      topic: string,
      payload: unknown,
      metadata: { retain: boolean },
    ) => void,
  ): () => void;
};

export type MqttSubscriberConfig = {
  url: string;
  username?: string;
  password?: string;
  clientId?: string;
  connectTimeoutMs?: number;
  reconnectPeriodMs?: number;
};

export type MqttSubscriberStatus =
  'stopped' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

type MessageHandler = (
  topic: string,
  payload: unknown,
  metadata: { retain: boolean },
) => void;

type Subscription = {
  topic: string;
  qos: 0 | 1;
  onMessage: MessageHandler;
};

/** MQTT.js-backed subscriber that forwards the broker RETAIN flag explicitly. */
export class MqttJsSubscriber implements PresenceMqttSubscriber {
  private client: MqttClient | undefined;
  private active = false;
  private nextSubscriptionId = 0;
  private readonly subscriptions = new Map<number, Subscription>();
  private readonly statusListeners = new Set<
    (status: MqttSubscriberStatus) => void
  >();
  private _status: MqttSubscriberStatus = 'stopped';
  private readonly pendingPublishes = new Set<() => void>();
  private readonly publicationGuards = new Map<string, Set<number>>();

  constructor(
    private readonly config: MqttSubscriberConfig,
    private readonly onError?: () => void,
  ) {}

  get status(): MqttSubscriberStatus {
    return this._status;
  }

  onStatus(listener: (status: MqttSubscriberStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this._status);
    return () => this.statusListeners.delete(listener);
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.setStatus('connecting');
    try {
      const client = connect(this.config.url, {
        clean: true,
        connectTimeout: this.config.connectTimeoutMs ?? 10_000,
        reconnectPeriod: this.config.reconnectPeriodMs ?? 1_000,
        reconnectOnConnackError: true,
        resubscribe: false,
        queueQoSZero: false,
        ...(this.config.clientId === undefined
          ? {}
          : { clientId: this.config.clientId }),
        ...(this.config.username === undefined
          ? {}
          : { username: this.config.username }),
        ...(this.config.password === undefined
          ? {}
          : { password: this.config.password }),
      });
      this.client = client;
      // MQTT.js can defer publish() while its outgoing store is processing.
      // Reject that deferred operation if its connection or caller has gone
      // away, before the packet can enter the QoS 1 reconnect store.
      const store = client.outgoingStore;
      const put = store.put.bind(store);
      store.put = (packet, callback) => {
        if (packet.cmd === 'publish') {
          const guard = this.publicationGuards.get(
            JSON.stringify([packet.topic, String(packet.payload)]),
          );
          if (
            !guard ||
            !this.active ||
            this.client !== client ||
            !client.connected
          ) {
            callback(new Error('MQTT publication no longer authorized'));
            if (packet.messageId !== undefined)
              client.removeOutgoingMessage(packet.messageId);
            return store;
          }
          if (packet.messageId !== undefined) guard.add(packet.messageId);
        }
        put(packet, callback);
        return store;
      };
      client.on('connect', () => {
        if (!this.active || this.client !== client) return;
        this.setStatus('connected');
        this.subscribeRegisteredTopics(client);
      });
      client.on('reconnect', () => {
        if (!this.active || this.client !== client) return;
        this.setStatus('reconnecting');
      });
      client.on('offline', () => {
        if (!this.active || this.client !== client) return;
        this.setStatus('disconnected');
      });
      client.on('close', () => {
        if (!this.active || this.client !== client) return;
        this.setStatus('disconnected');
      });
      client.on('error', () => {
        if (!this.active || this.client !== client) return;
        this.reportError();
      });
      client.on('message', (topic, payload, packet) => {
        if (!this.active || this.client !== client) return;
        for (const subscription of this.subscriptions.values()) {
          if (subscription.topic !== topic) continue;
          try {
            subscription.onMessage(topic, payload, {
              retain: packet.retain === true,
            });
          } catch {
            this.reportError();
          }
        }
      });
    } catch {
      this.setStatus('disconnected');
      this.reportError();
    }
  }

  subscribe(
    topic: string,
    options: { qos: 0 | 1 },
    onMessage: MessageHandler,
  ): () => void {
    const id = ++this.nextSubscriptionId;
    this.subscriptions.set(id, { topic, qos: options.qos, onMessage });
    const client = this.client;
    if (client?.connected) this.subscribeTopic(client, topic, options.qos);
    return () => {
      this.subscriptions.delete(id);
    };
  }

  async stop(): Promise<void> {
    this.active = false;
    this.subscriptions.clear();
    const client = this.client;
    this.client = undefined;
    this.setStatus('stopped');
    if (!client) return;
    try {
      await client.endAsync(true);
    } catch {
      this.reportError();
    }
  }

  /** Commands must be sent on the current connection, never queued offline. */
  publish(
    topic: string,
    payload: string,
    options: { qos: 1; retain: false },
    signal?: AbortSignal,
  ): Promise<void> {
    const client = this.client;
    if (!this.active || !client?.connected || this.status !== 'connected')
      return Promise.reject(new Error('MQTT broker is disconnected'));
    if (signal?.aborted)
      return Promise.reject(new Error('MQTT publication aborted'));
    const key = JSON.stringify([topic, payload]);
    if (this.publicationGuards.has(key))
      return Promise.reject(new Error('MQTT publication already pending'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const messageIds = new Set<number>();
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', cancelled);
        this.pendingPublishes.delete(disconnected);
        this.publicationGuards.delete(key);
        if (error) {
          for (const id of messageIds) client.removeOutgoingMessage(id);
          reject(error);
        } else resolve();
      };
      const disconnected = () =>
        finish(new Error('MQTT broker disconnected during publication'));
      const cancelled = () => finish(new Error('MQTT publication aborted'));
      this.pendingPublishes.add(disconnected);
      this.publicationGuards.set(key, messageIds);
      signal?.addEventListener('abort', cancelled, { once: true });
      try {
        client.publish(topic, payload, options, (error) =>
          finish(error ?? undefined),
        );
      } catch (error) {
        finish(
          error instanceof Error ? error : new Error('MQTT publication failed'),
        );
      }
    });
  }

  private subscribeRegisteredTopics(client: MqttClient): void {
    const qosByTopic = new Map<string, 0 | 1>();
    for (const subscription of this.subscriptions.values()) {
      const previousQos = qosByTopic.get(subscription.topic) ?? 0;
      qosByTopic.set(
        subscription.topic,
        Math.max(previousQos, subscription.qos) as 0 | 1,
      );
    }
    for (const [topic, qos] of qosByTopic)
      this.subscribeTopic(client, topic, qos);
  }

  private subscribeTopic(client: MqttClient, topic: string, qos: 0 | 1): void {
    client.subscribe(topic, { qos }, (error) => {
      if (error) this.reportError();
    });
  }

  private setStatus(status: MqttSubscriberStatus): void {
    if (this._status === status) return;
    this._status = status;
    if (status !== 'connected')
      for (const cancel of [...this.pendingPublishes]) cancel();
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch {
        this.reportError();
      }
    }
  }

  private reportError(): void {
    try {
      this.onError?.();
    } catch {
      // Status reporting must not turn a broker callback into a process error.
    }
  }
}
