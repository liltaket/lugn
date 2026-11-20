import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ComputerOpticalMqttAdapter,
  ComputerOpticalStateSchema,
  type ComputerOpticalMqttPort,
  type ComputerOpticalState,
} from '../src/adapters/computer-optical-mqtt.js';
import {
  ExperienceRequestError,
  type ExperienceApi,
} from '../src/application/experience-api.js';
import { OpticalSwitchApi } from '../src/application/optical-switch-api.js';
import { OpticalSwitchSettingsService } from '../src/application/optical-switch-settings-service.js';
import { FakeClock } from '../src/core/clock.js';
import {
  OpticalSwitchSettingsError,
  OpticalSwitchSettingsSchema,
  defaultOpticalSwitchSettings,
  isLanHost,
  type OpticalSwitchSettings,
} from '../src/core/optical-switch-settings.js';
import { OpticalSwitchSettingsStore } from '../src/runtime/optical-switch-settings-store.js';

const defaults = defaultOpticalSwitchSettings();
const changed: OpticalSwitchSettings = {
  ...defaults,
  wiimHost: '192.168.10.194',
  audioSink: 'alsa_output.pci-0000_00_1f.3.iec958-stereo',
  minAudibleMs: 250,
};
const invocation = {
  actor: { type: 'user' as const, id: 'ui' },
  source: 'test',
};

