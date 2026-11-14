import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { connect } from 'mqtt';
import type { RuntimeConfig } from '../src/runtime/config.js';
import {
  platformScenes,
  type PlatformDevice,
  type PlatformState,
} from '../src/adapters/govee-platform.js';
import {
  applyPlatformControls,
  GoveePlatformConfigSchema,
  PLATFORM_EXTERNAL_UNKNOWN,
  PLATFORM_RESUME_LUGN,
  platformEffectControls,
  platformEffectSelection,
  platformSelectDiscovery,
  platformZoneControls,
  platformZoneDiscovery,
  platformZoneFeatures,
  platformZoneState,
  resolvePlatformKey,
  startGoveePlatformBridge,
  type PlatformControlPort,
} from '../src/runtime/govee-platform-bridge.js';

const config = GoveePlatformConfigSchema.parse({
  apiKeyEnv: 'GOVEE_KEY_B64',
  devices: [
    {
      id: 'ceiling',
      name: 'Taklampa',
      target: 'lighting.ceiling',
      sku: 'H60A6',
      device: 'AA:BB:CC:DD:EE:FF:00:11',
      zones: [
        {
          id: 'main',
          name: 'Huvudljus',
          powerInstance: 'mainLightToggle',
          segments: [12],
        },
        {
          id: 'ring',
          name: 'Yttre ring',
          powerInstance: 'backgroundLightToggle',
          segments: Array.from({ length: 12 }, (_, i) => i),
        },
      ],
    },
  ],
});
const fixture = config.devices[0]!;
const main = fixture.zones![0]!,
  ring = fixture.zones![1]!;
