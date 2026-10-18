import { z } from 'zod';

export const MusicVolumeSettingsSchema = z
  .object({
    enabled: z.boolean(),
    autoBaseVolumes: z
      .record(
        z.string().regex(/^music\.[a-zA-Z0-9_.-]+$/),
        z.number().finite().min(0).max(1),
      )
      .default({}),
    passiveMultiPersonReductionEnabled: z.boolean().default(false),
    dailyCurve: z
      .array(
        z
          .object({
            minute: z.number().int().min(0).max(1440),
            offset: z.number().finite().min(-1).max(1),
          })
          .strict(),
      )
      .min(2)
      .max(48),
    personOffset: z.number().finite().min(-1).max(0),
    minimum: z.number().finite().min(0).max(1),
    maximum: z.number().finite().min(0).max(1),
  })
  .strict()
  .superRefine((settings, context) => {
    if (settings.minimum > settings.maximum)
      context.addIssue({
        code: 'custom',
        path: ['minimum'],
        message: 'Minimum must not exceed maximum.',
      });
    if (
      settings.dailyCurve[0]?.minute !== 0 ||
      settings.dailyCurve.at(-1)?.minute !== 1440
    )
      context.addIssue({
        code: 'custom',
        path: ['dailyCurve'],
        message: 'Curve must start at 00:00 and end at 24:00.',
      });
    if (settings.dailyCurve[0]?.offset !== settings.dailyCurve.at(-1)?.offset)
      context.addIssue({
        code: 'custom',
        path: ['dailyCurve'],
        message: 'Midnight offsets must match for a continuous daily curve.',
      });
    settings.dailyCurve.forEach((point, index) => {
      if (index > 0 && point.minute <= settings.dailyCurve[index - 1]!.minute)
        context.addIssue({
          code: 'custom',
          path: ['dailyCurve', index, 'minute'],
          message: 'Times must be unique and in increasing order.',
        });
    });
  });
export type MusicVolumeSettings = z.infer<typeof MusicVolumeSettingsSchema>;
export const defaultMusicVolumeSettings: MusicVolumeSettings = {
  enabled: true,
  autoBaseVolumes: {},
  passiveMultiPersonReductionEnabled: false,
  dailyCurve: [
    { minute: 0, offset: -0.15 },
    { minute: 360, offset: 0 },
    { minute: 1320, offset: 0 },
    { minute: 1440, offset: -0.15 },
  ],
  personOffset: -0.1,
  minimum: 0.05,
  maximum: 0.8,
};

/** Pure calculation: no device state, ownership mutation or command dispatch. */
export function calculateMusicVolume(
  settings: MusicVolumeSettings,
  baseline: number | null,
  minute: number,
  personCount: number | null,
) {
  const position = Math.min(1440, Math.max(0, minute));
  const rightIndex = settings.dailyCurve.findIndex(
    (point, index) => index > 0 && point.minute >= position,
  );
  const right = settings.dailyCurve[rightIndex]!;
  const left = settings.dailyCurve[rightIndex - 1]!;
  const dailyOffset =
    left.offset +
    ((right.offset - left.offset) * (position - left.minute)) /
      (right.minute - left.minute);
  const personOffset =
    personCount !== null && personCount > 1 ? settings.personOffset : 0;
  return {
    baseline,
    dailyOffset,
    personOffset,
    target:
      baseline === null
        ? null
        : Math.min(
            settings.maximum,
            Math.max(settings.minimum, baseline + dailyOffset + personOffset),
          ),
  };
}
