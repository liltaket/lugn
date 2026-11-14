import { z } from 'zod';
import type { Clock, TimerHandle } from '../core/clock.js';
import { systemClock } from '../core/clock.js';

const ConnectionConfigSchema = z.object({
  baseUrl: z.string().superRefine((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'baseUrl must be a URL' });
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      context.addIssue({
        code: 'custom',
        message: 'baseUrl must use HTTP or HTTPS',
      });
    if (url.username || url.password || url.search || url.hash)
      context.addIssue({
        code: 'custom',
        message: 'baseUrl cannot contain credentials, a query, or a fragment',
      });
  }),
  token: z.string().min(1),
});

const ServerMessageSchema = z.object({
  type: z.string(),
  id: z.number().int().positive().optional(),
  success: z.boolean().optional(),
  error: z.object({ code: z.string().optional() }).optional().catch(undefined),
});
const EventFrameSchema = z.object({
  type: z.literal('event'),
  id: z.number().int().positive(),
  event: z
    .object({
      event_type: z.enum([
        'state_changed',
        'automation_triggered',
        'call_service',
      ]),
      data: z.record(z.string(), z.unknown()),
    })
    .passthrough(),
});

export type HomeAssistantSocketMessageEvent = { data: unknown };

/** Minimal subset shared by Node's global WebSocket and deterministic fakes. */
export interface HomeAssistantSocket {
  addEventListener(
    type: 'message',
    listener: (event: HomeAssistantSocketMessageEvent) => void,
  ): void;
  addEventListener(type: 'close' | 'error', listener: () => void): void;
  send(data: string): void;
  close(): void;
}

export type HomeAssistantSocketFactory = (url: string) => HomeAssistantSocket;

export type HomeAssistantConnectionStatus =
  | 'stopped'
  | 'connecting'
  | 'authenticating'
  | 'subscribing'
  | 'connected'
  | 'disconnected'
  | 'failed';

/** Valid only for this authenticated subscription; invalidated on loss or stop. */
export type HomeAssistantConnection = { isCurrent(): boolean };

/** An HA `call_service` command sent on the authenticated socket. */
export type HomeAssistantServiceCall = {
  domain: string;
  service: string;
  serviceData: Record<string, unknown>;
  target: { entity_id: string | string[] };
};

/**
 * `no_response`: the frame was sent but no result arrived (timeout or lost
 * socket), so HA may still have executed it. `rejected`: HA answered with an
 * error result carrying its WebSocket error code.
 */
export class HomeAssistantServiceCallError extends Error {
  constructor(
    readonly outcome: 'no_response' | 'rejected',
    readonly code?: string,
  ) {
    super(
      outcome === 'rejected'
        ? `Home Assistant rejected the service call (${code ?? 'unknown'})`
        : 'Home Assistant did not answer the service call',
    );
    this.name = 'HomeAssistantServiceCallError';
  }
}

export type HomeAssistantWebSocketOptions = {
  createSocket?: HomeAssistantSocketFactory;
  clock?: Clock;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  additionalEventTypes?: Array<'automation_triggered' | 'call_service'>;
  onDisconnected?: () => void;
  onConnected?: (connection: HomeAssistantConnection) => void | Promise<void>;
  onError?: (kind: 'socket' | 'event_handler' | 'malformed_message') => void;
};

/**
 * Owns HA WebSocket auth, filtered event subscriptions, and reconnects.
 * Additional passive event kinds use HA's all-events subscription, filtered here.
 * The host owns credentials and supplies an event callback; frame contents are
 * never logged or included in errors.
 */
export class HomeAssistantWebSocketTransport {
  private readonly websocketUrl: string;
  private readonly token: string;
  private readonly createSocket: HomeAssistantSocketFactory;
  private readonly clock: Clock;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly onConnected?: HomeAssistantWebSocketOptions['onConnected'];
  private readonly onError?: HomeAssistantWebSocketOptions['onError'];
  private readonly onDisconnected: (() => void) | undefined;
  private readonly eventTypes: Set<string>;
  private nextCommandId = 1;
  private reconnectAttempt = 0;
  private active = false;
  private generation = 0;
  private socket: HomeAssistantSocket | undefined;
  private reconnectTimer: TimerHandle | undefined;
  private subscriptionId: number | undefined;
  private _status: HomeAssistantConnectionStatus = 'stopped';
  private readonly pendingCalls = new Map<
    number,
    {
      resolve: () => void;
      reject: (error: HomeAssistantServiceCallError) => void;
      timer: TimerHandle;
    }
  >();

