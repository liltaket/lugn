import {
  composeHubPolicy,
  NEUTRAL_HUB_POLICY,
  ruleMatches,
  stockholmClock,
  type ComputerFact,
  type HubFacts,
  type HubPolicy,
  type HubRole,
  type HubRule,
} from '../core/hub-rules.js';
import type { ComputerObservation } from '../core/computer.js';
import {
  greetingSkin,
  stockholmDate,
  type GreetingsConfig,
} from '../core/greetings.js';
import type { RoomState } from '../core/schemas.js';
import { defaultHubSettings, type HubSettings } from '../core/hub-settings.js';

/**
 * What a computer's agent says about the person at it. Only a fresh, online
 * reading counts; anything else is unknown, and a stale "active" never keeps a
 * screen awake.
 */
export function computerFact(observation: ComputerObservation): ComputerFact {
  if (observation.availability === 'offline') return 'offline';
  if (
    observation.availability !== 'online' ||
    observation.freshness !== 'fresh'
  )
    return 'unknown';
  const { locked, idle } = observation.observed;
  if (locked === true) return 'locked';
  if (idle === true) return 'idle';
  return idle === false ? 'active' : 'unknown';
}

/** Some lamp is on; false when all known lamps are off; null without reports. */
export function lightsFact(state: RoomState): boolean | null {
  let known = false;
  for (const device of Object.values(state.lighting.devices)) {
    if (device.availability === 'unavailable') continue;
    const power = device.observed.power;
    if (power === true) return true;
    if (power === false) known = true;
  }
  return known ? false : null;
}

/** Some music device is playing; null when none reports a playback state. */
export function musicFact(state: RoomState): boolean | null {
  let known = false;
  for (const device of Object.values(state.music.devices)) {
    if (device.availability === 'unavailable') continue;
    const playback = device.observed.playback;
    if (playback === 'playing') return true;
    if (playback !== 'unknown') known = true;
  }
  return known ? false : null;
}

/**
 * A computer plays something in full screen, with someone's session open: a
 * film, a video or a game. False when the computers that report do not.
 */
export function watchingFact(state: RoomState): boolean | null {
  let known = false;
  for (const observation of Object.values(state.computer.devices)) {
    if (
      observation.availability !== 'online' ||
      observation.freshness !== 'fresh'
    )
      continue;
    const { locked, fullscreen, audio, media } = observation.observed;
    if (fullscreen === null) continue;
    known = true;
    if (
      fullscreen &&
      locked !== true &&
      (audio?.playing === true ||
        media?.some((entry) => entry.playback === 'playing'))
    )
      return true;
  }
  return known ? false : null;
}

/** The room's CO₂, as the environment adapter reports it. */
export type AirReading = { value: number | null; observedAt: number | null };

const AIR_MINUTES = 10;
/** The air counts as good again this far under the level, not just under it. */
const AIR_MARGIN_PPM = 200;
const AIR_MAX_AGE_MS = 30 * 60_000;

/** The day starts at 06:00: the first lamp turned on is kept per such day. */
const DAY_START_MINUTES = 6 * 60;

/** The facts the rules see, for one Hub at one moment. */
export function hubFacts(
  state: RoomState,
  hub: { id: string; role: HubRole },
  now: number,
  firstLightsOnToday: number | null = null,
  airStuffy: boolean | null = null,
): HubFacts {
  const computers: Record<string, ComputerFact> = {};
  for (const [id, observation] of Object.entries(state.computer.devices))
    computers[id] = computerFact(observation);
  const { home, state: presence, personCount } = state.presence;
  return {
    now,
    hub: { id: hub.id, role: hub.role },
    clock: stockholmClock(now),
    home: home.state,
    arrivedAt: home.arrivedAt ?? null,
    room: {
      presence,
      people:
        presence === 'confirmed_empty'
          ? 0
          : presence === 'occupied'
            ? personCount
            : null,
    },
    computers,
    lights: { anyOn: lightsFact(state), firstOnToday: firstLightsOnToday },
    musicPlaying: musicFact(state),
    watching: watchingFact(state),
    airStuffy,
  };
}

type Activation = { since: number; lastTrue: number };

/**
 * Applies the configured rules to the Hubs. It remembers, per Hub and rule,
 * when the rule started to apply (which names a `focus` activation) and, for a
 * rule with `holdMinutes`, when its condition was last true. It keeps nothing
 * else, so a restart forgets activations: an active `focus` is offered once
 * more to a Hub that connects afterwards.
 */
