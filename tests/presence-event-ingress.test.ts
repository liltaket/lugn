import { describe, expect, it, vi } from 'vitest';
import { PresenceEventIngress } from '../src/adapters/presence-event-ingress.js';

describe('PresenceEventIngress', () => {
  it('validates and forwards normalized events without changing unknown to empty', async () => {
    const handle = vi.fn(async () => {});
    const ingress = new PresenceEventIngress(handle);

    await ingress.accept({
      type: 'presence.changed',
      presence: 'unknown',
      personCount: null,
      source: 'room-presence-bridge',
    });

    expect(handle).toHaveBeenCalledWith({
      type: 'presence.changed',
      presence: 'unknown',
      personCount: null,
      source: 'room-presence-bridge',
    });
  });

  it('rejects inputs that do not satisfy the normalized event contract', () => {
    const handle = vi.fn(async () => {});
    const ingress = new PresenceEventIngress(handle);

    expect(() =>
      ingress.accept({ type: 'presence.changed', presence: 'unavailable' }),
    ).toThrow();
    expect(handle).not.toHaveBeenCalled();
  });
});
