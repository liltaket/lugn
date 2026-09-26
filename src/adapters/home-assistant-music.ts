import { z } from 'zod';
import type { Clock } from '../core/clock.js';
import {
  MusicRequestSchema,
  SemanticMusicIdSchema,
  type MusicObservationValues,
} from '../core/schemas.js';
import type {
  MusicAdapter,
  MusicCommand,
  MusicObservation,
} from './simulated-music.js';

export const HomeAssistantMusicMappingSchema = z
  .object({
    entityId: z.string().regex(/^media_player\.[a-z0-9_]+$/),
    sources: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .superRefine((mapping, context) => {
    if (new Set(mapping.sources).size !== mapping.sources.length)
      context.addIssue({
        code: 'custom',
        path: ['sources'],
        message: 'Sources must be distinct',
      });
  });
export const HomeAssistantMusicMappingsSchema = z
  .record(SemanticMusicIdSchema, HomeAssistantMusicMappingSchema)
  .superRefine((mappings, context) => {
    const entities = Object.values(mappings).map((mapping) => mapping.entityId);
    if (new Set(entities).size !== entities.length)
      context.addIssue({
        code: 'custom',
        message: 'Each music target must map to a distinct media_player entity',
      });
  });
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
    entities: HomeAssistantMusicMappingsSchema,
  })
  .strict();
export type HomeAssistantMusicConfig = z.input<typeof ConfigSchema>;
const EntityIdSchema = z.string().regex(/^media_player\.[a-z0-9_]+$/);
const StateSchema = z.object({
  entity_id: EntityIdSchema,
  state: z.string(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});
const EventDataSchema = z.object({
  entity_id: EntityIdSchema,
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

/** Fixed media_player services with explicit target and source allowlists. */
export class HomeAssistantMusicAdapter implements MusicAdapter {
  private readonly config: z.output<typeof ConfigSchema>;
  private readonly semanticByEntity: Map<string, string>;
  private readonly listeners = new Set<
    (observation: MusicObservation) => void
  >();
  constructor(
    config: HomeAssistantMusicConfig,
    private readonly transport: typeof fetch,
    private readonly clock: Clock,
  ) {
    this.config = ConfigSchema.parse(config);
    this.semanticByEntity = new Map(
      Object.entries(this.config.entities).map(([target, mapping]) => [
        mapping.entityId,
        target,
      ]),
    );
  }
  async dispatch(command: MusicCommand): Promise<void> {
    const target = SemanticMusicIdSchema.parse(command.target);
    const requested = MusicRequestSchema.parse(command.requested);
    const mapping = this.config.entities[target];
    if (!mapping)
      throw new Error(
        `No Home Assistant music entity is configured for ${target}`,
      );
    let service: string;
    const body: Record<string, unknown> = { entity_id: mapping.entityId };
    switch (requested.property) {
      case 'playback':
        service = requested.value === 'playing' ? 'media_play' : 'media_pause';
        break;
      case 'volume':
        service = 'volume_set';
        body['volume_level'] = requested.value;
        break;
      case 'source':
        if (!mapping.sources.includes(requested.value))
          throw new Error(`Source is not allowed for ${target}`);
        service = 'select_source';
        body['source'] = requested.value;
        break;
    }
    let response: Response;
    try {
      response = await this.transport(
        `${this.config.baseUrl.replace(/\/+$/, '')}/api/services/media_player/${service}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      throw new Error(
        `Home Assistant media_player.${service} failed for ${target}: transport error`,
      );
    }
    if (!response.ok)
      throw new Error(
        `Home Assistant media_player.${service} failed for ${target}: HTTP ${response.status}`,
      );
  }
  subscribe(listener: (observation: MusicObservation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  acceptState(payload: unknown): boolean {
    const result = StateSchema.safeParse(payload);
    if (!result.success) return false;
    const target = this.semanticByEntity.get(result.data.entity_id);
    if (!target) return false;
    const { state, attributes = {} } = result.data;
    const available = [
      'playing',
      'paused',
      'idle',
      'off',
      'on',
      'buffering',
    ].includes(state);
    const playback: MusicObservationValues['playback'] =
      state === 'playing' ||
      state === 'paused' ||
      state === 'idle' ||
      state === 'off'
        ? state
        : 'unknown';
    const volume = attributes['volume_level'];
    const text = (key: string): string | null =>
      typeof attributes[key] === 'string' ? attributes[key] : null;
    const observation: MusicObservation = {
      target,
      available,
      observedAt: this.clock.now(),
      values: {
        playback,
        volume:
          available &&
          typeof volume === 'number' &&
          Number.isFinite(volume) &&
          volume >= 0 &&
          volume <= 1
            ? volume
            : null,
        source: available ? text('source') : null,
        title: available ? text('media_title') : null,
      },
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
