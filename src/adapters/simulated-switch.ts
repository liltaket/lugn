import type { Clock } from '../core/clock.js';
import type { Provenance } from '../core/schemas.js';

export type SwitchCommand = { id: string; target: string; state: boolean };
export type SwitchObservation = {
  target: string;
  state: boolean | null;
  available: boolean;
  observedAt: number;
  commandId?: string;
  provenance?: Provenance;
};

export interface SwitchAdapter {
  dispatch(command: SwitchCommand): Promise<void>;
  subscribe(listener: (observation: SwitchObservation) => void): () => void;
}

/** Deterministic switch adapter for demos and offline integration checks. */
export class SimulatedSwitchAdapter implements SwitchAdapter {
  readonly dispatched: SwitchCommand[] = [];
  available = true;
  feedbackEnabled = true;
  private readonly listeners = new Set<
    (observation: SwitchObservation) => void
  >();

  constructor(private readonly clock: Clock) {}

  async dispatch(command: SwitchCommand): Promise<void> {
    this.dispatched.push(structuredClone(command));
    if (!this.available)
      throw new Error('Simulated switch adapter is unavailable');
    if (this.feedbackEnabled)
      this.observe(command.target, command.state, undefined, command.id);
  }

  subscribe(listener: (observation: SwitchObservation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  observe(
    target: string,
    state: boolean | null,
    provenance?: Provenance,
    commandId?: string,
  ): void {
    const observation: SwitchObservation = {
      target,
      state,
      available: state !== null,
      observedAt: this.clock.now(),
      ...(provenance === undefined ? {} : { provenance }),
      ...(commandId === undefined ? {} : { commandId }),
    };
    for (const listener of this.listeners)
      listener(structuredClone(observation));
  }
}
