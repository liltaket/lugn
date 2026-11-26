import {
  createWiimHttpsTransport,
  parseWiimPlayerStatus,
  type WiimTransport,
} from '../adapters/wiim-music.js';
import type { CoverProvider } from './spotify-covers.js';

/** Where a player is in its track, as of `measuredAt` (monotonic ms). */
export type PlayerPlayhead = {
  playing: boolean;
  positionSeconds: number;
  durationSeconds: number;
  measuredAt: number;
  title: string | null;
  artist: string | null;
  album: string | null;
  /** The cover's id, once the cover is here to be served. */
  art?: string;
};

export interface PlayheadProvider {
  /** Null for a player without a source here, or without a position to give. */
  read(target: string): Promise<PlayerPlayhead | null>;
  /** The last answer, if it is recent. Asks nothing. */
  peek?(target: string): PlayerPlayhead | undefined;
  /** Called when a watched player's track or cover changes. */
  subscribe?(listener: () => void): () => void;
  now(): number;
}

const TIMEOUT_MS = 1_500;
/** Two Hubs asking together share one answer from the player. */
const REUSE_MS = 200;
/** A player someone asked about is watched this long, this often. */
const WATCH_FOR_MS = 4_000;
const WATCH_EVERY_MS = 250;
/** An answer older than this says nothing about now. */
const RECENT_MS = 4_000;
/** Metadata that was not yet the track's is asked for again after this. */
const META_RETRY_MS = 250;
/** The only place covers are fetched from, whatever the player names. */
const ART_URL = /^https:\/\/i\.scdn\.co\/image\/([0-9a-f]{20,64})$/;

type Track = { key: string; cover?: string; retryAt: number };

const trackKey = (playhead: PlayerPlayhead) =>
  JSON.stringify([playhead.title, playhead.artist, playhead.album]);

/**
 * The position straight from a WiiM, in milliseconds, with the track and its
 * cover as soon as the player has them. It only reads: the player stays
 * controlled through whichever adapter owns it. Home Assistant reports whole
 * seconds a few at a time, too coarse to follow lyrics with, and a new track
 * seconds late. A player is watched only while someone is asking about it.
 */
export class WiimPlayhead implements PlayheadProvider {
  private readonly pending = new Map<string, Promise<PlayerPlayhead | null>>();
  private readonly latest = new Map<string, PlayerPlayhead>();
  private readonly tracks = new Map<string, Track>();
  private readonly watched = new Map<string, number>();
  private readonly announced = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly hosts: Readonly<Record<string, string>>,
    private readonly transport: WiimTransport = createWiimHttpsTransport(
      TIMEOUT_MS,
    ),
    readonly now: () => number = () => performance.now(),
    private readonly covers?: CoverProvider,
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    const covers = this.covers?.subscribe(() => {
      for (const target of this.latest.keys()) this.announce(target);
    });
    return () => {
      this.listeners.delete(listener);
      covers?.();
    };
  }

  peek(target: string): PlayerPlayhead | undefined {
    const latest = this.latest.get(target);
    return latest && this.now() - latest.measuredAt < RECENT_MS
      ? this.withArt(target, latest)
      : undefined;
  }

  read(target: string): Promise<PlayerPlayhead | null> {
    if (!Object.hasOwn(this.hosts, target)) return Promise.resolve(null);
    this.watched.set(target, this.now() + WATCH_FOR_MS);
    this.watch();
    return this.current(target);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.watched.clear();
    this.listeners.clear();
    this.transport.dispose?.();
  }

  private watch(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const [target, until] of this.watched) {
        if (this.now() >= until) this.watched.delete(target);
        else void this.current(target);
      }
      if (this.watched.size) {
        this.covers?.keepWarm();
        this.watch();
      }
    }, WATCH_EVERY_MS);
    this.timer.unref?.();
  }

  private current(target: string): Promise<PlayerPlayhead | null> {
    const recent = this.latest.get(target);
    if (recent && this.now() - recent.measuredAt < REUSE_MS)
      return Promise.resolve(this.withArt(target, recent));
    let request = this.pending.get(target);
    if (!request) {
      request = this.ask(target, this.hosts[target]!).finally(() =>
        this.pending.delete(target),
      );
      this.pending.set(target, request);
    }
    return request.then(
      (playhead) => playhead && this.withArt(target, playhead),
    );
  }

  // The track's cover: its address from the player once per track, and the
  // image from the cover store, which the answer never waits for.
  private withArt(target: string, playhead: PlayerPlayhead): PlayerPlayhead {
    if (!this.covers) return playhead;
    const key = trackKey(playhead);
    let track = this.tracks.get(target);
    if (!track || track.key !== key) {
      track = { key, retryAt: 0 };
      this.tracks.set(target, track);
    }
    if (track.cover) {
      this.covers.want(track.cover);
      if (this.covers.get(track.cover))
        return { ...playhead, art: track.cover };
    } else if (playhead.title && this.now() >= track.retryAt) {
      // In flight: no other attempt meanwhile.
      track.retryAt = Number.POSITIVE_INFINITY;
      void this.findCover(target, playhead.title, track);
    }
    return playhead;
  }

  private announce(target: string): void {
    const latest = this.latest.get(target);
    if (!latest) return;
    const now = this.withArt(target, latest);
    const key = JSON.stringify([trackKey(now), now.art ?? null]);
    if (this.announced.get(target) === key) return;
    this.announced.set(target, key);
    for (const listener of this.listeners) listener();
  }

  private async findCover(
    target: string,
    title: string,
    track: Track,
  ): Promise<void> {
    try {
      const body = await this.transport.sendCommand(
        this.hosts[target]!,
        'getMetaInfo',
        AbortSignal.timeout(TIMEOUT_MS),
      );
      const meta = (
        JSON.parse(body) as {
          metaData?: { title?: unknown; albumArtURI?: unknown };
        }
      ).metaData;
      // The metadata can still be the last track's for a moment.
      if (typeof meta?.title !== 'string' || meta.title.trim() !== title)
        throw new Error('Metadata for another track');
      const url = typeof meta.albumArtURI === 'string' ? meta.albumArtURI : '';
      // Another source's cover is left to the dashboard's own artwork.
      const id = ART_URL.exec(url)?.[1];
      if (!id) return;
      track.cover = id;
      this.covers?.want(id);
      this.announce(target);
    } catch {
      track.retryAt = this.now() + META_RETRY_MS;
    }
  }

  private async ask(
    target: string,
    host: string,
  ): Promise<PlayerPlayhead | null> {
    try {
      const sent = this.now();
      const body = await this.transport.sendCommand(
        host,
        'getPlayerStatus',
        AbortSignal.timeout(TIMEOUT_MS),
      );
      const received = this.now();
      const status = parseWiimPlayerStatus(body);
      if (
        status.positionSeconds === undefined ||
        status.durationSeconds === undefined
      ) {
        this.latest.delete(target);
        return null;
      }
      const playhead = {
        playing: status.playback === 'playing',
        positionSeconds: status.positionSeconds,
        durationSeconds: status.durationSeconds,
        // The player read its clock about halfway through the round trip.
        measuredAt: (sent + received) / 2,
        title: status.title,
        artist: status.artist,
        album: status.album,
      };
      this.latest.set(target, playhead);
      this.announce(target);
      return playhead;
    } catch {
      return null;
    }
  }
}
