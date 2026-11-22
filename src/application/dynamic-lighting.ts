import type { Rgb } from '../core/artwork-palette.js';
import type { Clock, TimerHandle } from '../core/clock.js';
import { isHumanActor } from '../core/automation-holds.js';
import {
  adaptivePlan,
  planDynamicLighting,
  sameDynamicValues,
  type DynamicComputerInput,
  type DynamicInputs,
  type DynamicLightingConfig,
  type DynamicPlan,
  type DynamicSituation,
} from '../core/dynamic-lighting.js';
import type { Actor, LightingValues, RoomState } from '../core/schemas.js';
import type { LugnEngine } from './lugn-engine.js';

/** Supplies what is playing and the colours of its artwork, without blocking. */
export type PaletteSource = {
  current(state: RoomState): { playing: boolean; palette: readonly Rgb[] };
  subscribe(listener: () => void): () => void;
};

export type DynamicLightingStatus = {
  mode: 'music' | 'adaptive' | null;
  situation: DynamicPlan['situation'] | null;
  reason: string | null;
  evidence: string[];
  /** Lamps a person adjusted by hand; the modes leave them alone. */
  heldByUser: string[];
};

export type DynamicLightingOptions = {
  clock: Clock;
  engine: LugnEngine;
  config: DynamicLightingConfig;
  palette: PaletteSource;
  /** Receives one line each time the controller's decision changes. */
  onDecision?: (message: string) => void;
};

const actor: Actor = { type: 'automation', id: 'lugn.dynamic' };

/**
 * Drives lamps for scenes marked `dynamic`. The engine stays authoritative:
 * every change is an ordinary automatic lighting command, a hand adjustment
 * wins, and leaving a dynamic scene (or having nothing to follow) returns the
 * lamps to the scene's own static definition.
 */
export class DynamicLightingController {
  private readonly applied = new Map<string, LightingValues>();
  private readonly lastSentAt = new Map<string, number>();
  private committed: DynamicPlan | null = null;
  private candidate: {
    situation: DynamicPlan['situation'];
    since: number;
  } | null = null;
  private idleSince: number | null = null;
  private sceneRevision = -1;
  private ownRevisions = new Set<number>();
  private wake: TimerHandle | undefined;
  private running = false;
  private rerun = false;
  private disposed = false;
  private status: DynamicLightingStatus = {
    mode: null,
    situation: null,
    reason: null,
    evidence: [],
    heldByUser: [],
  };
  private readonly unsubscribe: Array<() => void> = [];
  private lastLogged = '';

  constructor(private readonly options: DynamicLightingOptions) {
    this.unsubscribe.push(
      options.engine.stream.subscribe(() => this.observe()),
      options.palette.subscribe(() => this.observe()),
    );
    this.observe();
  }

  snapshot(): DynamicLightingStatus {
    return structuredClone(this.status);
  }

  observe(): void {
    if (this.disposed) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    void this.evaluate()
      .catch(() => undefined)
      .finally(() => {
        this.running = false;
        if (this.rerun && !this.disposed) {
          this.rerun = false;
          this.observe();
        }
      });
  }

  dispose(): void {
    this.disposed = true;
    this.clearWake();
    for (const stop of this.unsubscribe.splice(0)) stop();
  }

  private async evaluate(): Promise<void> {
    const { engine, config, clock } = this.options;
    const state = engine.state;
    const sceneId = state.lighting.currentScene;
    const kind = sceneId ? engine.scenes.get(sceneId)?.dynamic : undefined;
    if (!kind) {
      this.reset();
      return;
    }
    if (state.lighting.sceneRevision !== this.sceneRevision) {
      // A person (or routine) selected a scene: whatever we sent is superseded.
      if (!this.ownRevisions.delete(state.lighting.sceneRevision)) {
        this.applied.clear();
        this.lastSentAt.clear();
        this.committed = null;
        this.candidate = null;
      }
      this.sceneRevision = state.lighting.sceneRevision;
    }

    const music = this.options.palette.current(state);
    const inputs: DynamicInputs = {
      roomOccupied:
        state.presence.state === 'occupied' &&
        state.presence.home.state !== 'away',
      computer: this.computerInput(state),
      palette: music.palette,
      musicPlaying: music.playing,
    };
    const raw = planDynamicLighting(kind, inputs, config);

    const now = clock.monotonicNow();
    let plan = raw;
    // Only the adaptive mode settles: a new situation must hold for a few
    // seconds before lamps follow it, so a quick alt-tab never flashes the room.
    if (kind === 'adaptive') {
      if (
        !this.committed ||
        raw.situation === 'inactive' ||
        raw.situation === this.committed.situation
      ) {
        this.committed = raw;
        this.candidate = null;
      } else {
        if (this.candidate?.situation !== raw.situation)
          this.candidate = { situation: raw.situation, since: now };
        if (now - this.candidate.since >= config.settleMs) {
          this.committed = raw;
          this.candidate = null;
        } else {
          // Keep the committed situation, with the current inputs, meanwhile.
          plan =
            this.committed.situation === 'inactive'
              ? this.committed
              : adaptivePlan(
                  this.committed.situation as DynamicSituation,
                  this.committed.reason,
                  this.committed.evidence,
                  inputs,
                  config,
                );
          this.armWake(this.candidate.since + config.settleMs - now);
        }
      }
    }
    this.armIdleWake(inputs.computer, now);

    this.status = {
      mode: kind,
      situation: plan.situation,
      reason: plan.reason,
      evidence: plan.evidence,
      heldByUser: this.status.heldByUser,
    };
    this.log(kind, plan);
    await this.apply(plan, sceneId!, state.lighting.sceneRevision);
  }

