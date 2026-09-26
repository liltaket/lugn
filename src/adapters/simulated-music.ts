import type { Clock } from '../core/clock.js';
import type {
  MusicObservationValues,
  MusicRequest,
  Provenance,
} from '../core/schemas.js';

export type MusicCommand = {
  id: string;
  target: string;
  requested: MusicRequest;
};
export type MusicObservation = {
  target: string;
  values: MusicObservationValues;
  available: boolean;
  observedAt: number;
  commandId?: string;
  provenance?: Provenance;
};
export interface MusicAdapter {
  dispatch(command: MusicCommand): Promise<void>;
  subscribe(listener: (observation: MusicObservation) => void): () => void;
}

/** Offline adapter; feedback is explicit so HTTP acceptance cannot imply observation. */
export class SimulatedMusicAdapter implements MusicAdapter {
  readonly dispatched: MusicCommand[] = [];
  private readonly listeners = new Set<
    (observation: MusicObservation) => void
  >();
  constructor(private readonly clock: Clock) {}
  async dispatch(command: MusicCommand): Promise<void> {
    this.dispatched.push(structuredClone(command));
  }
  subscribe(listener: (observation: MusicObservation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  observe(
    target: string,
    values: MusicObservationValues,
    available = true,
    commandId?: string,
  ): void {
    const observation: MusicObservation = {
      target,
      values,
      available,
      observedAt: this.clock.now(),
      ...(commandId === undefined ? {} : { commandId }),
    };
    for (const listener of this.listeners)
      listener(structuredClone(observation));
  }
}
