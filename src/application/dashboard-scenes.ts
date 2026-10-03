import { SceneSchema, type LightingScene } from '../core/schemas.js';

const ROOM_CCT_MIN_KELVIN = 2700;
const ROOM_CCT_MAX_KELVIN = 6500;

/** Room-wide presets that remain valid for any set of configured light targets. */
export function withRoomPresets(
  scenes: readonly LightingScene[],
  targets: readonly string[],
): LightingScene[] {
  const validatedScenes = scenes.map((scene) => SceneSchema.parse(scene));
  if (targets.length === 0) return normalizeRoomScenes(validatedScenes);

  const ceilingTarget = findCeilingTarget(targets);

  const presets: LightingScene[] = [
    {
      id: 'scene.all_off',
      name: 'Helt släckt',
      lighting: valuesFor(targets, { power: false }),
    },
    {
      id: 'scene.everyday_light',
      name: 'Vardagsljus',
      lighting: accentLighting(targets, ceilingTarget, 55, 2700),
    },
    {
      id: 'scene.soft_light',
      name: 'Mysljus',
      lighting: accentLighting(targets, ceilingTarget, 12, 2200),
    },
    {
      id: 'scene.focus_light',
      name: 'Fokus',
      lighting: focusLighting(targets),
    },
    {
      id: 'scene.movie_light',
      name: 'Filmkväll',
      lighting: movieLighting(targets, ceilingTarget),
    },
  ];

  const presetIds = new Set([
    'scene.everyday',
    ...presets.map((scene) => scene.id),
  ]);
  return normalizeRoomScenes([
    ...validatedScenes.filter((scene) => !presetIds.has(scene.id)),
    ...presets.map((scene) => SceneSchema.parse(scene)),
  ]);
}

/**
 * Keeps active lights in the installed room's shared CCT range and lifts WLED.
 */
function normalizeRoomScenes(
  scenes: readonly LightingScene[],
): LightingScene[] {
  return scenes.map((scene) => {
    if (scene.id === 'scene.all_off') return scene;
    const cct = mostCommonSceneColorTemperature(scene);
    const lighting = Object.fromEntries(
      Object.entries(scene.lighting).map(([target, values]) => {
        const next = { ...values };
        if (values.power !== false && cct !== undefined)
          next.colorTemperature = cct;
        if (values.power !== false && target.toLowerCase().includes('wled'))
          next.brightness = Math.min(100, (values.brightness ?? 12) + 6);
        return [target, next];
      }),
    );
    return SceneSchema.parse({ ...scene, lighting });
  });
}

function mostCommonSceneColorTemperature(
  scene: LightingScene,
): number | undefined {
  const counts = new Map<number, number>();
  for (const values of Object.values(scene.lighting)) {
    if (values.power === false || values.colorTemperature === undefined)
      continue;
    counts.set(
      values.colorTemperature,
      (counts.get(values.colorTemperature) ?? 0) + 1,
    );
  }

  let selected: number | undefined;
  let highestCount = 0;
  for (const [temperature, count] of counts) {
    if (count > highestCount) {
      selected = temperature;
      highestCount = count;
    }
  }
  return selected === undefined
    ? undefined
    : Math.min(ROOM_CCT_MAX_KELVIN, Math.max(ROOM_CCT_MIN_KELVIN, selected));
}

/** Maps the retired `scene.everyday` id to its current room preset. */
export function resolveRoomDefaultSceneId(
  configuredSceneId: string | undefined,
  scenes: readonly LightingScene[],
): string | undefined {
  if (configuredSceneId === undefined) return undefined;
  if (scenes.some((scene) => scene.id === configuredSceneId))
    return configuredSceneId;
  if (
    configuredSceneId === 'scene.everyday' &&
    scenes.some((scene) => scene.id === 'scene.everyday_light')
  )
    return 'scene.everyday_light';
  return undefined;
}

function findCeilingTarget(targets: readonly string[]): string | undefined {
  const candidates = targets.filter((target) =>
    target.toLowerCase().split(/[._-]/).includes('ceiling'),
  );

  return (
    candidates.find((target) => target.toLowerCase() === 'lighting.ceiling') ??
    candidates.find((target) => /(?:^|[._-])ceiling$/i.test(target)) ??
    candidates[0]
  );
}

function focusLighting(targets: readonly string[]): LightingScene['lighting'] {
  return Object.fromEntries(
    targets.map((target) => [
      target,
      { power: true, brightness: 100, colorTemperature: 4000 },
    ]),
  );
}

function movieLighting(
  targets: readonly string[],
  ceilingTarget: string | undefined,
): LightingScene['lighting'] {
  return Object.fromEntries(
    targets.map((target) => [
      target,
      target === ceilingTarget || isMonitorFrontOrBar(target)
        ? { power: false, brightness: 0 }
        : { power: true, brightness: 6, colorTemperature: 2200 },
    ]),
  );
}

function isMonitorFrontOrBar(target: string): boolean {
  const normalized = target.toLowerCase().replaceAll('-', '_');
  return (
    normalized.includes('cleverio_bar') ||
    normalized.includes('monitor_front') ||
    normalized.includes('monitor_lightbar') ||
    normalized.includes('monitor_light_bar')
  );
}

function accentLighting(
  targets: readonly string[],
  ceilingTarget: string | undefined,
  brightness: number,
  colorTemperature: number,
): LightingScene['lighting'] {
  return Object.fromEntries(
    targets.map((target) => [
      target,
      target === ceilingTarget
        ? { power: false, brightness: 0 }
        : { power: true, brightness, colorTemperature },
    ]),
  );
}

function valuesFor(
  targets: readonly string[],
  values: LightingScene['lighting'][string],
): LightingScene['lighting'] {
  return Object.fromEntries(targets.map((target) => [target, { ...values }]));
}
