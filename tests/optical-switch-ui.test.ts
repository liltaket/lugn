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
  wiimHost: null as string | null,
  audioSink: null as string | null,
  minAudibleMs: 400,
  releaseMs: 1_500,
  levelDb: -55,
};
const GENERATION = '11111111-1111-4111-8111-111111111111';
type Overview = ReturnType<typeof overviewWith>;
function overviewWith(
  options: {
    generation?: string;
    stored?: Partial<typeof settings>;
    agent?: Record<string, unknown> | null;
    state?: Record<string, unknown>;
  } = {},
) {
  const current = { ...settings, ...options.stored };
  const agent =
    options.agent === null
      ? { contact: 'none', receivedAt: null, state: null }
      : {
          contact: 'live',
          receivedAt: Date.now(),
          state: {
            phase: 'idle',
            capture: 'ok',
            host: '192.168.10.194',
            hostSource: 'discovered',
            wiim: { reachable: true, optical: false, playing: false },
            discovered: ['192.168.10.194'],
            lastSwitch: null,
            settingsSource: 'lugn',
            settingsGeneration: options.generation ?? GENERATION,
            ...options.state,
          },
          ...options.agent,
        };
  return {
    opticalSwitch: {
      version: 1,
      generation: options.generation ?? GENERATION,
      computers: {
        kuffe: {
          settings: current,
          defaults: settings,
          customized: JSON.stringify(current) !== JSON.stringify(settings),
        },
      },
      agents: { kuffe: agent },
    },
  };
}

