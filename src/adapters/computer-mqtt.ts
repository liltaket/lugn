import { z } from 'zod';
import { systemClock, type Clock, type TimerHandle } from '../core/clock.js';
import {
  ComputerActivitySchema,
  ComputerArtworkSchema,
  ComputerDeviceIdSchema,
  unknownComputerReadings,
  type ComputerObservation,
  type ComputerReadings,
} from '../core/computer.js';
import type { PresenceMqttSubscriber } from '../runtime/mqttjs-subscriber.js';

const MAX_PAYLOAD_BYTES = 262_144;
const MAX_FUTURE_SKEW_MS = 5_000;
const Text = z.string().max(512);
const Counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Envelope = z.object({
  schema_version: z.literal(1),
  device_id: ComputerDeviceIdSchema,
  session_id: z.uuid(),
});
const SequencedEnvelope = Envelope.extend({
  sequence: Counter.min(1),
  timestamp_ms: Counter,
});
const StateMessageSchema = SequencedEnvelope.extend({
  reason: z.enum(['startup', 'change', 'heartbeat', 'reconnect']),
  heartbeat_interval_ms: z.number().int().min(5_000).max(300_000),
  observations: z.object({
    network_online: z.boolean().nullable(),
    locked: z.boolean().nullable(),
    idle: z.boolean().nullable(),
    active_application: z
      .object({
        app_id: Text,
        resource_class: Text,
        fullscreen: z.boolean(),
      })
      .nullable(),
    audio: z
      .object({
        playing: z.boolean(),
        applications: z.array(Text).max(128),
        roles: z.array(Text).max(128),
      })
      .nullable(),
    media: z
      .array(
        z.object({
          player: Text,
          identity: Text.nullable(),
          desktop_entry: Text.nullable(),
          playback_status: z.enum(['Playing', 'Paused', 'Stopped']).nullable(),
          title: Text.nullable(),
          artists: z.array(Text).max(64).nullable(),
          album: Text.nullable(),
          content_type: Text.nullable(),
          // Optional presentation failure must not discard valid desktop state.
          artwork: ComputerArtworkSchema.nullable().catch(null).optional(),
        }),
      )
      .max(64)
      .nullable(),
  }),
  inference: z.object({
    activity: ComputerActivitySchema.shape.classification,
    basis: z.enum([
      'locked_or_idle',
      'application_rule',
      'application_rule_and_playback',
      'mpris_content_type',
      'active_application',
      'insufficient_evidence',
    ]),
  }),
});
const AvailabilityMessageSchema = Envelope.extend({
  status: z.enum(['online', 'offline']),
});
const EventMessageSchema = SequencedEnvelope.extend({
  type: z.literal('state_changed'),
});
type StateMessage = z.infer<typeof StateMessageSchema>;

type Candidate = {
  message: StateMessage;
  receivedAt: number;
  expiresMonotonicAt: number;
};

export type ComputerMqttOptions = {
  deviceId: string;
  /** Prefix preceding /{deviceId}/state, /availability and /events. */
  baseTopic?: string;
  maxAgeMs?: number;
  clock?: Clock;
};

/** Read-only MQTT v1 desktop integration. Events never replace state snapshots. */
export class ComputerMqttAdapter {
  private readonly deviceId: string;
  private readonly topic: string;
  private readonly maxAgeMs: number;
  private readonly clock: Clock;
  private active = false;
  private connected = false;
  private unsubscribers: Array<() => void> = [];
  private expiryTimer: TimerHandle | undefined;
  private availability: z.infer<typeof AvailabilityMessageSchema> | undefined;
  private candidate: Candidate | undefined;
  // Bounded deduplication across connection changes and recent process restarts.
  private readonly sequences = new Map<string, number>();
  private readonly eventSequences = new Map<string, number>();
  private readonly retiredSessions = new Set<string>();
  private lastOnlineSession: string | undefined;
  private lastEvent: ComputerObservation['lastEvent'] = null;
  private reason: ComputerObservation['reason'] = 'awaiting_state';
  private lastEmitted: string | undefined;

