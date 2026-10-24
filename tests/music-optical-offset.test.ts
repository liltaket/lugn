import { afterEach, expect, it } from 'vitest';
import {
  SimulatedMusicAdapter,
  type MusicAdapter,
  type MusicObservation,
} from '../src/adapters/simulated-music.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import {
  defaultMusicVolumeSettings,
  MusicVolumeSettingsSchema,
  type MusicVolumeSettings,
} from '../src/core/music-volume-settings.js';
import {
  MusicIntentSnapshotSchema,
  type MusicIntentSnapshot,
} from '../src/core/schemas.js';

const target = 'music.room';
const trimSettlingMs = 2_000;
const human = { actor: { type: 'user' as const }, source: 'dashboard' };
const engines: LugnEngine[] = [];
afterEach(() => engines.splice(0).forEach((engine) => engine.dispose()));
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
const settings = (): MusicVolumeSettings => ({
  ...structuredClone(defaultMusicVolumeSettings),
  minimum: 0,
  maximum: 1,
  opticalOffsets: {
    [target]: { enabled: true, source: 'Optical', offset: 0.07 },
  },
});
async function setup(
  config = settings(),
  restoredMusicIntent?: MusicIntentSnapshot,
  initialSource: string | null = 'Spotify',
  initialVolume = 0.3,
) {
  const clock = new FakeClock(Date.parse('2026-10-18T12:00:00+02:00'));
  const adapter = new SimulatedMusicAdapter(clock);
  let trusted = true;
  let provenanceOverride: MusicObservation['provenance'];
  const wrappedAdapter: MusicAdapter = {
    dispatch: adapter.dispatch.bind(adapter),
    subscribe: (listener) =>
      adapter.subscribe((observation) =>
        listener({
          ...observation,
          provenance: provenanceOverride ?? {
            actor: { type: 'home_assistant' },
            source: 'ha_state',
          },
        }),
      ),
  };
  Object.defineProperty(wrappedAdapter, 'readStatus', {
    get: () =>
      (
        adapter as SimulatedMusicAdapter & Partial<MusicAdapter>
      ).readStatus?.bind(adapter),
  });
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [{ id: 'scene.all_off', name: 'Off', lighting: {} }],
    musicVolumeSettings: config,
    music: {
      targets: {
        [target]: ['Spotify', 'Optical', 'TV'],
        'music.other': ['Spotify'],
      },
      adapter: wrappedAdapter,
      observationTrusted: () => trusted,
    },
    ...(restoredMusicIntent ? { restoredMusicIntent } : {}),
  });
  engines.push(engine);
  const observe = (
    source: string | null,
    volume: number,
    commandId?: string,
    sourceUpdatedAt?: number,
    available = true,
    provenance?: MusicObservation['provenance'],
  ) => {
    clock.advanceBy(1);
    provenanceOverride = provenance;
    adapter.observe(
      target,
      { playback: 'paused', source, volume, title: null },
      available,
      commandId,
      sourceUpdatedAt,
    );
    provenanceOverride = undefined;
  };
  const policy = () => engine.getMusicVolumePolicySnapshots()[target]!;
  const volumes = () =>
    adapter.dispatched.filter((c) => c.requested.property === 'volume');
  const lastVolume = () =>
    (volumes().at(-1)?.requested as { value: number } | undefined)?.value;
  const settle = async () => {
    await flush();
    for (const command of [...volumes()]) {
      if (
        engine.state.music.commands.find((c) => c.id === command.id)?.status !==
        'pending'
      )
        continue;
      observe(
        engine.getMusicState(target).observed.source,
        (command.requested as { value: number }).value,
        command.id,
      );
    }
    await flush();
  };
  const switchTo = async (
    source: string,
    volume = engine.getMusicState(target).observed.volume!,
  ) => {
    observe(source, volume);
    clock.advanceBy(trimSettlingMs);
    await settle();
  };
  const manual = async (volume: number) => {
    await engine.requestMusic(
      target,
      { property: 'volume', value: volume },
      human,
    );
    await settle();
  };
  observe(initialSource, initialVolume);
  clock.advanceBy(trimSettlingMs);
  await engine.handlePresence({
    type: 'presence.changed',
    presence: 'occupied',
    personCount: 1,
  });
  await settle();
  return {
    clock,
    adapter,
    engine,
    observe,
    policy,
    volumes,
    lastVolume,
    settle,
    switchTo,
    manual,
    trust: (value: boolean) => {
      trusted = value;
    },
  };
}

