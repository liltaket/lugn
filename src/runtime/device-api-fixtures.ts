import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimulatedLightingAdapter } from '../adapters/simulated-lighting.js';
import { SimulatedMusicAdapter } from '../adapters/simulated-music.js';
import { CapabilityRegistry } from '../application/capabilities.js';
import { withRoomPresets } from '../application/dashboard-scenes.js';
import { defaultScenes, LugnEngine } from '../application/lugn-engine.js';
import { FakeClock } from '../core/clock.js';
import { RoutineService } from '../application/routines.js';
import { createRoutineTemplates } from '../core/routines.js';
import { DeviceCommandService } from './device-commands.js';
import { RoutineApi } from './routine-api.js';
import { RoutineStore } from './routine-store.js';
import { DeviceRegistry } from './device-registry.js';
import { LugnDeviceServer } from './device-server.js';

export const FIXTURE_INSTANCE_ID = 'f1x7e5a3c0de';
const FIXTURE_NOW = Date.parse('2026-11-16T19:30:00+01:00');

type Fixture = { name: string; content: unknown };

/**
 * Produces example payloads by driving the real engine, view builder,
 * registry and HTTP listener with simulated devices. Tokens are redacted;
 * ids and session UUIDs differ on every run.
 */
export async function buildDeviceApiFixtures(): Promise<Fixture[]> {
  const clock = new FakeClock(FIXTURE_NOW);
  const lighting = new SimulatedLightingAdapter(clock);
  const music = new SimulatedMusicAdapter(clock);
  const deviceIds = ['lighting.bed', 'lighting.ceiling', 'lighting.desk'];
  const engine = new LugnEngine(clock, {
    adapter: lighting,
    deviceIds,
    scenes: withRoomPresets(defaultScenes, deviceIds),
    music: {
      targets: { 'music.room': ['Spotify', 'Optical'] },
      adapter: music,
    },
  });
  const capabilities = new CapabilityRegistry(engine);
  const directory = await mkdtemp(join(tmpdir(), 'lugn-fixtures-'));
  const registry = new DeviceRegistry(join(directory, 'devices.json'), {
    clock,
  });
  await registry.load();
  const routineStore = new RoutineStore(
    join(directory, 'routines.json'),
    createRoutineTemplates({
      lightTargets: deviceIds,
      musicTarget: 'music.room',
    }),
  );
  await routineStore.load();
  const routines = new RoutineService(clock, {
    engine,
    capabilities,
    store: routineStore,
    bedtime: {
      lightTargets: ['lighting.bed', 'lighting.desk'],
      musicTarget: 'music.room',
    },
  });
  const experience = new RoutineApi(routines, routineStore);
  const fixtures: Fixture[] = [];
  let server: LugnDeviceServer | undefined;
  try {
    await engine.handleHomePresence('home', clock.now());
    music.observe('music.room', {
      playback: 'playing',
      volume: 0.24,
      source: 'Spotify',
      title: 'Exempelspår',
      artist: 'Exempelartist',
      album: null,
    });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 1,
      source: 'fixture',
    });
    clock.advanceBy(1_000);

    server = new LugnDeviceServer({
      host: '127.0.0.1',
      port: 0,
      allowedHosts: ['lugn.example.ts.net:8789'],
      registry,
      clock,
      room: {
        sources: {
          engine,
          instanceId: FIXTURE_INSTANCE_ID,
          now: () => clock.now(),
          integrations: () => ({
            home_assistant: 'connected',
            mqtt: 'connected',
          }),
          scenePresetsEditable: true,
          experience,
          environment: () => ({
            temperature: { value: 21.4, unit: '°C', observedAt: FIXTURE_NOW },
            humidity: { value: 38, unit: '%', observedAt: FIXTURE_NOW },
            co2: { value: 612, unit: 'ppm', observedAt: FIXTURE_NOW },
            pm25: { value: null, unit: 'µg/m³', observedAt: null },
          }),
        },
        stream: engine.stream,
        subscribeAuxiliary: [(listener) => experience.subscribe(listener)],
        commands: new DeviceCommandService({
          capabilities,
          experience,
          revision: () => engine.state.revision,
          clock,
        }),
      },
    });
    await server.start();
    const port = server.address!.port;
    const api = (path: string, options: CallOptions = {}) =>
      call(port, path, options);

    const code = registry.createPairingCode();
    fixtures.push({ name: 'pairing-code', content: code });
    const pairRequest = {
      code: code.code,
      name: 'Brunos iPhone',
      platform: 'ios',
      appVersion: '1.0.0',
    };
    fixtures.push({ name: 'pair-request', content: pairRequest });
    const paired = (await api('/api/v1/pair', { body: pairRequest })).json as {
      token: string;
      deviceId: string;
    };
    const token = paired.token;
    fixtures.push({
      name: 'pair-response',
      content: { ...paired, token: redact(token) },
    });
    fixtures.push({
      name: 'me',
      content: (await api('/api/v1/me', { token })).json,
    });

    const events = openEvents(port, token);
    await events.waitFor(1);

    const command = {
      requestId: '7f0a3c52-5a8e-4c1e-9d1a-2f6c8b9e4d10',
      command: 'lighting.activateScene',
      input: { sceneId: 'scene.soft_light' },
    };
    fixtures.push({ name: 'command-request', content: command });
    fixtures.push({
      name: 'command-response',
      content: (await api('/api/v1/commands', { token, body: command })).json,
    });
    fixtures.push({
      name: 'command-replayed',
      content: (await api('/api/v1/commands', { token, body: command })).json,
    });
    fixtures.push({
      name: 'error-request-id-conflict',
      content: (
        await api('/api/v1/commands', {
          token,
          body: { ...command, input: { sceneId: 'scene.all_off' } },
        })
      ).json,
    });
    fixtures.push({
      name: 'error-unauthorized',
      content: (await api('/api/v1/state', { token: 'lgn1.invalid' })).json,
    });
    clock.advanceBy(2_000);
    lighting.externalChange('lighting.desk', { brightness: 35 });
    const generation = (
      (await api('/api/v1/state', { token })).json as {
        routines: { generation: string };
      }
    ).routines.generation;
    const bedtime = {
      requestId: '0b7c2e1a-3d4f-4a5b-8c6d-7e8f9a0b1c2d',
      command: 'routines.bedtime',
      input: {
        action: 'plan',
        wakeTime: '07:00',
        mode: 'auto',
        music: false,
        expectedGeneration: generation,
        requestId: 'fixture-bedtime-plan',
      },
    };
    fixtures.push({ name: 'command-bedtime-request', content: bedtime });
    fixtures.push({
      name: 'command-bedtime-response',
      content: (await api('/api/v1/commands', { token, body: bedtime })).json,
    });
    await events.waitFor(3);
    fixtures.push({
      name: 'state',
      content: (await api('/api/v1/state', { token })).json,
    });
    events.close();
    const parsed = parseEvents(events.text());
    fixtures.push({ name: 'event-snapshot', content: parsed[0]!.data });
    fixtures.push({
      name: 'event-patch',
      content: parsed.find((event) => event.event === 'patch')!.data,
    });
    fixtures.push({
      name: 'events',
      content: events.text().replaceAll(token, redact(token)),
    });
  } finally {
    await server?.stop();
    routines.dispose();
    engine.dispose();
    await rm(directory, { recursive: true, force: true });
  }
  return fixtures;
}

