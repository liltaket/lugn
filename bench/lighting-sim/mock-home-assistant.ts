import type {
  HomeAssistantSocket,
  HomeAssistantSocketFactory,
  HomeAssistantSocketMessageEvent,
} from '../../src/adapters/home-assistant-websocket.js';
import type { LatencyProfile } from './latency-profiles.js';
import {
  keyedLatency,
  keyedUniform,
  type LatencyDistribution,
} from './random.js';
import type { SimClock } from './sim-clock.js';

export type EntityState = {
  state: 'on' | 'off' | 'unavailable';
  attributes: Record<string, unknown>;
  lastUpdated: number;
};

export type EntityEffect = {
  entity: string;
  /** Would this command leave HA's (scheduled) state unchanged? */
  noop: boolean;
  stateAt?: number;
  physicalAt?: number;
  feedbackDropped: boolean;
};

export type ServiceCallRecord = {
  seq: number;
  transport: 'rest' | 'websocket';
  service: 'turn_on' | 'turn_off';
  entities: string[];
  data: Record<string, unknown>;
  /** Monotonic times on the SimClock. */
  invokedAt: number;
  wireAt?: number;
  arrivedAt?: number;
  completedAt?: number;
  effects: EntityEffect[];
  outcome?: 'ok' | 'error' | 'timeout' | 'disconnected';
};

export type WledRecord = {
  seq: number;
  method: 'GET' | 'POST';
  invokedAt: number;
  physicalAt?: number;
};

/** Faults the workload can switch on and off while it runs. */
export type FaultState = {
  /** Probability that an otherwise-successful REST call returns HTTP 503. */
  restServerErrorRate: number;
  /** Probability that a state_changed is delivered twice, the second stale. */
  staleReplayRate: number;
  /** Extra delay added to every state_changed (delayed feedback). */
  extraFeedbackDelayMs: number;
  /** Drop every state_changed (HA recorder/websocket stall). */
  dropAllFeedback: boolean;
};

type SocketSession = {
  client: MockHomeAssistantSocket;
  authenticated: boolean;
  subscriptionId?: number;
  open: boolean;
};

const clientTimeoutMs = 10_000;
const allColorModes = ['color_temp', 'hs', 'xy', 'rgb'];

/**
 * A deterministic, in-process Home Assistant: REST light services, the
 * WebSocket API (auth, state_changed subscription, call_service), a WLED JSON
 * endpoint, an HA event-loop queue, and per-integration latency/fault models.
 * Every latency sample is keyed by (seed, entity, per-entity command index), so
 * candidates that send fewer commands do not shift other samples.
 */
export class MockHomeAssistant {
  readonly calls: ServiceCallRecord[] = [];
  readonly wledCalls: WledRecord[] = [];
  readonly faults: FaultState = {
    restServerErrorRate: 0,
    staleReplayRate: 0,
    extraFeedbackDelayMs: 0,
    dropAllFeedback: false,
  };
  private readonly states = new Map<string, EntityState>();
  /** Latest state each entity will reach once scheduled effects land. */
  private readonly scheduled = new Map<string, EntityState>();
  private readonly commandIndex = new Map<string, number>();
  private readonly serialBusyUntil = new Map<string, number>();
  private readonly sessions = new Set<SocketSession>();
  private readonly connections: Array<{ busy: boolean; idleSince: number }> =
    [];
  private haBusyUntil = 0;
  private seq = 0;
  private wled = { on: false, bri: 128, cct: 0, white: 0 };

  constructor(
    private readonly clock: SimClock,
    private readonly profile: LatencyProfile,
    private readonly seed: number,
    entities: readonly string[],
  ) {
    for (const entity of entities) {
      const integration = profile.entityIntegration[entity];
      const supported =
        integration === 'yeelight' && !entity.endsWith('ambilight')
          ? ['color_temp']
          : integration === 'wled'
            ? ['color_temp']
            : allColorModes.filter((mode) => mode !== 'xy');
      const state: EntityState = {
        state: 'off',
        attributes: { supported_color_modes: supported, color_mode: null },
        lastUpdated: this.clock.now(),
      };
      this.states.set(entity, state);
      this.scheduled.set(entity, structuredClone(state));
    }
  }

