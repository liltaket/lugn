import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { LugnEngine } from '../src/application/lugn-engine.js';
import { FakeClock } from '../src/core/clock.js';
import { LightingIntentStore } from '../src/runtime/lighting-intent-store.js';
import type { LightingIntentSource } from '../src/runtime/lighting-intent-store.js';

const directories: string[] = [];
const user = { actor: { type: 'user' as const }, source: 'dashboard' };
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lugn-music-intent-'));
  directories.push(directory);
  const filePath = join(directory, 'intent.json');
  const engine = new LugnEngine(new FakeClock(10_000), {
    deviceIds: [],
    scenes: [],
    music: { targets: { 'music.room': [] } },
  });
  await engine.requestMusic(
    'music.room',
    { property: 'volume', value: 0.95 },
    user,
  );
  await engine.requestMusic(
    'music.room',
    { property: 'playback', value: 'paused' },
    user,
  );
  const snapshot = engine.getLightingIntentSnapshot();
  const music = engine.getMusicIntentSnapshot();
  engine.dispose();
  const store = (expectedMusicTargetIds = ['music.room']) =>
    new LightingIntentStore({
      filePath,
      expectedDeviceIds: [],
      knownSceneIds: [],
      expectedMusicTargetIds,
      debounceMs: 60_000,
      onWarning: vi.fn(),
    });
  return { directory, filePath, snapshot, music, store };
}

it('accepts legacy lighting-only version1 without manufacturing music intent', async () => {
  const f = await fixture();
  await writeFile(
    f.filePath,
    JSON.stringify({ version: 1, snapshot: f.snapshot }),
  );
  const store = f.store();
  await expect(store.load()).resolves.toEqual(f.snapshot);
  expect(store.restoredMusicIntent).toBeUndefined();
});

it.each([
  'bad version',
  'extra state',
  'nonhuman pause',
  'invalid hold',
  'wrong target',
] as const)('retains valid lighting when music has %s', async (scenario) => {
  const f = await fixture();
  const music = structuredClone(f.music);
  const target = music.targets['music.room']!;
  const invalid: unknown =
    scenario === 'bad version'
      ? { ...music, version: 99 }
      : scenario === 'extra state'
        ? { ...music, observed: { playback: 'playing' } }
        : scenario === 'wrong target'
          ? { ...music, targets: { 'music.other': target } }
          : scenario === 'nonhuman pause'
            ? {
                ...music,
                targets: {
                  'music.room': {
                    ...target,
                    pause: {
                      createdAt: 10_000,
                      provenance: { actor: { type: 'automation' } },
                    },
                  },
                },
              }
            : {
                ...music,
                targets: {
                  'music.room': {
                    ...target,
                    manualVolume: { ...target.manualVolume, expiresAt: -1 },
                  },
                },
              };
  await writeFile(
    f.filePath,
    JSON.stringify({ version: 2, snapshot: f.snapshot, music: invalid }),
  );
  const store = f.store();
  await expect(store.load()).resolves.toEqual(f.snapshot);
  expect(store.restoredMusicIntent).toBeUndefined();
});

it('validates music independently from mismatched lighting and returns defensive clones', async () => {
  const f = await fixture();
  await writeFile(
    f.filePath,
    JSON.stringify({
      version: 2,
      snapshot: { ...f.snapshot, sceneRevision: -1 },
      music: f.music,
    }),
  );
  const store = f.store();
  await expect(store.load()).resolves.toBeUndefined();
  expect(store.restoredMusicIntent).toEqual(f.music);
  const copy = store.restoredMusicIntent!;
  copy.targets['music.room']!.manualVolume!.volume = 0;
  expect(store.restoredMusicIntent).toEqual(f.music);
});

it('rejects configured music target mismatch without discarding valid lighting', async () => {
  const f = await fixture();
  await writeFile(
    f.filePath,
    JSON.stringify({ version: 2, snapshot: f.snapshot, music: f.music }),
  );
  const store = f.store([]);
  await expect(store.load()).resolves.toEqual(f.snapshot);
  expect(store.restoredMusicIntent).toBeUndefined();
});

it('writes private atomic version2 intent and preserves last valid music if new music is malformed', async () => {
  const f = await fixture();
  const store = f.store();
  let snapshot = f.snapshot;
  let music: unknown = f.music;
  let notify: ((update: { domains: string[] }) => void) | undefined;
  const source: LightingIntentSource = {
    getLightingIntentSnapshot: () => snapshot,
    getMusicIntentSnapshot: () => music as typeof f.music,
    stream: {
      subscribe(listener) {
        notify = listener;
        return () => {};
      },
    },
  };
  store.start(source);
  try {
    await store.flush();
    expect((await stat(f.filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(f.directory)).mode & 0o777).toBe(0o700);
    const first = JSON.parse(await readFile(f.filePath, 'utf8'));
    expect(first).toEqual({ version: 2, snapshot: f.snapshot, music: f.music });
    snapshot = { ...snapshot, sceneRevision: 2 };
    music = { ...f.music, commands: [] };
    notify?.({ domains: ['intent'] });
    await store.flush();
    expect(JSON.parse(await readFile(f.filePath, 'utf8'))).toEqual({
      version: 2,
      snapshot,
      music: f.music,
    });
  } finally {
    await store.stop();
  }
});

it('persists human intent from music/intent events even after rejected dispatch', async () => {
  const f = await fixture();
  const clock = new FakeClock(10_000);
  const engine = new LugnEngine(clock, {
    deviceIds: [],
    scenes: [],
    music: {
      targets: { 'music.room': [] },
      adapter: {
        subscribe: () => () => {},
        dispatch: async () => {
          throw new Error('offline');
        },
      },
    },
  });
  const store = f.store();
  store.start(engine);
  try {
    await expect(
      engine.requestMusic('music.room', { property: 'volume', value: 1 }, user),
    ).rejects.toThrow();
    await expect(
      engine.requestMusic(
        'music.room',
        { property: 'playback', value: 'paused' },
        user,
      ),
    ).rejects.toThrow();
    await store.flush();
    const reloaded = f.store();
    await reloaded.load();
    expect(reloaded.restoredMusicIntent?.targets['music.room']).toMatchObject({
      manualVolume: { volume: 1 },
      pause: { createdAt: 10_000, provenance: user },
    });
  } finally {
    await store.stop();
    engine.dispose();
  }
});
