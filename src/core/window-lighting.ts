import { z } from 'zod';
import { SemanticLightingIdSchema } from './schemas.js';

/** An outward-facing light still takes its colour from the room scene. */
export const WindowLightingSchema = z
  .object({
    target: SemanticLightingIdSchema,
    presenceMode: z.enum(['room', 'home', 'always']).default('home'),
    brightness: z.number().int().min(1).max(100).default(55),
    maxSunElevation: z.number().min(-18).max(30).default(0),
  })
  .strict();
export type WindowLighting = z.infer<typeof WindowLightingSchema>;