  constructor(
    private readonly subscriber: PresenceMqttSubscriber,
    private readonly onObservation: (observation: ComputerObservation) => void,
    options: ComputerMqttOptions,
  ) {
    this.deviceId = ComputerDeviceIdSchema.parse(options.deviceId);
    const prefix = (options.baseTopic ?? 'lugn/computers').replace(/\/+$/, '');
    if (!prefix || /[+#\0]/.test(prefix))
      throw new Error('Computer MQTT prefix must be a concrete topic');
    this.topic = `${prefix}/${this.deviceId}`;
    this.maxAgeMs = options.maxAgeMs ?? 90_000;
    if (
      !Number.isSafeInteger(this.maxAgeMs) ||
      this.maxAgeMs < 1_000 ||
      this.maxAgeMs > 300_000
    )
      throw new Error(
        'Computer maximum age must be between 1000 and 300000 ms',
      );
    this.clock = options.clock ?? systemClock;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    try {
      for (const suffix of ['state', 'availability', 'events'] as const) {
        this.unsubscribers.push(
          this.subscriber.subscribe(
            `${this.topic}/${suffix}`,
            { qos: 1 },
            (topic, payload, metadata) => {
              if (
                !this.active ||
                !this.connected ||
                topic !== `${this.topic}/${suffix}`
              )
                return;
              this.receive(suffix, payload, metadata.retain);
            },
          ),
        );
      }
      this.emit();
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    for (const unsubscribe of this.unsubscribers.splice(0).reverse())
      unsubscribe();
    this.invalidate('stopped');
    this.availability = undefined;
    this.connected = false;
    this.lastEvent = null;
    this.emit();
  }

  setBrokerConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.invalidate(connected ? 'awaiting_state' : 'broker_disconnected');
    this.availability = undefined;
    this.lastEvent = null;
    if (this.active) this.emit();
  }

  private receive(
    suffix: 'state' | 'availability' | 'events',
    payload: unknown,
    retained: boolean,
  ): void {
    if (suffix === 'events') {
      if (retained) return;
      const parsed = EventMessageSchema.safeParse(decode(payload));
      if (!parsed.success) return;
      const event = parsed.data;
      if (
        event.device_id !== this.deviceId ||
        !this.isCurrentSession(event.session_id) ||
        !this.validTimestamp(event.timestamp_ms) ||
        event.sequence <= (this.eventSequences.get(event.session_id) ?? -1) ||
        event.sequence < (this.sequences.get(event.session_id) ?? -1)
      )
        return;
      this.remember(this.eventSequences, event.session_id, event.sequence);
      this.lastEvent = {
        type: event.type,
        sessionId: event.session_id,
        sequence: event.sequence,
        occurredAt: event.timestamp_ms,
        receivedAt: this.clock.now(),
      };
      this.emit();
      return;
    }
    if (suffix === 'availability') {
      const parsed = AvailabilityMessageSchema.safeParse(decode(payload));
      if (!parsed.success || parsed.data.device_id !== this.deviceId) {
        this.availability = undefined;
        this.invalidate('malformed');
        this.lastEvent = null;
        this.emit();
        return;
      }
      const incoming = parsed.data;
      if (this.retiredSessions.has(incoming.session_id)) return;
      if (
        incoming.status === 'offline' &&
        this.availability &&
        this.availability.session_id !== incoming.session_id
      )
        return;
      if (incoming.status === 'online') {
        if (
          this.lastOnlineSession &&
          this.lastOnlineSession !== incoming.session_id
        ) {
          this.retiredSessions.add(this.lastOnlineSession);
          if (this.retiredSessions.size > 64)
            this.retiredSessions.delete(
              this.retiredSessions.values().next().value!,
            );
          this.lastEvent = null;
        }
        this.lastOnlineSession = incoming.session_id;
      }
      this.availability = incoming;
      if (incoming.status === 'offline') {
        // An old process's Last Will can arrive between a new process's state
        // and online messages. Keep that new candidate and its original expiry;
        // it remains hidden until matching online availability arrives.
        if (
          this.candidate &&
          this.candidate.message.session_id !== incoming.session_id
        )
          this.reason = 'offline';
        else this.invalidate('offline');
        this.lastEvent = null;
      } else if (
        this.candidate &&
        this.candidate.message.session_id !== incoming.session_id
      ) {
        this.invalidate('awaiting_state');
        this.lastEvent = null;
      } else if (!this.candidate && this.reason === 'offline') {
        this.reason = 'awaiting_state';
      }
      this.emit();
      return;
    }

    const parsed = StateMessageSchema.safeParse(decode(payload));
    if (!parsed.success || parsed.data.device_id !== this.deviceId) {
      this.invalidate('malformed');
      this.emit();
      return;
    }
    const message = parsed.data;
    if (this.retiredSessions.has(message.session_id)) return;
    if (retained) {
      // Cached state is never evidence that the desktop is still alive.
      if (!this.candidate && this.reason !== 'offline')
        this.reason = 'retained';
      this.emit();
      return;
    }
    if (message.sequence <= (this.sequences.get(message.session_id) ?? -1))
      return;
    this.remember(this.sequences, message.session_id, message.sequence);
    if (!this.validTimestamp(message.timestamp_ms)) {
      this.invalidate(
        message.timestamp_ms < this.clock.now() ? 'stale' : 'malformed',
      );
      this.emit();
      return;
    }
    // Buffer a live reconnect snapshot even while the old LWT is offline.
    // Matching online availability can arrive after state on another topic.
    this.clearExpiry();
    const now = this.clock.now();
    const lifetime = Math.min(
      this.maxAgeMs,
      message.timestamp_ms + this.maxAgeMs - now,
    );
    this.candidate = {
      message,
      receivedAt: now,
      expiresMonotonicAt: this.clock.monotonicNow() + lifetime,
    };
    this.reason = 'live';
    this.expiryTimer = this.clock.setTimeout(() => this.expire(), lifetime);
    this.emit();
  }

  private isCurrentSession(session: string): boolean {
    return (
      this.availability?.status === 'online' &&
      this.availability.session_id === session
    );
  }

  private validTimestamp(timestamp: number): boolean {
    const age = this.clock.now() - timestamp;
    return age < this.maxAgeMs && age >= -MAX_FUTURE_SKEW_MS;
  }

  private invalidate(reason: ComputerObservation['reason']): void {
    this.clearExpiry();
    this.candidate = undefined;
    this.reason = reason;
  }

  private expire(): void {
    this.expiryTimer = undefined;
    if (!this.candidate) return;
    const remaining =
      this.candidate.expiresMonotonicAt - this.clock.monotonicNow();
    if (remaining > 0) {
      this.expiryTimer = this.clock.setTimeout(() => this.expire(), remaining);
      return;
    }
    this.invalidate('stale');
    this.emit();
  }

  private clearExpiry(): void {
    if (this.expiryTimer === undefined) return;
    this.clock.clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  private remember(
    map: Map<string, number>,
    session: string,
    sequence: number,
  ): void {
    map.delete(session);
    map.set(session, sequence);
    if (map.size > 64) map.delete(map.keys().next().value!);
  }

  private emit(): void {
    const candidate = this.candidate;
    const fresh =
      this.connected &&
      candidate !== undefined &&
      candidate.expiresMonotonicAt > this.clock.monotonicNow() &&
      this.isCurrentSession(candidate.message.session_id);
    const offline = this.connected && this.availability?.status === 'offline';
    const reason =
      !this.connected && this.reason !== 'stopped'
        ? 'broker_disconnected'
        : offline
          ? 'offline'
          : fresh
            ? 'live'
            : this.reason === 'live'
              ? 'awaiting_state'
              : this.reason;
    const observation: ComputerObservation = {
      deviceId: this.deviceId,
      availability: offline ? 'offline' : fresh ? 'online' : 'unknown',
      freshness: fresh ? 'fresh' : reason === 'stale' ? 'stale' : 'unknown',
      reason,
      observedAt: fresh ? candidate.message.timestamp_ms : null,
      receivedAt: fresh ? candidate.receivedAt : null,
      sessionId: this.availability?.session_id ?? null,
      sequence: fresh ? candidate.message.sequence : null,
      observed: fresh
        ? normalize(candidate.message)
        : unknownComputerReadings(),
      activity: {
        classification: fresh
          ? candidate.message.inference.activity
          : 'unknown',
        source: 'desktop-agent',
        basis: fresh ? candidate.message.inference.basis : null,
      },
      lastEvent: this.lastEvent === null ? null : { ...this.lastEvent },
    };
    const key = JSON.stringify(observation);
    if (key === this.lastEmitted) return;
    this.lastEmitted = key;
    this.onObservation(structuredClone(observation));
  }
}

function normalize(message: StateMessage): ComputerReadings {
  const observed = message.observations;
  const app = observed.active_application;
  return {
    networkOnline: observed.network_online,
    locked: observed.locked,
    idle: observed.idle,
    activeApplication: app
      ? { id: app.app_id, resourceClass: app.resource_class }
      : null,
    fullscreen: app?.fullscreen ?? null,
    audio: observed.audio,
    media:
      observed.media?.map((media) => ({
        player: media.player,
        identity: media.identity,
        desktopEntry: media.desktop_entry,
        playback:
          media.playback_status === 'Playing'
            ? 'playing'
            : media.playback_status === 'Paused'
              ? 'paused'
              : media.playback_status === 'Stopped'
                ? 'stopped'
                : 'unknown',
        title: media.title,
        artists: media.artists,
        album: media.album,
        contentType: media.content_type,
        ...(media.artwork ? { artwork: media.artwork } : {}),
      })) ?? null,
  };
}

function decode(payload: unknown): unknown {
  let text: string;
  if (typeof payload === 'string') {
    if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES)
      return undefined;
    text = payload;
  } else if (
    payload instanceof Uint8Array &&
    payload.byteLength <= MAX_PAYLOAD_BYTES
  ) {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    } catch {
      return undefined;
    }
  } else return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
