import { z } from 'zod';
import type { RoomState } from '../core/schemas.js';

/**
 * Home Assistant entities for voice assistants (Google Assistant, Alexa,
 * Assist). Lugn publishes them with MQTT discovery, owns their state and
 * turns their commands into ordinary capability calls. A voice assistant
 * then controls Lugn's intent instead of the raw lights, which Lugn would
 * read as a manual change it did not make.
 *
 * Commands and state use separate topics, so a state publication can never
 * come back as a command.
 */

const SlugSchema = z.string().regex(/^[a-z0-9_]{1,48}$/);
const NameSchema = z.string().trim().min(1).max(64);
const SceneIdSchema = z.string().regex(/^scene\.[a-z0-9_]+$/);
const LightingTargetSchema = z.string().regex(/^lighting\.[a-z0-9_]+$/);
const TopicSchema = z.string().regex(/^[a-z0-9_]+(?:\/[a-z0-9_]+)*$/);

export const AssistantEntitiesConfigSchema = z
  .object({
    discoveryPrefix: SlugSchema.default('homeassistant'),
    baseTopic: TopicSchema.default('lugn/assistant'),
    /** One light per Lugn lighting target, for example the ceiling lamp. */
    lights: z
      .array(
        z
          .object({
            id: SlugSchema,
            name: NameSchema,
            target: LightingTargetSchema,
            brightness: z.boolean().default(true),
          })
          .strict(),
      )
      .max(16)
      .default([]),
    /**
     * One switch per scene. On activates the scene; it reads on while the
     * scene is Lugn's current scene. Off while it is current activates
     * `offSceneId`; off for another scene changes nothing.
     */
    scenes: z
      .array(
        z
          .object({ id: SlugSchema, name: NameSchema, sceneId: SceneIdSchema })
          .strict(),
      )
      .max(16)
      .default([]),
    /**
     * One light for the whole room. On activates `onSceneId` only when every
     * light is off; off activates `offSceneId`.
     */
    room: z
      .object({ id: SlugSchema, name: NameSchema, onSceneId: SceneIdSchema })
      .strict()
      .optional(),
    offSceneId: SceneIdSchema.default('scene.all_off'),
  })
  .strict()
  .superRefine((config, context) => {
    const ids = new Set<string>();
    const all = [
      ...config.lights.map((entry, index) => ({
        entry,
        path: ['lights', index, 'id'],
      })),
      ...config.scenes.map((entry, index) => ({
        entry,
        path: ['scenes', index, 'id'],
      })),
      ...(config.room ? [{ entry: config.room, path: ['room', 'id'] }] : []),
    ];
    for (const { entry, path } of all) {
      if (ids.has(entry.id))
        context.addIssue({
          code: 'custom',
          path,
          message: 'Assistant entity IDs must be unique',
        });
      ids.add(entry.id);
    }
  });

export type AssistantEntitiesConfig = z.input<
  typeof AssistantEntitiesConfigSchema
>;
export type ResolvedAssistantEntitiesConfig = z.output<
  typeof AssistantEntitiesConfigSchema
>;

export type AssistantEntitiesMqtt = {
  subscribe(
    topic: string,
    options: { qos: 0 | 1 },
    onMessage: (
      topic: string,
      payload: unknown,
      metadata: { retain: boolean },
    ) => void,
  ): () => void;
  publish(
    topic: string,
    payload: string,
    options: { qos: 1; retain: boolean },
  ): Promise<void>;
};

/** The capability calls this adapter makes; nothing else. */
export type AssistantCommand =
  | {
      capability: 'lighting.set';
      input: {
        target: string;
        values: { power: boolean; brightness?: number };
      };
    }
  | { capability: 'lighting.activateScene'; input: { sceneId: string } };

export type AssistantEntitiesOptions = {
  config: AssistantEntitiesConfig;
  mqtt: AssistantEntitiesMqtt;
  getState: () => RoomState | undefined;
  invoke: (command: AssistantCommand) => Promise<unknown>;
  onWarning?: (message: string) => void;
};

type Entity =
  | {
      kind: 'light';
      id: string;
      name: string;
      target: string;
      brightness: boolean;
    }
  | { kind: 'scene'; id: string; name: string; sceneId: string }
  | { kind: 'room'; id: string; name: string; onSceneId: string };

const LightCommandSchema = z
  .object({
    state: z.enum(['ON', 'OFF']),
    brightness: z.number().finite().optional(),
  })
  .passthrough();

const MaxPayloadBytes = 1024;