const toggle = (instance: string) => ({
  type:
    instance === 'powerSwitch'
      ? 'devices.capabilities.on_off'
      : 'devices.capabilities.toggle',
  instance,
  parameters: {
    dataType: 'ENUM',
    options: [
      { name: 'on', value: 1 },
      { name: 'off', value: 0 },
    ],
  },
});
const segment = (instance: string, field: string, max: number) => ({
  type: 'devices.capabilities.segment_color_setting',
  instance,
  parameters: {
    dataType: 'STRUCT',
    fields: [
      {
        fieldName: 'segment',
        dataType: 'Array',
        elementType: 'INTEGER',
        elementRange: { min: 0, max: 12 },
        size: { min: 1, max: 13 },
        required: true,
      },
      {
        fieldName: field,
        dataType: 'INTEGER',
        range: { min: 0, max, precision: 1 },
        required: true,
      },
    ],
  },
});
const scene = {
  type: 'devices.capabilities.dynamic_scene',
  instance: 'lightScene',
  parameters: {
    dataType: 'ENUM',
    options: [
      { name: 'Forest', value: { id: 1, paramId: 2 } },
      { name: 'Ocean', value: 99 },
    ],
  },
};
const metadata: PlatformDevice = {
  sku: fixture.sku,
  device: fixture.device,
  capabilities: [
    toggle('powerSwitch'),
    toggle('mainLightToggle'),
    toggle('backgroundLightToggle'),
    segment('segmentedBrightness', 'brightness', 100),
    segment('segmentedColorRgb', 'rgb', 16777215),
    scene,
  ],
};
const catalogs = platformScenes([scene]);
const state = (): PlatformState => ({
  sku: fixture.sku,
  device: fixture.device,
  capabilities: [
    {
      type: 'devices.capabilities.online',
      instance: 'online',
      state: { value: true },
    },
    ...['powerSwitch', 'mainLightToggle', 'backgroundLightToggle'].map(
      (instance) => ({
        type: toggle(instance).type,
        instance,
        state: { value: 1 },
      }),
    ),
    {
      type: scene.type,
      instance: scene.instance,
      state: { value: { id: 1, paramId: 2 } },
    },
  ],
});
const runtime: RuntimeConfig = {
  http: {
    host: '127.0.0.1',
    port: 8787,
    trustedOrigins: [],
    bearerToken: 'lugn-secret',
  },
  homeAssistant: {
    baseUrl: 'http://ha',
    token: 'unused',
    entities: { [fixture.target]: 'light.h60a6' },
    buttons: {},
    switches: {},
    music: {},
    environment: { temperature: '', humidity: '', co2: '', pm25: '' },
  },
  mqtt: { url: 'mqtt://broker', baseTopic: 'unused', maxAgeMs: 7000 },
  prelight: { targets: {}, maxDurationMs: 5000 },
  statePath: '/unused',
};
function port(): PlatformControlPort {
  return {
    assertSession: vi.fn(),
    begin: vi.fn(async () => 'mine'),
    owns: vi.fn(async () => true),
    end: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
  };
}
class FakeClient extends EventEmitter {
  connected = true;
  published: Array<{ topic: string; value: string }> = [];
  publishAsync = vi.fn(async (topic: string, value: string) => {
    this.published.push({ topic, value });
  });
  subscribeAsync = vi.fn(async () => undefined);
  endAsync = vi.fn(async () => undefined);
  command(topic: string, value: string, retain = false) {
    this.emit('message', topic, Buffer.from(value), { retain });
  }
  last(topic: string) {
    return this.published.filter((item) => item.topic === topic).at(-1)?.value;
  }
}
async function running(
  options: {
    startupFails?: boolean;
    orphan?: boolean;
    supersede?: boolean;
    pollIntervalMs?: number;
    exposeEffects?: boolean;
    unknownZoneState?: boolean;
  } = {},
) {
  const client = new FakeClient();
  let owner = options.orphan ? 'orphan' : undefined;
  const localCalls: Array<{ path: string; input: unknown }> = [];
  const platform = {
    devices: vi.fn(async () => [metadata]),
    scenes: vi.fn(async () => [scene]),
    state: vi.fn(async () => {
      const feedback = state();
      if (options.unknownZoneState) {
        for (const capability of feedback.capabilities) {
          if (capability.type === 'devices.capabilities.toggle')
            capability.state.value = '';
          if (capability.instance === 'powerSwitch') capability.state.value = 0;
        }
      }
      return feedback;
    }),
    control: vi.fn(async (_identity, _command, guard: () => void) => {
      guard();
    }),
  };
  if (options.startupFails)
    platform.devices.mockRejectedValueOnce(new Error('offline'));
  const fetchLocal: typeof fetch = async (url, init) => {
    const path = String(url);
    const body = init?.body
      ? (JSON.parse(String(init.body)) as { input: unknown })
      : undefined;
    localCalls.push({ path, input: body?.input });
    let response: unknown;
    if (path.endsWith('/state'))
      response = {
        lighting: {
          devices: {
            [fixture.target]: owner
              ? { externalControl: { id: options.supersede ? 'newer' : owner } }
              : {},
          },
        },
      };
    else if (path.endsWith('beginExternalControl')) {
      owner = 'mine';
      response = { accepted: true, controlId: owner };
    } else if (path.endsWith('endExternalControl'))
      response = { accepted: true };
    else throw new Error('Unexpected local route');
    return new Response(JSON.stringify(response));
  };
  const mqttConnect = vi.fn(() => client);
  const stop = await startGoveePlatformBridge(
    runtime,
    GoveePlatformConfigSchema.parse({
      ...config,
      devices: config.devices.map((device) => ({
        ...device,
        exposeEffects: options.exposeEffects ?? true,
      })),
    }),
    {
      connect: mqttConnect as unknown as typeof connect,
      platform,
      fetch: fetchLocal,
      environment: {
        GOVEE_KEY_B64: Buffer.from('test-api-secret').toString('base64url'),
      },
      pollIntervalMs: options.pollIntervalMs ?? 60000,
      followupDelayMs: 60000,
    },
  );
  client.emit('connect');
  await vi.waitFor(() =>
    expect(client.last('lugn/govee/platform/availability')).toBe('online'),
  );
  return { client, localCalls, platform, stop, mqttConnect };
}

