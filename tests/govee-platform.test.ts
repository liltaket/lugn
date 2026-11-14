import { describe, expect, it, vi } from 'vitest';
import {
  GoveePlatformClient,
  platformControl,
  platformOnline,
  platformScenes,
  platformStateValue,
  platformToggle,
  platformValueAllowed,
  type PlatformDevice,
} from '../src/adapters/govee-platform.js';

const identity = { sku: 'H60A6', device: 'AA:BB:CC:DD:EE:FF:00:11' };
const toggle = {
  type: 'devices.capabilities.toggle',
  instance: 'mainLightToggle',
  parameters: {
    dataType: 'ENUM',
    options: [
      { name: 'on', value: 1 },
      { name: 'off', value: 0 },
    ],
  },
};
const device: PlatformDevice = { ...identity, capabilities: [toggle] };
const sceneCapability = {
  type: 'devices.capabilities.dynamic_scene',
  instance: 'lightScene',
  parameters: {
    dataType: 'ENUM',
    options: [
      { name: 'Forest', value: { id: 10, paramId: 30 } },
      { name: 'Ocean', value: 42 },
    ],
  },
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe('official Govee platform schemas', () => {
  it('preserves scene object and integer values without guessing IDs', () => {
    const scenes = platformScenes([sceneCapability]);
    expect(scenes.get('Forest')?.control.value).toEqual({
      id: 10,
      paramId: 30,
    });
    expect(scenes.get('Ocean')?.control.value).toBe(42);
    expect(() =>
      platformScenes([
        {
          ...sceneCapability,
          parameters: {
            dataType: 'ENUM',
            options: [{ name: 'Bad', value: '42' }],
          },
        },
      ]),
    ).toThrow('Invalid');
  });
  it('rejects ambiguous names instead of silently selecting another variant', () => {
    expect(() =>
      platformScenes([
        sceneCapability,
        {
          ...sceneCapability,
          parameters: {
            dataType: 'ENUM',
            options: [{ name: 'Forest', value: 7 }],
          },
        },
      ]),
    ).toThrow('Ambiguous');
  });
  it('uses only the advertised toggle and refuses missing/global substitutions', () => {
    expect(platformToggle(device, 'mainLightToggle', true)).toEqual({
      type: toggle.type,
      instance: toggle.instance,
      value: 1,
    });
    expect(() =>
      platformToggle(device, 'backgroundLightToggle', true),
    ).toThrow();
    expect(() => platformToggle(device, 'powerSwitch', true)).toThrow();
    expect(() =>
      platformControl(device, toggle.type, toggle.instance, '1'),
    ).toThrow();
  });
  it('enforces array size, unique segment indices, integer range and precision', () => {
    const params = {
      dataType: 'STRUCT',
      fields: [
        {
          fieldName: 'segment',
          required: true,
          dataType: 'Array',
          elementType: 'INTEGER',
          elementRange: { min: 0, max: 12 },
          size: { min: 1, max: 12 },
        },
        {
          fieldName: 'brightness',
          required: true,
          dataType: 'INTEGER',
          range: { min: 0, max: 100, precision: 2 },
        },
      ],
    };
    expect(
      platformValueAllowed(params, { segment: [12], brightness: 42 }),
    ).toBe(true);
    for (const value of [
      { segment: [13], brightness: 42 },
      { segment: [1, 1], brightness: 42 },
      { segment: [1], brightness: 43 },
      { segment: [], brightness: 42 },
      { segment: [1], brightness: 42, extra: true },
    ])
      expect(platformValueAllowed(params, value)).toBe(false);
  });
  it('never treats offline historical or out-of-range state as feedback', () => {
    const state = {
      ...identity,
      capabilities: [
        {
          type: 'devices.capabilities.online',
          instance: 'online',
          state: { value: false },
        },
        { type: toggle.type, instance: toggle.instance, state: { value: 1 } },
      ],
    };
    expect(platformOnline(state)).toBe(false);
    expect(
      platformStateValue(device, state, toggle.type, toggle.instance),
    ).toBeUndefined();
    state.capabilities[0]!.state.value = true;
    expect(
      platformStateValue(device, state, toggle.type, toggle.instance),
    ).toBe(1);
    state.capabilities[1]!.state.value = 9;
    expect(
      platformStateValue(device, state, toggle.type, toggle.instance),
    ).toBeUndefined();
  });
});
describe('Govee platform HTTP client', () => {
  it('authenticates at the fixed official origin and sends exact scene value with UUID', async () => {
    const request = vi.fn<typeof fetch>(async () => response({ code: 200 }));
    const client = new GoveePlatformClient({
      apiKey: 'secret-example',
      fetch: request,
    });
    const control = platformScenes([sceneCapability]).get('Forest')!.control;
    const guard = vi.fn();
    await client.control(identity, control, guard);
    expect(guard).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(
      'https://openapi.api.govee.com/router/api/v1/device/control',
    );
    expect(init?.headers).toHaveProperty('Govee-API-Key', 'secret-example');
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(String(init?.body))).toEqual({
      requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      payload: { ...identity, capability: control },
    });
  });
  it.each([
    response({ code: 401, message: 'secret-example' }),
    response({ code: 200 }, 429),
    response({ code: 200, payload: {} }),
  ])(
    'rejects API, HTTP, and invalid-payload failures without exposing body/key',
    async (result) => {
      const client = new GoveePlatformClient({
        apiKey: 'secret-example',
        fetch: async () => result,
      });
      await expect(client.state(identity)).rejects.toThrow(/Govee/);
      try {
        await new GoveePlatformClient({
          apiKey: 'secret-example',
          fetch: async () => response({ code: 401, message: 'secret-example' }),
        }).devices();
      } catch (error) {
        expect(String(error)).not.toContain('secret-example');
      }
    },
  );
  it('does not call fetch for an expired mutation session', async () => {
    const request = vi.fn<typeof fetch>();
    const client = new GoveePlatformClient({
      apiKey: 'secret-example',
      fetch: request,
    });
    await expect(
      client.control(
        identity,
        { type: toggle.type, instance: toggle.instance, value: 1 },
        () => {
          throw new Error('stale');
        },
      ),
    ).rejects.toThrow('request failed');
    expect(request).not.toHaveBeenCalled();
  });
  it('bounds response size and accepts metadata without parameters for unrelated event capabilities', async () => {
    const client = new GoveePlatformClient({
      apiKey: 'secret-example',
      fetch: async () =>
        response({
          code: 200,
          data: [
            {
              ...identity,
              capabilities: [
                { type: 'devices.capabilities.event', instance: 'alarm' },
              ],
            },
          ],
        }),
    });
    expect((await client.devices())[0]?.capabilities[0]?.parameters).toEqual(
      {},
    );
    const huge = new GoveePlatformClient({
      apiKey: 'secret-example',
      fetch: async () => new Response(' '.repeat(2_000_001)),
    });
    await expect(huge.devices()).rejects.toThrow('request failed');
  });
});

describe('mixed physical and virtual Govee accounts', () => {
  it('ignores unrelated virtual groups without dropping valid configured lamps', async () => {
    const client = new GoveePlatformClient({
      apiKey: 'fixture-key',
      fetch: async () =>
        response({
          code: 200,
          data: [
            { sku: 'BaseGroup', device: '12345678', capabilities: [toggle] },
            {
              sku: 'DreamViewScenic',
              device: '11223344',
              capabilities: [toggle],
            },
            device,
          ],
        }),
    });
    expect(await client.devices()).toEqual([device]);
  });
});
