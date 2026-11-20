import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DisplayPowerApi } from '../src/application/display-power-api.js';
import {
  DisplayPowerSettingsService,
  settingsFromConfig,
} from '../src/application/display-power-settings-service.js';
import {
  ExperienceRequestError,
  type ExperienceApi,
} from '../src/application/experience-api.js';
import {
  DisplayPowerSettingsError,
  type DisplayPowerSettings,
} from '../src/core/display-power-settings.js';
import { DisplayPowerSettingsStore } from '../src/runtime/display-power-settings-store.js';

const defaults: DisplayPowerSettings = settingsFromConfig({
  offAfterEmptyMs: 120_000,
  ensureOffWhenAway: true,
  wakeOnEntry: true,
  wakeInQuietHours: false,
  inhibitOnActivity: true,
  activeInhibitMaxMs: 1_800_000,
  idleSleepAfterMs: 1_800_000,
  ignoreIdleBlockers: ['T3 Code'],
});
const changed: DisplayPowerSettings = {
  ...defaults,
  offAfterEmptyMs: 300_000,
  idleSleepAfterMs: null,
  ignoreIdleBlockers: [],
};

describe('display power settings', () => {
  let directory: string;
  let file: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'lugn-display-settings-'));
    file = join(directory, 'state.json.display-power.json');
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  describe('store', () => {
    it('starts empty, persists a save across a reload and leaves no temporary file', async () => {
      const store = new DisplayPowerSettingsStore(file);
      const initial = await store.load();
      expect(initial.computers).toEqual({});
      const saved = await store.save('kuffe', changed, initial.generation);
      expect(saved.generation).not.toBe(initial.generation);
      expect(await readdir(directory)).toEqual([
        'state.json.display-power.json',
      ]);
      const reloaded = new DisplayPowerSettingsStore(file);
      await reloaded.load();
      expect(reloaded.snapshot()).toMatchObject({
        generation: saved.generation,
        computers: { kuffe: changed },
      });
    });

    it('refuses a save based on an old generation', async () => {
      const store = new DisplayPowerSettingsStore(file);
      const { generation } = await store.load();
      await store.save('kuffe', changed, generation);
      await expect(
        store.save('kuffe', defaults, generation),
      ).rejects.toMatchObject({
        status: 409,
        code: 'display_settings_changed',
      });
    });

    it('removes a computer to return it to the defaults', async () => {
      const store = new DisplayPowerSettingsStore(file);
      const { generation } = await store.load();
      const first = await store.save('kuffe', changed, generation);
      await store.save('kuffe', null, first.generation);
      expect(store.snapshot().computers).toEqual({});
    });

    it('rejects out-of-range settings before touching the file', async () => {
      const store = new DisplayPowerSettingsStore(file);
      const { generation } = await store.load();
      expect(() =>
        store.save('kuffe', { ...defaults, offAfterEmptyMs: 5 }, generation),
      ).toThrow(ZodError);
      expect(() =>
        store.save(
          'kuffe',
          { ...defaults, idleSleepAfterMs: 60_000 },
          generation,
        ),
      ).toThrow(ZodError);
    });

    it('fails closed on an unreadable file: defaults stay and the file is never overwritten', async () => {
      await writeFile(file, '{ not json');
      const warning = vi.fn();
      const store = new DisplayPowerSettingsStore(file, warning);
      const { generation } = await store.load();
      expect(warning).toHaveBeenCalledOnce();
      await expect(
        store.save('kuffe', changed, generation),
      ).rejects.toMatchObject({
        status: 503,
        code: 'display_settings_unavailable',
      });
      expect(await readFile(file, 'utf8')).toBe('{ not json');
    });
  });

  describe('service and API', () => {
    async function fixture() {
      const store = new DisplayPowerSettingsStore(file);
      await store.load();
      const service = new DisplayPowerSettingsService({
        repository: store,
        defaults: { kuffe: defaults },
      });
      const base: ExperienceApi = {
        snapshot: () => ({ routines: { version: 1 } }),
        request: vi.fn(async () => ({ ok: true })),
        subscribe: () => () => undefined,
      };
      return { store, service, base, api: new DisplayPowerApi(base, service) };
    }
    const invocation = {
      actor: { type: 'user' as const, id: 'ui' },
      source: 'test',
    };

    it('reports configured defaults, saved overrides and whether they differ', async () => {
      const { service } = await fixture();
      expect(service.effective('kuffe')).toEqual(defaults);
      expect(service.effective('other')).toBeUndefined();
      const generation = service.snapshot().generation;
      expect(service.snapshot().computers['kuffe']).toMatchObject({
        customized: false,
      });
      await service.update('kuffe', changed, generation);
      expect(service.effective('kuffe')).toEqual(changed);
      expect(service.snapshot().computers['kuffe']).toMatchObject({
        settings: changed,
        defaults,
        customized: true,
      });
    });

    it('notifies listeners on save and on reset to defaults', async () => {
      const { service } = await fixture();
      const listener = vi.fn();
      service.subscribe(listener);
      const saved = await service.update(
        'kuffe',
        changed,
        service.snapshot().generation,
      );
      const reset = await service.update('kuffe', null, saved.generation);
      expect(listener).toHaveBeenCalledTimes(2);
      expect(reset.computers['kuffe']?.customized).toBe(false);
    });

    it('does not accept a computer without a display entry', async () => {
      const { service } = await fixture();
      await expect(
        service.update('stranger', changed, service.snapshot().generation),
      ).rejects.toBeInstanceOf(DisplayPowerSettingsError);
    });

    it('adds the settings to the panel snapshot and delegates other routes', async () => {
      const { api, base } = await fixture();
      expect(api.snapshot()).toMatchObject({
        routines: { version: 1 },
        displayPower: {
          version: 1,
          computers: { kuffe: { customized: false } },
        },
      });
      await expect(
        api.request('routines/save', { a: 1 }, invocation),
      ).resolves.toEqual({ ok: true });
      expect(base.request).toHaveBeenCalledOnce();
    });

    it('saves through the route, maps conflicts to HTTP errors and validates bodies', async () => {
      const { api, service } = await fixture();
      const generation = service.snapshot().generation;
      const result = (await api.request(
        'display/settings',
        {
          deviceId: 'kuffe',
          settings: changed,
          expectedGeneration: generation,
        },
        invocation,
      )) as { computers: Record<string, { settings: DisplayPowerSettings }> };
      expect(result.computers['kuffe']?.settings).toEqual(changed);
      await expect(
        api.request(
          'display/settings',
          {
            deviceId: 'kuffe',
            settings: defaults,
            expectedGeneration: generation,
          },
          invocation,
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: 'display_settings_changed',
      });
      await expect(
        api.request(
          'display/settings',
          {
            deviceId: 'nope',
            settings: defaults,
            expectedGeneration: generation,
          },
          invocation,
        ),
      ).rejects.toBeInstanceOf(ExperienceRequestError);
      await expect(
        api.request(
          'display/settings',
          {
            deviceId: 'kuffe',
            settings: { enabled: true },
            expectedGeneration: generation,
          },
          invocation,
        ),
      ).rejects.toBeInstanceOf(ZodError);
      await expect(
        api.request(
          'display/settings',
          {
            deviceId: 'kuffe',
            settings: defaults,
            expectedGeneration: generation,
            extra: 1,
          },
          invocation,
        ),
      ).rejects.toBeInstanceOf(ZodError);
    });
  });
});
