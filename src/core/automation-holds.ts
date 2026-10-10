import type { Clock } from './clock.js';
import type {
  AutomationHold,
  Actor,
  Provenance,
  MusicPauseIntent,
} from './schemas.js';

export function isHumanActor(actor: Actor): boolean {
  return ['user', 'physical_remote', 'home_assistant'].includes(actor.type);
}

/** Holds share command provenance; observations enter only after attribution. */
export class AutomationHolds {
  private readonly holds = new Map<string, AutomationHold>();

  constructor(private readonly clock: Clock) {}

  blocks(
    scope: 'music.playback' | 'lighting.activation',
    target: string,
  ): boolean {
    return this.holds.has(`${scope}:${target}`);
  }

  set(
    scope: 'music.playback' | 'lighting.activation',
    target: string,
    provenance: Provenance,
  ): void {
    this.holds.set(`${scope}:${target}`, {
      scope,
      target,
      intent: scope === 'music.playback' ? 'paused' : 'off',
      provenance: structuredClone(provenance),
      createdAt: this.clock.now(),
      resetPolicy:
        scope === 'music.playback' ? 'explicit_playback' : 'explicit_lighting',
    });
  }

  clear(scope: 'music.playback' | 'lighting.activation', target: string): void {
    this.holds.delete(`${scope}:${target}`);
  }

  restoreMusicPause(target: string, intent: MusicPauseIntent): void {
    this.holds.set(`music.playback:${target}`, {
      scope: 'music.playback',
      target,
      intent: 'paused',
      provenance: structuredClone(intent.provenance),
      createdAt: intent.createdAt,
      resetPolicy: 'explicit_playback',
    });
  }

  snapshot(): AutomationHold[] {
    return structuredClone([...this.holds.values()]);
  }
}
