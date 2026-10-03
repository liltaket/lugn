import { z } from 'zod';
import type { Clock } from '../core/clock.js';

const BilresaEntityIdSchema = z.string().regex(/^event\.[a-z0-9_]+$/);

const DefaultButton1Entities = [
  'event.bilresa_dual_button_knapp_1',
  'event.bilresa_dual_button_knapp_1_2',
] as const;
const DefaultButton2Entities = [
  'event.bilresa_dual_button_knapp_2',
  'event.bilresa_dual_button_knapp_2_2',
] as const;

/** Explicit allowlist of the Home Assistant event entities for each key. */
export const HomeAssistantBilresaConfigSchema = z
  .object({
    button1Entities: z
      .array(BilresaEntityIdSchema)
      .min(1)
      .default([...DefaultButton1Entities]),
    button2Entities: z
      .array(BilresaEntityIdSchema)
      .min(1)
      .default([...DefaultButton2Entities]),
  })
  .strict()
  .superRefine((config, context) => {
    const button1 = new Set(config.button1Entities);
    const button2 = new Set(config.button2Entities);
    if (button1.size !== config.button1Entities.length)
      context.addIssue({
        code: 'custom',
        path: ['button1Entities'],
        message: 'Button 1 entity IDs must be distinct',
      });
    if (button2.size !== config.button2Entities.length)
      context.addIssue({
        code: 'custom',
        path: ['button2Entities'],
        message: 'Button 2 entity IDs must be distinct',
      });
    for (const entityId of config.button2Entities) {
      if (button1.has(entityId)) {
        context.addIssue({
          code: 'custom',
          path: ['button2Entities'],
          message: 'A Home Assistant entity cannot map to both buttons',
        });
        break;
      }
    }
  });

export type HomeAssistantBilresaConfig = z.input<
  typeof HomeAssistantBilresaConfigSchema
>;
export type ResolvedHomeAssistantBilresaConfig = z.output<
  typeof HomeAssistantBilresaConfigSchema
>;

export const BilresaGestureSchema = z.enum([
  'multi_press_1',
  'multi_press_2',
  'long_press',
]);
export type BilresaGesture = z.infer<typeof BilresaGestureSchema>;
export type BilresaButton = '1' | '2';

// Home Assistant reports the completed hold as `long_release` for some
// BILRESA integrations. Lugn's engine consumes the canonical `long_press`
// action, so normalize the HA-specific event name at this adapter boundary.
const HomeAssistantBilresaGestureSchema = z.enum([
  'multi_press_1',
  'multi_press_2',
  'long_press',
  'long_release',
]);

export type HomeAssistantBilresaEvent = {
  button: BilresaButton;
  gesture: BilresaGesture;
  entityId: string;
  observedAt: number;
};

const StateSchema = z.object({
  entity_id: BilresaEntityIdSchema,
  attributes: z.object({ event_type: z.unknown() }).passthrough().optional(),
});
const EventDataSchema = z.object({
  entity_id: BilresaEntityIdSchema,
  new_state: StateSchema.nullable(),
});
const StateChangedFrameSchema = z.object({
  type: z.literal('event'),
  id: z.number().int().positive(),
  event: z.object({
    event_type: z.literal('state_changed'),
    data: EventDataSchema,
  }),
});

const DefaultMirrorWindowMs = 100;
const LongPressReleaseDuplicateWindowMs = 5_000;
const MirrorWindowMsSchema = z.number().int().positive().max(500);

/**
 * Extracts the two physical keys from the HA event entities. Mirrored HA
 * entities for a key are deduplicated only across different entity IDs; a
 * successive event from the same entity is always emitted.
 */
export class HomeAssistantBilresaAdapter {
  private readonly buttonByEntity: Map<string, BilresaButton>;
  private readonly lastGestureByButton = new Map<
    BilresaButton,
    { gesture: BilresaGesture; entityId: string; receivedAt: number }
  >();
  private readonly lastLongPressByButton = new Map<
    BilresaButton,
    { entityId: string; receivedAt: number }
  >();
  private readonly mirrorWindowMs: number;

  constructor(
    config: HomeAssistantBilresaConfig,
    private readonly clock: Clock,
    private readonly onEvent: (event: HomeAssistantBilresaEvent) => void,
    mirrorWindowMs = DefaultMirrorWindowMs,
  ) {
    const parsed = HomeAssistantBilresaConfigSchema.parse(config);
    this.mirrorWindowMs = MirrorWindowMsSchema.parse(mirrorWindowMs);
    this.buttonByEntity = new Map([
      ...parsed.button1Entities.map((entityId): [string, BilresaButton] => [
        entityId,
        '1',
      ]),
      ...parsed.button2Entities.map((entityId): [string, BilresaButton] => [
        entityId,
        '2',
      ]),
    ]);
  }

  /** Returns true only when a supported gesture was delivered to the callback. */
  acceptStateChangedFrame(payload: unknown): boolean {
    const parsed = StateChangedFrameSchema.safeParse(payload);
    if (!parsed.success) return false;

    const { entity_id: entityId, new_state: newState } = parsed.data.event.data;
    const button = this.buttonByEntity.get(entityId);
    if (!button || !newState || newState.entity_id !== entityId) return false;

    const rawGesture = newState.attributes?.event_type;
    if (typeof rawGesture !== 'string') return false;
    const parsedGesture = HomeAssistantBilresaGestureSchema.safeParse(
      rawGesture.trim().toLowerCase(),
    );
    if (!parsedGesture.success) return false;
    const gesture: BilresaGesture =
      parsedGesture.data === 'long_release' ? 'long_press' : parsedGesture.data;

    const observedAt = this.clock.now();
    const receivedAt = this.clock.monotonicNow();
    const previous = this.lastGestureByButton.get(button);

    // Some HA integrations emit both `long_press` and `long_release` for one
    // physical hold. Deliver the engine action on the first event, then ignore
    // its release alias within a bounded window, including mirrored entities.
    if (parsedGesture.data === 'long_release') {
      const previousLongPress = this.lastLongPressByButton.get(button);
      if (
        previousLongPress &&
        receivedAt >= previousLongPress.receivedAt &&
        receivedAt - previousLongPress.receivedAt <=
          LongPressReleaseDuplicateWindowMs
      ) {
        this.lastGestureByButton.set(button, {
          gesture,
          entityId,
          receivedAt,
        });
        return false;
      }
    }

    if (
      previous &&
      previous.gesture === gesture &&
      previous.entityId !== entityId &&
      receivedAt >= previous.receivedAt &&
      receivedAt - previous.receivedAt <= this.mirrorWindowMs
    )
      return false;

    const event: HomeAssistantBilresaEvent = {
      button,
      gesture,
      entityId,
      observedAt,
    };
    this.lastGestureByButton.set(button, {
      gesture,
      entityId,
      receivedAt,
    });
    if (parsedGesture.data === 'long_press') {
      this.lastLongPressByButton.set(button, { entityId, receivedAt });
    }
    this.onEvent(event);
    return true;
  }
}
