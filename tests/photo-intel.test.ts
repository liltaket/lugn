import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseBinaryPlist, plistNumbers } from '../src/runtime/bplist.js';
import { extractDetails } from '../src/runtime/icloud-shared-album.js';
import {
  PhotoAnalyzer,
  type WorkerHandle,
} from '../src/runtime/photo-intel/analyzer.js';
import {
  AnalysisStore,
  CLIP_DIM,
  FACE_DIM,
  type StoredFace,
} from '../src/runtime/photo-intel/analysis-store.js';
import {
  ALIGN_TEMPLATE,
  alignedCrop,
  applySimilarity,
  decodeYuNet,
  fitSimilarity,
  frontalness,
  nonMaxSuppression,
  normalize,
  type DetectedFace,
} from '../src/runtime/photo-intel/faces.js';
import {
  affinity,
  classifyScene,
  findHome,
  groupPhotos,
  loadScenes,
  placeScore,
  timeScore,
  type GroupingInput,
} from '../src/runtime/photo-intel/grouping.js';
import { PhotoInsight } from '../src/runtime/photo-intel/insight.js';
import {
  PeopleError,
  PeopleStore,
  linkFaces,
  type FaceRef,
} from '../src/runtime/photo-intel/people.js';
import type {
  WorkerReply,
  WorkerRequest,
} from '../src/runtime/photo-intel/worker.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lugn-intel-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// ── Binary property lists ──

// plistlib output for {"{TIFF}": {Model, Make}, "{Exif}": {...}, "{GPS}": {...}, "{ExifAux}": {Regions: ...}}.
const IMAGE_PROPERTIES =
  'YnBsaXN0MDDUAQIDBAUVISpZe0V4aWZBdXh9VntFeGlmfVV7R1BTfVZ7VElGRn3RBgdXUmVnaW9uc9EICVpSZWdpb25MaXN0ogoT1QsMDQ4PEBEQEhJWSGVpZ2h0VFR5cGVVV2lkdGhRWFFZIz+5mZmZmZmaVEZhY2UjP9mZmZmZmZrVCwwNDg8QERAUEiM/4zMzMzMzM9UWFxgZGhscHR4gXxAPQnJpZ2h0bmVzc1ZhbHVlVUZsYXNoXxASRm9jYWxMZW5JbjM1bW1GaWxtXxAPSVNPU3BlZWRSYXRpbmdzWUxlbnNNb2RlbCO/+AAAAAAAABAQEBehHxDIXxAraVBob25lIDE0IFBybyBNYXggZnJvbnQgY2FtZXJhIDIuNjltbSBmLzEuOdQiIyQlJicoKVhBbHRpdHVkZVtBbHRpdHVkZVJlZlxJbWdEaXJlY3Rpb25VU3BlZWQjQEHAAAAAAAAQACNAcOAAAAAAACM/+AAAAAAAANIrLC0uVE1ha2VVTW9kZWxVQXBwbGVfEBFpUGhvbmUgMTQgUHJvIE1heAAIABEAGwAiACgALwAyADoAPQBIAEsAVgBdAGIAaABqAGwAdQB6AIMAjgCXAKIAtAC6AM8A4QDrAPQA9gD4APoA/AEqATMBPAFIAVUBWwFkAWYBbwF4AX0BggGIAY4AAAAAAAACAQAAAAAAAAAvAAAAAAAAAAAAAAAAAAABog==';
const KEYWORDS =
  'YnBsaXN0MDCiAQJWc3RyYW5kWHNlbWVzdGVyCAsSAAAAAAAAAQEAAAAAAAAAAwAAAAAAAAAAAAAAAAAAABs=';
const CAPTION_PLIST =
  'YnBsaXN0MDBfEBRNaWRzb21tYXIgaG9zIG1vcm1vcggAAAAAAAABAQAAAAAAAAABAAAAAAAAAAAAAAAAAAAAHw==';

describe('binary property lists', () => {
  it('reads nested dictionaries, arrays, strings and numbers', () => {
    const parsed = parseBinaryPlist(
      Buffer.from(IMAGE_PROPERTIES, 'base64'),
    ) as Record<string, Record<string, unknown>>;
    expect(parsed['{TIFF}']?.['Model']).toBe('iPhone 14 Pro Max');
    expect(parsed['{Exif}']?.['ISOSpeedRatings']).toEqual([200]);
    expect(parsed['{GPS}']?.['Altitude']).toBe(35.5);
    expect(parseBinaryPlist(Buffer.from(KEYWORDS, 'base64'))).toEqual([
      'strand',
      'semester',
    ]);
    expect(parseBinaryPlist(Buffer.from(CAPTION_PLIST, 'base64'))).toBe(
      'Midsommar hos mormor',
    );
  });

  it('gives nothing for hostile or foreign data and respects its limits', () => {
    expect(
      parseBinaryPlist(Buffer.from('not a plist at all, really not')),
    ).toBeUndefined();
    expect(parseBinaryPlist(Buffer.alloc(300, 7))).toBeUndefined();
    const real = Buffer.from(IMAGE_PROPERTIES, 'base64');
    expect(parseBinaryPlist(real, { maxBytes: 100 })).toBeUndefined();
    // A table pointing outside the buffer must end in undefined, not a loop.
    const broken = Buffer.from(real);
    broken.writeBigUInt64BE(2n ** 40n, broken.length - 8);
    expect(parseBinaryPlist(broken)).toBeUndefined();
    // Depth is capped.
    expect(parseBinaryPlist(real, { maxDepth: 1 })).not.toEqual(
      parseBinaryPlist(real),
    );
  });

  it('keeps only the numbers of a flat dictionary', () => {
    expect(plistNumbers(Buffer.from(IMAGE_PROPERTIES, 'base64')).size).toBe(0);
  });
});

