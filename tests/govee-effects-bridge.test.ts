import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyEffect,
  loadGoveeEffects,
  effectOptions,
  GoveeBridgeConfigSchema,
  playableEffects,
  selectDiscovery,
  type EffectBridgePort,
} from '../src/runtime/govee-effects-bridge.js';
import type { GoveeEffect } from '../src/adapters/govee-lan-effects.js';

const effect: GoveeEffect = {
  sku: 'H612A',
  id: 'forest',
  name: 'Forest',
  category: 'Natural',
  sceneCode: 212,
  sceneType: 2,
  sceneParam: '',
  variant: 1,
};
const device = {
  id: 'strip_1',
  name: 'Ljusslinga',
  target: 'lighting.strip_1',
  sku: 'H612A' as const,
  device: '15:57:D0:03:C2:46:3C:62',
};
function port(): EffectBridgePort {
  return {
    begin: vi.fn(async () => 'generation-1'),
    owns: vi.fn(async () => true),
    end: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
  };
}
describe('Govee effect handoff', () => {
  it('never sends a scene when a user supersedes the handoff', async () => {
    const p = port();
    vi.mocked(p.owns).mockResolvedValue(false);
    await expect(applyEffect(device.target, effect, p)).rejects.toThrow(
      'superseded',
    );
    expect(p.send).not.toHaveBeenCalled();
    expect(p.end).toHaveBeenCalledWith(device.target, 'generation-1');
  });
  it('waits for handoff and ownership before UDP', async () => {
    const calls: string[] = [];
    await applyEffect(device.target, effect, {
      begin: async () => {
        calls.push('begin');
        return 'id';
      },
      owns: async () => {
        calls.push('owns');
        return true;
      },
      send: async () => {
        calls.push('send');
      },
      end: async () => {
        calls.push('end');
      },
    });
    expect(calls).toEqual(['begin', 'owns', 'send']);
  });
  it('only releases its own generation if sending fails', async () => {
    const p = port();
    vi.mocked(p.send).mockRejectedValue(new Error('udp'));
    await expect(applyEffect(device.target, effect, p)).rejects.toThrow('udp');
    expect(p.end).toHaveBeenCalledWith(device.target, 'generation-1');
  });
  it('does not change intent for an unsupported packet format', async () => {
    const p = port();
    await expect(
      applyEffect(
        device.target,
        { ...effect, sceneType: 255, sceneParam: 'AQ==' },
        p,
      ),
    ).rejects.toThrow();
    expect(p.begin).not.toHaveBeenCalled();
  });
});
describe('Govee MQTT discovery', () => {
  it('preserves duplicate app scene variants as distinct options', () => {
    const options = effectOptions([
      effect,
      { ...effect, id: 'forest2', variant: 2 },
    ]);
    expect(options.size).toBe(2);
    expect([...options.keys()]).toEqual([
      'Forest · Natural · 1',
      'Forest · Natural · 2',
    ]);
  });
  it('filters unverified frames and never offers them to HA', () => {
    expect(
      playableEffects([
        effect,
        { ...effect, sceneType: 255, sceneParam: 'AQ==' },
      ]),
    ).toEqual([effect]);
  });
  it('uses a separate select and non-retained command topic', () => {
    const d = selectDiscovery(device, ['Forest']);
    expect(d.options).toEqual(['Lugn', 'Extern (okänd effekt)', 'Forest']);
    expect(d.retain).toBe(false);
    expect(d.command_topic).toBe('lugn/govee/strip_1/set');
    expect(d).not.toHaveProperty('brightness_command_topic');
  });
  it('rejects duplicate physical devices or targets in the bridge config', () => {
    expect(() =>
      GoveeBridgeConfigSchema.parse({
        cacheDirectory: '/tmp/cache',
        interfaceAddress: '192.168.10.132',
        devices: [device, { ...device, id: 'strip_2' }],
      }),
    ).toThrow();
  });
});

describe('combined LAN and platform configuration', () => {
  const ceiling = {
    ...device,
    id: 'ceiling',
    target: 'lighting.ceiling',
    sku: 'H60A6',
    name: 'Taklampa',
  };
  const platform = {
    ...ceiling,
    exposeEffects: false,
    zones: [
      { id: 'main', name: 'Huvudljus', powerInstance: 'mainLightToggle' },
    ],
  };
  const config = {
    cacheDirectory: '/tmp/cache',
    interfaceAddress: '192.168.10.132',
    broadcastAddress: '192.168.10.255',
    devices: [ceiling],
    platform: { apiKeyEnv: 'GOVEE_API_KEY_B64', devices: [platform] },
  };
  it('allows cloud zone buttons to complement the exact same LAN fixture', () => {
    expect(GoveeBridgeConfigSchema.safeParse(config).success).toBe(true);
    expect(
      GoveeBridgeConfigSchema.safeParse({
        ...config,
        platform: {
          ...config.platform,
          devices: [{ ...platform, exposeEffects: true }],
        },
      }).success,
    ).toBe(false);
    expect(
      GoveeBridgeConfigSchema.safeParse({
        ...config,
        platform: {
          ...config.platform,
          devices: [{ ...platform, device: '00:00:00:00:00:00:00:FF' }],
        },
      }).success,
    ).toBe(false);
  });
  it('loads model-specific metadata from the offline cache without losing optional fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'govee-cache-'));
    const cached = { ...effect, paramId: 15496, cmdVersion: 1 };
    await writeFile(join(directory, 'H612A.json'), JSON.stringify([cached]));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline fixture');
      }),
    );
    try {
      expect(await loadGoveeEffects('H612A', directory)).toEqual([cached]);
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