it('defaults legacy settings to no trim and validates exact source mapping before applying', async () => {
  const legacy = structuredClone(defaultMusicVolumeSettings);
  const old = { ...legacy } as Partial<MusicVolumeSettings>;
  delete old.opticalOffsets;
  expect(MusicVolumeSettingsSchema.parse(old).opticalOffsets).toEqual({});
  expect(
    MusicVolumeSettingsSchema.parse({
      ...legacy,
      opticalOffsets: { [target]: { source: 'Optical', enabled: false } },
    }).opticalOffsets[target]?.offset,
  ).toBe(0.07);
  for (const offset of [-0.01, 0.21, NaN])
    expect(
      MusicVolumeSettingsSchema.safeParse({
        ...settings(),
        opticalOffsets: {
          [target]: { source: 'Optical', enabled: true, offset },
        },
      }).success,
    ).toBe(false);
  const s = await setup();
  for (const [id, source] of [
    [target, 'optical'],
    ['music.other', 'Optical'],
    ['music.unknown', 'Optical'],
  ]) {
    expect(() =>
      s.engine.applyMusicVolumeSettings({
        ...settings(),
        opticalOffsets: {
          [id!]: { enabled: true, source: source!, offset: 0.07 },
        },
      }),
    ).toThrow('configured source');
  }
  expect(s.engine.getMusicVolumeSettings()).toEqual(settings());
});

it.each(['auto', 'manual'] as const)(
  'adds source trim without ratcheting or changing %s mode on simultaneous native restores',
  async (mode) => {
    const s = await setup();
    if (mode === 'manual')
      s.engine.setMusicVolumeAuthority({ target, mode }, human);
    for (let i = 0; i < 3; i++) {
      await s.switchTo('Optical', 0.61); // native per-source remembered volume
      expect(s.lastVolume()).toBeCloseTo(0.37);
      expect(s.policy()).toMatchObject({
        mode,
        sourceOffset: 0.07,
        configuredBaseline: 0.3,
      });
      await s.switchTo('Spotify', 0.18);
      expect(s.lastVolume()).toBeCloseTo(0.3);
      expect(s.policy()).toMatchObject({
        mode,
        sourceOffset: 0,
        configuredBaseline: 0.3,
      });
    }
    expect(s.policy().manualReference).toBe(mode === 'manual' ? 0.3 : null);
    expect(
      s.adapter.dispatched.every((c) => c.requested.property === 'volume'),
    ).toBe(true);
  },
);

it('settles delayed native source-volume restores, while subsequent real physical changes claim a neutral manual reference', async () => {
  const s = await setup();
  s.engine.setMusicVolumeAuthority({ target, mode: 'manual' }, human);
  s.observe('Optical', 0.3);
  s.clock.advanceBy(200);
  s.observe('Optical', 0.58); // delayed restore before source settles
  expect(s.policy().manualReference).toBe(0.3);
  s.clock.advanceBy(trimSettlingMs - 200);
  await s.settle();
  expect(s.lastVolume()).toBeCloseTo(0.37);
  s.observe('Optical', 0.42);
  expect(s.policy().manualReference).toBeCloseTo(0.35);
  await s.switchTo('Spotify', 0.3);
  expect(s.lastVolume()).toBeCloseTo(0.35);
  expect(s.policy()).toMatchObject({ mode: 'manual', configuredBaseline: 0.3 });
});

it('human commands win during settling, including negative neutral and clipped restoration without drift', async () => {
  const s = await setup();
  await s.manual(0.98);
  await s.switchTo('Optical');
  expect(s.lastVolume()).toBe(1);
  await s.switchTo('Spotify');
  expect(s.lastVolume()).toBe(0.98);
  s.observe('Optical', 0.98);
  await s.manual(0.02);
  expect(s.policy().manualReference).toBeCloseTo(-0.05);
  s.clock.advanceBy(trimSettlingMs);
  await s.settle();
  expect(s.policy().effectiveTarget).toBeCloseTo(0.02);
  const saved = MusicIntentSnapshotSchema.parse(
    s.engine.getMusicIntentSnapshot(),
  );
  const r = await setup(settings(), saved, 'Optical', 0.02);
  expect(r.policy().manualReference).toBeCloseTo(-0.05);
  await r.switchTo('Spotify');
  expect(r.lastVolume()).toBe(0);
  await r.switchTo('Optical');
  expect(r.lastVolume()).toBeCloseTo(0.02);
});

