import { z } from 'zod';

/**
 * Evidence about whether a display is drawing power. A monitor offers no
 * direct feedback, so this is only ever circumstantial: it can raise or lower
 * confidence, never prove the panel is lit or dark.
 */
export const DisplayPowerEvidenceSchema = z.object({
  source: z.literal('power-sensor'),
  state: z.enum(['on', 'standby', 'unknown']),
  watts: z.number().finite().nullable(),
  observedAt: z.number().nonnegative().nullable(),
});
export type DisplayPowerEvidence = z.infer<typeof DisplayPowerEvidenceSchema>;

export const unknownDisplayPowerEvidence = (): DisplayPowerEvidence => ({
  source: 'power-sensor',
  state: 'unknown',
  watts: null,
  observedAt: null,
});

export const DisplayPowerInhibitReasonSchema = z.enum([
  'recent_input',
  'recent_activity',
  'video_or_game',
]);
export type DisplayPowerInhibitReason = z.infer<
  typeof DisplayPowerInhibitReasonSchema
>;

/**
 * Policy and transport status for one computer display. `desired` is what
 * Lugn wants, `lastRequest` is the last request the agent acknowledged. Neither
 * is an observation of the physical panel.
 */
export const DisplayPowerSnapshotSchema = z.object({
  deviceId: z.string(),
  control: z.enum(['available', 'unavailable']),
  desired: z.enum(['on', 'off']).nullable(),
  inhibited: DisplayPowerInhibitReasonSchema.nullable(),
  lastRequest: z
    .object({
      action: z.enum(['on', 'off']),
      outcome: z.enum(['applied', 'rejected', 'uncertain', 'failed']),
      reason: z.string().max(64).nullable().optional(),
      at: z.number().nonnegative(),
    })
    .nullable(),
  /** What the agent reports about the picture signal; absent without feedback. */
  observed: z
    .object({
      power: z.enum(['on', 'off', 'partial', 'none', 'unknown']),
      inputIdle: z.boolean().nullable(),
      changedAt: z.number().nonnegative().nullable(),
    })
    .nullable()
    .optional(),
  /** Why Lugn stopped trying until the room is occupied and empty again. */
  problem: z
    .enum(['off_failed', 'keeps_waking', 'wake_failed', 'wake_unavailable'])
    .nullable()
    .optional(),
  nextAttemptAt: z.number().nonnegative().nullable(),
  evidence: DisplayPowerEvidenceSchema.nullable(),
});
export type DisplayPowerSnapshot = z.infer<typeof DisplayPowerSnapshotSchema>;

export const PowerSensorThresholdsSchema = z
  .object({
    /** At or above this draw the display counts as on. */
    onAboveWatts: z.number().finite().positive(),
    /** At or below this draw the display counts as off or in standby. */
    standbyBelowWatts: z.number().finite().nonnegative(),
    /**
     * A class must hold this long before it is reported. Power-up inrush and
     * the decay after power-off pass through the thresholds briefly.
     */
    settleMs: z.number().int().min(0).max(600_000).default(20_000),
  })
  .refine((t) => t.standbyBelowWatts < t.onAboveWatts, {
    message: 'standbyBelowWatts must be lower than onAboveWatts',
    path: ['standbyBelowWatts'],
  });
export type PowerSensorThresholds = z.infer<typeof PowerSensorThresholdsSchema>;

export type PowerClass = 'on' | 'standby' | 'unknown';

/**
 * Classifies one reading. Between the thresholds the previous settled class is
 * kept (hysteresis); without one the reading is genuinely unknown.
 */
export function classifyPower(
  watts: number | null,
  thresholds: Pick<PowerSensorThresholds, 'onAboveWatts' | 'standbyBelowWatts'>,
  previous: PowerClass,
): PowerClass {
  if (watts === null || !Number.isFinite(watts) || watts < 0) return 'unknown';
  if (watts >= thresholds.onAboveWatts) return 'on';
  if (watts <= thresholds.standbyBelowWatts) return 'standby';
  return previous;
}
