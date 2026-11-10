import type { Clock } from '../core/clock.js';
import {
  defaultPresenceFeedbackSettings,
  PresenceFeedbackSettingsSchema,
  type ChimeKind,
  type ChimeStyle,
  type PresenceFeedbackSettings,
} from '../core/presence-feedback.js';
import type { PresenceInputEvent } from '../core/schemas.js';
import { PresenceExitGrace } from './presence-exit-grace.js';

export interface PresenceChime {
  play(kind: ChimeKind, volume: number, style: ChimeStyle): void;
  test(kind: ChimeKind, volume: number, style: ChimeStyle): Promise<void>;
}

/**
 * Sits between the sensor and the engine. It answers the person in the room
 * from what the sensor reported (chime), and decides when the engine hears
 * that the room emptied (exit grace). The chime always follows the sensor
 * report, never the grace, so it still confirms an exit that Lugn has not
 * acted on yet.
 */
export class PresenceFeedback {
  private settings: PresenceFeedbackSettings;
  private readonly grace: PresenceExitGrace;
  private lastSensorConfirmed: 'occupied' | 'confirmed_empty' | undefined;
  private lastSensorCount: number | undefined;

  constructor(
    private readonly options: {
      clock: Clock;
      forward: (event: PresenceInputEvent) => void;
      save: (
        settings: PresenceFeedbackSettings,
      ) => Promise<PresenceFeedbackSettings>;
      chime?: PresenceChime;
      onExitPending?: (pending: { startedAt: number; until: number }) => void;
      initial?: PresenceFeedbackSettings;
    },
  ) {
    this.settings = structuredClone(
      options.initial ?? defaultPresenceFeedbackSettings,
    );
    this.grace = new PresenceExitGrace({
      clock: options.clock,
      graceMs: () => this.settings.exitGraceSeconds * 1000,
      forward: options.forward,
      ...(options.onExitPending === undefined
        ? {}
        : { onHold: options.onExitPending }),
    });
  }

  getSettings(): PresenceFeedbackSettings {
    return structuredClone(this.settings);
  }

  get pendingExitUntil(): number | null {
    return this.grace.pendingUntil;
  }

  accept(event: PresenceInputEvent): void {
    // Lighting first: the chime is scheduled after the engine has the event.
    this.grace.accept(event);
    if (event.type !== 'presence.changed') return;
    if (event.presence === 'unknown') {
      // After a dropout the next count has nothing trustworthy to compare with.
      this.lastSensorCount = undefined;
      return;
    }
    const previous = this.lastSensorConfirmed;
    const previousCount = this.lastSensorCount;
    this.lastSensorConfirmed = event.presence;
    this.lastSensorCount = event.personCount ?? undefined;
    const { chime } = this.settings;
    if (!this.options.chime || !chime.enabled || previous === undefined) return;
    const kind = chimeKind(previous, previousCount, event);
    if (kind && chime[kind])
      this.options.chime.play(kind, chime.volume, chime.style);
  }

  async updateSettings(
    input: PresenceFeedbackSettings,
  ): Promise<PresenceFeedbackSettings> {
    const saved = await this.options.save(
      PresenceFeedbackSettingsSchema.parse(input),
    );
    this.settings = structuredClone(saved);
    this.grace.settingsChanged();
    return this.getSettings();
  }

  /** Auditions the given volume and style, defaulting to the saved ones. */
  async testChime(
    kind: ChimeKind,
    overrides: { volume?: number; style?: ChimeStyle } = {},
  ): Promise<void> {
    if (!this.options.chime) throw new Error('chime_unavailable');
    await this.options.chime.test(
      kind,
      overrides.volume ?? this.settings.chime.volume,
      overrides.style ?? this.settings.chime.style,
    );
  }

  dispose(): void {
    this.grace.dispose();
  }
}

/**
 * A room that never empties still has people coming and going, so a change in
 * the count answers the person just like a change between occupied and empty.
 */
function chimeKind(
  previous: 'occupied' | 'confirmed_empty',
  previousCount: number | undefined,
  event: Extract<PresenceInputEvent, { type: 'presence.changed' }>,
): ChimeKind | undefined {
  if (previous !== event.presence)
    return event.presence === 'occupied' ? 'entry' : 'exit';
  const count = event.personCount;
  if (previousCount === undefined || count === null || count === undefined)
    return undefined;
  if (count > previousCount) return 'entry';
  return count < previousCount ? 'exit' : undefined;
}
