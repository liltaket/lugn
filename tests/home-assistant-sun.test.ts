import { describe, expect, it } from 'vitest';
import { HomeAssistantSunAdapter } from '../src/adapters/home-assistant-sun.js';

describe('Home Assistant sun observations', () => {
  it('accepts seed and events, ignores invalid and stale values', () => {
    const seen: number[] = [];
    const adapter = new HomeAssistantSunAdapter((value) => seen.push(value));
    const state = (elevation: unknown, last_updated: string) => ({
      entity_id: 'sun.sun',
      state: 'above_horizon',
      attributes: { elevation },
      last_updated,
    });
    adapter.acceptState(state(4, '2026-01-02T00:00:00Z'));
    adapter.acceptState(state(-5, '2026-01-01T00:00:00Z'));
    adapter.acceptEvent({
      event_type: 'state_changed',
      data: {
        entity_id: 'sun.sun',
        new_state: state(-1, '2026-01-03T00:00:00Z'),
      },
    });
    adapter.acceptState(state(null, '2026-01-04T00:00:00Z'));
    expect(seen).toEqual([4, -1]);
  });
});
