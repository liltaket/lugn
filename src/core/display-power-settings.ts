import { z } from 'zod';
import { ComputerDeviceIdSchema } from './computer.js';

/**
 * What the control panel can change about a computer's display power policy.
 * The `display` entry in the runtime configuration decides that the feature
 * exists for a computer and supplies the defaults; these saved values override
 * them until the user resets.
 */
export const DisplayPowerSettingsSchema = z
  .object({
    /** Master switch: when off, Lugn sends nothing to this display. */
    enabled: z.boolean(),
    /** Confirmed-empty time before the display is put to sleep. */
    offAfterEmptyMs: z.number().int().min(10_000).max(86_400_000),
    /** While nobody is home, keep the display off (with low-rate rechecks). */
    ensureOffWhenAway: z.boolean(),
    wakeOnEntry: z.boolean(),
    wakeInQuietHours: z.boolean(),
    /**
     * In quiet hours, still wake after an absence of at most this long. The
     * default keeps settings saved before this existed readable.
     */
    quietWakeMaxAbsenceMs: z
      .number()
      .int()
      .min(0)
      .max(86_400_000)
      .default(1_200_000),
    /** Hold sleep while the computer is in use or plays video or a game. */
    inhibitOnActivity: z.boolean(),
    activeInhibitMaxMs: z.number().int().min(0).max(86_400_000),
    /** Sleep after this long without input, regardless of presence. null: off. */
    idleSleepAfterMs: z.number().int().min(300_000).max(86_400_000).nullable(),
    /** Idle blockers (application names) that never keep the display on. */
    ignoreIdleBlockers: z.array(z.string().min(1).max(64)).max(16),
  })
  .strict();
export type DisplayPowerSettings = z.infer<typeof DisplayPowerSettingsSchema>;

export const DisplayPowerSettingsFileSchema = z
  .object({
    version: z.literal(1),
    generation: z.uuid(),
    computers: z.record(ComputerDeviceIdSchema, DisplayPowerSettingsSchema),
  })
  .strict();
export type DisplayPowerSettingsFile = z.infer<
  typeof DisplayPowerSettingsFileSchema
>;

export class DisplayPowerSettingsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** The part of the file the service needs; implemented by the runtime store. */
export interface DisplayPowerSettingsRepository {
  snapshot(): {
    generation: string;
    computers: Record<string, DisplayPowerSettings>;
  };
  save(
    deviceId: string,
    settings: DisplayPowerSettings | null,
    expectedGeneration: string,
  ): Promise<{ generation: string }>;
}
