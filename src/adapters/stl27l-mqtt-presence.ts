import type { Clock } from '../core/clock.js';
import { systemClock } from '../core/clock.js';
import type { PresenceInputEvent } from '../core/schemas.js';

/** MQTT retain state is required to distinguish a live heartbeat from a cache. */
export interface Stl27lMqttMessageMetadata {
  retain: boolean;
}

/** The minimal MQTT client surface needed by the STL27L presence adapter. */
export interface Stl27lPresenceMqttSubscriber {
  subscribe(
    topic: string,
    options: { qos: 0 | 1 },
    onMessage: (
      topic: string,
      payload: unknown,
      metadata: Stl27lMqttMessageMetadata,
    ) => void,
  ): () => void;
}

export type Stl27lMqttPresenceOptions = {
  baseTopic?: string;
  maxAgeMs?: number;
  clock?: Clock;
};

type Snapshot = {
  count: number;
  quality: 'CERTAIN' | 'DEGRADED' | 'UNCERTAIN';
};

type NormalizedPresence = {
  presence: 'occupied' | 'confirmed_empty' | 'unknown';
  personCount: number | null;
};

const DEFAULT_BASE_TOPIC = 'bruno/doorway';
const DEFAULT_MAX_AGE_MS = 5_000;

/**
 * Consumes the STL27L snapshot, availability, and preview MQTT topics.
 * Confirmed empty requires a live non-retained heartbeat, an online sensor,
 * and CERTAIN quality. Retained snapshots are cache only and never establish
 * heartbeat freshness.
 */
export class Stl27lMqttPresenceAdapter {
  private readonly baseTopic: string;
  private readonly maxAgeMs: number;
  private readonly clock: Clock;
  private unsubscribers: Array<() => void> = [];
  private expiryTimer: ReturnType<Clock['setTimeout']> | undefined;
  private brokerConnected: boolean | undefined;
  private sensorOnline = false;
  private snapshot: Snapshot | undefined;
  private snapshotReceivedAt: number | undefined;
  private lastPresenceKey: string | undefined;
  private lastPreviewActive: boolean | undefined;

  constructor(
    private readonly subscriber: Stl27lPresenceMqttSubscriber,
    private readonly onEvent: (event: PresenceInputEvent) => void,
    options: Stl27lMqttPresenceOptions = {},
  ) {
    this.baseTopic = normalizeBaseTopic(
      options.baseTopic ?? DEFAULT_BASE_TOPIC,
    );
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.clock = options.clock ?? systemClock;

    if (!Number.isFinite(this.maxAgeMs) || this.maxAgeMs <= 0) {
      throw new Error('STL27L maximum snapshot age must be a positive number');
    }
  }

  start(): void {
    if (this.unsubscribers.length > 0) return;

    const topics: Array<{ suffix: string; qos: 0 | 1 }> = [
      { suffix: 'snapshot', qos: 1 },
      { suffix: 'availability', qos: 1 },
      { suffix: 'preview', qos: 0 },
    ];
    const unsubscribers: Array<() => void> = [];

    try {
      for (const { suffix, qos } of topics) {
        const topic = `${this.baseTopic}/${suffix}`;
        unsubscribers.push(
          this.subscriber.subscribe(
            topic,
            { qos },
            (receivedTopic, payload, metadata) =>
              this.receive(receivedTopic, payload, metadata),
          ),
        );
      }
      this.unsubscribers = unsubscribers;
    } catch (error) {
      for (const unsubscribe of unsubscribers.reverse()) unsubscribe();
      throw error;
    }
  }

  stop(): void {
    const unsubscribers = this.unsubscribers;
    this.unsubscribers = [];
    for (const unsubscribe of unsubscribers.reverse()) unsubscribe();
    this.clearExpiryTimer();
    this.snapshotReceivedAt = undefined;
    this.snapshot = undefined;
    this.sensorOnline = false;
    this.brokerConnected = undefined;
    this.lastPresenceKey = undefined;
    this.lastPreviewActive = undefined;
  }

  /**
   * Must be driven by the MQTT client's connection lifecycle. A reconnect
   * requires a new live heartbeat before count can establish occupancy.
   */
  setBrokerConnected(connected: boolean): void {
    if (this.brokerConnected === connected) return;
    this.brokerConnected = connected;

    if (!connected) {
      this.sensorOnline = false;
      this.snapshotReceivedAt = undefined;
      this.clearExpiryTimer();
      this.lastPreviewActive = undefined;
      this.emitPresence({ presence: 'unknown', personCount: null });
      return;
    }

    this.recomputePresence();
  }

  private receive(
    topic: string,
    payload: unknown,
    metadata: Stl27lMqttMessageMetadata,
  ): void {
    if (topic === `${this.baseTopic}/snapshot`) {
      this.receiveSnapshot(payload, metadata);
    } else if (topic === `${this.baseTopic}/availability`) {
      this.receiveAvailability(payload);
    } else if (topic === `${this.baseTopic}/preview`) {
      this.receivePreview(payload, metadata);
    }
  }

