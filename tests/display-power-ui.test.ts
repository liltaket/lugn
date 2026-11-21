import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

class Element {
  value = '';
  checked = false;
  disabled = false;
  hidden = false;
  className = '';
  textContent = '';
  dataset: Record<string, string> = {};
  children: Element[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<
    string,
    ((event: { preventDefault(): void }) => void)[]
  >();
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.children = [...children];
  }
  get options() {
    return this.children;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  addEventListener(
    type: string,
    listener: (event: { preventDefault(): void }) => void,
  ) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string) {
    for (const listener of this.listeners.get(type) ?? [])
      listener({ preventDefault() {} });
  }
  /** All text below this element, for readable assertions. */
  text(): string {
    return [this.textContent, ...this.children.map((c) => c.text())]
      .filter(Boolean)
      .join(' | ');
  }
}

const settings = {
  enabled: true,
  offAfterEmptyMs: 120_000,
  ensureOffWhenAway: true,
  wakeOnEntry: true,
  wakeInQuietHours: false,
  quietWakeMaxAbsenceMs: 1_200_000,
  inhibitOnActivity: true,
  activeInhibitMaxMs: 1_800_000,
  idleSleepAfterMs: 1_800_000,
  ignoreIdleBlockers: ['T3 Code'],
};
const GENERATION = '11111111-1111-4111-8111-111111111111';
function overviewWith(
  options: {
    generation?: string;
    stored?: Partial<typeof settings> & { idleSleepAfterMs?: number | null };
    display?: Record<string, unknown>;
  } = {},
) {
  const current = { ...settings, ...options.stored };
  return {
    displayPower: {
      version: 1,
      generation: options.generation ?? GENERATION,
      computers: {
        kuffe: {
          settings: current,
          defaults: settings,
          customized: JSON.stringify(current) !== JSON.stringify(settings),
        },
      },
    },
    state: {
      computer: {
        displays: {
          kuffe: {
            deviceId: 'kuffe',
            enabled: true,
            control: 'available',
            desired: 'on',
            inhibited: null,
            lastRequest: null,
            observed: { power: 'on', inputIdle: true, changedAt: null },
            idleSleep: {
              inactiveSince: Date.now() - 120_000,
              dueAt: Date.now() + 28 * 60_000,
              heldBy: null,
            },
            problem: null,
            nextAttemptAt: null,
            evidence: null,
            ...options.display,
          },
        },
      },
    },
  };
}

