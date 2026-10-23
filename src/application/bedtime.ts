import { z } from 'zod';
import { isHumanActor } from '../core/automation-holds.js';
import type { Clock } from '../core/clock.js';
import { ProvenanceSchema, type Provenance } from '../core/schemas.js';
import {
  RoutineError,
  tomorrowStockholm,
  RoutineDefinitionSchema,
  type BedtimeProjection,
  type RoutineDefinition,
  type RoutineSnapshot,
} from '../core/routines.js';
import type { RoutineStore } from '../runtime/routine-store.js';
import type { LugnEngine } from './lugn-engine.js';

export const BEDTIME_NIGHT_ID = 'bedtime-night';
export const BEDTIME_MORNING_ID = 'bedtime-morning';
export type BedtimeOptions = { lightTargets: string[]; musicTarget?: string };
const common = {
  expectedGeneration: z.uuid(),
  requestId: z.string().trim().min(1).max(128),
};
const settings = {
  ...common,
  wakeTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  mode: z.enum(['auto', 'button', 'none']),
  music: z.boolean().default(false),
};
export const BedtimeRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), ...settings }).strict(),
  z.object({ action: z.literal('plan'), ...settings }).strict(),
  z.object({ action: z.literal('clear'), ...common }).strict(),
  z
    .object({
      action: z.literal('morning'),
      ...common,
      music: z.boolean().default(false),
    })
    .strict(),
]);

/** Persists owned definitions; scheduling and all device effects remain in RoutineService. */
export class BedtimeController {
  private buttonAt: number | undefined;
  private buttonOriginalAt: number | undefined;
  private readonly dismissed = new Set<number>();
  private readonly requests = new Map<
    string,
    { fingerprint: string; result: Promise<RoutineSnapshot> }
  >();
  constructor(
    private readonly clock: Clock,
    private readonly engine: LugnEngine,
    private readonly store: RoutineStore,
    private readonly options: BedtimeOptions,
    private readonly service: {
      snapshot(): RoutineSnapshot;
      validateStart(definition: RoutineDefinition): void;
      captureStartGuard(definition: RoutineDefinition): () => boolean;
      startDefinition(
        definition: RoutineDefinition,
        provenance: Provenance,
      ): void;
    },
  ) {
    store.beginSession();
  }

