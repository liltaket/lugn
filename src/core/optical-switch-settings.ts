import { z } from 'zod';
import { ComputerDeviceIdSchema } from './computer.js';

/** `host`, `host:port`; IPv4 or a name, no URL, path or credentials. */
const HOST_PATTERN = /^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$/;

/**
 * A WiiM address the agent may be handed over MQTT: a private or link-local
 * IPv4 address, or a `.local` name, so a settings message can never point the
 * agent at the internet. The agent enforces the same rule.
 */
export function isLanHost(value: string): boolean {
  if (!HOST_PATTERN.test(value)) return false;
  const [name, port] = value.split(':') as [string, string | undefined];
  if (port !== undefined && !(Number(port) >= 1 && Number(port) <= 65_535))
    return false;
  const octets = name.split('.');
  if (
    octets.length === 4 &&
    octets.every((part) => /^[0-9]{1,3}$/.test(part))
  ) {
    const [a, b] = octets.map(Number) as [number, number];
    if (octets.some((part) => Number(part) > 255)) return false;
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  return name.length > 6 && name.endsWith('.local');
}

/**
 * What the control panel can change about a computer's fast WiiM Optical
 * switching. The `opticalSwitch` entry in the runtime configuration supplies the
 * defaults; saved values override them until the user resets. Lugn publishes
 * the effective values to the computer's agent (OPTICAL v1).
 */
export const OpticalSwitchSettingsSchema = z
  .object({
    /** Master switch: when off the agent leaves the WiiM alone. */
    enabled: z.boolean(),
    /** LAN address of the WiiM. null: the agent uses its own setting, then finds it. */
    wiimHost: z
      .string()
      .trim()
      .refine(isLanHost, 'A private IPv4 address or a .local name')
      .nullable(),
    /** Exact PipeWire sink the WiiM is wired to. null: the default sink. */
    audioSink: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,128}$/)
      .nullable(),
    /** Sustained sound needed before the switch. */
    minAudibleMs: z.number().int().min(200).max(5_000),
    /** Silence that ends a run of sound, so the next sound is a new decision. */
    releaseMs: z.number().int().min(500).max(10_000),
    /** Loudness a frame needs to count as sound, in dBFS. */
    levelDb: z.number().int().min(-80).max(-20),
  })
  .strict();
export type OpticalSwitchSettings = z.infer<typeof OpticalSwitchSettingsSchema>;

/** Used when the configuration does not say otherwise: on, with discovery. */
export function defaultOpticalSwitchSettings(): OpticalSwitchSettings {
  return {
    enabled: true,
    wiimHost: null,
    audioSink: null,
    minAudibleMs: 400,
    releaseMs: 1_500,
    levelDb: -55,
  };
}

export const OpticalSwitchSettingsFileSchema = z
  .object({
    version: z.literal(1),
    generation: z.uuid(),
    computers: z.record(ComputerDeviceIdSchema, OpticalSwitchSettingsSchema),
  })
  .strict();
export type OpticalSwitchSettingsFile = z.infer<
  typeof OpticalSwitchSettingsFileSchema
>;

export class OpticalSwitchSettingsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** The part of the file the service needs; implemented by the runtime store. */
export interface OpticalSwitchSettingsRepository {
  snapshot(): {
    generation: string;
    computers: Record<string, OpticalSwitchSettings>;
  };
  save(
    deviceId: string,
    settings: OpticalSwitchSettings | null,
    expectedGeneration: string,
  ): Promise<{ generation: string }>;
}
