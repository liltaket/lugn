/**
 * The few settings a Hub can change, gathered from the services that own them.
 * A Hub only ever picks among the values listed here: it cannot send a number
 * of its own, and nothing outside this list can be changed from a Hub.
 */
import type { CameraSettingsDocument } from '../core/cameras.js';
import {
  defaultHubSettings,
  HubSettingsSchema,
  type HubRuleSwitch,
  type HubSettingItem,
  type HubSettings,
} from '../core/hub-settings.js';
import type { Condition, HubRule } from '../core/hub-rules.js';
import type { DisplayPowerSettingsService } from './display-power-settings-service.js';
import type { PresenceFeedback } from './presence-feedback.js';

export class HubSettingError extends Error {
  constructor(readonly code: 'setting_unknown' | 'setting_value_not_allowed') {
    super(code);
  }
}

export type HubSettingsDependencies = {
  rules: readonly HubRule[];
  saved?: HubSettings | undefined;
  save: (settings: HubSettings) => Promise<HubSettings>;
  presence?: Pick<PresenceFeedback, 'getSettings' | 'updateSettings'>;
  display?: Pick<DisplayPowerSettingsService, 'snapshot' | 'update'>;
  camera?: {
    snapshot(): CameraSettingsDocument;
    save(
      settings: CameraSettingsDocument['settings'],
      generation: string,
    ): Promise<unknown>;
  };
};

type Entry = {
  item: HubSettingItem;
  apply: (value: number | boolean) => Promise<unknown>;
};

const duration = (seconds: number) =>
  seconds === 0
    ? 'Direkt'
    : seconds < 60
      ? `${seconds} sek`
      : `${Math.round((seconds / 60) * 10) / 10} min`.replace('.', ',');

/** The offered values, with the present one among them even if set elsewhere. */
function choices(
  offered: readonly number[],
  value: number,
  label: (value: number) => string,
) {
  return [...new Set([...offered, value])]
    .sort((a, b) => a - b)
    .map((choice) => ({ value: choice, label: label(choice) }));
}

function usesAir(condition: Condition): boolean {
  if ('air' in condition) return true;
  if ('all' in condition) return condition.all.some(usesAir);
  if ('any' in condition) return condition.any.some(usesAir);
  return 'not' in condition && usesAir(condition.not);
}

export class HubSettingsService {
  private settings: HubSettings;
  /** One change at a time: each starts from what the one before it saved. */
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: HubSettingsDependencies) {
    this.settings = { ...(options.saved ?? defaultHubSettings) };
  }

  /** Lugn's own settings, which the Hub rules read. */
  own(): HubSettings {
    return { ...this.settings };
  }

  list(): HubSettingItem[] {
    return this.entries().map((entry) => entry.item);
  }

  set(id: string, value: number | boolean): Promise<HubSettingItem[]> {
    const operation = this.pending.then(async () => {
      const entry = this.entries().find(
        (candidate) => candidate.item.id === id,
      );
      if (!entry) throw new HubSettingError('setting_unknown');
      const { item } = entry;
      const allowed =
        item.kind === 'toggle'
          ? typeof value === 'boolean'
          : item.choices.some((choice) => choice.value === value);
      if (!allowed) throw new HubSettingError('setting_value_not_allowed');
      await entry.apply(value);
      return this.list();
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  private async saveOwn(change: Partial<HubSettings>): Promise<void> {
    this.settings = await this.options.save(
      HubSettingsSchema.parse({ ...this.settings, ...change }),
    );
  }

  private entries(): Entry[] {
    const { presence, display, camera, rules } = this.options;
    const entries: Entry[] = [];
    if (presence) {
      const current = presence.getSettings();
      entries.push({
        item: {
          id: 'exitGrace',
          label: 'Släck när rummet är tomt',
          kind: 'choice',
          value: current.exitGraceSeconds,
          choices: choices(
            [0, 30, 60, 120, 300, 600],
            current.exitGraceSeconds,
            duration,
          ),
        },
        apply: (value) =>
          presence.updateSettings({
            ...presence.getSettings(),
            exitGraceSeconds: value as number,
          }),
      });
    }
    // The first computer with a managed display.
    const [computer] = Object.entries(display?.snapshot().computers ?? {});
    if (display && computer) {
      const [id, { settings }] = computer;
      const seconds = settings.offAfterEmptyMs / 1000;
      entries.push({
        item: {
          id: 'displaySleep',
          label: 'Datorskärmen släcks efter',
          kind: 'choice',
          value: seconds,
          choices: choices([60, 120, 300, 600, 900, 1800], seconds, duration),
        },
        apply: (value) => {
          const now = display.snapshot();
          return display.update(
            id,
            {
              ...now.computers[id]!.settings,
              offAfterEmptyMs: (value as number) * 1000,
            },
            now.generation,
          );
        },
      });
    }
    if (rules.some((rule) => rule.enabled && usesAir(rule.when)))
      entries.push({
        item: {
          id: 'airPpm',
          label: 'Påminn om att vädra',
          kind: 'choice',
          value: this.settings.airPpm,
          choices: choices(
            [0, 800, 1000, 1200, 1500],
            this.settings.airPpm,
            (ppm) => (ppm === 0 ? 'Av' : `${ppm} ppm`),
          ),
        },
        apply: (value) => this.saveOwn({ airPpm: value as number }),
      });
    if (presence)
      entries.push({
        item: {
          id: 'chime',
          label: 'Ljud när någon går in eller ut',
          kind: 'toggle',
          value: presence.getSettings().chime.enabled,
        },
        apply: (value) => {
          const current = presence.getSettings();
          return presence.updateSettings({
            ...current,
            chime: { ...current.chime, enabled: value as boolean },
          });
        },
      });
    if (camera?.snapshot().settings.enabled)
      entries.push({
        item: {
          id: 'cameraAuto',
          label: 'Visa kameran vid rörelse',
          kind: 'toggle',
          value: camera.snapshot().settings.automaticEnabled,
        },
        apply: (value) => {
          const now = camera.snapshot();
          return camera.save(
            { ...now.settings, automaticEnabled: value as boolean },
            now.generation,
          );
        },
      });
    const switches: Array<[HubRuleSwitch, string]> = [
      ['film', 'Dimma skärmarna vid film'],
      ['away', 'Mörka skärmar när ingen är hemma'],
    ];
    for (const [name, label] of switches)
      if (rules.some((rule) => rule.enabled && rule.switch === name))
        entries.push({
          item: { id: name, label, kind: 'toggle', value: this.settings[name] },
          apply: (value) => this.saveOwn({ [name]: value as boolean }),
        });
    return entries;
  }
}
