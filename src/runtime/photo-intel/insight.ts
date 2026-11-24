import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { systemClock, type Clock } from '../../core/clock.js';
import type { AlbumPhotoDetails } from '../icloud-shared-album.js';
import {
  MIN_SCENE_ODDS,
  MIN_SCORE,
  findHome,
  findTrips,
  keepBest,
  loadSceneNames,
  swedishCountryName,
  windowNeighbours,
  type GroupingInput,
  type Neighbour,
  type PhotoExtras,
  type Trip,
} from './grouping.js';
import { IntelStore, type PhotoIntel } from './intel-store.js';
import {
  PeopleError,
  PeopleStore,
  faceKey,
  isFaceId,
  type FaceRef,
  type MoveTarget,
  type PeopleLabels,
  type PeopleView,
  type ReviewPerson,
  type ReviewPhoto,
  type ReviewView,
} from './people.js';

/** A cached picture as the intelligence sees it. */
export type InsightPhoto = {
  id: string;
  t: number | null;
  /** Full precision when known; only used here, never sent to a Hub. */
  lat: number | null;
  lon: number | null;
  place: string | null;
  cc: string | null;
  utcOffsetSeconds: number;
  details?: AlbumPhotoDetails | undefined;
};

export type InsightExtras = {
  extras: PhotoExtras[];
  trips: Trip[];
  /** People who are in at least one picture, named or not. */
  people: Array<{ id: string; name: string | null }>;
  /** Scene key → what a Hub calls it. */
  scenes: Record<string, string>;
  ai: boolean;
};

export type InsightStatus = {
  /** The photo brain's results are used (`photoFrame.intelligence.enabled`). */
  available: boolean;
  reason: string | null;
  brain: {
    /** When the last bundle from Kuffe arrived (ms), or null before the first. */
    intelAt: number | null;
    /** Pictures in the library with a result from Kuffe. */
    analysed: number;
    photos: number;
    faces: number;
  };
};

/** What `GET /photo-brain/v1/state` tells Kuffe (the library adds `revision`). */
export type BrainState = {
  intelAt: number | null;
  pictures: number;
  analysed: number;
};

export type InsightOptions = {
  cacheDir: string;
  enabled: boolean;
  home?: { lat: number; lon: number } | undefined;
  /** The cached picture's bytes (any variant the library keeps); null if gone. */
  readPhoto: (id: string) => Promise<Uint8Array | null>;
  /** Scene key → name; defaults to `data/photo-scenes.json`. */
  scenes?: Record<string, string>;
  countryName?: (cc: string) => string;
  clock?: Clock;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  /** Test seam for the debounce of file writes. */
  saveDelayMs?: number;
};

const CROP_MARGIN = 0.35;
const CROP_SIZE = 112;
/** A bundle older than this means Kuffe is not working on the pictures now. */
export const BRAIN_QUIET_MS = 6 * 60 * 60 * 1000;
/** Sharpness below or darkness above this: not a picture to show in company. */
const MIN_SHARP = 8;
const MAX_DARK = 95;
const MAX_DUPLICATES = 16;

const isJunk = (entry: PhotoIntel | undefined): boolean =>
  entry !== undefined &&
  (entry.q.junk !== null ||
    entry.q.sharp < MIN_SHARP ||
    entry.q.dark > MAX_DARK);

/**
 * Everything the photo frame knows beyond the picture itself. The photo brain
 * on Kuffe sends what it saw (scenes, faces and who they may be, candidate
 * neighbours, trips); the household's decisions about people live here. Out
 * of both this builds the short list per picture a Hub reads. Pictures Kuffe
 * has not seen yet are grouped by time and place, near neighbours in time
 * only. Nothing here runs a model or compares faces.
 */
export class PhotoInsight {
  private readonly intel: IntelStore;
  private readonly people: PeopleStore;
  private readonly sceneNames: Record<string, string>;
  private readonly clock: Clock;
  private photos: InsightPhoto[] = [];
  private faces: FaceRef[] = [];
  private version = 0;
  private cache: { key: string; value: InsightExtras } | null = null;
  private readonly listeners = new Set<() => void>();
  private saveTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private peopleByPhoto = new Map<string, string[]>();

  constructor(private readonly options: InsightOptions) {
    const warn = options.warn ?? (() => undefined);
    this.intel = new IntelStore(join(options.cacheDir, 'intel.json'), warn);
    this.people = new PeopleStore(join(options.cacheDir, 'people.json'), warn);
    this.sceneNames = options.scenes ?? loadSceneNames();
    this.clock = options.clock ?? systemClock;
  }