it.each(['auto', 'manual'] as const)(
  'trim works with daily automation disabled and preserves %s mode and saved references',
  async (mode) => {
    const config = { ...settings(), enabled: false };
    const s = await setup(config);
    if (mode === 'manual')
      s.engine.setMusicVolumeAuthority({ target, mode }, human);
    await s.switchTo('Optical');
    expect(s.lastVolume()).toBeCloseTo(0.37);
    expect(s.policy()).toMatchObject({ mode, policyEnabled: false });
    const saved = MusicIntentSnapshotSchema.parse(
      s.engine.getMusicIntentSnapshot(),
    );
    const r = await setup(config, saved, 'Optical', 0.37);
    await r.switchTo('Spotify');
    expect(r.lastVolume()).toBeCloseTo(0.3);
    expect(r.policy()).toMatchObject({
      mode,
      policyEnabled: false,
      configuredBaseline: 0.3,
    });
  },
);

it('edits and disables Optical trim in place without changing manual reference, bases or mode', async () => {
  const s = await setup();
  await s.manual(0.3);
  await s.switchTo('Optical');
  s.engine.applyMusicVolumeSettings({
    ...settings(),
    opticalOffsets: {
      [target]: { enabled: true, source: 'Optical', offset: 0.12 },
    },
  });
  await s.settle();
  expect(s.lastVolume()).toBeCloseTo(0.42);
  s.engine.applyMusicVolumeSettings({ ...settings(), opticalOffsets: {} });
  await s.settle();
  expect(s.lastVolume()).toBeCloseTo(0.3);
  expect(s.policy()).toMatchObject({
    mode: 'manual',
    manualReference: 0.3,
    configuredBaseline: 0.3,
    sourceOffset: 0,
  });
  expect(
    s.engine.getMusicIntentSnapshot().targets[target]?.sourceTrimManaged,
  ).toBeUndefined();
});

it('rejects stale source snapshots, waits for trusted fresh feedback, and coalesces rapid switches', async () => {
  const s = await setup();
  const timestamp = s.clock.now();
  s.observe('Spotify', 0.3, undefined, timestamp);
  s.observe('Optical', 0.3, undefined, timestamp - 1);
  s.clock.advanceBy(trimSettlingMs);
  await s.settle();
  expect(s.volumes()).toHaveLength(0);
  s.trust(false);
  await s.switchTo('Optical');
  expect(s.volumes()).toHaveLength(0);
  s.trust(true);
  s.observe('Optical', 0.3);
  s.clock.advanceBy(trimSettlingMs);
  await s.settle();
  expect(s.lastVolume()).toBeCloseTo(0.37);
  const count = s.volumes().length;
  s.observe('Spotify', 0.37);
  s.clock.advanceBy(100);
  s.observe('Optical', 0.37);
  s.clock.advanceBy(100);
  s.observe('Spotify', 0.37);
  s.clock.advanceBy(trimSettlingMs);
  await s.settle();
  expect(s.volumes()).toHaveLength(count + 1);
  expect(s.lastVolume()).toBeCloseTo(0.3);
});

it('combines person reduction and source trim around the same neutral manual reference', async () => {
  const s = await setup({
    ...settings(),
    passiveMultiPersonReductionEnabled: true,
  });
  await s.manual(0.5);
  await s.engine.handlePresence({
    type: 'presence.changed',
    presence: 'occupied',
    personCount: 2,
  });
  await s.settle();
  await s.switchTo('Optical');
  expect(s.lastVolume()).toBeCloseTo(0.47);
  s.observe('Optical', 0.52);
  expect(s.policy().manualReference).toBeCloseTo(0.55);
  await s.switchTo('Spotify');
  expect(s.lastVolume()).toBeCloseTo(0.45);
  await s.engine.handlePresence({
    type: 'presence.changed',
    presence: 'occupied',
    personCount: 1,
  });
  await s.settle();
  expect(s.lastVolume()).toBeCloseTo(0.55);
});

