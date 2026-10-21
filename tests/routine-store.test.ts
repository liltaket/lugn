import { afterEach, expect, it } from 'vitest';
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoutineStore } from '../src/runtime/routine-store.js';
import {
  createRoutineTemplates,
  type RoutineDefinition,
} from '../src/core/routines.js';
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'routine-store-'));
  directories.push(directory);
  const path = join(directory, 'routines.json');
  const warnings: string[] = [];
  const store = new RoutineStore(path, createRoutineTemplates(), (message) =>
    warnings.push(message),
  );
  await store.load();
  return { directory, path, store, warnings };
}
const custom = (id = 'custom'): RoutineDefinition => ({
  id,
  name: 'Custom',
  kind: 'custom',
  enabled: false,
  schedule: null,
  steps: [{ type: 'delay', durationMs: 0 }],
});
it('writes an atomic versioned sidecar and reloads exact definitions/generation', async () => {
  const s = await setup();
  const initial = s.store.snapshot();
  const result = await s.store.save(custom(), initial.generation);
  expect(result.generation).not.toBe(initial.generation);
  expect(JSON.parse(await readFile(s.path, 'utf8'))).toEqual(result);
  expect((await stat(s.path)).mode & 0o777).toBe(0o600);
  const restarted = new RoutineStore(s.path);
  expect(await restarted.load()).toEqual(result);
  expect(result).not.toHaveProperty('runs');
  expect(result).not.toHaveProperty('next');
});
it('serializes concurrent edits and rejects a stale expected generation', async () => {
  const s = await setup();
  const generation = s.store.snapshot().generation;
  const results = await Promise.allSettled([
    s.store.save(custom('one'), generation),
    s.store.save(custom('two'), generation),
  ]);
  expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
  expect(results[1]).toMatchObject({
    reason: { status: 409, code: 'routines_changed' },
  });
  expect(s.store.snapshot().definitions.some((d) => d.id === 'two')).toBe(
    false,
  );
});
it('publishes after commit and deletes optimistically', async () => {
  const s = await setup();
  const generations: string[] = [];
  s.store.subscribe(() => {
    generations.push(s.store.snapshot().generation);
  });
  const result = await s.store.save(custom(), s.store.snapshot().generation);
  expect(generations).toEqual([result.generation]);
  const deleted = await s.store.delete('custom', result.generation);
  expect(deleted.definitions.some((d) => d.id === 'custom')).toBe(false);
  await expect(
    s.store.delete('custom', deleted.generation),
  ).rejects.toMatchObject({ status: 404 });
});
it('cannot write before load and preserves corrupt/unreadable persisted data', async () => {
  const s = await setup();
  await writeFile(s.path, '{invalid');
  const restarted = new RoutineStore(s.path, createRoutineTemplates());
  await expect(
    restarted.save(custom(), restarted.snapshot().generation),
  ).rejects.toMatchObject({ status: 503 });
  await restarted.load();
  await expect(
    restarted.save(custom(), restarted.snapshot().generation),
  ).rejects.toMatchObject({ status: 503 });
  expect(await readFile(s.path, 'utf8')).toBe('{invalid');
});
it('rejects symlink input and never overwrites its target', async () => {
  const s = await setup();
  const target = join(s.directory, 'target.json');
  await writeFile(target, '{}');
  await symlink(target, s.path);
  const restarted = new RoutineStore(s.path, createRoutineTemplates());
  await restarted.load();
  await expect(
    restarted.save(custom(), restarted.snapshot().generation),
  ).rejects.toMatchObject({ status: 503 });
  expect(await readFile(target, 'utf8')).toBe('{}');
});
it('rejects writes too large for a subsequent load', async () => {
  const s = await setup();
  const oversized = custom();
  oversized.steps = [
    {
      type: 'light',
      targets: ['lighting.' + 'a'.repeat(1024 * 1024)],
      brightness: 1,
      durationMs: 0,
    },
  ];
  const before = s.store.snapshot();
  await expect(
    s.store.save(oversized, before.generation),
  ).rejects.toMatchObject({ code: 'routine_store_too_large' });
  expect(s.store.snapshot()).toEqual(before);
});
it('isolates subscriber failure from the committed generation', async () => {
  const s = await setup();
  s.store.subscribe(() => {
    throw new Error('consumer failed');
  });
  const result = await s.store.save(custom(), s.store.snapshot().generation);
  expect(JSON.parse(await readFile(s.path, 'utf8'))).toEqual(result);
  expect(s.warnings).toContain('Routine subscriber failed.');
});
