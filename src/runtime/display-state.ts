import type { RoomState } from '../core/schemas.js';
import type { ComputerAudioRoute } from '../application/computer-now-playing.js';

/** Decisions kept per music target: the Hub lists the latest eight. */
export const DISPLAY_DECISIONS_PER_TARGET = 8;

/**
 * Room state as a Hub page needs it. The page never reads the diagnostics
 * and fast-path timing logs and only asks the command ledger whether a
 * command is still pending, so those make up most of the raw state (about
 * 190 of 267 KB on the live system) and cost a Hub a JSON parse and a draw
 * every time. Everything else is passed through unchanged.
 */
export function displayState(
  state: RoomState,
): Omit<RoomState, 'diagnostics' | 'timings'> {
  const { diagnostics, timings, ...rest } = state;
  // Named only to leave them out.
  void diagnostics;
  void timings;
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
  return {
    ...rest,
    music,
    commands: state.commands.filter((command) => command.status === 'pending'),
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

/**
 * Per player, whether the Hub may offer Nästa låt: the player is available
 * and is not playing a computer's audio through its input (a computer's
 * media is not skipped through the player).
 */
export function musicTrackControl(
  state: RoomState,
  routes: Readonly<Record<string, ComputerAudioRoute>>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [target, device] of Object.entries(state.music.devices)) {
    const route = routes[target];
    const source = device.observed.source;
    const computerInput =
      !!route && (source == null || source === route.source);
    out[target] = device.availability === 'available' && !computerInput;
  }
  return out;
}
