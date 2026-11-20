import { z } from 'zod';
import type { CapabilityInvocation } from './capabilities.js';
import type { OpticalSwitchSettingsService } from './optical-switch-settings-service.js';
import {
  ExperienceRequestError,
  type ExperienceApi,
  type ExperienceRoute,
} from './experience-api.js';
import { ComputerDeviceIdSchema } from '../core/computer.js';
import {
  OpticalSwitchSettingsError,
  OpticalSwitchSettingsSchema,
} from '../core/optical-switch-settings.js';
import type { ComputerOpticalAgentStatus } from '../adapters/computer-optical-mqtt.js';

const SettingsRequest = z
  .object({
    deviceId: ComputerDeviceIdSchema,
    /** null returns the computer to its configured defaults. */
    settings: OpticalSwitchSettingsSchema.nullable(),
    expectedGeneration: z.uuid(),
  })
  .strict();

/** What the API needs from the transport that talks to a computer's agent. */
export interface OpticalAgentSource {
  status(): ComputerOpticalAgentStatus;
  subscribe(listener: () => void): () => void;
}

/** Adds the optical switch settings and the agents' reports to the panel's experience API. */
export class OpticalSwitchApi implements ExperienceApi {
  constructor(
    private readonly base: ExperienceApi,
    private readonly settings: OpticalSwitchSettingsService,
    private readonly agents: ReadonlyMap<string, OpticalAgentSource>,
  ) {}

  snapshot(): ReturnType<ExperienceApi['snapshot']> {
    return {
      ...this.base.snapshot(),
      opticalSwitch: {
        ...this.settings.snapshot(),
        agents: Object.fromEntries(
          [...this.agents].map(([deviceId, agent]) => [
            deviceId,
            agent.status(),
          ]),
        ),
      },
    };
  }

  subscribe(listener: () => void): () => void {
    const unsubscribers = [
      this.base.subscribe(listener),
      this.settings.subscribe(listener),
      ...[...this.agents.values()].map((agent) => agent.subscribe(listener)),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }

  async request(
    route: ExperienceRoute,
    body: unknown,
    invocation: CapabilityInvocation,
  ): Promise<unknown> {
    if (route !== 'optical/settings')
      return this.base.request(route, body, invocation);
    try {
      const input = SettingsRequest.parse(body);
      await this.settings.update(
        input.deviceId,
        input.settings,
        input.expectedGeneration,
      );
      return this.snapshot().opticalSwitch;
    } catch (error) {
      if (error instanceof OpticalSwitchSettingsError)
        throw new ExperienceRequestError(error.status, error.code);
      throw error;
    }
  }
}
