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
  step = '';
  multiple = false;
  size = 0;
  selected = false;
  required = false;
  dataset: Record<string, string> = {};
  children: Element[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, () => unknown>();
  get validity() {
    const value = Number(this.value);
    const step = Number(this.step || 1);
    return {
      stepMismatch:
        Number.isFinite(value) && (value - Number(this.min || 0)) % step !== 0,
      valid:
        this.value !== '' &&
        value >= Number(this.min || 0) &&
        value <= Number(this.max || Infinity) &&
        Number.isFinite(value) &&
        (value - Number(this.min || 0)) % step === 0,
    };
  }
  get options() {
    return this.children;
  }
  get selectedOptions() {
    return this.children.filter((option) => option.selected);
  }
  append(...children: Element[]) {
    this.children.push(...children);
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  getAttribute(key: string) {
    return this.attributes.get(key) ?? null;
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
function setup(
  govee = true,
  kelvin = 3000,
  goveeIntent?: Record<string, unknown>,
  effects = ['Aurora', 'Forest B'],
) {
  const lighting = {
    [target]: {
      power: true,
      brightness: 30,
      ...(goveeIntent?.['rotation'] ? {} : { colorTemperature: kelvin }),
    },
  };
  const draft = {
    id: 'scene.custom_test',
    name: 'Kväll',
    lighting,
    ...(goveeIntent
      ? { govee: { [target]: structuredClone(goveeIntent) } }
      : {}),
  };
  const overview = {
    scenes: [],
    goveeCapabilities: govee
      ? {
          [target]: {
            effects,
            zones: true,
            colorTemperature: { min: 2000, max: 6500 },
          },
        }
      : {},
  };
  const changed = vi.fn();
  const setStatus = vi.fn();
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
    presetForm: new Element(),
    closePresetButton: new Element(),
    presetConfirmYes: new Element(),
    presetConfirmNo: new Element(),
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
    appendReading: (
      readings: unknown[],
      label: string,
      value: string,
      tone = '',
    ) => readings.push({ label, value, ...(tone ? { tone } : {}) }),
    displayTarget: (value: string) => value,
    updatePresetDirtyState: changed,
    setPresetStatus: setStatus,
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
      ) +
      source.slice(
        source.indexOf('function appendGoveeReadings('),
        source.indexOf('function renderLight('),
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
  return {
    run,
    row,
    field,
    fetch,
    changed,
    invoke,
    setStatus,
    overview,
    draft,
  };
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

it('creates and saves an ordered animation loop with its interval and ceiling mask', async () => {
  const s = setup();
  const mode = s.field('Ljustyp');
  expect(mode.children.map((option) => option.value)).toContain('rotation');
  mode.value = 'rotation';
  await mode.fire('change');
  const rotations = s.field('Animationer i loopen (2–16)');
  for (const option of rotations.options)
    option.selected = ['Aurora', 'Forest B'].includes(option.value);
  await rotations.fire('change');
  s.field('Byt animation efter (sekunder)').value = '25';
  await s.field('Byt animation efter (sekunder)').fire('input');
  s.field('Taklampans delar').value = 'ring';
  await s.field('Taklampans delar').fire('change');
  expect(s.run('presetDraft')).toMatchObject({
    lighting: { [target]: { power: true, brightness: 30 } },
    govee: {
      [target]: {
        rotation: { effects: ['Aurora', 'Forest B'], intervalSeconds: 25 },
        zones: { main: false, ring: true },
      },
    },
  });
  expect(
    s.run(`presetDraft.lighting['${target}'].colorTemperature`),
  ).toBeUndefined();
  await s.run('savePreset(false)');
  const saved = JSON.parse(String(s.fetch.mock.calls[0]![1].body));
  expect(saved.govee[target]).toEqual({
    rotation: { effects: ['Aurora', 'Forest B'], intervalSeconds: 25 },
    zones: { main: false, ring: true },
  });
  expect(s.run('sceneSnapshot(presetDraft).govee')).toEqual(saved.govee);
});

it('round-trips a saved loop order and interval when catalog capabilities are absent', async () => {
  const rotation = {
    effects: ['Forest B', 'Aurora'],
    intervalSeconds: 45,
  };
  const s = setup(false, 3000, {
    rotation,
    zones: { main: false, ring: true },
  });
  expect(s.field('Ljustyp').value).toBe('rotation');
  expect(
    s
      .field('Animationer i loopen (2–16)')
      .options.map((option) => option.value),
  ).toEqual(['Forest B', 'Aurora']);
  expect(
    s
      .field('Animationer i loopen (2–16)')
      .selectedOptions.map((option) => option.value),
  ).toEqual(rotation.effects);
  expect(s.field('Byt animation efter (sekunder)').value).toBe('45');
  expect(s.field('Animationer i loopen (2–16)').disabled).toBe(true);
  expect(
    s.field('Animationer i loopen (2–16)').getAttribute('aria-invalid'),
  ).toBe('false');
  expect(s.setStatus).not.toHaveBeenCalled();
  // The status stays in the editor even though the current catalog is absent.
  expect(s.row.children[2]!.children[7]!.textContent).toContain(
    'Katalogen saknas',
  );
  await s.run('savePreset(false)');
  const saved = JSON.parse(String(s.fetch.mock.calls[0]![1].body));
  expect(saved.govee[target]).toEqual({
    rotation,
    zones: { main: false, ring: true },
  });
});

it('preserves the loop across exclusion and OFF, then restores it on re-entry', async () => {
  const s = setup(true, 3000, {
    rotation: { effects: ['Forest B', 'Aurora'], intervalSeconds: 30 },
    zones: { main: false, ring: true },
  });
  const include = s.row.children[0]!.children[0]!;
  include.checked = false;
  await include.fire('change');
  expect(s.run('presetDraft.govee')).toBeUndefined();
  include.checked = true;
  await include.fire('change');
  expect(s.run(`presetDraft.govee['${target}']`)).toEqual({
    rotation: { effects: ['Forest B', 'Aurora'], intervalSeconds: 30 },
    zones: { main: false, ring: true },
  });
  const slider = s.row.children[1]!.children[0]!;
  slider.value = '0';
  await slider.fire('input');
  expect(s.run(`presetDraft.lighting['${target}'].power`)).toBe(false);
  expect(s.run('presetDraft.govee')).toBeUndefined();
  slider.value = '30';
  await slider.fire('input');
  expect(s.run(`presetDraft.govee['${target}']`)).toEqual({
    rotation: { effects: ['Forest B', 'Aurora'], intervalSeconds: 30 },
    zones: { main: false, ring: true },
  });
});

it.each([
  [{ effects: ['Aurora'], intervalSeconds: 30 }, 'Välj 2–16 olika animationer'],
  [
    { effects: ['Aurora', 'Forest B'], intervalSeconds: 14 },
    'intervall mellan 15 och 3600',
  ],
  [
    { effects: ['Aurora', 'Forest B'], intervalSeconds: 30.5 },
    'intervall mellan 15 och 3600',
  ],
  [
    { effects: ['Aurora', 'Missing'], intervalSeconds: 30 },
    'saknas i aktuell Govee-katalog',
  ],
])('blocks saving an invalid loop %j', async (rotation, expectedMessage) => {
  const s = setup(true, 3000, { rotation });
  await s.run('savePreset(false)');
  expect(s.fetch).not.toHaveBeenCalled();
  expect(s.setStatus.mock.calls[0]?.[0]).toContain(expectedMessage);
  expect(s.run('presetRotationValidationMessage()')).toContain(expectedMessage);
});

it('accepts the 16-effect and 15/3600-second boundaries and rejects 17 effects', async () => {
  const labels = Array.from(
    { length: 17 },
    (_, index) => `Effect ${index + 1}`,
  );
  const s = setup(true, 3000, undefined, labels);
  s.field('Ljustyp').value = 'rotation';
  await s.field('Ljustyp').fire('change');
  const effects = s.field('Animationer i loopen (2–16)');
  for (const option of effects.options) option.selected = true;
  await effects.fire('change');
  await s.run('savePreset(false)');
  expect(s.fetch).not.toHaveBeenCalled();
  expect(s.setStatus.mock.calls.at(-1)?.[0]).toContain('2–16');

  const boundary = setup(true, 3000, undefined, labels.slice(0, 16));
  boundary.field('Ljustyp').value = 'rotation';
  await boundary.field('Ljustyp').fire('change');
  const boundaryEffects = boundary.field('Animationer i loopen (2–16)');
  for (const option of boundaryEffects.options) option.selected = true;
  await boundaryEffects.fire('change');
  const interval = boundary.field('Byt animation efter (sekunder)');
  interval.value = '15';
  await interval.fire('input');
  expect(boundary.run('presetRotationValidationMessage()')).toBe('');
  interval.value = '3600';
  await interval.fire('input');
  expect(boundary.run('presetRotationValidationMessage()')).toBe('');
});

it('clears a saved loop from the draft when changing to static white', async () => {
  const s = setup(true, 3000, {
    rotation: { effects: ['Forest B', 'Aurora'], intervalSeconds: 30 },
  });
  s.field('Ljustyp').value = 'white';
  await s.field('Ljustyp').fire('change');
  expect(s.run('presetDraft.govee')).toBeUndefined();
  expect(s.run(`presetDraft.lighting['${target}'].colorTemperature`)).toBe(
    2000,
  );
});

it('labels the latest animation as sent rather than physically confirmed', () => {
  const s = setup();
  const readings = JSON.parse(
    JSON.stringify(
      s.run(`(() => {
        const readings = [];
        appendGoveeReadings(readings, {
          intent: { rotation: { effects: ['Aurora', 'Forest B'], intervalSeconds: 30 } },
          activeEffect: 'Forest B',
          status: 'sent',
        });
        return readings;
      })()`),
    ),
  );
  expect(readings).toEqual([
    {
      label: 'Animationsloop · 30 s',
      value: 'Aurora → Forest B',
    },
    {
      label: 'Senast skickad Govee-animation',
      value: 'Forest B',
      tone: 'warn',
    },
  ]);
});
