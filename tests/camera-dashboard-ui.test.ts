import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

class Element {
  hidden = false;
  disabled = false;
  checked = false;
  value = '';
  src = '';
  alt = '';
  type = '';
  textContent = '';
  dataset: Record<string, string> = {};
  children: Element[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, (() => unknown)[]>();
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  removeAttribute(key: string) {
    this.attributes.delete(key);
    if (key === 'src') this.src = '';
  }
  addEventListener(type: string, callback: () => unknown) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }
  checkValidity() {
    return true;
  }
  async fire(type: string) {
    for (const callback of this.listeners.get(type) ?? []) await callback();
  }
}
const active = (id = 'view-one', cameraId = 'entrance') => ({
  id,
  cameraId,
  name: cameraId === 'entrance' ? 'Entré' : 'Framsida',
  reason: 'Person vid entrén',
  expiresAt: 31_000,
  manual: false,
  imageUrl: `/hub/display-api/cameras/${id}/${cameraId}/image`,
});
const camera = () => ({
  generation: 'first',
  settings: {
    enabled: true,
    automaticEnabled: false,
    durationSeconds: 30,
    cameras: { entrance: true, front: true },
    triggers: { person: false },
    viewers: ['bed', 'desk', 'web'],
  },
  definitions: [
    { id: 'entrance', name: 'Entré', enabled: true, available: true },
    { id: 'front', name: 'Framsida', enabled: true, available: true },
  ],
  triggers: [
    {
      id: 'person',
      name: 'Person vid entrén',
      cameraId: 'entrance',
      kind: 'state',
      enabled: false,
    },
  ],
  active: null as ReturnType<typeof active> | null,
});
const imageResponse = () =>
  new Response(new Blob(['jpeg'], { type: 'image/jpeg' }), {
    headers: { 'content-type': 'image/jpeg' },
  });
function setup(surface: 'hub' | 'web') {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => imageResponse());
  const post = vi.fn(async () => ({
    cameraDashboard: camera(),
  }));
  const revoke = vi.fn();
  let urlId = 0;
  class BrowserURL extends URL {
    static override createObjectURL() {
      return `blob:frame-${++urlId}`;
    }
    static override revokeObjectURL = revoke;
  }
  const doc = {
    visibilityState: 'visible',
    createElement: () => new Element(),
    addEventListener: vi.fn(),
  };
  const context = createContext({
    URL: BrowserURL,
    Date,
    JSON,
    Promise,
    AbortController,
    Number,
    Math,
    TypeError,
    Error,
    structuredClone,
    fetch,
    location: { href: 'http://lugn.test/hub/', origin: 'http://lugn.test' },
    document: doc,
    window: {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      addEventListener: vi.fn(),
    },
    postJson: post,
    isUnavailable: () => false,
    estimatedServerNow: () => Date.now(),
    roleName: (role: string) => role,
    setText: (element: Element, value: string) => {
      element.textContent = value;
    },
    showToast: vi.fn(),
    setActionMessage: vi.fn(),
    l2: get,
    node: (_tag: string, _class?: string, text?: string) => {
      const element = new Element();
      element.textContent = text ?? '';
      return element;
    },
    fetchOverview: vi.fn(),
    dashboardView: Object.assign(get('dashboard'), {
      dataset: { page: 'oversikt' },
    }),
    testCamera: camera(),
  });
  const source = readFileSync(
    new URL(
      surface === 'hub' ? '../src/ui/display.js' : '../web/app.js',
      import.meta.url,
    ),
    'utf8',
  );
  const declarations =
    surface === 'hub'
      ? source.slice(
          source.indexOf('let cameraActive'),
          source.indexOf('let contextDetailsOpen'),
        )
      : source.slice(
          source.indexOf('let cameraWebDraft'),
          source.indexOf('let intelligenceDraft'),
        );
  const functions =
    surface === 'hub'
      ? source.slice(
          source.indexOf('// Camera media is scoped'),
          source.indexOf('refs.cameraMenu.addEventListener'),
        )
      : source.slice(source.indexOf('// Camera settings keep'));
  const refs = Object.fromEntries(
    [
      'cameraMenu',
      'cameraChoices',
      'cameraPanel',
      'cameraName',
      'cameraReason',
      'cameraClose',
      'cameraCountdown',
      'cameraImage',
      'cameraPlaceholder',
      'cameraStatus',
      'musicSection',
      'musicHeading',
    ].map((id) => [id, get(id)]),
  );
  Object.assign(context, { refs });
  runInContext(
    `const BASE_PATH='/hub/'; const API_ROOT='/ui/api'; let stopped=false; let latestPayload={role:'bed', cameraDashboard:testCamera}; let overview={cameraDashboard:testCamera,generatedAt:1000}; let overviewStale=false; let lastOverviewAt=1000; let csrfToken='csrf'; ${declarations}\n${functions}`,
    context,
  );
  return {
    surface,
    context,
    doc,
    get,
    refs,
    fetch,
    post,
    revoke,
    run: (code: string) => runInContext(code, context),
    render() {
      runInContext(
        surface === 'hub' ? 'renderCamera(latestPayload)' : 'renderCameraWeb()',
        context,
      );
    },
    setActive(id = 'view-one') {
      runInContext(`testCamera.active=${JSON.stringify(active(id))}`, context);
    },
    image: surface === 'hub' ? refs['cameraImage']! : get('camera-web-image'),
    status:
      surface === 'hub'
        ? refs['cameraStatus']!
        : get('camera-web-media-status'),
  };
}
afterEach(() => vi.useRealTimers());

