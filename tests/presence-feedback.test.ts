import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChimePlayer,
  ChimeUnavailableError,
  renderChime,
  warmChimes,
} from '../src/adapters/chime-player.js';
import {
  CapabilityInputError,
  CapabilityRegistry,
} from '../src/application/capabilities.js';
import { LugnEngine } from '../src/application/lugn-engine.js';
import {
  PresenceFeedback,
  type PresenceChime,
} from '../src/application/presence-feedback.js';
import { FakeClock } from '../src/core/clock.js';
import {
  defaultPresenceFeedbackSettings,
  type ChimeKind,
  type PresenceFeedbackSettings,
} from '../src/core/presence-feedback.js';
import type { PresenceInputEvent } from '../src/core/schemas.js';
import { PresenceFeedbackSettingsStore } from '../src/runtime/presence-feedback-settings-store.js';

const changed = (
  presence: 'occupied' | 'confirmed_empty' | 'unknown',
  personCount: number | null = presence === 'occupied'
    ? 1
    : presence === 'unknown'
      ? null
      : 0,
): PresenceInputEvent => ({
  type: 'presence.changed',
  presence,
  personCount,
  source: 'stl27l',
});

const settings = ({
  exitGraceSeconds = 20,
  ...chime
}: Partial<PresenceFeedbackSettings['chime']> & {
  exitGraceSeconds?: number;
} = {}): PresenceFeedbackSettings => ({
  exitGraceSeconds,
  chime: { ...defaultPresenceFeedbackSettings.chime, enabled: true, ...chime },
});

function feedbackFixture(initial: PresenceFeedbackSettings = settings()) {
  const clock = new FakeClock(0);
  const log: string[] = [];
  const chime: PresenceChime = {
    play: (kind, volume, style) => log.push(`chime:${kind}:${volume}:${style}`),
    test: async () => undefined,
  };
  const saved: PresenceFeedbackSettings[] = [];
  const feedback = new PresenceFeedback({
    clock,
    chime,
    initial,
    forward: (event) =>
      log.push(
        event.type === 'presence.changed'
          ? `engine:${event.presence}`
          : event.type,
      ),
    save: async (next) => {
      saved.push(next);
      return next;
    },
  });
  return { clock, log, feedback, saved };
}

describe('presence feedback', () => {
  it('chimes on a sensor-confirmed exit while Lugn is still waiting', () => {
    const { clock, log, feedback } = feedbackFixture();
    feedback.accept(changed('occupied'));
    feedback.accept(changed('confirmed_empty'));
    expect(log).toEqual(['engine:occupied', 'chime:exit:0.3:glass']);
    expect(feedback.pendingExitUntil).toBe(20_000);
    clock.advanceBy(20_000);
    expect(log).toEqual([
      'engine:occupied',
      'chime:exit:0.3:glass',
      'engine:confirmed_empty',
    ]);
  });

  it('hands the event to the engine before the chime is scheduled', () => {
    const { log, feedback } = feedbackFixture(
      settings({ exitGraceSeconds: 0 }),
    );
    feedback.accept(changed('occupied'));
    feedback.accept(changed('confirmed_empty'));
    feedback.accept(changed('occupied'));
    expect(log).toEqual([
      'engine:occupied',
      'engine:confirmed_empty',
      'chime:exit:0.3:glass',
      'engine:occupied',
      'chime:entry:0.3:glass',
    ]);
  });

  it('is silent for first reports, unknown, repeats and prelight', () => {
    const { log, feedback } = feedbackFixture();
    feedback.accept(changed('confirmed_empty'));
    feedback.accept(changed('unknown'));
    feedback.accept(changed('confirmed_empty'));
    feedback.accept({ type: 'presence.prelight', active: true });
    feedback.accept(changed('occupied'));
    expect(log.filter((line) => line.startsWith('chime'))).toEqual([
      'chime:entry:0.3:glass',
    ]);
    feedback.accept(changed('occupied'));
    feedback.accept(changed('unknown'));
    feedback.accept(changed('occupied'));
    expect(log.filter((line) => line.startsWith('chime'))).toHaveLength(1);
  });

  it('chimes on a change in the count while the room stays occupied', () => {
    const { log, feedback } = feedbackFixture(
      settings({ exitGraceSeconds: 0 }),
    );
    feedback.accept(changed('occupied', 1));
    feedback.accept(changed('occupied', 2));
    feedback.accept(changed('occupied', 1));
    feedback.accept(changed('occupied', 1));
    expect(log.filter((line) => line.startsWith('chime'))).toEqual([
      'chime:entry:0.3:glass',
      'chime:exit:0.3:glass',
    ]);
  });

  it('does not compare counts across a dropout', () => {
    const { log, feedback } = feedbackFixture(
      settings({ exitGraceSeconds: 0 }),
    );
    feedback.accept(changed('occupied', 2));
    feedback.accept(changed('unknown'));
    feedback.accept(changed('occupied', 1));
    expect(log.filter((line) => line.startsWith('chime'))).toEqual([]);
  });

  it('honours the master switch and the per-direction switches', () => {
    const off = feedbackFixture(settings({ enabled: false }));
    off.feedback.accept(changed('confirmed_empty'));
    off.feedback.accept(changed('occupied'));
    expect(off.log.some((line) => line.startsWith('chime'))).toBe(false);

    const exitOnly = feedbackFixture(
      settings({ entry: false, exitGraceSeconds: 0 }),
    );
    exitOnly.feedback.accept(changed('confirmed_empty'));
    exitOnly.feedback.accept(changed('occupied'));
    exitOnly.feedback.accept(changed('confirmed_empty'));
    expect(exitOnly.log.filter((line) => line.startsWith('chime'))).toEqual([
      'chime:exit:0.3:glass',
    ]);
  });

  it('persists settings before applying them and re-times a held exit', async () => {
    const { clock, log, feedback, saved } = feedbackFixture();
    feedback.accept(changed('occupied'));
    feedback.accept(changed('confirmed_empty'));
    await feedback.updateSettings(settings({ exitGraceSeconds: 5 }));
    expect(saved).toHaveLength(1);
    expect(feedback.getSettings().exitGraceSeconds).toBe(5);
    clock.advanceBy(5_000);
    expect(log.at(-1)).toBe('engine:confirmed_empty');
  });

  it('keeps the old settings when saving fails', async () => {
    const clock = new FakeClock(0);
    const feedback = new PresenceFeedback({
      clock,
      forward: () => undefined,
      save: async () => {
        throw new Error('disk');
      },
    });
    await expect(
      feedback.updateSettings(settings({ exitGraceSeconds: 5 })),
    ).rejects.toThrow('disk');
    expect(feedback.getSettings()).toEqual(defaultPresenceFeedbackSettings);
  });

  it('rejects out-of-range settings', async () => {
    const { feedback } = feedbackFixture();
    await expect(
      feedback.updateSettings(settings({ exitGraceSeconds: 601 })),
    ).rejects.toThrow();
    await expect(
      feedback.updateSettings(settings({ volume: 1.5 })),
    ).rejects.toThrow();
  });
});