  private async apply(
    plan: DynamicPlan,
    sceneId: string,
    revision: number,
  ): Promise<void> {
    const { engine, clock, config } = this.options;
    const state = engine.state;
    const held: string[] = [];
    const entries = Object.entries(plan.targets);

    if (plan.situation === 'inactive') {
      // The room engine owns an empty room. Forget what was sent so the next
      // entry sends the current look again, rather than assuming it survived.
      this.applied.clear();
      return;
    }

    if (entries.length > 0 && entries.every(([, v]) => v === 'release')) {
      // Nothing to follow: return to the scene's own look, once.
      if (this.applied.size === 0) return;
      this.applied.clear();
      this.lastSentAt.clear();
      try {
        const next = await engine.reapplyScene(actor, 'dynamic-lighting');
        this.ownRevisions.add(next);
        this.sceneRevision = next;
      } catch {
        // The room engine may refuse (empty room, hold); retry on next change.
      }
      this.status.heldByUser = [];
      return;
    }

    for (const [target, wanted] of entries) {
      if (this.disposed) return;
      if (wanted === 'release') continue;
      const device = state.lighting.devices[target];
      if (!device || device.availability === 'unavailable') continue;
      if (device.externalControl || isHeldByUser(device)) {
        if (isHeldByUser(device)) held.push(target);
        continue;
      }
      if (sameDynamicValues(this.applied.get(target), wanted)) continue;
      const since =
        clock.monotonicNow() - (this.lastSentAt.get(target) ?? -Infinity);
      if (since < config.minChangeIntervalMs) {
        this.armWake(config.minChangeIntervalMs - since);
        continue;
      }
      this.lastSentAt.set(target, clock.monotonicNow());
      try {
        // Target scope: one lamp's white must not retune the rest of the scene.
        await engine.setLighting(
          target,
          wanted,
          {
            actor,
            source: 'dynamic-lighting',
            reason: `Dynamic lighting: ${plan.reason}`,
          },
          undefined,
          'target',
        );
        this.applied.set(target, wanted);
      } catch {
        // Held or unavailable lamps keep their state; the next change retries.
      }
      // A person or scene change during the await supersedes the rest.
      if (
        engine.state.lighting.sceneRevision !== revision ||
        engine.state.lighting.currentScene !== sceneId
      ) {
        this.rerun = true;
        return;
      }
    }
    this.status.heldByUser = held;
  }

  private computerInput(state: RoomState): DynamicComputerInput | null {
    const { clock, config } = this.options;
    const devices = state.computer.devices;
    const id = config.computerDeviceId ?? Object.keys(devices)[0];
    const observation = id ? devices[id] : undefined;
    if (
      !observation ||
      observation.availability !== 'online' ||
      observation.freshness !== 'fresh' ||
      observation.reason !== 'live'
    ) {
      this.idleSince = null;
      return null;
    }
    const idle = observation.observed.idle;
    if (idle === true) this.idleSince ??= clock.monotonicNow();
    else this.idleSince = null;
    return {
      locked: observation.observed.locked,
      idle,
      fullscreen: observation.observed.fullscreen,
      activity: observation.activity.classification,
      idleForMs:
        this.idleSince === null ? null : clock.monotonicNow() - this.idleSince,
    };
  }

  private armIdleWake(
    computer: DynamicComputerInput | null,
    now: number,
  ): void {
    if (!computer || computer.idle !== true || computer.idleForMs === null)
      return;
    const remaining = this.options.config.idleAfterMs - computer.idleForMs;
    if (remaining > 0) this.armWake(remaining + 50);
    void now;
  }

  private armWake(delayMs: number): void {
    this.clearWake();
    this.wake = this.options.clock.setTimeout(
      () => {
        this.wake = undefined;
        this.observe();
      },
      Math.max(50, Math.ceil(delayMs)),
    );
  }

  private clearWake(): void {
    if (this.wake !== undefined) this.options.clock.clearTimeout(this.wake);
    this.wake = undefined;
  }

  private reset(): void {
    if (this.status.mode === null && this.applied.size === 0) return;
    this.clearWake();
    this.applied.clear();
    this.lastSentAt.clear();
    this.committed = null;
    this.candidate = null;
    this.idleSince = null;
    this.sceneRevision = -1;
    this.ownRevisions.clear();
    this.lastLogged = '';
    this.status = {
      mode: null,
      situation: null,
      reason: null,
      evidence: [],
      heldByUser: [],
    };
  }

  private log(kind: string, plan: DynamicPlan): void {
    const line = `dynamic lighting (${kind}): ${plan.situation} — ${plan.reason}`;
    if (line === this.lastLogged) return;
    this.lastLogged = line;
    this.options.onDecision?.(line);
  }
}

function isHeldByUser(
  device: RoomState['lighting']['devices'][string],
): boolean {
  return Object.values(device.ownership).some(
    (entry) => entry?.kind === 'override' && isHumanActor(entry.actor),
  );
}
