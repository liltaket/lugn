import { createServer } from 'node:net';
import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MusicPlaybackPolicySnapshot } from '../src/application/music-automation.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { LugnDisplayServer } from '../src/runtime/display-server.js';
import { FakeClock } from '../src/core/clock.js';
import {
  unknownComputerReadings,
  type ComputerObservation,
} from '../src/core/computer.js';

const token = 'a'.repeat(32);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(streaming = true, music = false, computerAudio = false) {
  const portFinder = createServer();
  await new Promise<void>((resolve) =>
    portFinder.listen(0, '127.0.0.1', resolve),
  );
  const address = portFinder.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const port = address.port;
  await new Promise<void>((resolve) => portFinder.close(() => resolve()));
  const engine = new LugnEngine(
    new FakeClock(Date.parse('2026-10-04T12:00:00+02:00')),
    music ? { music: { targets: { 'music.room': [] } } } : {},
  );
  let musicObservationConnected = true;
  const server = new LugnDisplayServer({
    host: '127.0.0.1',
    port,
    hubs: [{ id: 'bed', role: 'bed', token, castHost: '127.0.0.1' }],
    capabilities: new CapabilityRegistry(engine),
    scenes: [...engine.scenes.values()],
    scenesProvider: () => [...engine.scenes.values()],
    ...(computerAudio
      ? {
          computerAudioMappings: {
            'music.room': { deviceId: 'kuffe', source: 'Optical In' },
          },
        }
      : {}),
    stateProvider: () => {
      if (snapshotFails) throw new Error('Snapshot temporarily unavailable');
      return engine.state;
    },
    musicObservationConnectedProvider: () => musicObservationConnected,
    ...(streaming ? { stateStream: engine.stream } : {}),
    ...(music
      ? {
          musicPlaybackPoliciesProvider: () =>
            engine.getMusicPlaybackPolicySnapshots(),
        }
      : {}),
  });
  let snapshotFails = false;
  await server.start();
  cleanups.push(async () => {
    await server.stop();
    engine.dispose();
  });
  const base = `http://127.0.0.1:${port}/k/${token}/display-api`;
  const open = async (headers: Record<string, string> = {}) => {
    const abort = new AbortController();
    const response = await fetch(`${base}/events`, {
      signal: abort.signal,
      headers,
    });
    cleanups.push(async () => {
      abort.abort();
    });
    if (!response.body) throw new Error('Missing stream');
    const reader = response.body.getReader();
    let buffer = '';
    return {
      response,
      abort,
      next: async () => {
        while (!buffer.includes('\n\n')) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('Stream ended');
          buffer += new TextDecoder().decode(chunk.value);
        }
        const end = buffer.indexOf('\n\n');
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split('\n')
          .find((line) => line.startsWith('data: '));
        return JSON.parse(data?.slice(6) ?? '{}') as {
          state: typeof engine.state;
          role: string;
          deliveryRevision: number;
          generatedAt: number;
          computerNowPlaying: Record<
            string,
            { status: string; title: string | null; reason: string }
          >;
          musicPlaybackPolicies: Record<string, MusicPlaybackPolicySnapshot>;
        };
      },
    };
  };
  return {
    engine,
    disconnectMusic: () => {
      musicObservationConnected = false;
    },
    server,
    base,
    open,
    breakSnapshot: () => {
      snapshotFails = true;
    },
  };
}

