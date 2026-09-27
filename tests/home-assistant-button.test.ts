import { describe, expect, it } from 'vitest';
import {
  HomeAssistantButtonAdapter,
  HomeAssistantButtonMappingsSchema,
} from '../src/adapters/home-assistant-button.js';

const token = 'secret-test-token';
const host = 'http://ha-secret-host.test:8123';
const config = {
  baseUrl: `${host}/`,
  token,
  entities: {
    'button.entry_unlock': 'button.entry_unlock',
    'button.garage_pulse': 'button.garage_pulse',
  },
};

function setup(
  transport: typeof fetch = async () => new Response(null, { status: 200 }),
  timeoutMs = 10_000,
) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const recordingTransport: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      ...(init === undefined ? {} : { init }),
    });
    return transport(input, init);
  };
  const adapter = new HomeAssistantButtonAdapter(
    config,
    recordingTransport,
    timeoutMs,
  );
  return { adapter, requests };
}

describe('Home Assistant button adapter', () => {
  it('sends only the configured button.press action', async () => {
    const { adapter, requests } = setup();

    await adapter.press('button.entry_unlock');

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${host}/api/services/button/press`);
    expect(requests[0]?.init?.method).toBe('POST');
    expect(requests[0]?.init?.headers).toMatchObject({
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(requestBody(requests[0]?.init?.body))).toEqual({
      entity_id: 'button.entry_unlock',
    });
    expect(requests[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('validates and enforces the mapping allowlist', async () => {
    expect(
      HomeAssistantButtonMappingsSchema.safeParse({
        'light.desk': 'button.entry_unlock',
      }).success,
    ).toBe(false);
    expect(
      HomeAssistantButtonMappingsSchema.safeParse({
        'button.entry_unlock': 'switch.entry_unlock',
      }).success,
    ).toBe(false);
    expect(
      HomeAssistantButtonMappingsSchema.safeParse({
        'button.entry_unlock': 'button.entry_unlock',
        'button.entry_lock': 'button.entry_unlock',
      }).success,
    ).toBe(false);
    expect(HomeAssistantButtonMappingsSchema.safeParse({}).success).toBe(true);

    const { adapter, requests } = setup();
    expect(adapter.hasTarget('button.entry_unlock')).toBe(true);
    expect(adapter.hasTarget('button.unconfigured')).toBe(false);
    expect(adapter.hasTarget('light.entry_unlock')).toBe(false);
    await expect(adapter.press('button.unconfigured')).rejects.toThrow(
      'No Home Assistant button entity is configured for button.unconfigured',
    );
    await expect(adapter.press('light.entry_unlock')).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it('rejects invalid configuration schemas', () => {
    expect(
      () =>
        new HomeAssistantButtonAdapter(
          { ...config, entities: { 'button.entry_unlock': 'light.desk' } },
          async () => new Response(null, { status: 200 }),
        ),
    ).toThrow();
    expect(
      () =>
        new HomeAssistantButtonAdapter(
          { ...config, baseUrl: 'https://user:password@ha.test/path?token=x' },
          async () => new Response(null, { status: 200 }),
        ),
    ).toThrow();
  });

  it('reports sanitized HTTP and transport failures', async () => {
    const { adapter: httpFailure } = setup(
      async () => new Response(null, { status: 503 }),
    );
    await expect(httpFailure.press('button.entry_unlock')).rejects.toThrow(
      'Home Assistant button.press failed for button.entry_unlock: HTTP 503',
    );

    const { adapter: transportFailure } = setup(async () => {
      throw new Error(`Failed for ${host} with Bearer ${token}`);
    });
    const error = await transportFailure.press('button.entry_unlock').then(
      () => new Error('Expected transport failure'),
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).toContain('transport error');
      expect(error.message).not.toContain(token);
      expect(error.message).not.toContain(host);
    }
  });

  it('bounds requests and sanitizes timeout failures', async () => {
    let observedSignal: AbortSignal | undefined;
    const { adapter } = setup((_input, init) => {
      observedSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>(() => {});
    }, 5);

    const error = await adapter.press('button.entry_unlock').then(
      () => new Error('Expected timeout'),
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).toContain('request timed out');
      expect(error.message).not.toContain(token);
      expect(error.message).not.toContain(host);
    }
    expect(observedSignal?.aborted).toBe(true);
  });
});

function requestBody(body: unknown): string {
  if (typeof body !== 'string') throw new Error('Expected a JSON string body');
  return body;
}
