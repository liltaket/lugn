import { z } from 'zod';

export const ChimeStyleSchema = z.enum(['glass', 'soft', 'tick']);
export type ChimeStyle = z.infer<typeof ChimeStyleSchema>;

export const PresenceFeedbackSettingsSchema = z
  .object({
    /**
     * How long a room that the sensor reports as empty keeps its lights and
     * music before Lugn acts on it. Zero acts immediately.
     */
    exitGraceSeconds: z.number().int().min(0).max(600),
    chime: z
      .object({
        enabled: z.boolean(),
        /** Linear 0..1 control; the tone is already quiet at 1. */
        volume: z.number().min(0).max(1),
        /** Glass is a bell-like blip, soft is rounder, tick is short and dry. */
        style: ChimeStyleSchema.default('glass'),
        entry: z.boolean(),
        exit: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type PresenceFeedbackSettings = z.infer<
  typeof PresenceFeedbackSettingsSchema
>;

export const defaultPresenceFeedbackSettings: PresenceFeedbackSettings = {
  exitGraceSeconds: 0,
  chime: {
    enabled: false,
    volume: 0.3,
    style: 'glass',
    entry: true,
    exit: true,
  },
};

export const ChimeKindSchema = z.enum(['entry', 'exit']);
export type ChimeKind = z.infer<typeof ChimeKindSchema>;
