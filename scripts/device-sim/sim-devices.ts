import type {
  LightingAdapter,
  LightingCommand,
  LightingObservation,
} from '../../src/adapters/simulated-lighting.js';
import type {
  MusicAdapter,
  MusicCommand,
  MusicObservation,
} from '../../src/adapters/simulated-music.js';
import type { Clock } from '../../src/core/clock.js';
import { mergeLightingValues } from '../../src/core/lighting-feedback.js';
import type {
  Actor,
  LightingValues,
  MusicObservationValues,
} from '../../src/core/schemas.js';

export type Random = () => number;

/** Small deterministic PRNG (mulberry32) so a seed reproduces a run. */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const humanProvenance = {
  actor: { type: 'user' } as Actor,
  source: 'device-sim.wall',
};

/**
 * Lights that answer like real bulbs: feedback arrives after a random delay,
 * a light can drop off the network and come back reporting its last state,
 * and anyone can change a light outside Lugn.
 */
export class SimLights implements LightingAdapter {
  readonly observed = new Map<string, LightingValues>();
  private readonly unavailable = new Set<string>();
  private readonly listeners = new Set<
    (observation: LightingObservation) => void
  >();
  latencyMs: [number, number] = [250, 1_800];
  /** Every dispatch, for tests and the status endpoint. */
  dispatchCount = 0;

  constructor(
    private readonly clock: Clock,
    private readonly random: Random,
  ) {}

  async dispatch(command: LightingCommand): Promise<void> {
    const { isCurrent } = command;
    if (isCurrent && !isCurrent()) return;
    this.dispatchCount += 1;
    if (this.unavailable.has(command.target))
      throw new Error(`${command.target} is unreachable (simulated)`);
    const [min, max] = this.latencyMs;
    await new Promise<void>((resolve) =>
      this.clock.setTimeout(resolve, min + this.random() * (max - min)),
    );
    // The light went away while the request was in flight.
    if (this.unavailable.has(command.target)) return;
    this.observed.set(
      command.target,
      mergeLightingValues(
        this.observed.get(command.target) ?? {},
        command.values,
      ),
    );
    this.emit({
      target: command.target,
      values: command.values,
      commandId: command.id,
      observedAt: this.clock.now(),
    });
  }