it.each(['away', 'unknown', 'empty'] as const)(
  'respects %s room gates with trim-only authorization',
  async (gate) => {
    const s = await setup({ ...settings(), enabled: false });
    if (gate === 'away') await s.engine.handleHomePresence('away');
    else
      await s.engine.handlePresence({
        type: 'presence.changed',
        presence: gate === 'empty' ? 'confirmed_empty' : 'unknown',
        personCount: null,
      });
    await s.switchTo('Optical');
    expect(s.volumes()).toHaveLength(0);
    expect(() =>
      s.engine.requestMusic(
        target,
        { property: 'volume', value: 0.9 },
        {
          actor: { type: 'automation', id: 'lugn.music' },
          source: 'presence_music_automation',
          reason: 'set source volume',
        },
      ),
    ).toThrow();
  },
);

it('omits new intent fields and preserves source/volume manual detection while offsets remain disabled', async () => {
  const s = await setup({ ...settings(), opticalOffsets: {} });
  await s.switchTo('Optical', 0.61);
  expect(s.policy()).toMatchObject({
    mode: 'manual',
    manualReference: 0.61,
    sourceOffset: 0,
  });
  expect(s.volumes()).toHaveLength(0);
  for (const intent of Object.values(
    s.engine.getMusicIntentSnapshot().targets,
  )) {
    expect(Object.hasOwn(intent, 'sourceReference')).toBe(false);
    expect(Object.hasOwn(intent, 'sourceTrimManaged')).toBe(false);
  }
});

it('ignores an old command echo carrying its former source after a rapid switch', async () => {
  const s = await setup();
  s.observe('Optical', 0.3);
  s.clock.advanceBy(trimSettlingMs);
  await flush();
  const old = s.volumes().at(-1)!;
  expect((old.requested as { value: number }).value).toBeCloseTo(0.37);
  s.observe('Spotify', 0.3);
  s.clock.advanceBy(trimSettlingMs);
  await s.settle();
  const count = s.volumes().length;
  s.observe('Optical', 0.37, old.id);
  s.clock.advanceBy(trimSettlingMs);
  await s.settle();
  expect(s.engine.getMusicState(target).observed.source).toBe('Spotify');
  expect(s.policy()).toMatchObject({ mode: 'auto', sourceOffset: 0 });
  expect(s.volumes()).toHaveLength(count);
});

it('keeps command timeout recovery bounded when fresh observations stop', async () => {
  const s = await setup({ ...settings(), enabled: false });
  s.observe('Optical', 0.3);
  s.clock.advanceBy(trimSettlingMs);
  await flush();
  expect(s.volumes()).toHaveLength(1);
  s.clock.advanceBy(120_000);
  await flush();
  expect(s.volumes()).toHaveLength(1);
  expect(s.engine.state.music.commands.at(-1)?.status).toBe('unconfirmed');
});

it('captures the current neutral Auto volume when daily automation is disabled on Optical', async () => {
  const config = { ...settings(), autoBaseVolumes: { [target]: 0.5 } };
  const s = await setup(config);
  await s.switchTo('Optical');
  expect(s.lastVolume()).toBeCloseTo(0.57);
  s.engine.applyMusicVolumeSettings({ ...config, enabled: false });
  await s.settle();
  expect(s.policy()).toMatchObject({
    mode: 'auto',
    policyEnabled: false,
    configuredBaseline: 0.5,
  });
  await s.switchTo('Spotify');
  expect(s.lastVolume()).toBeCloseTo(0.5);
});

it('source changes interrupt a user fade without rebasing its neutral destination to native restored volume', async () => {
  const s = await setup();
  s.engine.startMusicFade({ target, volume: 0.4, durationMs: 5_000 }, human);
  s.observe('Optical', 0.7);
  s.clock.advanceBy(trimSettlingMs);
  await s.settle();
  expect(s.engine.state.music.fades[target]?.status).toBe('interrupted');
  expect(s.policy()).toMatchObject({ mode: 'manual', manualReference: 0.4 });
  expect(s.lastVolume()).toBeCloseTo(0.47);
});

it.each([800, 1500])(
  'collects an unknown first native Optical restore delayed %i ms without phantom manual ownership, including repeat switches',
  async (delay) => {
    const s = await setup();
    s.engine.setMusicVolumeAuthority({ target, mode: 'manual' }, human);
    for (let i = 0; i < 2; i++) {
      s.observe('Optical', 0.3);
      s.clock.advanceBy(delay);
      s.observe('Optical', 0.62 + i / 100);
      expect(s.policy().manualReference).toBe(0.3);
      s.clock.advanceBy(trimSettlingMs - delay);
      await s.settle();
      expect(s.lastVolume()).toBeCloseTo(0.37);
      await s.switchTo('Spotify', 0.3);
      expect(s.engine.getMusicState(target).observed.volume).toBeCloseTo(0.3);
      expect(s.policy().effectiveTarget).toBeCloseTo(0.3);
    }
  },
);

