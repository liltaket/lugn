import { z } from 'zod';
import {
  ComputerDeviceIdSchema,
  type ComputerObservation,
} from './computer.js';

const Text = z.string().trim().min(1).max(512);
export const IntelligenceSettingsSchema = z
  .object({
    version: z.literal(1),
    optical: z
      .object({
        enabled: z.boolean(),
        mode: z.enum(['suggest', 'auto']),
        deviceId: ComputerDeviceIdSchema.nullable(),
        target: Text.nullable(),
        source: Text.nullable(),
        stabilityMs: z.number().int().min(1000).max(300_000),
        cooldownMs: z.number().int().min(1000).max(86_400_000),
        allowedActivities: z
          .array(Text)
          .max(32)
          .refine((a) => new Set(a).size === a.length),
        respectManual: z.literal(true),
      })
      .strict(),
    suggestions: z
      .object({
        enabled: z.boolean(),
        cooldownMs: z.number().int().min(1000).max(86_400_000),
        sceneMappings: z
          .record(
            Text,
            z
              .string()
              .max(512)
              .regex(/^scene\.[a-z0-9][a-z0-9._-]*$/),
          )
          .refine((m) => Object.keys(m).length <= 128),
      })
      .strict(),
  })
  .strict();
export type IntelligenceSettings = z.infer<typeof IntelligenceSettingsSchema>;

export function defaultIntelligenceSettings(): IntelligenceSettings {
  return {
    version: 1,
    optical: {
      enabled: false,
      mode: 'suggest',
      deviceId: null,
      target: null,
      source: null,
      stabilityMs: 10_000,
      cooldownMs: 300_000,
      allowedActivities: ['music', 'video'],
      respectManual: true,
    },
    suggestions: { enabled: false, cooldownMs: 300_000, sceneMappings: {} },
  };
}
export const SuggestionSchema = z
  .object({
    id: Text,
    kind: z.enum(['scene', 'optical']),
    title: Text,
    reason: Text,
    deviceId: ComputerDeviceIdSchema,
    sceneId: Text.optional(),
    target: Text.optional(),
    source: Text.optional(),
    createdAt: z.number().finite().nonnegative(),
    expiresAt: z.number().finite().nonnegative(),
  })
  .strict();
export type Suggestion = z.infer<typeof SuggestionSchema>;
export type OpticalReason =
  | 'disabled'
  | 'mapping_unavailable'
  | 'computer_untrusted'
  | 'computer_stale'
  | 'out_of_order'
  | 'restart_baseline'
  | 'no_media'
  | 'ambiguous_media'
  | 'uncorroborated_media'
  | 'activity_not_allowed'
  | 'awaiting_start_transition'
  | 'stabilizing'
  | 'presence_not_occupied'
  | 'home_not_home'
  | 'quiet_hours'
  | 'playback_policy_blocked'
  | 'manual_hold'
  | 'receiver_untrusted'
  | 'receiver_busy'
  | 'already_optical'
  | 'context_suppressed'
  | 'cooldown'
  | 'suggestion_only_no_audibility';
export type OpticalDecision = {
  deviceId: string | null;
  target: string | null;
  source: string | null;
  state: 'pending' | 'suppressed' | 'permitted';
  reason: OpticalReason;
  evidence: string[];
  automaticAllowed: false;
  suggestionAllowed: boolean;
  stableSince: number | null;
  evaluatedAt: number;
};
export type IntelligenceSnapshot = {
  settings: IntelligenceSettings;
  generation: string;
  suggestions: Suggestion[];
  optical: OpticalDecision[];
};
export type IntelligenceSettingsDocument = {
  settings: IntelligenceSettings;
  generation: string;
};
export interface IntelligenceSettingsRepository {
  snapshot(): IntelligenceSettingsDocument;
  save(
    settings: IntelligenceSettings,
    expectedGeneration: string,
  ): Promise<IntelligenceSettingsDocument>;
}
export class IntelligenceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** v1 has no mute, volume or sample-level evidence: this can justify a suggestion only. */
export function corroboratedMedia(computer: ComputerObservation): {
  player: string | null;
  reason: OpticalReason;
  evidence: string[];
} {
  const media = computer.observed.media;
  if (!media) return { player: null, reason: 'no_media', evidence: [] };
  const playing = media.filter((m) => m.playback === 'playing');
  if (playing.length > 1)
    return { player: null, reason: 'ambiguous_media', evidence: [] };
  const player = playing[0];
  if (!player) return { player: null, reason: 'no_media', evidence: [] };
  const ids = [player.desktopEntry, player.identity]
    .filter((id): id is string => Boolean(id?.trim()))
    .map(normalize);
  const observed = computer.observed;
  const audioMatch =
    observed.audio?.playing === true &&
    observed.audio.applications.some((app) => ids.includes(normalize(app)));
  const focused = [
    observed.activeApplication?.id,
    observed.activeApplication?.resourceClass,
  ].some((app) => app && ids.includes(normalize(app)));
  const content = player.contentType?.toLowerCase() ?? '';
  const matchesActivity =
    (computer.activity.classification === 'music' &&
      content.startsWith('audio/')) ||
    (computer.activity.classification === 'video' &&
      content.startsWith('video/'));
  if (
    !player.title?.trim() ||
    !matchesActivity ||
    !focused ||
    !audioMatch ||
    observed.locked !== false ||
    observed.idle !== false
  )
    return { player: null, reason: 'uncorroborated_media', evidence: [] };
  return {
    player: player.player,
    reason: 'suggestion_only_no_audibility',
    evidence: [
      'single_mpris_playing',
      'explicit_content_type',
      'matching_focused_application',
      'matching_pipewire_application',
      'unlocked_active_desktop',
    ],
  };
}
function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.desktop$/, '');
}
