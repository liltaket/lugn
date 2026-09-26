import { PresenceEventSchema, type PresenceEvent } from '../core/schemas.js';

/** A transport-neutral boundary for already-normalized presence events. */
export class PresenceEventIngress {
  constructor(
    private readonly handle: (event: PresenceEvent) => Promise<void>,
  ) {}

  accept(input: unknown): Promise<void> {
    const event = PresenceEventSchema.parse(input);
    return this.handle(event);
  }
}