it('keeps an explicit human request during settling over a subsequent raw native restore and a slow own echo', async () => {
  const s = await setup();
  s.observe('Optical', 0.3);
  s.clock.advanceBy(600);
  const command = await s.engine.requestMusic(
    target,
    { property: 'volume', value: 0.42 },
    human,
  );
  s.clock.advanceBy(400);
  s.observe('Optical', 0.63); // raw receiver restore cannot rewrite the human request
  expect(s.policy()).toMatchObject({ mode: 'manual' });
  expect(s.policy().manualReference).toBeCloseTo(0.35);
  s.clock.advanceBy(3_000);
  s.observe('Optical', 0.42, command.id);
  await s.settle();
  expect(s.policy().manualReference).toBeCloseTo(0.35);
  expect(s.engine.state.music.volumeChanges?.[target]).toMatchObject({
    provenance: human,
    attribution: 'correlated',
  });
  await s.switchTo('Spotify', 0.3);
  expect(s.lastVolume()).toBeCloseTo(0.35);
});

it('documents the observation boundary: an unknown restore beyond two seconds is indistinguishable from manual volume', async () => {
  const s = await setup();
  await s.switchTo('Optical');
  s.clock.advanceBy(500);
  s.observe('Optical', 0.62);
  expect(s.policy()).toMatchObject({ mode: 'manual' });
  expect(s.policy().manualReference).toBeCloseTo(0.55);
});

it.each(['source', 'away', 'manual'] as const)(
  'cancels trim recovery after %s changes while a fresh status read is pending',
  async (change) => {
    const s = await setup({ ...settings(), enabled: false });
    let resolve!: (observation: MusicObservation) => void;
    Object.assign(s.adapter, {
      readStatus: () =>
        new Promise<MusicObservation>((done) => {
          resolve = done;
        }),
    });
    s.observe('Optical', 0.3);
    s.clock.advanceBy(trimSettlingMs);
    await flush();
    const trim = s.engine.state.music.commands.at(-1)!;
    expect(trim.requested).toMatchObject({ property: 'volume', value: 0.37 });
    s.clock.advanceBy(10_000);
    await flush();
    expect(trim.recovery?.stage).toBe('verifying');
    if (change === 'away') await s.engine.handleHomePresence('away');
    if (change === 'manual')
      await s.engine.requestMusic(
        target,
        { property: 'volume', value: 0.42 },
        human,
      );
    const count = s.volumes().length;
    resolve({
      target,
      available: true,
      observedAt: s.clock.now(),
      values: {
        playback: 'paused',
        source: change === 'source' ? 'Spotify' : 'Optical',
        volume: 0.3,
        title: null,
      },
    });
    await flush();
    s.clock.advanceBy(5_000);
    await flush();
    expect(s.volumes()).toHaveLength(count);
    expect(trim.recovery?.stage).toBe('stopped');
    expect(trim.recovery?.stopReason).toBe(
      change === 'source'
        ? 'newer_report'
        : change === 'manual'
          ? 'superseded'
          : 'policy_changed',
    );
    expect(s.policy().configuredBaseline).toBe(0.3);
  },
);

it('retains the unclipped neutral Auto reference when daily automation is disabled at a source clamp', async () => {
  const config = { ...settings(), autoBaseVolumes: { [target]: 0.98 } };
  const s = await setup(config);
  await s.switchTo('Optical');
  expect(s.lastVolume()).toBe(1);
  s.engine.applyMusicVolumeSettings({ ...config, enabled: false });
  await s.settle();
  await s.switchTo('Spotify');
  expect(s.lastVolume()).toBe(0.98);
  expect(s.policy()).toMatchObject({
    mode: 'auto',
    policyEnabled: false,
    configuredBaseline: 0.98,
  });
});