describe('what an album record says about a picture', () => {
  const asset = (fields: Record<string, unknown> = {}) => ({
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, { value: v }]),
    ),
  });
  it("reads camera, lens, exposure, heading, altitude and the phone's faces", () => {
    const details = extractDetails(
      asset({
        isFavorite: 1,
        assetBatchId: 'BATCH-1',
        addedDate: 1_700_000_000_000,
        assetSubtypeV2: 4,
        keywordsEnc: KEYWORDS,
        captionEnc: CAPTION_PLIST,
      }),
      asset({
        filenameEnc: Buffer.from('IMG_0042.HEIC').toString('base64'),
        mediaMetaDataEnc: IMAGE_PROPERTIES,
      }),
    );
    expect(details).toMatchObject({
      filename: 'IMG_0042.HEIC',
      caption: 'Midsommar hos mormor',
      keywords: ['strand', 'semester'],
      favorite: true,
      subtype: 4,
      batch: 'BATCH-1',
      device: 'iPhone 14 Pro Max',
      lens: 'front',
      iso: 200,
      brightness: -1.5,
      flash: false,
      altitude: 35.5,
      heading: 270,
      speed: 1.5,
      deviceFaces: 2,
    });
  });

  it('copes with a record that has nothing', () => {
    const details = extractDetails(asset(), asset());
    expect(details).toMatchObject({
      filename: null,
      caption: null,
      keywords: [],
      favorite: false,
      device: null,
      lens: null,
      altitude: null,
      deviceFaces: 0,
    });
  });
});

// ── Faces ──

describe('face detection arithmetic', () => {
  /** YuNet tensors with one confident face at a known cell of stride 8. */
  function outputs(size = 640) {
    const cells = [size / 8, size / 16, size / 32].map((n) => n * n);
    const make = (width: number) =>
      cells.map((n) => new Float32Array(n * width));
    const tensors = {
      cls: make(1),
      obj: make(1),
      bbox: make(4),
      kps: make(10),
    };
    const col = 10;
    const row = 20;
    const index = row * (size / 8) + col;
    tensors.cls[0]![index] = 0.9;
    tensors.obj[0]![index] = 0.9;
    // box centre at (col + 0.5, row + 0.5) * 8, 4 cells wide and 5 tall
    tensors.bbox[0]!.set([0.5, 0.5, Math.log(4), Math.log(5)], index * 4);
    tensors.kps[0]!.set([0, 0, 1, 0, 0.5, 1, 0, 2, 1, 2], index * 10);
    return tensors;
  }

  it('decodes boxes and landmarks like OpenCV does', () => {
    const [face] = decodeYuNet(outputs());
    expect(face).toBeDefined();
    expect(face!.score).toBeCloseTo(0.9);
    expect(face!.w).toBeCloseTo(32);
    expect(face!.h).toBeCloseTo(40);
    expect(face!.x + face!.w / 2).toBeCloseTo(84);
    expect(face!.y + face!.h / 2).toBeCloseTo(164);
    expect(face!.landmarks[0]).toEqual({ x: 80, y: 160 });
    expect(face!.landmarks[2]).toEqual({ x: 84, y: 168 });
  });

  it('ignores weak detections', () => {
    const tensors = outputs();
    tensors.obj[0]!.fill(0.1);
    expect(decodeYuNet(tensors)).toEqual([]);
  });

  it('keeps the strongest of overlapping boxes', () => {
    const base: DetectedFace = {
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      score: 0.8,
      landmarks: Array(5).fill({ x: 0, y: 0 }) as DetectedFace['landmarks'],
    };
    const kept = nonMaxSuppression([
      base,
      { ...base, x: 5, score: 0.95 },
      { ...base, x: 400, score: 0.7 },
    ]);
    expect(kept.map((f) => f.score)).toEqual([0.95, 0.7]);
  });

  it('measures how frontal a face is from where the nose sits', () => {
    const eyes = [
      { x: 30, y: 40 },
      { x: 70, y: 40 },
    ] as const;
    const face = (noseX: number) =>
      [
        eyes[0],
        eyes[1],
        { x: noseX, y: 60 },
        { x: 35, y: 80 },
        { x: 65, y: 80 },
      ] as DetectedFace['landmarks'];
    expect(frontalness(face(50))).toBe(1);
    expect(frontalness(face(66))).toBeLessThan(0.3);
    expect(frontalness(face(30))).toBeLessThan(frontalness(face(40)));
  });

  it('fits the similarity transform that aligns landmarks to the template', () => {
    // Landmarks that are the template scaled 2x, rotated 30° and moved.
    const angle = Math.PI / 6;
    const moved = ALIGN_TEMPLATE.map((p) => ({
      x: 2 * (p.x * Math.cos(angle) - p.y * Math.sin(angle)) + 90,
      y: 2 * (p.x * Math.sin(angle) + p.y * Math.cos(angle)) - 40,
    }));
    const fit = fitSimilarity(moved, ALIGN_TEMPLATE);
    moved.forEach((p, i) => {
      const out = applySimilarity(fit, p);
      expect(out.x).toBeCloseTo(ALIGN_TEMPLATE[i]!.x, 3);
      expect(out.y).toBeCloseTo(ALIGN_TEMPLATE[i]!.y, 3);
    });
  });

  it('cuts a 112 px planar crop, grey outside the picture', () => {
    const width = 4;
    const height = 4;
    const rgb = new Uint8Array(width * height * 3).fill(200);
    const points = ALIGN_TEMPLATE.map((p) => ({
      x: p.x / 28,
      y: p.y / 28,
    })) as DetectedFace['landmarks'];
    const crop = alignedCrop(rgb, width, height, points);
    expect(crop).toHaveLength(3 * 112 * 112);
    expect(crop[0 * 112 * 112 + 56 * 112 + 56]).toBeCloseTo(200);
    const far = alignedCrop(
      rgb,
      width,
      height,
      points.map((p) => ({
        x: p.x + 500,
        y: p.y,
      })) as DetectedFace['landmarks'],
    );
    expect(far[10]).toBe(128);
  });

  it('normalises vectors', () => {
    const v = normalize([3, 4]);
    expect(Math.hypot(v[0]!, v[1]!)).toBeCloseTo(1);
    expect(normalize([0, 0])).toEqual(new Float32Array([0, 0]));
  });
});

