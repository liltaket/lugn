import type { Clock, TimerHandle } from '../core/clock.js';
import {
  emptyPhoneSignals,
  PhoneObservationBatchSchema,
  PhoneSignalWindows,
  WAKE_ALARM_GRACE_MS,
  type PhoneDeviceState,
  type PhoneObservation,
  type PhoneObservationResponse,
  type PhoneSignalName,
  type PhoneSignalSettings,
  type PhoneState,
} from '../core/phone.js';

const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_REMEMBERED_EVENTS = 1024;
const MAX_SESSIONS_PER_DEVICE = 8;
const MAX_ZONES = 8;
const SWEEP_MS = 60_000;

export type ArrivalHint = { until: number; deviceId: string; zoneId: string };

export type PhoneIngressOptions = {
  clock: Clock;
  signals: PhoneSignalSettings;
  maxObservationAgeMs: number;
  arrivalPrelight: { enabled: boolean; zoneId: string; windowMs: number };
  onState: (state: PhoneState) => void;
  onArrivalHint?: (hint: ArrivalHint | null) => void;
};

type Memory = {
  events: Map<string, true>;
  sessions: Map<string, Map<number, string>>;
};

const SIGNAL_BY_TYPE: Record<PhoneObservation['type'], PhoneSignalName> = {
  app: 'app',
  geofence: 'geofence',
  power: 'power',
  focus: 'focus',
  wake_alarm: 'wakeAlarm',
  motion: 'motion',
  network: 'network',
};

/**
 * Validates batched phone observations into an observation-only domain.
 * Duplicates are idempotent, old or far-future events are rejected, and an
 * event older than the current value of its signal never replaces it. Signals
 * fade from fresh to stale and are then forgotten, so silence becomes
 * unknown rather than a remembered "still home".
 */
export class PhoneIngress {
  private readonly devices = new Map<string, PhoneDeviceState>();
  private readonly memory = new Map<string, Memory>();
  private readonly hints = new Map<string, ArrivalHint>();
  private lastHint: string | undefined;
  private sweepTimer: TimerHandle | undefined;
  private lastEmitted = '';
  private disposed = false;

  constructor(private readonly options: PhoneIngressOptions) {}

  accept(
    deviceId: string,
    name: string,
    raw: unknown,
  ): PhoneObservationResponse {
    const batch = PhoneObservationBatchSchema.parse(raw);
    const now = this.options.clock.now();
    const memory = this.memoryFor(deviceId, batch.sessionId);
    const sequences = memory.sessions.get(batch.sessionId)!;
    const device = this.devices.get(deviceId) ?? {
      deviceId,
      name,
      lastSeenAt: null,
      signals: emptyPhoneSignals(),
    };
    device.name = name;
    device.lastSeenAt = now;
    const results: PhoneObservationResponse['results'] = [];
    for (const observation of batch.observations) {
      const eventId = observation.eventId;
      if (memory.events.has(eventId)) {
        results.push({ eventId, status: 'duplicate' });
        continue;
      }
      const knownSequence = sequences.get(observation.sequence);
      if (knownSequence !== undefined && knownSequence !== eventId) {
        results.push({
          eventId,
          status: 'rejected',
          reason: 'sequence_reused',
        });
        continue;
      }
      if (now - observation.observedAt > this.options.maxObservationAgeMs) {
        results.push({ eventId, status: 'rejected', reason: 'stale' });
        continue;
      }
      if (observation.observedAt - now > MAX_FUTURE_SKEW_MS) {
        results.push({
          eventId,
          status: 'rejected',
          reason: 'future_timestamp',
        });
        continue;
      }
      remember(memory.events, eventId, true, MAX_REMEMBERED_EVENTS);
      remember(sequences, observation.sequence, eventId, MAX_REMEMBERED_EVENTS);
      if (!this.options.signals[SIGNAL_BY_TYPE[observation.type]]) {
        results.push({
          eventId,
          status: 'ignored',
          reason: 'signal_disabled',
        });
        continue;
      }
      results.push(
        this.apply(device, observation, now)
          ? { eventId, status: 'applied' }
          : { eventId, status: 'superseded', reason: 'older_than_current' },
      );
    }
    this.devices.set(deviceId, device);
    this.refresh(now);
    this.emit();
    this.scheduleSweep();
    return { serverTime: now, results };
  }

  /** Drops a revoked device's observations and hints. */
  forget(deviceId: string): void {
    this.memory.delete(deviceId);
    this.hints.delete(deviceId);
    if (this.devices.delete(deviceId)) this.emit();
    this.emitHint();
  }

  snapshot(): PhoneState {
    return { devices: Object.fromEntries(structuredClone([...this.devices])) };
  }

