import {
  PresenceInputEventSchema,
  type PresenceInputEvent,
} from '../core/schemas.js';

/** A transport-neutral boundary for already-normalized presence events. */
export class PresenceEventIngress {
  constructor(
    private readonly handle: (event: PresenceInputEvent) => Promise<void>,
  ) {}

  accept(input: unknown): Promise<void> {
    const event = PresenceInputEventSchema.parse(input);
    if (
      event.localReceivedMonotonicAt !== undefined &&
      event.source !== 'stl27l'
    ) {
      throw new Error(
        'Local MQTT receive timing is only valid for STL27L events',
      );
    }
    return this.handle(event);
  }
}
