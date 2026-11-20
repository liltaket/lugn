import { z } from 'zod';
import type { CapabilityInvocation } from './capabilities.js';
import type { DisplayPowerSettingsService } from './display-power-settings-service.js';
import {
  ExperienceRequestError,
  type ExperienceApi,
  type ExperienceRoute,
} from './experience-api.js';
import { ComputerDeviceIdSchema } from '../core/computer.js';
import {
  DisplayPowerSettingsError,
  DisplayPowerSettingsSchema,
} from '../core/display-power-settings.js';

const SettingsRequest = z
  .object({
    deviceId: ComputerDeviceIdSchema,
    /** null returns the computer to its configured defaults. */
    settings: DisplayPowerSettingsSchema.nullable(),
    expectedGeneration: z.uuid(),
  })
  .strict();

/** Adds the display power settings to the panel's experience API. */
export class DisplayPowerApi implements ExperienceApi {
  constructor(
    private readonly base: ExperienceApi,
    private readonly settings: DisplayPowerSettingsService,
  ) {}

  snapshot(): ReturnType<ExperienceApi['snapshot']> {
    return { ...this.base.snapshot(), displayPower: this.settings.snapshot() };
  }

  subscribe(listener: () => void): () => void {
    const unsubscribeBase = this.base.subscribe(listener);
    const unsubscribeSettings = this.settings.subscribe(listener);
    return () => {
      unsubscribeBase();
      unsubscribeSettings();
    };
  }

  async request(
    route: ExperienceRoute,
    body: unknown,
    invocation: CapabilityInvocation,
  ): Promise<unknown> {
    if (route !== 'display/settings')
      return this.base.request(route, body, invocation);
    try {
      const input = SettingsRequest.parse(body);
      return await this.settings.update(
        input.deviceId,
        input.settings,
        input.expectedGeneration,
      );
    } catch (error) {
      if (error instanceof DisplayPowerSettingsError)
        throw new ExperienceRequestError(error.status, error.code);
      throw error;
    }
  }
}
