import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { systemClock, type Clock, type TimerHandle } from '../core/clock.js';
import { ComputerDeviceIdSchema } from '../core/computer.js';
import type { ComputerPlaybackMqttPort } from './computer-playback-mqtt.js';

const Integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const UUID = z.uuid().regex(/^[0-9a-f-]{36}$/);
const Identity = {
  schema_version: z.literal(1),
  device_id: ComputerDeviceIdSchema,
  session_id: UUID,
  connection_id: UUID,
};
const Action = z.enum(['off', 'on']);
const Outcome = z.enum(['applied', 'rejected', 'uncertain']);
const Reason = z.enum([
  'display_off',
  'display_on',
  'retained',
  'expired',
  'invalid_command',
  'wrong_session',
  'wrong_connection',
  'id_conflict',
  'busy',
  'unavailable',
  'timeout',
  'failed',
  'not_observed',
  'no_output',
]);
export const ComputerDisplayStateSchema = z.strictObject({
  ...Identity,
  sequence: Integer.min(1),
  timestamp_ms: Integer,
  heartbeat_interval_ms: Integer.min(5_000).max(300_000),
  backend: z.enum(['kscreen', 'xset']).nullable(),
  /** The GPU's picture-signal state across connected outputs. */
  power: z.enum(['on', 'off', 'partial', 'none', 'unknown']),
  outputs: z
    .array(
      z.strictObject({
        connector: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        power: z.enum(['on', 'off', 'unknown']),
      }),
    )
    .max(16),
  power_changed_at_ms: Integer.nullable(),
  /** No real keyboard/pointer input recently, ignoring idle inhibitors. */
  input_idle: z.boolean().nullable(),
  /** Estimated time of the last input while `input_idle` is true. */
  input_idle_since_ms: Integer.nullable(),
  /** What PowerDevil lists as holding the machine awake; null when unreadable. */
  idle_blockers: z
    .array(
      z.strictObject({ app: z.string().max(64), reason: z.string().max(64) }),
    )
    .max(8)
    .nullable(),
  last_command: z
    .strictObject({
      command_id: UUID,
      action: Action,
      outcome: Outcome,
      reason: Reason,
      timestamp_ms: Integer,
    })
    .nullable(),
});
export const ComputerDisplayCommandSchema = z
  .strictObject({
    ...Identity,
    command_id: UUID,
    action: Action,
    issued_at_ms: Integer,
    expires_at_ms: Integer,
  })
  .refine(
    (c) =>
      c.expires_at_ms > c.issued_at_ms &&
      c.expires_at_ms - c.issued_at_ms <= 15_000,
  );
export const ComputerDisplayAckSchema = z.strictObject({
  ...Identity,
  command_id: UUID,
  action: Action,
  timestamp_ms: Integer,
  outcome: Outcome,
  reason: Reason,
});

export type ComputerDisplayState = z.infer<typeof ComputerDisplayStateSchema>;
export type ComputerDisplayCommand = z.infer<
  typeof ComputerDisplayCommandSchema
>;
export type ComputerDisplayAck = z.infer<typeof ComputerDisplayAckSchema>;
export type ComputerDisplayAction = z.infer<typeof Action>;
export type ComputerDisplaySnapshot = {
  state: ComputerDisplayState;
  receivedAtMs: number;
  fresh: boolean;
};
/** What the policy needs from the transport; the MQTT adapter implements it. */
export interface ComputerDisplayTransport {
  getSnapshot(): ComputerDisplaySnapshot | undefined;
  sendCommand(
    action: ComputerDisplayAction,
    signal?: AbortSignal,
  ): Promise<ComputerDisplayAck>;
}
export type ComputerDisplayMqttOptions = {
  deviceId: string;
  baseTopic?: string;
  mqtt: ComputerPlaybackMqttPort;
  maxAgeMs?: number;
  clock?: Clock;
  onChange?: () => void;
  uuid?: () => string;
};
type Pending = {
  command: ComputerDisplayCommand;
  finish: (error?: Error, ack?: ComputerDisplayAck) => void;
};

