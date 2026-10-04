import { createServer } from 'node:net';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { LugnDisplayServer } from '../src/runtime/display-server.js';
import { FakeClock } from '../src/core/clock.js';

const token = 'a'.repeat(32);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(streaming = true) {
  const portFinder = createServer();
  await new Promise<void>((resolve) =>
    portFinder.listen(0, '127.0.0.1', resolve),
  );
  const address = portFinder.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const port = address.port;
  await new Promise<void>((resolve) => portFinder.close(() => resolve()));
  const engine = new LugnEngine(
    new FakeClock(Date.parse('2026-10-04T12:00:00+02:00')),
  );
  const server = new LugnDisplayServer({
    host: '127.0.0.1',
    port,
    hubs: [{ id: 'bed', role: 'bed', token, castHost: '127.0.0.1' }],
    capabilities: new CapabilityRegistry(engine),
    scenes: [...engine.scenes.values()],
    stateProvider: () => {
      if (snapshotFails) throw new Error('Snapshot temporarily unavailable');
      return engine.state;
    },
    ...(streaming ? { stateStream: engine.stream } : {}),
  });
  let snapshotFails = false;
  await server.start();
  cleanups.push(async () => {
    await server.stop();
    engine.dispose();
  });
  const base = `http://127.0.0.1:${port}/k/${token}/display-api`;
  const open = async (headers: Record<string, string> = {}) => {
    const abort = new AbortController();
    const response = await fetch(`${base}/events`, {
      signal: abort.signal,
      headers,
    });
    cleanups.push(async () => {
      abort.abort();
    });
    if (!response.body) throw new Error('Missing stream');
    const reader = response.body.getReader();
    let buffer = '';
    return {
      response,
      abort,
      next: async () => {
        while (!buffer.includes('\n\n')) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('Stream ended');
          buffer += new TextDecoder().decode(chunk.value);
        }
        const end = buffer.indexOf('\n\n');
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split('\n')
          .find((line) => line.startsWith('data: '));
        return JSON.parse(data?.slice(6) ?? '{}') as {
          state: typeof engine.state;
          role: string;
          deliveryRevision: number;
        };
      },
    };
  };
  return {
    engine,
    server,
    base,
    open,
    breakSnapshot: () => {
      snapshotFails = true;
    },
  };
}

describe('secret-path Hub state stream', () => {
  it('closes an event stream when an asynchronous snapshot provider fails', async () => {
    const { engine, open, breakSnapshot } = await setup();
    const stream = await open();
    await stream.next();
    breakSnapshot();
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
    });
    await expect(stream.next()).rejects.toThrow();
  });
  it('sends current state immediately and pushes presence/scene changes without polling', async () => {
    const { engine, server, open } = await setup();
    const stream = await open();
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get('content-type')).toContain(
      'text/event-stream',
    );
    const initial = await stream.next();
    expect(initial.state.revision).toBe(engine.state.revision);
    expect(initial.role).toBe('bed');
    expect(server.lastHubHeartbeatAt('bed')).toBeDefined();
    await engine.activateScene('scene.cozy', { type: 'user' });
    await engine.handlePresence({
      type: 'presence.changed',
      presence: 'occupied',
      personCount: 2,
    });
    const update = await stream.next();
    expect(update.state.lighting.currentScene).toBe('scene.cozy');
    expect(update.state.presence.personCount).toBe(2);
    expect(update.state.revision).toBeGreaterThan(initial.state.revision);
    expect(update.deliveryRevision).toBeGreaterThan(initial.deliveryRevision);
  });

  it('reconnects from a stale Last-Event-ID using a fresh authoritative snapshot', async () => {
    const { engine, open } = await setup();
    await engine.activateScene('scene.movie', { type: 'user' });
    const stream = await open({ 'Last-Event-ID': '0' });
    const payload = await stream.next();
    expect(payload.state.revision).toBe(engine.state.revision);
    expect(payload.state.lighting.currentScene).toBe('scene.movie');
  });

  it('preserves path credentials, Host/Origin checks and rejects unexpected query parameters', async () => {
    const { base } = await setup();
    expect(
      (await fetch(`${base.replace(token, 'b'.repeat(32))}/events`)).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${base}/events`, {
          headers: { Origin: 'http://untrusted.test' },
        })
      ).status,
    ).toBe(403);
    const invalidHost = await new Promise<number | undefined>(
      (resolve, reject) => {
        const req = request(
          `${base}/events`,
          { headers: { Host: 'untrusted.test' } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        req.once('error', reject);
        req.end();
      },
    );
    expect(invalidHost).toBe(400);
    expect((await fetch(`${base}/events?token=bad`)).status).toBe(400);
  });

  it('bounds subscriptions per Hub and retains polling while streaming is unavailable', async () => {
    const { open, base } = await setup();
    const first = await open();
    await first.next();
    const second = await open();
    await second.next();
    expect((await fetch(`${base}/events`)).status).toBe(503);
    expect((await fetch(`${base}/state`)).status).toBe(200);
    const fallback = await setup(false);
    expect((await fetch(`${fallback.base}/events`)).status).toBe(503);
    expect((await fetch(`${fallback.base}/state`)).status).toBe(200);
  });
});
