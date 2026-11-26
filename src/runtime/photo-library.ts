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
  AlbumRendition,
} from './icloud-shared-album.js';
import type {
  BrainState,
  InsightExtras,
  InsightPhoto,
  InsightStatus,
} from './photo-intel/insight.js';
import type {
  MoveTarget,
  PeopleLabels,
  PeopleView,
  ReviewPerson,
  ReviewPhoto,
  ReviewView,
} from './photo-intel/people.js';
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
  /** Brightness 0–99 of the upper right, lower right and lower left corner. */
  lu?: Corners;
} & PhotoExtras;
export type Corners = [number, number, number];
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
  /** Corner brightness; absent when it could not be measured. */
  corners?: Corners;
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
  setFaceBox(faceId: string, box: number[] | null): void;
  skipPhoto(photoId: string, skip: boolean): void;
  review(): ReviewView;
  photoReview(photoId: string): { people: ReviewPerson[]; photo: ReviewPhoto };
  faceCrop(faceId: string): Promise<Uint8Array | null>;
  faceContext(faceId: string): { photoId: string } | null;
};
/** What the intelligence adds: the photo brain's results and a smarter listing. */
export type PhotoInsightLike = Partial<PhotoPeopleApi> &
  Partial<{
    putIntel(bundle: unknown): Promise<{ accepted: number; unknown: number }>;
    labels(): PeopleLabels;
    brainState(): BrainState;
  }> & {
    start(): Promise<void>;
    sync(photos: InsightPhoto[]): void;
    decorate(): InsightExtras;
    revision(): string;
    subscribe(listener: () => void): () => void;
    dispose(): void;
  };

/** The body of `GET /photo-brain/v1/album` (docs/PHOTO-BRAIN.md). */
export type BrainAlbum = {
  schema: 1;
  title: string;
  listedAt: number;
  photos: Array<{
    id: string;
    version: string;
    takenAt: number | null;
    utcOffsetSeconds: number;
    latitude: number | null;
    longitude: number | null;
    width: number;
    height: number;
    details?: AlbumPhotoDetails;
    renditions: AlbumRendition[];
  }>;
};

/** The machine API Kuffe's photo brain uses (bearer token, loopback). */
export type PhotoBrainApi = {
  album(): Promise<BrainAlbum>;
  putIntel(bundle: unknown): Promise<{ accepted: number; unknown: number }>;
  people(): PeopleLabels;
  state(): BrainState & { revision: string };
};

export type PhotoLibraryOptions = {
  cacheDir: string;
  list: () => Promise<AlbumListing>;
  /** Download one signed image URL; rejects on any failure. */
  download: (url: string) => Promise<Uint8Array>;
  process: PhotoProcessor;
  place: PlaceLookup;
  country?: CountryLookup;
  /** Measures a cached picture's corners; used for pictures cached before it existed. */
  measure?: (source: Uint8Array) => Promise<Corners>;
  /** Optional: looks at new pictures and groups them. Without it nothing changes. */
  insight?: PhotoInsightLike;
  /** `photoFrame.intelligence.enabled`: false keeps the album from the photo brain. */
  brainEnabled?: boolean;
  refreshMs?: number;
  maxPhotos?: number;
  /** New pictures between two writes of the index during one refresh. */
  checkpointEvery?: number;
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
  /** Full-precision position, for this machine only; a Hub gets `lat`/`lon`. */
  geo?: [lat: number, lon: number];
  /** Seconds east of UTC where it was taken (for local dates). */
  off?: number;
  details?: AlbumPhotoDetails;
  lu?: Corners;
};
type IndexFile = { version: 1; photos: IndexEntry[] };

const IMAGE_ID = /^[A-Za-z0-9_-]{24}$/;
const EMPTY_LISTINGS_BEFORE_CLEAR = 3;
export const DEFAULT_MAX_PHOTOS = 5000;
const CHECKPOINT_EVERY = 25;
/** Apple's download links last about 15 minutes; the brain gets fresh ones. */
const ALBUM_MAX_AGE_MS = 5 * 60_000;
const ALBUM_STALE_MS = 15 * 60_000;

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
  ...(entry.lu ? { lu: entry.lu } : {}),
});

export function photoId(sourceId: string): string {
  return createHash('sha256')
    .update('lugn-photo:')
    .update(sourceId)
    .digest('base64url')
    .slice(0, 24);
}

type Metadata = Pick<
  IndexEntry,
  'date' | 'place' | 't' | 'lat' | 'lon' | 'geo' | 'cc' | 'off' | 'details'
