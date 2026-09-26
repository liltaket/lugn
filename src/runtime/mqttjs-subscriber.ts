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
        connectTimeout: 10_000,
        reconnectPeriod: 1_000,
        reconnectOnConnackError: true,
        resubscribe: false,
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
