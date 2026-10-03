import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import {
  LightingIntentSnapshotSchema,
  SemanticLightingIdSchema,
  SceneSchema,
  type LightingIntentSnapshot,
} from '../core/schemas.js';

const currentVersion = 1;
const maxSnapshotBytes = 1024 * 1024;
const defaultDebounceMs = 150;

const VersionedSnapshotSchema = z
  .object({
    version: z.literal(currentVersion),
    snapshot: LightingIntentSnapshotSchema,
  })
  .strict();

export type LightingIntentStoreStream = {
  subscribe(listener: (update: { domains: string[] }) => void): () => void;
};

export type LightingIntentSource = {
  getLightingIntentSnapshot(): LightingIntentSnapshot;
  stream: LightingIntentStoreStream;
};

export type LightingIntentStoreOptions = {
  /** Path to the private, versioned lighting intent file. */
  filePath: string;
  /** Configured semantic lighting IDs; persisted IDs must match this set. */
  expectedDeviceIds: readonly string[];
  /** Scene IDs accepted by the active configuration. */
  knownSceneIds: readonly string[];
  debounceMs?: number;
  /** Receives generic messages only; paths, values, and OS errors are redacted. */
  onWarning?: (message: string) => void;
};

/**
 * Persists only the engine's logical lighting intent. Observations, presence
 * measurements, and command history are deliberately excluded by the snapshot
 * type and its runtime schema.
 */
export class LightingIntentStore {
  private readonly expectedDeviceIds: Set<string>;
  private readonly knownSceneIds: Set<string>;
  private readonly debounceMs: number;
  private readonly warn: (message: string) => void;
  private unsubscribe: (() => void) | undefined;
  private source: LightingIntentSource | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private writeInFlight: Promise<void> = Promise.resolve();
  private dirty = false;
  private stopped = false;

  constructor(private readonly options: LightingIntentStoreOptions) {
    this.expectedDeviceIds = new Set(options.expectedDeviceIds);
    this.knownSceneIds = new Set(options.knownSceneIds);
    this.debounceMs = options.debounceMs ?? defaultDebounceMs;
    const warningSink =
      options.onWarning ?? ((message: string) => console.warn(message));
    this.warn = (message) => {
      try {
        warningSink(message);
      } catch {
        // A logging callback must not break state loading or persistence.
      }
    };

    if (
      this.expectedDeviceIds.size !== options.expectedDeviceIds.length ||
      [...this.expectedDeviceIds].some(
        (id) => !SemanticLightingIdSchema.safeParse(id).success,
      )
    ) {
      throw new Error('Lighting intent store device IDs are invalid');
    }
    if (
      this.knownSceneIds.size !== options.knownSceneIds.length ||
      [...this.knownSceneIds].some(
        (id) => !SceneSchema.shape.id.safeParse(id).success,
      )
    ) {
      throw new Error('Lighting intent store scene IDs are invalid');
    }
    if (!Number.isFinite(this.debounceMs) || this.debounceMs < 0) {
      throw new Error('Lighting intent store debounce is invalid');
    }
  }

