import { z } from 'zod';
import type { Clock } from '../core/clock.js';

const SensorEntityIdSchema = z.string().regex(/^sensor\.[a-z0-9_]+$/);

export const HomeAssistantEnvironmentMappingsSchema = z
  .object({
    temperature: SensorEntityIdSchema.default(
      'sensor.alpstuga_air_quality_monitor_temperatur',
    ),
    humidity: SensorEntityIdSchema.default(
      'sensor.alpstuga_air_quality_monitor_luftfuktighet',
    ),
    co2: SensorEntityIdSchema.default(
      'sensor.alpstuga_air_quality_monitor_koldioxid',
    ),
    pm25: SensorEntityIdSchema.default(
      'sensor.alpstuga_air_quality_monitor_pm25',
    ),
  })
  .strict()
  .superRefine((mappings, context) => {
    const entities = Object.values(mappings);
    if (new Set(entities).size !== entities.length)
      context.addIssue({
        code: 'custom',
        message: 'Each environment metric must map to a distinct sensor entity',
      });
  });

export type HomeAssistantEnvironmentMappings = z.infer<
  typeof HomeAssistantEnvironmentMappingsSchema
>;

const Metrics = ['temperature', 'humidity', 'co2', 'pm25'] as const;
export type EnvironmentMetric = (typeof Metrics)[number];

export type EnvironmentMetricSnapshot = {
  value: number | null;
  unit: string;
  observedAt: number | null;
};

export type EnvironmentSnapshot = Record<
  EnvironmentMetric,
  EnvironmentMetricSnapshot
>;

const MetricUnits: Record<EnvironmentMetric, string> = {
  temperature: '°C',
  humidity: '%',
  co2: 'ppm',
  pm25: 'µg/m³',
};

const StateSchema = z.object({
  entity_id: SensorEntityIdSchema,
  state: z.union([z.string(), z.number()]),
  last_updated: z.string().optional(),
});
const EventDataSchema = z.object({
  entity_id: SensorEntityIdSchema,
  new_state: StateSchema.nullable(),
});
const EventSchema = z.object({
  event_type: z.literal('state_changed'),
  data: EventDataSchema,
});
const EnvelopeSchema = z.object({
  type: z.literal('event'),
  event: EventSchema,
});

/** Observes configured Home Assistant air-quality and climate sensors. */
export class HomeAssistantEnvironmentAdapter {
  private readonly metricByEntity: ReadonlyMap<string, EnvironmentMetric>;
  private readonly observations = new Map<
    EnvironmentMetric,
    { value: number | null; observedAt: number }
  >();
  private readonly lastUpdatedByEntity = new Map<string, number>();

  constructor(
    mappings: HomeAssistantEnvironmentMappings,
    private readonly clock: Clock,
  ) {
    const parsed = HomeAssistantEnvironmentMappingsSchema.parse(mappings);
    this.metricByEntity = new Map(
      Object.entries(parsed).map(([metric, entityId]) => [
        entityId,
        metric as EnvironmentMetric,
      ]),
    );
  }

  acceptState(payload: unknown): boolean {
    const result = StateSchema.safeParse(payload);
    if (!result.success) return false;
    const metric = this.metricByEntity.get(result.data.entity_id);
    if (!metric) return false;
    const lastUpdated = parseObservationTime(result.data.last_updated);
    const previousUpdate = this.lastUpdatedByEntity.get(result.data.entity_id);
    if (
      lastUpdated !== undefined &&
      previousUpdate !== undefined &&
      lastUpdated < previousUpdate
    )
      return true;
    if (lastUpdated !== undefined)
      this.lastUpdatedByEntity.set(result.data.entity_id, lastUpdated);
    this.observations.set(metric, {
      value: normalizeNumericState(result.data.state),
      observedAt: lastUpdated ?? this.clock.now(),
    });
    return true;
  }

  acceptStateChangedEvent(payload: unknown): boolean {
    const envelope = EnvelopeSchema.safeParse(payload);
    const event = EventSchema.safeParse(payload);
    const data = EventDataSchema.safeParse(
      envelope.success
        ? envelope.data.event.data
        : event.success
          ? event.data.data
          : payload,
    );
    if (!data.success) return false;
    if (
      data.data.new_state &&
      data.data.new_state.entity_id !== data.data.entity_id
    )
      return false;
    return this.acceptState(
      data.data.new_state ?? {
        entity_id: data.data.entity_id,
        state: 'unavailable',
      },
    );
  }

  snapshot(): EnvironmentSnapshot {
    return Object.fromEntries(
      Metrics.map((metric) => {
        const observation = this.observations.get(metric);
        return [
          metric,
          {
            value: observation?.value ?? null,
            unit: MetricUnits[metric],
            observedAt: observation?.observedAt ?? null,
          },
        ];
      }),
    ) as EnvironmentSnapshot;
  }
}

function normalizeNumericState(state: string | number): number | null {
  if (typeof state === 'number') return Number.isFinite(state) ? state : null;
  const normalized = state.trim();
  if (
    normalized.length === 0 ||
    !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)
  )
    return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function parseObservationTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
