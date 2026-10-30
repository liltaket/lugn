import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type {
  HomeAssistantSocket,
  HomeAssistantSocketMessageEvent,
} from '../src/adapters/home-assistant-websocket.js';
import {
  createCameraSettings,
  type CameraDashboardConfig,
  type CameraDashboardSnapshot,
} from '../src/core/cameras.js';
import { CameraSettingsStore } from '../src/runtime/camera-settings-store.js';
import { startRuntime } from '../src/runtime/main.js';
class FakeSocket implements HomeAssistantSocket {
  sent: string[] = [];
  listeners = new Map<
    string,
    Array<(event?: HomeAssistantSocketMessageEvent) => void>
  >();
  addEventListener(
    type: 'message',
    listener: (event: HomeAssistantSocketMessageEvent) => void,
  ): void;
  addEventListener(type: 'close' | 'error', listener: () => void): void;
  addEventListener(
    type: string,
    listener: ((event: HomeAssistantSocketMessageEvent) => void) | (() => void),
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(
      listener as (event?: HomeAssistantSocketMessageEvent) => void,
    );
    this.listeners.set(type, listeners);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.listeners.get('close')?.forEach((listener) => listener());
  }
  receive(message: unknown) {
    this.listeners
      .get('message')
      ?.forEach((listener) => listener({ data: JSON.stringify(message) }));
  }
  fail() {
    this.listeners.get('error')?.forEach((listener) => listener());
  }
}
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as AddressInfo).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;
}
it('composes private camera settings and trusts only successfully seeded authenticated HA observations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lugn-camera-runtime-'));
  const port = await freePort();
  const statePath = join(directory, 'state.json');
  const cameraDashboard: CameraDashboardConfig = {
    cameras: [{ id: 'entry', name: 'Entré', entityId: 'camera.entry' }],
    triggers: [
      {
        id: 'motion',
        name: 'Rörelse',
        cameraId: 'entry',
        kind: 'state',
        entityId: 'binary_sensor.motion',
        from: 'off',
        to: 'on',
      },
    ],
  };
  const preferences = new CameraSettingsStore(
    `${statePath}.cameras.json`,
    createCameraSettings(cameraDashboard),
  );
  await preferences.load();
  await preferences.save(
    {
      ...preferences.snapshot().settings,
      enabled: true,
      automaticEnabled: true,
      triggers: { motion: true },
    },
    preferences.snapshot().generation,
  );
  vi.stubEnv('LUGN_CAMERA_TEST_TOKEN', 'test-secret');
  const path = join(directory, 'config.json');
  await writeFile(
    path,
    JSON.stringify({
      http: { host: '127.0.0.1', port },
      homeAssistant: {
        baseUrl: 'http://ha.invalid',
        tokenEnv: 'LUGN_CAMERA_TEST_TOKEN',
        entities: { 'lighting.entry': 'light.entry' },
      },
      scenes: [],
      cameraDashboard,
    }),
  );
  const states = [
    { entity_id: 'light.entry', state: 'off', attributes: {} },
    { entity_id: 'camera.entry', state: 'idle' },
    { entity_id: 'binary_sensor.motion', state: 'off' },
  ];
  let initial = true;
  let resolveSeed: ((value: Response) => void) | undefined;
  const socket = new FakeSocket();
  const commands: string[] = [];
  const runtime = await startRuntime(path, {
    lightingIntentPath: statePath,
    createHomeAssistantSocket: () => socket,
    homeAssistantFetch: async (input) => {
      const url = String(input);
      if (!url.endsWith('/api/states')) {
        commands.push(url);
        return new Response(null);
      }
      if (initial) {
        initial = false;
        return Response.json(states);
      }
      return new Promise<Response>((resolve) => {
        resolveSeed = resolve;
      });
    },
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    const session = await fetch(`${base}/ui/api/session`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: '' }),
    });
    const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
    const snapshot = async () => {
      const response = await fetch(`${base}/ui/api/overview`, {
        headers: { Cookie: cookie },
      });
      const body = (await response.json()) as {
        cameraDashboard: CameraDashboardSnapshot;
      };
      return body.cameraDashboard;
    };
    expect(await snapshot()).toMatchObject({
      settings: { enabled: true },
      definitions: [{ available: false }],
      active: null,
    });
    socket.receive({ type: 'auth_required' });
    socket.receive({ type: 'auth_ok' });
    const { id } = JSON.parse(socket.sent.at(-1)!) as { id: number };
    socket.receive({ type: 'result', id, success: true });
    await settle();
    const motion = () =>
      socket.receive({
        type: 'event',
        id,
        event: {
          event_type: 'state_changed',
          time_fired: new Date().toISOString(),
          data: {
            entity_id: 'binary_sensor.motion',
            old_state: { state: 'off' },
            new_state: { state: 'on' },
          },
        },
      });
    motion();
    expect((await snapshot()).active).toBeNull();
    resolveSeed!(Response.json(states));
    await settle();
    expect(await snapshot()).toMatchObject({
      definitions: [{ available: true }],
      active: null,
    });
    motion();
    expect((await snapshot()).active).toMatchObject({
      cameraId: 'entry',
      manual: false,
    });
    socket.fail();
    expect(await snapshot()).toMatchObject({
      definitions: [{ available: false }],
      active: null,
    });
    motion();
    expect((await snapshot()).active).toBeNull();
    expect(commands).toEqual([]);
  } finally {
    await runtime.stop();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
