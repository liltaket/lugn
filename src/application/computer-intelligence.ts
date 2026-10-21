import { randomUUID } from 'node:crypto';
import type { Clock, TimerHandle } from '../core/clock.js';
import type { ComputerObservation } from '../core/computer.js';
import {
  corroboratedMedia,
  IntelligenceError,
  IntelligenceSettingsSchema,
  type IntelligenceSettings,
  type IntelligenceSettingsDocument,
  type IntelligenceSettingsRepository,
  type IntelligenceSnapshot,
  type OpticalDecision,
  type OpticalReason,
  type Suggestion,
} from '../core/intelligence.js';
import type { RoomState } from '../core/schemas.js';
import type { ComputerAudioRoute } from './computer-now-playing.js';
import type { CapabilityInvocation, CapabilityResult } from './capabilities.js';

/** Typed capability seam: the service has no adapter, transport or device access. */
export interface IntelligenceCapabilities {
  invoke(
    name: 'lighting.activateScene',
    input: { sceneId: string },
    invocation: CapabilityInvocation,
  ): Promise<CapabilityResult<'lighting.activateScene'>>;
  invoke(
    name: 'music.selectSource',
    input: { target: string; source: string },
    invocation: CapabilityInvocation,
  ): Promise<CapabilityResult<'music.selectSource'>>;
}
/** Missing/unknown policy evidence must be represented as false (or true for holds). */
export type IntelligenceTrust = {
  computerTrusted: boolean;
  receiverTrusted: boolean;
  playbackAllowed: boolean;
  quietHours: boolean;
  manualPause: boolean;
  manualSourceHold: boolean;
};
export type ComputerIntelligenceOptions = {
  clock: Clock;
  settingsStore: IntelligenceSettingsRepository;
  computerDeviceIds: readonly string[];
  /** Extract only explicit existing computerAudio mappings; never discover or infer routes. */
  computerAudio: Readonly<Record<string, ComputerAudioRoute>>;
  getState: () => RoomState;
  getTrust: (deviceId: string, target: string | null) => IntelligenceTrust;
  availableSceneIds: () => readonly string[];
  sceneName?: (sceneId: string) => string;
  capabilities: IntelligenceCapabilities;
  onChange?: (snapshot: IntelligenceSnapshot) => void;
  maxObservationAgeMs?: number;
  suggestionTtlMs?: number;
};
export interface ComputerIntelligenceService {
  snapshot(): IntelligenceSnapshot;
  updateSettings(
    settings: IntelligenceSettings,
    expectedGeneration: string,
  ): Promise<IntelligenceSnapshot>;
  respondSuggestion(
    id: string,
    action: 'accept' | 'reject' | 'dismiss',
    invocation?: CapabilityInvocation,
  ): Promise<IntelligenceSnapshot>;
  observe(): void;
  subscribe(listener: (snapshot: IntelligenceSnapshot) => void): () => void;
  dispose(): void;
}
type Context = {
  id: string;
  since: number;
  sinceWall: number;
  emitted: boolean;
  suppressed: boolean;
};
type History = {
  session: string;
  retiredSessions: Set<string>;
  sequence: number;
  observedAt: number;
  receivedAt: number;
  acceptedAt: number;
  previous: ComputerObservation;
  invalid: OpticalReason | null;
  activity: string;
  scene: Context | null;
  audio: Context | null;
  player: string | null;
  stoppedSince: number | null;
  armed: boolean;
};
type LiveSuggestion = {
  suggestion: Suggestion;
  contextId: string;
  expiresMono: number;
};
const HYSTERESIS_MS = 5000;
const SCENE_STABILITY_MS = 5000;

