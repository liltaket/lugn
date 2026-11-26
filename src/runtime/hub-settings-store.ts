import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { HubSettingsSchema, type HubSettings } from '../core/hub-settings.js';

const StoreSchema = z
  .object({ version: z.literal(1), settings: HubSettingsSchema })
  .strict();
const MAX_BYTES = 16 * 1024;

export class HubSettingsStoreError extends Error {
  constructor() {
    super('hub_settings_save_failed');
  }
}

/** One atomic, serialized settings file; an unreadable one is never overwritten. */
export class HubSettingsStore {
  private writable = true;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly onWarning: (message: string) => void = () => undefined,
  ) {}

  async load(): Promise<HubSettings | undefined> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const entry = await lstat(this.filePath);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_BYTES)
        throw new Error('Invalid settings file');
      handle = await open(
        this.filePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
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
          'Saved Hub settings could not be read; defaults are active and saving is blocked.',
        );
      }
      return undefined;
    } finally {
      await handle?.close();
    }
  }

  save(input: HubSettings): Promise<HubSettings> {
    // Parse before queueing so a caller cannot mutate a pending save.
    const settings = HubSettingsSchema.parse(input);
    const operation = this.pending.then(async () => {
      if (!this.writable) throw new HubSettingsStoreError();
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
          current.dev !== info.dev ||
          current.ino !== info.ino
        )
          throw new Error('Directory changed');
        await rename(temporaryPath, this.filePath);
      } catch {
        throw new HubSettingsStoreError();
      } finally {
        await handle?.close().catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
      }
      return settings;
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
}
