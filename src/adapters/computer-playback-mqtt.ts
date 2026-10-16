import { z } from 'zod';
import { systemClock, type Clock, type TimerHandle } from '../core/clock.js';
import { ComputerDeviceIdSchema } from '../core/computer.js';
import type { PresenceMqttSubscriber } from '../runtime/mqttjs-subscriber.js';

const Integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const UUID = z.uuid().regex(/^[0-9a-f-]{36}$/);
const PlayerName = z
  .string()
  .max(255)
  .regex(
    /^org\.mpris\.MediaPlayer2\.[A-Za-z_-][A-Za-z0-9_-]*(?:\.[A-Za-z_-][A-Za-z0-9_-]*)*$/,
  );
const Identity = {
  schema_version: z.literal(1),
  device_id: ComputerDeviceIdSchema,
  session_id: UUID,
  connection_id: UUID,
};
export const ComputerPlaybackPlayerSchema = z.strictObject({
  player: PlayerName,
  player_instance_id: UUID,
  content_id: UUID.nullable(),
  playback_status: z.enum(['Playing', 'Paused', 'Stopped']).nullable(),
  can_pause: z.boolean(),
  can_play: z.boolean(),
  pause_lease: z
    .strictObject({
      pause_command_id: UUID,
      resume_token: UUID,
      expires_at_ms: Integer,
    })
    .nullable(),
});
export const ComputerPlaybackStateSchema = z
  .strictObject({
    ...Identity,
    sequence: Integer.min(1),
    timestamp_ms: Integer,
    heartbeat_interval_ms: Integer.min(5_000).max(300_000),
    players: z.array(ComputerPlaybackPlayerSchema).max(64),
  })
  .refine(
    (s) => new Set(s.players.map((p) => p.player)).size === s.players.length,
  );
export const ComputerPlaybackCommandSchema = z
  .strictObject({
    ...Identity,
    command_id: UUID,
    action: z.enum(['pause', 'resume']),
    player: PlayerName,
    player_instance_id: UUID,
    content_id: UUID,
    issued_at_ms: Integer,
    expires_at_ms: Integer,
    pause_command_id: UUID.nullable(),
    resume_token: UUID.nullable(),
    lease_ttl_ms: Integer.nullable(),
  })
  .refine(
    (c) =>
      c.expires_at_ms > c.issued_at_ms &&
      c.expires_at_ms - c.issued_at_ms <= 15_000,
  )
  .refine((c) =>
    c.action === 'pause'
      ? c.pause_command_id === null &&
        c.resume_token === null &&
        c.lease_ttl_ms !== null &&
        c.lease_ttl_ms >= 1_000 &&
        c.lease_ttl_ms <= 3_600_000
      : c.pause_command_id !== null &&
        c.resume_token !== null &&
        c.lease_ttl_ms === null,
  );
export const ComputerPlaybackAckSchema = z
  .strictObject({
    ...Identity,
    command_id: UUID,
    action: z.enum(['pause', 'resume']),
    player: PlayerName,
    player_instance_id: UUID,
    content_id: UUID,
    timestamp_ms: Integer,
    outcome: z.enum(['applied', 'rejected', 'uncertain']),
    reason: z.enum([
      'paused',
      'resumed',
      'disabled',
      'retained',
      'expired',
      'invalid_command',
      'wrong_session',
      'wrong_connection',
      'unknown_player',
      'player_changed',
      'content_changed',
      'not_playing',
      'not_paused',
      'not_capable',
      'not_owner',
      'lease_expired',
      'id_conflict',
      'busy',
      'unavailable',
      'timeout',
      'unconfirmed',
    ]),
    resume_token: UUID.nullable(),
    lease_expires_at_ms: Integer.nullable(),
  })
  .refine(
    (a) =>
      a.outcome !== 'applied' ||
      (a.action === 'pause'
        ? a.reason === 'paused' &&
          a.resume_token !== null &&
          a.lease_expires_at_ms !== null &&
          a.lease_expires_at_ms > a.timestamp_ms
        : a.reason === 'resumed' &&
          a.resume_token === null &&
          a.lease_expires_at_ms === null),
  );

export type ComputerPlaybackPlayer = z.infer<
  typeof ComputerPlaybackPlayerSchema
>;
export type ComputerPlaybackState = z.infer<typeof ComputerPlaybackStateSchema>;
export type ComputerPlaybackCommand = z.infer<
  typeof ComputerPlaybackCommandSchema
>;
export type ComputerPlaybackAck = z.infer<typeof ComputerPlaybackAckSchema>;
export type ComputerPlaybackControlSnapshot = {
  state: ComputerPlaybackState;
  receivedAtMs: number;
  fresh: boolean;
};
export type ComputerPlaybackMqttPort = PresenceMqttSubscriber & {
  publish(
    topic: string,
    payload: string,
    options: { qos: 1; retain: false },
    signal?: AbortSignal,
  ): Promise<void>;
};
export type ComputerPlaybackMqttOptions = {
  deviceId: string;
  baseTopic?: string;
  mqtt: ComputerPlaybackMqttPort;
  maxAgeMs?: number;
  clock?: Clock;
  onChange?: () => void;
};
type Pending = {
  command: ComputerPlaybackCommand;
  finish: (error?: Error, ack?: ComputerPlaybackAck) => void;
};

/** CONTROL v1 transport. Only a live snapshot received on this broker connection authorizes commands. */
export class ComputerPlaybackMqttAdapter {
  private readonly topic: string;
  private readonly clock: Clock;
  private readonly maxAgeMs: number;
  private active = false;
  private connected = false;
  private snapshot: ComputerPlaybackControlSnapshot | undefined;
  private expiresAt = 0;
  private expiryTimer: TimerHandle | undefined;
  private unsubscribers: Array<() => void> = [];
  private readonly pending = new Map<string, Pending>();
  private readonly sequences = new Map<string, number>();
  private readonly retired = new Set<string>();
  private currentIdentity: string | undefined;
  private lastTimestamp = -1;