  constructor(
    config: { baseUrl: string; token: string },
    private readonly onEvent: (event: unknown) => void,
    options: HomeAssistantWebSocketOptions = {},
  ) {
    const parsed = ConnectionConfigSchema.parse(config);
    this.websocketUrl = toWebSocketUrl(parsed.baseUrl);
    this.token = parsed.token;
    this.createSocket = options.createSocket ?? createNativeWebSocket;
    this.clock = options.clock ?? systemClock;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30_000;
    this.onConnected = options.onConnected;
    this.onError = options.onError;
    this.onDisconnected = options.onDisconnected;
    this.eventTypes = new Set([
      'state_changed',
      ...(options.additionalEventTypes ?? []),
    ]);
    if (
      !Number.isFinite(this.reconnectDelayMs) ||
      this.reconnectDelayMs < 1 ||
      !Number.isFinite(this.maxReconnectDelayMs) ||
      this.maxReconnectDelayMs < this.reconnectDelayMs
    ) {
      throw new Error('Invalid Home Assistant reconnect timing configuration');
    }
  }

  get status(): HomeAssistantConnectionStatus {
    return this._status;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.clearReconnectTimer();
    this.openSocket();
  }

  stop(): void {
    this.active = false;
    this.clearReconnectTimer();
    this.generation += 1;
    const socket = this.socket;
    this.socket = undefined;
    this.subscriptionId = undefined;
    this._status = 'stopped';
    this.abandonPendingCalls();
    this.notifyDisconnected();
    if (socket) this.closeSocket(socket);
  }

