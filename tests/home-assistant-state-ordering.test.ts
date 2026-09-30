import { describe, expect, it, vi } from 'vitest';
import { HomeAssistantEnvironmentAdapter } from '../src/adapters/home-assistant-environment.js';
import { HomeAssistantHomePresenceAdapter } from '../src/adapters/home-assistant-home-presence.js';
import { HomeAssistantMusicAdapter } from '../src/adapters/home-assistant-music.js';
import { HomeAssistantSwitchAdapter } from '../src/adapters/home-assistant-switch.js';
import { FakeClock } from '../src/core/clock.js';

const earlier = '2026-09-30T10:00:00.000Z';
const later = '2026-09-30T10:01:00.000Z';

describe('Home Assistant adapter state ordering', () => {
  it('does not publish a stale switch REST snapshot after a newer event', () => {
    const adapter = new HomeAssistantSwitchAdapter(
      {
        baseUrl: 'http://ha.local',
        token: 'token',
        entities: { 'switch.desk': 'switch.desk_power' },
      },
      fetch,
      new FakeClock(),
    );
    const listener = vi.fn();
    adapter.subscribe(listener);

    expect(
      adapter.acceptStateChangedEvent({
        event_type: 'state_changed',
        data: {
          entity_id: 'switch.desk_power',
          new_state: {
            entity_id: 'switch.desk_power',
            state: 'on',
            last_updated: later,
          },
        },
      }),
    ).toBe(true);
    expect(
      adapter.acceptState({
        entity_id: 'switch.desk_power',
        state: 'off',
        last_updated: earlier,
      }),
    ).toBe(true);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: true, available: true }),
    );
  });

  it('does not publish a stale music event after a newer REST snapshot', () => {
    const adapter = new HomeAssistantMusicAdapter(
      {
        baseUrl: 'http://ha.local',
        token: 'token',
        entities: {
          'music.room': { entityId: 'media_player.room', sources: [] },
        },
      },
      fetch,
      new FakeClock(),
    );
    const listener = vi.fn();
    adapter.subscribe(listener);

    expect(
      adapter.acceptState({
        entity_id: 'media_player.room',
        state: 'playing',
        last_updated: later,
      }),
    ).toBe(true);
    expect(
      adapter.acceptStateChangedEvent({
        event_type: 'state_changed',
        data: {
          entity_id: 'media_player.room',
          new_state: {
            entity_id: 'media_player.room',
            state: 'paused',
            last_updated: earlier,
          },
        },
      }),
    ).toBe(true);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        values: expect.objectContaining({ playback: 'playing' }),
      }),
    );
  });

  it('keeps the newest environmental sensor value when an older snapshot arrives', () => {
    const adapter = new HomeAssistantEnvironmentAdapter(
      {
        temperature: 'sensor.alpstuga_air_quality_monitor_temperatur',
        humidity: 'sensor.alpstuga_air_quality_monitor_luftfuktighet',
        co2: 'sensor.alpstuga_air_quality_monitor_koldioxid',
        pm25: 'sensor.alpstuga_air_quality_monitor_pm25',
      },
      new FakeClock(),
    );

    expect(
      adapter.acceptStateChangedEvent({
        event_type: 'state_changed',
        data: {
          entity_id: 'sensor.alpstuga_air_quality_monitor_temperatur',
          new_state: {
            entity_id: 'sensor.alpstuga_air_quality_monitor_temperatur',
            state: '22',
            last_updated: later,
          },
        },
      }),
    ).toBe(true);
    expect(
      adapter.acceptState({
        entity_id: 'sensor.alpstuga_air_quality_monitor_temperatur',
        state: '18',
        last_updated: earlier,
      }),
    ).toBe(true);

    expect(adapter.snapshot().temperature).toMatchObject({ value: 22 });
  });

  it('does not let an older presence event overwrite a newer REST snapshot', () => {
    const onChange = vi.fn();
    const adapter = new HomeAssistantHomePresenceAdapter(
      { entity: 'device_tracker.lustigkurre' },
      new FakeClock(),
      onChange,
    );

    expect(
      adapter.acceptState({
        entity_id: 'device_tracker.lustigkurre',
        state: 'home',
        last_updated: later,
      }),
    ).toBe(true);
    expect(
      adapter.acceptStateChangedEvent({
        event_type: 'state_changed',
        data: {
          entity_id: 'device_tracker.lustigkurre',
          new_state: {
            entity_id: 'device_tracker.lustigkurre',
            state: 'not_home',
            last_updated: earlier,
          },
        },
      }),
    ).toBe(true);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(adapter.snapshot().state).toBe('home');
  });
});
