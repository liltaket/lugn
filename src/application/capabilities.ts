import { z } from 'zod';
import type { HomeAssistantButtonAdapter } from '../adapters/home-assistant-button.js';
import {
  SensorConfigChangesSchema,
  SensorConfigDocumentSchema,
  SensorRejectedError,
  type Stl27lPresenceControlAdapter,
} from '../adapters/stl27l-presence-control.js';
import {
  DeviceLightingStateSchema,
  DeviceSwitchStateSchema,
  DeviceMusicStateSchema,
  MusicFadeRequestSchema,
  MusicFadeStateSchema,
  SemanticButtonIdSchema,
  SemanticMusicIdSchema,
  MusicCommandStatusSchema,
  MusicVolumeChangeSchema,
  MusicDecisionSchema,
  MusicPresetSchema,
  LightingValuesSchema,
  ProvenanceSchema,
  RoomStateSchema,
  SemanticSwitchIdSchema,
  SwitchCommandStatusSchema,
} from '../core/schemas.js';
import type { ActorSchema } from '../core/schemas.js';
import {
  ChimeKindSchema,
  ChimeStyleSchema,
  defaultPresenceFeedbackSettings,
  PresenceFeedbackSettingsSchema,
} from '../core/presence-feedback.js';
import type { PresenceFeedback } from './presence-feedback.js';
import type { ExecutionGuard, LugnEngine } from './lugn-engine.js';
import {
  MusicFadeDurationError,
  MusicFadeUnavailableError,
} from './music-controller.js';
import {
  MusicVolumePolicySnapshotSchema,
  VolumeAuthorityRequestSchema,
  VolumeAuthorityError,
  MusicPlaybackPolicySnapshotSchema,
} from './music-automation.js';

const EmptyInput = z.object({});
const ActivateSceneInput = z.object({ sceneId: z.string() });
const SetLightingInput = z.object({
  target: z.string(),
  values: LightingValuesSchema,
  /** Explicit routine targets must not expand through scene temperature synchronization. */
  temperatureScope: z.enum(['target', 'scene']).optional(),
});
const AdjustInput = z.object({
  target: z.string(),
  brightnessDelta: z.number().int(),
});
const GetSwitchInput = z.object({ target: SemanticSwitchIdSchema }).strict();
const SetSwitchInput = z
  .object({ target: SemanticSwitchIdSchema, state: z.boolean() })
  .strict();
const PressButtonInput = z.object({ target: SemanticButtonIdSchema }).strict();

const GetMusicInput = z.object({ target: SemanticMusicIdSchema }).strict();
const VolumeMusicInput = z
  .object({ target: SemanticMusicIdSchema, volume: z.number().min(0).max(1) })
  .strict();
const FadeMusicInput = MusicFadeRequestSchema;
const SourceMusicInput = z
  .object({ target: SemanticMusicIdSchema, source: z.string().min(1) })
  .strict();
const PresetMusicInput = z
  .object({ target: SemanticMusicIdSchema, preset: MusicPresetSchema })
  .strict();
const MusicCommandOutput = z.object({
  accepted: z.literal(true),
  commandId: z.string(),
  status: MusicCommandStatusSchema,
});

export class CapabilityInputError extends Error {
  constructor(
    readonly code:
      | 'target_not_configured'
      | 'source_not_allowed'
      | 'scene_not_found'
      | 'music_state_unavailable'
      | 'music_fade_duration_too_short'
      | 'volume_unavailable'
      | 'volume_pending'
      | 'fade_active'
      | 'sensor_rejected_change'
      | 'presence_feedback_unavailable'
      | 'presence_feedback_save_failed'
      | 'chime_unavailable'
      | 'human_actor_required',
  ) {
    super(code);
    this.name = 'CapabilityInputError';
  }
}