export class HubPolicyEngine {
  private readonly activations = new Map<string, Map<string, Activation>>();
  /** When a lamp was first turned on since 06:00, for the day it belongs to. */
  private firstLightsOn: { day: number; at: number } | null = null;
  /** Each lamp's last reported power, which is how turning one on is seen. */
  private readonly lampPower = new Map<string, boolean>();

  /** Since when the CO₂ has been over the level, and whether it counts yet. */
  private air: { since: number | null; stuffy: boolean } = {
    since: null,
    stuffy: false,
  };

  constructor(
    private readonly rules: readonly HubRule[],
    private readonly greetings: GreetingsConfig = {
      birthdays: [],
      days: [],
    },
    private readonly settings: () => HubSettings = () => defaultHubSettings,
  ) {}

  /**
   * Stuffy after ten minutes at or over the set level, and until the level is
   * well under it, so a reading that hovers does not blink the reminder.
   */
  private observeAir(
    reading: AirReading | undefined,
    now: number,
  ): boolean | null {
    const limit = this.settings().airPpm;
    const value = reading?.value;
    const fresh =
      typeof value === 'number' &&
      typeof reading?.observedAt === 'number' &&
      now - reading.observedAt <= AIR_MAX_AGE_MS;
    if (limit === 0 || !fresh) {
      this.air = { since: null, stuffy: false };
      return limit === 0 ? false : null;
    }
    if (this.air.stuffy) {
      if (value < limit - AIR_MARGIN_PPM)
        this.air = { since: null, stuffy: false };
    } else if (value >= limit) {
      this.air.since ??= now;
      this.air.stuffy = now - this.air.since >= AIR_MINUTES * 60_000;
    } else this.air.since = null;
    return this.air.stuffy;
  }

  /**
   * When a lamp was first turned on today (the day starts at 06:00): it was
   * last reported off and is now on. A lamp left on overnight does not count.
   * Seen at each evaluation, so it is as exact as the Hub's five-second
   * heartbeat, and a restart starts the day's reading over.
   */
  private observeLights(state: RoomState, now: number): number | null {
    const clock = stockholmClock(now);
    const date = stockholmDate(now - DAY_START_MINUTES * 60_000);
    const day = date.year * 10_000 + date.month * 100 + date.day;
    if (this.firstLightsOn && this.firstLightsOn.day !== day)
      this.firstLightsOn = null;
    let turnedOn = false;
    for (const [id, device] of Object.entries(state.lighting.devices)) {
      // A lamp that drops out keeps its last report.
      if (device.availability === 'unavailable') continue;
      const power = device.observed.power;
      if (typeof power !== 'boolean') continue;
      if (power && this.lampPower.get(id) === false) turnedOn = true;
      this.lampPower.set(id, power);
    }
    if (!this.firstLightsOn && turnedOn && clock.minutes >= DAY_START_MINUTES)
      this.firstLightsOn = { day, at: now };
    return this.firstLightsOn?.at ?? null;
  }

  get hasRules(): boolean {
    return this.rules.some((rule) => rule.enabled);
  }

  evaluate(
    hub: { id: string; role: HubRole },
    state: RoomState,
    now: number,
    air?: AirReading,
  ): HubPolicy {
    if (!this.hasRules) return NEUTRAL_HUB_POLICY;
    const facts = hubFacts(
      state,
      hub,
      now,
      this.observeLights(state, now),
      this.observeAir(air, now),
    );
    const settings = this.settings();
    let hubActivations = this.activations.get(hub.id);
    if (!hubActivations) {
      hubActivations = new Map();
      this.activations.set(hub.id, hubActivations);
    }
    const active = new Map<string, number>();
    for (const rule of this.rules) {
      const previous = hubActivations.get(rule.id);
      // Switched off on the settings page: gone at once, whatever it holds.
      if (rule.switch && !settings[rule.switch]) {
        hubActivations.delete(rule.id);
        continue;
      }
      if (ruleMatches(rule, facts)) {
        const activation = previous ?? { since: now, lastTrue: now };
        activation.lastTrue = now;
        hubActivations.set(rule.id, activation);
        active.set(rule.id, activation.since);
      } else if (
        previous &&
        rule.enabled &&
        rule.holdMinutes > 0 &&
        now >= previous.lastTrue &&
        now - previous.lastTrue < rule.holdMinutes * 60_000
      ) {
        active.set(rule.id, previous.since);
      } else {
        hubActivations.delete(rule.id);
      }
    }
    return composeHubPolicy(
      this.rules,
      active,
      greetingSkin(now, this.greetings),
    );
  }
}
