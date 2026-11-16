import { z } from 'zod';
import { lightingFeedbackMatches } from '../core/lighting-feedback.js';
import {
  DEVICE_API_VERSION,
  StateViewSectionNames,
  type StateView,
  type StateViewSection,
  type StateViewSections,
  type WhyEntry,
} from '../core/device-api.js';
import {
  LightingProperties,
  type Diagnostic,
  type LightingValues,
  type MusicDecision,
  type RoomState,
  type StateUpdate,
} from '../core/schemas.js';
import type { LugnEngine } from './lugn-engine.js';
import { phoneFacts } from '../core/phone.js';
import type { ExperienceApi } from './experience-api.js';

export type StateViewSources = {
  engine: Pick<
    LugnEngine,
    | 'state'
    | 'scenes'
    | 'sceneProtection'
    | 'getMusicVolumePolicySnapshots'
    | 'getMusicPlaybackPolicySnapshots'
  >;
  instanceId: string;
  now: () => number;
  integrations: () => Record<string, string>;
  scenePresetsEditable: boolean;
  experience?: Pick<ExperienceApi, 'snapshot'>;
  environment?: () => StateViewSections['environment'];
};

const WHY_LIMIT = 30;
const SCENE_ICONS: Record<
  string,
  NonNullable<StateViewSections['lighting']['scenes'][number]['icon']>
> = {
  'scene.all_off': 'power',
  'scene.soft_light': 'moon',
  'scene.everyday_light': 'sun',
  'scene.focus_light': 'desk-lamp',
  'scene.party': 'disco-ball',
  'scene.movie_light': 'film',
};

/** Which view sections an engine domain can change. */
const DOMAIN_SECTIONS: Record<
  StateUpdate['domains'][number],
  StateViewSection[]
> = {
  presence: ['presence', 'music', 'why'],
  session: ['session'],
  lighting: ['lighting'],
  switches: [],
  music: ['music', 'why'],
  computer: ['computer'],
  phone: ['phone'],
  intent: ['lighting', 'music'],
  commands: ['lighting'],
  diagnostics: ['why'],
  timings: [],
};
/**
 * Always resent on resume: sources outside the engine revision, and music,
 * whose quiet-hours policy changes with the clock rather than a revision.
 */
export const AUXILIARY_SECTIONS: readonly StateViewSection[] = [
  'routines',
  'environment',
  'suggestions',
  'health',
  'music',
];

export function sectionsForDomains(
  domains: Iterable<StateUpdate['domains'][number]>,
): Set<StateViewSection> {
  const sections = new Set<StateViewSection>(AUXILIARY_SECTIONS);
  for (const domain of domains)
    for (const section of DOMAIN_SECTIONS[domain] ?? StateViewSectionNames)
      sections.add(section);
  return sections;
}

/**
 * Builds the compact client DTO. It reads engine state without mutating it
 * and never copies ledgers, timings or raw diagnostics into the view.
 */
export function buildStateView(sources: StateViewSources): StateView {
  const state = sources.engine.state;
  return {
    apiVersion: DEVICE_API_VERSION,
    instanceId: sources.instanceId,
    revision: state.revision,
    generatedAt: sources.now(),
    ...buildSections(sources),
  };
}

export function buildSections(sources: StateViewSources): StateViewSections {
  const state = sources.engine.state;
  const experience = sources.experience?.snapshot();
  return {
    presence: presenceView(state),
    session: {
      state: state.session?.state ?? 'none',
      startedAt: state.session?.startedAt ?? null,
      expiresAt: state.session?.expiresAt ?? null,
    },
    lighting: lightingView(sources),
    music: musicView(sources),
    routines: routinesView(experience?.routines),
    environment: sources.environment?.() ?? null,
    suggestions: suggestionsView(experience?.intelligence),
    computer: Object.values(state.computer.devices).map((device) => ({
      deviceId: device.deviceId,
      availability: device.availability,
      freshness: device.freshness,
      activity: device.activity.classification,
      locked: device.observed.locked,
      idle: device.observed.idle,
      fullscreen: device.observed.fullscreen,
      observedAt: device.observedAt,
    })),
    phone: {
      devices: Object.values(state.phone.devices)
        .sort((a, b) => a.deviceId.localeCompare(b.deviceId))
        .map((device) => structuredClone(device)),
      facts: phoneFacts(state.phone, sources.now()),
    },
    health: healthView(sources.integrations()),
    why: whyFeed(state),
  };
}

