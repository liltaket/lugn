import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import {
  previewRoutine as previewRoutineDefinition,
  RoutineDefinitionSchema,
} from '../src/core/routines.js';
import { IntelligenceSettingsSchema } from '../src/core/intelligence.js';

/** Run real production handlers with a focused DOM seam and in-memory API responses. */
class Element {
  ownText = '';
  tagName: string;
  value: string | number = '';
  checked = false;
  disabled = false;
  hidden = false;
  type = '';
  required = false;
  min: string | number = '';
  max: string | number = '';
  step = '';
  dataset: Record<string, string> = {};
  children: Element[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, ((event: unknown) => unknown)[]>();
  focused = false;
  classes = new Set<string>();
  classList = {
    toggle: (name: string, active: boolean) =>
      active ? this.classes.add(name) : this.classes.delete(name),
  };
  constructor(tagName = 'div') {
    this.tagName = tagName;
  }
  get valueAsNumber() {
    return this.value === '' ? NaN : Number(this.value);
  }
  // Native number constraints apply before a browser dispatches form submit.
  get validity() {
    const value = this.valueAsNumber;
    const base = this.min === '' ? 0 : Number(this.min);
    const step = this.step === '' ? 1 : Number(this.step);
    const number = this.type === 'number' && this.value !== '';
    const steps = (value - base) / step;
    const valueMissing = this.required && this.value === '';
    const badInput = number && !Number.isFinite(value);
    const rangeUnderflow = number && this.min !== '' && value < base;
    const rangeOverflow = number && this.max !== '' && value > Number(this.max);
    const stepMismatch =
      number &&
      this.step !== 'any' &&
      Math.abs(steps - Math.round(steps)) > 1e-7;
    return {
      valueMissing,
      badInput,
      rangeUnderflow,
      rangeOverflow,
      stepMismatch,
      valid:
        !valueMissing &&
        !badInput &&
        !rangeUnderflow &&
        !rangeOverflow &&
        !stepMismatch,
    };
  }
  checkValidity(): boolean {
    return (
      this.disabled ||
      (this.validity.valid &&
        this.children.every((child) => child.checkValidity()))
    );
  }
  get firstElementChild() {
    return this.children[0];
  }
  get lastElementChild() {
    return this.children.at(-1);
  }
  get textContent(): string {
    return (
      this.ownText + this.children.map((child) => child.textContent).join(' ')
    );
  }
  set textContent(value: string) {
    this.ownText = value;
    this.children = [];
  }
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
    this.ownText = '';
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  addEventListener(type: string, listener: (event: unknown) => unknown) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  focus() {
    this.focused = true;
  }
  querySelector(selector: string): Element | undefined {
    return this.descendants().find((child) =>
      selector.split(/,\s*/).includes(child.tagName),
    );
  }
  descendants(): Element[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
  async fire(type: string) {
    for (const listener of this.listeners.get(type) ?? [])
      await listener({ target: this, preventDefault() {} });
  }
}
const initialSnapshot = () => ({
  state: {
    revision: 1,
    lighting: { devices: { 'lighting.bed': {}, 'lighting.desk': {} } },
    music: { devices: { 'music.room': { allowedSources: ['Optical'] } } },
    computer: { devices: { desktop: {} } },
  },
  scenes: [
    { id: 'scene.cozy', name: 'Mysljus' },
    { id: 'scene.work', name: 'Arbetsljus' },
  ],
  routines: {
    version: 1,
    generation: 'r1',
    definitions: [
      {
        id: 'night',
        name: 'God natt',
        kind: 'good_night',
        enabled: false,
        schedule: null,
        steps: [{ type: 'scene', sceneId: 'scene.cozy' }],
      },
    ],
    runs: [],
    next: [],
  },
  intelligence: {
    generation: 'i1',
    settings: {
      version: 1,
      optical: {
        enabled: false,
        mode: 'suggest',
        deviceId: 'desktop',
        target: 'music.room',
        source: 'Optical',
        stabilityMs: 30000,
        cooldownMs: 300000,
        allowedActivities: ['gaming'],
        respectManual: true,
      },
      suggestions: {
        enabled: false,
        cooldownMs: 600000,
        sceneMappings: { gaming: 'scene.work' },
      },
    },
    suggestions: [],
    optical: [],
  },
});
function ui() {
  const html = readFileSync(
    new URL('../web/index.html', import.meta.url),
    'utf8',
  );
  const ids = new Set(
    [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]),
  );
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!ids.has(id)) throw new Error(`Missing element ${id}`);
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const nav = [
    'oversikt',
    'belysning',
    'musik',
    'rutiner',
    'intelligens',
    'system',
  ].map((page) => {
    const item = new Element('a');
    item.dataset['page'] = page;
    return item;
  });
  const sections = [...html.matchAll(/data-pages="([^"]+)"/g)].map((match) => {
    const item = new Element('section');
    item.dataset['pages'] = match[1]!;
    return item;
  });
  const events = new Map<string, (event?: unknown) => unknown>();
  const location = { hash: '', origin: 'http://127.0.0.1' };
  let snapshot = initialSnapshot();
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async (url, init) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      if (url.endsWith('/routines/preview'))
        return new Response(
          JSON.stringify(previewRoutineDefinition(body.definition)),
        );
      if (url.endsWith('/routines/save')) {
        RoutineDefinitionSchema.parse(body.definition);
        snapshot.routines.generation = 'r2';
        snapshot.routines.definitions = [body.definition];
        return new Response(JSON.stringify(snapshot.routines));
      }
      if (url.endsWith('/intelligence/settings')) {
        IntelligenceSettingsSchema.parse(body.settings);
        snapshot.intelligence.generation = 'i2';
        snapshot.intelligence.settings = body.settings;
        return new Response(JSON.stringify(snapshot.intelligence));
      }
      if (url.endsWith('/routines/delete')) {
        snapshot.routines.definitions = snapshot.routines.definitions.filter(
          (item) => item.id !== body.id,
        );
        snapshot.routines.generation = 'r2';
      }
      if (url.includes('/routines/'))
        return new Response(JSON.stringify(snapshot.routines));
      if (url.includes('/intelligence/'))
        return new Response(JSON.stringify(snapshot.intelligence));
      return new Response('{}');
    },
  );
  const context = createContext({
    document: {
      getElementById: get,
      createElement: (tag: string) => new Element(tag),
      querySelectorAll: (selector: string) =>
        selector === '.section-nav a'
          ? nav
          : selector === '[data-pages]'
            ? sections
            : selector === '[data-l2-pending]'
              ? [
                  ...new Set(
                    [...elements.values()]
                      .flatMap((item) => item.descendants())
                      .filter((item) => item.dataset['l2Pending']),
                  ),
                ]
              : [],
    },
    window: {
      addEventListener: (
        type: string,
        listener: (event?: unknown) => unknown,
      ) => events.set(type, listener),
      confirm: vi.fn(() => true),
      setTimeout,
      clearTimeout,
    },
    location,
    crypto: { randomUUID: () => 'fixture-id' },
    structuredClone,
    fetch,
    AbortController,
    TypeError,
    URL,
    dashboardView: get('dashboard-view'),
    fetchOverview: async () => {
      context['overview'] = structuredClone(snapshot);
    },
    overview: structuredClone(snapshot),
    overviewStale: false,
    API_ROOT: '/ui/api',
    csrfToken: 'fixture-csrf',
  });
  const source = readFileSync(
    new URL('../web/app.js', import.meta.url),
    'utf8',
  );
  const functions = [
    ...source.matchAll(/^(?:async )?function \w+\([\s\S]*?^\}/gm),
  ]
    .map(([fn]) => fn)
    .join('\n');
  runInContext(
    `// Bolt optimization: Cache Intl instantiation instead of recreating inside render function
    const routineDateFormat = new Intl.DateTimeFormat('sv-SE', {
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Stockholm',
    });
    let routineDraft=null, routineOriginal=null, routineGeneration=null, routinePreviewRevision=0;
    let intelligenceDraft=null, intelligenceOriginal=null, intelligenceGeneration=null, mappingDraft=[];
    const l2Pending=new Set(); ${functions}
    render = renderLugn2; fetchOverview = async () => testRefresh(); initializeLugn2(); renderLugn2();`,
    Object.assign(context, {
      testRefresh: async () => {
        context['overview'] = structuredClone(snapshot);
      },
    }),
  );
  get('routine-add-type').value = 'scene';
  return {
    get,
    nav,
    sections,
    events,
    location,
    fetch,
    context,
    run: (code: string) => runInContext(code, context),
    server: () => snapshot,
    setServer: (next: ReturnType<typeof initialSnapshot>) => {
      snapshot = next;
    },
  };
}
function button(root: Element, label: string) {
  const found = root
    .descendants()
    .find((item) => item.tagName === 'button' && item.textContent === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
function input(root: Element, label: string) {
  const field = root
    .descendants()
    .find((item) => item.tagName === 'label' && item.ownText === label);
  const control = field?.children[0];
  if (!control) throw new Error(`Missing field ${label}`);
  return control;
}

it('models native number constraints before dispatching a form submit', () => {
  const control = new Element('input');
  control.type = 'number';
  control.required = true;
  control.value = '1.5';
  expect(control.validity.stepMismatch).toBe(true);
  control.min = '0.5';
  expect(control.checkValidity()).toBe(true);
  control.max = '1';
  expect(control.validity.rangeOverflow).toBe(true);
  control.max = '';
  control.min = '0';
  control.step = 'any';
  expect(control.checkValidity()).toBe(true);
  control.value = '-0.1';
  expect(control.validity.rangeUnderflow).toBe(true);
  control.value = '';
  expect(control.validity.valueMissing).toBe(true);
});

it.each([
  [1 / 3, 1500],
  [0.123456789, 1001],
  [0.000001, 119999],
  [0, 0],
  [1, 120000],
])(
  'round-trips schema-valid volume %s and duration %s through a name-only edit',
  async (volume, durationMs) => {
    const s = ui();
    const definition = RoutineDefinitionSchema.parse({
      ...initialSnapshot().routines.definitions[0],
      steps: [
        { type: 'volume', target: 'music.room', volume, durationMs },
        {
          type: 'light',
          targets: ['lighting.bed'],
          brightness: 37,
          durationMs: 1,
        },
        { type: 'delay', durationMs: 3599999 },
      ],
    });
    s.run(`openRoutine(${JSON.stringify(definition)})`);
    s.get('routine-name').value = 'Bara nytt namn';
    await s.get('routine-name').fire('input');
    const controls = s.get('routine-steps');
    for (const control of controls
      .descendants()
      .filter((item) => item.type === 'number'))
      expect(control.validity).toMatchObject({
        valid: true,
        stepMismatch: false,
      });
    // A browser only delivers submit after native constraint validation succeeds.
    if (controls.checkValidity()) await s.get('routine-form').fire('submit');
    expect(s.fetch).toHaveBeenCalledTimes(1);
    const [path, init] = s.fetch.mock.calls[0]!;
    expect(path).toBe('/ui/api/routines/save');
    const saved = JSON.parse(init?.body as string).definition;
    expect(RoutineDefinitionSchema.parse(saved)).toEqual({
      ...definition,
      name: 'Bara nytt namn',
    });
    expect(s.run('routineDirty()')).toBe(false);
  },
);

it('accepts fractional routine input while retaining integer brightness and bounded millisecond durations', async () => {
  const s = ui();
  await s.get('routine-night').fire('click');
  s.get('routine-add-type').value = 'volume';
  await s.get('routine-add').fire('click');
  s.get('routine-add-type').value = 'delay';
  await s.get('routine-add').fire('click');
  const rows = s.get('routine-steps').children;
  const brightness = input(rows[1]!, 'Ljusstyrka (%)');
  brightness.value = '37.5';
  expect(brightness.validity.stepMismatch).toBe(true);
  brightness.value = '37';
  await brightness.fire('input');
  const percent = input(rows[2]!, 'Volym (%)');
  percent.value = '33.33333333333333';
  await percent.fire('input');
  const seconds = input(rows[2]!, 'Förändringstid (sekunder)');
  seconds.value = '1.5006';
  await seconds.fire('input');
  const light = input(rows[1]!, 'Förändringstid (minuter)');
  light.value = String(1001 / 60000);
  await light.fire('input');
  const delay = input(rows[3]!, 'Vänta (minuter)');
  delay.value = String(1 / 60000);
  await delay.fire('input');
  expect(s.get('routine-steps').checkValidity()).toBe(true);
  const definition = RoutineDefinitionSchema.parse(s.run('validateRoutine()'));
  expect(definition.steps).toMatchObject([
    { type: 'scene' },
    { type: 'light', brightness: 37, durationMs: 1001 },
    { type: 'volume', volume: Number(percent.value) / 100, durationMs: 1501 },
    { type: 'delay', durationMs: 1 },
  ]);
  for (const [control, value] of [
    [seconds, '-1'],
    [seconds, '0.5'],
    [seconds, '120.001'],
    [light, '60.001'],
    [delay, '60.001'],
  ] as const) {
    const previous = control.value;
    control.value = value;
    await control.fire('input');
    expect(
      RoutineDefinitionSchema.safeParse(s.run('routineDraft')).success,
    ).toBe(false);
    expect(() => s.run('validateRoutine()')).toThrow();
    control.value = previous;
    await control.fire('input');
  }
});

it('navigates all six sections and preserves a routine draft across navigation and live refresh', async () => {
  const s = ui();
  await s.get('routine-new').fire('click');
  s.get('routine-name').value = 'Mitt mys';
  await s.get('routine-name').fire('input');
  s.location.hash = '#musik';
  s.events.get('hashchange')!();
  expect(s.get('page-title').textContent).toBe('Musik');
  expect(s.nav[2]?.attributes.get('aria-current')).toBe('page');
  expect(
    s.sections
      .filter((item) => !item.classes.has('page-inactive'))
      .every((item) => item.dataset['pages']!.includes('musik')),
  ).toBe(true);
  s.run(
    "overview.routines.generation='remote'; overview.routines.definitions[0].name='Ändrad'; renderLugn2()",
  );
  s.location.hash = '#rutiner';
  s.events.get('hashchange')!();
  expect(s.get('routine-name').value).toBe('Mitt mys');
  expect(s.run('routineGeneration')).toBe('r1');
  expect(s.fetch).not.toHaveBeenCalled();
  for (const page of ['oversikt', 'belysning', 'intelligens', 'system']) {
    s.location.hash = `#${page}`;
    s.events.get('hashchange')!();
    expect(
      s.nav
        .find((item) => item.dataset['page'] === page)
        ?.attributes.get('aria-current'),
    ).toBe('page');
  }
});
it('authors Mysljus → dim over ten minutes → off, previews purely and saves the exact contract disabled', async () => {
  const s = ui();
  await s.get('routine-night').fire('click');
  s.get('routine-name').value = 'Mys till natt';
  await s.get('routine-name').fire('input');
  const dim = s.get('routine-steps').children[1]!;
  input(dim, 'Ljusstyrka (%)').value = '10';
  await input(dim, 'Ljusstyrka (%)').fire('input');
  s.get('routine-add-type').value = 'light';
  await s.get('routine-add').fire('click');
  const off = s.get('routine-steps').children[2]!;
  input(off, 'Förändringstid (minuter)').value = '0';
  await input(off, 'Förändringstid (minuter)').fire('input');
  await s.get('routine-preview').fire('click');
  expect(s.fetch.mock.calls[0]?.[0]).toBe('/ui/api/routines/preview');
  expect(s.get('routine-timeline').textContent).toContain('Släck');
  expect(s.get('routine-preview-summary').textContent).toContain('10 min');
  await s.get('routine-form').fire('submit');
  const [path, init] = s.fetch.mock.calls[1]!;
  expect(path).toBe('/ui/api/routines/save');
  expect(init?.headers).toMatchObject({ 'X-Lugn-CSRF': 'fixture-csrf' });
  expect(JSON.parse(init?.body as string)).toEqual({
    expectedGeneration: 'r1',
    definition: {
      id: 'routine-fixture-id',
      name: 'Mys till natt',
      kind: 'good_night',
      enabled: false,
      schedule: null,
      steps: [
        { type: 'scene', sceneId: 'scene.cozy' },
        {
          type: 'light',
          targets: ['lighting.bed', 'lighting.desk'],
          brightness: 10,
          durationMs: 600000,
        },
        {
          type: 'light',
          targets: ['lighting.bed', 'lighting.desk'],
          brightness: 0,
          durationMs: 0,
        },
      ],
    },
  });
  expect(s.run('routineDirty()')).toBe(false);
  expect(s.get('routine-status').textContent).toContain('Sparad och avstängd');
});
it('edits ISO weekdays and all ordered step types using inputs, supports reorder and remove', async () => {
  const s = ui();
  await s.get('routine-new').fire('click');
  s.get('routine-name').value = 'Allt';
  await s.get('routine-name').fire('input');
  s.get('routine-scheduled').checked = true;
  await s.get('routine-scheduled').fire('change');
  const monday = s.get('routine-weekdays').children[1]!.children[0]!;
  monday.checked = false;
  await monday.fire('change');
  expect(s.run('routineDraft.schedule.weekdays')).toEqual([2, 3, 4, 5, 6, 7]);
  s.get('routine-time').value = '07:10';
  await s.get('routine-time').fire('input');
  for (const type of [
    'volume',
    'delay',
    'playback',
    'source',
    'preset',
    'condition',
  ]) {
    s.get('routine-add-type').value = type;
    await s.get('routine-add').fire('click');
  }
  const volume = s.get('routine-steps').children[0]!;
  input(volume, 'Volym (%)').value = '45';
  await input(volume, 'Volym (%)').fire('input');
  expect(s.run('routineDraft.steps[0].volume')).toBe(0.45);
  await button(s.get('routine-steps').children[1]!, 'Flytta upp').fire('click');
  expect(s.run('routineDraft.steps[0].type')).toBe('delay');
  expect(
    s.get('routine-steps').children[0]?.querySelector('input')?.focused,
  ).toBe(true);
  await button(s.get('routine-steps').children[0]!, 'Ta bort steg').fire(
    'click',
  );
  const draft = s.run('validateRoutine()');
  expect(draft.steps.map((step: { type: string }) => step.type)).toEqual([
    'volume',
    'playback',
    'source',
    'preset',
    'condition',
  ]);
  expect(draft.steps.at(-1)).toEqual({
    type: 'condition',
    condition: 'occupied',
  });
  expect(draft.schedule).toEqual({
    time: '07:10',
    weekdays: [2, 3, 4, 5, 6, 7],
  });
});
it('retains original concurrency token and entered values after conflict, session failure, and unavailable route', async () => {
  const s = ui();
  await s.get('routine-night').fire('click');
  for (const status of [409, 401, 404]) {
    s.fetch.mockResolvedValueOnce(new Response('{}', { status }));
    await s.get('routine-form').fire('submit');
    expect(s.get('routine-status').textContent).toContain('utkast');
    expect(s.get('routine-name').value).toBe('God natt');
    expect(s.run('routineGeneration')).toBe('r1');
    expect(s.run('routineDirty()')).toBe(true);
    expect(s.get('routine-fields').disabled).toBe(false);
  }
});
it('ignores a late timeline for an edited draft and prevents duplicate saves while pending', async () => {
  const s = ui();
  await s.get('routine-night').fire('click');
  let resolve!: (response: Response) => void;
  s.fetch.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const preview = s.get('routine-preview').fire('click');
  s.get('routine-name').value = 'Nytt';
  await s.get('routine-name').fire('input');
  resolve(
    new Response(JSON.stringify({ timeline: [], durationMs: 0, warnings: [] })),
  );
  await preview;
  expect(s.get('routine-timeline').children).toHaveLength(0);
  expect(s.get('routine-status').textContent).toContain('ändrades');
  s.fetch.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const save = s.get('routine-form').fire('submit');
  expect(s.get('routine-fields').disabled).toBe(true);
  await s.get('routine-form').fire('submit');
  expect(s.fetch).toHaveBeenCalledTimes(2);
  resolve(new Response('{}', { status: 409 }));
  await save;
  expect(s.get('routine-fields').disabled).toBe(false);
});
it('handles staged rollout, stale snapshots and new server settings without erasing dirty forms', async () => {
  const s = ui();
  s.get('intelligence-stability').value = '75';
  await s.get('intelligence-form').fire('input');
  s.run(
    "overview.intelligence.generation='remote'; overview.intelligence.settings.optical.stabilityMs=9000; renderLugn2()",
  );
  expect(s.get('intelligence-stability').value).toBe('75');
  expect(s.run('intelligenceGeneration')).toBe('i1');
  s.run('overviewStale=true; renderLugn2()');
  expect(s.get('snapshot-notice').hidden).toBe(false);
  expect(s.get('intelligence-save').disabled).toBe(true);
  s.run(
    'delete overview.routines; delete overview.intelligence; renderLugn2()',
  );
  expect(s.get('routine-new').disabled).toBe(true);
  expect(s.get('intelligence-form').hidden).toBe(true);
  expect(s.get('routines-availability').textContent).toContain(
    'inte tillgängliga',
  );
  expect(s.run('intelligenceDraft.optical.stabilityMs')).toBe(75000);
});
it('saves exact intelligence settings with optimistic generation and explicit disabled defaults', async () => {
  const s = ui();
  s.get('intelligence-stability').value = '45';
  s.get('intelligence-activities').value = 'gaming, video, gaming';
  await s.get('intelligence-form').fire('input');
  await s.get('intelligence-form').fire('submit');
  const [path, init] = s.fetch.mock.calls[0]!;
  expect(path).toBe('/ui/api/intelligence/settings');
  const sent = JSON.parse(init?.body as string);
  expect(sent).toEqual({
    expectedGeneration: 'i1',
    settings: {
      ...initialSnapshot().intelligence.settings,
      optical: {
        ...initialSnapshot().intelligence.settings.optical,
        stabilityMs: 45000,
        allowedActivities: ['gaming', 'video'],
      },
    },
  });
  expect(s.run('intelligenceDirty()')).toBe(false);
  expect(s.get('intelligence-status').textContent).toContain('sparade');
});
it('validates explicit optical context and unique scene mappings, retains intelligence draft on failed save', async () => {
  const s = ui();
  s.get('intelligence-optical-enabled').checked = true;
  s.get('intelligence-device').value = '';
  await s.get('intelligence-form').fire('input');
  await s.get('intelligence-form').fire('submit');
  expect(s.fetch).not.toHaveBeenCalled();
  expect(s.get('intelligence-status').textContent).toContain('Välj dator');
  s.get('intelligence-device').value = 'desktop';
  await s.get('intelligence-form').fire('input');
  await s.get('intelligence-add-mapping').fire('click');
  const mapping = s.get('intelligence-mappings').children[1]!;
  input(mapping, 'Rapporterad aktivitet').value = 'gaming';
  await input(mapping, 'Rapporterad aktivitet').fire('input');
  await s.get('intelligence-form').fire('submit');
  expect(s.fetch).not.toHaveBeenCalled();
  expect(s.get('intelligence-status').textContent).toContain('unik');
  await button(mapping, 'Ta bort koppling').fire('click');
  s.fetch.mockResolvedValueOnce(new Response('{}', { status: 409 }));
  await s.get('intelligence-form').fire('submit');
  expect(s.get('intelligence-status').textContent).toContain('Ändrat');
  expect(s.run('intelligenceDraft.optical.enabled')).toBe(true);
  expect(s.run('intelligenceGeneration')).toBe('i1');
});
it('uses real action routes and authoritative runs; disabled definitions cannot be started in the UI', async () => {
  const s = ui();
  expect(button(s.get('routine-list'), 'Starta').disabled).toBe(true);
  s.run(`overview.routines.definitions[0].enabled=true;
    overview.routines.next=[{routineId:'night',at:1792612800000}];
    overview.routines.runs=[{id:'run1',routineId:'night',status:'running',stepIndex:0,reason:null}]; renderLugn2()`);
  s.setServer(s.run('structuredClone(overview)'));
  for (const label of ['Starta', 'Snooza 10 min', 'Hoppa över nästa'])
    await button(s.get('routine-list'), label).fire('click');
  // Refresh mock returns its stored snapshot. Restore the active run to exercise cancel.
  s.run(
    "overview.routines.runs=[{id:'run1',routineId:'night',status:'running',stepIndex:0,reason:null}]; renderLugn2()",
  );
  await button(s.get('routine-runs'), 'Avbryt körning').fire('click');
  const calls = s.fetch.mock.calls.map(([url, init]) => ({
    url,
    body: JSON.parse(init?.body as string),
  }));
  expect(calls.map((call) => call.body.action)).toEqual([
    'start',
    'snooze',
    'skip',
    'cancel',
  ]);
  expect(calls.every((call) => call.url === '/ui/api/routines/action')).toBe(
    true,
  );
  expect(calls[1]?.body).toMatchObject({
    id: 'night',
    minutes: 10,
    requestId: 'fixture-id',
  });
  expect(calls[3]?.body.id).toBe('night');
});
it('posts suggestion accept, reject and dismiss with no frontend decision policy', async () => {
  const s = ui();
  for (const [label, action] of [
    ['Acceptera', 'accept'],
    ['Avvisa', 'reject'],
    ['Stäng förslaget', 'dismiss'],
  ]) {
    s.run(
      "overview.intelligence.suggestions=[{id:'s1',title:'Optical?',reason:'Serverns underlag',deviceId:'computer.desk'}];renderLugn2()",
    );
    await button(s.get('intelligence-suggestions'), label!).fire('click');
    const [url, init] = s.fetch.mock.calls.at(-1)!;
    expect(url).toBe('/ui/api/intelligence/suggestion');
    expect(JSON.parse(init?.body as string)).toEqual({ id: 's1', action });
  }
});
it('guards unload for unsaved drafts and asks before throwing them away', async () => {
  const s = ui();
  await s.get('routine-night').fire('click');
  const preventDefault = vi.fn();
  s.events.get('beforeunload')!({ preventDefault });
  expect(preventDefault).toHaveBeenCalled();
  await s.get('routine-discard').fire('click');
  expect(s.run('routineDraft')).toBeNull();
  expect(s.get('routine-form').hidden).toBe(true);
});
it('keeps artwork same-origin with fixed fallback after missing, external or failed images', async () => {
  const s = ui();
  s.run(
    "overview.artwork={'music.room':{status:'available',url:'https://example.invalid/art'}}",
  );
  expect(
    (s.run("renderMusicArtwork('music.room')") as Element).children,
  ).toHaveLength(1);
  s.run("overview.artwork['music.room'].url='/ui/artwork/room'");
  const frame = s.run("renderMusicArtwork('music.room')") as Element;
  const image = frame.children[1]!;
  await image.fire('load');
  expect(frame.children[0]!.hidden).toBe(true);
  await image.fire('error');
  expect(image.hidden).toBe(true);
  expect(frame.children[0]!.hidden).toBe(false);
});

it('deletes the saved routine with its captured generation and updates from the direct snapshot', async () => {
  const s = ui();
  await button(s.get('routine-list'), 'Redigera').fire('click');
  await s.get('routine-delete').fire('click');
  const [url, init] = s.fetch.mock.calls[0]!;
  expect(url).toBe('/ui/api/routines/delete');
  expect(JSON.parse(init?.body as string)).toEqual({
    id: 'night',
    expectedGeneration: 'r1',
  });
  expect(s.get('routine-form').hidden).toBe(true);
  expect(s.get('routine-list').textContent).toContain('Skapa en egen');
  expect(s.get('routines-availability').textContent).toContain('raderad');
});
it('keeps invalid duplicate mapping rows across live generations and explicitly fetches before discarding', async () => {
  const s = ui();
  await s.get('intelligence-add-mapping').fire('click');
  const row = s.get('intelligence-mappings').children[1]!;
  const activity = input(row, 'Rapporterad aktivitet');
  activity.value = 'gaming';
  await activity.fire('input');
  const scene = input(row, 'Ljusscen');
  scene.value = 'scene.work';
  await scene.fire('change');
  // The resulting map equals the original, but the duplicate row is still an unsaved draft.
  expect(s.run('intelligenceDirty()')).toBe(true);
  s.run("overview.intelligence.generation='other'; renderLugn2()");
  expect(s.get('intelligence-mappings').children).toHaveLength(2);
  s.server().intelligence.settings.optical.stabilityMs = 70000;
  await s.get('intelligence-discard').fire('click');
  expect(s.get('intelligence-mappings').children).toHaveLength(1);
  expect(s.get('intelligence-stability').value).toBe(70);
  expect(s.fetch).not.toHaveBeenCalled();
});
it('shows an unknown outcome for network failure and retains the draft without repeating a request', async () => {
  const s = ui();
  await s.get('routine-night').fire('click');
  s.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  await s.get('routine-form').fire('submit');
  expect(s.get('routine-status').textContent).toContain('Utfallet är okänt');
  expect(s.run('routineDirty()')).toBe(true);
  expect(s.fetch).toHaveBeenCalledTimes(1);
});

it('enforces backend duration and step limits and explains blocked volume ownership', async () => {
  const s = ui();
  await s.get('routine-night').fire('click');
  s.get('routine-add-type').value = 'volume';
  await s.get('routine-add').fire('click');
  const volume = s.get('routine-steps').children[2]!;
  expect(volume.textContent).toContain('Manuellt ägd volym kan blockera');
  const seconds = input(volume, 'Förändringstid (sekunder)');
  expect(Reflect.get(seconds, 'max')).toBe(120);
  seconds.value = '0.5';
  await seconds.fire('input');
  await s.get('routine-preview').fire('click');
  expect(s.get('routine-status').textContent).toContain('1–120 sekunder');
  expect(s.fetch).not.toHaveBeenCalled();
  seconds.value = '121';
  await seconds.fire('input');
  await s.get('routine-form').fire('submit');
  expect(s.get('routine-status').textContent).toContain('1–120 sekunder');
  seconds.value = '0';
  await seconds.fire('input');
  expect(s.run('validateRoutine().steps[2].durationMs')).toBe(0);
  const light = input(
    s.get('routine-steps').children[1]!,
    'Förändringstid (minuter)',
  );
  expect(Reflect.get(light, 'max')).toBe(60);
  light.value = '61';
  await light.fire('input');
  await s.get('routine-preview').fire('click');
  expect(s.get('routine-status').textContent).toContain('högst 60 minuter');
  s.run(
    "routineDraft.steps = Array.from({length:7},()=>({type:'delay',durationMs:3600000})); renderRoutineSteps(); routineChanged()",
  );
  await s.get('routine-form').fire('submit');
  expect(s.get('routine-status').textContent).toContain('högst 6 timmar');
  s.run(
    "routineDraft.steps = Array.from({length:32},()=>({type:'delay',durationMs:0})); renderRoutineSteps(); routineChanged()",
  );
  expect(s.get('routine-add').disabled).toBe(true);
  await s.get('routine-add').fire('click');
  expect(s.run('routineDraft.steps.length')).toBe(32);
  expect(s.run('validateRoutine().steps.length')).toBe(32);
  s.run("routineDraft.steps.push({type:'delay',durationMs:0})");
  await s.get('routine-form').fire('submit');
  expect(s.get('routine-status').textContent).toContain('högst 32 steg');
});

it('round-trips millisecond timing precision and rejects out-of-range timings before saving', async () => {
  const s = ui();
  s.run(`overview.intelligence.settings.optical.stabilityMs=1500;
    overview.intelligence.settings.optical.cooldownMs=1000;
    overview.intelligence.settings.suggestions.cooldownMs=1001;
    intelligenceDraft=null; renderLugn2()`);
  await s.get('intelligence-form').fire('submit');
  const [, init] = s.fetch.mock.calls[0]!;
  expect(JSON.parse(init?.body as string).settings).toMatchObject({
    optical: { stabilityMs: 1500, cooldownMs: 1000 },
    suggestions: { cooldownMs: 1001 },
  });
  s.fetch.mockClear();
  s.get('intelligence-stability').value = '0';
  await s.get('intelligence-form').fire('submit');
  expect(s.fetch).not.toHaveBeenCalled();
  expect(s.get('intelligence-status').textContent).toContain('1–300 sekunder');
  s.get('intelligence-stability').value = '301';
  await s.get('intelligence-form').fire('submit');
  expect(s.fetch).not.toHaveBeenCalled();
  s.get('intelligence-stability').value = '1.5';
  s.get('intelligence-optical-cooldown').value = '1441';
  await s.get('intelligence-form').fire('submit');
  expect(s.fetch).not.toHaveBeenCalled();
});
