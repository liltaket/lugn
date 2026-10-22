import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  CameraError,
  CameraSettingsSchema,
  CameraSettingsDocumentSchema,
  type CameraSettings,
  type CameraSettingsDocument,
} from '../core/cameras.js';

export { CameraError } from '../core/cameras.js';

/** Single-process owner, serialized optimistic edits; corrupt documents are never overwritten. */
export class CameraSettingsStore {
  private document: CameraSettingsDocument;
  private writable = true;
  private loaded = false;
  private loading: Promise<CameraSettingsDocument> | undefined;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly filePath: string,
    defaults: CameraSettings = {
      enabled: false,
      automaticEnabled: false,
      durationSeconds: 30,
      cameras: {},
      triggers: {},
      viewers: ['bed', 'desk', 'web'],
    },
    private readonly onWarning: (message: string) => void = () => undefined,
  ) {
    this.document = CameraSettingsDocumentSchema.parse({
      version: 1,
      generation: randomUUID(),
      settings: defaults,
    });
  }
  snapshot(): CameraSettingsDocument {
    return structuredClone(this.document);
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  load(): Promise<CameraSettingsDocument> {
    if (this.loaded) return Promise.resolve(this.snapshot());
    this.loading ??= this.read();
    return this.loading;
  }
  private async read(): Promise<CameraSettingsDocument> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const stat = await lstat(this.filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
        throw new Error('Invalid camera file');
      handle = await open(
        this.filePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const info = await handle.stat();
      if (!info.isFile() || info.size > 1024 * 1024)
        throw new Error('Invalid camera file');
      const text = await handle.readFile('utf8');
      if (Buffer.byteLength(text) > 1024 * 1024)
        throw new Error('Invalid camera file');
      this.document = CameraSettingsDocumentSchema.parse(JSON.parse(text));
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      )) {
        this.writable = false;
        this.onWarning('Saved cameras could not be read. Saving is disabled.');
      }
    } finally {
      await handle?.close();
      this.loaded = true;
    }
    return this.snapshot();
  }
  save(
    input: unknown,
    expectedGeneration: string,
  ): Promise<CameraSettingsDocument> {
    const settings = CameraSettingsSchema.parse(input);
    return this.edit(expectedGeneration, settings);
  }
  private edit(
    expected: string,
    settings: CameraSettings,
  ): Promise<CameraSettingsDocument> {
    const operation = this.pending.then(async () => {
      if (!this.loaded || !this.writable)
        throw new CameraError(503, 'camera_store_unavailable');
      if (expected !== this.document.generation)
        throw new CameraError(409, 'cameras_changed');
      const document = CameraSettingsDocumentSchema.parse({
        version: 1,
        generation: randomUUID(),
        settings,
      });
      const serialized = JSON.stringify(document) + '\n';
      if (Buffer.byteLength(serialized) > 1024 * 1024)
        throw new CameraError(400, 'camera_store_too_large');
      const directory = dirname(this.filePath);
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error('Invalid directory');
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(serialized);
        await handle.sync();
        await handle.close();
        handle = undefined;
        const current = await lstat(directory);
        if (
          current.isSymbolicLink() ||
          info.dev !== current.dev ||
          info.ino !== current.ino
        )
          throw new Error('Directory changed');
        try {
          const target = await lstat(this.filePath);
          if (!target.isFile() || target.isSymbolicLink())
            throw new Error('Invalid target');
        } catch (error) {
          if (!(
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          ))
            throw error;
        }
        await rename(temporary, this.filePath);
        this.document = document;
        for (const listener of this.listeners) {
          try {
            listener();
          } catch {
            this.onWarning('Camera subscriber failed.');
          }
        }
      } catch {
        throw new CameraError(503, 'camera_save_failed');
      } finally {
        await handle?.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
      }
      let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        directoryHandle = await open(
          directory,
          constants.O_RDONLY |
            (constants.O_DIRECTORY ?? 0) |
            (constants.O_NOFOLLOW ?? 0),
        );
        await directoryHandle.sync();
      } catch {
        this.onWarning('Cameras saved, but directory sync failed.');
      } finally {
        await directoryHandle?.close().catch(() => undefined);
      }
      return this.snapshot();
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
}