function redact(token: string): string {
  const [prefix, deviceId] = token.split('.');
  return `${prefix}.${deviceId}.${'x'.repeat(43)}`;
}

type CallOptions = { token?: string; body?: unknown };

function call(
  port: number,
  path: string,
  options: CallOptions,
): Promise<{ status: number; json: unknown }> {
  const body =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: body === undefined ? 'GET' : 'POST',
        setHost: false,
        headers: {
          host: 'lugn.example.ts.net:8789',
          ...(options.token
            ? { authorization: `Bearer ${options.token}` }
            : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            json: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
          }),
        );
      },
    );
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function openEvents(port: number, token: string) {
  let text = '';
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const count = () => (text.match(/\n\n/g) ?? []).length - 1;
  const request = httpRequest(
    {
      host: '127.0.0.1',
      port,
      path: '/api/v1/events',
      setHost: false,
      headers: {
        host: 'lugn.example.ts.net:8789',
        authorization: `Bearer ${token}`,
        accept: 'text/event-stream',
      },
    },
    (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
        for (const waiter of [...waiters])
          if (count() >= waiter.count) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve();
          }
      });
    },
  );
  request.on('error', () => undefined);
  request.end();
  return {
    text: () => text,
    close: () => request.destroy(),
    waitFor: (events: number) =>
      new Promise<void>((resolve, reject) => {
        if (count() >= events) return resolve();
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for events')),
          5_000,
        );
        waiters.push({
          count: events,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      }),
  };
}

export function parseEvents(
  text: string,
): Array<{ event: string; id: string | null; data: unknown }> {
  return text
    .split('\n\n')
    .filter((block) => /^data: /m.test(block))
    .map((block) => {
      const field = (name: string) =>
        block
          .split('\n')
          .find((line) => line.startsWith(`${name}: `))
          ?.slice(name.length + 2) ?? null;
      return {
        event: field('event') ?? 'message',
        id: field('id'),
        data: JSON.parse(field('data')!) as unknown,
      };
    });
}
