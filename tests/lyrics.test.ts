import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { HomeAssistantMusicAdapter } from '../src/adapters/home-assistant-music.js';
import { FakeClock } from '../src/core/clock.js';
import { parseLrc, type LyricsProvider } from '../src/core/lyrics.js';
import { LrclibLyrics } from '../src/runtime/lrclib-lyrics.js';
import { LugnDisplayServer } from '../src/runtime/display-server.js';
import {
  WiimPlayhead,
  type PlayheadProvider,
} from '../src/runtime/wiim-playhead.js';

const synced = '[00:10.00] First line\n[00:14.50] Second line';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const track = { title: 'Song', artist: 'Band', durationSeconds: 200.4 };

describe('LRC lines', () => {
  it('reads repeated timestamps, offsets and pauses, in time order', () => {
    expect(
      parseLrc(
        '[ar:Band]\n[offset:+500]\n[00:20.00][00:05.50] Chorus\n[00:12:00]\n' +
          '[00:15.00] <00:15.10>Word <00:15.60>timed',
      ),
    ).toEqual([
      { at: 5, text: 'Chorus' },
      { at: 11.5, text: '' },
      { at: 14.5, text: 'Word timed' },
      { at: 19.5, text: 'Chorus' },
    ]);
  });

  it('is empty for text without anything to follow', () => {
    expect(parseLrc('Just words\nand more')).toEqual([]);
    expect(parseLrc('[00:01.00]\n[00:09.00]')).toEqual([]);
  });
});

