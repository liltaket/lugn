import { z } from 'zod';
import { systemClock, type Clock, type TimerHandle } from '../core/clock.js';
import { ComputerDeviceIdSchema } from '../core/computer.js';
import type { OpticalSwitchSettings } from '../core/optical-switch-settings.js';
import type { PresenceMqttSubscriber } from '../runtime/mqttjs-subscriber.js';

const Integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Generation = z.string().regex(/^[0-9a-fA-F-]{1,36}$/);

/** OPTICAL v1 `optical/state`, published by the computer's agent. */
export const ComputerOpticalStateSchema = z.strictObject({
  schema_version: z.literal(1),
  device_id: ComputerDeviceIdSchema,
  sequence: Integer.min(1),
  timestamp_ms: Integer,
  heartbeat_interval_ms: Integer.min(5_000).max(300_000),
  phase: z.enum(['disabled', 'searching', 'idle', 'sound']),
  capture: z.enum(['off', 'ok', 'unavailable']),
  host: z.string().max(260).nullable(),
  host_source: z.enum(['config', 'lugn', 'discovered']).nullable(),
  wiim: z
    .strictObject({
      reachable: z.boolean(),
      optical: z.boolean().nullable(),
      playing: z.boolean().nullable(),
    })
    .nullable(),
  /** LinkPlay devices the agent found when it searched. */
  discovered: z.array(z.string().max(64)).max(8),
  last_switch: z
    .strictObject({
      outcome: z.enum(['switched', 'failed']),
      timestamp_ms: Integer,
      latency_ms: Integer,
    })
    .nullable(),
  settings_source: z.enum(['config', 'lugn']),
  settings_generation: Generation.nullable(),
});
export type ComputerOpticalState = z.infer<typeof ComputerOpticalStateSchema>;

/** What the control panel shows about a computer's optical switching. */
export type ComputerOpticalAgentStatus = {
  /** `live`: a state from this broker connection, recent. `stale`: only an old or retained one. */
  contact: 'live' | 'stale' | 'none';
  receivedAt: number | null;
  state: {
    phase: ComputerOpticalState['phase'];
    capture: ComputerOpticalState['capture'];
    host: string | null;
    hostSource: ComputerOpticalState['host_source'];
    wiim: ComputerOpticalState['wiim'];
    discovered: string[];
    lastSwitch: {
      outcome: 'switched' | 'failed';
      at: number;
      latencyMs: number;
    } | null;
    settingsSource: ComputerOpticalState['settings_source'];
    settingsGeneration: string | null;
  } | null;
};

export type ComputerOpticalMqttPort = PresenceMqttSubscriber & {
  publish(
    topic: string,
    payload: string,
    options: { qos: 1; retain: boolean },
    signal?: AbortSignal,
  ): Promise<void>;
};

export type ComputerOpticalMqttOptions = {
  deviceId: string;
  baseTopic?: string;
  mqtt: ComputerOpticalMqttPort;
  /** The effective settings and the generation to publish them under. */
  settings: () =>
    { settings: OpticalSwitchSettings; generation: string } | undefined;
  maxAgeMs?: number;
  clock?: Clock;
  onChange?: () => void;
  onWarning?: (message: string) => void;
};

/**
 * OPTICAL v1 transport. Lugn publishes the effective settings retained so the
 * agent has them as soon as it connects, and shows what the agent reports back.
 * Nothing here decides anything: the agent switches the WiiM by itself.
 */
