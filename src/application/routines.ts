import { randomUUID } from 'node:crypto';
import type { Clock, TimerHandle } from '../core/clock.js';
import { isHumanActor } from '../core/automation-holds.js';
import {
  ProvenanceSchema,
  type Provenance,
  type LightingScene,
} from '../core/schemas.js';
import {
  RoutineError,
  RoutineActionSchema,
  RoutineDefinitionSchema,
  nextRoutineOccurrence,
  previewRoutine,
  type RoutineDefinition,
  type RoutineOccurrence,
  type RoutineRun,
  type RoutineSnapshot,
  type RoutineStep,
} from '../core/routines.js';
import type { RoutineStore } from '../runtime/routine-store.js';
import type {
  CapabilityInvocation,
  CapabilityName,
  CapabilityRegistry,
  CapabilityResult,
} from './capabilities.js';
import type { Intervention, LugnEngine } from './lugn-engine.js';

const MAX_LATENESS_MS = 1_000;
const DISPATCH_TIMEOUT_MS = 15_000;
type Work = {
  definition: RoutineDefinition;
  run: RoutineRun;
  provenance: Provenance;
  scheduled: boolean;
  occurrence: RoutineOccurrence | null;
  resources: Set<string>;
  scenes: Map<string, LightingScene>;
  valid: boolean;
  cancelWaits: Set<(error: Error) => void>;
  fades: Map<string, string>;
};
export type RoutineServiceOptions = {
  engine: LugnEngine;
  capabilities: Pick<CapabilityRegistry, 'invoke'>;
  store: RoutineStore;
  /** Requested light command spacing; long fades avoid duplicate rounded levels. */
  fadeIntervalMs?: number;
  onChange?: (snapshot: RoutineSnapshot) => void;
};

/** Optional orchestration. Construction never restores runs or replays overdue occurrences. */
export class RoutineService {
  private readonly active = new Map<string, Work>();
  private readonly history: RoutineRun[] = [];
  private readonly next = new Map<string, RoutineOccurrence>();
  private readonly requests = new Map<string, string>();
  private readonly listeners = new Set<(snapshot: RoutineSnapshot) => void>();
  private readonly unsubscribers: (() => void)[];
  private readonly fadeIntervalMs: number;
  private timer: TimerHandle | undefined;
  private disposed = false;
  private lastWall: number;
  private lastMono: number;
  private highWater: number;
  private definitions: RoutineDefinition[];

