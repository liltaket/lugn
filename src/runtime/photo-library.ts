import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { systemClock, type Clock } from '../core/clock.js';
import type {
  AlbumListing,
  AlbumPhoto,
  AlbumPhotoDetails,
} from './icloud-shared-album.js';
import type {
  InsightExtras,
  InsightPhoto,
  InsightStatus,
} from './photo-intel/insight.js';
import type { MoveTarget, PeopleView } from './photo-intel/people.js';
import type { PhotoExtras, Trip } from './photo-intel/grouping.js';

/** What the Hub gets per photo; no Apple URL or record name ever leaves here. */
export type PhotoSummary = {
  /** Opaque: 24 base64url characters from the picture's record and version. */
  id: string;
  /** Pixel size of the cached picture. */
  w: number;
  h: number;
  /** Local capture date `YYYY-MM-DD` at the place it was taken, or null. */
  date: string | null;
  /** Nearest populated place, or null. */
  place: string | null;
  /** Capture time, ms since the epoch (UTC), or null; the page groups by it. */
  t: number | null;
  /** Position rounded to about a kilometre, or null; the page groups by it. */
  lat: number | null;
  lon: number | null;
  /** Country code of the nearest populated place, or null. */
  cc: string | null;
} & PhotoExtras;
export type PhotoListing = {
  /** Changes when the set of photos changes. */
  revision: string;
  photos: PhotoSummary[];
  /** Trips found in the dates and places; pictures point at them by index. */
  trips?: Trip[];
  /** People who are in at least one picture (a name only once someone gave one). */
  people?: Array<{ id: string; name: string | null }>;
  /** Scene key → the name a Hub shows for it. */
  scenes?: Record<string, string>;
  /** The pictures have been looked at by the models (neighbours are real). */
  ai?: boolean;
};
export type PhotoVariant = 'main' | 'backdrop';
export type PhotoStatus = {
  configured: boolean;
  photos: number;
  lastRefreshAt: number | null;
  lastError: string | null;
};

export type ProcessedPhoto = {
  main: Uint8Array;
  backdrop: Uint8Array;
  width: number;
  height: number;
};
export type PhotoProcessor = (source: Uint8Array) => Promise<ProcessedPhoto>;
export type PlaceLookup = (
  latitude: number,
  longitude: number,
) => string | null;
export type CountryLookup = (
  latitude: number,
  longitude: number,
) => string | null;

/** What the intelligence adds: analysis of new pictures and a smarter listing. */
/** What the household's panel may do with the people the frame found. */
export type PhotoPeopleApi = {
  status(): InsightStatus;
  summary(): { people: number; pending: number };
  peopleView(): PeopleView;
  rename(personId: string, name: string | null): void;
  confirm(personId: string): void;
  setHidden(personId: string, hidden: boolean): void;
  moveFace(faceId: string, target: MoveTarget): void;
  merge(fromId: string, intoId: string): void;
  faceCrop(faceId: string): Promise<Uint8Array | null>;
  faceContext(faceId: string): { photoId: string } | null;
};
export type PhotoInsightLike = Partial<PhotoPeopleApi> & {
  start(): Promise<void>;
  sync(photos: InsightPhoto[]): void;
  decorate(): InsightExtras;
  revision(): string;
  subscribe(listener: () => void): () => void;
  dispose(): void;
};

export type PhotoLibraryOptions = {
  cacheDir: string;
  list: () => Promise<AlbumListing>;
  /** Download one signed image URL; rejects on any failure. */
  download: (url: string) => Promise<Uint8Array>;
  process: PhotoProcessor;
  place: PlaceLookup;
  country?: CountryLookup;
  /** Optional: looks at new pictures and groups them. Without it nothing changes. */
  insight?: PhotoInsightLike;
  refreshMs?: number;
  maxPhotos?: number;
  /** Rest between two new pictures, so a large refresh never hogs the CPU. */
  pauseMs?: number;
  log?: (message: string) => void;
  clock?: Clock;
  warn?: (message: string) => void;
  /** Test seam: the scheduler for the periodic refresh. */
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  clearTimer?: (handle: unknown) => void;
};

