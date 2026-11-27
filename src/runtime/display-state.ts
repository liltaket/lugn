import type { RoomState } from '../core/schemas.js';

/** Decisions kept per music target: the Hub lists the latest eight. */
export const DISPLAY_DECISIONS_PER_TARGET = 8;

/**
 * Room state as a Hub page needs it. The page never reads the diagnostics
 * and fast-path timing logs, the automation holds or who owns a lamp
 * property, only asks the command ledger whether a command is still pending,
 * shows little of the music ledger and gets covers from the artwork route, so
 * the rest only costs transfer and a JSON parse on every message. Everything
 * else is passed through unchanged.
 */
export function displayState(state: RoomState) {
  const { diagnostics, timings, intent, ...rest } = state;
  // Named only to leave them out.
  void diagnostics;
  void timings;
  void intent;
  const decisions = state.music.decisions;
  let music = rest.music;
  if (decisions && decisions.length > 0) {
    const seen = new Map<string, number>();
    const kept = [];
    for (let index = decisions.length - 1; index >= 0; index -= 1) {
      const decision = decisions[index]!;
      const count = seen.get(decision.target) ?? 0;
      if (count >= DISPLAY_DECISIONS_PER_TARGET) continue;
      seen.set(decision.target, count + 1);
      kept.push(decision);
    }
    music = { ...music, decisions: kept.reverse() };
  }
  const commands = shownMusicCommands(state.music);
  if (commands.length < state.music.commands.length)
    music = { ...music, commands };
  return {
    ...rest,
    lighting: withoutOwnership(rest.lighting),
    music,
    computer: withoutArtwork(rest.computer),
    commands: state.commands.filter((command) => command.status === 'pending'),
  };
}

/**
 * A Hub draws what each lamp reports and what it was asked to show, not the
 * baseline underneath or the record of who set each property.
 */
function withoutOwnership(lighting: RoomState['lighting']) {
  return {
    ...lighting,
    devices: Object.fromEntries(
      Object.entries(lighting.devices).map(([id, device]) => {
        const { ownership, baselineDesired, ...shown } = device;
        void ownership;
        void baselineDesired;
        return [id, shown];
      }),
    ),
  };
}

/**
 * The music commands a Hub page can show, in ledger order: those pending, the
 * latest request to each player (track steps and seeks are never shown), and
 * those whose read-back is newer than the player's last observation, which
 * the page uses to mark that observation as old.
 */
function shownMusicCommands(music: RoomState['music']) {
  const latest = new Map<string, RoomState['music']['commands'][number]>();
  for (const command of music.commands) {
    const { property } = command.requested;
    if (property === 'track' || property === 'seek') continue;
    const current = latest.get(command.target);
    // Of two issued at once, the later in the ledger counts.
    if (!current || command.issuedAt >= current.issuedAt)
      latest.set(command.target, command);
  }
  return music.commands.filter((command) => {
    if (command.status === 'pending') return true;
    if (latest.get(command.target) === command) return true;
    const verifiedAt = command.recovery?.reported
      ? command.recovery.verifiedAt
      : undefined;
    return (
      verifiedAt !== undefined &&
      verifiedAt > (music.devices[command.target]?.observedAt ?? -1)
    );
  });
}

/**
 * Desktop media can carry its cover inline (up to 32 KB each). A Hub loads
 * covers from the artwork route and never reads these.
 */
function withoutArtwork(computer: RoomState['computer']) {
  const devices = Object.entries(computer.devices);
  if (
    !devices.some(([, device]) =>
      device.observed.media?.some((media) => media.artwork),
    )
  )
    return computer;
  return {
    ...computer,
    devices: Object.fromEntries(
      devices.map(([id, device]) => [
        id,
        {
          ...device,
          observed: {
            ...device.observed,
            media:
              device.observed.media?.map((media) => {
                const shown = { ...media };
                delete shown.artwork;
                return shown;
              }) ?? null,
          },
        },
      ]),
    ),
  };
}

/**
 * The text of a payload without the fields that change on every publish and
 * mean nothing by themselves (counters and evaluation clocks). Two payloads
 * with the same key draw the same page.
 */
export function displayPayloadKey(json: string): string {
  return json.replace(
    /"(?:deliveryRevision|generatedAt|revision|updatedAt|evaluatedAt)":\d+/g,
    '',
  );
}

export { musicTrackControl } from '../application/music-track-control.js';
