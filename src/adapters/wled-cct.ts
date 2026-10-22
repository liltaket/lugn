import { z } from 'zod';
import type { Clock } from '../core/clock.js';
import { SemanticLightingIdSchema } from '../core/schemas.js';
import {
  LightingDeliveryUnknownError,
  type LightingCommand,
  type LightingObservation,
} from './simulated-lighting.js';

const WledCctDeviceSchema = z
  .object({
    baseUrl: z
      .string()
      .url()
      .superRefine((value, context) => {
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          return;
        }
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          url.pathname !== '/'
        )
          context.addIssue({
            code: 'custom',
            message:
              'WLED baseUrl must be a bare HTTP or HTTPS origin without credentials',
          });
      }),
    segmentId: z.number().int().min(0).max(255).default(0),
  })
  .strict();

export const WledCctMappingsSchema = z
  .record(SemanticLightingIdSchema, WledCctDeviceSchema)
  .superRefine((devices, context) => {
    const origins = new Set<string>();
    for (const [target, device] of Object.entries(devices)) {
      if (!URL.canParse(device.baseUrl)) continue;
      const origin = new URL(device.baseUrl).origin;
      if (origins.has(origin))
        context.addIssue({
          code: 'custom',
          path: [target],
          message: 'Each dedicated WLED device must have one semantic target',
        });
      origins.add(origin);
    }
  });

const ByteSchema = z.number().int().min(0).max(255);
const WledStateSchema = z.object({
  on: z.boolean(),
  bri: ByteSchema,
  seg: z.array(
    z.object({
      id: z.number().int(),
      lc: z.number().int().nonnegative(),
      on: z.boolean(),
      bri: ByteSchema,
      cct: ByteSchema,
      col: z.array(z.tuple([ByteSchema, ByteSchema, ByteSchema, ByteSchema])),
    }),
  ),
});

/** Opt-in control for a dedicated, single-segment PWM CCT white strip. */
export class WledCctController {
  private readonly generations = new Map<string, number>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly requestedTemperatures = new Map<
    string,
    { kelvin: number; cct: number }
  >();

  constructor(
    private readonly devices: z.output<typeof WledCctMappingsSchema>,
    private readonly transport: typeof fetch,
    private readonly clock: Clock,
    private readonly emit: (observation: LightingObservation) => void,
  ) {}

  has(target: string): boolean {
    return target in this.devices;
  }

  invalidate(target: string): void {
    this.nextGeneration(target);
  }

  async refresh(target: string): Promise<void> {
    // Poll/event reads must not invalidate the feedback from an active write.
    if (this.writes.has(target)) return;
    const generation = this.nextGeneration(target);
    try {
      const state = await this.readState(target);
      if (this.generations.get(target) === generation)
        this.publishState(target, state);
    } catch {
      if (this.generations.get(target) === generation)
        this.publishUnavailable(target);
    }
  }

