import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ComputerMqttAdapter } from '../src/adapters/computer-mqtt.js';
import { FakeClock } from '../src/core/clock.js';
import {
  ComputerObservationSchema,
  unknownComputerReadings,
  type ComputerObservation,
} from '../src/core/computer.js';
import type { PresenceMqttSubscriber } from '../src/runtime/mqttjs-subscriber.js';

type Handler = Parameters<PresenceMqttSubscriber['subscribe']>[2];
class Subscriber implements PresenceMqttSubscriber {
  readonly handlers = new Map<string, Handler>();
  readonly qos = new Map<string, number>();
  subscribe(
    topic: string,
    options: { qos: 0 | 1 },
    handler: Handler,
  ): () => void {
    this.handlers.set(topic, handler);
    this.qos.set(topic, options.qos);
    return () => {
      this.handlers.delete(topic);
    };
  }
  send(suffix: string, payload: unknown, retain = false): void {
    this.handlers.get(`lugn/computers/desktop/${suffix}`)?.(
      `lugn/computers/desktop/${suffix}`,
      payload,
      { retain },
    );
  }
}
function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      new URL(`./fixtures/computer-mqtt/${name}.example.json`, import.meta.url),
      'utf8',
    ),
  ) as Record<string, unknown>;
}
const NOW = Number(fixture('state')['timestamp_ms']);
const SESSION = String(fixture('state')['session_id']);
const NEXT_SESSION = '123e4567-e89b-42d3-a456-426614174001';
function setup() {
  const clock = new FakeClock(NOW);
  const subscriber = new Subscriber();
  const observations: ComputerObservation[] = [];
  const adapter = new ComputerMqttAdapter(
    subscriber,
    (observation) => {
      observations.push(ComputerObservationSchema.parse(observation));
    },
    { deviceId: 'desktop', maxAgeMs: 5_000, clock },
  );
  adapter.start();
  adapter.setBrokerConnected(true);
  const state = (overrides: Record<string, unknown> = {}, retain = false) =>
    subscriber.send(
      'state',
      JSON.stringify({
        ...fixture('state'),
        timestamp_ms: clock.now(),
        ...overrides,
      }),
      retain,
    );
  const availability = (status = 'online', session = SESSION) =>
    subscriber.send(
      'availability',
      JSON.stringify({
        ...fixture('availability-online'),
        status,
        session_id: session,
      }),
      true,
    );
  const event = (overrides: Record<string, unknown> = {}, retain = false) =>
    subscriber.send(
      'events',
      JSON.stringify({
        ...fixture('events'),
        timestamp_ms: clock.now(),
        ...overrides,
      }),
      retain,
    );
  const last = () => observations.at(-1)!;
  const live = () => {
    availability();
    state();
  };
  return {
    clock,
    subscriber,
    observations,
    adapter,
    state,
    availability,
    event,
    last,
    live,
  };
}

