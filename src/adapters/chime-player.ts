import { spawn, type ChildProcess } from 'node:child_process';
import type { Clock } from '../core/clock.js';
import { systemClock } from '../core/clock.js';
import type { ChimeKind, ChimeStyle } from '../core/presence-feedback.js';

const SAMPLE_RATE = 44_100;
const PLAYBACK_TIMEOUT_MS = 3_000;
const WARNING_INTERVAL_MS = 5 * 60_000;
/** The Pi's DAC needs a moment after the device opens; sound sent earlier is clipped. */
const LEAD_IN_SECONDS = 0.02;
const TAIL_SECONDS = 0.08;

type Voice = {
  /** Fundamental of each note, played in order. */
  notes: Record<ChimeKind, readonly number[]>;
  noteGapSeconds: number;
  attackSeconds: number;
  /** Decay time constant of each note, in the order they are played. */
  decaySeconds: readonly number[];
  /** Overtones as [frequency ratio, amplitude]; ratios off the integers sound bell-like. */
  partials: ReadonlyArray<readonly [number, number]>;
  /** A short darkened echo gives the blip a room to sound in. */
  echoes: ReadonlyArray<readonly [delaySeconds: number, gain: number]>;
};

/** Rising for a visit that starts, falling for one that ends. */
const VOICES: Record<ChimeStyle, Voice> = {
  glass: {
    notes: { entry: [783.99, 1174.66], exit: [987.77, 659.26] },
    noteGapSeconds: 0.11,
    attackSeconds: 0.003,
    decaySeconds: [0.11, 0.18],
    partials: [
      [1, 1],
      [2, 0.22],
      [3, 0.07],
      [4.17, 0.05],
    ],
    echoes: [
      [0.037, 0.26],
      [0.071, 0.16],
      [0.113, 0.09],
    ],
  },
  soft: {
    notes: { entry: [523.25, 783.99], exit: [783.99, 523.25] },
    noteGapSeconds: 0.12,
    attackSeconds: 0.012,
    decaySeconds: [0.13, 0.2],
    partials: [
      [1, 1],
      [2, 0.1],
    ],
    echoes: [[0.05, 0.12]],
  },
  tick: {
    notes: { entry: [1568, 2093], exit: [2093, 1568] },
    noteGapSeconds: 0.07,
    attackSeconds: 0.001,
    decaySeconds: [0.03, 0.04],
    partials: [
      [1, 1],
      [2.76, 0.1],
    ],
    echoes: [],
  },
};

const masters = new Map<string, Float64Array>();

/**
 * One voice rendered at unit peak. Volume only scales it, so it is rendered
 * once per style and kind, ahead of time, and never when a sensor event is
 * waiting. Notes are sines with a few overtones under a fast attack and an
 * exponential decay, mixed through a darkened echo.
 */
function renderMaster(kind: ChimeKind, style: ChimeStyle): Float64Array {
  const key = `${style}:${kind}`;
  const cached = masters.get(key);
  if (cached) return cached;
  const voice = VOICES[style];
  const notes = voice.notes[kind];
  const lastDecay = voice.decaySeconds.at(-1) ?? 0.1;
  const echoSeconds = Math.max(0, ...voice.echoes.map(([delay]) => delay));
  const bodySeconds =
    (notes.length - 1) * voice.noteGapSeconds + lastDecay * 3.5 + echoSeconds;
  const lead = Math.round(LEAD_IN_SECONDS * SAMPLE_RATE);
  const total = lead + Math.round((bodySeconds + TAIL_SECONDS) * SAMPLE_RATE);
  const dry = new Float64Array(total);
  const partials = voice.partials.length;
  const value = new Float64Array(partials);
  const next = new Float64Array(partials);
  const coefficient = new Float64Array(partials);
  notes.forEach((frequency, note) => {
    const start = lead + Math.round(note * voice.noteGapSeconds * SAMPLE_RATE);
    const decay = voice.decaySeconds[note] ?? lastDecay;
    // Each overtone is a recurrence, y[n+1] = 2cos(w)y[n] - y[n-1], so sin is
    // evaluated once per overtone instead of once per sample. That is what
    // keeps a render cheap on a Pi.
    voice.partials.forEach(([ratio], partial) => {
      const step = (2 * Math.PI * frequency * ratio) / SAMPLE_RATE;
      coefficient[partial] = 2 * Math.cos(step);
      value[partial] = 0;
      next[partial] = Math.sin(step);
    });
    const rise = Math.exp(-1 / (voice.attackSeconds * SAMPLE_RATE));
    const fall = Math.exp(-1 / (decay * SAMPLE_RATE));
    let attack = 1;
    let level = 1;
    for (let index = start; index < total; index += 1) {
      const envelope = (1 - attack) * level;
      if (envelope < 1e-4 && (index - start) / SAMPLE_RATE > decay) break;
      let sum = 0;
      for (let partial = 0; partial < partials; partial += 1) {
        sum += voice.partials[partial]![1] * value[partial]!;
        const following =
          coefficient[partial]! * next[partial]! - value[partial]!;
        value[partial] = next[partial]!;
        next[partial] = following;
      }
      dry[index]! += sum * envelope;
      attack *= rise;
      level *= fall;
    }
  });
  const mixed = Float64Array.from(dry);
  for (const [delay, gain] of voice.echoes) {
    const offset = Math.round(delay * SAMPLE_RATE);
    let smoothed = 0;
    for (let index = offset; index < total; index += 1) {
      // One-pole low-pass so each echo is darker than the note it repeats.
      smoothed += 0.3 * (dry[index - offset]! - smoothed);
      mixed[index]! += gain * smoothed;
    }
  }
  // Ease the last 20 ms to zero so the stream never ends on a step.
  const fade = Math.round(0.02 * SAMPLE_RATE);
  for (let index = 0; index < fade; index += 1)
    mixed[total - 1 - index]! *= index / fade;
  let peak = 1e-9;
  for (const sample of mixed) peak = Math.max(peak, Math.abs(sample));
  for (let index = 0; index < total; index += 1) mixed[index]! /= peak;
  masters.set(key, mixed);
  return mixed;
}