export class AssistantEntitiesMqttAdapter {
  private readonly config: ResolvedAssistantEntitiesConfig;
  private readonly entities: Entity[];
  private readonly published = new Map<string, string>();
  private readonly unsubscribers: Array<() => void> = [];
  private connected = false;
  private generation = 0;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly options: AssistantEntitiesOptions) {
    this.config = AssistantEntitiesConfigSchema.parse(options.config);
    this.entities = [
      ...this.config.lights.map((light): Entity => ({
        kind: 'light',
        ...light,
      })),
      ...this.config.scenes.map((scene): Entity => ({
        kind: 'scene',
        ...scene,
      })),
      ...(this.config.room
        ? [{ kind: 'room' as const, ...this.config.room }]
        : []),
    ];
    for (const entity of this.entities) {
      this.unsubscribers.push(
        options.mqtt.subscribe(
          this.commandTopic(entity),
          { qos: 1 },
          (_topic, payload, metadata) => {
            // A retained command is an old one replayed by the broker.
            if (metadata.retain) return;
            this.enqueue(entity, payload);
          },
        ),
      );
    }
  }

  get availabilityTopic(): string {
    return `${this.config.baseTopic}/availability`;
  }

  /** Payload the broker should publish when Lugn's connection drops. */
  static readonly offlinePayload = 'offline';

  setBrokerConnected(connected: boolean): void {
    if (this.stopped || connected === this.connected) return;
    this.connected = connected;
    this.generation += 1;
    this.published.clear();
    if (connected) void this.announce(this.generation);
  }

  /** Publishes entity states that changed since the last publication. */
  observe(): void {
    if (!this.connected || this.stopped) return;
    void this.publishStates(this.generation);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    if (this.connected)
      await this.options.mqtt
        .publish(
          this.availabilityTopic,
          AssistantEntitiesMqttAdapter.offlinePayload,
          {
            qos: 1,
            retain: true,
          },
        )
        .catch(() => undefined);
    this.stopped = true;
    this.connected = false;
  }

  /** Entity states for the current room state; exported for diagnostics. */
  statePayloads(state: RoomState | undefined): Map<string, string> {
    const payloads = new Map<string, string>();
    for (const entity of this.entities)
      payloads.set(this.stateTopic(entity), statePayload(entity, state));
    return payloads;
  }

  discoveryPayloads(): Map<string, string> {
    const payloads = new Map<string, string>();
    for (const entity of this.entities) {
      const component = entity.kind === 'scene' ? 'switch' : 'light';
      const uniqueId = `lugn_assistant_${entity.id}`;
      const common = {
        name: null,
        has_entity_name: true,
        unique_id: uniqueId,
        default_entity_id: `${component}.lugn_${entity.id}`,
        command_topic: this.commandTopic(entity),
        state_topic: this.stateTopic(entity),
        availability_topic: this.availabilityTopic,
        qos: 1,
        retain: false,
        optimistic: false,
        device: {
          identifiers: [uniqueId],
          name: entity.name,
          manufacturer: 'Lugn',
          model: entity.kind === 'scene' ? 'Scen' : 'Belysning',
        },
      };
      const discovery =
        component === 'switch'
          ? {
              ...common,
              icon: 'mdi:palette',
              payload_on: 'ON',
              payload_off: 'OFF',
            }
          : {
              ...common,
              schema: 'json',
              supported_color_modes:
                entity.kind === 'light' && entity.brightness
                  ? ['brightness']
                  : ['onoff'],
              ...(entity.kind === 'light' && entity.brightness
                ? { brightness: true, brightness_scale: 100 }
                : {}),
            };
      payloads.set(
        `${this.config.discoveryPrefix}/${component}/${uniqueId}/config`,
        JSON.stringify(discovery),
      );
    }
    return payloads;
  }

  private commandTopic(entity: Entity): string {
    return `${this.config.baseTopic}/${entity.id}/set`;
  }

  private stateTopic(entity: Entity): string {
    return `${this.config.baseTopic}/${entity.id}/state`;
  }

  private async announce(generation: number): Promise<void> {
    try {
      for (const [topic, payload] of this.discoveryPayloads()) {
        if (generation !== this.generation) return;
        await this.options.mqtt.publish(topic, payload, {
          qos: 1,
          retain: true,
        });
      }
      await this.publishStates(generation);
      if (generation !== this.generation) return;
      await this.options.mqtt.publish(this.availabilityTopic, 'online', {
        qos: 1,
        retain: true,
      });
    } catch {
      // The next connection announces again.
      this.options.onWarning?.(
        'Assistant entity discovery could not be published',
      );
    }
  }

  private async publishStates(generation: number): Promise<void> {
    const state = this.options.getState();
    for (const [topic, payload] of this.statePayloads(state)) {
      if (generation !== this.generation) return;
      if (this.published.get(topic) === payload) continue;
      // Mark first: a concurrent observe() must not publish the same payload.
      this.published.set(topic, payload);
      try {
        await this.options.mqtt.publish(topic, payload, {
          qos: 1,
          retain: true,
        });
      } catch {
        if (this.published.get(topic) === payload) this.published.delete(topic);
      }
    }
  }

  private enqueue(entity: Entity, payload: unknown): void {
    if (this.stopped) return;
    const text = payloadText(payload);
    // One command at a time, in arrival order: "släck allt" from Google
    // reaches several entities at once.
    this.queue = this.queue
      .then(async () => {
        if (this.stopped || text === undefined) return;
        const command = this.commandFor(entity, text, this.options.getState());
        if (command) await this.options.invoke(command);
      })
      .catch(() => {
        this.options.onWarning?.(`Assistant command for ${entity.id} failed`);
      })
      .finally(() => {
        // Without optimistic mode Home Assistant shows only published state,
        // so a rejected or no-op command must still be answered.
        this.published.delete(this.stateTopic(entity));
        this.observe();
      });
  }

  /** The capability call for one command, or undefined for a no-op. */
  commandFor(
    entity: Entity,
    text: string,
    state: RoomState | undefined,
  ): AssistantCommand | undefined {
    switch (entity.kind) {
      case 'light': {
        const command = parseLightCommand(text);
        if (!command) return undefined;
        const values: { power: boolean; brightness?: number } = {
          power: command.on,
        };
        if (command.on && entity.brightness && command.brightness !== undefined)
          values.brightness = command.brightness;
        return {
          capability: 'lighting.set',
          input: { target: entity.target, values },
        };
      }
      case 'scene': {
        const on = parseSwitchCommand(text);
        if (on === undefined) return undefined;
        if (on)
          return {
            capability: 'lighting.activateScene',
            input: { sceneId: entity.sceneId },
          };
        if (state?.lighting.currentScene !== entity.sceneId) return undefined;
        return {
          capability: 'lighting.activateScene',
          input: { sceneId: this.config.offSceneId },
        };
      }
      case 'room': {
        const command = parseLightCommand(text);
        if (!command) return undefined;
        if (!command.on)
          return {
            capability: 'lighting.activateScene',
            input: { sceneId: this.config.offSceneId },
          };
        // "Tänd lamporna" in a lit room keeps what is on.
        if (!state || anyLightOn(state) !== false) return undefined;
        return {
          capability: 'lighting.activateScene',
          input: { sceneId: entity.onSceneId },
        };
      }
    }
  }
}

