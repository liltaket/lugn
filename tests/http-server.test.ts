import { createServer, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import { LugnHttpServer } from '../src/runtime/http-server.js';

describe('local capability HTTP API', () => {
  let server: LugnHttpServer | undefined;
  let engine: LugnEngine | undefined;

  afterEach(async () => {
    await server?.stop();
    engine?.dispose();
    server = undefined;
    engine = undefined;
  });

  it('protects routes and sends validated capability requests to the engine', async () => {
    const port = await findAvailablePort();
    const clock = new FakeClock();
    const adapter = new SimulatedLightingAdapter(clock);
    engine = new LugnEngine(clock, {
      deviceIds: ['lighting.ceiling'],
      scenes: [],
      adapter,
    });
    server = new LugnHttpServer({
      host: '127.0.0.1',
      port,
      bearerToken: 'local-test-token',
      engine,
      capabilities: new CapabilityRegistry(engine),
      integrations: () => ({
        home_assistant: 'connected',
        mqtt: 'not_configured',
      }),
    });
    await server.start();

    const baseUrl = `http://127.0.0.1:${port}`;
    const unauthorized = await fetch(`${baseUrl}/health`);
    expect(unauthorized.status).toBe(401);

    const authorization = { Authorization: 'Bearer local-test-token' };
    const health = await fetch(`${baseUrl}/health`, {
      headers: authorization,
    });
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      status: 'ok',
      integrations: {
        home_assistant: 'connected',
        mqtt: 'not_configured',
      },
    });

    const response = await fetch(`${baseUrl}/capabilities/lighting.set`, {
      method: 'POST',
      headers: {
        ...authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: {
          target: 'lighting.ceiling',
          values: { power: true, brightness: 42 },
        },
        requestId: 'http-test-1',
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true });
    expect(adapter.dispatched).toHaveLength(1);
    expect(adapter.dispatched[0]).toMatchObject({
      target: 'lighting.ceiling',
      values: { power: true, brightness: 42 },
    });

    const invalid = await fetch(`${baseUrl}/capabilities/music.setVolume`, {
      method: 'POST',
      headers: {
        ...authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: { target: 'music.room', volume: 2 },
      }),
    });
    expect(invalid.status).toBe(400);

    const unconfiguredTarget = await fetch(
      `${baseUrl}/capabilities/music.play`,
      {
        method: 'POST',
        headers: {
          ...authorization,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ input: { target: 'music.room' } }),
      },
    );
    expect(unconfiguredTarget.status).toBe(400);
    expect(await unconfiguredTarget.json()).toEqual({
      error: 'target_not_configured',
    });
  });
});

async function findAvailablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}
