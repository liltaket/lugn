import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AlbumPhotoDetails } from '../icloud-shared-album.js';

/**
 * The cheap side of "which pictures belong together": time and place turned
 * into 0–1 scores, home and trips. The photo brain on Kuffe does the pairwise
 * work with everything it knows; these helpers group the pictures it has not
 * looked at yet, and only ever compare a picture with its neighbours in time.
 */
export type GroupingInput = {
  id: string;
  t: number | null;
  lat: number | null;
  lon: number | null;
  place: string | null;
  cc: string | null;
  utcOffsetSeconds?: number;
  details?: Partial<AlbumPhotoDetails> | undefined;
  /** People in the picture (stable ids). */
  people: string[];
};

export type Neighbour = [index: number, score: number];
export type PhotoExtras = {
  /** Best scene key, and how sure (0–100); only when sure enough to use. */
  sc?: string;
  sp?: number;
  pp?: string[];
  /** Index into the listing's trips. */
  tr?: number;
  nb?: Neighbour[];
  /** Near-duplicates (bursts): never shown together. */
  du?: number[];
  fav?: 1;
  /** A caption somebody wrote in Photos. */
  cap?: string;
  /**
   * A screenshot, a document, or too blurred or dark to show: never a group's
   * seed, and no other picture lists it as a neighbour.
   */
  skip?: 1;
};
export type Trip = {
  title: string;
  /** Local dates `YYYY-MM-DD`, first and last day. */
  from: string;
  to: string;
  cc: string | null;
};

export const NEIGHBOURS = 14;
export const MIN_SCORE = 0.3;
const SESSION_GAP_MS = 6 * 60 * 60 * 1000;
const TRIP_GAP_MS = 40 * 60 * 60 * 1000;
const AWAY_KM = 80;

export function distanceKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const dy = (a.lat - b.lat) * 111.32;
  const dx = (a.lon - b.lon) * 111.32 * Math.cos((a.lat * Math.PI) / 180);
  return Math.sqrt(dx * dx + dy * dy);
}

const clamp01 = (value: number): number =>
  value < 0 ? 0 : value > 1 ? 1 : value;

type Knots = ReadonlyArray<readonly [x: number, score: number, log: number]>;
const knots = (points: ReadonlyArray<readonly [number, number]>): Knots =>
  points.map(([x, score]) => [x, score, Math.log(x)] as const);
/** Piecewise-linear in log scale between the knots (computed once). */
function logLinear(value: number, table: Knots): number {
  if (value <= table[0]![0]) return table[0]![1];
  for (let i = 1; i < table.length; i += 1) {
    const [x2, s2, l2] = table[i]!;
    if (value <= x2) {
      const [, s1, l1] = table[i - 1]!;
      return s1 + ((s2 - s1) * (Math.log(value) - l1)) / (l2 - l1);
    }
  }
  return 0;
}
const TIME_KNOTS = knots([
  [0.5, 1],
  [3, 0.85],
  [8, 0.6],
  [36, 0.35],
  [24 * 7, 0.15],
  [24 * 30, 0],
]);
const PLACE_KNOTS = knots([
  [0.3, 1],
  [3, 0.85],
  [15, 0.6],
  [60, 0.3],
  [200, 0.08],
]);

/** Piecewise-linear in log time: 1 within half an hour, 0 after a month. */
export const timeScore = (deltaMs: number): number =>
  logLinear(deltaMs / 3_600_000, TIME_KNOTS);

/** 1 within 300 m, ~0 at 200 km, 0 beyond. */
export const placeScore = (km: number): number => logLinear(km, PLACE_KNOTS);

const W_TIME = 0.3;
const W_PLACE = 0.2;
const W_PEOPLE = 0.2;