function presenceView(state: RoomState): StateViewSections['presence'] {
  return {
    state: state.presence.state,
    personCount: state.presence.personCount,
    exitPending: state.presence.exitPending
      ? {
          startedAt: state.presence.exitPending.startedAt,
          until: state.presence.exitPending.until,
        }
      : null,
    continuityExpiresAt: state.presence.continuityExpiresAt,
    home: {
      state: state.presence.home.state,
      observedAt: state.presence.home.observedAt,
    },
  };
}

function lightValues(values: LightingValues) {
  return {
    power: values.power ?? null,
    brightness: values.brightness ?? null,
    colorTemperature: values.colorTemperature ?? null,
    rgb: values.rgb ? ([...values.rgb] as [number, number, number]) : null,
  };
}

function matchesIntent(
  intent: LightingValues,
  observed: LightingValues,
): boolean | null {
  if (intent.power === false) return observed.power === false;
  const properties = LightingProperties.filter(
    (property) => intent[property] !== undefined,
  );
  if (properties.length === 0) return null;
  return properties.every((property) =>
    lightingFeedbackMatches(property, intent[property], observed[property]),
  );
}

function lightingView(
  sources: StateViewSources,
): StateViewSections['lighting'] {
  const lighting = sources.engine.state.lighting;
  return {
    currentSceneId: lighting.currentScene,
    sceneRevision: lighting.sceneRevision,
    scenes: [...sources.engine.scenes.values()].map((scene) => {
      const protection = sources.engine.sceneProtection(scene.id);
      return {
        id: scene.id,
        name: scene.name,
        icon: SCENE_ICONS[scene.id] ?? null,
        canEdit: sources.scenePresetsEditable && protection !== 'all_off',
        allOff:
          scene.id === 'scene.all_off' ||
          (Object.keys(scene.lighting).length > 0 &&
            Object.values(scene.lighting).every(
              (values) => values.power === false,
            )),
      };
    }),
    lights: Object.entries(lighting.devices)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, device]) => ({
        id,
        name: lightName(id),
        availability: device.availability,
        observed: lightValues(device.observed),
        intent: lightValues(device.effectiveDesired),
        matchesIntent: matchesIntent(device.effectiveDesired, device.observed),
        overridden: LightingProperties.filter(
          (property) => device.ownership[property]?.kind === 'override',
        ),
        externalControl: device.externalControl !== undefined,
      })),
  };
}

function lightName(id: string): string {
  const slug = id
    .replace(/^lighting\./, '')
    .replace(/[._-]+/g, ' ')
    .trim();
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

function musicView(sources: StateViewSources): StateViewSections['music'] {
  const music = sources.engine.state.music;
  const volume = sources.engine.getMusicVolumePolicySnapshots();
  const playback = sources.engine.getMusicPlaybackPolicySnapshots();
  return {
    targets: Object.entries(music.devices)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, device]) => {
        const volumePolicy = volume[id];
        const playbackPolicy = playback[id];
        const fade = music.fades[id];
        return {
          id,
          availability: device.availability,
          observedAt: device.observedAt,
          observed: {
            playback: device.observed.playback,
            volume: device.observed.volume,
            source: device.observed.source,
            title: device.observed.title,
            artist: device.observed.artist ?? null,
            album: device.observed.album ?? null,
          },
          allowedSources: [...device.allowedSources],
          presets: ['spotify_dj', 'optical'] as Array<'spotify_dj' | 'optical'>,
          volume: volumePolicy
            ? {
                controller: volumePolicy.controller,
                mode: volumePolicy.mode,
                policyEnabled: volumePolicy.policyEnabled,
                policyActive: volumePolicy.policyActive,
                activityReason: volumePolicy.activityReason,
                target: volumePolicy.target,
                effectiveTarget: volumePolicy.effectiveTarget,
              }
            : null,
          playback: playbackPolicy
            ? {
                activityReason: playbackPolicy.activityReason,
                quietHours: playbackPolicy.quietHours,
                manualPause: playbackPolicy.manualPause !== null,
                entryEligible: playbackPolicy.entryEligible,
                resumeExpiresAt: playbackPolicy.resumeExpiresAt,
              }
            : null,
          fade:
            fade && (fade.status === 'active' || fade.status === 'settling')
              ? { targetVolume: fade.targetVolume, status: fade.status }
              : null,
        };
      }),
  };
}

