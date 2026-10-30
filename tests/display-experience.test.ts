import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import {
  ExperienceRequestError,
  type ExperienceApi,
} from '../src/application/experience-api.js';
import { FakeClock } from '../src/core/clock.js';
import { LugnDisplayServer } from '../src/runtime/display-server.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('Hub experience authorization and delivery', () => {
  async function fixture() {
    const finder = createServer();
    await new Promise<void>((resolve) =>
      finder.listen(0, '127.0.0.1', resolve),
    );
    const address = finder.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing port');
    const port = address.port;
    await new Promise<void>((resolve) => finder.close(() => resolve()));
    const engine = new LugnEngine(new FakeClock());
    cleanups.push(() => engine.dispose());
    let notify: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const snapshot = {
      routines: { generation: 'first', definitions: [], runs: [], next: [] },
    };
    const request = vi.fn<ExperienceApi['request']>(async () => ({
      accepted: true,
    }));
    const server = new LugnDisplayServer({
      host: '127.0.0.1',
      port,
      hubs: [
        {
          id: 'bed',
          role: 'bed',
          token: 'b'.repeat(32),
          castHost: '127.0.0.1',
        },
        {
          id: 'desk',
          role: 'desk',
          token: 'd'.repeat(32),
          castHost: '127.0.0.1',
        },
      ],
      capabilities: new CapabilityRegistry(engine),
      scenes: [...engine.scenes.values()],
      stateProvider: () => engine.state,
      stateStream: engine.stream,
      experience: {
        snapshot: () => snapshot,
        request,
        subscribe: (listener) => {
          notify = listener;
          return unsubscribe;
        },
      },
    });
    await server.start();
    cleanups.push(() => server.stop());
    const origin = `http://127.0.0.1:${port}`;
    return {
      origin,
      server,
      request,
      snapshot,
      unsubscribe,
      notify: () => notify?.(),
    };
  }

  it('uses only the authenticated Hub role for both action types and rejects untrusted origins', async () => {
    const f = await fixture();
    for (const role of ['bed', 'desk']) {
      for (const [path, route] of [
        ['routine', 'routines/action'],
        ['suggestion', 'intelligence/suggestion'],
      ]) {
        const url = `${f.origin}${f.server.pathForHub(role)}display-api/${path}`;
        const body = {
          id: 'test',
          action: path === 'routine' ? 'cancel' : 'dismiss',
        };
        const invalid = await fetch(url, {
          method: 'POST',
          headers: {
            Origin: 'https://untrusted.invalid',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        expect(invalid.status).toBe(403);
        const valid = await fetch(url, {
          method: 'POST',
          headers: { Origin: f.origin, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(valid.status).toBe(200);
        expect(f.request).toHaveBeenLastCalledWith(route, body, {
          actor: { type: 'user', id: `nest-dashboard:${role}` },
          source: `lugn.cast_dashboard.${role}`,
        });
      }
    }
    expect(f.request).toHaveBeenCalledTimes(4);
    f.request.mockRejectedValueOnce(
      new ExperienceRequestError(409, 'routine_disabled'),
    );
    const disabled = await fetch(
      `${f.origin}${f.server.pathForHub('bed')}display-api/routine`,
      {
        method: 'POST',
        headers: { Origin: f.origin, 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    expect(disabled.status).toBe(409);
    expect(await disabled.json()).toEqual({ error: 'routine_disabled' });
  });

  it('streams routine-only state changes and removes its listener on disconnect', async () => {
    const f = await fixture();
    const stream = await fetch(
      `${f.origin}${f.server.pathForHub('bed')}display-api/events`,
    );
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      '"generation":"first"',
    );
    f.snapshot.routines.generation = 'second';
    f.notify();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      '"generation":"second"',
    );
    await reader.cancel();
    await vi.waitFor(() => expect(f.unsubscribe).toHaveBeenCalledOnce());
  });
});