  async start(): Promise<void> {
    await this.intel.load();
    await this.people.load();
    if (this.people.needsBoxes()) await this.adoptLegacyBoxes();
    this.regroup();
  }

  /** Stops; resolves once what was decided is written. */
  dispose(): Promise<void> {
    this.disposed = true;
    clearTimeout(this.saveTimer);
    this.listeners.clear();
    return this.flush();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Changes whenever what a Hub would be told changes. */
  revision(): string {
    return `${this.version}`;
  }

  /** The library's pictures changed (or were loaded). */
  sync(photos: InsightPhoto[]): void {
    if (this.disposed) return;
    this.photos = photos;
    this.regroup();
    this.bump(false);
  }

  // ── The photo brain ──

  /** Takes a bundle from Kuffe; throws `IntelError` when it is not schema 1. */
  async putIntel(
    bundle: unknown,
  ): Promise<{ accepted: number; unknown: number }> {
    const result = await this.intel.put(
      bundle,
      new Set(this.photos.map((p) => p.id)),
      this.clock.now(),
    );
    this.regroup();
    this.bump(true);
    this.options.log?.(
      `photo brain: result for ${result.accepted} pictures (${result.unknown} not in the library)`,
    );
    return result;
  }

  /** The household's decisions, for Kuffe's grouping to anchor on. */
  labels(): PeopleLabels {
    return this.people.labels();
  }

  brainState(): BrainState {
    return {
      intelAt: this.intel.receivedAt(),
      pictures: this.photos.length,
      analysed: this.analysedCount(),
    };
  }

  // ── The listing ──

  /** The listing's extras, in the order of `photos` as last synced. */
  decorate(): InsightExtras {
    const key = `${this.version}:${this.photos.length}`;
    if (this.cache?.key === key) return this.cache.value;
    const value = this.compute();
    this.cache = { key, value };
    return value;
  }

  private compute(): InsightExtras {
    const photos = this.photos;
    const n = photos.length;
    const enabled = this.options.enabled;
    const index = new Map<string, number>();
    photos.forEach((photo, i) => index.set(photo.id, i));
    const entries: Array<PhotoIntel | undefined> = photos.map((photo) =>
      enabled ? this.intel.get(photo.id) : undefined,
    );
    const skip = entries.map(isJunk);
    const people = photos.map(
      (photo) => this.peopleByPhoto.get(photo.id) ?? [],
    );
    const inputs: GroupingInput[] = photos.map((photo, i) => ({
      id: photo.id,
      t: photo.t,
      lat: photo.lat,
      lon: photo.lon,
      place: photo.place,
      cc: photo.cc,
      utcOffsetSeconds: photo.utcOffsetSeconds,
      details: photo.details,
      people: people[i]!,
    }));

    // Trips: the brain's for the pictures it saw, the cheap ones for the rest.
    const trips: Trip[] = [];
    const tripOf = new Map<number, number>();
    const bundleTrips = this.intel.trips();
    const renumbered = new Map<number, number>();
    entries.forEach((entry, i) => {
      const trip = entry?.trip;
      if (trip === undefined || trip === null || !bundleTrips[trip]) return;
      let at = renumbered.get(trip);
      if (at === undefined) {
        at = trips.length;
        trips.push({ ...bundleTrips[trip] });
        renumbered.set(trip, at);
      }
      tripOf.set(i, at);
    });
    const unseen: number[] = [];
    for (let i = 0; i < n; i += 1) if (!entries[i]) unseen.push(i);
    if (unseen.length > 0) {
      const home =
        this.options.home ??
        (enabled ? this.intel.home() : null) ??
        findHome(inputs);
      const subset = unseen.map((i) => inputs[i]!);
      const found = findTrips(
        subset,
        home,
        this.options.countryName ?? swedishCountryName,
      );
      const offset = trips.length;
      trips.push(...found.trips);
      for (const [local, trip] of found.tripOf)
        tripOf.set(unseen[local]!, offset + trip);
    }

    const fallback = windowNeighbours(inputs, {
      wanted: (i) => !entries[i] && !skip[i],
      excluded: (i) => skip[i]!,
      tripOf,
    });

    const extras: PhotoExtras[] = photos.map((photo, i) => {
      const entry = entries[i];
      const extra: PhotoExtras = {};
      const scene = entry?.scene[0];
      if (scene && scene[1] >= MIN_SCENE_ODDS) {
        extra.sc = scene[0];
        extra.sp = Math.round(scene[1] * 100);
      }
      if (people[i]!.length > 0) extra.pp = people[i]!;
      const trip = tripOf.get(i);
      if (trip !== undefined) extra.tr = trip;
      if (photo.details?.favorite || entry?.fav === 1) extra.fav = 1;
      const caption = photo.details?.caption ?? entry?.cap;
      if (caption) extra.cap = caption;
      if (skip[i]) {
        extra.skip = 1;
        return extra;
      }
      const nb = entry
        ? this.rerank(entry, i, index, skip, people)
        : fallback.get(i);
      if (nb && nb.length > 0) extra.nb = nb;
      if (entry && entry.du.length > 0) {
        const du: number[] = [];
        for (const id of entry.du) {
          const j = index.get(id);
          if (j !== undefined && j !== i) du.push(j);
          if (du.length >= MAX_DUPLICATES) break;
        }
        if (du.length > 0) extra.du = du;
      }
      return extra;
    });

    const seen = new Set<string>();
    for (const list of people) for (const id of list) seen.add(id);
    return {
      extras,
      trips,
      people: [...seen]
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
        .map((id) => ({ id, name: this.people.nameOf(id) })),
      scenes: this.sceneNames,
      ai: entries.some((entry) => entry !== undefined),
    };
  }

  /**
   * Kuffe's candidates, raised or lowered by who is in both pictures (decided
   * here), as indexes into the current listing. Candidates no longer in the
   * library, and pictures not to be shown in company, are dropped.
   */
  private rerank(
    entry: PhotoIntel,
    i: number,
    index: Map<string, number>,
    skip: boolean[],
    people: string[][],
  ): Neighbour[] {
    const mine = people[i]!;
    const list: Neighbour[] = [];
    for (const [id, base] of entry.cand) {
      const j = index.get(id);
      if (j === undefined || j === i || skip[j]) continue;
      const score = withPeople(base / 100, mine, people[j]!);
      if (score >= MIN_SCORE) keepBest(list, j, Math.round(score * 100));
    }
    return list;
  }

  status(): InsightStatus {
    return {
      available: this.options.enabled,
      reason: this.options.enabled
        ? null
        : 'Bildanalysen är avstängd i inställningarna.',
      brain: {
        intelAt: this.intel.receivedAt(),
        analysed: this.analysedCount(),
        photos: this.photos.length,
        faces: this.faces.length,
      },
    };
  }

  // ── People (the household's corrections) ──

  /** Cheap numbers for the panel's settings list. */
  summary(): { people: number; pending: number } {
    const at = this.intel.receivedAt();
    // While Kuffe is at work, the pictures it has not reached yet.
    const working =
      this.options.enabled &&
      at !== null &&
      this.clock.now() - at < BRAIN_QUIET_MS;
    return {
      people: this.people.activeCount(),
      pending: working ? this.photos.length - this.analysedCount() : 0,
    };
  }

  peopleView(): PeopleView {
    return this.people.view();
  }

  rename(personId: string, name: string | null): void {
    this.people.rename(personId, name);
    this.changed();
  }
  confirm(personId: string): void {
    this.people.confirm(personId);
    this.changed();
  }
  setHidden(personId: string, hidden: boolean): void {
    this.people.setHidden(personId, hidden);
    this.changed();
  }
  moveFace(faceId: string, target: MoveTarget): void {
    this.people.moveFace(faceId, target);
    this.changed();
  }
  merge(fromId: string, intoId: string): void {
    this.people.merge(fromId, intoId);
    this.changed();
  }
  setFaceBox(faceId: string, box: number[] | null): void {
    this.people.setFaceBox(faceId, box);
    this.changed();
  }
  skipPhoto(photoId: string, skip: boolean): void {
    this.people.skipPhoto(photoId, skip);
    this.changed();
  }
  review(): ReviewView {
    return this.people.review();
  }
  photoReview(photoId: string): { people: ReviewPerson[]; photo: ReviewPhoto } {
    return this.people.photoReview(photoId);
  }

  /** A square crop of one face for the panel; null if it is not known. */
  async faceCrop(faceId: string): Promise<Uint8Array | null> {
    if (!isFaceId(faceId)) return null;
    const ref = this.people.faceRef(faceId);
    if (!ref) return null;
    const bytes = await this.options.readPhoto(ref.photoId);
    if (!bytes) return null;
    try {
      const meta = await sharp(bytes).metadata();
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;
      if (width <= 0 || height <= 0) return null;
      const { x, y, w, h } = this.people.faceBox(faceId) ?? ref.face;
      const side = Math.max(w * width, h * height) * (1 + 2 * CROP_MARGIN);
      const cx = (x + w / 2) * width;
      const cy = (y + h / 2) * height;
      const size = Math.max(1, Math.min(Math.round(side), width, height));
      const left = Math.min(
        Math.max(0, Math.round(cx - size / 2)),
        width - size,
      );
      const top = Math.min(
        Math.max(0, Math.round(cy - size / 2)),
        height - size,
      );
      return await sharp(bytes)
        .extract({ left, top, width: size, height: size })
        .resize(CROP_SIZE, CROP_SIZE)
        .jpeg({ quality: 78 })
        .toBuffer();
    } catch {
      return null;
    }
  }

  /** The picture a face is in, so a face can be judged in its setting. */
  faceContext(faceId: string): { photoId: string } | null {
    const ref = isFaceId(faceId) ? this.people.faceRef(faceId) : undefined;
    return ref ? { photoId: ref.photoId } : null;
  }

  // ── Internals ──

  private analysedCount(): number {
    let count = 0;
    for (const photo of this.photos) if (this.intel.has(photo.id)) count += 1;
    return count;
  }

  /**
   * The faces of the pictures in the library, as Kuffe numbered them, mapped
   * to people. Before Kuffe's first word nothing is re-mapped, so the
   * household's people are kept as they are.
   */
  private regroup(): void {
    const faces: FaceRef[] = [];
    if (this.options.enabled)
      for (const photo of this.photos) {
        const entry = this.intel.get(photo.id);
        entry?.faces.forEach((face, i) =>
          faces.push({
            id: faceKey(photo.id, i),
            photoId: photo.id,
            face: {
              x: face.x,
              y: face.y,
              w: face.w,
              h: face.h,
              score: face.score,
              front: face.front,
              quality: face.q,
              ...(face.p ? { p: face.p } : {}),
            },
          }),
        );
      }
    this.faces = faces;
    if (this.options.enabled && this.intel.receivedAt() !== null)
      this.people.regroup(faces);
    this.peopleByPhoto = this.people.peopleByPhoto();
  }

  private changed(): void {
    // A correction is a decision: map everyone again, at once.
    this.regroup();
    this.bump(true);
  }

  private bump(notify: boolean): void {
    this.version += 1;
    this.cache = null;
    this.scheduleSave();
    if (notify) for (const listener of this.listeners) listener();
  }

  private scheduleSave(): void {
    if (this.saveTimer || this.disposed) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush();
    }, this.options.saveDelayMs ?? 4000);
    this.saveTimer.unref?.();
  }

  private async flush(): Promise<void> {
    try {
      await this.people.save();
    } catch (error) {
      this.options.warn?.(
        `photo people could not be saved: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Decisions made with the old on-device analysis know their face only by
   * its number; its `analysis.json` still has the boxes, so the decisions can
   * follow their faces into Kuffe's numbering. Read once, boxes only.
   */
  private async adoptLegacyBoxes(): Promise<void> {
    try {
      const parsed = JSON.parse(
        await readFile(join(this.options.cacheDir, 'analysis.json'), 'utf8'),
      ) as {
        photos?: Record<
          string,
          { f?: Array<{ x?: unknown; y?: unknown; w?: unknown; h?: unknown }> }
        >;
      };
      const boxes = new Map<string, [number, number, number, number]>();
      for (const [photoId, record] of Object.entries(parsed.photos ?? {}))
        record.f?.forEach((face, i) =>
          boxes.set(faceKey(photoId, i), [
            Number(face.x),
            Number(face.y),
            Number(face.w),
            Number(face.h),
          ]),
        );
      this.people.adoptBoxes(boxes);
    } catch {
      /* no old analysis: decisions stay keyed by number */
    }
  }
}

/** The contract's people adjustment of a candidate's base score (0–1). */
export function withPeople(base: number, a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return base;
  // A picture shows a handful of people at most: no set needed.
  let shared = 0;
  for (const id of b) if (a.includes(id)) shared += 1;
  if (shared === 0) return base * 0.8;
  const union = a.length + b.length - shared;
  return Math.min(1, base + 0.08 + 0.12 * (shared / union));
}

export { PeopleError };
