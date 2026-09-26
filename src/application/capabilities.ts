import { z } from 'zod';
import {
  DeviceLightingStateSchema,
  LightingValuesSchema,
  ProvenanceSchema,
  RoomStateSchema,
} from '../core/schemas.js';
import type { ActorSchema } from '../core/schemas.js';
import type { LugnEngine } from './lugn-engine.js';

const EmptyInput = z.object({});
const ActivateSceneInput = z.object({ sceneId: z.string() });
const SetLightingInput = z.object({
  target: z.string(),
  values: LightingValuesSchema,
});
const AdjustInput = z.object({
  target: z.string(),
  brightnessDelta: z.number().int(),
});

export const CapabilitySchemas = {
  'room.getState': {
    input: EmptyInput,
    output: z.object({ state: RoomStateSchema }),
  },
  'lighting.getState': {
    input: EmptyInput,
    output: z.object({
      lighting: z.object({
        currentScene: z.string().nullable(),
        sceneRevision: z.number().int().nonnegative(),
        devices: z.record(z.string(), DeviceLightingStateSchema),
      }),
    }),
  },
  'lighting.activateScene': {
    input: ActivateSceneInput,
    output: z.object({ sceneRevision: z.number().int().nonnegative() }),
  },
  'lighting.reapplyScene': {
    input: EmptyInput,
    output: z.object({ sceneRevision: z.number().int().nonnegative() }),
  },
  'lighting.set': {
    input: SetLightingInput,
    output: z.object({ accepted: z.literal(true) }),
  },
  'lighting.adjust': {
    input: AdjustInput,
    output: z.object({ brightness: z.number().int().min(0).max(100) }),
  },
} as const;

export type CapabilityName = keyof typeof CapabilitySchemas;
export type CapabilityResult<Name extends CapabilityName> = z.infer<
  (typeof CapabilitySchemas)[Name]['output']
>;

export type CapabilityInvocation = {
  actor: z.infer<typeof ActorSchema>;
  source?: string;
  requestId?: string;
  reason?: string;
};

export class CapabilityRegistry {
  constructor(private readonly engine: LugnEngine) {}

  async invoke<Name extends CapabilityName>(
    name: Name,
    rawInput: unknown,
    invocation: CapabilityInvocation,
  ): Promise<CapabilityResult<Name>> {
    const provenance = ProvenanceSchema.parse(invocation);
    let output: unknown;
    switch (name) {
      case 'room.getState':
        CapabilitySchemas[name].input.parse(rawInput);
        output = { state: structuredClone(this.engine.state) };
        break;
      case 'lighting.getState':
        CapabilitySchemas[name].input.parse(rawInput);
        output = { lighting: structuredClone(this.engine.state.lighting) };
        break;
      case 'lighting.activateScene': {
        const input = ActivateSceneInput.parse(rawInput);
        output = {
          sceneRevision: await this.engine.activateScene(
            input.sceneId,
            provenance.actor,
            provenance.source,
            provenance.requestId,
          ),
        };
        break;
      }
      case 'lighting.reapplyScene':
        CapabilitySchemas[name].input.parse(rawInput);
        output = {
          sceneRevision: await this.engine.reapplyScene(
            provenance.actor,
            provenance.source,
            provenance.requestId,
          ),
        };
        break;
      case 'lighting.set': {
        const input = SetLightingInput.parse(rawInput);
        await this.engine.setLighting(input.target, input.values, {
          actor: provenance.actor,
          ...(provenance.source === undefined
            ? {}
            : { source: provenance.source }),
          ...(provenance.reason === undefined
            ? {}
            : { reason: provenance.reason }),
          ...(provenance.requestId === undefined
            ? {}
            : { requestId: provenance.requestId }),
        });
        output = { accepted: true };
        break;
      }
      case 'lighting.adjust': {
        const input = AdjustInput.parse(rawInput);
        output = {
          brightness: await this.engine.adjustBrightness(
            input.target,
            input.brightnessDelta,
            provenance.actor,
            provenance.source,
            provenance.requestId,
          ),
        };
        break;
      }
    }
    return CapabilitySchemas[name].output.parse(
      output,
    ) as CapabilityResult<Name>;
  }
}
