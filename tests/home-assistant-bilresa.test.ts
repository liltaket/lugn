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

function stateChangedFrame(entityId: string, gesture: string) {
  return {
    type: 'event',
    id: 1,
    event: {
      event_type: 'state_changed',
      data: {
        entity_id: entityId,
        new_state: {
          entity_id: entityId,
          attributes: { event_type: gesture },
        },
      },
    },
  };
}

describe('Home Assistant BILRESA adapter', () => {
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

    for (const { entityId, button } of controllerEntities) {
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