describe('ComputerMqttAdapter v1', () => {
  it('subscribes once to the three concrete QoS 1 topics and cancels on stop', () => {
    const { adapter, subscriber, clock, last, live } = setup();
    adapter.start();
    expect([...subscriber.qos]).toEqual(
      ['state', 'availability', 'events'].map((suffix) => [
        `lugn/computers/desktop/${suffix}`,
        1,
      ]),
    );
    live();
    const lateHandler = subscriber.handlers.get(
      'lugn/computers/desktop/state',
    )!;
    adapter.stop();
    expect(subscriber.handlers.size).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
    expect(last()).toMatchObject({
      reason: 'stopped',
      availability: 'unknown',
      observed: unknownComputerReadings(),
    });
    lateHandler(
      'lugn/computers/desktop/state',
      JSON.stringify(fixture('state')),
      { retain: false },
    );
    expect(last().reason).toBe('stopped');
  });

  it.each(['state-first', 'availability-first'])(
    'accepts PR1 fixtures in %s order',
    (order) => {
      const { subscriber, state, availability, last } = setup();
      if (order === 'state-first') {
        state();
        expect(last().availability).toBe('unknown');
        availability();
      } else {
        availability();
        expect(last().availability).toBe('unknown');
        state();
      }
      expect(last()).toMatchObject({
        deviceId: 'desktop',
        availability: 'online',
        freshness: 'fresh',
        observedAt: NOW,
        sequence: 1,
        observed: {
          networkOnline: true,
          locked: false,
          idle: false,
          activeApplication: {
            id: 'org.kde.konsole',
            resourceClass: 'konsole',
          },
          fullscreen: false,
          audio: { playing: false },
          media: [],
        },
        activity: {
          classification: 'desktop',
          source: 'desktop-agent',
          basis: 'active_application',
        },
      });
      subscriber.send(
        'state',
        Buffer.from(
          JSON.stringify({ ...fixture('state-unknown'), sequence: 2 }),
        ),
      );
      expect(last().availability).toBe('online');
      expect(last().observed).toEqual(unknownComputerReadings());
      expect(last().activity.classification).toBe('unknown');
    },
  );

  it('normalizes lock, idle, fullscreen, PipeWire and MPRIS independently of inference', () => {
    const { state, availability, last } = setup();
    availability();
    const observations = {
      network_online: false,
      locked: true,
      idle: true,
      active_application: {
        app_id: 'org.kde.konsole',
        resource_class: 'konsole',
        fullscreen: true,
      },
      audio: { playing: true, applications: ['Firefox'], roles: ['Video'] },
      media: [
        {
          player: 'org.mpris.MediaPlayer2.firefox',
          identity: 'Firefox',
          desktop_entry: null,
          playback_status: 'Playing',
          title: '<img src=x onerror=alert(1)>',
          artists: ['Artist'],
          album: null,
          content_type: 'video',
        },
      ],
    };
    state({
      observations,
      inference: { activity: 'video', basis: 'mpris_content_type' },
    });
    expect(last()).toMatchObject({
      availability: 'online',
      observed: {
        networkOnline: false,
        locked: true,
        idle: true,
        fullscreen: true,
        audio: { playing: true },
        media: [
          {
            playback: 'playing',
            artists: ['Artist'],
            title: '<img src=x onerror=alert(1)>',
          },
        ],
      },
      activity: { classification: 'video' },
    });
    state({
      sequence: 2,
      observations: {
        ...observations,
        media: [{ ...observations.media[0], playback_status: null }],
      },
    });
    expect(last().observed.media?.[0]?.playback).toBe('unknown');
    state({
      sequence: 3,
      observations: {
        ...observations,
        media: [{ ...observations.media[0], playback_status: 'Paused' }],
      },
    });
    expect(last().observed.media?.[0]?.playback).toBe('paused');
    state({
      sequence: 4,
      observations: {
        ...observations,
        media: [{ ...observations.media[0], playback_status: 'Stopped' }],
      },
    });
    expect(last().observed.media?.[0]?.playback).toBe('stopped');
  });

  it('requires a live state after retained startup and every broker reconnect', () => {
    const { adapter, clock, state, availability, live, last, observations } =
      setup();
    availability();
    state({}, true);
    expect(last()).toMatchObject({
      availability: 'unknown',
      reason: 'retained',
      observed: unknownComputerReadings(),
    });
    state();
    expect(last().availability).toBe('online');
    adapter.setBrokerConnected(false);
    expect(last()).toMatchObject({
      reason: 'broker_disconnected',
      availability: 'unknown',
      observed: unknownComputerReadings(),
    });
    expect(clock.pendingTimers()).toBe(0);
    const count = observations.length;
    live();
    expect(observations).toHaveLength(count);
    adapter.setBrokerConnected(true);
    availability();
    state({ sequence: 2 }, true);
    expect(last().availability).toBe('unknown');
    state();
    expect(last().availability).toBe('unknown'); // QoS duplicate from old connection
    state({ sequence: 2, reason: 'reconnect' });
    expect(last()).toMatchObject({ availability: 'online', sequence: 2 });
  });

  it('expires exactly at the freshness deadline without a heartbeat; duplicates do not extend it', () => {
    const { clock, state, live, last, observations } = setup();
    live();
    clock.advanceBy(4_999);
    const count = observations.length;
    state();
    expect(observations).toHaveLength(count);
    expect(last().availability).toBe('online');
    clock.advanceBy(1);
    expect(last()).toMatchObject({
      availability: 'unknown',
      freshness: 'stale',
      reason: 'stale',
      observed: unknownComputerReadings(),
      activity: { classification: 'unknown' },
    });
    state({ sequence: 2, reason: 'heartbeat' });
    expect(last()).toMatchObject({ availability: 'online', sequence: 2 });
  });

  it('does not extend an existing live snapshot when retained packets are replayed', () => {
    const { clock, state, last, live } = setup();
    live();
    clock.advanceBy(4_000);
    state({ sequence: 50 }, true);
    expect(last().sequence).toBe(1);
    clock.advanceBy(1_000);
    expect(last().reason).toBe('stale');
    state({ sequence: 2 });
    expect(last().availability).toBe('online');
  });

  it('rejects delayed, future and out-of-order states using source time and session sequence', () => {
    const { clock, state, availability, last } = setup();
    availability();
    state({ timestamp_ms: NOW - 5_000 });
    expect(last().reason).toBe('stale');
    state({ sequence: 2, timestamp_ms: NOW + 5_001 });
    expect(last().reason).toBe('malformed');
    state({ sequence: 3, timestamp_ms: NOW - 4_000 });
    expect(last().availability).toBe('online');
    clock.advanceBy(1_000);
    expect(last().reason).toBe('stale');
    state({ sequence: 2 });
    expect(last().reason).toBe('stale');
    state({ sequence: 4 });
    expect(last().availability).toBe('online');
  });

  it.each(['state-first', 'availability-first'])(
    'recovers from offline in the same process session in %s order',
    (order) => {
      const { live, state, availability, last } = setup();
      live();
      availability('offline');
      expect(last()).toMatchObject({
        availability: 'offline',
        reason: 'offline',
        observed: unknownComputerReadings(),
      });
      state(); // duplicate from before the outage cannot restore liveness
      expect(last().availability).toBe('offline');
      if (order === 'state-first') {
        state({ sequence: 2, reason: 'reconnect' });
        expect(last()).toMatchObject({
          availability: 'offline',
          observed: unknownComputerReadings(),
        });
        availability();
      } else {
        availability();
        expect(last().availability).toBe('unknown');
        state({ sequence: 2, reason: 'reconnect' });
      }
      expect(last()).toMatchObject({
        availability: 'online',
        freshness: 'fresh',
        sequence: 2,
      });
    },
  );

  it('does not promote an expired candidate when online availability arrives late', () => {
    const { live, state, availability, clock, last } = setup();
    live();
    availability('offline');
    state({ sequence: 2, reason: 'reconnect' });
    clock.advanceBy(5_000);
    availability();
    expect(last()).toMatchObject({
      availability: 'unknown',
      observed: unknownComputerReadings(),
    });
    state({ sequence: 3 });
    expect(last().availability).toBe('online');
  });

  it.each(['state-first', 'availability-first'])(
    'handles process restarts and old-session LWT/events in %s order',
    (order) => {
      const { live, state, availability, event, last } = setup();
      live();
      if (order === 'state-first') {
        state({ session_id: NEXT_SESSION });
        availability('online', NEXT_SESSION);
      } else {
        availability('online', NEXT_SESSION);
        state({ session_id: NEXT_SESSION });
      }
      expect(last()).toMatchObject({
        availability: 'online',
        sessionId: NEXT_SESSION,
        sequence: 1,
      });
      availability('offline', SESSION);
      availability('online', SESSION);
      state({ sequence: 90 });
      event({ sequence: 90 });
      expect(last()).toMatchObject({
        availability: 'online',
        sessionId: NEXT_SESSION,
        sequence: 1,
        lastEvent: null,
      });
    },
  );

  it('preserves a new-session candidate across the previous session Last Will', () => {
    const { live, state, availability, last } = setup();
    live();
    state({ session_id: NEXT_SESSION, reason: 'reconnect' });
    expect(last().availability).toBe('unknown');
    availability('offline', SESSION);
    expect(last()).toMatchObject({
      availability: 'offline',
      observed: unknownComputerReadings(),
    });
    availability('online', NEXT_SESSION);
    expect(last()).toMatchObject({
      availability: 'online',
      freshness: 'fresh',
      sessionId: NEXT_SESSION,
      sequence: 1,
    });
  });

  it('does not extend a pending new-session snapshot across an old Last Will', () => {
    const { live, state, availability, clock, last } = setup();
    live();
    state({ session_id: NEXT_SESSION });
    clock.advanceBy(4_000);
    availability('offline', SESSION);
    expect(last().availability).toBe('offline');
    clock.advanceBy(1_000);
    availability('online', NEXT_SESSION);
    expect(last()).toMatchObject({
      availability: 'unknown',
      observed: unknownComputerReadings(),
    });
    state({ session_id: NEXT_SESSION, sequence: 2 });
    expect(last().availability).toBe('online');
  });

  it('does not let retained state from another session satisfy online availability', () => {
    const { state, availability, last } = setup();
    state({}, true);
    availability('online', NEXT_SESSION);
    expect(last().availability).toBe('unknown');
    state({ session_id: NEXT_SESSION });
    expect(last().availability).toBe('online');
  });

  it('validates events without treating them as snapshots or heartbeat evidence', () => {
    const { event, live, state, clock, last, observations, availability } =
      setup();
    event();
    expect(last().lastEvent).toBeNull();
    live();
    event({}, true);
    event({ schema_version: 2 });
    event({ type: 'lock' });
    event({ device_id: 'other' });
    event({ session_id: NEXT_SESSION });
    event({ timestamp_ms: NOW + 5_001 });
    expect(last().lastEvent).toBeNull();
    clock.advanceBy(4_000);
    event();
    expect(last()).toMatchObject({
      sequence: 1,
      lastEvent: {
        type: 'state_changed',
        sequence: 2,
        occurredAt: NOW + 4_000,
      },
    });
    const count = observations.length;
    event();
    expect(observations).toHaveLength(count);
    clock.advanceBy(1_000);
    expect(last().reason).toBe('stale');
    event({ sequence: 3 });
    expect(last().availability).toBe('unknown');
    state({ sequence: 4 });
    event({ sequence: 3 });
    expect(last().lastEvent?.sequence).toBe(3);
    availability('offline');
    expect(last().lastEvent).toBeNull();
  });

  it.each([
    ['invalid JSON', '{'],
    ['invalid UTF-8', new Uint8Array([0xff])],
    ['non-text', { schema_version: 1 }],
    ['oversized', ' '.repeat(262_145)],
    ['null', 'null'],
    ['array', '[]'],
    ['version', JSON.stringify({ ...fixture('state'), schema_version: 2 })],
    [
      'device mismatch',
      JSON.stringify({ ...fixture('state'), device_id: 'other' }),
    ],
    ['session', JSON.stringify({ ...fixture('state'), session_id: 'session' })],
    ['sequence', JSON.stringify({ ...fixture('state'), sequence: 0 })],
    [
      'unsafe sequence',
      JSON.stringify({
        ...fixture('state'),
        sequence: Number.MAX_SAFE_INTEGER + 1,
      }),
    ],
    [
      'negative timestamp',
      JSON.stringify({ ...fixture('state'), timestamp_ms: -1 }),
    ],
    [
      'missing observation',
      JSON.stringify({ ...fixture('state'), observations: { locked: false } }),
    ],
    [
      'string boolean',
      JSON.stringify({
        ...fixture('state'),
        observations: {
          ...(fixture('state-unknown')['observations'] as object),
          locked: 'false',
        },
      }),
    ],
    [
      'bad inference',
      JSON.stringify({
        ...fixture('state'),
        inference: { activity: 'work', basis: 'guess' },
      }),
    ],
    [
      'long string',
      JSON.stringify({
        ...fixture('state'),
        observations: {
          ...(fixture('state-unknown')['observations'] as object),
          active_application: {
            app_id: 'a'.repeat(513),
            resource_class: 'app',
            fullscreen: false,
          },
        },
      }),
    ],
  ])('fails to unknown on malformed state: %s', (_label, payload) => {
    const { live, subscriber, last, clock, state } = setup();
    live();
    subscriber.send('state', payload);
    expect(last()).toMatchObject({
      availability: 'unknown',
      reason: 'malformed',
      observed: unknownComputerReadings(),
      activity: { classification: 'unknown' },
    });
    expect(clock.pendingTimers()).toBe(0);
    state({ sequence: 2 });
    expect(last().availability).toBe('online');
  });

  it('invalidates malformed availability but ignores malformed events', () => {
    const { live, subscriber, last, observations, availability, state } =
      setup();
    live();
    const count = observations.length;
    subscriber.send('events', '{');
    expect(observations).toHaveLength(count);
    subscriber.send('availability', 'online', true);
    expect(last()).toMatchObject({
      reason: 'malformed',
      availability: 'unknown',
    });
    state({ sequence: 2 });
    expect(last().availability).toBe('unknown');
    availability();
    expect(last().availability).toBe('online');
  });

  it('accepts additive v1 fields but rejects unsupported version', () => {
    const { state, availability, last } = setup();
    availability();
    state({ extension: 'ignored' });
    expect(last().availability).toBe('online');
    state({ sequence: 2, schema_version: 2 });
    expect(last().reason).toBe('malformed');
  });

  it('preserves retired-session protection across a broker disconnect and process restart', () => {
    const { adapter, live, availability, state, last } = setup();
    live();
    adapter.setBrokerConnected(false);
    adapter.setBrokerConnected(true);
    availability('online', NEXT_SESSION);
    state({ session_id: NEXT_SESSION });
    availability('online', SESSION);
    availability('offline', SESSION);
    state({ sequence: 2 });
    expect(last()).toMatchObject({
      availability: 'online',
      sessionId: NEXT_SESSION,
      sequence: 1,
    });
  });

  it('expires on monotonic elapsed time even when the wall clock moves backward', () => {
    const baseClock = new FakeClock(NOW);
    let offset = 0;
    const clock = {
      now: () => baseClock.now() + offset,
      monotonicNow: () => baseClock.monotonicNow(),
      setTimeout: baseClock.setTimeout.bind(baseClock),
      clearTimeout: baseClock.clearTimeout.bind(baseClock),
    };
    const subscriber = new Subscriber();
    const received: ComputerObservation[] = [];
    const adapter = new ComputerMqttAdapter(
      subscriber,
      (observation) => received.push(observation),
      { deviceId: 'desktop', maxAgeMs: 5_000, clock },
    );
    adapter.start();
    adapter.setBrokerConnected(true);
    subscriber.send(
      'availability',
      JSON.stringify(fixture('availability-online')),
      true,
    );
    subscriber.send('state', JSON.stringify(fixture('state')));
    expect(received.at(-1)?.availability).toBe('online');
    offset = -3_600_000;
    baseClock.advanceBy(5_000);
    expect(received.at(-1)).toMatchObject({
      availability: 'unknown',
      reason: 'stale',
    });
    adapter.stop();
  });

  it('isolates emitted nested readings from the adapter snapshot', () => {
    const { live, last, event } = setup();
    live();
    last().observed.audio!.applications.push('caller mutation');
    event();
    expect(last().observed.audio!.applications).toEqual([]);
  });

  it('rolls back partial subscriptions on startup failure and accepts a custom prefix', () => {
    let unsubscribed = 0;
    let subscriptions = 0;
    const adapter = new ComputerMqttAdapter(
      {
        subscribe() {
          if (++subscriptions === 2) throw new Error('subscribe');
          return () => {
            unsubscribed++;
          };
        },
      },
      () => {},
      { deviceId: 'desktop', baseTopic: 'custom/computers/' },
    );
    expect(() => adapter.start()).toThrow('subscribe');
    expect(unsubscribed).toBe(1);
    for (const options of [
      { deviceId: '../invalid' },
      { deviceId: 'desktop', baseTopic: 'lugn/+' },
      { deviceId: 'desktop', baseTopic: '/' },
      { deviceId: 'desktop', maxAgeMs: 0 },
    ]) {
      expect(
        () => new ComputerMqttAdapter(new Subscriber(), () => {}, options),
      ).toThrow();
    }
  });
});