describe('exit grace state in the engine', () => {
  it('shows the wait and clears it on whatever the sensor reports next', async () => {
    for (const next of ['occupied', 'confirmed_empty', 'unknown'] as const) {
      const clock = new FakeClock(5_000);
      const engine = new LugnEngine(clock, { deviceIds: [], scenes: [] });
      await engine.handleEvent(changed('occupied'));
      expect(engine.state.presence).not.toHaveProperty('exitPending');
      engine.setPresenceExitPending({ startedAt: 5_000, until: 25_000 });
      expect(engine.state.presence.exitPending).toEqual({
        startedAt: 5_000,
        until: 25_000,
      });
      // Presence itself is untouched while Lugn waits.
      expect(engine.state.presence.state).toBe('occupied');
      expect(
        engine.state.diagnostics.some(
          (entry) => entry.kind === 'presence.exit_pending',
        ),
      ).toBe(true);
      await engine.handleEvent(changed(next));
      expect(engine.state.presence).not.toHaveProperty('exitPending');
      engine.dispose();
    }
  });

  it('publishes the wait so dashboards update', async () => {
    const engine = new LugnEngine(new FakeClock(0), {
      deviceIds: [],
      scenes: [],
    });
    await engine.handleEvent(changed('occupied'));
    const patches: unknown[] = [];
    const unsubscribe = engine.stream.subscribe((update) => {
      if (update.domains.includes('presence'))
        patches.push(update.patch.presence);
    });
    engine.setPresenceExitPending({ startedAt: 0, until: 9_000 });
    unsubscribe();
    expect(patches).toMatchObject([
      { exitPending: { startedAt: 0, until: 9_000 } },
    ]);
    engine.dispose();
  });
});

