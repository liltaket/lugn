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
});
const StateChangedFrameSchema = z.object({
  type: z.literal('event'),
  id: z.number().int().positive(),
  event: z.object({
    event_type: z.literal('state_changed'),
    data: z.record(z.string(), z.unknown()),
  }),
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

export type HomeAssistantWebSocketOptions = {
  createSocket?: HomeAssistantSocketFactory;
  clock?: Clock;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  onError?: (kind: 'socket' | 'event_handler' | 'malformed_message') => void;
};

/**
 * Owns Home Assistant WebSocket auth, state_changed subscription, and reconnects.
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
  private readonly onError?: HomeAssistantWebSocketOptions['onError'];
  private nextCommandId = 1;
  private reconnectAttempt = 0;
  private active = false;
  private generation = 0;
  private socket?: HomeAssistantSocket;
  private reconnectTimer?: TimerHandle;
  private subscriptionId?: number;
  private _status: HomeAssistantConnectionStatus = 'stopped';

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
    this.onError = options.onError;
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
    if (socket) this.closeSocket(socket);
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
        event_type: 'state_changed',
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
      } else {
        this.connectionLost(socket, this.generation);
      }
      return;
    }

    if (
      message.type === 'event' &&
      message.id === this.subscriptionId &&
      this._status === 'connected'
    ) {
      const stateChangedFrame = StateChangedFrameSchema.safeParse(raw);
      if (!stateChangedFrame.success) return;
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

  private failAuthentication(socket: HomeAssistantSocket): void {
    if (socket !== this.socket) return;
    this.active = false;
    this.socket = undefined;
    this.subscriptionId = undefined;
    this.generation += 1;
    this._status = 'failed';
    this.closeSocket(socket);
  }

  private connectionLost(
    socket: HomeAssistantSocket,
    generation: number,
  ): void {
    if (!this.isCurrent(socket, generation)) return;
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
