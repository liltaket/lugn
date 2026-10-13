import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import type { LugnEngine } from '../application/lugn-engine.js';
import {
  LightingValuesSchema,
  SceneSchema,
  SemanticLightingIdSchema,
  type LightingScene,
} from '../core/schemas.js';

const MAX_STORE_BYTES = 1024 * 1024;
const MAX_SCENES = 100;
export const ScenePresetInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    lighting: z.record(SemanticLightingIdSchema, LightingValuesSchema.strict()),
  })
  .strict();
const StoredSceneSchema = ScenePresetInputSchema.extend({
  id: SceneSchema.shape.id,
});
export const ScenePresetUpdateSchema = ScenePresetInputSchema.extend({
  expectedScene: StoredSceneSchema,
});
export const ScenePresetDeleteSchema = z
  .object({ expectedScene: StoredSceneSchema })
  .strict();
const StoreSchema = z
  .object({
    version: z.literal(1),
    scenes: z.array(StoredSceneSchema).max(MAX_SCENES),
    deletedSceneIds: z.array(SceneSchema.shape.id).max(1000),
  })
  .strict();
type PresetData = z.infer<typeof StoreSchema>;

export class ScenePresetError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** Atomic, serialized edits layered over configured scenes and generated room presets. */
export class ScenePresetStore {
  private data: PresetData = { version: 1, scenes: [], deletedSceneIds: [] };
  private pending: Promise<unknown> = Promise.resolve();
  private writable = true;

  constructor(
    private readonly options: {
      filePath: string;
      deviceIds: readonly string[];
      defaultSceneId?: string;
      onWarning?: (message: string) => void;
      onSaved?: (sceneIds: string[]) => void;
    },
  ) {}

  get deletedSceneIds(): readonly string[] {
    return [...this.data.deletedSceneIds];
  }

