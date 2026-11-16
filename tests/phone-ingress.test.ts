import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PhoneIngress,
  type ArrivalHint,
} from '../src/adapters/phone-ingress.js';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { withRoomPresets } from '../src/application/dashboard-scenes.js';
import { defaultScenes, LugnEngine } from '../src/application/lugn-engine.js';
import { buildStateView } from '../src/application/state-view.js';
import { FakeClock } from '../src/core/clock.js';
import {
  PhoneObservationResponseSchema,
  phoneFacts,
} from '../src/core/phone.js';
import type { PhoneState } from '../src/core/phone.js';
import {
  DeviceApiConfigSchema,
  phoneConfigResponse,
} from '../src/runtime/device-config.js';
import { DeviceRegistry } from '../src/runtime/device-registry.js';
import { LugnDeviceServer } from '../src/runtime/device-server.js';
import { call, findAvailablePort } from './device-api-helpers.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const NOW = Date.parse('2026-11-16T19:30:00+01:00');
const DEVICE = 'dev_aaaaaaaaaaaaaaaa';
const SESSION = '5d0c4b9a-8e7f-4a6b-9c1d-2e3f4a5b6c7d';
let nextEvent = 1;
function eventId(): string {
  return `00000000-0000-4000-8000-${String(nextEvent++).padStart(12, '0')}`;
}

function config(phone: Record<string, unknown> = {}) {
  return DeviceApiConfigSchema.parse({
    enabled: true,
    host: '127.0.0.1',
    port: 8789,
    allowedHosts: ['127.0.0.1:8789'],
    phone,
  }).phone;
}

function ingress(
  phone = config(),
  clock = new FakeClock(NOW),
): {
  clock: FakeClock;
  ingress: PhoneIngress;
  states: PhoneState[];
  hints: Array<ArrivalHint | null>;
} {
  const states: PhoneState[] = [];
  const hints: Array<ArrivalHint | null> = [];
  const value = new PhoneIngress({
    clock,
    signals: phone.signals,
    maxObservationAgeMs: phone.maxObservationAgeSeconds * 1000,
    arrivalPrelight: {
      enabled: phone.arrivalPrelight.enabled,
      zoneId: phone.arrivalPrelight.zoneId,
      windowMs: phone.arrivalPrelight.windowSeconds * 1000,
    },
    onState: (state) => states.push(state),
    onArrivalHint: (hint) => hints.push(hint),
  });
  cleanups.push(() => value.dispose());
  return { clock, ingress: value, states, hints };
}

function batch(...observations: Array<Record<string, unknown>>) {
  return {
    sessionId: SESSION,
    observations: observations.map((observation, index) => ({
      eventId: eventId(),
      sequence: index + 1,
      observedAt: NOW,
      ...observation,
    })),
  };
}

