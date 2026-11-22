import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('serves the pager and its pages and loads them after the dashboard', async () => {
    const { origin, bed } = await setup();
    for (const [file, type] of [
      ['pages.css', 'text/css; charset=utf-8'],
      ['pages.js', 'text/javascript; charset=utf-8'],
      ['page-views.js', 'text/javascript; charset=utf-8'],
      ['cameras-page.css', 'text/css; charset=utf-8'],
      ['cameras-page.js', 'text/javascript; charset=utf-8'],
      ['quick-menu.css', 'text/css; charset=utf-8'],
      ['quick-menu.js', 'text/javascript; charset=utf-8'],
      ['photos-page.css', 'text/css; charset=utf-8'],
      ['photos-page.js', 'text/javascript; charset=utf-8'],
    ] as const) {
      const response = await fetch(`${bed}/${file}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(type);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toBe(
        readFileSync(new URL(`../src/ui/${file}`, import.meta.url), 'utf8'),
      );
      expect(
        (await fetch(`${origin}/k/${'x'.repeat(32)}/${file}`)).status,
      ).toBe(404);
    }
    const html = await (await fetch(`${bed}/`)).text();
    const bridge = html.indexOf('<script src="./pointer-bridge.js" defer>');
    const pages = html.indexOf('<script src="./pages.js" defer></script>');
    const views = html.indexOf('<script src="./page-views.js" defer></script>');
    expect(bridge).toBeGreaterThan(html.indexOf('<script src="./display.js"'));
    expect(pages).toBeGreaterThan(bridge);
    expect(views).toBeGreaterThan(pages);
    expect(
      html.indexOf('<script src="./cameras-page.js" defer></script>'),
    ).toBeGreaterThan(views);
    expect(html).toContain('<link rel="stylesheet" href="./pages.css" />');
    expect(html.indexOf('id="hub-track"')).toBeLessThan(
      html.indexOf('id="app-root"'),
    );
  });

  it('serves the on-device probe and logs what a Hub reports', async () => {
    const { origin, bed } = await setup();
    const response = await fetch(`${bed}/hub-probe.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'text/javascript; charset=utf-8',
    );
    expect(await response.text()).toBe(
      readFileSync(new URL('../src/ui/hub-probe.js', import.meta.url), 'utf8'),
    );
    // Nothing loads it but a Hub opened with #probe.
    expect(await (await fetch(`${bed}/`)).text()).not.toContain('hub-probe');
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const post = (body: unknown, url = `${bed}/display-api/probe`) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify(body),
      });
    const report = { run: 'abc123', phase: 'idle', data: { fps: 31.5 } };
    // Another origin is refused.
    expect(
      (
        await fetch(`${bed}/display-api/probe`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'http://evil.example',
          },
          body: JSON.stringify(report),
        })
      ).status,
    ).toBe(403);
    expect((await post(report)).status).toBe(202);
    expect(log).toHaveBeenCalledWith(
      `[lugn] hub probe hub=bed ${JSON.stringify(report)}`,
    );
    // Anything but the report shape is refused and never logged.
    log.mockClear();
    expect((await post({ ...report, extra: 1 })).status).toBe(400);
    expect((await post({ run: 'x', phase: 'y' })).status).toBe(400);
    expect((await post({ ...report, phase: 'unknown' })).status).toBe(400);
    expect(
      (await post({ ...report, data: { text: 'x'.repeat(400) } })).status,
    ).toBe(400);
    expect((await post({ ...report, data: { deep: [[[[1]]]] } })).status).toBe(
      400,
    );
    expect(
      (await post({ ...report, data: { a: 'x'.repeat(100) } })).status,
    ).toBe(202);
    expect(
      (await post(report, `${origin}/k/${'x'.repeat(32)}/display-api/probe`))
        .status,
    ).toBe(404);
    // Only the one valid report in between was logged.
    expect(log).toHaveBeenCalledTimes(1);
    // A Hub that floods it is cut off.
    let limited = 0;
    for (let index = 0; index < 60; index += 1)
      if ((await post(report)).status === 429) limited += 1;
    expect(limited).toBeGreaterThan(0);
    log.mockRestore();
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