describe('optical switch settings', () => {
  it('is on by default and finds the WiiM itself', () => {
    expect(defaults).toEqual({
      enabled: true,
      wiimHost: null,
      audioSink: null,
      minAudibleMs: 400,
      releaseMs: 1_500,
      levelDb: -55,
    });
    expect(OpticalSwitchSettingsSchema.parse(defaults)).toEqual(defaults);
  });

  it('accepts only LAN hosts', () => {
    for (const good of [
      '192.168.10.194',
      '10.0.0.5:443',
      '172.16.1.1',
      '172.31.255.1',
      '169.254.3.4',
      'wiim.local',
      'living-room.local:8443',
    ])
      expect(isLanHost(good), good).toBe(true);
    for (const bad of [
      '',
      '8.8.8.8',
      '93.184.216.34:443',
      'example.com',
      '127.0.0.1',
      '172.32.0.1',
      '192.169.1.1',
      '192.168.1.256',
      '192.168.1.5:0',
      '192.168.1.5:70000',
      'http://192.168.1.5',
      '192.168.1.5/x',
      '.local',
      'a b.local',
      'user@192.168.1.5',
    ])
      expect(isLanHost(bad), bad).toBe(false);
  });

  it('bounds the tunables', () => {
    const parse = (patch: Partial<OpticalSwitchSettings>) =>
      OpticalSwitchSettingsSchema.safeParse({ ...defaults, ...patch }).success;
    expect(parse({ minAudibleMs: 200 })).toBe(true);
    expect(parse({ minAudibleMs: 199 })).toBe(false);
    expect(parse({ minAudibleMs: 5_001 })).toBe(false);
    expect(parse({ releaseMs: 499 })).toBe(false);
    expect(parse({ releaseMs: 10_001 })).toBe(false);
    expect(parse({ levelDb: -80 })).toBe(true);
    expect(parse({ levelDb: -81 })).toBe(false);
    expect(parse({ levelDb: -19 })).toBe(false);
    expect(parse({ levelDb: -55.5 })).toBe(false);
    expect(parse({ wiimHost: 'example.com' })).toBe(false);
    expect(parse({ audioSink: 'a b' })).toBe(false);
    expect(parse({ audioSink: 'x'.repeat(129) })).toBe(false);
  });

  describe('store, service and API', () => {
    let directory: string;
    let file: string;
    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'lugn-optical-settings-'));
      file = join(directory, 'state.json.optical-switch.json');
    });
    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it('persists a save across a reload and leaves no temporary file', async () => {
      const store = new OpticalSwitchSettingsStore(file);
      const { generation } = await store.load();
      const saved = await store.save('kuffe', changed, generation);
      expect(saved.generation).not.toBe(generation);
      expect(await readdir(directory)).toEqual([
        'state.json.optical-switch.json',
      ]);
      const reloaded = new OpticalSwitchSettingsStore(file);
      await reloaded.load();
      expect(reloaded.snapshot().computers).toEqual({ kuffe: changed });
    });

    it('refuses an old generation and out-of-range values', async () => {
      const store = new OpticalSwitchSettingsStore(file);
      const { generation } = await store.load();
      await store.save('kuffe', changed, generation);
      await expect(
        store.save('kuffe', defaults, generation),
      ).rejects.toMatchObject({
        status: 409,
        code: 'optical_settings_changed',
      });
      expect(() =>
        store.save(
          'kuffe',
          { ...defaults, minAudibleMs: 5 },
          store.snapshot().generation,
        ),
      ).toThrow(ZodError);
    });

    it('fails closed on an unreadable file', async () => {
      await writeFile(file, '{ not json');
      const warning = vi.fn();
      const store = new OpticalSwitchSettingsStore(file, warning);
      const { generation } = await store.load();
      expect(warning).toHaveBeenCalledOnce();
      await expect(
        store.save('kuffe', changed, generation),
      ).rejects.toMatchObject({
        status: 503,
        code: 'optical_settings_unavailable',
      });
    });

    async function fixture() {
      const store = new OpticalSwitchSettingsStore(file);
      await store.load();
      const service = new OpticalSwitchSettingsService({
        repository: store,
        defaults: { kuffe: defaults },
      });
      const base: ExperienceApi = {
        snapshot: () => ({ routines: { version: 1 } }),
        request: vi.fn(async () => ({ ok: true })),
        subscribe: () => () => undefined,
      };
      const listeners = new Set<() => void>();
      const agent = {
        status: vi.fn(() => ({
          contact: 'none' as const,
          receivedAt: null,
          state: null,
        })),
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      const api = new OpticalSwitchApi(
        base,
        service,
        new Map([['kuffe', agent]]),
      );
      return { store, service, base, api, agent, listeners };
    }

    it('reports defaults, saved overrides and whether they differ', async () => {
      const { service } = await fixture();
      expect(service.effective('kuffe')).toEqual(defaults);
      expect(service.effective('other')).toBeUndefined();
      expect(service.deviceIds()).toEqual(['kuffe']);
      await service.update('kuffe', changed, service.generation());
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
        service.generation(),
      );
      const reset = await service.update('kuffe', null, saved.generation);
      expect(listener).toHaveBeenCalledTimes(2);
      expect(reset.computers['kuffe']?.customized).toBe(false);
      await expect(
        service.update('stranger', changed, reset.generation),
      ).rejects.toBeInstanceOf(OpticalSwitchSettingsError);
    });

    it('adds settings and the agent report to the snapshot and keeps the other routes', async () => {
      const { api, base } = await fixture();
      expect(api.snapshot()).toMatchObject({
        routines: { version: 1 },
        opticalSwitch: {
          version: 1,
          computers: { kuffe: { settings: defaults, customized: false } },
          agents: { kuffe: { contact: 'none', state: null } },
        },
      });
      await expect(
        api.request('display/settings', {}, invocation),
      ).resolves.toEqual({ ok: true });
      expect(base.request).toHaveBeenCalledOnce();
    });

    it('saves through the route and answers with the new generation', async () => {
      const { api, service } = await fixture();
      const result = (await api.request(
        'optical/settings',
        {
          deviceId: 'kuffe',
          settings: changed,
          expectedGeneration: service.generation(),
        },
        invocation,
      )) as { generation: string };
      expect(result.generation).toBe(service.generation());
      expect(service.effective('kuffe')).toEqual(changed);
    });

    it('maps conflicts and unknown computers to request errors, and rejects bad bodies', async () => {
      const { api, service } = await fixture();
      const generation = service.generation();
      await api.request(
        'optical/settings',
        {
          deviceId: 'kuffe',
          settings: changed,
          expectedGeneration: generation,
        },
        invocation,
      );
      await expect(
        api.request(
          'optical/settings',
          {
            deviceId: 'kuffe',
            settings: defaults,
            expectedGeneration: generation,
          },
          invocation,
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: 'optical_settings_changed',
      });
      await expect(
        api.request(
          'optical/settings',
          {
            deviceId: 'ghost',
            settings: defaults,
            expectedGeneration: service.generation(),
          },
          invocation,
        ),
      ).rejects.toBeInstanceOf(ExperienceRequestError);
      await expect(
        api.request(
          'optical/settings',
          {
            deviceId: 'kuffe',
            settings: { ...defaults, wiimHost: '8.8.8.8' },
            expectedGeneration: service.generation(),
          },
          invocation,
        ),
      ).rejects.toBeInstanceOf(ZodError);
    });

    it('forwards agent changes to subscribers', async () => {
      const { api, listeners } = await fixture();
      const listener = vi.fn();
      const unsubscribe = api.subscribe(listener);
      for (const notify of listeners) notify();
      expect(listener).toHaveBeenCalledOnce();
      unsubscribe();
      expect(listeners.size).toBe(0);
    });
  });
});

