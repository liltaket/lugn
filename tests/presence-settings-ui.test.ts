import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

class Element {
  value = '';
  checked = false;
  disabled = false;
  hidden = false;
  type = '';
  textContent = '';
  dataset: Record<string, string> = {};
  style = {};
  children: Element[] = [];
  parent: Element | undefined;
  attributes = new Map<string, string>();
  listeners = new Map<
    string,
    ((event: { preventDefault(): void }) => void)[]
  >();
  append(...children: Element[]) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children: Element[]) {
    this.children = [];
    this.append(...children);
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
  get unavailable(): boolean {
    return this.disabled || (this.parent?.unavailable ?? false);
  }
  fire(type: string) {
    if (this.unavailable) return;
    for (const listener of this.listeners.get(type) ?? [])
      listener({ preventDefault() {} });
  }
  getContext() {
    return Object.fromEntries(
      [
        'setTransform',
        'fillRect',
        'beginPath',
        'arc',
        'stroke',
        'fillText',
        'moveTo',
        'lineTo',
        'fill',
      ].map((name) => [name, () => undefined]),
    );
  }
}

const config = (recalibrates: boolean) => ({
  fields: [
    {
      key: 'passage_deadtime_ms',
      type: 'integer',
      min: 0,
      max: 5000,
      recalibrates,
    },
    {
      key: 'prelight_mode',
      type: 'enum',
      options: ['legacy', 'smart'],
      recalibrates,
    },
    { key: 'invert_direction', type: 'boolean', recalibrates },
  ],
  values: {
    passage_deadtime_ms: 200,
    prelight_mode: 'legacy',
    invert_direction: false,
  },
});
async function flush() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}
function setup(recalibrates: boolean) {
  const elements = new Map<string, Element>();
  const inputs: Element[] = [];
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  get('presence-form').append(get('presence-fields'));
  get('presence-fields').append(
    get('presence-groups'),
    get('presence-save'),
    get('presence-discard'),
  );
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const response = new Promise<Response>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const fetch = vi.fn<typeof globalThis.fetch>(() => response);
  const context = createContext({
    window: {
      lugnPanel: {
        overview: () => ({ presenceSensorEnabled: false }),
        csrfToken: () => 'csrf',
      },
      addEventListener: vi.fn(),
    },
    document: {
      getElementById: get,
      createElement: () => {
        const element = new Element();
        inputs.push(element);
        return element;
      },
      querySelector: (selector: string) =>
        [...inputs]
          .reverse()
          .find(
            (input) =>
              selector ===
              `[data-presence-key="${input.dataset['presenceKey']}"]`,
          ),
      addEventListener: vi.fn(),
    },
    CSS: { escape: (value: string) => value },
    location: { hash: '#narvaro' },
    fetch,
    setTimeout,
    clearTimeout,
  });
  runInContext(
    readFileSync(new URL('../web/presence.js', import.meta.url), 'utf8'),
    context,
  );
  runInContext(
    `applyDocument(${JSON.stringify(config(recalibrates))})`,
    context,
  );
  const input = (key: string) =>
    [...inputs]
      .reverse()
      .find((element) => element.dataset['presenceKey'] === key)!;
  const edit = (key: string, value: string | boolean) => {
    const element = input(key);
    // Native controls inside a disabled fieldset reject keyboard/pointer edits.
    if (element.unavailable) return false;
    if (typeof value === 'boolean') element.checked = value;
    else element.value = value;
    element.fire('input');
    return true;
  };
  return {
    get,
    input,
    edit,
    fetch,
    resolve,
    reject,
    run: (code: string) => runInContext(code, context),
  };
}

