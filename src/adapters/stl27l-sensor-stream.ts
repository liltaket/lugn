import { z } from 'zod';

const MAX_FRAME_CHARACTERS = 1_000_000;
const MAX_POINTS = 5_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
// The sensor streams at least every 200 ms; silence means its scan loop stopped.
const STALE_AFTER_MS = 5_000;

const Scalar = z.union([z.number(), z.boolean(), z.string(), z.null()]);

/**
 * One live radar frame from the sensor. Only fields the control panel draws
 * are kept; everything else, including the door entity id and serial port, is
 * dropped before a frame can reach a browser.
 */
export const SensorFrameSchema = z.object({
  timestamp: z.string().max(64),
  scan_id: z.number().int().optional(),
  metrics: z.object({
    lidar_hz: z.number(),
    points_per_second: z.number(),
    total_scans: z.number(),
    crc_errors: z.number(),
  }),
  state: z.object({
    count: z.number().int(),
    quality: z.enum(['CERTAIN', 'DEGRADED', 'UNCERTAIN']),
    confidence: z.number(),
    last_direction: z.string().max(32).nullable(),
  }),
  preview_active: z.boolean(),
  preview_info: z
    .object({
      approaching_tracks: z
        .array(z.record(z.string(), Scalar))
        .max(16)
        .default([]),
    })
    .optional(),
  door: z
    .object({
      enabled: z.boolean(),
      connected: z.boolean(),
      state: z.string().max(32).nullable(),
      blocking: z.boolean(),
    })
    .optional(),
  points: z
    .array(z.tuple([z.number(), z.number(), z.boolean()]))
    .max(MAX_POINTS),
  clusters: z
    .array(
      z.object({
        x: z.number(),
        y: z.number(),
        diameter: z.number(),
        points: z.number(),
      }),
    )
    .max(64),
  tracks: z
    .array(
      z.object({
        id: z.number(),
        state: z.string().max(32),
        x: z.number(),
        y: z.number(),
        vx: z.number(),
        vy: z.number(),
        is_moving: z.boolean(),
        is_static: z.boolean(),
        trajectory: z.array(z.tuple([z.number(), z.number()])).max(32),
      }),
    )
    .max(64),
  config: z.record(z.string(), z.union([z.number(), z.boolean()])),
});
export type SensorFrame = z.infer<typeof SensorFrameSchema>;

/** Pre-serialized so one frame can be written to every viewer unchanged. */
export type SensorStreamMessage =
  { type: 'frame'; data: string } | { type: 'status'; data: string };

type SocketHandlers = {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
};
export type SensorSocketFactory = (url: string) => SocketHandlers;

/**
 * Relays the sensor's radar WebSocket to any number of local viewers over one
 * upstream connection. The runtime's blackbox is also a subscriber, keeping
 * the retrospective window warm without opening a second upstream connection.
 */
export class Stl27lSensorStream {
  private readonly listeners = new Set<
    (message: SensorStreamMessage) => void
  >();
  private socket: SocketHandlers | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private staleTimer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private connected = false;
  private latestFrame: string | undefined;

  constructor(
    private readonly url: string,
    private readonly createSocket: SensorSocketFactory = (target) =>
      new WebSocket(target) as unknown as SocketHandlers,
  ) {}

  get viewerCount(): number {
    return this.listeners.size;
  }

  subscribe(listener: (message: SensorStreamMessage) => void): () => void {
    this.listeners.add(listener);
    listener(this.statusMessage());
    if (this.latestFrame !== undefined)
      listener({ type: 'frame', data: this.latestFrame });
    if (!this.socket && this.reconnectTimer === undefined) this.connect();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.disconnect();
    };
  }

  private statusMessage(): SensorStreamMessage {
    return {
      type: 'status',
      data: JSON.stringify({ connected: this.connected }),
    };
  }

  private emit(message: SensorStreamMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    if (!connected) this.latestFrame = undefined;
    this.emit(this.statusMessage());
  }

  private connect(): void {
    let socket: SocketHandlers;
    try {
      socket = this.createSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.failures = 0;
      this.setConnected(true);
      this.watchForSilence();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      const frame = parseFrame(event.data);
      if (!frame) return;
      // The socket can stay open after the sensor's scan loop stops, so
      // liveness is judged by frames, not by the connection alone.
      this.setConnected(true);
      this.watchForSilence();
      this.latestFrame = frame;
      this.emit({ type: 'frame', data: frame });
    };
    const lost = (): void => {
      if (this.socket !== socket) return;
      if (this.staleTimer !== undefined) clearTimeout(this.staleTimer);
      this.staleTimer = undefined;
      this.socket = undefined;
      this.setConnected(false);
      // An error need not be followed by close: release the old upstream so
      // reconnects cannot leave additional sensor streams running.
      try {
        socket.close();
      } catch {
        /* Already closed. */
      }
      this.scheduleReconnect();
    };
    socket.onclose = lost;
    socket.onerror = lost;
  }

  private watchForSilence(): void {
    if (this.staleTimer !== undefined) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      this.staleTimer = undefined;
      this.setConnected(false);
    }, STALE_AFTER_MS);
    this.staleTimer.unref();
  }

  private scheduleReconnect(): void {
    if (this.listeners.size === 0 || this.reconnectTimer !== undefined) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.failures,
      RECONNECT_MAX_MS,
    );
    this.failures += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.listeners.size > 0) this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private disconnect(): void {
    if (this.staleTimer !== undefined) clearTimeout(this.staleTimer);
    this.staleTimer = undefined;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.failures = 0;
    this.connected = false;
    this.latestFrame = undefined;
    try {
      socket?.close();
    } catch {
      // The socket is already gone.
    }
  }

  /** Stop relaying; used on shutdown. */
  close(): void {
    this.listeners.clear();
    this.disconnect();
  }
}

function parseFrame(data: unknown): string | undefined {
  if (typeof data !== 'string' || data.length > MAX_FRAME_CHARACTERS) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }
  const frame = SensorFrameSchema.safeParse(parsed);
  return frame.success ? JSON.stringify(frame.data) : undefined;
}
