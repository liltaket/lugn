import { describe, expect, it } from 'vitest';
import {
  Stl27lMqttPresenceAdapter,
  type Stl27lMqttMessageMetadata,
  type Stl27lPresenceMqttSubscriber,
} from '../src/adapters/stl27l-mqtt-presence.js';
import { FakeClock } from '../src/core/clock.js';
import type { PresenceInputEvent } from '../src/core/schemas.js';

type MessageHandler = (
  topic: string,
  payload: unknown,
  metadata: Stl27lMqttMessageMetadata,
) => void;

class FakeMqttSubscriber implements Stl27lPresenceMqttSubscriber {
  readonly subscriptions = new Map<
    string,
    { qos: 0 | 1; handlers: Set<MessageHandler> }
  >();

  subscribe(
    topic: string,
    options: { qos: 0 | 1 },
    onMessage: MessageHandler,
  ): () => void {
    let subscription = this.subscriptions.get(topic);
    if (!subscription) {
      subscription = { qos: options.qos, handlers: new Set() };
      this.subscriptions.set(topic, subscription);
    }
    subscription.handlers.add(onMessage);

    return () => {
      subscription?.handlers.delete(onMessage);
      if (subscription?.handlers.size === 0) {
        this.subscriptions.delete(topic);
      }
    };
  }

  publish(topic: string, payload: unknown, retain = false): void {
    const metadata = { retain };
    for (const handler of this.subscriptions.get(topic)?.handlers ?? []) {
      handler(topic, payload, metadata);
    }
  }
}

const BASE_TOPIC = 'bruno/doorway';
const START_TIME = Date.parse('2026-09-26T12:00:00.000Z');

function setup(maxAgeMs = 5_000) {
  const clock = new FakeClock(START_TIME);
  const subscriber = new FakeMqttSubscriber();
  const events: PresenceInputEvent[] = [];
  const adapter = new Stl27lMqttPresenceAdapter(
    subscriber,
    (event) => events.push(event),
    { clock, maxAgeMs },
  );
  adapter.start();
  adapter.setBrokerConnected(true);
  return { adapter, clock, events, subscriber };
}

function publishAvailability(
  subscriber: FakeMqttSubscriber,
  state: string,
): void {
  subscriber.publish(`${BASE_TOPIC}/availability`, state, true);
}

function publishSnapshot(
  subscriber: FakeMqttSubscriber,
  clock: FakeClock,
  options: {
    count: number;
    quality?: 'CERTAIN' | 'DEGRADED' | 'UNCERTAIN';
    retain?: boolean;
  },
): void {
  const { count, quality = 'CERTAIN', retain = false } = options;
  subscriber.publish(
    `${BASE_TOPIC}/snapshot`,
    JSON.stringify({
      schema_version: 1,
      count,
      quality,
      confidence: 1,
      updated_at: new Date(clock.now()).toISOString(),
    }),
    retain,
  );
}

function expectLatestPresence(
  events: PresenceInputEvent[],
  presence: 'occupied' | 'confirmed_empty' | 'unknown',
  personCount?: number | null,
): void {
  const event = [...events]
    .reverse()
    .find((candidate) => candidate.type === 'presence.changed');
  expect(event).toMatchObject({
    type: 'presence.changed',
    presence,
    ...(personCount === undefined ? {} : { personCount }),
    source: 'stl27l',
  });
}

describe('STL27L MQTT presence adapter', () => {
  it('subscribes at the topic QoS levels and does not trust retained snapshots as fresh', () => {
    const { clock, events, subscriber } = setup();

    expect(
      [...subscriber.subscriptions.entries()].map(([topic, value]) => [
        topic,
        value.qos,
      ]),
    ).toEqual([
      [`${BASE_TOPIC}/snapshot`, 1],
      [`${BASE_TOPIC}/availability`, 1],
      [`${BASE_TOPIC}/preview`, 0],
    ]);

    publishAvailability(subscriber, 'online');
    publishSnapshot(subscriber, clock, { count: 2, retain: true });
    expectLatestPresence(events, 'unknown', null);

    publishSnapshot(subscriber, clock, { count: 2 });
    expectLatestPresence(events, 'occupied', 2);
  });

  it('normalizes fresh CERTAIN heartbeats to occupied and confirmed empty', () => {
    const { clock, events, subscriber } = setup();
    publishAvailability(subscriber, 'online');

    publishSnapshot(subscriber, clock, { count: 3 });
    expectLatestPresence(events, 'occupied', 3);

    publishSnapshot(subscriber, clock, { count: 0 });
    expectLatestPresence(events, 'confirmed_empty', 0);
  });

  it('fails closed for non-CERTAIN, offline, and disconnected sensor states', () => {
    const { adapter, clock, events, subscriber } = setup();
    publishAvailability(subscriber, 'online');
    publishSnapshot(subscriber, clock, { count: 1 });
    expectLatestPresence(events, 'occupied', 1);

    publishSnapshot(subscriber, clock, { count: 1, quality: 'DEGRADED' });
    expectLatestPresence(events, 'unknown', null);

    publishSnapshot(subscriber, clock, { count: 1 });
    expectLatestPresence(events, 'occupied', 1);
    publishAvailability(subscriber, 'offline');
    expectLatestPresence(events, 'unknown', null);
    publishAvailability(subscriber, 'online');
    expectLatestPresence(events, 'unknown', null);
    publishSnapshot(subscriber, clock, { count: 1 });
    expectLatestPresence(events, 'occupied', 1);

    adapter.setBrokerConnected(false);
    expectLatestPresence(events, 'unknown', null);
    adapter.setBrokerConnected(true);
    publishAvailability(subscriber, 'online');
    expectLatestPresence(events, 'unknown', null);
    publishSnapshot(subscriber, clock, { count: 1 });
    expectLatestPresence(events, 'occupied', 1);
  });

  it('emits unknown when the local heartbeat freshness window expires', () => {
    const { clock, events, subscriber } = setup(5_000);
    publishAvailability(subscriber, 'online');
    publishSnapshot(subscriber, clock, { count: 1 });
    expectLatestPresence(events, 'occupied', 1);

    clock.advanceBy(5_000);
    expectLatestPresence(events, 'unknown', null);
  });

  it('keeps preview edge-triggered and resets its edge after offline or disconnect', () => {
    const { adapter, events, subscriber } = setup();
    const topic = `${BASE_TOPIC}/preview`;

    subscriber.publish(topic, 'ON', true);
    expect(
      events.filter((event) => event.type === 'presence.prelight'),
    ).toEqual([]);

    subscriber.publish(topic, 'ON');
    subscriber.publish(topic, 'ON');
    publishAvailability(subscriber, 'offline');
    publishAvailability(subscriber, 'online');
    subscriber.publish(topic, 'ON');

    adapter.setBrokerConnected(false);
    adapter.setBrokerConnected(true);
    publishAvailability(subscriber, 'online');
    subscriber.publish(topic, 'ON');

    expect(
      events
        .filter((event) => event.type === 'presence.prelight')
        .map((event) => event.active),
    ).toEqual([true, true, true]);
  });
});
