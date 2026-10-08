import { z } from 'zod';

export const PresenceSchema = z.enum([
  'occupied',
  'confirmed_empty',
  'unknown',
]);
export type Presence = z.infer<typeof PresenceSchema>;

export const HomePresenceSchema = z.enum(['home', 'away', 'unknown']);
export type HomePresence = z.infer<typeof HomePresenceSchema>;

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

export const AutomationHoldSchema = z.object({
  scope: z.enum(['music.playback', 'lighting.activation', 'lighting.property']),
  target: z.string(),
  property: z.enum(['power', 'brightness', 'colorTemperature']).optional(),
  intent: z.union([
    z.literal('paused'),
    z.literal('off'),
    z.boolean(),
    z.number(),
  ]),
  provenance: ProvenanceSchema,
  createdAt: z.number().nonnegative(),
  resetPolicy: z.enum([
    'explicit_playback',
    'explicit_lighting',
    'lighting_continuity',
  ]),
});
export type AutomationHold = z.infer<typeof AutomationHoldSchema>;

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

export const LightingControlModesSchema = z.record(
  SemanticLightingIdSchema,
  z.enum(['respect_manual', 'enforce']),
);
export type LightingControlModes = z.infer<typeof LightingControlModesSchema>;

export const SemanticSwitchIdSchema = z
  .string()
  .regex(/^switch\.[a-z0-9][a-z0-9._-]*$/);

export const SemanticButtonIdSchema = z
  .string()
  .regex(/^button\.[a-z0-9][a-z0-9._-]*$/);

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
export const MusicPresetSchema = z.enum(['spotify_dj', 'optical']);
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
  z
    .object({ property: z.literal('preset'), value: MusicPresetSchema })
    .strict(),
]);
export type MusicRequest = z.infer<typeof MusicRequestSchema>;
export const MusicFadeRequestSchema = z
  .object({
    target: SemanticMusicIdSchema,
    volume: z.number().min(0).max(1),
    durationMs: z.number().int().min(1_000).max(120_000),
  })
  .strict();
export type MusicFadeRequest = z.infer<typeof MusicFadeRequestSchema>;
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
    preset: MusicPresetSchema.optional(),
  }),
  availability: z.enum(['available', 'unavailable']),
  observedAt: z.number().nonnegative().nullable(),
  observedProvenance: ProvenanceSchema.nullable(),
  allowedSources: z.array(z.string().min(1)),
});
export type DeviceMusicState = z.infer<typeof DeviceMusicStateSchema>;
export const MusicFadeStatusSchema = z.enum([
  'active',
  'settling',
  'completed',
  'cancelled',
  'interrupted',
  'failed',
  'unconfirmed',
]);
export const MusicFadeStateSchema = z.object({
  id: z.string(),
  target: SemanticMusicIdSchema,
  startVolume: z.number().min(0).max(1),
  targetVolume: z.number().min(0).max(1),
  durationMs: z.number().int().positive(),
  startedAt: z.number().nonnegative(),
  expectedVolume: z.number().min(0).max(1),
  observedVolume: z.number().min(0).max(1).nullable(),
  issuedVolume: z.number().min(0).max(1).nullable(),
  status: MusicFadeStatusSchema,
  settlingUntil: z.number().nonnegative().optional(),
  diagnosticReason: z.string().optional(),
});
export type MusicFadeState = z.infer<typeof MusicFadeStateSchema>;
export const MusicVolumeActivityReasonSchema = z.enum([
  'manual_hold',
  'automation_disabled',
  'presence_unknown',
  'confirmed_empty',
  'home_away',
  'fade_active',
  'volume_unavailable',
  'active',
]);
export const MusicPlaybackActivityReasonSchema = z.enum([
  'manual_pause',
  'home_away',
  'quiet_hours',
  'presence_unknown',
  'confirmed_empty',
  'player_unavailable',
  'already_playing',
  'awaiting_new_entry',
]);
export type MusicPlaybackActivityReason = z.infer<
  typeof MusicPlaybackActivityReasonSchema
