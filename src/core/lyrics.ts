/** What a lyrics lookup knows about the track. */
export type LyricsTrack = {
  title: string;
  artist: string;
  album?: string;
  durationSeconds?: number;
};

/** One line and the second it starts. An empty text is a pause in the song. */
export type LyricLine = { at: number; text: string };

export type Lyrics =
  | { status: 'synced'; lines: LyricLine[] }
  | { status: 'instrumental' }
  /** The source knows no lines to follow for this track. */
  | { status: 'none' }
  /** The source could not be asked; worth asking again later. */
  | { status: 'unavailable' };

export interface LyricsProvider {
  lookup(track: LyricsTrack): Promise<Lyrics>;
}

const MAX_LINES = 600;
const MAX_LINE_LENGTH = 300;
const TIMESTAMP = /^\[(\d{1,3}):([0-5]?\d(?:[.:]\d{1,3})?)\]/;

/**
 * LRC text to lines in time order. A line may carry several timestamps, an
 * `[offset:±ms]` tag shifts them all (positive is earlier), and other tags are
 * left out.
 */
export function parseLrc(source: string): LyricLine[] {
  const offset =
    Number(/^\[offset:\s*([+-]?\d+)\s*\]/im.exec(source)?.[1] ?? 0) / 1000;
  const lines: LyricLine[] = [];
  for (const raw of source.split(/\r?\n/)) {
    let rest = raw.trim();
    const times: number[] = [];
    for (;;) {
      const match = TIMESTAMP.exec(rest);
      if (!match) break;
      times.push(Number(match[1]) * 60 + Number(match[2]!.replace(':', '.')));
      rest = rest.slice(match[0].length).trimStart();
    }
    // Word timestamps (<00:12.34>) are not used: the page follows lines.
    const text = rest
      .replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_LINE_LENGTH);
    for (const time of times)
      lines.push({
        at: Math.max(0, Math.round((time - offset) * 100) / 100),
        text,
      });
  }
  lines.sort((a, b) => a.at - b.at);
  return lines.some((line) => line.text) ? lines.slice(0, MAX_LINES) : [];
}
