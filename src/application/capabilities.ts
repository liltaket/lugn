import { z } from 'zod';
import {
  DeviceLightingStateSchema,
  DeviceSwitchStateSchema,
  DeviceMusicStateSchema,
  SemanticMusicIdSchema,
  MusicCommandStatusSchema,
  LightingValuesSchema,
  ProvenanceSchema,
  RoomStateSchema,
  SemanticSwitchIdSchema,
  SwitchCommandStatusSchema,
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
const GetSwitchInput = z.object({ target: SemanticSwitchIdSchema }).strict();
const SetSwitchInput = z
  .object({ target: SemanticSwitchIdSchema, state: z.boolean() })
  .strict();

const GetMusicInput = z.object({ target: SemanticMusicIdSchema }).strict();
const VolumeMusicInput = z
  .object({ target: SemanticMusicIdSchema, volume: z.number().min(0).max(1) })
  .strict();
const SourceMusicInput = z
  .object({ target: SemanticMusicIdSchema, source: z.string().min(1) })
  .strict();
const MusicCommandOutput = z.object({
  accepted: z.literal(true),
  commandId: z.string(),
  status: MusicCommandStatusSchema,
});

export class CapabilityInputError extends Error {
  constructor(
    readonly code:
      'target_not_configured' | 'source_not_allowed' | 'scene_not_found',
  ) {
    super(code);
    this.name = 'CapabilityInputError';
  }
}

export const CapabilitySchemas = {
  'music.getState': {
    input: GetMusicInput,
    output: z.object({ device: DeviceMusicStateSchema }),
  },
  'music.play': { input: GetMusicInput, output: MusicCommandOutput },
  'music.pause': { input: GetMusicInput, output: MusicCommandOutput },
  'music.setVolume': { input: VolumeMusicInput, output: MusicCommandOutput },
  'music.selectSource': { input: SourceMusicInput, output: MusicCommandOutput },
  'switch.getState': {
    input: GetSwitchInput,
    output: z.object({ device: DeviceSwitchStateSchema }),
  },
  'switch.set': {
    input: SetSwitchInput,
    output: z.object({
      accepted: z.literal(true),
      commandId: z.string(),
      status: SwitchCommandStatusSchema,
    }),
  },
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
      case 'music.getState': {
        const input = GetMusicInput.parse(rawInput);
        output = {
          device: getMusicTarget(this.engine, input.target),
        };
        break;
      }
      case 'music.play':
      case 'music.pause': {
        const input = GetMusicInput.parse(rawInput);
        getMusicTarget(this.engine, input.target);
        const command = await this.engine.requestMusic(
          input.target,
          {
            property: 'playback',
            value: name === 'music.play' ? 'playing' : 'paused',
          },
          provenance,
        );
        output = {
          accepted: true,
          commandId: command.id,
          status: command.status,
        };
        break;
      }
      case 'music.setVolume': {
        const input = VolumeMusicInput.parse(rawInput);
        const command = await this.engine.requestMusic(
          input.target,
          { property: 'volume', value: input.volume },
          provenance,
        );
        output = {
          accepted: true,
          commandId: command.id,
          status: command.status,
        };
        break;
      }
      case 'music.selectSource': {
        const input = SourceMusicInput.parse(rawInput);
        const device = getMusicTarget(this.engine, input.target);
        if (!device.allowedSources.includes(input.source))
          throw new CapabilityInputError('source_not_allowed');
        const command = await this.engine.requestMusic(
          input.target,
          { property: 'source', value: input.source },
          provenance,
        );
        output = {
          accepted: true,
          commandId: command.id,
          status: command.status,
        };
        break;
      }
      case 'switch.getState': {
        const input = GetSwitchInput.parse(rawInput);
        output = {
          device: getSwitchTarget(this.engine, input.target),
        };
        break;
      }
      case 'switch.set': {
        const input = SetSwitchInput.parse(rawInput);
        getSwitchTarget(this.engine, input.target);
        const command = await this.engine.setSwitch(
          input.target,
          input.state,
          provenance,
        );
        output = {
          accepted: true,
          commandId: command.id,
          status: command.status,
        };
        break;
      }
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
        if (!this.engine.scenes.has(input.sceneId))
          throw new CapabilityInputError('scene_not_found');
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
        assertLightingTarget(this.engine, input.target);
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
        assertLightingTarget(this.engine, input.target);
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

function getMusicTarget(engine: LugnEngine, target: string) {
  try {
    return engine.getMusicState(target);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('Unknown semantic music target:')
    )
      throw new CapabilityInputError('target_not_configured');
    throw error;
  }
}

function getSwitchTarget(engine: LugnEngine, target: string) {
  try {
    return engine.getSwitchState(target);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('Unknown semantic switch:')
    )
      throw new CapabilityInputError('target_not_configured');
    throw error;
  }
}

function assertLightingTarget(engine: LugnEngine, target: string): void {
  if (!engine.state.lighting.devices[target])
    throw new CapabilityInputError('target_not_configured');
}