/** Renders every voice now, so a sensor event never has to. */
export function warmChimes(): void {
  for (const style of Object.keys(VOICES) as ChimeStyle[])
    for (const kind of ['entry', 'exit'] as const) {
      renderMaster(kind, style);
      // Also warms the code that turns a voice into a WAV at some volume.
      renderChime(kind, 0.3, style);
    }
}

/**
 * Renders a short UI blip in memory, so there is no audio asset to ship. The
 * loudest sample is scaled to a fixed ceiling, so every style is equally loud
 * at the same volume, and the volume is squared so the quiet end of the slider
 * has useful resolution.
 */
export function renderChime(
  kind: ChimeKind,
  volume: number,
  style: ChimeStyle = 'glass',
): Buffer {
  const mixed = renderMaster(kind, style);
  const total = mixed.length;
  const scale = 0.6 * volume * volume * 32_767;
  const wav = Buffer.alloc(44 + total * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + total * 2, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(total * 2, 40);
  // Buffer.alloc is not pooled, so the data starts on an even offset.
  const pcm = new Int16Array(wav.buffer, wav.byteOffset + 44, total);
  for (let index = 0; index < total; index += 1)
    pcm[index] = Math.round(mixed[index]! * scale);
  return wav;
}

export class ChimeUnavailableError extends Error {
  constructor() {
    super('chime_unavailable');
  }
}

export type ChimePlayerOptions = {
  /** ALSA device name passed to `aplay -D`; the system default when absent. */
  audioDevice?: string;
  clock?: Clock;
  spawnProcess?: (command: string, args: string[]) => ChildProcess;
  onWarning?: (message: string) => void;
  /** Blips closer together than this are dropped, not queued. */
  minIntervalMs?: number;
};

/**
 * Plays chimes in a separate `aplay` process so nothing about playback can
 * slow the lighting path. A chime is a courtesy: it is dropped, never
 * queued, while another is still sounding or just ended.
 */
export class ChimePlayer {
  private readonly clock: Clock;
  private readonly minIntervalMs: number;
  private readonly cache = new Map<string, Buffer>();
  private active = false;
  private lastStartedAt = -Infinity;
  private lastWarningAt = -Infinity;

  constructor(private readonly options: ChimePlayerOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.minIntervalMs = options.minIntervalMs ?? 1_500;
  }

  /** Fire and forget. The process starts after the caller's current turn. */
  play(kind: ChimeKind, volume: number, style: ChimeStyle): void {
    if (
      this.active ||
      this.clock.now() - this.lastStartedAt < this.minIntervalMs
    )
      return;
    this.active = true;
    this.lastStartedAt = this.clock.now();
    setImmediate(() => {
      void this.run(kind, volume, style).catch((error: unknown) => {
        this.warn(error);
      });
    });
  }

  /** For the settings page: waits for the result so a broken setup is visible. */
  async test(
    kind: ChimeKind,
    volume: number,
    style: ChimeStyle,
  ): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.lastStartedAt = this.clock.now();
    try {
      await this.run(kind, volume, style);
    } catch {
      throw new ChimeUnavailableError();
    }
  }

  private run(
    kind: ChimeKind,
    volume: number,
    style: ChimeStyle,
  ): Promise<void> {
    const key = `${style}:${kind}:${volume}`;
    let wav = this.cache.get(key);
    if (!wav) {
      if (this.cache.size > 16) this.cache.clear();
      wav = renderChime(kind, volume, style);
      this.cache.set(key, wav);
    }
    const args = [
      '-q',
      '-t',
      'wav',
      ...(this.options.audioDevice ? ['-D', this.options.audioDevice] : []),
      '-',
    ];
    return new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = (this.options.spawnProcess ?? defaultSpawn)('aplay', args);
      } catch (error) {
        this.active = false;
        reject(error);
        return;
      }
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.active = false;
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error('aplay timed out'));
      }, PLAYBACK_TIMEOUT_MS);
      timeout.unref();
      child.once('error', (error) => finish(error));
      child.once('close', (code) =>
        finish(code === 0 ? undefined : new Error(`aplay exited with ${code}`)),
      );
      // A player that exits early closes the pipe; that surfaces through 'close'.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(wav);
    });
  }

  private warn(error: unknown): void {
    const now = this.clock.now();
    if (now - this.lastWarningAt < WARNING_INTERVAL_MS) return;
    this.lastWarningAt = now;
    this.options.onWarning?.(
      `Presence chime could not be played (${error instanceof Error ? error.message : 'unknown error'})`,
    );
  }
}

function defaultSpawn(command: string, args: string[]): ChildProcess {
  return spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
}
