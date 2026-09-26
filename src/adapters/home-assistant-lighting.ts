import { z } from 'zod';
import type { Clock } from '../core/clock.js';
import {
  SemanticLightingIdSchema,
  type LightingValues,
} from '../core/schemas.js';
import type {
  LightingAdapter,
  LightingCommand,
  LightingObservation,
} from './simulated-lighting.js';

const HomeAssistantEntityIdSchema = z.string().regex(/^light\.[a-z0-9_]+$/);

const HomeAssistantLightingConfigSchema = z
  .object({
    baseUrl: z.string().superRefine((value, context) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        context.addIssue({
          code: 'custom',
          message: 'baseUrl must be a valid URL',
        });
        return;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        context.addIssue({
          code: 'custom',
          message: 'baseUrl must use HTTP or HTTPS',
        });
      }
      if (url.username || url.password || url.search || url.hash) {
        context.addIssue({
          code: 'custom',
          message: 'baseUrl cannot contain credentials, a query, or a fragment',
        });
      }
    }),
    token: z.string().min(1),
    entities: z.record(SemanticLightingIdSchema, HomeAssistantEntityIdSchema),
  })
  .superRefine((config, context) => {
    const entityIds = Object.values(config.entities);
    if (entityIds.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['entities'],
        message: 'At least one Home Assistant light mapping is required',
      });
    }
    if (new Set(entityIds).size !== entityIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['entities'],
        message: 'Each Home Assistant light entity must have one semantic ID',
      });
    }
  });

export type HomeAssistantLightingConfig = z.input<
  typeof HomeAssistantLightingConfigSchema
>;

const HomeAssistantStateSchema = z.object({
  entity_id: HomeAssistantEntityIdSchema,
  state: z.string(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

const HomeAssistantStateChangedDataSchema = z.object({
  entity_id: HomeAssistantEntityIdSchema,
  new_state: HomeAssistantStateSchema.nullable(),
});

const HomeAssistantStateChangedEventSchema = z.object({
  event_type: z.literal('state_changed'),
  data: HomeAssistantStateChangedDataSchema,
});

const HomeAssistantWebSocketEventSchema = z.object({
  type: z.literal('event'),
  event: HomeAssistantStateChangedEventSchema,
});

/**
 * Adapts normalized Lugn lighting commands to Home Assistant's light service
 * API. State changes are accepted separately so a transport can own the
 * Home Assistant WebSocket connection and forward its event payloads here.
 */
export class HomeAssistantLightingAdapter implements LightingAdapter {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly entityBySemanticId: Map<string, string>;
  private readonly semanticIdByEntity: Map<string, string>;
  private readonly listeners = new Set<
    (observation: LightingObservation) => void
  >();

  constructor(
    config: HomeAssistantLightingConfig,
    private readonly transport: typeof fetch,
    private readonly clock: Clock,
  ) {
    const parsedConfig = HomeAssistantLightingConfigSchema.parse(config);
    this.baseUrl = parsedConfig.baseUrl.replace(/\/+$/, '');
    this.token = parsedConfig.token;
    this.entityBySemanticId = new Map(Object.entries(parsedConfig.entities));
    this.semanticIdByEntity = new Map(
      Object.entries(parsedConfig.entities).map(([semanticId, entityId]) => [
        entityId,
        semanticId,
      ]),
    );
  }

  async dispatch(command: LightingCommand): Promise<void> {
    const entityId = this.entityBySemanticId.get(command.target);
    if (!entityId) {
      throw new Error(
        `No Home Assistant light entity is configured for ${command.target}`,
      );
    }

    const service = command.values.power === false ? 'turn_off' : 'turn_on';
    const data: Record<string, string | number> = { entity_id: entityId };

    if (service === 'turn_on') {
      if (command.values.brightness !== undefined)
        data['brightness_pct'] = command.values.brightness;
      if (command.values.colorTemperature !== undefined)
        data['color_temp_kelvin'] = command.values.colorTemperature;
    }

    let response: Response;
    try {
      response = await this.transport(
        `${this.baseUrl}/api/services/light/${service}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(data),
        },
      );
    } catch {
      // Transport errors can include request details. Do not forward them since
      // custom fetch implementations may include request headers in messages.
      throw new Error(
        `Home Assistant light.${service} failed for ${command.target} (${entityId}): transport error`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `Home Assistant light.${service} failed for ${command.target} (${entityId}): HTTP ${response.status}`,
      );
    }
  }

  subscribe(listener: (observation: LightingObservation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Accepts a Home Assistant state_changed event, either the event itself, its
   * WebSocket event envelope, or the event's data object. Returns true only
   * when a usable observation for a configured entity was published.
   */
  acceptStateChangedEvent(payload: unknown): boolean {
    const eventEnvelope = HomeAssistantWebSocketEventSchema.safeParse(payload);
    let eventData: unknown = payload;
    if (eventEnvelope.success) {
      eventData = eventEnvelope.data.event.data;
    } else {
      const event = HomeAssistantStateChangedEventSchema.safeParse(payload);
      if (event.success) eventData = event.data.data;
    }

    const parsedData = HomeAssistantStateChangedDataSchema.safeParse(eventData);
    if (!parsedData.success) return false;
    const data = parsedData.data;

    const target = this.semanticIdByEntity.get(data.entity_id);
    const newState = data.new_state;
    if (!target || !newState || newState.entity_id !== data.entity_id)
      return false;
    if (newState.state !== 'on' && newState.state !== 'off') return false;

    const values = this.normalizeValues(newState.state, newState.attributes);
    this.emit({
      target,
      values,
      observedAt: this.clock.now(),
      provenance: {
        actor: { type: 'home_assistant' },
        source: 'home_assistant.state_changed',
      },
    });
    return true;
  }

  private normalizeValues(
    state: 'on' | 'off',
    attributes: Record<string, unknown> | undefined,
  ): LightingValues {
    const values: LightingValues = { power: state === 'on' };
    if (!attributes) return values;

    const brightness = attributes['brightness'];
    if (
      typeof brightness === 'number' &&
      Number.isFinite(brightness) &&
      brightness >= 0 &&
      brightness <= 255
    ) {
      values.brightness = Math.round((brightness / 255) * 100);
    }

    const colorTemperature = attributes['color_temp_kelvin'];
    if (
      typeof colorTemperature === 'number' &&
      Number.isFinite(colorTemperature) &&
      colorTemperature >= 1000 &&
      colorTemperature <= 10000
    ) {
      values.colorTemperature = Math.round(colorTemperature);
    }

    return values;
  }

  private emit(observation: LightingObservation): void {
    for (const listener of this.listeners)
      listener(structuredClone(observation));
  }
}
