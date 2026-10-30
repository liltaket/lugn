import { z } from 'zod';
import type { CapabilityInvocation } from '../application/capabilities.js';
import type { ComputerIntelligenceService } from '../application/computer-intelligence.js';
import {
  ExperienceRequestError,
  type ExperienceApi,
  type ExperienceRoute,
} from '../application/experience-api.js';
import {
  IntelligenceError,
  IntelligenceSettingsSchema,
} from '../core/intelligence.js';

const SettingsRequest = z
  .object({
    settings: IntelligenceSettingsSchema,
    expectedGeneration: z.uuid(),
  })
  .strict();
const SuggestionRequest = z
  .object({
    id: z.string().min(1).max(512),
    action: z.enum(['accept', 'reject', 'dismiss']),
  })
  .strict();

/** Composes optional context with the routine API; observations remain ordinary room state. */
export class IntelligenceApi implements ExperienceApi {
  constructor(
    private readonly base: ExperienceApi,
    private readonly intelligence: ComputerIntelligenceService,
  ) {}
  snapshot(): ReturnType<ExperienceApi['snapshot']> {
    return {
      ...this.base.snapshot(),
      intelligence: this.intelligence.snapshot(),
    };
  }
  subscribe(listener: () => void): () => void {
    const unsubscribeBase = this.base.subscribe(listener);
    const unsubscribeIntelligence = this.intelligence.subscribe(listener);
    return () => {
      unsubscribeBase();
      unsubscribeIntelligence();
    };
  }
  async request(
    route: ExperienceRoute,
    body: unknown,
    invocation: CapabilityInvocation,
  ): Promise<unknown> {
    try {
      if (route === 'intelligence/settings') {
        const input = SettingsRequest.parse(body);
        return await this.intelligence.updateSettings(
          input.settings,
          input.expectedGeneration,
        );
      }
      if (route === 'intelligence/suggestion') {
        const input = SuggestionRequest.parse(body);
        return await this.intelligence.respondSuggestion(
          input.id,
          input.action,
          invocation,
        );
      }
      return await this.base.request(route, body, invocation);
    } catch (error) {
      if (error instanceof IntelligenceError)
        throw new ExperienceRequestError(error.status, error.code);
      throw error;
    }
  }
}
