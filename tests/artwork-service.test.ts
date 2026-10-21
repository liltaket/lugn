import { describe, expect, it, vi } from 'vitest';
import {
  HomeAssistantArtworkService,
  safeImagePath,
} from '../src/runtime/artwork-service.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import {
  MusicObservationValuesSchema,
  type RoomState,
} from '../src/core/schemas.js';
import { HomeAssistantMusicAdapter } from '../src/adapters/home-assistant-music.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=',
  'base64',
);
const picture =
  '/api/media_player_proxy/media_player.room?token=ha_image_token';
const prefix = '/ui/api/artwork/';
function state(): RoomState {
  const engine = new LugnEngine(new FakeClock(), {
    music: { targets: { 'music.room': [] } },
  });
  const state = structuredClone(engine.state);
  engine.dispose();
  state.music.devices['music.room']!.availability = 'available';
  state.music.devices['music.room']!.observed = {
    playback: 'playing',
    volume: 0.4,
    source: 'Spotify',
    title: 'Song A',
    artist: 'Artist',
    album: 'Album',
  };
  return state;
}
const image = () =>
  new Response(png, { headers: { 'content-type': 'image/png' } });
async function settle() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
function setup(
  options: Partial<
    ConstructorParameters<typeof HomeAssistantArtworkService>[0]
  > = {},
  impl: typeof fetch = async () => image(),
) {
  const clock = new FakeClock();
  const fetch = vi.fn(impl);
  const currentState = state();
  const metadata = {
    generation: 1,
    mediaContentId: 'spotify:track:a' as string | null,
    entityPicture: picture as string | null,
  };
  const service = new HomeAssistantArtworkService(
    {
      baseUrl: 'http://ha.test',
      token: 'private-credential',
      entities: { 'music.room': 'media_player.room' },
      metadataProvider: (target) => ({
        ...currentState.music.devices[target]!.observed,
        artist: currentState.music.devices[target]!.observed.artist ?? null,
        album: currentState.music.devices[target]!.observed.album ?? null,
        ...metadata,
        ...(target === 'music.desk'
          ? { entityPicture: '/api/media_player_proxy/media_player.desk' }
          : {}),
      }),
      ...options,
    },
    fetch,
    clock,
  );
  return { service, fetch, clock, state: currentState, metadata };
}
function url(s: ReturnType<typeof setup>): string | null {
  return s.service.snapshot(s.state, prefix)['music.room']!.url;
}
function token(url: string | null): string {
  return url!.split('/').at(-1)!;
}

describe('HA metadata extraction', () => {
  it('adds optional bounded metadata without changing legacy schema fixtures', () => {
    const legacy = {
      playback: 'playing',
      volume: 0.3,
      source: 'Spotify',
      title: 'Song',
    };
    expect(MusicObservationValuesSchema.parse(legacy)).toEqual(legacy);
    const adapter = new HomeAssistantMusicAdapter(
      {
        baseUrl: 'http://ha.test',
        token: 'private',
        entities: { 'music.room': { entityId: 'media_player.room' } },
      },
      vi.fn(),
      new FakeClock(),
    );
    const listener = vi.fn();
    adapter.subscribe(listener);
    adapter.acceptState({
      entity_id: 'media_player.room',
      state: 'playing',
      attributes: {
        media_title: 'Song',
        media_artist: 'Artist',
        media_album_name: 'Album',
        media_content_id: 'spotify:track:a',
        entity_picture: picture,
      },
    });
    expect(listener.mock.calls[0]![0].values).toMatchObject({
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
    });
    expect(adapter.artworkMetadata('music.room')).toMatchObject({
      mediaContentId: 'spotify:track:a',
      entityPicture: picture,
    });
    expect(JSON.stringify(listener.mock.calls[0]![0])).not.toMatch(
      /entityPicture|mediaContentId|ha_image_token/,
    );
    adapter.acceptState({
      entity_id: 'media_player.room',
      state: 'playing',
      attributes: {
        media_artist: 'a'.repeat(1025),
        entity_picture: 'x'.repeat(2049),
      },
    });
    expect(listener.mock.calls[1]![0].values).not.toHaveProperty('artist');
    expect(listener.mock.calls[1]![0].values).not.toHaveProperty('album');
    adapter.acceptState({
      entity_id: 'media_player.room',
      state: 'unavailable',
      attributes: { entity_picture: picture },
    });
    expect(listener.mock.calls[2]![0].values).toMatchObject({ title: null });
    expect(adapter.artworkMetadata('music.room')).toBeNull();
  });
});

