import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { z } from 'zod';
import {
  LightingIntentSnapshotSchema,
  type LightingIntentSnapshot,
  type LightingScene,
  type RoomState,
} from '../core/schemas.js';

const StoredIntentSchema = z
  .object({
    version: z.literal(1),
    intent: LightingIntentSnapshotSchema,
  })
  .strict();

export type LightingIntentStateSource = {
  readonly state: RoomState;
  readonly defaultScenePending: boolean;
  readonly stream: {
    subscribe(listener: (update: { domains: string[] }) => void): () => void;
  };
};

/** Writes only logical light intent; physical observations and command history never enter the file. */
export class LightingIntentStore {
  private readonly unsubscribe: () => void;
  private readonly debounceMs: number;
  private readonly warn: (message: string) => void;
  private timer: NodeJS.Timeout | undefined;
  private pendingPayload: string | undefined;
  private generation = 0;
  private writtenGeneration = 0;
  private writing: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly filePath: string,
    private readonly source: LightingIntentStateSource,
    options: { debounceMs?: number; warn?: (message: string) => void } = {},
  ) {
    this.debounceMs = options.debounceMs ?? 100;
    this.warn =
      options.warn ?? ((message) => console.warn(`[lugn] ${message}`));
    this.unsubscribe = source.stream.subscribe((update) => {
      if (
        update.domains.includes('lighting') ||
        update.domains.includes('presence')
      )
        this.schedule();
    });
  }

  static async load(
    filePath: string,
    expectedDeviceIds: string[],
    scenes: LightingScene[],
    warn: (message: string) => void = (message) =>
      console.warn(`[lugn] ${message}`),
  ): Promise<LightingIntentSnapshot | undefined> {
    let contents: string;
    try {
      const fileInfo = await lstat(filePath);
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
        warn(
          'saved lighting intent ignored (state path is not a regular file)',
        );
        return undefined;
      }
      contents = await readFile(filePath, 'utf8');
    } catch (error) {
      if (isMissing(error)) return undefined;
      warn(
        'saved lighting intent could not be read; starting with empty intent',
      );
      return undefined;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(contents) as unknown;
    } catch {
      warn('saved lighting intent is corrupt; starting with empty intent');
      return undefined;
    }
    const parsed = StoredIntentSchema.safeParse(raw);
    if (!parsed.success) {
      warn('saved lighting intent is invalid or from an unsupported version');
      return undefined;
    }

    const intent = parsed.data.intent;
    const expectedIds = [...expectedDeviceIds].sort();
    const savedIds = Object.keys(intent.devices).sort();
    const configuredScenes = new Set(scenes.map((scene) => scene.id));
    if (
      expectedIds.length !== savedIds.length ||
      expectedIds.some((id, index) => id !== savedIds[index]) ||
      (intent.currentScene !== null &&
        !configuredScenes.has(intent.currentScene)) ||
      Object.values(intent.devices).some((device) =>
        Object.values(device.ownership).some(
          (ownership) =>
            ownership.kind === 'scene' &&
            ownership.revision > intent.sceneRevision,
        ),
      )
    ) {
      warn(
        'saved lighting intent does not match the configured devices or scenes; starting empty',
      );
      return undefined;
    }
    return intent;
  }

  async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      this.unsubscribe();
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    while (this.writtenGeneration < this.generation) {
      if (this.writing) {
        await this.writing;
        continue;
      }
      const generation = this.generation;
      const payload = this.pendingPayload;
      if (payload === undefined) return;
      const write = writeAtomically(this.filePath, payload);
      this.writing = write;
      try {
        await write;
        this.writtenGeneration = generation;
      } finally {
        if (this.writing === write) this.writing = undefined;
      }
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    try {
      const state = this.source.state;
      const intent: LightingIntentSnapshot = LightingIntentSnapshotSchema.parse(
        {
          currentScene: this.source.defaultScenePending
            ? null
            : state.lighting.currentScene,
          sceneRevision: state.lighting.sceneRevision,
          continuityExpiresAt: state.presence.continuityExpiresAt,
          devices: Object.fromEntries(
            Object.entries(state.lighting.devices).map(([id, device]) => [
              id,
              {
                baselineDesired: device.baselineDesired,
                effectiveDesired: device.effectiveDesired,
                ownership: device.ownership,
              },
            ]),
          ),
        },
      );
      this.pendingPayload = JSON.stringify({ version: 1, intent });
      this.generation += 1;
    } catch {
      this.warn(
        'logical lighting intent could not be serialized; previous state remains on disk',
      );
      return;
    }

    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => {
        this.warn('logical lighting intent could not be saved');
      });
    }, this.debounceMs);
    this.timer.unref();
  }
}

async function writeAtomically(
  filePath: string,
  contents: string,
): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const pathInfo = await lstat(directory);
  if (!pathInfo.isDirectory() || pathInfo.isSymbolicLink())
    throw new Error('Lighting state directory must be a regular directory');
  await chmod(directory, 0o700);

  const temporaryPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let file;
  try {
    file = await open(temporaryPath, 'wx', 0o600);
    await file.writeFile(contents, 'utf8');
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporaryPath, filePath);
    const directoryHandle = await open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await file?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
