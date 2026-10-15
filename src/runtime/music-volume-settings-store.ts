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
  .object({ version: z.literal(1), settings: MusicVolumeSettingsSchema })
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
      return StoreSchema.parse(JSON.parse(await handle.readFile('utf8')))
        .settings;
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
      if (
        JSON.stringify(engine.getMusicVolumeSettings()) !==
        JSON.stringify(expected)
      )
        throw new MusicVolumeSettingsError(409, 'volume_settings_changed');
      if (!this.writable)
        throw new MusicVolumeSettingsError(503, 'volume_settings_save_failed');
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
          JSON.stringify(StoreSchema.parse({ version: 1, settings })) + '\n',
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
        await rename(temporaryPath, this.filePath);
      } catch {
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
      engine.applyMusicVolumeSettings(settings);
      return engine.getMusicVolumeSettings();
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
}