describe('local-first artwork projection', () => {
  it('constructs offline, projects without waiting, fetches only fixed HA with credentials and serves opaque paths', async () => {
    const s = setup();
    expect(s.fetch).not.toHaveBeenCalled();
    expect(s.service.snapshot(s.state, prefix)['music.room']).toEqual({
      url: null,
      status: 'unavailable',
      source: 'home_assistant',
    });
    expect(s.fetch).not.toHaveBeenCalled();
    await settle();
    const result = s.service.snapshot(s.state, prefix)['music.room']!;
    expect(result).toMatchObject({
      status: 'available',
      source: 'home_assistant',
    });
    expect(result.url).toMatch(/^\/ui\/api\/artwork\/[A-Za-z0-9_-]{32}$/);
    expect(JSON.stringify(result)).not.toMatch(
      /ha\.test|private|ha_image_token|Song/,
    );
    expect(s.fetch).toHaveBeenCalledExactlyOnceWith(
      `http://ha.test${picture}`,
      expect.objectContaining({
        method: 'GET',
        redirect: 'manual',
        headers: expect.objectContaining({
          Authorization: 'Bearer private-credential',
        }),
      }),
    );
    expect(await s.service.read(token(result.url), s.state)).toEqual({
      contentType: 'image/png',
      body: new Uint8Array(png),
    });
    expect(await s.service.read('never-issued', s.state)).toBeNull();
    const asset = await s.service.read(token(result.url), s.state);
    asset!.body[0] = 0;
    expect((await s.service.read(token(result.url), s.state))!.body[0]).toBe(
      137,
    );
  });

  it.each([
    'missing',
    'idle',
    'unavailable',
    'computer',
    'unidentified',
  ] as const)('does not fetch %s metadata', async (kind) => {
    const s = setup({ excludedSources: { 'music.room': ['Optical In'] } });
    const d = s.state.music.devices['music.room']!;
    if (kind === 'missing') s.metadata.entityPicture = null;
    if (kind === 'idle') d.observed.playback = 'idle';
    if (kind === 'unavailable') d.availability = 'unavailable';
    if (kind === 'computer') d.observed.source = 'Optical In';
    if (kind === 'unidentified') {
      d.observed.title = null;
      s.metadata.mediaContentId = null;
    }
    expect(s.service.snapshot(s.state, prefix)['music.room']).toEqual({
      url: null,
      status: 'missing',
      source: null,
    });
    await settle();
    expect(s.fetch).not.toHaveBeenCalled();
  });

  it('keeps identity stable across volume updates and revokes old tokens immediately on track/source/picture changes', async () => {
    const s = setup();
    url(s);
    await settle();
    const first = url(s);
    const observed = s.state.music.devices['music.room']!.observed;
    observed.volume = 0.8;
    expect(url(s)).toBe(first);
    expect(s.fetch).toHaveBeenCalledTimes(1);
    for (const key of ['title', 'artist', 'album', 'source'] as const) {
      const saved = observed[key];
      observed[key] = 'changed';
      expect(await s.service.read(token(first), s.state)).toBeNull();
      observed[key] = saved!;
    }
    s.metadata.mediaContentId = 'spotify:track:b';
    expect(await s.service.read(token(first), s.state)).toBeNull();
    s.metadata.entityPicture =
      '/api/media_player_proxy/media_player.room?token=new';
    observed.title = 'Song B';
    expect(url(s)).toBeNull();
    await settle();
    expect(url(s)).not.toBe(first);
    expect(await s.service.read(token(first), s.state)).toBeNull();
    expect(s.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not publish slow previous-track completion as current artwork', async () => {
    let resolve!: (value: Response) => void;
    const s = setup(
      {},
      vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Response>((r) => {
              resolve = r;
            }),
        )
        .mockImplementation(async () => image()),
    );
    url(s);
    await settle();
    s.state.music.devices['music.room']!.observed.title = 'Song B';
    url(s);
    await settle();
    const current = url(s);
    resolve(image());
    await settle();
    expect(url(s)).toBe(current);
    expect(s.fetch).toHaveBeenCalledTimes(2);
  });

  it('notifies subscribers after resolution and releases subscriptions/disposes safely', async () => {
    const s = setup();
    const listener = vi.fn();
    const off = s.service.subscribe(listener);
    url(s);
    await settle();
    expect(listener).toHaveBeenCalledOnce();
    off();
    s.service.dispose();
    expect(
      await s.service.read(token(url(s) ?? 'unissued'), s.state),
    ).toBeNull();
    expect(url(s)).toBeNull();
  });
});