describe('secret-path Hub state stream', () => {
  it('delivers current computer media through polling and SSE without rewriting music observations', async () => {
    const { base, open, engine } = await setup(true, true, true);
    engine.state.music.devices['music.room']!.observed.source = 'Optical In';
    engine.state.music.devices['music.room']!.observed.title = '4';
    const observation: ComputerObservation = {
      deviceId: 'kuffe',
      availability: 'online',
      freshness: 'fresh',
      reason: 'live',
      sessionId: 'session',
      sequence: 1,
      observedAt: 100,
      receivedAt: 100,
      observed: {
        ...unknownComputerReadings(),
        media: [
          {
            player: 'spotify',
            desktopEntry: 'spotify',
            identity: 'Spotify',
            playback: 'playing',
            title: 'A song',
            artists: ['Artist'],
            album: null,
            contentType: null,
          },
        ],
      },
      activity: {
        classification: 'music',
        basis: 'mpris_content_type',
        source: 'desktop-agent',
      },
      lastEvent: null,
    };
    engine.acceptComputerObservation(observation);
    const polled = (await (await fetch(`${base}/state`)).json()) as Awaited<
      ReturnType<Awaited<ReturnType<typeof open>>['next']>
    >;
    expect(polled.computerNowPlaying['music.room']).toMatchObject({
      status: 'playing',
      title: 'A song',
    });
    expect(polled.state.music.devices['music.room']!.observed.title).toBe('4');
    const stream = await open();
    expect((await stream.next()).computerNowPlaying['music.room']?.title).toBe(
      'A song',
    );
    engine.acceptComputerObservation({
      ...observation,
      availability: 'unknown',
      freshness: 'stale',
      reason: 'stale',
      observed: unknownComputerReadings(),
    });
    expect(
      (await stream.next()).computerNowPlaying['music.room'],
    ).toMatchObject({ status: 'unavailable', title: null });
    engine.state.music.devices['music.room']!.observed.source = 'Spotify';
    const changed = (await (await fetch(`${base}/state`)).json()) as {
      computerNowPlaying: unknown;
    };
    expect(changed.computerNowPlaying).toEqual({});
  });

  it('keeps Hub activation scenes current after dashboard preset edits', async () => {
    const { base, engine } = await setup();
    const scene = {
      id: 'scene.custom_test',
      name: 'Ny scen',
      lighting: {
        [Object.keys(engine.state.lighting.devices)[0]!]: {
          power: true,
          brightness: 26,
        },
      },
    };
    engine.saveSceneDefinition(scene);
    const snapshot = (await (await fetch(`${base}/state`)).json()) as {
      scenes: (typeof scene)[];
    };
    expect(snapshot.scenes).toContainEqual(scene);
    engine.deleteSceneDefinition(scene.id);
    const updated = (await (await fetch(`${base}/state`)).json()) as {
      scenes: (typeof scene)[];
    };
    expect(updated.scenes.some((entry) => entry.id === scene.id)).toBe(false);
  });
  it('carries authoritative playback policy and server time in polling and stream snapshots', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.parse('2026-10-04T12:00:00+02:00');
    vi.setSystemTime(now);
    try {
      const { base, open, engine } = await setup(true, true);
      const polled = (await (await fetch(`${base}/state`)).json()) as {
        generatedAt: number;
        musicPlaybackPolicies: Record<string, MusicPlaybackPolicySnapshot>;
      };
      expect(polled.generatedAt).toBe(now);
      expect(polled.musicPlaybackPolicies).toEqual(
        engine.getMusicPlaybackPolicySnapshots(),
      );
      const streamed = await (await open()).next();
      expect(streamed.generatedAt).toBe(now);
      expect(streamed.musicPlaybackPolicies).toEqual(
        polled.musicPlaybackPolicies,
      );
      const fallback = await setup(false);
      const fallbackPayload = (await (
        await fetch(`${fallback.base}/state`)
      ).json()) as {
        musicPlaybackPolicies: Record<string, MusicPlaybackPolicySnapshot>;
      };
      expect(fallbackPayload.musicPlaybackPolicies).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });
  it('closes an event stream when an asynchronous snapshot provider fails', async () => {
    const { engine, open, breakSnapshot } = await setup();
    const stream = await open();
    await stream.next();
    breakSnapshot();
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    await expect(stream.next()).rejects.toThrow();
  });
  it('sends current state immediately and pushes presence/scene changes without polling', async () => {
    const { engine, server, open } = await setup();
    const stream = await open();
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get('content-type')).toContain(
      'text/event-stream',
    );
    const initial = await stream.next();
    expect(initial.state.revision).toBe(engine.state.revision);
    expect(initial.role).toBe('bed');
    expect(server.lastHubHeartbeatAt('bed')).toBeDefined();
    await engine.activateScene('scene.cozy', { type: 'user' });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 2,
    });
    const update = await stream.next();
    expect(update.state.lighting.currentScene).toBe('scene.cozy');
    expect(update.state.presence.personCount).toBe(2);
    expect(update.state.revision).toBeGreaterThan(initial.state.revision);
    expect(update.deliveryRevision).toBeGreaterThan(initial.deliveryRevision);
  });

  it('reconnects from a stale Last-Event-ID using a fresh authoritative snapshot', async () => {
    const { engine, open } = await setup();
    await engine.activateScene('scene.movie', { type: 'user' });
    const stream = await open({ 'Last-Event-ID': '0' });
    const payload = await stream.next();
    expect(payload.state.revision).toBe(engine.state.revision);
    expect(payload.state.lighting.currentScene).toBe('scene.movie');
  });

  it('preserves path credentials, Host/Origin checks and rejects unexpected query parameters', async () => {
    const { base } = await setup();
    expect(
      (await fetch(`${base.replace(token, 'b'.repeat(32))}/events`)).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${base}/events`, {
          headers: { Origin: 'http://untrusted.test' },
        })
      ).status,
    ).toBe(403);
    const invalidHost = await new Promise<number | undefined>(
      (resolve, reject) => {
        const req = request(
          `${base}/events`,
          { headers: { Host: 'untrusted.test' } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        req.once('error', reject);
        req.end();
      },
    );
    expect(invalidHost).toBe(400);
    expect((await fetch(`${base}/events?token=bad`)).status).toBe(400);
  });

  it('bounds subscriptions per Hub and retains polling while streaming is unavailable', async () => {
    const { open, base } = await setup();
    const first = await open();
    await first.next();
    const second = await open();
    await second.next();
    expect((await fetch(`${base}/events`)).status).toBe(503);
    expect((await fetch(`${base}/state`)).status).toBe(200);
    const fallback = await setup(false);
    expect((await fetch(`${fallback.base}/events`)).status).toBe(503);
    expect((await fetch(`${fallback.base}/state`)).status).toBe(200);
  });
});

it('carries upstream observation trust independently of cached player availability', async () => {
  const s = await setup(true, true);
  const live = await fetch(`${s.base}/state`).then((r) => r.json());
  expect(live).toMatchObject({ musicObservationConnected: true });
  s.disconnectMusic();
  const cached = await fetch(`${s.base}/state`).then((r) => r.json());
  expect(cached).toMatchObject({ musicObservationConnected: false });
  const stream = await s.open();
  expect(await stream.next()).toMatchObject({
    musicObservationConnected: false,
  });
});
