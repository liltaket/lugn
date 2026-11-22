import type { RoomState } from '../core/schemas.js';
import type { ComputerAudioRoute } from './computer-now-playing.js';

/**
 * Whether a player can take a track step (Nästa låt): it is available and is
 * not playing a computer's audio through its input. A computer's media is
 * not skipped through the player, and an unknown source on a player with a
 * computer route counts as the computer. The engine refuses steps by this
 * rule and the Hub offers the button by it.
 */
export function canStepTrack(
  state: RoomState,
  target: string,
  routes: Readonly<Record<string, Pick<ComputerAudioRoute, 'source'>>>,
): boolean {
  const device = state.music.devices[target];
  if (!device || device.availability !== 'available') return false;
  const route = routes[target];
  const source = device.observed.source;
  return !(route && (source == null || source === route.source));
}

/** canStepTrack for every player, as the Hub payload carries it. */
export function musicTrackControl(
  state: RoomState,
  routes: Readonly<Record<string, Pick<ComputerAudioRoute, 'source'>>>,
): Record<string, boolean> {
  return Object.fromEntries(
    Object.keys(state.music.devices).map((target) => [
      target,
      canStepTrack(state, target, routes),
    ]),
  );
}