describe('artwork upstream boundary', () => {
  it.each([
    'http://evil.test/a.png',
    'https://ha.test/api/media_player_proxy/media_player.room',
    '//evil.test/a',
    '/api/media_player_proxy/media_player.other',
    '/api/camera_proxy/camera.private',
    '/api/media_player_proxy/media_player.room/../../states',
    '/api/media_player_proxy/%2e%2e/states',
    '/api/media_player_proxy/media_player.room%3f@evil.test',
    '/api/media_player_proxy/media_player.room\\evil',
    '/api/media_player_proxy/media_player.room?url=http://evil.test',
    '/api/media_player_proxy/media_player.room?token=a&url=b',
    '/api/media_player_proxy/media_player.room#evil',
    '/local/art.svg',
    '/api/image_proxy/image.room%00',
    '/api/media_player_proxy/media_player.room\r\nHost: evil.test',
  ])('rejects injection %j without any network request', async (value) => {
    expect(safeImagePath(value, 'media_player.room')).toBeNull();
    const s = setup();
    s.metadata.entityPicture = value;
    expect(s.service.snapshot(s.state, prefix)['music.room']).toMatchObject({
      url: null,
      status: 'unavailable',
    });
    await settle();
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it('accepts only relative HA image endpoint forms', () => {
    expect(
      safeImagePath(
        '/api/image_proxy/image.album?token=a-b_c',
        'media_player.room',
      ),
    ).toBe('/api/image_proxy/image.album?token=a-b_c');
    expect(safeImagePath(picture, 'media_player.room')).toBe(picture);
  });
  it.each([
    'http://user:pw@ha.test',
    'http://ha.test?x=y',
    'file:///tmp/image',
    'http://ha.test/#x',
  ])('rejects invalid fixed upstream %s', (baseUrl) => {
    expect(() => setup({ baseUrl })).toThrow();
  });
  it.each([
    [
      'redirect',
      () =>
        new Response(null, {
          status: 302,
          headers: {
            location: 'http://evil.test',
            'content-type': 'image/png',
          },
        }),
    ],
    ['unavailable', () => new Response(null, { status: 503 })],
    [
      'SVG',
      () =>
        new Response('<svg/>', {
          headers: { 'content-type': 'image/svg+xml' },
        }),
    ],
    [
      'HTML',
      () =>
        new Response('<html/>', { headers: { 'content-type': 'text/html' } }),
    ],
    [
      'spoofed PNG',
      () =>
        new Response('<html/>', { headers: { 'content-type': 'image/png' } }),
    ],
    [
      'empty',
      () => new Response(null, { headers: { 'content-type': 'image/png' } }),
    ],
    [
      'oversized declared',
      () =>
        new Response(png, {
          headers: { 'content-type': 'image/png', 'content-length': '5000000' },
        }),
    ],
    [
      'oversized streamed',
      () =>
        new Response(new Uint8Array(1000), {
          headers: { 'content-type': 'image/png' },
        }),
    ],
    [
      'transport failure',
      () => {
        throw new Error('private network detail');
      },
    ],
  ] as const)(
    'negative caches %s without exposing details or retry storms',
    async (_, response) => {
      const s = setup({ maxImageBytes: 100 }, async () => response());
      url(s);
      await settle();
      expect(s.service.snapshot(s.state, prefix)['music.room']).toEqual({
        url: null,
        status: 'unavailable',
        source: 'home_assistant',
      });
      await settle();
      expect(s.fetch).toHaveBeenCalledTimes(1);
      s.clock.advanceBy(30_000);
      url(s);
      await settle();
      expect(s.fetch).toHaveBeenCalledTimes(2);
    },
  );
  it('bounds a hung transport with FakeClock and retries after negative expiry', async () => {
    const s = setup(
      { timeoutMs: 50, negativeTtlMs: 100 },
      () => new Promise(() => {}),
    );
    url(s);
    await settle();
    const signal = s.fetch.mock.calls[0]![1]!.signal!;
    s.clock.advanceBy(50);
    await settle();
    expect(signal.aborted).toBe(true);
    expect(url(s)).toBeNull();
    expect(s.clock.pendingTimers()).toBe(0);
    s.clock.advanceBy(100);
    url(s);
    await settle();
    expect(s.fetch).toHaveBeenCalledTimes(2);
    s.service.dispose();
    s.clock.advanceBy(50);
    await settle();
  });
  it('times out a stalled body, not just response headers', async () => {
    const s = setup(
      { timeoutMs: 50 },
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(png.subarray(0, 8));
            },
          }),
          { headers: { 'content-type': 'image/png' } },
        ),
    );
    url(s);
    await settle();
    s.clock.advanceBy(50);
    await settle();
    expect(url(s)).toBeNull();
    expect(s.fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    s.service.dispose();
  });
});