it.each([
  { volume: 0.9, neutral: 0.83, enabled: true, input: 'request' },
  { volume: 0.01, neutral: -0.06, enabled: true, input: 'request' },
  { volume: 0.9, neutral: 0.83, enabled: true, input: 'physical' },
  { volume: 0.01, neutral: -0.06, enabled: true, input: 'physical' },
  { volume: 0.9, neutral: 0.83, enabled: false, input: 'request' },
  { volume: 0.01, neutral: -0.06, enabled: false, input: 'request' },
])(
  'preserves Optical human $input=$volume outside default Auto bounds with daily enabled=$enabled',
  async ({ volume, neutral, enabled, input }) => {
    const config = { ...settings(), minimum: 0.05, maximum: 0.8, enabled };
    const s = await setup(config);
    await s.switchTo('Optical');
    if (input === 'request') await s.manual(volume);
    else {
      s.observe('Optical', volume);
      await s.settle();
    }
    expect(s.engine.getMusicState(target).observed.volume).toBeCloseTo(volume);
    expect(s.policy().effectiveTarget).toBeCloseTo(volume);
    expect(s.policy().manualReference).toBeCloseTo(neutral);
    for (let i = 0; i < 2; i++) {
      await s.switchTo('Spotify');
      expect(s.engine.getMusicState(target).observed.volume).toBeCloseTo(
        Math.max(0, neutral),
      );
      expect(s.policy().manualReference).toBeCloseTo(neutral);
      await s.switchTo('Optical');
      expect(s.engine.getMusicState(target).observed.volume).toBeCloseTo(
        volume,
      );
    }
    expect(s.policy()).toMatchObject({
      mode: 'manual',
      policyEnabled: enabled,
      configuredBaseline: 0.3,
    });
    expect(s.engine.getMusicVolumeSettings().autoBaseVolumes).toEqual({});
  },
);

it.each([0.9, 0.01])(
  'preserves a trim-only neutral volume of %s outside default Auto bounds while daily policy stays off',
  async (volume) => {
    const config = {
      ...settings(),
      enabled: false,
      minimum: 0.05,
      maximum: 0.8,
    };
    const s = await setup(config, undefined, 'Spotify', volume);
    expect(s.engine.getMusicState(target).observed.volume).toBeCloseTo(volume);
    await s.switchTo('Optical');
    expect(s.engine.getMusicState(target).observed.volume).toBeCloseTo(
      volume + 0.07,
    );
    await s.switchTo('Spotify');
    expect(s.engine.getMusicState(target).observed.volume).toBeCloseTo(volume);
    expect(s.policy()).toMatchObject({
      mode: 'auto',
      policyEnabled: false,
      configuredBaseline: 0.3,
    });
  },
);

it.each([0, 0.98])(
  'retains configured 5–80 percent bounds for active Auto baseline %s',
  async (baseline) => {
    const config = {
      ...settings(),
      minimum: 0.05,
      maximum: 0.8,
      autoBaseVolumes: { [target]: baseline },
    };
    const s = await setup(config);
    expect(s.engine.getMusicState(target).observed.volume).toBeCloseTo(
      Math.min(0.8, Math.max(0.05, baseline)),
    );
    await s.switchTo('Optical');
    expect(s.engine.getMusicState(target).observed.volume).toBeCloseTo(
      Math.min(0.8, Math.max(0.05, baseline + 0.07)),
    );
    expect(s.policy()).toMatchObject({
      mode: 'auto',
      policyEnabled: true,
      configuredBaseline: baseline,
    });
  },
);

it.each(['auto', 'manual'] as const)(
  'preserves %s through a long null, unavailable or unknown-alias source gap before native Optical volume resolves',
  async (mode) => {
    for (const gap of [
      'initial-null',
      'null',
      'disconnected-null',
      'disconnected-optical',
      'unknown-alias',
    ] as const) {
      const s = await setup(
        settings(),
        undefined,
        gap === 'initial-null' ? null : 'Spotify',
      );
      if (mode === 'manual')
        s.engine.setMusicVolumeAuthority({ target, mode }, human);
      s.observe(
        gap.endsWith('null')
          ? null
          : gap === 'unknown-alias'
            ? 'unconfigured input'
            : 'Optical',
        0.3,
        undefined,
        undefined,
        !gap.startsWith('disconnected'),
      );
      s.clock.advanceBy(trimSettlingMs + 500);
      const before = s.volumes().length;
      s.observe('Optical', 0.61);
      expect(s.policy()).toMatchObject({ mode, configuredBaseline: 0.3 });
      expect(s.policy().manualReference).toBe(mode === 'manual' ? 0.3 : null);
      expect(s.volumes()).toHaveLength(before);
      s.clock.advanceBy(trimSettlingMs);
      await s.settle();
      expect(s.engine.getMusicState(target).observed.volume).toBeCloseTo(0.37);
      expect(s.policy().manualReference).toBe(mode === 'manual' ? 0.3 : null);
      await s.switchTo('Spotify', 0.3);
      expect(s.engine.getMusicState(target).observed.volume).toBeCloseTo(0.3);
    }
  },
);

