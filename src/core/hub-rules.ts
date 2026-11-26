/**
 * Hub rules: what each Hub screen shows, decided from the situation.
 *
 * A rule is `when` (a condition over facts about the home, the room and the
 * Hub) and `then` (effects on the Hub's screen). Nothing here knows about
 * pages' insides, the network or the clock: facts go in, a policy comes out,
 * so every rule can be tested by writing the facts down.
 *
 * Facts → conditions → matched rules → effects → one policy per Hub:
 *
 *   facts      what is true now (home or away, people in the room, whether the
 *              computer is in use, the time, which Hub this is)
 *   condition  a JSON tree: `all` / `any` / `not` over leaf tests
 *   effects    which pages exist (`only`, `hide`), which page to bring up
 *              (`focus`), how bright the screen is (`dim`) and free labels
 *              (`tags`) that any part of the page can style or react to
 *
 * Three-valued logic. A fact may be unknown (the sensor is silent, Home
 * Assistant has not answered). A leaf over an unknown fact is neither true nor
 * false, and a rule only applies when its condition is *true*. So unknown
 * never behaves as away, empty or idle: it only fails to trigger, which is the
 * same rule the rest of Lugn follows (docs/PRESENCE.md). `not` of unknown is
 * unknown. A leaf that can never be unknown, like the time, is always decided.
 *
 * Conflicts between rules are settled the same way everywhere:
 *   - rules apply in order of `priority` (lowest first, config order within a
 *     priority), and for single-valued effects the later rule wins;
 *   - `hide` is a union and `only` an intersection, so the stricter rule wins,
 *     and hiding beats showing;
 *   - `dim` takes the darkest value and `tags` are a union;
 *   - `focus` of a page that the result hides is dropped.
 * See docs/HUB-RULES.md.
 */
import { z } from 'zod';
import { HUB_RULE_SWITCHES } from './hub-settings.js';
import type { HomePresence, Presence } from './schemas.js';

/** The pages of the Hub pager (`data-page` in src/ui/display.html). */
export const HUB_PAGE_IDS = [
  'home',
  'halsning',
  'music',
  'foto',
  'kameror',
  'clock',
  'dator',
  'info',
  'installningar',
] as const;
export type HubPageId = (typeof HUB_PAGE_IDS)[number];
const HubPageIdSchema = z.enum(HUB_PAGE_IDS);

/**
 * Pages that are not in the pager unless a rule lets them in (`show`, or a
 * `scene`): the greeting belongs to a moment, and the computer page to someone
 * sitting at the computer.
 */
export const CONDITIONAL_PAGES: readonly HubPageId[] = ['halsning', 'dator'];

/** The scenes the greeting page can be in (`scene` effect). */
export const HUB_SCENE_KINDS = ['godmorgon', 'godnatt', 'hem', 'natt'] as const;
export type HubSceneKind = (typeof HUB_SCENE_KINDS)[number];

export const HUB_ROLES = ['bed', 'desk'] as const;
export type HubRole = (typeof HUB_ROLES)[number];

export const WEEKDAYS = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** What the computer agent says about the person at one computer. */
export type ComputerFact = 'active' | 'idle' | 'locked' | 'offline' | 'unknown';

// ── Facts ───────────────────────────────────────────────────────────────

export type HubFacts = {
  /** Epoch milliseconds. */
  now: number;
  hub: { id: string; role: HubRole };
  /** Europe/Stockholm wall clock. */
  clock: { minutes: number; weekday: Weekday };
  /** Home Assistant's home/away; not the room sensor. */
  home: HomePresence;
  /** When the resident last came home (`away` → `home`), if they did. */
  arrivedAt: number | null;
  room: {
    presence: Presence;
    /** Null when the sensor cannot count. */
    people: number | null;
  };
  /** Per computer id. */
  computers: Readonly<Record<string, ComputerFact>>;
  lights: {
    /** Some lamp is on; false when every known lamp is off; null when unknown. */
    anyOn: boolean | null;
    /**
     * When a lamp was first turned on since 06:00 today (the day starts at
     * 06:00), or null if none has been.
     */
    firstOnToday: number | null;
  };
  /** Some music device is playing; null when none reports. */
  musicPlaying: boolean | null;
  /** A computer plays something in full screen; null when none reports. */
  watching: boolean | null;
  /** The air has been over the set CO₂ level for a while; null without it. */
  airStuffy: boolean | null;
};

const clockFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Stockholm',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** The Stockholm wall clock at `at`: minutes after midnight and the weekday. */
export function stockholmClock(at: number): HubFacts['clock'] {
  let hour = 0;
  let minute = 0;
  let weekday: Weekday = 'mon';
  for (const part of clockFormat.formatToParts(at)) {
    if (part.type === 'hour') hour = Number(part.value);
    else if (part.type === 'minute') minute = Number(part.value);
    else if (part.type === 'weekday')
      weekday = part.value.slice(0, 3).toLowerCase() as Weekday;
  }
  return { minutes: hour * 60 + minute, weekday };
}

// ── Conditions ──────────────────────────────────────────────────────────

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { home: HomePresence }
  | { arrived: { withinMinutes: number } }
  | { room: 'occupied' | 'empty' | 'unknown' }
  | {
      people: { atLeast?: number | undefined; atMost?: number | undefined };
    }
  | {
      computer: {
        device?: string | undefined;
        is: Exclude<ComputerFact, 'unknown'>;
      };
    }
  | { lights: 'on' | 'off' }
  | { lightsOnFor: { atLeastMinutes: number } }
  | { music: 'playing' | 'quiet' }
  | { watching: boolean }
  | { air: 'stuffy' }
  | {
      time: {
        from: string;
        to: string;
        days?: Weekday[] | undefined;
      };
    }
  | { hub: { id?: string | undefined; role?: HubRole | undefined } };

const TimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const WeekdaySchema = z.enum(WEEKDAYS);

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(ConditionSchema).min(1).max(32) }).strict(),
    z.object({ any: z.array(ConditionSchema).min(1).max(32) }).strict(),
    z.object({ not: ConditionSchema }).strict(),
    z.object({ home: z.enum(['home', 'away', 'unknown']) }).strict(),
    z
      .object({
        arrived: z
          .object({
            withinMinutes: z
              .number()
              .positive()
              .max(24 * 60),
          })
          .strict(),
      })
      .strict(),
    z.object({ room: z.enum(['occupied', 'empty', 'unknown']) }).strict(),
    z
      .object({
        people: z
          .object({
            atLeast: z.number().int().min(0).max(99).optional(),
            atMost: z.number().int().min(0).max(99).optional(),
          })
          .strict()
          .refine(
            (value) =>
              value.atLeast !== undefined || value.atMost !== undefined,
            'people needs atLeast or atMost',
          ),
      })
      .strict(),
    z
      .object({
        computer: z
          .object({
            device: z.string().min(1).max(64).optional(),
            is: z.enum(['active', 'idle', 'locked', 'offline']),
          })
          .strict(),
      })
      .strict(),
    z.object({ lights: z.enum(['on', 'off']) }).strict(),
    z
      .object({
        lightsOnFor: z
          .object({
            atLeastMinutes: z
              .number()
              .positive()
              .max(24 * 60),
          })
          .strict(),
      })
      .strict(),
    z.object({ music: z.enum(['playing', 'quiet']) }).strict(),
    z.object({ watching: z.boolean() }).strict(),
    z.object({ air: z.literal('stuffy') }).strict(),
    z
      .object({
        time: z
          .object({
            from: TimeOfDaySchema,
            to: TimeOfDaySchema,
            days: z.array(WeekdaySchema).min(1).max(7).optional(),
          })
          .strict()
          .refine((value) => value.from !== value.to, 'from and to are equal'),
      })
      .strict(),
    z
      .object({
        hub: z
          .object({
            id: z.string().min(1).max(64).optional(),
            role: z.enum(HUB_ROLES).optional(),
          })
          .strict()
          .refine(
            (value) => value.id !== undefined || value.role !== undefined,
            'hub needs id or role',
          ),
      })
      .strict(),
  ]),
);

// ── Rules ───────────────────────────────────────────────────────────────

const TagSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

