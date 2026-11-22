import { createServer } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { FakeClock } from '../src/core/clock.js';
import { LugnDisplayServer } from '../src/runtime/display-server.js';
import type { PhotoLibrary } from '../src/runtime/photo-library.js';

const hubToken = 'a'.repeat(32);
const id = 'A'.repeat(24);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(withLibrary: boolean) {
  const finder = createServer();
  await new Promise<void>((resolve) => finder.listen(0, '127.0.0.1', resolve));
  const address = finder.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const port = address.port;
  await new Promise<void>((resolve) => finder.close(() => resolve()));
  const engine = new LugnEngine(new FakeClock());
  const library = {
    snapshot: () => ({
      revision: 'r1',
      photos: [{ id, w: 480, h: 640, date: '2026-11-04', place: 'Svedala' }],
    }),
    read: async (wanted: string, variant: 'main' | 'backdrop') =>
      wanted === id ? new Uint8Array([variant === 'main' ? 1 : 2]) : null,
  } as unknown as PhotoLibrary;
  const server = new LugnDisplayServer({
    host: '127.0.0.1',
    port,
    hubs: [{ id: 'bed', role: 'bed', token: hubToken, castHost: '127.0.0.1' }],
    capabilities: new CapabilityRegistry(engine),
    scenes: [...engine.scenes.values()],
    stateProvider: () => engine.state,
    stateStream: engine.stream,
    ...(withLibrary ? { photoLibrary: library } : {}),
  });
  await server.start();
  cleanups.push(async () => {
    await server.stop();
    engine.dispose();
  });
  return `http://127.0.0.1:${port}/k/${hubToken}/display-api/photos`;
}

it('lists the photos and serves each picture and backdrop for a week', async () => {
  const base = await setup(true);
  const list = await fetch(base);
  expect(list.status).toBe(200);
  expect(await list.json()).toMatchObject({
    revision: 'r1',
    photos: [{ id, place: 'Svedala' }],
  });
  const main = await fetch(`${base}/${id}`);
  expect(main.status).toBe(200);
  expect(main.headers.get('content-type')).toBe('image/jpeg');
  expect(main.headers.get('cache-control')).toContain('immutable');
  expect([...new Uint8Array(await main.arrayBuffer())]).toEqual([1]);
  const backdrop = await fetch(`${base}/${id}/backdrop`);
  expect([...new Uint8Array(await backdrop.arrayBuffer())]).toEqual([2]);
});

it('answers 404 for unknown ids, odd paths and an unconfigured frame', async () => {
  const base = await setup(true);
  for (const path of [
    `/${'B'.repeat(24)}`,
    `/${'A'.repeat(23)}`,
    `/${id}/other`,
    `/${id}/backdrop/extra`,
    '/..%2F..%2Fstate',
  ])
    expect((await fetch(`${base}${path}`)).status).toBe(404);
  const none = await setup(false);
  expect((await fetch(none)).status).toBe(404);
});

it('refuses a cross-site request', async () => {
  const base = await setup(true);
  expect(
    (await fetch(base, { headers: { 'sec-fetch-site': 'cross-site' } })).status,
  ).toBe(403);
  expect(
    (await fetch(base, { headers: { origin: 'http://evil.example' } })).status,
  ).toBe(403);
});
