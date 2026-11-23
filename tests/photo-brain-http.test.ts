import { createServer, type AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import { LugnHttpServer } from '../src/runtime/http-server.js';
import {
  IntelError,
  parseBundle,
} from '../src/runtime/photo-intel/intel-store.js';
import type {
  BrainAlbum,
  PhotoBrainApi,
  PhotoLibrary,
} from '../src/runtime/photo-library.js';

const TOKEN = 'local-test-token';
const PICTURE = 'a'.repeat(24);
const ALBUM: BrainAlbum = {
  schema: 1,
  title: 'T',
  listedAt: 1,
  photos: [
    {
      id: PICTURE,
      version: 'v1',
      takenAt: 1,
      utcOffsetSeconds: 0,
      latitude: 55.528765,
      longitude: 13.377321,
      width: 1536,
      height: 2048,
      renditions: [
        {
          kind: 'jpeg',
          url: 'https://cvws.icloud-content.com/x',
          width: 1536,
          height: 2048,
        },
      ],
    },
  ],
};
const BUNDLE = {
  schema: 1,
  generatedAt: 1,
  brain: { version: '0.1.0' },
  home: null,
  trips: [],
  events: [],
  photos: {
    [PICTURE]: {
      v: 'v1',
      scene: [],
      q: { sharp: 80, dark: 3, junk: null },
      faces: [],
      cand: [],
      du: [],
    },
  },
};

describe('the photo brain API', () => {
  let server: LugnHttpServer | undefined;
  let engine: LugnEngine | undefined;
  afterEach(async () => {
    await server?.stop();
    engine?.dispose();
    server = undefined;
    engine = undefined;
  });

  async function start(
    options: {
      token?: string | null;
      brain?: boolean;
      albumFails?: boolean;
    } = {},
  ) {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const clock = new FakeClock();
    engine = new LugnEngine(clock, {
      deviceIds: ['lighting.ceiling'],
      scenes: [],
      adapter: new SimulatedLightingAdapter(clock),
    });
    const received: unknown[] = [];
    const api: PhotoBrainApi = {
      album: async () => {
        if (options.albumFails) throw new Error('offline');
        return ALBUM;
      },
      putIntel: async (bundle) => {
        // The real insight checks the bundle the same way.
        parseBundle(bundle);
        received.push(bundle);
        return { accepted: 1, unknown: 0 };
      },
      people: () => ({
        schema: 1,
        people: [{ id: 'p3', name: 'Anna', confirmed: true, hidden: false }],
        decided: { [`${PICTURE}.0`]: 'p3' },
        previous: {},
        not: {},
      }),
      state: () => ({
        revision: 'r1',
        intelAt: null,
        pictures: 1,
        analysed: 0,
      }),
    };
    const library = {
      brainApi: () => (options.brain === false ? undefined : api),
      peopleApi: () => undefined,
    } as unknown as PhotoLibrary;
    const token = options.token === undefined ? TOKEN : options.token;
    server = new LugnHttpServer({
      host: '127.0.0.1',
      port,
      ...(token === null ? {} : { bearerToken: token }),
      engine,
      capabilities: new CapabilityRegistry(engine),
      integrations: () => ({}),
      photoLibrary: library,
    });
    await server.start();
    const base = `http://127.0.0.1:${port}/photo-brain/v1`;
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const put = (
      body: Uint8Array | string,
      headers: Record<string, string> = {},
    ) =>
      fetch(`${base}/intel`, {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': 'application/json', ...headers },
        body,
      });
    return { base, port, auth, put, received };
  }

  it('answers only with the bearer token, and stays shut without one configured', async () => {
    const { base } = await start();
    for (const path of ['/album', '/people', '/state']) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(401);
      expect(
        (
          await fetch(`${base}${path}`, {
            headers: { Authorization: 'Bearer wrong-test-token' },
          })
        ).status,
      ).toBe(401);
    }
    expect(
      (await fetch(`${base}/intel`, { method: 'PUT', body: '{}' })).status,
    ).toBe(401);
    await server!.stop();
    const open = await start({ token: null });
    const response = await fetch(`${open.base}/album`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'photo_brain_requires_token',
    });
  });

  it('serves the album, the decisions and the state', async () => {
    const { base, auth } = await start();
    const album = await fetch(`${base}/album`, { headers: auth });
    expect(album.status).toBe(200);
    expect(album.headers.get('cache-control')).toBe('no-store');
    expect(await album.json()).toEqual(ALBUM);
    expect(
      await (await fetch(`${base}/people`, { headers: auth })).json(),
    ).toMatchObject({ schema: 1, decided: { [`${PICTURE}.0`]: 'p3' } });
    expect(
      await (await fetch(`${base}/state`, { headers: auth })).json(),
    ).toEqual({ revision: 'r1', intelAt: null, pictures: 1, analysed: 0 });
    // Wrong method and unknown routes.
    const wrong = await fetch(`${base}/album`, {
      method: 'PUT',
      headers: auth,
    });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('GET');
    expect((await fetch(`${base}/intel`, { headers: auth })).status).toBe(405);
    expect((await fetch(`${base}/nope`, { headers: auth })).status).toBe(404);
  });

  it('says when the album cannot be read, or the frame has no brain', async () => {
    const failing = await start({ albumFails: true });
    const response = await fetch(`${failing.base}/album`, {
      headers: failing.auth,
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'album_unavailable' });
    await server!.stop();
    const off = await start({ brain: false });
    const none = await fetch(`${off.base}/state`, { headers: off.auth });
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ error: 'photo_brain_unavailable' });
  });

  it('takes a bundle as JSON, plain or gzip, and refuses what is not one', async () => {
    const { put, received } = await start();
    const plain = await put(JSON.stringify(BUNDLE));
    expect(plain.status).toBe(200);
    expect(await plain.json()).toEqual({ accepted: 1, unknown: 0 });
    const zipped = await put(gzipSync(JSON.stringify(BUNDLE)), {
      'Content-Encoding': 'gzip',
    });
    expect(zipped.status).toBe(200);
    expect(received).toHaveLength(2);
    expect(received[1]).toEqual(BUNDLE);

    const invalid = await put(JSON.stringify({ ...BUNDLE, schema: 2 }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: 'invalid_bundle' });
    expect((await put('{"schema":')).status).toBe(400);
    expect((await put('')).status).toBe(400);
    const notGzip = await put(JSON.stringify(BUNDLE), {
      'Content-Encoding': 'gzip',
    });
    expect(notGzip.status).toBe(400);
    expect(await notGzip.json()).toEqual({ error: 'invalid_gzip' });
    expect(
      (await put(JSON.stringify(BUNDLE), { 'Content-Encoding': 'br' })).status,
    ).toBe(415);
    expect(
      (await put(JSON.stringify(BUNDLE), { 'Content-Type': 'text/plain' }))
        .status,
    ).toBe(415);
    expect(received).toHaveLength(2);
    expect(IntelError).toBeDefined();
  });

  it('stops inflating at 64 MB, so a small gzip bomb is refused', async () => {
    const { put } = await start();
    // 70 MB of spaces inside a JSON string: about 70 kB gzipped.
    const bomb = gzipSync(
      Buffer.concat([
        Buffer.from('{"schema":1,"x":"'),
        Buffer.alloc(70 * 1024 * 1024, 0x20),
        Buffer.from('"}'),
      ]),
    );
    expect(bomb.byteLength).toBeLessThan(1024 * 1024);
    const response = await put(bomb, { 'Content-Encoding': 'gzip' });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'request_too_large' });
  });

  it('refuses a body announced as larger than 64 MB without reading it', async () => {
    const { port } = await start();
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'PUT',
          path: '/photo-brain/v1/intel',
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            'Content-Type': 'application/json',
            'Content-Length': String(65 * 1024 * 1024),
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on('error', reject);
      request.write('{');
    });
    expect(status).toBe(413);
  });
});
