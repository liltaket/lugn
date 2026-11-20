import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { HomeAssistantMusicAdapter } from '../src/adapters/home-assistant-music.js';
import { ComputerMqttAdapter } from '../src/adapters/computer-mqtt.js';
import { FakeClock } from '../src/core/clock.js';
import {
  ComputerObservationSchema,
  type ComputerObservation,
} from '../src/core/computer.js';
import type { MusicObservation } from '../src/adapters/simulated-music.js';
import type { PresenceMqttSubscriber } from '../src/runtime/mqttjs-subscriber.js';

function haAdapter() {
  const adapter = new HomeAssistantMusicAdapter(
    {
      baseUrl: 'http://ha.test',
      token: 'private',
      entities: { 'music.room': { entityId: 'media_player.room' } },
    },
    vi.fn(),
    new FakeClock(),
  );
  const seen: MusicObservation[] = [];
  adapter.subscribe((observation) => seen.push(observation));
  return { adapter, last: () => seen.at(-1)! };
}

describe('playback position for the Hub progress ring', () => {
  it('reads a Home Assistant position sample only together with a real duration', () => {
    const { adapter, last } = haAdapter();
    adapter.acceptState({
      entity_id: 'media_player.room',
      state: 'playing',
      attributes: {
        media_title: 'Song',
        media_position: 61.5,
        media_duration: 200,
        media_position_updated_at: '2026-11-20T13:45:12.000+00:00',
      },
    });
    expect(last().values).toMatchObject({
      positionSeconds: 61.5,
      durationSeconds: 200,
      positionUpdatedAt: Date.parse('2026-11-20T13:45:12.000Z'),
    });
    // The Optical/PC input reports a position without any duration.
    adapter.acceptState({
      entity_id: 'media_player.room',
      state: 'playing',
      attributes: {
        media_position: 154,
        media_duration: null,
        media_position_updated_at: '2026-11-20T13:45:12.706054+00:00',
      },
    });
    expect(last().values.positionSeconds).toBeUndefined();
    expect(last().values.durationSeconds).toBeUndefined();
    adapter.acceptState({
      entity_id: 'media_player.room',
      state: 'playing',
      attributes: {
        media_position: 500,
        media_duration: 200,
        media_position_updated_at: 'not a time',
      },
    });
    expect(last().values.positionSeconds).toBeUndefined();
  });
});

type Handler = Parameters<PresenceMqttSubscriber['subscribe']>[2];
class Subscriber implements PresenceMqttSubscriber {
  readonly handlers = new Map<string, Handler>();
  subscribe(topic: string, _options: { qos: 0 | 1 }, handler: Handler) {
    this.handlers.set(topic, handler);
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

describe('computer agent position', () => {
  it('maps MPRIS microseconds to seconds and drops incomplete or invalid samples', () => {
    const now = Number(fixture('state')['timestamp_ms']);
    const clock = new FakeClock(now);
    const subscriber = new Subscriber();
    const observations: ComputerObservation[] = [];
    const adapter = new ComputerMqttAdapter(
      subscriber,
      (observation) =>
        observations.push(ComputerObservationSchema.parse(observation)),
      { deviceId: 'desktop', maxAgeMs: 5_000, clock },
    );
    adapter.start();
    adapter.setBrokerConnected(true);
    subscriber.send(
      'availability',
      JSON.stringify({ ...fixture('availability-online'), status: 'online' }),
      true,
    );
    const media = {
      player: 'org.mpris.MediaPlayer2.firefox.instance_1_42',
      identity: 'Mozilla zen',
      desktop_entry: 'zen',
      playback_status: 'Playing',
      title: 'Video',
      artists: null,
      album: null,
      content_type: null,
    };
    const state = (sequence: number, extra: Record<string, unknown>) => {
      const base = fixture('state') as {
        observations: Record<string, unknown>;
      };
      subscriber.send(
        'state',
        JSON.stringify({
          ...base,
          sequence,
          timestamp_ms: clock.now(),
          observations: {
            ...base.observations,
            media: [{ ...media, ...extra }],
          },
        }),
      );
    };
    state(1, {
      position_us: 90_000_000,
      length_us: 600_000_000,
      position_at_ms: now - 500,
    });
    expect(observations.at(-1)!.observed.media?.[0]).toMatchObject({
      positionSeconds: 90,
      durationSeconds: 600,
      positionUpdatedAt: now - 500,
    });
    state(2, { position_us: 90_000_000, length_us: -1, position_at_ms: now });
    const invalid = observations.at(-1)!.observed.media?.[0];
    expect(invalid?.title).toBe('Video');
    expect(invalid?.durationSeconds).toBeUndefined();
    adapter.stop();
  });
});
