import { z } from 'zod';

export const PresenceControlConfigSchema = z
  .object({
    baseUrl: z
      .string()
      .url()
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            ['http:', 'https:'].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash
          );
        } catch {
          return false;
        }
      }, 'baseUrl must use HTTP or HTTPS without credentials, query, or fragment'),
  })
  .strict();

const CorrectionResponseSchema = z.object({
  ok: z.literal(true),
  count: z.literal(1),
});

const SensorConfigValueSchema = z.union([
  z.number(),
  z.boolean(),
  z.string().max(64),
]);

/** Editable sensor setting as described by the sensor's own `/api/v1/config`. */
export const SensorConfigFieldSchema = z.object({
  key: z.string().min(1).max(64),
  section: z.string().max(32),
  type: z.enum(['number', 'integer', 'boolean', 'enum']),
  recalibrates: z.boolean(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  unit: z.string().max(16).optional(),
  options: z.array(z.string().max(32)).max(16).optional(),
});

export const SensorConfigDocumentSchema = z.object({
  version: z.literal(1),
  fields: z.array(SensorConfigFieldSchema).max(128),
  values: z.record(z.string(), SensorConfigValueSchema),
});
export type SensorConfigDocument = z.infer<typeof SensorConfigDocumentSchema>;

export const SensorConfigChangesSchema = z
  .record(z.string().min(1).max(64), SensorConfigValueSchema)
  .refine((changes) => Object.keys(changes).length > 0, 'No changes')
  .refine((changes) => Object.keys(changes).length <= 32, 'Too many changes');
export type SensorConfigChanges = z.infer<typeof SensorConfigChangesSchema>;

const ConfigUpdateResponseSchema = SensorConfigDocumentSchema.extend({
  ok: z.literal(true),
  background_reset: z.boolean(),
});

/** The sensor refused a request that the sensor itself validates. */
export class SensorRejectedError extends Error {
  constructor() {
    super('The presence sensor rejected the request');
    this.name = 'SensorRejectedError';
  }
}

/**
 * Reads and controls the STL27L sensor service. The sensor stays the owner of
 * its configuration and persistent ledger; MQTT remains the source of room
 * truth, so nothing here changes Lugn's presence state.
 */
export class Stl27lPresenceControlAdapter {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    const config = PresenceControlConfigSchema.parse({ baseUrl });
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
  }

  /**
   * WebSocket address of the sensor's live radar stream. The sensor's single
   * processing thread already runs near capacity on its Pi, so the control
   * panel asks for a quieter stream (5 frames/s, every 8th point) than the
   * sensor's own page. A sensor that predates these options ignores them.
   */
  get streamUrl(): string {
    const url = new URL(`${this.baseUrl}/ws/stream`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('max_fps', '5');
    url.searchParams.set('point_step', '8');
    return url.toString();
  }

  private async send(
    path: string,
    method: 'GET' | 'POST' | 'PUT',
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.transport(`${this.baseUrl}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
      signal: AbortSignal.timeout(5_000),
      redirect: 'error',
    });
    if (response.status === 400) throw new SensorRejectedError();
    if (!response.ok) throw new Error('Presence sensor request failed');
    return response.json();
  }

  async setCountOne(): Promise<void> {
    CorrectionResponseSchema.parse(
      await this.send('/api/manual', 'POST', {
        count: 1,
        reason: 'Sätt till 1 person via Lugn-dashboard',
      }),
    );
  }

  async setCount(count: number): Promise<void> {
    const result = z.object({ ok: z.literal(true), count: z.number() }).parse(
      await this.send('/api/manual', 'POST', {
        count,
        reason: 'Ändrat i Lugn',
      }),
    );
    if (result.count !== count)
      throw new Error('Presence correction was not acknowledged');
  }

  async getConfig(): Promise<SensorConfigDocument> {
    return SensorConfigDocumentSchema.parse(
      await this.send('/api/v1/config', 'GET'),
    );
  }

  async updateConfig(
    changes: SensorConfigChanges,
  ): Promise<SensorConfigDocument & { backgroundReset: boolean }> {
    const result = ConfigUpdateResponseSchema.parse(
      await this.send('/api/v1/config', 'PUT', { changes }),
    );
    return {
      version: result.version,
      fields: result.fields,
      values: result.values,
      backgroundReset: result.background_reset,
    };
  }

  async recalibrate(): Promise<void> {
    z.object({ ok: z.literal(true) }).parse(
      await this.send('/api/recalibrate', 'POST'),
    );
  }
}