describe('capabilities', () => {
  const invocation = { actor: { type: 'user' as const, id: 'ui' } };

  it('reads, updates and auditions through typed capabilities', async () => {
    const engine = new LugnEngine(new FakeClock(0));
    const tests: Array<[ChimeKind, number | undefined, string]> = [];
    const feedback = new PresenceFeedback({
      clock: new FakeClock(0),
      forward: () => undefined,
      save: async (next) => next,
      chime: {
        play: () => undefined,
        test: async (kind, volume, style) => {
          tests.push([kind, volume, style]);
        },
      },
    });
    const registry = new CapabilityRegistry(engine, {
      presenceFeedback: feedback,
    });
    const read = await registry.invoke(
      'presence.getFeedbackSettings',
      {},
      invocation,
    );
    expect(read.settings).toEqual(defaultPresenceFeedbackSettings);
    expect(read.defaults).toEqual(defaultPresenceFeedbackSettings);
    const next = settings({ volume: 0.15 });
    await expect(
      registry.invoke(
        'presence.updateFeedbackSettings',
        { settings: next },
        invocation,
      ),
    ).resolves.toEqual({ settings: next });
    await registry.invoke(
      'presence.testChime',
      { kind: 'exit', volume: 0.5, style: 'tick' },
      invocation,
    );
    await registry.invoke('presence.testChime', { kind: 'entry' }, invocation);
    // Without a volume or style the saved ones are used.
    expect(tests).toEqual([
      ['exit', 0.5, 'tick'],
      ['entry', 0.15, 'glass'],
    ]);
    await expect(
      registry.invoke(
        'presence.updateFeedbackSettings',
        { settings: { ...next, extra: 1 } },
        invocation,
      ),
    ).rejects.toThrow();
    engine.dispose();
  });

  it('reports a missing or broken speaker as an input error', async () => {
    const engine = new LugnEngine(new FakeClock(0));
    await expect(
      new CapabilityRegistry(engine).invoke(
        'presence.getFeedbackSettings',
        {},
        invocation,
      ),
    ).rejects.toMatchObject({ code: 'presence_feedback_unavailable' });
    const broken = new CapabilityRegistry(engine, {
      presenceFeedback: new PresenceFeedback({
        clock: new FakeClock(0),
        forward: () => undefined,
        save: async (next) => next,
        chime: {
          play: () => undefined,
          test: async () => {
            throw new ChimeUnavailableError();
          },
        },
      }),
    });
    const failure = broken.invoke(
      'presence.testChime',
      { kind: 'entry' },
      invocation,
    );
    await expect(failure).rejects.toBeInstanceOf(CapabilityInputError);
    await expect(failure).rejects.toMatchObject({ code: 'chime_unavailable' });
    engine.dispose();
  });
});

describe('chime sound', () => {
  const samples = (wav: Buffer) =>
    Array.from({ length: (wav.length - 44) / 2 }, (_, index) =>
      wav.readInt16LE(44 + index * 2),
    );
  const peak = (wav: Buffer) => Math.max(...samples(wav).map(Math.abs));
  const styles = ['glass', 'soft', 'tick'] as const;

  it.each(styles)(
    'renders a valid, short %s blip that starts and ends silent',
    (style) => {
      for (const kind of ['entry', 'exit'] as const) {
        const wav = renderChime(kind, 1, style);
        expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
        expect(wav.toString('ascii', 8, 16)).toBe('WAVEfmt ');
        expect(wav.readUInt16LE(22)).toBe(1);
        expect(wav.readUInt16LE(34)).toBe(16);
        expect(wav.readUInt32LE(24)).toBe(44_100);
        expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
        expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
        // Short enough to stay a blip, quiet enough never to startle.
        expect((wav.length - 44) / 2 / 44_100).toBeLessThan(1.1);
        expect(peak(wav)).toBeLessThanOrEqual(0.6 * 32_767 + 1);
        expect(peak(wav)).toBeGreaterThan(0.55 * 32_767);
        const data = samples(wav);
        expect(data[0]).toBe(0);
        expect(data.at(-1)).toBe(0);
        // The first 20 ms are silence so the DAC can open before the sound.
        expect(Math.max(...data.slice(0, 850).map(Math.abs))).toBe(0);
      }
    },
  );

  it('is equally loud in every style and quieter faster than linearly', () => {
    expect(
      new Set(styles.map((style) => peak(renderChime('entry', 0.5, style))))
        .size,
    ).toBe(1);
    expect(peak(renderChime('exit', 0))).toBe(0);
    expect(peak(renderChime('exit', 0.3))).toBeLessThan(
      0.15 * peak(renderChime('exit', 1)),
    );
    expect(peak(renderChime('exit', 0.5))).toBeGreaterThan(
      peak(renderChime('exit', 0.3)),
    );
  });

  it('sounds different going in and going out', () => {
    expect(renderChime('entry', 0.5).equals(renderChime('exit', 0.5))).toBe(
      false,
    );
    expect(
      renderChime('entry', 0.5, 'glass').equals(
        renderChime('entry', 0.5, 'soft'),
      ),
    ).toBe(false);
  });
});