  /**
   * Sends a service call on the connected socket, which avoids a REST request
   * (and often a TCP connect) per light. Returns undefined when no
   * authenticated subscription exists; nothing was sent and the caller may
   * use another transport. The promise resolves on HA's success result.
   */
  callService(
    call: HomeAssistantServiceCall,
    timeoutMs = 10_000,
  ): Promise<void> | undefined {
    const socket = this.socket;
    if (!socket || this._status !== 'connected') return undefined;
    const id = this.nextCommandId++;
    const frame = JSON.stringify({
      id,
      type: 'call_service',
      domain: call.domain,
      service: call.service,
      service_data: call.serviceData,
      target: call.target,
    });
    try {
      socket.send(frame);
    } catch {
      this.connectionLost(socket, this.generation);
      return undefined;
    }
    return new Promise<void>((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        this.pendingCalls.delete(id);
        reject(new HomeAssistantServiceCallError('no_response'));
      }, timeoutMs);
      this.pendingCalls.set(id, { resolve, reject, timer });
    });
  }

  private openSocket(): void {
    if (!this.active) return;
    this._status = 'connecting';
    this.subscriptionId = undefined;
    const generation = ++this.generation;
    let socket: HomeAssistantSocket;
    try {
      socket = this.createSocket(this.websocketUrl);
    } catch {
      this._status = 'disconnected';
      this.reportError('socket');
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      if (this.isCurrent(socket, generation)) this.receive(event.data, socket);
    });
    socket.addEventListener('close', () =>
      this.connectionLost(socket, generation),
    );
    socket.addEventListener('error', () =>
      this.connectionLost(socket, generation),
    );
  }

  private receive(data: unknown, socket: HomeAssistantSocket): void {
    if (typeof data !== 'string') return;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      this.reportError('malformed_message');
      return;
    }
    const parsed = ServerMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;

    if (message.type === 'auth_required') {
      if (this._status !== 'connecting') return;
      this._status = 'authenticating';
      this.send(socket, { type: 'auth', access_token: this.token });
      return;
    }

    if (message.type === 'auth_invalid') {
      this.failAuthentication(socket);
      return;
    }

    if (message.type === 'auth_ok') {
      if (this._status !== 'authenticating') return;
      const id = this.nextCommandId++;
      this.subscriptionId = id;
      this._status = 'subscribing';
      this.send(socket, {
        id,
        type: 'subscribe_events',
        ...(this.eventTypes.size === 1 ? { event_type: 'state_changed' } : {}),
      });
      return;
    }

    if (
      message.type === 'result' &&
      message.id === this.subscriptionId &&
      this._status === 'subscribing'
    ) {
      if (message.success) {
        this._status = 'connected';
        this.reconnectAttempt = 0;
        try {
          const generation = this.generation;
          const result = this.onConnected?.({
            isCurrent: () =>
              this.isCurrent(socket, generation) &&
              this._status === 'connected',
          });
          void Promise.resolve(result).catch(() =>
            this.reportError('event_handler'),
          );
        } catch {
          this.reportError('event_handler');
        }
      } else {
        this.connectionLost(socket, this.generation);
      }
      return;
    }

    if (message.type === 'result' && message.id !== undefined) {
      const pending = this.pendingCalls.get(message.id);
      if (pending) {
        this.pendingCalls.delete(message.id);
        this.clock.clearTimeout(pending.timer);
        if (message.success === true) pending.resolve();
        else
          pending.reject(
            new HomeAssistantServiceCallError('rejected', message.error?.code),
          );
        return;
      }
    }

    if (
      message.type === 'event' &&
      message.id === this.subscriptionId &&
      this._status === 'connected'
    ) {
      const stateChangedFrame = EventFrameSchema.safeParse(raw);
      if (
        !stateChangedFrame.success ||
        !this.eventTypes.has(stateChangedFrame.data.event.event_type)
      )
        return;
      try {
        this.onEvent(stateChangedFrame.data);
      } catch {
        this.reportError('event_handler');
      }
    }
  }

  private send(socket: HomeAssistantSocket, message: unknown): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      if (socket === this.socket) this.connectionLost(socket, this.generation);
    }
  }

  /** Sent frames without a result may still have executed in HA. */
  private abandonPendingCalls(): void {
    const pending = [...this.pendingCalls.values()];
    this.pendingCalls.clear();
    for (const call of pending) {
      this.clock.clearTimeout(call.timer);
      call.reject(new HomeAssistantServiceCallError('no_response'));
    }
  }

  private failAuthentication(socket: HomeAssistantSocket): void {
    if (socket !== this.socket) return;
    this.active = false;
    this.socket = undefined;
    this.subscriptionId = undefined;
    this.generation += 1;
    this._status = 'failed';
    this.abandonPendingCalls();
    this.notifyDisconnected();
    this.closeSocket(socket);
  }

  private connectionLost(
    socket: HomeAssistantSocket,
    generation: number,
  ): void {
    if (!this.isCurrent(socket, generation)) return;
    this.abandonPendingCalls();
    this.notifyDisconnected();
    this.reportError('socket');
    this.socket = undefined;
    this.subscriptionId = undefined;
    this.generation += 1;
    this.closeSocket(socket);
    if (!this.active) {
      this._status = 'stopped';
      return;
    }
    this._status = 'disconnected';
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.active || this.reconnectTimer !== undefined) return;
    const multiplier = 2 ** Math.min(this.reconnectAttempt, 30);
    const delayMs = Math.min(
      this.reconnectDelayMs * multiplier,
      this.maxReconnectDelayMs,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openSocket();
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === undefined) return;
    this.clock.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private closeSocket(socket: HomeAssistantSocket): void {
    try {
      socket.close();
    } catch {
      this.reportError('socket');
    }
  }

  private notifyDisconnected(): void {
    try {
      this.onDisconnected?.();
    } catch {
      this.reportError('event_handler');
    }
  }

  private reportError(
    kind: 'socket' | 'event_handler' | 'malformed_message',
  ): void {
    try {
      this.onError?.(kind);
    } catch {
      // Reporting errors must not escape a WebSocket event callback.
    }
  }

  private isCurrent(socket: HomeAssistantSocket, generation: number): boolean {
    return (
      this.active && socket === this.socket && generation === this.generation
    );
  }
}

function toWebSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}/api/websocket`;
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function createNativeWebSocket(url: string): HomeAssistantSocket {
  const constructor = (
    globalThis as unknown as {
      WebSocket?: new (socketUrl: string) => HomeAssistantSocket;
    }
  ).WebSocket;
  if (!constructor)
    throw new Error('This Node.js runtime does not provide global WebSocket');
  return new constructor(url);
}
