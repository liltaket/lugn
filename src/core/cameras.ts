import { z } from 'zod';

const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
const Name = z.string().trim().min(1).max(80);
const Entity = (domain: string) =>
  z
    .string()
    .regex(new RegExp(`^${domain}\\.[a-z0-9_]+$`))
    .max(255);
export const CameraViewerSchema = z.enum(['bed', 'desk', 'web']);
export type CameraViewer = z.infer<typeof CameraViewerSchema>;
const TriggerBase = { id: Id, name: Name, cameraId: Id };
export const CameraTriggerSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...TriggerBase,
      kind: z.literal('state'),
      entityId: Entity('(binary_sensor|switch)'),
      from: z.literal('off'),
      to: z.literal('on'),
    })
    .strict(),
  z
    .object({
      ...TriggerBase,
      kind: z.literal('automation'),
      entityId: Entity('automation'),
    })
    .strict(),
  z
    .object({
      ...TriggerBase,
      kind: z.literal('service'),
      domain: z.literal('media_player'),
      service: z.literal('play_media'),
      entityId: Entity('media_player'),
      mediaContentId: z.string().min(1).max(2048),
    })
    .strict(),
]);
export const CameraDashboardConfigSchema = z
  .object({
    cameras: z
      .array(
        z.object({ id: Id, name: Name, entityId: Entity('camera') }).strict(),
      )
      .max(8),
    triggers: z.array(CameraTriggerSchema).max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const key of ['cameras', 'triggers'] as const) {
      if (new Set(value[key].map((item) => item.id)).size !== value[key].length)
        ctx.addIssue({ code: 'custom', path: [key], message: 'Duplicate IDs' });
    }
    const cameras = new Set(value.cameras.map((camera) => camera.id));
    value.triggers.forEach((trigger, index) => {
      if (!cameras.has(trigger.cameraId))
        ctx.addIssue({
          code: 'custom',
          path: ['triggers', index, 'cameraId'],
          message: 'Unknown camera',
        });
    });
  });
export type CameraDashboardConfig = z.infer<typeof CameraDashboardConfigSchema>;
export type CameraTrigger = z.infer<typeof CameraTriggerSchema>;
export const CameraSettingsSchema = z
  .object({
    enabled: z.boolean(),
    automaticEnabled: z.boolean(),
    durationSeconds: z.number().int().min(5).max(120),
    cameras: z
      .record(Id, z.boolean())
      .refine((v) => Object.keys(v).length <= 8),
    triggers: z
      .record(Id, z.boolean())
      .refine((v) => Object.keys(v).length <= 32),
    viewers: z
      .array(CameraViewerSchema)
      .max(3)
      .refine((v) => new Set(v).size === v.length),
  })
  .strict();
export type CameraSettings = z.infer<typeof CameraSettingsSchema>;
export const CameraSettingsDocumentSchema = z
  .object({
    version: z.literal(1),
    generation: z.uuid(),
    settings: CameraSettingsSchema,
  })
  .strict();
export type CameraSettingsDocument = z.infer<
  typeof CameraSettingsDocumentSchema
>;
export function createCameraSettings(
  config: CameraDashboardConfig,
): CameraSettings {
  return {
    enabled: false,
    automaticEnabled: false,
    durationSeconds: 30,
    cameras: Object.fromEntries(
      config.cameras.map((camera) => [camera.id, true]),
    ),
    triggers: Object.fromEntries(
      config.triggers.map((trigger) => [trigger.id, false]),
    ),
    viewers: ['bed', 'desk', 'web'],
  };
}
export class CameraError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export interface CameraActiveView {
  id: string;
  cameraId: string;
  name: string;
  reason: string;
  expiresAt: number;
  manual: boolean;
  imageUrl?: string;
  streamUrl?: string;
}
export interface CameraDashboardSnapshot {
  generation: string;
  settings: CameraSettings;
  definitions: {
    id: string;
    name: string;
    enabled: boolean;
    available: boolean;
  }[];
  triggers: {
    id: string;
    name: string;
    cameraId: string;
    kind: CameraTrigger['kind'];
    enabled: boolean;
  }[];
  active: CameraActiveView | null;
}
