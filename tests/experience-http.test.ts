import { createServer, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import {
  ExperienceRequestError,
  experienceRoutes,
  type ExperienceApi,
} from '../src/application/experience-api.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import type { ArtworkProvider } from '../src/core/artwork.js';
import { LugnHttpServer } from '../src/runtime/http-server.js';

describe('room experience HTTP security and delivery', () => {
  let server: LugnHttpServer | undefined;
  let engine: LugnEngine | undefined;
  afterEach(async () => {
    await server?.stop();
    engine?.dispose();
  });

  async function fixture(artworkProvider?: ArtworkProvider) {
    const listener = createServer();
    await new Promise<void>((resolve) =>
      listener.listen(0, '127.0.0.1', resolve),
    );
    const port = (listener.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    const clock = new FakeClock();
    const adapter = new SimulatedLightingAdapter(clock);
    engine = new LugnEngine(clock, { deviceIds: [], scenes: [], adapter });
    let notify: (() => void) | undefined;
    const snapshot = {
      routines: {
        version: 1,
        generation: 'test-generation',
        definitions: [],
        runs: [],
        next: [],
      },
      intelligence: {
        suggestions: [],
        settings: { optical: { enabled: false } },
      },
    };
    const invoke = vi.fn<ExperienceApi['request']>(async () => ({
      accepted: true,
    }));
    const unsubscribe = vi.fn();
    const experience: ExperienceApi = {
      snapshot: () => snapshot,
      request: invoke,
      subscribe: (listener) => {
        notify = listener;
        return unsubscribe;
      },
    };
    server = new LugnHttpServer({
      host: '127.0.0.1',
      port,
      bearerToken: 'test-only',
      engine,
      capabilities: new CapabilityRegistry(engine),
      experience,
      ...(artworkProvider ? { artworkProvider } : {}),
      integrations: () => ({}),
    });
    await server.start();
    const origin = `http://127.0.0.1:${port}`;
    const login = await fetch(`${origin}/ui/api/session`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'test-only' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const { csrfToken } = (await login.json()) as { csrfToken: string };
    const headers = {
      Origin: origin,
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-Lugn-CSRF': csrfToken,
    };
    return {
      origin,
      headers,
      invoke,
      adapter,
      snapshot,
      unsubscribe,
      notify: () => notify?.(),
    };
  }

  it('requires the existing web session for opaque artwork and serves safe image headers', async () => {
    const token = 'a'.repeat(32);
    const read = vi.fn<ArtworkProvider['read']>(async (id) =>
      id === token
        ? {
            body: new Uint8Array([137, 80, 78, 71]),
            contentType: 'image/png',
          }
        : null,
    );
    const f = await fixture({
      snapshot: (_state, prefix) => ({
        'music.room': {
          url: `${prefix}${token}`,
          status: 'available',
          source: 'home_assistant',
        },
      }),
      read,
    });
    const path = `${f.origin}/ui/api/artwork/${token}`;
    expect((await fetch(path)).status).toBe(401);
    expect(read).not.toHaveBeenCalled();
    const image = await fetch(path, { headers: f.headers });
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('x-content-type-options')).toBe('nosniff');
    expect(image.headers.get('cross-origin-resource-policy')).toBe(
      'same-origin',
    );
    expect(image.headers.get('cache-control')).toContain('no-store');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(
      new Uint8Array([137, 80, 78, 71]),
    );
    expect(
      (
        await fetch(`${f.origin}/ui/api/artwork/${'b'.repeat(32)}`, {
          headers: f.headers,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(path, {
          headers: { ...f.headers, Origin: 'https://untrusted.invalid' },
        })
      ).status,
    ).toBe(403);
  });

  it('requires a session, same origin and CSRF for every new mutation', async () => {
    const f = await fixture();
    for (const route of experienceRoutes) {
      const url = `${f.origin}/ui/api/${route}`;
      const anonymous = await fetch(url, {
        method: 'POST',
        headers: { Origin: f.origin, 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(anonymous.status).toBe(401);
      const withoutCsrf: Record<string, string> = { ...f.headers };
      delete withoutCsrf['X-Lugn-CSRF'];
      const missingCsrf = await fetch(url, {
        method: 'POST',
        headers: withoutCsrf,
        body: '{}',
      });
      expect(missingCsrf.status).toBe(403);
      const crossOrigin = await fetch(url, {
        method: 'POST',
        headers: { ...f.headers, Origin: 'https://untrusted.invalid' },
        body: '{}',
      });
      expect(crossOrigin.status).toBe(403);
    }
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.adapter.dispatched).toHaveLength(0);
  });

  it('delivers current snapshots and validated service errors without device commands', async () => {
    const f = await fixture();
    const overview = await fetch(`${f.origin}/ui/api/overview`, {
      headers: f.headers,
    });
    expect(await overview.json()).toMatchObject(f.snapshot);
    const routines = await fetch(`${f.origin}/ui/api/routines`, {
      headers: f.headers,
    });
    expect(await routines.json()).toEqual(f.snapshot.routines);
    const action = { id: 'good-night', action: 'start', requestId: 'unique' };
    const response = await fetch(`${f.origin}/ui/api/routines/action`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify(action),
    });
    expect(response.status).toBe(200);
    expect(f.invoke).toHaveBeenCalledWith('routines/action', action, {
      actor: { type: 'user', id: 'ui' },
      source: 'lugn.ui',
    });
    f.invoke.mockRejectedValueOnce(
      new ExperienceRequestError(409, 'routine_definitions_changed'),
    );
    const stale = await fetch(`${f.origin}/ui/api/routines/save`, {
      method: 'POST',
      headers: f.headers,
      body: '{}',
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: 'routine_definitions_changed',
    });
    expect(f.adapter.dispatched).toHaveLength(0);
  });

  it('publishes experience-only changes over the existing stream and cleans up subscribers', async () => {
    const f = await fixture();
    const response = await fetch(`${f.origin}/ui/api/events`, {
      headers: f.headers,
    });
    const reader = response.body!.getReader();
    const initial = await reader.read();
    expect(new TextDecoder().decode(initial.value)).toContain(
      'test-generation',
    );
    f.snapshot.routines.generation = 'changed-generation';
    f.notify();
    const updated = await reader.read();
    expect(new TextDecoder().decode(updated.value)).toContain(
      'changed-generation',
    );
    await reader.cancel();
    await vi.waitFor(() => expect(f.unsubscribe).toHaveBeenCalledOnce());
    expect(f.adapter.dispatched).toHaveLength(0);
  });
});