/** 0–1: how well two pictures belong in one group, from time, place and people. Symmetric. */
export function affinity(a: GroupingInput, b: GroupingInput): number {
  let sum = 0;
  let weight = 0;
  let delta: number | null = null;
  let km: number | null = null;
  if (a.t !== null && b.t !== null) {
    delta = Math.abs(a.t - b.t);
    sum += W_TIME * timeScore(delta);
    weight += W_TIME;
  }
  if (a.lat !== null && a.lon !== null && b.lat !== null && b.lon !== null) {
    km = distanceKm(
      a as { lat: number; lon: number },
      b as { lat: number; lon: number },
    );
    sum += W_PLACE * placeScore(km);
    weight += W_PLACE;
  }
  let shared = 0;
  const peopleKnown = a.people.length > 0 && b.people.length > 0;
  if (peopleKnown) {
    const set = new Set(a.people);
    shared = b.people.filter((p) => set.has(p)).length;
    const union = new Set([...a.people, ...b.people]).size;
    const score = shared > 0 ? 0.6 + 0.4 * (shared / union) : 0;
    sum += W_PEOPLE * score;
    weight += W_PEOPLE;
  }
  if (weight === 0) return 0;
  let score = sum / weight;
  // Far apart on every axis that is known: not a group, whatever else says.
  if (delta !== null && delta > 14 * 86_400_000 && shared === 0) score *= 0.5;
  if (km !== null && km > 150 && (delta === null || delta > 6 * 3_600_000))
    score *= 0.4;
  if (peopleKnown) score = shared > 0 ? Math.min(1, score + 0.1) : score * 0.75;
  return clamp01(score);
}

// ── Scenes ──

/**
 * Scene key → the name a Hub shows (`data/photo-scenes.json`, the vocabulary
 * the photo brain classifies with). Only the names are read here.
 */
export function loadSceneNames(path?: string): Record<string, string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = path
    ? [path]
    : [
        resolve(here, '../../../data/photo-scenes.json'),
        resolve(process.cwd(), 'data/photo-scenes.json'),
      ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as {
        scenes?: Array<{ key?: unknown; sv?: unknown }>;
      };
      const names: Record<string, string> = {};
      for (const scene of parsed.scenes ?? [])
        if (typeof scene.key === 'string' && typeof scene.sv === 'string')
          names[scene.key] = scene.sv;
      return names;
    } catch {
      /* try the next */
    }
  }
  return {};
}

// ── Trips ──

const localDay = (input: GroupingInput): string | null => {
  if (input.t === null) return null;
  const shifted = new Date(input.t + (input.utcOffsetSeconds ?? 0) * 1000);
  return Number.isNaN(shifted.getTime())
    ? null
    : shifted.toISOString().slice(0, 10);
};

/**
 * The most photographed place; where the pictures are usually taken. Pictures
 * are pooled per ~1 km cell and a cell only counts the cells in the grid
 * squares around it, so thousands of pictures cost about as much as the
 * number of distinct places.
 */
export function findHome(
  photos: GroupingInput[],
): { lat: number; lon: number } | null {
  const cells = new Map<string, { lat: number; lon: number; count: number }>();
  let located = 0;
  for (const p of photos) {
    if (p.lat === null || p.lon === null) continue;
    located += 1;
    const key = `${Math.round(p.lat * 100)}:${Math.round(p.lon * 100)}`;
    const cell = cells.get(key);
    if (cell) cell.count += 1;
    else cells.set(key, { lat: p.lat, lon: p.lon, count: 1 });
  }
  if (located < 5) return null;
  // Squares of a quarter degree: at least 25 km north to south.
  const SQUARE = 0.25;
  const squares = new Map<
    string,
    Array<{ lat: number; lon: number; count: number }>
  >();
  const squareOf = (lat: number, lon: number): [number, number] => [
    Math.floor(lat / SQUARE),
    Math.floor(lon / SQUARE),
  ];
  for (const cell of cells.values()) {
    const [y, x] = squareOf(cell.lat, cell.lon);
    const list = squares.get(`${y}:${x}`) ?? [];
    list.push(cell);
    squares.set(`${y}:${x}`, list);
  }
  let best: { lat: number; lon: number; count: number } | null = null;
  for (const centre of cells.values()) {
    const [y, x] = squareOf(centre.lat, centre.lon);
    const kmPerSquare =
      111.32 * SQUARE * Math.max(0.05, Math.cos((centre.lat * Math.PI) / 180));
    const reach = Math.min(720, Math.ceil(25 / kmPerSquare));
    let count = 0;
    for (let dy = -1; dy <= 1; dy += 1)
      for (let dx = -reach; dx <= reach; dx += 1)
        for (const other of squares.get(`${y + dy}:${x + dx}`) ?? [])
          if (distanceKm(centre, other) <= 25) count += other.count;
    if (!best || count > best.count)
      best = { lat: centre.lat, lon: centre.lon, count };
  }
  // Home needs to be where a good share of the pictures were taken.
  return best && best.count >= located * 0.25
    ? { lat: best.lat, lon: best.lon }
    : null;
}

