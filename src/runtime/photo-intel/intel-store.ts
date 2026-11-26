import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/**
 * What the photo brain on Kuffe says about the pictures (the intel bundle,
 * `docs/PHOTO-BRAIN.md`). It arrives whole over `PUT /photo-brain/v1/intel`,
 * is checked field by field, kept in memory and written atomically next to the
 * cached pictures, so a restart (or Kuffe being away) keeps the last word.
 */

export const MAX_BUNDLE_PHOTOS = 20_000;
export const MAX_FACES = 64;
export const MAX_CANDIDATES = 64;
const MAX_TRIPS = 2_000;
const MAX_EVENTS = 20_000;

const PictureId = z.string().regex(/^[A-Za-z0-9_-]{24}$/);
const Fraction = z.number().min(0).max(1);
const Percent = z.number().min(0).max(100);
const Score = z.number().int().min(-1).max(100);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Millis = z.number().int().min(0).max(8.64e15);
const Label = (max: number) => z.string().max(max);

const FaceSchema = z.object({
  x: Fraction,
  y: Fraction,
  w: Fraction,
  h: Fraction,
  score: Fraction,
  front: Fraction,
  q: Percent,
  /** `p3`: an existing person; `n7`: a new group of faces that agree. */
  p: z
    .string()
    .regex(/^[pn]\d{1,6}$/)
    .nullable()
    .optional(),
});

const PhotoIntelSchema = z.object({
  v: Label(256),
  scene: z
    .array(z.tuple([z.string().regex(/^[a-z0-9_-]{1,64}$/), Fraction]))
    .max(8)
    .default([]),
  q: z
    .object({
      sharp: Percent,
      dark: Percent,
      /** `screenshot`, `document` or null; any other word counts as junk too. */
      junk: Label(32).nullable(),
    })
    .default({ sharp: 100, dark: 0, junk: null }),
  fav: z.number().int().min(0).max(1).nullable().optional(),
  cap: Label(500).nullable().optional(),
  faces: z.array(FaceSchema).max(MAX_FACES).default([]),
  trip: z.number().int().min(0).max(MAX_TRIPS).nullable().optional(),
  event: Label(64).nullable().optional(),
  /** `[id, base, time, place, look]`, 0–100, -1 unknown; best first. */
  cand: z
    .array(z.tuple([PictureId, Score, Score, Score, Score]))
    .max(MAX_CANDIDATES)
    .default([]),
  du: z.array(PictureId).max(MAX_CANDIDATES).default([]),
});

export const IntelBundleSchema = z.object({
  schema: z.literal(1),
  generatedAt: Millis,
  brain: z.object({
    version: Label(64),
    models: z.record(Label(32), Label(200)).optional(),
    faceDim: z.number().int().min(0).max(8192).optional(),
  }),
  home: z
    .object({
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
    })
    .nullable()
    .default(null),
  trips: z
    .array(
      z.object({
        title: Label(120),
        from: Day,
        to: Day,
        cc: z
          .string()
          .regex(/^[A-Z]{2}$/)
          .nullable(),
      }),
    )
    .max(MAX_TRIPS)
    .default([]),
  events: z
    .array(
      z.object({
        id: Label(64),
        from: Millis,
        to: Millis,
        count: z.number().int().min(0).max(MAX_BUNDLE_PHOTOS),
      }),
    )
    .max(MAX_EVENTS)
    .default([]),
  photos: z.record(PictureId, PhotoIntelSchema),
});

export type IntelBundle = z.infer<typeof IntelBundleSchema>;
export type PhotoIntel = z.infer<typeof PhotoIntelSchema>;
export type IntelFace = z.infer<typeof FaceSchema>;

export class IntelError extends Error {
  constructor(
    readonly code: 'invalid_bundle' | 'too_many_photos',
    message: string,
    readonly issues: Array<{ path: string; message: string }> = [],
  ) {
    super(message);
    this.name = 'IntelError';
  }
}

/** Checks a bundle; throws `IntelError` with at most a few issues. */
export function parseBundle(input: unknown): IntelBundle {
  // Count before the field-by-field check, so an oversized bundle fails fast.
  const photos = (input as { photos?: unknown } | null)?.photos;
  if (
    photos &&
    typeof photos === 'object' &&
    Object.keys(photos).length > MAX_BUNDLE_PHOTOS
  )
    throw new IntelError(
      'too_many_photos',
      `a bundle holds at most ${MAX_BUNDLE_PHOTOS} pictures`,
    );
  const parsed = IntelBundleSchema.safeParse(input);
  if (!parsed.success)
    throw new IntelError(
      'invalid_bundle',
      'the bundle does not match schema 1',
      parsed.error.issues.slice(0, 10).map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    );
  return parsed.data;
}

type IntelFile = { version: 1; receivedAt: number; bundle: IntelBundle };

export class IntelStore {
  private bundle: IntelBundle | null = null;
  private entries = new Map<string, PhotoIntel>();
  private received: number | null = null;
  /** Puts are written one after the other. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly warn: (message: string) => void = () => undefined,
  ) {}

  /** Reads the last bundle; a missing or damaged file means none yet. */
  async load(): Promise<void> {
    this.set(null, null);
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.warn(
          `photo brain result unreadable: ${error instanceof Error ? error.message : String(error)}`,
        );
      return;
    }
    try {
      const file = JSON.parse(text) as Partial<IntelFile>;
      if (file.version !== 1 || typeof file.receivedAt !== 'number')
        throw new Error('unknown file version');
      this.set(parseBundle(file.bundle), file.receivedAt);
    } catch (error) {
      // Never stops the frame: the next bundle from Kuffe replaces it.
      this.warn(
        `photo brain result ignored, waiting for a new one: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Replaces the bundle and writes it to disk. `known` holds the library's
   * picture ids; entries for other ids are kept (the picture may arrive later)
   * but counted as unknown. A picture id encodes its version, so `v` is not
   * compared.
   */
  async put(
    input: unknown,
    known: ReadonlySet<string>,
    receivedAt: number,
  ): Promise<{ accepted: number; unknown: number }> {
    const bundle = parseBundle(input);
    let accepted = 0;
    for (const id of Object.keys(bundle.photos))
      if (known.has(id)) accepted += 1;
    const done = this.queue.then(async () => {
      await this.write({ version: 1, receivedAt, bundle });
      this.set(bundle, receivedAt);
    });
    this.queue = done.catch(() => undefined);
    await done;
    return { accepted, unknown: Object.keys(bundle.photos).length - accepted };
  }

  get(id: string): PhotoIntel | undefined {
    return this.entries.get(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** When the last bundle arrived (ms), or null before the first. */
  receivedAt(): number | null {
    return this.received;
  }

  trips(): IntelBundle['trips'] {
    return this.bundle?.trips ?? [];
  }

  home(): { lat: number; lon: number } | null {
    return this.bundle?.home ?? null;
  }

  private set(bundle: IntelBundle | null, receivedAt: number | null): void {
    this.bundle = bundle;
    this.received = receivedAt;
    this.entries = new Map(Object.entries(bundle?.photos ?? {}));
  }

  private async write(file: IntelFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = join(dirname(this.path), `.intel.${process.pid}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(file), { mode: 0o600 });
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