describe('phone ingress', () => {
  it('applies valid hints and is idempotent per event and session sequence', () => {
    const { ingress: value, states } = ingress();
    const first = batch(
      { type: 'app', state: 'foreground' },
      { type: 'geofence', zoneId: 'home', transition: 'enter' },
    );
    const result = PhoneObservationResponseSchema.parse(
      value.accept(DEVICE, 'iPhone', first),
    );
    expect(result.results.map((entry) => entry.status)).toEqual([
      'applied',
      'applied',
    ]);
    expect(states.at(-1)!.devices[DEVICE]!.signals.geofence['home']).toEqual(
      expect.objectContaining({ inside: true, fresh: true }),
    );
    const emitted = states.length;
    expect(
      value
        .accept(DEVICE, 'iPhone', first)
        .results.map((entry) => entry.status),
    ).toEqual(['duplicate', 'duplicate']);
    const reused = value.accept(DEVICE, 'iPhone', {
      sessionId: SESSION,
      observations: [
        {
          eventId: eventId(),
          sequence: 1,
          observedAt: NOW,
          type: 'app',
          state: 'background',
        },
      ],
    });
    expect(reused.results[0]).toEqual(
      expect.objectContaining({
        status: 'rejected',
        reason: 'sequence_reused',
      }),
    );
    // Only lastSeenAt could change, and it did not; nothing new is published.
    expect(states.length).toBe(emitted);
  });

  it('rejects stale and far-future events, ignores disabled signals and keeps newer values', () => {
    const { ingress: value, states } = ingress(
      config({ signals: { focus: false }, maxObservationAgeSeconds: 3600 }),
    );
    const response = value.accept(
      DEVICE,
      'iPhone',
      batch(
        { type: 'power', charging: true, batteryLevel: 0.5 },
        {
          type: 'power',
          charging: false,
          batteryLevel: 0.4,
          observedAt: NOW - 60_000,
        },
        { type: 'app', state: 'foreground', observedAt: NOW - 3_600_001 },
        { type: 'app', state: 'foreground', observedAt: NOW + 10 * 60_000 },
        { type: 'focus', mode: 'sleep' },
        { type: 'motion', activity: 'walking', confidence: 'high' },
      ),
    );
    expect(response.results.map((r) => r.reason ?? r.status)).toEqual([
      'applied',
      'older_than_current',
      'stale',
      'future_timestamp',
      'signal_disabled',
      'signal_disabled',
    ]);
    const signals = states.at(-1)!.devices[DEVICE]!.signals;
    expect(signals.power).toEqual(
      expect.objectContaining({ charging: true, batteryLevel: 0.5 }),
    );
    expect(signals.app).toBeNull();
    expect(signals.focus).toBeNull();
    expect(signals.motion).toBeNull();
  });

  it('lets signals go stale and then forgets them, so silence becomes unknown', () => {
    const { ingress: value, clock, states } = ingress();
    value.accept(
      DEVICE,
      'iPhone',
      batch(
        { type: 'app', state: 'heartbeat' },
        { type: 'geofence', zoneId: 'home', transition: 'enter' },
        {
          type: 'wake_alarm',
          at: NOW + 60 * 60_000,
          source: 'sleep_schedule',
        },
      ),
    );
    clock.advanceBy(11 * 60_000);
    let signals = states.at(-1)!.devices[DEVICE]!.signals;
    expect(signals.app?.fresh).toBe(false);
    expect(signals.geofence['home']?.fresh).toBe(true);
    clock.advanceBy(3 * 60 * 60_000);
    signals = states.at(-1)!.devices[DEVICE]!.signals;
    expect(signals.wakeAlarm).toBeNull();
    clock.advanceBy(24 * 60 * 60_000);
    // Still "inside home" a day later is not evidence; it is simply gone.
    expect(states.at(-1)!.devices[DEVICE]).toBeUndefined();
  });

  it('raises a bounded arrival hint only when enabled', () => {
    const disabled = ingress();
    disabled.ingress.accept(
      DEVICE,
      'iPhone',
      batch({ type: 'geofence', zoneId: 'home', transition: 'enter' }),
    );
    expect(disabled.hints.filter((hint) => hint !== null)).toEqual([]);

    const enabled = ingress(
      config({ arrivalPrelight: { enabled: true, windowSeconds: 300 } }),
    );
    enabled.ingress.accept(
      DEVICE,
      'iPhone',
      batch(
        { type: 'geofence', zoneId: 'office', transition: 'enter' },
        { type: 'geofence', zoneId: 'home', transition: 'enter' },
      ),
    );
    expect(enabled.hints.at(-1)).toEqual({
      until: NOW + 300_000,
      deviceId: DEVICE,
      zoneId: 'home',
    });
    enabled.clock.advanceBy(301_000);
    expect(enabled.hints.at(-1)).toBeNull();

    const exit = ingress(config({ arrivalPrelight: { enabled: true } }));
    exit.ingress.accept(
      DEVICE,
      'iPhone',
      batch({ type: 'geofence', zoneId: 'home', transition: 'enter' }),
    );
    exit.ingress.accept(DEVICE, 'iPhone', {
      sessionId: SESSION,
      observations: [
        {
          eventId: eventId(),
          sequence: 9,
          observedAt: NOW,
          type: 'geofence',
          zoneId: 'home',
          transition: 'exit',
        },
      ],
    });
    expect(exit.hints.at(-1)).toBeNull();

    const late = ingress(config({ arrivalPrelight: { enabled: true } }));
    late.ingress.accept(
      DEVICE,
      'iPhone',
      batch({
        type: 'geofence',
        zoneId: 'home',
        transition: 'enter',
        observedAt: NOW - 11 * 60_000,
      }),
    );
    expect(late.hints.filter((hint) => hint !== null)).toEqual([]);

    const revoked = ingress(config({ arrivalPrelight: { enabled: true } }));
    revoked.ingress.accept(
      DEVICE,
      'iPhone',
      batch({ type: 'geofence', zoneId: 'home', transition: 'enter' }),
    );
    revoked.ingress.forget(DEVICE);
    expect(revoked.hints.at(-1)).toBeNull();
    expect(revoked.states.at(-1)!.devices).toEqual({});
  });

  it('exposes fresh facts for routines without inventing absent ones', () => {
    const { ingress: value, clock, states } = ingress();
    value.accept(
      DEVICE,
      'iPhone',
      batch(
        { type: 'focus', mode: 'sleep' },
        { type: 'power', charging: null, batteryLevel: 0.2 },
        { type: 'wake_alarm', at: NOW + 9 * 60 * 60_000, source: 'shortcut' },
      ),
    );
    const facts = phoneFacts(states.at(-1)!, clock.now());
    expect(facts.focus).toMatchObject({ mode: 'sleep', deviceId: DEVICE });
    expect(facts.charging).toBeNull();
    expect(facts.wakeAlarm?.at).toBe(NOW + 9 * 60 * 60_000);
    clock.advanceBy(13 * 60 * 60_000);
    expect(phoneFacts(states.at(-1)!, clock.now()).focus).toBeNull();
  });
});

