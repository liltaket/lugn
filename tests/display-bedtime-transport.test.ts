import { createServer } from 'node:net';
import { expect, it, vi } from 'vitest';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import type { ExperienceApi } from '../src/application/experience-api.js';
import { FakeClock } from '../src/core/clock.js';
import { LugnDisplayServer } from '../src/runtime/display-server.js';

it('routes bedtime only with an authenticated Hub token and matching origin', async () => {
  const finder = createServer();
  await new Promise<void>((resolve) => finder.listen(0, '127.0.0.1', resolve));
  const address = finder.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  const port = address.port;
  await new Promise<void>((resolve) => finder.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const engine = new LugnEngine(new FakeClock());
  const request = vi.fn<ExperienceApi['request']>(async () => ({
    accepted: true,
  }));
  const server = new LugnDisplayServer({
    host: '127.0.0.1',
    port,
    hubs: [
      { id: 'bed', role: 'bed', token: 'b'.repeat(32), castHost: '127.0.0.1' },
    ],
    capabilities: new CapabilityRegistry(engine),
    scenes: [...engine.scenes.values()],
    stateProvider: () => engine.state,
    stateStream: engine.stream,
    experience: {
      snapshot: () => ({}),
      subscribe: () => () => undefined,
      request,
    },
  });
  try {
    await server.start();
    const route = `${origin}${server.pathForHub('bed')}display-api/bedtime`;
    const body = {
      action: 'start',
      wakeTime: '07:30',
      mode: 'auto',
      music: false,
      expectedGeneration: 'generation',
      requestId: 'request',
    };
    expect(
      (
        await fetch(route, {
          method: 'POST',
          headers: {
            Origin: 'https://foreign.invalid',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(403);
    expect(request).not.toHaveBeenCalled();
    expect(
      (
        await fetch(`${origin}/k/${'x'.repeat(32)}/display-api/bedtime`, {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(404);
    expect(request).not.toHaveBeenCalled();
    const response = await fetch(route, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(request).toHaveBeenCalledExactlyOnceWith('routines/bedtime', body, {
      actor: { type: 'user', id: 'nest-dashboard:bed' },
      source: 'lugn.cast_dashboard.bed',
    });
  } finally {
    await server.stop();
    engine.dispose();
  }
});