// ── Grouping ──

function input(over: Partial<GroupingInput> & { id: string }): GroupingInput {
  return {
    t: null,
    lat: null,
    lon: null,
    place: null,
    cc: null,
    people: [],
    ...over,
  };
}
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 12, 12);

describe('which pictures belong together', () => {
  it('scores time and place by how near they are', () => {
    expect(timeScore(10 * 60_000)).toBe(1);
    expect(timeScore(2 * HOUR)).toBeGreaterThan(timeScore(10 * HOUR));
    expect(timeScore(10 * HOUR)).toBeGreaterThan(timeScore(5 * 24 * HOUR));
    expect(timeScore(60 * 24 * HOUR)).toBe(0);
    expect(placeScore(0.1)).toBe(1);
    expect(placeScore(10)).toBeGreaterThan(placeScore(100));
    expect(placeScore(500)).toBe(0);
  });

  it('puts the same outing together and keeps strangers apart', () => {
    const here = { lat: 59.3, lon: 18.0 };
    const a = input({ id: 'a', t: T0, ...here });
    const b = input({ id: 'b', t: T0 + 20 * 60_000, lat: 59.301, lon: 18.001 });
    const farAway = input({
      id: 'c',
      t: T0 + 30 * 24 * HOUR,
      lat: 41.9,
      lon: 12.5,
    });
    expect(affinity(a, b)).toBeGreaterThan(0.9);
    expect(affinity(a, farAway)).toBeLessThan(0.1);
    expect(affinity(a, b)).toBe(affinity(b, a));
  });

  it('lets people and looks decide what time and place cannot', () => {
    const one = (v: number[]) => normalize(v);
    const both = [
      input({ id: 'a', t: T0, people: ['p1'], embedding: one([1, 0, 0]) }),
      input({
        id: 'b',
        t: T0 + 40 * 24 * HOUR,
        people: ['p1'],
        embedding: one([1, 0.1, 0]),
      }),
    ];
    const strangers = [
      input({ id: 'a', t: T0, people: ['p1'], embedding: one([1, 0, 0]) }),
      input({
        id: 'b',
        t: T0 + 40 * 24 * HOUR,
        people: ['p2'],
        embedding: one([0, 1, 0]),
      }),
    ];
    expect(affinity(both[0]!, both[1]!)).toBeGreaterThan(0.5);
    expect(affinity(strangers[0]!, strangers[1]!)).toBeLessThan(0.1);
  });

  it('knows nothing of a picture without any data and scores it zero', () => {
    expect(affinity(input({ id: 'a' }), input({ id: 'b' }))).toBe(0);
  });

  it('finds home as where most pictures are taken', () => {
    const photos = [
      ...Array.from({ length: 8 }, (_, i) =>
        input({
          id: `h${i}`,
          t: T0 + i * HOUR,
          lat: 59.3 + i * 0.001,
          lon: 18.0,
        }),
      ),
      input({ id: 'far', t: T0, lat: 50.0, lon: 20.0 }),
    ];
    const home = findHome(photos)!;
    expect(home.lat).toBeCloseTo(59.3, 1);
    expect(findHome(photos.slice(0, 3))).toBeNull();
  });

  it('names a trip from consecutive days away from home', () => {
    const photos: GroupingInput[] = [];
    for (let i = 0; i < 10; i += 1)
      photos.push(
        input({
          id: `h${i}`,
          t: T0 - (40 - i) * 24 * HOUR,
          lat: 59.3,
          lon: 18.0,
          place: 'Stockholm',
          cc: 'SE',
        }),
      );
    for (let day = 0; day < 3; day += 1)
      for (let i = 0; i < 3; i += 1)
        photos.push(
          input({
            id: `t${day}${i}`,
            t: T0 + day * 24 * HOUR + i * HOUR,
            lat: 49.4,
            lon: 22.3,
            place: 'Lesko',
            cc: 'PL',
          }),
        );
    const { extras, trips } = groupPhotos(photos, {
      scenes: null,
      countryName: (cc) => (cc === 'PL' ? 'Polen' : cc),
    });
    expect(trips).toEqual([
      { title: 'Lesko', from: '2026-09-12', to: '2026-09-14', cc: 'PL' },
    ]);
    expect(extras.slice(0, 10).every((e) => e.tr === undefined)).toBe(true);
    expect(extras.slice(10).every((e) => e.tr === 0)).toBe(true);
    // Strongest neighbours first, and every list names real indexes.
    const nb = extras[10]!.nb!;
    expect(nb[0]![1]).toBeGreaterThanOrEqual(nb[nb.length - 1]![1]);
    for (const [index] of nb) expect(photos[index]).toBeDefined();
  });

  it('uses the country when no single place carries the trip', () => {
    const photos = [
      ...Array.from({ length: 6 }, (_, i) =>
        input({
          id: `h${i}`,
          t: T0 - (30 - i) * 24 * HOUR,
          lat: 59.3,
          lon: 18.0,
          cc: 'SE',
          place: 'Stockholm',
        }),
      ),
      ...['Roma', 'Florens', 'Pisa', 'Siena'].map((place, i) =>
        input({
          id: `t${i}`,
          t: T0 + i * 20 * HOUR,
          lat: 42 + i,
          lon: 12,
          place,
          cc: 'IT',
        }),
      ),
    ];
    const { trips } = groupPhotos(photos, {
      scenes: null,
      countryName: () => 'Italien',
    });
    expect(trips[0]?.title).toBe('Italien');
  });

  it('flags bursts as duplicates and favourites and captions come through', () => {
    const photos = [
      input({
        id: 'a',
        t: T0,
        embedding: normalize([1, 0]),
        details: { favorite: true, caption: 'Midsommar' },
      }),
      input({ id: 'b', t: T0 + 2000, embedding: normalize([1, 0.01]) }),
    ];
    const { extras } = groupPhotos(photos, { scenes: null });
    expect(extras[0]).toMatchObject({ du: [1], fav: 1, cap: 'Midsommar' });
    expect(extras[1]?.du).toEqual([0]);
  });

  it('reads the scene vocabulary and names the best match when sure', () => {
    const scenes = loadScenes()!;
    expect(scenes.keys).toContain('beach');
    expect(scenes.names['beach']).toBe('Stranden');
    expect(scenes.names['screen']).toBeUndefined();
    const dim = scenes.vectors[0]!.length;
    expect(dim).toBe(CLIP_DIM);
    const beach = scenes.vectors[scenes.keys.indexOf('beach')]!;
    const guess = classifyScene(beach, scenes)!;
    expect(guess.key).toBe('beach');
    expect(guess.p).toBeGreaterThan(0.45);
  });
});