/** Deterministic advisory service. Optical v1 is always suggestion-first, including auto mode. */
export class ComputerIntelligence implements ComputerIntelligenceService {
  private readonly histories = new Map<string, History>();
  private readonly suggestions = new Map<string, LiveSuggestion>();
  private readonly listeners = new Set<
    (snapshot: IntelligenceSnapshot) => void
  >();
  private readonly lastIssued = new Map<Suggestion['kind'], number>();
  private readonly receiverSources = new Map<string, string | null>();
  private timer: TimerHandle | undefined;
  private disposed = false;
  private serial = 0;
  private readonly instanceId = randomUUID();
  private decisions: OpticalDecision[] = [];
  private publication = '';
  private evidenceGeneration: string | undefined;
  private readonly maxAge: number;
  private readonly ttl: number;
  private readonly deviceIds: Set<string>;

  constructor(private readonly options: ComputerIntelligenceOptions) {
    this.maxAge = options.maxObservationAgeMs ?? 90_000;
    this.ttl = options.suggestionTtlMs ?? 60_000;
    if (
      !Number.isFinite(this.maxAge) ||
      this.maxAge < 1000 ||
      this.maxAge > 300_000 ||
      !Number.isFinite(this.ttl) ||
      this.ttl < 1000 ||
      this.ttl > 300_000
    )
      throw new Error('Invalid intelligence timing bounds');
    this.deviceIds = new Set(options.computerDeviceIds);
    if (options.onChange) this.listeners.add(options.onChange);
    this.observe();
  }

