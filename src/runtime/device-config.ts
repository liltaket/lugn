import { isIP } from 'node:net';
import { z } from 'zod';
import {
  PhoneSignalSettingsSchema,
  PhoneSignalWindows,
  PhoneZoneIdSchema,
  type PhoneConfigResponseSchema,
} from '../core/phone.js';

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::']);

/** An exact `host:port` value a client sends in its Host header. */
const AllowedHostSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => {
    try {
      const url = new URL(`http://${value}`);
      return (
        url.host === value.toLowerCase() &&
        url.port !== '' &&
        url.pathname === '/' &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, 'allowedHosts entries must be host:port values without paths or credentials');

/**
 * Optional listener for paired native clients. The section is absent by
 * default; when present it must name an explicit interface address, port and
 * Host allowlist, and `enabled` must be true for the listener to start.
 */
export const DeviceApiConfigSchema = z
  .object({
    enabled: z.boolean(),
    /** An IP literal for the Tailscale or LAN interface (or loopback for tests). */
    host: z
      .string()
      .refine(
        (value) => isIP(value.replace(/^\[|\]$/g, '')) !== 0,
        'device.host must be an IP address',
      ),
    port: z.number().int().min(1).max(65_535),
    /** Binding 0.0.0.0 or :: must be requested explicitly. */
    allowAllInterfaces: z.boolean().default(false),
    allowedHosts: z.array(AllowedHostSchema).min(1).max(8),
    /** Paired-phone hints; every signal can be switched off server-side. */
    phone: z
      .object({
        signals: PhoneSignalSettingsSchema.prefault({}),
        /** Older device timestamps are rejected as stale. */
        maxObservationAgeSeconds: z
          .number()
          .int()
          .min(60)
          .max(86_400)
          .default(21_600),
        /**
         * A recent geofence arrival lets the sensor's prelight run while
         * Home Assistant still reports away. Off unless enabled.
         */
        arrivalPrelight: z
          .object({
            enabled: z.boolean().default(false),
            zoneId: PhoneZoneIdSchema.default('home'),
            windowSeconds: z.number().int().min(60).max(1_800).default(600),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .superRefine((config, context) => {
    const host = config.host.replace(/^\[|\]$/g, '');
    if (WILDCARD_HOSTS.has(host) && !config.allowAllInterfaces)
      context.addIssue({
        code: 'custom',
        path: ['host'],
        message:
          'device.host must name one interface; set allowAllInterfaces to bind every interface',
      });
    for (const [index, value] of config.allowedHosts.entries()) {
      let port = '';
      try {
        port = new URL(`http://${value}`).port;
      } catch {
        continue;
      }
      if (Number(port) !== config.port)
        context.addIssue({
          code: 'custom',
          path: ['allowedHosts', index],
          message: 'allowedHosts ports must match device.port',
        });
    }
  });
export type DeviceApiConfig = z.output<typeof DeviceApiConfigSchema>;

/** What the app may collect, sent so it never gathers disabled signals. */
export function phoneConfigResponse(
  phone: DeviceApiConfig['phone'],
): z.infer<typeof PhoneConfigResponseSchema> {
  return {
    signals: { ...phone.signals },
    maxObservationAgeSeconds: phone.maxObservationAgeSeconds,
    maxBatchSize: 100,
    windows: Object.fromEntries(
      Object.entries(PhoneSignalWindows).map(([name, window]) => [
        name,
        {
          freshSeconds: window.freshMs / 1000,
          retainSeconds: window.retainMs / 1000,
        },
      ]),
    ) as z.infer<typeof PhoneConfigResponseSchema>['windows'],
  };
}
