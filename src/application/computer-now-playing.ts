import type { ComputerObservation } from '../core/computer.js';
import type { RoomState } from '../core/schemas.js';

type Media = NonNullable<ComputerObservation['observed']['media']>[number];
export type ComputerAudioRoute = { deviceId: string; source: string };
export type ComputerNowPlaying = {
  status: 'playing' | 'idle' | 'unavailable' | 'ambiguous';
  title: string | null;
  artist: string | null;
  application: string | null;
  deviceId: string;
  reason: string;
};
type PlayerHistory = {
  playback: Media['playback'];
  content: string;
  hasTitle: boolean;
  startedAt: number | null;
  changedAt: number | null;
};
type History = {
  sessionId: string;
  sequence: number;
  players: Map<string, PlayerHistory>;
  winner: string | null;
};

/** Presentation context only. Never changes the music player's observed state or intent. */
export class ComputerNowPlayingSelector {
  private readonly histories = new Map<string, History>();
  private readonly deviceIds: Set<string>;

  constructor(
    private readonly routes: Readonly<Record<string, ComputerAudioRoute>>,
  ) {
    this.deviceIds = new Set(
      Object.values(routes).map((route) => route.deviceId),
    );
  }

  reset(): void {
    this.histories.clear();
  }

  observe(computers: Readonly<Record<string, ComputerObservation>>): void {
    for (const deviceId of this.deviceIds) {
      const computer = computers[deviceId];
      if (
        !computer ||
        computer.availability !== 'online' ||
        computer.freshness !== 'fresh' ||
        computer.sessionId === null ||
        computer.sequence === null ||
        computer.observedAt === null
      ) {
        this.histories.delete(deviceId);
        continue;
      }
      let history = this.histories.get(deviceId);
      if (!history || history.sessionId !== computer.sessionId) {
        history = {
          sessionId: computer.sessionId,
          sequence: -1,
          players: new Map(),
          winner: null,
        };
        this.histories.set(deviceId, history);
      }
      if (computer.sequence <= history.sequence) continue;
      history.sequence = computer.sequence;
      const media = computer.observed.media;
      // The agent briefly clears media while requerying MPRIS. Keep bounded
      // fingerprints through that unknown snapshot; unchanged recovery is no event.
      if (media === null) continue;
      const present = new Set(media.map((player) => player.player));
      for (const player of history.players.keys())
        if (!present.has(player)) history.players.delete(player);
      if (history.winner && !present.has(history.winner)) history.winner = null;
      for (const player of media) {
        const previous = history.players.get(player.player);
        const title = player.title?.trim() ?? '';
        const content = JSON.stringify([title, player.artists, player.album]);
        const started =
          previous &&
          ['paused', 'stopped'].includes(previous.playback) &&
          player.playback === 'playing';
        const changed =
          previous &&
          previous.hasTitle &&
          title !== '' &&
          previous.content !== content;
        history.players.set(player.player, {
          playback: player.playback,
          content,
          hasTitle: title !== '',
          // Discovery/restart is a baseline, not evidence of a recent start.
          startedAt: started
            ? computer.observedAt
            : (previous?.startedAt ?? null),
          changedAt:
            changed && player.playback === 'playing'
              ? computer.observedAt
              : (previous?.changedAt ?? null),
        });
      }
    }
  }

  snapshot(state: RoomState): Record<string, ComputerNowPlaying> {
    this.observe(state.computer.devices);
    const result: Record<string, ComputerNowPlaying> = {};
    for (const [target, route] of Object.entries(this.routes)) {
      // A requested preset or a numeric media title does not confirm the input.
      if (state.music.devices[target]?.observed.source !== route.source)
        continue;
      result[target] = this.select(
        route.deviceId,
        state.computer.devices[route.deviceId],
      );
    }
    return result;
  }

  private select(
    deviceId: string,
    computer: ComputerObservation | undefined,
  ): ComputerNowPlaying {
    const empty = (
      status: ComputerNowPlaying['status'],
      reason: string,
    ): ComputerNowPlaying => ({
      status,
      reason,
      deviceId,
      title: null,
      artist: null,
      application: null,
    });
    if (
      !computer ||
      computer.availability !== 'online' ||
      computer.freshness !== 'fresh' ||
      computer.observed.media === null
    )
      return empty('unavailable', 'computer_unavailable');
    const candidates = computer.observed.media.filter(
      (media) => media.playback === 'playing' && media.title?.trim(),
    );
    const history = this.histories.get(deviceId);
    if (candidates.length === 0) {
      if (history) history.winner = null;
      return computer.observed.media.some(
        (media) => media.playback === 'playing',
      )
        ? empty('unavailable', 'metadata_missing')
        : empty('idle', 'no_playing_media');
    }
    let selected: Media | undefined;
    let reason = 'single_playing';
    if (candidates.length === 1) selected = candidates[0];
    if (!selected) {
      const active = computer.observed.activeApplication;
      const focused = candidates.filter((media) =>
        [active?.id, active?.resourceClass].some((app) =>
          matchesApplication(media, app),
        ),
      );
      if (focused.length === 1) {
        selected = focused[0];
        reason = 'focused_application';
      }
    }
    if (!selected) {
      // These are application names, not stream/player identity or loudness.
      // Use only a unique corroborated app; global roles/playing never gate media.
      const apps = computer.observed.audio?.playing
        ? computer.observed.audio.applications
        : [];
      const corroborated = candidates.filter((media) =>
        apps.some((app) => matchesApplication(media, app)),
      );
      if (corroborated.length === 1) {
        selected = corroborated[0];
        reason = 'audio_application';
      }
    }
    if (!selected && history) {
      for (const [field, basis] of [
        ['startedAt', 'recent_playback'],
        ['changedAt', 'recent_track'],
      ] as const) {
        const latest = Math.max(
          ...candidates.map(
            (media) => history.players.get(media.player)?.[field] ?? -1,
          ),
        );
        const recent =
          latest >= 0
            ? candidates.filter(
                (media) =>
                  history.players.get(media.player)?.[field] === latest,
              )
            : [];
        if (recent.length === 1) {
          selected = recent[0];
          reason = basis;
          break;
        }
      }
      if (!selected) {
        selected = candidates.find((media) => media.player === history.winner);
        if (selected) reason = 'stable_selection';
      }
    }
    if (!selected) return empty('ambiguous', 'multiple_playing_media');
    if (history) history.winner = selected.player;
    return {
      status: 'playing',
      reason,
      deviceId,
      title: selected.title!.trim(),
      artist:
        selected.artists
          ?.map((artist) => artist.trim())
          .filter(Boolean)
          .join(', ') || null,
      application:
        selected.identity?.trim() ||
        selected.desktopEntry?.trim() ||
        selected.player,
    };
  }
}

/** Exact desktop IDs plus a small explicit alias list; never compare media titles. */
function appIdentity(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\.desktop$/, '');
  const aliases: Readonly<Record<string, string>> = {
    'org.mozilla.firefox': 'firefox',
    firefox_firefox: 'firefox',
    'mozilla firefox_firefox': 'firefox',
    'com.spotify.client': 'spotify',
    'org.spotify.spotify': 'spotify',
    'org.videolan.vlc': 'vlc',
    'io.mpv.mpv': 'mpv',
  };
  return Object.hasOwn(aliases, normalized) ? aliases[normalized]! : normalized;
}
function matchesApplication(
  media: Media,
  application: string | null | undefined,
): boolean {
  if (!application?.trim()) return false;
  return [media.desktopEntry, media.identity].some(
    (identity) =>
      identity?.trim() && appIdentity(identity) === appIdentity(application),
  );
}
