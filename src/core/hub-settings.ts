/**
 * What a Hub's settings page can change that is Lugn's own: when to suggest
 * airing the room, and whether the dimming rules run. Everything else on that
 * page belongs to the service that already owns it (presence, the computer's
 * display, the cameras); see src/application/hub-settings.ts.
 */
import { z } from 'zod';

/** The rules a settings page may switch off (a rule's `switch`). */
export const HUB_RULE_SWITCHES = ['film', 'away'] as const;
export type HubRuleSwitch = (typeof HUB_RULE_SWITCHES)[number];

export const HubSettingsSchema = z
  .object({
    /** CO₂ level (ppm) from which the room needs airing; 0 never says so. */
    airPpm: z.number().int().min(0).max(5000),
    film: z.boolean(),
    away: z.boolean(),
  })
  .strict();
export type HubSettings = z.output<typeof HubSettingsSchema>;

export const defaultHubSettings: HubSettings = {
  airPpm: 1000,
  film: true,
  away: true,
};

/** One row of the settings page, as a Hub draws it. */
export type HubSettingItem = { id: string; label: string } & (
  | {
      kind: 'choice';
      value: number;
      choices: Array<{ value: number; label: string }>;
    }
  | { kind: 'toggle'; value: boolean }
);
