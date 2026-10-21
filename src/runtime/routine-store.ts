import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  RoutineError,
  RoutineDefinitionSchema,
  RoutineDocumentSchema,
  type RoutineDefinition,
  type RoutineDocument,
} from '../core/routines.js';

export { RoutineError } from '../core/routines.js';

/** Single-process owner, serialized optimistic edits; corrupt documents are never overwritten. */
export class RoutineStore {
  private document: RoutineDocument;
  private writable = true;
  private loaded = false;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly filePath: string,
    defaults: RoutineDefinition[] = [],
    private readonly onWarning: (message: string) => void = () => undefined,
  ) {
    this.document = RoutineDocumentSchema.parse({
      version: 1,
      generation: randomUUID(),
      definitions: defaults,
    });
  }
  snapshot(): RoutineDocument {
    return structuredClone(this.document);
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async load(): Promise<RoutineDocument> {
    if (this.loaded) return this.snapshot();
    this.loaded = true;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const stat = await lstat(this.filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
        throw new Error('Invalid routine file');
      handle = await open(
        this.filePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const info = await handle.stat();
      if (!info.isFile() || info.size > 1024 * 1024)
        throw new Error('Invalid routine file');
      this.document = RoutineDocumentSchema.parse(
        JSON.parse(await handle.readFile('utf8')),
      );
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      )) {
        this.writable = false;
        this.onWarning('Saved routines could not be read. Saving is disabled.');
      }
    } finally {
      await handle?.close();
    }
    return this.snapshot();
  }
  save(input: unknown, expectedGeneration: string): Promise<RoutineDocument> {
    const definition = RoutineDefinitionSchema.parse(input);
    return this.edit(expectedGeneration, (definitions) => [
      ...definitions.filter((d) => d.id !== definition.id),
      definition,
    ]);
  }
  delete(id: string, expectedGeneration: string): Promise<RoutineDocument> {
    return this.edit(expectedGeneration, (definitions) => {
      if (!definitions.some((d) => d.id === id))
        throw new RoutineError(404, 'routine_not_found');
      return definitions.filter((d) => d.id !== id);
    });
  }
  private edit(
    expected: string,
    change: (definitions: RoutineDefinition[]) => RoutineDefinition[],
  ): Promise<RoutineDocument> {
    const operation = this.pending.then(async () => {
      if (!this.loaded || !this.writable)
        throw new RoutineError(503, 'routine_store_unavailable');
      if (expected !== this.document.generation)
        throw new RoutineError(409, 'routines_changed');
      const document = RoutineDocumentSchema.parse({
        version: 1,
        generation: randomUUID(),
        definitions: change(this.snapshot().definitions),
      });
      const serialized = JSON.stringify(document) + '\n';
      if (Buffer.byteLength(serialized) > 1024 * 1024)
        throw new RoutineError(400, 'routine_store_too_large');
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
        await rename(temporary, this.filePath);
        this.document = document;
        for (const listener of this.listeners) {
          try {
            listener();
          } catch {
            this.onWarning('Routine subscriber failed.');
          }
        }
      } catch {
        throw new RoutineError(503, 'routine_save_failed');
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
        this.onWarning('Routines saved, but directory sync failed.');
      } finally {
        await directoryHandle?.close().catch(() => undefined);
      }
      return this.snapshot();
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
}