  private receiveSnapshot(
    payload: unknown,
    metadata: Stl27lMqttMessageMetadata,
  ): void {
    const snapshot = decodeSnapshot(payload);
    this.clearExpiryTimer();

    if (!snapshot) {
      this.snapshot = undefined;
      this.snapshotReceivedAt = undefined;
      this.recomputePresence();
      return;
    }

    this.snapshot = snapshot;
    if (metadata?.retain === false && this.brokerConnected === true) {
      this.snapshotReceivedAt = this.clock.now();
      this.scheduleExpiry();
    } else {
      // A retained packet only proves that the broker has cached a value.
      this.snapshotReceivedAt = undefined;
    }
    this.recomputePresence();
  }

  private receiveAvailability(payload: unknown): void {
    const state = decodeText(payload);
    if (state !== 'online' && state !== 'offline') {
      this.sensorOnline = false;
      this.invalidateSnapshotFreshness();
      this.lastPreviewActive = undefined;
      this.recomputePresence();
      return;
    }

    this.sensorOnline = state === 'online';
    if (!this.sensorOnline) {
      this.invalidateSnapshotFreshness();
      this.lastPreviewActive = undefined;
    }
    this.recomputePresence();
  }

  private invalidateSnapshotFreshness(): void {
    this.snapshotReceivedAt = undefined;
    this.clearExpiryTimer();
  }

  private receivePreview(
    payload: unknown,
    metadata: Stl27lMqttMessageMetadata,
  ): void {
    if (metadata?.retain !== false) return;
    const state = decodeText(payload);
    if (state !== 'ON' && state !== 'OFF') return;

    const active = state === 'ON';
    if (active === this.lastPreviewActive) return;
    this.lastPreviewActive = active;
    this.onEvent({
      type: 'presence.prelight',
      active,
      occurredAt: this.clock.now(),
      source: 'stl27l',
    });
  }

  private recomputePresence(): void {
    const fresh =
      this.brokerConnected === true &&
      this.sensorOnline &&
      this.snapshot !== undefined &&
      this.snapshotReceivedAt !== undefined &&
      this.clock.now() - this.snapshotReceivedAt < this.maxAgeMs;

    if (!fresh || !this.snapshot || this.snapshot.quality !== 'CERTAIN') {
      this.emitPresence({ presence: 'unknown', personCount: null });
      return;
    }

    this.emitPresence(
      this.snapshot.count > 0
        ? { presence: 'occupied', personCount: this.snapshot.count }
        : { presence: 'confirmed_empty', personCount: 0 },
    );
  }

  private emitPresence(normalized: NormalizedPresence): void {
    const key = `${normalized.presence}:${normalized.personCount ?? 'null'}`;
    if (key === this.lastPresenceKey) return;
    this.lastPresenceKey = key;
    this.onEvent({
      type: 'presence.changed',
      presence: normalized.presence,
      personCount: normalized.personCount,
      occurredAt: this.clock.now(),
      source: 'stl27l',
    });
  }

  private scheduleExpiry(): void {
    this.clearExpiryTimer();
    if (this.snapshotReceivedAt === undefined) return;

    const expiresAt = this.snapshotReceivedAt + this.maxAgeMs;
    const delay = Math.max(0, expiresAt - this.clock.now());
    this.expiryTimer = this.clock.setTimeout(() => {
      this.expiryTimer = undefined;
      if (
        this.snapshotReceivedAt !== undefined &&
        this.clock.now() - this.snapshotReceivedAt >= this.maxAgeMs
      ) {
        this.snapshotReceivedAt = undefined;
        this.recomputePresence();
      } else {
        this.scheduleExpiry();
      }
    }, delay);
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer === undefined) return;
    this.clock.clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }
}

function normalizeBaseTopic(baseTopic: string): string {
  const normalized = baseTopic.replace(/\/+$/, '');
  if (normalized.length === 0) {
    throw new Error('STL27L base MQTT topic must not be empty');
  }
  return normalized;
}

function decodeSnapshot(payload: unknown): Snapshot | undefined {
  const text = decodeText(payload);
  if (text === undefined) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;

  const { schema_version, count, quality, confidence, updated_at } = value;
  if (
    schema_version !== 1 ||
    typeof count !== 'number' ||
    !Number.isInteger(count) ||
    count < 0 ||
    (quality !== 'CERTAIN' &&
      quality !== 'DEGRADED' &&
      quality !== 'UNCERTAIN') ||
    typeof confidence !== 'number' ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1 ||
    typeof updated_at !== 'string'
  ) {
    return undefined;
  }

  const updatedAt = parseIsoTimestamp(updated_at);
  if (updatedAt === undefined) return undefined;

  return { count, quality };
}

function parseIsoTimestamp(value: string): number | undefined {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[8] ?? 0);
  const offsetMinute = Number(match[9] ?? 0);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return undefined;
  }

  const localCalendarDate = new Date(0);
  localCalendarDate.setUTCFullYear(year, month - 1, day);
  localCalendarDate.setUTCHours(hour, minute, second, 0);
  if (
    localCalendarDate.getUTCFullYear() !== year ||
    localCalendarDate.getUTCMonth() !== month - 1 ||
    localCalendarDate.getUTCDate() !== day
  ) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function decodeText(payload: unknown): string | undefined {
  if (typeof payload === 'string') return payload;
  if (!(payload instanceof Uint8Array)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
