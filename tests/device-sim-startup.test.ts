import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { StateViewSchema } from '../src/core/device-api.js';
import { DEV_PAIRING_CODE, startSim } from '../scripts/device-sim/app.js';
import { loadRecording } from '../scripts/device-sim/recording.js';
import { ReplayServer } from '../scripts/device-sim/replay.js';
import { call, findAvailablePort, openStream } from './device-api-helpers.js';

const START = Date.parse('2026-11-16T19:00:00+01:00');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function boot(options: Partial<Parameters<typeof startSim>[0]> = {}) {
  const port = await findAvailablePort();
  const sim = await startSim({
    host: '127.0.0.1',
    port,
    panelPort: null,
    controlPort: null,
    // A live clock: commands wait for simulated device latency.
    speed: 20,
    startAt: START,
    scenario: 'off',
    fixedPairingCode: DEV_PAIRING_CODE.replace('-', ''),
    ...options,
  });
  cleanups.push(() => sim.stop());
  return { sim, port };
}

async function pair(port: number, code: string) {
  const response = await call(port, {
    path: '/api/v1/pair',
    body: { code, name: 'Testtelefon', platform: 'ios' },
  });
  return {
    status: response.status,
    token: (response.json() as { token: string }).token,
  };
}

const until = async (predicate: () => boolean, label: string) => {
  for (let i = 0; i < 300 && !predicate(); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  if (!predicate()) throw new Error(`timed out waiting for ${label}`);
};

it('boots the real listener with a printed pairing code and a reusable dev code', async () => {
  const { sim, port } = await boot({
    controlPort: 0,
    panelPort: await findAvailablePort(),
  });
  expect(sim.urls).toEqual([`http://127.0.0.1:${port}`]);
  expect(sim.allowedHosts).toEqual([`127.0.0.1:${port}`, `localhost:${port}`]);
  const printed = sim.room.pairingCode!.code;
  expect(printed).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);

  const first = await pair(port, printed);
  expect(first.status).toBe(201);
  // A used code is replaced at once, so the banner always shows a valid one.
  expect(sim.room.pairingCode!.code).not.toBe(printed);
  expect((await pair(port, DEV_PAIRING_CODE)).status).toBe(201);
  expect((await pair(port, DEV_PAIRING_CODE.toLowerCase())).status).toBe(201);

  const state = await call(port, { path: '/api/v1/state', token: first.token });
  expect(state.status).toBe(200);
  const view = StateViewSchema.parse(state.json());
  expect(view.lighting.lights.map((light) => light.id)).toEqual([
    'lighting.bed',
    'lighting.ceiling',
    'lighting.desk',
  ]);
  expect(view.health.status).toBe('ok');
  expect(view.environment?.co2.unit).toBe('ppm');
  expect(
    (
      await call(port, {
        path: '/api/v1/state',
        token: first.token,
        host: 'evil.example:80',
      })
    ).status,
  ).toBe(421);

  // Control-panel API on loopback issues codes like production.
  const panel = await call(
    Number(sim.room.controlPanelUrl!.split(':').at(-1)),
    {
      path: '/devices/pairing',
      body: {},
    },
  );
  expect(panel.status).toBe(201);
  expect(
    (await pair(port, (panel.json() as { code: string }).code)).status,
  ).toBe(201);

  // Simulator control endpoint: text commands, status, and no browsers.
  const controlPort = Number(sim.controlUrl!.split(':').at(-1));
  const scene = await call(controlPort, {
    path: '/sim/command',
    rawBody: 'scene film',
    headers: { 'content-type': 'text/plain' },
  });
  expect(scene.text.trim()).toBe('scene scene.movie_light');
  expect(sim.room.engine.state.lighting.currentScene).toBe('scene.movie_light');
  const bad = await call(controlPort, {
    path: '/sim/command',
    body: { command: 'scene nonsense' },
  });
  expect(bad.status).toBe(400);
  expect(
    (
      await call(controlPort, {
        path: '/sim/status',
        headers: { origin: 'http://x' },
      })
    ).status,
  ).toBe(403);
  const status = (await call(controlPort, { path: '/sim/status' })).json() as {
    scene: string;
    instanceId: string;
  };
  expect(status.scene).toBe('scene.movie_light');
  expect(status.instanceId).toBe(sim.room.instanceId);
});

