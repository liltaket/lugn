import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lightingFeedbackBrowserScript } from '../src/runtime/lighting-feedback-script.js';

type Listener = (event?: { target?: Element; key?: string }) => void;
class Element {
  textContent = '';
  innerHTML = '';
  className = '';
  dataset: Record<string, string> = {};
  hidden = false;
  disabled = false;
  value = '';
  children: Element[] = [];
  parentElement: Element | null = null;
  attributes = new Map<string, string>();
  listeners = new Map<string, Listener>();
  classList = {
    contains: (name: string) => this.className.split(' ').includes(name),
  };
  get firstElementChild() {
    return this.children[0];
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name);
  }
  append(...children: Element[]) {
    for (const child of children) {
      child.remove();
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children: Element[]) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...children);
  }
  remove() {
    if (this.parentElement)
      this.parentElement.children = this.parentElement.children.filter(
        (item) => item !== this,
      );
    this.parentElement = null;
  }
  contains(element: Element): boolean {
    return (
      this === element || this.children.some((item) => item.contains(element))
    );
  }
  closest(selector: string): Element | undefined {
    return selector === 'button[data-scene]' && this.dataset['scene']
      ? this
      : this.parentElement?.closest(selector);
  }
  querySelector(selector: string): Element | undefined {
    return (
      this.children.find((item) => item.className === selector.slice(1)) ??
      this.children.map((item) => item.querySelector(selector)).find(Boolean)
    );
  }
  addEventListener(name: string, fn: Listener) {
    this.listeners.set(name, fn);
  }
  focus = vi.fn();
  click() {
    if (!this.disabled) this.bubble({ target: this });
  }
  private bubble(event: { target: Element }) {
    this.listeners.get('click')?.(event);
    this.parentElement?.bubble(event);
  }
}
const source = readFileSync(
  new URL('../src/ui/display.js', import.meta.url),
  'utf8',
);
const initial = JSON.parse(
  readFileSync(new URL('./fixtures/hub/state.json', import.meta.url), 'utf8'),
);
async function settle() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
function dashboard() {
  let payload = structuredClone(initial);
  let offline = false;
  let postGate: Promise<void> | undefined;
  let postStatus = 200;
  const elements = new Map<string, Element>();
  const get = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector)!;
  };
  get('#music-presets').append(
    get('#music-preset-dj'),
    get('#music-preset-optical'),
    get('#music-details-button'),
  );
  const documentListeners = new Map<string, Listener>();
  const windowListeners = new Map<string, Listener>();
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const streams: Stream[] = [];
  class Stream {
    onmessage?: (event: { data: string }) => void;
    onerror?: () => void;
    closed = false;
    constructor(readonly url: string) {
      streams.push(this);
    }
    close() {
      this.closed = true;
    }
    emit(value: unknown) {
      this.onmessage?.({ data: JSON.stringify(value) });
    }
  }
  const context = createContext({
    location: { pathname: '/k/mock-only/' },
    document: {
      visibilityState: 'visible',
      querySelector: get,
      createElement: () => new Element(),
      createTextNode: (text: string) => {
        const el = new Element();
        el.textContent = text;
        return el;
      },
      addEventListener: (name: string, fn: Listener) =>
        documentListeners.set(name, fn),
    },
    window: {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      EventSource: Stream,
      addEventListener: (name: string, fn: Listener) =>
        windowListeners.set(name, fn),
    },
    Date,
    Intl,
    AbortController,
    console,
    fetch: async (
      url: string,
      options: { method: string; body?: string; signal?: AbortSignal },
    ) => {
      if (options.method === 'POST') {
        calls.push({ url, body: JSON.parse(options.body!) });
        let onAbort = () => {};
        try {
          await Promise.race([
            postGate,
            new Promise((_, reject) => {
              onAbort = () => reject(options.signal?.reason);
              options.signal?.addEventListener('abort', onAbort, {
                once: true,
              });
            }),
          ]);
        } finally {
          options.signal?.removeEventListener('abort', onAbort);
        }
        return {
          ok: postStatus === 200,
          status: postStatus,
          json: async () => ({ accepted: true }),
        };
      }
      if (offline) throw new Error('simulated offline');
      return { ok: true, json: async () => structuredClone(payload) };
    },
  });
  runInContext(lightingFeedbackBrowserScript + source, context);
  return {
    get,
    context,
    calls,
    streams,
    documentListeners,
    payload: () => payload,
    render: (value = payload) => {
      payload = value;
      runInContext(`render(${JSON.stringify(payload)})`, context);
    },
    setOffline: (value: boolean) => {
      offline = value;
    },
    holdPost: () => {
      let release = () => {};
      postGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    failPost: (status: number) => {
      postStatus = status;
    },
    dispose: () => windowListeners.get('pagehide')?.(),
  };
}
function actions(element: Element): Element[] {
  return element.children.flatMap((item) =>
    item.className === 'context-action' ? [item] : actions(item),
  );
}
let ui: ReturnType<typeof dashboard>;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(initial.generatedAt);
  ui = dashboard();
  await settle();
});
afterEach(() => {
  ui.dispose();
  vi.useRealTimers();
});