// ── People ──

const unit = (seed: number, jitter = 0, index = 0): Float32Array => {
  const v = new Float32Array(FACE_DIM);
  // A deterministic direction per identity, plus a little individual noise.
  let x = seed * 9301 + 49297;
  for (let i = 0; i < FACE_DIM; i += 1) {
    x = (x * 233280 + 49297) % 2147483647;
    v[i] = (x / 2147483647) * 2 - 1;
  }
  let y = (index + 1) * 7919;
  for (let i = 0; i < FACE_DIM; i += 1) {
    y = (y * 48271) % 2147483647;
    v[i] = v[i]! + jitter * ((y / 2147483647) * 2 - 1);
  }
  return normalize(v);
};
const PHOTO = (n: number): string =>
  `photo${String(n).padStart(19, '0')}`.slice(0, 24);
function face(
  photoNo: number,
  identity: number,
  index = 0,
  extra: Partial<StoredFace> = {},
): FaceRef {
  return {
    id: `${PHOTO(photoNo)}.${index}`,
    photoId: PHOTO(photoNo),
    face: {
      x: 0.4,
      y: 0.3,
      w: 0.2,
      h: 0.25,
      score: 0.95,
      front: 0.9,
      embedding: unit(identity, 0.35, photoNo * 10 + index),
      ...extra,
    },
  };
}

