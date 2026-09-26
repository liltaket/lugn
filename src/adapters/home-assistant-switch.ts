import { z } from 'zod';
import type { Clock } from '../core/clock.js';
import { SemanticSwitchIdSchema } from '../core/schemas.js';
import type {
  SwitchAdapter,
  SwitchCommand,
  SwitchObservation,
} from './simulated-switch.js';

const EntityId = z.string().regex(/^switch\.[a-z0-9_]+$/);
const ConfigSchema = z
  .object({
    baseUrl: z.string().superRefine((value, context) => {
      try {
        const url = new URL(value);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          context.addIssue({
            code: 'custom',
            message:
              'baseUrl must use HTTP or HTTPS without credentials, query or fragment',
          });
      } catch {
        context.addIssue({
          code: 'custom',
          message: 'baseUrl must be a valid URL',
        });
      }
    }),
    token: z.string().min(1),
    entities: z.record(SemanticSwitchIdSchema, EntityId),
  })
  .strict()
  .superRefine((config, context) => {
    const ids = Object.values(config.entities);
    if (ids.length === 0 || new Set(ids).size !== ids.length)
      context.addIssue({
        code: 'custom',
        path: ['entities'],
        message:
          'Configure at least one switch with a distinct Home Assistant entity for each semantic ID',
      });
  });

export type HomeAssistantSwitchConfig = z.input<typeof ConfigSchema>;

const StateSchema = z.object({ entity_id: EntityId, state: z.string() });
const EventDataSchema = z.object({
  entity_id: EntityId,
  new_state: StateSchema.nullable(),
});
const EventSchema = z.object({
  event_type: z.literal('state_changed'),
  data: EventDataSchema,
});
const EnvelopeSchema = z.object({
  type: z.literal('event'),
  event: EventSchema,
});

/** Fixed switch services and observations for explicitly configured entities. */
export class HomeAssistantSwitchAdapter implements SwitchAdapter {
  private readonly config: z.output<typeof ConfigSchema>;
  private readonly semanticByEntity: Map<string, string>;
  private readonly listeners = new Set<
    (observation: SwitchObservation) => void
  >();

  constructor(
    config: HomeAssistantSwitchConfig,
    private readonly transport: typeof fetch,
    private readonly clock: Clock,
  ) {
    this.config = ConfigSchema.parse(config);
    this.semanticByEntity = new Map(
      Object.entries(this.config.entities).map(([target, entity]) => [
        entity,
        target,
      ]),
    );
  }

  async dispatch(command: SwitchCommand): Promise<void> {
    const target = SemanticSwitchIdSchema.parse(command.target);
    const state = z.boolean().parse(command.state);
    const entityId = this.config.entities[target];
    if (!entityId)
      throw new Error(
        `No Home Assistant switch entity is configured for ${target}`,
      );
    const service = state ? 'turn_on' : 'turn_off';
    let response: Response;
    try {
      response = await this.transport(
        `${this.config.baseUrl.replace(/\/+$/, '')}/api/services/switch/${service}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ entity_id: entityId }),
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      throw new Error(
        `Home Assistant switch.${service} failed for ${target}: transport error`,
      );
    }
    if (!response.ok)
      throw new Error(
        `Home Assistant switch.${service} failed for ${target}: HTTP ${response.status}`,
      );
  }

  subscribe(listener: (observation: SwitchObservation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Accepts REST initial states using the same normalization as live feedback. */
  acceptState(payload: unknown): boolean {
    const result = StateSchema.safeParse(payload);
    if (!result.success) return false;
    const target = this.semanticByEntity.get(result.data.entity_id);
    if (!target) return false;
    const state = result.data.state;
    const available = state === 'on' || state === 'off';
    const observation: SwitchObservation = {
      target,
      state: available ? state === 'on' : null,
      available,
      observedAt: this.clock.now(),
      provenance: {
        actor: { type: 'home_assistant' },
        source: 'home_assistant.state_changed',
      },
    };
    for (const listener of this.listeners)
      listener(structuredClone(observation));
    return true;
  }

  acceptStateChangedEvent(payload: unknown): boolean {
    const envelope = EnvelopeSchema.safeParse(payload);
    const event = EventSchema.safeParse(payload);
    const result = EventDataSchema.safeParse(
      envelope.success
        ? envelope.data.event.data
        : event.success
          ? event.data.data
          : payload,
    );
    if (!result.success) return false;
    const { entity_id: entityId, new_state: state } = result.data;
    if (state && state.entity_id !== entityId) return false;
    return this.acceptState(
      state ?? { entity_id: entityId, state: 'unavailable' },
    );
  }
}
