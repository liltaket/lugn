import { createServer } from 'node:net';
import { expect, it, vi } from 'vitest';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { FakeClock } from '../src/core/clock.js';
import { LugnDisplayServer } from '../src/runtime/display-server.js';

async function setup() {
  const finder = createServer();
  await new Promise<void>((resolve) => finder.listen(0, '127.0.0.1', resolve));
  const address = finder.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve) => finder.close(() => resolve()));
  const engine = new LugnEngine(new FakeClock(10_000), {
    deviceIds: ['lighting.entry'],
    scenes: [
      {
        id: 'scene.soft_light',
        name: 'Mysljus',
        lighting: { 'lighting.entry': { power: true, brightness: 20 } },
      },
    ],
    music: { targets: { 'music.room': ['Optical'] } },
  });
  const registry = new CapabilityRegistry(engine);
  const invoke = vi.spyOn(registry, 'invoke');
  const server = new LugnDisplayServer({
    host: '127.0.0.1',
    port: address.port,
    hubs: [
      { id: 'bed', role: 'bed', token: 'a'.repeat(32), castHost: '127.0.0.1' },
      {
        id: 'desk',
        role: 'desk',
        token: 'b'.repeat(32),
        castHost: '127.0.0.1',
      },
    ],
    capabilities: registry,
    scenes: [...engine.scenes.values()],
    stateProvider: () => engine.state,
  });
  await server.start();
  const url = (role: 'bed' | 'desk') =>
    `http://127.0.0.1:${address.port}${server.pathForHub(role)}display-api`;
  const post = (
    role: 'bed' | 'desk',
    route: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${url(role)}/${route}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: new URL(url(role)).origin,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const stop = async () => {
    await server.stop();
    engine.dispose();
  };
  return { engine, invoke, url, post, stop };
}

const actions = [
  ['scene', { sceneId: 'scene.soft_light' }, 'lighting.activateScene'],
  [
    'light',
    { target: 'lighting.entry', values: { power: false } },
    'lighting.set',
  ],
  [
    'music',
    { target: 'music.room', request: { property: 'volume', value: 0.4 } },
    'music.setVolume',
  ],
  ['music-preset', { target: 'music.room', presetId: 4 }, 'music.playPreset'],
] as const;

it.each(['bed', 'desk'] as const)(
  'attributes every explicit %s action to the authenticated path without inferring occupancy',
  async (role) => {
    const s = await setup();
    try {
      const before = structuredClone(s.engine.state.presence);
      for (const [route, body, capability] of actions) {
        expect(
          (
            await s.post(role, route, body, {
              'x-hub-role': role === 'bed' ? 'desk' : 'bed',
            })
          ).status,
        ).toBe(200);
        expect(s.invoke.mock.calls.at(-1)).toEqual([
          capability,
          expect.any(Object),
          {
            actor: { type: 'user', id: `nest-dashboard:${role}` },
            source: `lugn.cast_dashboard.${role}`,
          },
        ]);
        expect(s.engine.state.presence).toEqual(before);
      }
      const bed = (await (await fetch(`${s.url('bed')}/state`)).json()) as {
        state: unknown;
        role: string;
      };
      const desk = (await (await fetch(`${s.url('desk')}/state`)).json()) as {
        state: unknown;
        role: string;
      };
      expect(bed.role).toBe('bed');
      expect(desk.role).toBe('desk');
      expect(bed.state).toEqual(desk.state);
    } finally {
      await s.stop();
    }
  },
);

it('rejects body or URL role/source spoofing before invoking capabilities', async () => {
  const s = await setup();
  try {
    for (const [route, body] of actions) {
      expect(
        (
          await s.post('bed', route, {
            ...body,
            role: 'desk',
            source: 'lugn.cast_dashboard.desk',
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await fetch(`${s.url('bed')}/music?role=desk`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: new URL(s.url('bed')).origin,
          },
          body: JSON.stringify(actions[2][1]),
        })
      ).status,
    ).toBe(400);
    expect(s.invoke).not.toHaveBeenCalled();
    expect(s.engine.state.presence.state).toBe('unknown');
  } finally {
    await s.stop();
  }
});
