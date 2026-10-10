import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Stl27lPresenceControlAdapter,
  PresenceControlConfigSchema,
} from '../src/adapters/stl27l-presence-control.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { FakeClock } from '../src/core/clock.js';
import { LugnDisplayServer } from '../src/runtime/display-server.js';
import { validateRuntimeFileConfig } from '../src/runtime/config.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(transport?: typeof fetch) {
  const finder = createServer();
  await new Promise<void>((resolve) => finder.listen(0, '127.0.0.1', resolve));
  const address = finder.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test port');
  await new Promise<void>((resolve) => finder.close(() => resolve()));
  const engine = new LugnEngine(new FakeClock(0));
  const server = new LugnDisplayServer({
    host: '127.0.0.1',
    port: address.port,
    hubs: [
      { id: 'bed', role: 'bed', castHost: '127.0.0.1', token: 'a'.repeat(32) },
    ],
    capabilities: new CapabilityRegistry(
      engine,
      transport
        ? {
            presenceCountAdapter: new Stl27lPresenceControlAdapter(
              'http://sensor.local:8080',
              transport,
            ),
          }
        : {},
    ),
    presenceCountCorrectionAvailable: Boolean(transport),
    scenes: [],
    stateProvider: () => engine.state,
  });
  await server.start();
  cleanups.push(async () => {
    await server.stop();
    engine.dispose();
  });
  const origin = `http://127.0.0.1:${address.port}`;
  const base = `${origin}/k/${'a'.repeat(32)}/display-api`;
  return {
    engine,
    base,
    post: (body: unknown = {}, source = origin) =>
      fetch(`${base}/presence-count-one`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: source },
        body: JSON.stringify(body),
      }),
  };
}

describe('persistent presence correction from the Hub', () => {
  it('writes exactly one person to the sensor and leaves room state to MQTT', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, count: 1 })));
    const { engine, base, post } = await setup(transport);
    const before = structuredClone(engine.state);
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true, count: 1 });
    expect(engine.state).toEqual(before);
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, options] = transport.mock.calls[0]!;
    expect(url).toBe('http://sensor.local:8080/api/manual');
    expect(JSON.parse(options!.body as string)).toMatchObject({ count: 1 });
    expect(options!.signal).toBeInstanceOf(AbortSignal);
    expect(
      (
        (await (await fetch(`${base}/state`)).json()) as {
          presenceCountCorrectionAvailable: boolean;
        }
      ).presenceCountCorrectionAvailable,
    ).toBe(true);
  });

  it('rejects cross-origin commands and arbitrary count payloads before touching the sensor', async () => {
    const transport = vi.fn<typeof fetch>();
    const { post } = await setup(transport);
    expect((await post({}, 'http://untrusted.local')).status).toBe(403);
    expect((await post({ count: 7 })).status).toBe(400);
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    new Response('failure', { status: 500 }),
    new Response(JSON.stringify({ ok: true, count: 0 })),
    new Response(JSON.stringify({ ok: false, count: 1 })),
  ])(
    'does not acknowledge an upstream failure or wrong count',
    async (upstream) => {
      const { post } = await setup(
        vi.fn<typeof fetch>().mockResolvedValue(upstream),
      );
      const response = await post();
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: 'presence_sensor_unavailable',
      });
    },
  );

  it('handles a disconnected sensor without returning success', async () => {
    const { post } = await setup(
      vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')),
    );
    expect((await post()).status).toBe(502);
  });

  it('keeps the correction disabled when no sensor control URL is configured', async () => {
    const { base, post } = await setup();
    expect((await post()).status).toBe(400);
    expect(
      (
        (await (await fetch(`${base}/state`)).json()) as {
          presenceCountCorrectionAvailable: boolean;
        }
      ).presenceCountCorrectionAvailable,
    ).toBe(false);
  });

  it('validates optional runtime configuration and rejects URL credentials', () => {
    const minimal = {
      homeAssistant: {
        baseUrl: 'http://ha.local',
        tokenEnv: 'HA_TOKEN',
        entities: { 'lighting.ceiling': 'light.ceiling' },
      },
      scenes: [],
    };
    expect(() =>
      validateRuntimeFileConfig({
        ...minimal,
        presenceControl: { baseUrl: 'http://127.0.0.1:8080' },
      }),
    ).not.toThrow();
    for (const baseUrl of [
      'file:///etc/passwd',
      'not-a-url',
      'http://user:password@sensor.local',
      'http://sensor.local?token=secret',
      'http://sensor.local#fragment',
    ]) {
      expect(PresenceControlConfigSchema.safeParse({ baseUrl }).success).toBe(
        false,
      );
    }
  });
});