describe('who is who', () => {
  it('groups faces by identity and leaves singles alone', async () => {
    const dir = await tempDir();
    const store = new PeopleStore(join(dir, 'people.json'));
    await store.load();
    const faces = [
      ...[1, 2, 3, 4].map((n) => face(n, 11)),
      ...[5, 6, 7].map((n) => face(n, 22)),
      face(8, 33),
    ];
    store.regroup(faces);
    const view = store.view();
    expect(view.people.map((p) => p.faces).sort()).toEqual([3, 4]);
    expect(view.unassigned.count).toBe(1);
    expect(store.peopleByPhoto().get(PHOTO(1))).toHaveLength(1);
    expect(store.peopleByPhoto().has(PHOTO(8))).toBe(false);
  });

  it('keeps ids stable when new pictures arrive and never merges what differs', async () => {
    const dir = await tempDir();
    const store = new PeopleStore(join(dir, 'people.json'));
    await store.load();
    const first = [
      ...[1, 2, 3].map((n) => face(n, 11)),
      ...[4, 5, 6].map((n) => face(n, 22)),
    ];
    store.regroup(first);
    const before = store.peopleByPhoto();
    const ids = new Set([...before.values()].flat());
    expect(ids.size).toBe(2);
    store.regroup([...first, face(7, 11), face(8, 22), face(9, 44)]);
    const after = store.peopleByPhoto();
    expect(after.get(PHOTO(1))).toEqual(before.get(PHOTO(1)));
    expect(after.get(PHOTO(7))).toEqual(before.get(PHOTO(1)));
    expect(after.get(PHOTO(8))).toEqual(before.get(PHOTO(4)));
    expect(after.has(PHOTO(9))).toBe(false);
  });

  it('names a person, confirms the group and remembers it across restarts', async () => {
    const dir = await tempDir();
    const path = join(dir, 'people.json');
    const store = new PeopleStore(path);
    await store.load();
    const faces = [1, 2, 3].map((n) => face(n, 11));
    store.regroup(faces);
    const [person] = store.view().people;
    store.rename(person!.id, '  Anna  ');
    expect(store.nameOf(person!.id)).toBe('Anna');
    expect(store.person(person!.id)?.confirmed).toBe(true);
    await store.save();
    expect(
      JSON.parse(await readFile(path, 'utf8')).people[person!.id].name,
    ).toBe('Anna');
    const again = new PeopleStore(path);
    await again.load();
    again.regroup(faces);
    expect(again.nameOf(person!.id)).toBe('Anna');
    expect(again.view().people[0]?.faces).toBe(3);
    // The file is private to the user.
    expect(
      (await (await import('node:fs/promises')).stat(path)).mode & 0o777,
    ).toBe(0o600);
  });

  it('moves a face and never lets the automatic grouping put it back', async () => {
    const dir = await tempDir();
    const store = new PeopleStore(join(dir, 'people.json'));
    await store.load();
    const faces = [
      ...[1, 2, 3].map((n) => face(n, 11)),
      ...[4, 5, 6].map((n) => face(n, 22)),
    ];
    store.regroup(faces);
    const [one, two] = store.view().people;
    const stray = one!.samples[0]!.id;
    store.moveFace(stray, { person: two!.id });
    store.regroup(faces);
    const moved = store.view().people.find((p) => p.id === two!.id)!;
    expect(moved.samples.some((s) => s.id === stray)).toBe(true);
    // "Not a person" removes the face from every list.
    store.moveFace(stray, 'none');
    store.regroup(faces);
    expect(store.view().ignored).toBe(1);
    expect(store.peopleByPhoto().get(stray.split('.')[0]!)).toBeUndefined();
    // A new person from one face.
    const other = two!.samples.find((s) => s.id !== stray)!.id;
    store.moveFace(other, 'new');
    expect(store.view().people.length).toBe(3);
    expect(() => store.moveFace('nope', 'none')).toThrow(PeopleError);
    expect(() => store.moveFace(other, { person: 'p999' })).toThrow(
      PeopleError,
    );
  });

  it('merges two people and hides a stranger', async () => {
    const dir = await tempDir();
    const store = new PeopleStore(join(dir, 'people.json'));
    await store.load();
    const faces = [
      ...[1, 2, 3].map((n) => face(n, 11)),
      ...[4, 5, 6].map((n) => face(n, 22)),
    ];
    store.regroup(faces);
    const [a, b] = store.view().people;
    store.rename(a!.id, 'Erik');
    store.merge(b!.id, a!.id);
    store.regroup(faces);
    const view = store.view();
    expect(view.people).toHaveLength(1);
    expect(view.people[0]).toMatchObject({ name: 'Erik', faces: 6 });
    expect(() => store.merge(a!.id, a!.id)).toThrow(PeopleError);
    store.setHidden(a!.id, true);
    expect(store.peopleByPhoto().size).toBe(0);
    expect(store.activeCount()).toBe(0);
  });

  it('only lets clear, front-facing faces start a new person', async () => {
    const dir = await tempDir();
    const store = new PeopleStore(join(dir, 'people.json'));
    await store.load();
    store.regroup(
      [1, 2, 3].map((n) => face(n, 11, 0, { score: 0.65, front: 0.1 })),
    );
    expect(store.view().people).toHaveLength(0);
    expect(store.view().unassigned.count).toBe(3);
  });

  it('links by average agreement', () => {
    const faces = [face(1, 1), face(2, 1), face(3, 2), face(4, 2)];
    expect(
      linkFaces(faces, 0.38)
        .map((g) => g.length)
        .sort(),
    ).toEqual([2, 2]);
    expect(linkFaces(faces, 0.999).length).toBe(4);
  });
});

