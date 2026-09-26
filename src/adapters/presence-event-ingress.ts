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
    return this.handle(event);
  }
}