  dispose(): void {
    this.disposed = true;
    if (this.sweepTimer !== undefined)
      this.options.clock.clearTimeout(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  private memoryFor(deviceId: string, sessionId: string): Memory {
    let memory = this.memory.get(deviceId);
    if (!memory) {
      memory = { events: new Map(), sessions: new Map() };
      this.memory.set(deviceId, memory);
    }
    const sequences = memory.sessions.get(sessionId) ?? new Map();
    remember(memory.sessions, sessionId, sequences, MAX_SESSIONS_PER_DEVICE);
    return memory;
  }

  private apply(
    device: PhoneDeviceState,
    observation: PhoneObservation,
    now: number,
  ): boolean {
    const stamp = {
      observedAt: observation.observedAt,
      receivedAt: now,
      fresh: true,
    };
    const signals = device.signals;
    const newer = (current: { observedAt: number } | null | undefined) =>
      !current || observation.observedAt >= current.observedAt;
    switch (observation.type) {
      case 'app':
        if (!newer(signals.app)) return false;
        signals.app = { ...stamp, state: observation.state };
        return true;
      case 'geofence': {
        const zone = signals.geofence[observation.zoneId];
        if (!newer(zone)) return false;
        if (!zone && Object.keys(signals.geofence).length >= MAX_ZONES)
          return false;
        signals.geofence[observation.zoneId] = {
          ...stamp,
          inside: observation.transition === 'enter',
        };
        this.updateHint(device.deviceId, observation, now);
        return true;
      }
      case 'power':
        if (!newer(signals.power)) return false;
        signals.power = {
          ...stamp,
          charging: observation.charging,
          batteryLevel: observation.batteryLevel,
        };
        return true;
      case 'focus':
        if (!newer(signals.focus)) return false;
        signals.focus = { ...stamp, mode: observation.mode };
        return true;
      case 'wake_alarm':
        if (!newer(signals.wakeAlarm)) return false;
        signals.wakeAlarm = {
          ...stamp,
          at: observation.at,
          source: observation.source,
        };
        return true;
      case 'motion':
        if (!newer(signals.motion)) return false;
        signals.motion = {
          ...stamp,
          activity: observation.activity,
          confidence: observation.confidence,
        };
        return true;
      case 'network':
        if (!newer(signals.network)) return false;
        signals.network = {
          ...stamp,
          kind: observation.kind,
          homeNetwork: observation.homeNetwork,
        };
        return true;
    }
  }

  private updateHint(
    deviceId: string,
    observation: Extract<PhoneObservation, { type: 'geofence' }>,
    now: number,
  ): void {
    const config = this.options.arrivalPrelight;
    if (!config.enabled || observation.zoneId !== config.zoneId) return;
    if (observation.transition === 'exit') this.hints.delete(deviceId);
    else if (now - observation.observedAt <= config.windowMs)
      this.hints.set(deviceId, {
        until: observation.observedAt + config.windowMs,
        deviceId,
        zoneId: observation.zoneId,
      });
  }

  /** Recomputes freshness and forgets expired signals. */
  private refresh(now: number): void {
    for (const [deviceId, device] of this.devices) {
      const signals = device.signals;
      const keep = <T extends { observedAt: number; fresh: boolean }>(
        signal: T | null,
        name: PhoneSignalName,
        extraFresh = true,
      ): T | null => {
        if (!signal) return null;
        const age = now - signal.observedAt;
        if (age > PhoneSignalWindows[name].retainMs) return null;
        signal.fresh = extraFresh && age <= PhoneSignalWindows[name].freshMs;
        return signal;
      };
      signals.app = keep(signals.app, 'app');
      signals.power = keep(signals.power, 'power');
      signals.focus = keep(signals.focus, 'focus');
      signals.motion = keep(signals.motion, 'motion');
      signals.network = keep(signals.network, 'network');
      const alarm = signals.wakeAlarm;
      signals.wakeAlarm =
        alarm && alarm.at !== null && alarm.at + WAKE_ALARM_GRACE_MS <= now
          ? null
          : keep(alarm, 'wakeAlarm');
      for (const [zoneId, zone] of Object.entries(signals.geofence)) {
        const kept = keep(zone, 'geofence');
        if (kept) signals.geofence[zoneId] = kept;
        else delete signals.geofence[zoneId];
      }
      const empty =
        signals.app === null &&
        signals.power === null &&
        signals.focus === null &&
        signals.wakeAlarm === null &&
        signals.motion === null &&
        signals.network === null &&
        Object.keys(signals.geofence).length === 0;
      // A silent phone eventually disappears instead of lingering as "seen".
      if (
        empty &&
        device.lastSeenAt !== null &&
        now - device.lastSeenAt > PhoneSignalWindows.app.retainMs
      )
        this.devices.delete(deviceId);
    }
    for (const [deviceId, hint] of this.hints)
      if (hint.until <= now) this.hints.delete(deviceId);
    this.emitHint();
  }

  private emitHint(): void {
    let best: ArrivalHint | null = null;
    for (const hint of this.hints.values())
      if (!best || hint.until > best.until) best = hint;
    const key = JSON.stringify(best);
    if (key === this.lastHint) return;
    this.lastHint = key;
    this.options.onArrivalHint?.(best ? { ...best } : null);
  }

  private emit(): void {
    const state = this.snapshot();
    const key = JSON.stringify(state);
    if (key === this.lastEmitted) return;
    this.lastEmitted = key;
    this.options.onState(state);
  }

  private scheduleSweep(): void {
    if (this.disposed || this.sweepTimer !== undefined) return;
    this.sweepTimer = this.options.clock.setTimeout(() => {
      this.sweepTimer = undefined;
      this.refresh(this.options.clock.now());
      this.emit();
      if (this.devices.size > 0 || this.hints.size > 0) this.scheduleSweep();
    }, SWEEP_MS);
  }
}

function remember<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value!);
}