export const HubEffectsSchema = z
  .object({
    /** Bring this page up when the rule starts to apply (once, not held). */
    focus: z
      .object({
        page: HubPageIdSchema,
        /** Go here when the rule stops, if the page is still the one shown. */
        returnTo: HubPageIdSchema.optional(),
        /** Only take over from these pages; otherwise the offer is dropped. */
        fromPages: z.array(HubPageIdSchema).min(1).max(8).optional(),
        /** Not while anyone has touched the Hub this recently (seconds). */
        idleSeconds: z.number().min(0).max(3600).optional(),
      })
      .strict()
      .optional(),
    /** Let conditional pages (`halsning`, `dator`) into the pager. */
    show: z
      .array(z.enum(CONDITIONAL_PAGES as [HubPageId, ...HubPageId[]]))
      .min(1)
      .max(CONDITIONAL_PAGES.length)
      .optional(),
    /**
     * The greeting scene: lets the greeting page in, brings it up once when the
     * rule starts, and tells it which scene it is. `natt` also locks the Hub to
     * it (the dimmed night sheet).
     */
    scene: z.enum(HUB_SCENE_KINDS).optional(),
    /** The pager contains only these pages. */
    only: z.array(HubPageIdSchema).min(1).max(HUB_PAGE_IDS.length).optional(),
    /** These pages cannot be reached. */
    hide: z.array(HubPageIdSchema).min(1).max(HUB_PAGE_IDS.length).optional(),
    /** Screen brightness, 1 = unchanged. The Hub cannot dim its own panel. */
    dim: z.number().min(0.05).max(1).optional(),
    /** Free labels the page can react to (`[data-hub-tags~='night']`). */
    tags: z.array(TagSchema).min(1).max(16).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'then has no effect');
export type HubEffects = z.output<typeof HubEffectsSchema>;

export const HubRuleSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    description: z.string().max(200).optional(),
    enabled: z.boolean().default(true),
    /** Lets a Hub's settings page switch the rule off. */
    switch: z.enum(HUB_RULE_SWITCHES).optional(),
    /** Higher is applied later and wins single-valued effects. */
    priority: z.number().int().min(-100).max(100).default(0),
    /** Narrows the rule to some Hubs; sugar for an `all` with a `hub` test. */
    hubs: z
      .object({
        id: z.string().min(1).max(64).optional(),
        role: z.enum(HUB_ROLES).optional(),
      })
      .strict()
      .refine(
        (value) => value.id !== undefined || value.role !== undefined,
        'hubs needs id or role',
      )
      .optional(),
    when: ConditionSchema,
    then: HubEffectsSchema,
    /**
     * Once true, the rule stays applied this long after its condition stops
     * being true, so a flickering sensor does not flicker the screen.
     */
    holdMinutes: z
      .number()
      .min(0)
      .max(24 * 60)
      .default(0),
  })
  .strict();
export type HubRule = z.output<typeof HubRuleSchema>;

export const HubRulesSchema = z
  .array(HubRuleSchema)
  .max(64)
  .superRefine((rules, context) => {
    const seen = new Set<string>();
    for (const [index, rule] of rules.entries()) {
      if (seen.has(rule.id))
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: 'Hub rule IDs must be unique',
        });
      seen.add(rule.id);
    }
  });

// ── Evaluation ──────────────────────────────────────────────────────────

/** true, false, or null for "cannot tell". */
type Tri = boolean | null;

function conjunction(values: readonly Tri[]): Tri {
  let unknown = false;
  for (const value of values) {
    if (value === false) return false;
    if (value === null) unknown = true;
  }
  return unknown ? null : true;
}

function disjunction(values: readonly Tri[]): Tri {
  let unknown = false;
  for (const value of values) {
    if (value === true) return true;
    if (value === null) unknown = true;
  }
  return unknown ? null : false;
}

function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

function inTimeWindow(
  clock: HubFacts['clock'],
  window: { from: string; to: string; days?: Weekday[] | undefined },
): boolean {
  const from = minutesOf(window.from);
  const to = minutesOf(window.to);
  const day = (offset: number): Weekday =>
    WEEKDAYS[(WEEKDAYS.indexOf(clock.weekday) + 7 + offset) % 7]!;
  const allowed = (weekday: Weekday) =>
    window.days === undefined || window.days.includes(weekday);
  if (from < to)
    return clock.minutes >= from && clock.minutes < to && allowed(day(0));
  // Past midnight: the days name the day the window starts on.
  if (clock.minutes >= from) return allowed(day(0));
  if (clock.minutes < to) return allowed(day(-1));
  return false;
}