/**
 * DISPLAY v1 transport. Like CONTROL v1, only a live state received on this
 * broker connection authorizes a request; retained state only seeds a display.
 * The display request is idempotent, so no lease or content identity exists:
 * the connection nonce and the short expiry fence replays.
 */
export class ComputerDisplayMqttAdapter implements ComputerDisplayTransport {
  private readonly topic: string;
  private readonly clock: Clock;
  private readonly maxAgeMs: number;
  private active = false;
  private connected = false;
  private snapshot: ComputerDisplaySnapshot | undefined;
  private expiresAt = 0;
  private expiryTimer: TimerHandle | undefined;
  private unsubscribers: Array<() => void> = [];
  private readonly pending = new Map<string, Pending>();
  private readonly sequences = new Map<string, number>();
  private readonly retired = new Set<string>();
  private currentIdentity: string | undefined;
  private lastTimestamp = -1;

  constructor(private readonly options: ComputerDisplayMqttOptions) {
    ComputerDeviceIdSchema.parse(options.deviceId);
    const prefix = (options.baseTopic ?? 'lugn/computers').replace(/\/+$/, '');
    if (!prefix || /[+#\0]/.test(prefix))
      throw new Error('Computer display prefix must be a concrete topic');
    this.topic = `${prefix}/${options.deviceId}/display`;
    this.clock = options.clock ?? systemClock;
    this.maxAgeMs = options.maxAgeMs ?? 90_000;
    if (
      !Number.isSafeInteger(this.maxAgeMs) ||
      this.maxAgeMs < 1_000 ||
      this.maxAgeMs > 90_000
    )
      throw new Error(
        'Computer display maximum age must be between 1000 and 90000 ms',
      );
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    try {
      for (const suffix of ['state', 'ack'] as const) {
        this.unsubscribers.push(
          this.options.mqtt.subscribe(
            `${this.topic}/${suffix}`,
            { qos: 1 },
            (topic, payload, metadata) => {
              if (
                !this.active ||
                !this.connected ||
                topic !== `${this.topic}/${suffix}`
              )
                return;
              if (suffix === 'state')
                this.receiveState(payload, metadata.retain);
              else if (!metadata.retain) this.receiveAck(payload);
            },
          ),
        );
      }
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  setBrokerConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.invalidate('Broker connection changed');
  }

  stop(): void {
    this.active = false;
    this.connected = false;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.invalidate('Computer display transport stopped');
  }

  getSnapshot(): ComputerDisplaySnapshot | undefined {
    if (!this.snapshot) return undefined;
    const fresh =
      this.active &&
      this.connected &&
      this.snapshot.fresh &&
      this.clock.monotonicNow() < this.expiresAt &&
      this.validTimestamp(this.snapshot.state.timestamp_ms);
    return structuredClone({ ...this.snapshot, fresh });
  }

  sendCommand(
    action: ComputerDisplayAction,
    signal?: AbortSignal,
  ): Promise<ComputerDisplayAck> {
    const snapshot = this.getSnapshot();
    const now = this.clock.now();
    if (!snapshot?.fresh || snapshot.state.backend === null)
      return Promise.reject(
        new Error('Computer display has no fresh usable context'),
      );
    if (signal?.aborted)
      return Promise.reject(new Error('Computer display command aborted'));
    const parsed = ComputerDisplayCommandSchema.safeParse({
      schema_version: 1,
      device_id: this.options.deviceId,
      session_id: snapshot.state.session_id,
      connection_id: snapshot.state.connection_id,
      command_id: (this.options.uuid ?? randomUUID)(),
      action,
      issued_at_ms: now,
      expires_at_ms: now + 10_000,
    });
    if (!parsed.success)
      return Promise.reject(new Error('Invalid computer display command'));
    const command = parsed.data;
    const payload = JSON.stringify(command);
    return new Promise((resolve, reject) => {
      const abort = new AbortController();
      let settled = false;
      const finish = (error?: Error, ack?: ComputerDisplayAck) => {
        if (settled) return;
        settled = true;
        this.pending.delete(command.command_id);
        this.clock.clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        abort.abort();
        if (error) reject(error);
        else resolve(ack!);
      };
      const onAbort = () =>
        finish(new Error('Computer display command aborted'));
      const timer = this.clock.setTimeout(
        () => finish(new Error('Computer display acknowledgement timed out')),
        command.expires_at_ms - now,
      );
      this.pending.set(command.command_id, { command, finish });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        void this.options.mqtt
          .publish(
            `${this.topic}/command`,
            payload,
            { qos: 1, retain: false },
            abort.signal,
          )
          .catch((error) =>
            finish(
              error instanceof Error
                ? error
                : new Error('Computer display publish failed'),
            ),
          );
      } catch (error) {
        finish(
          error instanceof Error
            ? error
            : new Error('Computer display publish failed'),
        );
      }
    });
  }

  private receiveState(payload: unknown, retained: boolean): void {
    const parsed = ComputerDisplayStateSchema.safeParse(decode(payload, 8_192));
    if (!parsed.success || parsed.data.device_id !== this.options.deviceId) {
      this.invalidate('Invalid computer display state');
      return;
    }
    const state = parsed.data;
    const identity = `${state.session_id}/${state.connection_id}`;
    if (this.retired.has(identity) || this.retired.has(state.session_id))
      return;
    if (retained) {
      if (!this.snapshot) {
        this.snapshot = { state, receivedAtMs: this.clock.now(), fresh: false };
        this.changed();
      }
      return;
    }
    if (
      state.sequence <= (this.sequences.get(identity) ?? 0) ||
      state.timestamp_ms < this.lastTimestamp
    )
      return;
    if (!this.validTimestamp(state.timestamp_ms)) {
      this.invalidate('Stale computer display state');
      return;
    }
    if (this.currentIdentity && identity !== this.currentIdentity) {
      this.rememberRetired(this.currentIdentity);
      const oldSession = this.currentIdentity.split('/')[0]!;
      if (oldSession !== state.session_id) this.rememberRetired(oldSession);
      this.failPending('Computer display identity changed');
    }
    this.currentIdentity = identity;
    this.lastTimestamp = state.timestamp_ms;
    this.sequences.delete(identity);
    this.sequences.set(identity, state.sequence);
    if (this.sequences.size > 64)
      this.sequences.delete(this.sequences.keys().next().value!);
    this.clearExpiry();
    this.snapshot = { state, receivedAtMs: this.clock.now(), fresh: true };
    const lifetime = Math.min(
      this.maxAgeMs,
      state.timestamp_ms + this.maxAgeMs - this.clock.now(),
    );
    this.expiresAt = this.clock.monotonicNow() + lifetime;
    this.expiryTimer = this.clock.setTimeout(
      () => this.invalidate('Computer display state expired'),
      lifetime,
    );
    this.changed();
  }

  private receiveAck(payload: unknown): void {
    const parsed = ComputerDisplayAckSchema.safeParse(decode(payload, 4_096));
    if (!parsed.success) return;
    const ack = parsed.data;
    const pending = this.pending.get(ack.command_id);
    if (!pending) return;
    const command = pending.command;
    const now = this.clock.now();
    if (
      ack.device_id !== command.device_id ||
      ack.session_id !== command.session_id ||
      ack.connection_id !== command.connection_id ||
      ack.action !== command.action ||
      ack.timestamp_ms < command.issued_at_ms - 2_000 ||
      ack.timestamp_ms >= command.expires_at_ms ||
      ack.timestamp_ms > now + 2_000 ||
      now >= command.expires_at_ms
    )
      return;
    pending.finish(undefined, ack);
  }

  private validTimestamp(timestamp: number): boolean {
    const age = this.clock.now() - timestamp;
    return age < this.maxAgeMs && age >= -2_000;
  }
  private rememberRetired(identity: string): void {
    this.retired.add(identity);
    if (this.retired.size > 128)
      this.retired.delete(this.retired.values().next().value!);
  }
  private failPending(reason: string): void {
    for (const p of [...this.pending.values()]) p.finish(new Error(reason));
  }
  private clearExpiry(): void {
    if (this.expiryTimer !== undefined)
      this.clock.clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }
  private invalidate(reason: string): void {
    this.clearExpiry();
    if (this.snapshot) this.snapshot.fresh = false;
    this.failPending(reason);
    this.changed();
  }
  private changed(): void {
    this.options.onChange?.();
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
