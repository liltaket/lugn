import { createHash } from 'node:crypto';
import { join } from 'node:path';
import sharp from 'sharp';
import type { AlbumPhotoDetails } from '../icloud-shared-album.js';
import { AnalysisStore } from './analysis-store.js';
import {
  PhotoAnalyzer,
  type AnalyzerStatus,
  type SpawnWorker,
} from './analyzer.js';
import {
  groupPhotos,
  loadScenes,
  type GroupingInput,
  type PhotoExtras,
  type SceneVocabulary,
  type Trip,
} from './grouping.js';
import { MODELS, MODEL_VERSION, findModels } from './models.js';
import {
  PeopleError,
  PeopleStore,
  faceKey,
  isFaceId,
  type FaceRef,
  type MoveTarget,
  type PeopleView,
} from './people.js';

/** A cached picture as the intelligence sees it. */
export type InsightPhoto = {
  id: string;
  t: number | null;
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
  /** The models are installed and the analysis may run. */
  available: boolean;
  reason: string | null;
  analyzer: AnalyzerStatus;
  photos: number;
  analysed: number;
  faces: number;
  modelsDir: string;
  missingModels: string[];
};

export type InsightOptions = {
  cacheDir: string;
  modelsDir: string;
  enabled: boolean;
  home?: { lat: number; lon: number } | undefined;
  /** The cached picture's bytes (any variant the library keeps); null if gone. */
  readPhoto: (id: string) => Promise<Uint8Array | null>;
  spawn?: SpawnWorker;
  scenes?: SceneVocabulary | null;
  pauseMs?: number;
  idleMs?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  /** Test seam for the debounce of file writes. */
  saveDelayMs?: number;
};

const CROP_MARGIN = 0.35;
const CROP_SIZE = 112;

/**
 * Everything the photo frame knows beyond the picture itself: what the
 * models saw, who the faces are, and which pictures belong together. The
 * library hands it the cached pictures; it hands back a short list per
 * picture for the Hubs and an API for the household's corrections.
 */
export class PhotoInsight {
  private readonly analysis: AnalysisStore;
  private readonly people: PeopleStore;
  private readonly analyzer: PhotoAnalyzer;
  private readonly scenes: SceneVocabulary | null;
  private photos: InsightPhoto[] = [];
  private version = 0;
  private cache: { key: string; value: InsightExtras } | null = null;
  private readonly listeners = new Set<() => void>();
  private saveTimer: NodeJS.Timeout | undefined;
  private modelState: {
    available: boolean;
    reason: string | null;
    missing: string[];
  } = {
    available: false,
    reason: null,
    missing: [],
  };
  private disposed = false;

  constructor(private readonly options: InsightOptions) {
    const warn = options.warn ?? (() => undefined);
    this.analysis = new AnalysisStore(
      join(options.cacheDir, 'analysis.json'),
      MODEL_VERSION,
      warn,
    );
    this.people = new PeopleStore(join(options.cacheDir, 'people.json'), warn);
    this.scenes = options.scenes === undefined ? loadScenes() : options.scenes;
    this.analyzer = new PhotoAnalyzer({
      store: this.analysis,
      pathOf: (id) => join(options.cacheDir, `${id}.jpg`),
      models: async () => {
        const found = await findModels(options.modelsDir);
        this.modelState = {
          available: found.paths !== null,
          reason:
            found.paths === null
              ? `models missing in ${options.modelsDir}: ${found.missing.join(', ')}`
              : null,
          missing: found.missing,
        };
        return { paths: found.paths, reason: this.modelState.reason };
      },
      ...(options.spawn ? { spawn: options.spawn } : {}),
      ...(options.pauseMs === undefined ? {} : { pauseMs: options.pauseMs }),
      ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
      onChange: () => this.analysisChanged(),
      ...(options.log ? { log: options.log } : {}),
      warn,
    });
  }

  async start(): Promise<void> {
    await this.analysis.load();
    await this.people.load();
    const found = await findModels(this.options.modelsDir);
    this.modelState = {
      available: found.paths !== null,
      reason:
        found.paths === null
          ? `models missing in ${this.options.modelsDir}: ${found.missing.join(', ')}`
          : null,
      missing: found.missing,
    };
    this.regroup();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.saveTimer);
    this.analyzer.dispose();
    this.listeners.clear();
    void this.flush();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Changes whenever what a Hub would be told changes. */
  revision(): string {
    return `${this.version}`;
  }