describe('phone hints in the engine', () => {
  function engine() {
    const clock = new FakeClock(NOW);
    const lighting = new SimulatedLightingAdapter(clock);
    const ids = ['lighting.ceiling', 'lighting.desk'];
    const value = new LugnEngine(clock, {
      adapter: lighting,
      deviceIds: ids,
      scenes: withRoomPresets(defaultScenes, ids),
      prelight: { targets: {}, maxDurationMs: 5_000 },
    });
    cleanups.push(() => value.dispose());
    return { clock, lighting, engine: value };
  }
  const phoneHome: PhoneState = {
    devices: {
      [DEVICE]: {
        deviceId: DEVICE,
        name: 'iPhone',
        lastSeenAt: NOW,
        signals: {
          app: null,
          geofence: {
            home: {
              observedAt: NOW,
              receivedAt: NOW,
              fresh: true,
              inside: true,
            },
          },
          power: null,
          focus: null,
          wakeAlarm: null,
          motion: null,
          network: null,
        },
      },
    },
  };

  it('never changes room presence or lighting by itself', async () => {
    const { engine: value, lighting } = engine();
    const updates: string[][] = [];
    value.stream.subscribe((update) => updates.push([...update.domains]));
    value.acceptPhoneState(phoneHome);
    value.setPrelightArrivalHint({
      until: NOW + 60_000,
      deviceId: DEVICE,
      zoneId: 'home',
    });
    expect(updates).toEqual([['phone']]);
    expect(value.state.presence.state).toBe('unknown');
    expect(lighting.dispatched).toEqual([]);
    expect(
      buildStateView({
        engine: value,
        instanceId: 'abc',
        now: () => NOW,
        integrations: () => ({}),
        scenePresetsEditable: false,
      }).phone.devices[0]?.signals.geofence['home']?.inside,
    ).toBe(true);

    await value.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    await value.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
    });
    // "Phone home" with a sensor-confirmed empty room is still an empty room.
    value.acceptPhoneState(phoneHome);
    expect(value.state.presence.state).toBe('confirmed_empty');
  });

  it('lets a recent arrival waive only the away gate of sensor prelight', async () => {
    const { engine: value, lighting } = engine();
    await value.handleHomePresence('away');
    await value.handleEvent({ type: 'presence.prelight', active: true });
    expect(lighting.dispatched).toEqual([]);
    expect(value.state.diagnostics.at(-1)).toMatchObject({
      kind: 'presence.prelight_suppressed',
      details: { reason: 'home_away' },
    });
    await value.handleEvent({ type: 'presence.prelight', active: false });

    value.setPrelightArrivalHint({
      until: NOW + 60_000,
      deviceId: DEVICE,
      zoneId: 'home',
    });
    await value.handleEvent({ type: 'presence.prelight', active: true });
    expect(lighting.dispatched.length).toBeGreaterThan(0);
    expect(
      value.state.diagnostics.some(
        (entry) => entry.kind === 'presence.prelight_arrival_hint',
      ),
    ).toBe(true);
    // Prelight is not occupancy.
    expect(value.state.presence.state).toBe('unknown');
    // Confirmed entry still follows the Home Assistant away gate.
    await value.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    expect(
      value.state.diagnostics.some(
        (entry) => entry.kind === 'presence.lighting_suppressed_home_away',
      ),
    ).toBe(true);

    // An expired hint is no hint.
    const expired = engine();
    await expired.engine.handleHomePresence('away');
    expired.engine.setPrelightArrivalHint({
      until: NOW,
      deviceId: DEVICE,
      zoneId: 'home',
    });
    await expired.engine.handleEvent({
      type: 'presence.prelight',
      active: true,
    });
    expect(expired.lighting.dispatched).toEqual([]);
    expect(expired.engine.state.diagnostics.at(-1)).toMatchObject({
      kind: 'presence.prelight_suppressed',
      details: { reason: 'home_away' },
    });
  });
});

