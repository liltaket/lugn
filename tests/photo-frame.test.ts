import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AlbumError,
  parseAlbumToken,
  parseBinaryPlistReals,
  readCapped,
  readSharedAlbum,
  type AlbumListing,
  type AlbumPhoto,
  type FetchLike,
} from '../src/runtime/icloud-shared-album.js';
import {
  PhotoLibrary,
  photoId,
  type PhotoLibraryOptions,
} from '../src/runtime/photo-library.js';
import {
  loadPlaceLookup,
  measureCorners,
  processPhoto,
} from '../src/runtime/photo-frame.js';
import sharp from 'sharp';
import { FakeClock } from '../src/core/clock.js';

// A binary plist with lat 55.52987 and lon 13.3773, as Apple stores a location.
const LOCATION =
  'YnBsaXN0MDDUAQIDBAUGBwhTYWx0U2xhdFNsb25Vc3BlZWQjQFLzMzMzMzMjQEvD0se4kNYjQCrBLXcxj8UjP+zMzMzMzM0IERUZHSMsNT4AAAAAAAABAQAAAAAAAAAJAAAAAAAAAAAAAAAAAAAARw==';
const LINK = 'https://photos.icloud.com/shared/album/ABCDEFGH12345678';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('shared album link', () => {
  it('accepts the CloudKit link forms and rejects legacy and foreign links', () => {
    expect(parseAlbumToken(LINK)).toBe('ABCDEFGH12345678');
    expect(parseAlbumToken(`${LINK}/`)).toBe('ABCDEFGH12345678');
    expect(
      parseAlbumToken('https://share.icloud.com/photos/ABCDEFGH12345678'),
    ).toBe('ABCDEFGH12345678');
    for (const bad of [
      'https://www.icloud.com/sharedalbum/#B0aGZNnr3Gkl',
      'http://photos.icloud.com/shared/album/ABCDEFGH12345678',
      'https://evil.example/shared/album/ABCDEFGH12345678',
      'https://photos.icloud.com.evil.example/shared/album/ABCDEFGH12345678',
    ])
      expect(() => parseAlbumToken(bad)).toThrow(AlbumError);
  });
  it('reads the location blob and nothing else', () => {
    const parsed = parseBinaryPlistReals(Buffer.from(LOCATION, 'base64'));
    expect(parsed.get('lat')).toBeCloseTo(55.52987, 5);
    expect(parsed.get('lon')).toBeCloseTo(13.3773, 4);
    expect(parseBinaryPlistReals(Buffer.from('not a plist'))).toEqual(
      new Map(),
    );
    expect(parseBinaryPlistReals(Buffer.alloc(200, 1))).toEqual(new Map());
  });
});

function json(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    arrayBuffer: async () =>
      new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer,
  };
}
const photoRecords = (name: string, over: Record<string, unknown> = {}) => [
  {
    recordName: `asset-${name}`,
    recordType: 'CPLAsset',
    fields: {
      masterRef: { value: { recordName: `master-${name}` } },
      assetDate: { value: 1_793_770_126_083 },
      timeZoneOffset: { value: 3600 },
      locationEnc: { value: LOCATION },
      ...over,
    },
  },
  {
    recordName: `master-${name}`,
    recordType: 'CPLMaster',
    fields: {
      itemType: { value: 'public.heic' },
      resJPEGMedRes: {
        value: { downloadURL: 'https://cvws.icloud-content.com/B/x/${f}?e=1' },
      },
      resJPEGMedFileType: { value: 'public.jpeg' },
      resJPEGMedWidth: { value: 1536 },
      resJPEGMedHeight: { value: 2048 },
    },
  },
];
function albumFetch(
  records: unknown[],
  partition = 'https://p123-ckdatabasews.icloud.com:443',
) {
  const calls: string[] = [];
  const fetcher: FetchLike = async (url) => {
    calls.push(url);
    if (url.endsWith('/records/resolve'))
      return json({
        results: [
          {
            databaseScope: 'SHARED',
            zoneID: { zoneName: 'SharedCollection-1' },
            anonymousPublicAccess: {
              token: 'tok',
              databasePartition: partition,
            },
            share: { fields: { 'cloudkit.title': { value: 'Test' } } },
          },
        ],
      });
    return json({ records });
  };
  return { fetcher, calls };
}

