import { z } from 'zod';
import type { Clock, TimerHandle } from '../core/clock.js';
import {
  classifyPower,
  unknownDisplayPowerEvidence,
  type DisplayPowerEvidence,
  type PowerClass,
  type PowerSensorThresholds,
} from '../core/display-power.js';

const StateSchema = z.object({
  entity_id: z.string(),
  state: z.union([z.string(), z.number()]),
  last_updated: z.string().optional(),
  attributes: z
    .object({ unit_of_measurement: z.string().optional() })
    .passthrough()
    .optional(),
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

/**
 * Turns a Home Assistant power sensor (a smart plug between the wall and the
 * monitor) into display-power evidence. The plug is a measuring device only;
 * Lugn never switches its relay.
 *
 * A changed class is reported only after it has stayed put for `settleMs`.
 * The first usable reading after unknown is trusted immediately. Unavailable
 * or non-numeric states become unknown immediately, and a Home Assistant
 * disconnect forgets the reading until the next seed.
 */
export class HomeAssistantPowerSensorAdapter {
  private evidence: DisplayPowerEvidence = unknownDisplayPowerEvidence();
  private pending:
    { state: PowerClass; watts: number; timer: TimerHandle } | undefined;
  private lastUpdated: number | undefined;
  private disposed = false;

  constructor(
    private readonly options: {
      entityId: string;
      thresholds: PowerSensorThresholds;
      clock: Clock;
      onChange?: () => void;
    },
  ) {}

  get entityId(): string {
    return this.options.entityId;
  }

  getEvidence(): DisplayPowerEvidence {
    return { ...this.evidence };
  }

  acceptState(payload: unknown): boolean {
    const parsed = StateSchema.safeParse(payload);
    if (!parsed.success || parsed.data.entity_id !== this.options.entityId)
      return false;
    if (this.disposed) return true;
    const state = parsed.data;
    const updated = Date.parse(state.last_updated ?? '');
    if (Number.isFinite(updated)) {
      if (this.lastUpdated !== undefined && updated < this.lastUpdated)
        return true;
      this.lastUpdated = updated;
    }
    const observedAt = Number.isFinite(updated)
      ? updated
      : this.options.clock.now();
    const watts = toWatts(state.state, state.attributes?.unit_of_measurement);
    const raw = classifyPower(
      watts,
      this.options.thresholds,
      this.evidence.state,
    );
    if (watts === null || raw === 'unknown') {
      this.clearPending();
      this.commit('unknown', watts, observedAt);
      return true;
    }
    if (raw === this.evidence.state) {
      // Same class: keep it, refresh the reading, and abandon any pending flip.
      this.clearPending();
      this.commit(raw, watts, observedAt);
      return true;
    }
    if (this.evidence.state === 'unknown') {
      // First usable reading (startup, seed or recovery): nothing to debounce.
      this.clearPending();
      this.commit(raw, watts, observedAt);
      return true;
    }
    this.promote(raw, watts, observedAt);
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
    if (!data.success || data.data.entity_id !== this.options.entityId)
      return false;
    return this.acceptState(
      data.data.new_state ?? {
        entity_id: data.data.entity_id,
        state: 'unavailable',
      },
    );
  }

  /** Forget the reading, for example when Home Assistant disconnects. */
  invalidate(): void {
    this.clearPending();
    this.lastUpdated = undefined;
    if (this.evidence.state === 'unknown' && this.evidence.watts === null)
      return;
    this.evidence = unknownDisplayPowerEvidence();
    this.options.onChange?.();
  }

  dispose(): void {
    this.disposed = true;
    this.clearPending();
  }

  private promote(state: PowerClass, watts: number, observedAt: number): void {
    const { settleMs } = this.options.thresholds;
    if (this.pending?.state === state) {
      // Still the same unsettled class; the timer keeps its original start.
      this.pending.watts = watts;
      return;
    }
    this.clearPending();
    if (settleMs === 0) {
      this.commit(state, watts, observedAt);
      return;
    }
    const timer = this.options.clock.setTimeout(() => {
      const pending = this.pending;
      this.pending = undefined;
      if (!pending || this.disposed) return;
      this.commit(pending.state, pending.watts, this.options.clock.now());
    }, settleMs);
    this.pending = { state, watts, timer };
  }

  private commit(
    state: PowerClass,
    watts: number | null,
    observedAt: number,
  ): void {
    const next: DisplayPowerEvidence = {
      source: 'power-sensor',
      state,
      watts,
      observedAt,
    };
    const changed =
      next.state !== this.evidence.state || next.watts !== this.evidence.watts;
    this.evidence = next;
    if (changed) this.options.onChange?.();
  }

  private clearPending(): void {
    if (this.pending) this.options.clock.clearTimeout(this.pending.timer);
    this.pending = undefined;
  }
}

function toWatts(
  state: string | number,
  unit: string | undefined,
): number | null {
  const value = typeof state === 'number' ? state : parseNumber(state);
  if (value === null || !Number.isFinite(value)) return null;
  switch (unit?.trim()) {
    case undefined:
    case '':
    case 'W':
      return value;
    case 'kW':
      return value * 1_000;
    case 'mW':
      return value / 1_000;
    default:
      // An energy or unknown unit must never be mistaken for power.
      return null;
  }
}

function parseNumber(state: string): number | null {
  const normalized = state.trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized))
    return null;
  return Number(normalized);
}
