import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

export const GOVEE_PLATFORM_BASE =
  'https://openapi.api.govee.com/router/api/v1';
export const PlatformIdentitySchema = z.object({
  sku: z.string().regex(/^H[A-Z0-9]{4}$/),
  device: z
    .string()
    .regex(/^(?:(?:[a-fA-F0-9]{2}:){5}|(?:[a-fA-F0-9]{2}:){7})[a-fA-F0-9]{2}$/)
    .transform((value) => value.toUpperCase()),
});
export type PlatformIdentity = z.infer<typeof PlatformIdentitySchema>;
const CapabilitySchema = z.object({
  type: z.string().min(1).max(100),
  instance: z.string().min(1).max(100),
  parameters: z.record(z.string(), z.unknown()).default({}),
});
export type PlatformCapability = z.infer<typeof CapabilitySchema>;
const DeviceSchema = PlatformIdentitySchema.extend({
  capabilities: z.array(CapabilitySchema).max(256),
});
export type PlatformDevice = z.infer<typeof DeviceSchema>;
const StateSchema = PlatformIdentitySchema.extend({
  capabilities: z
    .array(
      z.object({
        type: z.string().min(1).max(100),
        instance: z.string().min(1).max(100),
        state: z.object({ value: z.unknown() }),
      }),
    )
    .max(256),
});
export type PlatformState = z.infer<typeof StateSchema>;
export type PlatformControl = {
  type: string;
  instance: string;
  value: unknown;
};
const SceneValueSchema = z.union([
  z.number().int().nonnegative(),
  z
    .object({
      id: z.number().int().nonnegative(),
      paramId: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type PlatformScene = { name: string; control: PlatformControl };
const RangeSchema = z
  .object({
    min: z.number().int(),
    max: z.number().int(),
    precision: z.number().int().positive().optional(),
  })
  .refine((range) => range.min <= range.max);
const OptionsSchema = z
  .array(z.object({ name: z.string().optional(), value: z.unknown() }))
  .max(4096);

export function platformCapability(
  device: PlatformDevice,
  type: string,
  instance: string,
): PlatformCapability | undefined {
  const matches = device.capabilities.filter(
    (capability) =>
      capability.type === type && capability.instance === instance,
  );
  return matches.length === 1 ? matches[0] : undefined;
}
/** A supported value must fit the complete advertised schema, including segment indices. */
export function platformValueAllowed(
  parameters: Record<string, unknown>,
  value: unknown,
): boolean {
  switch (parameters['dataType']) {
    case 'INTEGER': {
      const range = RangeSchema.safeParse(parameters['range']);
      return (
        range.success &&
        Number.isSafeInteger(value) &&
        typeof value === 'number' &&
        value >= range.data.min &&
        value <= range.data.max &&
        (value - range.data.min) % (range.data.precision ?? 1) === 0
      );
    }
    case 'ENUM': {
      const options = OptionsSchema.safeParse(parameters['options']);
      return (
        options.success &&
        options.data.some((option) => isDeepStrictEqual(option.value, value))
      );
    }
    case 'Array': {
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        new Set(value).size !== value.length
      )
        return false;
      const size = RangeSchema.safeParse(parameters['size']);
      if (
        parameters['size'] !== undefined &&
        (!size.success ||
          value.length < size.data.min ||
          value.length > size.data.max)
      )
        return false;
      const options = OptionsSchema.safeParse(parameters['options']);
      if (options.success)
        return value.every((element) =>
          options.data.some((option) =>
            isDeepStrictEqual(option.value, element),
          ),
        );
      return (
        parameters['elementType'] === 'INTEGER' &&
        value.every((element) =>
          platformValueAllowed(
            { dataType: 'INTEGER', range: parameters['elementRange'] },
            element,
          ),
        )
      );
    }
    case 'STRUCT': {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
      const fields = z
        .array(
          z
            .object({ fieldName: z.string(), required: z.boolean().optional() })
            .passthrough(),
        )
        .max(32)
        .safeParse(parameters['fields']);
      if (
        !fields.success ||
        new Set(fields.data.map((field) => field.fieldName)).size !==
          fields.data.length
      )
        return false;
      const record = value as Record<string, unknown>;
      return (
        Object.keys(record).every((key) =>
          fields.data.some((field) => field.fieldName === key),
        ) &&
        fields.data.every((field) =>
          record[field.fieldName] === undefined
            ? !field.required
            : platformValueAllowed(field, record[field.fieldName]),
        )
      );
    }
    default:
      return false;
  }
}
export function platformControl(
  device: PlatformDevice,
  type: string,
  instance: string,
  value: unknown,
): PlatformControl {
  const capability = platformCapability(device, type, instance);
  if (!capability || !platformValueAllowed(capability.parameters, value))
    throw new Error('Unsupported Govee capability or value');
  return { type, instance, value };
}
export function platformToggle(
  device: PlatformDevice,
  instance: string,
  on: boolean,
): PlatformControl {
  const type =
    instance === 'powerSwitch'
      ? 'devices.capabilities.on_off'
      : 'devices.capabilities.toggle';
  const capability = platformCapability(device, type, instance);
  const options = OptionsSchema.safeParse(capability?.parameters['options']);
  const option = options.success
    ? options.data.filter((option) => option.name === (on ? 'on' : 'off'))
    : [];
  if (option.length !== 1) throw new Error('Unsupported Govee power toggle');
  return platformControl(device, type, instance, option[0]!.value);
}
export function platformScenes(
  capabilities: PlatformCapability[],
): Map<string, PlatformScene> {
  const scenes = new Map<string, PlatformScene>();
  for (const capability of capabilities) {
    if (
      capability.type !== 'devices.capabilities.dynamic_scene' ||
      capability.instance !== 'lightScene' ||
      capability.parameters['dataType'] !== 'ENUM'
    )
      continue;
    const options = z
      .array(
        z.object({ name: z.string().min(1).max(255), value: SceneValueSchema }),
      )
      .max(4096)
      .safeParse(capability.parameters['options']);
    if (!options.success) throw new Error('Invalid Govee scene options');
    for (const option of options.data) {
      const previous = scenes.get(option.name);
      if (previous && !isDeepStrictEqual(previous.control.value, option.value))
        throw new Error('Ambiguous Govee scene name');
      scenes.set(option.name, {
        name: option.name,
        control: {
          type: capability.type,
          instance: capability.instance,
          value: option.value,
        },
      });
    }
  }
  return scenes;
}
export function platformOnline(state?: PlatformState): boolean {
  const matches = state?.capabilities.filter(
    (capability) =>
      capability.type === 'devices.capabilities.online' &&
      capability.instance === 'online',
  );
  return matches?.length === 1 && matches[0]?.state.value === true;
}
export function platformStateValue(
  device: PlatformDevice,
  state: PlatformState | undefined,
  type: string,
  instance: string,
): unknown {
  if (
    !state ||
    state.sku !== device.sku ||
    state.device !== device.device ||
    !platformOnline(state)
  )
    return undefined;
  const values = state.capabilities.filter(
    (capability) =>
      capability.type === type && capability.instance === instance,
  );
  const capability = platformCapability(device, type, instance);
  const value = values.length === 1 ? values[0]?.state.value : undefined;
  return capability &&
    value !== undefined &&
    platformValueAllowed(capability.parameters, value)
    ? value
    : undefined;
}

export class GoveePlatformClient {
  private readonly requestFetch: typeof fetch;
  constructor(
    private readonly options: { apiKey: string; fetch?: typeof fetch },
  ) {
    if (!options.apiKey || /[\r\n\0]/.test(options.apiKey))
      throw new Error('Missing or invalid Govee API key');
    this.requestFetch = options.fetch ?? fetch;
  }
  private async request(
    path: string,
    payload?: unknown,
    assertSession?: () => void,
  ): Promise<Record<string, unknown>> {
    try {
      assertSession?.();
      const response = await this.requestFetch(
        `${GOVEE_PLATFORM_BASE}${path}`,
        {
          headers: {
            'Content-Type': 'application/json',
            'Govee-API-Key': this.options.apiKey,
          },
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
          ...(payload === undefined
            ? {}
            : {
                method: 'POST',
                body: JSON.stringify({ requestId: randomUUID(), payload }),
              }),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('HTTP failure');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing response');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 2_000_000) throw new Error('Response too large');
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      const result = z
        .object({ code: z.literal(200) })
        .passthrough()
        .safeParse(JSON.parse(Buffer.concat(chunks).toString()));
      if (!result.success) throw new Error('API failure');
      return result.data;
    } catch {
      throw new Error('Govee platform request failed');
    }
  }
  async devices(): Promise<PlatformDevice[]> {
    const parsed = z
      .array(z.unknown())
      .max(256)
      .safeParse((await this.request('/user/devices'))['data']);
    if (!parsed.success) throw new Error('Invalid Govee devices response');
    // The account also contains virtual BaseGroup/DreamViewScenic identities.
    // They must not prevent explicitly configured physical lamps from loading.
    return parsed.data.flatMap((entry) => {
      const physical = DeviceSchema.safeParse(entry);
      return physical.success ? [physical.data] : [];
    });
  }
  async scenes(identity: PlatformIdentity): Promise<PlatformCapability[]> {
    const parsed = DeviceSchema.safeParse(
      (
        await this.request(
          '/device/scenes',
          PlatformIdentitySchema.parse(identity),
        )
      )['payload'],
    );
    if (
      !parsed.success ||
      parsed.data.sku !== identity.sku ||
      parsed.data.device !== identity.device.toUpperCase()
    )
      throw new Error('Invalid Govee scenes response');
    platformScenes(parsed.data.capabilities);
    return parsed.data.capabilities;
  }
  async state(identity: PlatformIdentity): Promise<PlatformState> {
    const parsed = StateSchema.safeParse(
      (
        await this.request(
          '/device/state',
          PlatformIdentitySchema.parse(identity),
        )
      )['payload'],
    );
    if (
      !parsed.success ||
      parsed.data.sku !== identity.sku ||
      parsed.data.device !== identity.device.toUpperCase()
    )
      throw new Error('Invalid Govee state response');
    return parsed.data;
  }
  async control(
    identity: PlatformIdentity,
    capability: PlatformControl,
    assertSession: () => void,
  ): Promise<void> {
    await this.request(
      '/device/control',
      { ...PlatformIdentitySchema.parse(identity), capability },
      assertSession,
    );
  }
}
