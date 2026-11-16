import { createWriteStream, type WriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { request as httpRequest, type ClientRequest } from 'node:http';

export const RECORDING_FORMAT = 'lugn-device-sim-recording';
export const RECORDING_VERSION = 1;

/** One JSON object per line. `t` is wall milliseconds since recording start. */
export type RecordingLine =
  | {
      type: 'header';
      format: typeof RECORDING_FORMAT;
      version: typeof RECORDING_VERSION;
      recordedAt: number;
      speed: number;
      phoneConfig: unknown;
    }
  | {
      type: 'sse';
      t: number;
      event: string;
      id: string | null;
      data: unknown;
    }
  | { type: 'state'; t: number; data: unknown }
  | { type: 'connection'; t: number; status: 'open' | 'closed' }
  | { type: 'note'; t: number; text: string };

export type SseEvent = { event: string; id: string | null; data: unknown };

/** Incremental `text/event-stream` parser; comments and retry lines are dropped. */
export class SseParser {
  private buffer = '';
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let index: number;
    while ((index = this.buffer.indexOf('\n\n')) >= 0) {
      const block = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      let event = 'message';
      let id: string | null = null;
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('id: ')) id = line.slice(4);
        else if (line.startsWith('data: ')) data.push(line.slice(6));
      }
      if (data.length === 0) continue;
      events.push({ event, id, data: JSON.parse(data.join('\n')) as unknown });
    }
    return events;
  }
}

type Target = { port: number; host: string; token: string };

function get(target: Target, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: target.port,
        path,
        setHost: false,
        headers: {
          host: target.host,
          authorization: `Bearer ${target.token}`,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          try {
            if (response.statusCode !== 200)
              throw new Error(`GET ${path} returned ${response.statusCode}`);
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/**
 * Records what a paired client sees: the SSE stream (snapshots, patches,
 * heartbeats, resumes after restarts) plus a full `GET /state` every
 * `stateEveryMs`. It reconnects with Last-Event-ID like the app should.
 */
export class StreamRecorder {
  private readonly out: WriteStream;
  private readonly startedAt = Date.now();
  private request: ClientRequest | undefined;
  private lastEventId: string | undefined;
  private stateTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  lines = 0;

  constructor(
    private readonly file: string,
    private readonly target: Target,
    private readonly options: {
      speed: () => number;
      stateEveryMs?: number;
      log?: (line: string) => void;
    },
  ) {
    this.out = createWriteStream(file, { flags: 'w', mode: 0o600 });
  }

  async start(): Promise<void> {
    const phoneConfig = await get(this.target, '/api/v1/phone/config').catch(
      () => null,
    );
    this.write({
      type: 'header',
      format: RECORDING_FORMAT,
      version: RECORDING_VERSION,
      recordedAt: this.startedAt,
      speed: this.options.speed(),
      phoneConfig,
    });
    this.connect();
    this.stateTimer = setInterval(
      () => void this.captureState(),
      this.options.stateEveryMs ?? 30_000,
    );
    this.stateTimer.unref();
    await this.captureState();
  }

  note(text: string): void {
    this.write({ type: 'note', t: this.elapsed(), text });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.stateTimer) clearInterval(this.stateTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.request?.destroy();
    await new Promise<void>((resolve) => this.out.end(resolve));
  }

  private elapsed(): number {
    return Date.now() - this.startedAt;
  }

  private write(line: RecordingLine): void {
    this.lines += 1;
    this.out.write(`${JSON.stringify(line)}\n`);
  }

  private async captureState(): Promise<void> {
    if (this.stopped) return;
    try {
      const data = await get(this.target, '/api/v1/state');
      if (!this.stopped) this.write({ type: 'state', t: this.elapsed(), data });
    } catch {
      // The listener is down (restart or offline); the stream records that.
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const parser = new SseParser();
    let opened = false;
    const closed = () => {
      if (this.stopped || this.request !== request) return;
      this.request = undefined;
      if (opened)
        this.write({ type: 'connection', t: this.elapsed(), status: 'closed' });
      this.reconnectTimer = setTimeout(() => this.connect(), 1_000);
      this.reconnectTimer.unref();
    };
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: this.target.port,
        path: '/api/v1/events',
        setHost: false,
        headers: {
          host: this.target.host,
          authorization: `Bearer ${this.target.token}`,
          accept: 'text/event-stream',
          ...(this.lastEventId ? { 'last-event-id': this.lastEventId } : {}),
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          response.on('end', closed);
          return;
        }
        opened = true;
        this.write({ type: 'connection', t: this.elapsed(), status: 'open' });
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          for (const event of parser.push(chunk)) {
            if (event.id) this.lastEventId = event.id;
            this.write({ type: 'sse', t: this.elapsed(), ...event });
            // A fresh snapshot after a restart is also a full state.
            if (event.event === 'snapshot') void this.captureState();
          }
        });
        response.on('close', closed);
      },
    );
    request.on('error', closed);
    request.end();
    this.request = request;
  }

  get path(): string {
    return this.file;
  }
}

export type Recording = {
  header: Extract<RecordingLine, { type: 'header' }>;
  lines: Exclude<RecordingLine, { type: 'header' }>[];
};

export async function loadRecording(file: string): Promise<Recording> {
  const text = await readFile(file, 'utf8');
  const parsed = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line) as RecordingLine;
      } catch {
        throw new Error(`${file}:${index + 1} is not JSON`);
      }
    });
  const header = parsed[0];
  if (
    header?.type !== 'header' ||
    header.format !== RECORDING_FORMAT ||
    header.version !== RECORDING_VERSION
  )
    throw new Error(`${file} is not a device-sim recording`);
  const lines = parsed.slice(1) as Recording['lines'];
  if (
    !lines.some(
      (line) =>
        line.type === 'state' ||
        (line.type === 'sse' && line.event === 'snapshot'),
    )
  )
    throw new Error(`${file} has no snapshot or state to start from`);
  return { header, lines };
}
