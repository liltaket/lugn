import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../src/core/clock.js';
import { parseBinaryPlist, plistNumbers } from '../src/runtime/bplist.js';
import { extractDetails } from '../src/runtime/icloud-shared-album.js';
import {
  affinity,
  findHome,
  findTrips,
  loadSceneNames,
  placeScore,
  timeScore,
  windowNeighbours,
  type GroupingInput,
} from '../src/runtime/photo-intel/grouping.js';
import {
  BRAIN_QUIET_MS,
  PhotoInsight,
  withPeople,
  type InsightPhoto,
} from '../src/runtime/photo-intel/insight.js';
import {
  IntelError,
  IntelStore,
  parseBundle,
  type IntelBundle,
  type PhotoIntel,
} from '../src/runtime/photo-intel/intel-store.js';
import {
  PeopleError,
  PeopleStore,
  type Face,
  type FaceRef,
} from '../src/runtime/photo-intel/people.js';

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

describe('which pictures belong together, by time and place', () => {
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

  it('lets shared people decide what time cannot, and strangers stay apart', () => {
    const later = T0 + 40 * 24 * HOUR;
    const friends = affinity(
      input({ id: 'a', t: T0, people: ['p1'] }),
      input({ id: 'b', t: later, people: ['p1'] }),
    );
    const strangers = affinity(
      input({ id: 'a', t: T0, people: ['p1'] }),
      input({ id: 'b', t: later, people: ['p2'] }),
    );
    expect(friends).toBeGreaterThanOrEqual(0.5);
    expect(strangers).toBeLessThan(0.1);
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
    expect(home.lon).toBeCloseTo(18.0, 1);
    expect(findHome(photos.slice(0, 3))).toBeNull();
    // Spread over many places with no centre: no home.
    const scattered = Array.from({ length: 12 }, (_, i) =>
      input({ id: `s${i}`, lat: 40 + i * 2, lon: 10 + i }),
    );
    expect(findHome(scattered)).toBeNull();
  });

  it('counts neighbours across grid lines when it looks for home', () => {
    // Two clusters 10 km apart straddle a quarter-degree line; together they
    // are home, and the far-away cluster with more pictures of its own is not.
    const photos = [
      ...Array.from({ length: 5 }, (_, i) =>
        input({ id: `a${i}`, lat: 59.24, lon: 18.0 + i * 0.0001 }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        input({ id: `b${i}`, lat: 59.26, lon: 18.0 + i * 0.0001 }),
      ),
      ...Array.from({ length: 7 }, (_, i) =>
        input({ id: `c${i}`, lat: 45.0, lon: 9.0 + i * 0.0001 }),
      ),
    ];
    expect(findHome(photos)!.lat).toBeGreaterThan(59);
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
    const { trips, tripOf } = findTrips(photos, findHome(photos), (cc) =>
      cc === 'PL' ? 'Polen' : cc,
    );
    expect(trips).toEqual([
      { title: 'Lesko', from: '2026-09-12', to: '2026-09-14', cc: 'PL' },
    ]);
    expect([...tripOf.keys()].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 9 }, (_, i) => 10 + i),
    );
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
    const { trips } = findTrips(photos, findHome(photos), () => 'Italien');
    expect(trips[0]?.title).toBe('Italien');
  });

  it('compares a picture only with its neighbours in time', () => {
    // One outing in the morning, then 100 pictures elsewhere, then the same
    // place again a year later: the year-later picture is out of reach.
    const photos = [
      input({ id: 'a', t: T0, lat: 59.3, lon: 18 }),
      input({ id: 'b', t: T0 + 10 * 60_000, lat: 59.3, lon: 18 }),
      ...Array.from({ length: 100 }, (_, i) =>
        input({ id: `x${i}`, t: T0 + (i + 1) * HOUR, lat: 41.9, lon: 12.5 }),
      ),
      input({ id: 'late', t: T0 + 365 * 24 * HOUR, lat: 59.3, lon: 18 }),
      input({ id: 'untimed', lat: 59.3, lon: 18 }),
    ];
    const lists = windowNeighbours(photos, {
      wanted: () => true,
      excluded: (i) => i === 5,
      tripOf: new Map(),
      window: 60,
    });
    expect(lists.get(0)?.[0]).toEqual([1, 100]);
    // Pictures nobody may list never appear, and untimed pictures get none.
    for (const list of lists.values())
      expect(list.some(([j]) => j === 5)).toBe(false);
    expect(lists.has(photos.length - 1)).toBe(false);
    expect(lists.get(0)!.some(([j]) => j === photos.length - 2)).toBe(false);
    expect(lists.get(0)!.length).toBeLessThanOrEqual(14);
  });

  it('reads only the scene names from the shared vocabulary', () => {
    const names = loadSceneNames();
    expect(names['beach']).toBe('Stranden');
    expect(names['screen']).toBeUndefined();
    expect(loadSceneNames('/definitely/not/here.json')).toEqual({});
  });
});

// ── People ──

const PHOTO = (n: number): string =>
  `photo${String(n).padStart(19, '0')}`.slice(0, 24);
function face(
  photoNo: number,
  p: string | undefined,
  index = 0,
  extra: Partial<Face> = {},
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
      quality: 80,
      ...(p ? { p } : {}),
      ...extra,
    },
  };
}
async function peopleStore(path?: string): Promise<PeopleStore> {
  const store = new PeopleStore(path ?? join(await tempDir(), 'people.json'));
  await store.load();
  return store;
}
const personOf = (store: PeopleStore, photoNo: number) =>
  store.peopleByPhoto().get(PHOTO(photoNo))?.[0];