const NOW = 1_795_000_000_000;
const ROOT = 'lugn/computers/kuffe/optical';
const GENERATION = '0b0e5f4c-41d5-4fd6-8f77-2f7a9a8c3a10';

function state(
  overrides: Partial<ComputerOpticalState> = {},
): ComputerOpticalState {
  return {
    schema_version: 1,
    device_id: 'kuffe',
    sequence: 1,
    timestamp_ms: NOW,
    heartbeat_interval_ms: 30_000,
    phase: 'idle',
    capture: 'ok',
    host: '192.168.10.194',
    host_source: 'discovered',
    wiim: { reachable: true, optical: false, playing: false },
    discovered: ['192.168.10.194'],
    last_switch: null,
    settings_source: 'lugn',
    settings_generation: GENERATION,
    ...overrides,
  };
}

class Port implements ComputerOpticalMqttPort {
  handlers = new Map<
    string,
    (topic: string, payload: unknown, metadata: { retain: boolean }) => void
  >();
  publish = vi
    .fn<ComputerOpticalMqttPort['publish']>()
    .mockResolvedValue(undefined);
  subscribe(
    topic: string,
    _options: { qos: 0 | 1 },
    handler: (
      topic: string,
      payload: unknown,
      metadata: { retain: boolean },
    ) => void,
  ): () => void {
    this.handlers.set(topic, handler);
    return () => this.handlers.delete(topic);
  }
  emit(payload: unknown, retain = false): void {
    const topic = `${ROOT}/state`;
    this.handlers.get(topic)?.(topic, JSON.stringify(payload), { retain });
  }
}