describe('Hub optional Lugn 2 presentation', () => {
  it('never starts routines or accepts suggestions on load; missing projections retain manual controls', () => {
    expect(ui.calls).toEqual([]);
    const legacy = ui.payload();
    delete legacy.routines;
    delete legacy.intelligence;
    delete legacy.artwork;
    ui.render(legacy);
    expect(ui.get('#context-strip').hidden).toBe(true);
    expect(ui.get('#context-details-button').hidden).toBe(true);
    expect(
      ui
        .get('#scene-grid')
        .children.some((button) => button.dataset['scene'] === 'scene.all_off'),
    ).toBe(true);
    expect(ui.get('#music-preset-optical').disabled).toBe(false);
    expect(ui.get('#music-volume-up').disabled).toBe(false);
    expect(ui.get('#presence-count-one').disabled).toBe(false);
  });
  it('starts only an enabled configured night routine, guards double taps and waits for authoritative run state', async () => {
    expect(ui.get('#context-title').textContent).toBe('God natt');
    const release = ui.holdPost();
    actions(ui.get('#context-actions'))[0]!.click();
    actions(ui.get('#context-actions'))[0]!.click();
    await settle();
    expect(ui.calls).toEqual([
      {
        url: '/k/mock-only/display-api/routine',
        body: { id: 'night', action: 'start' },
      },
    ]);
    expect(ui.get('#context-description').textContent).not.toContain('Pågår');
    const data = ui.payload();
    data.routines.runs = [
      { id: 'run-1', routineId: 'night', status: 'running', stepIndex: 1 },
    ];
    release();
    await settle();
    expect(ui.get('#context-description').textContent).toBe(
      'Pågår · steg 2 av 3',
    );
    const cancel = actions(ui.get('#context-actions'))[0]!;
    expect(cancel.textContent).toBe('Avbryt');
    cancel.click();
    await settle();
    expect(ui.calls.at(-1)?.body).toEqual({ id: 'night', action: 'cancel' });
    expect(ui.get('#context-description').textContent).toContain('Pågår');
    data.routines.runs[0].status = 'cancelled';
    ui.render(data);
    expect(ui.get('#context-description').textContent).not.toContain('Pågår');
  });
  it('allows Cancel from authoritative state while Start is stalled and blocks duplicate cancels', async () => {
    const release = ui.holdPost();
    actions(ui.get('#context-actions'))[0]!.click();
    await settle();
    const data = ui.payload();
    data.routines.runs = [
      { id: 'run-1', routineId: 'night', status: 'running', stepIndex: 1 },
    ];
    ui.render(data);
    const cancel = actions(ui.get('#context-actions'))[0]!;
    expect(cancel.disabled).toBe(false);
    cancel.click();
    actions(ui.get('#context-actions'))[0]!.click();
    await settle();
    expect(ui.calls.map((call) => call.body)).toEqual([
      { id: 'night', action: 'start' },
      { id: 'night', action: 'cancel' },
    ]);
    release();
    await settle();
  });
  it('bounds stalled routine requests, reports an unknown outcome and never retries them', async () => {
    const release = ui.holdPost();
    actions(ui.get('#context-actions'))[0]!.click();
    await settle();
    const data = ui.payload();
    data.routines.runs = [
      { id: 'run-1', routineId: 'night', status: 'running', stepIndex: 1 },
    ];
    ui.render(data);
    await vi.advanceTimersByTimeAsync(8_001);
    await settle();
    expect(ui.calls).toHaveLength(1);
    expect(ui.get('#toast').textContent).toContain('Kvittens saknas');
    expect(actions(ui.get('#context-actions'))[0]!.disabled).toBe(false);
    release();
    await settle();
    expect(ui.calls).toHaveLength(1);
  });
  it('never invents wake times from morning hours, presence or disabled definitions', () => {
    const data = ui.payload();
    data.generatedAt += 9 * 3600000;
    data.routines.next = [];
    ui.render(data);
    expect(ui.get('#context-strip').hidden).toBe(true);
    data.routines.definitions[0].enabled = false;
    data.routines.definitions[1].enabled = false;
    data.routines.next = [
      { routineId: 'morning', at: data.generatedAt + 3600000 },
    ];
    ui.render(data);
    expect(ui.get('#context-strip').hidden).toBe(true);
    ui.get('#context-details-button').click();
    expect(actions(ui.get('#context-list'))).toHaveLength(0); // disabled routines and expired suggestion
  });
  it('snoozes and skips an actual configured wake occurrence using contracted actions', async () => {
    const data = ui.payload();
    data.generatedAt += 9 * 3600000;
    ui.render(data);
    expect(ui.get('#context-title').textContent).toBe('God morgon');
    expect(ui.get('#context-description').textContent).toContain('Planerad');
    actions(ui.get('#context-actions'))[0]!.click();
    await settle();
    expect(ui.calls.at(-1)?.body).toEqual({
      id: 'morning',
      action: 'snooze',
      minutes: 10,
    });
    actions(ui.get('#context-actions'))[1]!.click();
    await settle();
    expect(ui.calls.at(-1)?.body).toEqual({ id: 'morning', action: 'skip' });
  });
  it('prioritizes Desk suggestions, hides expired or unconfigured scenes and uses authenticated-path routes', async () => {
    const data = ui.payload();
    data.role = 'desk';
    ui.render(data);
    expect(ui.get('#scene-grid').children[0]!.dataset['scene']).toBe(
      'scene.focus_light',
    );
    expect(ui.get('#music-presets').children[0]).toBe(
      ui.get('#music-preset-optical'),
    );
    expect(ui.get('#context-title').textContent).toBe(
      'Fokus för arbetsstunden',
    );
    actions(ui.get('#context-actions'))[1]!.click();
    await settle();
    expect(ui.calls.at(-1)).toEqual({
      url: '/k/mock-only/display-api/suggestion',
      body: { id: 'focus', action: 'dismiss' },
    });
    data.intelligence.suggestions[0].expiresAt = data.generatedAt - 1;
    ui.render(data);
    expect(ui.get('#context-strip').hidden).toBe(true);
    data.intelligence.suggestions[0].expiresAt = data.generatedAt + 3600000;
    data.intelligence.suggestions[0].sceneId = 'imaginary';
    ui.render(data);
    expect(ui.get('#context-strip').hidden).toBe(true);
  });
  it('supports accept/reject in the accessible secondary pane without hiding music controls', async () => {
    ui.get('#context-details-button').click();
    expect(ui.get('#context-panel').hidden).toBe(false);
    expect(ui.get('#scene-grid').hidden).toBe(true);
    const controls = actions(ui.get('#context-list'));
    controls.find((button) => button.dataset['action'] === 'accept')!.click();
    await settle();
    controls.find((button) => button.dataset['action'] === 'reject')!.click();
    await settle();
    expect(ui.calls.map((call) => call.body['action'])).toEqual([
      'accept',
      'reject',
    ]);
    expect(ui.get('#music-playback').disabled).toBe(false);
    ui.documentListeners.get('keydown')?.({ key: 'Escape' });
    expect(ui.get('#context-panel').hidden).toBe(true);
    expect(ui.get('#context-details-button').focus).toHaveBeenCalled();
  });
  it('keeps artwork errors harmless and retries only for new metadata, never an external URL', () => {
    const image = ui.get('#music-artwork-image');
    expect(image.attributes.get('src')).toBe('/fixture-cover.svg');
    image.listeners.get('load')?.();
    expect(image.hidden).toBe(false);
    image.listeners.get('error')?.();
    expect(image.hidden).toBe(true);
    expect(ui.get('#music-artwork').dataset['state']).toBe('unavailable');
    ui.render();
    expect(ui.get('#music-artwork').dataset['state']).toBe('unavailable');
    const data = ui.payload();
    data.artwork['music.room'].url = '/new-cover.svg';
    ui.render(data);
    expect(ui.get('#music-artwork').dataset['state']).toBe('loading');
    for (const url of [
      'https://example.invalid/art.jpg',
      '//example.invalid/art.jpg',
      '/\\example.invalid/art.jpg',
      '/\nexample.invalid',
    ]) {
      data.artwork['music.room'].url = url;
      ui.render(data);
      expect(image.hidden).toBe(true);
      expect(ui.get('#music-artwork').dataset['state']).toBe('missing');
    }
    expect(ui.get('#music-preset-dj').disabled).toBe(false);
  });
  it('disables new actions on stream loss and stale polling, recovers without replaying actions', async () => {
    const data = ui.payload();
    data.role = 'desk';
    ui.render(data);
    ui.setOffline(true);
    ui.streams[0]!.onerror?.();
    await settle();
    expect(ui.get('#connection-notice').dataset['state']).toBe('offline');
    expect(
      actions(ui.get('#context-actions')).every((button) => button.disabled),
    ).toBe(true);
    expect(ui.get('#music-volume-observed-label').textContent).toBe('Senast');
    expect(ui.get('#context-description').textContent).toContain(
      'Senast rapporterat',
    );
    await vi.advanceTimersByTimeAsync(1000);
    ui.setOffline(false);
    ui.streams.at(-1)!.emit({ ...data, deliveryRevision: 2 });
    await settle();
    expect(ui.get('#connection-notice').dataset['state']).toBe('connected');
    expect(
      actions(ui.get('#context-actions')).every((button) => !button.disabled),
    ).toBe(true);
    expect(ui.calls).toEqual([]);
  });
  it('retains manual all-off, Optical, volume and presence requests with no client-supplied provenance', async () => {
    ui.get('#scene-grid')
      .children.find((button) => button.dataset['scene'] === 'scene.all_off')!
      .click();
    await settle();
    ui.get('#music-preset-optical').click();
    await settle();
    ui.get('#music-volume-up').click();
    await settle();
    ui.get('#presence-count-one').click();
    await settle();
    expect(ui.calls.map((call) => call.body)).toEqual([
      { sceneId: 'scene.all_off' },
      { target: 'music.room', presetId: 4 },
      { target: 'music.room', request: { property: 'volume', value: 0.28 } },
      {},
    ]);
    expect(ui.get('#music-volume-value').textContent).toBe('23%');
  });
  it('preserves full authority and command explanations in Details when main status lines are compact', () => {
    const data = ui.payload();
    data.musicVolumePolicies['music.room'].mode = 'manual';
    data.state.music.commands = [
      {
        id: 'failure',
        target: 'music.room',
        issuedAt: data.generatedAt,
        status: 'failed',
        requested: { property: 'volume', value: 0.3 },
      },
    ];
    ui.render(data);
    expect(ui.get('#music-command-detail').textContent).toContain(
      'misslyckades',
    );
    expect(ui.get('#music-authority-detail').textContent).toContain(
      'Manuellt läge',
    );
    ui.get('#music-details-button').click();
    expect(ui.get('#music-details').hidden).toBe(false);
    expect(ui.get('#music-volume-up').disabled).toBe(false);
  });
  it('keeps the action DOM stable during pending requests so keyboard focus is retained', async () => {
    const button = actions(ui.get('#context-actions'))[0]!;
    const release = ui.holdPost();
    button.click();
    await settle();
    expect(actions(ui.get('#context-actions'))[0]).toBe(button);
    expect(button.disabled).toBe(true);
    release();
    await settle();
    expect(actions(ui.get('#context-actions'))[0]).toBe(button);
    expect(button.disabled).toBe(false);
  });
  it('pages a larger configured scene set and keeps every scene reachable without primary scrolling', () => {
    const data = ui.payload();
    data.scenes.push(
      ...Array.from({ length: 7 }, (_, index) => ({
        id: `scene.custom${index}`,
        name: `Eget ljus ${index}`,
      })),
    );
    ui.render(data);
    expect(ui.get('#scene-pagination').hidden).toBe(false);
    expect(ui.get('#scene-grid').children).toHaveLength(6);
    expect(ui.get('#scene-page-label').textContent).toBe('1 / 2');
    ui.get('#scene-next').click();
    expect(ui.get('#scene-grid').children).toHaveLength(6);
    expect(ui.get('#scene-page-label').textContent).toBe('2 / 2');
    ui.get('#scene-previous').click();
    expect(ui.get('#scene-grid').children[0]!.dataset['scene']).toBe(
      'scene.all_off',
    );
  });
  it('shows failed requests and re-enables retry without claiming a routine is running', async () => {
    ui.failPost(409);
    actions(ui.get('#context-actions'))[0]!.click();
    await settle();
    expect(ui.get('#toast').textContent).toContain('Försök igen');
    expect(ui.get('#context-description').textContent).not.toContain('Pågår');
    expect(actions(ui.get('#context-actions'))[0]!.disabled).toBe(false);
  });
});

