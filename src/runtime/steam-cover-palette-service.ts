import type { GameCoverSource } from '../application/dynamic-lighting.js';
import { paletteFromArtwork, type Rgb } from '../core/artwork-palette.js';
import { systemClock, type Clock } from '../core/clock.js';

const CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps';
/** Portrait cover first; older or smaller titles only have the wide header. */
const IMAGES = ['library_600x900.jpg', 'header.jpg'] as const;
const MAX_CACHED = 32;

export type SteamCoverPaletteOptions = {
  transport?: typeof fetch;
  clock?: Clock;
  timeoutMs?: number;
  maxImageBytes?: number;
  /** How long a failed lookup is left alone before the next attempt. */
  retryAfterMs?: number;
};

/**
 * Turns a Steam game's public cover into lamp colours. The app id comes from
 * the focused window's class (`steam_app_<id>`); it is validated as digits and
 * only ever placed in a fixed Steam CDN URL. Each game is fetched once and
 * remembered, and `current` never waits for the network.
 */
export class SteamCoverPaletteService implements GameCoverSource {
  private readonly cache = new Map<string, readonly Rgb[]>();
  private readonly failedAt = new Map<string, number>();
  private readonly loading = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly abort = new AbortController();
  private readonly transport: typeof fetch;
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly maxImageBytes: number;
  private readonly retryAfterMs: number;

  constructor(options: SteamCoverPaletteOptions = {}) {
    this.transport = options.transport ?? fetch;
    this.clock = options.clock ?? systemClock;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.maxImageBytes = options.maxImageBytes ?? 2 * 1024 * 1024;
    this.retryAfterMs = options.retryAfterMs ?? 120_000;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  current(appId: string): readonly Rgb[] {
    if (!/^[1-9]\d{0,9}$/.test(appId)) return [];
    const cached = this.cache.get(appId);
    if (cached) return cached;
    const failed = this.failedAt.get(appId);
    const retry =
      failed === undefined ||
      this.clock.monotonicNow() - failed >= this.retryAfterMs;
    if (retry && !this.loading.has(appId) && !this.abort.signal.aborted)
      void this.load(appId);
    return [];
  }

  dispose(): void {
    this.abort.abort();
    this.listeners.clear();
  }

  private async load(appId: string): Promise<void> {
    this.loading.add(appId);
    try {
      let decoded = false;
      for (const image of IMAGES) {
        const asset = await this.fetchImage(`${CDN}/${appId}/${image}`);
        if (!asset) continue;
        decoded = true;
        const palette = paletteFromArtwork(asset);
        // A grey or dark portrait cover may still sit next to a colourful header.
        if (palette.length === 0) continue;
        this.remember(appId, palette);
        this.failedAt.delete(appId);
        this.notify();
        return;
      }
      if (decoded) {
        // Every image was real but without colour: remembered as "none".
        this.remember(appId, []);
        this.failedAt.delete(appId);
      } else {
        this.failedAt.set(appId, this.clock.monotonicNow());
      }
    } catch {
      this.failedAt.set(appId, this.clock.monotonicNow());
    } finally {
      this.loading.delete(appId);
    }
  }

  private async fetchImage(
    url: string,
  ): Promise<{ body: Uint8Array; contentType: 'image/jpeg' } | null> {
    const signal = AbortSignal.any([
      this.abort.signal,
      AbortSignal.timeout(this.timeoutMs),
    ]);
    const response = await this.transport(url, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: { Accept: 'image/jpeg' },
    });
    try {
      if (response.status !== 200) return null;
      const type = response.headers
        .get('content-type')
        ?.split(';')[0]
        ?.trim()
        .toLowerCase();
      if (type !== 'image/jpeg') return null;
      const length = response.headers.get('content-length');
      if (
        length !== null &&
        (!/^\d+$/.test(length) || Number(length) > this.maxImageBytes)
      )
        return null;
      if (!response.body) return null;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > this.maxImageBytes) return null;
          chunks.push(value);
        }
      } finally {
        void reader.cancel().catch(() => {});
      }
      const body = Buffer.concat(chunks, size);
      // JPEG magic bytes: never hand anything else to the decoder.
      if (body[0] !== 0xff || body[1] !== 0xd8 || body[2] !== 0xff) return null;
      return { body, contentType: 'image/jpeg' };
    } finally {
      void response.body?.cancel().catch(() => {});
    }
  }

  private remember(appId: string, palette: readonly Rgb[]): void {
    this.cache.delete(appId);
    this.cache.set(appId, palette);
    while (this.cache.size > MAX_CACHED)
      this.cache.delete(this.cache.keys().next().value!);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        /* A controller error must not break cover delivery. */
      }
    }
  }
}
