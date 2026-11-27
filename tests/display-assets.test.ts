import type * as FileSystem from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { request, type IncomingHttpHeaders } from 'node:http';
import { createServer } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import { LugnDisplayServer } from '../src/runtime/display-server.js';

// Stands in for an edited file without touching the working tree.
const reads = vi.hoisted(() => ({
  override: undefined as { url: string; body: Buffer } | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FileSystem>();
  return {
    ...fs,
    readFile: (async (path: unknown, ...rest: unknown[]) => {
      const override = reads.override;
      if (override && path === override.url) return override.body;
      return fs.readFile(path as string, ...(rest as [BufferEncoding]));
    }) as typeof fs.readFile,
  };
});

const token = 'a'.repeat(32);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const portFinder = createServer();
  await new Promise<void>((resolve) =>
    portFinder.listen(0, '127.0.0.1', resolve),
  );
  const address = portFinder.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const port = address.port;
  await new Promise<void>((resolve) => portFinder.close(() => resolve()));
  const engine = new LugnEngine(new FakeClock(1_000_000));
  const server = new LugnDisplayServer({
    host: '127.0.0.1',
    port,
    hubs: [{ id: 'bed', role: 'bed', token, castHost: '127.0.0.1' }],
    capabilities: new CapabilityRegistry(engine),
    scenes: [...engine.scenes.values()],
    stateProvider: () => engine.state,
  });
  await server.start();
  cleanups.push(async () => {
    await server.stop();
    engine.dispose();
  });
  // node:http, which leaves the body as it came over the wire.
  return (path: string, acceptEncoding?: string) =>
    new Promise<{ headers: IncomingHttpHeaders; body: Buffer }>(
      (resolve, reject) => {
        request(
          {
            host: '127.0.0.1',
            port,
            path: `/k/${token}${path}`,
            headers: acceptEncoding
              ? { 'accept-encoding': acceptEncoding }
              : {},
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () =>
              resolve({
                headers: response.headers,
                body: Buffer.concat(chunks),
              }),
            );
          },
        )
          .on('error', reject)
          .end();
      },
    );
}

describe('Hub page files', () => {
  it('are compressed for a client that accepts gzip', async () => {
    const get = await setup();
    for (const path of ['/', '/display.css', '/display.js', '/pages.js']) {
      const plain = await get(path);
      const packed = await get(path, 'gzip, deflate');
      expect(plain.headers['content-encoding']).toBeUndefined();
      expect(packed.headers['content-encoding']).toBe('gzip');
      expect(gunzipSync(packed.body).equals(plain.body)).toBe(true);
      expect(packed.body.byteLength).toBeLessThan(plain.body.byteLength / 2);
      expect(Number(packed.headers['content-length'])).toBe(
        packed.body.byteLength,
      );
      for (const response of [plain, packed]) {
        expect(response.headers.vary).toBe('accept-encoding');
        expect(response.headers['cache-control']).toBe('no-store');
      }
    }
    expect((await get('/display.css')).body.toString()).toBe(
      await readFile(new URL('../src/ui/display.css', import.meta.url), 'utf8'),
    );
  });

  it('follow a file that changes on disk, compressed or not', async () => {
    const get = await setup();
    const url = new URL('../src/ui/hub-history.js', import.meta.url);
    const original = await readFile(url);
    const unpacked = async () =>
      gunzipSync((await get('/hub-history.js', 'gzip')).body);
    expect((await unpacked()).equals(original)).toBe(true);
    // A UI-only update replaces files under a running server.
    const changed = Buffer.concat([original, Buffer.from('// changed\n')]);
    reads.override = { url: url.pathname, body: changed };
    expect((await unpacked()).equals(changed)).toBe(true);
    reads.override = undefined;
    expect((await unpacked()).equals(original)).toBe(true);
  });

  it('stay plain when gzip is refused or not offered', async () => {
    const get = await setup();
    for (const encoding of ['br', 'gzip;q=0', 'gzip; q=0.0, deflate'])
      expect(
        (await get('/display.js', encoding)).headers['content-encoding'],
      ).toBeUndefined();
    expect(
      (await get('/display.js', 'br;q=1, GZIP;q=0.5')).headers[
        'content-encoding'
      ],
    ).toBe('gzip');
  });

  it('leave state responses uncompressed', async () => {
    const get = await setup();
    const state = await get('/display-api/state', 'gzip');
    expect(state.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(state.body.toString())).toHaveProperty('state');
  });
});