describe('Hub lighting pictograms', () => {
  it('uses distinct built-in icons with learnable name captions and keeps unknown presets readable', () => {
    const data = ui.payload();
    data.scenes.push(
      { id: 'scene.party', name: 'Party' },
      { id: 'scene.custom_evening', name: 'Min sena kväll' },
    );
    delete data.routines;
    delete data.intelligence;
    ui.render(data);
    const expected = {
      'scene.all_off': 'power',
      'scene.soft_light': 'moon',
      'scene.everyday_light': 'sun',
      'scene.focus_light': 'desk-lamp',
      'scene.movie_light': 'film',
      'scene.party': 'disco-ball',
    };
    for (const button of ui.get('#scene-grid').children) {
      const scene = data.scenes.find(
        (item: { id: string }) => item.id === button.dataset['scene'],
      );
      expect(button.getAttribute('aria-label')).toContain(scene.name);
      expect(button.getAttribute('title')).toContain(scene.name);
      expect(button.querySelector('.scene-name')?.textContent).toBe(scene.name);
      const symbol = button.querySelector('.scene-icon');
      if (button.dataset['scene'] === 'scene.custom_evening') {
        expect(button.dataset['icon']).toBe('false');
        expect(symbol).toBeUndefined();
        expect(button.querySelector('.scene-name')?.textContent).toBe(
          'Min sena kväll',
        );
      } else {
        expect(button.dataset['icon']).toBe('true');
        expect(symbol?.dataset['symbol']).toBe(
          expected[button.dataset['scene'] as keyof typeof expected],
        );
        expect(symbol?.getAttribute('aria-hidden')).toBe('true');
        expect(symbol?.innerHTML).toContain('<svg viewBox="0 0 24 24"');
      }
    }
    expect(new Set(Object.values(expected)).size).toBe(6);
    expect(ui.calls).toEqual([]);
  });

  it('keeps icon button and focus stable when a preset is renamed without inserting the name in SVG', () => {
    const button = ui
      .get('#scene-grid')
      .children.find((item) => item.dataset['scene'] === 'scene.soft_light')!;
    const symbol = button.querySelector('.scene-icon')!;
    const data = ui.payload();
    data.scenes.find(
      (item: { id: string }) => item.id === 'scene.soft_light',
    ).name = '<script>kväll</script>';
    ui.render(data);
    expect(ui.get('#scene-grid').children).toContain(button);
    expect(button.querySelector('.scene-icon')).toBe(symbol);
    expect(button.getAttribute('aria-label')).toContain(
      '<script>kväll</script>',
    );
    expect(symbol.innerHTML).not.toContain('script');
  });

  it('accepts taps on the SVG wrapper, reflects pending state, and never claims a request is confirmed', async () => {
    const button = ui
      .get('#scene-grid')
      .children.find(
        (item) => item.dataset['scene'] === 'scene.everyday_light',
      )!;
    const release = ui.holdPost();
    button.querySelector('.scene-icon')!.click();
    await settle();
    expect(ui.calls).toEqual([
      {
        url: '/k/mock-only/display-api/scene',
        body: { sceneId: 'scene.everyday_light' },
      },
    ]);
    expect(button.dataset['state']).toBe('pending');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.getAttribute('aria-label')).toContain('Skickar');
    expect(button.disabled).toBe(true);
    button.querySelector('.scene-icon')!.click();
    await settle();
    expect(ui.calls).toHaveLength(1);
    release();
    await settle();
    expect(button.dataset['state']).toBe('idle');
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('distinguishes selected intent, device confirmation, waiting and offline states accessibly', async () => {
    const data = ui.payload();
    const button = ui
      .get('#scene-grid')
      .children.find((item) => item.dataset['scene'] === 'scene.soft_light')!;
    expect(button.dataset['state']).toBe('selected');
    data.state.lighting.sceneRevision = 2;
    data.state.commands = [{ revision: 2, status: 'pending' }];
    ui.render(data);
    expect(button.dataset['state']).toBe('awaiting');
    expect(button.getAttribute('aria-label')).toContain('väntar på lampor');
    data.state.commands = [];
    data.state.lighting.devices = {
      lamp: {
        availability: 'available',
        effectiveDesired: { power: true },
        observed: { power: true },
      },
    };
    ui.render(data);
    expect(button.dataset['state']).toBe('confirmed');
    expect(button.getAttribute('aria-label')).toContain('Bekräftat');
    ui.setOffline(true);
    ui.streams[0]!.onerror?.();
    await settle();
    expect(button.dataset['state']).toBe('offline');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-label')).toContain('Frånkopplad');
    expect(button.getAttribute('aria-label')).not.toContain('Bekräftat');
  });
});
