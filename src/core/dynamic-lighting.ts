import { z } from 'zod';
import { hsvToRgb, rgbToHsv, type Rgb } from './artwork-palette.js';
import { ComputerDeviceIdSchema } from './computer.js';
import { SemanticLightingIdSchema, type LightingValues } from './schemas.js';

/**
 * What a lamp is for. Roles are the only thing the dynamic modes need to know
 * about the room, and they are configured rather than guessed from names.
 *
 * - `main`: a large white light that is on only while working at the desk.
 * - `desk`: task light over the desk; on only while working there.
 * - `front`: everyday functional light, on except while watching.
 * - `accent`: colour-capable lamps that follow the music.
 * - `decor`: white-only decoration; it dims and warms but never takes colour.
 * - `backlight`: bias light behind the monitor.
 */
export const DynamicRoleSchema = z.enum([
  'main',
  'desk',
  'front',
  'accent',
  'decor',
  'backlight',
]);
export type DynamicRole = z.infer<typeof DynamicRoleSchema>;

export const DynamicLightingConfigSchema = z
  .object({
    targets: z
      .record(SemanticLightingIdSchema, DynamicRoleSchema)
      .refine((targets) => Object.keys(targets).length > 0, {
        message: 'At least one lighting target needs a role',
      }),
    /** Computer whose activity drives the adaptive mode; default: the only one configured. */
    computerDeviceId: ComputerDeviceIdSchema.optional(),
    /** Computer idle time before the adaptive mode treats the desk as empty. */
    idleAfterMs: z.number().int().min(30_000).max(3_600_000).default(300_000),
    /** A new situation must hold this long before lamps follow it. */
    settleMs: z.number().int().min(0).max(60_000).default(4_000),
    /** Accent brightness while a full-screen video or game is showing. */
    cinemaBrightness: z.number().int().min(1).max(30).default(6),
    /** Accent brightness while music colours are the main light. */
    musicBrightness: z.number().int().min(10).max(100).default(70),
    /** Lowest spacing between two commands to the same lamp. */
    minChangeIntervalMs: z.number().int().min(1_000).max(60_000).default(5_000),
  })
  .strict();
export type DynamicLightingConfig = z.infer<typeof DynamicLightingConfigSchema>;

export type DynamicSituation = 'cinema' | 'desk' | 'lounge' | 'unknown';
export type ComputerActivityClass =
  'gaming' | 'video' | 'music' | 'desktop' | 'idle' | 'unknown';

export type DynamicComputerInput = {
  locked: boolean | null;
  idle: boolean | null;
  fullscreen: boolean | null;
  activity: ComputerActivityClass;
  /** How long the computer has reported idle, or null if it is not idle. */
  idleForMs: number | null;
};

/**
 * True when PowerDevil lists an application holding the machine awake for
 * playing video (Firefox, Zen and other browsers do this for a playing video
 * tab, including full-screen ones). Blockers named in `ignored` are skipped.
 * The display power policy reads the same list.
 */
export function blockersShowVideo(
  blockers: ReadonlyArray<{ app: string; reason: string }> | null,
  ignored: readonly string[] = [],
): boolean {
  if (!blockers) return false;
  const skip = new Set(ignored.map((name) => name.toLowerCase()));
  return blockers.some(
    (blocker) =>
      !skip.has(blocker.app.toLowerCase()) && /video/i.test(blocker.reason),
  );
}

export type DynamicInputs = {
  roomOccupied: boolean;
  /** Null when no trusted, fresh computer observation exists. */
  computer: DynamicComputerInput | null;
  /** Vivid artwork colours of the playing track; empty when none are known. */
  palette: readonly Rgb[];
  musicPlaying: boolean;
};

/** A lamp setting, or `release` to hand the lamp back to the scene's own look. */
export type DynamicTargetPlan = LightingValues | 'release';

export type DynamicPlan = {
  /** Why the plan looks the way it does; shown to the operator. */
  situation: DynamicSituation | 'music' | 'inactive';
  reason: string;
  evidence: string[];
  targets: Record<string, DynamicTargetPlan>;
};

