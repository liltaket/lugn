import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

class Element {
  hidden = false;
  disabled = false;
  value = '';
  type = '';
  className = '';
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: Element[] = [];
  listeners = new Map<string, Array<() => void>>();
  private text = '';
  constructor(readonly tagName = 'div') {}
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('');
  }
  set textContent(value: string) {
    this.text = String(value);
    this.children = [];
  }
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.text = '';
    this.children = [];
    this.append(...children);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string) {
    if (this.disabled) return;
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  descendants(): Element[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

const html = readFileSync(
  new URL('../web/index.html', import.meta.url),
  'utf8',
);
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

function loadEncoder(): unknown {
  const source = readFileSync(
    new URL('../web/qr.js', import.meta.url),
    'utf8',
  ).replace(/^export /gm, '');
  const context = createContext({ TextEncoder });
  runInContext(source, context);
  return runInContext('encodeQr', context);
}
const encodeQr = loadEncoder();

const ALL = ['state:read', 'commands:write', 'phone:ingest'];
const A = 'dev_aaaaaaaaaaaaaaaa';
const B = 'dev_bbbbbbbbbbbbbbbb';
const C = 'dev_cccccccccccccccc';
const D = 'dev_dddddddddddddddd';
const E = 'dev_eeeeeeeeeeeeeeee';

function device(
  id: string,
  name: string,
  fields: Partial<{
    scopes: string[];
    createdAt: number;
    lastSeenAt: number | null;
    revokedAt: number | null;
    appVersion: string | null;
  }> = {},
) {
  return {
    id,
    name,
    platform: 'ios',
    appVersion: null,
    scopes: ALL,
    createdAt: Date.now() - 60_000,
    lastSeenAt: null,
    revokedAt: null,
    ...fields,
  };
}

function stamp(ageMs: number, fresh: boolean) {
  const at = Date.now() - ageMs;
  return { observedAt: at, receivedAt: at, fresh };
}

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

async function flush() {
  for (let index = 0; index < 6; index++)
    await new Promise((resolve) => setImmediate(resolve));
}

function setup(
  route: Route,
  options: {
    storage?: Map<string, string>;
    phone?: Record<string, unknown>;
  } = {},
) {
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!ids.has(id)) throw new Error(`Missing element ${id}`);
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const storage = options.storage ?? new Map<string, string>();
  const timeouts: Array<() => void> = [];
  let offset = 0;
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async (url, init) => route(url, init),
  );
  const overview = {
    state: { phone: { devices: options.phone ?? {} } },
  };
  const context = createContext({
    window: {
      lugnPanel: {
        csrfToken: () => 'csrf',
        overview: () => overview,
        refresh: vi.fn(async () => undefined),
        serverNow: () => Date.now() + offset,
      },
      addEventListener: vi.fn(),
    },
    document: {
      getElementById: get,
      createElement: (tag: string) => new Element(tag),
      createElementNS: (_ns: string, tag: string) => new Element(tag),
      createTextNode: (text: string) => {
        const node = new Element('#text');
        node.textContent = text;
        return node;
      },
      activeElement: null,
      visibilityState: 'visible',
      addEventListener: vi.fn(),
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    location: { hash: '#telefoner' },
    fetch,
    URL,
    encodeQr,
    setTimeout: (callback: () => void) => timeouts.push(callback),
    clearTimeout: () => undefined,
    setInterval: () => 1,
    clearInterval: () => undefined,
  });
  const source = readFileSync(
    new URL('../web/phones.js', import.meta.url),
    'utf8',
  ).replace(/^import .*$/m, '');
  runInContext(source, context);
  const rows = () => get('phones-list').children;
  const row = (name: string) =>
    rows().find((item) => item.children[0]?.children[0]?.textContent === name);
  const readingOf = (item: Element | undefined, label: string) =>
    item
      ?.descendants()
      .find(
        (child) =>
          child.className === 'reading' &&
          child.children[0]?.textContent === label,
      )?.children[1]?.textContent;
  const button = (item: Element | undefined) =>
    item?.descendants().find((child) => child.tagName === 'button');
  return {
    get,
    fetch,
    storage,
    row,
    rows,
    readingOf,
    button,
    overview,
    run: (code: string) => runInContext(code, context),
    runTimeouts: () => timeouts.splice(0).forEach((callback) => callback()),
    advanceServer: (ms: number) => {
      offset += ms;
    },
  };
}

function listRoute(
  body: () => unknown,
  extra: Route = () => json({}, 404),
): Route {
  return (url, init) =>
    url === '/ui/api/devices' && (init?.method ?? 'GET') === 'GET'
      ? json(body())
      : extra(url, init);
}

describe('Telefoner page', () => {
  it('says the device API is off and names the config key', async () => {
    const ui = setup(() => json({ error: 'device_api_disabled' }, 404));
    await flush();
    expect(ui.fetch).toHaveBeenCalledTimes(1);
    expect(ui.get('phones-unavailable').hidden).toBe(false);
    expect(ui.get('phones-unavailable').textContent).toContain(
      'Enhets-API:t är avstängt.',
    );
    expect(ui.get('phones-unavailable').textContent).toContain(
      'device.enabled',
    );
    expect(ui.get('phones-content').hidden).toBe(true);
    expect(ui.get('settings-value-telefoner').textContent).toBe('Av');
    expect(ui.get('phones-status').textContent).toBe('Av');
  });

  it('lists phones with last seen, hints, scopes and revoked phones', async () => {
    const now = Date.now();
    const since = now - 3_600_000;
    const ui = setup(
      listRoute(() => ({
        publicUrl: null,
        lastSeenSince: since,
        devices: [
          device(A, 'Brunos iPhone', {
            createdAt: since - 3 * 86_400_000,
            lastSeenAt: now - 5 * 60_000,
            appVersion: '1.0.0',
          }),
          device(B, 'iPad', { scopes: ['state:read'] }),
          device(C, 'Gamla telefonen', { createdAt: since - 1000 }),
          device(D, 'Borttappad', { revokedAt: now - 86_400_000 }),
        ],
      })),
      {
        phone: {
          [A]: {
            deviceId: A,
            name: 'Brunos iPhone',
            lastSeenAt: now - 10_000,
            signals: {
              app: { ...stamp(10_000, true), state: 'foreground' },
              geofence: { home: { ...stamp(4_000_000, false), inside: true } },
              power: null,
              focus: { ...stamp(50_000_000, false), mode: 'sleep' },
              wakeAlarm: null,
              motion: null,
              network: null,
            },
          },
        },
      },
    );
    await flush();
    expect(ui.get('phones-content').hidden).toBe(false);
    expect(ui.get('phones-status').hidden).toBe(true);
    expect(ui.get('settings-value-telefoner').textContent).toBe('3');
    expect(ui.rows()).toHaveLength(3);
    const a = ui.row('Brunos iPhone');
    // The newest of the registry's and the phone hints' times.
    expect(ui.readingOf(a, 'Senast')).toBe('Sedd nyss');
    expect(ui.readingOf(a, 'Ledtrådar')).toBe(
      'Färska: appen · Äldre: zoner, fokus',
    );
    expect(ui.readingOf(a, 'Får')).toBe(
      'Läsa läget, Styra rummet, Skicka ledtrådar',
    );
    expect(ui.readingOf(a, 'Ihopparad')).toContain('iOS · 1.0.0');
    const b = ui.row('iPad');
    expect(ui.readingOf(b, 'Senast')).toBe('Aldrig sedd');
    expect(ui.readingOf(b, 'Ledtrådar')).toBe('Skickar inga ledtrådar');
    expect(ui.readingOf(b, 'Får')).toBe('Läsa läget');
    const c = ui.row('Gamla telefonen');
    // Paired before the restart, so null only means "not since restart".
    expect(ui.readingOf(c, 'Senast')).toBe('Inte sedd sedan omstart');
    expect(ui.readingOf(c, 'Ledtrådar')).toBe('Inga ledtrådar än');
    expect(ui.get('phones-empty').hidden).toBe(true);
    expect(ui.get('phones-revoked').hidden).toBe(false);
    expect(ui.get('phones-revoked-summary').textContent).toBe(
      'Spärrade telefoner (1)',
    );
    expect(ui.get('phones-revoked-list').textContent).toContain('Borttappad');
  });

  it('shows the empty state when no phone is paired', async () => {
    const ui = setup(
      listRoute(() => ({ publicUrl: null, lastSeenSince: 0, devices: [] })),
    );
    await flush();
    expect(ui.get('phones-empty').hidden).toBe(false);
    expect(ui.get('phones-revoked').hidden).toBe(true);
    expect(ui.get('settings-value-telefoner').textContent).toBe('0');
    expect(ui.get('phones-pair-button').disabled).toBe(false);
  });

  it('creates a code with a countdown and a QR code for the configured server', async () => {
    let expiresAt = 0;
    const ui = setup(
      listRoute(
        () => ({
          publicUrl: 'https://lugn.example.ts.net:8789',
          lastSeenSince: 0,
          devices: [],
        }),
        (url, init) => {
          expect(url).toBe('/ui/api/devices/pairing');
          expect(init?.method).toBe('POST');
          expect(init?.body).toBe('{}');
          expect(init?.headers).toMatchObject({
            'content-type': 'application/json',
            'X-Lugn-CSRF': 'csrf',
          });
          expiresAt = Date.now() + 300_000;
          return json({ code: '7K3Q-M9TD', expiresAt, scopes: ALL }, 201);
        },
      ),
    );
    await flush();
    expect(ui.get('phones-server-field').hidden).toBe(true);
    expect(ui.get('phones-server-configured').hidden).toBe(false);
    expect(ui.get('phones-server-configured-url').textContent).toBe(
      'https://lugn.example.ts.net:8789',
    );
    ui.get('phones-pair-button').fire('click');
    await flush();
    expect(ui.get('phones-code-card').hidden).toBe(false);
    expect(ui.get('phones-code').textContent).toBe('7K3Q-M9TD');
    expect(ui.get('phones-countdown').textContent).toMatch(
      /^Gäller i (5:00|4:59), till \d\d:\d\d$/,
    );
    expect(ui.get('phones-pair-button').textContent).toBe('Ny kod');
    const qr = ui.get('phones-qr');
    expect(qr.hidden).toBe(false);
    expect(qr.dataset['payload']).toBe(
      'lugn://pair?server=https%3A%2F%2Flugn.example.ts.net%3A8789&code=7K3Q-M9TD',
    );
    const svg = qr.children[0]!;
    expect(svg.tagName).toBe('svg');
    expect(svg.attributes.get('viewBox')).toBe('0 0 45 45');
    expect(svg.children[0]!.attributes.get('d')).toMatch(/^M4 4h7v1h-7z/);
    expect(ui.get('phones-qr-missing').hidden).toBe(true);

    ui.advanceServer(301_000);
    ui.run('tick()');
    expect(ui.get('phones-countdown').textContent).toBe(
      'Koden har gått ut. Skapa en ny.',
    );
    expect(ui.get('phones-code-card').dataset['state']).toBe('expired');
    expect(qr.hidden).toBe(true);
  });

  it('asks for the server address once and remembers it in this browser', async () => {
    const body = () => ({ publicUrl: null, lastSeenSince: 0, devices: [] });
    const ui = setup(
      listRoute(body, () =>
        json(
          { code: 'ABCD-EFGH', expiresAt: Date.now() + 300_000, scopes: ALL },
          201,
        ),
      ),
    );
    await flush();
    expect(ui.get('phones-server-field').hidden).toBe(false);
    expect(ui.get('phones-server-help').textContent).toContain(
      'device.publicUrl',
    );
    ui.get('phones-pair-button').fire('click');
    await flush();
    // The code still works by hand without an address.
    expect(ui.get('phones-code').textContent).toBe('ABCD-EFGH');
    expect(ui.get('phones-qr').hidden).toBe(true);
    expect(ui.get('phones-qr-missing').hidden).toBe(false);
    expect(ui.get('phones-code-server').textContent).toBe('Inte ifylld');

    const input = ui.get('phones-server-url');
    input.value = 'lugn.example.ts.net';
    input.fire('input');
    expect(ui.get('phones-server-help').dataset['tone']).toBe('bad');
    expect(ui.storage.size).toBe(0);
    expect(ui.get('phones-qr').hidden).toBe(true);

    input.value = ' https://lugn.example.ts.net:8789/ ';
    input.fire('input');
    expect(ui.storage.get('lugn.phones.serverUrl')).toBe(
      'https://lugn.example.ts.net:8789',
    );
    expect(ui.get('phones-qr').hidden).toBe(false);
    expect(ui.get('phones-qr').dataset['payload']).toBe(
      'lugn://pair?server=https%3A%2F%2Flugn.example.ts.net%3A8789&code=ABCD-EFGH',
    );

    const again = setup(listRoute(body), { storage: ui.storage });
    await flush();
    expect(again.get('phones-server-url').value).toBe(
      'https://lugn.example.ts.net:8789',
    );
  });

  it('notices the phone that used the code', async () => {
    let devices = [device(A, 'Brunos iPhone')];
    const ui = setup(
      listRoute(
        () => ({ publicUrl: null, lastSeenSince: 0, devices }),
        () =>
          json(
            {
              code: 'ABCD-EFGH',
              expiresAt: Date.now() + 300_000,
              scopes: ALL,
            },
            201,
          ),
      ),
    );
    await flush();
    ui.get('phones-pair-button').fire('click');
    await flush();
    expect(ui.get('phones-code-card').hidden).toBe(false);
    devices = [...devices, device(E, 'Nya iPhone')];
    await ui.run('loadList()');
    expect(ui.get('phones-code-card').hidden).toBe(true);
    expect(ui.get('phones-pair-status').textContent).toBe(
      'Nya iPhone är ihopparad.',
    );
    expect(ui.get('phones-pair-status').dataset['tone']).toBe('good');
    expect(ui.rows()).toHaveLength(2);
  });

  it.each([
    [
      429,
      'too_many_pairing_codes',
      'Fyra koder väntar redan. Använd en av dem eller vänta tills de går ut.',
    ],
    [
      409,
      'device_limit_reached',
      'Det finns redan 32 ihopparade telefoner. Spärra en först.',
    ],
    [503, 'device_registry_unavailable', 'Lugn kan inte läsa eller spara'],
  ])('explains a refused pairing code (%s %s)', async (status, error, text) => {
    const ui = setup(
      listRoute(
        () => ({ publicUrl: null, lastSeenSince: 0, devices: [] }),
        () => json({ error }, status),
      ),
    );
    await flush();
    ui.get('phones-pair-button').fire('click');
    await flush();
    expect(ui.get('phones-pair-status').textContent).toContain(text);
    expect(ui.get('phones-pair-status').dataset['tone']).toBe('bad');
    expect(ui.get('phones-code-card').hidden).toBe(true);
    expect(ui.get('phones-pair-button').disabled).toBe(false);
  });

  it('asks for confirmation before revoking and reports the result', async () => {
    let devices = [device(A, 'Brunos iPhone'), device(B, 'iPad')];
    const revoked: string[] = [];
    const ui = setup(
      listRoute(
        () => ({ publicUrl: null, lastSeenSince: 0, devices }),
        (url, init) => {
          expect(init?.headers).toMatchObject({ 'X-Lugn-CSRF': 'csrf' });
          revoked.push(url);
          devices = devices.map((item) =>
            item.id === A ? { ...item, revokedAt: Date.now() } : item,
          );
          return json({ device: devices[0] });
        },
      ),
    );
    await flush();
    const first = ui.button(ui.row('Brunos iPhone'))!;
    expect(first.textContent).toBe('Spärra');
    first.fire('click');
    expect(revoked).toEqual([]);
    expect(ui.button(ui.row('Brunos iPhone'))!.textContent).toBe(
      'Bekräfta spärr',
    );
    expect(ui.row('Brunos iPhone')!.textContent).toContain(
      'kommer inte in igen',
    );
    // The confirm step lapses on its own.
    ui.runTimeouts();
    expect(ui.button(ui.row('Brunos iPhone'))!.textContent).toBe('Spärra');

    ui.button(ui.row('Brunos iPhone'))!.fire('click');
    ui.button(ui.row('Brunos iPhone'))!.fire('click');
    await flush();
    expect(revoked).toEqual([`/ui/api/devices/${A}/revoke`]);
    expect(ui.get('phones-list-status').textContent).toBe(
      'Spärrade Brunos iPhone. Telefonen kommer inte in längre.',
    );
    expect(ui.row('Brunos iPhone')).toBeUndefined();
    expect(ui.get('phones-revoked-summary').textContent).toBe(
      'Spärrade telefoner (1)',
    );
    expect(ui.get('settings-value-telefoner').textContent).toBe('1');
  });

  it('shows an error with a retry and keeps the last list on a later failure', async () => {
    let fail = true;
    const ui = setup((url) => {
      if (fail) throw new TypeError('offline');
      expect(url).toBe('/ui/api/devices');
      return json({
        publicUrl: null,
        lastSeenSince: 0,
        devices: [device(A, 'Brunos iPhone')],
      });
    });
    await flush();
    expect(ui.get('phones-content').hidden).toBe(true);
    expect(ui.get('phones-status').textContent).toBe('Svarar inte');
    expect(ui.get('phones-unavailable').textContent).toContain(
      'Kunde inte hämta telefonerna.',
    );
    fail = false;
    ui.button(ui.get('phones-unavailable'))!.fire('click');
    await flush();
    expect(ui.get('phones-content').hidden).toBe(false);
    expect(ui.rows()).toHaveLength(1);

    fail = true;
    await ui.run('loadList()');
    expect(ui.get('phones-content').hidden).toBe(false);
    expect(ui.rows()).toHaveLength(1);
    expect(ui.get('phones-list-status').dataset['tone']).toBe('warn');
    fail = false;
    await ui.run('loadList()');
    expect(ui.get('phones-list-status').textContent).toBe('');
  });

  it('sends the person back to sign in when the session has ended', async () => {
    const ui = setup(() => json({ error: 'unauthorized' }, 401));
    await flush();
    expect(ui.get('phones-unavailable').textContent).toBe(
      'Sessionen har gått ut. Logga in igen.',
    );
    expect(ui.get('phones-content').hidden).toBe(true);
  });
});
