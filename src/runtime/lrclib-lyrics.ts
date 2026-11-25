import {
  parseLrc,
  type Lyrics,
  type LyricsProvider,
  type LyricsTrack,
} from '../core/lyrics.js';

const BASE_URL = 'https://lrclib.net/api';
/** LRCLIB asks every client to name itself. */
const USER_AGENT = 'room-dashboard-lyrics/1.0';
const TIMEOUT_MS = 8_000;
const MAX_BYTES = 1_000_000;
const CACHE_ENTRIES = 100;
const FOUND_TTL_MS = 24 * 3_600_000;
const MISSING_TTL_MS = 3_600_000;
const FAILED_TTL_MS = 20_000;
/** A search result is the same recording only if its length is this close. */
const DURATION_TOLERANCE_S = 3;
/** Longer than any song: a video or a mix, which is not looked up. */
const MAX_TRACK_SECONDS = 20 * 60;

type Entry = { expires: number; result: Promise<Lyrics> };

type LrclibRecord = {
  duration?: unknown;
  instrumental?: unknown;
  syncedLyrics?: unknown;
};

/**
 * Synced lyrics from LRCLIB (https://lrclib.net), a free service without a
 * key. A track is asked for only when a Hub shows its lyrics; answers are kept
 * in memory.
 */
export class LrclibLyrics implements LyricsProvider {
  private readonly cache = new Map<string, Entry>();

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  lookup(track: LyricsTrack): Promise<Lyrics> {
    const duration =
      track.durationSeconds !== undefined && track.durationSeconds > 0
        ? Math.round(track.durationSeconds)
        : undefined;
    if (duration !== undefined && duration > MAX_TRACK_SECONDS)
      return Promise.resolve({ status: 'none' });
    const key = JSON.stringify([
      track.title.toLowerCase(),
      track.artist.toLowerCase(),
      duration ?? null,
    ]);
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) return cached.result;
    const entry: Entry = {
      expires: Number.POSITIVE_INFINITY,
      result: this.ask({
        ...track,
        ...(duration === undefined ? {} : { durationSeconds: duration }),
      }).catch((): Lyrics => ({ status: 'unavailable' })),
    };
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > CACHE_ENTRIES)
      this.cache.delete(this.cache.keys().next().value!);
    void entry.result.then((result) => {
      entry.expires =
        this.now() +
        (result.status === 'unavailable'
          ? FAILED_TTL_MS
          : result.status === 'none'
            ? MISSING_TTL_MS
            : FOUND_TTL_MS);
    });
    return entry.result;
  }

  private async ask(track: LyricsTrack): Promise<Lyrics> {
    const duration = track.durationSeconds;
    const exact = new URLSearchParams({
      track_name: track.title,
      artist_name: track.artist,
      ...(track.album ? { album_name: track.album } : {}),
      ...(duration === undefined ? {} : { duration: String(duration) }),
    });
    const direct = (await this.get(`/get?${exact}`)) as LrclibRecord | null;
    const first = direct ? read(direct) : null;
    if (first) return first;
    // The exact lookup misses other album names, and may answer with a record
    // that has no timed lines while another one does.
    const query = new URLSearchParams({
      track_name: track.title,
      artist_name: track.artist,
    });
    const found = await this.get(`/search?${query}`);
    const records = (Array.isArray(found) ? found : []) as LrclibRecord[];
    const distance = (record: LrclibRecord) =>
      duration === undefined || typeof record.duration !== 'number'
        ? duration === undefined
          ? 0
          : Number.POSITIVE_INFINITY
        : Math.abs(record.duration - duration);
    const close = records
      .filter((record) => distance(record) <= DURATION_TOLERANCE_S)
      .sort((a, b) => distance(a) - distance(b));
    for (const record of close) {
      const result = read(record);
      if (result?.status === 'synced') return result;
    }
    return close.some((record) => record.instrumental === true)
      ? { status: 'instrumental' }
      : { status: 'none' };
  }

  /** The parsed answer, or null when LRCLIB has no such record. */
  private async get(path: string): Promise<unknown> {
    const response = await this.fetcher(`${BASE_URL}${path}`, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`LRCLIB answered ${response.status}`);
    const body = await response.text();
    if (body.length > MAX_BYTES) throw new Error('LRCLIB answer too large');
    return JSON.parse(body) as unknown;
  }
}

function read(record: LrclibRecord): Lyrics | null {
  if (record.instrumental === true) return { status: 'instrumental' };
  if (typeof record.syncedLyrics !== 'string') return null;
  const lines = parseLrc(record.syncedLyrics);
  return lines.length > 0 ? { status: 'synced', lines } : null;
}