  async load(baseScenes: readonly LightingScene[]): Promise<LightingScene[]> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const info = await lstat(this.options.filePath);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > MAX_STORE_BYTES
      )
        throw new Error('Invalid store');
      handle = await open(
        this.options.filePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const openedInfo = await handle.stat();
      if (!openedInfo.isFile() || openedInfo.size > MAX_STORE_BYTES)
        throw new Error('Invalid store');
      const parsed = StoreSchema.parse(
        JSON.parse(await handle.readFile('utf8')),
      );
      const ids = new Set(parsed.scenes.map((scene) => scene.id));
      if (
        ids.size !== parsed.scenes.length ||
        new Set(parsed.deletedSceneIds).size !==
          parsed.deletedSceneIds.length ||
        parsed.deletedSceneIds.some(
          (id) => ids.has(id) || this.protectedDeletion(id),
        )
      )
        throw new Error('Invalid scene IDs');
      for (const scene of parsed.scenes) {
        if (scene.id === 'scene.all_off') throw new Error('Protected preset');
        this.validateTargets(scene);
      }
      this.data = parsed;
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      )) {
        // Do not replace unreadable user preferences with the fallback presets.
        this.writable = false;
        this.options.onWarning?.(
          'Lugn saved scene presets could not be read; using configured presets.',
        );
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
    const scenes = new Map(
      baseScenes
        .filter((scene) => !this.data.deletedSceneIds.includes(scene.id))
        .map((scene) => [scene.id, scene]),
    );
    for (const scene of this.data.scenes)
      scenes.set(scene.id, structuredClone(scene));
    return [...scenes.values()];
  }

  create(
    engine: LugnEngine,
    input: z.infer<typeof ScenePresetInputSchema>,
  ): Promise<LightingScene> {
    return this.serialize(async () => {
      const scene = {
        ...ScenePresetInputSchema.parse(input),
        id: `scene.custom_${randomUUID()}`,
      };
      this.validateTargets(scene);
      if (engine.scenes.size >= MAX_SCENES)
        throw new ScenePresetError(409, 'scene_limit_reached');
      const next = { ...this.data, scenes: [...this.data.scenes, scene] };
      await this.save(next);
      this.options.onSaved?.([...engine.scenes.keys(), scene.id]);
      engine.saveSceneDefinition(scene);
      return structuredClone(scene);
    });
  }

  update(
    engine: LugnEngine,
    id: string,
    input: z.infer<typeof ScenePresetUpdateSchema>,
  ): Promise<LightingScene> {
    return this.serialize(async () => {
      const parsed = ScenePresetUpdateSchema.parse(input);
      this.checkExpected(engine, id, parsed.expectedScene);
      if (id === 'scene.all_off')
        throw new ScenePresetError(409, 'scene_protected');
      const scene = { id, name: parsed.name, lighting: parsed.lighting };
      this.validateTargets(scene);
      const next = {
        ...this.data,
        scenes: [...this.data.scenes.filter((entry) => entry.id !== id), scene],
      };
      await this.save(next);
      this.options.onSaved?.([...engine.scenes.keys()]);
      engine.saveSceneDefinition(scene);
      return structuredClone(scene);
    });
  }

  delete(
    engine: LugnEngine,
    id: string,
    expected: LightingScene,
  ): Promise<void> {
    return this.serialize(async () => {
      this.checkExpected(engine, id, expected);
      if (engine.sceneProtection(id) || this.protectedDeletion(id))
        throw new ScenePresetError(409, 'scene_protected');
      const next = {
        ...this.data,
        scenes: this.data.scenes.filter((entry) => entry.id !== id),
        deletedSceneIds: [...this.data.deletedSceneIds, id],
      };
      await this.save(next);
      this.options.onSaved?.(
        [...engine.scenes.keys()].filter((sceneId) => sceneId !== id),
      );
      engine.deleteSceneDefinition(id);
    });
  }

  private protectedDeletion(id: string): boolean {
    return id === 'scene.all_off' || id === this.options.defaultSceneId;
  }

  private checkExpected(
    engine: LugnEngine,
    id: string,
    expected: LightingScene,
  ): void {
    const scene = engine.scenes.get(id);
    if (!scene) throw new ScenePresetError(404, 'unknown_scene');
    if (
      scene.id !== expected.id ||
      scene.name !== expected.name ||
      !sameLighting(scene.lighting, expected.lighting)
    )
      throw new ScenePresetError(409, 'scene_changed');
  }

  private validateTargets(scene: LightingScene): void {
    const targets = Object.keys(scene.lighting);
    if (targets.length === 0)
      throw new ScenePresetError(400, 'scene_lighting_required');
    if (targets.some((id) => !this.options.deviceIds.includes(id)))
      throw new ScenePresetError(400, 'target_not_configured');
    if (
      Object.values(scene.lighting).some(
        (values) => Object.keys(values).length === 0,
      )
    )
      throw new ScenePresetError(400, 'scene_lighting_required');
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation);
    this.pending = next.catch(() => undefined);
    return next;
  }

  private async save(data: PresetData): Promise<void> {
    if (!this.writable) throw new ScenePresetError(503, 'scene_save_failed');
    if (data.scenes.length > MAX_SCENES || data.deletedSceneIds.length > 1000)
      throw new ScenePresetError(409, 'scene_limit_reached');
    const text = `${JSON.stringify(StoreSchema.parse(data))}\n`;
    if (Buffer.byteLength(text) > MAX_STORE_BYTES)
      throw new ScenePresetError(409, 'scene_limit_reached');
    const directory = dirname(this.options.filePath);
    const temporaryPath = join(
      directory,
      `.${basename(this.options.filePath)}.${randomUUID()}.tmp`,
    );
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
      const currentInfo = await lstat(directory);
      if (
        currentInfo.isSymbolicLink() ||
        !currentInfo.isDirectory() ||
        currentInfo.dev !== info.dev ||
        currentInfo.ino !== info.ino
      )
        throw new Error('Directory changed');
      await rename(temporaryPath, this.options.filePath);
      this.data = data;
      // POSIX needs the directory entry flushed for power-loss durability.
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
          this.options.onWarning?.(
            'Lugn scene presets were saved, but directory sync failed.',
          );
        } finally {
          await directoryHandle?.close().catch(() => undefined);
        }
      }
    } catch {
      throw new ScenePresetError(503, 'scene_save_failed');
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

function sameLighting(
  left: LightingScene['lighting'],
  right: LightingScene['lighting'],
): boolean {
  const targets = Object.keys(left);
  return (
    targets.length === Object.keys(right).length &&
    targets.every((target) => {
      const a = left[target];
      const b = right[target];
      return (
        a !== undefined &&
        b !== undefined &&
        a.power === b.power &&
        a.brightness === b.brightness &&
        a.colorTemperature === b.colorTemperature
      );
    })
  );
}
