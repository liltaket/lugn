import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  OpticalSwitchSettingsError,
  OpticalSwitchSettingsFileSchema,
  OpticalSwitchSettingsSchema,
  type OpticalSwitchSettings,
  type OpticalSwitchSettingsFile,
} from '../core/optical-switch-settings.js';

const MAX_BYTES = 64 * 1024;

/**
 * Saved optical switch overrides, one JSON file. Call `load` before use. An
 * unreadable existing file fails closed: defaults stay active, saving is
 * blocked and the file is never overwritten.
 */
export class OpticalSwitchSettingsStore {
  private document: OpticalSwitchSettingsFile = {
    version: 1,
    generation: randomUUID(),
    computers: {},
  };
  private loaded = false;
  private writable = true;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly filePath: string,
    private readonly onWarning: (message: string) => void = () => undefined,
  ) {}

  snapshot(): OpticalSwitchSettingsFile {
    return structuredClone(this.document);
  }

  load(): Promise<OpticalSwitchSettingsFile> {
    const operation = this.pending.then(() => this.loadDocument());
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  private async loadDocument(): Promise<OpticalSwitchSettingsFile> {
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
      this.document = OpticalSwitchSettingsFileSchema.parse(
        JSON.parse(await handle.readFile('utf8')),
      );
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      )) {
        this.writable = false;
        this.onWarning(
          'Saved optical switch settings could not be read; configured defaults are active and saving is blocked.',
        );
      }
    } finally {
      await handle?.close();
      this.loaded = true;
    }
    return this.snapshot();
  }

  /** Saves one computer's settings, or removes them (null) to return to defaults. */
  save(
    deviceId: string,
    input: OpticalSwitchSettings | null,
    expectedGeneration: string,
  ): Promise<{ generation: string }> {
    // Capture input before queueing so a caller cannot mutate a pending save.
    const settings =
      input === null ? null : OpticalSwitchSettingsSchema.parse(input);
    const operation = this.pending.then(async () => {
      if (!this.loaded || !this.writable)
        throw new OpticalSwitchSettingsError(
          503,
          'optical_settings_unavailable',
        );
      if (this.document.generation !== expectedGeneration)
        throw new OpticalSwitchSettingsError(409, 'optical_settings_changed');
      const computers = { ...this.document.computers };
      if (settings === null) delete computers[deviceId];
      else computers[deviceId] = settings;
      const generation = randomUUID();
      const next = OpticalSwitchSettingsFileSchema.parse({
        version: 1,
        generation,
        computers,
      });
      const text = JSON.stringify(next) + '\n';
      if (Buffer.byteLength(text) > MAX_BYTES)
        throw new OpticalSwitchSettingsError(400, 'optical_settings_too_large');
      await this.write(text);
      this.document = next;
      return { generation };
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  private async write(text: string): Promise<void> {
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
      await rename(temporaryPath, this.filePath);
    } catch {
      throw new OpticalSwitchSettingsError(503, 'optical_settings_save_failed');
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}
