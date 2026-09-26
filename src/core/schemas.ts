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

export const PresenceEventSchema = z.object({
  type: z.literal('presence.changed'),
  presence: PresenceSchema,
  personCount: z.number().int().nonnegative().nullable().optional(),
  occurredAt: z.number().nonnegative().optional(),
  source: z.string().optional(),
});
export type PresenceEvent = z.infer<typeof PresenceEventSchema>;

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
  commands: z.array(CommandRecordSchema),
  diagnostics: z.array(DiagnosticSchema),
  timings: z.array(FastPathTimingSchema),
});
export type RoomState = z.infer<typeof RoomStateSchema>;

export const StateUpdateSchema = z.object({
  revision: z.number().int().positive(),
  at: z.number().nonnegative(),
  domains: z.array(
    z.enum(['presence', 'lighting', 'commands', 'diagnostics', 'timings']),
  ),
  patch: z.object({
    presence: RoomStateSchema.shape.presence.optional(),
    lighting: RoomStateSchema.shape.lighting.optional(),
    commands: RoomStateSchema.shape.commands.optional(),
    diagnostics: RoomStateSchema.shape.diagnostics.optional(),
    timings: RoomStateSchema.shape.timings.optional(),
  }),
});
export type StateUpdate = z.infer<typeof StateUpdateSchema>;