export function evaluateCondition(condition: Condition, facts: HubFacts): Tri {
  if ('all' in condition)
    return conjunction(condition.all.map((c) => evaluateCondition(c, facts)));
  if ('any' in condition)
    return disjunction(condition.any.map((c) => evaluateCondition(c, facts)));
  if ('not' in condition) {
    const inner = evaluateCondition(condition.not, facts);
    return inner === null ? null : !inner;
  }
  if ('home' in condition) {
    if (condition.home === 'unknown') return facts.home === 'unknown';
    return facts.home === 'unknown' ? null : facts.home === condition.home;
  }
  if ('arrived' in condition) {
    if (facts.home === 'unknown') return null;
    if (facts.home !== 'home' || facts.arrivedAt === null) return false;
    const elapsed = facts.now - facts.arrivedAt;
    return elapsed >= 0 && elapsed < condition.arrived.withinMinutes * 60_000;
  }
  if ('room' in condition) {
    const wanted =
      condition.room === 'empty' ? 'confirmed_empty' : condition.room;
    if (condition.room === 'unknown') return facts.room.presence === 'unknown';
    return facts.room.presence === 'unknown'
      ? null
      : facts.room.presence === wanted;
  }
  if ('people' in condition) {
    const count = facts.room.people;
    if (count === null) return null;
    const { atLeast, atMost } = condition.people;
    return (
      (atLeast === undefined || count >= atLeast) &&
      (atMost === undefined || count <= atMost)
    );
  }
  if ('computer' in condition) {
    const { device, is } = condition.computer;
    const readings =
      device === undefined
        ? Object.values(facts.computers)
        : facts.computers[device] === undefined
          ? []
          : [facts.computers[device]];
    if (readings.length === 0) return null;
    return disjunction(
      readings.map((reading) =>
        reading === 'unknown' ? null : reading === is,
      ),
    );
  }
  if ('lights' in condition) {
    if (facts.lights.anyOn === null) return null;
    return facts.lights.anyOn === (condition.lights === 'on');
  }
  if ('lightsOnFor' in condition) {
    if (facts.lights.anyOn === null) return null;
    const first = facts.lights.firstOnToday;
    if (first === null) return false;
    const elapsed = facts.now - first;
    return elapsed >= condition.lightsOnFor.atLeastMinutes * 60_000;
  }
  if ('music' in condition) {
    if (facts.musicPlaying === null) return null;
    return facts.musicPlaying === (condition.music === 'playing');
  }
  if ('watching' in condition)
    return facts.watching === null
      ? null
      : facts.watching === condition.watching;
  if ('air' in condition) return facts.airStuffy;
  if ('time' in condition) return inTimeWindow(facts.clock, condition.time);
  const { id, role } = condition.hub;
  return (
    (id === undefined || facts.hub.id === id) &&
    (role === undefined || facts.hub.role === role)
  );
}

/** Whether one rule's condition (and Hub selector) is true on these facts. */
export function ruleMatches(rule: HubRule, facts: HubFacts): boolean {
  if (!rule.enabled) return false;
  if (rule.hubs) {
    const { id, role } = rule.hubs;
    if (id !== undefined && facts.hub.id !== id) return false;
    if (role !== undefined && facts.hub.role !== role) return false;
  }
  return evaluateCondition(rule.when, facts) === true;
}

// ── Policy ──────────────────────────────────────────────────────────────

export type HubFocus = {
  page: HubPageId;
  returnTo: HubPageId | null;
  fromPages: HubPageId[] | null;
  idleSeconds: number | null;
  rule: string;
  /**
   * Names one activation of the rule. The Hub goes to the page when it sees a
   * token it has not acted on, so a person who swipes away is left alone until
   * the rule starts again.
   */
  token: string;
};

/** A greeting day shown on top of a scene (see greetings.ts). */
export type HubSceneSkin = {
  id: string;
  name?: string;
  age?: number;
  title?: string;
};

export type HubScene = {
  kind: HubSceneKind;
  skin: HubSceneSkin | null;
  rule: string;
};

export type HubPolicy = {
  /**
   * The pager's pages in order, or null for the usual ones (every page except
   * the conditional ones). Never empty.
   */
  pages: HubPageId[] | null;
  focus: HubFocus | null;
  scene: HubScene | null;
  /** 1 leaves the screen as it is; smaller is darker. */
  dim: number;
  tags: string[];
  /** The ids of the rules that apply, in the order they were applied. */
  rules: string[];
};

export const NEUTRAL_HUB_POLICY: HubPolicy = Object.freeze({
  pages: null,
  focus: null,
  scene: null,
  dim: 1,
  tags: [],
  rules: [],
}) as HubPolicy;