  /** Load and validate a prior intent snapshot; invalid or absent state is ignored. */
  async load(): Promise<LightingIntentSnapshot | undefined> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      // lstat rejects symlinks before opening. O_NOFOLLOW closes the race on
      // platforms that support it, while fstat verifies the opened object.
      const linkInfo = await lstat(this.options.filePath);
      if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) {
        this.warn(
          'Lugn lighting intent state is not a regular file; ignoring it.',
        );
        return undefined;
      }
      const noFollow = constants.O_NOFOLLOW ?? 0;
      handle = await open(this.options.filePath, constants.O_RDONLY | noFollow);
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxSnapshotBytes) {
        this.warn('Lugn lighting intent state is invalid; ignoring it.');
        return undefined;
      }
      const text = await handle.readFile('utf8');
      let raw: unknown;
      try {
        raw = JSON.parse(text) as unknown;
      } catch {
        this.warn('Lugn lighting intent state is invalid; ignoring it.');
        return undefined;
      }
      const parsed = VersionedSnapshotSchema.safeParse(raw);
      if (!parsed.success || !this.matchesConfiguredIds(parsed.data.snapshot)) {
        this.warn('Lugn lighting intent state is invalid; ignoring it.');
        return undefined;
      }
      return structuredClone(parsed.data.snapshot);
    } catch (error) {
      this.warn(
        isMissingFile(error)
          ? 'Lugn lighting intent state is missing; starting without a saved snapshot.'
          : 'Lugn lighting intent state could not be read; starting without a saved snapshot.',
      );
      return undefined;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /** Begin listening for logical lighting and presence changes. */
  start(source: LightingIntentSource): void {
    if (this.stopped) throw new Error('Lighting intent store has stopped');
    if (this.unsubscribe) {
      if (this.source !== source)
        throw new Error('Lighting intent store is already connected');
      return;
    }
    this.source = source;
    this.unsubscribe = source.stream.subscribe((update) => {
      if (
        update.domains.includes('lighting') ||
        update.domains.includes('presence')
      )
        this.scheduleWrite();
    });
  }

  /** Write the latest intent now, waiting for any previous atomic write. */
  async flush(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    // If an update arrives while a write is in progress, flush again with the
    // newest snapshot rather than allowing that update to be lost.
    while (this.dirty) {
      this.dirty = false;
      const next = this.writeInFlight.then(() => this.writeSnapshot());
      this.writeInFlight = next.catch(() => undefined);
      await next.catch(() => undefined);
    }
    await this.writeInFlight.catch(() => undefined);
  }

  /** Stop observing updates and flush the last pending snapshot. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.flush();
  }

  private scheduleWrite(): void {
    if (this.stopped) return;
    this.dirty = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.flush();
    }, this.debounceMs);
  }

  private async writeSnapshot(): Promise<void> {
    let temporaryPath: string | undefined;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
    let renamed = false;
    try {
      const snapshot = this.validateSnapshot(
        this.source?.getLightingIntentSnapshot(),
      );
      if (!snapshot) {
        this.warn(
          'Lugn lighting intent snapshot is invalid; it was not saved.',
        );
        return;
      }

      const directory = dirname(this.options.filePath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const directoryInfo = await lstat(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
        this.warn(
          'Lugn lighting intent directory is invalid; state was not saved.',
        );
        return;
      }
      directoryHandle = await open(
        directory,
        constants.O_RDONLY |
          (constants.O_DIRECTORY ?? 0) |
          (constants.O_NOFOLLOW ?? 0),
      );
      const openedDirectoryInfo = await directoryHandle.stat();
      if (
        !openedDirectoryInfo.isDirectory() ||
        openedDirectoryInfo.dev !== directoryInfo.dev ||
        openedDirectoryInfo.ino !== directoryInfo.ino
      ) {
        this.warn(
          'Lugn lighting intent directory changed; state was not saved.',
        );
        return;
      }
      await directoryHandle.chmod(0o700);

      temporaryPath = join(
        directory,
        `.${basename(this.options.filePath)}.${process.pid}.${randomUUID()}.tmp`,
      );
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(
        `${JSON.stringify({ version: currentVersion, snapshot })}\n`,
        'utf8',
      );
      await handle.sync();
      await handle.close();
      handle = undefined;
      const currentDirectoryInfo = await lstat(directory);
      if (
        !currentDirectoryInfo.isDirectory() ||
        currentDirectoryInfo.isSymbolicLink() ||
        currentDirectoryInfo.dev !== openedDirectoryInfo.dev ||
        currentDirectoryInfo.ino !== openedDirectoryInfo.ino
      ) {
        this.warn(
          'Lugn lighting intent directory changed; state was not saved.',
        );
        return;
      }
      await rename(temporaryPath, this.options.filePath);
      temporaryPath = undefined;
      renamed = true;
      try {
        await directoryHandle.sync();
      } catch {
        this.warn(
          'Lugn lighting intent state was saved, but directory sync failed.',
        );
      }
    } catch {
      this.warn(
        renamed
          ? 'Lugn lighting intent state was saved, but directory sync failed.'
          : 'Lugn lighting intent state could not be saved.',
      );
    } finally {
      await handle?.close().catch(() => undefined);
      await directoryHandle?.close().catch(() => undefined);
      if (temporaryPath) await unlink(temporaryPath).catch(() => undefined);
    }
  }

  private validateSnapshot(value: unknown): LightingIntentSnapshot | undefined {
    const parsed = LightingIntentSnapshotSchema.safeParse(value);
    if (!parsed.success || !this.matchesConfiguredIds(parsed.data))
      return undefined;
    return parsed.data;
  }

  private matchesConfiguredIds(snapshot: LightingIntentSnapshot): boolean {
    const deviceIds = Object.keys(snapshot.devices);
    if (
      deviceIds.length !== this.expectedDeviceIds.size ||
      deviceIds.some((id) => !this.expectedDeviceIds.has(id))
    ) {
      return false;
    }
    return (
      snapshot.currentScene === null ||
      this.knownSceneIds.has(snapshot.currentScene)
    );
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