describe('ComputerOpticalMqttAdapter', () => {
  let clock: FakeClock;
  let port: Port;
  let adapter: ComputerOpticalMqttAdapter;
  let current: OpticalSwitchSettings;
  let changes: number;
  beforeEach(() => {
    clock = new FakeClock(NOW);
    port = new Port();
    current = changed;
    changes = 0;
    adapter = new ComputerOpticalMqttAdapter({
      deviceId: 'kuffe',
      baseTopic: 'lugn/computers',
      mqtt: port,
      clock,
      settings: () => ({ settings: current, generation: GENERATION }),
      onChange: () => (changes += 1),
    });
    adapter.start();
  });

  it('publishes the effective settings retained, and again on every connection', async () => {
    adapter.setBrokerConnected(true);
    await Promise.resolve();
    expect(port.publish).toHaveBeenCalledOnce();
    const [topic, payload, options] = port.publish.mock.calls[0]!;
    expect(topic).toBe(`${ROOT}/settings`);
    expect(options).toEqual({ qos: 1, retain: true });
    expect(JSON.parse(payload)).toEqual({
      schema_version: 1,
      device_id: 'kuffe',
      generation: GENERATION,
      enabled: true,
      wiim_host: '192.168.10.194',
      audio_sink: 'alsa_output.pci-0000_00_1f.3.iec958-stereo',
      min_audible_ms: 250,
      release_ms: 1_500,
      level_db: -55,
    });
    adapter.setBrokerConnected(false);
    adapter.setBrokerConnected(true);
    await Promise.resolve();
    expect(port.publish).toHaveBeenCalledTimes(2);
  });

  it('publishes nothing while the broker is down and survives a refused publish', async () => {
    await adapter.publishSettings();
    expect(port.publish).not.toHaveBeenCalled();
    const warning = vi.fn();
    const failing = new ComputerOpticalMqttAdapter({
      deviceId: 'kuffe',
      mqtt: port,
      clock,
      settings: () => ({ settings: current, generation: GENERATION }),
      onWarning: warning,
    });
    failing.start();
    failing.setBrokerConnected(true);
    port.publish.mockRejectedValueOnce(new Error('denied'));
    await expect(failing.publishSettings()).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalled();
  });

  it('accepts the agent’s state only from a live connection', () => {
    expect(adapter.status()).toEqual({
      contact: 'none',
      receivedAt: null,
      state: null,
    });
    port.emit(state());
    expect(adapter.status().contact).toBe('none'); // not connected yet
    adapter.setBrokerConnected(true);
    port.emit(state());
    const status = adapter.status();
    expect(status.contact).toBe('live');
    expect(status.state).toMatchObject({
      phase: 'idle',
      host: '192.168.10.194',
      hostSource: 'discovered',
      wiim: { reachable: true, optical: false, playing: false },
      settingsSource: 'lugn',
      settingsGeneration: GENERATION,
    });
    expect(changes).toBeGreaterThan(0);
  });

  it('shows a retained report as stale contact, never live', () => {
    adapter.setBrokerConnected(true);
    port.emit(state({ phase: 'sound' }), true);
    expect(adapter.status()).toMatchObject({
      contact: 'stale',
      state: { phase: 'sound' },
    });
    port.emit(state({ sequence: 2, timestamp_ms: NOW }));
    expect(adapter.status().contact).toBe('live');
  });

  it('turns stale after the heartbeat lapses and on broker loss', () => {
    adapter.setBrokerConnected(true);
    port.emit(state());
    clock.advanceBy(89_000);
    expect(adapter.status().contact).toBe('live');
    clock.advanceBy(2_000);
    expect(adapter.status().contact).toBe('stale');
    port.emit(state({ sequence: 2, timestamp_ms: clock.now() }));
    expect(adapter.status().contact).toBe('live');
    adapter.setBrokerConnected(false);
    expect(adapter.status().contact).toBe('stale');
  });

  it('ignores invalid, foreign, old and replayed states', () => {
    adapter.setBrokerConnected(true);
    port.emit({ ...state(), extra: 1 });
    port.emit(state({ device_id: 'other' }));
    port.emit('nonsense');
    port.emit(state({ timestamp_ms: NOW - 200_000 }));
    expect(adapter.status().contact).toBe('none');
    port.emit(state({ sequence: 5, timestamp_ms: NOW }));
    port.emit(
      state({ sequence: 4, timestamp_ms: NOW - 1_000, phase: 'sound' }),
    );
    expect(adapter.status().state?.phase).toBe('idle');
  });

  it('validates the published agent example', async () => {
    const { readFileSync } = await import('node:fs');
    const example = JSON.parse(
      readFileSync(
        new URL(
          '../agents/linux/protocol/optical-state.example.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    expect(
      ComputerOpticalStateSchema.parse({ ...example, device_id: 'kuffe' }),
    ).toMatchObject({ phase: 'sound' });
  });
});