>;
export const MusicVolumeChangeSchema = z.object({
  volume: z.number().finite().min(0).max(1),
  observedAt: z.number().finite().nonnegative(),
  provenance: ProvenanceSchema,
  attribution: z.enum(['correlated', 'matched', 'external']),
});
export type MusicVolumeChange = z.infer<typeof MusicVolumeChangeSchema>;
export const MusicDecisionSchema = z.object({
  target: SemanticMusicIdSchema,
  at: z.number().finite().nonnegative(),
  reason: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('volume'),
      value: MusicVolumeActivityReasonSchema,
    }),
    z.object({
      kind: z.literal('playback'),
      value: MusicPlaybackActivityReasonSchema,
    }),
  ]),
  owner: z.enum(['manual', 'lugn', 'none']),
  policyEnabled: z.boolean(),
  manualExpiresAt: z.number().finite().nonnegative().nullable(),
  resumeExpiresAt: z.number().finite().nonnegative().nullable(),
});
export type MusicDecision = z.infer<typeof MusicDecisionSchema>;
export const MusicStateSchema = z.object({
  devices: z.record(SemanticMusicIdSchema, DeviceMusicStateSchema),
  commands: z.array(MusicCommandRecordSchema),
  fades: z.record(SemanticMusicIdSchema, MusicFadeStateSchema).default({}),
  volumeChanges: z
    .record(SemanticMusicIdSchema, MusicVolumeChangeSchema)
    .optional(),
  decisions: z.array(MusicDecisionSchema).max(128).optional(),
});
export type MusicState = z.infer<typeof MusicStateSchema>;

const PersistedHumanMusicProvenanceSchema = ProvenanceSchema.extend({
  actor: ActorSchema.strict(),
})
  .strict()
  .refine((provenance) =>
    ['user', 'physical_remote', 'home_assistant'].includes(
      provenance.actor.type,
    ),
  );

export const ManualVolumeHoldSchema = z
  .object({
    volume: z.number().finite().min(0).max(1),
    createdAt: z.number().finite().nonnegative(),
    expiresAt: z.number().finite().nonnegative().nullable(),
    provenance: PersistedHumanMusicProvenanceSchema,
  })
  .strict()
  .refine(
    (hold) => hold.expiresAt === null || hold.expiresAt >= hold.createdAt,
  );
export type ManualVolumeHold = z.infer<typeof ManualVolumeHoldSchema>;

export const MusicPauseIntentSchema = z
  .object({
    createdAt: z.number().finite().nonnegative(),
    provenance: PersistedHumanMusicProvenanceSchema,
  })
  .strict();
export type MusicPauseIntent = z.infer<typeof MusicPauseIntentSchema>;

/** Logical intent and absolute continuity deadlines; no observations, commands or fades. */
export const MusicIntentSnapshotSchema = z
  .object({
    version: z.literal(1),
    volumeAutomationEnabled: z.boolean(),
    temporaryVolumeAutomationRestore: z.boolean().nullable(),
    confirmedAbsence: z.boolean(),
    absenceExpiresAt: z.number().finite().nonnegative().nullable(),
    targets: z.record(
      SemanticMusicIdSchema,
      z
        .object({
          baseline: z.number().finite().min(0).max(1).nullable(),
          baselineSource: z.enum(['user', 'inferred', 'unknown']),
          lastIntentActor: z.enum(['manual', 'lugn', 'unknown']),
          manualVolume: ManualVolumeHoldSchema.nullable(),
          pause: MusicPauseIntentSchema.nullable(),
          resumeUntil: z.number().finite().nonnegative(),
        })
        .strict()
        .refine(
          (target) =>
            (target.baseline === null) ===
              (target.baselineSource === 'unknown') &&
            (target.pause === null || target.resumeUntil === 0),
        ),
    ),
  })
  .strict()
  .refine(
    (snapshot) =>
      snapshot.confirmedAbsence === (snapshot.absenceExpiresAt !== null) &&
      Object.values(snapshot.targets).every(
        (target) =>
          snapshot.confirmedAbsence ||
          (target.manualVolume?.expiresAt == null && target.resumeUntil === 0),
      ),
  );
export type MusicIntentSnapshot = z.infer<typeof MusicIntentSnapshotSchema>;

export const PresenceEventSchema = z.object({
  type: z.literal('presence.changed'),
  presence: PresenceSchema,
  personCount: z.number().int().nonnegative().nullable().optional(),
  occurredAt: z.number().nonnegative().optional(),
  source: z.string().optional(),
  /** Local process receipt metadata; never populated from the sensor payload. */
  localReceivedMonotonicAt: z.number().finite().nonnegative().optional(),
});
export type PresenceEvent = z.infer<typeof PresenceEventSchema>;