describe('phone observation endpoint', () => {
  it('requires the ingest scope, publishes config and forgets revoked phones', async () => {
    const port = await findAvailablePort();
    const directory = mkdtempSync(join(tmpdir(), 'lugn-phone-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const registry = new DeviceRegistry(join(directory, 'devices.json'));
    await registry.load();
    const phone = config();
    const { ingress: value, states } = ingress(
      phone,
      new FakeClock(Date.now()),
    );
    const server = new LugnDeviceServer({
      host: '127.0.0.1',
      port,
      allowedHosts: [`127.0.0.1:${port}`],
      registry,
      phone: { ingress: value, config: phoneConfigResponse(phone) },
    });
    await server.start();
    cleanups.push(() => server.stop());
    const pair = async (scopes: Array<'state:read' | 'phone:ingest'>) => {
      const { code } = registry.createPairingCode({ scopes });
      return registry.pair({ code, name: 'iPhone', platform: 'ios' });
    };
    const ingest = await pair(['phone:ingest']);
    const reader = await pair(['state:read']);

    const configResponse = await call(port, {
      path: '/api/v1/phone/config',
      token: ingest.token,
    });
    expect(configResponse.json()).toMatchObject({
      signals: { geofence: true, motion: false, network: false },
      maxBatchSize: 100,
    });
    const body = {
      sessionId: SESSION,
      observations: [
        {
          eventId: eventId(),
          sequence: 1,
          observedAt: Date.now(),
          type: 'app',
          state: 'foreground',
        },
      ],
    };
    expect(
      (
        await call(port, {
          path: '/api/v1/phone/observations',
          token: reader.token,
          body,
        })
      ).status,
    ).toBe(403);
    const accepted = await call(port, {
      path: '/api/v1/phone/observations',
      token: ingest.token,
      body,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.json()).toMatchObject({
      results: [{ status: 'applied' }],
    });
    expect(states.at(-1)!.devices[ingest.deviceId]?.name).toBe('iPhone');
    expect(
      (
        await call(port, {
          path: '/api/v1/phone/observations',
          token: ingest.token,
          rawBody: JSON.stringify({ ...body, padding: 'x'.repeat(70_000) }),
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await call(port, {
          path: '/api/v1/phone/observations',
          token: ingest.token,
          body: { sessionId: SESSION, observations: [] },
        })
      ).status,
    ).toBe(400);

    await registry.revoke(ingest.deviceId);
    expect(states.at(-1)!.devices).toEqual({});
  });
});
