import { createServer, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HomeAssistantButtonAdapter } from '../src/adapters/home-assistant-button.js';
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

  it('routes button.press only through the configured Home Assistant mapping', async () => {
    const port = await findAvailablePort();
    const clock = new FakeClock();
    const lightingAdapter = new SimulatedLightingAdapter(clock);
    engine = new LugnEngine(clock, {
      deviceIds: ['lighting.ceiling'],
      scenes: [],
      adapter: lightingAdapter,
    });

    const buttonRequests: Array<{ url: string; init?: RequestInit }> = [];
    const buttonAdapter = new HomeAssistantButtonAdapter(
      {
        baseUrl: 'http://home-assistant.test:8123',
        token: 'ha-test-token',
        entities: { 'button.office_pc_lock': 'button.pc_lock' },
      },
      async (input, init) => {
        buttonRequests.push({
          url: String(input),
          ...(init === undefined ? {} : { init }),
        });
        return new Response(null, { status: 200 });
      },
    );

    server = new LugnHttpServer({
      host: '127.0.0.1',
      port,
      bearerToken: 'local-test-token',
      engine,
      capabilities: new CapabilityRegistry(engine, { buttonAdapter }),
      integrations: () => ({ home_assistant: 'connected' }),
    });
    await server.start();

    const baseUrl = `http://127.0.0.1:${port}`;
    const headers = {
      Authorization: 'Bearer local-test-token',
      'Content-Type': 'application/json',
    };
    const mapped = await fetch(`${baseUrl}/capabilities/button.press`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        input: { target: 'button.office_pc_lock' },
        requestId: 'button-http-test-1',
      }),
    });

    expect(mapped.status).toBe(200);
    expect(await mapped.json()).toEqual({ accepted: true });
    expect(buttonRequests).toHaveLength(1);
    expect(buttonRequests[0]?.url).toBe(
      'http://home-assistant.test:8123/api/services/button/press',
    );
    expect(buttonRequests[0]?.init?.method).toBe('POST');
    expect(buttonRequests[0]?.init?.headers).toMatchObject({
      Authorization: 'Bearer ha-test-token',
    });
    expect(buttonRequests[0]?.init?.body).toBe(
      JSON.stringify({ entity_id: 'button.pc_lock' }),
    );

    const unmapped = await fetch(`${baseUrl}/capabilities/button.press`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input: { target: 'button.unmapped' } }),
    });
    expect(unmapped.status).toBe(400);
    expect(await unmapped.json()).toEqual({ error: 'target_not_configured' });

    const malformed = await fetch(`${baseUrl}/capabilities/button.press`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input: { target: 'light.office_pc_lock' } }),
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      error: 'invalid_capability_input',
    });

    const extraInput = await fetch(`${baseUrl}/capabilities/button.press`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        input: {
          target: 'button.office_pc_lock',
          service: 'homeassistant.turn_off',
        },
      }),
    });
    expect(extraInput.status).toBe(400);
    expect(await extraInput.json()).toMatchObject({
      error: 'invalid_capability_input',
    });
    expect(buttonRequests).toHaveLength(1);
  });

  it('serves a same-origin UI session without exposing its bearer token to API calls', async () => {
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
      integrations: () => ({ home_assistant: 'connected' }),
    });
    await server.start();

    const baseUrl = `http://127.0.0.1:${port}`;
    const origin = baseUrl;
    const page = await fetch(`${baseUrl}/ui/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain(
      "script-src 'self'",
    );
    expect(await page.text()).toContain('<title>Lugn · Rumskontroll</title>');
    const frontend = await fetch(`${baseUrl}/ui/app.js`);
    expect(frontend.status).toBe(200);
    expect(await frontend.text()).not.toContain('local-test-token');

    const sessionStatus = await fetch(`${baseUrl}/ui/api/session`);
    expect(await sessionStatus.json()).toEqual({
      tokenRequired: true,
      authenticated: false,
      provider: 'token',
    });

    const dnsRebindingAttempt = await fetch(`${baseUrl}/ui/api/session`, {
      method: 'POST',
      headers: {
        Host: `attacker.example:${port}`,
        Origin: `http://attacker.example:${port}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token: '' }),
    });
    expect(dnsRebindingAttempt.status).toBe(403);

    const crossOriginLogin = await fetch(`${baseUrl}/ui/api/session`, {
      method: 'POST',
      headers: {
        Origin: 'http://attacker.example',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token: 'local-test-token' }),
    });
    expect(crossOriginLogin.status).toBe(403);

    const invalidLogin = await fetch(`${baseUrl}/ui/api/session`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'wrong-token' }),
    });
    expect(invalidLogin.status).toBe(401);

    const login = await fetch(`${baseUrl}/ui/api/session`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'local-test-token' }),
    });
    expect(login.status).toBe(200);
    const loginBody = (await login.json()) as { csrfToken: string };
    const sessionCookie = login.headers
      .get('set-cookie')
      ?.match(/lugn_ui_session=([^;]+)/)?.[1];
    expect(sessionCookie).toBeTruthy();
    expect(login.headers.get('set-cookie')).toContain('HttpOnly');
    expect(login.headers.get('set-cookie')).toContain('SameSite=Strict');

    const overview = await fetch(`${baseUrl}/ui/api/overview`, {
      headers: { Cookie: `lugn_ui_session=${sessionCookie}` },
    });
    expect(overview.status).toBe(200);
    const overviewBody = (await overview.json()) as {
      state: { presence: { state: string } };
    };
    expect(overviewBody.state.presence.state).toBe('unknown');

    const missingCsrf = await fetch(
      `${baseUrl}/ui/api/capabilities/lighting.set`,
      {
        method: 'POST',
        headers: {
          Origin: origin,
          Cookie: `lugn_ui_session=${sessionCookie}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: { target: 'lighting.ceiling', values: { power: true } },
        }),
      },
    );
    expect(missingCsrf.status).toBe(403);
    expect(adapter.dispatched).toHaveLength(0);

    const nullInput = await fetch(
      `${baseUrl}/ui/api/capabilities/lighting.reapplyScene`,
      {
        method: 'POST',
        headers: {
          Origin: origin,
          Cookie: `lugn_ui_session=${sessionCookie}`,
          'X-Lugn-CSRF': loginBody.csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ input: null }),
      },
    );
    expect(nullInput.status).toBe(400);
    expect(adapter.dispatched).toHaveLength(0);

    const setLight = await fetch(
      `${baseUrl}/ui/api/capabilities/lighting.set`,
      {
        method: 'POST',
        headers: {
          Origin: origin,
          Cookie: `lugn_ui_session=${sessionCookie}`,
          'X-Lugn-CSRF': loginBody.csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: { target: 'lighting.ceiling', values: { power: true } },
        }),
      },
    );
    expect(setLight.status).toBe(200);
    expect(adapter.dispatched).toHaveLength(1);

    const logout = await fetch(`${baseUrl}/ui/api/session`, {
      method: 'DELETE',
      headers: {
        Origin: origin,
        Cookie: `lugn_ui_session=${sessionCookie}`,
      },
    });
    expect(logout.status).toBe(204);
    const expired = await fetch(`${baseUrl}/ui/api/overview`, {
      headers: { Cookie: `lugn_ui_session=${sessionCookie}` },
    });
    expect(expired.status).toBe(401);
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
