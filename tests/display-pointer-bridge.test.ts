import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import {
  LugnDisplayServer,
  type LugnDisplayHub,
} from '../src/runtime/display-server.js';

const deskToken = 'd'.repeat(32);
const bedToken = 'b'.repeat(32);
const pointerToken = 'pointer-secret-0123456789';
const defaultCsp =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors https://www.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function freePort(): Promise<number> {
  const finder = createServer();
  await new Promise<void>((resolve) => finder.listen(0, '127.0.0.1', resolve));
  const address = finder.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve) => finder.close(() => resolve()));
  return address.port;
}

function serverOptions(port: number, hubs: LugnDisplayHub[]) {
  const engine = new LugnEngine(
    new FakeClock(Date.parse('2026-10-04T12:00:00+02:00')),
  );
  cleanups.push(async () => engine.dispose());
  return {
    host: '127.0.0.1',
    port,
    hubs,
    capabilities: new CapabilityRegistry(engine),
    scenes: [...engine.scenes.values()],
    stateProvider: () => engine.state,
  };
}

async function setup() {
  const port = await freePort();
  const server = new LugnDisplayServer(
    serverOptions(port, [
      {
        id: 'desk',
        role: 'desk',
        token: deskToken,
        castHost: '127.0.0.1',
        pointerBridge: {
          url: 'ws://192.168.10.20:8791/hub-pointer',
          token: pointerToken,
        },
      },
      { id: 'bed', role: 'bed', token: bedToken, castHost: '127.0.0.1' },
    ]),
  );
  await server.start();
  cleanups.push(() => server.stop());
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    desk: `${origin}/k/${deskToken}`,
    bed: `${origin}/k/${bedToken}`,
  };
}

describe('display pointer bridge', () => {
  it('allows the agent WebSocket origin only in the configured Hub CSP', async () => {
    const { origin, desk, bed } = await setup();
    for (const path of ['/', '/display.js', '/display-api/state']) {
      const deskCsp = (await fetch(`${desk}${path}`)).headers.get(
        'content-security-policy',
      );
      expect(deskCsp).toBe(
        defaultCsp.replace(
          "connect-src 'self'",
          "connect-src 'self' ws://192.168.10.20:8791",
        ),
      );
      expect(
        (await fetch(`${bed}${path}`)).headers.get('content-security-policy'),
      ).toBe(defaultCsp);
    }
    const unauthenticated = await fetch(`${origin}/k/${'x'.repeat(32)}/`);
    expect(unauthenticated.status).toBe(404);
    expect(unauthenticated.headers.get('content-security-policy')).toBe(
      defaultCsp,
    );
  });

  it('serves pointer-bridge.js and loads it after display.js', async () => {
    const { desk, bed } = await setup();
    for (const base of [desk, bed]) {
      const response = await fetch(`${base}/pointer-bridge.js`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(
        'text/javascript; charset=utf-8',
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await response.text()).toBe(
        readFileSync(
          new URL('../src/ui/pointer-bridge.js', import.meta.url),
          'utf8',
        ),
      );
    }
    const html = await (await fetch(`${desk}/`)).text();
    expect(
      html.indexOf('<script src="./pointer-bridge.js" defer></script>'),
    ).toBeGreaterThan(html.indexOf('<script src="./display.js" defer>'));
  });

  it('returns bridge credentials only to the configured Hub', async () => {
    const { desk, bed } = await setup();
    const configured = await fetch(`${desk}/display-api/pointer-bridge`);
    expect(configured.status).toBe(200);
    expect(configured.headers.get('cache-control')).toBe('no-store');
    expect(await configured.json()).toEqual({
      url: 'ws://192.168.10.20:8791/hub-pointer',
      token: pointerToken,
    });
    const other = await fetch(`${bed}/display-api/pointer-bridge`);
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({
      error: 'pointer_bridge_not_configured',
    });
    expect(
      (
        await fetch(`${desk}/display-api/pointer-bridge`, {
          headers: { Origin: 'http://untrusted.test' },
        })
      ).status,
    ).toBe(403);
  });

  it('rejects a malformed bridge URL or token at startup', async () => {
    const port = await freePort();
    const hub = (pointerBridge: { url: string; token: string }) => [
      {
        id: 'desk',
        role: 'desk' as const,
        token: deskToken,
        castHost: '127.0.0.1',
        pointerBridge,
      },
    ];
    for (const url of [
      'http://192.168.10.20:8791/hub-pointer',
      'ws://192.168.10.20:8791/hub-pointer?token=x',
      'ws://192.168.10.20:8791/hub-pointer#x',
      'ws://user@192.168.10.20:8791/hub-pointer',
    ])
      expect(
        () =>
          new LugnDisplayServer(
            serverOptions(port, hub({ url, token: pointerToken })),
          ),
      ).toThrow('pointer bridge URL');
    for (const token of ['short', 'has a space in the middle'])
      expect(
        () =>
          new LugnDisplayServer(
            serverOptions(
              port,
              hub({ url: 'ws://192.168.10.20:8791/hub-pointer', token }),
            ),
          ),
      ).toThrow('pointer bridge token');
  });
});
