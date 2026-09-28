import { z } from 'zod';
import type { Clock } from '../core/clock.js';

const HomePresenceStateSchema = z.enum(['home', 'away', 'unknown']);
export type HomePresenceState = z.infer<typeof HomePresenceStateSchema>;

export const HomeAssistantHomePresenceConfigSchema = z
  .object({
    entity: z
      .string()
      .regex(/^(person|device_tracker)\.[a-z0-9_]+$/)
      .default('device_tracker.lustigkurre'),
  })
  .strict();
export type HomeAssistantHomePresenceConfig = z.infer<
  typeof HomeAssistantHomePresenceConfigSchema
>;

const StateSchema = z.object({
  entity_id: z.string(),
  state: z.string(),
  last_updated: z.string().optional(),
});
const EventDataSchema = z.object({
  entity_id: z.string(),
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

/** Normalizes a configured Home Assistant person or device tracker. */
export class HomeAssistantHomePresenceAdapter {
  readonly entity: string;
  private current: { state: HomePresenceState; observedAt: number } = {
    state: 'unknown',
    observedAt: 0,
  };

  constructor(
    config: HomeAssistantHomePresenceConfig,
    private readonly clock: Clock,
    private readonly onChange: (
      state: HomePresenceState,
      observedAt: number,
    ) => void,
  ) {
    this.entity = HomeAssistantHomePresenceConfigSchema.parse(config).entity;
  }

  acceptState(payload: unknown): boolean {
    const result = StateSchema.safeParse(payload);
    if (!result.success || result.data.entity_id !== this.entity) return false;
    const state = normalizeHomeState(result.data.state);
    const observedAt =
      parseObservationTime(result.data.last_updated) ?? this.clock.now();
    this.current = { state, observedAt };
    this.onChange(state, observedAt);
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
    if (!data.success || data.data.entity_id !== this.entity) return false;
    if (data.data.new_state && data.data.new_state.entity_id !== this.entity)
      return false;
    return this.acceptState(
      data.data.new_state ?? { entity_id: this.entity, state: 'unknown' },
    );
  }

  snapshot(): { state: HomePresenceState; observedAt: number | null } {
    return {
      state: this.current.state,
      observedAt: this.current.observedAt || null,
    };
  }
}

function normalizeHomeState(value: string): HomePresenceState {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'home') return 'home';
  if (
    normalized === 'unknown' ||
    normalized === 'unavailable' ||
    normalized.length === 0
  )
    return 'unknown';
  return 'away';
}

function parseObservationTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
