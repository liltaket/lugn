import { createServer } from 'node:net';
import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { LugnDisplayServer } from '../src/runtime/display-server.js';
import { HomeAssistantArtworkService } from '../src/runtime/artwork-service.js';
import { HomeAssistantMusicAdapter } from '../src/adapters/home-assistant-music.js';
import { FakeClock } from '../src/core/clock.js';
import type { ArtworkMap } from '../src/core/artwork.js';
import { ComputerNowPlayingSelector } from '../src/application/computer-now-playing.js';
import { unknownComputerReadings } from '../src/core/computer.js';

const hubToken = 'a'.repeat(32);
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=',
  'base64',
);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup(computerArtwork = false) {
  const finder = createServer();
  await new Promise<void>((resolve) => finder.listen(0, '127.0.0.1', resolve));
  const address = finder.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test port');
  const port = address.port;
  await new Promise<void>((resolve) => finder.close(() => resolve()));
  const clock = new FakeClock();
  const adapter = new HomeAssistantMusicAdapter(
    {
      baseUrl: 'http://ha.test',
      token: 'private',
      entities: { 'music.room': { entityId: 'media_player.room' } },
    },
    vi.fn(),
    clock,
  );
  const engine = new LugnEngine(clock, {
    music: { targets: { 'music.room': [] }, adapter },
  });
  let resolveImage!: (response: Response) => void;
  const upstream = vi.fn<typeof fetch>(
    () =>
      new Promise<Response>((resolve) => {
        resolveImage = resolve;
      }),
  );
  const routes = {
    'music.room': { deviceId: 'desktop', source: 'Optical In' },
  };
  const selector = new ComputerNowPlayingSelector(routes);
  const artwork = new HomeAssistantArtworkService(
    {
      baseUrl: 'http://ha.test',
      token: 'private',
      entities: { 'music.room': 'media_player.room' },
      metadataProvider: (target) => adapter.artworkMetadata(target),
      excludedSources: { 'music.room': ['Optical In'] },
      computer: { routes: computerArtwork ? routes : {}, selector },
    },
    upstream,
    clock,
  );
  const server = new LugnDisplayServer({
    host: '127.0.0.1',
    port,
    hubs: [{ id: 'bed', role: 'bed', token: hubToken, castHost: '127.0.0.1' }],
    capabilities: new CapabilityRegistry(engine),
    scenes: [...engine.scenes.values()],
    stateProvider: () => engine.state,
    stateStream: engine.stream,
    artworkProvider: artwork,
    computerAudioMappings: routes,
    computerNowPlayingSelector: selector,
  });
  const observe = (title: string) =>
    adapter.acceptState({
      entity_id: 'media_player.room',
      state: 'playing',
      attributes: {
        media_title: title,
        media_artist: 'Artist',
        media_content_id: title,
        entity_picture:
          '/api/media_player_proxy/media_player.room?token=secret_image_token',
      },
    });
  observe('A');
  await server.start();
  cleanups.push(async () => {
    artwork.dispose();
    await server.stop();
    engine.dispose();
  });
  return {
    engine,
    artwork,
    server,
    observe,
    upstream,
    finish: () =>
      resolveImage(
        new Response(png, { headers: { 'content-type': 'image/png' } }),
      ),
    origin: `http://127.0.0.1:${port}`,
    base: `http://127.0.0.1:${port}/k/${hubToken}/display-api`,
  };
}
async function stream(base: string) {
  const abort = new AbortController();
  const response = await fetch(`${base}/events`, { signal: abort.signal });
  cleanups.push(async () => {
    abort.abort();
  });
  const reader = response.body!.getReader();
  let buffer = '';
  return {
    next: async () => {
      while (!buffer.includes('\n\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('Stream ended');
        buffer += new TextDecoder().decode(chunk.value);
      }
      const end = buffer.indexOf('\n\n');
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      return JSON.parse(
        frame
          .split('\n')
          .find((l) => l.startsWith('data: '))!
          .slice(6),
      ) as {
        artwork: ArtworkMap;
        state: { lighting: { currentScene: string } };
      };
    },
  };
}

describe('authenticated Hub artwork vertical slice (fake HA, loopback only)', () => {
  it('delivers the selected Optical player title and Spotify artwork over SSE and the protected image route', async () => {
    const s = await setup(true);
    const receiver = s.engine.state.music.devices['music.room']!;
    receiver.observed.source = 'Optical In';
    s.engine.acceptComputerObservation({
      deviceId: 'desktop',
      availability: 'online',
      freshness: 'fresh',
      reason: 'live',
      observedAt: 0,
      receivedAt: 0,
      sessionId: 'session-1',
      sequence: 1,
      observed: {
        ...unknownComputerReadings(),
        media: [
          {
            player: 'spotify',
            identity: 'Spotify',
            desktopEntry: 'spotify',
            playback: 'playing',
            title: 'Computer song',
            artists: ['Artist'],
            album: 'Album',
            contentType: null,
            artwork: { provider: 'spotify', id: 'a'.repeat(40) },
          },
        ],
      },
      activity: {
        classification: 'music',
        source: 'desktop-agent',
        basis: null,
      },
      lastEvent: null,
    });
    const events = await stream(s.base);
    const first = await events.next();
    expect(first).toMatchObject({
      computerNowPlaying: { 'music.room': { title: 'Computer song' } },
    });
    expect(s.upstream.mock.calls[0]![0]).toBe(
      `https://i.scdn.co/image/${'a'.repeat(40)}`,
    );
    s.finish();
    const ready = await events.next();
    expect(ready.artwork['music.room']).toMatchObject({
      source: 'computer',
      status: 'available',
    });
    const image = await fetch(s.origin + ready.artwork['music.room']!.url);
    expect(image.status).toBe(200);
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    s.engine.state.computer.devices['desktop']!.freshness = 'stale';
    expect(
      (await fetch(s.origin + ready.artwork['music.room']!.url)).status,
    ).toBe(404);
  });

  it('keeps polling, SSE and essential controls responsive during slow images and publishes artwork when ready', async () => {
    const s = await setup();
    const events = await stream(s.base);
    const first = await events.next();
    expect(first.artwork['music.room']).toEqual({
      url: null,
      status: 'unavailable',
      source: 'home_assistant',
    });
    expect(JSON.stringify(first)).not.toMatch(
      /secret_image_token|entityPicture|mediaContentId|ha\.test|private/,
    );
    expect((await fetch(`${s.base}/state`)).status).toBe(200);
    const control = await fetch(`${s.base}/scene`, {
      method: 'POST',
      headers: { origin: s.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ sceneId: 'scene.cozy' }),
    });
    expect(control.status).toBe(200);
    expect((await events.next()).state.lighting.currentScene).toBe(
      'scene.cozy',
    );
    expect(s.upstream).toHaveBeenCalledTimes(1);
    s.finish();
    const ready = await events.next();
    expect(ready.artwork['music.room']!.status).toBe('available');
    const path = ready.artwork['music.room']!.url!;
    expect(path).toMatch(
      new RegExp(`^/k/${hubToken}/display-api/artwork/[A-Za-z0-9_-]{32}$`),
    );
    const response = await fetch(s.origin + path);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('cross-origin-resource-policy')).toBe(
      'same-origin',
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    s.observe('B');
    expect((await fetch(s.origin + path)).status).toBe(404);
    expect((await events.next()).artwork['music.room']!.url).toBeNull();
  });
  it('requires the Hub credential, validated Host/Origin and a server-issued image token', async () => {
    const s = await setup();
    await fetch(`${s.base}/state`);
    s.finish();
    const snapshot = (await fetch(`${s.base}/state`).then((r) => r.json())) as {
      artwork: ArtworkMap;
    };
    const path = snapshot.artwork['music.room']!.url!;
    expect(path).toBeTypeOf('string');
    expect(
      (await fetch(s.origin + path.replace(hubToken, 'b'.repeat(32)))).status,
    ).toBe(404);
    expect(
      (
        await fetch(s.origin + path, {
          headers: { Origin: 'http://evil.test' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(s.origin + path, {
          headers: { 'sec-fetch-site': 'cross-site' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await fetch(s.origin + path, { headers: { Origin: s.origin } })).status,
    ).toBe(200);
    const invalidHost = await new Promise<number | undefined>(
      (resolve, reject) => {
        const req = request(
          s.origin + path,
          { headers: { Host: 'evil.test' } },
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
    expect((await fetch(`${s.base}/artwork/${'z'.repeat(32)}`)).status).toBe(
      404,
    );
    expect(
      (await fetch(s.origin + path + '?url=http://evil.test')).status,
    ).toBe(400);
    expect(
      (await fetch(`${s.base}/artwork/https%3A%2F%2Fevil.test`)).status,
    ).toBe(404);
    expect(s.upstream).toHaveBeenCalledTimes(1);
  });
});
