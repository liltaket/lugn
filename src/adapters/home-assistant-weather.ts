import { z } from 'zod';
import type { Clock } from '../core/clock.js';

export const HomeAssistantWeatherConfigSchema = z
  .object({
    /** The weather entity (an integration such as Met.no or SMHI). */
    entity: z.string().regex(/^weather\.[a-z0-9_]+$/),
    /** Home Assistant's sun entity, for sunrise and sunset. */
    sun: z
      .string()
      .regex(/^sun\.[a-z0-9_]+$/)
      .default('sun.sun'),
    /** How often the daily forecast is asked for. */
    forecastRefreshMinutes: z.number().int().min(5).max(720).default(30),
  })
  .strict();
export type HomeAssistantWeatherConfig = z.output<
  typeof HomeAssistantWeatherConfigSchema
>;

export type WeatherDay = {
  /** Stockholm calendar date, YYYY-MM-DD. */
  date: string;
  condition: string | null;
  high: number | null;
  low: number | null;
  /** 0-100, when the integration reports it. */
  precipitationProbability: number | null;
  /** Millimetres, when the integration reports it. */
  precipitation: number | null;
};

export type WeatherSnapshot = {
  /** Home Assistant's condition word (`cloudy`, `rainy`, `clear-night`, ...). */
  condition: string | null;
  /** °C. */
  temperature: number | null;
  humidity: number | null;
  /** m/s. */
  windSpeed: number | null;
  /** Epoch ms of the last observation. */
  observedAt: number | null;
  /** Today and tomorrow from the daily forecast, when it has been fetched. */
  forecast: { today: WeatherDay | null; tomorrow: WeatherDay | null };
  sun: {
    /** Epoch ms of the next sunrise / sunset. */
    nextRising: number | null;
    nextSetting: number | null;
    elevation: number | null;
  };
};

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
export const stockholmDay = (at: number): string => dayFormat.format(at);

function number(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function time(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toCelsius(value: number | null, unit: unknown): number | null {
  if (value === null) return null;
  return unit === '°F' ? Math.round(((value - 32) * 50) / 9) / 10 : value;
}

function toMetresPerSecond(value: number | null, unit: unknown): number | null {
  if (value === null) return null;
  switch (unit) {
    case 'km/h':
      return value / 3.6;
    case 'mph':
      return value * 0.44704;
    case 'kn':
      return value * 0.514444;
    default:
      return value;
  }
}

/** Observes Home Assistant's weather entity, its sun, and a daily forecast. */
export class HomeAssistantWeatherAdapter {
  private weather: Omit<WeatherSnapshot, 'forecast' | 'sun'> = {
    condition: null,
    temperature: null,
    humidity: null,
    windSpeed: null,
    observedAt: null,
  };
  private sun: WeatherSnapshot['sun'] = {
    nextRising: null,
    nextSetting: null,
    elevation: null,
  };
  private days: WeatherDay[] = [];

  constructor(
    private readonly config: HomeAssistantWeatherConfig,
    private readonly clock: Clock,
  ) {}

  /** A Home Assistant state object (`/api/states` or a state_changed new_state). */
  acceptState(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const state = value as Record<string, unknown>;
    const attributes =
      state['attributes'] && typeof state['attributes'] === 'object'
        ? (state['attributes'] as Record<string, unknown>)
        : {};
    const lost =
      state['state'] === 'unavailable' || state['state'] === 'unknown';
    if (state['entity_id'] === this.config.entity) {
      this.weather = lost
        ? {
            condition: null,
            temperature: null,
            humidity: null,
            windSpeed: null,
            observedAt: null,
          }
        : {
            condition:
              typeof state['state'] === 'string' ? state['state'] : null,
            temperature: toCelsius(
              number(attributes['temperature']),
              attributes['temperature_unit'],
            ),
            humidity: number(attributes['humidity']),
            windSpeed: toMetresPerSecond(
              number(attributes['wind_speed']),
              attributes['wind_speed_unit'],
            ),
            observedAt: time(state['last_updated']) ?? this.clock.now(),
          };
      return true;
    }
    if (state['entity_id'] === this.config.sun) {
      this.sun = lost
        ? { nextRising: null, nextSetting: null, elevation: null }
        : {
            nextRising: time(attributes['next_rising']),
            nextSetting: time(attributes['next_setting']),
            elevation: number(attributes['elevation']),
          };
      return true;
    }
    return false;
  }

  /** A state_changed event, bare or in a WebSocket frame. */
  acceptStateChangedEvent(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const envelope = value as Record<string, unknown>;
    const event = (envelope['event'] ?? envelope) as Record<string, unknown>;
    if (
      event['event_type'] !== 'state_changed' ||
      !event['data'] ||
      typeof event['data'] !== 'object'
    )
      return false;
    const data = event['data'] as Record<string, unknown>;
    if (
      data['entity_id'] !== this.config.entity &&
      data['entity_id'] !== this.config.sun
    )
      return false;
    return this.acceptState(
      data['new_state'] ?? {
        entity_id: data['entity_id'],
        state: 'unavailable',
      },
    );
  }

  /** The days of a daily forecast, as Home Assistant's `weather.get_forecasts` returns them. */
  acceptForecast(forecast: unknown): void {
    if (!Array.isArray(forecast)) return;
    const days: WeatherDay[] = [];
    for (const item of forecast) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const at = time(entry['datetime']);
      if (at === null) continue;
      days.push({
        date: stockholmDay(at),
        condition:
          typeof entry['condition'] === 'string' ? entry['condition'] : null,
        high: number(entry['temperature']),
        low: number(entry['templow']),
        precipitationProbability: number(entry['precipitation_probability']),
        precipitation: number(entry['precipitation']),
      });
    }
    this.days = days;
  }

  snapshot(): WeatherSnapshot {
    const now = this.clock.now();
    const today = stockholmDay(now);
    const tomorrow = stockholmDay(now + 24 * 60 * 60 * 1000);
    return {
      ...this.weather,
      forecast: {
        today: this.days.find((day) => day.date === today) ?? null,
        tomorrow: this.days.find((day) => day.date === tomorrow) ?? null,
      },
      sun: this.sun,
    };
  }
}

/**
 * Asks Home Assistant for the daily forecast (`weather.get_forecasts`, which
 * integrations since 2024 use instead of a forecast attribute). Returns the
 * forecast list, or null if Home Assistant cannot answer.
 */
export async function fetchDailyForecast(
  baseUrl: string,
  token: string,
  entity: string,
  fetcher: typeof fetch = fetch,
): Promise<unknown[] | null> {
  try {
    const response = await fetcher(
      `${baseUrl}/api/services/weather/get_forecasts?return_response`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ entity_id: entity, type: 'daily' }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const answer = (body as { service_response?: Record<string, unknown> })
      .service_response?.[entity] as { forecast?: unknown } | undefined;
    return Array.isArray(answer?.forecast) ? answer.forecast : null;
  } catch {
    return null;
  }
}
