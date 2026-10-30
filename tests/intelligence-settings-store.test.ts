import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntelligenceSettingsStore } from '../src/runtime/intelligence-settings-store.js';
import {
  defaultIntelligenceSettings,
  IntelligenceSettingsSchema,
} from '../src/core/intelligence.js';
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lugn-intelligence-'));
  directories.push(directory);
  return { directory, file: join(directory, 'intelligence.json') };
}

describe('intelligence settings persistence', () => {
  it('starts disabled without creating a file, saves atomically with private permissions, and restores exact generation/settings', async () => {
    const { directory, file } = await fixture();
    const store = new IntelligenceSettingsStore(file);
    const initial = await store.load();
    expect(initial.settings).toEqual(defaultIntelligenceSettings());
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
    const settings = initial.settings;
    settings.optical = {
      ...settings.optical,
      enabled: true,
      mode: 'auto',
      deviceId: 'desktop',
      target: 'music.room',
      source: 'Optical',
    };
    const saved = await store.save(settings, initial.generation);
    expect(saved.generation).not.toBe(initial.generation);
    expect(saved.settings).toEqual(settings);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1,
      ...saved,
    });
    expect(await readdir(directory)).toEqual(['intelligence.json']);
    if (process.platform !== 'win32')
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    const restored = await new IntelligenceSettingsStore(file).load();
    expect(restored).toEqual(saved);
  });
  it('rejects stale concurrent writers rather than losing updates, and accepts the next generation', async () => {
    const { file } = await fixture();
    const store = new IntelligenceSettingsStore(file);
    const initial = await store.load();
    const a = {
      ...initial.settings,
      suggestions: { ...initial.settings.suggestions, enabled: true },
    };
    const results = await Promise.allSettled([
      store.save(a, initial.generation),
      store.save(initial.settings, initial.generation),
    ]);
    expect(results[0]?.status).toBe('fulfilled');
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: { status: 409, code: 'intelligence_settings_changed' },
    });
    const saved = store.snapshot();
    const next = await store.save(initial.settings, saved.generation);
    expect(next.settings.suggestions.enabled).toBe(false);
  });
  it('serializes load with queued writes and captures mutable input before enqueue', async () => {
    const { file } = await fixture();
    const store = new IntelligenceSettingsStore(file);
    const generation = store.snapshot().generation;
    const settings = defaultIntelligenceSettings();
    const loading = store.load();
    const loadingAgain = store.load();
    const saving = store.save(settings, generation);
    settings.optical.mode = 'auto';
    await Promise.all([loading, loadingAgain]);
    const saved = await saving;
    expect(saved.settings.optical.mode).toBe('suggest');
    expect(await store.load()).toEqual(saved);
  });
  it.each([
    'malformed',
    'unknown_version',
    'oversized',
    'invalid_settings',
    'directory',
    'symlink',
  ] as const)(
    'fails closed and refuses to overwrite %s existing preferences',
    async (kind) => {
      const { directory, file } = await fixture();
      if (kind === 'directory') await mkdir(file);
      else if (kind === 'symlink') {
        const real = join(directory, 'real.json');
        await writeFile(real, 'private preferences');
        await symlink(real, file);
      } else {
        const content =
          kind === 'malformed'
            ? '{'
            : kind === 'oversized'
              ? 'x'.repeat(65537)
              : JSON.stringify({
                  version: kind === 'unknown_version' ? 2 : 1,
                  generation: '3708cbf2-e636-4c44-b8f8-e082868f5d5a',
                  settings:
                    kind === 'invalid_settings'
                      ? {
                          ...defaultIntelligenceSettings(),
                          optical: {
                            ...defaultIntelligenceSettings().optical,
                            respectManual: false,
                          },
                        }
                      : defaultIntelligenceSettings(),
                });
        await writeFile(file, content);
      }
      const warning = vi.fn();
      const store = new IntelligenceSettingsStore(file, warning);
      const initial = await store.load();
      expect(initial.settings).toEqual(defaultIntelligenceSettings());
      expect(warning).toHaveBeenCalledOnce();
      await expect(
        store.save(initial.settings, initial.generation),
      ).rejects.toMatchObject({
        status: 503,
        code: 'intelligence_settings_save_failed',
      });
      expect(
        (await readdir(directory)).filter((name) => name.endsWith('.tmp')),
      ).toEqual([]);
      if (kind === 'symlink')
        expect(await readFile(file, 'utf8')).toBe('private preferences');
    },
  );
  it('does not publish a generation after failed rename and cleans its temporary file', async () => {
    const { directory, file } = await fixture();
    const store = new IntelligenceSettingsStore(file);
    const initial = await store.load();
    await mkdir(file);
    await expect(
      store.save(initial.settings, initial.generation),
    ).rejects.toMatchObject({ code: 'intelligence_settings_save_failed' });
    expect(store.snapshot()).toEqual(initial);
    expect(await readdir(directory)).toEqual(['intelligence.json']);
  });
  it('rejects a symlink save directory without touching the destination', async () => {
    const { directory } = await fixture();
    const real = join(directory, 'real');
    const alias = join(directory, 'alias');
    await mkdir(real);
    await symlink(real, alias);
    const store = new IntelligenceSettingsStore(join(alias, 'settings.json'));
    const initial = await store.load();
    await expect(
      store.save(initial.settings, initial.generation),
    ).rejects.toMatchObject({ code: 'intelligence_settings_save_failed' });
    expect(await readdir(real)).toEqual([]);
  });
  it('refuses saving before load and validates all request settings without modifying prior data', async () => {
    const { file } = await fixture();
    const store = new IntelligenceSettingsStore(file);
    const initial = store.snapshot();
    await expect(
      store.save(initial.settings, initial.generation),
    ).rejects.toMatchObject({ code: 'intelligence_settings_save_failed' });
    await store.load();
    for (const optical of [
      { cooldownMs: 0 },
      { stabilityMs: 0 },
      { stabilityMs: 300001 },
      { respectManual: false },
      { mode: 'learn' },
    ]) {
      expect(
        IntelligenceSettingsSchema.safeParse({
          ...initial.settings,
          optical: { ...initial.settings.optical, ...optical },
        }).success,
      ).toBe(false);
    }
    expect(() =>
      store.save(
        { ...initial.settings, version: 2 } as never,
        initial.generation,
      ),
    ).toThrow();
    expect(store.snapshot()).toEqual(initial);
  });
  it('only exposes copies of saved settings and generation', async () => {
    const { file } = await fixture();
    const store = new IntelligenceSettingsStore(file);
    const initial = await store.load();
    initial.settings.optical.enabled = true;
    expect(store.snapshot().settings.optical.enabled).toBe(false);
  });
});
