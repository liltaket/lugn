import { z } from 'zod';
import type { CapabilityInvocation } from '../application/capabilities.js';
import {
  ExperienceRequestError,
  type ExperienceApi,
  type ExperienceRoute,
} from '../application/experience-api.js';
import type { RoutineService } from '../application/routines.js';
import { RoutineDefinitionSchema } from '../core/routines.js';
import { RoutineError, type RoutineStore } from './routine-store.js';

const SaveRoutineSchema = z
  .object({
    definition: RoutineDefinitionSchema,
    expectedGeneration: z.uuid(),
  })
  .strict();
const DeleteRoutineSchema = z
  .object({
    id: RoutineDefinitionSchema.shape.id,
    expectedGeneration: z.uuid(),
  })
  .strict();
const PreviewRoutineSchema = z
  .object({ definition: RoutineDefinitionSchema })
  .strict();

/** Adds orchestration to authenticated transports without a second device-control path. */
export class RoutineApi implements ExperienceApi {
  constructor(
    private readonly routines: RoutineService,
    private readonly store: RoutineStore,
  ) {}

  snapshot(): ReturnType<ExperienceApi['snapshot']> {
    return { routines: this.routines.snapshot() };
  }

  subscribe(listener: () => void): () => void {
    return this.routines.subscribe(listener);
  }

  async request(
    route: ExperienceRoute,
    body: unknown,
    invocation: CapabilityInvocation,
  ): Promise<unknown> {
    try {
      switch (route) {
        case 'routines/bedtime':
          return await this.routines.bedtimeAction(body, invocation);
        case 'routines/save': {
          const input = SaveRoutineSchema.parse(body);
          if (
            input.definition.bedtime ||
            this.store
              .snapshot()
              .definitions.find((d) => d.id === input.definition.id)?.bedtime
          )
            throw new RoutineError(409, 'bedtime_definition_owned');
          await this.store.save(input.definition, input.expectedGeneration);
          return this.routines.snapshot();
        }
        case 'routines/delete': {
          const input = DeleteRoutineSchema.parse(body);
          if (
            this.store.snapshot().definitions.find((d) => d.id === input.id)
              ?.bedtime
          )
            throw new RoutineError(409, 'bedtime_definition_owned');
          await this.store.delete(input.id, input.expectedGeneration);
          return this.routines.snapshot();
        }
        case 'routines/action':
          return this.routines.action(body, invocation);
        case 'routines/preview':
          return this.routines.preview(
            PreviewRoutineSchema.parse(body).definition,
          );
        default:
          throw new ExperienceRequestError(503, 'intelligence_unavailable');
      }
    } catch (error) {
      if (error instanceof RoutineError)
        throw new ExperienceRequestError(error.status, error.code);
      throw error;
    }
  }
}
