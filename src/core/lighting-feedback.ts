import type { LightingProperty, LightingValues } from './schemas.js';

/** Readback allows 1% Kelvin error and two RGB levels for HS/XY rounding. */
export function lightingFeedbackMatches(
  property: LightingProperty,
  desired: LightingValues[LightingProperty],
  observed: LightingValues[LightingProperty],
): boolean {
  if (desired === undefined || observed === undefined) return false;
  if (property === 'rgb')
    return (
      Array.isArray(desired) &&
      Array.isArray(observed) &&
      desired.every(
        (channel, index) => Math.abs(channel - observed[index]!) <= 2,
      )
    );
  if (property !== 'colorTemperature') return desired === observed;
  return (
    typeof desired === 'number' &&
    typeof observed === 'number' &&
    Number.isFinite(desired) &&
    Number.isFinite(observed) &&
    desired > 0 &&
    Math.abs(observed - desired) * 100 <= desired
  );
}

/** Color modes replace each other; partial power/brightness updates retain color. */
export function mergeLightingValues(
  current: LightingValues,
  update: LightingValues,
): LightingValues {
  const next = { ...current, ...update };
  if (update.rgb !== undefined) delete next.colorTemperature;
  if (update.colorTemperature !== undefined) delete next.rgb;
  return next;
}

/** Intent equality is exact, including Kelvin; RGB compares tuple contents. */
export function lightingIntentMatches(
  property: LightingProperty,
  left: LightingValues[LightingProperty],
  right: LightingValues[LightingProperty],
): boolean {
  return property === 'rgb'
    ? Array.isArray(left) &&
        Array.isArray(right) &&
        left.every((channel, index) => channel === right[index])
    : left === right;
}

/** ON/level writes must explicitly preserve the selected color mode in HA. */
export function withLightingColor(
  update: LightingValues,
  current: LightingValues,
): LightingValues {
  if (
    update.power === false ||
    (update.power !== true && update.brightness === undefined)
  )
    return update;
  const color: LightingValues =
    current.rgb !== undefined
      ? { rgb: current.rgb }
      : current.colorTemperature !== undefined
        ? { colorTemperature: current.colorTemperature }
        : {};
  return mergeLightingValues(color, update);
}
