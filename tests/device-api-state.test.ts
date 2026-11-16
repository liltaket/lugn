import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { SimulatedMusicAdapter } from '../src/adapters/simulated-music.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { withRoomPresets } from '../src/application/dashboard-scenes.js';
import { defaultScenes, LugnEngine } from '../src/application/lugn-engine.js';
import {
  buildStateView,
  sectionsForDomains,
  whyFeed,
} from '../src/application/state-view.js';
import { FakeClock } from '../src/core/clock.js';
import {
  CommandResponseSchema,
  PairResponseSchema,
  StatePatchSchema,
  StateViewSchema,
  type DeviceScope,
} from '../src/core/device-api.js';
import {
  PhoneConfigResponseSchema,
  PhoneObservationBatchSchema,
  PhoneObservationResponseSchema,
} from '../src/core/phone.js';
import { DeviceCommandService } from '../src/runtime/device-commands.js';
import { DeviceRegistry } from '../src/runtime/device-registry.js';
import { LugnDeviceServer } from '../src/runtime/device-server.js';
import { call, findAvailablePort, openStream } from './device-api-helpers.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const DEVICES = ['lighting.bed', 'lighting.ceiling', 'lighting.desk'];

function room(at = '2026-11-16T19:30:00+01:00') {
  const clock = new FakeClock(Date.parse(at));
  const lighting = new SimulatedLightingAdapter(clock);
  const music = new SimulatedMusicAdapter(clock);
  const engine = new LugnEngine(clock, {
    adapter: lighting,
    deviceIds: DEVICES,
    scenes: withRoomPresets(defaultScenes, DEVICES),
    music: { targets: { 'music.room': ['Spotify'] }, adapter: music },
  });
  cleanups.push(() => engine.dispose());
  const sources = {
    engine,
    instanceId: 'abc123',
    now: () => clock.now(),
    integrations: () => ({ home_assistant: 'connected' }),
    scenePresetsEditable: false,
  };
  return { clock, lighting, music, engine, sources };
}

async function serve(context = room()) {
  const port = await findAvailablePort();
  const directory = mkdtempSync(join(tmpdir(), 'lugn-device-state-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const registry = new DeviceRegistry(join(directory, 'devices.json'));
  await registry.load();
  const server = new LugnDeviceServer({
    host: '127.0.0.1',
    port,
    allowedHosts: [`127.0.0.1:${port}`],
    registry,
    room: {
      sources: context.sources,
      stream: context.engine.stream,
      commands: new DeviceCommandService({
        capabilities: new CapabilityRegistry(context.engine),
        revision: () => context.engine.state.revision,
        clock: context.clock,
      }),
    },
  });
  await server.start();
  cleanups.push(() => server.stop());
  const pair = async (scopes?: DeviceScope[]) => {
    const { code } = registry.createPairingCode(scopes ? { scopes } : {});
    return PairResponseSchema.parse(
      await registry.pair({ code, name: 'iPhone', platform: 'ios' }),
    );
  };
  return { ...context, port, registry, server, pair };
}

async function enter(engine: LugnEngine, personCount = 1): Promise<void> {
  await engine.handlePresence({
    type: 'presence.changed',
    presence: 'occupied',
    personCount,
  });
}

describe('state view', () => {
  it('is a compact typed DTO without ledgers that keeps unknown presence unknown', async () => {
    const { engine, sources } = room();
    const initial = StateViewSchema.parse(buildStateView(sources));
    expect(initial.presence.state).toBe('unknown');
    expect(initial.presence.home.state).toBe('unknown');
    expect(initial.session.state).toBe('none');
    expect(Object.keys(initial)).not.toEqual(
      expect.arrayContaining(['commands']),
    );
    for (const heavy of ['commands', 'diagnostics', 'timings', 'intent'])
      expect(initial).not.toHaveProperty(heavy);

    await enter(engine, 2);
    const view = StateViewSchema.parse(buildStateView(sources));
    expect(view.presence).toMatchObject({ state: 'occupied', personCount: 2 });
    expect(view.revision).toBe(engine.state.revision);
    expect(view.lighting.scenes.find((s) => s.id === 'scene.all_off')).toEqual(
      expect.objectContaining({ icon: 'power', allOff: true, canEdit: false }),
    );
    expect(view.music.targets[0]).toMatchObject({
      id: 'music.room',
      presets: ['spotify_dj', 'optical'],
    });
  });

  it('reports observed versus intended light values and manual overrides', async () => {
    const { engine, lighting, sources } = room();
    await enter(engine);
    await engine.activateScene('scene.everyday_light', { type: 'user' });
    lighting.externalChange('lighting.desk', { brightness: 5 });
    const desk = buildStateView(sources).lighting.lights.find(
      (light) => light.id === 'lighting.desk',
    )!;
    expect(desk.name).toBe('Desk');
    expect(desk.observed.brightness).toBe(5);
    expect(desk.intent.brightness).toBe(5);
    expect(desk.overridden).toEqual(['brightness']);
    expect(desk.matchesIntent).toBe(true);
  });

  it('flags quiet hours for automatic music in Stockholm time', () => {
    const late = room('2026-11-16T23:30:00+01:00');
    expect(
      buildStateView(late.sources).music.targets[0]?.playback?.quietHours,
    ).toBe(true);
    const evening = room('2026-11-16T21:30:00+01:00');
    expect(
      buildStateView(evening.sources).music.targets[0]?.playback?.quietHours,
    ).toBe(false);
  });

  it('explains actions and deliberate non-actions in Swedish', async () => {
    const { engine } = room();
    await enter(engine);
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'unknown',
    });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'confirmed_empty',
    });
    await engine.handleHomePresence('away');
    await engine.handleEvent({ type: 'presence.prelight', active: true });
    const texts = whyFeed(engine.state).map((entry) => entry.text);
    expect(texts).toEqual(
      expect.arrayContaining([
        'Tände: någon kom in',
        'Släckte inte: sensorn vet inte om rummet är tomt',
        'Släckte: rummet är tomt',
        'Borta: automatisk tändning och musik är pausade',
        'Förtände inte: du är borta enligt Home Assistant',
      ]),
    );
    const feed = whyFeed(engine.state);
    expect(feed[0]!.at).toBeGreaterThanOrEqual(feed.at(-1)!.at);
    expect(new Set(feed.map((entry) => entry.id)).size).toBe(feed.length);
  });

  it('maps engine domains to the sections a resume must resend', () => {
    expect([...sectionsForDomains(['lighting'])].sort()).toEqual([
      'environment',
      'health',
      'lighting',
      'music',
      'routines',
      'suggestions',
    ]);
    expect(sectionsForDomains(['diagnostics']).has('why')).toBe(true);
    expect(sectionsForDomains(['timings']).has('lighting')).toBe(false);
  });
});

