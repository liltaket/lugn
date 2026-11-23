import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AlbumPhotoDetails } from '../icloud-shared-album.js';
import { dot, normalize } from './faces.js';

/**
 * Which pictures belong together. Time, place, the people in them and what
 * they look like are each turned into a 0–1 score and combined; pictures that
 * are far apart in every respect never end up side by side. All of it is
 * computed here, once per change, so a Hub only reads a short list of
 * neighbours per picture and does no analysis while it shows pictures.
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
  /** CLIP embedding, when the models have run. */
  embedding?: Float32Array | undefined;
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
};
export type Trip = {
  title: string;
  /** Local dates `YYYY-MM-DD`, first and last day. */
  from: string;
  to: string;
  cc: string | null;
};
export type GroupingResult = {
  extras: PhotoExtras[];
  trips: Trip[];
};

const NEIGHBOURS = 14;
const MIN_SCORE = 0.3;
const SESSION_GAP_MS = 6 * 60 * 60 * 1000;
const TRIP_GAP_MS = 40 * 60 * 60 * 1000;
const AWAY_KM = 80;

export function distanceKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const dy = (a.lat - b.lat) * 111.32;
  const dx = (a.lon - b.lon) * 111.32 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

const clamp01 = (value: number): number =>
  value < 0 ? 0 : value > 1 ? 1 : value;

/** Piecewise-linear in log time: 1 within half an hour, 0 after a month. */
export function timeScore(deltaMs: number): number {
  const hours = deltaMs / 3_600_000;
  const knots: ReadonlyArray<readonly [number, number]> = [
    [0.5, 1],
    [3, 0.85],
    [8, 0.6],
    [36, 0.35],
    [24 * 7, 0.15],
    [24 * 30, 0],
  ];
  if (hours <= knots[0]![0]) return 1;
  for (let i = 1; i < knots.length; i += 1) {
    const [h1, s1] = knots[i - 1]!;
    const [h2, s2] = knots[i]!;
    if (hours <= h2) {
      const k =
        (Math.log(hours) - Math.log(h1)) / (Math.log(h2) - Math.log(h1));
      return s1 + (s2 - s1) * k;
    }
  }
  return 0;
}

export function placeScore(km: number): number {
  const knots: ReadonlyArray<readonly [number, number]> = [
    [0.3, 1],
    [3, 0.85],
    [15, 0.6],
    [60, 0.3],
    [200, 0.08],
  ];
  if (km <= knots[0]![0]) return 1;
  for (let i = 1; i < knots.length; i += 1) {
    const [d1, s1] = knots[i - 1]!;
    const [d2, s2] = knots[i]!;
    if (km <= d2) {
      const k = (Math.log(km) - Math.log(d1)) / (Math.log(d2) - Math.log(d1));
      return s1 + (s2 - s1) * k;
    }
  }
  return 0;
}

/** CLIP picture-to-picture cosine: ~0.5 is unrelated, 0.85 is the same scene. */
export const visualScore = (cosine: number): number =>
  clamp01((cosine - 0.5) / 0.35);

const W_TIME = 0.3;
const W_PLACE = 0.2;
const W_PEOPLE = 0.2;
const W_VISUAL = 0.3;

/** 0–1: how well two pictures belong in one group. Symmetric. */
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
    km = distanceKm({ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon });
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
  let visual: number | null = null;
  if (a.embedding && b.embedding) {
    visual = visualScore(dot(a.embedding, b.embedding));
    sum += W_VISUAL * visual;
    weight += W_VISUAL;
  }
  if (weight === 0) return 0;
  let score = sum / weight;
  // Far apart on every axis that is known: not a group, whatever else says.
  if (
    delta !== null &&
    delta > 14 * 86_400_000 &&
    shared === 0 &&
    (visual ?? 0) < 0.6
  )
    score *= 0.5;
  if (km !== null && km > 150 && (delta === null || delta > 6 * 3_600_000))
    score *= 0.4;
  if (peopleKnown) score = shared > 0 ? Math.min(1, score + 0.1) : score * 0.75;
  return clamp01(score);
}

// ── Scenes ──

export type SceneVocabulary = {
  keys: string[];
  names: Record<string, string>;
  vectors: Float32Array[];
};

export function loadScenes(path?: string): SceneVocabulary | null {
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
        dim: number;
        scale: number;
        scenes: Array<{ key: string; sv: string | null; vector: string }>;
      };
      const keys: string[] = [];
      const names: Record<string, string> = {};
      const vectors: Float32Array[] = [];
      for (const scene of parsed.scenes) {
        const bytes = Buffer.from(scene.vector, 'base64');
        if (bytes.length !== parsed.dim) continue;
        const vector = new Float32Array(parsed.dim);
        for (let i = 0; i < parsed.dim; i += 1)
          vector[i] = bytes.readInt8(i) / parsed.scale;
        keys.push(scene.key);
        vectors.push(normalize(vector));
        if (scene.sv) names[scene.key] = scene.sv;
      }
      return { keys, names, vectors };
    } catch {
      /* try the next */
    }
  }
  return null;
}

