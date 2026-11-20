import {
  DisplayPowerSettingsError,
  type DisplayPowerSettings,
  type DisplayPowerSettingsRepository,
} from '../core/display-power-settings.js';

/** Configured defaults for a computer's display power settings. */
export function settingsFromConfig(display: {
  offAfterEmptyMs: number;
  ensureOffWhenAway: boolean;
  wakeOnEntry: boolean;
  wakeInQuietHours: boolean;
  inhibitOnActivity: boolean;
  activeInhibitMaxMs: number;
  idleSleepAfterMs: number | null;
  ignoreIdleBlockers: readonly string[];
}): DisplayPowerSettings {
  return {
    enabled: true,
    offAfterEmptyMs: display.offAfterEmptyMs,
    ensureOffWhenAway: display.ensureOffWhenAway,
    wakeOnEntry: display.wakeOnEntry,
    wakeInQuietHours: display.wakeInQuietHours,
    inhibitOnActivity: display.inhibitOnActivity,
    activeInhibitMaxMs: display.activeInhibitMaxMs,
    idleSleepAfterMs: display.idleSleepAfterMs,
    ignoreIdleBlockers: [...display.ignoreIdleBlockers],
  };
}

export type DisplayPowerSettingsSnapshot = {
  version: 1;
  generation: string;
  computers: Record<
    string,
    {
      settings: DisplayPowerSettings;
      defaults: DisplayPowerSettings;
      /** Saved values differ from the configured defaults. */
      customized: boolean;
    }
  >;
};

/**
 * Effective display power settings: configured defaults, overridden by what
 * the user saved in the control panel. Only computers that have a `display`
 * entry in the runtime configuration exist here.
 */
export class DisplayPowerSettingsService {
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly options: {
      repository: DisplayPowerSettingsRepository;
      defaults: Readonly<Record<string, DisplayPowerSettings>>;
    },
  ) {}

  /** Current settings for a configured computer, or undefined. */
  effective(deviceId: string): DisplayPowerSettings | undefined {
    const defaults = this.options.defaults[deviceId];
    if (!defaults) return undefined;
    return (
      this.options.repository.snapshot().computers[deviceId] ??
      structuredClone(defaults)
    );
  }

  snapshot(): DisplayPowerSettingsSnapshot {
    const stored = this.options.repository.snapshot();
    return {
      version: 1,
      generation: stored.generation,
      computers: Object.fromEntries(
        Object.entries(this.options.defaults).map(([deviceId, defaults]) => {
          const settings = stored.computers[deviceId] ?? defaults;
          return [
            deviceId,
            {
              settings: structuredClone(settings),
              defaults: structuredClone(defaults),
              customized: JSON.stringify(settings) !== JSON.stringify(defaults),
            },
          ];
        }),
      ),
    };
  }

  /** Saves new settings, or `null` to return to the configured defaults. */
  async update(
    deviceId: string,
    settings: DisplayPowerSettings | null,
    expectedGeneration: string,
  ): Promise<DisplayPowerSettingsSnapshot> {
    if (!Object.hasOwn(this.options.defaults, deviceId))
      throw new DisplayPowerSettingsError(404, 'display_computer_unknown');
    await this.options.repository.save(deviceId, settings, expectedGeneration);
    for (const listener of [...this.listeners]) listener();
    return this.snapshot();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
