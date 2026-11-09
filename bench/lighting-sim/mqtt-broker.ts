import type {
  Stl27lMqttMessageMetadata,
  Stl27lPresenceMqttSubscriber,
} from '../../src/adapters/stl27l-mqtt-presence.js';
import type { SimClock } from './sim-clock.js';

type Handler = (
  topic: string,
  payload: unknown,
  metadata: Stl27lMqttMessageMetadata,
) => void;

/**
 * In-process MQTT broker with modeled delivery delay. It implements the
 * subscriber surface Lugn's STL27L adapter uses and delivers payloads as
 * bytes, like MQTT.js, so decoding stays on the measured path.
 */
export class SimMqttBroker implements Stl27lPresenceMqttSubscriber {
  private readonly subscriptions = new Map<
    number,
    { topic: string; handler: Handler }
  >();
  private readonly retained = new Map<string, Uint8Array>();
  private readonly connectionListeners = new Set<
    (connected: boolean) => void
  >();
  private nextSubscription = 1;
  private connected = true;
  private lastDeliveryAt = 0;
  /** Monotonic receive time of every delivered message, by sequence. */
  readonly deliveries: Array<{ topic: string; text: string; at: number }> = [];

  constructor(
    private readonly clock: SimClock,
    /** One-way publisher -> broker -> Lugn delay, in ms. */
    private readonly deliveryDelayMs: () => number = () => 2,
  ) {}

  subscribe(
    topic: string,
    _options: { qos: 0 | 1 },
    onMessage: Handler,
  ): () => void {
    const id = this.nextSubscription++;
    this.subscriptions.set(id, { topic, handler: onMessage });
    const retained = this.retained.get(topic);
    if (retained && this.connected)
      this.clock.setTimeout(() => this.deliver(topic, retained, true), 0);
    return () => this.subscriptions.delete(id);
  }

  onConnection(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  /**
   * Publish from the simulated sensor. Delivery keeps per-broker FIFO order
   * unless `reorder` is set, which lets a later message overtake this one.
   */
  publish(
    topic: string,
    text: string,
    options: { retain?: boolean; extraDelayMs?: number } = {},
  ): void {
    const payload = new TextEncoder().encode(text);
    if (options.retain) this.retained.set(topic, payload);
    if (!this.connected) return;
    const due =
      this.clock.monotonicNow() +
      this.deliveryDelayMs() +
      (options.extraDelayMs ?? 0);
    const at =
      options.extraDelayMs === undefined
        ? Math.max(due, this.lastDeliveryAt)
        : due;
    if (options.extraDelayMs === undefined) this.lastDeliveryAt = at;
    this.clock.setTimeout(
      () => this.deliver(topic, payload, false),
      at - this.clock.monotonicNow(),
    );
  }

  setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    for (const listener of this.connectionListeners) listener(connected);
    if (connected)
      for (const [topic, payload] of this.retained)
        this.clock.setTimeout(
          () => this.deliver(topic, payload, true),
          this.deliveryDelayMs(),
        );
  }

  private deliver(topic: string, payload: Uint8Array, retain: boolean): void {
    if (!this.connected) return;
    const at = this.clock.monotonicNow();
    this.clock.excluded(() =>
      this.deliveries.push({
        topic,
        text: new TextDecoder().decode(payload),
        at,
      }),
    );
    for (const { topic: subscribed, handler } of [
      ...this.subscriptions.values(),
    ])
      if (subscribed === topic) handler(topic, payload, { retain });
  }
}