function setup(initial: Overview | null) {
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  let overview: Overview | null = initial;
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
    RegExp,
  });
  runInContext(
    readFileSync(new URL('../web/optical-switch.js', import.meta.url), 'utf8'),
    context,
  );
  return {
    get,
    fetch,
    refresh,
    confirm,
    setOverview(next: Overview | null) {
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

describe('optical switch panel', () => {
  it('stays hidden when the server has no optical switch settings', () => {
    const ui = setup({} as never);
    expect(ui.get('optical-section').hidden).toBe(true);
  });

  it('shows the WiiM, what it is doing and the last switch', () => {
    const ui = setup(
      overviewWith({
        state: {
          phase: 'sound',
          wiim: { reachable: true, optical: true, playing: false },
          lastSwitch: { outcome: 'switched', at: Date.now(), latencyMs: 412 },
        },
      }),
    );
    expect(ui.get('optical-section').hidden).toBe(false);
    const text = ui.get('optical-status').text();
    expect(text).toContain('kuffe');
    expect(text).toContain('Datorn spelar ljud');
    expect(text).toContain('192.168.10.194 (hittades automatiskt)');
    expect(text).toContain('Står på optisk ingång');
    expect(text).toContain('412 ms efter att ljudet började');
  });

  it('distinguishes a WiiM playing its own music, a paused one and a silent one', () => {
    const ui = setup(
      overviewWith({
        state: { wiim: { reachable: true, optical: false, playing: true } },
      }),
    );
    expect(ui.get('optical-status').text()).toContain('Spelar egen musik');
    ui.setOverview(
      overviewWith({
        state: { wiim: { reachable: true, optical: false, playing: false } },
      }),
    );
    expect(ui.get('optical-status').text()).toContain(
      'Står på annan ingång, pausad',
    );
    ui.setOverview(
      overviewWith({
        state: { wiim: { reachable: false, optical: null, playing: null } },
      }),
    );
    expect(ui.get('optical-status').text()).toContain('Svarar inte');
  });

  it('says when it has no contact, is switched off, cannot listen or is still searching', () => {
    const ui = setup(overviewWith({ agent: null }));
    expect(ui.get('optical-status').text()).toContain(
      'Ingen kontakt med datorns agent',
    );
    ui.setOverview(overviewWith({ stored: { enabled: false } }));
    expect(ui.get('optical-status').text()).toContain('Av i inställningarna');
    ui.setOverview(overviewWith({ state: { capture: 'unavailable' } }));
    expect(ui.get('optical-status').text()).toContain(
      'Kan inte lyssna på ljudutgången',
    );
    ui.setOverview(
      overviewWith({
        state: {
          phase: 'searching',
          host: null,
          hostSource: null,
          wiim: null,
          discovered: ['192.168.10.5', '192.168.10.6'],
        },
      }),
    );
    const text = ui.get('optical-status').text();
    expect(text).toContain('Letar efter WiiM');
    expect(text).toContain('Hittade flera: 192.168.10.5, 192.168.10.6');
  });

  it('explains when the agent does not use the settings from Lugn', () => {
    const ui = setup(overviewWith({ state: { settingsSource: 'config' } }));
    expect(ui.get('optical-status').text()).toContain(
      'Agenten använder sina egna',
    );
    ui.setOverview(
      overviewWith({
        state: { settingsGeneration: '99999999-9999-4999-8999-999999999999' },
      }),
    );
    expect(ui.get('optical-status').text()).toContain(
      'Väntar på att agenten tar emot dem',
    );
  });

  it('fills the form from the saved settings', () => {
    const ui = setup(
      overviewWith({
        stored: { wiimHost: '192.168.10.194', minAudibleMs: 300 },
      }),
    );
    expect(ui.get('optical-enabled').checked).toBe(true);
    expect(ui.get('optical-host').value).toBe('192.168.10.194');
    expect(ui.get('optical-sink').value).toBe('');
    expect(ui.get('optical-min').value).toBe('300');
    expect(ui.get('optical-release').value).toBe('1500');
    expect(ui.get('optical-level').value).toBe('-55');
    expect(ui.get('optical-save').disabled).toBe(true);
    expect(ui.get('optical-reset').disabled).toBe(false);
  });

  it('saves edits with the expected generation and the session token', async () => {
    const ui = setup(overviewWith());
    ui.fetch.mockImplementation(
      respond(200, { generation: '22222222-2222-4222-8222-222222222222' }),
    );
    ui.get('optical-min').value = '250';
    ui.get('optical-host').value = ' 192.168.10.194 ';
    ui.get('optical-sink').value = 'alsa_output.iec958-stereo';
    ui.get('optical-level').value = '-65';
    ui.get('optical-form').fire('input');
    expect(ui.get('optical-save').disabled).toBe(false);
    ui.get('optical-form').fire('submit');
    expect(ui.get('optical-fields').disabled).toBe(true);
    await flush();
    const [url, init] = ui.fetch.mock.calls[0]!;
    expect(url).toBe('/ui/api/optical/settings');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['X-Lugn-CSRF']).toBe(
      'csrf-token',
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      deviceId: 'kuffe',
      expectedGeneration: GENERATION,
      settings: {
        enabled: true,
        wiimHost: '192.168.10.194',
        audioSink: 'alsa_output.iec958-stereo',
        minAudibleMs: 250,
        releaseMs: 1500,
        levelDb: -65,
      },
    });
    expect(ui.refresh).toHaveBeenCalledOnce();
    expect(ui.get('optical-message').textContent).toContain('Sparat');
  });

  it('sends empty address and output as null', async () => {
    const ui = setup(overviewWith({ stored: { wiimHost: '192.168.10.194' } }));
    ui.fetch.mockImplementation(respond(200, { generation: GENERATION }));
    ui.get('optical-host').value = '';
    ui.get('optical-form').fire('input');
    ui.get('optical-form').fire('submit');
    await flush();
    const body = JSON.parse(String(ui.fetch.mock.calls[0]![1]?.body));
    expect(body.settings.wiimHost).toBeNull();
    expect(body.settings.audioSink).toBeNull();
  });

  it('refuses invalid values without asking the server', () => {
    const ui = setup(overviewWith());
    const tries: Array<[string, string, string]> = [
      ['optical-min', '100', '200–5000'],
      ['optical-min', '250.5', '200–5000'],
      ['optical-release', '100', '500–10000'],
      ['optical-level', '-10', '-80 och -20'],
      ['optical-host', '8.8.8.8', 'lokala nätverket'],
      ['optical-host', 'http://192.168.1.5', 'lokala nätverket'],
      ['optical-host', '192.168.1.5:99999', 'lokala nätverket'],
      ['optical-sink', 'a b', 'bokstäver'],
    ];
    for (const [id, value, expected] of tries) {
      const reset = {
        'optical-min': '400',
        'optical-release': '1500',
        'optical-level': '-55',
        'optical-host': '',
        'optical-sink': '',
      };
      for (const [key, v] of Object.entries(reset)) ui.get(key).value = v;
      ui.get(id).value = value;
      ui.get('optical-form').fire('submit');
      expect(ui.get('optical-message').textContent, `${id}=${value}`).toContain(
        expected,
      );
    }
    expect(ui.fetch).not.toHaveBeenCalled();
  });

  it('accepts a .local name', async () => {
    const ui = setup(overviewWith());
    ui.fetch.mockImplementation(respond(200, { generation: GENERATION }));
    ui.get('optical-host').value = 'wiim.local';
    ui.get('optical-form').fire('input');
    ui.get('optical-form').fire('submit');
    await flush();
    expect(
      JSON.parse(String(ui.fetch.mock.calls[0]![1]?.body)).settings.wiimHost,
    ).toBe('wiim.local');
  });

  it('keeps the draft and says so when the settings changed elsewhere', async () => {
    const ui = setup(overviewWith());
    ui.fetch.mockImplementation(
      respond(409, { error: 'optical_settings_changed' }),
    );
    ui.get('optical-min').value = '300';
    ui.get('optical-form').fire('input');
    ui.get('optical-form').fire('submit');
    await flush();
    expect(ui.get('optical-message').textContent).toContain(
      'Ändrat på annat håll',
    );
    expect(ui.get('optical-min').value).toBe('300');
    expect(ui.get('optical-save').disabled).toBe(false);
  });

  it('does not overwrite an unsaved draft when a newer snapshot arrives', () => {
    const ui = setup(overviewWith());
    ui.get('optical-min').value = '300';
    ui.get('optical-form').fire('input');
    ui.setOverview(
      overviewWith({
        generation: '33333333-3333-4333-8333-333333333333',
        stored: { minAudibleMs: 700 },
      }),
    );
    expect(ui.get('optical-min').value).toBe('300');
    ui.get('optical-discard').fire('click');
    expect(ui.get('optical-min').value).toBe('700');
  });

  it('resets to the configured defaults by sending null, after confirmation', async () => {
    const ui = setup(overviewWith({ stored: { minAudibleMs: 700 } }));
    ui.fetch.mockImplementation(respond(200, { generation: GENERATION }));
    ui.get('optical-reset').fire('click');
    await flush();
    expect(ui.confirm).toHaveBeenCalledOnce();
    expect(
      JSON.parse(String(ui.fetch.mock.calls[0]![1]?.body)).settings,
    ).toBeNull();
    ui.confirm.mockReturnValue(false);
    ui.fetch.mockClear();
    ui.get('optical-reset').fire('click');
    await flush();
    expect(ui.fetch).not.toHaveBeenCalled();
  });
});