/** The place name that most pictures carry, with its share. */
function dominant(
  values: Array<string | null>,
): { value: string; share: number } | null {
  const counts = new Map<string, number>();
  for (const value of values)
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: [string, number] | null = null;
  for (const entry of counts) if (!best || entry[1] > best[1]) best = entry;
  return best ? { value: best[0], share: best[1] / values.length } : null;
}

export function findTrips(
  photos: GroupingInput[],
  home: { lat: number; lon: number } | null,
  countryName: (cc: string) => string,
): { trips: Trip[]; tripOf: Map<number, number> } {
  const timed = photos
    .map((photo, index) => ({ photo, index }))
    .filter((e) => e.photo.t !== null)
    .sort((a, b) => a.photo.t! - b.photo.t!);
  // Sessions: one outing is a run of pictures without a long pause.
  const sessions: Array<typeof timed> = [];
  for (const entry of timed) {
    const last = sessions[sessions.length - 1];
    const previous = last?.[last.length - 1];
    if (
      last &&
      previous &&
      entry.photo.t! - previous.photo.t! <= SESSION_GAP_MS
    )
      last.push(entry);
    else sessions.push([entry]);
  }
  const homeCc = home
    ? (dominant(
        photos
          .filter(
            (p) =>
              p.lat !== null &&
              p.lon !== null &&
              distanceKm({ lat: p.lat, lon: p.lon }, home) <= 25,
          )
          .map((p) => p.cc),
      )?.value ?? null)
    : null;
  const away = (session: typeof timed): boolean | null => {
    const located = session.filter(
      (e) => e.photo.lat !== null && e.photo.lon !== null,
    );
    if (located.length === 0 || !home) return null;
    const far = located.filter(
      (e) =>
        distanceKm({ lat: e.photo.lat!, lon: e.photo.lon! }, home) > AWAY_KM,
    ).length;
    return far >= located.length / 2;
  };
  const trips: Trip[] = [];
  const tripOf = new Map<number, number>();
  let chain: Array<typeof timed> = [];
  const close = (): void => {
    if (chain.length === 0) return;
    const entries = chain.flat();
    const days = entries
      .map((e) => localDay(e.photo))
      .filter((d): d is string => d !== null)
      .sort();
    const first = days[0];
    const last = days[days.length - 1];
    const countries = new Set(entries.map((e) => e.photo.cc).filter(Boolean));
    const abroad =
      homeCc !== null && [...countries].some((cc) => cc !== homeCc);
    chain = [];
    if (!first || !last || (first === last && !abroad)) return;
    const place = dominant(entries.map((e) => e.photo.place));
    const country = dominant(entries.map((e) => e.photo.cc));
    // One place carries the pictures: name it; otherwise the country.
    const title =
      place && place.share >= 0.6
        ? place.value
        : country
          ? countryName(country.value)
          : (place?.value ?? '');
    if (!title) return;
    const index = trips.length;
    trips.push({ title, from: first, to: last, cc: country?.value ?? null });
    for (const e of entries) tripOf.set(e.index, index);
  };
  for (const session of sessions) {
    if (away(session) !== true) {
      close();
      continue;
    }
    const previous = chain[chain.length - 1];
    const gap = previous
      ? session[0]!.photo.t! - previous[previous.length - 1]!.photo.t!
      : 0;
    if (previous && gap > TRIP_GAP_MS) close();
    chain.push(session);
  }
  close();
  return { trips, tripOf };
}