describe('who is who', () => {
  it("gives each of Kuffe's new groups a person and leaves singles and unclear faces alone", async () => {
    const store = await peopleStore();
    store.regroup([
      ...[1, 2, 3, 4].map((n) => face(n, 'n1')),
      ...[5, 6, 7].map((n) => face(n, 'n2')),
      face(8, 'n3'),
      face(9, undefined),
    ]);
    const view = store.view();
    expect(view.people.map((p) => p.faces).sort()).toEqual([3, 4]);
    expect(view.unassigned.count).toBe(2);
    expect(personOf(store, 1)).toBe(personOf(store, 4));
    expect(personOf(store, 1)).not.toBe(personOf(store, 5));
    expect(store.peopleByPhoto().has(PHOTO(8))).toBe(false);
    expect(store.faceCount()).toBe(9);
  });

  it('keeps ids stable when Kuffe renumbers its groups, and never merges two groups', async () => {
    const store = await peopleStore();
    store.regroup([
      ...[1, 2, 3].map((n) => face(n, 'n1')),
      ...[4, 5, 6].map((n) => face(n, 'n2')),
    ]);
    const anna = personOf(store, 1)!;
    const erik = personOf(store, 4)!;
    // The next bundle calls them the other way round and finds more pictures.
    store.regroup([
      ...[1, 2, 3, 7].map((n) => face(n, 'n9')),
      ...[4, 5, 6, 8].map((n) => face(n, 'n4')),
      ...[10, 11].map((n) => face(n, 'n5')),
    ]);
    expect(personOf(store, 7)).toBe(anna);
    expect(personOf(store, 8)).toBe(erik);
    const fresh = personOf(store, 10)!;
    expect([anna, erik]).not.toContain(fresh);
    // Two groups that both used to be Anna: only the larger keeps her.
    store.regroup([
      ...[1, 2, 3].map((n) => face(n, 'n1')),
      face(7, 'n2'),
      face(12, 'n2'),
    ]);
    expect(personOf(store, 1)).toBe(anna);
    expect(personOf(store, 7)).not.toBe(anna);
    expect(personOf(store, 7)).toBe(personOf(store, 12));
  });

  it('follows a proposal of a known person, but only one that still exists', async () => {
    const store = await peopleStore();
    store.regroup([1, 2].map((n) => face(n, 'n1')));
    const id = personOf(store, 1)!;
    store.regroup([face(1, id), face(2, id), face(3, id), face(4, 'p999')]);
    expect(personOf(store, 3)).toBe(id);
    expect(store.peopleByPhoto().has(PHOTO(4))).toBe(false);
  });

  it('names a person, confirms the group and remembers it across restarts', async () => {
    const path = join(await tempDir(), 'people.json');
    const store = await peopleStore(path);
    const faces = [1, 2, 3].map((n) => face(n, 'n1'));
    store.regroup(faces);
    const [person] = store.view().people;
    store.rename(person!.id, '  Anna  ');
    expect(store.nameOf(person!.id)).toBe('Anna');
    expect(store.person(person!.id)?.confirmed).toBe(true);
    await store.save();
    expect(
      JSON.parse(await readFile(path, 'utf8')).people[person!.id].name,
    ).toBe('Anna');
    const again = await peopleStore(path);
    // Kuffe has not caught up yet: the decided faces stay with Anna anyway.
    again.regroup([1, 2, 3].map((n) => face(n, 'n7')));
    expect(again.nameOf(person!.id)).toBe('Anna');
    expect(again.view().people[0]).toMatchObject({ id: person!.id, faces: 3 });
    // The file is private to the user.
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('moves a face and never lets a proposal put it back', async () => {
    const store = await peopleStore();
    const faces = [
      ...[1, 2, 3].map((n) => face(n, 'n1')),
      ...[4, 5, 6].map((n) => face(n, 'n2')),
    ];
    store.regroup(faces);
    const one = personOf(store, 1)!;
    const two = personOf(store, 4)!;
    const stray = `${PHOTO(1)}.0`;
    store.moveFace(stray, { person: two });
    // Kuffe still thinks it is the first person: the decision wins.
    store.regroup([face(1, one), ...faces.slice(1)]);
    expect(personOf(store, 1)).toBe(two);
    // "Not a person" removes the face from every list.
    store.moveFace(stray, 'none');
    store.regroup([face(1, one), ...faces.slice(1)]);
    expect(store.view().ignored).toBe(1);
    expect(store.peopleByPhoto().get(PHOTO(1))).toBeUndefined();
    // A face moved away from somebody is never given back to them automatically.
    const other = `${PHOTO(4)}.0`;
    store.moveFace(other, 'new');
    expect(store.view().people.length).toBe(3);
    store.moveFace(other, 'none');
    store.moveFace(`${PHOTO(5)}.0`, { person: one });
    store.regroup([...faces.slice(0, 4), face(5, two), face(6, 'n2')]);
    expect(personOf(store, 5)).toBe(one);
    expect(() => store.moveFace('nope', 'none')).toThrow(PeopleError);
    expect(() => store.moveFace(other, { person: 'p999' })).toThrow(
      PeopleError,
    );
  });

  it('never gives a face automatically to a person it was moved away from', async () => {
    const path = join(await tempDir(), 'people.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        next: 2,
        people: { p1: { id: 'p1', name: null, confirmed: false } },
        faces: {
          [`${PHOTO(1)}.0`]: { auto: 'p1' },
          [`${PHOTO(2)}.0`]: { auto: 'p1' },
          [`${PHOTO(3)}.0`]: { auto: 'p1', not: ['p1'] },
          [`${PHOTO(4)}.0`]: { not: ['p1'] },
        },
      }),
    );
    const store = await peopleStore(path);
    store.regroup([face(1, 'n5'), face(2, 'n5'), face(3, 'n5'), face(4, 'p1')]);
    expect(personOf(store, 1)).toBe('p1');
    expect(personOf(store, 2)).toBe('p1');
    expect(personOf(store, 3)).toBeUndefined();
    expect(personOf(store, 4)).toBeUndefined();
    expect(store.view().unassigned.count).toBe(2);
  });

  it('merges two people and hides a stranger', async () => {
    const store = await peopleStore();
    const faces = [
      ...[1, 2, 3].map((n) => face(n, 'n1')),
      ...[4, 5, 6].map((n) => face(n, 'n2')),
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

  it('drops people nobody named or confirmed once they have no faces', async () => {
    const store = await peopleStore();
    store.regroup([1, 2].map((n) => face(n, 'n1')));
    const id = personOf(store, 1)!;
    store.regroup([]);
    expect(store.person(id)).toBeUndefined();
    expect(store.view().people).toHaveLength(0);
  });

  it('tells Kuffe what the household decided, what it chose before and what not', async () => {
    const store = await peopleStore();
    const faces = [
      ...[1, 2, 3].map((n) => face(n, 'n1')),
      ...[4, 5].map((n) => face(n, 'n2')),
    ];
    store.regroup(faces);
    const one = personOf(store, 1)!;
    const two = personOf(store, 4)!;
    store.rename(one, 'Anna');
    store.moveFace(`${PHOTO(4)}.0`, { person: one });
    store.moveFace(`${PHOTO(5)}.0`, 'none');
    store.setHidden(two, true);
    const labels = store.labels();
    expect(labels.schema).toBe(1);
    expect(labels.people).toEqual(
      expect.arrayContaining([
        { id: one, name: 'Anna', confirmed: true, hidden: false },
      ]),
    );
    expect(labels.decided).toMatchObject({
      [`${PHOTO(1)}.0`]: one,
      [`${PHOTO(4)}.0`]: one,
      [`${PHOTO(5)}.0`]: null,
    });
    expect(labels.previous[`${PHOTO(1)}.0`]).toBe(one);
    expect(labels.not[`${PHOTO(4)}.0`]).toEqual([two]);
    expect(JSON.stringify(labels)).not.toMatch(/box|embedding/);
  });

  it('reads a people file written before the photo brain, decisions intact', async () => {
    const path = join(await tempDir(), 'people.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        next: 4,
        people: {
          p2: { id: 'p2', name: 'Anna', confirmed: true, hidden: false },
          p3: { id: 'p3', name: null, confirmed: false, hidden: true },
        },
        faces: {
          [`${PHOTO(1)}.0`]: { person: 'p2' },
          [`${PHOTO(2)}.0`]: { auto: 'p3' },
          [`${PHOTO(3)}.1`]: { person: null, not: ['p2'] },
          'not a face': { person: 'p2' },
        },
      }),
    );
    const store = await peopleStore(path);
    store.regroup([
      face(1, undefined),
      face(2, 'n1'),
      face(4, 'n1'),
      face(3, 'p2', 1),
    ]);
    expect(personOf(store, 1)).toBe('p2');
    expect(store.view().people.find((p) => p.id === 'p3')?.faces).toBe(2);
    expect(store.view().ignored).toBe(1);
    expect(store.labels().decided).toEqual({
      [`${PHOTO(1)}.0`]: 'p2',
      [`${PHOTO(3)}.1`]: null,
    });
    // New people continue the numbering.
    store.moveFace(`${PHOTO(4)}.0`, 'new');
    expect(store.view().people.some((p) => p.id === 'p4')).toBe(true);
  });

  it('lets a decision follow its face when Kuffe numbers the faces differently', async () => {
    const store = await peopleStore();
    // The old on-device analysis had found two faces; Anna was the second.
    store.regroup([
      face(1, 'n1', 0, { x: 0.1 }),
      face(1, 'n2', 1, { x: 0.6 }),
      face(2, 'n2', 0, { x: 0.6 }),
    ]);
    const anna = personOf(store, 2)!;
    store.rename(anna, 'Anna');
    // Kuffe finds a third face first and so numbers the picture again.
    store.regroup([
      face(1, undefined, 0, { x: 0.35 }),
      face(1, undefined, 1, { x: 0.1 }),
      face(1, undefined, 2, { x: 0.6 }),
      face(2, undefined, 0, { x: 0.6 }),
    ]);
    const view = store.view().people.find((p) => p.id === anna)!;
    expect(view.samples.map((s) => s.id).sort()).toEqual(
      [`${PHOTO(1)}.2`, `${PHOTO(2)}.0`].sort(),
    );
    expect(store.labels().decided[`${PHOTO(1)}.2`]).toBe(anna);
    expect(store.labels().decided[`${PHOTO(1)}.1`]).toBeUndefined();
    // A decision whose face Kuffe does not find is kept but used for nobody.
    store.regroup([
      face(1, undefined, 0, { x: 0.1 }),
      face(1, undefined, 1, { x: 0.35 }),
      face(2, undefined, 0, { x: 0.6 }),
    ]);
    expect(personOf(store, 1)).toBeUndefined();
    expect(store.labels().decided[`${PHOTO(1)}.1`]).toBeUndefined();
    store.regroup([
      face(1, undefined, 0, { x: 0.1 }),
      face(1, undefined, 1, { x: 0.35 }),
      face(1, undefined, 2, { x: 0.6 }),
      face(2, undefined, 0, { x: 0.6 }),
    ]);
    expect(personOf(store, 1)).toBe(anna);
  });

  it('takes the boxes of decisions made before boxes were kept', async () => {
    const path = join(await tempDir(), 'people.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        next: 2,
        people: { p1: { id: 'p1', name: 'Erik', confirmed: true } },
        faces: { [`${PHOTO(1)}.0`]: { person: 'p1' } },
      }),
    );
    const store = await peopleStore(path);
    expect(store.needsBoxes()).toBe(true);
    store.adoptBoxes(new Map([[`${PHOTO(1)}.0`, [0.6, 0.3, 0.2, 0.25]]]));
    expect(store.needsBoxes()).toBe(false);
    store.regroup([
      face(1, undefined, 0, { x: 0.1 }),
      face(1, undefined, 1, { x: 0.6 }),
    ]);
    expect(store.labels().decided).toEqual({ [`${PHOTO(1)}.1`]: 'p1' });
  });
});