export class ComputerOpticalMqttAdapter {
  private readonly topic: string;
  private readonly clock: Clock;
  private readonly maxAgeMs: number;
  private active = false;
  private connected = false;
  private state: ComputerOpticalState | undefined;
  private receivedAt: number | null = null;
  private live = false;
  private expiryTimer: TimerHandle | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: ComputerOpticalMqttOptions) {
    ComputerDeviceIdSchema.parse(options.deviceId);
    const prefix = (options.baseTopic ?? 'lugn/computers').replace(/\/+$/, '');
    if (!prefix || /[+#\0]/.test(prefix))
      throw new Error('Computer optical prefix must be a concrete topic');
    this.topic = `${prefix}/${options.deviceId}/optical`;
    this.clock = options.clock ?? systemClock;
    this.maxAgeMs = options.maxAgeMs ?? 90_000;
    if (
      !Number.isSafeInteger(this.maxAgeMs) ||
      this.maxAgeMs < 1_000 ||
      this.maxAgeMs > 300_000
    )
      throw new Error(
        'Computer optical maximum age must be between 1000 and 300000 ms',
      );
    if (options.onChange) this.listeners.add(options.onChange);
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    try {
      this.unsubscribe = this.options.mqtt.subscribe(
        `${this.topic}/state`,
        { qos: 1 },
        (topic, payload, metadata) => {
          if (
            !this.active ||
            !this.connected ||
            topic !== `${this.topic}/state`
          )
            return;
          this.receive(payload, metadata.retain);
        },
      );
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(): void {
    this.active = false;
    this.connected = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.invalidate();
  }

  /** The broker connection changed; a new one gets the settings again. */
  setBrokerConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    if (connected) void this.publishSettings();
    else this.invalidate();
  }

  /** Publishes the effective settings, retained. Called when they change. */
  async publishSettings(): Promise<void> {
    if (!this.active || !this.connected) return;
    const effective = this.options.settings();
    if (!effective) return;
    const { settings, generation } = effective;
    const payload = JSON.stringify({
      schema_version: 1,
      device_id: this.options.deviceId,
      generation,
      enabled: settings.enabled,
      wiim_host: settings.wiimHost,
      audio_sink: settings.audioSink,
      min_audible_ms: settings.minAudibleMs,
      release_ms: settings.releaseMs,
      level_db: settings.levelDb,
    });
    try {
      await this.options.mqtt.publish(`${this.topic}/settings`, payload, {
        qos: 1,
        retain: true,
      });
    } catch {
      // The broker may be down or the computer's ACL missing; the next
      // connection or change publishes again.
      this.options.onWarning?.(
        `Optical settings for ${this.options.deviceId} could not be published`,
      );
    }
  }

  status(): ComputerOpticalAgentStatus {
    const state = this.state;
    if (!state) return { contact: 'none', receivedAt: null, state: null };
    return {
      contact: this.active && this.connected && this.live ? 'live' : 'stale',
      receivedAt: this.receivedAt,
      state: {
        phase: state.phase,
        capture: state.capture,
        host: state.host,
        hostSource: state.host_source,
        wiim: state.wiim,
        discovered: [...state.discovered],
        lastSwitch: state.last_switch
          ? {
              outcome: state.last_switch.outcome,
              at: state.last_switch.timestamp_ms,
              latencyMs: state.last_switch.latency_ms,
            }
          : null,
        settingsSource: state.settings_source,
        settingsGeneration: state.settings_generation,
      },
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private receive(payload: unknown, retained: boolean): void {
    const parsed = ComputerOpticalStateSchema.safeParse(decode(payload, 8_192));
    if (!parsed.success || parsed.data.device_id !== this.options.deviceId)
      return;
    const state = parsed.data;
    const now = this.clock.now();
    if (retained) {
      // A retained report only shows what the agent last said; it never counts as contact.
      if (!this.state) {
        this.state = state;
        this.receivedAt = now;
        this.live = false;
        this.changed();
      }
      return;
    }
    // Sequences restart with the agent, so order by the agent's clock instead.
    const age = now - state.timestamp_ms;
    if (age > this.maxAgeMs || age < -2_000) return;
    if (this.live && this.state && state.timestamp_ms < this.state.timestamp_ms)
      return;
    this.state = state;
    this.receivedAt = now;
    this.live = true;
    if (this.expiryTimer !== undefined)
      this.clock.clearTimeout(this.expiryTimer);
    const lifetime = Math.min(this.maxAgeMs, state.heartbeat_interval_ms * 3);
    this.expiryTimer = this.clock.setTimeout(() => {
      this.expiryTimer = undefined;
      this.live = false;
      this.changed();
    }, lifetime);
    this.changed();
  }

  private invalidate(): void {
    if (this.expiryTimer !== undefined)
      this.clock.clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.live = false;
    this.changed();
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function decode(payload: unknown, limit: number): unknown {
  try {
    let text: string;
    if (typeof payload === 'string' && Buffer.byteLength(payload) <= limit)
      text = payload;
    else if (payload instanceof Uint8Array && payload.byteLength <= limit)
      text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    else return undefined;
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