export const MIN_SCENE_ODDS = 0.45;

/** Swedish country names, for trips named after a country. */
export function swedishCountryName(cc: string): string {
  try {
    return new Intl.DisplayNames(['sv'], { type: 'region' }).of(cc) ?? cc;
  } catch {
    return cc;
  }
}

/** Adds `[j, score]` to a best-first list of at most NEIGHBOURS. */
export function keepBest(list: Neighbour[], j: number, score: number): void {
  let at = list.length;
  if (at >= NEIGHBOURS) {
    const last = list[at - 1]!;
    if (last[1] > score || (last[1] === score && last[0] < j)) return;
  }
  // Insertion from the end: lists are short and mostly arrive best first.
  while (at > 0) {
    const x = list[at - 1]!;
    if (x[1] > score || (x[1] === score && x[0] < j)) break;
    at -= 1;
  }
  list.splice(at, 0, [j, score]);
  if (list.length > NEIGHBOURS) list.pop();
}

/** How many pictures nearest in time a picture without the brain's word is compared with. */
export const FALLBACK_WINDOW = 60;
const FAR_APART_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Neighbours from time and place alone, for the pictures `wanted` says: each
 * is compared with the `window` pictures nearest to it in time, so the work
 * is O(n · window), never O(n²). Pictures without a capture time get none.
 * Pictures `excluded` says are never anybody's neighbour.
 */
export function windowNeighbours(
  photos: GroupingInput[],
  options: {
    wanted: (index: number) => boolean;
    excluded: (index: number) => boolean;
    tripOf: Map<number, number>;
    window?: number;
  },
): Map<number, Neighbour[]> {
  const window = options.window ?? FALLBACK_WINDOW;
  const order: number[] = [];
  for (let i = 0; i < photos.length; i += 1)
    if (photos[i]!.t !== null) order.push(i);
  order.sort((a, b) => photos[a]!.t! - photos[b]!.t! || a - b);
  const out = new Map<number, Neighbour[]>();
  for (let k = 0; k < order.length; k += 1) {
    const i = order[k]!;
    if (!options.wanted(i)) continue;
    const a = photos[i]!;
    const list: Neighbour[] = [];
    let lo = k - 1;
    let hi = k + 1;
    const trip = options.tripOf.get(i);
    for (let taken = 0; taken < window && (lo >= 0 || hi < order.length);) {
      const before = lo >= 0 ? a.t! - photos[order[lo]!]!.t! : Infinity;
      const after =
        hi < order.length ? photos[order[hi]!]!.t! - a.t! : Infinity;
      // Without people, a month apart never reaches the threshold, and every
      // picture after this one is further away still.
      if (a.people.length === 0 && Math.min(before, after) > FAR_APART_MS)
        break;
      let j: number;
      if (before <= after) {
        j = order[lo]!;
        lo -= 1;
      } else {
        j = order[hi]!;
        hi += 1;
      }
      taken += 1;
      if (options.excluded(j)) continue;
      let score = affinity(a, photos[j]!);
      if (trip !== undefined && trip === options.tripOf.get(j))
        score = Math.min(1, score + 0.08);
      if (score >= MIN_SCORE) keepBest(list, j, Math.round(score * 100));
    }
    if (list.length > 0) out.set(i, list);
  }
  return out;
}