function setup(initial: ReturnType<typeof overviewWith> | null) {
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  let overview: ReturnType<typeof overviewWith> | null = initial;
  const refresh = vi.fn(async () => undefined);
  const fetch = vi.fn<typeof globalThis.fetch>();
  const renderHandlers: Array<() => void> = [];
  const confirm = vi.fn(() => true);
  const context = createContext({
    window: {
      lugnPanel: {
        overview: () => overview,
        csrfToken: () => 'csrf-token',
        refresh,
      },
      addEventListener: vi.fn(),
      setTimeout,
      clearTimeout,
      confirm,
    },
    document: {
      getElementById: get,
      createElement: () => new Element(),
      addEventListener: (type: string, handler: () => void) => {
        if (type === 'lugn:render') renderHandlers.push(handler);
      },
    },
    fetch,
    AbortController,
    JSON,
    Date,
    Math,
    Number,
    Object,
    Set,
  });
  runInContext(
    readFileSync(new URL('../web/display-power.js', import.meta.url), 'utf8'),
    context,
  );
  return {
    get,
    fetch,
    refresh,
    confirm,
    setOverview(next: ReturnType<typeof overviewWith> | null) {
      overview = next;
      for (const handler of renderHandlers) handler();
    },
  };
}
const respond = (status: number, body: unknown) =>
  vi.fn<typeof globalThis.fetch>(
    async () =>
      ({ ok: status < 400, status, json: async () => body }) as Response,
  );
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('display power panel', () => {
  it('stays hidden when the server has no display power settings', () => {
    const ui = setup({ state: { computer: { displays: {} } } } as never);
    expect(ui.get('display-power-section').hidden).toBe(true);
  });

  it('shows a computer’s display state and why it is not sleeping yet', () => {
    const ui = setup(
      overviewWith({
        display: {
          inhibited: 'recent_input',
          idleSleep: { inactiveSince: null, dueAt: null, heldBy: 'video' },
          lastRequest: { action: 'off', outcome: 'uncertain', at: Date.now() },
        },
      }),
    );
    expect(ui.get('display-power-section').hidden).toBe(false);
    const text = ui.get('display-power-status').text();
    expect(text).toContain('kuffe');
    expect(text).toContain('Skärmen är på');
    expect(text).toContain('Du använder datorn');
    expect(text).toContain('Film spelas');
    expect(text).toContain('Släck gav ingen märkbar effekt');
  });

  it('says when the display will sleep, and when control is unavailable or switched off', () => {
    const ui = setup(overviewWith());
    expect(ui.get('display-power-status').text()).toMatch(/om \d+ min/);
    ui.setOverview(overviewWith({ display: { control: 'unavailable' } }));
    expect(ui.get('display-power-status').text()).toContain(
      'Ingen kontakt med datorns agent',
    );
    ui.setOverview(overviewWith({ stored: { enabled: false } }));
    expect(ui.get('display-power-status').text()).toContain(
      'Av i inställningarna',
    );
  });

  it('fills the form from the saved settings, in minutes', () => {
    const ui = setup(overviewWith());
    expect(ui.get('display-enabled').checked).toBe(true);
    expect(ui.get('display-away').checked).toBe(true);
    expect(ui.get('display-off-after').value).toBe('2');
    expect(ui.get('display-idle-enabled').checked).toBe(true);
    expect(ui.get('display-idle-minutes').value).toBe('30');
    expect(ui.get('display-inhibit-max').value).toBe('30');
    expect(ui.get('display-ignore').value).toBe('T3 Code');
    expect(ui.get('display-wake').checked).toBe(true);
    expect(ui.get('display-wake-quiet').checked).toBe(false);
    expect(ui.get('display-wake-quiet-max').value).toBe('20');
    expect(ui.get('display-save').disabled).toBe(true);
    expect(ui.get('display-reset').disabled).toBe(true);
  });

  it('saves edits with the expected generation and the session token', async () => {
    const ui = setup(overviewWith());
    ui.fetch.mockImplementation(
      respond(200, { generation: '22222222-2222-4222-8222-222222222222' }),
    );
    ui.get('display-off-after').value = '5';
    ui.get('display-idle-enabled').checked = false;
    ui.get('display-ignore').value = 'T3 Code, zen, , T3 Code';
    ui.get('display-power-form').fire('input');
    expect(ui.get('display-save').disabled).toBe(false);
    ui.get('display-power-form').fire('submit');
    expect(ui.get('display-power-fields').disabled).toBe(true);
    expect(ui.get('display-save').attributes.get('aria-busy')).toBe('true');
    await flush();
    expect(ui.fetch).toHaveBeenCalledOnce();
    const [url, init] = ui.fetch.mock.calls[0]!;
    expect(url).toBe('/ui/api/display/settings');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['X-Lugn-CSRF']).toBe(
      'csrf-token',
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      deviceId: 'kuffe',
      expectedGeneration: GENERATION,
      settings: {
        ...settings,
        offAfterEmptyMs: 300_000,
        idleSleepAfterMs: null,
        ignoreIdleBlockers: ['T3 Code', 'zen'],
      },
    });
    expect(ui.refresh).toHaveBeenCalledOnce();
    expect(ui.get('display-power-message').textContent).toContain('Sparat');
    expect(ui.get('display-power-fields').disabled).toBe(false);
  });

  it('refuses out-of-range values without asking the server', () => {
    const ui = setup(overviewWith());
    ui.get('display-off-after').value = '0';
    ui.get('display-power-form').fire('submit');
    expect(ui.get('display-power-message').textContent).toContain('1–1440');
    ui.get('display-off-after').value = '2';
    ui.get('display-idle-minutes').value = '2';
    ui.get('display-power-form').fire('submit');
    expect(ui.get('display-power-message').textContent).toContain('5–1440');
    expect(ui.fetch).not.toHaveBeenCalled();
  });

  it('keeps the draft and says so when the settings changed elsewhere', async () => {
    const ui = setup(overviewWith());
    ui.fetch.mockImplementation(
      respond(409, { error: 'display_settings_changed' }),
    );
    ui.get('display-off-after').value = '9';
    ui.get('display-power-form').fire('input');
    ui.get('display-power-form').fire('submit');
    await flush();
    expect(ui.get('display-power-message').textContent).toContain(
      'Ändrat på annat håll',
    );
    expect(ui.get('display-off-after').value).toBe('9');
    expect(ui.get('display-save').disabled).toBe(false);
  });

  it('does not overwrite an unsaved draft when a newer snapshot arrives', async () => {
    const ui = setup(overviewWith());
    ui.get('display-off-after').value = '9';
    ui.get('display-power-form').fire('input');
    ui.setOverview(
      overviewWith({
        generation: '33333333-3333-4333-8333-333333333333',
        stored: { offAfterEmptyMs: 600_000 },
      }),
    );
    expect(ui.get('display-off-after').value).toBe('9');
    // Saving the draft reports the generation it was made from, so the server
    // answers with a conflict instead of silently overwriting the newer values.
    ui.fetch.mockImplementation(respond(409, {}));
    ui.get('display-power-form').fire('submit');
    expect(
      JSON.parse(String(ui.fetch.mock.calls[0]![1]?.body)).expectedGeneration,
    ).toBe(GENERATION);
    // Without edits the new saved values are shown.
    await flush();
    ui.get('display-discard').fire('click');
    expect(ui.get('display-off-after').value).toBe('10');
  });

  it('resets to the configured defaults by sending null, after confirmation', async () => {
    const ui = setup(overviewWith({ stored: { offAfterEmptyMs: 600_000 } }));
    expect(ui.get('display-reset').disabled).toBe(false);
    ui.fetch.mockImplementation(
      respond(200, { generation: '44444444-4444-4444-8444-444444444444' }),
    );
    ui.get('display-reset').fire('click');
    await flush();
    expect(ui.confirm).toHaveBeenCalledOnce();
    expect(
      JSON.parse(String(ui.fetch.mock.calls[0]![1]?.body)).settings,
    ).toBeNull();
    ui.confirm.mockReturnValue(false);
    ui.fetch.mockClear();
    ui.get('display-reset').fire('click');
    await flush();
    expect(ui.fetch).not.toHaveBeenCalled();
  });
});
