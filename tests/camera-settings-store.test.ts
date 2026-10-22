import { afterEach, expect, it } from 'vitest';
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CameraSettingsStore } from '../src/runtime/camera-settings-store.js';
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'camera-settings-'));
  directories.push(directory);
  const path = join(directory, 'cameras.json');
  const warnings: string[] = [];
  const store = new CameraSettingsStore(path, undefined, (warning) =>
    warnings.push(warning),
  );
  await store.load();
  return { directory, path, store, warnings };
}
it('atomically writes private versioned preferences and reloads without session state', async () => {
  const { path, store } = await setup();
  const initial = store.snapshot();
  const saved = await store.save(
    { ...initial.settings, enabled: true, cameras: { entry: true } },
    initial.generation,
  );
  expect(saved.generation).not.toBe(initial.generation);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(saved);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  const restarted = new CameraSettingsStore(path);
  expect(await restarted.load()).toEqual(saved);
  expect(saved).not.toHaveProperty('active');
});
it('serializes edits and rejects stale optimistic generations', async () => {
  const { store } = await setup();
  const initial = store.snapshot();
  const results = await Promise.allSettled([
    store.save({ ...initial.settings, enabled: true }, initial.generation),
    store.save(
      { ...initial.settings, durationSeconds: 60 },
      initial.generation,
    ),
  ]);
  expect(results.map((result) => result.status)).toEqual([
    'fulfilled',
    'rejected',
  ]);
  expect(results[1]).toMatchObject({
    reason: { status: 409, code: 'cameras_changed' },
  });
  expect(store.snapshot().settings).toMatchObject({
    enabled: true,
    durationSeconds: 30,
  });
});
it('refuses writes before or while load is pending and never overwrites corrupt files', async () => {
  const { path } = await setup();
  await writeFile(path, '{corrupt');
  const store = new CameraSettingsStore(path);
  const initial = store.snapshot();
  const loading = store.load();
  await expect(
    store.save(initial.settings, initial.generation),
  ).rejects.toMatchObject({ status: 503 });
  await loading;
  await expect(
    store.save(initial.settings, initial.generation),
  ).rejects.toMatchObject({ status: 503 });
  expect(await readFile(path, 'utf8')).toBe('{corrupt');
});
it('reads concurrently once and keeps a corrupt file disabled', async () => {
  const { path } = await setup();
  await writeFile(path, '{}');
  const warnings: string[] = [];
  const store = new CameraSettingsStore(path, undefined, (warning) =>
    warnings.push(warning),
  );
  expect(await Promise.all([store.load(), store.load()])).toEqual([
    store.snapshot(),
    store.snapshot(),
  ]);
  expect(warnings).toHaveLength(1);
  await expect(
    store.save(store.snapshot().settings, store.snapshot().generation),
  ).rejects.toMatchObject({ status: 503 });
});
it('rejects symlink input and preserves its target', async () => {
  const { path, directory } = await setup();
  const target = join(directory, 'target.json');
  await writeFile(target, '{}');
  await symlink(target, path);
  const store = new CameraSettingsStore(path);
  await store.load();
  await expect(
    store.save(store.snapshot().settings, store.snapshot().generation),
  ).rejects.toMatchObject({ status: 503 });
  expect(await readFile(target, 'utf8')).toBe('{}');
});
it('refuses a destination replaced with a symlink after loading', async () => {
  const { path, directory, store } = await setup();
  const target = join(directory, 'target.json');
  await writeFile(target, 'private');
  await symlink(target, path);
  const initial = store.snapshot();
  await expect(
    store.save({ ...initial.settings, enabled: true }, initial.generation),
  ).rejects.toMatchObject({ status: 503, code: 'camera_save_failed' });
  expect(store.snapshot()).toEqual(initial);
  expect(await readFile(target, 'utf8')).toBe('private');
});
it('rejects an oversized persisted document and cannot save over it', async () => {
  const { path } = await setup();
  await writeFile(path, ' '.repeat(1024 * 1024 + 1));
  const store = new CameraSettingsStore(path);
  await store.load();
  await expect(
    store.save(store.snapshot().settings, store.snapshot().generation),
  ).rejects.toMatchObject({ status: 503 });
  expect((await stat(path)).size).toBe(1024 * 1024 + 1);
});
it('validates settings bounds before touching the saved document and publishes only committed state', async () => {
  const { store, path } = await setup();
  const observed: string[] = [];
  store.subscribe(() => {
    observed.push(store.snapshot().generation);
  });
  const initial = store.snapshot();
  expect(() =>
    store.save(
      { ...initial.settings, durationSeconds: 121 },
      initial.generation,
    ),
  ).toThrow();
  expect(observed).toEqual([]);
  const result = await store.save(
    { ...initial.settings, durationSeconds: 5 },
    initial.generation,
  );
  expect(observed).toEqual([result.generation]);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(result);
});
