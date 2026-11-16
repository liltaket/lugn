import { z } from 'zod';

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