// ── Reviewing faces picture by picture ──

/** A picture with `count` faces side by side, none of them proposed. */
const crowd = (photoNo: number, count: number, p?: string): FaceRef[] =>
  Array.from({ length: count }, (_, i) =>
    face(photoNo, p, i, { x: 0.05 + i * 0.12, w: 0.1 }),
  );

describe('reviewing faces picture by picture', () => {
  it('lists the pictures with faces nobody placed, a crowd first and faces left to right', async () => {
    const store = await peopleStore();
    store.regroup([
      ...crowd(1, 2),
      ...crowd(2, 5),
      ...[3, 4, 5].map((n) => face(n, 'n1')),
    ]);
    const review = store.review();
    expect(review.photos.map((p) => p.id)).toEqual([PHOTO(2), PHOTO(1)]);
    const xs = review.photos[0]!.faces.map((f) => f.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(review.photos[0]!.faces.every((f) => f.state === 'open')).toBe(true);
    // A picture whose faces all have somebody is not waiting for anybody.
    expect(review.photos.some((p) => p.id === PHOTO(3))).toBe(false);
    // ...but it can be opened to look at, and shows who each face is.
    const opened = store.photoReview(PHOTO(3));
    expect(opened.photo.faces[0]).toMatchObject({
      state: 'person',
      auto: true,
      moved: false,
    });
    expect(opened.people).toHaveLength(1);
    expect(opened.people[0]?.sample).toBe(`${PHOTO(3)}.0`);
    expect(() => store.photoReview(PHOTO(9))).toThrow(PeopleError);
    expect(() => store.photoReview('nope')).toThrow(PeopleError);
  });

  it('says that none of a picture’s faces matter, keeps decided faces, and takes it back', async () => {
    const path = join(await tempDir(), 'people.json');
    const store = await peopleStore(path);
    const faces = [...crowd(1, 6), ...[2, 3, 4].map((n) => face(n, 'n1'))];
    store.regroup(faces);
    const anna = personOf(store, 2)!;
    store.moveFace(`${PHOTO(1)}.2`, { person: anna });
    store.skipPhoto(PHOTO(1), true);
    // The face somebody placed stays; the other five do not count.
    const view = store.view();
    expect(view.ignored).toBe(5);
    expect(view.unassigned.count).toBe(0);
    expect(view.skippedPhotos).toEqual([PHOTO(1)]);
    expect(store.peopleByPhoto().get(PHOTO(1))).toEqual([anna]);
    expect(store.review().photos).toEqual([]);
    expect(store.photoReview(PHOTO(1)).photo).toMatchObject({ skipped: true });
    // Kuffe is told the five are no example of anybody.
    const decided = store.labels().decided;
    expect(decided[`${PHOTO(1)}.0`]).toBeNull();
    expect(decided[`${PHOTO(1)}.2`]).toBe(anna);
    // It survives Kuffe sending the same faces again, and a restart.
    store.regroup(faces);
    await store.save();
    const again = await peopleStore(path);
    again.regroup(faces);
    expect(again.view().ignored).toBe(5);
    expect(again.review().photos).toEqual([]);
    // Taking it back reopens exactly those faces.
    again.skipPhoto(PHOTO(1), false);
    expect(again.view().ignored).toBe(0);
    expect(
      again.review().photos[0]?.faces.filter((f) => f.state === 'open'),
    ).toHaveLength(5);
    expect(() => again.skipPhoto(PHOTO(9), true)).toThrow(PeopleError);
  });

  it('moves a box onto the real face and trusts nobody’s idea of the old one', async () => {
    const path = join(await tempDir(), 'people.json');
    const store = await peopleStore(path);
    const faces = [...[1, 2, 3].map((n) => face(n, 'n1')), ...crowd(4, 2)];
    store.regroup(faces);
    const anna = personOf(store, 1)!;
    const arm = `${PHOTO(1)}.0`;
    // The detector put the box on an arm and called it Anna.
    store.setFaceBox(arm, [0.7, 0.1, 0.15, 0.2]);
    expect(personOf(store, 1)).toBeUndefined();
    expect(store.photoReview(PHOTO(1)).photo.faces[0]).toMatchObject({
      state: 'open',
      moved: true,
      x: 0.7,
      y: 0.1,
      w: 0.15,
      h: 0.2,
    });
    expect(store.faceBox(arm)).toEqual({ x: 0.7, y: 0.1, w: 0.15, h: 0.2 });
    expect(store.review().photos.map((p) => p.id)).toContain(PHOTO(1));
    // Kuffe proposes Anna again for the arm; the moved box ignores that.
    store.regroup(faces);
    expect(personOf(store, 1)).toBeUndefined();
    // The household says who is there; Kuffe is not told the arm is Anna.
    store.moveFace(arm, { person: anna });
    expect(personOf(store, 1)).toBe(anna);
    expect(store.labels().decided[arm]).toBeNull();
    expect(
      store.view().people.find((p) => p.id === anna)?.samples[0],
    ).toMatchObject({ x: 0.7 });
    // Boxes are kept inside the picture, and a sliver is not a box.
    store.setFaceBox(arm, [0.9, -1, 0.5, 2]);
    expect(store.faceBox(arm)).toEqual({ x: 0.9, y: 0, w: 0.1, h: 1 });
    expect(() => store.setFaceBox(arm, [0.5, 0.5, 0.001, 0.2])).toThrow(
      PeopleError,
    );
    expect(() => store.setFaceBox(arm, [0.5, 0.5, Number.NaN, 0.2])).toThrow(
      PeopleError,
    );
    expect(() => store.setFaceBox(arm, [0.5, 0.5, 0.2])).toThrow(PeopleError);
    expect(() => store.setFaceBox('nope', null)).toThrow(PeopleError);
    // It is remembered across a restart, and giving the box back restores the detector's.
    store.setFaceBox(arm, [0.7, 0.1, 0.15, 0.2]);
    await store.save();
    const again = await peopleStore(path);
    again.regroup(faces);
    expect(again.faceBox(arm)).toEqual({ x: 0.7, y: 0.1, w: 0.15, h: 0.2 });
    expect(personOf(again, 1)).toBe(anna);
    again.setFaceBox(arm, null);
    expect(again.faceBox(arm)).toEqual({ x: 0.4, y: 0.3, w: 0.2, h: 0.25 });
    expect(again.labels().decided[arm]).toBe(anna);
  });

  it('puts a moved face with a person without an explicit decision back to the detector’s proposal when the box is given back', async () => {
    const store = await peopleStore();
    const faces = [1, 2, 3].map((n) => face(n, 'n1'));
    store.regroup(faces);
    const anna = personOf(store, 1)!;
    store.setFaceBox(`${PHOTO(1)}.0`, [0.1, 0.1, 0.2, 0.2]);
    expect(personOf(store, 1)).toBeUndefined();
    store.setFaceBox(`${PHOTO(1)}.0`, null);
    expect(personOf(store, 1)).toBe(anna);
  });

  it('files a face under a name, and takes a decision back', async () => {
    const store = await peopleStore();
    const faces = [...[1, 2, 3].map((n) => face(n, 'n1')), ...crowd(4, 3)];
    store.regroup(faces);
    const first = personOf(store, 1)!;
    store.rename(first, 'Anna');
    // An existing name is the same person, whatever the case.
    store.moveFace(`${PHOTO(4)}.0`, { named: ' anna ' });
    expect(personOf(store, 4)).toBe(first);
    // A new name is a new, confirmed person.
    store.moveFace(`${PHOTO(4)}.1`, { named: 'Erik' });
    const erik = store.view().people.find((p) => p.name === 'Erik')!;
    expect(erik).toMatchObject({ confirmed: true, faces: 1 });
    // Nothing is filed under somebody who is hidden, just because of a name.
    store.setHidden(erik.id, true);
    store.moveFace(`${PHOTO(4)}.1`, { named: 'Erik' });
    expect(
      store.view().people.filter((p) => p.name === 'Erik' && !p.hidden),
    ).toHaveLength(1);
    const filed = store.photoReview(PHOTO(4)).photo.faces[1]!.person;
    expect(filed).not.toBe(erik.id);
    expect(filed).not.toBe(first);
    expect(() => store.moveFace(`${PHOTO(4)}.2`, { named: '  ' })).toThrow(
      PeopleError,
    );
    // "Open" says nobody looked: the face is as it was before the decision.
    store.moveFace(`${PHOTO(4)}.1`, 'open');
    expect(store.review().photos[0]?.faces[1]).toMatchObject({ state: 'open' });
    store.moveFace(`${PHOTO(1)}.0`, 'none');
    expect(store.view().ignored).toBe(1);
    store.moveFace(`${PHOTO(1)}.0`, 'open');
    expect(store.view().ignored).toBe(0);
    expect(personOf(store, 1)).toBe(first);
  });

  it('keeps a moved box with its face when Kuffe numbers the faces differently', async () => {
    const store = await peopleStore();
    store.regroup([
      face(1, undefined, 0, { x: 0.1 }),
      face(1, undefined, 1, { x: 0.6 }),
    ]);
    store.moveFace(`${PHOTO(1)}.1`, 'new');
    store.setFaceBox(`${PHOTO(1)}.1`, [0.62, 0.32, 0.2, 0.25]);
    // The detector now lists the right-hand face first.
    store.regroup([
      face(1, undefined, 0, { x: 0.6 }),
      face(1, undefined, 1, { x: 0.1 }),
    ]);
    expect(store.faceBox(`${PHOTO(1)}.0`)).toEqual({
      x: 0.62,
      y: 0.32,
      w: 0.2,
      h: 0.25,
    });
    expect(store.faceBox(`${PHOTO(1)}.1`)).toEqual({
      x: 0.1,
      y: 0.3,
      w: 0.2,
      h: 0.25,
    });
  });
});

// ── The photo brain's bundle ──

const ID = (n: number): string => `img${String(n).padStart(21, '0')}`;
const DAY = 24 * HOUR;
function entry(over: Partial<PhotoIntel> = {}): PhotoIntel {
  return {
    v: 'v1',
    scene: [],
    q: { sharp: 80, dark: 3, junk: null },
    faces: [],
    cand: [],
    du: [],
    ...over,
  };
}
function bundle(
  photos: Record<string, Partial<PhotoIntel>>,
  extra: Partial<IntelBundle> = {},
): IntelBundle {
  return {
    schema: 1,
    generatedAt: 1_763_900_000_000,
    brain: {
      version: '0.1.0',
      models: { embed: 'e', face: 'f', detector: 'd' },
      faceDim: 512,
    },
    home: null,
    trips: [],
    events: [],
    photos: Object.fromEntries(
      Object.entries(photos).map(([id, value]) => [id, entry(value)]),
    ),
    ...extra,
  };
}
const brainFace = (p?: string, x = 0.4) => ({
  x,
  y: 0.3,
  w: 0.2,
  h: 0.25,
  score: 0.95,
  front: 0.9,
  q: 70,
  ...(p ? { p } : {}),
});

describe('the intel bundle', () => {
  it('accepts the contract example and keeps what it says', () => {
    const parsed = parseBundle({
      ...bundle({
        [ID(1)]: {
          scene: [
            ['beach', 0.71],
            ['sea', 0.12],
          ],
          fav: 1,
          cap: 'Midsommar',
          faces: [brainFace('p3'), brainFace('n7')],
          trip: 0,
          event: 'e12',
          cand: [[ID(2), 74, 90, 60, 71]],
          du: [ID(2)],
        },
      }),
      home: { lat: 59.2, lon: 18.0 },
      trips: [
        { title: 'Lesko', from: '2026-09-11', to: '2026-09-14', cc: 'PL' },
      ],
      events: [{ id: 'e12', from: 1, to: 2, count: 14 }],
      somethingNew: true,
    });
    expect(parsed.photos[ID(1)]?.cand[0]).toEqual([ID(2), 74, 90, 60, 71]);
    expect(parsed.home).toEqual({ lat: 59.2, lon: 18.0 });
    // Fields this side does not know are dropped, not kept.
    expect('somethingNew' in parsed).toBe(false);
  });

  it('refuses what does not fit, with a short list of why', () => {
    const bad =
      (photos: Record<string, unknown>, extra = {}) =>
      () =>
        parseBundle({ ...bundle({}), photos, ...extra });
    expect(bad({}, { schema: 2 })).toThrow(IntelError);
    expect(bad({ 'too-short': entry() })).toThrow(IntelError);
    expect(
      bad({ [ID(1)]: { ...entry(), cand: [['../x', 1, 1, 1, 1]] } }),
    ).toThrow(IntelError);
    expect(
      bad({ [ID(1)]: { ...entry(), faces: Array(65).fill(brainFace()) } }),
    ).toThrow(IntelError);
    expect(
      bad({
        [ID(1)]: {
          ...entry(),
          cand: Array(65).fill([ID(2), 50, 50, 50, 50]),
        },
      }),
    ).toThrow(IntelError);
    expect(bad({ [ID(1)]: { ...entry(), v: 'x'.repeat(300) } })).toThrow(
      IntelError,
    );
    expect(bad({ [ID(1)]: { ...entry(), cap: 'x'.repeat(501) } })).toThrow(
      IntelError,
    );
    expect(
      bad({ [ID(1)]: { ...entry(), faces: [{ ...brainFace(), x: 2 }] } }),
    ).toThrow(IntelError);
    expect(
      bad({ [ID(1)]: { ...entry(), faces: [{ ...brainFace(), p: 'x1' }] } }),
    ).toThrow(IntelError);
    expect(bad({ [ID(1)]: { ...entry(), q: { sharp: 'x' } } })).toThrow(
      IntelError,
    );
    try {
      bad({ [ID(1)]: { ...entry(), cand: 'nope' } })();
    } catch (error) {
      expect((error as IntelError).code).toBe('invalid_bundle');
      expect((error as IntelError).issues[0]?.path).toContain('cand');
    }
    // More than 20000 pictures fails before anything else is looked at.
    const many: Record<string, null> = {};
    for (let i = 0; i < 20_001; i += 1) many[`k${i}`] = null;
    try {
      bad(many)();
      expect.unreachable();
    } catch (error) {
      expect((error as IntelError).code).toBe('too_many_photos');
    }
  });

  it('is kept across a restart, privately, and a damaged file is shrugged off', async () => {
    const dir = await tempDir();
    const path = join(dir, 'intel.json');
    const warnings: string[] = [];
    const store = new IntelStore(path, (m) => warnings.push(m));
    await store.load();
    expect(store.receivedAt()).toBeNull();
    const result = await store.put(
      bundle({ [ID(1)]: {}, [ID(2)]: {}, [ID(9)]: {} }),
      new Set([ID(1), ID(2), ID(3)]),
      1234,
    );
    expect(result).toEqual({ accepted: 2, unknown: 1 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const again = new IntelStore(path);
    await again.load();
    expect(again.receivedAt()).toBe(1234);
    expect(again.has(ID(9))).toBe(true);
    // A refused bundle leaves the last good one in place.
    await expect(
      again.put({ schema: 1 }, new Set(), 5678),
    ).rejects.toBeInstanceOf(IntelError);
    expect(again.receivedAt()).toBe(1234);
    await writeFile(path, '{"version":1,"receivedAt":1,"bundle":{"nope":');
    await store.load();
    expect(store.receivedAt()).toBeNull();
    expect(store.has(ID(1))).toBe(false);
    expect(warnings.some((w) => w.includes('ignored'))).toBe(true);
  });
});

// ── Everything together ──

function insightPhoto(
  n: number,
  over: Partial<InsightPhoto> = {},
): InsightPhoto {
  return {
    id: ID(n),
    t: T0 + n * 60_000,
    lat: 59.3,
    lon: 18.0,
    place: 'Stockholm',
    cc: 'SE',
    utcOffsetSeconds: 7200,
    ...over,
  };
}
async function makeInsight(
  over: Partial<ConstructorParameters<typeof PhotoInsight>[0]> = {},
) {
  const dir = await tempDir();
  const clock = new FakeClock(1_763_900_000_000);
  const insight = new PhotoInsight({
    cacheDir: dir,
    enabled: true,
    readPhoto: async () => null,
    scenes: { beach: 'Stranden' },
    saveDelayMs: 5,
    clock,
    ...over,
  });
  cleanups.push(() => insight.dispose());
  await insight.start();
  return { dir, clock, insight };
}

describe('the insight service', () => {
  it('re-ranks the brain’s candidates with the people decided here', () => {
    expect(withPeople(0.5, [], ['p1'])).toBe(0.5);
    expect(withPeople(0.5, ['p1'], ['p2'])).toBeCloseTo(0.4);
    expect(withPeople(0.5, ['p1', 'p2'], ['p1'])).toBeCloseTo(
      0.5 + 0.08 + 0.12 * (1 / 2),
    );
    expect(withPeople(0.95, ['p1'], ['p1'])).toBe(1);
  });

  it('builds the listing a Hub reads from the bundle', async () => {
    const { insight } = await makeInsight();
    const photos = [1, 2, 3, 4, 5, 6].map((n) => insightPhoto(n));
    insight.sync(photos);
    let notified = 0;
    insight.subscribe(() => (notified += 1));
    const revision = insight.revision();
    const result = await insight.putIntel(
      bundle(
        {
          [ID(1)]: {
            scene: [['beach', 0.71]],
            faces: [brainFace('n1')],
            trip: 1,
            cand: [
              [ID(2), 60, 90, 90, -1],
              [ID(3), 60, 90, 90, -1],
              [ID(4), 50, 90, 90, -1],
              [ID(5), 90, 90, 90, -1],
              [ID(6), 25, 90, 90, -1],
              [ID(99), 95, 90, 90, -1],
            ],
            du: [ID(3), ID(99)],
          },
          [ID(2)]: { scene: [['beach', 0.3]], faces: [brainFace('n1')] },
          [ID(3)]: { faces: [brainFace('n2')], fav: 1, cap: 'Från Kuffe' },
          [ID(4)]: { faces: [brainFace('n2')] },
          [ID(5)]: { q: { sharp: 80, dark: 3, junk: 'screenshot' } },
          [ID(99)]: {},
        },
        {
          trips: [
            {
              title: 'Oanvänd',
              from: '2026-01-01',
              to: '2026-01-02',
              cc: null,
            },
            { title: 'Lesko', from: '2026-09-11', to: '2026-09-14', cc: 'PL' },
          ],
        },
      ),
    );
    expect(result).toEqual({ accepted: 5, unknown: 1 });
    expect(notified).toBe(1);
    expect(insight.revision()).not.toBe(revision);
    const listing = insight.decorate();
    expect(listing.ai).toBe(true);
    expect(listing.scenes).toEqual({ beach: 'Stranden' });
    expect(listing.people).toHaveLength(2);
    // Only the trips pictures point at, numbered again from 0.
    expect(listing.trips).toEqual([
      { title: 'Lesko', from: '2026-09-11', to: '2026-09-14', cc: 'PL' },
    ]);
    const first = listing.extras[0]!;
    expect(first).toMatchObject({ sc: 'beach', sp: 71, tr: 0 });
    expect(first.pp).toEqual(listing.extras[1]!.pp);
    // Same person: raised; known strangers: lowered; below 0.3: dropped;
    // junk and pictures not in the library: never listed.
    expect(first.nb).toEqual([
      [1, Math.round((0.6 + 0.08 + 0.12) * 100)],
      [2, 48],
      [3, 40],
    ]);
    expect(first.du).toEqual([2]);
    // A scene the brain is not sure of is not named.
    expect(listing.extras[1]!.sc).toBeUndefined();
    expect(listing.extras[2]).toMatchObject({ fav: 1, cap: 'Från Kuffe' });
    expect(listing.extras[4]).toEqual({ skip: 1 });
    // The panel's numbers.
    expect(insight.status()).toMatchObject({
      available: true,
      brain: { analysed: 5, photos: 6, faces: 4 },
    });
    expect(insight.brainState()).toMatchObject({ pictures: 6, analysed: 5 });
    expect(insight.summary()).toEqual({ people: 2, pending: 1 });
  });

  it('lets the household decide, and a decision changes the neighbours at once', async () => {
    const { insight, dir } = await makeInsight();
    insight.sync([1, 2].map((n) => insightPhoto(n)));
    await insight.putIntel(
      bundle({
        [ID(1)]: { faces: [brainFace('n1')], cand: [[ID(2), 50, -1, -1, -1]] },
        [ID(2)]: { faces: [brainFace('n2')] },
      }),
    );
    const known = () => insight.decorate().extras[0]!.nb?.[0]?.[1];
    // Two different people (each a group of one: nobody yet).
    expect(known()).toBe(50);
    insight.moveFace(`${ID(1)}.0`, 'new');
    const anna = insight.peopleView().people[0]!.id;
    insight.moveFace(`${ID(2)}.0`, { person: anna });
    expect(known()).toBe(Math.round((0.5 + 0.08 + 0.12) * 100));
    insight.rename(anna, 'Anna');
    expect(insight.decorate().people).toEqual([{ id: anna, name: 'Anna' }]);
    expect(insight.labels().decided).toEqual({
      [`${ID(1)}.0`]: anna,
      [`${ID(2)}.0`]: anna,
    });
    // Saved without being asked twice.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(
      JSON.parse(await readFile(join(dir, 'people.json'), 'utf8')).people[anna]
        .name,
    ).toBe('Anna');
    expect(await insight.faceCrop('not a face')).toBeNull();
    expect(await insight.faceCrop(`${ID(1)}.0`)).toBeNull(); // no picture bytes
    expect(insight.faceContext(`${ID(1)}.0`)).toEqual({ photoId: ID(1) });
  });

  it('cuts a face crop from the cached picture with the box', async () => {
    const sharp = (await import('sharp')).default;
    const picture = await sharp({
      create: { width: 400, height: 300, channels: 3, background: '#808080' },
    })
      .jpeg()
      .toBuffer();
    const { insight } = await makeInsight({
      readPhoto: async (id) => (id === ID(1) ? picture : null),
    });
    insight.sync([insightPhoto(1)]);
    await insight.putIntel(bundle({ [ID(1)]: { faces: [brainFace()] } }));
    const crop = await insight.faceCrop(`${ID(1)}.0`);
    const meta = await sharp(crop!).metadata();
    expect([meta.width, meta.height]).toEqual([112, 112]);
  });

  it('groups pictures Kuffe has not seen by time and place alone', async () => {
    const { insight } = await makeInsight();
    insight.sync([
      insightPhoto(1),
      insightPhoto(2),
      insightPhoto(3, { t: T0 + 200 * DAY, lat: 41.9, lon: 12.5 }),
    ]);
    const before = insight.decorate();
    expect(before.ai).toBe(false);
    expect(before.extras[0]?.nb?.[0]?.[0]).toBe(1);
    expect(before.extras[2]?.nb).toBeUndefined();
    expect(insight.status().brain.intelAt).toBeNull();
    expect(insight.summary().pending).toBe(0);
    // Kuffe has seen one of them: that one follows the bundle, the rest the clock.
    await insight.putIntel(bundle({ [ID(1)]: { cand: [] } }));
    const after = insight.decorate();
    expect(after.ai).toBe(true);
    expect(after.extras[0]?.nb).toBeUndefined();
    expect(after.extras[1]?.nb?.[0]?.[0]).toBe(0);
  });

  it('finds trips among the pictures Kuffe has not seen', async () => {
    const { insight } = await makeInsight({
      home: { lat: 59.3, lon: 18.0 },
      countryName: () => 'Polen',
    });
    const photos: InsightPhoto[] = [];
    for (let day = 0; day < 3; day += 1)
      for (let i = 0; i < 3; i += 1)
        photos.push(
          insightPhoto(day * 3 + i + 1, {
            t: T0 + day * DAY + i * HOUR,
            lat: 49.4,
            lon: 22.3,
            place: 'Lesko',
            cc: 'PL',
          }),
        );
    insight.sync(photos);
    const listing = insight.decorate();
    expect(listing.trips).toEqual([
      { title: 'Lesko', from: '2026-09-12', to: '2026-09-14', cc: 'PL' },
    ]);
    expect(listing.extras.every((extra) => extra.tr === 0)).toBe(true);
  });

  it('ignores the bundle and keeps it from Kuffe when switched off', async () => {
    const { insight } = await makeInsight({ enabled: false });
    insight.sync([insightPhoto(1), insightPhoto(2)]);
    await insight.putIntel(
      bundle({
        [ID(1)]: { scene: [['beach', 0.9]], faces: [brainFace('n1')] },
      }),
    );
    const listing = insight.decorate();
    expect(listing.ai).toBe(false);
    expect(listing.extras[0]?.sc).toBeUndefined();
    expect(insight.status()).toMatchObject({ available: false });
    expect(insight.status().reason).toContain('avstängd');
    expect(insight.peopleView().unassigned.count).toBe(0);
  });

  it('keeps the people as they are until Kuffe has said anything', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, 'people.json'),
      JSON.stringify({
        version: 1,
        next: 3,
        people: { p2: { id: 'p2', name: null, confirmed: false } },
        faces: { [`${ID(1)}.0`]: { auto: 'p2' } },
      }),
    );
    const { insight } = await makeInsight({ cacheDir: dir });
    insight.sync([insightPhoto(1)]);
    expect(insight.labels().people.map((p) => p.id)).toEqual(['p2']);
    expect(insight.labels().previous).toEqual({ [`${ID(1)}.0`]: 'p2' });
  });

  it("lets decisions made on this machine follow their faces into Kuffe's numbering", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, 'people.json'),
      JSON.stringify({
        version: 1,
        next: 2,
        people: { p1: { id: 'p1', name: 'Erik', confirmed: true } },
        faces: { [`${ID(1)}.0`]: { person: 'p1' } },
      }),
    );
    // What the old on-device analysis kept: boxes (and vectors, never read).
    await writeFile(
      join(dir, 'analysis.json'),
      JSON.stringify({
        version: 1,
        model: 'old',
        photos: {
          [ID(1)]: {
            e: 'AAAA',
            f: [
              { x: 0.6, y: 0.3, w: 0.2, h: 0.25, score: 1, front: 1, e: 'AA' },
            ],
            at: 1,
          },
        },
      }),
    );
    const { insight } = await makeInsight({ cacheDir: dir });
    insight.sync([insightPhoto(1)]);
    await insight.putIntel(
      bundle({
        [ID(1)]: {
          faces: [brainFace(undefined, 0.1), brainFace(undefined, 0.6)],
        },
      }),
    );
    expect(insight.labels().decided).toEqual({ [`${ID(1)}.1`]: 'p1' });
    expect(insight.decorate().extras[0]?.pp).toEqual(['p1']);
  });

  it('tells when Kuffe has gone quiet', async () => {
    const { insight, clock } = await makeInsight();
    insight.sync([insightPhoto(1), insightPhoto(2)]);
    await insight.putIntel(bundle({ [ID(1)]: {} }));
    expect(insight.status().brain.intelAt).toBe(clock.now());
    expect(insight.summary().pending).toBe(1);
    clock.advanceBy(BRAIN_QUIET_MS + 1);
    expect(insight.summary().pending).toBe(0);
  });

  it('decorates five thousand pictures quickly, with or without the bundle', async () => {
    const { insight } = await makeInsight();
    const n = 5000;
    const photos = Array.from({ length: n }, (_, i) =>
      insightPhoto(i + 1, {
        t: T0 - i * 37 * 60_000,
        lat: 59.3 + (i % 50) * 0.01,
        lon: 18.0 + (i % 7) * 0.01,
      }),
    );
    insight.sync(photos);
    const t0 = performance.now();
    const fallback = insight.decorate();
    const fallbackMs = performance.now() - t0;
    expect(fallback.extras).toHaveLength(n);
    expect(fallback.extras.filter((e) => e.nb).length).toBeGreaterThan(n * 0.9);
    // Every picture analysed: 48 candidates and a face each.
    const entries: Record<string, Partial<PhotoIntel>> = {};
    for (let i = 0; i < n; i += 1)
      entries[ID(i + 1)] = {
        scene: [['beach', 0.5]],
        faces: [brainFace(`n${i % 40}`)],
        cand: Array.from({ length: 48 }, (_, k) => [
          ID(((i + k * 13 + 1) % n) + 1),
          30 + ((i + k) % 70),
          -1,
          -1,
          -1,
        ]) as PhotoIntel['cand'],
        du: [ID(((i + 1) % n) + 1)],
      };
    await insight.putIntel(bundle(entries));
    const t1 = performance.now();
    const full = insight.decorate();
    const fullMs = performance.now() - t1;
    expect(full.ai).toBe(true);
    expect(full.extras.every((e) => (e.nb?.length ?? 0) <= 14)).toBe(true);
    console.info(
      `decorate 5000 pictures: fallback ${fallbackMs.toFixed(0)} ms, bundle ${fullMs.toFixed(0)} ms`,
    );
    // Generous bounds for a busy test machine; the target is well under 300 ms.
    expect(fallbackMs).toBeLessThan(1500);
    expect(fullMs).toBeLessThan(1500);
    // The listing is cached until something changes.
    const t2 = performance.now();
    insight.decorate();
    expect(performance.now() - t2).toBeLessThan(5);
  });
});
