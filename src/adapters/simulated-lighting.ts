import type { Clock } from '../core/clock.js';
import type { Actor, LightingValues } from '../core/schemas.js';

export type LightingObservation = {
  target: string;
  values: LightingValues;
  commandId?: string;
  observedAt: number;
  provenance?: { actor: Actor; source?: string };
};

export type LightingCommand = {
  id: string;
  target: string;
  values: LightingValues;
};

export interface LightingAdapter {
  dispatch(command: LightingCommand): Promise<void>;
  subscribe(listener: (observation: LightingObservation) => void): () => void;
}

export class SimulatedLightingAdapter implements LightingAdapter {
  readonly observed = new Map<string, LightingValues>();
  readonly dispatched: LightingCommand[] = [];
  readonly ignoredCommandIds = new Set<string>();
  readonly ignoreNextForTargets = new Set<string>();
  readonly feedbackDelayByCommandId = new Map<string, number>();
  available = true;
  feedbackDelayMs = 0;
  private readonly listeners = new Set<
    (observation: LightingObservation) => void
  >();

  constructor(private readonly clock: Clock) {}

  async dispatch(command: LightingCommand): Promise<void> {
    this.dispatched.push(structuredClone(command));
    if (!this.available) throw new Error('Simulated adapter is unavailable');
    if (
      this.ignoredCommandIds.has(command.id) ||
      this.ignoreNextForTargets.delete(command.target)
    )
      return;
    const delayMs =
      this.feedbackDelayByCommandId.get(command.id) ?? this.feedbackDelayMs;
    if (delayMs > 0) await delay(this.clock, delayMs);
    const next = { ...this.observed.get(command.target), ...command.values };
    this.observed.set(command.target, next);
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

  setAvailable(available: boolean): void {
    this.available = available;
  }

  externalChange(
    target: string,
    values: LightingValues,
    provenance: { actor: Actor; source?: string } = { actor: { type: 'user' } },
  ): void {
    const next = { ...this.observed.get(target), ...values };
    this.observed.set(target, next);
    this.emit({ target, values, observedAt: this.clock.now(), provenance });
  }

  private emit(observation: LightingObservation): void {
    for (const listener of this.listeners)
      listener(structuredClone(observation));
  }
}

function delay(clock: Clock, milliseconds: number): Promise<void> {
  return new Promise((resolve) => clock.setTimeout(resolve, milliseconds));
}