>;
const comparable = (fresh: Metadata) => ({
  date: fresh.date ?? null,
  place: fresh.place ?? null,
  t: fresh.t ?? null,
  lat: fresh.lat ?? null,
  lon: fresh.lon ?? null,
  geo: fresh.geo ?? null,
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
  /** The last album listing and when it was read, for the photo brain. */
  private listing: { value: AlbumListing; at: number } | null = null;
  private listingInFlight: Promise<AlbumListing> | null = null;
  private emptyBrainListings = 0;

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
      lat: entry.geo?.[0] ?? entry.lat ?? null,
      lon: entry.geo?.[1] ?? entry.lon ?? null,
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

  /**
   * Kuffe's side of the frame; absent without the intelligence or when it is
   * switched off.
   */
  brainApi(): PhotoBrainApi | undefined {
    const insight = this.options.insight;
    if (
      !insight ||
      this.options.brainEnabled === false ||
      !insight.putIntel ||
      !insight.labels ||
      !insight.brainState
    )
      return undefined;
    return {
      album: () => this.albumForBrain(),
      putIntel: (bundle) => insight.putIntel!(bundle),
      people: () => insight.labels!(),
      state: () => ({ revision: this.revision, ...insight.brainState!() }),
    };
  }

  /**
   * The contract's album body: every still in the album, newest first, no
   * cap, with Apple's download links. A listing older than five minutes is
   * read again first (one read at a time); never more often.
   */
  async albumForBrain(): Promise<BrainAlbum> {
    let listing = this.listing;
    if (!listing || this.clock.now() - listing.at > ALBUM_MAX_AGE_MS) {
      try {
        await this.listAlbum();
      } catch (error) {
        // A listing a few minutes old still has working links.
        if (!listing || this.clock.now() - listing.at > ALBUM_STALE_MS)
          throw error;
      }
      listing = this.listing ?? listing;
    }
    if (!listing) throw new Error('album not listed');
    const photos = [...listing.value.photos].sort(
      (a, b) => (b.takenAt ?? 0) - (a.takenAt ?? 0),
    );
    return {
      schema: 1,
      title: listing.value.title,
      listedAt: listing.at,
      photos: photos.map((photo) => ({
        id: photoId(`${photo.id}:${photo.version}`),
        version: photo.version,
        takenAt: photo.takenAt,
        utcOffsetSeconds: photo.utcOffsetSeconds,
        latitude: photo.latitude,
        longitude: photo.longitude,
        width: photo.width,
        height: photo.height,
        ...(photo.details ? { details: photo.details } : {}),
        renditions:
          photo.renditions && photo.renditions.length > 0
            ? photo.renditions
            : [
                {
                  kind: 'jpeg' as const,
                  url: photo.url,
                  width: photo.width,
                  height: photo.height,
                },
              ],
      })),
    };
  }

  /** Reads the album; a read already under way is shared. */
  private listAlbum(): Promise<AlbumListing> {
    if (this.listingInFlight) return this.listingInFlight;
    const pending = this.options
      .list()
      .then((value) => {
        // Apple has answered with an empty list for a live album before: the
        // brain keeps the last real listing until a few in a row say so.
        const empty =
          value.photos.length === 0 &&
          (this.listing?.value.photos.length ?? 0) > 0;
        this.emptyBrainListings = empty ? this.emptyBrainListings + 1 : 0;
        if (!empty || this.emptyBrainListings >= EMPTY_LISTINGS_BEFORE_CLEAR)
          this.listing = { value, at: this.clock.now() };
        return value;
      })
      .finally(() => {
        this.listingInFlight = null;
      });
    this.listingInFlight = pending;
    return pending;
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
    const listing = await this.listAlbum();
    const max = this.options.maxPhotos ?? DEFAULT_MAX_PHOTOS;
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
    let sinceCheckpoint = 0;
    for (const [position, photo] of wanted.entries()) {
      if (this.disposed) return;
      if (
        sinceCheckpoint >= (this.options.checkpointEvery ?? CHECKPOINT_EVERY)
      ) {
        // Thousands of new pictures take hours: what is done so far is kept
        // (and shown) now, so a restart or a failure does not lose it.
        sinceCheckpoint = 0;
        await this.checkpoint(next, wanted.slice(position), known);
      }
      const key = `${photo.id}:${photo.version}`;
      const existing = known.get(key);
      if (existing) {
        // The picture stays; what is known about it may have been added since.
        const fresh = this.metadata(photo);
        if (
          JSON.stringify(comparable(existing)) !==
          JSON.stringify(comparable(fresh))
        )
          changed = true;
        // Pictures cached before corners were measured get them now, from the
        // copy on disk (no download).
        let lu = existing.lu;
        if (!lu && this.options.measure) {
          try {
            const bytes = await this.read(existing.id, 'main');
            if (bytes) lu = await this.options.measure(bytes);
          } catch {
            /* measured again next time */
          }
          if (lu) changed = true;
        }
        const kept: IndexEntry = {
          ...existing,
          ...fresh,
          ...(lu ? { lu } : {}),
        };
        if (!fresh.geo) delete kept.geo;
        next.push(kept);
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
          ...(processed.corners ? { lu: processed.corners } : {}),
        });
        changed = true;
        sinceCheckpoint += 1;
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

  /**
   * Writes and shows what one refresh has done so far: the pictures already
   * handled, the ones still to come that are cached from before, and those
   * that may be leaving (only a full pass removes anything).
   */
  private async checkpoint(
    done: IndexEntry[],
    rest: AlbumPhoto[],
    known: Map<string, IndexEntry>,
  ): Promise<void> {
    const list = [...done];
    const placed = new Set(done.map((entry) => entry.source));
    for (const photo of rest) {
      const entry = known.get(`${photo.id}:${photo.version}`);
      if (entry && !placed.has(entry.source)) {
        list.push(entry);
        placed.add(entry.source);
      }
    }
    for (const entry of this.entries)
      if (!placed.has(entry.source)) list.push(entry);
    await this.writeIndex(list);
    this.entries = list;
    this.options.insight?.sync(this.insightPhotos());
    this.updateRevision();
    for (const listener of this.listeners) listener();
  }

  private metadata(photo: AlbumPhoto): Metadata {
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
      ...(located ? { geo: [photo.latitude!, photo.longitude!] } : {}),
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
