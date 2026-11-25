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
};

export interface PlayheadProvider {
  /** Null for a player without a source here, or without a position to give. */
  read(target: string): Promise<PlayerPlayhead | null>;
  now(): number;
}

const TIMEOUT_MS = 1_500;
/** Two Hubs asking together share one answer from the player. */
const REUSE_MS = 200;

/**
 * The position straight from a WiiM, in milliseconds. It only reads: the
 * player stays controlled through whichever adapter owns it. Home Assistant
 * reports whole seconds a few at a time, too coarse to follow lyrics with.
 */
export class WiimPlayhead implements PlayheadProvider {
  private readonly pending = new Map<string, Promise<PlayerPlayhead | null>>();
  private readonly latest = new Map<string, PlayerPlayhead>();

  constructor(
    private readonly hosts: Readonly<Record<string, string>>,
    private readonly transport: WiimTransport = createWiimHttpsTransport(
      TIMEOUT_MS,
    ),
    readonly now: () => number = () => performance.now(),
  ) {}

  read(target: string): Promise<PlayerPlayhead | null> {
    const host = Object.hasOwn(this.hosts, target)
      ? this.hosts[target]
      : undefined;
    if (!host) return Promise.resolve(null);
    const recent = this.latest.get(target);
    if (recent && this.now() - recent.measuredAt < REUSE_MS)
      return Promise.resolve(recent);
    let request = this.pending.get(target);
    if (!request) {
      request = this.ask(target, host).finally(() =>
        this.pending.delete(target),
      );
      this.pending.set(target, request);
    }
    return request;
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