describe.each(['hub', 'web'] as const)(
  '%s camera media lifecycle with simulated APIs',
  (surface) => {
    it('keeps media stable through SSE, serializes one-second refreshes and labels frames truthfully', async () => {
      const ui = setup(surface);
      ui.setActive();
      ui.render();
      await vi.waitFor(() => expect(typeof ui.image.onload).toBe('function'));
      expect(ui.fetch).toHaveBeenCalledTimes(1);
      ui.image.onload!();
      expect(ui.status.textContent).toMatch(/^Uppdaterad bild kl\./);
      expect(ui.status.textContent).not.toMatch(/Livevideo/);
      ui.render();
      expect(ui.fetch).toHaveBeenCalledTimes(1);
      let complete!: (value: Response) => void;
      ui.fetch.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(ui.fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(3000);
      ui.render();
      expect(ui.fetch).toHaveBeenCalledTimes(2);
      complete(imageResponse());
      await vi.waitFor(() => expect(ui.image.src).toBe('blob:frame-2'));
      ui.image.onload!();
      expect(ui.revoke).toHaveBeenCalledWith('blob:frame-1');
    });
    it('stops on local close, aborts pending images and ignores late completions', async () => {
      const ui = setup(surface);
      let complete!: (value: Response) => void;
      ui.fetch.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      ui.setActive();
      ui.render();
      const signal = ui.fetch.mock.calls[0]![1]!.signal!;
      if (surface === 'hub') await ui.run("cameraAction('hide')");
      else {
        ui.fetch.mockResolvedValueOnce(
          new Response(JSON.stringify({ cameraDashboard: camera() })),
        );
        await ui.run("cameraWebAction('hide')");
      }
      expect(signal.aborted).toBe(true);
      expect(ui.image.src).toBe('');
      complete(imageResponse());
      await vi.advanceTimersByTimeAsync(0);
      expect(ui.image.src).toBe('');
      expect(ui.image.hidden).toBe(true);
      await vi.advanceTimersByTimeAsync(5000);
      expect(ui.fetch).toHaveBeenCalledTimes(surface === 'hub' ? 1 : 2);
    });
    it('does not fetch external media, never claims a missing image is live, and bounds failure retries', async () => {
      const ui = setup(surface);
      ui.setActive();
      ui.run("testCamera.active.imageUrl='https://other.test/private.jpg'");
      ui.render();
      expect(ui.fetch).not.toHaveBeenCalled();
      expect(ui.status.textContent).not.toMatch(/Live/);
      ui.run(
        "testCamera.active.id='new';testCamera.active.imageUrl='/hub/display-api/cameras/new/entrance/image'",
      );
      ui.fetch.mockResolvedValue(new Response('', { status: 503 }));
      ui.render();
      await vi.advanceTimersByTimeAsync(6000);
      expect(ui.fetch).toHaveBeenCalledTimes(3);
      expect(ui.status.textContent).toMatch(/Kameran svarar inte/);
      ui.render();
      await vi.advanceTimersByTimeAsync(6000);
      expect(ui.fetch).toHaveBeenCalledTimes(3);
    });
    it('stops at expiry and when the page is hidden without reopening old views', async () => {
      const ui = setup(surface);
      ui.setActive();
      ui.render();
      await vi.waitFor(() => expect(typeof ui.image.onload).toBe('function'));
      ui.image.onload!();
      ui.doc.visibilityState = 'hidden';
      ui.render();
      expect(ui.image.src).toBe('');
      expect(ui.revoke).toHaveBeenCalledWith('blob:frame-1');
      ui.doc.visibilityState = 'visible';
      vi.setSystemTime(32_000);
      ui.render();
      expect(ui.image.hidden).toBe(true);
      expect(ui.fetch).toHaveBeenCalledTimes(1);
    });
  },
);

it('preserves a dirty camera preference draft and original generation across live updates; persists only explicit saves', async () => {
  const ui = setup('web');
  ui.run('initializeCameraWeb()');
  ui.render();
  const enable = ui.get('camera-automatic');
  enable.checked = true;
  await enable.fire('change');
  ui.run(
    "testCamera.generation='changed-elsewhere';testCamera.settings.durationSeconds=60",
  );
  ui.render();
  expect(ui.get('camera-duration').value).toBe('30');
  expect(enable.checked).toBe(true);
  expect(ui.fetch).not.toHaveBeenCalled();
  const saved = camera();
  saved.generation = 'saved';
  saved.settings.automaticEnabled = true;
  ui.fetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ cameraDashboard: saved })),
  );
  const formListeners = ui.run('document');
  void formListeners;
  // The real handler receives the native submit event after browser constraints pass.
  const listener = ui.get('camera-form').listeners.get('submit')![0]!;
  await (listener as (event: { preventDefault(): void }) => Promise<void>)({
    preventDefault() {},
  });
  expect(ui.fetch).toHaveBeenCalledWith(
    '/ui/api/cameras/settings',
    expect.objectContaining({ method: 'PUT', body: expect.any(String) }),
  );
  const body = JSON.parse(ui.fetch.mock.calls[0]![1]!.body as string);
  expect(body).toMatchObject({
    generation: 'first',
    settings: { automaticEnabled: true, durationSeconds: 30 },
  });
  expect(ui.get('camera-settings-status').textContent).toContain('sparade');
});

