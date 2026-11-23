import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { createContext, runInContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { SimulatedLightingAdapter } from '../src/adapters/simulated-lighting.js';
import { CapabilityRegistry } from '../src/application/capabilities.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import { LugnHttpServer } from '../src/runtime/http-server.js';
import { PeopleError } from '../src/runtime/photo-intel/people.js';
import type {
  PhotoLibrary,
  PhotoPeopleApi,
} from '../src/runtime/photo-library.js';

const PHOTO = 'a'.repeat(24);
const FACE = `${PHOTO}.0`;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

function fakeApi(calls: unknown[][]): PhotoPeopleApi {
  return {
    status: () => ({
      available: true,
      reason: null,
      brain: { intelAt: 1_763_900_000_000, analysed: 1, photos: 1, faces: 1 },
    }),
    summary: () => ({ people: 1, pending: 0 }),
    peopleView: () => ({
      people: [
        {
          id: 'p1',
          name: null,
          confirmed: false,
          hidden: false,
          faces: 1,
          photos: 1,
          samples: [
            { id: FACE, photoId: PHOTO, x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
          ],
        },
      ],
      unassigned: { count: 0, samples: [] },
      ignored: 0,
    }),
    rename: (...args) => {
      if (args[0] === 'p9')
        throw new PeopleError('not_found', 'No such person.');
      calls.push(['rename', ...args]);
    },
    confirm: (...args) => void calls.push(['confirm', ...args]),
    setHidden: (...args) => void calls.push(['hide', ...args]),
    moveFace: (...args) => void calls.push(['move', ...args]),
    merge: (...args) => void calls.push(['merge', ...args]),
    faceCrop: async (id) => (id === FACE ? JPEG : null),
    faceContext: () => ({ photoId: PHOTO }),
  };
}

describe('the photo people panel API', () => {
  let server: LugnHttpServer | undefined;
  let engine: LugnEngine | undefined;
  afterEach(async () => {
    await server?.stop();
    engine?.dispose();
    server = undefined;
    engine = undefined;
  });

  async function start(withLibrary = true) {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const clock = new FakeClock();
    engine = new LugnEngine(clock, {
      deviceIds: ['lighting.ceiling'],
      scenes: [],
      adapter: new SimulatedLightingAdapter(clock),
    });
    const calls: unknown[][] = [];
    const library = {
      peopleApi: () => fakeApi(calls),
      readMain: async (id: string) => (id === PHOTO ? JPEG : null),
    } as unknown as PhotoLibrary;
    server = new LugnHttpServer({
      host: '127.0.0.1',
      port,
      bearerToken: 'local-test-token',
      engine,
      capabilities: new CapabilityRegistry(engine),
      integrations: () => ({}),
      ...(withLibrary ? { photoLibrary: library } : {}),
    });
    await server.start();
    const base = `http://127.0.0.1:${port}`;
    const login = await fetch(`${base}/ui/api/session`, {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'local-test-token' }),
    });
    const csrf = ((await login.json()) as { csrfToken: string }).csrfToken;
    const cookie = `lugn_ui_session=${login.headers.get('set-cookie')?.match(/lugn_ui_session=([^;]+)/)?.[1]}`;
    const post = (
      path: string,
      body: unknown,
      headers: Record<string, string> = {},
    ) =>
      fetch(`${base}/ui/api/photo-people${path}`, {
        method: 'POST',
        headers: {
          Origin: base,
          Cookie: cookie,
          'X-Lugn-CSRF': csrf,
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
      });
    return { base, cookie, csrf, calls, post };
  }

  it('needs a signed-in session and tells the page when the frame is off', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/ui/api/photo-people`)).status).toBe(401);
    expect((await fetch(`${base}/ui/photo-people.js`)).status).toBe(200);
    await server!.stop();
    const off = await start(false);
    const response = await fetch(`${off.base}/ui/api/photo-people`, {
      headers: { Cookie: off.cookie },
    });
    expect(response.status).toBe(404);
    const overview = (await (
      await fetch(`${off.base}/ui/api/overview`, {
        headers: { Cookie: off.cookie },
      })
    ).json()) as { photoPeople?: unknown };
    expect(overview.photoPeople).toBeUndefined();
  });

  it('lists people, serves face crops and pictures, and announces itself in the overview', async () => {
    const { base, cookie } = await start();
    const headers = { Cookie: cookie };
    const list = (await (
      await fetch(`${base}/ui/api/photo-people`, { headers })
    ).json()) as {
      status: { brain: { photos: number } };
      people: Array<{ id: string }>;
    };
    expect(list.people[0]?.id).toBe('p1');
    expect(list.status.brain.photos).toBe(1);
    const crop = await fetch(`${base}/ui/api/photo-people/faces/${FACE}.jpg`, {
      headers,
    });
    expect(crop.status).toBe(200);
    expect(crop.headers.get('content-type')).toBe('image/jpeg');
    expect(crop.headers.get('cross-origin-resource-policy')).toBe(
      'same-origin',
    );
    expect(Array.from(new Uint8Array(await crop.arrayBuffer()))).toEqual(
      Array.from(JPEG),
    );
    expect(
      (
        await fetch(
          `${base}/ui/api/photo-people/faces/${'b'.repeat(24)}.0.jpg`,
          { headers },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${base}/ui/api/photo-people/photos/${PHOTO}.jpg`, {
          headers,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(
          `${base}/ui/api/photo-people/photos/${'c'.repeat(24)}.jpg`,
          { headers },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${base}/ui/api/photo-people/photos/..%2F..%2Fetc.jpg`, {
          headers,
        })
      ).status,
    ).toBe(404);
    const overview = (await (
      await fetch(`${base}/ui/api/overview`, { headers })
    ).json()) as {
      photoPeople: { people: number };
    };
    expect(overview.photoPeople).toEqual({ people: 1, pending: 0 });
    // A page from another site cannot read faces.
    const cross = await fetch(`${base}/ui/api/photo-people`, {
      headers: { ...headers, Origin: 'http://attacker.example' },
    });
    expect(cross.status).toBe(403);
  });

  it('makes each correction through the one door, with the same checks as the rest of the panel', async () => {
    const { calls, post, base, cookie } = await start();
    expect((await post('/people/p1', { name: 'Anna' })).status).toBe(200);
    expect((await post('/people/p1', { confirm: true })).status).toBe(200);
    expect((await post('/people/p1', { hidden: true })).status).toBe(200);
    expect((await post('/merge', { from: 'p2', into: 'p1' })).status).toBe(200);
    expect((await post(`/faces/${FACE}`, { person: 'p1' })).status).toBe(200);
    expect((await post(`/faces/${FACE}`, { new: true })).status).toBe(200);
    expect((await post(`/faces/${FACE}`, { none: true })).status).toBe(200);
    expect(calls).toEqual([
      ['rename', 'p1', 'Anna'],
      ['confirm', 'p1'],
      ['hide', 'p1', true],
      ['merge', 'p2', 'p1'],
      ['move', FACE, { person: 'p1' }],
      ['move', FACE, 'new'],
      ['move', FACE, 'none'],
    ]);
    // Unknown things and bad bodies are refused without touching anything.
    calls.length = 0;
    expect((await post('/people/p9', { name: 'X' })).status).toBe(404);
    expect((await post('/people/p1', { name: 'x'.repeat(200) })).status).toBe(
      400,
    );
    expect((await post('/people/p1', { surprise: true })).status).toBe(400);
    expect((await post('/merge', { from: 'p1', into: '../p2' })).status).toBe(
      400,
    );
    expect(
      (await post(`/faces/${FACE}`, { person: 'p1', none: true })).status,
    ).toBe(400);
    expect((await post('/nothing', {})).status).toBe(404);
    expect(calls).toEqual([]);
    // CSRF, origin and content type.
    expect(
      (await post('/people/p1', { name: 'A' }, { 'X-Lugn-CSRF': 'wrong' }))
        .status,
    ).toBe(403);
    expect(
      (
        await post(
          '/people/p1',
          { name: 'A' },
          { Origin: 'http://attacker.example' },
        )
      ).status,
    ).toBe(403);
    const form = await fetch(`${base}/ui/api/photo-people/people/p1`, {
      method: 'POST',
      headers: { Origin: base, Cookie: cookie, 'Content-Type': 'text/plain' },
      body: '{}',
    });
    expect([403, 415]).toContain(form.status);
    expect(calls).toEqual([]);
    const put = await fetch(`${base}/ui/api/photo-people/people/p1`, {
      method: 'PUT',
      headers: { Origin: base, Cookie: cookie },
    });
    expect(put.status).toBe(405);
  });
});

describe('the panel status chip', () => {
  type Status = {
    available: boolean;
    brain?: { intelAt: number | null; analysed: number; photos: number };
  } | null;
  function load(): (status: Status, now?: number) => [string, string] {
    const noop = () => undefined;
    const sandbox: Record<string, unknown> = {
      window: { addEventListener: noop, setTimeout: noop, clearTimeout: noop },
      document: { addEventListener: noop, getElementById: () => null },
      Intl,
      Date,
    };
    const context = createContext(sandbox);
    runInContext(
      `${readFileSync(new URL('../web/photo-people.js', import.meta.url), 'utf8')}
globalThis.statusText = statusText;`,
      context,
    );
    return sandbox['statusText'] as (s: Status, n?: number) => [string, string];
  }
  const statusText = load();
  const now = Date.UTC(2026, 10, 23, 12);

  it('says what Kuffe has done, that it is awaited, or that it has gone quiet', () => {
    expect(statusText(null)).toEqual(['Läser …', 'warn']);
    expect(statusText({ available: false })[0]).toBe('Bildanalysen är av');
    expect(
      statusText(
        { available: true, brain: { intelAt: null, analysed: 0, photos: 9 } },
        now,
      ),
    ).toEqual(['Väntar på Kuffe', 'warn']);
    expect(
      statusText(
        {
          available: true,
          brain: { intelAt: now - 60_000, analysed: 412, photos: 418 },
        },
        now,
      ),
    ).toEqual(['Kuffe: 412 av 418 bilder analyserade', 'warn']);
    expect(
      statusText(
        { available: true, brain: { intelAt: now, analysed: 1, photos: 1 } },
        now,
      ),
    ).toEqual(['Kuffe: 1 av 1 bild analyserad', 'ok']);
    const [quiet, tone] = statusText(
      {
        available: true,
        brain: { intelAt: now - 7 * 3_600_000, analysed: 1, photos: 1 },
      },
      now,
    );
    expect(quiet).toMatch(/^Kuffe har inte hörts av sedan \d/);
    expect(tone).toBe('warn');
  });
});