/** CLIP's own temperature (logit scale 100) turns similarities into odds. */
export function classifyScene(
  embedding: Float32Array,
  scenes: SceneVocabulary,
): { key: string; p: number } | null {
  if (scenes.vectors.length === 0) return null;
  const logits = scenes.vectors.map((vector) => 100 * dot(vector, embedding));
  const top = Math.max(...logits);
  const odds = logits.map((l) => Math.exp(l - top));
  const total = odds.reduce((a, b) => a + b, 0);
  let best = 0;
  for (let i = 1; i < odds.length; i += 1) if (odds[i]! > odds[best]!) best = i;
  return { key: scenes.keys[best]!, p: odds[best]! / total };
}

// ── Trips ──

const localDay = (input: GroupingInput): string | null => {
  if (input.t === null) return null;
  const shifted = new Date(input.t + (input.utcOffsetSeconds ?? 0) * 1000);
  return Number.isNaN(shifted.getTime())
    ? null
    : shifted.toISOString().slice(0, 10);
};

/** The most photographed place; where the pictures are usually taken. */
export function findHome(
  photos: GroupingInput[],
): { lat: number; lon: number } | null {
  const located = photos.filter(
    (p): p is GroupingInput & { lat: number; lon: number } =>
      p.lat !== null && p.lon !== null,
  );
  if (located.length < 5) return null;
  let best: { lat: number; lon: number; count: number } | null = null;
  for (const centre of located) {
    let count = 0;
    for (const other of located)
      if (distanceKm(centre, other) <= 25) count += 1;
    if (!best || count > best.count)
      best = { lat: centre.lat, lon: centre.lon, count };
  }
  // Home needs to be where a good share of the pictures were taken.
  return best && best.count >= located.length * 0.25 ? best : null;
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

// ── Putting it together ──

export type GroupingOptions = {
  scenes: SceneVocabulary | null;
  home?: { lat: number; lon: number } | null;
  countryName?: (cc: string) => string;
};
export const MIN_SCENE_ODDS = 0.45;

export function groupPhotos(
  photos: GroupingInput[],
  options: GroupingOptions,
): GroupingResult {
  const countryName =
    options.countryName ??
    ((cc: string): string => {
      try {
        return new Intl.DisplayNames(['sv'], { type: 'region' }).of(cc) ?? cc;
      } catch {
        return cc;
      }
    });
  const home = options.home ?? findHome(photos);
  const { trips, tripOf } = findTrips(photos, home, countryName);
  const extras: PhotoExtras[] = photos.map((photo, index) => {
    const extra: PhotoExtras = {};
    if (photo.embedding && options.scenes) {
      const scene = classifyScene(photo.embedding, options.scenes);
      if (scene && scene.p >= MIN_SCENE_ODDS) {
        extra.sc = scene.key;
        extra.sp = Math.round(scene.p * 100);
      }
    }
    if (photo.people.length > 0) extra.pp = photo.people;
    const trip = tripOf.get(index);
    if (trip !== undefined) extra.tr = trip;
    if (photo.details?.favorite) extra.fav = 1;
    if (photo.details?.caption) extra.cap = photo.details.caption;
    return extra;
  });
  // Neighbours: every pair once, the best few kept per picture.
  const lists: Array<Neighbour[]> = photos.map(() => []);
  const duplicates: number[][] = photos.map(() => []);
  for (let i = 0; i < photos.length; i += 1) {
    for (let j = i + 1; j < photos.length; j += 1) {
      const a = photos[i]!;
      const b = photos[j]!;
      let score = affinity(a, b);
      if (tripOf.has(i) && tripOf.get(i) === tripOf.get(j))
        score = Math.min(1, score + 0.08);
      if (a.embedding && b.embedding && a.t !== null && b.t !== null) {
        const close = dot(a.embedding, b.embedding) >= 0.94;
        if (close && Math.abs(a.t - b.t) <= 120_000) {
          duplicates[i]!.push(j);
          duplicates[j]!.push(i);
        }
      }
      if (score >= MIN_SCORE) {
        const rounded = Math.round(score * 100);
        lists[i]!.push([j, rounded]);
        lists[j]!.push([i, rounded]);
      }
    }
  }
  lists.forEach((list, index) => {
    list.sort((x, y) => y[1] - x[1] || x[0] - y[0]);
    if (list.length > 0) extras[index]!.nb = list.slice(0, NEIGHBOURS);
    if (duplicates[index]!.length > 0)
      extras[index]!.du = duplicates[index]!.slice(0, 8);
  });
  return { extras, trips };
}
