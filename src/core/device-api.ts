import { z } from 'zod';
import { PhoneDeviceStateSchema } from './phone.js';

/**
 * Versioned contract for paired native clients (`/api/v1`). These schemas are
 * the source of docs/api/openapi.v1.yaml; change them deliberately and
 * regenerate the document with `npm run api:generate`.
 */
export const DEVICE_API_VERSION = 1 as const;

export const DeviceScopeSchema = z.enum([
  'state:read',
  'commands:write',
  'phone:ingest',
]);
export type DeviceScope = z.infer<typeof DeviceScopeSchema>;
export const AllDeviceScopes: readonly DeviceScope[] =
  DeviceScopeSchema.options;

export const DeviceIdSchema = z.string().regex(/^dev_[a-z2-7]{16}$/);
export const DevicePlatformSchema = z.enum(['ios']);

/** Printable, single-line labels; control characters never reach the panel. */
const LabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u);

/** Eight Crockford base32 characters, optionally grouped as XXXX-XXXX. */
export const PairingCodeSchema = z
  .string()
  .trim()
  .regex(
    /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{4}-?[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{4}$/,
  );

export const PairRequestSchema = z
  .object({
    code: PairingCodeSchema,
    name: LabelSchema,
    platform: DevicePlatformSchema,
    appVersion: z
      .string()
      .regex(/^[0-9A-Za-z.+-]{1,32}$/)
      .optional(),
  })
  .strict();
export type PairRequest = z.infer<typeof PairRequestSchema>;

export const PairResponseSchema = z
  .object({
    apiVersion: z.literal(DEVICE_API_VERSION),
    deviceId: DeviceIdSchema,
    /** Shown once. Lugn stores only its SHA-256 digest. */
    token: z.string().min(1),
    tokenType: z.literal('Bearer'),
    scopes: z.array(DeviceScopeSchema),
    issuedAt: z.number().int().nonnegative(),
  })
  .strict();
export type PairResponse = z.infer<typeof PairResponseSchema>;

export const DeviceSummarySchema = z
  .object({
    id: DeviceIdSchema,
    name: z.string(),
    platform: DevicePlatformSchema,
    appVersion: z.string().nullable(),
    scopes: z.array(DeviceScopeSchema),
    createdAt: z.number().int().nonnegative(),
    /** Process-local; it resets to null after a restart. */
    lastSeenAt: z.number().int().nonnegative().nullable(),
    revokedAt: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type DeviceSummary = z.infer<typeof DeviceSummarySchema>;

export const DeviceListResponseSchema = z
  .object({ devices: z.array(DeviceSummarySchema) })
  .strict();

export const PairingCodeRequestSchema = z
  .object({
    scopes: z
      .array(DeviceScopeSchema)
      .min(1)
      .refine((scopes) => new Set(scopes).size === scopes.length)
      .optional(),
    ttlSeconds: z.number().int().min(60).max(900).optional(),
  })
  .strict();
export type PairingCodeRequest = z.infer<typeof PairingCodeRequestSchema>;

export const PairingCodeResponseSchema = z
  .object({
    code: z.string(),
    expiresAt: z.number().int().nonnegative(),
    scopes: z.array(DeviceScopeSchema),
  })
  .strict();
export type PairingCodeResponse = z.infer<typeof PairingCodeResponseSchema>;

export const MeResponseSchema = z
  .object({
    apiVersion: z.literal(DEVICE_API_VERSION),
    device: z
      .object({
        id: DeviceIdSchema,
        name: z.string(),
        platform: DevicePlatformSchema,
        scopes: z.array(DeviceScopeSchema),
      })
      .strict(),
    serverTime: z.number().int().nonnegative(),
  })
  .strict();
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const ApiErrorSchema = z
  .object({
    error: z.string(),
    issues: z
      .array(z.object({ path: z.string(), message: z.string() }).strict())
      .optional(),
    retryAfterSeconds: z.number().int().positive().optional(),
  })
  .strict();
export type ApiError = z.infer<typeof ApiErrorSchema>;

const Time = z.number().nonnegative();
const NullableTime = Time.nullable();

export const PresenceViewSchema = z
  .object({
    /** Sensor ground truth; `unknown` is never treated as empty. */
    state: z.enum(['occupied', 'confirmed_empty', 'unknown']),
    personCount: z.number().int().nonnegative().nullable(),
    /** Exit grace countdown on the server clock, or null. */
    exitPending: z.object({ startedAt: Time, until: Time }).strict().nullable(),
    continuityExpiresAt: NullableTime,
    home: z
      .object({
        state: z.enum(['home', 'away', 'unknown']),
        observedAt: NullableTime,
      })
      .strict(),
  })
  .strict();

export const SessionViewSchema = z
  .object({
    state: z.enum(['active', 'suspended', 'ended', 'none']),
    startedAt: NullableTime,
    expiresAt: NullableTime,
  })
  .strict();

const LightValuesViewSchema = z
  .object({
    power: z.boolean().nullable(),
    brightness: z.number().int().min(0).max(100).nullable(),
    colorTemperature: z.number().int().nullable(),
    rgb: z
      .tuple([
        z.number().int().min(0).max(255),
        z.number().int().min(0).max(255),
        z.number().int().min(0).max(255),
      ])
      .nullable(),
  })
  .strict();

export const SceneViewSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** Semantic icon key for established scenes; null for user presets. */
    icon: z
      .enum(['power', 'moon', 'sun', 'desk-lamp', 'disco-ball', 'film'])
      .nullable(),
    /** Whether the preset can be edited in the Lugn control panel. */
    canEdit: z.boolean(),
    allOff: z.boolean(),
  })
  .strict();

export const LightViewSchema = z
  .object({
    id: z.string(),
    /** Derived from the semantic id; Lugn has no friendly light names. */
    name: z.string(),
    availability: z.enum(['available', 'degraded', 'unavailable']),
    observed: LightValuesViewSchema,
    /** Lugn's remembered effective intent, kept through a confirmed-empty off. */
    intent: LightValuesViewSchema,
    /** Null when there is no intent to compare. */
    matchesIntent: z.boolean().nullable(),
    /** Properties currently owned by a manual change rather than the scene. */
    overridden: z.array(
      z.enum(['power', 'brightness', 'colorTemperature', 'rgb']),
    ),
    externalControl: z.boolean(),
  })
  .strict();

export const LightingViewSchema = z
  .object({
    currentSceneId: z.string().nullable(),
    sceneRevision: z.number().int().nonnegative(),
    scenes: z.array(SceneViewSchema),
    lights: z.array(LightViewSchema),
  })
  .strict();

export const MusicTargetViewSchema = z
  .object({
    id: z.string(),
    availability: z.enum(['available', 'unavailable']),
    observedAt: NullableTime,
    observed: z
      .object({
        playback: z.enum(['playing', 'paused', 'idle', 'off', 'unknown']),
        volume: z.number().min(0).max(1).nullable(),
        source: z.string().nullable(),
        title: z.string().nullable(),
        artist: z.string().nullable(),
        album: z.string().nullable(),
      })
      .strict(),
    allowedSources: z.array(z.string()),
    presets: z.array(z.enum(['spotify_dj', 'optical'])),
    volume: z
      .object({
        /** Who currently controls volume: the resident or Lugn's policy. */
        controller: z.enum(['you', 'lugn']),
        mode: z.enum(['auto', 'manual']),
        policyEnabled: z.boolean(),
        policyActive: z.boolean(),
        activityReason: z.string(),
        target: z.number().nullable(),
        effectiveTarget: z.number().nullable(),
      })
      .strict()
      .nullable(),
    playback: z
      .object({
        activityReason: z.string(),
        /** 23:00–06:00 Stockholm: automatic playback never starts or resumes. */
        quietHours: z.boolean(),
        manualPause: z.boolean(),
        entryEligible: z.boolean(),
        resumeExpiresAt: NullableTime,
      })
      .strict()
      .nullable(),
    fade: z
      .object({
        targetVolume: z.number().min(0).max(1),
        status: z.string(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const MusicViewSchema = z
  .object({ targets: z.array(MusicTargetViewSchema) })
  .strict();

export const RoutinesViewSchema = z
  .object({
    generation: z.string().nullable(),
    next: z.array(
      z
        .object({
          routineId: z.string(),
          name: z.string(),
          kind: z.string(),
          at: Time,
        })
        .strict(),
    ),
    running: z.array(
      z
        .object({ routineId: z.string(), runId: z.string(), startedAt: Time })
        .strict(),
    ),
    bedtime: z
      .object({
        nightAvailable: z.boolean(),
        morningAvailable: z.boolean(),
        musicAvailable: z.boolean(),
        plan: z
          .object({
            at: Time,
            time: z.string(),
            mode: z.enum(['auto', 'button']),
            music: z.boolean(),
          })
          .strict()
          .nullable(),
        ready: z
          .object({ until: Time, music: z.boolean() })
          .strict()
          .nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .nullable();

const EnvironmentMetricViewSchema = z
  .object({
    value: z.number().nullable(),
    unit: z.string(),
    observedAt: NullableTime,
  })
  .strict();
export const EnvironmentViewSchema = z
  .object({
    temperature: EnvironmentMetricViewSchema,
    humidity: EnvironmentMetricViewSchema,
    co2: EnvironmentMetricViewSchema,
    pm25: EnvironmentMetricViewSchema,
  })
  .strict()
  .nullable();

export const SuggestionViewSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['scene', 'optical']),
    title: z.string(),
    reason: z.string(),
    sceneId: z.string().nullable(),
    createdAt: Time,
    expiresAt: Time,
  })
  .strict();

export const ComputerViewSchema = z
  .object({
    deviceId: z.string(),
    availability: z.enum(['online', 'offline', 'unknown']),
    freshness: z.enum(['fresh', 'stale', 'unknown']),
    activity: z.enum([
      'gaming',
      'video',
      'music',
      'desktop',
      'idle',
      'unknown',
    ]),
    locked: z.boolean().nullable(),
    idle: z.boolean().nullable(),
    fullscreen: z.boolean().nullable(),
    observedAt: NullableTime,
  })
  .strict();

export const HealthViewSchema = z
  .object({
    status: z.enum(['ok', 'degraded']),
    integrations: z.record(z.string(), z.string()),
  })
  .strict();

/** One plain-Swedish line explaining something Lugn did or deliberately did not do. */
export const WhyEntrySchema = z
  .object({
    id: z.string(),
    at: Time,
    domain: z.enum(['presence', 'lighting', 'music', 'home', 'system']),
    outcome: z.enum(['acted', 'skipped', 'observed', 'failed']),
    text: z.string(),
    /** What started it, for example `Närvarosensor`, `Telefon` or `Hub`. */
    trigger: z.string().nullable(),
    conditions: z.array(z.string()),
  })
  .strict();
export type WhyEntry = z.infer<typeof WhyEntrySchema>;

const PhoneFactStamp = { deviceId: z.string(), observedAt: Time };
/** Paired-phone hints. Never room presence; a missing signal is unknown. */
export const PhoneViewSchema = z
  .object({
    devices: z.array(PhoneDeviceStateSchema),
    /** Typed facts for bedtime and routines; nothing acts on them yet. */
    facts: z
      .object({
        wakeAlarm: z
          .object({ ...PhoneFactStamp, at: Time })
          .strict()
          .nullable(),
        focus: z
          .object({
            ...PhoneFactStamp,
            mode: z.enum(['sleep', 'dnd', 'other', 'none', 'unknown']),
          })
          .strict()
          .nullable(),
        charging: z
          .object({ ...PhoneFactStamp, charging: z.boolean() })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict();

export const StateViewSectionsSchema = z
  .object({
    presence: PresenceViewSchema,
    session: SessionViewSchema,
    lighting: LightingViewSchema,
    music: MusicViewSchema,
    routines: RoutinesViewSchema,
    environment: EnvironmentViewSchema,
    suggestions: z.array(SuggestionViewSchema),
    computer: z.array(ComputerViewSchema),
    phone: PhoneViewSchema,
    health: HealthViewSchema,
    why: z.array(WhyEntrySchema),
  })
  .strict();
export type StateViewSections = z.infer<typeof StateViewSectionsSchema>;
export type StateViewSection = keyof StateViewSections;
export const StateViewSectionNames = Object.keys(
  StateViewSectionsSchema.shape,
) as StateViewSection[];

export const StateViewSchema = StateViewSectionsSchema.extend({
  apiVersion: z.literal(DEVICE_API_VERSION),
  /** Changes on every server start; a different value means resync. */
  instanceId: z.string(),
  /** The engine revision this view was derived from. */
  revision: z.number().int().nonnegative(),
  generatedAt: Time,
}).strict();
export type StateView = z.infer<typeof StateViewSchema>;

/** SSE `patch` data: replace each listed section wholesale. */
export const StatePatchSchema = z
  .object({
    instanceId: z.string(),
    revision: z.number().int().nonnegative(),
    generatedAt: Time,
    sections: StateViewSectionsSchema.partial(),
  })
  .strict();
export type StatePatch = z.infer<typeof StatePatchSchema>;

export const HeartbeatEventSchema = z
  .object({
    instanceId: z.string(),
    revision: z.number().int().nonnegative(),
    serverTime: Time,
  })
  .strict();

/** Capabilities a paired phone may invoke; sensor and settings tools are excluded. */
export const DeviceCommandNames = [
  'lighting.activateScene',
  'lighting.reapplyScene',
  'lighting.set',
  'lighting.adjust',
  'music.play',
  'music.pause',
  'music.setVolume',
  'music.fadeVolume',
  'music.cancelFade',
  'music.selectSource',
  'music.playPreset',
  'music.setVolumeAuthority',
  'switch.set',
  'presence.setCountOne',
  'routines.bedtime',
  'routines.action',
  'suggestions.respond',
] as const;
export const DeviceCommandNameSchema = z.enum(DeviceCommandNames);
export type DeviceCommandName = z.infer<typeof DeviceCommandNameSchema>;

export const CommandRequestSchema = z
  .object({
    /** Client-generated UUID; retries with the same id and body are idempotent. */
    requestId: z.uuid(),
    command: DeviceCommandNameSchema,
    input: z.record(z.string(), z.unknown()).default({}),
    reason: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type CommandRequest = z.infer<typeof CommandRequestSchema>;

export const CommandResponseSchema = z
  .object({
    requestId: z.uuid(),
    command: DeviceCommandNameSchema,
    /**
     * `accepted`: Lugn took the intent; watch state for device feedback.
     * `confirmed`: the capability already observed matching feedback.
     */
    status: z.enum(['accepted', 'confirmed']),
    /** True when this is the stored answer to an earlier identical request. */
    replayed: z.boolean(),
    /** The capability's own typed output. */
    result: z.unknown(),
    /** Engine revision right after the command returned. */
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type CommandResponse = z.infer<typeof CommandResponseSchema>;