describe.each(['hub', 'web'] as const)(
  '%s close intent across concurrent action/SSE updates',
  (surface) => {
    it('keeps a later SSE nonce closed after Close, even when a pending Show resolves late; resumes only new events after 60s', async () => {
      const ui = setup(surface);
      if (surface === 'web') ui.run('cameraWebRequest=postJson');
      ui.setActive('A');
      ui.render();
      await vi.waitFor(() => expect(typeof ui.image.onload).toBe('function'));
      ui.image.onload!();
      let finishShow!: (value: {
        cameraDashboard: ReturnType<typeof camera>;
      }) => void;
      let finishHide!: (value: {
        cameraDashboard: ReturnType<typeof camera>;
      }) => void;
      ui.post.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishShow = resolve;
          }),
      );
      ui.post.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishHide = resolve;
          }),
      );
      const show = ui.run(
        surface === 'hub'
          ? "cameraAction('show','front')"
          : "cameraWebAction('show','front')",
      );
      const hide = ui.run(
        surface === 'hub' ? "cameraAction('hide')" : "cameraWebAction('hide')",
      );
      ui.setActive('B');
      ui.run('testCamera.active.expiresAt=121000');
      ui.render();
      expect(
        surface === 'hub'
          ? ui.refs['cameraPanel']!.hidden
          : ui.get('camera-web-panel').hidden,
      ).toBe(true);
      expect(ui.image.src).toBe('');
      expect(ui.fetch).toHaveBeenCalledTimes(1);
      const late = camera();
      late.active = active('B');
      finishShow({ cameraDashboard: late });
      finishHide({ cameraDashboard: camera() });
      await Promise.all([show, hide]);
      ui.run('testCamera.active.expiresAt=121000');
      vi.setSystemTime(62_000);
      ui.render();
      expect(ui.fetch).toHaveBeenCalledTimes(1);
      // A new future event is allowed once local and backend Close suppression ends.
      ui.setActive('future');
      ui.run('testCamera.active.expiresAt=Date.now()+30000');
      if (surface === 'hub') ui.run('latestPayload.cameraDashboard=testCamera');
      else ui.run('overview.cameraDashboard=testCamera');
      ui.render();
      expect(ui.fetch).toHaveBeenCalledTimes(2);
    });
    it('shows an independently cancellable pending panel before the first Show receives an active view', async () => {
      const ui = setup(surface);
      if (surface === 'web') ui.run('cameraWebRequest=postJson');
      let finish!: (value: {
        cameraDashboard: ReturnType<typeof camera>;
      }) => void;
      ui.post.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const showing = ui.run(
        surface === 'hub'
          ? "cameraAction('show','entrance')"
          : "cameraWebAction('show','entrance')",
      );
      const panel =
        surface === 'hub'
          ? ui.refs['cameraPanel']!
          : ui.get('camera-web-panel');
      expect(panel.hidden).toBe(false);
      expect(ui.fetch).not.toHaveBeenCalled();
      expect(ui.status.textContent).toContain('stänga');
      await ui.run(
        surface === 'hub' ? "cameraAction('hide')" : "cameraWebAction('hide')",
      );
      expect(panel.hidden).toBe(true);
      ui.setActive('late-first-view');
      ui.render();
      expect(panel.hidden).toBe(true);
      finish({ cameraDashboard: camera() });
      await showing;
      expect(ui.fetch).not.toHaveBeenCalled();
    });
  },
);