  constructor(private readonly options: ComputerPlaybackMqttOptions) {
    ComputerDeviceIdSchema.parse(options.deviceId);
    const prefix = (options.baseTopic ?? 'lugn/computers').replace(/\/+$/, '');
    if (!prefix || /[+#\0]/.test(prefix))
      throw new Error('Computer control prefix must be a concrete topic');
    this.topic = `${prefix}/${options.deviceId}/control`;
    this.clock = options.clock ?? systemClock;
    this.maxAgeMs = options.maxAgeMs ?? 90_000;
    if (
      !Number.isSafeInteger(this.maxAgeMs) ||
      this.maxAgeMs < 1_000 ||
      this.maxAgeMs > 90_000
    )
      throw new Error(
        'Computer control maximum age must be between 1000 and 90000 ms',
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
    this.invalidate('Computer playback transport stopped');
  }

  getSnapshot(): ComputerPlaybackControlSnapshot | undefined {
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
    input: ComputerPlaybackCommand,
    signal?: AbortSignal,
  ): Promise<ComputerPlaybackAck> {
    const parsed = ComputerPlaybackCommandSchema.safeParse(input);
    if (!parsed.success)
      return Promise.reject(new Error('Invalid computer playback command'));
    const command = parsed.data;
    const payload = JSON.stringify(command);
    const snapshot = this.getSnapshot();
    const now = this.clock.now();
    if (
      !snapshot?.fresh ||
      !this.matchesContext(command, snapshot.state) ||
      command.expires_at_ms <= now ||
      command.issued_at_ms > now + 2_000 ||
      command.issued_at_ms < now - 15_000 ||
      Buffer.byteLength(payload) > 8_192
    )
      return Promise.reject(
        new Error('Computer playback command has no fresh matching context'),
      );
    if (signal?.aborted)
      return Promise.reject(new Error('Computer playback command aborted'));
    if (this.pending.has(command.command_id))
      return Promise.reject(
        new Error('Computer playback command already pending'),
      );
    const player = snapshot.state.players.find(
      (p) => p.player === command.player,
    );
    if (
      !player ||
      player.player_instance_id !== command.player_instance_id ||
      player.content_id !== command.content_id
    )
      return Promise.reject(new Error('Computer playback player changed'));
    if (
      command.action === 'pause'
        ? player.playback_status !== 'Playing' ||
          !player.can_pause ||
          player.pause_lease !== null
        : player.playback_status !== 'Paused' ||
          !player.can_play ||
          !player.pause_lease ||
          player.pause_lease.pause_command_id !== command.pause_command_id ||
          player.pause_lease.resume_token !== command.resume_token ||
          player.pause_lease.expires_at_ms <= now
    )
      return Promise.reject(
        new Error(
          'Computer playback action is not authorized by current state',
        ),
      );
    return new Promise((resolve, reject) => {
      const abort = new AbortController();
      let settled = false;
      const finish = (error?: Error, ack?: ComputerPlaybackAck) => {
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
        finish(new Error('Computer playback command aborted'));
      const timer = this.clock.setTimeout(
        () => finish(new Error('Computer playback acknowledgement timed out')),
        Math.min(15_000, command.expires_at_ms - now),
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
                : new Error('Computer playback publish failed'),
            ),
          );
      } catch (error) {
        finish(
          error instanceof Error
            ? error
            : new Error('Computer playback publish failed'),
        );
      }
    });
  }

  private receiveState(payload: unknown, retained: boolean): void {
    const parsed = ComputerPlaybackStateSchema.safeParse(
      decode(payload, 65_536),
    );
    if (!parsed.success || parsed.data.device_id !== this.options.deviceId) {
      this.invalidate('Invalid computer playback state');
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
      this.invalidate('Stale computer playback state');
      return;
    }
    if (this.currentIdentity && identity !== this.currentIdentity) {
      this.rememberRetired(this.currentIdentity);
      const oldSession = this.currentIdentity.split('/')[0]!;
      if (oldSession !== state.session_id) this.rememberRetired(oldSession);
      this.failPending('Computer playback identity changed');
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
      () => this.invalidate('Computer playback state expired'),
      lifetime,
    );
    this.changed();
  }

  private receiveAck(payload: unknown): void {
    const parsed = ComputerPlaybackAckSchema.safeParse(decode(payload, 8_192));
    if (!parsed.success) return;
    const ack = parsed.data;
    const pending = this.pending.get(ack.command_id);
    if (!pending) return;
    const command = pending.command;
    if (
      !this.matchesContext(ack, command) ||
      ack.action !== command.action ||
      ack.player !== command.player ||
      ack.player_instance_id !== command.player_instance_id ||
      ack.content_id !== command.content_id ||
      ack.timestamp_ms < command.issued_at_ms - 2_000 ||
      ack.timestamp_ms >= command.expires_at_ms ||
      ack.timestamp_ms > this.clock.now() + 2_000 ||
      this.clock.now() >= command.expires_at_ms
    )
      return;
    pending.finish(undefined, ack);
  }

  private matchesContext(
    a: { device_id: string; session_id: string; connection_id: string },
    b: { device_id: string; session_id: string; connection_id: string },
  ): boolean {
    return (
      a.device_id === b.device_id &&
      a.session_id === b.session_id &&
      a.connection_id === b.connection_id
    );
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
