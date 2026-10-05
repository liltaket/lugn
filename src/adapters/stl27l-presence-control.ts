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

/** Correct the persistent sensor ledger; MQTT remains the source of room truth. */
export class Stl27lPresenceControlAdapter {
  private readonly url: string;

  constructor(
    baseUrl: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    const config = PresenceControlConfigSchema.parse({ baseUrl });
    this.url = `${config.baseUrl.replace(/\/+$/, '')}/api/manual`;
  }

  async setCountOne(): Promise<void> {
    const response = await this.transport(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        count: 1,
        reason: 'Sätt till 1 person via Lugn-dashboard',
      }),
      signal: AbortSignal.timeout(5_000),
      redirect: 'error',
    });
    if (!response.ok)
      throw new Error('Presence correction was not acknowledged');
    CorrectionResponseSchema.parse(await response.json());
  }
}
