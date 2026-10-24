import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { defaultMusicVolumeSettings } from '../src/core/music-volume-settings.js';

/** Focused DOM seam runs the real editor handlers, without duplicating draft logic. */
class Element {
  value = '';
  checked = false;
  disabled = false;
  hidden = false;
  textContent = '';
  type = '';
  className = '';
  dataset: Record<string, string> = {};
  children: Element[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, (event: unknown) => unknown>();
  get valueAsNumber() {
    return this.value === '' ? NaN : Number(this.value);
  }
  get options() {
    return this.children;
  }
  get firstElementChild() {
    return this.children[0];
  }
  get lastElementChild() {
    return this.children.at(-1);
  }
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
  }
  addEventListener(type: string, callback: (event: unknown) => unknown) {
    this.listeners.set(type, callback);
  }
  querySelector(selector: string): Element | undefined {
    const type = /type=(\w+)/.exec(selector)?.[1];
    return (
      this.children.find((child) => child.type === type) ??
      this.children.map((child) => child.querySelector(selector)).find(Boolean)
    );
  }
  async fire(type: string) {
    await this.listeners.get(type)?.({ target: this, preventDefault() {} });
  }
}
function editor() {
  const elements = new Map<string, Element>();
  const html = readFileSync(
    new URL('../web/index.html', import.meta.url),
    'utf8',
  );
  const ids = new Set(
    [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]),
  );
  const get = (id: string) => {
    if (!ids.has(id)) throw new Error(`Missing editor element: ${id}`);
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  get('settings-preview-target').value = 'music.room';
  get('settings-preview-time').value = '12:00';
  get('settings-preview-people').value = '1';
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async () =>
      new Response(JSON.stringify({ settings: defaultMusicVolumeSettings }), {
        status: 200,
      }),
  );
  const unload = new Map<string, (event: unknown) => unknown>();
  const overview = {
    musicSettingsEnabled: true,
    musicSettings: structuredClone(defaultMusicVolumeSettings),
    musicSettingsDefaults: structuredClone(defaultMusicVolumeSettings),
    musicVolumePolicies: {},
    state: {
      music: {
        devices: {
          'music.room': {
            observed: { volume: 0.4, source: 'Spotify' },
            allowedSources: ['Spotify', 'Optical In'],
          },
        },
      },
    },
  };
  const context = createContext({
    overview,
    overviewStale: false,
    fetch,
    structuredClone,
    API_ROOT: '/ui/api',
    csrfToken: 'csrf',
    document: {
      getElementById: get,
      createElement: () => new Element(),
      createElementNS: () => new Element(),
    },
    window: {
      addEventListener: (type: string, callback: (event: unknown) => unknown) =>
        unload.set(type, callback),
    },
  });
  const script = readFileSync(
    new URL('../web/app.js', import.meta.url),
    'utf8',
  );
  runInContext(
    `let volumeSettingsDraft = null, volumeSettingsOriginal = null, volumeSettingsBusy = false, volumePreviewRevision = 0;\n${script.slice(script.indexOf('function settingsElement('))}\nrenderMusicSettings();`,
    context,
  );
  return {
    get,
    fetch,
    overview,
    unload,
    run: (code: string) => runInContext(code, context),
  };
}
it('keeps dirty drafts across live updates and supports Cancel and unsaved Reset', async () => {
  const s = editor();
  s.get('settings-minimum').value = '20';
  await s.get('settings-minimum').fire('input');
  expect(s.get('settings-save').disabled).toBe(false);
  s.overview.musicSettings.maximum = 0.7;
  s.run('renderMusicSettings()');
  expect(s.get('settings-minimum').value).toBe('20');
  expect(s.fetch).not.toHaveBeenCalled();
  await s.get('settings-cancel').fire('click');
  expect(s.run('volumeSettingsDraft.maximum')).toBe(0.7);
  expect(s.get('settings-save').disabled).toBe(true);
  await s.get('settings-reset').fire('click');
  expect(s.run('volumeSettingsDirty()')).toBe(true);
  expect(s.fetch).not.toHaveBeenCalled();
  const event = { preventDefault: vi.fn(), returnValue: null };
  s.unload.get('beforeunload')!(event);
  expect(event.preventDefault).toHaveBeenCalled();
});
it('shows useful validation feedback and retains drafts after failed Save', async () => {
  const s = editor();
  s.get('settings-minimum').value = '90';
  await s.get('settings-minimum').fire('input');
  s.fetch.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          error: 'invalid_request',
          issues: [
            {
              path: 'settings.minimum',
              message: 'Minimum must not exceed maximum.',
            },
          ],
        }),
        { status: 400 },
      ),
  );
  await s.get('music-settings-form').fire('submit');
  expect(s.get('settings-status').textContent).toContain(
    'Minimum must not exceed maximum.',
  );
  expect(s.get('settings-minimum').value).toBe('90');
  expect(s.get('settings-save').disabled).toBe(false);
  expect(s.get('settings-fields').disabled).toBe(false);
});
it('Save sends the draft and expected original; successful save clears dirty state', async () => {
  const s = editor();
  s.get('settings-enabled').checked = false;
  await s.get('settings-enabled').fire('change');
  const saved = { ...defaultMusicVolumeSettings, enabled: false };
  s.fetch.mockImplementation(
    async () =>
      new Response(JSON.stringify({ settings: saved }), { status: 200 }),
  );
  await s.get('music-settings-form').fire('submit');
  const init = s.fetch.mock.calls[0]?.[1] as RequestInit;
  expect(JSON.parse(init.body as string)).toEqual({
    settings: saved,
    expectedSettings: defaultMusicVolumeSettings,
  });
  expect(s.run('volumeSettingsDirty()')).toBe(false);
  expect(s.get('settings-status').textContent).toContain(
    'Sparat och tillämpat',
  );
});
it('edits a separate per-player Auto base and passive reduction without applying drafts', async () => {
  const s = editor();
  const input = s.get('settings-auto-bases').children[0]!.children[0]!;
  expect(input.value).toBe(30);
  input.value = '45';
  await input.fire('input');
  s.get('settings-passive-reduction').checked = true;
  await s.get('settings-passive-reduction').fire('change');
  expect(s.run('volumeSettingsDraft.autoBaseVolumes["music.room"]')).toBe(0.45);
  expect(s.run('volumeSettingsDraft.passiveMultiPersonReductionEnabled')).toBe(
    true,
  );
  expect(s.fetch).not.toHaveBeenCalled();
  s.fetch.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          settings: {
            ...defaultMusicVolumeSettings,
            autoBaseVolumes: { 'music.room': 0.45 },
            passiveMultiPersonReductionEnabled: true,
          },
        }),
        { status: 200 },
      ),
  );
  await s.get('music-settings-form').fire('submit');
  expect(
    JSON.parse(s.fetch.mock.calls[0]![1]!.body as string).settings,
  ).toMatchObject({
    autoBaseVolumes: { 'music.room': 0.45 },
    passiveMultiPersonReductionEnabled: true,
  });
  expect(s.run('volumeSettingsDirty()')).toBe(false);
});
it('preview uses the pure endpoint and ignores a response after the draft changes', async () => {
  const s = editor();
  let resolve!: (response: Response) => void;
  s.fetch.mockImplementation(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  const pending = s.get('settings-preview-button').fire('click');
  s.get('settings-minimum').value = '15';
  await s.get('settings-minimum').fire('input');
  resolve(
    new Response(
      JSON.stringify({
        target: 0.4,
        baseline: 0.4,
        dailyOffset: 0,
        personOffset: 0,
        observedVolume: 0.4,
        activeOwner: 'lugn',
      }),
    ),
  );
  await pending;
  expect(s.fetch.mock.calls[0]?.[0]).toBe('/ui/api/music-settings/preview');
  expect(s.get('settings-preview-result').textContent).toContain(
    'behöver beräknas',
  );
  expect(s.get('settings-preview-button').disabled).toBe(false);
});

it('qualifies settings observations after upstream trust is lost without dropping drafts', () => {
  const s = editor();
  s.run(`overview.state.music.devices['music.room'].availability = 'available';
    overview.musicVolumePolicies['music.room'] = { baseline:0.4,baselineSource:'user',dailyOffset:0,personOffset:0,target:0.4,activeOwner:'manual' };
    renderMusicSettings();`);
  expect(s.get('music-settings-current').textContent).toMatch(/^Nu ·/);
  s.run(
    `volumeSettingsDraft.minimum = 0.2; overview.musicObservationTrust = { 'music.room':false }; renderMusicSettings();`,
  );
  expect(s.get('music-settings-current').textContent).toMatch(
    /^Senast rapporterat ·/,
  );
  expect(s.run('volumeSettingsDraft.minimum')).toBe(0.2);
});

it('prefills an opt-in Optical offset and preserves edits during source feedback', async () => {
  const s = editor();
  const group = s.get('settings-optical-offsets').children[0]!;
  const enabled = group.children[0]!.children[0]!;
  const source = group.children[1]!.children[0]!;
  const offset = group.children[2]!.children[0]!;
  expect(enabled.checked).toBe(false);
  expect(source.value).toBe('Optical In');
  expect(offset.value).toBe(7);
  expect(s.run('volumeSettingsDirty()')).toBe(false);
  enabled.checked = true;
  await enabled.fire('change');
  offset.value = '9.5';
  await offset.fire('input');
  s.overview.state.music.devices['music.room'].observed.source = 'Optical In';
  s.run('renderMusicSettings()');
  expect(s.get('settings-optical-offsets').children[0]).toBe(group);
  expect(offset.value).toBe('9.5');
  expect(s.run('volumeSettingsDraft.opticalOffsets["music.room"]')).toEqual({
    enabled: true,
    source: 'Optical In',
    offset: 0.095,
  });
  expect(s.fetch).not.toHaveBeenCalled();
  await s.get('settings-cancel').fire('click');
  expect(s.run('volumeSettingsDirty()')).toBe(false);
});

it('saves and disables the explicit per-player mapping without changing Auto bases', async () => {
  const s = editor();
  const group = s.get('settings-optical-offsets').children[0]!;
  const enabled = group.children[0]!.children[0]!;
  enabled.checked = true;
  await enabled.fire('change');
  const saved = s.run('structuredClone(volumeSettingsDraft)');
  s.fetch.mockImplementation(
    async () =>
      new Response(JSON.stringify({ settings: saved }), { status: 200 }),
  );
  await s.get('music-settings-form').fire('submit');
  const sent = JSON.parse(s.fetch.mock.calls[0]![1]!.body as string);
  expect(sent.settings.opticalOffsets).toEqual({
    'music.room': { enabled: true, source: 'Optical In', offset: 0.07 },
  });
  expect(sent.settings.autoBaseVolumes).toEqual(
    defaultMusicVolumeSettings.autoBaseVolumes,
  );
  const restored = s.get('settings-optical-offsets').children[0]!.children[0]!
    .children[0]!;
  restored.checked = false;
  await restored.fire('change');
  expect(s.run('volumeSettingsDraft.opticalOffsets["music.room"]')).toEqual({
    enabled: false,
    source: 'Optical In',
    offset: 0.07,
  });
  expect(s.run('volumeSettingsDraft.autoBaseVolumes')).toEqual(
    defaultMusicVolumeSettings.autoBaseVolumes,
  );
});

it('requires an explicit input when the player does not advertise Optical', async () => {
  const s = editor();
  s.overview.state.music.devices['music.room'].allowedSources = [
    'WiFi',
    'Line In',
  ];
  s.run('fillMusicSettings()');
  const group = s.get('settings-optical-offsets').children[0]!;
  const enabled = group.children[0]!.children[0]!;
  const source = group.children[1]!.children[0]!;
  expect(source.value).toBe('');
  expect(enabled.disabled).toBe(true);
  expect(s.run('volumeSettingsDirty()')).toBe(false);
  source.value = 'Line In';
  await source.fire('change');
  expect(enabled.disabled).toBe(false);
  expect(s.run('volumeSettingsDraft.opticalOffsets["music.room"]')).toEqual({
    enabled: false,
    source: 'Line In',
    offset: 0.07,
  });
});

it('keeps another player’s offset and a blank numeric draft while live state updates', async () => {
  const s = editor();
  s.run(`volumeSettingsDraft.opticalOffsets = {
    'music.other': {enabled:true, source:'Optical', offset:0.1}
  }; fillOpticalOffsets();`);
  const offset = s.get('settings-optical-offsets').children[0]!.children[2]!
    .children[0]!;
  offset.value = '';
  await offset.fire('input');
  s.run('renderMusicSettings()');
  expect(offset.value).toBe('');
  expect(
    s.run('volumeSettingsDraft.opticalOffsets["music.room"].offset'),
  ).toBeNull();
  expect(s.run('volumeSettingsDraft.opticalOffsets["music.other"]')).toEqual({
    enabled: true,
    source: 'Optical',
    offset: 0.1,
  });
  expect(s.fetch).not.toHaveBeenCalled();
});
