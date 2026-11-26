import { Agent, request } from 'node:https';

export type Cover = { body: Uint8Array; contentType: 'image/jpeg' };

export interface CoverProvider {
  /** Fetches the cover in the background, once, unless it is already here. */
  want(id: string): void;
  get(id: string): Cover | undefined;
  /** Called when a wanted cover has arrived. */
  subscribe(listener: () => void): () => void;
  /** Keeps the connection open while someone is looking, so the next is quick. */
  keepWarm(): void;
}

/** One request to the image host; the body, or null for a bad answer. */
export type CoverTransport = (
  url: string,
  method: 'GET' | 'HEAD',
) => Promise<Uint8Array | null>;

/** A Spotify image id: the only thing that is ever put into the address. */
export const COVER_ID = /^[0-9a-f]{20,64}$/;
const BASE_URL = 'https://i.scdn.co/image/';
const TIMEOUT_MS = 4_000;
const MAX_BYTES = 2 * 1024 * 1024;
const ENTRIES = 24;
const RETRY_MS = 1_000;
/** The host keeps an idle connection for at least this long. */
const WARM_MS = 40_000;

export function httpsCoverTransport(): CoverTransport {
  // A new connection costs several times what the image does: it is kept.
  const agent = new Agent({ keepAlive: true, maxSockets: 2 });
  return (url, method) =>
    new Promise((resolve) => {
      const req = request(
        url,
        { agent, method, signal: AbortSignal.timeout(TIMEOUT_MS) },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > MAX_BYTES) req.destroy();
            else chunks.push(chunk);
          });
          response.on('end', () =>
            resolve(response.statusCode === 200 ? Buffer.concat(chunks) : null),
          );
          response.on('error', () => resolve(null));
        },
      );
      req.on('error', () => resolve(null));
      req.end();
    });
}

/**
 * Covers from Spotify's image host, kept in memory and served to the Hubs by
 * Lugn. Only JPEGs of a sensible size are kept, and redirects are not followed.
 */
export class SpotifyCovers implements CoverProvider {
  private readonly covers = new Map<string, Cover>();
  /** Ids in flight (Infinity), or not to be asked for again until then. */
  private readonly held = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private last: { id: string; at: number } | undefined;

  constructor(
    private readonly transport: CoverTransport = httpsCoverTransport(),
    private readonly now: () => number = () => performance.now(),
  ) {}

  get(id: string): Cover | undefined {
    return this.covers.get(id);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  want(id: string): void {
    if (!COVER_ID.test(id) || this.covers.has(id)) return;
    if (this.now() < (this.held.get(id) ?? 0)) return;
    this.held.set(id, Number.POSITIVE_INFINITY);
    void this.load(id);
  }

  keepWarm(): void {
    const last = this.last;
    if (!last || this.now() - last.at < WARM_MS) return;
    last.at = this.now();
    void this.transport(`${BASE_URL}${last.id}`, 'HEAD').catch(() => null);
  }

  private async load(id: string): Promise<void> {
    this.last = { id, at: this.now() };
    const body = await this.transport(`${BASE_URL}${id}`, 'GET').catch(
      () => null,
    );
    if (
      !body ||
      body.length > MAX_BYTES ||
      body[0] !== 0xff ||
      body[1] !== 0xd8
    ) {
      this.held.set(id, this.now() + RETRY_MS);
      while (this.held.size > ENTRIES)
        this.held.delete(this.held.keys().next().value!);
      return;
    }
    this.held.delete(id);
    this.covers.set(id, { body, contentType: 'image/jpeg' });
    while (this.covers.size > ENTRIES)
      this.covers.delete(this.covers.keys().next().value!);
    for (const listener of this.listeners) listener();
  }
}