export function classifySituation(
  inputs: DynamicInputs,
  config: Pick<DynamicLightingConfig, 'idleAfterMs'>,
): { situation: DynamicSituation; reason: string; evidence: string[] } {
  const computer = inputs.computer;
  if (!computer)
    return {
      situation: 'unknown',
      reason: 'computer_unavailable',
      evidence: ['No fresh observation from the configured computer'],
    };
  const watching =
    computer.activity === 'video' || computer.activity === 'gaming';
  if (computer.fullscreen === true && watching && computer.locked !== true)
    return {
      situation: 'cinema',
      reason: 'fullscreen_media',
      evidence: [`Full-screen ${computer.activity}`],
    };
  if (computer.locked === true)
    return {
      situation: 'lounge',
      reason: 'screen_locked',
      evidence: ['The computer is locked while the room is occupied'],
    };
  // Video and games are watched without touching the keyboard, so they count
  // as someone at the desk however long the input has been quiet.
  if (watching)
    return {
      situation: 'desk',
      reason: 'media_in_window',
      evidence: [`${computer.activity} is playing`],
    };
  if (computer.idle === true && (computer.idleForMs ?? 0) >= config.idleAfterMs)
    return {
      situation: 'lounge',
      reason: 'computer_idle',
      evidence: [
        `No computer input for ${Math.round((computer.idleForMs ?? 0) / 60_000)} min`,
      ],
    };
  if (computer.idle === null && computer.locked === null)
    return {
      situation: 'unknown',
      reason: 'computer_state_unknown',
      evidence: ['The computer reports neither idle nor lock state'],
    };
  return {
    situation: 'desk',
    reason: computer.idle === true ? 'recent_input' : 'computer_in_use',
    evidence: [
      computer.idle === true
        ? 'Computer idle for less than the idle limit'
        : 'The computer is being used',
    ],
  };
}

/**
 * Pure decision for a dynamic scene. Callers apply it; it never reads a clock
 * or device, so every outcome is reproducible from the inputs.
 */
export function planDynamicLighting(
  kind: 'music' | 'adaptive',
  inputs: DynamicInputs,
  config: DynamicLightingConfig,
): DynamicPlan {
  const roles = Object.entries(config.targets);
  const release = (
    situation: DynamicPlan['situation'],
    reason: string,
    evidence: string[],
  ): DynamicPlan => ({
    situation,
    reason,
    evidence,
    targets: Object.fromEntries(roles.map(([target]) => [target, 'release'])),
  });
  if (!inputs.roomOccupied)
    return release('inactive', 'room_not_occupied', [
      'The room engine owns lamps while nobody is there',
    ]);

  const colours = inputs.palette;
  if (kind === 'music') {
    if (!inputs.musicPlaying || colours.length === 0)
      return release('music', 'nothing_to_follow', [
        inputs.musicPlaying
          ? 'The playing track has no usable artwork colours'
          : 'Nothing is playing',
      ]);
    // A full-screen film outshines the music: keep the colours, but dim them
    // to the cinema level so the lamps never glare over the picture.
    const cinema = classifySituation(inputs, config).situation === 'cinema';
    return {
      situation: 'music',
      reason: cinema ? 'artwork_colours_dimmed' : 'artwork_colours',
      evidence: [
        cinema
          ? 'Full-screen video is showing; accent lamps follow the artwork at cinema brightness'
          : 'Accent lamps follow the artwork of the playing track',
      ],
      targets: accentTargets(
        roles,
        colours,
        cinema ? config.cinemaBrightness : config.musicBrightness,
        {
          power: true,
          brightness: cinema ? config.cinemaBrightness : 25,
          colorTemperature: cinema ? 2200 : 2700,
        },
      ),
    };
  }

  const decision = classifySituation(inputs, config);
  return adaptivePlan(
    decision.situation,
    decision.reason,
    decision.evidence,
    inputs,
    config,
  );
}

