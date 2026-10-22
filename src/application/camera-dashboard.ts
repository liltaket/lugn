import { randomUUID } from 'node:crypto';
import type { Clock, TimerHandle } from '../core/clock.js';
import {
  CameraDashboardConfigSchema,
  CameraError,
  CameraSettingsSchema,
  type CameraActiveView,
  type CameraDashboardConfig,
  type CameraDashboardSnapshot,
  type CameraSettings,
  type CameraViewer,
  type CameraTrigger,
} from '../core/cameras.js';
import type { CameraSettingsStore } from '../runtime/camera-settings-store.js';

const viewers: CameraViewer[] = ['bed', 'desk', 'web'];
const cooldownMs = 60_000;
const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const known = (state: unknown): state is string =>
  typeof state === 'string' && state !== 'unknown' && state !== 'unavailable';

/** Presentation intent only: HA events are observed passively; no device commands. */
export class CameraDashboardService {
  private readonly config: CameraDashboardConfig;
  private connected = false;
  private disposed = false;
  private readonly available = new Set<string>();
  private readonly baselines = new Map<string, string>();
  private readonly observedAt = new Map<string, number>();
  private readonly active = new Map<CameraViewer, CameraActiveView>();
  private readonly timers = new Map<CameraViewer, TimerHandle>();
  private readonly blockedUntil = new Map<CameraViewer, number>();
  private readonly seen = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;