/** A temporary entry approach signal. It does not assert room occupancy. */
export const PrelightEventSchema = z.object({
  type: z.literal('presence.prelight'),
  active: z.boolean(),
  occurredAt: z.number().nonnegative().optional(),
  source: z.string().optional(),
  /** Local process receipt metadata; never populated from the sensor payload. */
  localReceivedMonotonicAt: z.number().finite().nonnegative().optional(),
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

const PersistedLightingOwnershipSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('scene'),
      revision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('override'),
      actor: ActorSchema.strict(),
      source: z.string().optional(),
      reason: z.string(),
      createdAt: z.number().finite().nonnegative(),
    })
    .strict(),
]);

/** The durable subset of lighting state. Observations and commands are excluded. */
export const LightingIntentSnapshotSchema = z
  .object({
    currentScene: z
      .string()
      .regex(/^scene\.[a-z0-9][a-z0-9._-]*$/)
      .nullable(),
    sceneRevision: z.number().int().nonnegative(),
    continuityExpiresAt: z.number().finite().nonnegative().nullable(),
    devices: z.record(
      SemanticLightingIdSchema,
      z
        .object({
          baselineDesired: LightingValuesSchema.strict(),
          effectiveDesired: LightingValuesSchema.strict(),
          ownership: z.partialRecord(
            LightingPropertySchema,
            PersistedLightingOwnershipSchema,
          ),
        })
        .strict(),
    ),
  })
  .strict();
export type LightingIntentSnapshot = z.infer<
  typeof LightingIntentSnapshotSchema
>;

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
  eventToDecisionMs: z.number().finite().nonnegative().optional(),
  eventToFirstDispatchMs: z.number().finite().nonnegative().optional(),
  eventToFirstFeedbackMs: z.number().finite().nonnegative().optional(),
  eventToFullConvergenceMs: z.number().finite().nonnegative().optional(),
});
export type FastPathTiming = z.infer<typeof FastPathTimingSchema>;

export const RoomSessionSchema = z.object({
  id: z.string().uuid(),
  state: z.enum(['active', 'suspended', 'ended']),
  startedAt: z.number().nonnegative(),
  lastActiveAt: z.number().nonnegative(),
  suspendedAt: z.number().nonnegative().nullable(),
  expiresAt: z.number().nonnegative().nullable(),
  endedAt: z.number().nonnegative().nullable(),
});
export type RoomSession = z.infer<typeof RoomSessionSchema>;

export const RoomStateSchema = z.object({
  revision: z.number().int().nonnegative(),
  updatedAt: z.number().nonnegative(),
  session: RoomSessionSchema.nullable(),
  presence: z.object({
    state: PresenceSchema,
    personCount: z.number().int().nonnegative().nullable(),
    continuityExpiresAt: z.number().nonnegative().nullable(),
    home: z.object({
      state: HomePresenceSchema,
      observedAt: z.number().nonnegative().nullable(),
    }),
  }),
  lighting: z.object({
    currentScene: z.string().nullable(),
    sceneRevision: z.number().int().nonnegative(),
    devices: z.record(z.string(), DeviceLightingStateSchema),
  }),
  switches: SwitchStateSchema,
  music: MusicStateSchema,
  intent: z
    .object({ holds: z.array(AutomationHoldSchema) })
    .default({ holds: [] }),
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
      'session',
      'lighting',
      'switches',
      'music',
      'intent',
      'commands',
      'diagnostics',
      'timings',
    ]),
  ),
  patch: z.object({
    presence: RoomStateSchema.shape.presence.optional(),
    session: RoomStateSchema.shape.session.optional(),
    lighting: RoomStateSchema.shape.lighting.optional(),
    switches: RoomStateSchema.shape.switches.optional(),
    music: RoomStateSchema.shape.music.optional(),
    intent: RoomStateSchema.shape.intent.removeDefault().optional(),
    commands: RoomStateSchema.shape.commands.optional(),
    diagnostics: RoomStateSchema.shape.diagnostics.optional(),
    timings: RoomStateSchema.shape.timings.optional(),
  }),
});
export type StateUpdate = z.infer<typeof StateUpdateSchema>;
