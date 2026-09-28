import { SceneSchema, type LightingScene } from '../core/schemas.js';

/** Room-wide presets that remain valid for any set of configured light targets. */
export function withRoomPresets(
  scenes: readonly LightingScene[],
  targets: readonly string[],
): LightingScene[] {
  const validatedScenes = scenes.map((scene) => SceneSchema.parse(scene));
  if (targets.length === 0) return validatedScenes;

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
  return [
    ...validatedScenes.filter((scene) => !presetIds.has(scene.id)),
    ...presets.map((scene) => SceneSchema.parse(scene)),
  ];
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
