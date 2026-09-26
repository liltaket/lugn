import { z } from 'zod';

export const PresenceSchema = z.enum([
  'occupied',
  'confirmed_empty',
  'unknown',
]);
export type Presence = z.infer<typeof PresenceSchema>;

export const ActorTypeSchema = z.enum([
  'user',
  'automation',
  'routine',
  'physical_remote',
  'home_assistant',
  'agent',
]);
export const ActorSchema = z.object({
  type: ActorTypeSchema,
  id: z.string().optional(),
});
export type Actor = z.infer<typeof ActorSchema>;

export const ProvenanceSchema = z.object({
  actor: ActorSchema,
  source: z.string().optional(),
  requestId: z.string().optional(),
  reason: z.string().optional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const LightingProperties = [
  'power',
  'brightness',
  'colorTemperature',
] as const;
export const LightingPropertySchema = z.enum(LightingProperties);
export type LightingProperty = z.infer<typeof LightingPropertySchema>;

export const LightingValuesSchema = z.object({
  power: z.boolean().optional(),
  brightness: z.number().int().min(0).max(100).optional(),
  colorTemperature: z.number().int().min(1000).max(10000).optional(),
});
export type LightingValues = z.infer<typeof LightingValuesSchema>;

export const SemanticLightingIdSchema = z
  .string()
  .regex(/^lighting\.[a-z0-9][a-z0-9._-]*$/);

export const SemanticSwitchIdSchema = z
  .string()
  .regex(/^switch\.[a-z0-9][a-z0-9._-]*$/);

export const SwitchCommandStatusSchema = z.enum([
  'pending',
  'confirmed',
  'unconfirmed',
  'superseded',
  'failed',
]);
export const SwitchCommandRecordSchema = z.object({
  id: z.string(),
  target: SemanticSwitchIdSchema,
  requested: z.boolean(),
  issuedAt: z.number().nonnegative(),
  status: SwitchCommandStatusSchema,
  provenance: ProvenanceSchema,
  acceptedAt: z.number().nonnegative().optional(),
  confirmedAt: z.number().nonnegative().optional(),
  diagnosticReason: z.string().optional(),
});
export type SwitchCommandRecord = z.infer<typeof SwitchCommandRecordSchema>;

export const DeviceSwitchStateSchema = z.object({
  observed: z.boolean().nullable(),
  requested: z.boolean().nullable(),
  availability: z.enum(['available', 'unavailable']),
  observedAt: z.number().nonnegative().nullable(),
  observedProvenance: ProvenanceSchema.nullable(),
  requestedProvenance: ProvenanceSchema.nullable(),
  latestCommandId: z.string().nullable(),
});
export type DeviceSwitchState = z.infer<typeof DeviceSwitchStateSchema>;

export const SwitchStateSchema = z.object({
  devices: z.record(SemanticSwitchIdSchema, DeviceSwitchStateSchema),
  commands: z.array(SwitchCommandRecordSchema),
});

export const SemanticMusicIdSchema = z
  .string()
  .regex(/^music\.[a-z0-9][a-z0-9._-]*$/);
export const MusicRequestSchema = z.discriminatedUnion('property', [
  z
    .object({
      property: z.literal('playback'),
      value: z.enum(['playing', 'paused']),
    })
    .strict(),
  z
    .object({ property: z.literal('volume'), value: z.number().min(0).max(1) })
    .strict(),
  z
    .object({ property: z.literal('source'), value: z.string().min(1) })
    .strict(),
]);
export type MusicRequest = z.infer<typeof MusicRequestSchema>;
export const MusicObservationValuesSchema = z
  .object({
    playback: z.enum(['playing', 'paused', 'idle', 'off', 'unknown']),
    volume: z.number().min(0).max(1).nullable(),
    source: z.string().nullable(),
    title: z.string().nullable(),
  })
  .strict();
export type MusicObservationValues = z.infer<
  typeof MusicObservationValuesSchema
>;
export const MusicCommandStatusSchema = z.enum([
  'pending',
  'confirmed',
  'unconfirmed',
  'superseded',
  'failed',
]);
export const MusicCommandRecordSchema = z.object({
  id: z.string(),
  target: SemanticMusicIdSchema,
  requested: MusicRequestSchema,
  issuedAt: z.number().nonnegative(),
  status: MusicCommandStatusSchema,
  provenance: ProvenanceSchema,
  acceptedAt: z.number().nonnegative().optional(),
  confirmedAt: z.number().nonnegative().optional(),
  diagnosticReason: z.string().optional(),
});
export type MusicCommandRecord = z.infer<typeof MusicCommandRecordSchema>;
export const DeviceMusicStateSchema = z.object({
  observed: MusicObservationValuesSchema,
  requested: z.object({
    playback: z.enum(['playing', 'paused']).optional(),
    volume: z.number().min(0).max(1).optional(),
    source: z.string().optional(),
  }),
  availability: z.enum(['available', 'unavailable']),
  observedAt: z.number().nonnegative().nullable(),
  observedProvenance: ProvenanceSchema.nullable(),
  allowedSources: z.array(z.string().min(1)),
});
export type DeviceMusicState = z.infer<typeof DeviceMusicStateSchema>;
export const MusicStateSchema = z.object({
  devices: z.record(SemanticMusicIdSchema, DeviceMusicStateSchema),
  commands: z.array(MusicCommandRecordSchema),
});
export type MusicState = z.infer<typeof MusicStateSchema>;

export const PresenceEventSchema = z.object({
  type: z.literal('presence.changed'),
  presence: PresenceSchema,
  personCount: z.number().int().nonnegative().nullable().optional(),
  occurredAt: z.number().nonnegative().optional(),
  source: z.string().optional(),
});
export type PresenceEvent = z.infer<typeof PresenceEventSchema>;

/** A temporary entry approach signal. It does not assert room occupancy. */
export const PrelightEventSchema = z.object({
  type: z.literal('presence.prelight'),
  active: z.boolean(),
  occurredAt: z.number().nonnegative().optional(),
  source: z.string().optional(),
});
export type PrelightEvent = z.infer<typeof PrelightEventSchema>;

export const PresenceInputEventSchema = z.union([
  PresenceEventSchema,
  PrelightEventSchema,
]);
export type PresenceInputEvent = z.infer<typeof PresenceInputEventSchema>;

export const SceneSchema = z.object({
  id: z.string().regex(/^scene\.[a-z0-9][a-z0-9._-]*$/),
  name: z.string().min(1),
  lighting: z.record(SemanticLightingIdSchema, LightingValuesSchema),
});
export type LightingScene = z.infer<typeof SceneSchema>;

export const OwnershipSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('scene'),
    revision: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('override'),
    actor: ActorSchema,
    source: z.string().optional(),
    reason: z.string(),
    createdAt: z.number().nonnegative(),
  }),
]);
export type Ownership = z.infer<typeof OwnershipSchema>;

