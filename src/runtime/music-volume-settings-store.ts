import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  MusicVolumeSettingsSchema,
  type MusicVolumeSettings,
} from '../core/music-volume-settings.js';
import type { LugnEngine } from '../application/lugn-engine.js';

const StoreSchema = z
  .object({
    version: z.literal(1),
    settings: MusicVolumeSettingsSchema,
    generation: z.uuid().optional(),
  })
  .strict();
export class MusicVolumeSettingsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** One atomic, serialized settings document; unreadable preferences are never overwritten. */
export class MusicVolumeSettingsStore {
  private writable = true;
  private savedGeneration: string | undefined;

  get generation(): string | undefined {
    return this.savedGeneration;
  }
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly filePath: string,
    private readonly onWarning: (message: string) => void = () => undefined,
  ) {}

  async load(): Promise<MusicVolumeSettings | undefined> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const entry = await lstat(this.filePath);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 64 * 1024)
        throw new Error('Invalid settings file');
      handle = await open(
        this.filePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const info = await handle.stat();
      if (!info.isFile() || info.size > 64 * 1024)
        throw new Error('Invalid settings file');
      const document = StoreSchema.parse(
        JSON.parse(await handle.readFile('utf8')),
      );
      this.savedGeneration = document.generation;
      return document.settings;
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      )) {
        this.writable = false;
        this.onWarning(
          'Saved volume settings could not be read; using existing defaults. Saving is disabled.',
        );
      }
      return undefined;
    } finally {
      await handle?.close();
    }
  }

  save(
    engine: LugnEngine,
    input: MusicVolumeSettings,
    expectedSettings: MusicVolumeSettings,
  ): Promise<MusicVolumeSettings> {
    const operation = this.pending.then(async () => {
      const settings = MusicVolumeSettingsSchema.parse(input);
      const expected = MusicVolumeSettingsSchema.parse(expectedSettings);
      try {
        engine.validateMusicVolumeSettings(settings);
      } catch {
        throw new MusicVolumeSettingsError(
          400,
          'invalid_optical_offset_source',
        );
      }
      if (
        JSON.stringify(engine.getMusicVolumeSettings()) !==
        JSON.stringify(expected)
      )
        throw new MusicVolumeSettingsError(409, 'volume_settings_changed');
      if (!this.writable)
        throw new MusicVolumeSettingsError(503, 'volume_settings_save_failed');
      const enableIntentRevision = engine.getMusicVolumeEnableIntentRevision();
      const generation = randomUUID();
      const directory = dirname(this.filePath);
      const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error('Invalid directory');
        handle = await open(temporaryPath, 'wx', 0o600);
        await handle.writeFile(
          JSON.stringify(
            StoreSchema.parse({ version: 1, settings, generation }),
          ) + '\n',
        );
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
        // A remote press during preparation invalidates the proposed write,
        // even if multiple presses have returned enabled to its original value.
        if (
          engine.getMusicVolumeEnableIntentRevision() !==
            enableIntentRevision ||
          JSON.stringify(engine.getMusicVolumeSettings()) !==
            JSON.stringify(expected)
        )
          throw new MusicVolumeSettingsError(409, 'volume_settings_changed');
        await rename(temporaryPath, this.filePath);
        this.savedGeneration = generation;
        // Rename commits the preferences. Publish their generation before any
        // cleanup/directory-sync awaits; a press during rename keeps authority.
        engine.applyMusicVolumeSettings(
          settings,
          generation,
          enableIntentRevision,
        );
      } catch (error) {
        if (error instanceof MusicVolumeSettingsError) throw error;
        throw new MusicVolumeSettingsError(503, 'volume_settings_save_failed');
      } finally {
        await handle?.close().catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
      }
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
          this.onWarning('Volume settings saved, but directory sync failed.');
        } finally {
          await directoryHandle?.close().catch(() => undefined);
        }
      }
      return engine.getMusicVolumeSettings();
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
}