export const CapabilitySchemas = {
  'music.setVolumeAuthority': {
    input: VolumeAuthorityRequestSchema,
    output: z.object({
      accepted: z.literal(true),
      policy: MusicVolumePolicySnapshotSchema,
    }),
  },
  'music.getPolicy': {
    input: GetMusicInput,
    output: z.object({
      volume: MusicVolumePolicySnapshotSchema,
      playback: MusicPlaybackPolicySnapshotSchema,
      lastVolumeChange: MusicVolumeChangeSchema.nullable(),
      decisions: z.array(MusicDecisionSchema).max(128),
    }),
  },
  'presence.setCountOne': {
    input: z.object({}).strict(),
    output: z.object({ accepted: z.literal(true), count: z.literal(1) }),
  },
  'presence.setCount': {
    input: z.object({ count: z.number().int().min(0).max(10) }).strict(),
    output: z.object({ accepted: z.literal(true), count: z.number() }),
  },
  'presence.recalibrate': {
    input: z.object({}).strict(),
    output: z.object({ accepted: z.literal(true) }),
  },
  'presence.getSensorConfig': {
    input: z.object({}).strict(),
    output: SensorConfigDocumentSchema,
  },
  'presence.updateSensorConfig': {
    input: z.object({ changes: SensorConfigChangesSchema }).strict(),
    output: SensorConfigDocumentSchema.extend({
      accepted: z.literal(true),
      backgroundReset: z.boolean(),
    }),
  },
  'presence.getFeedbackSettings': {
    input: z.object({}).strict(),
    output: z.object({
      settings: PresenceFeedbackSettingsSchema,
      defaults: PresenceFeedbackSettingsSchema,
    }),
  },
  'presence.updateFeedbackSettings': {
    input: z.object({ settings: PresenceFeedbackSettingsSchema }).strict(),
    output: z.object({ settings: PresenceFeedbackSettingsSchema }),
  },
  'presence.testChime': {
    input: z
      .object({
        kind: ChimeKindSchema,
        /** Lets the page audition an unsaved volume or style. */
        volume: z.number().min(0).max(1).optional(),
        style: ChimeStyleSchema.optional(),
      })
      .strict(),
    output: z.object({ played: z.literal(true) }),
  },
  'music.getState': {
    input: GetMusicInput,
    output: z.object({ device: DeviceMusicStateSchema }),
  },
  'music.play': { input: GetMusicInput, output: MusicCommandOutput },
  'music.pause': { input: GetMusicInput, output: MusicCommandOutput },
  'music.setVolume': { input: VolumeMusicInput, output: MusicCommandOutput },
  'music.fadeVolume': {
    input: FadeMusicInput,
    output: z.object({
      accepted: z.literal(true),
      fade: MusicFadeStateSchema,
    }),
  },
  'music.cancelFade': {
    input: GetMusicInput,
    output: z.object({
      cancelled: z.boolean(),
      fade: MusicFadeStateSchema.nullable(),
    }),
  },
  'music.selectSource': { input: SourceMusicInput, output: MusicCommandOutput },
  'music.playPreset': { input: PresetMusicInput, output: MusicCommandOutput },
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
  'button.press': {
    input: PressButtonInput,
    output: z.object({ accepted: z.literal(true) }),
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
  constructor(
    private readonly engine: LugnEngine,
    private readonly adapters: {
      buttonAdapter?: HomeAssistantButtonAdapter;
      presenceCountAdapter?: Stl27lPresenceControlAdapter;
      presenceFeedback?: PresenceFeedback;
    } = {},
  ) {}

  private async sensorCall<T>(
    call: (adapter: Stl27lPresenceControlAdapter) => Promise<T>,
  ): Promise<T> {
    const adapter = this.adapters.presenceCountAdapter;
    if (!adapter) throw new CapabilityInputError('target_not_configured');
    try {
      return await call(adapter);
    } catch (error) {
      if (error instanceof SensorRejectedError)
        throw new CapabilityInputError('sensor_rejected_change');
      throw error;
    }
  }

  private feedback(): PresenceFeedback {
    const feedback = this.adapters.presenceFeedback;
    if (!feedback)
      throw new CapabilityInputError('presence_feedback_unavailable');
    return feedback;
  }

  async invoke<Name extends CapabilityName>(
    name: Name,
    rawInput: unknown,
    invocation: CapabilityInvocation,
    isCurrent?: ExecutionGuard,
  ): Promise<CapabilityResult<Name>> {
    if (isCurrent && !isCurrent())
      throw new Error('Capability execution cancelled');
    const provenance = ProvenanceSchema.parse(invocation);
    let output: unknown;
    switch (name) {
      case 'music.setVolumeAuthority': {
        const input = VolumeAuthorityRequestSchema.parse(rawInput);
        getMusicTarget(this.engine, input.target);
        try {
          output = {
            accepted: true,
            policy: this.engine.setMusicVolumeAuthority(input, provenance),
          };
        } catch (error) {
          if (error instanceof VolumeAuthorityError)
            throw new CapabilityInputError(error.code);
          throw error;
        }
        break;
      }
      case 'music.getPolicy': {
        const input = GetMusicInput.parse(rawInput);
        getMusicTarget(this.engine, input.target);
        output = this.engine.getMusicPolicySnapshot(input.target);
        break;
      }
      case 'presence.setCountOne': {
        CapabilitySchemas[name].input.parse(rawInput);
        const adapter = this.adapters.presenceCountAdapter;
        if (!adapter) throw new CapabilityInputError('target_not_configured');
        await adapter.setCountOne();
        output = { accepted: true, count: 1 };
        break;
      }
      case 'presence.setCount': {
        const input =
          CapabilitySchemas['presence.setCount'].input.parse(rawInput);
        await this.sensorCall((adapter) => adapter.setCount(input.count));
        output = { accepted: true, count: input.count };
        break;
      }
      case 'presence.recalibrate': {
        CapabilitySchemas[name].input.parse(rawInput);
        await this.sensorCall((adapter) => adapter.recalibrate());
        output = { accepted: true };
        break;
      }
      case 'presence.getSensorConfig': {
        CapabilitySchemas[name].input.parse(rawInput);
        output = await this.sensorCall((adapter) => adapter.getConfig());
        break;
      }
      case 'presence.updateSensorConfig': {
        const input =
          CapabilitySchemas['presence.updateSensorConfig'].input.parse(
            rawInput,
          );
        output = {
          accepted: true,
          ...(await this.sensorCall((adapter) =>
            adapter.updateConfig(input.changes),
          )),
        };
        break;
      }
      case 'presence.getFeedbackSettings': {
        CapabilitySchemas[name].input.parse(rawInput);
        output = {
          settings: this.feedback().getSettings(),
          defaults: structuredClone(defaultPresenceFeedbackSettings),
        };
        break;
      }
      case 'presence.updateFeedbackSettings': {
        const input =
          CapabilitySchemas['presence.updateFeedbackSettings'].input.parse(
            rawInput,
          );
        try {
          output = {
            settings: await this.feedback().updateSettings(input.settings),
          };
        } catch {
          throw new CapabilityInputError('presence_feedback_save_failed');
        }
        break;
      }
      case 'presence.testChime': {
        const input =
          CapabilitySchemas['presence.testChime'].input.parse(rawInput);
        const feedback = this.feedback();
        try {
          await feedback.testChime(input.kind, {
            ...(input.volume === undefined ? {} : { volume: input.volume }),
            ...(input.style === undefined ? {} : { style: input.style }),
          });
        } catch {
          throw new CapabilityInputError('chime_unavailable');
        }
        output = { played: true };
        break;
      }
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
          isCurrent,
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
          isCurrent,
        );
        output = {
          accepted: true,
          commandId: command.id,
          status: command.status,
        };
        break;
      }
      case 'music.fadeVolume': {
        const input = FadeMusicInput.parse(rawInput);
        getMusicTarget(this.engine, input.target);
        try {
          const fade = this.engine.startMusicFade(input, provenance, isCurrent);
          output = { accepted: true, fade };
        } catch (error) {
          if (error instanceof MusicFadeUnavailableError)
            throw new CapabilityInputError('music_state_unavailable');
          if (error instanceof MusicFadeDurationError)
            throw new CapabilityInputError('music_fade_duration_too_short');
          throw error;
        }
        break;
      }
      case 'music.cancelFade': {
        const input = GetMusicInput.parse(rawInput);
        getMusicTarget(this.engine, input.target);
        const before = this.engine.state.music.fades[input.target];
        const cancelled =
          before?.status === 'active' || before?.status === 'settling';
        const fade = this.engine.cancelMusicFade(input.target, provenance);
        output = { cancelled, fade };
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
          isCurrent,
        );
        output = {
          accepted: true,
          commandId: command.id,
          status: command.status,
        };
        break;
      }
      case 'music.playPreset': {
        const input = PresetMusicInput.parse(rawInput);
        getMusicTarget(this.engine, input.target);
        const command = await this.engine.requestMusic(
          input.target,
          { property: 'preset', value: input.preset },
          provenance,
          isCurrent,
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
      case 'button.press': {
        const input = PressButtonInput.parse(rawInput);
        const adapter = this.adapters.buttonAdapter;
        if (!adapter?.hasTarget(input.target))
          throw new CapabilityInputError('target_not_configured');
        await adapter.press(input.target);
        output = { accepted: true };
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
            isCurrent,
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
            isCurrent,
          ),
        };
        break;
      case 'lighting.set': {
        const input = SetLightingInput.parse(rawInput);
        assertLightingTarget(this.engine, input.target);
        await this.engine.setLighting(
          input.target,
          input.values,
          {
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
          },
          isCurrent,
          input.temperatureScope,
        );
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
            isCurrent,
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
