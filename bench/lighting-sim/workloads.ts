import type { FaultState } from './mock-home-assistant.js';
import { mulberry32 } from './random.js';

export type WorkloadStep =
  | {
      at: number;
      kind: 'mqtt';
      topic: 'snapshot' | 'availability' | 'preview';
      text: string;
      retain?: boolean;
      extraDelayMs?: number;
    }
  | {
      at: number;
      kind: 'manual';
      entity: string;
      values: Record<string, unknown>;
    }
  | { at: number; kind: 'scene'; sceneId: string }
  | { at: number; kind: 'faults'; faults: Partial<FaultState> }
  | { at: number; kind: 'ws-drop' }
  | { at: number; kind: 'broker'; connected: boolean }
  | { at: number; kind: 'sun'; elevation: number }
  /** Settled checkpoint for differential correctness comparison. */
  | { at: number; kind: 'checkpoint'; episode: number; label: string };

export type Workload = {
  name: string;
  seed: number;
  steps: WorkloadStep[];
  endAt: number;
  episodes: Array<{ index: number; kind: EpisodeKind; startAt: number }>;
};

export type EpisodeKind =
  | 'entry_preview'
  | 'entry_direct'
  | 'false_preview'
  | 'bounce'
  | 'second_person'
  | 'preview_storm'
  | 'sensor_flap'
  | 'manual_override'
  | 'scene_change'
  | 'ha_ws_drop'
  | 'broker_reconnect'
  | 'out_of_order'
  | 'feedback_stall'
  | 'rest_errors';

export type WorkloadOptions = {
  name: string;
  seed: number;
  episodes: number;
  /** Relative episode weights; unspecified kinds use 0. */
  mix: Partial<Record<EpisodeKind, number>>;
  /** Sensor heartbeat interval for snapshots (live config tolerates 7 s). */
  heartbeatMs?: number;
};

/** Training mix: ordinary days dominated by entries/exits. */
export const trainingMix: Partial<Record<EpisodeKind, number>> = {
  entry_preview: 34,
  entry_direct: 8,
  false_preview: 8,
  bounce: 6,
  second_person: 8,
  preview_storm: 4,
  sensor_flap: 4,
  manual_override: 10,
  scene_change: 8,
  ha_ws_drop: 3,
  rest_errors: 3,
  out_of_order: 2,
  feedback_stall: 2,
};

/** Held-out mix: more storms, reorderings and transport faults. */
export const testMix: Partial<Record<EpisodeKind, number>> = {
  entry_preview: 22,
  entry_direct: 10,
  false_preview: 6,
  bounce: 10,
  second_person: 6,
  preview_storm: 8,
  sensor_flap: 6,
  manual_override: 10,
  scene_change: 6,
  ha_ws_drop: 6,
  broker_reconnect: 4,
  rest_errors: 6,
  out_of_order: 8,
  feedback_stall: 6,
};

const manualTargets = [
  'light.h6022',
  'light.h600d',
  'light.h612f',
  'light.yeelight_lamp15_0x305a74b9',
  'light.cleverio_lb100',
];

/**
 * Generates a reproducible event timeline. Times are monotonic SimClock ms.
 * The sensor keeps publishing non-retained heartbeats like the STL27L, so the
 * adapter's deduplication and freshness logic stays on the measured path.
 */