function payloadText(payload: unknown): string | undefined {
  if (typeof payload === 'string')
    return payload.length <= MaxPayloadBytes ? payload : undefined;
  if (payload instanceof Uint8Array)
    return payload.byteLength <= MaxPayloadBytes
      ? Buffer.from(payload).toString('utf8')
      : undefined;
  return undefined;
}

function parseSwitchCommand(text: string): boolean | undefined {
  const value = text.trim();
  if (value === 'ON') return true;
  if (value === 'OFF') return false;
  return undefined;
}

function parseLightCommand(
  text: string,
): { on: boolean; brightness?: number } | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = LightCommandSchema.safeParse(json);
  if (!parsed.success) return undefined;
  const on = parsed.data.state === 'ON';
  const brightness = parsed.data.brightness;
  if (brightness === undefined) return { on };
  return { on, brightness: Math.min(100, Math.max(1, Math.round(brightness))) };
}

function devicePower(
  state: RoomState,
  target: string,
): { power: boolean | undefined; brightness: number | undefined } {
  const device = state.lighting.devices[target];
  if (!device) return { power: undefined, brightness: undefined };
  // Observed state is what the lamp reported; intent fills the gap until it does.
  const power = device.observed.power ?? device.effectiveDesired.power;
  const brightness =
    device.observed.brightness ?? device.effectiveDesired.brightness;
  return { power, brightness };
}

function anyLightOn(state: RoomState): boolean | undefined {
  let unknown = false;
  for (const target of Object.keys(state.lighting.devices)) {
    const { power } = devicePower(state, target);
    if (power === true) return true;
    if (power === undefined) unknown = true;
  }
  return unknown ? undefined : false;
}

function statePayload(entity: Entity, state: RoomState | undefined): string {
  switch (entity.kind) {
    case 'scene':
      if (!state) return 'None';
      return state.lighting.currentScene === entity.sceneId ? 'ON' : 'OFF';
    case 'room': {
      const on = state ? anyLightOn(state) : undefined;
      if (on === undefined) return JSON.stringify({ state: null });
      return JSON.stringify({ state: on ? 'ON' : 'OFF', color_mode: 'onoff' });
    }
    case 'light': {
      const { power, brightness } = state
        ? devicePower(state, entity.target)
        : { power: undefined, brightness: undefined };
      if (power === undefined) return JSON.stringify({ state: null });
      if (!entity.brightness)
        return JSON.stringify({
          state: power ? 'ON' : 'OFF',
          color_mode: 'onoff',
        });
      return JSON.stringify({
        state: power ? 'ON' : 'OFF',
        color_mode: 'brightness',
        ...(power && brightness !== undefined ? { brightness } : {}),
      });
    }
  }
}