  /** The library's pictures changed (or were loaded): analyse what is new. */
  sync(photos: InsightPhoto[]): void {
    if (this.disposed) return;
    this.photos = photos;
    const live = new Set(photos.map((p) => p.id));
    this.analysis.retain(live);
    this.analyzer.forget(live);
    if (this.options.enabled) this.analyzer.enqueue(photos.map((p) => p.id));
    this.regroup();
    this.bump(false);
  }

  /** The listing's extras, in the order of `photos` as last synced. */
  decorate(): InsightExtras {
    const key = `${this.version}:${this.photos.map((p) => p.id).join(',')}`;
    if (this.cache?.key === key) return this.cache.value;
    const inputs: GroupingInput[] = this.photos.map((photo) => ({
      id: photo.id,
      t: photo.t,
      lat: photo.lat,
      lon: photo.lon,
      place: photo.place,
      cc: photo.cc,
      utcOffsetSeconds: photo.utcOffsetSeconds,
      details: photo.details,
      embedding: this.analysis.get(photo.id)?.embedding,
      people: this.peopleByPhoto.get(photo.id) ?? [],
    }));
    const result = groupPhotos(inputs, {
      scenes: this.scenes,
      home: this.options.home ?? null,
    });
    const seen = new Set<string>();
    for (const extra of result.extras)
      for (const id of extra.pp ?? []) seen.add(id);
    const value: InsightExtras = {
      extras: result.extras,
      trips: result.trips,
      people: [...seen]
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
        .map((id) => ({ id, name: this.people.nameOf(id) })),
      scenes: this.scenes?.names ?? {},
      ai: this.analysis.size > 0,
    };
    this.cache = { key, value };
    return value;
  }

  status(): InsightStatus {
    const analyzer = this.analyzer.status();
    let faces = 0;
    for (const id of this.analysis.ids())
      faces += this.analysis.get(id)!.faces.length;
    return {
      available: this.modelState.available && this.options.enabled,
      reason: !this.options.enabled
        ? 'Bildanalysen är avstängd i inställningarna.'
        : this.modelState.reason,
      analyzer,
      photos: this.photos.length,
      analysed: this.photos.filter((p) => this.analysis.has(p.id)).length,
      faces,
      modelsDir: this.options.modelsDir,
      missingModels: this.modelState.missing,
    };
  }

  // ── People (the household's corrections) ──

  /** Cheap numbers for the panel's settings list. */
  summary(): { people: number; pending: number } {
    return {
      people: this.people.activeCount(),
      pending: this.analyzer.status().pending,
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
      const { x, y, w, h } = ref.face;
      const side = Math.max(w * width, h * height) * (1 + 2 * CROP_MARGIN);
      const cx = (x + w / 2) * width;
      const cy = (y + h / 2) * height;
      const size = Math.min(Math.round(side), width, height);
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

  private peopleByPhoto = new Map<string, string[]>();

  private regroup(): void {
    const faces: FaceRef[] = [];
    for (const photo of this.photos) {
      const record = this.analysis.get(photo.id);
      record?.faces.forEach((face, index) =>
        faces.push({ id: faceKey(photo.id, index), photoId: photo.id, face }),
      );
    }
    this.people.regroup(faces);
    this.peopleByPhoto = this.people.peopleByPhoto();
  }

  private analysisChanged(): void {
    this.regroup();
    this.bump(true);
  }

  private changed(): void {
    // A correction reshuffles who is in which picture at once.
    this.peopleByPhoto = this.people.peopleByPhoto();
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
      await this.analysis.save();
      await this.people.save();
    } catch (error) {
      this.options.warn?.(
        `photo analysis could not be saved: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Hash of what is installed; handy in logs. */
  static modelFiles(): string {
    return createHash('sha256')
      .update(MODELS.map((m) => m.sha256).join(','))
      .digest('hex')
      .slice(0, 12);
  }
}

export { PeopleError };