describe('bounded cache and concurrency', () => {
  it('expires successful images and rotates tokens without a stale URL', async () => {
    const s = setup({ positiveTtlMs: 100 });
    url(s);
    await settle();
    const first = url(s);
    s.clock.advanceBy(99);
    expect(url(s)).toBe(first);
    s.clock.advanceBy(1);
    expect(await s.service.read(token(first), s.state)).toBeNull();
    expect(url(s)).toBeNull();
    await settle();
    expect(url(s)).not.toBe(first);
    expect(s.fetch).toHaveBeenCalledTimes(2);
  });
  it('evicts least recently used entries and bounds total image bytes', async () => {
    for (const options of [{ maxEntries: 2 }, { maxBytes: png.length * 2 }]) {
      const s = setup(options);
      url(s);
      await settle();
      const first = url(s);
      s.state.music.devices['music.room']!.observed.title = 'B';
      url(s);
      await settle();
      s.state.music.devices['music.room']!.observed.title = 'C';
      url(s);
      await settle();
      s.state.music.devices['music.room']!.observed.title = 'Song A';
      expect(await s.service.read(token(first), s.state)).toBeNull();
      expect(url(s)).toBeNull();
      await settle();
      if ('maxBytes' in options) {
        expect(s.fetch).toHaveBeenCalledTimes(3);
        s.clock.advanceBy(30_000);
        url(s);
        await settle();
      }
      expect(s.fetch).toHaveBeenCalledTimes(4);
    }
  });
  it('deduplicates in-flight requests and bounds concurrency across targets', async () => {
    let resolve!: (value: Response) => void;
    const s = setup(
      {
        maxConcurrent: 1,
        entities: {
          'music.room': 'media_player.room',
          'music.desk': 'media_player.desk',
        },
      },
      vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Response>((r) => {
              resolve = r;
            }),
        )
        .mockImplementation(async () => image()),
    );
    s.state.music.devices['music.desk'] = structuredClone(
      s.state.music.devices['music.room']!,
    );
    for (let i = 0; i < 10; i++) url(s);
    await settle();
    expect(s.fetch).toHaveBeenCalledTimes(1);
    resolve(image());
    await settle();
    url(s);
    await settle();
    expect(s.fetch).toHaveBeenCalledTimes(2);
    expect(s.service.snapshot(s.state, prefix)['music.desk']!.status).toBe(
      'available',
    );
  });
});