describe('readSharedAlbum', () => {
  it('lists photos with date, offset, size and location, skipping videos', async () => {
    const video = photoRecords('v');
    (video[1] as { fields: Record<string, unknown> }).fields['itemType'] = {
      value: 'com.apple.quicktime-movie',
    };
    const { fetcher, calls } = albumFetch([...photoRecords('a'), ...video]);
    const album = await readSharedAlbum(LINK, fetcher);
    expect(album.title).toBe('Test');
    expect(album.photos).toHaveLength(1);
    expect(album.photos[0]).toMatchObject({
      id: 'asset-a',
      width: 1536,
      height: 2048,
      takenAt: 1_793_770_126_083,
      utcOffsetSeconds: 3600,
    });
    expect(album.photos[0]!.latitude).toBeCloseTo(55.52987, 4);
    expect(album.photos[0]!.url).toContain('/photo.jpg?e=1');
    expect(calls[1]).toContain('p123-ckdatabasews.icloud.com');
  });
  it('offers the full-size original next to the browser rendition', async () => {
    const records = photoRecords('a');
    const master = records[1] as { fields: Record<string, unknown> };
    master.fields['resOriginalRes'] = {
      value: { downloadURL: 'https://cvws.icloud-content.com/B/o/${f}?e=2' },
    };
    master.fields['resOriginalFileType'] = { value: 'public.heic' };
    master.fields['resOriginalWidth'] = { value: 4032 };
    master.fields['resOriginalHeight'] = { value: 3024 };
    const album = await readSharedAlbum(LINK, albumFetch(records).fetcher);
    const renditions = album.photos[0]!.renditions!;
    expect(renditions.map((r) => r.kind)).toEqual(['jpeg', 'original']);
    expect(renditions[1]).toMatchObject({
      width: 4032,
      height: 3024,
      type: 'public.heic',
    });
    expect(renditions[1]!.url).toContain('/photo.jpg?e=2');
    // The asset's own upright full rendition wins over the master's original.
    (records[0] as { fields: Record<string, unknown> }).fields[
      'resJPEGFullRes'
    ] = { value: { downloadURL: 'https://cvws.icloud-content.com/B/f/${f}' } };
    (records[0] as { fields: Record<string, unknown> }).fields[
      'resJPEGFullFileType'
    ] = { value: 'public.heic' };
    (records[0] as { fields: Record<string, unknown> }).fields[
      'resJPEGFullWidth'
    ] = { value: 3024 };
    (records[0] as { fields: Record<string, unknown> }).fields[
      'resJPEGFullHeight'
    ] = { value: 4032 };
    const upright = await readSharedAlbum(LINK, albumFetch(records).fetcher);
    expect(upright.photos[0]!.renditions![1]).toMatchObject({
      width: 3024,
      height: 4032,
    });
    // A picture without an original still lists its browser rendition.
    const plain = await readSharedAlbum(
      LINK,
      albumFetch(photoRecords('b')).fetcher,
    );
    expect(plain.photos[0]!.renditions).toHaveLength(1);
  });
  it('refuses a partition or download host that is not Apple’s', async () => {
    await expect(
      readSharedAlbum(LINK, albumFetch([], 'https://evil.example').fetcher),
    ).rejects.toMatchObject({ code: 'unexpected_response' });
    const records = photoRecords('a');
    (records[1] as { fields: Record<string, unknown> }).fields[
      'resJPEGMedRes'
    ] = {
      value: { downloadURL: 'https://evil.example/x/${f}' },
    };
    const album = await readSharedAlbum(LINK, albumFetch(records).fetcher);
    expect(album.photos).toHaveLength(0);
  });
  it('explains an album without a public link', async () => {
    const fetcher: FetchLike = async () =>
      json({ results: [{ requireAppleLogin: true }] });
    await expect(readSharedAlbum(LINK, fetcher)).rejects.toMatchObject({
      code: 'not_public',
    });
  });
});

describe('hostile input', () => {
  it('survives a plist whose dictionary size lies', () => {
    const real = Buffer.from(LOCATION, 'base64');
    // The dictionary marker claims 0xFFFF entries.
    const hostile = Buffer.from(real);
    const top = hostile.length - 32 + 16; // topObject is index 0 here
    expect(top).toBeGreaterThan(0);
    const dictAt = hostile.indexOf(0xd4, 8);
    hostile[dictAt] = 0xdf;
    const evil = Buffer.concat([
      hostile.subarray(0, dictAt + 1),
      Buffer.from([0x11, 0xff, 0xff]),
      hostile.subarray(dictAt + 1),
    ]);
    const started = Date.now();
    expect(parseBinaryPlistReals(evil).size).toBe(0);
    expect(Date.now() - started).toBeLessThan(200);
    expect(parseBinaryPlistReals(Buffer.alloc(5000, 7)).size).toBe(0);
  });
  it('never follows a redirect and rejects odd ports and hosts', async () => {
    const seen: Array<string | undefined> = [];
    const { fetcher } = albumFetch(photoRecords('a'));
    const wrapped: FetchLike = async (url, init) => {
      seen.push(init?.redirect);
      return fetcher(url, init);
    };
    await readSharedAlbum(LINK, wrapped);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((redirect) => redirect === 'error')).toBe(true);
    await expect(
      readSharedAlbum(
        LINK,
        albumFetch([], 'https://p123-ckdatabasews.icloud.com:8443').fetcher,
      ),
    ).rejects.toMatchObject({ code: 'unexpected_response' });
    const records = photoRecords('a');
    for (const bad of [
      'https://cvws.icloud.com/x/${f}',
      'https://cvws.icloud-content.com:8443/x/${f}',
      'https://user@cvws.icloud-content.com/x/${f}',
      'https://icloud-content.com.evil.example/x/${f}',
    ]) {
      (records[1] as { fields: Record<string, unknown> }).fields[
        'resJPEGMedRes'
      ] = { value: { downloadURL: bad } };
      expect(
        (await readSharedAlbum(LINK, albumFetch(records).fetcher)).photos,
      ).toHaveLength(0);
    }
  });
  it('stops reading a response at the byte cap', async () => {
    const chunk = new Uint8Array(1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    await expect(
      readCapped(
        {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => '',
          arrayBuffer: async () => new ArrayBuffer(0),
          body: stream,
        },
        10_000,
      ),
    ).rejects.toThrow('too large');
  });
  it('reports a listing cut short by the page limit', async () => {
    const fetcher: FetchLike = async (url) => {
      if (url.endsWith('/records/resolve'))
        return json({
          results: [
            {
              databaseScope: 'SHARED',
              zoneID: { zoneName: 'z' },
              anonymousPublicAccess: {
                token: 't',
                databasePartition: 'https://p1-ckdatabasews.icloud.com',
              },
            },
          ],
        });
      return json({ records: [], continuationMarker: 'more' });
    };
    expect((await readSharedAlbum(LINK, fetcher)).truncated).toBe(true);
  });
});

