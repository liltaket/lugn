import { z } from 'zod';

/**
 * Phone observations are hints about the resident, never room presence.
 * The LiDAR sensor stays the only source of occupied / confirmed_empty, and
 * a missing or expired signal is unknown, not false.
 */
export const PhoneSignalNames = [
  'app',
  'geofence',
  'power',
  'focus',
  'wakeAlarm',
  'motion',
  'network',
] as const;
export const PhoneSignalNameSchema = z.enum(PhoneSignalNames);
export type PhoneSignalName = z.infer<typeof PhoneSignalNameSchema>;

const PhoneDeviceIdSchema = z.string().regex(/^dev_[a-z2-7]{16}$/);
export const PhoneZoneIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
const Time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const Envelope = {
  /** Client UUID; resending the same event is a harmless duplicate. */
  eventId: z.uuid(),
  /** Increments per app session (see the batch `sessionId`). */
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  /** Device clock, milliseconds since the Unix epoch. */
  observedAt: Time,
};

export const PhoneObservationSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...Envelope,
      type: z.literal('app'),
      state: z.enum(['foreground', 'background', 'heartbeat']),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('geofence'),
      zoneId: PhoneZoneIdSchema,
      transition: z.enum(['enter', 'exit']),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('power'),
      charging: z.boolean().nullable(),
      batteryLevel: z.number().min(0).max(1).nullable(),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('focus'),
      mode: z.enum(['sleep', 'dnd', 'other', 'none', 'unknown']),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('wake_alarm'),
      /** Next wake time, or null when no alarm is set. */
      at: Time.nullable(),
      source: z.enum(['sleep_schedule', 'shortcut', 'manual', 'unknown']),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('motion'),
      activity: z.enum([
        'stationary',
        'walking',
        'running',
        'cycling',
        'automotive',
        'unknown',
      ]),
      confidence: z.enum(['low', 'medium', 'high']),
    })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('network'),
      kind: z.enum(['wifi', 'cellular', 'none', 'unknown']),
      /** The app's own judgement; SSIDs never leave the phone. */
      homeNetwork: z.boolean().nullable(),
    })
    .strict(),
]);
export type PhoneObservation = z.infer<typeof PhoneObservationSchema>;

export const PhoneObservationBatchSchema = z
  .object({
    /** A UUID per app launch; sequences restart with a new session. */
    sessionId: z.uuid(),
    observations: z.array(PhoneObservationSchema).min(1).max(100),
  })
  .strict();
export type PhoneObservationBatch = z.infer<typeof PhoneObservationBatchSchema>;

export const PhoneObservationResultSchema = z
  .object({
    eventId: z.string(),
    status: z.enum([
      'applied',
      'duplicate',
      'superseded',
      'rejected',
      'ignored',
    ]),
    reason: z
      .enum([
        'stale',
        'future_timestamp',
        'sequence_reused',
        'signal_disabled',
        'older_than_current',
      ])
      .optional(),
  })
  .strict();
export const PhoneObservationResponseSchema = z
  .object({
    serverTime: Time,
    results: z.array(PhoneObservationResultSchema),
  })
  .strict();
export type PhoneObservationResponse = z.infer<
  typeof PhoneObservationResponseSchema
>;

