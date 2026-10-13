import type { LightingProperty, LightingValues } from './schemas.js';

/** Compare readback with intent; Kelvin allows an inclusive 1% device error. */
export function lightingFeedbackMatches(
  property: LightingProperty,
  desired: LightingValues[LightingProperty],
  observed: LightingValues[LightingProperty],
): boolean {
  if (desired === undefined || observed === undefined) return false;
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