// ── The analysis queue ──

class FakeWorker implements WorkerHandle {
  replies: Array<(reply: WorkerReply) => void> = [];
  exits: Array<(why: string) => void> = [];
  received: WorkerRequest[] = [];
  killed = false;
  constructor(
    readonly behave: (message: WorkerRequest, worker: FakeWorker) => void,
  ) {}
  send(message: WorkerRequest): void {
    this.received.push(message);
    queueMicrotask(() => this.behave(message, this));
  }
  onReply(handler: (reply: WorkerReply) => void): void {
    this.replies.push(handler);
    queueMicrotask(() => handler({ type: 'ready' }));
  }
  onExit(handler: (why: string) => void): void {
    this.exits.push(handler);
  }
  kill(): void {
    this.killed = true;
  }
  say(reply: WorkerReply): void {
    for (const handler of this.replies) handler(reply);
  }
}
const ID = (n: number): string => `img${String(n).padStart(21, '0')}`;
const okReply = (id: string): WorkerReply => ({
  type: 'result',
  id,
  embedding: unit(1),
  faces: [],
  ms: 5,
});
const tick = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('analysing new pictures', () => {
  function make(
    behave: (m: WorkerRequest, w: FakeWorker) => void,
    extra: Record<string, unknown> = {},
  ) {
    const workers: FakeWorker[] = [];
    let changes = 0;
    const store = new AnalysisStore('/nonexistent/analysis.json', 'm1');
    const analyzer = new PhotoAnalyzer({
      store,
      pathOf: (id) => `/cache/${id}.jpg`,
      models: async () => ({
        paths: { clip: 'a', detector: 'b', recognizer: 'c' },
        reason: null,
      }),
      spawn: () => {
        const worker = new FakeWorker(behave);
        workers.push(worker);
        return worker;
      },
      pauseMs: 0,
      onChange: () => {
        changes += 1;
      },
      ...extra,
    });
    cleanups.push(() => analyzer.dispose());
    return { analyzer, store, workers, changes: () => changes };
  }

  it('analyses each new picture once, in order, and stores the result', async () => {
    const { analyzer, store, workers, changes } = make((m, w) => {
      if (m.type === 'analyse') w.say(okReply(m.id));
    });
    analyzer.enqueue([ID(1), ID(2), ID(3)]);
    await tick();
    expect(store.size).toBe(3);
    expect(workers).toHaveLength(1);
    expect(
      workers[0]!.received.map((m) => (m.type === 'analyse' ? m.id : '')),
    ).toEqual([ID(1), ID(2), ID(3)]);
    expect(changes()).toBeGreaterThan(0);
    expect(analyzer.status()).toMatchObject({
      state: 'idle',
      pending: 0,
      done: 3,
    });
    // Already analysed pictures never go back to the worker.
    analyzer.enqueue([ID(1), ID(2), ID(3)]);
    await tick();
    expect(workers[0]!.received).toHaveLength(3);
  });

  it('skips a picture that cannot be analysed and tries it only twice', async () => {
    const { analyzer, store, workers } = make((m, w) => {
      if (m.type === 'analyse')
        w.say(
          m.id === ID(2)
            ? { type: 'error', id: m.id, message: 'broken' }
            : okReply(m.id),
        );
    });
    analyzer.enqueue([ID(1), ID(2), ID(3)]);
    await tick();
    expect(store.has(ID(1)) && store.has(ID(3))).toBe(true);
    expect(store.has(ID(2))).toBe(false);
    expect(analyzer.status().failed).toBe(1);
    analyzer.enqueue([ID(2)]);
    await tick();
    expect(analyzer.status().failed).toBe(2);
    analyzer.enqueue([ID(2)]);
    await tick();
    expect(analyzer.status().failed).toBe(2);
    expect(
      workers[0]!.received.filter(
        (m) => m.type === 'analyse' && m.id === ID(2),
      ),
    ).toHaveLength(2);
  });

  it('reports models that are missing and does nothing else', async () => {
    const analyzer = new PhotoAnalyzer({
      store: new AnalysisStore('/nonexistent/analysis.json', 'm1'),
      pathOf: () => '/x',
      models: async () => ({ paths: null, reason: 'models missing' }),
      spawn: () => {
        throw new Error('must not start a worker');
      },
      onChange: () => undefined,
    });
    cleanups.push(() => analyzer.dispose());
    analyzer.enqueue([ID(1)]);
    await tick();
    expect(analyzer.status()).toMatchObject({
      state: 'unavailable',
      reason: 'models missing',
      pending: 0,
    });
  });

  it('replaces a worker that dies mid-picture and backs off after repeated failures', async () => {
    const { analyzer, workers } = make(
      (m, w) => {
        if (m.type === 'analyse') for (const exit of w.exits) exit('exit 137');
      },
      { maxConsecutiveFailures: 2, backoffMs: 60_000 },
    );
    analyzer.enqueue([ID(1), ID(2), ID(3), ID(4)]);
    await tick();
    expect(analyzer.status().state).toBe('backoff');
    expect(workers.length).toBeGreaterThanOrEqual(2);
  });

  it('forgets queued pictures that left the library', async () => {
    const gate: Array<() => void> = [];
    const { analyzer, workers } = make((m, w) => {
      if (m.type === 'analyse') gate.push(() => w.say(okReply(m.id)));
    });
    analyzer.enqueue([ID(1), ID(2), ID(3)]);
    await tick();
    analyzer.forget(new Set([ID(1)]));
    gate.shift()!();
    await tick();
    expect(
      workers[0]!.received.filter((m) => m.type === 'analyse'),
    ).toHaveLength(1);
  });

  it('lets an idle worker go', async () => {
    const { analyzer, workers } = make(
      (m, w) => {
        if (m.type === 'analyse') w.say(okReply(m.id));
      },
      { idleMs: 5 },
    );
    analyzer.enqueue([ID(1)]);
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(workers[0]!.received.some((m) => m.type === 'stop')).toBe(true);
  });
});

