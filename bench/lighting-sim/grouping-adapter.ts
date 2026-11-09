import {
  LightingDeliveryUnknownError,
  type LightingAdapter,
  type LightingCommand,
  type LightingObservation,
} from '../../src/adapters/simulated-lighting.js';

/** Structural so the harness still compiles against trees without it. */
export type ServiceCallSocket = {
  callService?(call: {
    domain: string;
    service: string;
    serviceData: Record<string, unknown>;
    target: { entity_id: string | string[] };
  }): Promise<void> | undefined;
};

type Queued = {
  command: LightingCommand;
  resolve: () => void;
  reject: (error: unknown) => void;
};

/**
 * Experiment only: coalesces commands issued in the same synchronous run that
 * carry identical service data into one HA call_service with an entity list.
 * Lamps with special delivery rules (WLED, Cleverio off) keep the inner path.
 */
export class GroupingLightingAdapter implements LightingAdapter {
  private queue: Queued[] = [];

  constructor(
    private readonly inner: LightingAdapter,
    private readonly socket: ServiceCallSocket,
    private readonly entities: Record<string, string>,
    private readonly individual: (command: LightingCommand) => boolean,
  ) {}

  subscribe(listener: (observation: LightingObservation) => void): () => void {
    return this.inner.subscribe(listener);
  }

  dispatch(command: LightingCommand): Promise<void> {
    if (this.individual(command)) return this.inner.dispatch(command);
    return new Promise<void>((resolve, reject) => {
      if (this.queue.length === 0) queueMicrotask(() => this.flush());
      this.queue.push({ command, resolve, reject });
    });
  }

  private flush(): void {
    const queued = this.queue;
    this.queue = [];
    const groups = new Map<string, Queued[]>();
    for (const entry of queued) {
      const key = JSON.stringify(serviceFor(entry.command));
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    for (const group of groups.values()) {
      if (group.length === 1) {
        const [only] = group as [Queued];
        this.inner.dispatch(only.command).then(only.resolve, only.reject);
        continue;
      }
      const { service, serviceData } = serviceFor(group[0]!.command);
      const call = this.socket.callService?.({
        domain: 'light',
        service,
        serviceData,
        target: {
          entity_id: group.map((entry) => this.entities[entry.command.target]!),
        },
      });
      if (!call) {
        for (const entry of group)
          this.inner.dispatch(entry.command).then(entry.resolve, entry.reject);
        continue;
      }
      call.then(
        () => group.forEach((entry) => entry.resolve()),
        () =>
          group.forEach((entry) =>
            entry.reject(
              new LightingDeliveryUnknownError('Grouped light call failed'),
            ),
          ),
      );
    }
  }
}

function serviceFor(command: LightingCommand): {
  service: 'turn_on' | 'turn_off';
  serviceData: Record<string, unknown>;
} {
  if (command.values.power === false)
    return { service: 'turn_off', serviceData: {} };
  const serviceData: Record<string, unknown> = {};
  if (command.values.brightness !== undefined)
    serviceData['brightness_pct'] = command.values.brightness;
  if (command.values.rgb !== undefined)
    serviceData['rgb_color'] = command.values.rgb;
  if (command.values.colorTemperature !== undefined)
    serviceData['color_temp_kelvin'] = command.values.colorTemperature;
  return { service: 'turn_on', serviceData };
}
