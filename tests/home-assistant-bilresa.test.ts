import { describe, expect, it } from 'vitest';
import {
  HomeAssistantBilresaAdapter,
  type HomeAssistantBilresaEvent,
} from '../src/adapters/home-assistant-bilresa.js';
import { FakeClock } from '../src/core/clock.js';

const controllerEntities = [
  { entityId: 'event.bilresa_dual_button_knapp_1', button: '1' },
  { entityId: 'event.bilresa_dual_button_knapp_1_2', button: '1' },
  { entityId: 'event.bilresa_dual_button_knapp_2', button: '2' },
  { entityId: 'event.bilresa_dual_button_knapp_2_2', button: '2' },
] as const;

const supportedGestures = [
  'multi_press_1',
  'multi_press_2',
  'long_press',
] as const;

let eventSequence = 0;

function stateChangedFrame(entityId: string, gesture: string) {
  const timestamp =
    Date.parse('2026-10-03T18:00:00.000+00:00') + ++eventSequence;
  return {
    type: 'event',
    id: 1,
    event: {
      event_type: 'state_changed',
      time_fired: new Date(timestamp).toISOString(),
      data: {
        entity_id: entityId,
        old_state: {
          entity_id: entityId,
          state: new Date(timestamp - 1).toISOString(),
          attributes: { event_type: gesture },
        },
        new_state: {
          entity_id: entityId,
          state: new Date(timestamp).toISOString(),
          attributes: { event_type: gesture },
        },
      },
    },
  };
}