describe('the analysis cache', () => {
  it('survives a restart, forgets removed pictures and starts over for other models', async () => {
    const dir = await tempDir();
    const path = join(dir, 'analysis.json');
    const store = new AnalysisStore(path, 'm1');
    await store.load();
    const faces = [
      {
        x: 0.1,
        y: 0.2,
        w: 0.3,
        h: 0.3,
        score: 0.9,
        front: 0.8,
        embedding: unit(5),
      },
    ];
    const clip = (n: number) =>
      normalize(
        Array.from({ length: CLIP_DIM }, (_, i) => Math.sin(i * n + 1)),
      );
    store.put(ID(1), { embedding: clip(1), faces, at: 5 });
    store.put(ID(2), { embedding: clip(2), faces: [], at: 6 });
    await store.save();
    const again = new AnalysisStore(path, 'm1');
    await again.load();
    expect(again.size).toBe(2);
    expect(again.get(ID(1))?.faces[0]?.embedding[3]).toBeCloseTo(
      unit(5)[3]!,
      5,
    );
    expect(again.retain(new Set([ID(1)]))).toBe(true);
    expect(again.has(ID(2))).toBe(false);
    const other = new AnalysisStore(path, 'm2');
    await other.load();
    expect(other.size).toBe(0);
  });

  it('shrugs off a damaged file', async () => {
    const dir = await tempDir();
    const path = join(dir, 'analysis.json');
    await writeFile(path, '{ not json');
    const warnings: string[] = [];
    const store = new AnalysisStore(path, 'm1', (m) => warnings.push(m));
    await store.load();
    expect(store.size).toBe(0);
    expect(warnings).toHaveLength(1);
  });
});

// ── Everything together ──