  constructor(
    private readonly clock: Clock,
    private readonly options: RoutineServiceOptions,
  ) {
    this.fadeIntervalMs = options.fadeIntervalMs ?? 1_000;
    if (
      !Number.isInteger(this.fadeIntervalMs) ||
      this.fadeIntervalMs < 250 ||
      this.fadeIntervalMs > 30_000
    )
      throw new Error('Invalid routine fade interval');
    this.lastWall = this.highWater = clock.now();
    this.lastMono = clock.monotonicNow();
    this.definitions = options.store.snapshot().definitions;
    this.recompute();
    this.unsubscribers = [
      options.store.subscribe(() => this.definitionsChanged()),
      options.engine.subscribeInterventions((event) => this.intervened(event)),
      options.engine.stream.subscribe(() => this.revalidate()),
    ];
    this.arm();
  }
  snapshot(): RoutineSnapshot {
    return {
      ...this.options.store.snapshot(),
      runs: structuredClone(this.history),
      next: structuredClone(
        [...this.next.values()].sort((a, b) => a.at - b.at),
      ),
    };
  }
  subscribe(listener: (snapshot: RoutineSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  preview(definition: unknown): ReturnType<typeof previewRoutine> {
    return previewRoutine(definition);
  }

  action(input: unknown, rawProvenance: Provenance): RoutineSnapshot {
    if (this.disposed) throw new RoutineError(503, 'routines_disposed');
    const action = RoutineActionSchema.parse(input);
    const provenance = ProvenanceSchema.parse(rawProvenance);
    if (!isHumanActor(provenance.actor))
      throw new RoutineError(403, 'human_actor_required');
    const fingerprint = JSON.stringify({ action, actor: provenance.actor });
    if (action.requestId) {
      const previous = this.requests.get(action.requestId);
      if (previous) {
        if (previous !== fingerprint)
          throw new RoutineError(409, 'routine_request_reused');
        return this.snapshot();
      }
      // Never silently evict an idempotency key and let a retry execute again.
      if (this.requests.size >= 1024)
        throw new RoutineError(429, 'routine_request_capacity');
    }
    const definition = this.definitions.find((d) => d.id === action.id);
    if (!definition) throw new RoutineError(404, 'routine_not_found');
    // Reserve before synchronous publication so a subscriber retry cannot reenter.
    if (action.requestId) this.requests.set(action.requestId, fingerprint);
    try {
      if (action.action === 'start') {
        if (!definition.enabled)
          throw new RoutineError(409, 'routine_disabled');
        this.start(definition, provenance, null);
      } else if (action.action === 'cancel') {
        for (const work of [...this.active.values()])
          if (work.definition.id === definition.id)
            this.finish(work, 'cancelled', 'Cancelled explicitly');
      } else {
        if (!definition.enabled)
          throw new RoutineError(409, 'routine_disabled');
        const running = [...this.active.values()].find(
          (w) => w.definition.id === definition.id && w.occurrence,
        );
        const occurrence = running?.occurrence ?? this.next.get(definition.id);
        if (!occurrence)
          throw new RoutineError(409, 'routine_occurrence_unknown');
        if (running)
          this.finish(
            running,
            'cancelled',
            action.action === 'skip'
              ? 'Occurrence skipped'
              : 'Occurrence snoozed',
          );
        if (action.action === 'snooze')
          this.next.set(definition.id, {
            routineId: definition.id,
            at: this.clock.now() + (action.minutes ?? 10) * 60_000,
          });
        else this.setNext(definition, Math.max(this.highWater, occurrence.at));
      }
    } catch (error) {
      if (action.requestId) this.requests.delete(action.requestId);
      throw error;
    }

    this.publish();
    return this.snapshot();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    for (const work of [...this.active.values()])
      this.finish(work, 'cancelled', 'Service disposed');
    this.listeners.clear();
  }
  private publish(): void {
    if (this.disposed) return;
    const snapshot = this.snapshot();
    // A publication consumer must not affect device orchestration or persistence.
    try {
      this.options.onChange?.(structuredClone(snapshot));
    } catch {
      /* isolated subscriber */
    }
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(snapshot));
      } catch {
        /* isolated subscriber */
      }
    }
  }
  private definitionsChanged(): void {
    const definitions = this.options.store.snapshot().definitions;
    for (const work of [...this.active.values()]) {
      const current = definitions.find((d) => d.id === work.definition.id);
      if (JSON.stringify(current) !== JSON.stringify(work.definition))
        this.finish(work, 'cancelled', 'Definition changed or disabled');
    }
    for (const definition of definitions) {
      if (
        JSON.stringify(definition) !==
        JSON.stringify(this.definitions.find((d) => d.id === definition.id))
      )
        this.setNext(definition, Math.max(this.highWater, this.clock.now()));
    }
    for (const id of this.next.keys())
      if (!definitions.some((d) => d.id === id)) this.next.delete(id);
    this.definitions = definitions;
    this.publish();
  }
  private setNext(definition: RoutineDefinition, after: number): void {
    const next = nextRoutineOccurrence(definition, after);
    if (next) this.next.set(definition.id, next);
    else this.next.delete(definition.id);
  }
  private recompute(): void {
    this.next.clear();
    for (const definition of this.definitions)
      this.setNext(definition, Math.max(this.highWater, this.clock.now()));
  }
  private arm(): void {
    if (this.disposed) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      this.tick();
      this.arm();
    }, 1_000);
  }
  private tick(): void {
    const now = this.clock.now();
    const mono = this.clock.monotonicNow();
    const drift = now - this.lastWall - (mono - this.lastMono);
    this.lastWall = now;
    this.lastMono = mono;
    this.highWater = Math.max(this.highWater, now);
    if (Math.abs(drift) > MAX_LATENESS_MS) {
      for (const work of [...this.active.values()])
        this.finish(work, 'cancelled', 'Clock changed');
      this.recompute();
      this.publish();
      return;
    }
    this.revalidate();
    for (const occurrence of [...this.next.values()]) {
      if (occurrence.at > now) continue;
      const definition = this.definitions.find(
        (d) => d.id === occurrence.routineId,
      );
      if (!definition) continue;
      this.setNext(definition, now);
      if (now - occurrence.at <= MAX_LATENESS_MS) {
        try {
          this.start(
            definition,
            { actor: { type: 'routine', id: definition.id } },
            occurrence,
          );
        } catch {
          /* A conflicting/capacity-limited occurrence is skipped, never queued. */
        }
      }
      this.publish();
    }
  }
  private resources(
    definition: RoutineDefinition,
  ): Pick<Work, 'resources' | 'scenes'> {
    const resources = new Set<string>();
    const scenes = new Map<string, LightingScene>();
    for (const step of definition.steps) {
      if (step.type === 'light')
        for (const target of step.targets) resources.add(target);
      else if (step.type === 'scene') {
        const scene = this.options.engine.scenes.get(step.sceneId);
        if (!scene) throw new RoutineError(400, 'routine_scene_unknown');
        scenes.set(step.sceneId, structuredClone(scene));
        for (const target of Object.keys(scene.lighting)) resources.add(target);
      } else if ('target' in step && step.target) resources.add(step.target);
    }
    for (const resource of resources) {
      if (
        !this.options.engine.state.lighting.devices[resource] &&
        !this.options.engine.state.music.devices[resource]
      )
        throw new RoutineError(400, 'routine_target_unknown');
    }
    return { resources, scenes };
  }
  private scenesCurrent(work: Work): boolean {
    return [...work.scenes].every(
      ([id, captured]) =>
        JSON.stringify(this.options.engine.scenes.get(id)) ===
        JSON.stringify(captured),
    );
  }
  private start(
    input: RoutineDefinition,
    provenance: Provenance,
    occurrence: RoutineOccurrence | null,
  ): void {
    const definition = RoutineDefinitionSchema.parse(input);
    const { resources, scenes } = this.resources(definition);
    for (const work of [...this.active.values()]) {
      if (
        work.definition.id === definition.id ||
        [...resources].some((r) => work.resources.has(r))
      )
        this.finish(work, 'cancelled', 'Replaced by another routine');
    }
    if (this.active.size >= 8)
      throw new RoutineError(429, 'routine_run_capacity');
    const now = this.clock.now();
    const run: RoutineRun = {
      id: randomUUID(),
      routineId: definition.id,
      status: 'running',
      stepIndex: 0,
      startedAt: now,
      updatedAt: now,
      reason: null,
    };
    const work: Work = {
      definition,
      run,
      resources,
      scenes,
      scheduled: occurrence !== null,
      occurrence,
      provenance,
      valid: true,
      cancelWaits: new Set(),
      fades: new Map(),
    };
    this.active.set(run.id, work);
    this.history.push(run);
    while (this.history.length > 100) {
      const index = this.history.findIndex((r) => r.status !== 'running');
      if (index < 0) break;
      this.history.splice(index, 1);
    }
    this.publish();
    // Yield before the first command so the action response and idempotency entry settle.
    void Promise.resolve().then(() => this.execute(work));
  }
  private intervened(event: Intervention): void {
    for (const work of [...this.active.values()]) {
      if (
        event.target
          ? work.resources.has(event.target)
          : [...work.resources].some((r) =>
              r.startsWith(
                event.domain === 'lighting' ? 'lighting.' : 'music.',
              ),
            )
      )
        this.finish(work, 'cancelled', 'Human intervention');
    }
  }
  private revalidate(): void {
    for (const work of [...this.active.values()]) {
      if (!this.scenesCurrent(work)) {
        this.finish(work, 'cancelled', 'Referenced scene changed or deleted');
        continue;
      }
      if (
        work.scheduled &&
        (this.options.engine.state.presence.state !== 'occupied' ||
          this.options.engine.state.presence.home.state === 'away')
      )
        this.finish(work, 'cancelled', 'Scheduled context unavailable');
      for (const [target, id] of work.fades) {
        const fade = this.options.engine.state.music.fades[target];
        if (
          fade?.id === id &&
          ['cancelled', 'interrupted', 'failed'].includes(fade.status)
        )
          this.finish(work, 'cancelled', 'Music fade interrupted');
      }
    }
  }
  private finish(
    work: Work,
    status: RoutineRun['status'],
    reason: string | null,
  ): void {
    if (work.run.status !== 'running') return;
    work.run.status = status;
    work.run.reason = reason;
    work.run.updatedAt = this.clock.now();
    if (status !== 'completed') {
      work.valid = false;
      this.options.engine.cancelExecution(work.run.id);
    }
    this.active.delete(work.run.id);
    for (const cancel of [...work.cancelWaits])
      cancel(new Error(reason ?? status));
    for (const [target, id] of work.fades) {
      if (this.options.engine.state.music.fades[target]?.id === id)
        this.options.engine.cancelMusicFade(target);
    }
    work.fades.clear();
    this.publish();
  }
  private assert(work: Work): void {
    if (work.valid && !this.scenesCurrent(work))
      this.finish(work, 'cancelled', 'Referenced scene changed or deleted');
    if (!work.valid || this.disposed || work.run.status !== 'running')
      throw new Error('Routine cancelled');
    // Detect clock changes before a delayed step can beat the scheduler's heartbeat.
    if (
      Math.abs(
        this.clock.now() -
          this.lastWall -
          (this.clock.monotonicNow() - this.lastMono),
      ) > MAX_LATENESS_MS
    )
      throw new Error('Clock changed');
    if (
      work.scheduled &&
      (this.options.engine.state.presence.state !== 'occupied' ||
        this.options.engine.state.presence.home.state === 'away')
    )
      throw new Error('Scheduled context unavailable');
  }
  private wait<T>(
    work: Work,
    promise: Promise<T> | null,
    timeoutMs: number,
  ): Promise<T | undefined> {
    this.assert(work);
    const due = this.clock.now() + timeoutMs;
    return new Promise<T | undefined>((resolve, reject) => {
      const done = (error?: Error, value?: T) => {
        this.clock.clearTimeout(timer);
        work.cancelWaits.delete(cancel);
        if (error) reject(error);
        else resolve(value);
      };
      const cancel = (error: Error) => done(error);
      const timer = this.clock.setTimeout(() => {
        if (promise) done(new Error('Routine command timed out'));
        else if (this.clock.now() - due > MAX_LATENESS_MS)
          done(new Error('Stale delayed step'));
        else done();
      }, timeoutMs);
      work.cancelWaits.add(cancel);
      promise?.then(
        (value) => done(undefined, value),
        (error) =>
          done(
            error instanceof Error
              ? error
              : new Error('Routine command failed'),
          ),
      );
    }).then((value) => {
      this.assert(work);
      if (this.clock.now() - due > MAX_LATENESS_MS)
        throw new Error('Stale delayed step');
      return value;
    });
  }
  private async invoke<N extends CapabilityName>(
    work: Work,
    name: N,
    input: unknown,
    volume = false,
  ): Promise<CapabilityResult<N>> {
    this.assert(work);
    const target =
      typeof input === 'object' && input !== null && 'target' in input
        ? String(input.target)
        : undefined;
    const guard = () => {
      if (
        !work.valid ||
        !this.scenesCurrent(work) ||
        this.disposed ||
        Math.abs(
          this.clock.now() -
            this.lastWall -
            (this.clock.monotonicNow() - this.lastMono),
        ) > MAX_LATENESS_MS
      )
        return false;
      if (target) {
        const state = this.options.engine.state;
        const device =
          state.lighting.devices[target] ?? state.music.devices[target];
        if (!device || device.availability === 'unavailable') return false;
      }
      if (work.scheduled) {
        const state = this.options.engine.state;
        if (
          state.presence.state !== 'occupied' ||
          state.presence.home.state === 'away'
        )
          return false;
        if (
          target &&
          ['music.play', 'music.selectSource', 'music.playPreset'].includes(
            name,
          ) &&
          !this.options.engine.automaticMusicPlaybackAllowed(target)
        )
          return false;
      }
      return true;
    };
    if (!guard()) throw new Error('Routine action suppressed by policy');
    const provenance: CapabilityInvocation = {
      actor:
        volume || work.scheduled
          ? { type: 'routine', id: work.definition.id }
          : work.provenance.actor,
      source: `routine.${work.definition.id}`,
      requestId: work.run.id,
      reason: work.scheduled ? 'Scheduled routine' : 'Explicit routine start',
    };
    const result = (await this.wait(
      work,
      Promise.resolve().then(() =>
        this.options.capabilities.invoke(name, input, provenance, guard),
      ),
      DISPATCH_TIMEOUT_MS,
    )) as CapabilityResult<N>;
    this.assert(work);
    if (
      typeof result === 'object' &&
      result !== null &&
      'status' in result &&
      ['failed', 'superseded', 'unconfirmed'].includes(String(result.status)) &&
      !this.acceptedSelectorFeedback(work, name, result)
    )
      throw new Error(`Routine command ${result.status}`);
    return result;
  }
  private acceptedSelectorFeedback(
    work: Work,
    name: CapabilityName,
    result: object,
  ): boolean {
    if (
      !['music.selectSource', 'music.playPreset'].includes(name) ||
      !('status' in result) ||
      result.status !== 'superseded' ||
      !('commandId' in result)
    )
      return false;
    const commands = this.options.engine.state.music.commands;
    const index = commands.findIndex(
      (command) => command.id === result.commandId,
    );
    const command = commands[index];
    // Native source feedback invalidates recovery in the playback ordering domain.
    // An accepted selector can still advance; this never claims preset confirmation.
    return (
      command?.acceptedAt !== undefined &&
      command.provenance.requestId === work.run.id &&
      !commands
        .slice(index + 1)
        .some(
          (newer) =>
            newer.target === command.target &&
            newer.requested.property !== 'volume' &&
            newer.provenance.requestId !== work.run.id,
        )
    );
  }
  private async execute(work: Work): Promise<void> {
    try {
      for (let index = 0; index < work.definition.steps.length; index++) {
        this.assert(work);
        work.run.stepIndex = index;
        work.run.updatedAt = this.clock.now();
        this.publish();
        await this.step(work, work.definition.steps[index]!);
      }
      this.assert(work);
      this.finish(work, 'completed', null);
    } catch (error) {
      this.finish(
        work,
        'failed',
        error instanceof Error ? error.message : 'Routine failed',
      );
    }
  }
  private async step(work: Work, step: RoutineStep): Promise<void> {
    switch (step.type) {
      case 'condition': {
        const state = this.options.engine.state;
        const passed =
          step.condition === 'occupied'
            ? state.presence.state === 'occupied'
            : step.condition === 'home'
              ? state.presence.home.state === 'home'
              : ['paused', 'idle', 'off'].includes(
                  state.music.devices[step.target!]?.observed.playback ??
                    'unknown',
                );
        if (!passed) {
          this.finish(work, 'cancelled', `Condition false: ${step.condition}`);
          throw new Error('Condition false');
        }
        return;
      }
      case 'delay':
        if (step.durationMs > 0) await this.wait(work, null, step.durationMs);
        return;
      case 'scene':
        await this.invoke(work, 'lighting.activateScene', {
          sceneId: step.sceneId,
        });
        return;
      case 'light':
        await this.light(work, step);
        return;
      case 'playback':
        await this.invoke(
          work,
          step.state === 'playing' ? 'music.play' : 'music.pause',
          { target: step.target },
        );
        return;
      case 'source':
        await this.invoke(work, 'music.selectSource', {
          target: step.target,
          source: step.source,
        });
        return;
      case 'preset':
        await this.invoke(work, 'music.playPreset', {
          target: step.target,
          preset: step.preset,
        });
        return;
      case 'volume': {
        if (!step.durationMs) {
          await this.invoke(
            work,
            'music.setVolume',
            { target: step.target, volume: step.volume },
            true,
          );
          return;
        }
        const result = await this.invoke(
          work,
          'music.fadeVolume',
          stepToFade(step),
          true,
        );
        work.fades.set(step.target, result.fade.id);
        const deadline =
          this.clock.now() + step.durationMs + DISPATCH_TIMEOUT_MS;
        while (true) {
          this.assert(work);
          const fade = this.options.engine.state.music.fades[step.target];
          if (fade?.id !== result.fade.id)
            throw new Error('Music fade replaced');
          if (fade.status === 'completed') break;
          if (!['active', 'settling'].includes(fade.status))
            throw new Error('Music fade failed');
          if (this.clock.now() >= deadline)
            throw new Error('Music fade timed out');
          await this.wait(work, null, 250);
        }
        work.fades.delete(step.target);
        return;
      }
    }
  }
  private async light(
    work: Work,
    step: Extract<RoutineStep, { type: 'light' }>,
  ): Promise<void> {
    const starts = step.targets.map((target) => {
      const device = this.options.engine.state.lighting.devices[target];
      if (!device || device.availability === 'unavailable')
        throw new Error('Light unavailable');
      const brightness =
        device.observed.power === false ? 0 : device.observed.brightness;
      if (brightness === undefined) throw new Error('Light brightness unknown');
      return { target, brightness };
    });
    const change = Math.max(
      ...starts.map((s) => Math.abs(s.brightness - step.brightness)),
    );
    const count =
      step.durationMs === 0
        ? 1
        : Math.max(
            1,
            Math.min(change, Math.ceil(step.durationMs / this.fadeIntervalMs)),
          );
    const origin = this.clock.now();
    for (let index = 1; index <= count; index++) {
      const due = origin + (step.durationMs * index) / count;
      const remaining = due - this.clock.now();
      if (remaining > 0) await this.wait(work, null, remaining);
      if (this.clock.now() - due > MAX_LATENESS_MS)
        throw new Error('Stale light fade');
      for (const start of starts) {
        const brightness = Math.round(
          start.brightness +
            ((step.brightness - start.brightness) * index) / count,
        );
        await this.invoke(work, 'lighting.set', {
          target: start.target,
          values:
            brightness === 0
              ? { power: false, brightness: 0 }
              : { power: true, brightness },
        });
      }
    }
  }
}
function stepToFade(step: Extract<RoutineStep, { type: 'volume' }>) {
  return {
    target: step.target,
    volume: step.volume,
    durationMs: step.durationMs,
  };
}
