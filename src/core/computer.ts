import { z } from 'zod';

export const ComputerDeviceIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const TextSchema = z.string().max(512);

export const ComputerMediaSchema = z.object({
  player: TextSchema,
  identity: TextSchema.nullable(),
  desktopEntry: TextSchema.nullable(),
  playback: z.enum(['playing', 'paused', 'stopped', 'unknown']),
  title: TextSchema.nullable(),
  artists: z.array(TextSchema).max(64).nullable(),
  album: TextSchema.nullable(),
  contentType: TextSchema.nullable(),
});

/** Readings describe the computer, never physical room occupancy or user intent. */
export const ComputerReadingsSchema = z.object({
  networkOnline: z.boolean().nullable(),
  locked: z.boolean().nullable(),
  idle: z.boolean().nullable(),
  activeApplication: z
    .object({ id: TextSchema.nullable(), resourceClass: TextSchema.nullable() })
    .nullable(),
  fullscreen: z.boolean().nullable(),
  audio: z
    .object({
      playing: z.boolean(),
      applications: z.array(TextSchema).max(128),
      roles: z.array(TextSchema).max(128),
    })
    .nullable(),
  media: z.array(ComputerMediaSchema).max(64).nullable(),
});
export type ComputerReadings = z.infer<typeof ComputerReadingsSchema>;

export const ComputerActivitySchema = z.object({
  classification: z.enum([
    'gaming',
    'video',
    'music',
    'desktop',
    'idle',
    'unknown',
  ]),
  source: z.literal('desktop-agent'),
  basis: TextSchema.nullable(),
});

export const ComputerObservationSchema = z.object({
  deviceId: ComputerDeviceIdSchema,
  availability: z.enum(['online', 'offline', 'unknown']),
  freshness: z.enum(['fresh', 'stale', 'unknown']),
  reason: z.enum([
    'awaiting_state',
    'live',
    'retained',
    'stale',
    'offline',
    'broker_disconnected',
    'malformed',
    'stopped',
  ]),
  observedAt: z.number().nonnegative().nullable(),
  receivedAt: z.number().nonnegative().nullable(),
  sessionId: z.string().nullable(),
  sequence: z.number().int().nonnegative().nullable(),
  observed: ComputerReadingsSchema,
  activity: ComputerActivitySchema,
  lastEvent: z
    .object({
      type: z.literal('state_changed'),
      sessionId: z.string(),
      sequence: z.number().int().nonnegative(),
      occurredAt: z.number().nonnegative(),
      receivedAt: z.number().nonnegative(),
    })
    .nullable(),
});
export type ComputerObservation = z.infer<typeof ComputerObservationSchema>;
export const ComputerStateSchema = z.object({
  devices: z.record(ComputerDeviceIdSchema, ComputerObservationSchema),
});

export function unknownComputerReadings(): ComputerReadings {
  return {
    networkOnline: null,
    locked: null,
    idle: null,
    activeApplication: null,
    fullscreen: null,
    audio: null,
    media: null,
  };
}