const Stamp = {
  observedAt: Time,
  receivedAt: Time,
  /** Within the signal's freshness window on the server clock. */
  fresh: z.boolean(),
};
export const PhoneDeviceStateSchema = z
  .object({
    deviceId: PhoneDeviceIdSchema,
    name: z.string(),
    /** Server receipt time of the last accepted batch. */
    lastSeenAt: Time.nullable(),
    signals: z
      .object({
        app: z
          .object({
            ...Stamp,
            state: z.enum(['foreground', 'background', 'heartbeat']),
          })
          .strict()
          .nullable(),
        geofence: z.record(
          PhoneZoneIdSchema,
          z.object({ ...Stamp, inside: z.boolean() }).strict(),
        ),
        power: z
          .object({
            ...Stamp,
            charging: z.boolean().nullable(),
            batteryLevel: z.number().min(0).max(1).nullable(),
          })
          .strict()
          .nullable(),
        focus: z
          .object({
            ...Stamp,
            mode: z.enum(['sleep', 'dnd', 'other', 'none', 'unknown']),
          })
          .strict()
          .nullable(),
        wakeAlarm: z
          .object({
            ...Stamp,
            at: Time.nullable(),
            source: z.enum(['sleep_schedule', 'shortcut', 'manual', 'unknown']),
          })
          .strict()
          .nullable(),
        motion: z
          .object({
            ...Stamp,
            activity: z.enum([
              'stationary',
              'walking',
              'running',
              'cycling',
              'automotive',
              'unknown',
            ]),
            confidence: z.enum(['low', 'medium', 'high']),
          })
          .strict()
          .nullable(),
        network: z
          .object({
            ...Stamp,
            kind: z.enum(['wifi', 'cellular', 'none', 'unknown']),
            homeNetwork: z.boolean().nullable(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict();
export type PhoneDeviceState = z.infer<typeof PhoneDeviceStateSchema>;
export const PhoneStateSchema = z.object({
  devices: z.record(PhoneDeviceIdSchema, PhoneDeviceStateSchema),
});
export type PhoneState = z.infer<typeof PhoneStateSchema>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** How long a signal counts as current, and when it is forgotten entirely. */
export const PhoneSignalWindows: Record<
  PhoneSignalName,
  { freshMs: number; retainMs: number }
> = {
  app: { freshMs: 10 * MINUTE, retainMs: 24 * HOUR },
  geofence: { freshMs: 30 * MINUTE, retainMs: 24 * HOUR },
  power: { freshMs: 2 * HOUR, retainMs: 24 * HOUR },
  focus: { freshMs: 12 * HOUR, retainMs: 24 * HOUR },
  wakeAlarm: { freshMs: 36 * HOUR, retainMs: 36 * HOUR },
  motion: { freshMs: 10 * MINUTE, retainMs: HOUR },
  network: { freshMs: 30 * MINUTE, retainMs: 6 * HOUR },
};
/** A wake alarm is no longer meaningful this long after it rang. */
export const WAKE_ALARM_GRACE_MS = 2 * HOUR;

export const PhoneSignalSettingsSchema = z
  .object({
    app: z.boolean().default(true),
    geofence: z.boolean().default(true),
    power: z.boolean().default(true),
    focus: z.boolean().default(true),
    wakeAlarm: z.boolean().default(true),
    motion: z.boolean().default(false),
    network: z.boolean().default(false),
  })
  .strict();
export type PhoneSignalSettings = z.output<typeof PhoneSignalSettingsSchema>;

export const PhoneConfigResponseSchema = z
  .object({
    signals: z.record(PhoneSignalNameSchema, z.boolean()),
    maxObservationAgeSeconds: z.number().int().positive(),
    maxBatchSize: z.number().int().positive(),
    windows: z.record(
      PhoneSignalNameSchema,
      z
        .object({
          freshSeconds: z.number().int().positive(),
          retainSeconds: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();

/**
 * Narrow, typed facts for bedtime and routines. They are only exposed; no
 * routine or bedtime behaviour consumes them yet.
 */
export type PhoneFacts = {
  wakeAlarm: { at: number; deviceId: string; observedAt: number } | null;
  focus: {
    mode: 'sleep' | 'dnd' | 'other' | 'none' | 'unknown';
    deviceId: string;
    observedAt: number;
  } | null;
  charging: { charging: boolean; deviceId: string; observedAt: number } | null;
};

export function phoneFacts(state: PhoneState, now: number): PhoneFacts {
  let wakeAlarm: PhoneFacts['wakeAlarm'] = null;
  let focus: PhoneFacts['focus'] = null;
  let charging: PhoneFacts['charging'] = null;
  for (const device of Object.values(state.devices)) {
    const alarm = device.signals.wakeAlarm;
    if (
      alarm?.fresh &&
      alarm.at !== null &&
      alarm.at + WAKE_ALARM_GRACE_MS > now &&
      (wakeAlarm === null || alarm.at < wakeAlarm.at)
    )
      wakeAlarm = {
        at: alarm.at,
        deviceId: device.deviceId,
        observedAt: alarm.observedAt,
      };
    const mode = device.signals.focus;
    if (
      mode?.fresh &&
      mode.mode !== 'unknown' &&
      (focus === null || mode.observedAt > focus.observedAt)
    )
      focus = {
        mode: mode.mode,
        deviceId: device.deviceId,
        observedAt: mode.observedAt,
      };
    const power = device.signals.power;
    if (
      power?.fresh &&
      power.charging !== null &&
      (charging === null || power.observedAt > charging.observedAt)
    )
      charging = {
        charging: power.charging,
        deviceId: device.deviceId,
        observedAt: power.observedAt,
      };
  }
  return { wakeAlarm, focus, charging };
}

export function emptyPhoneSignals(): PhoneDeviceState['signals'] {
  return {
    app: null,
    geofence: {},
    power: null,
    focus: null,
    wakeAlarm: null,
    motion: null,
    network: null,
  };
}