describe('chime player', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeProcess() {
    const processes: Array<{
      args: string[];
      written: Buffer[];
      emitter: EventEmitter;
    }> = [];
    const spawnProcess = (_command: string, args: string[]): ChildProcess => {
      const emitter = new EventEmitter();
      const record = { args, written: [] as Buffer[], emitter };
      processes.push(record);
      return Object.assign(emitter, {
        stdin: Object.assign(new EventEmitter(), {
          end: (chunk: Buffer) => record.written.push(chunk),
        }),
        kill: () => true,
      }) as unknown as ChildProcess;
    };
    return { processes, spawnProcess };
  }

  it('starts the player after the caller yields and never blocks it', async () => {
    const clock = new FakeClock(0);
    const { processes, spawnProcess } = fakeProcess();
    const player = new ChimePlayer({
      clock,
      spawnProcess,
      audioDevice: 'plughw:1,0',
    });
    player.play('entry', 0.3, 'glass');
    expect(processes).toHaveLength(0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(processes).toHaveLength(1);
    expect(processes[0]!.args).toEqual([
      '-q',
      '-t',
      'wav',
      '-D',
      'plughw:1,0',
      '-',
    ]);
    expect(
      processes[0]!.written[0]!.equals(renderChime('entry', 0.3, 'glass')),
    ).toBe(true);
  });

  it('drops a chime while one is sounding or just ended instead of queueing', async () => {
    const clock = new FakeClock(0);
    const { processes, spawnProcess } = fakeProcess();
    const player = new ChimePlayer({ clock, spawnProcess });
    player.play('entry', 0.3, 'glass');
    player.play('exit', 0.3, 'glass');
    await new Promise((resolve) => setImmediate(resolve));
    expect(processes).toHaveLength(1);
    processes[0]!.emitter.emit('close', 0);
    clock.advanceBy(500);
    player.play('exit', 0.3, 'glass');
    await new Promise((resolve) => setImmediate(resolve));
    expect(processes).toHaveLength(1);
    clock.advanceBy(2_000);
    player.play('exit', 0.3, 'glass');
    await new Promise((resolve) => setImmediate(resolve));
    expect(processes).toHaveLength(2);
  });

  it('warns once per interval when the player fails and keeps working', async () => {
    const clock = new FakeClock(0);
    const { processes, spawnProcess } = fakeProcess();
    const warnings: string[] = [];
    const player = new ChimePlayer({
      clock,
      spawnProcess,
      onWarning: (message) => warnings.push(message),
    });
    player.play('entry', 0.3, 'glass');
    await new Promise((resolve) => setImmediate(resolve));
    processes[0]!.emitter.emit('error', new Error('spawn aplay ENOENT'));
    await new Promise((resolve) => setImmediate(resolve));
    clock.advanceBy(2_000);
    player.play('entry', 0.3, 'glass');
    await new Promise((resolve) => setImmediate(resolve));
    processes[1]!.emitter.emit('close', 1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('ENOENT');
  });

  it('lets the settings page wait for the result', async () => {
    const clock = new FakeClock(0);
    const { processes, spawnProcess } = fakeProcess();
    const player = new ChimePlayer({ clock, spawnProcess });
    const ok = player.test('exit', 0.3, 'glass');
    processes[0]!.emitter.emit('close', 0);
    await expect(ok).resolves.toBeUndefined();
    clock.advanceBy(2_000);
    const failed = player.test('exit', 0.3, 'glass');
    processes[1]!.emitter.emit('close', 1);
    await expect(failed).rejects.toBeInstanceOf(ChimeUnavailableError);
  });
});

describe('presence feedback settings store', () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });
  async function file() {
    const directory = await mkdtemp(join(tmpdir(), 'lugn-feedback-'));
    directories.push(directory);
    return join(directory, 'feedback.json');
  }

  it('starts empty, saves atomically and restores what it saved', async () => {
    const path = await file();
    const store = new PresenceFeedbackSettingsStore(path);
    expect(await store.load()).toBeUndefined();
    const next = settings({ volume: 0.2, exitGraceSeconds: 25 });
    await store.save(next);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: 1,
      settings: next,
    });
    expect(await new PresenceFeedbackSettingsStore(path).load()).toEqual(next);
  });

  it('refuses to overwrite a file it cannot read', async () => {
    const path = await file();
    await writeFile(path, '{ not json');
    const warnings: string[] = [];
    const store = new PresenceFeedbackSettingsStore(path, (message) =>
      warnings.push(message),
    );
    expect(await store.load()).toBeUndefined();
    expect(warnings).toHaveLength(1);
    await expect(store.save(settings())).rejects.toThrow(
      'presence_feedback_save_failed',
    );
    expect(await readFile(path, 'utf8')).toBe('{ not json');
  });
});

describe('chime rendering', () => {
  it('renders a voice quickly enough to never matter on the hot path', () => {
    warmChimes();
    const started = performance.now();
    for (const style of ['glass', 'soft', 'tick'] as const)
      for (const kind of ['entry', 'exit'] as const)
        renderChime(kind, 0.4, style);
    // Pre-rendered voices only need scaling to a volume.
    expect(performance.now() - started).toBeLessThan(250);
  });
});