describe('the insight service', () => {
  it('analyses, groups people, decorates the listing and takes corrections', async () => {
    const dir = await tempDir();
    const photos = Array.from({ length: 6 }, (_, i) => ({
      id: ID(i + 1),
      t: T0 + i * 10 * 60_000,
      lat: 59.3,
      lon: 18.0,
      place: 'Stockholm',
      cc: 'SE',
      utcOffsetSeconds: 7200,
    }));
    const identities = [11, 11, 11, 22, 22, 22];
    const insight = new PhotoInsight({
      cacheDir: dir,
      modelsDir: join(dir, 'models'),
      enabled: true,
      readPhoto: async () => null,
      scenes: null,
      pauseMs: 0,
      saveDelayMs: 5,
      spawn: () =>
        new FakeWorker((m, w) => {
          if (m.type !== 'analyse') return;
          const n = Number(/(\d+)$/.exec(m.id)![1]) - 1;
          w.say({
            type: 'result',
            id: m.id,
            embedding: normalize([1, n === 5 ? 0.4 : 0, 0]),
            faces: [
              {
                x: 0.4,
                y: 0.3,
                w: 0.2,
                h: 0.25,
                score: 0.95,
                front: 0.9,
                embedding: unit(identities[n]!, 0.35, n),
              },
            ],
            ms: 3,
          });
        }),
    });
    cleanups.push(() => insight.dispose());
    // Models "installed": the analyzer only asks for files that exist.
    const { MODELS } = await import('../src/runtime/photo-intel/models.js');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'models'));
    for (const spec of MODELS)
      await writeFile(join(dir, 'models', spec.file), Buffer.alloc(spec.bytes));
    await insight.start();
    let notified = 0;
    insight.subscribe(() => {
      notified += 1;
    });
    const revisionBefore = insight.revision();
    insight.sync(photos);
    await tick(40);
    expect(insight.status()).toMatchObject({
      available: true,
      analysed: 6,
      faces: 6,
    });
    expect(notified).toBeGreaterThan(0);
    expect(insight.revision()).not.toBe(revisionBefore);
    const decorated = insight.decorate();
    expect(decorated.ai).toBe(true);
    expect(decorated.people).toHaveLength(2);
    expect(decorated.extras[0]?.pp).toHaveLength(1);
    expect(decorated.extras[0]?.nb?.length).toBeGreaterThan(0);
    // A name changes what a Hub is told.
    const view = insight.peopleView();
    const revision = insight.revision();
    insight.rename(view.people[0]!.id, 'Anna');
    expect(insight.revision()).not.toBe(revision);
    expect(
      insight.decorate().people.find((p) => p.name === 'Anna'),
    ).toBeDefined();
    expect(insight.summary()).toEqual({ people: 2, pending: 0 });
    // Saved to disk without being asked twice.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(
      JSON.parse(await readFile(join(dir, 'people.json'), 'utf8')).people,
    ).toBeDefined();
    expect(await insight.faceCrop('not a face')).toBeNull();
    expect(
      insight.faceContext(view.people[0]!.samples[0]!.id)?.photoId,
    ).toBeDefined();
  });

  it('works without models: neighbours from time and place alone', async () => {
    const dir = await tempDir();
    const insight = new PhotoInsight({
      cacheDir: dir,
      modelsDir: join(dir, 'no-models'),
      enabled: true,
      readPhoto: async () => null,
      scenes: null,
    });
    cleanups.push(() => insight.dispose());
    await insight.start();
    insight.sync([
      {
        id: ID(1),
        t: T0,
        lat: 59.3,
        lon: 18,
        place: 'Stockholm',
        cc: 'SE',
        utcOffsetSeconds: 0,
      },
      {
        id: ID(2),
        t: T0 + 600_000,
        lat: 59.3,
        lon: 18,
        place: 'Stockholm',
        cc: 'SE',
        utcOffsetSeconds: 0,
      },
    ]);
    await tick();
    const status = insight.status();
    expect(status.available).toBe(false);
    expect(status.reason).toContain('models missing');
    const decorated = insight.decorate();
    expect(decorated.ai).toBe(false);
    expect(decorated.extras[0]?.nb?.[0]?.[0]).toBe(1);
  });

  it('does not analyse when switched off', async () => {
    const dir = await tempDir();
    const insight = new PhotoInsight({
      cacheDir: dir,
      modelsDir: dir,
      enabled: false,
      readPhoto: async () => null,
      scenes: null,
      spawn: () => {
        throw new Error('must not start a worker');
      },
    });
    cleanups.push(() => insight.dispose());
    await insight.start();
    insight.sync([
      {
        id: ID(1),
        t: T0,
        lat: null,
        lon: null,
        place: null,
        cc: null,
        utcOffsetSeconds: 0,
      },
    ]);
    await tick();
    expect(insight.status().available).toBe(false);
    expect(insight.status().reason).toContain('avstängd');
  });
});

describe('fetching the models', () => {
  it('installs only files that match their checksum, and keeps what is already right', async () => {
    const { createHash } = await import('node:crypto');
    const { fetchModels } =
      await import('../src/runtime/photo-intel/fetch-models.js');
    const dir = await tempDir();
    const good = Buffer.from('model bytes');
    const spec = {
      key: 'detector' as const,
      file: 'm.onnx',
      url: 'https://example.invalid/m.onnx',
      sha256: createHash('sha256').update(good).digest('hex'),
      bytes: good.length,
      license: 'MIT',
    };
    let calls = 0;
    const serve =
      (body: Buffer, ok = true) =>
      async () => {
        calls += 1;
        return {
          ok,
          status: ok ? 200 : 404,
          arrayBuffer: async () => new Uint8Array(body).buffer,
        };
      };
    await expect(
      fetchModels(dir, {
        specs: [spec],
        fetcher: serve(Buffer.from('tampered!!!')),
      }),
    ).rejects.toThrow(/checksum/);
    await expect(
      fetchModels(dir, { specs: [spec], fetcher: serve(good, false) }),
    ).rejects.toThrow(/404/);
    expect(
      await fetchModels(dir, { specs: [spec], fetcher: serve(good) }),
    ).toEqual({
      downloaded: ['m.onnx'],
      kept: [],
    });
    expect(await readFile(join(dir, 'm.onnx'))).toEqual(good);
    calls = 0;
    expect(
      await fetchModels(dir, { specs: [spec], fetcher: serve(good) }),
    ).toEqual({
      downloaded: [],
      kept: ['m.onnx'],
    });
    expect(calls).toBe(0);
  });
});