type IndexEntry = Omit<PhotoSummary, keyof PhotoExtras> & {
  source: string;
  /** Seconds east of UTC where it was taken (for local dates). */
  off?: number;
  details?: AlbumPhotoDetails;
};
type IndexFile = { version: 1; photos: IndexEntry[] };

const IMAGE_ID = /^[A-Za-z0-9_-]{24}$/;
const EMPTY_LISTINGS_BEFORE_CLEAR = 3;

const pick = (entry: IndexEntry): Omit<PhotoSummary, keyof PhotoExtras> => ({
  id: entry.id,
  w: entry.w,
  h: entry.h,
  date: entry.date ?? null,
  place: entry.place ?? null,
  t: entry.t ?? null,
  lat: entry.lat ?? null,
  lon: entry.lon ?? null,
  cc: entry.cc ?? null,
});

export function photoId(sourceId: string): string {
  return createHash('sha256')
    .update('lugn-photo:')
    .update(sourceId)
    .digest('base64url')
    .slice(0, 24);
}

const comparable = (
  fresh: Pick<
    IndexEntry,
    'date' | 'place' | 't' | 'lat' | 'lon' | 'cc' | 'off' | 'details'
  >,
) => ({
  date: fresh.date ?? null,
  place: fresh.place ?? null,
  t: fresh.t ?? null,
  lat: fresh.lat ?? null,
  lon: fresh.lon ?? null,
  cc: fresh.cc ?? null,
  off: fresh.off ?? 0,
  details: fresh.details ?? null,
});

const round2 = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 100) / 100;

function localDate(photo: AlbumPhoto): string | null {
  if (photo.takenAt === null) return null;
  const shifted = new Date(photo.takenAt + photo.utcOffsetSeconds * 1000);
  return Number.isNaN(shifted.getTime())
    ? null
    : shifted.toISOString().slice(0, 10);
}

/**
 * A bounded local copy of the album. The listing is read on a schedule and
 * every new photo is downloaded, scaled once and written to disk; a failing
 * or empty listing never removes what is already cached.
 */
