import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

/** Runs the actual preset handlers against a bounded DOM seam. */
class Element {
  value = '';
  checked = false;
  disabled = false;
  hidden = false;
  textContent = '';
  type = '';
  className = '';
  id = '';
  min = '';
  max = '';
  dataset: Record<string, string> = {};
  children: Element[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, () => unknown>();
  get validity() {
    const value = Number(this.value);
    return {
      valid:
        this.value !== '' &&
        value >= Number(this.min || 0) &&
        value <= Number(this.max || Infinity),
    };
  }
  append(...children: Element[]) {
    this.children.push(...children);
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  addEventListener(type: string, callback: () => unknown) {
    this.listeners.set(type, callback);
  }
  async fire(type: string) {
    await this.listeners.get(type)?.();
  }
  focus() {}
}
const target = 'lighting.govee_ceiling';
function setup(govee = true, kelvin = 3000) {
  const lighting = {
    [target]: { power: true, brightness: 30, colorTemperature: kelvin },
  };
  const draft = { id: 'scene.custom_test', name: 'Kväll', lighting };
  const overview = {
    scenes: [],
    goveeCapabilities: govee
      ? {
          [target]: {
            effects: ['Aurora', 'Forest B'],
            zones: true,
            colorTemperature: { min: 2000, max: 6500 },
          },
        }
      : {},
  };
  const changed = vi.fn();
  const invoke = vi.fn();
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const input = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({ scene: { ...input, id: draft.id, canDelete: true } }),
    );
  });
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const context = createContext({
    overview,
    presetDraft: structuredClone(draft),
    presetOriginal: structuredClone(draft),
    presetBusy: false,
    csrfToken: 'csrf',
    pendingActions: new Set(),
    presetName: Object.assign(new Element(), { value: draft.name }),
    presetEditor: new Element(),
    savePresetButton: new Element(),
    deletePresetButton: new Element(),
    API_ROOT: '/ui/api',
    fetch,
    structuredClone,
    document: { createElement: () => new Element(), getElementById: get },
    node: (_tag: string, _className = '', text = '') =>
      Object.assign(new Element(), {
        textContent: text,
        className: _className,
      }),
    displayTarget: (value: string) => value,
    updatePresetDirtyState: changed,
    setPresetStatus: vi.fn(),
    setPresetBusy: vi.fn(),
    refreshOverview: vi.fn(),
    invokeCapability: invoke,
    handlePresetError: vi.fn(),
  });
  const source = readFileSync(
    new URL('../web/app.js', import.meta.url),
    'utf8',
  );
  runInContext(
    source.slice(
      source.indexOf('function sceneSnapshot('),
      source.indexOf('function presetIsDirty('),
    ) +
      source.slice(
        source.indexOf('function setPresetGovee('),
        source.indexOf('function setPresetBusy('),
      ) +
      source.slice(
        source.indexOf('async function mutatePreset('),
        source.indexOf('async function deletePreset('),
      ),
    context,
  );
  const run = (code: string) => runInContext(code, context);
  const row: Element = run(`renderPresetLight('${target}')`);
  const detail = row.children[2]!;
  const field = (name: string) => {
    const label = detail.children.find(
      (child) => child.children[0]?.textContent === name,
    );
    if (!label?.children[1]) throw new Error(`Missing preset field: ${name}`);
    return label.children[1];
  };
  return { run, row, field, fetch, changed, invoke, overview, draft };
}

it('edits catalog animations and ceiling masks without sending a light command', async () => {
  const s = setup();
  s.field('Ljustyp').value = 'effect';
  await s.field('Ljustyp').fire('change');
  s.field('Appanimation').value = 'Forest B';
  await s.field('Appanimation').fire('change');
  s.field('Taklampans delar').value = 'ring';
  await s.field('Taklampans delar').fire('change');
  expect(s.run('presetDraft')).toMatchObject({
    lighting: { [target]: { power: true, brightness: 30 } },
    govee: {
      [target]: { effect: 'Forest B', zones: { main: false, ring: true } },
    },
  });
  expect(
    s.run(`presetDraft.lighting['${target}'].colorTemperature`),
  ).toBeUndefined();
  expect(s.fetch).not.toHaveBeenCalled();
  expect(s.invoke).not.toHaveBeenCalled();
  await s.run('savePreset(false)');
  const saved = JSON.parse(String(s.fetch.mock.calls[0]![1].body));
  expect(saved.govee[target]).toEqual({
    effect: 'Forest B',
    zones: { main: false, ring: true },
  });
  expect(saved.expectedScene).toEqual(s.draft);
  expect(s.invoke).not.toHaveBeenCalled();
  expect(s.run('sceneSnapshot(presetDraft).govee')).toEqual(saved.govee);
});

