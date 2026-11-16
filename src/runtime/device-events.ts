import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildSections,
  buildStateView,
  sectionsForDomains,
  type StateViewSources,
} from '../application/state-view.js';
import type { Clock } from '../core/clock.js';
import {
  StateViewSectionNames,
  type StatePatch,
  type StateViewSection,
  type StateViewSections,
} from '../core/device-api.js';
import type { StateEventStream } from '../core/event-stream.js';
import type { StateUpdate } from '../core/schemas.js';
import { deviceResponseHeaders, sendJson } from './device-http.js';

const HEARTBEAT_MS = 15_000;
/** Streams end after this long; the client reconnects with Last-Event-ID. */
const MAX_STREAM_MS = 30 * 60_000;
const MAX_STREAMS_PER_DEVICE = 2;
const MAX_STREAMS = 16;

type Stream = {
  deviceId: string;
  response: ServerResponse;
  openedAt: number;
  /** A slow client skipped a patch and must receive a full snapshot on drain. */
  resync: boolean;
};

/**
 * Server-sent state for paired devices. Event ids are `<instanceId>-<revision>`
 * so a resume after a restart is detected even when the engine revision has
 * caught up with the client's number. Patches replace whole view sections.
 */
export class DeviceEventHub {
  private readonly streams = new Set<Stream>();
  private baseline: Map<StateViewSection, string> | undefined;
  private unsubscribers: Array<() => void> = [];
  private pending: NodeJS.Immediate | undefined;
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(
    private readonly options: {
      sources: StateViewSources;
      stream: Pick<StateEventStream, 'subscribe' | 'resume'>;
      /** Extra change sources outside the engine revision (routines, suggestions). */
      subscribeAuxiliary?: Array<(listener: () => void) => () => void>;
      clock: Pick<Clock, 'now'>;
    },
  ) {}

  get size(): number {
    return this.streams.size;
  }

  open(
    deviceId: string,
    request: IncomingMessage,
    response: ServerResponse,
    lastEventId: string | undefined,
  ): void {
    if (this.streams.size >= MAX_STREAMS) {
      sendJson(response, 503, { error: 'too_many_event_streams' });
      return;
    }
    const own = [...this.streams].filter((s) => s.deviceId === deviceId);
    // A reconnecting phone replaces its oldest stream instead of being refused.
    while (own.length >= MAX_STREAMS_PER_DEVICE) own.shift()!.response.end();
    response.writeHead(200, {
      ...deviceResponseHeaders,
      'cache-control': 'no-cache, no-store, no-transform',
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    request.socket.setNoDelay(true);
    request.socket.setKeepAlive(true, HEARTBEAT_MS);
    const stream: Stream = {
      deviceId,
      response,
      openedAt: this.options.clock.now(),
      resync: false,
    };
    if (this.streams.size === 0) this.activate();
    this.streams.add(stream);
    response.once('close', () => this.remove(stream));
    response.on('drain', () => {
      if (!stream.resync) return;
      stream.resync = false;
      this.writeSnapshot(stream);
    });
    response.write('retry: 5000\n\n');
    this.writeInitial(stream, lastEventId);
  }

  /** Ends every stream of a device, for example after revocation. */
  closeDevice(deviceId: string): void {
    for (const stream of this.streams)
      if (stream.deviceId === deviceId) stream.response.end();
  }

  closeAll(): void {
    for (const stream of this.streams) stream.response.destroy();
    this.streams.clear();
    this.deactivate();
  }

  private eventId(revision: number): string {
    return `${this.options.sources.instanceId}-${revision}`;
  }

  private writeInitial(stream: Stream, lastEventId: string | undefined): void {
    const state = this.options.sources.engine.state;
    const match = /^([A-Za-z0-9]+)-(\d{1,15})$/.exec(lastEventId ?? '');
    if (match && match[1] === this.options.sources.instanceId) {
      const delivery = this.options.stream.resume(Number(match[2]), state);
      if (delivery.kind === 'updates') {
        const sections = sectionsForDomains(
          delivery.updates.flatMap((update) => update.domains),
        );
        const all = buildSections(this.options.sources);
        this.writePatch(stream, pick(all, sections), state.revision);
        return;
      }
    }
    this.writeSnapshot(stream);
  }

  private writeSnapshot(stream: Stream): void {
    const view = buildStateView(this.options.sources);
    write(stream, 'snapshot', this.eventId(view.revision), view);
  }

  private writePatch(
    stream: Stream,
    sections: Partial<StateViewSections>,
    revision: number,
  ): void {
    const patch: StatePatch = {
      instanceId: this.options.sources.instanceId,
      revision,
      generatedAt: this.options.clock.now(),
      sections,
    };
    if (stream.response.writableNeedDrain) {
      stream.resync = true;
      return;
    }
    write(stream, 'patch', this.eventId(revision), patch);
  }

  private activate(): void {
    this.baseline = serialize(buildSections(this.options.sources));
    const schedule = (): void => {
      if (this.pending) return;
      this.pending = setImmediate(() => {
        this.pending = undefined;
        this.broadcast();
      });
    };
    this.unsubscribers = [
      this.options.stream.subscribe((update: Readonly<StateUpdate>) => {
        // Timing-only publications cannot change the view.
        if (update.domains.length === 1 && update.domains[0] === 'timings')
          return;
        schedule();
      }),
      ...(this.options.subscribeAuxiliary ?? []).map((subscribe) =>
        subscribe(schedule),
      ),
    ];
    this.heartbeat = setInterval(() => this.tick(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  private deactivate(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    if (this.pending) clearImmediate(this.pending);
    this.pending = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.baseline = undefined;
  }

  private remove(stream: Stream): void {
    if (!this.streams.delete(stream)) return;
    if (this.streams.size === 0) this.deactivate();
  }

  /** Sends sections that differ from the last broadcast to every stream. */
  broadcast(): void {
    if (this.streams.size === 0) return;
    const sections = buildSections(this.options.sources);
    const next = serialize(sections);
    const changed = new Set<StateViewSection>();
    for (const [name, value] of next)
      if (this.baseline?.get(name) !== value) changed.add(name);
    this.baseline = next;
    if (changed.size === 0) return;
    const revision = this.options.sources.engine.state.revision;
    const patch = pick(sections, changed);
    for (const stream of this.streams) this.writePatch(stream, patch, revision);
  }

  /** Heartbeats also pick up clock-driven changes such as quiet hours. */
  private tick(): void {
    this.broadcast();
    const now = this.options.clock.now();
    const revision = this.options.sources.engine.state.revision;
    for (const stream of this.streams) {
      if (now - stream.openedAt >= MAX_STREAM_MS) {
        stream.response.end();
        continue;
      }
      if (stream.response.writableNeedDrain) continue;
      stream.response.write(
        `event: heartbeat\ndata: ${JSON.stringify({
          instanceId: this.options.sources.instanceId,
          revision,
          serverTime: now,
        })}\n\n`,
      );
    }
  }
}

function write(
  stream: Stream,
  event: 'snapshot' | 'patch',
  id: string,
  data: unknown,
): void {
  if (stream.response.destroyed) return;
  stream.response.write(
    `event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

function serialize(sections: StateViewSections): Map<StateViewSection, string> {
  return new Map(
    StateViewSectionNames.map((name) => [name, JSON.stringify(sections[name])]),
  );
}

function pick(
  sections: StateViewSections,
  names: Iterable<StateViewSection>,
): Partial<StateViewSections> {
  const result: Partial<Record<StateViewSection, unknown>> = {};
  for (const name of names) result[name] = sections[name];
  return result as Partial<StateViewSections>;
}