  /** Seeds for `HomeAssistantLightingAdapter.acceptStateChangedEvent`. */
  snapshot(): Array<{ entity_id: string; new_state: unknown }> {
    return [...this.states].map(([entity, state]) => ({
      entity_id: entity,
      new_state: this.toHaState(entity, state),
    }));
  }

  state(entity: string): EntityState | undefined {
    return this.states.get(entity);
  }

  /** A person changes a light in the HA app or on the device. */
  manualChange(entity: string, values: Record<string, unknown>): void {
    const current = this.scheduled.get(entity);
    if (!current) throw new Error(`Unknown entity ${entity}`);
    const next = applyService(
      current,
      values['state'] === 'off' ? 'turn_off' : 'turn_on',
      values,
    );
    this.scheduled.set(entity, structuredClone(next));
    this.clock.setTimeout(() => this.applyState(entity, next, false), 5);
  }

  setUnavailable(entity: string, unavailable: boolean): void {
    const current = this.scheduled.get(entity);
    if (!current) return;
    const next: EntityState = {
      ...structuredClone(current),
      state: unavailable ? 'unavailable' : 'off',
    };
    this.scheduled.set(entity, structuredClone(next));
    this.applyState(entity, next, false);
  }

  /** Server-side WebSocket loss: every open session closes. */
  dropWebSockets(): void {
    for (const session of [...this.sessions]) this.closeSession(session);
  }