export function generateWorkload(options: WorkloadOptions): Workload {
  const random = mulberry32(options.seed);
  const heartbeatMs = options.heartbeatMs ?? 2_000;
  const steps: WorkloadStep[] = [];
  const episodes: Workload['episodes'] = [];
  const between = (min: number, max: number): number =>
    Math.round(min + (max - min) * random());
  let count = 0;
  let sensorOnline = true;
  let t = 1_000;
  let lastHeartbeat = 0;
  const snapshot = (at: number, next: number, quality = 'CERTAIN'): void => {
    count = next;
    // Heartbeats repeat the newest explicit count and never precede it.
    lastHeartbeat = Math.max(lastHeartbeat, at);
    steps.push({
      at,
      kind: 'mqtt',
      topic: 'snapshot',
      text: JSON.stringify({
        schema_version: 1,
        count: next,
        quality,
        confidence: quality === 'CERTAIN' ? 0.97 : 0.4,
        updated_at: new Date(
          Date.parse('2026-11-09T14:00:00+01:00') + at,
        ).toISOString(),
      }),
    });
  };
  const preview = (at: number, on: boolean): void => {
    steps.push({ at, kind: 'mqtt', topic: 'preview', text: on ? 'ON' : 'OFF' });
  };
  const heartbeatsUntil = (until: number): void => {
    for (let at = lastHeartbeat + heartbeatMs; at < until; at += heartbeatMs)
      if (sensorOnline) snapshot(at, count);
  };

  steps.push({ at: 0, kind: 'sun', elevation: -8 });
  steps.push({
    at: 10,
    kind: 'mqtt',
    topic: 'availability',
    text: 'online',
    retain: true,
  });
  snapshot(20, 0);
  lastHeartbeat = 20;

  const kinds = Object.entries(options.mix).filter(
    ([, weight]) => (weight ?? 0) > 0,
  ) as Array<[EpisodeKind, number]>;
  const totalWeight = kinds.reduce((sum, [, weight]) => sum + weight, 0);
  const pickKind = (): EpisodeKind => {
    let pick = random() * totalWeight;
    for (const [kind, weight] of kinds) {
      pick -= weight;
      if (pick <= 0) return kind;
    }
    return kinds.at(-1)![0];
  };

  const enter = (at: number, withPreview: boolean): number => {
    if (withPreview) {
      preview(at, true);
      const confirmAt = at + between(350, 1_600);
      snapshot(confirmAt, 1);
      preview(confirmAt + between(150, 600), false);
      return confirmAt + 800;
    }
    snapshot(at, 1);
    return at + 200;
  };
  const exit = (at: number): number => {
    preview(at, true);
    snapshot(at + between(300, 900), 0);
    preview(at + between(1_000, 1_400), false);
    return at + 1_500;
  };

  for (let index = 0; index < options.episodes; index += 1) {
    const kind = pickKind();
    // Mostly short gaps; some longer than the 20-minute continuity window.
    t +=
      random() < 0.7
        ? between(15_000, 150_000)
        : between(21 * 60_000, 45 * 60_000);
    heartbeatsUntil(t);
    const start = t;
    episodes.push({ index, kind, startAt: start });
    let cursor = start;
    const occupiedDwell = (): number => between(8_000, 120_000);
    switch (kind) {
      case 'entry_preview':
      case 'entry_direct': {
        cursor = enter(cursor, kind === 'entry_preview');
        cursor += occupiedDwell();
        heartbeatsUntil(cursor);
        cursor = exit(cursor);
        break;
      }
      case 'false_preview': {
        preview(cursor, true);
        preview(cursor + between(300, 2_500), false);
        cursor += 9_000;
        break;
      }
      case 'bounce': {
        cursor = enter(cursor, true);
        cursor += between(1_500, 5_000);
        cursor = exit(cursor);
        break;
      }
      case 'second_person': {
        cursor = enter(cursor, true) + between(3_000, 20_000);
        heartbeatsUntil(cursor);
        preview(cursor, true);
        snapshot(cursor + 600, 2);
        preview(cursor + 900, false);
        cursor += between(10_000, 40_000);
        heartbeatsUntil(cursor);
        preview(cursor, true);
        snapshot(cursor + 500, 1);
        preview(cursor + 900, false);
        cursor += between(5_000, 30_000);
        heartbeatsUntil(cursor);
        cursor = exit(cursor);
        break;
      }
      case 'preview_storm': {
        for (let toggle = 0; toggle < 12; toggle += 1)
          preview(cursor + toggle * between(40, 140), toggle % 2 === 0);
        cursor += 2_000;
        cursor = enter(cursor, true) + between(5_000, 20_000);
        heartbeatsUntil(cursor);
        for (let burst = 0; burst < 30; burst += 1)
          snapshot(cursor + burst * 7, 1);
        cursor += 1_000;
        cursor = exit(cursor);
        break;
      }
      case 'sensor_flap': {
        cursor = enter(cursor, true) + between(4_000, 20_000);
        heartbeatsUntil(cursor);
        sensorOnline = false;
        steps.push({
          at: cursor,
          kind: 'mqtt',
          topic: 'availability',
          text: 'offline',
          retain: true,
        });
        cursor += between(2_000, 15_000);
        sensorOnline = true;
        steps.push({
          at: cursor,
          kind: 'mqtt',
          topic: 'availability',
          text: 'online',
          retain: true,
        });
        snapshot(cursor + 50, 1);
        cursor += between(5_000, 30_000);
        heartbeatsUntil(cursor);
        cursor = exit(cursor);
        break;
      }
      case 'manual_override': {
        cursor = enter(cursor, true) + between(4_000, 15_000);
        heartbeatsUntil(cursor);
        const entity =
          manualTargets[Math.floor(random() * manualTargets.length)]!;
        steps.push({
          at: cursor,
          kind: 'manual',
          entity,
          values:
            random() < 0.5
              ? { state: 'off' }
              : { state: 'on', brightness_pct: between(5, 95) },
        });
        cursor += between(10_000, 60_000);
        heartbeatsUntil(cursor);
        cursor = exit(cursor);
        cursor += between(5_000, 60_000);
        heartbeatsUntil(cursor);
        // Return within continuity: the override must still be respected.
        cursor = enter(cursor, true) + between(8_000, 30_000);
        heartbeatsUntil(cursor);
        cursor = exit(cursor);
        break;
      }
      case 'scene_change': {
        cursor = enter(cursor, true) + between(3_000, 15_000);
        heartbeatsUntil(cursor);
        steps.push({ at: cursor, kind: 'scene', sceneId: 'scene.party' });
        cursor += between(8_000, 40_000);
        heartbeatsUntil(cursor);
        steps.push({
          at: cursor,
          kind: 'scene',
          sceneId: random() < 0.5 ? 'scene.soft_light' : 'scene.everyday_light',
        });
        cursor += between(5_000, 20_000);
        heartbeatsUntil(cursor);
        cursor = exit(cursor);
        break;
      }
      case 'ha_ws_drop': {
        preview(cursor, true);
        steps.push({ at: cursor + between(5, 120), kind: 'ws-drop' });
        snapshot(cursor + between(400, 1_200), 1);
        preview(cursor + 1_500, false);
        cursor += between(10_000, 40_000);
        heartbeatsUntil(cursor);
        cursor = exit(cursor);
        break;
      }
      case 'broker_reconnect': {
        cursor = enter(cursor, true) + between(5_000, 20_000);
        heartbeatsUntil(cursor);
        steps.push({ at: cursor, kind: 'broker', connected: false });
        cursor += between(1_000, 6_000);
        steps.push({ at: cursor, kind: 'broker', connected: true });
        snapshot(cursor + 30, 1);
        cursor += between(5_000, 20_000);
        heartbeatsUntil(cursor);
        cursor = exit(cursor);
        break;
      }
      case 'out_of_order': {
        steps.push({
          at: cursor - 10,
          kind: 'faults',
          faults: { staleReplayRate: 0.5 },
        });
        // The confirming snapshot overtakes the preview edge.
        preview(cursor, true);
        snapshot(cursor + 20, 1);
        steps.push({
          at: cursor + 5,
          kind: 'mqtt',
          topic: 'preview',
          text: 'OFF',
          extraDelayMs: 0,
        });
        cursor += between(10_000, 30_000);
        heartbeatsUntil(cursor);
        cursor = exit(cursor);
        steps.push({
          at: cursor + 5_000,
          kind: 'faults',
          faults: { staleReplayRate: 0 },
        });
        break;
      }
      case 'feedback_stall': {
        steps.push({
          at: cursor - 10,
          kind: 'faults',
          faults: { extraFeedbackDelayMs: between(1_500, 6_000) },
        });
        cursor = enter(cursor, true) + between(10_000, 30_000);
        heartbeatsUntil(cursor);
        cursor = exit(cursor);
        steps.push({
          at: cursor + 8_000,
          kind: 'faults',
          faults: { extraFeedbackDelayMs: 0 },
        });
        break;
      }
      case 'rest_errors': {
        steps.push({
          at: cursor - 10,
          kind: 'faults',
          faults: { restServerErrorRate: 0.4 },
        });
        cursor = enter(cursor, true) + between(10_000, 30_000);
        heartbeatsUntil(cursor);
        cursor = exit(cursor);
        steps.push({
          at: cursor + 8_000,
          kind: 'faults',
          faults: { restServerErrorRate: 0 },
        });
        break;
      }
    }
    t = Math.max(cursor, t);
    heartbeatsUntil(t);
    // Checkpoint after the episode has had time to retry and settle.
    t += 12_000;
    heartbeatsUntil(t);
    steps.push({ at: t, kind: 'checkpoint', episode: index, label: kind });
  }
  steps.sort((a, b) => a.at - b.at);
  return {
    name: options.name,
    seed: options.seed,
    steps,
    endAt: t + 5_000,
    episodes,
  };
}
