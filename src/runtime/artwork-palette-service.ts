import type { PaletteSource } from '../application/dynamic-lighting.js';
import { paletteFromArtwork, type Rgb } from '../core/artwork-palette.js';
import type { ArtworkProvider } from '../core/artwork.js';
import type { RoomState } from '../core/schemas.js';

const PREFIX = '/palette/';
const MAX_CACHED = 32;

export type ArtworkPaletteOptions = {
  artwork: ArtworkProvider | undefined;
  observationTrusted?: (target: string) => boolean;
};

/**
 * Turns the artwork the room already fetches for its dashboards into lamp
 * colours. It adds no network access: it can only read what the artwork
 * service admits for the track that is playing right now.
 */
export class ArtworkPaletteService implements PaletteSource {
  private readonly cache = new Map<string, readonly Rgb[]>();
  private readonly loading = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | undefined;
  private disposed = false;

  constructor(private readonly options: ArtworkPaletteOptions) {
    this.unsubscribe = options.artwork?.subscribe?.(() => this.notify());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  current(state: RoomState): { playing: boolean; palette: readonly Rgb[] } {
    const target = Object.keys(state.music.devices).find((id) => {
      const device = state.music.devices[id]!;
      return (
        device.availability === 'available' &&
        device.observed.playback === 'playing' &&
        (this.options.observationTrusted?.(id) ?? true)
      );
    });
    if (!target) return { playing: false, palette: [] };
    const observed = state.music.devices[target]!.observed;
    const key = JSON.stringify([
      target,
      observed.source ?? null,
      observed.title ?? null,
      observed.artist ?? null,
      observed.album ?? null,
    ]);
    const cached = this.cache.get(key);
    if (cached) return { playing: true, palette: cached };
    this.load(key, target, state);
    return { playing: true, palette: [] };
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.listeners.clear();
  }

  private load(key: string, target: string, state: RoomState): void {
    const artwork = this.options.artwork;
    if (!artwork || this.loading.has(key)) return;
    const entry = artwork.snapshot(state, PREFIX)[target];
    if (!entry?.url?.startsWith(PREFIX)) return;
    const token = entry.url.slice(PREFIX.length);
    this.loading.add(key);
    void artwork
      .read(token, state)
      .then((asset) => {
        if (this.disposed) return;
        // A failed decode is cached as "no colours" so a track is tried once.
        this.remember(key, asset ? paletteFromArtwork(asset) : []);
        this.notify();
      })
      .catch(() => {
        if (!this.disposed) this.remember(key, []);
      })
      .finally(() => this.loading.delete(key));
  }

  private remember(key: string, palette: readonly Rgb[]): void {
    this.cache.delete(key);
    this.cache.set(key, palette);
    while (this.cache.size > MAX_CACHED)
      this.cache.delete(this.cache.keys().next().value!);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        /* A controller error must not break artwork delivery. */
      }
    }
  }
}