it('keeps target Kelvin limits and changes between animation, white and RGB', async () => {
  const s = setup();
  expect(s.field('Färgtemperatur (K)').min).toBe('2000');
  s.field('Ljustyp').value = 'effect';
  await s.field('Ljustyp').fire('change');
  s.field('Ljustyp').value = 'white';
  await s.field('Ljustyp').fire('change');
  s.field('Färgtemperatur (K)').value = '2200';
  await s.field('Färgtemperatur (K)').fire('input');
  expect(s.run(`presetDraft.lighting['${target}'].colorTemperature`)).toBe(
    2200,
  );
  expect(s.run(`presetDraft.govee['${target}'].effect`)).toBeUndefined();
  s.field('Ljustyp').value = 'rgb';
  await s.field('Ljustyp').fire('change');
  s.field('Färg').value = '#10a0ff';
  await s.field('Färg').fire('input');
  expect(s.run(`presetDraft.lighting['${target}'].rgb`)).toEqual([
    16, 160, 255,
  ]);
  expect(
    s.run(`presetDraft.lighting['${target}'].colorTemperature`),
  ).toBeUndefined();
  s.overview.goveeCapabilities[target]!.effects = ['Different'];
  expect(s.run(`presetDraft.lighting['${target}'].rgb`)).toEqual([
    16, 160, 255,
  ]);
  expect(s.fetch).not.toHaveBeenCalled();
});

it('retains excluded animation settings and removes animation intent for whole OFF', async () => {
  const s = setup();
  s.field('Ljustyp').value = 'effect';
  await s.field('Ljustyp').fire('change');
  s.field('Taklampans delar').value = 'ring';
  await s.field('Taklampans delar').fire('change');
  const include = s.row.children[0]!.children[0]!;
  include.checked = false;
  await include.fire('change');
  expect(s.run(`presetDraft.lighting['${target}']`)).toBeUndefined();
  expect(s.run('presetDraft.govee')).toBeUndefined();
  include.checked = true;
  await include.fire('change');
  expect(s.run(`presetDraft.govee['${target}']`)).toEqual({
    effect: 'Aurora',
    zones: { main: false, ring: true },
  });
  const slider = s.row.children[1]!.children[0]!;
  slider.value = '0';
  await slider.fire('input');
  expect(s.run(`presetDraft.lighting['${target}'].power`)).toBe(false);
  expect(s.run('presetDraft.govee')).toBeUndefined();
  slider.value = '20';
  await slider.fire('input');
  expect(s.run(`presetDraft.govee['${target}'].zones.ring`)).toBe(true);
});

it('offers static controls without inventing an animation catalog or ceiling zones', () => {
  const s = setup(false);
  expect(s.field('Ljustyp').children.map((option) => option.value)).toEqual([
    'white',
  ]);
  expect(s.field('Taklampans delar').disabled).toBe(true);
  expect(s.field('Färgtemperatur (K)').min).toBe('2700');
  expect(s.run('presetDraft')).toEqual(s.draft);
});

it('keeps the draft on failed Save and re-enters animation after saving whole OFF', async () => {
  const s = setup();
  s.field('Ljustyp').value = 'effect';
  await s.field('Ljustyp').fire('change');
  const beforeFailure = structuredClone(s.run('presetDraft'));
  s.fetch.mockImplementationOnce(
    async () =>
      new Response(JSON.stringify({ error: 'scene_save_failed' }), {
        status: 503,
      }),
  );
  await s.run('savePreset(false)');
  expect(s.run('presetDraft')).toEqual(beforeFailure);
  const slider = s.row.children[1]!.children[0]!;
  slider.value = '0';
  await slider.fire('input');
  const include = s.row.children[0]!.children[0]!;
  include.checked = false;
  await include.fire('change');
  include.checked = true;
  await include.fire('change');
  expect(s.run('presetDraft.govee')).toBeUndefined();
  // The server fills remembered white intent for OFF definitions on save.
  s.run(`presetDraft.lighting['${target}'].colorTemperature = 2700`);
  slider.value = '30';
  await slider.fire('input');
  expect(
    s.run(`presetDraft.lighting['${target}'].colorTemperature`),
  ).toBeUndefined();
  expect(s.run(`presetDraft.govee['${target}'].effect`)).toBe('Aurora');
  expect(s.invoke).not.toHaveBeenCalled();
});

it('keeps legacy 2200 K editable without advertising new RGB for lamps without confirmed capability', () => {
  const s = setup(false, 2200);
  const white = s.field('Färgtemperatur (K)');
  expect(white.value).toBe('2200');
  expect(white.validity.valid).toBe(true);
  const mode = s.field('Ljustyp');
  expect(mode.children.map((option) => option.value)).toEqual(['white']);
});
