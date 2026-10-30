import { createHash, randomBytes } from 'node:crypto';
import type {
  ComputerAudioRoute,
  ComputerNowPlayingSelector,
} from '../application/computer-now-playing.js';
import { ComputerArtworkSchema } from '../core/computer.js';
import type {
  ArtworkAsset,
  ArtworkMap,
  ArtworkProvider,
  HomeAssistantArtworkMetadata,
} from '../core/artwork.js';
import { systemClock, type Clock } from '../core/clock.js';
import type { RoomState } from '../core/schemas.js';

export type HomeAssistantArtworkOptions = {
  /** Fixed trusted HA base URL (including any path prefix). No startup I/O. */
  baseUrl: string;
  token: string;
  entities: Readonly<Record<string, string>>;
  /** Read server-only metadata from HomeAssistantMusicAdapter.artworkMetadata. */
  metadataProvider: (target: string) => HomeAssistantArtworkMetadata | null;
  observationTrusted?: (target: string) => boolean;
  /** Suppress receiver artwork while a mapped computer input supplies playback. */
  excludedSources?: Readonly<Record<string, readonly string[]>>;
  /** Explicit opt-in routes only; selection is shared with the dashboard. */
  computer?: {
    routes: Readonly<Record<string, ComputerAudioRoute>>;
    selector: ComputerNowPlayingSelector;
  };
  maxEntries?: number;
  maxBytes?: number;
  maxImageBytes?: number;
  maxConcurrent?: number;
  timeoutMs?: number;
  /** External CDN connection setup can exceed the local HA deadline. */
  computerTimeoutMs?: number;
  positiveTtlMs?: number;
  negativeTtlMs?: number;
};
type Descriptor = {
  key: string;
  target: string;
  path: string;
  source: 'home_assistant' | 'computer';
  inlineAsset?: ArtworkAsset;
};
type Entry = Descriptor & {
  token: string;
  expiresAt: number;
  asset: ArtworkAsset | null;
  pending: boolean;
  abort: AbortController;
};

/** Process-local, bounded image cache. The browser never supplies an upstream URL. */
export class HomeAssistantArtworkService implements ArtworkProvider {
  private readonly upstreamBaseUrl: string;
  private readonly basePath: string;
  private readonly entries = new Map<string, Entry>();
  private readonly byToken = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private readonly limits;
  private active = 0;
  private disposed = false;