/** The treatment of one adaptive situation; the controller may hold an older one while a change settles. */
export function adaptivePlan(
  situation: DynamicSituation,
  reason: string,
  evidence: string[],
  inputs: DynamicInputs,
  config: DynamicLightingConfig,
): DynamicPlan {
  const roles = Object.entries(config.targets);
  if (situation === 'unknown')
    return {
      situation,
      reason,
      evidence,
      targets: Object.fromEntries(roles.map(([target]) => [target, 'release'])),
    };
  const colours = inputs.palette;
  const following = inputs.musicPlaying && colours.length > 0;
  const accentBrightness =
    situation === 'cinema'
      ? config.cinemaBrightness
      : situation === 'lounge'
        ? Math.min(config.musicBrightness, 55)
        : Math.min(config.musicBrightness, 35);
  const warmAccent: LightingValues = {
    power: true,
    brightness: situation === 'cinema' ? config.cinemaBrightness : 30,
    colorTemperature: situation === 'cinema' ? 2200 : 2700,
  };
  const targets: Record<string, DynamicTargetPlan> = {};
  for (const [target, role] of roles) {
    if (role === 'accent') continue;
    targets[target] = roleValues(role, situation, config);
  }
  Object.assign(
    targets,
    accentTargets(
      roles,
      following ? colours : [],
      accentBrightness,
      warmAccent,
    ),
  );
  return {
    situation,
    reason,
    evidence: [
      ...evidence,
      ...(following ? ['Accent lamps carry the artwork colours'] : []),
    ],
    targets,
  };
}

function roleValues(
  role: Exclude<DynamicRole, 'accent'>,
  situation: Exclude<DynamicSituation, 'unknown'>,
  config: Pick<DynamicLightingConfig, 'cinemaBrightness'>,
): LightingValues {
  switch (role) {
    case 'main':
      return situation === 'desk'
        ? { power: true, brightness: 60, colorTemperature: 4000 }
        : { power: false };
    case 'desk':
      return situation === 'desk'
        ? { power: true, brightness: 80, colorTemperature: 4000 }
        : { power: false };
    case 'front':
      // Everyday functional light: wanted on except while watching.
      return situation === 'desk'
        ? { power: true, brightness: 65, colorTemperature: 4000 }
        : situation === 'lounge'
          ? { power: true, brightness: 35, colorTemperature: 2700 }
          : { power: false };
    case 'decor':
      // White-only decoration: it can dim and warm, never take a colour.
      return situation === 'cinema'
        ? {
            power: true,
            brightness: config.cinemaBrightness,
            colorTemperature: 2200,
          }
        : {
            power: true,
            brightness: situation === 'lounge' ? 30 : 20,
            colorTemperature: 2400,
          };
    case 'backlight':
      return situation === 'cinema'
        ? {
            power: true,
            brightness: Math.max(config.cinemaBrightness, 15),
            colorTemperature: 6500,
          }
        : situation === 'desk'
          ? { power: true, brightness: 35, colorTemperature: 6500 }
          : { power: false };
  }
}

/** Spreads the palette over accent lamps in a stable order. */
function accentTargets(
  roles: ReadonlyArray<readonly [string, DynamicRole]>,
  palette: readonly Rgb[],
  brightness: number,
  fallback: LightingValues,
): Record<string, LightingValues> {
  const accents = roles
    .filter(([, role]) => role === 'accent')
    .map(([target]) => target)
    .sort();
  const colours = expandPalette(palette, accents.length);
  return Object.fromEntries(
    accents.map((target, index) => {
      const rgb = colours[index];
      return [target, rgb ? { power: true, brightness, rgb } : { ...fallback }];
    }),
  );
}

/**
 * One colour is shifted a little for the next lamp so a single-colour cover
 * still looks like a gradient rather than a flat wash.
 */
function expandPalette(palette: readonly Rgb[], count: number): Rgb[] {
  if (palette.length === 0 || count === 0) return [];
  const colours = [...palette];
  const [hue, saturation, value] = rgbToHsv(...palette[0]!);
  for (let step = 1; colours.length < count; step++)
    colours.push(hsvToRgb(hue + 28 * step, saturation, value));
  return colours.slice(0, count);
}

/** True when two settings are close enough that a lamp would not visibly change. */
export function sameDynamicValues(
  left: LightingValues | undefined,
  right: LightingValues,
): boolean {
  if (!left) return false;
  if (left.power !== right.power) return false;
  if (Math.abs((left.brightness ?? -100) - (right.brightness ?? -100)) > 2)
    return false;
  if ((left.rgb === undefined) !== (right.rgb === undefined)) return false;
  if (left.rgb && right.rgb)
    return (
      Math.abs(left.rgb[0] - right.rgb[0]) +
        Math.abs(left.rgb[1] - right.rgb[1]) +
        Math.abs(left.rgb[2] - right.rgb[2]) <=
      24
    );
  return (
    Math.abs((left.colorTemperature ?? 0) - (right.colorTemperature ?? 0)) <=
    100
  );
}
