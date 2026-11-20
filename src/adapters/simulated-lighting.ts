import { mergeLightingValues } from '../core/lighting-feedback.js';
import type { Clock } from '../core/clock.js';
import type {
  Actor,
  LightingValues,
  GoveeSceneIntent,
  GoveeCapabilities,
  GoveeStaticColor,
} from '../core/schemas.js';

export type LightingObservation = {
  target: string;
  values: LightingValues;
  availability?: 'available' | 'unavailable';
  /** Active device mode invalidates cached metadata from the other mode. */
  colorMode?: 'rgb' | 'color_temp' | 'unknown';
  commandId?: string;
  observedAt: number;
  provenance?: { actor: Actor; source?: string };
};

export type LightingCommand = {
  /** Checked by composite transports before each delayed physical write. */
  isCurrent?: () => boolean;
  /** Internal mode-only rotation step; never repeats baseline power/brightness. */
  goveeOnly?: true;
  govee?: GoveeSceneIntent & {
    controlId: string;
    /** Whole-fixture white/RGB sent with a zones-only mask, never with an effect. */
    staticColor?: GoveeStaticColor;
    /** Fixture reported OFF: light it dimly and mask it before the baseline. */
    stageZones?: true;
    /** Mask Lugn last delivered, kept by the fixture through OFF/ON; only changed toggles are sent. */
    knownZones?: { main: boolean; ring: boolean };
  };
  goveeStatic?: {
    controlId: string;
    color: GoveeStaticColor;
    /** Restores both zones after Lugn last left a zoned fixture partially masked. */
    zones?: { main: boolean; ring: boolean };
  };
  id: string;
  target: string;
  values: LightingValues;
};

/** Delivery is unknown when a request may have reached a device without a usable reply. */
export class LightingDeliveryUnknownError extends Error {
  readonly deliveryOutcome = 'unknown';

  constructor(message: string) {
    super(message);
    this.name = 'LightingDeliveryUnknownError';
  }
}

export function isLightingDeliveryUnknownError(
  error: unknown,
): error is Error & { readonly deliveryOutcome: 'unknown' } {
  return (
    error instanceof Error &&
    'deliveryOutcome' in error &&
    error.deliveryOutcome === 'unknown'
  );
}

export interface LightingAdapter {
  readonly goveeCapabilities?: GoveeCapabilities;
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
    const { isCurrent, ...record } = command;
    if (isCurrent && !isCurrent()) return;
    this.dispatched.push(structuredClone(record));
    if (!this.available) throw new Error('Simulated adapter is unavailable');
    if (
      this.ignoredCommandIds.has(command.id) ||
      this.ignoreNextForTargets.delete(command.target)
    )
      return;
    const delayMs =
      this.feedbackDelayByCommandId.get(command.id) ?? this.feedbackDelayMs;
    if (delayMs > 0) await delay(this.clock, delayMs);
    const next = mergeLightingValues(
      this.observed.get(command.target) ?? {},
      command.values,
    );
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
    const next = mergeLightingValues(this.observed.get(target) ?? {}, values);
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