  readonly fetch: typeof fetch = (input, init) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.hostname === '192.168.10.184') return this.wledFetch(url, init);
    const match = /^\/api\/services\/light\/(turn_on|turn_off)$/.exec(
      url.pathname,
    );
    if (!match || init?.method !== 'POST')
      return Promise.resolve(new Response('Not found', { status: 404 }));
    const service = match[1] as 'turn_on' | 'turn_off';
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const invokedAt = this.clock.monotonicNow();
    this.clock.chargeCpu(this.profile.restClientCpuMs);
    return new Promise<Response>((resolve, reject) => {
      const record = this.record('rest', service, body, invokedAt);
      // undici writes the request after the current task's microtasks; the
      // check phase is the earliest point the bytes can reach the socket.
      setImmediate(() => {
        const readyAt = this.clock.monotonicNow();
        const connectMs = this.acquireConnection(record.seq, readyAt);
        // A cold socket writes from its connect callback, which runs only
        // once the event loop is free again (after SSE/setImmediate work).
        const send = (): void => {
          record.wireAt = this.clock.monotonicNow();
          this.at(record.wireAt + this.lan(`rest-out:${record.seq}`), () =>
            this.execute(record, this.profile.haCpuMs.rest, respondTo),
          );
        };
        if (connectMs > 0) this.at(readyAt + connectMs, send);
        else send();
        const respondTo = (outcome: 'ok' | 'error' | 'timeout'): void => {
          const respond = (): void => {
            this.releaseConnection();
            if (outcome === 'timeout') return;
            if (
              outcome === 'ok' &&
              keyedUniform(this.seed, 'rest-503', record.seq) <
                this.faults.restServerErrorRate
            ) {
              record.outcome = 'error';
              resolve(new Response('Service Unavailable', { status: 503 }));
              return;
            }
            resolve(
              outcome === 'ok'
                ? new Response('[]', {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                  })
                : new Response('{"message":"Integration error"}', {
                    status: 500,
                  }),
            );
          };
          this.clock.setTimeout(respond, this.lan(`rest-in:${record.seq}`));
        };
        this.clock.setTimeout(() => {
          if (record.completedAt !== undefined && record.outcome !== 'timeout')
            return;
          record.outcome = 'timeout';
          this.releaseConnection();
          reject(new DOMException('The operation timed out', 'TimeoutError'));
        }, clientTimeoutMs);
      });
    });
  };

  readonly createSocket: HomeAssistantSocketFactory = () => {
    const client = new MockHomeAssistantSocket(this);
    const session: SocketSession = { client, authenticated: false, open: true };
    this.sessions.add(session);
    client.session = session;
    this.at(this.clock.monotonicNow() + this.lan('ws-open') * 3, () =>
      this.sendFrame(session, { type: 'auth_required' }),
    );
    return client;
  };

  /** Client -> server frame, already on the wire (WebSocket send is sync). */
  receiveFrame(session: SocketSession, data: string): void {
    if (!session.open) return;
    const invokedAt = this.clock.monotonicNow();
    const message = JSON.parse(data) as Record<string, unknown>;
    if (message['type'] === 'call_service')
      this.clock.chargeCpu(this.profile.websocketClientCpuMs);
    const arrival = invokedAt + this.lan(`ws-out:${this.seq}:${data.length}`);
    if (message['type'] === 'auth') {
      this.at(arrival, () => {
        session.authenticated = true;
        this.sendFrame(session, { type: 'auth_ok' });
      });
      return;
    }
    const id = message['id'];
    if (!session.authenticated || typeof id !== 'number') return;
    if (message['type'] === 'subscribe_events') {
      this.at(arrival, () => {
        session.subscriptionId = id;
        this.sendFrame(session, {
          id,
          type: 'result',
          success: true,
          result: null,
        });
      });
      return;
    }
    if (
      message['type'] === 'call_service' &&
      message['domain'] === 'light' &&
      (message['service'] === 'turn_on' || message['service'] === 'turn_off')
    ) {
      const target = (message['target'] ?? {}) as Record<string, unknown>;
      const body: Record<string, unknown> = {
        ...((message['service_data'] ?? {}) as Record<string, unknown>),
        entity_id: target['entity_id'],
      };
      const record = this.record(
        'websocket',
        message['service'],
        body,
        invokedAt,
      );
      record.wireAt = invokedAt;
      this.at(arrival, () =>
        this.execute(record, this.profile.haCpuMs.websocket, (outcome) => {
          if (outcome === 'timeout') return;
          this.clock.setTimeout(
            () =>
              this.sendFrame(
                session,
                outcome === 'ok'
                  ? {
                      id,
                      type: 'result',
                      success: true,
                      result: { context: { id: `ctx-${record.seq}` } },
                    }
                  : {
                      id,
                      type: 'result',
                      success: false,
                      error: {
                        code: 'home_assistant_error',
                        message: 'Integration error',
                      },
                    },
              ),
            this.lan(`ws-in:${record.seq}`),
          );
        }),
      );
      return;
    }
    this.at(arrival, () =>
      this.sendFrame(session, {
        id,
        type: 'result',
        success: false,
        error: { code: 'unknown_command', message: 'Unknown command.' },
      }),
    );
  }

  clientClosed(session: SocketSession): void {
    session.open = false;
    this.sessions.delete(session);
  }

  private closeSession(session: SocketSession): void {
    if (!session.open) return;
    session.open = false;
    this.sessions.delete(session);
    for (const call of this.calls)
      if (call.transport === 'websocket' && call.completedAt === undefined)
        call.outcome ??= 'disconnected';
    session.client.emit('close');
  }

  private record(
    transport: ServiceCallRecord['transport'],
    service: ServiceCallRecord['service'],
    body: Record<string, unknown>,
    invokedAt: number,
  ): ServiceCallRecord {
    const rawEntities = body['entity_id'];
    const entities = Array.isArray(rawEntities)
      ? rawEntities.map(String)
      : [String(rawEntities)];
    const data = Object.fromEntries(
      Object.entries(body).filter(([key]) => key !== 'entity_id'),
    );
    const record: ServiceCallRecord = {
      seq: ++this.seq,
      transport,
      service,
      entities,
      data,
      invokedAt,
      effects: [],
    };
    this.clock.excluded(() => this.calls.push(record));
    return record;
  }

  /** Run a service call on the modeled HA event loop and integrations. */
  private execute(
    record: ServiceCallRecord,
    requestCpuMs: number,
    done: (outcome: 'ok' | 'error' | 'timeout') => void,
  ): void {
    this.clock.excluded(() => {
      const arrivedAt = this.clock.monotonicNow();
      record.arrivedAt = arrivedAt;
      const startedAt = Math.max(arrivedAt, this.haBusyUntil);
      const dispatchedAt =
        startedAt +
        requestCpuMs +
        this.profile.haCpuMs.perEntity * record.entities.length;
      this.haBusyUntil = dispatchedAt;
      let serviceDoneAt = dispatchedAt;
      let outcome: 'ok' | 'error' | 'timeout' = 'ok';
      for (const entity of record.entities) {
        const integrationName = this.profile.entityIntegration[entity];
        const current = this.scheduled.get(entity);
        if (!current || !integrationName) {
          outcome = 'error';
          continue;
        }
        if (integrationName === 'wled') continue;
        const integration = this.profile.integrations[integrationName]!;
        const index = (this.commandIndex.get(entity) ?? 0) + 1;
        this.commandIndex.set(entity, index);
        const key = [this.seed, entity, index] as const;
        const serialKey = integration.serialKey;
        const begin = serialKey
          ? Math.max(dispatchedAt, this.serialBusyUntil.get(serialKey) ?? 0)
          : dispatchedAt;
        const service = sample(integration.serviceMs, 'service', ...key);
        if (serialKey) this.serialBusyUntil.set(serialKey, begin + service);
        const hang = keyedUniform('hang', ...key) < (integration.hangRate ?? 0);
        const fails =
          !hang && keyedUniform('error', ...key) < (integration.errorRate ?? 0);
        if (hang) outcome = 'timeout';
        else if (fails && outcome === 'ok') outcome = 'error';
        serviceDoneAt = Math.max(serviceDoneAt, begin + service);
        const next = applyService(current, record.service, record.data);
        const effect: EntityEffect = {
          entity,
          noop: sameLightState(current, next),
          feedbackDropped: false,
        };
        record.effects.push(effect);
        if (fails || hang) continue;
        this.scheduled.set(entity, structuredClone(next));
        effect.physicalAt =
          begin + sample(integration.physicalMs, 'physical', ...key);
        const dropped =
          this.faults.dropAllFeedback ||
          keyedUniform('drop', ...key) < (integration.feedbackDropRate ?? 0);
        effect.feedbackDropped = dropped;
        const stateAt = Math.max(
          begin + sample(integration.stateMs, 'state', ...key),
          dispatchedAt,
        );
        effect.stateAt = stateAt + this.faults.extraFeedbackDelayMs;
        this.at(effect.stateAt, () => this.applyState(entity, next, dropped));
      }
      this.at(serviceDoneAt, () => {
        record.completedAt = this.clock.monotonicNow();
        record.outcome ??= outcome === 'ok' ? 'ok' : outcome;
        done(outcome);
      });
    });
  }

  private applyState(
    entity: string,
    next: EntityState,
    dropped: boolean,
  ): void {
    this.clock.excluded(() => {
      const previous = this.states.get(entity);
      const state = { ...structuredClone(next), lastUpdated: this.clock.now() };
      this.states.set(entity, state);
      if (dropped) return;
      this.broadcastState(entity, state);
      if (
        previous &&
        keyedUniform(this.seed, 'stale', entity, state.lastUpdated) <
          this.faults.staleReplayRate
      )
        this.at(this.clock.monotonicNow() + 15, () =>
          this.broadcastState(entity, previous),
        );
    });
  }

  private broadcastState(entity: string, state: EntityState): void {
    for (const session of this.sessions) {
      if (session.subscriptionId === undefined) continue;
      const frame = {
        id: session.subscriptionId,
        type: 'event',
        event: {
          event_type: 'state_changed',
          data: { entity_id: entity, new_state: this.toHaState(entity, state) },
        },
      };
      this.clock.setTimeout(
        () => this.sendFrame(session, frame),
        this.lan(`event:${entity}:${state.lastUpdated}`),
      );
    }
  }

  private sendFrame(session: SocketSession, message: unknown): void {
    if (!session.open) return;
    const data = this.clock.excluded(() => JSON.stringify(message));
    session.client.emit('message', { data });
  }

  private toHaState(
    entity: string,
    state: EntityState,
  ): Record<string, unknown> {
    return {
      entity_id: entity,
      state: state.state,
      attributes: state.attributes,
      last_updated: new Date(state.lastUpdated).toISOString(),
    };
  }

  private acquireConnection(seq: number, at: number): number {
    const warm = this.connections.find(
      (connection) =>
        !connection.busy &&
        at - connection.idleSince < this.profile.restKeepAliveMs,
    );
    // Expired sockets are closed by undici; drop them from the pool.
    for (let index = this.connections.length - 1; index >= 0; index -= 1) {
      const connection = this.connections[index]!;
      if (
        connection !== warm &&
        !connection.busy &&
        at - connection.idleSince >= this.profile.restKeepAliveMs
      )
        this.connections.splice(index, 1);
    }
    if (warm) {
      warm.busy = true;
      return 0;
    }
    this.connections.push({ busy: true, idleSince: at });
    return sample(this.profile.restConnectMs, 'connect', this.seed, seq);
  }

  private releaseConnection(): void {
    const busy = this.connections.find((connection) => connection.busy);
    if (busy) {
      busy.busy = false;
      busy.idleSince = this.clock.monotonicNow();
    }
  }

  private wledFetch(
    url: URL,
    init: RequestInit | undefined,
  ): Promise<Response> {
    const method = init?.method === 'POST' ? 'POST' : 'GET';
    const record: WledRecord = {
      seq: ++this.seq,
      method,
      invokedAt: this.clock.monotonicNow(),
    };
    this.wledCalls.push(record);
    const latency = sample(
      this.profile.wled.requestMs,
      'wled',
      this.seed,
      record.seq,
    );
    return new Promise((resolve) => {
      this.clock.setTimeout(() => {
        if (method === 'POST') {
          const body = JSON.parse(String(init?.body)) as {
            on: boolean;
            bri?: number;
            seg?: Array<{ cct?: number }>;
          };
          this.wled.on = body.on;
          if (body.bri !== undefined) this.wled.bri = body.bri;
          if (body.seg?.[0]?.cct !== undefined) this.wled.cct = body.seg[0].cct;
          if (body.on) this.wled.white = 255;
          record.physicalAt =
            record.invokedAt +
            sample(
              this.profile.wled.physicalMs,
              'wled-physical',
              this.seed,
              record.seq,
            );
        }
        resolve(
          new Response(
            JSON.stringify({
              on: this.wled.on,
              bri: this.wled.bri,
              seg: [
                {
                  id: 0,
                  lc: 1,
                  on: this.wled.on,
                  bri: 255,
                  cct: this.wled.cct,
                  col: [[0, 0, 0, this.wled.white]],
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }, latency);
    });
  }

  private lan(key: string): number {
    return sample(this.profile.lanOneWayMs, 'lan', this.seed, key);
  }

  private at(monotonicAt: number, work: () => void): void {
    this.clock.setTimeout(work, monotonicAt - this.clock.monotonicNow());
  }
}

/** Client half of the in-process HA WebSocket. */
export class MockHomeAssistantSocket implements HomeAssistantSocket {
  session: SocketSession | undefined;
  private readonly messageListeners = new Set<
    (event: HomeAssistantSocketMessageEvent) => void
  >();
  private readonly closeListeners = new Set<() => void>();

  constructor(private readonly server: MockHomeAssistant) {}

  addEventListener(
    type: 'message',
    listener: (event: HomeAssistantSocketMessageEvent) => void,
  ): void;
  addEventListener(type: 'close' | 'error', listener: () => void): void;
  addEventListener(
    type: 'message' | 'close' | 'error',
    listener: ((event: HomeAssistantSocketMessageEvent) => void) | (() => void),
  ): void {
    if (type === 'message')
      this.messageListeners.add(
        listener as (event: HomeAssistantSocketMessageEvent) => void,
      );
    else if (type === 'close') this.closeListeners.add(listener as () => void);
  }

  send(data: string): void {
    if (!this.session?.open) throw new Error('WebSocket is not open');
    this.server.receiveFrame(this.session, data);
  }

  close(): void {
    if (!this.session?.open) return;
    this.server.clientClosed(this.session);
  }

  emit(type: 'message', event: HomeAssistantSocketMessageEvent): void;
  emit(type: 'close'): void;
  emit(
    type: 'message' | 'close',
    event?: HomeAssistantSocketMessageEvent,
  ): void {
    if (type === 'message')
      for (const listener of [...this.messageListeners]) listener(event!);
    else for (const listener of [...this.closeListeners]) listener();
  }
}

function sample(
  distribution: LatencyDistribution,
  ...key: Array<string | number>
): number {
  return Math.max(0, keyedLatency(distribution, ...key));
}

function applyService(
  current: EntityState,
  service: 'turn_on' | 'turn_off',
  data: Record<string, unknown>,
): EntityState {
  const attributes = { ...current.attributes };
  if (service === 'turn_off')
    return {
      state: 'off',
      attributes: {
        supported_color_modes: attributes['supported_color_modes'],
        color_mode: null,
        // Keep the remembered lit values out of view like real integrations.
        _brightness: attributes['brightness'] ?? attributes['_brightness'],
        _color_temp_kelvin:
          attributes['color_temp_kelvin'] ?? attributes['_color_temp_kelvin'],
        _rgb_color: attributes['rgb_color'] ?? attributes['_rgb_color'],
        _color_mode: attributes['color_mode'] ?? attributes['_color_mode'],
      },
      lastUpdated: current.lastUpdated,
    };
  const next: Record<string, unknown> = {
    supported_color_modes: attributes['supported_color_modes'],
    brightness: attributes['brightness'] ?? attributes['_brightness'] ?? 255,
    color_mode:
      attributes['color_mode'] ?? attributes['_color_mode'] ?? 'color_temp',
    color_temp_kelvin:
      attributes['color_temp_kelvin'] ??
      attributes['_color_temp_kelvin'] ??
      2700,
    rgb_color: attributes['rgb_color'] ?? attributes['_rgb_color'],
  };
  if (typeof data['brightness_pct'] === 'number')
    next['brightness'] = Math.round((data['brightness_pct'] * 255) / 100);
  if (typeof data['color_temp_kelvin'] === 'number') {
    next['color_mode'] = 'color_temp';
    next['color_temp_kelvin'] = data['color_temp_kelvin'];
    delete next['rgb_color'];
  }
  if (Array.isArray(data['rgb_color'])) {
    next['color_mode'] = 'rgb';
    next['rgb_color'] = data['rgb_color'];
    delete next['color_temp_kelvin'];
  }
  if (next['color_mode'] === 'color_temp') delete next['rgb_color'];
  if (next['rgb_color'] === undefined) delete next['rgb_color'];
  return { state: 'on', attributes: next, lastUpdated: current.lastUpdated };
}

function sameLightState(left: EntityState, right: EntityState): boolean {
  if (left.state !== right.state) return false;
  if (left.state !== 'on') return true;
  return (
    left.attributes['brightness'] === right.attributes['brightness'] &&
    left.attributes['color_mode'] === right.attributes['color_mode'] &&
    left.attributes['color_temp_kelvin'] ===
      right.attributes['color_temp_kelvin'] &&
    JSON.stringify(left.attributes['rgb_color']) ===
      JSON.stringify(right.attributes['rgb_color'])
  );
}
