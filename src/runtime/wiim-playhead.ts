import {
  createWiimHttpsTransport,
  parseWiimPlayerStatus,
  type WiimTransport,
} from '../adapters/wiim-music.js';

/** Where a player is in its track, as of `measuredAt` (monotonic ms). */
export type PlayerPlayhead = {
  playing: boolean;
  positionSeconds: number;
  durationSeconds: number;
  measuredAt: number;
  title: string | null;
  artist: string | null;
  album: string | null;
  /** The cover's id for `art`, once it has been fetched. */
  art?: string;
};

export type PlayerArt = { body: Uint8Array; contentType: 'image/jpeg' };

export interface PlayheadProvider {
  /** Null for a player without a source here, or without a position to give. */
  read(target: string): Promise<PlayerPlayhead | null>;
  now(): number;
  art?(id: string): PlayerArt | undefined;
}

const TIMEOUT_MS = 1_500;
const ART_TIMEOUT_MS = 4_000;
const ART_MAX_BYTES = 2 * 1024 * 1024;
const ART_ENTRIES = 12;
/** A cover that could not be had is asked for again after this long. */
const ART_RETRY_MS = 1_000;
/** The only place covers are fetched from, whatever the player names. */
const ART_URL = /^https:\/\/i\.scdn\.co\/image\/([0-9a-f]{20,64})$/;
/** Two Hubs asking together share one answer from the player. */
const REUSE_MS = 200;

const trackKey = (playhead: PlayerPlayhead) =>
  JSON.stringify([playhead.title, playhead.artist, playhead.album]);

/**
 * The position straight from a WiiM, in milliseconds. It only reads: the
 * player stays controlled through whichever adapter owns it. Home Assistant
 * reports whole seconds a few at a time, too coarse to follow lyrics with.
 */
export class WiimPlayhead implements PlayheadProvider {
  private readonly pending = new Map<string, Promise<PlayerPlayhead | null>>();
  private readonly latest = new Map<string, PlayerPlayhead>();
  private readonly covers = new Map<string, PlayerArt>();
  /** The newest track's cover per target: its id, or when to try again. */
  private readonly tracks = new Map<
    string,
    { key: string; art?: string; retryAt: number }
  >();

  constructor(
    private readonly hosts: Readonly<Record<string, string>>,
    private readonly transport: WiimTransport = createWiimHttpsTransport(
      TIMEOUT_MS,
    ),
    readonly now: () => number = () => performance.now(),
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  art(id: string): PlayerArt | undefined {
    return this.covers.get(id);
  }

  read(target: string): Promise<PlayerPlayhead | null> {
    const host = Object.hasOwn(this.hosts, target)
      ? this.hosts[target]
      : undefined;
    if (!host) return Promise.resolve(null);
    const recent = this.latest.get(target);
    if (recent && this.now() - recent.measuredAt < REUSE_MS)
      return Promise.resolve(this.withArt(target, recent));
    let request = this.pending.get(target);
    if (!request) {
      request = this.ask(target, host).finally(() =>
        this.pending.delete(target),
      );
      this.pending.set(target, request);
    }
    return request.then(
      (playhead) => playhead && this.withArt(target, playhead),
    );
  }

  private withArt(target: string, playhead: PlayerPlayhead): PlayerPlayhead {
    const key = trackKey(playhead);
    let track = this.tracks.get(target);
    if (!track || track.key !== key) {
      track = { key, retryAt: 0 };
      this.tracks.set(target, track);
    }
    if (!track.art && playhead.title && this.now() >= track.retryAt) {
      // In flight: no other attempt meanwhile. The answer does not wait.
      track.retryAt = Number.POSITIVE_INFINITY;
      void this.loadArt(target, playhead.title, track);
    }
    return track.art ? { ...playhead, art: track.art } : playhead;
  }

  private async loadArt(
    target: string,
    title: string,
    track: { art?: string; retryAt: number },
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
      const id = ART_URL.exec(url)?.[1];
      // Another source's cover is left to the dashboard's own artwork.
      if (!id) return;
      if (!this.covers.has(id)) {
        const response = await this.fetcher(url, {
          redirect: 'error',
          signal: AbortSignal.timeout(ART_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error('Cover unavailable');
        const image = new Uint8Array(await response.arrayBuffer());
        if (
          image.length > ART_MAX_BYTES ||
          image[0] !== 0xff ||
          image[1] !== 0xd8
        )
          throw new Error('Cover is not a JPEG of a sensible size');
        this.covers.set(id, { body: image, contentType: 'image/jpeg' });
        while (this.covers.size > ART_ENTRIES)
          this.covers.delete(this.covers.keys().next().value!);
      }
      track.art = id;
    } catch {
      track.retryAt = this.now() + ART_RETRY_MS;
    }
  }

  dispose(): void {
    this.transport.dispose?.();
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
      )
        return null;
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
      return playhead;
    } catch {
      return null;
    }
  }
}