const RoutineSnapshotSchema = z.object({
  generation: z.string().optional(),
  definitions: z.array(
    z.object({ id: z.string(), name: z.string(), kind: z.string() }),
  ),
  next: z.array(z.object({ routineId: z.string(), at: z.number() })),
  runs: z.array(
    z.object({
      id: z.string(),
      routineId: z.string(),
      status: z.string(),
      startedAt: z.number(),
    }),
  ),
  bedtime: z
    .object({
      nightAvailable: z.boolean(),
      morningAvailable: z.boolean(),
      musicAvailable: z.boolean(),
      plan: z
        .object({
          at: z.number(),
          time: z.string(),
          mode: z.enum(['auto', 'button']),
          music: z.boolean(),
        })
        .nullable(),
      ready: z.object({ until: z.number(), music: z.boolean() }).nullable(),
    })
    .optional(),
});

function routinesView(raw: unknown): StateViewSections['routines'] {
  const parsed = RoutineSnapshotSchema.safeParse(raw);
  if (!parsed.success) return null;
  const snapshot = parsed.data;
  const names = new Map(snapshot.definitions.map((d) => [d.id, d]));
  const bedtime = snapshot.bedtime;
  return {
    generation: snapshot.generation ?? null,
    next: snapshot.next.slice(0, 10).map((occurrence) => ({
      routineId: occurrence.routineId,
      name: names.get(occurrence.routineId)?.name ?? occurrence.routineId,
      kind: names.get(occurrence.routineId)?.kind ?? 'custom',
      at: occurrence.at,
    })),
    running: snapshot.runs
      .filter((run) => run.status === 'running')
      .map((run) => ({
        routineId: run.routineId,
        runId: run.id,
        startedAt: run.startedAt,
      })),
    bedtime: bedtime
      ? {
          nightAvailable: bedtime.nightAvailable,
          morningAvailable: bedtime.morningAvailable,
          musicAvailable: bedtime.musicAvailable,
          plan: bedtime.plan
            ? {
                at: bedtime.plan.at,
                time: bedtime.plan.time,
                mode: bedtime.plan.mode,
                music: bedtime.plan.music,
              }
            : null,
          ready: bedtime.ready
            ? { until: bedtime.ready.until, music: bedtime.ready.music }
            : null,
        }
      : null,
  };
}

const IntelligenceSnapshotSchema = z.object({
  suggestions: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['scene', 'optical']),
      title: z.string(),
      reason: z.string(),
      sceneId: z.string().optional(),
      createdAt: z.number(),
      expiresAt: z.number(),
    }),
  ),
});

function suggestionsView(raw: unknown): StateViewSections['suggestions'] {
  const parsed = IntelligenceSnapshotSchema.safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.suggestions.map((suggestion) => ({
    id: suggestion.id,
    kind: suggestion.kind,
    title: suggestion.title,
    reason: suggestion.reason,
    sceneId: suggestion.sceneId ?? null,
    createdAt: suggestion.createdAt,
    expiresAt: suggestion.expiresAt,
  }));
}

function healthView(
  integrations: Record<string, string>,
): StateViewSections['health'] {
  const ok = Object.values(integrations).every(
    (status) => status === 'connected' || status === 'not_configured',
  );
  return { status: ok ? 'ok' : 'degraded', integrations: { ...integrations } };
}

const clockFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
function clock(at: unknown): string | null {
  return typeof at === 'number' && Number.isFinite(at)
    ? clockFormat.format(at)
    : null;
}

const SOURCE_LABELS: Array<[RegExp, string]> = [
  [/^lugn\.mobile/, 'Telefon'],
  [/^lugn\.ui/, 'Kontrollpanel'],
  [/^lugn\.display|^display/, 'Hub'],
  [/^presence/, 'Närvarosensor'],
  [/^routine/, 'Rutin'],
  [/^bilresa|^button/, 'Knapp'],
  [/^lugn\.http/, 'API'],
  [/^home_assistant|^homeassistant/, 'Home Assistant'],
];
function triggerLabel(details: Record<string, unknown>): string | null {
  const source = typeof details['source'] === 'string' ? details['source'] : '';
  for (const [pattern, label] of SOURCE_LABELS)
    if (pattern.test(source)) return label;
  const actor = details['actor'];
  if (actor && typeof actor === 'object' && 'type' in actor) {
    if (actor.type === 'physical_remote') return 'Knapp';
    if (actor.type === 'routine') return 'Rutin';
    if (actor.type === 'user') return 'Du';
  }
  return source ? source : null;
}