describe('sensor settings save lifecycle', () => {
  it.each([false, true])(
    'prevents edits while saving and recovers after success (confirmation %s)',
    async (recalibrates) => {
      const ui = setup(recalibrates);
      ui.edit('passage_deadtime_ms', '350');
      ui.edit('prelight_mode', 'smart');
      ui.edit('invert_direction', true);
      ui.get('presence-form').fire('submit');
      if (recalibrates) {
        expect(ui.fetch).not.toHaveBeenCalled();
        expect(ui.get('presence-fields').disabled).toBe(false);
        ui.get('presence-form').fire('submit');
      }
      expect(ui.get('presence-fields').disabled).toBe(true);
      expect(ui.get('presence-form').attributes.get('aria-busy')).toBe('true');
      expect(ui.get('presence-save').disabled).toBe(true);
      expect(ui.get('presence-discard').disabled).toBe(true);
      expect(ui.edit('passage_deadtime_ms', '450')).toBe(false);
      expect(ui.edit('prelight_mode', 'legacy')).toBe(false);
      expect(ui.edit('invert_direction', false)).toBe(false);
      ui.get('presence-form').fire('submit');
      ui.get('presence-discard').fire('click');
      expect(ui.fetch).toHaveBeenCalledTimes(1);
      const changes = {
        passage_deadtime_ms: 350,
        prelight_mode: 'smart',
        invert_direction: true,
      };
      expect(JSON.parse(String(ui.fetch.mock.calls[0]![1]?.body))).toEqual({
        input: { changes },
      });
      ui.resolve(
        new Response(
          JSON.stringify({ ...config(recalibrates), values: changes }),
        ),
      );
      await flush();
      expect(ui.run('saved')).toEqual(changes);
      expect(ui.run('draft')).toEqual(changes);
      expect(ui.input('passage_deadtime_ms').value).toBe('350');
      expect(ui.input('prelight_mode').value).toBe('smart');
      expect(ui.input('invert_direction').checked).toBe(true);
      expect(ui.get('presence-fields').disabled).toBe(false);
      expect(ui.get('presence-form').attributes.get('aria-busy')).toBe('false');
      expect(ui.get('presence-save').disabled).toBe(true);
      expect(ui.get('presence-settings-status').dataset['tone']).toBe('good');
      expect(ui.edit('passage_deadtime_ms', '450')).toBe(true);
      expect(ui.get('presence-save').disabled).toBe(false);
    },
  );

  it.each(['network', 'rejected'])(
    'retains the draft and unlocks editing after %s failure',
    async (failure) => {
      const ui = setup(false);
      ui.edit('passage_deadtime_ms', '350');
      ui.get('presence-form').fire('submit');
      expect(ui.get('presence-fields').disabled).toBe(true);
      expect(ui.get('presence-form').attributes.get('aria-busy')).toBe('true');
      expect(ui.edit('passage_deadtime_ms', '450')).toBe(false);
      if (failure === 'network') ui.reject(new Error('offline'));
      else
        ui.resolve(
          new Response(JSON.stringify({ error: 'sensor_rejected_change' }), {
            status: 400,
          }),
        );
      await flush();
      expect(ui.run('saved.passage_deadtime_ms')).toBe(200);
      expect(ui.run('draft.passage_deadtime_ms')).toBe(350);
      expect(ui.input('passage_deadtime_ms').value).toBe('350');
      expect(ui.get('presence-fields').disabled).toBe(false);
      expect(ui.get('presence-form').attributes.get('aria-busy')).toBe('false');
      expect(ui.get('presence-save').disabled).toBe(false);
      expect(ui.get('presence-discard').disabled).toBe(false);
      expect(ui.get('presence-settings-status').dataset['tone']).toBe('bad');
      ui.edit('passage_deadtime_ms', '450');
      expect(ui.run('draft.passage_deadtime_ms')).toBe(450);
      ui.get('presence-discard').fire('click');
      expect(ui.input('passage_deadtime_ms').value).toBe('200');
      expect(ui.get('presence-save').disabled).toBe(true);
    },
  );
  it.each([false, true])(
    'unlocks the shared form after a sensor action (failure %s)',
    async (fails) => {
      const ui = setup(false);
      ui.edit('passage_deadtime_ms', '350');
      const action = ui.run(
        "runAction('presence.setCount', { count: 0 }, 'Done')",
      );
      expect(ui.get('presence-fields').disabled).toBe(true);
      expect(ui.get('presence-save').disabled).toBe(true);
      expect(ui.edit('passage_deadtime_ms', '450')).toBe(false);
      if (fails) ui.reject(new Error('offline'));
      else ui.resolve(new Response('{}'));
      await action;
      expect(ui.get('presence-fields').disabled).toBe(false);
      expect(ui.get('presence-save').disabled).toBe(false);
      expect(ui.get('presence-form').attributes.get('aria-busy')).toBe('false');
      expect(ui.run('draft.passage_deadtime_ms')).toBe(350);
    },
  );
});