function byPrecedence(rules: readonly HubRule[]): HubRule[] {
  return rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => a.rule.priority - b.rule.priority || a.index - b.index)
    .map((entry) => entry.rule);
}

const USUAL_PAGES: readonly HubPageId[] = HUB_PAGE_IDS.filter(
  (page) => !CONDITIONAL_PAGES.includes(page),
);

/** Scene kinds that bring a skin (a greeting day) with them. */
const SKINNED_SCENES: readonly HubSceneKind[] = ['godmorgon', 'hem'];

/**
 * Combines the rules that apply into one policy. `active` maps a rule's id to
 * when it started to apply (epoch ms); that is what names its focus token.
 * `skin` is today's greeting day, put on the scenes that carry one.
 */
export function composeHubPolicy(
  rules: readonly HubRule[],
  active: ReadonlyMap<string, number>,
  skin: HubSceneSkin | null = null,
): HubPolicy {
  const applied = byPrecedence(rules).filter((rule) => active.has(rule.id));
  if (applied.length === 0) return NEUTRAL_HUB_POLICY;

  const limit: { only: Set<HubPageId> | null } = { only: null };
  const hidden = new Set<HubPageId>();
  const shown = new Set<HubPageId>();
  const tags = new Set<string>();
  let dim = 1;
  let focus: {
    rule: HubRule;
    page: HubPageId;
    returnTo: HubPageId | null;
    fromPages: HubPageId[] | null;
    idleSeconds: number | null;
  } | null = null;
  let scene: { rule: HubRule; kind: HubSceneKind } | null = null;
  for (const rule of applied) {
    const { then } = rule;
    if (then.only) {
      const list: Set<HubPageId> = new Set(then.only);
      limit.only = limit.only
        ? new Set([...limit.only].filter((page) => list.has(page)))
        : list;
    }
    for (const page of then.hide ?? []) hidden.add(page);
    for (const page of then.show ?? []) shown.add(page);
    for (const tag of then.tags ?? []) tags.add(tag);
    if (then.dim !== undefined) dim = Math.min(dim, then.dim);
    if (then.scene) {
      // A scene lets the greeting in and brings it up.
      scene = { rule, kind: then.scene };
      shown.add('halsning');
      focus = {
        rule,
        page: 'halsning',
        returnTo: 'home',
        fromPages: null,
        idleSeconds: null,
      };
    }
    if (then.focus)
      focus = {
        rule,
        page: then.focus.page,
        returnTo: then.focus.returnTo ?? null,
        fromPages: then.focus.fromPages ?? null,
        idleSeconds: then.focus.idleSeconds ?? null,
      };
  }

  // The dimmed night sheet locks the Hub to it, but only while it is the scene
  // that wins: a scene ranked above the night is not locked by it.
  if (scene?.kind === 'natt')
    limit.only = new Set(
      [...(limit.only ?? ['halsning'])].filter((page) => page === 'halsning'),
    );

  let pages: HubPageId[] | null = null;
  const list = HUB_PAGE_IDS.filter(
    (page) =>
      (USUAL_PAGES.includes(page) || shown.has(page)) &&
      (limit.only === null || limit.only.has(page)) &&
      !hidden.has(page),
  );
  // Rules that together leave no page are ignored rather than obeyed.
  if (
    list.length > 0 &&
    (list.length !== USUAL_PAGES.length ||
      list.some((page, index) => page !== USUAL_PAGES[index]))
  )
    pages = list;

  const reachable = (page: HubPageId) =>
    pages === null ? USUAL_PAGES.includes(page) : pages.includes(page);
  const goes = focus !== null && reachable(focus.page);
  const sceneNow =
    scene !== null && reachable('halsning')
      ? {
          kind: scene.kind,
          skin: SKINNED_SCENES.includes(scene.kind) ? skin : null,
          rule: scene.rule.id,
        }
      : null;
  return {
    pages,
    focus:
      focus && goes
        ? {
            page: focus.page,
            returnTo:
              focus.returnTo && reachable(focus.returnTo)
                ? focus.returnTo
                : null,
            fromPages: focus.fromPages,
            idleSeconds: focus.idleSeconds,
            rule: focus.rule.id,
            token: `${focus.rule.id}@${active.get(focus.rule.id)}`,
          }
        : null,
    scene: sceneNow,
    dim,
    tags: [...tags].sort(),
    rules: applied.map((rule) => rule.id),
  };
}