function target(details: Record<string, unknown>): string {
  return typeof details['target'] === 'string'
    ? lightName(details['target'])
    : 'En lampa';
}

const PRELIGHT_SUPPRESSED: Record<string, string> = {
  all_lights_off_scene: 'Förtände inte: en släckt scen är vald',
  explicitly_off: 'Förtände inte: lamporna släcktes för hand',
  room_already_lit: 'Förtände inte: ljuset var redan tänt',
  home_away: 'Förtände inte: du är borta enligt Home Assistant',
  already_occupied: 'Förtände inte: rummet var redan upptaget',
  prelight_restore_pending:
    'Förtände inte: föregående förtändning återställs fortfarande',
};

/** Maps an engine diagnostic to a short explanation, or null when it is noise. */
function diagnosticEntry(diagnostic: Diagnostic): WhyEntry | null {
  const details = diagnostic.details;
  const base = { id: `d${diagnostic.id}`, at: diagnostic.at };
  switch (diagnostic.kind) {
    case 'presence.empty': {
      const until = clock(details['expiresAt']);
      return {
        ...base,
        domain: 'lighting',
        outcome: 'acted',
        text: 'Släckte: rummet är tomt',
        trigger: 'Närvarosensor',
        conditions: [
          'Sensorn bekräftade tomt rum',
          ...(until ? [`Scen och justeringar minns till ${until}`] : []),
        ],
      };
    }
    case 'presence.occupied':
      return {
        ...base,
        domain: 'presence',
        outcome: 'acted',
        text: 'Tände: någon kom in',
        trigger: 'Närvarosensor',
        conditions: ['Sensorn bekräftade upptaget rum'],
      };
    case 'presence.returned':
      return {
        ...base,
        domain: 'lighting',
        outcome: 'acted',
        text: 'Återställde ljuset: du kom tillbaka inom minnestiden',
        trigger: 'Närvarosensor',
        conditions: ['Tidigare scen och justeringar fanns kvar'],
      };
    case 'presence.unknown':
      return {
        ...base,
        domain: 'presence',
        outcome: 'skipped',
        text: 'Släckte inte: sensorn vet inte om rummet är tomt',
        trigger: 'Närvarosensor',
        conditions: ['Okänd närvaro räknas aldrig som tomt'],
      };
    case 'presence.exit_pending': {
      const until = clock(details['until']);
      return {
        ...base,
        domain: 'presence',
        outcome: 'observed',
        text: until
          ? `Rummet verkar tomt: släcker ${until} om ingen kommer tillbaka`
          : 'Rummet verkar tomt: väntar innan ljuset släcks',
        trigger: 'Närvarosensor',
        conditions: ['Utgångsfördröjning pågår'],
      };
    }
    case 'presence.prelight':
      return {
        ...base,
        domain: 'lighting',
        outcome: 'acted',
        text: 'Förtände ljuset: möjlig entré',
        trigger: 'Närvarosensor',
        conditions: ['Tillfälligt tills entrén bekräftas'],
      };
    case 'presence.prelight_arrival_hint':
      return {
        ...base,
        domain: 'lighting',
        outcome: 'acted',
        text: 'Förtände trots borta: telefonen kom hem nyss',
        trigger: 'Telefon',
        conditions: [
          'Sensorn såg en möjlig entré',
          'Home Assistant rapporterade fortfarande borta',
        ],
      };
    case 'presence.prelight_suppressed': {
      const reason = String(details['reason'] ?? '');
      return {
        ...base,
        domain: 'lighting',
        outcome: 'skipped',
        text: PRELIGHT_SUPPRESSED[reason] ?? 'Förtände inte',
        trigger: 'Närvarosensor',
        conditions: reason ? [reason] : [],
      };
    }
    case 'presence.lighting_suppressed_home_away':
      return {
        ...base,
        domain: 'lighting',
        outcome: 'skipped',
        text: 'Tände inte: du är borta enligt Home Assistant',
        trigger: 'Närvarosensor',
        conditions: ['Borta blockerar automatisk tändning'],
      };
    case 'home_presence.away':
      return {
        ...base,
        domain: 'home',
        outcome: 'observed',
        text: 'Borta: automatisk tändning och musik är pausade',
        trigger: 'Home Assistant',
        conditions: [],
      };
    case 'home_presence.changed':
      return {
        ...base,
        domain: 'home',
        outcome: 'observed',
        text: diagnostic.message.endsWith('home')
          ? 'Hemma enligt Home Assistant'
          : 'Hemma-status okänd: räknas inte som borta',
        trigger: 'Home Assistant',
        conditions: [],
      };
    case 'continuity.expired':
      return {
        ...base,
        domain: 'lighting',
        outcome: 'acted',
        text: 'Glömde scen och justeringar: borta längre än minnestiden',
        trigger: null,
        conditions: [],
      };
    case 'scene.selected': {
      const name = diagnostic.message.replace(/^Scene (.*) selected$/, '$1');
      return {
        ...base,
        domain: 'lighting',
        outcome: 'acted',
        text: `Valde ${name}`,
        trigger: triggerLabel(details),
        conditions: [],
      };
    }
    case 'lighting.override':
      return {
        ...base,
        domain: 'lighting',
        outcome: 'observed',
        text: `Respekterar manuell ändring: ${target(details)}`,
        trigger: 'Manuellt',
        conditions: ['Ändringen kom inte från Lugn'],
      };
    case 'convergence.degraded':
      return {
        ...base,
        domain: 'lighting',
        outcome: 'failed',
        text: `${target(details)} svarade inte efter flera försök`,
        trigger: null,
        conditions: [],
      };
    case 'device.unavailable':
      return {
        ...base,
        domain: 'system',
        outcome: 'failed',
        text: `${target(details)} är inte nåbar`,
        trigger: null,
        conditions: [],
      };
    case 'command.failed':
      return {
        ...base,
        domain: 'system',
        outcome: 'failed',
        text: `Kommandot till ${target(details)} misslyckades`,
        trigger: null,
        conditions: [],
      };
    default:
      return null;
  }
}