export const DeviceLightingStateSchema = z.object({
  observed: LightingValuesSchema,
  baselineDesired: LightingValuesSchema,
  effectiveDesired: LightingValuesSchema,
  ownership: z.partialRecord(LightingPropertySchema, OwnershipSchema),
  availability: z.enum(['available', 'degraded', 'unavailable']),
});
export type DeviceLightingState = z.infer<typeof DeviceLightingStateSchema>;

export const CommandStatusSchema = z.enum([
  'pending',
  'confirmed',
  'superseded',
  'cancelled',
  'invalidated',
  'failed',
]);
export type CommandStatus = z.infer<typeof CommandStatusSchema>;

export const CommandRecordSchema = z.object({
  id: z.string(),
  target: z.string(),
  controller: z.string(),
  revision: z.number().int().nonnegative(),
  desired: LightingValuesSchema,
  issuedAt: z.number().nonnegative(),
  status: CommandStatusSchema,
  source: z.string(),
  requestId: z.string().optional(),
  reason: z.string(),
  actor: ActorSchema,
  confirmedProperties: z.array(LightingPropertySchema),
  confirmedAt: z.number().nonnegative().optional(),
  diagnosticReason: z.string().optional(),
});
export type CommandRecord = z.infer<typeof CommandRecordSchema>;

export const DiagnosticSchema = z.object({
  id: z.number().int().nonnegative(),
  at: z.number().nonnegative(),
  kind: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).default({}),
});
export type Diagnostic = z.infer<typeof DiagnosticSchema>;

export const FastPathTimingSchema = z.object({
  eventId: z.string(),
  eventReceivedAt: z.number().nonnegative(),
  decisionCompletedAt: z.number().nonnegative().optional(),
  commandDispatchedAt: z.number().nonnegative().optional(),
  feedbackObservedAt: z.number().nonnegative().optional(),
  fullConvergenceAt: z.number().nonnegative().optional(),
});
export type FastPathTiming = z.infer<typeof FastPathTimingSchema>;

export const RoomStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  updatedAt: z.number().nonnegative(),
  presence: z.object({
    state: PresenceSchema,
    personCount: z.number().int().nonnegative().nullable(),
    continuityExpiresAt: z.number().nonnegative().nullable(),
  }),
  lighting: z.object({
    currentScene: z.string().nullable(),
    sceneRevision: z.number().int().nonnegative(),
    devices: z.record(z.string(), DeviceLightingStateSchema),
  }),
  switches: SwitchStateSchema,
  music: MusicStateSchema,
  commands: z.array(CommandRecordSchema),
  diagnostics: z.array(DiagnosticSchema),
  timings: z.array(FastPathTimingSchema),
});
export type RoomState = z.infer<typeof RoomStateSchema>;

export const StateUpdateSchema = z.object({
  revision: z.number().int().positive(),
  at: z.number().nonnegative(),
  domains: z.array(
    z.enum([
      'presence',
      'lighting',
      'switches',
      'music',
      'commands',
      'diagnostics',
      'timings',
    ]),
  ),
  patch: z.object({
    presence: RoomStateSchema.shape.presence.optional(),
    lighting: RoomStateSchema.shape.lighting.optional(),
    switches: RoomStateSchema.shape.switches.optional(),
    music: RoomStateSchema.shape.music.optional(),
    commands: RoomStateSchema.shape.commands.optional(),
    diagnostics: RoomStateSchema.shape.diagnostics.optional(),
    timings: RoomStateSchema.shape.timings.optional(),
  }),
});
export type StateUpdate = z.infer<typeof StateUpdateSchema>;
