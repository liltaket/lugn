import { z } from 'zod';
import { SemanticButtonIdSchema } from '../core/schemas.js';

const HomeAssistantButtonEntityIdSchema = z
  .string()
  .regex(/^button\.[a-z0-9_]+$/);

/** Explicit semantic-to-Home-Assistant button allowlist. */
export const HomeAssistantButtonMappingsSchema = z
  .record(SemanticButtonIdSchema, HomeAssistantButtonEntityIdSchema)
  .superRefine((mappings, context) => {
    const entityIds = Object.values(mappings);
    if (new Set(entityIds).size !== entityIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Each Home Assistant button entity must have one semantic ID',
      });
    }
  });

const ConfigSchema = z
  .object({
    baseUrl: z.string().superRefine((value, context) => {
      try {
        const url = new URL(value);
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          context.addIssue({
            code: 'custom',
            message:
              'baseUrl must use HTTP or HTTPS without credentials, query or fragment',
          });
      } catch {
        context.addIssue({
          code: 'custom',
          message: 'baseUrl must be a valid URL',
        });
      }
    }),
    token: z.string().min(1),
    entities: HomeAssistantButtonMappingsSchema,
  })
  .strict();

export type HomeAssistantButtonConfig = z.input<typeof ConfigSchema>;

const DefaultTimeoutMs = 10_000;
const TimeoutMsSchema = z.number().int().positive().max(DefaultTimeoutMs);

/**
 * Sends only the fixed Home Assistant button.press action for configured
 * semantic targets. A successful response means HA accepted the request; it
 * does not confirm that a physical device completed the action.
 */
export class HomeAssistantButtonAdapter {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly entities: z.output<typeof HomeAssistantButtonMappingsSchema>;
  private readonly timeoutMs: number;

  constructor(
    config: HomeAssistantButtonConfig,
    private readonly transport: typeof fetch,
    timeoutMs = DefaultTimeoutMs,
  ) {
    const parsedConfig = ConfigSchema.parse(config);
    this.baseUrl = parsedConfig.baseUrl.replace(/\/+$/, '');
    this.token = parsedConfig.token;
    this.entities = parsedConfig.entities;
    this.timeoutMs = TimeoutMsSchema.parse(timeoutMs);
  }

  /** True only for a valid semantic target present in the explicit allowlist. */
  hasTarget(target: string): boolean {
    const parsed = SemanticButtonIdSchema.safeParse(target);
    return parsed.success && this.entities[parsed.data] !== undefined;
  }

  /** Invoke one configured button; service names and entity IDs are not inputs. */
  async press(semanticTarget: string): Promise<void> {
    const target = SemanticButtonIdSchema.parse(semanticTarget);
    const entityId = this.entities[target];
    if (!entityId)
      throw new Error(
        `No Home Assistant button entity is configured for ${target}`,
      );

    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error('timeout'));
      }, this.timeoutMs);
    });

    let response: Response;
    try {
      response = await Promise.race([
        this.transport(`${this.baseUrl}/api/services/button/press`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ entity_id: entityId }),
          signal: controller.signal,
        }),
        timeout,
      ]);
    } catch {
      if (timedOut)
        throw new Error(
          `Home Assistant button.press failed for ${target}: request timed out`,
        );
      // Do not forward transport errors: implementations may include the URL
      // or Authorization header in their message.
      throw new Error(
        `Home Assistant button.press failed for ${target}: transport error`,
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (!response.ok)
      throw new Error(
        `Home Assistant button.press failed for ${target}: HTTP ${response.status}`,
      );
  }
}
