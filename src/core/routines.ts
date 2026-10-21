import { z } from 'zod';
import { SemanticLightingIdSchema, SemanticMusicIdSchema } from './schemas.js';

export class RoutineError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export const MAX_ROUTINES = 50;
export const MAX_ROUTINE_STEPS = 32;
export const MAX_ROUTINE_DURATION_MS = 6 * 60 * 60_000;
const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
const Duration = z
  .number()
  .int()
  .min(0)
  .max(60 * 60_000);
export const RoutineStepSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('scene'), sceneId: z.string().min(1).max(100) })
    .strict(),
  z
    .object({
      type: z.literal('light'),
      targets: z
        .array(SemanticLightingIdSchema)
        .min(1)
        .max(32)
        .refine((v) => new Set(v).size === v.length),
      brightness: z.number().int().min(0).max(100),
      durationMs: Duration,
    })
    .strict(),
  z
    .object({
      type: z.literal('volume'),
      target: SemanticMusicIdSchema,
      volume: z.number().min(0).max(1),
      durationMs: z
        .number()
        .int()
        .min(0)
        .max(120_000)
        .refine((v) => v === 0 || v >= 1_000),
    })
    .strict(),
  z
    .object({
      type: z.literal('playback'),
      target: SemanticMusicIdSchema,
      state: z.enum(['playing', 'paused']),
    })
    .strict(),
  z
    .object({
      type: z.literal('source'),
      target: SemanticMusicIdSchema,
      source: z.string().trim().min(1).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal('preset'),
      target: SemanticMusicIdSchema,
      preset: z.enum(['spotify_dj', 'optical']),
    })
    .strict(),
  z.object({ type: z.literal('delay'), durationMs: Duration }).strict(),
  z
    .object({
      type: z.literal('condition'),
      condition: z.enum(['occupied', 'home', 'music_idle']),
      target: SemanticMusicIdSchema.optional(),
    })
    .strict()
    .refine((v) => v.condition !== 'music_idle' || v.target !== undefined),
]);
export type RoutineStep = z.infer<typeof RoutineStepSchema>;
export const RoutineDefinitionSchema = z
  .object({
    id: Id,
    name: z.string().trim().min(1).max(80),
    kind: z.enum(['good_night', 'good_morning', 'custom']),
    enabled: z.boolean(),
    schedule: z
      .object({
        time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
        weekdays: z
          .array(z.number().int().min(1).max(7))
          .min(1)
          .max(7)
          .refine((v) => new Set(v).size === v.length),
      })
      .strict()
      .nullable(),
    steps: z.array(RoutineStepSchema).min(1).max(MAX_ROUTINE_STEPS),
  })
  .strict()
  .refine(
    (v) =>
      v.steps.reduce(
        (sum, s) => sum + ('durationMs' in s ? s.durationMs : 0),
        0,
      ) <= MAX_ROUTINE_DURATION_MS,
    'Routine exceeds six hours',
  );
export type RoutineDefinition = z.infer<typeof RoutineDefinitionSchema>;
export const RoutineDocumentSchema = z
  .object({
    version: z.literal(1),
    generation: z.uuid(),
    definitions: z
      .array(RoutineDefinitionSchema)
      .max(MAX_ROUTINES)
      .refine((v) => new Set(v.map((d) => d.id)).size === v.length),
  })
  .strict();
export type RoutineDocument = z.infer<typeof RoutineDocumentSchema>;
export type RoutineRun = {
  id: string;
  routineId: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  stepIndex: number;
  startedAt: number;
  updatedAt: number;
  reason: string | null;
};
export type RoutineOccurrence = { routineId: string; at: number };
export type RoutineSnapshot = RoutineDocument & {
  runs: RoutineRun[];
  next: RoutineOccurrence[];
};
export const RoutineActionSchema = z
  .object({
    id: Id,
    action: z.enum(['start', 'cancel', 'snooze', 'skip']),
    requestId: z.string().min(1).max(128).optional(),
    minutes: z.number().int().min(1).max(120).optional(),
  })
  .strict();
export type RoutineAction = z.infer<typeof RoutineActionSchema>;