describe('device commands', () => {
  it('runs capabilities as the phone user, idempotently by request id', async () => {
    const { port, pair, engine } = await serve();
    const { token, deviceId } = await pair();
    const body = {
      requestId: '3c1f6a2e-0d4b-4e8a-9f7c-2a1b3c4d5e6f',
      command: 'lighting.activateScene',
      input: { sceneId: 'scene.soft_light' },
      reason: 'Från telefonen',
    };
    const first = await call(port, { path: '/api/v1/commands', token, body });
    expect(first.status).toBe(200);
    expect(CommandResponseSchema.parse(first.json())).toMatchObject({
      status: 'accepted',
      replayed: false,
      result: { sceneRevision: 1 },
    });
    const selected = engine.state.diagnostics.find(
      (entry) => entry.kind === 'scene.selected',
    )!;
    expect(selected.details).toMatchObject({
      actor: { type: 'user', id: `mobile:${deviceId}` },
      source: 'lugn.mobile',
    });
    expect(engine.state.lighting.sceneRevision).toBe(1);

    const replay = await call(port, {
      path: '/api/v1/commands',
      token,
      body: { ...body, input: { sceneId: 'scene.soft_light' } },
    });
    expect(replay.json()).toMatchObject({ replayed: true });
    expect(engine.state.lighting.sceneRevision).toBe(1);

    const conflict = await call(port, {
      path: '/api/v1/commands',
      token,
      body: { ...body, input: { sceneId: 'scene.all_off' } },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json()).toEqual({ error: 'request_id_conflict' });
  });

  it('rejects unknown commands, bad input and missing scope', async () => {
    const { port, pair } = await serve();
    const { token } = await pair();
    const base = { requestId: '9b2d7f10-1c3e-4a5b-8d6f-0e1a2b3c4d5e' };
    const status = async (body: unknown, useToken = token) =>
      (await call(port, { path: '/api/v1/commands', token: useToken, body }))
        .status;
    expect(
      await status({
        ...base,
        command: 'presence.updateSensorConfig',
        input: {},
      }),
    ).toBe(400);
    expect(
      await status({
        ...base,
        command: 'lighting.activateScene',
        input: { sceneId: 'scene.missing' },
      }),
    ).toBe(404);
    expect(
      await status({
        ...base,
        command: 'lighting.set',
        input: { target: 'lighting.desk', values: { brightness: 400 } },
      }),
    ).toBe(400);
    expect(
      await status({ requestId: 'not-a-uuid', command: 'music.play' }),
    ).toBe(400);
    const readOnly = await pair(['state:read']);
    expect(
      await status(
        { ...base, command: 'lighting.reapplyScene', input: {} },
        readOnly.token,
      ),
    ).toBe(403);
    expect(
      (await call(port, { path: '/api/v1/state', token: readOnly.token }))
        .status,
    ).toBe(200);
  });
});

describe('device event stream', () => {
  it('sends a snapshot, then section patches with revision ids', async () => {
    const { port, pair, engine } = await serve();
    const { token } = await pair();
    const stream = openStream(port, { token });
    cleanups.push(() => stream.close());
    await stream.waitForEvents(1);
    const [snapshot] = stream.events();
    expect(snapshot!.event).toBe('snapshot');
    expect(snapshot!.id).toBe(`abc123-${engine.state.revision}`);
    StateViewSchema.parse(snapshot!.data);

    await enter(engine);
    await stream.waitForEvents(2);
    const patch = stream.events()[1]!;
    expect(patch.event).toBe('patch');
    const parsed = StatePatchSchema.parse(patch.data);
    expect(parsed.sections.presence?.state).toBe('occupied');
    expect(parsed.sections).not.toHaveProperty('environment');
    expect(patch.id).toBe(`abc123-${parsed.revision}`);
  });

  it('resumes from Last-Event-ID with a patch and falls back to a snapshot', async () => {
    const { port, pair, engine } = await serve();
    const { token } = await pair();
    await enter(engine);
    const revision = engine.state.revision;
    await engine.activateScene('scene.soft_light', { type: 'user' });

    const resumed = openStream(port, {
      token,
      lastEventId: `abc123-${revision}`,
    });
    cleanups.push(() => resumed.close());
    await resumed.waitForEvents(1);
    const first = resumed.events()[0]!;
    expect(first.event).toBe('patch');
    const sections = StatePatchSchema.parse(first.data).sections;
    expect(sections.lighting?.currentSceneId).toBe('scene.soft_light');
    expect(sections).toHaveProperty('routines');
    expect(sections).not.toHaveProperty('presence');

    const restarted = openStream(port, {
      token,
      lastEventId: `other1-${engine.state.revision}`,
    });
    cleanups.push(() => restarted.close());
    await restarted.waitForEvents(1);
    expect(restarted.events()[0]!.event).toBe('snapshot');

    for (let index = 0; index < 140; index += 1)
      await engine.handlePresence({
        type: 'presence.changed',
        presence: index % 2 === 0 ? 'unknown' : 'occupied',
      });
    const tooOld = openStream(port, {
      token,
      lastEventId: `abc123-${revision}`,
    });
    cleanups.push(() => tooOld.close());
    await tooOld.waitForEvents(1);
    expect(tooOld.events()[0]!.event).toBe('snapshot');
  });

  it('caps streams per device and closes them on revocation', async () => {
    const { port, pair, registry } = await serve();
    const paired = await pair();
    const streams = [0, 1, 2].map(() =>
      openStream(port, { token: paired.token }),
    );
    for (const stream of streams) cleanups.push(() => stream.close());
    for (const stream of streams) await stream.waitForEvents(1);
    await streams[0]!.waitForEnd();
    expect(streams[1]!.ended()).toBe(false);
    await registry.revoke(paired.deviceId);
    await streams[1]!.waitForEnd();
    await streams[2]!.waitForEnd();
  });
});

describe('committed device API fixtures', () => {
  it('validate against the published schemas', () => {
    const directory = new URL('../docs/api/fixtures/', import.meta.url);
    const names = readdirSync(directory);
    expect(names).toEqual(
      expect.arrayContaining([
        'state.json',
        'event-snapshot.json',
        'event-patch.json',
        'command-response.json',
        'pair-response.json',
        'events.txt',
      ]),
    );
    const read = (name: string) =>
      JSON.parse(readFileSync(new URL(name, directory), 'utf8')) as unknown;
    StateViewSchema.parse(read('state.json'));
    StateViewSchema.parse(read('event-snapshot.json'));
    StatePatchSchema.parse(read('event-patch.json'));
    CommandResponseSchema.parse(read('command-response.json'));
    CommandResponseSchema.parse(read('command-bedtime-response.json'));
    PairResponseSchema.parse(read('pair-response.json'));
    PhoneObservationBatchSchema.parse(read('phone-observations-request.json'));
    PhoneObservationResponseSchema.parse(
      read('phone-observations-response.json'),
    );
    PhoneConfigResponseSchema.parse(read('phone-config.json'));
    expect(
      StateViewSchema.parse(read('state.json')).phone.devices,
    ).toHaveLength(1);
    expect(
      readFileSync(new URL('pair-response.json', directory), 'utf8'),
    ).toMatch(/"token": "lgn1\.dev_[a-z2-7]{16}\.x{43}"/);
  });
});