it('injects slow and failed acks and judges a real phone on the virtual clock', async () => {
  const { sim, port } = await boot();
  const { token } = await pair(port, DEV_PAIRING_CODE);
  const command = (requestId: string, sceneId: string) =>
    call(port, {
      path: '/api/v1/commands',
      token,
      body: {
        requestId,
        command: 'lighting.activateScene',
        input: { sceneId },
      },
    });
  await sim.command('ack fail');
  const failed = await command(
    '3c1f6a2e-0d4b-4e8a-9f7c-2a1b3c4d5e61',
    'scene.focus_light',
  );
  expect(failed.status).toBe(502);
  expect(failed.json()).toEqual({ error: 'command_failed' });
  expect(sim.room.engine.state.lighting.currentScene).not.toBe(
    'scene.focus_light',
  );
  // Not stored: the retry with the same id runs.
  const retried = await command(
    '3c1f6a2e-0d4b-4e8a-9f7c-2a1b3c4d5e61',
    'scene.focus_light',
  );
  expect(retried.json()).toMatchObject({ status: 'accepted', replayed: false });

  await sim.command('ack slow 250');
  const startedAt = Date.now();
  const slow = command(
    '3c1f6a2e-0d4b-4e8a-9f7c-2a1b3c4d5e62',
    'scene.soft_light',
  );
  // The intent is taken before the late answer arrives.
  await until(
    () => sim.room.engine.state.lighting.currentScene === 'scene.soft_light',
    'scene change',
  );
  expect((await slow).status).toBe(200);
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(240);

  // The virtual clock is far from wall time; a fresh phone event still applies.
  expect(await sim.command('jump 3h')).toContain('virtual time now');
  const observed = await call(port, {
    path: '/api/v1/phone/observations',
    token,
    body: {
      sessionId: '5d0c4b9a-8e7f-4a6b-9c1d-2e3f4a5b6c7d',
      observations: [
        {
          eventId: '1a2b3c4d-0001-4e5f-8a9b-0c1d2e3f4a5b',
          sequence: 1,
          observedAt: Date.now(),
          type: 'focus',
          mode: 'sleep',
        },
      ],
    },
  });
  expect(observed.json()).toMatchObject({ results: [{ status: 'applied' }] });
  expect(sim.room.view().phone.facts.focus?.mode).toBe('sleep');
});

it('restarts with a new instanceId (snapshot) and goes offline keeping it (resume patch)', async () => {
  const { sim, port } = await boot();
  const { token } = await pair(port, DEV_PAIRING_CODE);
  const stream = openStream(port, { token });
  await stream.waitForEvents(1);
  const first = stream.events()[0]!;
  expect(first.event).toBe('snapshot');
  await sim.command('scene cozy');
  await stream.waitForEvents(2);
  const lastId = stream.events().at(-1)!.id!;

  await sim.command('offline 0.1');
  await stream.waitForEnd();
  await until(() => !sim.room.online, 'offline');
  await until(() => sim.room.online, 'online');
  const resumed = openStream(port, { token, lastEventId: lastId });
  await resumed.waitForEvents(1);
  expect(resumed.events()[0]!.event).toBe('patch');
  resumed.close();

  const before = sim.room.instanceId;
  await sim.command('restart 0.1');
  await until(() => sim.room.restarts === 1 && sim.room.online, 'restart');
  expect(sim.room.instanceId).not.toBe(before);
  const afterRestart = openStream(port, { token, lastEventId: lastId });
  await afterRestart.waitForEvents(1);
  const snapshot = afterRestart.events()[0]!;
  expect(snapshot.event).toBe('snapshot');
  expect(snapshot.data['instanceId']).toBe(sim.room.instanceId);
  afterRestart.close();
  stream.close();
});

it('records the stream and replays it read-only from a frozen position', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lugn-device-sim-record-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'session.jsonl');
  const { sim } = await boot({ record: file });
  await sim.command('presence occupied 2');
  await sim.command('scene movie');
  await until(() => sim.recorder!.lines >= 4, 'recorded lines');
  await new Promise((resolve) => setTimeout(resolve, 100));
  await sim.stop();
  cleanups.pop();
  expect(await readFile(file, 'utf8')).not.toContain('lgn1.');

  const recording = await loadRecording(file);
  expect(
    recording.lines.some(
      (line) => line.type === 'sse' && line.event === 'patch',
    ),
  ).toBe(true);
  const port = await findAvailablePort();
  const replay = new ReplayServer({
    recording,
    host: '127.0.0.1',
    port,
    allowedHosts: [`127.0.0.1:${port}`],
    stateDir: directory,
    speed: 1_000,
    fixedPairingCode: 'DEV00000',
  });
  await replay.start();
  cleanups.push(() => replay.stop());
  await until(() => replay.currentPosition >= replay.duration, 'end of replay');
  const { token } = await pair(port, DEV_PAIRING_CODE);
  const state = StateViewSchema.parse(
    (await call(port, { path: '/api/v1/state', token })).json(),
  );
  expect(state.lighting.currentSceneId).toBe('scene.movie_light');
  expect(state.presence.personCount).toBe(2);
  const stream = openStream(port, { token });
  await stream.waitForEvents(1);
  expect(stream.events()[0]!.event).toBe('snapshot');
  expect(stream.events()[0]!.data['revision']).toBe(state.revision);
  stream.close();
  const refused = await call(port, {
    path: '/api/v1/commands',
    token,
    body: {
      requestId: '3c1f6a2e-0d4b-4e8a-9f7c-2a1b3c4d5e6f',
      command: 'lighting.activateScene',
      input: { sceneId: 'scene.all_off' },
    },
  });
  expect(refused.status).toBe(503);
  expect(refused.json()).toEqual({ error: 'replay_read_only' });
});