describe('HA path-prefix and lifecycle regressions', () => {
  it.each([picture, `/home-assistant${picture}`])(
    'supports a fixed configured HA base path with metadata %s',
    async (entityPicture) => {
      const s = setup({ baseUrl: 'https://ha.test/home-assistant/' });
      s.metadata.entityPicture = entityPicture;
      url(s);
      await settle();
      expect(url(s)).toBeTypeOf('string');
      expect(s.fetch.mock.calls[0]![0]).toBe(
        `https://ha.test/home-assistant${picture}`,
      );
      expect(s.fetch.mock.calls[0]![1]!.headers).toMatchObject({
        Authorization: 'Bearer private-credential',
      });
    },
  );
  it('never lets metadata escape the configured HA base path', async () => {
    const s = setup({ baseUrl: 'https://ha.test/home-assistant/' });
    for (const entityPicture of [
      '/home-assistant/../api/states',
      '/home-assistant//evil.test',
      '/other/api/media_player_proxy/media_player.room',
      'https://ha.test/home-assistant/api/media_player_proxy/media_player.room',
    ]) {
      s.metadata.entityPicture = entityPicture;
      expect(url(s)).toBeNull();
    }
    await settle();
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it('drops in-flight artwork when identity changes, including A → B → A', async () => {
    let resolve!: (response: Response) => void;
    const s = setup(
      {},
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    );
    url(s);
    await settle();
    s.metadata.generation = 3; // Adapter observed B, then A before the next projection.
    resolve(image());
    await settle();
    expect(url(s)).toBeNull();
    await settle();
    expect(s.fetch).toHaveBeenCalledTimes(2);
    s.service.dispose();
    await settle();
    expect(s.clock.pendingTimers()).toBe(0);
  });
  it('does not let cache memory pressure trigger an endless current-player refetch loop', async () => {
    for (const limits of [{ maxEntries: 1 }, { maxBytes: png.length }]) {
      const s = setup({
        ...limits,
        entities: {
          'music.room': 'media_player.room',
          'music.desk': 'media_player.desk',
        },
      });
      s.state.music.devices['music.desk'] = structuredClone(
        s.state.music.devices['music.room']!,
      );
      const off = s.service.subscribe(() => {
        s.service.snapshot(s.state, prefix);
      });
      url(s);
      await settle();
      expect(s.fetch.mock.calls.length).toBeLessThanOrEqual(2);
      expect(s.clock.pendingTimers()).toBe(0);
      off();
      s.service.dispose();
    }
  });
  it('rejects untrusted observations and metadata that no longer matches room state', async () => {
    const s = setup({ observationTrusted: () => false });
    expect(url(s)).toBeNull();
    await settle();
    expect(s.fetch).not.toHaveBeenCalled();
    const changed = setup({
      metadataProvider: () => ({
        generation: 1,
        source: 'Optical',
        title: 'Old',
        artist: null,
        album: null,
        mediaContentId: null,
        entityPicture: picture,
      }),
    });
    expect(url(changed)).toBeNull();
    await settle();
    expect(changed.fetch).not.toHaveBeenCalled();
  });
  it('keeps private HA identity stable across volume updates, advances on A → B → A, and rejects stale state', () => {
    const adapter = new HomeAssistantMusicAdapter(
      {
        baseUrl: 'http://ha.test',
        token: 'private',
        entities: { 'music.room': { entityId: 'media_player.room' } },
      },
      vi.fn(),
      new FakeClock(),
    );
    const observe = (title: string, last_updated: string, volume: number) =>
      adapter.acceptState({
        entity_id: 'media_player.room',
        state: 'playing',
        last_updated,
        attributes: {
          media_title: title,
          volume_level: volume,
          entity_picture: picture,
        },
      });
    observe('A', '2026-01-01T00:00:00Z', 0.4);
    const first = adapter.artworkMetadata('music.room')!;
    first.entityPicture = 'mutated';
    expect(adapter.artworkMetadata('music.room')!.entityPicture).toBe(picture);
    observe('A', '2026-01-01T00:00:01Z', 0.8);
    expect(adapter.artworkMetadata('music.room')!.generation).toBe(
      first.generation,
    );
    observe('B', '2026-01-01T00:00:02Z', 0.8);
    const second = adapter.artworkMetadata('music.room')!;
    observe('A', '2026-01-01T00:00:03Z', 0.8);
    expect(adapter.artworkMetadata('music.room')!.generation).toBeGreaterThan(
      second.generation,
    );
    observe('Old', '2026-01-01T00:00:00Z', 0.8);
    expect(adapter.artworkMetadata('music.room')!.title).toBe('A');
    adapter.acceptState({ entity_id: 'media_player.room', state: 'playing' });
    expect(adapter.artworkMetadata('music.room')!.entityPicture).toBeNull();
  });
});