it('keeps genuine human intent made in an unresolved source gap before native source resolution', async () => {
  const s = await setup();
  s.observe(null, 0.3);
  s.clock.advanceBy(trimSettlingMs + 500);
  await s.manual(0.45);
  s.observe('Optical', 0.61);
  s.clock.advanceBy(trimSettlingMs);
  await s.settle();
  expect(s.policy()).toMatchObject({
    mode: 'manual',
    manualReference: 0.45,
    configuredBaseline: 0.3,
  });
  expect(s.engine.getMusicState(target).observed.volume).toBeCloseTo(0.52);
});

it('preserves explicitly attributed physical volume on the first resolved source snapshot', async () => {
  const s = await setup();
  s.observe(null, 0.3);
  s.clock.advanceBy(trimSettlingMs + 500);
  s.observe('Optical', 0.42, undefined, undefined, true, {
    actor: { type: 'physical_remote' },
    source: 'physical_remote',
  });
  s.clock.advanceBy(trimSettlingMs);
  await s.settle();
  expect(s.policy().mode).toBe('manual');
  expect(s.policy().manualReference).toBeCloseTo(0.35);
  expect(s.engine.getMusicState(target).observed.volume).toBeCloseTo(0.42);
});

it('retains legacy manual volume classification after null-source gaps when offsets remain disabled', async () => {
  const s = await setup({ ...settings(), opticalOffsets: {} });
  s.observe(null, 0.3);
  s.clock.advanceBy(trimSettlingMs + 500);
  s.observe('Optical', 0.61);
  s.clock.advanceBy(trimSettlingMs);
  await s.settle();
  expect(s.policy()).toMatchObject({
    mode: 'manual',
    manualReference: 0.61,
    sourceOffset: 0,
  });
  expect(s.volumes()).toHaveLength(0);
  expect(
    s.engine.getMusicIntentSnapshot().targets[target]?.sourceTrimManaged,
  ).toBeUndefined();
});

it('requires fresh trusted source resolution after a null gap and rejects older source timestamps before attributing volume', async () => {
  const s = await setup();
  const timestamp = s.clock.now();
  s.observe(null, 0.3, undefined, timestamp);
  s.clock.advanceBy(trimSettlingMs + 500);
  s.observe('Optical', 0.61, undefined, timestamp - 1);
  expect(s.engine.getMusicState(target).observed.source).toBeNull();
  expect(s.policy()).toMatchObject({ mode: 'auto', sourceOffset: 0 });
  s.trust(false);
  s.observe('Optical', 0.3);
  s.clock.advanceBy(trimSettlingMs + 500);
  await s.settle();
  expect(s.volumes()).toHaveLength(0);
  s.trust(true);
  await s.engine.handlePresence({
    type: 'presence.changed',
    presence: 'occupied',
    personCount: 1,
  });
  await s.settle();
  expect(s.volumes()).toHaveLength(0); // toggling trust cannot confirm the earlier untrusted sample
  s.observe('Optical', 0.61);
  expect(s.policy()).toMatchObject({ mode: 'auto', sourceOffset: 0 });
  s.clock.advanceBy(trimSettlingMs);
  await s.settle();
  expect(s.engine.getMusicState(target).observed.volume).toBeCloseTo(0.37);
  expect(s.policy()).toMatchObject({ mode: 'auto', configuredBaseline: 0.3 });
});