describe('LRCLIB', () => {
  it('asks for the exact recording and keeps the answer', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      json({ duration: 200, syncedLyrics: synced }),
    );
    const lyrics = new LrclibLyrics(fetcher);
    const first = await lyrics.lookup({ ...track, album: 'Album' });
    expect(first).toEqual({
      status: 'synced',
      lines: [
        { at: 10, text: 'First line' },
        { at: 14.5, text: 'Second line' },
      ],
    });
    expect(await lyrics.lookup({ ...track, album: 'Album' })).toEqual(first);
    // The exact lookup and the search beside it, once.
    expect(fetcher).toHaveBeenCalledTimes(2);
    const url = new URL(
      String(
        fetcher.mock.calls.find(([input]) =>
          String(input).includes('/get?'),
        )![0],
      ),
    );
    expect(url.origin + url.pathname).toBe('https://lrclib.net/api/get');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      track_name: 'Song',
      artist_name: 'Band',
      album_name: 'Album',
      duration: '200',
    });
  });

  it('searches when the exact record has no timed lines, by length', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      String(input).includes('/get?')
        ? json({ duration: 200, syncedLyrics: null, plainLyrics: 'x' })
        : json([
            { duration: 260, syncedLyrics: '[00:01.00] Other recording' },
            { duration: 202, syncedLyrics: '[00:01.00] Near' },
            { duration: 200, syncedLyrics: '[00:01.00] Closest' },
          ]),
    );
    expect(await new LrclibLyrics(fetcher).lookup(track)).toEqual({
      status: 'synced',
      lines: [{ at: 1, text: 'Closest' }],
    });
  });

  it('tells instrumental, unknown and unreachable apart', async () => {
    const answer = (response: () => Response) =>
      new LrclibLyrics(async () => response()).lookup(track);
    expect(await answer(() => json({ instrumental: true }))).toEqual({
      status: 'instrumental',
    });
    expect(
      await new LrclibLyrics(async (input) =>
        String(input).includes('/get?') ? json({}, 404) : json([]),
      ).lookup(track),
    ).toEqual({ status: 'none' });
    expect(await answer(() => json({}, 503))).toEqual({
      status: 'unavailable',
    });
  });

  it('asks again after a failure, once a while has passed', async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>(async () => json({}, 500));
    const lyrics = new LrclibLyrics(fetcher, () => now);
    await lyrics.lookup(track);
    await lyrics.lookup(track);
    expect(fetcher).toHaveBeenCalledTimes(2);
    now = 60_000;
    await lyrics.lookup(track);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('does not ask about a recording longer than any song', async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(
      await new LrclibLyrics(fetcher).lookup({
        ...track,
        durationSeconds: 3600,
      }),
    ).toEqual({ status: 'none' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('the WiiM playhead', () => {
  const status = (extra: Record<string, string> = {}) =>
    JSON.stringify({
      mode: '31',
      status: 'play',
      curpos: '11285',
      totlen: '238426',
      Title: Buffer.from('Song').toString('hex'),
      Artist: Buffer.from('Band').toString('hex'),
      ...extra,
    });

  it('times the position halfway through the question, and shares answers', async () => {
    let now = 1_000;
    const sendCommand = vi.fn(async () => {
      now += 40;
      return status();
    });
    const playhead = new WiimPlayhead(
      { 'music.room': '192.168.1.5' },
      { sendCommand },
      () => now,
    );
    const [first, second] = await Promise.all([
      playhead.read('music.room'),
      playhead.read('music.room'),
    ]);
    expect(first).toEqual({
      playing: true,
      positionSeconds: 11.285,
      durationSeconds: 238.426,
      measuredAt: 1_020,
      title: 'Song',
      artist: 'Band',
      album: null,
    });
    expect(second).toEqual(first);
    expect(sendCommand).toHaveBeenCalledTimes(1);
    now += 500;
    await playhead.read('music.room');
    expect(sendCommand).toHaveBeenCalledTimes(2);
  });

  it('has no answer for an input, a failure or an unknown player', async () => {
    const reader = (reply: () => Promise<string>) =>
      new WiimPlayhead({ 'music.room': '192.168.1.5' }, { sendCommand: reply });
    expect(
      await reader(async () => status({ mode: '43' })).read('music.room'),
    ).toBeNull();
    expect(
      await reader(async () => {
        throw new Error('offline');
      }).read('music.room'),
    ).toBeNull();
    expect(await reader(async () => status()).read('constructor')).toBeNull();
  });
});

describe('the Hub lyrics route', () => {
  const token = 'a'.repeat(32);
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function setup(lyrics?: LyricsProvider, playhead?: PlayheadProvider) {
    const finder = createServer();
    await new Promise<void>((resolve) =>
      finder.listen(0, '127.0.0.1', resolve),
    );
    const address = finder.address();
    if (!address || typeof address === 'string') throw new Error('No port');
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
    const server = new LugnDisplayServer({
      host: '127.0.0.1',
      port,
      hubs: [{ id: 'bed', role: 'bed', token, castHost: '127.0.0.1' }],
      capabilities: new CapabilityRegistry(engine),
      scenes: [...engine.scenes.values()],
      stateProvider: () => engine.state,
      stateStream: engine.stream,
      ...(lyrics ? { lyrics } : {}),
      ...(playhead ? { playhead } : {}),
    });
    await server.start();
    cleanups.push(async () => {
      await server.stop();
      engine.dispose();
    });
    const play = (attributes: Record<string, unknown>) =>
      adapter.acceptState({
        entity_id: 'media_player.room',
        state: 'playing',
        attributes,
      });
    const route = (path: string, headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${port}/k/${token}/display-api/${path}`, {
        headers,
      });
    const get = (target: string, headers: Record<string, string> = {}) =>
      route(`lyrics/${target}`, headers);
    const at = (target: string) => route(`playhead/${target}`);
    return { play, get, at };
  }

  it("looks up the player's own track and names it", async () => {
    const lookup = vi.fn<LyricsProvider['lookup']>(async () => ({
      status: 'instrumental',
    }));
    const s = await setup({ lookup });
    s.play({ media_title: 'Song', media_artist: 'Band' });
    const response = await s.get('music.room');
    expect(await response.json()).toEqual({
      status: 'instrumental',
      track: { title: 'Song', artist: 'Band' },
    });
    expect(lookup).toHaveBeenCalledWith({ title: 'Song', artist: 'Band' });
  });

  it('asks nothing without an artist, a known player or its own origin', async () => {
    const lookup = vi.fn<LyricsProvider['lookup']>();
    const s = await setup({ lookup });
    s.play({ media_title: 'Radio' });
    expect(await (await s.get('music.room')).json()).toEqual({
      status: 'none',
    });
    expect((await s.get('music.other')).status).toBe(404);
    expect((await s.get('__proto__')).status).toBe(404);
    expect(
      (await s.get('music.room', { 'sec-fetch-site': 'cross-site' })).status,
    ).toBe(403);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("answers where the player itself says it is, ahead of Home Assistant's report", async () => {
    const lookup = vi.fn<LyricsProvider['lookup']>(async () => ({
      status: 'none',
    }));
    const s = await setup(
      { lookup },
      {
        now: () => 1_500,
        read: async () => ({
          playing: true,
          positionSeconds: 12.345,
          durationSeconds: 200.5,
          measuredAt: 1_250,
          title: 'New song',
          artist: 'Band',
          album: 'Album',
        }),
      },
    );
    s.play({
      media_title: 'Old song',
      media_artist: 'Band',
      media_position: 11,
      media_duration: 200,
      media_position_updated_at: new Date().toISOString(),
    });
    expect(await (await s.at('music.room')).json()).toEqual({
      source: 'player',
      playing: true,
      position: 12.595,
      duration: 200.5,
      track: { title: 'New song', artist: 'Band' },
      held: expect.any(Number),
    });
    // The new track's lines are asked for before any page asks.
    expect(lookup).toHaveBeenCalledWith({
      title: 'New song',
      artist: 'Band',
      album: 'Album',
      durationSeconds: 200.5,
    });
  });

  it('marks a position from Home Assistant as coarse', async () => {
    const s = await setup();
    expect(await (await s.at('music.room')).json()).toMatchObject({
      source: 'none',
    });
    s.play({
      media_title: 'Song',
      media_position: 30,
      media_duration: 200,
      media_position_updated_at: new Date().toISOString(),
    });
    expect(await (await s.at('music.room')).json()).toMatchObject({
      source: 'coarse',
      playing: true,
      duration: 200,
    });
    expect((await s.at('music.other')).status).toBe(404);
  });

  it('is absent without a lyrics source', async () => {
    const s = await setup();
    expect((await s.get('music.room')).status).toBe(404);
  });
});