  snapshot(): IntelligenceSnapshot {
    return structuredClone({
      ...this.settingsDocument(),
      suggestions: [...this.suggestions.values()].map(
        (entry) => entry.suggestion,
      ),
      optical: this.decisions,
    });
  }
  subscribe(listener: (snapshot: IntelligenceSnapshot) => void): () => void {
    this.assertActive();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async updateSettings(
    input: IntelligenceSettings,
    expectedGeneration: string,
  ): Promise<IntelligenceSnapshot> {
    this.assertActive();
    const settings = IntelligenceSettingsSchema.parse(input);
    const { deviceId, target, source, enabled } = settings.optical;
    if (
      enabled &&
      (!deviceId ||
        !target ||
        !source ||
        !this.mappingMatches(deviceId, target, source))
    )
      throw new IntelligenceError(400, 'optical_mapping_unavailable');
    if (
      settings.suggestions.enabled &&
      Object.values(settings.suggestions.sceneMappings).some(
        (id) => !this.options.availableSceneIds().includes(id!),
      )
    )
      throw new IntelligenceError(400, 'scene_unavailable');
    try {
      await this.options.settingsStore.save(settings, expectedGeneration);
    } finally {
      // A rename may have committed even if later persistence work fails. Read
      // the current document, never replay a delayed save result or reset newer evidence.
      if (!this.disposed) this.observe();
    }
    return this.snapshot();
  }
  async respondSuggestion(
    id: string,
    action: 'accept' | 'reject' | 'dismiss',
    invocation?: CapabilityInvocation,
  ): Promise<IntelligenceSnapshot> {
    this.assertActive();
    if (!['accept', 'reject', 'dismiss'].includes(action))
      throw new IntelligenceError(400, 'invalid_suggestion_action');
    this.observe(); // Revalidate with current state, trust, mappings, age and holds.
    this.assertActive();
    const entry = this.suggestions.get(id);
    if (!entry) throw new IntelligenceError(409, 'suggestion_unavailable');
    if (
      action === 'accept' &&
      (!invocation ||
        !['user', 'physical_remote'].includes(invocation.actor.type))
    )
      throw new IntelligenceError(400, 'human_actor_required');
    // Consume before awaiting a callback: concurrent accepts and feedback cannot replay it.
    this.suggestions.delete(id);
    if (action === 'accept') {
      const suggestion = entry.suggestion;
      try {
        if (suggestion.kind === 'scene')
          await this.options.capabilities.invoke(
            'lighting.activateScene',
            { sceneId: suggestion.sceneId! },
            invocation!,
          );
        else
          await this.options.capabilities.invoke(
            'music.selectSource',
            { target: suggestion.target!, source: suggestion.source! },
            invocation!,
          );
      } finally {
        if (!this.disposed) this.observe();
      }
    } else this.observe();
    return this.snapshot();
  }

  observe(): void {
    if (this.disposed) return;
    if (this.timer !== undefined) this.options.clock.clearTimeout(this.timer);
    this.timer = undefined;
    const settings = this.settingsDocument().settings;
    const state = this.options.getState();
    const now = this.options.clock.monotonicNow();
    for (const deviceId of this.deviceIds)
      this.ingest(deviceId, state.computer.devices[deviceId]);
    // Any source change away from Optical cancels that context, including changes while paused.
    const target = settings.optical.target;
    if (target) {
      const source = state.music.devices[target]?.observed.source ?? null;
      if (
        this.receiverSources.has(target) &&
        this.receiverSources.get(target) !== source &&
        source !== settings.optical.source
      )
        this.suppressAudio(settings.optical.deviceId);
      this.receiverSources.set(target, source);
    }
    this.decisions = [this.opticalDecision(state, settings)];
    for (const [id, entry] of this.suggestions) {
      const h = this.histories.get(entry.suggestion.deviceId);
      const valid =
        entry.suggestion.kind === 'optical'
          ? this.decisions[0]?.suggestionAllowed &&
            h?.audio?.id === entry.contextId
          : settings.suggestions.enabled &&
            this.sceneEligible(state, entry.suggestion.deviceId) &&
            h?.scene?.id === entry.contextId &&
            settings.suggestions.sceneMappings[
              h.activity as keyof typeof settings.suggestions.sceneMappings
            ] === entry.suggestion.sceneId &&
            this.options
              .availableSceneIds()
              .includes(entry.suggestion.sceneId!) &&
            state.lighting.currentScene !== entry.suggestion.sceneId;
      if (
        !valid ||
        now >= entry.expiresMono ||
        this.options.clock.now() >= entry.suggestion.expiresAt
      )
        this.suggestions.delete(id);
    }
    const optical = this.decisions[0]!;
    const audio = settings.optical.deviceId
      ? this.histories.get(settings.optical.deviceId)?.audio
      : null;
    if (
      optical.suggestionAllowed &&
      audio &&
      !audio.emitted &&
      !this.cooling('optical', settings.optical.cooldownMs)
    ) {
      this.issue(
        {
          kind: 'optical',
          title: 'Använd datorljudet?',
          reason:
            'Datorn har börjat spela och aktiviteten är stabil. Hörbart ljud är inte verifierat. Du väljer om ingången ska bytas.',
          deviceId: settings.optical.deviceId!,
          target: settings.optical.target!,
          source: settings.optical.source!,
        },
        audio,
      );
    }
    if (settings.suggestions.enabled)
      for (const [deviceId, history] of this.histories) {
        const context = history.scene;
        const sceneId =
          settings.suggestions.sceneMappings[
            history.activity as keyof typeof settings.suggestions.sceneMappings
          ];
        if (
          context &&
          !context.emitted &&
          sceneId &&
          now - context.since >= SCENE_STABILITY_MS &&
          this.sceneEligible(state, deviceId) &&
          this.options.availableSceneIds().includes(sceneId) &&
          state.lighting.currentScene !== sceneId &&
          !this.cooling('scene', settings.suggestions.cooldownMs)
        ) {
          this.issue(
            {
              kind: 'scene',
              title: `Vill du använda ${this.options.sceneName?.(sceneId) ?? 'ditt valda ljusläge'}?`,
              reason: `Datorn visar stabil ${activityLabel(history.activity)}. Du har kopplat den aktiviteten till detta ljusläge.`,
              deviceId,
              sceneId,
            },
            context,
          );
        }
      }
    // Pruning expiry can consume the context; expose that suppression immediately.
    this.decisions = [this.opticalDecision(state, settings)];
    this.publish();
    if (
      !this.disposed &&
      this.timer === undefined &&
      (settings.optical.enabled || settings.suggestions.enabled)
    )
      this.timer = this.options.clock.setTimeout(() => {
        this.timer = undefined;
        this.observe();
      }, 1000);
  }
  dispose(): void {
    if (this.timer !== undefined) this.options.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.disposed = true;
    this.suggestions.clear();
    this.histories.clear();
    this.listeners.clear();
  }

  private settingsDocument(): IntelligenceSettingsDocument {
    const document = this.options.settingsStore.snapshot();
    if (document.generation !== this.evidenceGeneration) {
      // The store publishes at rename, before save() finishes directory sync.
      // Rebase synchronously before evaluating or projecting this generation.
      this.evidenceGeneration = document.generation;
      this.histories.clear();
      this.suggestions.clear();
      this.receiverSources.clear();
      this.decisions = [];
    }
    return document;
  }

  private ingest(
    deviceId: string,
    computer: ComputerObservation | undefined,
  ): void {
    const now = this.options.clock.monotonicNow();
    let h = this.histories.get(deviceId);
    const fresh =
      computer &&
      computer.availability === 'online' &&
      computer.freshness === 'fresh' &&
      computer.reason === 'live' &&
      computer.sessionId &&
      computer.sequence !== null &&
      computer.observedAt !== null &&
      computer.receivedAt !== null &&
      this.freshTimestamp(computer.observedAt) &&
      this.freshTimestamp(computer.receivedAt);
    if (!fresh || !this.options.getTrust(deviceId, null).computerTrusted) {
      if (h) this.invalidate(h, 'computer_stale');
      return;
    }
    if (h?.retiredSessions.has(computer.sessionId!)) {
      this.invalidate(h, 'out_of_order');
      return;
    }
    if (!h || h.session !== computer.sessionId) {
      const retiredSessions = h?.retiredSessions ?? new Set<string>();
      if (h) retiredSessions.add(h.session);
      // Only configured computers are tracked. Bound restart history; forgotten sessions still seed baselines.
      if (retiredSessions.size > 64)
        retiredSessions.delete(retiredSessions.values().next().value!);
      h = {
        session: computer.sessionId!,
        retiredSessions,
        sequence: computer.sequence!,
        observedAt: computer.observedAt!,
        receivedAt: computer.receivedAt!,
        acceptedAt: now,
        previous: structuredClone(computer),
        invalid: 'restart_baseline',
        activity: computer.activity.classification,
        scene: null,
        audio: null,
        player: null,
        stoppedSince: this.knownStopped(computer) ? now : null,
        armed: this.knownStopped(computer),
      };
      this.histories.set(deviceId, h);
      return;
    }
    if (
      computer.sequence! < h.sequence ||
      computer.observedAt! < h.observedAt ||
      computer.receivedAt! < h.receivedAt
    ) {
      this.invalidate(h, 'out_of_order');
      return;
    }
    if (computer.sequence === h.sequence) {
      if (
        JSON.stringify([computer.observed, computer.activity]) !==
        JSON.stringify([h.previous.observed, h.previous.activity])
      ) {
        this.invalidate(h, 'out_of_order');
        return;
      }
      if (now - h.acceptedAt >= this.maxAge)
        this.invalidate(h, 'computer_stale');
      return;
    }
    // Equal timestamps with a newer sequence are ambiguous, never transition evidence.
    if (computer.observedAt === h.observedAt) {
      this.invalidate(h, 'out_of_order');
      h.sequence = computer.sequence!;
      return;
    }
    const wasInvalid = h.invalid !== null && h.invalid !== 'restart_baseline';
    const previous = h.previous;
    h.sequence = computer.sequence!;
    h.observedAt = computer.observedAt!;
    h.receivedAt = computer.receivedAt!;
    h.acceptedAt = now;
    h.previous = structuredClone(computer);
    h.invalid = null;
    if (wasInvalid) {
      h.activity = computer.activity.classification;
      h.armed = this.knownStopped(computer);
      h.stoppedSince = h.armed ? now : null;
      return;
    }
    if (h.activity !== computer.activity.classification) {
      h.scene =
        h.activity !== 'unknown' &&
        computer.activity.classification !== 'unknown'
          ? this.context()
          : null;
      h.activity = computer.activity.classification;
    }
    const media = corroboratedMedia(computer);
    if (!media.player) {
      h.audio = null;
      h.player = null;
      if (this.knownStopped(computer)) {
        h.stoppedSince ??= now;
        if (now - h.stoppedSince >= HYSTERESIS_MS) h.armed = true;
      } else {
        h.stoppedSince = null;
        h.armed = false;
      }
      return;
    }
    if (
      h.player === media.player &&
      h.audio &&
      previous.activity.classification === computer.activity.classification
    )
      return;
    // A different player/activity cannot inherit another player's elapsed stability.
    h.audio = null;
    h.player = null;
    const prior = previous.observed.media?.find(
      (m) => m.player === media.player,
    );
    const started = prior && ['paused', 'stopped'].includes(prior.playback);
    const rearmed =
      h.armed ||
      (h.stoppedSince !== null && now - h.stoppedSince >= HYSTERESIS_MS);
    h.stoppedSince = null;
    if (started && rearmed) {
      h.audio = this.context();
      h.player = media.player;
    }
    h.armed = false;
  }
  private opticalDecision(
    state: RoomState,
    settings: IntelligenceSettings,
  ): OpticalDecision {
    const optical = settings.optical;
    const h = optical.deviceId
      ? this.histories.get(optical.deviceId)
      : undefined;
    const computer = optical.deviceId
      ? state.computer.devices[optical.deviceId]
      : undefined;
    const decision = (
      reason: OpticalReason,
      status: OpticalDecision['state'] = 'suppressed',
      evidence: string[] = [],
    ): OpticalDecision => ({
      deviceId: optical.deviceId,
      target: optical.target,
      source: optical.source,
      state: status,
      reason,
      evidence,
      automaticAllowed: false,
      suggestionAllowed: status === 'permitted',
      stableSince: h?.audio?.sinceWall ?? null,
      evaluatedAt: this.options.clock.now(),
    });
    if (!optical.enabled) return decision('disabled');
    if (
      !optical.deviceId ||
      !optical.target ||
      !optical.source ||
      !this.mappingMatches(optical.deviceId, optical.target, optical.source)
    )
      return decision('mapping_unavailable');
    const trust = this.options.getTrust(optical.deviceId, optical.target);
    if (!trust.computerTrusted) return decision('computer_untrusted');
    if (!h || !computer) return decision('computer_stale');
    if (h.invalid) return decision(h.invalid);
    const media = corroboratedMedia(computer);
    if (!media.player) return decision(media.reason);
    if (!optical.allowedActivities.includes(computer.activity.classification))
      return decision('activity_not_allowed');
    if (!h.audio) return decision('awaiting_start_transition');
    if (state.presence.state !== 'occupied')
      return decision('presence_not_occupied');
    if (state.presence.home.state !== 'home') return decision('home_not_home');
    if (
      trust.manualPause ||
      trust.manualSourceHold ||
      state.intent.holds.some(
        (hold) =>
          hold.scope === 'music.playback' &&
          (hold.target === optical.target || hold.target === '*'),
      )
    ) {
      this.suppressAudio(optical.deviceId);
      return decision('manual_hold');
    }
    if (trust.quietHours) return decision('quiet_hours');
    if (!trust.playbackAllowed) return decision('playback_policy_blocked');
    const receiver = state.music.devices[optical.target];
    if (
      !trust.receiverTrusted ||
      !receiver ||
      receiver.availability !== 'available' ||
      receiver.observedAt === null ||
      !this.freshTimestamp(receiver.observedAt) ||
      !receiver.allowedSources.includes(optical.source)
    )
      return decision('receiver_untrusted');
    if (receiver.observed.source === optical.source) {
      this.suppressAudio(optical.deviceId);
      return decision('already_optical');
    }
    if (
      !['idle', 'paused'].includes(receiver.observed.playback) ||
      Object.keys(receiver.requested).length > 0
    )
      return decision('receiver_busy');
    if (this.options.clock.monotonicNow() - h.audio.since < optical.stabilityMs)
      return decision('stabilizing', 'pending', media.evidence);
    if (h.audio.suppressed) return decision('context_suppressed');
    const existing = [...this.suggestions.values()].some(
      (entry) => entry.contextId === h.audio!.id,
    );
    if (h.audio.emitted && !existing) return decision('context_suppressed');
    if (!existing && this.cooling('optical', optical.cooldownMs))
      return decision('cooldown', 'pending');
    return decision('suggestion_only_no_audibility', 'permitted', [
      ...media.evidence,
      'live_start_transition',
      'stable_context',
      'known_idle_receiver',
      'occupied_and_home',
      'policy_permits',
      'no_manual_hold',
    ]);
  }
  private sceneEligible(state: RoomState, deviceId: string): boolean {
    const h = this.histories.get(deviceId);
    const trust = this.options.getTrust(deviceId, null);
    return Boolean(
      h &&
      !h.invalid &&
      trust.computerTrusted &&
      !trust.quietHours &&
      state.presence.state === 'occupied' &&
      state.presence.home.state === 'home' &&
      !state.intent.holds.some((hold) => hold.scope.startsWith('lighting.')),
    );
  }
  private mappingMatches(
    deviceId: string,
    target: string,
    source: string,
  ): boolean {
    const route = this.options.computerAudio[target];
    return (
      this.deviceIds.has(deviceId) &&
      route?.deviceId === deviceId &&
      route.source === source
    );
  }
  private knownStopped(computer: ComputerObservation): boolean {
    return (
      computer.observed.media !== null &&
      computer.observed.media.every((m) =>
        ['paused', 'stopped'].includes(m.playback),
      )
    );
  }
  private invalidate(history: History, reason: OpticalReason): void {
    history.invalid = reason;
    history.audio = null;
    history.scene = null;
    history.player = null;
    history.armed = false;
    history.stoppedSince = null;
  }
  private suppressAudio(deviceId: string | null): void {
    const context = deviceId ? this.histories.get(deviceId)?.audio : null;
    if (context) {
      context.emitted = true;
      context.suppressed = true;
    }
  }
  private context(): Context {
    return {
      id: `context-${++this.serial}`,
      since: this.options.clock.monotonicNow(),
      sinceWall: this.options.clock.now(),
      emitted: false,
      suppressed: false,
    };
  }
  private cooling(kind: Suggestion['kind'], duration: number): boolean {
    const last = this.lastIssued.get(kind);
    return (
      last !== undefined && this.options.clock.monotonicNow() - last < duration
    );
  }
  private freshTimestamp(timestamp: number): boolean {
    const age = this.options.clock.now() - timestamp;
    return age >= 0 && age < this.maxAge;
  }
  private issue(
    input: Omit<Suggestion, 'id' | 'createdAt' | 'expiresAt'>,
    context: Context,
  ): void {
    const suggestion = {
      ...input,
      id: `suggestion-${this.instanceId}-${++this.serial}`,
      createdAt: this.options.clock.now(),
      expiresAt: this.options.clock.now() + this.ttl,
    };
    context.emitted = true;
    this.lastIssued.set(input.kind, this.options.clock.monotonicNow());
    this.suggestions.set(suggestion.id, {
      suggestion,
      contextId: context.id,
      expiresMono: this.options.clock.monotonicNow() + this.ttl,
    });
  }
  private publish(): void {
    const snapshot = this.snapshot();
    // Wall-clock evaluation alone is not a state change worth publishing over SSE.
    const fingerprint = JSON.stringify({
      ...snapshot,
      optical: snapshot.optical.map((decision) => ({
        ...decision,
        evaluatedAt: 0,
      })),
    });
    if (fingerprint === this.publication) return;
    this.publication = fingerprint;
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(snapshot));
      } catch {
        /* Subscribers cannot interrupt policy maintenance. */
      }
    }
  }
  private assertActive(): void {
    if (this.disposed)
      throw new IntelligenceError(409, 'intelligence_disposed');
  }
}

function activityLabel(activity: string): string {
  return (
    (
      {
        gaming: 'spelaktivitet',
        video: 'videouppspelning',
        music: 'musikuppspelning',
        desktop: 'skrivbordsaktivitet',
        idle: 'inaktivitet',
        unknown: 'okänd aktivitet',
      } as Record<string, string>
    )[activity] ?? 'aktivitet'
  );
}
