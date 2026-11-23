import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { decodeVector, encodeVector } from './vectors.js';

export const CLIP_DIM = 512;
export const FACE_DIM = 128;

export type StoredFace = {
  /** Box as fractions of the picture. */
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  front: number;
  embedding: Float32Array;
};
export type PhotoAnalysisRecord = {
  embedding: Float32Array;
  faces: StoredFace[];
  at: number;
};

type FileFace = Omit<StoredFace, 'embedding'> & { e: string };
type FileRecord = { e: string; f: FileFace[]; at: number };
type AnalysisFile = {
  version: 1;
  model: string;
  photos: Record<string, FileRecord>;
};

const ID = /^[A-Za-z0-9_-]{24}$/;

/**
 * What the models said about each picture, kept next to the pictures. A record
 * is made once per picture (its id changes when the picture does) and only
 * thrown away when the picture leaves the library or the models change.
 */
export class AnalysisStore {
  private records = new Map<string, PhotoAnalysisRecord>();
  private failures = new Map<string, number>();
  private dirty = false;
  private model = '';

  constructor(
    private readonly path: string,
    private readonly modelVersion: string,
    private readonly warn: (message: string) => void = () => undefined,
  ) {
    this.model = modelVersion;
  }

  async load(): Promise<void> {
    this.records.clear();
    try {
      const parsed = JSON.parse(
        await readFile(this.path, 'utf8'),
      ) as AnalysisFile;
      // Another model version means other numbers: start again, once.
      if (parsed.version !== 1 || parsed.model !== this.modelVersion) return;
      for (const [id, record] of Object.entries(parsed.photos ?? {})) {
        if (!ID.test(id)) continue;
        const embedding = decodeVector(record.e, CLIP_DIM);
        if (!embedding || !Array.isArray(record.f)) continue;
        const faces: StoredFace[] = [];
        for (const face of record.f) {
          const faceEmbedding = decodeVector(face.e, FACE_DIM);
          if (faceEmbedding)
            faces.push({
              x: face.x,
              y: face.y,
              w: face.w,
              h: face.h,
              score: face.score,
              front: face.front,
              embedding: faceEmbedding,
            });
        }
        this.records.set(id, { embedding, faces, at: Number(record.at) || 0 });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.warn(
          `photo analysis cache unreadable, starting again: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
  }

  has(id: string): boolean {
    return this.records.has(id);
  }
  get(id: string): PhotoAnalysisRecord | undefined {
    return this.records.get(id);
  }
  get size(): number {
    return this.records.size;
  }
  ids(): string[] {
    return [...this.records.keys()];
  }

  put(id: string, record: PhotoAnalysisRecord): void {
    this.records.set(id, record);
    this.failures.delete(id);
    this.dirty = true;
  }

  noteFailure(id: string): number {
    const count = (this.failures.get(id) ?? 0) + 1;
    this.failures.set(id, count);
    return count;
  }
  failureCount(id: string): number {
    return this.failures.get(id) ?? 0;
  }

  /** Forgets pictures that are no longer in the library. */
  retain(ids: Set<string>): boolean {
    let removed = false;
    for (const id of [...this.records.keys()])
      if (!ids.has(id)) {
        this.records.delete(id);
        removed = true;
      }
    for (const id of [...this.failures.keys()])
      if (!ids.has(id)) this.failures.delete(id);
    if (removed) this.dirty = true;
    return removed;
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    const photos: Record<string, FileRecord> = {};
    for (const [id, record] of this.records)
      photos[id] = {
        e: encodeVector(record.embedding),
        at: record.at,
        f: record.faces.map((face) => ({
          x: face.x,
          y: face.y,
          w: face.w,
          h: face.h,
          score: face.score,
          front: face.front,
          e: encodeVector(face.embedding),
        })),
      };
    const file: AnalysisFile = { version: 1, model: this.model, photos };
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = join(dirname(this.path), `.analysis.${process.pid}.tmp`);
    await writeFile(temporary, JSON.stringify(file), { mode: 0o600 });
    await rename(temporary, this.path);
    this.dirty = false;
  }
}
