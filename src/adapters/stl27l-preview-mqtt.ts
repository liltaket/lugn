/** The narrow MQTT surface needed to consume the STL27L preview topic. */
export interface MqttSubscriber {
  subscribe(
    topic: string,
    options: { qos: 0 },
    onMessage: (topic: string, payload: unknown) => void,
  ): () => void;
}

export type Stl27lPreviewEvent = {
  type: 'presence.prelight';
  active: boolean;
  source: 'stl27l';
};

export type Stl27lPreviewMqttOptions = {
  topic?: string;
};

const DEFAULT_TOPIC = 'bruno/doorway/preview';

/**
 * Converts the STL-27L preview MQTT state into normalized prelight events.
 * The sensor publishes non-retained state, so this adapter only reports
 * values it receives and cannot recover state missed during a disconnect.
 */
export class Stl27lPreviewMqttAdapter {
  private readonly topic: string;
  private unsubscribe?: () => void;
  private lastActive?: boolean;

  constructor(
    private readonly subscriber: MqttSubscriber,
    private readonly onEvent: (event: Stl27lPreviewEvent) => void,
    options: Stl27lPreviewMqttOptions = {},
  ) {
    this.topic = options.topic ?? DEFAULT_TOPIC;
    if (this.topic.length === 0) {
      throw new Error('STL27L preview MQTT topic must not be empty');
    }
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.subscriber.subscribe(
      this.topic,
      { qos: 0 },
      (topic, payload) => this.receive(topic, payload),
    );
  }

  stop(): void {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    this.lastActive = undefined;
    unsubscribe?.();
  }

  private receive(topic: string, payload: unknown): void {
    if (topic !== this.topic) return;
    const state = decodeState(payload);
    if (state === undefined) return;

    const active = state === 'ON';
    if (active === this.lastActive) return;
    this.lastActive = active;
    this.onEvent({ type: 'presence.prelight', active, source: 'stl27l' });
  }
}

function decodeState(payload: unknown): 'ON' | 'OFF' | undefined {
  let text: string;
  if (typeof payload === 'string') {
    text = payload;
  } else if (payload instanceof Uint8Array) {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    } catch {
      return undefined;
    }
  } else {
    return undefined;
  }

  return text === 'ON' || text === 'OFF' ? text : undefined;
}
