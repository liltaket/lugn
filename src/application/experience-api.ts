import type { CapabilityInvocation } from './capabilities.js';

export const experienceRoutes = [
  'routines/save',
  'routines/delete',
  'routines/action',
  'routines/preview',
  'intelligence/settings',
  'intelligence/suggestion',
] as const;
export type ExperienceRoute = (typeof experienceRoutes)[number];

/** Transport boundary: implementations validate bodies before changing intent. */
export interface ExperienceApi {
  snapshot(): { routines?: unknown; intelligence?: unknown };
  request(
    route: ExperienceRoute,
    body: unknown,
    invocation: CapabilityInvocation,
  ): Promise<unknown>;
  subscribe(listener: () => void): () => void;
}

export class ExperienceRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