  subscribe(listener: (observation: LightingObservation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isAvailable(target: string): boolean {
    return !this.unavailable.has(target);
  }

  /** Drops a light off the network, or brings it back with its last state. */
  setAvailable(target: string, available: boolean): void {
    if (available === !this.unavailable.has(target)) return;
    if (available) {
      this.unavailable.delete(target);
      this.emit({
        target,
        values: { ...(this.observed.get(target) ?? { power: false }) },
        availability: 'available',
        observedAt: this.clock.now(),
      });
    } else {
      this.unavailable.add(target);
      this.emit({
        target,
        values: {},
        availability: 'unavailable',
        observedAt: this.clock.now(),
      });
    }
  }

  /** Reports the current state, as Home Assistant does on startup. */
  report(target: string): void {
    if (this.unavailable.has(target)) return;
    this.emit({
      target,
      values: { ...(this.observed.get(target) ?? { power: false }) },
      availability: 'available',
      observedAt: this.clock.now(),
    });
  }

  /** Someone changed the light outside Lugn (wall switch, vendor app). */
  externalChange(target: string, values: LightingValues): void {
    if (this.unavailable.has(target)) return;
    this.observed.set(
      target,
      mergeLightingValues(this.observed.get(target) ?? {}, values),
    );
    this.emit({
      target,
      values,
      observedAt: this.clock.now(),
      provenance: humanProvenance,
    });
  }

  private emit(observation: LightingObservation): void {
    for (const listener of this.listeners)
      listener(structuredClone(observation));
  }
}

const TRACKS: Array<{ title: string; artist: string; album: string }> = [
  { title: 'Kvällsljus', artist: 'Simulerad Ensemble', album: 'Rummet' },
  { title: 'Långsamma vågor', artist: 'Testorkestern', album: 'Lugnt läge' },
  { title: 'Fönsterbänk', artist: 'Exempelartist', album: 'Skymning' },
  { title: 'Sista tåget', artist: 'Demo Duo', album: 'Natt' },
];

/**
 * A networked speaker. Requests are applied after a short delay and answered
 * with a full observation carrying the command id, like Home Assistant state
 * changes; a person can also use the speaker directly.
 */
export class SimSpeaker implements MusicAdapter {
  private readonly state = new Map<string, MusicObservationValues>();
  private readonly listeners = new Set<
    (observation: MusicObservation) => void
  >();
  private track = 0;
  latencyMs: [number, number] = [300, 1_200];
  available = true;
  dispatchCount = 0;

  constructor(
    private readonly clock: Clock,
    private readonly random: Random,
    targets: readonly string[],
  ) {
    for (const target of targets)
      this.state.set(target, {
        playback: 'idle',
        volume: 0.22,
        source: 'Spotify',
        title: null,
        artist: null,
        album: null,
      });
  }

  async dispatch(command: MusicCommand): Promise<void> {
    this.dispatchCount += 1;
    if (!this.available) throw new Error('speaker unreachable (simulated)');
    const [min, max] = this.latencyMs;
    await new Promise<void>((resolve) =>
      this.clock.setTimeout(resolve, min + this.random() * (max - min)),
    );
    const current = this.values(command.target);
    const request = command.requested;
    let next: MusicObservationValues;
    switch (request.property) {
      case 'playback':
        next = {
          ...current,
          playback: request.value,
          ...(request.value === 'playing' && current.title === null
            ? this.nextTrack()
            : {}),
        };
        break;
      case 'volume':
        next = { ...current, volume: Math.round(request.value * 100) / 100 };
        break;
      case 'source':
        next = { ...current, source: request.value };
        break;
      case 'preset':
        next = {
          ...current,
          playback: 'playing',
          source: request.value === 'optical' ? 'Optical' : 'Spotify',
          ...(request.value === 'optical'
            ? { title: null, artist: null, album: null }
            : this.nextTrack()),
        };
        break;
    }
    this.state.set(command.target, next);
    this.emit(command.target, command.id);
  }

  subscribe(listener: (observation: MusicObservation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  values(target: string): MusicObservationValues {
    return { ...this.state.get(target)! };
  }

  /** Reports the current state, as Home Assistant does on startup. */
  report(target: string): void {
    this.emit(target);
  }

  /** A person used the speaker or its app directly. */
  external(target: string, values: Partial<MusicObservationValues>): void {
    const current = this.values(target);
    const next = { ...current, ...values };
    if (values.playback === 'playing' && current.title === null)
      Object.assign(next, this.nextTrack());
    this.state.set(target, next);
    this.emit(target, undefined, {
      actor: { type: 'user' },
      source: 'device-sim.speaker',
    });
  }

  /** The playing track changes on its own. */
  advanceTrack(target: string): void {
    const current = this.values(target);
    if (current.playback !== 'playing' || current.source !== 'Spotify') return;
    this.state.set(target, { ...current, ...this.nextTrack() });
    this.emit(target);
  }

  private nextTrack() {
    const track = TRACKS[this.track++ % TRACKS.length]!;
    return { ...track };
  }

  private emit(
    target: string,
    commandId?: string,
    provenance?: MusicObservation['provenance'],
  ): void {
    const now = this.clock.now();
    const observation: MusicObservation = {
      target,
      values: this.values(target),
      available: this.available,
      observedAt: now,
      sourceUpdatedAt: now,
      ...(commandId === undefined ? {} : { commandId }),
      ...(provenance === undefined ? {} : { provenance }),
    };
    for (const listener of this.listeners)
      listener(structuredClone(observation));
  }
}
