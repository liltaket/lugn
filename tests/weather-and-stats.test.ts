import { describe, expect, it } from 'vitest';
import {
  fetchDailyForecast,
  HomeAssistantWeatherAdapter,
  HomeAssistantWeatherConfigSchema,
} from '../src/adapters/home-assistant-weather.js';
import {
  COMPUTER_STATS_MAX_AGE_MS,
  ComputerStatsMqttAdapter,
} from '../src/adapters/computer-stats-mqtt.js';
import { FakeClock } from '../src/core/clock.js';

const NOW = Date.parse('2026-11-24T21:00:00+01:00');

describe('weather from Home Assistant', () => {
  const config = HomeAssistantWeatherConfigSchema.parse({
    entity: 'weather.home',
  });

  it('reads the weather entity and the sun, converting units', () => {
    const adapter = new HomeAssistantWeatherAdapter(config, new FakeClock(NOW));
    adapter.acceptState({
      entity_id: 'weather.home',
      state: 'cloudy',
      last_updated: '2026-11-24T19:55:00+00:00',
      attributes: {
        temperature: 3.5,
        temperature_unit: '°C',
        humidity: 88,
        wind_speed: 18,
        wind_speed_unit: 'km/h',
      },
    });
    adapter.acceptState({
      entity_id: 'sun.sun',
      state: 'below_horizon',
      attributes: {
        next_rising: '2026-11-25T07:02:03+00:00',
        next_setting: '2026-11-25T14:05:00+00:00',
        elevation: -20.5,
      },
    });
    expect(adapter.snapshot()).toMatchObject({
      condition: 'cloudy',
      temperature: 3.5,
      humidity: 88,
      windSpeed: 5,
      sun: {
        nextRising: Date.parse('2026-11-25T07:02:03Z'),
        elevation: -20.5,
      },
      forecast: { today: null, tomorrow: null },
    });
  });

  it('converts Fahrenheit and forgets an entity that becomes unavailable', () => {
    const adapter = new HomeAssistantWeatherAdapter(config, new FakeClock(NOW));
    adapter.acceptState({
      entity_id: 'weather.home',
      state: 'sunny',
      attributes: { temperature: 50, temperature_unit: '°F' },
    });
    expect(adapter.snapshot().temperature).toBe(10);
    adapter.acceptStateChangedEvent({
      type: 'event',
      event: {
        event_type: 'state_changed',
        data: {
          entity_id: 'weather.home',
          new_state: { entity_id: 'weather.home', state: 'unavailable' },
        },
      },
    });
    expect(adapter.snapshot()).toMatchObject({
      condition: null,
      temperature: null,
    });
    // Other entities are not its business.
    expect(adapter.acceptState({ entity_id: 'light.lamp', state: 'on' })).toBe(
      false,
    );
  });

  it('picks today and tomorrow out of the daily forecast', () => {
    const adapter = new HomeAssistantWeatherAdapter(config, new FakeClock(NOW));
    adapter.acceptForecast([
      {
        datetime: '2026-11-24T00:00:00+01:00',
        condition: 'rainy',
        temperature: 6,
        templow: 1,
        precipitation_probability: 70,
        precipitation: 2.4,
      },
      {
        datetime: '2026-11-25T00:00:00+01:00',
        condition: 'cloudy',
        temperature: 4,
        templow: 0,
      },
      'garbage',
    ]);
    const { forecast } = adapter.snapshot();
    expect(forecast.today).toMatchObject({
      date: '2026-11-24',
      high: 6,
      low: 1,
      precipitationProbability: 70,
    });
    expect(forecast.tomorrow).toMatchObject({
      date: '2026-11-25',
      condition: 'cloudy',
      precipitationProbability: null,
    });
  });

  it('asks Home Assistant for the forecast and reads the answer', async () => {
    const calls: string[] = [];
    const fetcher = (async (url: string) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          service_response: {
            'weather.home': { forecast: [{ datetime: 'x' }] },
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    expect(
      await fetchDailyForecast('http://ha', 'token', 'weather.home', fetcher),
    ).toEqual([{ datetime: 'x' }]);
    expect(calls[0]).toContain('/api/services/weather/get_forecasts');
    const broken = (async () => new Response('no', { status: 500 })) as never;
    expect(
      await fetchDailyForecast('http://ha', 'token', 'weather.x', broken),
    ).toBeNull();
  });
});

describe('computer statistics over MQTT', () => {
  function setup() {
    const clock = new FakeClock(NOW);
    let deliver:
      | ((topic: string, payload: unknown, m: { retain: boolean }) => void)
      | undefined;
    const topics: string[] = [];
    const subscriber = {
      subscribe: (
        topic: string,
        _options: unknown,
        handler: typeof deliver,
      ) => {
        topics.push(topic);
        deliver = handler;
        return () => undefined;
      },
    };
    const adapter = new ComputerStatsMqttAdapter(subscriber as never, {
      deviceId: 'desktop',
      clock,
    });
    adapter.start();
    adapter.setBrokerConnected(true);
    const message = (overrides: Record<string, unknown> = {}) =>
      JSON.stringify({
        schema_version: 1,
        device_id: 'desktop',
        timestamp_ms: clock.now(),
        cpu: { percent: 38.2, temp_c: 52, ghz: 4.6, cores: [10, 20, 90] },
        gpu: { percent: 44, vram_used_mb: 7400, vram_total_mb: 16384 },
        memory: {
          ram_used_mb: 22000,
          ram_total_mb: 64000,
          swap_used_mb: 1200,
          swap_total_mb: 8192,
        },
        network: { iface: 'eth0', down_mbit: 142, up_mbit: 28 },
        disk: {
          label: 'nvme0n1',
          used_gb: 1180,
          total_gb: 2000,
          read_mbs: 84,
          write_mbs: 12,
        },
        processes: [{ name: 'firefox', cpu_percent: 9, ram_mb: 6200 }],
        ...overrides,
      });
    return {
      clock,
      adapter,
      topics,
      send: (payload: string, retain = false) =>
        deliver?.('lugn/computers/desktop/stats', payload, { retain }),
      message,
    };
  }

  it('subscribes to the computer’s stats topic and reports display-ready numbers', () => {
    const t = setup();
    expect(t.topics).toEqual(['lugn/computers/desktop/stats']);
    expect(t.adapter.snapshot()).toBeNull();
    t.send(t.message());
    expect(t.adapter.snapshot()).toMatchObject({
      cpu: { percent: 38.2, tempC: 52, cores: [10, 20, 90], history: [38.2] },
      gpu: { percent: 44, vramTotalMb: 16384 },
      memory: { ramTotalMb: 64000 },
      network: { downMbit: 142, downHistory: [142] },
      disk: { label: 'nvme0n1' },
      processes: [{ name: 'firefox', cpuPercent: 9, ramMb: 6200 }],
    });
    t.clock.advanceBy(2000);
    t.send(t.message({ cpu: { percent: 50, cores: [] } }));
    expect(t.adapter.snapshot()?.cpu.history).toEqual([38.2, 50]);
  });

  it('shows nothing that is old, retained, malformed or from another device', () => {
    const t = setup();
    t.send(t.message(), true);
    expect(t.adapter.snapshot()).toBeNull();
    t.send('{"nonsense":true}');
    t.send(t.message({ device_id: 'other' }));
    t.send(t.message({ cpu: { percent: 900, cores: [] } }));
    expect(t.adapter.snapshot()).toBeNull();
    t.send(t.message());
    expect(t.adapter.snapshot()).not.toBeNull();
    t.clock.advanceBy(COMPUTER_STATS_MAX_AGE_MS + 1);
    expect(t.adapter.snapshot()).toBeNull();
  });

  it('forgets everything when the broker drops', () => {
    const t = setup();
    t.send(t.message());
    t.adapter.setBrokerConnected(false);
    expect(t.adapter.snapshot()).toBeNull();
    t.adapter.setBrokerConnected(true);
    t.send(t.message());
    expect(t.adapter.snapshot()?.cpu.history).toHaveLength(1);
  });
});