  constructor(
    config: CameraDashboardConfig,
    private readonly store: CameraSettingsStore,
    private readonly clock: Clock,
  ) {
    this.config = CameraDashboardConfigSchema.parse(config);
    this.unsubscribe = store.subscribe(() => {
      // An opt-out or target change takes effect before the new state is published.
      this.clearViews();
      this.notify();
    });
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  snapshot(viewer: CameraViewer): CameraDashboardSnapshot {
    const document = this.store.snapshot();
    const settings = this.settings();
    return {
      generation: document.generation,
      settings,
      definitions: this.config.cameras.map((camera) => ({
        id: camera.id,
        name: camera.name,
        enabled: settings.cameras[camera.id] === true,
        available: this.connected && this.available.has(camera.id),
      })),
      triggers: this.config.triggers.map((trigger) => ({
        id: trigger.id,
        name: trigger.name,
        cameraId: trigger.cameraId,
        kind: trigger.kind,
        enabled: settings.triggers[trigger.id] === true,
      })),
      active: structuredClone(this.active.get(viewer) ?? null),
    };
  }
  show(viewer: CameraViewer, cameraId: string): CameraDashboardSnapshot {
    const camera = this.config.cameras.find((item) => item.id === cameraId);
    if (!camera) throw new CameraError(404, 'camera_not_found');
    if (this.disposed || !this.allowed(viewer, cameraId))
      throw new CameraError(409, 'camera_unavailable_or_disabled');
    this.activate(viewer, cameraId, 'Manuell visning', true);
    this.notify();
    return this.snapshot(viewer);
  }
  dismiss(viewer: CameraViewer): CameraDashboardSnapshot {
    this.clearView(viewer);
    this.blockedUntil.set(viewer, this.clock.monotonicNow() + cooldownMs);
    this.notify();
    return this.snapshot(viewer);
  }
  async updateSettings(
    input: unknown,
    expectedGeneration: string,
  ): Promise<CameraDashboardSnapshot> {
    const settings = CameraSettingsSchema.parse(input);
    if (
      Object.keys(settings.cameras).some(
        (id) => !this.config.cameras.some((camera) => camera.id === id),
      ) ||
      Object.keys(settings.triggers).some(
        (id) => !this.config.triggers.some((trigger) => trigger.id === id),
      )
    )
      throw new CameraError(400, 'unknown_camera_configuration');
    await this.store.save(settings, expectedGeneration);
    return this.snapshot('web');
  }
  setConnected(connected: boolean): void {
    if (this.disposed || this.connected === connected) return;
    this.connected = connected;
    this.available.clear();
    this.baselines.clear();
    this.observedAt.clear();
    this.seen.clear();
    this.clearViews();
    this.notify();
  }
  seedStates(states: unknown[]): void {
    if (!this.connected || this.disposed) return;
    this.baselines.clear();
    this.observedAt.clear();
    this.available.clear();
    for (const raw of states) {
      const state = object(raw);
      if (state && typeof state['entity_id'] === 'string')
        this.observeState(state['entity_id'], state['state'], this.clock.now());
    }
    for (const [viewer, view] of this.active)
      if (!this.available.has(view.cameraId)) this.clearView(viewer);
    this.notify();
  }
  acceptEvent(raw: unknown): void {
    if (!this.connected || this.disposed) return;
    const event = object(raw);
    const data = object(event?.['data']);
    if (!event || !data || typeof event['time_fired'] !== 'string') return;
    const time = Date.parse(event['time_fired']);
    if (
      !Number.isFinite(time) ||
      this.clock.now() - time > 10_000 ||
      time - this.clock.now() > 5_000
    )
      return;
    const type = event['event_type'];
    const entityId = data['entity_id'];
    const oldState = object(data['old_state']);
    const newState = object(data['new_state']);
    const previous =
      typeof entityId === 'string' ? this.baselines.get(entityId) : undefined;
    if (type === 'state_changed' && typeof entityId === 'string') {
      if (time < (this.observedAt.get(entityId) ?? -Infinity)) return;
      const camera = this.config.cameras.find(
        (item) => item.entityId === entityId,
      );
      const wasAvailable =
        camera !== undefined && this.available.has(camera.id);
      this.observeState(entityId, newState?.['state'], time);
      for (const [viewer, view] of this.active)
        if (!this.available.has(view.cameraId)) this.clearView(viewer);
      if (camera && wasAvailable !== this.available.has(camera.id))
        this.notify();
    }
    const settings = this.settings();
    if (!settings.enabled || !settings.automaticEnabled) return;
    for (const trigger of this.config.triggers) {
      if (!settings.triggers[trigger.id]) continue;
      let matches = false;
      if (trigger.kind === 'state') {
        matches =
          type === 'state_changed' &&
          entityId === trigger.entityId &&
          previous === trigger.from &&
          oldState?.['state'] === trigger.from &&
          newState?.['state'] === trigger.to;
      } else if (trigger.kind === 'automation') {
        matches =
          type === 'automation_triggered' && entityId === trigger.entityId;
      } else {
        matches = type === 'call_service' && this.matchesService(trigger, data);
      }
      if (!matches) continue;
      const context = object(event['context']);
      const contextId =
        typeof context?.['id'] === 'string' ? context['id'].slice(0, 128) : '';
      const key = `${trigger.id}:${event['time_fired']}:${contextId}`;
      const now = this.clock.monotonicNow();
      for (const [seenKey, at] of this.seen)
        if (now - at > cooldownMs) this.seen.delete(seenKey);
      if (this.seen.has(key)) continue;
      this.seen.set(key, now);
      if (this.seen.size > 256)
        this.seen.delete(this.seen.keys().next().value!);
      let changed = false;
      for (const viewer of viewers) {
        if (
          !this.allowed(viewer, trigger.cameraId) ||
          this.active.has(viewer) ||
          now < (this.blockedUntil.get(viewer) ?? 0)
        )
          continue;
        this.activate(viewer, trigger.cameraId, trigger.name, false);
        this.blockedUntil.set(viewer, now + cooldownMs);
        changed = true;
      }
      if (changed) this.notify();
    }
  }
  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.clearViews();
    this.listeners.clear();
  }
  private settings(): CameraSettings {
    const saved = this.store.snapshot().settings;
    // Removed definitions cannot reappear in the public snapshot or gain permission.
    return {
      ...saved,
      cameras: Object.fromEntries(
        this.config.cameras.map((camera) => [
          camera.id,
          saved.cameras[camera.id] === true,
        ]),
      ),
      triggers: Object.fromEntries(
        this.config.triggers.map((trigger) => [
          trigger.id,
          saved.triggers[trigger.id] === true,
        ]),
      ),
    };
  }
  private allowed(viewer: CameraViewer, cameraId: string): boolean {
    const settings = this.settings();
    return (
      this.connected &&
      settings.enabled &&
      settings.viewers.includes(viewer) &&
      settings.cameras[cameraId] === true &&
      this.available.has(cameraId)
    );
  }
  private observeState(entityId: string, value: unknown, time: number): void {
    if (
      !this.config.cameras.some((camera) => camera.entityId === entityId) &&
      !this.config.triggers.some(
        (trigger) => trigger.kind === 'state' && trigger.entityId === entityId,
      )
    )
      return;
    this.observedAt.set(entityId, time);
    if (known(value)) this.baselines.set(entityId, value);
    else this.baselines.delete(entityId);
    const camera = this.config.cameras.find(
      (item) => item.entityId === entityId,
    );
    if (camera) {
      if (known(value)) this.available.add(camera.id);
      else this.available.delete(camera.id);
    }
  }
  private matchesService(
    trigger: Extract<CameraTrigger, { kind: 'service' }>,
    data: Record<string, unknown>,
  ): boolean {
    const service = object(data['service_data']);
    const target = object(data['target']);
    const ids = service?.['entity_id'] ?? target?.['entity_id'];
    return (
      data['domain'] === trigger.domain &&
      data['service'] === trigger.service &&
      service?.['media_content_id'] === trigger.mediaContentId &&
      (ids === trigger.entityId ||
        (Array.isArray(ids) && ids.includes(trigger.entityId)))
    );
  }
  private activate(
    viewer: CameraViewer,
    cameraId: string,
    reason: string,
    manual: boolean,
  ): void {
    this.clearView(viewer);
    const camera = this.config.cameras.find((item) => item.id === cameraId)!;
    const durationMs = this.settings().durationSeconds * 1000;
    const view = {
      id: randomUUID(),
      cameraId,
      name: camera.name,
      reason,
      expiresAt: this.clock.now() + durationMs,
      manual,
    };
    this.active.set(viewer, view);
    this.timers.set(
      viewer,
      this.clock.setTimeout(() => {
        if (this.active.get(viewer)?.id !== view.id) return;
        this.clearView(viewer);
        this.notify();
      }, durationMs),
    );
  }
  private clearView(viewer: CameraViewer): void {
    const timer = this.timers.get(viewer);
    if (timer !== undefined) this.clock.clearTimeout(timer);
    this.timers.delete(viewer);
    this.active.delete(viewer);
  }
  private clearViews(): void {
    for (const viewer of viewers) this.clearView(viewer);
  }
  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* A subscriber cannot interrupt privacy controls. */
      }
    }
  }
}
