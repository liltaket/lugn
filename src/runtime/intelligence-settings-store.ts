import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  defaultIntelligenceSettings,
  IntelligenceError,
  IntelligenceSettingsSchema,
  type IntelligenceSettings,
  type IntelligenceSettingsDocument,
  type IntelligenceSettingsRepository,
} from '../core/intelligence.js';

const StoreSchema = z
  .object({
    version: z.literal(1),
    generation: z.uuid(),
    settings: IntelligenceSettingsSchema,
  })
  .strict();
const MAX_BYTES = 64 * 1024;
/** Call load before wiring the service. Invalid existing preferences fail closed, never overwritten. */
export class IntelligenceSettingsStore implements IntelligenceSettingsRepository {
  private document: IntelligenceSettingsDocument = {
    settings: defaultIntelligenceSettings(),
    generation: randomUUID(),
  };
  private loaded = false;
  private writable = true;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly filePath: string,
    private readonly onWarning: (message: string) => void = () => undefined,
  ) {}
  snapshot(): IntelligenceSettingsDocument {
    return structuredClone(this.document);
  }
  load(): Promise<IntelligenceSettingsDocument> {
    const operation = this.pending.then(() => this.loadDocument());
    this.pending = operation.catch(() => undefined);
    return operation;
  }
  private async loadDocument(): Promise<IntelligenceSettingsDocument> {
    if (this.loaded) return this.snapshot();
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const info = await lstat(this.filePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES)
        throw new Error('Invalid settings file');
      handle = await open(
        this.filePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_BYTES)
        throw new Error('Invalid settings file');
      const { settings, generation } = StoreSchema.parse(
        JSON.parse(await handle.readFile('utf8')),
      );
      this.document = { settings, generation };
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      )) {
        this.writable = false;
        this.onWarning(
          'Saved intelligence settings could not be read; disabled defaults are active and saving is blocked.',
        );
      }
    } finally {
      await handle?.close();
      this.loaded = true;
    }
    return this.snapshot();
  }
  save(
    input: IntelligenceSettings,
    expectedGeneration: string,
  ): Promise<IntelligenceSettingsDocument> {
    // Capture input before enqueueing so a caller cannot mutate a pending save.
    const settings = IntelligenceSettingsSchema.parse(input);
    const operation = this.pending.then(async () => {
      if (!this.loaded || !this.writable)
        throw new IntelligenceError(503, 'intelligence_settings_save_failed');
      if (this.document.generation !== expectedGeneration)
        throw new IntelligenceError(409, 'intelligence_settings_changed');
      const generation = randomUUID();
      const text =
        JSON.stringify(
          StoreSchema.parse({ version: 1, settings, generation }),
        ) + '\n';
      if (Buffer.byteLength(text) > MAX_BYTES)
        throw new IntelligenceError(400, 'intelligence_settings_too_large');
      const directory = dirname(this.filePath);
      const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error('Invalid directory');
        handle = await open(temporaryPath, 'wx', 0o600);
        await handle.writeFile(text, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        const current = await lstat(directory);
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          current.dev !== info.dev ||
          current.ino !== info.ino
        )
          throw new Error('Directory changed');
        await rename(temporaryPath, this.filePath);
        this.document = { settings, generation };
        if (process.platform !== 'win32') {
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
            this.onWarning(
              'Intelligence settings saved, but directory sync failed.',
            );
          } finally {
            await directoryHandle?.close().catch(() => undefined);
          }
        }
      } catch {
        throw new IntelligenceError(503, 'intelligence_settings_save_failed');
      } finally {
        await handle?.close().catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
      }
      return this.snapshot();
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
}