export class PhotoLibrary {
  private readonly clock: Clock;
  private entries: IndexEntry[] = [];
  private revision = '';
  private timer: unknown;
  private running = false;
  private disposed = false;
  private unsubscribeInsight: (() => void) | undefined;
  private lastRefreshAt: number | null = null;
  private lastError: string | null = null;
  private emptyListings = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: PhotoLibraryOptions) {
    this.clock = options.clock ?? systemClock;
  }

  async start(): Promise<void> {
    try {
      await mkdir(this.options.cacheDir, { recursive: true });
      const parsed = JSON.parse(
        await readFile(join(this.options.cacheDir, 'index.json'), 'utf8'),
      ) as IndexFile;
      if (parsed.version === 1 && Array.isArray(parsed.photos))
        this.entries = parsed.photos.filter(
          (entry) =>
            IMAGE_ID.test(entry.id) && typeof entry.source === 'string',
        );
      this.updateRevision();
    } catch (error) {
      // An unusable cache directory degrades to "no photos"; it never stops Lugn.
      this.entries = [];
      this.options.warn?.(
        `photo frame cache unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await this.startInsight();
    // The first refresh runs in the background; startup never waits for Apple.
    this.schedule(0);
  }

  private async startInsight(): Promise<void> {
    const insight = this.options.insight;
    if (!insight) return;
    try {
      await insight.start();
      this.unsubscribeInsight = insight.subscribe(() => {
        this.updateRevision();
        for (const listener of this.listeners) listener();
      });
      insight.sync(this.insightPhotos());
      this.updateRevision();
    } catch (error) {
      // The analysis is an extra; the frame works without it.
      this.options.warn?.(
        `photo analysis unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private insightPhotos(): InsightPhoto[] {
    return this.entries.map((entry) => ({
      id: entry.id,
      t: entry.t ?? null,
      lat: entry.lat ?? null,
      lon: entry.lon ?? null,
      place: entry.place ?? null,
      cc: entry.cc ?? null,
      utcOffsetSeconds: entry.off ?? 0,
      details: entry.details,
    }));
  }

  /** The people panel's operations; absent when the frame runs without insight. */
  peopleApi(): PhotoPeopleApi | undefined {
    const insight = this.options.insight;
    return insight && typeof insight.peopleView === 'function'
      ? (insight as PhotoPeopleApi)
      : undefined;
  }

  /** The cached picture itself, for the panel's face crops. */
  async readMain(id: string): Promise<Uint8Array | null> {
    return this.read(id, 'main');
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined)
      (this.options.clearTimer ?? clearTimeout)(
        this.timer as Parameters<typeof clearTimeout>[0],
      );
    this.listeners.clear();
    this.unsubscribeInsight?.();
    this.options.insight?.dispose();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  status(): PhotoStatus {
    return {
      configured: true,
      photos: this.entries.length,
      lastRefreshAt: this.lastRefreshAt,
      lastError: this.lastError,
    };
  }

  snapshot(): PhotoListing {
    const insight = this.options.insight;
    if (!insight)
      return {
        revision: this.revision,
        photos: this.entries.map((entry) => pick(entry)),
      };
    // The extras are computed for the entries as they were last synced.
    const extras = insight.decorate();
    const aligned = extras.extras.length === this.entries.length;
    return {
      revision: this.revision,
      photos: this.entries.map((entry, index) => ({
        ...pick(entry),
        ...(aligned ? extras.extras[index] : {}),
      })),
      ...(aligned && extras.trips.length > 0 ? { trips: extras.trips } : {}),
      ...(aligned && extras.people.length > 0 ? { people: extras.people } : {}),
      ...(aligned && Object.keys(extras.scenes).length > 0
        ? { scenes: extras.scenes }
        : {}),
      ai: aligned && extras.ai,
    };
  }

  /** Only ids this library issued resolve; the id never reaches a path unchecked. */
  async read(id: string, variant: PhotoVariant): Promise<Uint8Array | null> {
    if (!IMAGE_ID.test(id) || !this.entries.some((entry) => entry.id === id))
      return null;
    try {
      return await readFile(
        join(
          this.options.cacheDir,
          `${id}.${variant === 'main' ? 'jpg' : 'bg.jpg'}`,
        ),
      );
    } catch {
      return null;
    }
  }

  private schedule(ms: number): void {
    if (this.disposed) return;
    const set =
      this.options.setTimer ??
      ((fn: () => void, delay: number) => setTimeout(fn, delay));
    const handle = set(() => {
      void this.refresh();
    }, ms);
    handle.unref?.();
    this.timer = handle;
  }

  /** One refresh pass; overlapping calls are ignored. */
  async refresh(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      await this.refreshOnce();
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.options.warn?.(`photo frame refresh failed: ${this.lastError}`);
    } finally {
      this.running = false;
      this.lastRefreshAt = this.clock.now();
      this.schedule(this.options.refreshMs ?? 30 * 60_000);
    }
  }

  private async refreshOnce(): Promise<void> {
    const listing = await this.options.list();
    const max = this.options.maxPhotos ?? 150;
    if (listing.photos.length === 0 && this.entries.length > 0) {
      // Apple has answered with an empty list for a live album before; only a
      // few in a row are believed.
      this.emptyListings += 1;
      if (this.emptyListings < EMPTY_LISTINGS_BEFORE_CLEAR) return;
    } else {
      this.emptyListings = 0;
    }
    // Newest first; the cap drops the oldest.
    const wanted = [...listing.photos]
      .sort((a, b) => (b.takenAt ?? 0) - (a.takenAt ?? 0))
      .slice(0, max);
    if (listing.truncated)
      this.options.warn?.(
        'photo frame: the album is longer than what is read; the newest pictures may be missing',
      );
    const known = new Map(this.entries.map((entry) => [entry.source, entry]));
    const next: IndexEntry[] = [];
    let changed = false;
    for (const photo of wanted) {
      if (this.disposed) return;
      const key = `${photo.id}:${photo.version}`;
      const existing = known.get(key);
      if (existing) {
        // The picture stays; what is known about it may have been added since.
        const fresh = this.metadata(photo);
        const before = {
          date: existing.date ?? null,
          place: existing.place ?? null,
          t: existing.t ?? null,
          lat: existing.lat ?? null,
          lon: existing.lon ?? null,
          cc: existing.cc ?? null,
          off: existing.off ?? 0,
          details: existing.details ?? null,
        };
        if (JSON.stringify(before) !== JSON.stringify(comparable(fresh)))
          changed = true;
        next.push({ ...existing, ...fresh });
        continue;
      }
      try {
        const started = this.clock.monotonicNow();
        const processed = await this.options.process(
          await this.options.download(photo.url),
        );
        this.options.log?.(
          `photo frame: one picture took ${Math.round(this.clock.monotonicNow() - started)} ms`,
        );
        const id = photoId(key);
        await this.writeFiles(id, processed);
        next.push({
          id,
          source: key,
          w: processed.width,
          h: processed.height,
          ...this.metadata(photo),
        });
        changed = true;
        await this.rest();
      } catch (error) {
        // One bad picture does not stop the others; it is tried again next time.
        this.options.warn?.(
          `photo frame skipped one picture: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const kept = new Set(next.map((entry) => entry.source));
    const removed = this.entries.filter((entry) => !kept.has(entry.source));
    if (removed.length > 0) changed = true;
    if (!changed && next.length === this.entries.length) return;
    await this.writeIndex(next);
    this.entries = next;
    this.options.insight?.sync(this.insightPhotos());
    this.updateRevision();
    await this.sweep();
    for (const listener of this.listeners) listener();
  }

  private metadata(
    photo: AlbumPhoto,
  ): Pick<
    IndexEntry,
    'date' | 'place' | 't' | 'lat' | 'lon' | 'cc' | 'off' | 'details'
  > {
    const located = photo.latitude !== null && photo.longitude !== null;
    return {
      date: localDate(photo),
      place: located
        ? this.options.place(photo.latitude!, photo.longitude!)
        : null,
      cc: located
        ? (this.options.country?.(photo.latitude!, photo.longitude!) ?? null)
        : null,
      t: photo.takenAt,
      lat: round2(photo.latitude),
      lon: round2(photo.longitude),
      off: photo.utcOffsetSeconds,
      ...(photo.details ? { details: photo.details } : {}),
    };
  }

  private async rest(): Promise<void> {
    const ms = this.options.pauseMs ?? 0;
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async writeFiles(
    id: string,
    processed: ProcessedPhoto,
  ): Promise<void> {
    const { cacheDir } = this.options;
    for (const [suffix, bytes] of [
      ['jpg', processed.main],
      ['bg.jpg', processed.backdrop],
    ] as const) {
      const temporary = join(cacheDir, `${id}.${suffix}.tmp`);
      await writeFile(temporary, bytes);
      await rename(temporary, join(cacheDir, `${id}.${suffix}`));
    }
  }

  private async writeIndex(photos: IndexEntry[]): Promise<void> {
    const file: IndexFile = { version: 1, photos };
    const target = join(this.options.cacheDir, 'index.json');
    await writeFile(`${target}.tmp`, JSON.stringify(file));
    await rename(`${target}.tmp`, target);
  }

  private async sweep(): Promise<void> {
    const live = new Set(this.entries.map((entry) => entry.id));
    for (const name of await readdir(this.options.cacheDir)) {
      const id = /^([A-Za-z0-9_-]{24})\.(?:bg\.)?jpg(?:\.tmp)?$/.exec(
        name,
      )?.[1];
      if (id && !live.has(id))
        await rm(join(this.options.cacheDir, name), { force: true });
    }
  }

  private updateRevision(): void {
    this.revision = createHash('sha256')
      .update(this.entries.map((entry) => entry.id).join(','))
      .update(this.options.insight?.revision() ?? '')
      .digest('base64url')
      .slice(0, 12);
  }
}