const PLAYBACK_REASONS: Partial<Record<string, string>> = {
  manual_pause: 'Startade inte musik: du pausade',
  home_away: 'Startade inte musik: du är borta',
  quiet_hours: 'Startade inte musik: tyst tid 23–06',
  presence_unknown: 'Startade inte musik: närvaron är okänd',
  confirmed_empty: 'Pausade musiken: rummet är tomt',
  player_unavailable: 'Startade inte musik: spelaren svarar inte',
  computer_not_resumable: 'Startade inte musik: datorn kan inte återuppta',
  short_return_silent: 'Startade inte musik: det var tyst innan du gick',
  awaiting_new_entry: 'Startar musik vid nästa nya entré',
};
const VOLUME_REASONS: Partial<Record<string, string>> = {
  manual_hold: 'Ändrar inte volymen: du valde den själv',
  automation_disabled: 'Ändrar inte volymen: automatisk volym är av',
};

function musicEntry(decision: MusicDecision): WhyEntry | null {
  const text =
    decision.reason.kind === 'playback'
      ? PLAYBACK_REASONS[decision.reason.value]
      : VOLUME_REASONS[decision.reason.value];
  if (!text) return null;
  return {
    id: `m${decision.at}-${decision.target}-${decision.reason.kind}`,
    at: decision.at,
    domain: 'music',
    outcome: decision.reason.value === 'confirmed_empty' ? 'acted' : 'skipped',
    text,
    trigger: null,
    conditions: [decision.target, decision.reason.value],
  };
}

/** Newest first, bounded; derived only from existing engine ledgers. */
export function whyFeed(state: RoomState): WhyEntry[] {
  const entries: WhyEntry[] = [];
  for (const diagnostic of state.diagnostics) {
    const entry = diagnosticEntry(diagnostic);
    if (entry) entries.push(entry);
  }
  // Within one instant only the final policy reason per target and kind matters.
  const latest = new Map<string, MusicDecision>();
  for (const decision of state.music.decisions ?? [])
    latest.set(
      `${decision.at}-${decision.target}-${decision.reason.kind}`,
      decision,
    );
  for (const decision of latest.values()) {
    const entry = musicEntry(decision);
    if (entry) entries.push(entry);
  }
  return entries
    .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
    .slice(0, WHY_LIMIT);
}