  projection(): BedtimeProjection {
    const plan = this.store
      .snapshot()
      .definitions.find(
        (d) => d.id === BEDTIME_MORNING_ID && d.bedtime?.owner === 'bedtime',
      )?.bedtime?.plan;
    const now = this.clock.now();
    const readyAt =
      plan && this.buttonOriginalAt === plan.at ? this.buttonAt : undefined;
    if (plan && readyAt !== undefined && now >= readyAt + 3_600_000)
      this.dismissed.add(plan.at);
    const { available, skipped } = this.lights();
    return {
      nightRoutineId: BEDTIME_NIGHT_ID,
      morningRoutineId: BEDTIME_MORNING_ID,
      nightAvailable: available.length > 0,
      morningAvailable: available.length > 0,
      musicAvailable: this.musicAvailable(),
      plan:
        plan && plan.consumedAt === undefined && plan.at > now
          ? structuredClone(plan)
          : null,
      ready:
        plan?.mode === 'button' &&
        !this.dismissed.has(plan.at) &&
        readyAt !== undefined &&
        now >= readyAt &&
        now < readyAt + 3_600_000
          ? { until: readyAt + 3_600_000, music: plan.music }
          : null,
      skippedTargets: skipped,
    };
  }
  readyOccurrence(): { routineId: string; at: number } | null {
    const ready = this.projection().ready;
    return ready
      ? { routineId: BEDTIME_MORNING_ID, at: ready.until - 3_600_000 }
      : null;
  }
  openButton(at: number): void {
    this.buttonOriginalAt = this.store
      .snapshot()
      .definitions.find((d) => d.id === BEDTIME_MORNING_ID)?.bedtime?.plan?.at;
    this.buttonAt = at;
  }
  invalidateReady(): void {
    if (this.buttonAt !== undefined) this.dismissReady();
  }
  dismissReady(): void {
    const at = this.store
      .snapshot()
      .definitions.find((d) => d.id === BEDTIME_MORNING_ID)?.bedtime?.plan?.at;
    if (at !== undefined) this.dismissed.add(at);
  }
  private lights(): { available: string[]; skipped: string[] } {
    const targets = [...new Set(this.options.lightTargets)];
    const available = targets.filter((target) => {
      const d = this.engine.state.lighting.devices[target];
      return (
        d !== undefined &&
        d.availability !== 'unavailable' &&
        (d.observed.power === false || d.observed.brightness !== undefined)
      );
    });
    return {
      available,
      skipped: targets.filter((t) => !available.includes(t)),
    };
  }
  private musicAvailable(): boolean {
    return (
      this.options.musicTarget !== undefined &&
      this.engine.state.music.devices[this.options.musicTarget]
        ?.availability === 'available'
    );
  }
  request(raw: unknown, rawProvenance: Provenance): Promise<RoutineSnapshot> {
    const input = BedtimeRequestSchema.parse(raw);
    const provenance = ProvenanceSchema.parse(rawProvenance);
    if (!isHumanActor(provenance.actor))
      throw new RoutineError(403, 'human_actor_required');
    const fingerprint = JSON.stringify({ input, actor: provenance.actor });
    const previous = this.requests.get(input.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new RoutineError(409, 'routine_request_reused');
      return previous.result;
    }
    const receipt = this.store
      .snapshot()
      .bedtimeReceipts?.find((r) => r.requestId === input.requestId);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint)
        throw new RoutineError(409, 'routine_request_reused');
      // Committed requests never restart their night or morning after a process restart.
      return Promise.resolve(this.service.snapshot());
    }
    if (
      (this.store.snapshot().bedtimeReceipts?.length ?? 0) >= 1024 ||
      this.requests.size >= 1024
    )
      throw new RoutineError(429, 'routine_request_capacity');
    const result = Promise.resolve().then(async () => {
      if (input.expectedGeneration !== this.store.snapshot().generation)
        throw new RoutineError(409, 'routines_changed');
      const definitions = this.store.snapshot().definitions;
      for (const id of [BEDTIME_NIGHT_ID, BEDTIME_MORNING_ID]) {
        const existing = definitions.find((d) => d.id === id);
        if (existing && existing.bedtime?.owner !== 'bedtime')
          throw new RoutineError(409, 'bedtime_id_in_use');
      }
      const lights = this.lights().available;
      const music = 'music' in input && input.music;
      if (music && !this.musicAvailable())
        throw new RoutineError(409, 'bedtime_music_unavailable');
      if (input.action !== 'clear' && !lights.length)
        throw new RoutineError(409, 'bedtime_lights_unavailable');
      const plan =
        (input.action === 'start' || input.action === 'plan') &&
        input.mode !== 'none'
          ? {
              at: tomorrowStockholm(input.wakeTime, this.clock.now()),
              time: input.wakeTime,
              mode: input.mode,
              music,
            }
          : null;
      const make = (role: 'night' | 'morning'): RoutineDefinition =>
        RoutineDefinitionSchema.parse({
          id: role === 'night' ? BEDTIME_NIGHT_ID : BEDTIME_MORNING_ID,
          name: role === 'night' ? 'God natt' : 'God morgon',
          kind: role === 'night' ? 'good_night' : 'good_morning',
          enabled: true,
          schedule: null,
          bedtime: {
            owner: 'bedtime',
            role,
            plan: role === 'morning' ? plan : null,
          },
          steps: [
            ...(role === 'morning'
              ? [
                  { type: 'condition', condition: 'home' },
                  { type: 'condition', condition: 'occupied' },
                  ...(music
                    ? [
                        {
                          type: 'playback',
                          target: this.options.musicTarget,
                          state: 'playing',
                        },
                      ]
                    : []),
                ]
              : []),
            {
              type: 'light',
              targets: lights,
              brightness: role === 'night' ? 0 : 40,
              durationMs: (role === 'night' ? 15 : 20) * 60_000,
              colorTemperature: 3000,
            },
          ],
        });
      const night = input.action !== 'clear' ? make('night') : undefined;
      const morning = input.action !== 'clear' ? make('morning') : undefined;
      const start =
        input.action === 'start'
          ? night
          : input.action === 'morning'
            ? morning
            : undefined;
      const validate = () => {
        if (start) this.service.validateStart(start);
      };
      validate();
      const canStart = start
        ? this.service.captureStartGuard(start)
        : undefined;
      await this.store.update(
        input.expectedGeneration,
        (document) => ({
          ...document,
          definitions:
            input.action === 'clear'
              ? document.definitions.map((d) =>
                  d.id === BEDTIME_MORNING_ID && d.bedtime
                    ? { ...d, bedtime: { ...d.bedtime, plan: null } }
                    : d,
                )
              : [
                  ...document.definitions.filter(
                    (d) =>
                      d.id !== BEDTIME_NIGHT_ID && d.id !== BEDTIME_MORNING_ID,
                  ),
                  night!,
                  morning!,
                ],
          bedtimeReceipts: [
            ...(document.bedtimeReceipts ?? []),
            { requestId: input.requestId, fingerprint },
          ],
        }),
        validate,
      );
      if (start && canStart?.())
        this.service.startDefinition(start, provenance);
      return this.service.snapshot();
    });
    this.requests.set(input.requestId, { fingerprint, result });
    void result.catch(() => this.requests.delete(input.requestId));
    return result;
  }
}