const stockholm = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
function localParts(at: number): Record<string, number> {
  return Object.fromEntries(
    stockholm
      .formatToParts(at)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  );
}
/** Gaps are skipped; folds run once, at their first instant. Strictly future. */
export function nextRoutineOccurrence(
  definition: RoutineDefinition,
  after: number,
): RoutineOccurrence | null {
  if (!definition.enabled || !definition.schedule) return null;
  const p = localParts(after);
  const [hour, minute] = definition.schedule.time.split(':').map(Number) as [
    number,
    number,
  ];
  for (let day = 0; day < 16; day++) {
    const date = new Date(
      Date.UTC(p['year']!, p['month']! - 1, p['day']! + day),
    );
    if (!definition.schedule.weekdays.includes(date.getUTCDay() || 7)) continue;
    const civil = Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      hour,
      minute,
    );
    const matches = [civil - 2 * 60 * 60_000, civil - 60 * 60_000].filter(
      (at) => {
        const local = localParts(at);
        return (
          local['year'] === date.getUTCFullYear() &&
          local['month'] === date.getUTCMonth() + 1 &&
          local['day'] === date.getUTCDate() &&
          local['hour'] === hour &&
          local['minute'] === minute
        );
      },
    );
    const at = matches[0];
    if (at !== undefined && at > after) return { routineId: definition.id, at };
  }
  return null;
}

export function previewRoutine(input: unknown): {
  timeline: { atMs: number; label: string }[];
  durationMs: number;
  warnings: string[];
} {
  const definition = RoutineDefinitionSchema.parse(input);
  let durationMs = 0;
  const timeline = definition.steps.map((step) => {
    const atMs = durationMs;
    if ('durationMs' in step) durationMs += step.durationMs;
    const label =
      step.type === 'scene'
        ? `Scene: ${step.sceneId}`
        : step.type === 'light'
          ? `Light: ${step.targets.join(', ')} → ${step.brightness}%`
          : step.type === 'volume'
            ? `Volume: ${step.target} → ${Math.round(step.volume * 100)}%`
            : step.type === 'delay'
              ? 'Wait'
              : step.type === 'condition'
                ? `Require ${step.condition}`
                : step.type === 'playback'
                  ? `${step.target}: ${step.state}`
                  : step.type === 'source'
                    ? `${step.target}: ${step.source}`
                    : `${step.target}: ${step.preset}`;
    return { atMs, label };
  });
  return {
    timeline,
    durationMs,
    warnings: [
      ...(!definition.enabled
        ? ['Routine is disabled; enable it explicitly before starting.']
        : []),
      ...(definition.schedule
        ? [
            'Europe/Stockholm: missing DST times are skipped; repeated times run once.',
          ]
        : []),
      'Preview shows requested timing, not device confirmation. Policy and availability are rechecked during execution.',
    ],
  };
}

/** Supply configured semantic targets. Templates never enable scheduling or jump to a bright scene. */
export function createRoutineTemplates(
  options: { lightTargets?: string[]; musicTarget?: string } = {},
): RoutineDefinition[] {
  const lights = options.lightTargets ?? [];
  const music = options.musicTarget;
  return [
    {
      id: 'good-night',
      name: 'God natt',
      kind: 'good_night',
      enabled: false,
      schedule: null,
      steps: [
        ...(lights.length
          ? [
              {
                type: 'light' as const,
                targets: lights,
                brightness: 0,
                durationMs: 15 * 60_000,
              },
            ]
          : [{ type: 'delay' as const, durationMs: 0 }]),
        ...(music
          ? [
              {
                type: 'volume' as const,
                target: music,
                volume: 0,
                durationMs: 120_000,
              },
              {
                type: 'playback' as const,
                target: music,
                state: 'paused' as const,
              },
            ]
          : []),
      ],
    },
    {
      id: 'good-morning',
      name: 'God morgon',
      kind: 'good_morning',
      enabled: false,
      schedule: null,
      steps: [
        { type: 'condition', condition: 'home' },
        { type: 'condition', condition: 'occupied' },
        ...(lights.length
          ? [
              {
                type: 'light' as const,
                targets: lights,
                brightness: 40,
                durationMs: 20 * 60_000,
              },
            ]
          : [{ type: 'delay' as const, durationMs: 0 }]),
      ],
    },
  ].map((definition) => RoutineDefinitionSchema.parse(definition));
}