describe('PhotoLibrary', () => {
  const jpeg = new Uint8Array([255, 216, 255, 217]);
  async function setup(over: Partial<PhotoLibraryOptions> = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'photo-frame-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    let listing: AlbumListing = { title: 'T', photos: [], truncated: false };
    const downloads: string[] = [];
    const library = new PhotoLibrary({
      cacheDir: dir,
      list: async () => listing,
      download: async (url) => {
        downloads.push(url);
        return jpeg;
      },
      process: async () => ({
        main: jpeg,
        backdrop: jpeg,
        width: 450,
        height: 600,
      }),
      place: () => 'Svedala',
      setTimer: () => ({}),
      ...over,
    });
    cleanups.push(() => library.dispose());
    return {
      dir,
      library,
      downloads,
      set: (value: AlbumListing) => (listing = value),
    };
  }
  const photo = (id: string, takenAt: number) => ({
    id,
    url: `https://cvws.icloud-content.com/${id}`,
    version: 'v1',
    width: 1536,
    height: 2048,
    takenAt,
    utcOffsetSeconds: 3600,
    latitude: 55.5,
    longitude: 13.4,
  });

  it('downloads each new photo once, with the local date and place', async () => {
    const { library, downloads, set } = await setup();
    await library.start();
    set({
      title: 'T',
      truncated: false,
      photos: [photo('a', 1_793_770_126_083)],
    });
    await library.refresh();
    await library.refresh();
    expect(downloads).toHaveLength(1);
    const { photos, revision } = library.snapshot();
    expect(photos).toEqual([
      {
        id: photoId('a:v1'),
        w: 450,
        h: 600,
        date: '2026-11-04',
        place: 'Svedala',
        t: 1_793_770_126_083,
        lat: 55.5,
        lon: 13.4,
        cc: null,
      },
    ]);
    expect(revision).not.toBe('');
    expect(JSON.stringify(photos)).not.toContain('icloud');
    expect(Array.from((await library.read(photoId('a:v1'), 'main'))!)).toEqual(
      Array.from(jpeg),
    );
    expect((await library.read(photoId('a:v1'), 'backdrop'))?.byteLength).toBe(
      4,
    );
    expect(await library.read('x'.repeat(24), 'main')).toBeNull();
    expect(await library.read('../../etc/passwd', 'main')).toBeNull();
  });
  it('keeps the cache when the listing fails or comes back empty', async () => {
    const { library, set } = await setup();
    await library.start();
    set({ title: 'T', truncated: false, photos: [photo('a', 1)] });
    await library.refresh();
    set({ title: 'T', truncated: false, photos: [] });
    await library.refresh();
    await library.refresh();
    expect(library.snapshot().photos).toHaveLength(1);
    await library.refresh(); // the third empty answer is believed
    expect(library.snapshot().photos).toHaveLength(0);
  });
  it('removes pictures that left the album and files nobody lists', async () => {
    const { library, set, dir } = await setup();
    await library.start();
    set({
      title: 'T',
      truncated: false,
      photos: [photo('a', 2), photo('b', 1)],
    });
    await library.refresh();
    set({ title: 'T', truncated: false, photos: [photo('b', 1)] });
    await library.refresh();
    expect(library.snapshot().photos.map((p) => p.id)).toEqual([
      photoId('b:v1'),
    ]);
    expect((await readdir(dir)).sort()).toEqual(
      [
        `${photoId('b:v1')}.bg.jpg`,
        `${photoId('b:v1')}.jpg`,
        'index.json',
      ].sort(),
    );
  });
  it('skips one failing picture and keeps the rest, newest first, capped', async () => {
    let n = 0;
    const { library, set } = await setup({
      maxPhotos: 2,
      process: async () => {
        n += 1;
        if (n === 1) throw new Error('bad picture');
        return { main: jpeg, backdrop: jpeg, width: 1, height: 1 };
      },
    });
    await library.start();
    set({
      title: 'T',
      truncated: false,
      photos: [photo('old', 1), photo('new', 3), photo('mid', 2)],
    });
    await library.refresh();
    expect(library.snapshot().photos.map((p) => p.id)).toEqual([
      photoId('mid:v1'),
    ]);
    await library.refresh(); // the failed one is tried again
    expect(library.snapshot().photos.map((p) => p.id)).toEqual([
      photoId('new:v1'),
      photoId('mid:v1'),
    ]);
  });
  it('keeps its cache when the listing throws, and warns about a cut-short album', async () => {
    const warnings: string[] = [];
    let fail = false;
    let truncated = false;
    const { library, set } = await setup({
      warn: (message) => warnings.push(message),
      list: async () => {
        if (fail) throw new Error('offline');
        return { title: 'T', photos: [photo('a', 1)], truncated };
      },
    });
    void set;
    await library.start();
    await library.refresh();
    fail = true;
    await library.refresh();
    expect(library.snapshot().photos).toHaveLength(1);
    expect(library.status().lastError).toBe('offline');
    fail = false;
    truncated = true;
    await library.refresh();
    expect(warnings.some((w) => w.includes('longer than what is read'))).toBe(
      true,
    );
    expect(library.status().lastError).toBeNull();
  });
  it('fetches an edited picture again under a new id', async () => {
    const { library, downloads, set } = await setup();
    await library.start();
    set({ title: 'T', truncated: false, photos: [photo('a', 1)] });
    await library.refresh();
    const first = library.snapshot().photos[0]!.id;
    set({
      title: 'T',
      truncated: false,
      photos: [{ ...photo('a', 1), version: 'v2' }],
    });
    await library.refresh();
    expect(downloads).toHaveLength(2);
    expect(library.snapshot().photos[0]!.id).not.toBe(first);
  });
  it('does not fail to start when the cache directory is unusable', async () => {
    const warnings: string[] = [];
    const { library } = await setup({
      cacheDir: '/proc/definitely/not/writable',
      warn: (message) => warnings.push(message),
    });
    await expect(library.start()).resolves.toBeUndefined();
    expect(library.snapshot().photos).toEqual([]);
    expect(warnings.some((w) => w.includes('cache unavailable'))).toBe(true);
  });
  it('survives a restart from its index', async () => {
    const first = await setup();
    await first.library.start();
    first.set({ title: 'T', truncated: false, photos: [photo('a', 1)] });
    await first.library.refresh();
    const second = new PhotoLibrary({
      cacheDir: first.dir,
      list: async () => ({ title: '', photos: [], truncated: false }),
      download: async () => jpeg,
      process: async () => ({
        main: jpeg,
        backdrop: jpeg,
        width: 1,
        height: 1,
      }),
      place: () => null,
      setTimer: () => ({}),
    });
    cleanups.push(() => second.dispose());
    await second.start();
    expect(second.snapshot().photos).toHaveLength(1);
  });
});

