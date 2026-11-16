import { ZodError } from 'zod';
import {
  CapabilityInputError,
  type CapabilityInvocation,
  type CapabilityName,
  type CapabilityRegistry,
} from '../application/capabilities.js';
import {
  ExperienceRequestError,
  type ExperienceApi,
  type ExperienceRoute,
} from '../application/experience-api.js';
import type { Clock } from '../core/clock.js';
import {
  CommandRequestSchema,
  type CommandResponse,
  type DeviceCommandName,
} from '../core/device-api.js';
import { DeviceRequestError } from './device-http.js';

const MAX_RECEIPTS_PER_DEVICE = 256;
const RECEIPT_TTL_MS = 24 * 60 * 60_000;

const EXPERIENCE_COMMANDS: Partial<Record<DeviceCommandName, ExperienceRoute>> =
  {
    'routines.bedtime': 'routines/bedtime',
    'routines.action': 'routines/action',
    'suggestions.respond': 'intelligence/suggestion',
  };

type Receipt = {
  fingerprint: string;
  createdAt: number;
  outcome: Promise<Omit<CommandResponse, 'replayed'>>;
};

/** The source tag every phone command carries; provenance is never client-supplied. */
export const MOBILE_SOURCE = 'lugn.mobile';

export function mobileInvocation(
  deviceId: string,
  requestId: string,
  reason?: string,
): CapabilityInvocation {
  return {
    // A tap on the phone is an explicit human action, exactly like the panel
    // or a Hub, so manual-override and human-only checks apply unchanged.
    actor: { type: 'user', id: `mobile:${deviceId}` },
    source: MOBILE_SOURCE,
    requestId: `mobile:${deviceId}:${requestId}`,
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * Executes phone commands through the existing capability registry and
 * experience API. A request id identifies one intent per device: a retry with
 * the same id and body returns the stored answer instead of acting twice,
 * while the same id with a different body is a conflict. Failures are not
 * stored, so a retry after an error runs the command again.
 */
export class DeviceCommandService {
  private readonly receipts = new Map<string, Map<string, Receipt>>();

  constructor(
    private readonly options: {
      capabilities: Pick<CapabilityRegistry, 'invoke'>;
      experience?: Pick<ExperienceApi, 'request'>;
      revision: () => number;
      clock: Pick<Clock, 'now'>;
    },
  ) {}

  async execute(deviceId: string, raw: unknown): Promise<CommandResponse> {
    const request = CommandRequestSchema.parse(raw);
    const fingerprint = stableStringify({
      command: request.command,
      input: request.input,
      reason: request.reason ?? null,
    });
    const now = this.options.clock.now();
    const receipts = this.receiptsFor(deviceId, now);
    const existing = receipts.get(request.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new DeviceRequestError(409, 'request_id_conflict');
      return { ...(await existing.outcome), replayed: true };
    }
    const outcome = this.run(deviceId, request);
    receipts.set(request.requestId, { fingerprint, createdAt: now, outcome });
    if (receipts.size > MAX_RECEIPTS_PER_DEVICE)
      receipts.delete(receipts.keys().next().value!);
    try {
      return { ...(await outcome), replayed: false };
    } catch (error) {
      receipts.delete(request.requestId);
      throw error;
    }
  }

  forget(deviceId: string): void {
    this.receipts.delete(deviceId);
  }

  private receiptsFor(deviceId: string, now: number): Map<string, Receipt> {
    let receipts = this.receipts.get(deviceId);
    if (!receipts) {
      receipts = new Map();
      this.receipts.set(deviceId, receipts);
    }
    for (const [id, receipt] of receipts) {
      if (now - receipt.createdAt < RECEIPT_TTL_MS) break;
      receipts.delete(id);
    }
    return receipts;
  }

  private async run(
    deviceId: string,
    request: ReturnType<typeof CommandRequestSchema.parse>,
  ): Promise<Omit<CommandResponse, 'replayed'>> {
    const invocation = mobileInvocation(
      deviceId,
      request.requestId,
      request.reason,
    );
    let result: unknown;
    try {
      const route = EXPERIENCE_COMMANDS[request.command];
      if (route) {
        if (!this.options.experience)
          throw new DeviceRequestError(503, 'routines_unavailable');
        result = await this.options.experience.request(
          route,
          request.input,
          invocation,
        );
      } else {
        result = await this.options.capabilities.invoke(
          request.command as CapabilityName,
          request.input,
          invocation,
        );
      }
    } catch (error) {
      if (error instanceof DeviceRequestError) throw error;
      if (error instanceof ZodError)
        throw new DeviceRequestError(400, 'invalid_command_input');
      if (error instanceof CapabilityInputError)
        throw new DeviceRequestError(
          error.code === 'target_not_configured' ||
            error.code === 'scene_not_found'
            ? 404
            : 409,
          error.code,
        );
      if (error instanceof ExperienceRequestError)
        throw new DeviceRequestError(error.status, error.code);
      throw new DeviceRequestError(502, 'command_failed');
    }
    const confirmed =
      typeof result === 'object' &&
      result !== null &&
      'status' in result &&
      result.status === 'confirmed';
    return {
      requestId: request.requestId,
      command: request.command,
      status: confirmed ? 'confirmed' : 'accepted',
      result: summarizeResult(request.command, result),
      revision: this.options.revision(),
    };
  }
}

/** Routine and suggestion routes answer with whole snapshots; state carries those. */
function summarizeResult(command: DeviceCommandName, result: unknown): unknown {
  if (EXPERIENCE_COMMANDS[command]) return { accepted: true };
  return result;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