describe('cloud zone controls and discovery', () => {
  it('sends only the configured toggle for zone ON/OFF', () => {
    expect(platformZoneControls(metadata, main, { state: 'ON' })).toEqual([
      {
        type: toggle('mainLightToggle').type,
        instance: 'mainLightToggle',
        value: 1,
      },
    ]);
    expect(platformZoneControls(metadata, ring, { state: 'OFF' })).toEqual([
      {
        type: toggle('backgroundLightToggle').type,
        instance: 'backgroundLightToggle',
        value: 0,
      },
    ]);
  });
  it('uses exactly configured segment indices for RGB and brightness', () => {
    const controls = platformZoneControls(metadata, ring, {
      brightness: 128,
      color: { r: 1, g: 2, b: 3 },
    });
    expect(controls.map((control) => control.value)).toEqual([
      { segment: ring.segments, brightness: 50 },
      { segment: ring.segments, rgb: 66051 },
    ]);
    expect(
      controls.every((control) => control.instance !== 'powerSwitch'),
    ).toBe(true);
  });
  it.each([
    {},
    { entity_id: 'light.other', state: 'ON' },
    { color_temp: 3000 },
    { brightness: 256 },
    { state: 'OFF', brightness: 30 },
    { effect: 'Forest' },
  ])('rejects malformed/unadvertised input before any write %j', (input) => {
    expect(() => platformZoneControls(metadata, main, input)).toThrow();
  });
  it('does not offer global color/brightness as fallback when segments are missing or unsupported', () => {
    const noSegments = {
      ...metadata,
      capabilities: metadata.capabilities.filter(
        (capability) => !capability.instance.startsWith('segmented'),
      ),
    };
    expect(platformZoneFeatures(noSegments, main)).toEqual({
      power: true,
      brightness: false,
      rgb: false,
    });
    expect(() =>
      platformZoneControls(noSegments, main, { state: 'ON', brightness: 20 }),
    ).toThrow();
    expect(
      platformZoneFeatures(metadata, { ...main, segments: [13] }).rgb,
    ).toBe(false);
    const discovery = platformZoneDiscovery(fixture, main, noSegments);
    expect(discovery.supported_color_modes).toEqual(['onoff']);
    expect(discovery).not.toHaveProperty('color_temp_kelvin');
    expect(discovery.default_entity_id).toBe('light.lugn_govee_ceiling_main');
    expect(discovery.optimistic).toBe(false);
  });
  it('powers fixture effects on even if a cached cloud state could still report ON', () => {
    const controls = platformEffectControls(metadata, catalogs.get('Forest')!);
    expect(controls.map((control) => control.instance)).toEqual([
      'powerSwitch',
      'lightScene',
    ]);
    expect(controls[1]).toEqual(catalogs.get('Forest')!.control);
  });
  it('requires actual zone power feedback and rejects offline historical state', () => {
    expect(platformZoneState(metadata, main, state())).toEqual({ state: 'ON' });
    const missing = state();
    missing.capabilities = missing.capabilities.filter(
      (capability) => capability.instance !== main.powerInstance,
    );
    expect(platformZoneState(metadata, main, missing)).toBeUndefined();
    missing.capabilities[0]!.state.value = false;
    expect(platformZoneState(metadata, ring, missing)).toBeUndefined();
  });
  it('distinguishes actual scene feedback, Lugn, orphan ownership and unknown feedback', () => {
    expect(
      platformEffectSelection(
        metadata,
        state(),
        catalogs,
        undefined,
        undefined,
      ),
    ).toBe(PLATFORM_RESUME_LUGN);
    expect(
      platformEffectSelection(metadata, state(), catalogs, 'mine', 'mine'),
    ).toBe('Forest');
    expect(
      platformEffectSelection(metadata, state(), catalogs, 'orphan', undefined),
    ).toBe(PLATFORM_EXTERNAL_UNKNOWN);
    const missing = state();
    missing.capabilities.pop();
    expect(
      platformEffectSelection(metadata, missing, catalogs, 'mine', 'mine'),
    ).toBe(PLATFORM_EXTERNAL_UNKNOWN);
    expect(platformSelectDiscovery(fixture, catalogs).device.name).toBe(
      'Taklampa',
    );
  });
  it('strictly resolves env references and rejects duplicate or overlapping mappings', () => {
    expect(
      resolvePlatformKey('KEY_B64', {
        KEY_B64: Buffer.from('secret').toString('base64url'),
      }),
    ).toBe('secret');
    expect(() =>
      resolvePlatformKey('KEY_B64', { KEY_B64: 'c2VjcmV0=' }),
    ).toThrow();
    expect(() => resolvePlatformKey('KEY', { KEY: 'secret\n' })).toThrow();
    expect(() =>
      GoveePlatformConfigSchema.parse({
        ...config,
        devices: [fixture, fixture],
      }),
    ).toThrow();
    expect(() =>
      GoveePlatformConfigSchema.parse({
        ...config,
        devices: [{ ...fixture, zones: [main, { ...ring, segments: [12] }] }],
      }),
    ).toThrow();
  });
});
describe('cloud ownership and MQTT session guards', () => {
  it('rechecks Lugn ownership before EACH mutation and stops after supersession', async () => {
    const control = port();
    vi.mocked(control.owns)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const controls = platformZoneControls(metadata, main, {
      state: 'ON',
      brightness: 100,
    });
    await expect(
      applyPlatformControls(fixture.target, controls, control),
    ).rejects.toThrow('superseded');
    expect(control.send).toHaveBeenCalledTimes(1);
    expect(control.end).toHaveBeenCalledWith(fixture.target, 'mine');
  });
  it('does not mutate or clean up after the MQTT session expires during ownership read', async () => {
    const control = port();
    let active = true;
    control.assertSession = () => {
      if (!active) throw new Error('expired');
    };
    control.owns = async () => {
      active = false;
      return true;
    };
    await expect(
      applyPlatformControls(
        fixture.target,
        platformZoneControls(metadata, main, { state: 'ON' }),
        control,
      ),
    ).rejects.toThrow('expired');
    expect(control.send).not.toHaveBeenCalled();
    expect(control.end).not.toHaveBeenCalled();
  });
  it('routes zone ON without global power and acquires a non-activating lease', async () => {
    const f = await running();
    try {
      f.client.command(
        'lugn/govee/platform/ceiling/main/set',
        '{"state":"ON"}',
      );
      await vi.waitFor(() => expect(f.platform.control).toHaveBeenCalledOnce());
      expect(f.platform.control.mock.calls[0]?.[1]).toEqual({
        type: toggle('mainLightToggle').type,
        instance: 'mainLightToggle',
        value: 1,
      });
      expect(
        f.localCalls.find((call) => call.path.endsWith('beginExternalControl'))
          ?.input,
      ).toEqual({ target: fixture.target, activate: false });
      expect(f.localCalls.at(-1)?.path).toContain('/state');
    } finally {
      await f.stop();
    }
  });
  it('never publishes the requested scene as confirmed feedback', async () => {
    const f = await running();
    try {
      f.client.command('lugn/govee/platform/ceiling/set', 'Ocean');
      await vi.waitFor(() =>
        expect(f.platform.control).toHaveBeenCalledTimes(2),
      );
      expect(
        f.platform.control.mock.calls.map((call) => call[1].instance),
      ).toEqual(['powerSwitch', 'lightScene']);
      await vi.waitFor(() =>
        expect(f.client.last('lugn/govee/platform/ceiling/state')).toBe(
          'Forest',
        ),
      );
      expect(
        f.client.published.some(
          (item) =>
            item.topic.endsWith('/ceiling/state') && item.value === 'Ocean',
        ),
      ).toBe(false);
      expect(
        JSON.parse(f.client.last('lugn/govee/platform/ceiling/result')!),
      ).toHaveProperty('last_result', 'cloud_accepted');
    } finally {
      await f.stop();
    }
  });
  it('ignores retained/invalid commands and stops superseded leases before cloud writes', async () => {
    const f = await running({ supersede: true });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      f.client.command('lugn/govee/platform/ceiling/set', 'Ocean', true);
      f.client.command(
        'lugn/govee/platform/ceiling/main/set',
        '{"color_temp":3000}',
      );
      expect(f.platform.control).not.toHaveBeenCalled();
      f.client.command('lugn/govee/platform/ceiling/set', 'Forest');
      await vi.waitFor(() =>
        expect(
          f.localCalls.some((call) => call.path.endsWith('endExternalControl')),
        ).toBe(true),
      );
      expect(f.platform.control).not.toHaveBeenCalled();
      expect(
        f.localCalls.find((call) => call.path.endsWith('endExternalControl'))
          ?.input,
      ).toEqual({ target: fixture.target, expectedControlId: 'mine' });
    } finally {
      await f.stop();
      log.mockRestore();
    }
  });
  it('starts through a transient cloud outage and retries without restarting local controls', async () => {
    const f = await running({ startupFails: true, pollIntervalMs: 30 });
    try {
      expect(
        f.client.published.some(
          (item) =>
            item.topic === 'lugn/govee/platform/ceiling/availability' &&
            item.value === 'offline',
        ),
      ).toBe(true);
      await vi.waitFor(() =>
        expect(f.client.last('lugn/govee/platform/ceiling/availability')).toBe(
          'online',
        ),
      );
      expect(f.platform.devices).toHaveBeenCalledTimes(2);
      expect(f.mqttConnect).toHaveBeenCalledWith(
        runtime.mqtt!.url,
        expect.objectContaining({
          clientId: 'lugn-govee-platform',
          clean: true,
          queueQoSZero: false,
          resubscribe: false,
        }),
      );
    } finally {
      await f.stop();
    }
  });
  it('can complement LAN effects with zones only and group by physical device identity', async () => {
    const f = await running({ exposeEffects: false });
    try {
      expect(f.platform.scenes).not.toHaveBeenCalled();
      expect(
        f.client.published.some((item) => item.topic.includes('/select/')),
      ).toBe(false);
      expect(f.client.subscribeAsync).toHaveBeenCalledWith(
        [
          'lugn/govee/platform/ceiling/main/set',
          'lugn/govee/platform/ceiling/main/power/set',
          'lugn/govee/platform/ceiling/ring/set',
          'lugn/govee/platform/ceiling/ring/power/set',
        ],
        expect.anything(),
      );
      f.client.command('lugn/govee/platform/ceiling/set', 'Ocean');
      expect(f.platform.control).not.toHaveBeenCalled();
      f.client.command(
        'lugn/govee/platform/ceiling/ring/set',
        '{"state":"OFF"}',
      );
      await vi.waitFor(() => expect(f.platform.control).toHaveBeenCalledOnce());
      const discovery = JSON.parse(
        f.client.last(
          'homeassistant/light/lugn_govee_platform_ceiling_ring/config',
        )!,
      );
      expect(discovery.device.identifiers).toEqual([
        'lugn_govee_aabbccddeeff0011',
      ]);
    } finally {
      await f.stop();
    }
  });
  it('drops queued commands across disconnect/reconnect without replay', async () => {
    const f = await running();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      f.client.command(
        'lugn/govee/platform/ceiling/main/set',
        '{"state":"ON"}',
      );
      f.client.command('lugn/govee/platform/ceiling/set', 'Ocean');
      f.client.connected = false;
      f.client.emit('close');
      f.client.connected = true;
      f.client.emit('connect');
      await new Promise((resolve) => setImmediate(resolve));
      expect(f.platform.control).not.toHaveBeenCalled();
      expect(
        f.localCalls.some((call) => call.path.endsWith('beginExternalControl')),
      ).toBe(false);
    } finally {
      await f.stop();
      log.mockRestore();
    }
  });
  it('keeps zone buttons usable when the official API returns empty zone power values', async () => {
    const f = await running({ exposeEffects: false, unknownZoneState: true });
    try {
      expect(
        f.client.last('lugn/govee/platform/ceiling/main/availability'),
      ).toBe('offline');
      expect(
        f.client.last('lugn/govee/platform/ceiling/main/command_availability'),
      ).toBe('online');
      const button = JSON.parse(
        f.client.last(
          'homeassistant/button/lugn_govee_platform_ceiling_main_on/config',
        )!,
      );
      expect(button.default_entity_id).toBe(
        'button.lugn_govee_ceiling_main_on',
      );
      expect(button.name).toBe('Huvudljus · Slå på');
      expect(button.payload_press).toBe('ON');
      f.client.command(button.command_topic, button.payload_press);
      await vi.waitFor(() => expect(f.platform.control).toHaveBeenCalledOnce());
      f.client.command('lugn/govee/platform/ceiling/ring/power/set', 'OFF');
      await vi.waitFor(() =>
        expect(f.platform.control).toHaveBeenCalledTimes(2),
      );
      expect(f.platform.control.mock.calls.map((call) => call[1])).toEqual([
        {
          type: 'devices.capabilities.toggle',
          instance: 'mainLightToggle',
          value: 1,
        },
        {
          type: 'devices.capabilities.toggle',
          instance: 'backgroundLightToggle',
          value: 0,
        },
      ]);
      expect(
        f.client.published.some(
          (item) =>
            item.topic === 'lugn/govee/platform/ceiling/main/state' &&
            item.value.includes('ON'),
        ),
      ).toBe(false);
    } finally {
      await f.stop();
    }
  });
  it('ignores invalid or retained button payloads without acquiring a lease', async () => {
    const f = await running({ exposeEffects: false, unknownZoneState: true });
    try {
      f.client.command(
        'lugn/govee/platform/ceiling/main/power/set',
        'ON',
        true,
      );
      f.client.command(
        'lugn/govee/platform/ceiling/main/power/set',
        '{"state":"ON"}',
      );
      f.client.command('lugn/govee/platform/ceiling/main/power/set', 'toggle');
      await new Promise((resolve) => setImmediate(resolve));
      expect(f.platform.control).not.toHaveBeenCalled();
      expect(
        f.localCalls.some((call) => call.path.endsWith('beginExternalControl')),
      ).toBe(false);
    } finally {
      await f.stop();
    }
  });
});