  async dispatch(command: LightingCommand): Promise<void> {
    if (command.values.rgb !== undefined)
      throw new Error('Dedicated WLED CCT strips do not support RGB');
    const target = command.target;
    const generation = this.nextGeneration(target);
    const previous = this.writes.get(target) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.generations.get(target) !== generation) return;
        await this.execute(command, generation);
      });
    this.writes.set(target, write);
    try {
      await write;
    } finally {
      if (this.writes.get(target) === write) this.writes.delete(target);
    }
  }

  private async execute(
    command: LightingCommand,
    generation: number,
  ): Promise<void> {
    const target = command.target;
    const device = this.devices[target]!;
    // Read first: never create a missing segment or alter other outputs.
    const state = await this.readState(target);
    if (this.generations.get(target) !== generation) return;
    const off =
      command.values.power === false || command.values.brightness === 0;
    const body: Record<string, unknown> = { on: !off, v: true };
    let requestedTemperature: { kelvin: number; cct: number } | undefined;
    if (!off) {
      const segment: Record<string, unknown> = {
        id: device.segmentId,
        on: true,
        bri: 255,
        col: [[0, 0, 0, 255]],
        fx: 0,
      };
      if (command.values.colorTemperature !== undefined) {
        // Match HA's WLED 2000–6535 K mapping, including its state feedback.
        const cct = Math.round(
          Math.max(
            0,
            Math.min(
              255,
              ((command.values.colorTemperature - 2000) * 255) / 4535,
            ),
          ),
        );
        segment['cct'] = cct;
        if (
          command.values.colorTemperature >= 2000 &&
          command.values.colorTemperature <= 6535
        )
          requestedTemperature = {
            kelvin: command.values.colorTemperature,
            cct,
          };
      }
      body['seg'] = [segment];
      body['bri'] =
        command.values.brightness === undefined
          ? Math.max(
              1,
              Math.round(
                (((state.bri * state.seg[0]!.bri) / 255) *
                  state.seg[0]!.col[0]![3]) /
                  255,
              ) || state.bri,
            )
          : Math.max(1, Math.round((command.values.brightness * 255) / 100));
    }

    let response: Response;
    try {
      response = await this.transport(
        `${device.baseUrl.replace(/\/+$/, '')}/json/state`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      throw new LightingDeliveryUnknownError(
        `WLED CCT response was not received for ${target}`,
      );
    }
    if (!response.ok) {
      if (
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500
      )
        throw new LightingDeliveryUnknownError(
          `WLED CCT returned HTTP ${response.status} for ${target}`,
        );
      throw new Error(`WLED CCT failed for ${target}: HTTP ${response.status}`);
    }
    let observed: z.output<typeof WledStateSchema>;
    try {
      observed = this.parseState(target, await response.json());
    } catch {
      throw new LightingDeliveryUnknownError(
        `WLED CCT returned unusable state for ${target}`,
      );
    }
    if (this.generations.get(target) === generation) {
      if (requestedTemperature)
        this.requestedTemperatures.set(target, requestedTemperature);
      this.publishState(target, observed);
    }
  }

  private nextGeneration(target: string): number {
    const generation = (this.generations.get(target) ?? 0) + 1;
    this.generations.set(target, generation);
    return generation;
  }

  private async readState(
    target: string,
  ): Promise<z.output<typeof WledStateSchema>> {
    const device = this.devices[target]!;
    let response: Response;
    try {
      response = await this.transport(
        `${device.baseUrl.replace(/\/+$/, '')}/json/state`,
        {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      throw new Error(`WLED CCT state was not received for ${target}`);
    }
    if (!response.ok)
      throw new Error(
        `WLED CCT state failed for ${target}: HTTP ${response.status}`,
      );
    try {
      return this.parseState(target, await response.json());
    } catch {
      throw new Error(
        `WLED CCT requires one existing RGBW-state segment for ${target}`,
      );
    }
  }

  private parseState(
    target: string,
    payload: unknown,
  ): z.output<typeof WledStateSchema> {
    const state = WledStateSchema.parse(payload);
    if (
      state.seg.length !== 1 ||
      state.seg[0]?.id !== this.devices[target]!.segmentId ||
      !state.seg[0].col[0] ||
      (state.seg[0].lc & 7) !== 6
    )
      throw new Error('Expected one configured CCT segment');
    return state;
  }

  private publishState(
    target: string,
    state: z.output<typeof WledStateSchema>,
  ): void {
    const segment = state.seg[0]!;
    const white = segment.col[0]![3];
    const power = state.on && segment.on;
    // A zero white/segment level is a hidden channel fault, not a manual Lugn
    // brightness override. Keep the desired scene intact so recovery can run.
    if (power && (white === 0 || segment.bri === 0)) {
      this.publishUnavailable(target);
      return;
    }
    const requestedTemperature = this.requestedTemperatures.get(target);
    this.emit({
      target,
      values: {
        power,
        ...(power
          ? {
              brightness: Math.round(
                (((((state.bri / 255) * segment.bri) / 255) * white) / 255) *
                  100,
              ),
              colorTemperature:
                requestedTemperature?.cct === segment.cct
                  ? requestedTemperature.kelvin
                  : Math.round(2000 + (segment.cct * 4535) / 255),
            }
          : {}),
      },
      observedAt: this.clock.now(),
      provenance: { actor: { type: 'home_assistant' }, source: 'wled.state' },
    });
  }

  private publishUnavailable(target: string): void {
    this.emit({
      target,
      values: {},
      availability: 'unavailable',
      observedAt: this.clock.now(),
      provenance: { actor: { type: 'home_assistant' }, source: 'wled.state' },
    });
  }
}
