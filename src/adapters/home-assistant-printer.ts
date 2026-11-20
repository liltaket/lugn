import { z } from 'zod';
import type { Clock } from '../core/clock.js';

/**
 * Optional 3D printer observed through the Bambu Lab Home Assistant
 * integration (ha-bambulab). Every entity id is derived from one device prefix,
 * e.g. `a1_0123456789abcde` for `sensor.a1_0123456789abcde_print_status`.
 * Lugn never presses the printer's print buttons; it only switches the
 * chamber light on request (see `chamberLightEntityId`).
 */
export const HomeAssistantPrinterConfigSchema = z
  .object({
    entityPrefix: z.string().regex(/^[a-z0-9_]{1,80}$/),
    /** Display name; defaults to the printer's own name sensor. */
    name: z.string().trim().min(1).max(40).optional(),
    /** How long a finished or failed print stays on the Hubs. */
    resultVisibleMinutes: z.number().int().min(0).max(240).default(20),
  })
  .strict();

export type HomeAssistantPrinterConfig = z.output<
  typeof HomeAssistantPrinterConfigSchema
>;

export type PrinterStatus =
  | 'preparing'
  | 'printing'
  | 'paused'
  | 'finished'
  | 'failed'
  | 'idle'
  | 'offline';

export type PrinterTemperature = { current: number; target: number | null };

/** What a Hub needs to draw the print as a live activity. */
export type PrinterActivitySnapshot = {
  name: string;
  status: PrinterStatus;
  /** Raw ha-bambulab stage, e.g. `heatbed_preheating`; the Hub words it. */
  stage: string | null;
  /** 0–100 */
  progress: number | null;
  remainingMinutes: number | null;
  /** Estimated finish, from the latest remaining-time observation. */
  endsAt: number | null;
  layer: number | null;
  totalLayers: number | null;
  task: string | null;
  nozzle: PrinterTemperature | null;
  bed: PrinterTemperature | null;
  /** When the print status last changed (the start of a result). */
  statusSince: number | null;
  /** Changes whenever Home Assistant publishes a new cover image. */
  coverRevision: string | null;
  /** Chamber light; null while Home Assistant does not report on or off. */
  light: boolean | null;
  observedAt: number | null;
};

const Fields = {
  status: 'sensor.%_print_status',
  stage: 'sensor.%_current_stage',
  progress: 'sensor.%_print_progress',
  remaining: 'sensor.%_remaining_time',
  layer: 'sensor.%_current_layer',
  totalLayers: 'sensor.%_total_layer_count',
  task: 'sensor.%_task_name',
  printerName: 'sensor.%_printer_name',
  nozzle: 'sensor.%_nozzle_temperature',
  nozzleTarget: 'sensor.%_nozzle_target_temperature',
  bed: 'sensor.%_bed_temperature',
  bedTarget: 'sensor.%_bed_target_temperature',
  cover: 'image.%_cover_image',
  light: 'light.%_chamber_light',
  objects: 'sensor.%_printable_objects',
} as const;
type Field = keyof typeof Fields;

const ActiveStatuses: ReadonlySet<PrinterStatus> = new Set([
  'preparing',
  'printing',
  'paused',
]);
const ResultStatuses: ReadonlySet<PrinterStatus> = new Set([
  'finished',
  'failed',
]);

const StateSchema = z.object({
  entity_id: z.string().max(255),
  state: z.union([z.string().max(1024), z.number()]),
  attributes: z.record(z.string(), z.unknown()).optional(),
  last_changed: z.string().optional(),
  last_updated: z.string().optional(),
});
type Observation = {
  state: string;
  unit: string | null;
  changedAt: number;
  updatedAt: number;
};

/** Observes one printer's Home Assistant entities; never performs I/O. */
export class HomeAssistantPrinterAdapter {
  private readonly fieldByEntity: ReadonlyMap<string, Field>;
  private readonly observations = new Map<Field, Observation>();
  private readonly listeners = new Set<() => void>();
  readonly coverEntityId: string;
  readonly chamberLightEntityId: string;

  constructor(
    private readonly config: HomeAssistantPrinterConfig,
    private readonly clock: Clock,
  ) {
    const parsed = HomeAssistantPrinterConfigSchema.parse(config);
    this.fieldByEntity = new Map(
      (Object.entries(Fields) as [Field, string][]).map(([field, pattern]) => [
        pattern.replace('%', parsed.entityPrefix),
        field,
      ]),
    );
    this.coverEntityId = Fields.cover.replace('%', parsed.entityPrefix);
    this.chamberLightEntityId = Fields.light.replace('%', parsed.entityPrefix);
  }

