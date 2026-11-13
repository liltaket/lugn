import { mkdtemp, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { startRuntime } from '../src/runtime/main.js';
import type { SensorSocketFactory } from '../src/adapters/stl27l-sensor-stream.js';

it('loads existing presenceControl config and composes acknowledged correction without changing sensor truth or music intent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lugn-presence-control-'));
  const bodies: unknown[] = [];
  const sensor = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    expect(request.url).toBe('/api/manual');
    expect(request.method).toBe('POST');
    bodies.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, count: 1 }));
  });
  const portFinder = createServer();
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  let socket: ReturnType<SensorSocketFactory> | undefined;
  const closeSocket = vi.fn();
  try {
    await new Promise<void>((resolve) =>
      sensor.listen(0, '127.0.0.1', resolve),
    );
    await new Promise<void>((resolve) =>
      portFinder.listen(0, '127.0.0.1', resolve),
    );
    const port = (portFinder.address() as AddressInfo).port;
    await new Promise<void>((resolve) => portFinder.close(() => resolve()));
    const sensorPort = (sensor.address() as AddressInfo).port;
    vi.stubEnv('LUGN_TEST_HA_TOKEN', 'test-token');
    const configPath = join(directory, 'runtime.json');
    await writeFile(
      configPath,
      JSON.stringify({
        http: { host: '127.0.0.1', port },
        homeAssistant: {
          baseUrl: 'http://ha.invalid',
          tokenEnv: 'LUGN_TEST_HA_TOKEN',
          entities: { 'lighting.entry': 'light.entry' },
          music: { 'music.room': { entityId: 'media_player.room' } },
        },
        presenceControl: { baseUrl: `http://127.0.0.1:${sensorPort}` },
        scenes: [],
      }),
    );
    runtime = await startRuntime(configPath, {
      homeAssistantFetch: async () => Response.json([]),
      createHomeAssistantSocket: () => ({
        addEventListener: () => {},
        send: () => {},
        close: () => {},
      }),
      lightingIntentPath: join(directory, 'intent.json'),
      createSensorSocket: () => {
        socket = {
          onopen: null,
          onclose: null,
          onerror: null,
          onmessage: null,
          close: closeSocket,
        };
        return socket;
      },
    });
    // No radar browser is open: the recorder must already be subscribed.
    expect(socket).toBeDefined();
    socket!.onopen?.();
    socket!.onmessage?.({
      data: readFileSync(
        new URL('./fixtures/presence/sensor-frame.json', import.meta.url),
        'utf8',
      ),
    });
    const human = {
      actor: { type: 'user' as const },
      source: 'test.dashboard',
    };
    await runtime.engine.requestMusic(
      'music.room',
      { property: 'volume', value: 0.4 },
      human,
    );
    await runtime.engine.requestMusic(
      'music.room',
      { property: 'playback', value: 'paused' },
      human,
    );
    const presence = structuredClone(runtime.engine.state.presence);
    const musicIntent = runtime.engine.getMusicIntentSnapshot();
    const result = await fetch(
      `http://127.0.0.1:${port}/capabilities/presence.setCountOne`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: {} }),
      },
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ accepted: true, count: 1 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ count: 1 });
    expect(runtime.engine.state.presence).toEqual(presence);
    expect(runtime.engine.getMusicIntentSnapshot()).toEqual(musicIntent);
    await runtime.stop();
    runtime = undefined;
    expect(closeSocket).toHaveBeenCalledOnce();
    const capturesPath = join(directory, 'intent.json.presence-captures');
    const files = await readdir(capturesPath);
    expect(files).toHaveLength(1);
    const records = gunzipSync(await readFile(join(capturesPath, files[0]!)))
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({ acknowledged: true, frameCount: 1 });
    expect(records.find((record) => record.type === 'frame').data.scan_id).toBe(
      54,
    );
    expect(JSON.stringify(records)).not.toContain('serial_port');
  } finally {
    await runtime?.stop();
    await new Promise<void>((resolve) => sensor.close(() => resolve()));
    await new Promise<void>((resolve) => portFinder.close(() => resolve()));
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