describe('Home Assistant BILRESA adapter', () => {
  const entityId = controllerEntities[0].entityId;
  const beforeEventAt = '2026-10-03T17:59:00.000+00:00';
  const eventAt = '2026-10-03T18:00:00.000+00:00';
  const nextEventAt = '2026-10-03T18:00:01.000+00:00';
  const state = (timestamp: string, eventType = 'multi_press_1') => ({
    entity_id: entityId,
    state: timestamp,
    attributes: { event_type: eventType },
  });
  const frame = (oldState: unknown, newState: unknown) => ({
    type: 'event',
    id: 1,
    event: {
      event_type: 'state_changed',
      data: { entity_id: entityId, old_state: oldState, new_state: newState },
    },
  });

  it('ignores restoration on first observation and delivers the next real press', () => {
    const delivered: HomeAssistantBilresaEvent[] = [];
    const adapter = new HomeAssistantBilresaAdapter(
      {},
      new FakeClock(0),
      (e) => {
        delivered.push(e);
      },
    );
    expect(adapter.acceptStateChangedFrame(frame(null, state(eventAt)))).toBe(
      false,
    );
    expect(
      adapter.acceptStateChangedFrame(
        frame(state(eventAt), state(nextEventAt)),
      ),
    ).toBe(true);
    expect(delivered).toHaveLength(1);
  });

  it('accepts the first physical event from a never-pressed unknown entity', () => {
    const delivered: HomeAssistantBilresaEvent[] = [];
    const adapter = new HomeAssistantBilresaAdapter(
      {},
      new FakeClock(0),
      (e) => {
        delivered.push(e);
      },
    );
    expect(
      adapter.acceptStateChangedFrame(
        frame(state('unknown', ''), state(eventAt)),
      ),
    ).toBe(true);
    expect(delivered).toHaveLength(1);
  });

  it('learns the old timestamp while becoming unavailable even without a gesture', () => {
    const delivered: HomeAssistantBilresaEvent[] = [];
    const adapter = new HomeAssistantBilresaAdapter(
      {},
      new FakeClock(0),
      (e) => {
        delivered.push(e);
      },
    );
    const unavailable = {
      entity_id: entityId,
      state: 'unavailable',
      attributes: { friendly_name: 'BILRESA' },
    };
    expect(
      adapter.acceptStateChangedFrame(frame(state(eventAt), unavailable)),
    ).toBe(false);
    expect(
      adapter.acceptStateChangedFrame(frame(unavailable, state(eventAt))),
    ).toBe(false);
    expect(
      adapter.acceptStateChangedFrame(frame(unavailable, state(nextEventAt))),
    ).toBe(true);
    expect(delivered).toHaveLength(1);
  });

  it('treats recovery without an observed event baseline as historical', () => {
    const adapter = new HomeAssistantBilresaAdapter(
      {},
      new FakeClock(0),
      () => {
        throw new Error('Recovery is not a press');
      },
    );
    expect(
      adapter.acceptStateChangedFrame(
        frame(state('unavailable', ''), state(eventAt)),
      ),
    ).toBe(false);
  });

  it('ignores attribute-only updates, duplicate deliveries, and older event timestamps', () => {
    const delivered: HomeAssistantBilresaEvent[] = [];
    const adapter = new HomeAssistantBilresaAdapter(
      {},
      new FakeClock(0),
      (e) => {
        delivered.push(e);
      },
    );
    const genuine = frame(state(beforeEventAt), state(eventAt));
    expect(adapter.acceptStateChangedFrame(genuine)).toBe(true);
    expect(adapter.acceptStateChangedFrame(genuine)).toBe(false);
    expect(
      adapter.acceptStateChangedFrame(
        frame(state(eventAt), {
          ...state(eventAt),
          attributes: {
            event_type: 'multi_press_2',
            friendly_name: 'Desk remote',
          },
        }),
      ),
    ).toBe(false);
    expect(
      adapter.acceptStateChangedFrame(
        frame(state(beforeEventAt), state(beforeEventAt)),
      ),
    ).toBe(false);
    expect(delivered).toHaveLength(1);
  });

  it('normalizes equivalent offsets and keeps distinct submillisecond timestamps', () => {
    const delivered: HomeAssistantBilresaEvent[] = [];
    const adapter = new HomeAssistantBilresaAdapter(
      {},
      new FakeClock(0),
      (e) => {
        delivered.push(e);
      },
    );
    expect(
      adapter.acceptStateChangedFrame(
        frame(state('2026-10-03T20:00:00.000+02:00'), state(eventAt)),
      ),
    ).toBe(false);
    expect(
      adapter.acceptStateChangedFrame(
        frame(state(eventAt), state('2026-10-03T18:00:00.000001+00:00')),
      ),
    ).toBe(true);
    expect(
      adapter.acceptStateChangedFrame(
        frame(
          state('2026-10-03T18:00:00.000001+00:00'),
          state('2026-10-03T18:00:00.000002+00:00'),
        ),
      ),
    ).toBe(true);
    expect(delivered).toHaveLength(2);
  });

  it.each(['not-a-timestamp', 'unknown', 'unavailable'])(
    'rejects a gesture with non-event state %s',
    (timestamp) => {
      const adapter = new HomeAssistantBilresaAdapter(
        {},
        new FakeClock(0),
        () => {
          throw new Error('Non-event state is not a press');
        },
      );
      expect(
        adapter.acceptStateChangedFrame(
          frame(state(beforeEventAt), state(timestamp)),
        ),
      ).toBe(false);
    },
  );

  it('maps both physical controller entity pairs to the correct logical button and gestures', () => {
    const clock = new FakeClock(1_000);
    const delivered: Array<{
      button: string;
      gesture: string;
      entityId: string;
    }> = [];
    const adapter = new HomeAssistantBilresaAdapter({}, clock, (event) => {
      delivered.push(event);
    });

    for (const { entityId } of controllerEntities) {
      for (const gesture of supportedGestures) {
        expect(
          adapter.acceptStateChangedFrame(stateChangedFrame(entityId, gesture)),
        ).toBe(true);
      }
    }

    expect(delivered).toHaveLength(
      controllerEntities.length * supportedGestures.length,
    );
    for (const [index, { entityId, button }] of controllerEntities.entries()) {
      const events = delivered.slice(
        index * supportedGestures.length,
        (index + 1) * supportedGestures.length,
      );
      expect(events).toEqual(
        supportedGestures.map((gesture) => ({
          button,
          gesture,
          entityId,
          observedAt: 1_000,
        })),
      );
    }
  });

  it('maps Home Assistant long_release events to the engine long_press action for both controllers', () => {
    const clock = new FakeClock(3_000);
    const delivered: HomeAssistantBilresaEvent[] = [];
    const adapter = new HomeAssistantBilresaAdapter({}, clock, (event) => {
      delivered.push(event);
    });

    for (const [index, { entityId, button }] of controllerEntities.entries()) {
      if (index > 0) clock.advanceBy(101);
      expect(
        adapter.acceptStateChangedFrame(
          stateChangedFrame(entityId, 'long_release'),
        ),
      ).toBe(true);
      expect(delivered.at(-1)).toMatchObject({
        button,
        gesture: 'long_press',
        entityId,
      });
    }

    expect(delivered).toHaveLength(controllerEntities.length);
  });

  it('deduplicates a mirrored event only across different entities, while accepting repeated presses from one entity', () => {
    const clock = new FakeClock(2_000);
    const delivered: Array<{
      button: string;
      gesture: string;
      entityId: string;
    }> = [];
    const adapter = new HomeAssistantBilresaAdapter({}, clock, (event) => {
      delivered.push(event);
    });
    const firstController = 'event.bilresa_dual_button_knapp_1';
    const mirroredController = 'event.bilresa_dual_button_knapp_1_2';
    const gesture = 'multi_press_1';

    expect(
      adapter.acceptStateChangedFrame(
        stateChangedFrame(firstController, gesture),
      ),
    ).toBe(true);

    clock.advanceBy(50);
    expect(
      adapter.acceptStateChangedFrame(
        stateChangedFrame(mirroredController, gesture),
      ),
    ).toBe(false);

    expect(
      adapter.acceptStateChangedFrame(
        stateChangedFrame(firstController, gesture),
      ),
    ).toBe(true);

    expect(delivered.map((event) => event.entityId)).toEqual([
      firstController,
      firstController,
    ]);
  });

  it('deduplicates mirrored long_release events after normalizing them to long_press', () => {
    const clock = new FakeClock(4_000);
    const delivered: HomeAssistantBilresaEvent[] = [];
    const adapter = new HomeAssistantBilresaAdapter({}, clock, (event) => {
      delivered.push(event);
    });
    const firstController = 'event.bilresa_dual_button_knapp_2';
    const mirroredController = 'event.bilresa_dual_button_knapp_2_2';

    expect(
      adapter.acceptStateChangedFrame(
        stateChangedFrame(firstController, 'long_release'),
      ),
    ).toBe(true);
    clock.advanceBy(50);
    expect(
      adapter.acceptStateChangedFrame(
        stateChangedFrame(mirroredController, 'long_release'),
      ),
    ).toBe(false);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      button: '2',
      gesture: 'long_press',
      entityId: firstController,
    });
  });

  it('ignores a paired long_release after long_press across mirrored entities, then accepts one after the bounded window', () => {
    const clock = new FakeClock(5_000);
    const delivered: HomeAssistantBilresaEvent[] = [];
    const adapter = new HomeAssistantBilresaAdapter({}, clock, (event) => {
      delivered.push(event);
    });
    const firstController = 'event.bilresa_dual_button_knapp_1';
    const mirroredController = 'event.bilresa_dual_button_knapp_1_2';

    expect(
      adapter.acceptStateChangedFrame(
        stateChangedFrame(firstController, 'long_press'),
      ),
    ).toBe(true);
    clock.advanceBy(750);
    expect(
      adapter.acceptStateChangedFrame(
        stateChangedFrame(mirroredController, 'long_release'),
      ),
    ).toBe(false);
    clock.advanceBy(50);
    expect(
      adapter.acceptStateChangedFrame(
        stateChangedFrame(firstController, 'long_release'),
      ),
    ).toBe(false);
    expect(delivered).toHaveLength(1);

    clock.advanceBy(4_201);
    expect(
      adapter.acceptStateChangedFrame(
        stateChangedFrame(firstController, 'long_release'),
      ),
    ).toBe(true);
    expect(delivered).toHaveLength(2);
    expect(delivered.map((event) => event.gesture)).toEqual([
      'long_press',
      'long_press',
    ]);
  });
});