  get entityIds(): readonly string[] {
    return [...this.fieldByEntity.keys()];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  acceptState(payload: unknown): boolean {
    const result = StateSchema.safeParse(payload);
    if (!result.success) return false;
    const field = this.fieldByEntity.get(result.data.entity_id);
    if (!field) return false;
    const now = this.clock.now();
    const updatedAt = parseTime(result.data.last_updated) ?? now;
    const previous = this.observations.get(field);
    if (previous && updatedAt < previous.updatedAt) return true;
    const state = String(result.data.state);
    const unit = result.data.attributes?.['unit_of_measurement'];
    this.observations.set(field, {
      state,
      unit: typeof unit === 'string' ? unit : null,
      changedAt:
        parseTime(result.data.last_changed) ??
        (previous?.state === state ? previous.changedAt : updatedAt),
      updatedAt,
    });
    if (previous?.state !== state)
      for (const listener of this.listeners) listener();
    return true;
  }

  acceptStateChangedEvent(payload: unknown): boolean {
    const data = stateChangedData(payload);
    if (!data || !this.fieldByEntity.has(data.entityId)) return false;
    return this.acceptState(
      data.newState ?? { entity_id: data.entityId, state: 'unavailable' },
    );
  }

  /** The current print, or null when nothing worth showing is happening. */
  activity(): PrinterActivitySnapshot | null {
    const snapshot = this.snapshot();
    if (ActiveStatuses.has(snapshot.status)) return snapshot;
    if (
      ResultStatuses.has(snapshot.status) &&
      snapshot.statusSince !== null &&
      this.clock.now() - snapshot.statusSince <
        this.config.resultVisibleMinutes * 60_000
    )
      return snapshot;
    return null;
  }

  snapshot(): PrinterActivitySnapshot {
    const status = printerStatus(this.text('status'));
    const remaining = this.observations.get('remaining');
    const remainingMinutes = remaining
      ? durationMinutes(remaining.state, remaining.unit)
      : null;
    const progress = this.number('progress');
    const finished = status === 'finished';
    return {
      name: this.config.name ?? this.text('printerName') ?? '3D-skrivare',
      status,
      stage: stageName(this.text('stage')),
      progress: finished
        ? 100
        : progress === null
          ? null
          : Math.min(100, Math.max(0, Math.round(progress))),
      remainingMinutes: finished ? 0 : remainingMinutes,
      endsAt:
        remaining && remainingMinutes !== null && !finished
          ? remaining.updatedAt + Math.round(remainingMinutes * 60_000)
          : null,
      layer: this.integer('layer'),
      totalLayers: this.integer('totalLayers'),
      task: taskTitle(this.text('task'), this.integer('objects')),
      nozzle: this.temperature('nozzle', 'nozzleTarget'),
      bed: this.temperature('bed', 'bedTarget'),
      statusSince: this.observations.get('status')?.changedAt ?? null,
      coverRevision: coverRevision(this.text('cover')),
      light:
        this.text('light') === 'on'
          ? true
          : this.text('light') === 'off'
            ? false
            : null,
      observedAt:
        Math.max(
          0,
          ...[...this.observations.values()].map((item) => item.updatedAt),
        ) || null,
    };
  }

  private text(field: Field): string | null {
    const value = this.observations.get(field)?.state.trim();
    return !value || value === 'unknown' || value === 'unavailable'
      ? null
      : value;
  }

  private number(field: Field): number | null {
    const value = this.text(field);
    if (value === null || !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value))
      return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private integer(field: Field): number | null {
    const value = this.number(field);
    return value === null || value < 0 ? null : Math.round(value);
  }

  private temperature(current: Field, target: Field) {
    const value = this.number(current);
    if (value === null) return null;
    const goal = this.number(target);
    return {
      current: Math.round(value),
      target: goal === null ? null : Math.round(goal),
    };
  }
}

function printerStatus(value: string | null): PrinterStatus {
  switch (value) {
    case 'running':
      return 'printing';
    case 'prepare':
    case 'slicing':
    case 'init':
      return 'preparing';
    case 'pause':
      return 'paused';
    case 'finish':
      return 'finished';
    case 'failed':
      return 'failed';
    case 'idle':
      return 'idle';
    default:
      return 'offline';
  }
}

function stageName(value: string | null): string | null {
  return value && /^[a-z0-9_]{1,64}$/.test(value) ? value : null;
}

/** Remaining time arrives in hours in current ha-bambulab, minutes in older. */
function durationMinutes(state: string, unit: string | null): number | null {
  if (!/^\d+(?:\.\d+)?$/.test(state.trim())) return null;
  const value = Number(state);
  if (!Number.isFinite(value)) return null;
  const minutes = unit === 'h' ? value * 60 : unit === 's' ? value / 60 : value;
  return Math.round(minutes);
}

/**
 * `obj_4_Stand.stl + obj_5_Box.stl + …` reads as `Stand + Box + 5 till`.
 * The Hub has two short lines, so a single name keeps up to 60 characters,
 * and with several parts the names give way so the count always shows.
 */
export function taskTitle(
  value: string | null,
  objectCount: number | null = null,
): string | null {
  if (!value) return null;
  const truncated = /\+\s*$/.test(value);
  const parts = value
    .split('+')
    .map((part) =>
      part
        .trim()
        .replace(/^obj_\d+_/i, '')
        .replace(/\.(?:stl|3mf|step|obj|gcode)$/i, '')
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
  if (!parts.length) return null;
  const total = Math.max(
    parts.length + (truncated ? 1 : 0),
    truncated && objectCount !== null ? objectCount : 0,
  );
  if (total === 1) return shorten(parts[0]!, 60);
  const shown = [shorten(parts[0]!, 24)];
  const second = parts[1] ? shorten(parts[1], 18) : null;
  if (second && `${shown[0]} + ${second}`.length <= 36) shown.push(second);
  const more = total - shown.length;
  return more > 0 ? `${shown.join(' + ')} + ${more} till` : shown.join(' + ');
}

function shorten(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

function coverRevision(value: string | null): string | null {
  return value && value.length <= 64 ? value : null;
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function stateChangedData(
  payload: unknown,
): { entityId: string; newState: unknown } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  let candidate = payload as Record<string, unknown>;
  if (candidate['type'] === 'event' && typeof candidate['event'] === 'object')
    candidate = candidate['event'] as Record<string, unknown>;
  if (candidate['event_type'] === 'state_changed')
    candidate = (candidate['data'] ?? {}) as Record<string, unknown>;
  const entityId = candidate['entity_id'];
  if (typeof entityId !== 'string') return null;
  const newState = candidate['new_state'];
  if (
    newState !== null &&
    newState !== undefined &&
    (typeof newState !== 'object' ||
      (newState as Record<string, unknown>)['entity_id'] !== entityId)
  )
    return null;
  return { entityId, newState: newState ?? null };
}
