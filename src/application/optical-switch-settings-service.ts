import {
  OpticalSwitchSettingsError,
  type OpticalSwitchSettings,
  type OpticalSwitchSettingsRepository,
} from '../core/optical-switch-settings.js';

export type OpticalSwitchSettingsSnapshot = {
  version: 1;
  generation: string;
  computers: Record<
    string,
    {
      settings: OpticalSwitchSettings;
      defaults: OpticalSwitchSettings;
      /** Saved values differ from the configured defaults. */
      customized: boolean;
    }
  >;
};

/**
 * Effective optical switch settings: configured defaults, overridden by what
 * the user saved in the control panel. Every configured computer exists here.
 */
export class OpticalSwitchSettingsService {
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly options: {
      repository: OpticalSwitchSettingsRepository;
      defaults: Readonly<Record<string, OpticalSwitchSettings>>;
    },
  ) {}

  /** Current settings for a configured computer, or undefined. */
  effective(deviceId: string): OpticalSwitchSettings | undefined {
    const defaults = this.options.defaults[deviceId];
    if (!defaults) return undefined;
    return (
      this.options.repository.snapshot().computers[deviceId] ??
      structuredClone(defaults)
    );
  }

  /** Generation of the saved document; every change publishes a new one. */
  generation(): string {
    return this.options.repository.snapshot().generation;
  }

  deviceIds(): string[] {
    return Object.keys(this.options.defaults);
  }

  snapshot(): OpticalSwitchSettingsSnapshot {
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
    settings: OpticalSwitchSettings | null,
    expectedGeneration: string,
  ): Promise<OpticalSwitchSettingsSnapshot> {
    if (!Object.hasOwn(this.options.defaults, deviceId))
      throw new OpticalSwitchSettingsError(404, 'optical_computer_unknown');
    await this.options.repository.save(deviceId, settings, expectedGeneration);
    for (const listener of [...this.listeners]) listener();
    return this.snapshot();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