  constructor(
    private readonly options: HomeAssistantArtworkOptions,
    private readonly transport: typeof fetch,
    private readonly clock: Clock = systemClock,
  ) {
    const url = new URL(options.baseUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Artwork requires a fixed HTTP(S) HA base URL');
    if (!options.token || /[\r\n]/.test(options.token))
      throw new Error('Invalid HA credential');
    if (
      Object.values(options.entities).some(
        (id) => !/^media_player\.[a-z0-9_]+$/.test(id),
      )
    )
      throw new Error('Invalid artwork entity mapping');
    this.basePath = url.pathname.replace(/\/+$/, '');
    this.upstreamBaseUrl = `${url.origin}${this.basePath}`;
    this.limits = {
      entries: options.maxEntries ?? 64,
      bytes: options.maxBytes ?? 8 * 1024 * 1024,
      imageBytes: options.maxImageBytes ?? 2 * 1024 * 1024,
      concurrent: options.maxConcurrent ?? 2,
      timeout: options.timeoutMs ?? 3000,
      computerTimeout: options.computerTimeoutMs ?? 8000,
      positiveTtl: options.positiveTtlMs ?? 300_000,
      negativeTtl: options.negativeTtlMs ?? 30_000,
    };
    if (
      Object.values(this.limits).some((n) => !Number.isSafeInteger(n) || n <= 0)
    )
      throw new Error('Artwork limits must be positive integers');
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(state: RoomState, pathPrefix: string): ArtworkMap {
    if (!/^\/(?!\/)[A-Za-z0-9_/-]+\/$/.test(pathPrefix))
      throw new Error('Artwork route must be a same-origin path prefix');
    this.prune();
    const result: ArtworkMap = {};
    let admitted = 0;
    for (const target of Object.keys(state.music.devices)) {
      const descriptor = this.descriptor(target, state);
      if (!descriptor || this.disposed) {
        const rejected =
          !!this.options.metadataProvider(target)?.entityPicture &&
          this.eligible(target, state);
        result[target] = {
          url: null,
          status: rejected ? 'unavailable' : 'missing',
          source: rejected ? 'home_assistant' : null,
        };
        continue;
      }
      // A snapshot may cover more players than the cache can retain. Do not
      // continuously evict/refetch active players through resolution notifications.
      if (admitted++ >= this.limits.entries) {
        result[target] = {
          url: null,
          status: 'unavailable',
          source: descriptor.source,
        };
        continue;
      }
      let entry = this.entries.get(descriptor.key);
      if (!entry && this.active < this.limits.concurrent) {
        while (this.entries.size >= this.limits.entries) this.evictOldest();
        entry = {
          ...descriptor,
          token: randomBytes(24).toString('base64url'),
          expiresAt: Infinity,
          asset: null,
          pending: true,
          abort: new AbortController(),
        };
        this.entries.set(entry.key, entry);
        this.byToken.set(entry.token, entry);
        // Schedule after returning the snapshot: even injected fetch cannot block it.
        void Promise.resolve().then(() => this.load(entry!));
        this.active++;
      }
      if (entry) {
        this.entries.delete(entry.key);
        this.entries.set(entry.key, entry);
      }
      result[target] = {
        url: entry?.asset ? `${pathPrefix}${entry.token}` : null,
        status: entry?.asset ? 'available' : 'unavailable',
        source: descriptor.source,
      };
    }
    return result;
  }

  async read(token: string, state: RoomState): Promise<ArtworkAsset | null> {
    this.prune();
    const entry = this.byToken.get(token);
    if (
      !entry ||
      this.disposed ||
      this.descriptor(entry.target, state)?.key !== entry.key
    )
      return null;
    return entry.asset
      ? { ...entry.asset, body: new Uint8Array(entry.asset.body) }
      : null;
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of [...this.entries.values()]) this.remove(entry);
    this.listeners.clear();
  }

  private eligible(target: string, state: RoomState): boolean {
    const device = state.music.devices[target];
    const metadata = this.options.metadataProvider(target);
    return (
      !!device &&
      !!metadata &&
      (this.options.observationTrusted?.(target) ?? true) &&
      metadata.source === device.observed.source &&
      metadata.title === device.observed.title &&
      metadata.artist === (device.observed.artist ?? null) &&
      metadata.album === (device.observed.album ?? null) &&
      !!this.options.entities[target] &&
      device.availability === 'available' &&
      ['playing', 'paused'].includes(device.observed.playback) &&
      !!(device.observed.title?.trim() || metadata.mediaContentId?.trim()) &&
      !(this.options.excludedSources?.[target] ?? []).includes(
        device.observed.source ?? '',
      )
    );
  }

  private descriptor(target: string, state: RoomState): Descriptor | null {
    const route = this.options.computer?.routes[target];
    if (route && state.music.devices[target]?.observed.source === route.source)
      return this.computerDescriptor(target, route, state);
    if (!this.eligible(target, state)) return null;
    return this.metadataDescriptor(target);
  }

  private computerDescriptor(
    target: string,
    route: ComputerAudioRoute,
    state: RoomState,
  ): Descriptor | null {
    const receiver = state.music.devices[target];
    if (
      !receiver ||
      receiver.availability !== 'available' ||
      !(this.options.observationTrusted?.(target) ?? true) ||
      !['playing', 'paused'].includes(receiver.observed.playback)
    )
      return null;
    const media = this.options.computer!.selector.selectedMedia(state, target);
    const artwork = ComputerArtworkSchema.safeParse(media?.artwork);
    if (!media || !artwork.success) return null;
    const reference = artwork.data;
    const path =
      reference.provider === 'spotify'
        ? `https://i.scdn.co/image/${reference.id}`
        : '';
    let inlineAsset: ArtworkAsset | undefined;
    if (reference.provider === 'inline') {
      const body = Buffer.from(reference.data, 'base64');
      if (
        !body.length ||
        body.length >
          Math.min(24576, this.limits.imageBytes, this.limits.bytes) ||
        body.toString('base64') !== reference.data ||
        !matchesImageType(body, 'image/jpeg')
      )
        return null;
      inlineAsset = { body, contentType: 'image/jpeg' };
    }
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          target,
          route.deviceId,
          state.computer.devices[route.deviceId]?.sessionId,
          media.player,
          media.title,
          media.artists,
          media.album,
          reference,
        ]),
      )
      .digest('hex');
    return {
      key,
      target,
      path,
      source: 'computer',
      ...(inlineAsset ? { inlineAsset } : {}),
    };
  }

  private metadataDescriptor(target: string): Descriptor | null {
    const metadata = this.options.metadataProvider(target);
    if (!metadata) return null;
    const picture =
      this.basePath &&
      metadata.entityPicture?.startsWith(`${this.basePath}/api/`)
        ? metadata.entityPicture.slice(this.basePath.length)
        : metadata.entityPicture;
    const path = safeImagePath(picture, this.options.entities[target]!);
    if (!path) return null;
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          target,
          metadata.generation,
          metadata.source,
          metadata.title,
          metadata.artist,
          metadata.album,
          metadata.mediaContentId,
          path,
        ]),
      )
      .digest('hex');
    return { key, target, path, source: 'home_assistant' };
  }

  private async load(entry: Entry): Promise<void> {
    let cancel: (() => void) | undefined;
    let timeout: ReturnType<Clock['setTimeout']> | undefined;
    try {
      if (entry.abort.signal.aborted) throw new Error('Artwork cancelled');
      const cancelled = new Promise<never>((_, reject) => {
        cancel = () => reject(new Error('Artwork cancelled'));
        entry.abort.signal.addEventListener('abort', cancel, { once: true });
      });
      const expired = new Promise<never>((_, reject) => {
        timeout = this.clock.setTimeout(
          () => {
            entry.abort.abort();
            reject(new Error('Artwork timeout'));
          },
          entry.source === 'computer'
            ? this.limits.computerTimeout
            : this.limits.timeout,
        );
      });
      const image = entry.inlineAsset
        ? Promise.resolve(entry.inlineAsset)
        : this.fetchImage(entry);
      const asset = await Promise.race([image, expired, cancelled]);
      if (
        this.entries.get(entry.key) === entry &&
        !this.disposed &&
        (entry.source === 'computer' ||
          this.metadataDescriptor(entry.target)?.key === entry.key)
      )
        entry.asset = asset;
    } catch {
      // Never log transport errors: they can contain HA URLs or credentials.
    } finally {
      delete entry.inlineAsset;
      if (timeout !== undefined) this.clock.clearTimeout(timeout);
      if (cancel) entry.abort.signal.removeEventListener('abort', cancel);
      entry.abort.abort();
      this.active--;
      entry.pending = false;
      entry.expiresAt =
        this.clock.monotonicNow() +
        (entry.asset ? this.limits.positiveTtl : this.limits.negativeTtl);
      this.prune();
      if (!this.disposed)
        for (const listener of this.listeners) {
          try {
            listener();
          } catch {
            /* Presentation subscribers cannot break cache cleanup. */
          }
        }
    }
  }

  private async fetchImage(entry: Entry): Promise<ArtworkAsset> {
    const response = await this.transport(
      entry.source === 'computer'
        ? entry.path
        : `${this.upstreamBaseUrl}${entry.path}`,
      {
        method: 'GET',
        redirect: 'manual',
        signal: entry.abort.signal,
        headers: {
          ...(entry.source === 'home_assistant'
            ? { Authorization: `Bearer ${this.options.token}` }
            : {}),
          Accept: 'image/jpeg, image/png, image/webp, image/gif',
        },
      },
    );
    try {
      if (response.status !== 200 || response.redirected)
        throw new Error('Artwork unavailable');
      const contentType = response.headers
        .get('content-type')
        ?.split(';')[0]
        ?.trim()
        .toLowerCase();
      if (
        !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(
          contentType ?? '',
        )
      )
        throw new Error('Unsupported artwork type');
      const length = response.headers.get('content-length');
      if (
        length !== null &&
        (!/^\d+$/.test(length) || Number(length) > this.limits.imageBytes)
      )
        throw new Error('Artwork too large');
      if (!response.body) throw new Error('Missing artwork body');
      const reader = response.body.getReader();
      const cancelReader = () => {
        void reader.cancel().catch(() => {});
      };
      entry.abort.signal.addEventListener('abort', cancelReader, {
        once: true,
      });
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > this.limits.imageBytes || size > this.limits.bytes)
            throw new Error('Artwork too large');
          chunks.push(value);
        }
      } finally {
        entry.abort.signal.removeEventListener('abort', cancelReader);
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const body = Buffer.concat(chunks, size);
      if (!matchesImageType(body, contentType!))
        throw new Error('Invalid artwork bytes');
      return { body, contentType: contentType as ArtworkAsset['contentType'] };
    } finally {
      if (!response.body?.locked) void response.body?.cancel().catch(() => {});
    }
  }

  private prune(): void {
    const now = this.clock.monotonicNow();
    for (const entry of this.entries.values())
      if (!entry.pending && entry.expiresAt <= now) this.remove(entry);
    let bytes = [...this.entries.values()].reduce(
      (n, e) => n + (e.asset?.body.byteLength ?? 0),
      0,
    );
    while (bytes > this.limits.bytes) {
      const first = [...this.entries.values()].find((entry) => entry.asset);
      if (!first) break;
      bytes -= first.asset!.body.byteLength;
      // Keep a short negative entry so byte pressure cannot cause an SSE-driven
      // refetch loop for multiple current players.
      first.asset = null;
      first.expiresAt = now + this.limits.negativeTtl;
    }
  }
  private evictOldest(): void {
    const entry = this.entries.values().next().value;
    if (entry) this.remove(entry);
  }
  private remove(entry: Entry): void {
    entry.abort.abort();
    this.entries.delete(entry.key);
    this.byToken.delete(entry.token);
  }
}

/** Strict relative HA image endpoints only; reject encoding and URL normalization tricks. */
export function safeImagePath(
  value: string | null | undefined,
  entityId: string,
): string | null {
  if (!value || value.length > 2048) return null;
  const match =
    /^(\/api\/media_player_proxy\/(media_player\.[a-z0-9_]+)|\/api\/image_proxy\/image\.[a-z0-9_]+)(\?token=[A-Za-z0-9_-]{1,256}(?:&cache=[A-Za-z0-9_-]{1,128})?)?$/.exec(
      value,
    );
  if (!match || (match[2] && match[2] !== entityId)) return null;
  return value;
}

function matchesImageType(body: Uint8Array, type: string): boolean {
  const b = Buffer.from(body);
  if (type === 'image/png')
    return b
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === 'image/jpeg')
    return b[0] === 255 && b[1] === 216 && b[2] === 255;
  if (type === 'image/gif')
    return ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('ascii'));
  return (
    b.subarray(0, 4).toString('ascii') === 'RIFF' &&
    b.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}