describe('processing and places', () => {
  it('scales a landscape to 1024 wide and a portrait to 640 high, with a small backdrop', async () => {
    const landscape = await sharp({
      create: { width: 2048, height: 1536, channels: 3, background: '#468' },
    })
      .jpeg()
      .toBuffer();
    const l = await processPhoto(landscape);
    expect([l.width, l.height]).toEqual([1024, 768]);
    expect((await sharp(l.backdrop).metadata()).width).toBe(192);
    const portrait = await sharp({
      create: { width: 1536, height: 2048, channels: 3, background: '#864' },
    })
      .jpeg()
      .toBuffer();
    const p = await processPhoto(portrait);
    expect([p.width, p.height]).toEqual([480, 640]);
    await expect(processPhoto(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
  it('names the nearest place only when one is close', () => {
    const place = loadPlaceLookup(
      new URL('../data/places.tsv', import.meta.url).pathname,
    );
    expect(place(55.52987, 13.3773)).toBe('Svedala');
    expect(place(0, -30)).toBeNull();
  });
});

describe('photo page veils', () => {
  const script = readFileSync(
    new URL('../src/ui/photos-page.js', import.meta.url),
    'utf8',
  );
  const context = createContext({ globalThis: {}, document: undefined });
  (context as { globalThis: unknown }).globalThis = context;
  runInContext(script, context);
  const bottom = (
    context as unknown as {
      lugnPhotos: { bottomCell: (layout: string, index: number) => boolean };
    }
  ).lugnPhotos.bottomCell;
  it('puts the menu veil only on pictures that reach the bottom edge', () => {
    // Three landscapes: the large one and the lower small one, not the upper.
    expect([0, 1, 2].map((i) => bottom('stack3', i))).toEqual([
      true,
      false,
      true,
    ]);
    // Two stacked panoramas: only the lower.
    expect([0, 1].map((i) => bottom('wide2', i))).toEqual([false, true]);
    for (const layout of ['single', 'duo', 'pair', 'trio', 'mixed'])
      expect([0, 1, 2].every((i) => bottom(layout, i))).toBe(true);
  });
});

describe('photo page order', () => {
  const script = readFileSync(
    new URL('../src/ui/photos-page.js', import.meta.url),
    'utf8',
  );
  const context = createContext({ globalThis: {}, document: undefined });
  (context as { globalThis: unknown }).globalThis = context;
  runInContext(script, context);
  type Q = {
    id: string;
    t: number | null;
    lat: number | null;
    lon: number | null;
  };
  const api = (
    context as unknown as {
      lugnPhotos: {
        orderQueue: (p: Q[], rnd?: () => number) => Q[];
        clusters: (p: Q[]) => Q[][];
        mulberry32: (s: number) => () => number;
      };
    }
  ).lugnPhotos;
  const H = 3_600_000;
  const shot = (id: string, hours: number, lat = 59.3, lon = 18): Q => ({
    id,
    t: Date.UTC(2026, 9, 1) + hours * H,
    lat,
    lon,
  });
  it('groups pictures taken within hours of each other and in the same area', () => {
    const photos = [
      shot('a1', 0),
      shot('a2', 1),
      shot('a3', 2.5),
      shot('b1', 30),
      shot('b2', 31),
      shot('c1', 32, 55.5, 13.4), // the same hour as b2, but a long way off
      { id: 'n1', t: null, lat: null, lon: null },
    ];
    const groups = api
      .clusters(photos)
      .map((g) => g.map((p) => p.id).join(','))
      .sort();
    expect(groups).toEqual(['a1,a2,a3', 'b1,b2', 'c1', 'n1']);
  });
  it('keeps every picture once and mostly keeps outings together, but not always', () => {
    const photos: Q[] = [];
    for (let day = 0; day < 12; day += 1)
      for (let i = 0; i < 6; i += 1)
        photos.push(shot(`d${day}p${i}`, day * 48 + i * 0.5));
    const day = (p: Q) => p.id.slice(0, p.id.indexOf('p'));
    let together = 0;
    let breaks = 0;
    for (let seed = 1; seed <= 20; seed += 1) {
      const order = api.orderQueue(photos, api.mulberry32(seed));
      expect(order.map((p) => p.id).sort()).toEqual(
        photos.map((p) => p.id).sort(),
      );
      for (let i = 1; i < order.length; i += 1)
        if (day(order[i]!) === day(order[i - 1]!)) together += 1;
        else breaks += 1;
    }
    // Neighbours usually share an outing (random order would give about 1/12).
    expect(together / (together + breaks)).toBeGreaterThan(0.5);
    // But the groups are not fixed: some neighbours come from elsewhere.
    expect(together / (together + breaks)).toBeLessThan(0.95);
  });
});

describe('photo page planner', () => {
  const script = readFileSync(
    new URL('../src/ui/photos-page.js', import.meta.url),
    'utf8',
  );
  const context = createContext({ globalThis: {}, document: undefined });
  (context as { globalThis: unknown }).globalThis = context;
  runInContext(script, context);
  type P = {
    id: string;
    w: number;
    h: number;
    date: string | null;
    place: string | null;
    t?: number | null;
    lat?: number | null;
    lon?: number | null;
  };
  const api = (
    context as unknown as {
      lugnPhotos: {
        plan: (
          q: P[],
          prev: string,
          rnd?: () => number,
        ) => {
          layout: string;
          photos: P[];
          rest: P[];
        } | null;
        caption: (p: P[], year?: number) => { place: string; date: string };
        mulberry32: (s: number) => () => number;
        orderQueue: (p: P[], rnd?: () => number) => P[];
        clusters: (p: P[]) => P[][];
      };
    }
  ).lugnPhotos;
  const land = (id: string): P => ({
    id,
    w: 1024,
    h: 768,
    date: '2026-11-04',
    place: 'Svedala',
  });
  const port = (id: string): P => ({
    id,
    w: 480,
    h: 640,
    date: '2026-11-04',
    place: 'Svedala',
  });
  const pano = (id: string): P => ({
    id,
    w: 1024,
    h: 400,
    date: '2026-11-04',
    place: null,
  });

  it('never repeats a layout and never loses or duplicates a picture', () => {
    const rnd = api.mulberry32(7);
    let queue = Array.from({ length: 60 }, (_, i) =>
      i % 3 === 0 ? land(`l${i}`) : port(`p${i}`),
    );
    const seen: string[] = [];
    let previous = '';
    while (queue.length > 0) {
      const chosen = api.plan(queue, previous, rnd)!;
      seen.push(...chosen.photos.map((p) => p.id));
      expect(chosen.rest.length).toBe(queue.length - chosen.photos.length);
      previous = chosen.layout;
      queue = chosen.rest;
    }
    expect(new Set(seen).size).toBe(60);
  });
  it('picks another layout when one besides the last fits', () => {
    const queue = [port('a'), port('b'), port('c')];
    for (let seed = 1; seed < 30; seed += 1) {
      expect(api.plan(queue, 'trio', api.mulberry32(seed))!.layout).toBe('duo');
      expect(api.plan(queue, 'duo', api.mulberry32(seed))!.layout).toBe('trio');
    }
  });
  it('never shows a portrait alone while anything can go with it', () => {
    for (let seed = 1; seed < 40; seed += 1) {
      for (const queue of [
        [port('a'), port('b')],
        [port('a'), land('b')],
        [port('a'), port('b'), land('c'), port('d')],
      ])
        expect(api.plan(queue, '', api.mulberry32(seed))!.layout).not.toBe(
          'single',
        );
    }
    // Only when nothing is left does a portrait stand alone.
    expect(api.plan([port('a')], '')!.layout).toBe('single');
    // A portrait and a landscape: the portrait goes first.
    const pair = api.plan([land('l'), port('p')], 'single', () => 0.99)!;
    expect(pair.layout).toBe('pair');
    expect(pair.photos.map((p) => p.id)).toEqual(['p', 'l']);
  });
  it('fits layouts to the shapes available', () => {
    const portraits = [port('a'), port('b'), port('c')];
    for (let seed = 1; seed < 20; seed += 1) {
      const trio = api.plan(portraits, '', api.mulberry32(seed))!;
      expect(['duo', 'trio']).toContain(trio.layout);
      expect(trio.photos).toHaveLength(trio.layout === 'trio' ? 3 : 2);
    }
    expect(api.plan([land('x')], '', Math.random)!.layout).toBe('single');
    expect(api.plan([], '')).toBeNull();
    // Two panoramas may stack; ordinary landscapes never do.
    const layouts = new Set<string>();
    for (let seed = 1; seed < 60; seed += 1)
      layouts.add(
        api.plan([pano('a'), pano('b'), port('c')], '', api.mulberry32(seed))!
          .layout,
      );
    expect(layouts.has('wide2')).toBe(true);
    for (let seed = 1; seed < 60; seed += 1)
      expect(
        api.plan([land('a'), land('b'), port('c')], '', api.mulberry32(seed))!
          .layout,
      ).not.toBe('wide2');
  });
  it('writes a caption only from what the pictures agree on', () => {
    expect(api.caption([port('a')], 2026)).toEqual({
      place: 'Svedala',
      date: '4 november',
    });
    expect(api.caption([port('a')], 2027)).toEqual({
      place: 'Svedala',
      date: '4 november 2026',
    });
    const other = { ...port('b'), date: '2026-11-09', place: 'Malmö' };
    expect(api.caption([port('a'), other], 2026)).toEqual({
      place: '',
      date: 'november 2026',
    });
    expect(api.caption([{ ...port('a'), date: null, place: null }])).toEqual({
      place: '',
      date: '',
    });
  });
});

describe('PhotoLibrary with insight', () => {
  const jpeg = new Uint8Array([255, 216, 255, 217]);
  const photo = (
    id: string,
    takenAt: number,
    details?: AlbumPhoto['details'],
  ): AlbumPhoto => ({
    id,
    url: `https://cvws.icloud-content.com/${id}`,
    version: 'v1',
    width: 1536,
    height: 2048,
    takenAt,
    utcOffsetSeconds: 3600,
    latitude: 55.5,
    longitude: 13.4,
    ...(details ? { details } : {}),
  });
  function fakeInsight() {
    const seen: string[][] = [];
    const listeners = new Set<() => void>();
    let version = 0;
    return {
      seen,
      bump: () => {
        version += 1;
        for (const listener of listeners) listener();
      },
      insight: {
        start: async () => undefined,
        sync: (
          photos: Array<{ id: string; cc: string | null; details?: unknown }>,
        ) => {
          seen.push(photos.map((p) => p.id));
          lastPhotos = photos;
        },
        decorate: () => ({
          extras: lastPhotos.map((_, i) => ({
            nb: [[(i + 1) % lastPhotos.length, 90]] as Array<[number, number]>,
          })),
          trips: [
            { title: 'Skåne', from: '2026-11-04', to: '2026-11-05', cc: 'SE' },
          ],
          people: [{ id: 'p1', name: 'Anna' }],
          scenes: { beach: 'Stranden' },
          ai: true,
        }),
        revision: () => String(version),
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        dispose: () => undefined,
      },
    };
  }
  let lastPhotos: Array<{ id: string; cc: string | null; details?: unknown }> =
    [];

  async function setup(
    listing: AlbumListing,
    insight?: ReturnType<typeof fakeInsight>['insight'],
  ) {
    const dir = await mkdtemp(join(tmpdir(), 'photo-frame-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const state = { listing };
    const library = new PhotoLibrary({
      cacheDir: dir,
      list: async () => state.listing,
      download: async () => jpeg,
      process: async () => ({
        main: jpeg,
        backdrop: jpeg,
        width: 450,
        height: 600,
      }),
      place: () => 'Svedala',
      country: () => 'SE',
      setTimer: () => ({}),
      ...(insight ? { insight } : {}),
    });
    cleanups.push(() => library.dispose());
    return { dir, library, state };
  }

  it('adds the neighbours, trips and people to the listing and the country to each picture', async () => {
    const fake = fakeInsight();
    const { library } = await setup(
      {
        title: 'T',
        truncated: false,
        photos: [photo('a', 2_000), photo('b', 1_000)],
      },
      fake.insight,
    );
    await library.start();
    await library.refresh();
    const listing = library.snapshot();
    expect(listing.photos).toHaveLength(2);
    expect(listing.photos[0]).toMatchObject({ cc: 'SE', nb: [[1, 90]] });
    expect(listing.trips).toHaveLength(1);
    expect(listing.people).toEqual([{ id: 'p1', name: 'Anna' }]);
    expect(listing.scenes).toEqual({ beach: 'Stranden' });
    expect(listing.ai).toBe(true);
    // Nothing private leaves in the listing: no file names, captions as such, or Apple data.
    expect(JSON.stringify(listing)).not.toMatch(/icloud|filename|IMG_/);
    expect(fake.seen.at(-1)).toHaveLength(2);
  });

  it('changes its revision when the insight changes, so the Hubs read the list again', async () => {
    const fake = fakeInsight();
    const { library } = await setup(
      { title: 'T', truncated: false, photos: [photo('a', 1_000)] },
      fake.insight,
    );
    await library.start();
    await library.refresh();
    const before = library.snapshot().revision;
    let notified = 0;
    library.subscribe(() => {
      notified += 1;
    });
    fake.bump();
    expect(library.snapshot().revision).not.toBe(before);
    expect(notified).toBe(1);
  });

  it('fills in what it has learned about a picture it already has, without downloading it again', async () => {
    const downloads: string[] = [];
    const dir = await mkdtemp(join(tmpdir(), 'photo-frame-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const state = {
      listing: {
        title: 'T',
        truncated: false,
        photos: [photo('a', 1_000)],
      } as AlbumListing,
    };
    const make = () =>
      new PhotoLibrary({
        cacheDir: dir,
        list: async () => state.listing,
        download: async (url) => {
          downloads.push(url);
          return jpeg;
        },
        process: async () => ({
          main: jpeg,
          backdrop: jpeg,
          width: 450,
          height: 600,
        }),
        place: () => 'Svedala',
        country: () => 'SE',
        setTimer: () => ({}),
      });
    const first = make();
    await first.start();
    await first.refresh();
    first.dispose();
    state.listing = {
      title: 'T',
      truncated: false,
      photos: [
        photo('a', 1_000, {
          favorite: true,
          caption: 'Midsommar',
        } as NonNullable<AlbumPhoto['details']>),
      ],
    };
    const fake = fakeInsight();
    const second = new PhotoLibrary({
      cacheDir: dir,
      list: async () => state.listing,
      download: async (url) => {
        downloads.push(url);
        return jpeg;
      },
      process: async () => ({
        main: jpeg,
        backdrop: jpeg,
        width: 450,
        height: 600,
      }),
      place: () => 'Svedala',
      country: () => 'SE',
      setTimer: () => ({}),
      insight: fake.insight,
    });
    cleanups.push(() => second.dispose());
    await second.start();
    // The first start already hands what is cached to the analysis.
    expect(fake.seen[0]).toHaveLength(1);
    await second.refresh();
    expect(downloads).toHaveLength(1);
    expect(
      (lastPhotos[0] as { details?: { caption?: string } }).details?.caption,
    ).toBe('Midsommar');
  });

  it('works exactly as before without an insight', async () => {
    const { library } = await setup({
      title: 'T',
      truncated: false,
      photos: [photo('a', 1_000)],
    });
    await library.start();
    await library.refresh();
    const listing = library.snapshot();
    expect(Object.keys(listing).sort()).toEqual(['photos', 'revision']);
    expect(library.peopleApi()).toBeUndefined();
  });
});

describe('corner brightness', () => {
  /** A 200 × 120 picture, dark except for a bright block in one corner. */
  async function picture(bright: 'tr' | 'br' | 'bl' | 'none') {
    const width = 200;
    const height = 120;
    const raw = Buffer.alloc(width * height * 3, 10);
    const paint = (x0: number, y0: number) => {
      for (let y = y0; y < y0 + 40; y += 1)
        for (let x = x0; x < x0 + 70; x += 1)
          raw.fill(245, (y * width + x) * 3, (y * width + x) * 3 + 3);
    };
    if (bright === 'tr') paint(width - 70, 0);
    if (bright === 'br') paint(width - 70, height - 40);
    if (bright === 'bl') paint(0, height - 40);
    return sharp(raw, { raw: { width, height, channels: 3 } })
      .jpeg()
      .toBuffer();
  }

  it('measures the upper right, lower right and lower left corner on their own', async () => {
    expect(
      (await measureCorners(await picture('none'))).every((n) => n < 10),
    ).toBe(true);
    const [tr, br, bl] = await measureCorners(await picture('tr'));
    expect(tr).toBeGreaterThan(80);
    expect(br).toBeLessThan(15);
    expect(bl).toBeLessThan(15);
    expect((await measureCorners(await picture('br')))[1]).toBeGreaterThan(80);
    expect((await measureCorners(await picture('bl')))[2]).toBeGreaterThan(80);
  });

  it('is part of every processed picture', async () => {
    const processed = await processPhoto(await picture('br'));
    expect(processed.corners).toHaveLength(3);
    expect(processed.corners![1]).toBeGreaterThan(80);
  });

  it('is measured afterwards for pictures cached before it existed, without a download', async () => {
    const jpegBytes = new Uint8Array([255, 216, 255, 217]);
    const dir = await mkdtemp(join(tmpdir(), 'photo-frame-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const photo = {
      id: 'a',
      url: 'https://cvws.icloud-content.com/a',
      version: 'v1',
      width: 1536,
      height: 2048,
      takenAt: 1_000,
      utcOffsetSeconds: 0,
      latitude: null,
      longitude: null,
    };
    let downloads = 0;
    const make = (
      measure?: (b: Uint8Array) => Promise<[number, number, number]>,
    ) =>
      new PhotoLibrary({
        cacheDir: dir,
        list: async () => ({ title: 'T', truncated: false, photos: [photo] }),
        download: async () => {
          downloads += 1;
          return jpegBytes;
        },
        process: async () => ({
          main: jpegBytes,
          backdrop: jpegBytes,
          width: 450,
          height: 600,
        }),
        place: () => null,
        setTimer: () => ({}),
        ...(measure ? { measure } : {}),
      });
    const first = make();
    await first.start();
    await first.refresh();
    expect(first.snapshot().photos[0]).not.toHaveProperty('lu');
    first.dispose();
    const second = make(async () => [11, 22, 33]);
    cleanups.push(() => second.dispose());
    await second.start();
    await second.refresh();
    expect(second.snapshot().photos[0]?.lu).toEqual([11, 22, 33]);
    expect(downloads).toBe(1);
    // Kept in the index, so a restart does not measure again.
    const third = make(async () => {
      throw new Error('must not measure twice');
    });
    cleanups.push(() => third.dispose());
    await third.start();
    expect(third.snapshot().photos[0]?.lu).toEqual([11, 22, 33]);
  });
});

describe('PhotoLibrary at album scale', () => {
  const jpeg = new Uint8Array([255, 216, 255, 217]);
  const photo = (
    id: string,
    takenAt: number,
    extra: Partial<AlbumPhoto> = {},
  ): AlbumPhoto => ({
    id,
    url: `https://cvws.icloud-content.com/${id}`,
    version: 'v1',
    width: 1536,
    height: 2048,
    takenAt,
    utcOffsetSeconds: 3600,
    latitude: 55.528_765,
    longitude: 13.377_321,
    ...extra,
  });
  async function setup(over: Partial<PhotoLibraryOptions> = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'photo-frame-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const state: { listing: AlbumListing; lists: number } = {
      listing: { title: 'T', photos: [], truncated: false },
      lists: 0,
    };
    const make = (extra: Partial<PhotoLibraryOptions> = {}) => {
      const library = new PhotoLibrary({
        cacheDir: dir,
        list: async () => {
          state.lists += 1;
          return state.listing;
        },
        download: async () => jpeg,
        process: async () => ({
          main: jpeg,
          backdrop: jpeg,
          width: 450,
          height: 600,
        }),
        place: () => 'Svedala',
        setTimer: () => ({}),
        ...over,
        ...extra,
      });
      cleanups.push(() => library.dispose());
      return library;
    };
    return { dir, state, make, library: make() };
  }

  it('keeps up to 5000 pictures unless told otherwise', async () => {
    const { DEFAULT_MAX_PHOTOS } =
      await import('../src/runtime/photo-library.js');
    expect(DEFAULT_MAX_PHOTOS).toBe(5000);
  });

  it('writes and shows its progress every few new pictures, and only a full pass clears files', async () => {
    let processed = 0;
    const control: { stop?: () => void } = {};
    const { dir, state, make, library } = await setup({
      checkpointEvery: 2,
      process: async () => {
        processed += 1;
        // The fifth new picture of the second pass never finishes: Lugn is
        // stopped mid-way.
        if (processed === 6) control.stop?.();
        return { main: jpeg, backdrop: jpeg, width: 1, height: 1 };
      },
    });
    control.stop = () => library.dispose();
    // A picture cached before, which is no longer in the album.
    state.listing = {
      title: 'T',
      truncated: false,
      photos: [photo('gone', 99)],
    };
    await library.start();
    await library.refresh();
    const gone = photoId('gone:v1');
    state.listing = {
      title: 'T',
      truncated: false,
      photos: [1, 2, 3, 4, 5, 6].map((n) => photo(`p${n}`, 10 - n)),
    };
    const seen: number[] = [];
    library.subscribe(() => seen.push(library.snapshot().photos.length));
    // Checkpoints after the 2nd and 4th new picture.
    await library.refresh();
    expect(seen).toEqual([3, 5]);
    // The picture that left stays (with its files) until a pass completes.
    expect((await readdir(dir)).some((name) => name.startsWith(gone))).toBe(
      true,
    );
    // A restart keeps the four pictures done, and carries on from there.
    const fresh = make();
    await fresh.start();
    expect(fresh.snapshot().photos.map((p) => p.id)).toEqual([
      ...[1, 2, 3, 4].map((n) => photoId(`p${n}:v1`)),
      gone,
    ]);
    await fresh.refresh();
    expect(fresh.snapshot().photos.map((p) => p.id)).toEqual(
      [1, 2, 3, 4, 5, 6].map((n) => photoId(`p${n}:v1`)),
    );
    expect((await readdir(dir)).some((name) => name.startsWith(gone))).toBe(
      false,
    );
  });

  it('keeps full precision for this machine and a coarse position for the Hubs', async () => {
    const synced: Array<Array<{ lat: number | null }>> = [];
    const { state, library } = await setup({
      insight: {
        start: async () => undefined,
        sync: (photos) => void synced.push(photos),
        decorate: () => ({
          extras: [{}],
          trips: [],
          people: [],
          scenes: {},
          ai: false,
        }),
        revision: () => '0',
        subscribe: () => () => undefined,
        dispose: () => undefined,
      },
    });
    state.listing = { title: 'T', truncated: false, photos: [photo('a', 1)] };
    await library.start();
    await library.refresh();
    expect(library.snapshot().photos[0]).toMatchObject({
      lat: 55.53,
      lon: 13.38,
    });
    expect(synced.at(-1)?.[0]?.lat).toBe(55.528_765);
  });

  it("hands the photo brain the whole album with Lugn's own ids and fresh links", async () => {
    const clock = new FakeClock(1_763_900_000_000);
    const { state, library } = await setup({ clock, maxPhotos: 1 });
    state.listing = {
      title: 'Familjen',
      truncated: false,
      photos: [
        photo('old', 1),
        photo('new', 3, {
          version: 'v7',
          renditions: [
            {
              kind: 'jpeg',
              url: 'https://cvws.icloud-content.com/j',
              width: 1536,
              height: 2048,
            },
            {
              kind: 'original',
              url: 'https://cvws.icloud-content.com/o',
              width: 3024,
              height: 4032,
              type: 'public.heic',
            },
          ],
        }),
      ],
    };
    await library.start();
    await library.refresh();
    expect(library.snapshot().photos).toHaveLength(1);
    const lists = state.lists;
    const album = await library.albumForBrain();
    // Listed less than five minutes ago: no new read.
    expect(state.lists).toBe(lists);
    expect(album).toMatchObject({
      schema: 1,
      title: 'Familjen',
      listedAt: clock.now(),
    });
    expect(album.photos.map((p) => p.id)).toEqual([
      photoId('new:v7'),
      photoId('old:v1'),
    ]);
    expect(album.photos[0]).toMatchObject({
      version: 'v7',
      takenAt: 3,
      utcOffsetSeconds: 3600,
      latitude: 55.528_765,
      longitude: 13.377_321,
    });
    expect(album.photos[0]!.renditions.map((r) => r.kind)).toEqual([
      'jpeg',
      'original',
    ]);
    expect(album.photos[1]!.renditions).toEqual([
      {
        kind: 'jpeg',
        url: 'https://cvws.icloud-content.com/old',
        width: 1536,
        height: 2048,
      },
    ]);
    // Older than five minutes: listed again, once for callers that arrive together.
    clock.advanceBy(5 * 60_000 + 1);
    await Promise.all([library.albumForBrain(), library.albumForBrain()]);
    expect(state.lists).toBe(lists + 1);
  });

  it('serves a listing a few minutes old when Apple fails, never an expired one', async () => {
    const clock = new FakeClock(1_000_000);
    let fail = false;
    const listing: AlbumListing = {
      title: 'T',
      truncated: false,
      photos: [photo('a', 1)],
    };
    const { library } = await setup({
      clock,
      list: async () => {
        if (fail) throw new Error('offline');
        return listing;
      },
    });
    await library.start();
    await expect(library.albumForBrain()).resolves.toMatchObject({
      listedAt: 1_000_000,
    });
    fail = true;
    clock.advanceBy(10 * 60_000);
    await expect(library.albumForBrain()).resolves.toMatchObject({
      listedAt: 1_000_000,
    });
    clock.advanceBy(6 * 60_000);
    await expect(library.albumForBrain()).rejects.toThrow('offline');
  });

  it('does not believe a single empty answer for the brain either', async () => {
    const clock = new FakeClock(1_000_000);
    let photos = [photo('a', 1)];
    const { library } = await setup({
      clock,
      list: async () => ({ title: 'T', truncated: false, photos }),
    });
    await library.start();
    await library.albumForBrain();
    photos = [];
    for (const expected of [1, 1, 0]) {
      clock.advanceBy(5 * 60_000 + 1);
      expect((await library.albumForBrain()).photos).toHaveLength(expected);
    }
  });

  it('offers the brain API only with an insight that is switched on', async () => {
    const insight = {
      start: async () => undefined,
      sync: () => undefined,
      decorate: () => ({
        extras: [],
        trips: [],
        people: [],
        scenes: {},
        ai: false,
      }),
      revision: () => '0',
      subscribe: () => () => undefined,
      dispose: () => undefined,
      putIntel: async () => ({ accepted: 0, unknown: 0 }),
      labels: () => ({
        schema: 1 as const,
        people: [],
        decided: {},
        previous: {},
        not: {},
      }),
      brainState: () => ({ intelAt: null, pictures: 0, analysed: 0 }),
    };
    expect((await setup()).library.brainApi()).toBeUndefined();
    expect(
      (await setup({ insight, brainEnabled: false })).library.brainApi(),
    ).toBeUndefined();
    const { library } = await setup({ insight });
    await library.start();
    expect(library.brainApi()?.state()).toMatchObject({
      revision: library.snapshot().revision,
      intelAt: null,
    });
  });
});