it('updates camera availability during a dirty draft without replacing its checkbox or unsaved selection', async () => {
  const ui = setup('web');
  ui.render();
  const row = ui.get('camera-camera-fields').children[0]!;
  const checkbox = row.children[0]!;
  checkbox.checked = false;
  await checkbox.fire('change');
  ui.run('testCamera.definitions[0].available=false');
  ui.render();
  expect(row.children[1]!.textContent).toBe('Entré (otillgänglig)');
  expect(ui.get('camera-camera-fields').children[0]!.children[0]).toBe(
    checkbox,
  );
  expect(checkbox.checked).toBe(false);
  ui.run('testCamera.definitions[0].available=true');
  ui.render();
  expect(row.children[1]!.textContent).toBe('Entré');
  expect(ui.run('cameraWebDraft.cameras.entrance')).toBe(false);
});

it('retains unsaved camera preferences after a concurrent-write conflict and never silently retries the save', async () => {
  const ui = setup('web');
  ui.run('initializeCameraWeb()');
  ui.render();
  ui.get('camera-duration').value = '45';
  await ui.get('camera-duration').fire('input');
  ui.fetch.mockResolvedValueOnce(new Response('{}', { status: 409 }));
  const submit = ui.get('camera-form').listeners.get('submit')![0]!;
  await (submit as (event: { preventDefault(): void }) => Promise<void>)({
    preventDefault() {},
  });
  expect(ui.get('camera-duration').value).toBe('45');
  expect(ui.get('camera-settings-status').textContent).toContain('utkast');
  expect(ui.run('cameraWebGeneration')).toBe('first');
  await vi.advanceTimersByTimeAsync(10000);
  expect(ui.fetch).toHaveBeenCalledTimes(1);
});

it.each(['hub', 'web'] as const)(
  '%s prevents a late compensating Hide from racing a newer explicit Show',
  async (surface) => {
    const ui = setup(surface);
    if (surface === 'web') ui.run('cameraWebRequest=postJson');
    ui.setActive('A');
    ui.render();
    const completions: ((value: {
      cameraDashboard: ReturnType<typeof camera>;
    }) => void)[] = [];
    for (let index = 0; index < 3; index++)
      ui.post.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completions.push(resolve);
          }),
      );
    const show = ui.run(
      surface === 'hub'
        ? "cameraAction('show','front')"
        : "cameraWebAction('show','front')",
    );
    const close = ui.run(
      surface === 'hub' ? "cameraAction('hide')" : "cameraWebAction('hide')",
    );
    completions[0]!({ cameraDashboard: camera() });
    await vi.advanceTimersByTimeAsync(0);
    expect(ui.post).toHaveBeenCalledTimes(3);
    completions[1]!({ cameraDashboard: camera() });
    await close;
    // The original Close has settled, but its followup Hide is still pending.
    await ui.run(
      surface === 'hub'
        ? "cameraAction('show','entrance')"
        : "cameraWebAction('show','entrance')",
    );
    expect(ui.post).toHaveBeenCalledTimes(3);
    completions[2]!({ cameraDashboard: camera() });
    await show;
    await ui.run(
      surface === 'hub'
        ? "cameraAction('show','entrance')"
        : "cameraWebAction('show','entrance')",
    );
    expect(ui.post).toHaveBeenCalledTimes(4);
  },
);

it.each(['hub', 'web'] as const)(
  '%s blocks newer Show until an older cancelled Show and its cleanup both settle',
  async (surface) => {
    const ui = setup(surface);
    if (surface === 'web') ui.run('cameraWebRequest=postJson');
    let oldShowDone!: (value: {
      cameraDashboard: ReturnType<typeof camera>;
    }) => void;
    ui.post.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          oldShowDone = resolve;
        }),
    );
    const oldShow = ui.run(
      surface === 'hub'
        ? "cameraAction('show','front')"
        : "cameraWebAction('show','front')",
    );
    await ui.run(
      surface === 'hub' ? "cameraAction('hide')" : "cameraWebAction('hide')",
    );
    expect(ui.post).toHaveBeenCalledTimes(2);
    // Even though Close has completed, the first Show remains unconfirmed.
    await ui.run(
      surface === 'hub'
        ? "cameraAction('show','entrance')"
        : "cameraWebAction('show','entrance')",
    );
    expect(ui.post).toHaveBeenCalledTimes(2);
    oldShowDone({ cameraDashboard: camera() });
    await oldShow;
    expect(ui.post).toHaveBeenCalledTimes(3);
    await ui.run(
      surface === 'hub'
        ? "cameraAction('show','entrance')"
        : "cameraWebAction('show','entrance')",
    );
    expect(ui.post).toHaveBeenCalledTimes(4);
  },
);