it.each([
  { gap: null, mode: 'auto' },
  { gap: 'unconfigured input', mode: 'auto' },
  { gap: null, mode: 'manual' },
  { gap: 'unconfigured input', mode: 'manual' },
  { gap: null, mode: 'human' },
  { gap: 'unconfigured input', mode: 'human' },
])(
  'preserves $mode intent when native volume arrives on unresolved source $gap before its alias',
  async ({ gap, mode }) => {
    const s = await setup();
    if (mode === 'manual')
      s.engine.setMusicVolumeAuthority({ target, mode: 'manual' }, human);
    if (mode === 'human') await s.manual(0.45);
    const expectedMode = mode === 'auto' ? 'auto' : 'manual';
    const reference = mode === 'auto' ? null : mode === 'human' ? 0.45 : 0.3;
    const volumeChanges = structuredClone(
      s.engine.state.music.volumeChanges?.[target],
    );
    const before = s.volumes().length;
    s.observe(gap, 0.61);
    expect(s.policy()).toMatchObject({
      mode: expectedMode,
      manualReference: reference,
      sourceOffset: 0,
    });
    expect(s.engine.state.music.volumeChanges?.[target]).toEqual(volumeChanges);
    expect(s.volumes()).toHaveLength(before);
    s.clock.advanceBy(100);
    s.observe('Optical', 0.61);
    s.clock.advanceBy(trimSettlingMs);
    await s.settle();
    expect(s.policy()).toMatchObject({
      mode: expectedMode,
      manualReference: reference,
      configuredBaseline: 0.3,
    });
    expect(s.engine.getMusicState(target).observed.volume).toBeCloseTo(
      (reference ?? 0.3) + 0.07,
    );
  },
);

it.each([null, 'unconfigured input'])(
  'preserves an own human command made during unresolved source %s despite subsequent native feedback',
  async (gap) => {
    const s = await setup();
    s.observe(gap, 0.61);
    await s.manual(0.45);
    s.observe(gap, 0.61);
    expect(s.policy()).toMatchObject({
      mode: 'manual',
      manualReference: 0.45,
      sourceOffset: 0,
    });
    s.clock.advanceBy(100);
    s.observe('Optical', 0.61);
    s.clock.advanceBy(trimSettlingMs);
    await s.settle();
    expect(s.policy().manualReference).toBe(0.45);
    expect(s.engine.getMusicState(target).observed.volume).toBeCloseTo(0.52);
  },
);

it.each([null, 'unconfigured input'])(
  'keeps legacy volume-first manual detection on unresolved source %s when trim is disabled',
  async (gap) => {
    const s = await setup({ ...settings(), opticalOffsets: {} });
    s.observe(gap, 0.61);
    expect(s.policy()).toMatchObject({ mode: 'manual', manualReference: 0.61 });
    s.clock.advanceBy(100);
    s.observe('Optical', 0.61);
    s.clock.advanceBy(trimSettlingMs);
    await s.settle();
    expect(s.policy()).toMatchObject({
      mode: 'manual',
      manualReference: 0.61,
      sourceOffset: 0,
    });
    expect(s.volumes()).toHaveLength(0);
  },
);

it('keeps the unresolved-source deferral bounded to two seconds', async () => {
  const s = await setup();
  s.observe(null, 0.3);
  s.clock.advanceBy(trimSettlingMs + 1);
  s.observe(null, 0.45);
  expect(s.policy()).toMatchObject({
    mode: 'manual',
    manualReference: 0.45,
    sourceOffset: 0,
  });
});

it.each([null, 'unconfigured input'])(
  'preserves a human fade destination through a volume-first unresolved source %s',
  async (gap) => {
    const s = await setup();
    s.engine.startMusicFade({ target, volume: 0.4, durationMs: 5_000 }, human);
    s.observe(gap, 0.61);
    expect(s.engine.state.music.fades[target]?.status).toBe('interrupted');
    expect(s.policy().manualReference).toBeCloseTo(0.4);
    s.clock.advanceBy(100);
    s.observe('Optical', 0.61);
    s.clock.advanceBy(trimSettlingMs);
    await s.settle();
    expect(s.policy().manualReference).toBeCloseTo(0.4);
    expect(s.engine.getMusicState(target).observed.volume).toBeCloseTo(0.47);
  },
);

it.each([null, 'unconfigured input'])(
  'still accepts explicitly attributed physical volume during unresolved source %s',
  async (gap) => {
    const s = await setup();
    s.observe(gap, 0.45, undefined, undefined, true, {
      actor: { type: 'physical_remote' },
      source: 'physical_remote',
    });
    expect(s.policy()).toMatchObject({
      mode: 'manual',
      manualReference: 0.45,
      sourceOffset: 0,
    });
    s.clock.advanceBy(100);
    s.observe('Optical', 0.61);
    s.clock.advanceBy(trimSettlingMs);
    await s.settle();
    expect(s.policy().manualReference).toBe(0.45);
    expect(s.engine.getMusicState(target).observed.volume).toBeCloseTo(0.52);
  },
);
