import { z } from 'zod';

/** Public catalog; no account credentials are sent. Commands remain on the LAN. */
export const GOVEE_EFFECT_LIBRARY_URL =
  'https://app2.govee.com/appsku/v1/light-effect-libraries';
export const GOVEE_COMMAND_PORT = 4003;
export const GOVEE_STATUS_QUERY = {
  msg: { cmd: 'devStatus', data: {} },
} as const;

const MAX_PARAMETER_BYTES = 4_096;
// H612A includes large app-only metadata: its catalog exceeds 5 MB.
const MAX_LIBRARY_BYTES = 8_000_000;
const SkuSchema = z.string().regex(/^H[A-Z0-9]{4,11}$/);
const SceneParameterSchema = z
  .string()
  .max(Math.ceil(MAX_PARAMETER_BYTES / 3) * 4)
  .refine((value) => {
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        value,
      )
    )
      return false;
    const bytes = Buffer.from(value, 'base64');
    return (
      bytes.length <= MAX_PARAMETER_BYTES && bytes.toString('base64') === value
    );
  }, 'Scene parameters must be bounded canonical Base64');

const EffectSchema = z.object({
  sceneCode: z.number().int().min(0).max(65_535),
  sceneType: z.number().int().min(0).max(255).default(0),
  scenceParam: SceneParameterSchema.default(''),
  scenceParamId: z.number().int().nonnegative().optional(),
  scenceName: z.string().max(256).default(''),
  cmdVersion: z
    .number()
    .int()
    .min(0)
    .max(255)
    .nullish()
    .transform((value) => value ?? undefined),
  // Payload formats for other models are opaque; validate them only if selected.
  specialEffect: z.array(z.unknown()).max(1_024).default([]),
});
const SpecialEffectTargetSchema = z.object({
  supportSku: z.array(z.string().max(128)).max(256).default([]),
});
const SpecialEffectOverrideSchema = z.object({
  scenceParamId: z.number().int().nonnegative(),
  scenceParam: SceneParameterSchema,
  cmdVersion: z.number().int().min(0).max(255),
});

function selectModelParameters(
  sku: string,
  effect: z.infer<typeof EffectSchema>,
): z.infer<typeof EffectSchema> {
  const matches = effect.specialEffect.filter((entry) =>
    SpecialEffectTargetSchema.parse(entry).supportSku.includes(sku),
  );
  if (matches.length > 1)
    throw new Error(`Ambiguous Govee specialEffect overrides for ${sku}`);
  const selected = matches[0];
  return selected === undefined
    ? effect
    : { ...effect, ...SpecialEffectOverrideSchema.parse(selected) };
}
const LibrarySchema = z.object({
  data: z.object({
    categories: z
      .array(
        z.object({
          categoryName: z.string().max(256),
          scenes: z
            .array(
              z.object({
                sceneId: z.number().int().nonnegative(),
                sceneName: z.string().max(256),
                lightEffects: z.array(EffectSchema).max(256),
              }),
            )
            .max(1_024),
        }),
      )
      .max(64),
  }),
});

export type GoveeEffect = {
  sku: string;
  id: string;
  name: string;
  category: string;
  sceneCode: number;
  sceneType: number;
  sceneParam: string;
  /** Selected model-specific parameter ID; the public ID stays catalog-compatible. */
  paramId?: number;
  cmdVersion?: number;
  /** One-based variant index within the app's scene group. */
  variant: number;
};

export function parseGoveeEffectLibrary(
  sku: string,
  input: unknown,
): GoveeEffect[] {
  const normalizedSku = SkuSchema.parse(sku.toUpperCase());
  const library = LibrarySchema.parse(input);
  const effects: GoveeEffect[] = [];
  const duplicateIds = new Map<string, number>();
  for (const category of library.data.categories) {
    for (const scene of category.scenes) {
      scene.lightEffects.forEach((baseEffect, index) => {
        const effect = selectModelParameters(normalizedSku, baseEffect);
        // Use the complete variant list: the app displays Universe-A/B, etc.
        const suffix =
          scene.lightEffects.length > 1
            ? ` · ${effect.scenceName || String(index + 1)}`
            : '';
        // Overrides correct the payload without invalidating IDs already stored by callers.
        const baseId = `${normalizedSku}:${scene.sceneId}:${baseEffect.scenceParamId ?? baseEffect.sceneCode}:${index + 1}`;
        const occurrence = (duplicateIds.get(baseId) ?? 0) + 1;
        duplicateIds.set(baseId, occurrence);
        effects.push({
          sku: normalizedSku,
          id: occurrence === 1 ? baseId : `${baseId}:duplicate-${occurrence}`,
          name: `${scene.sceneName}${suffix}`,
          category: category.categoryName,
          sceneCode: effect.sceneCode,
          sceneType: effect.sceneType,
          sceneParam: effect.scenceParam,
          ...(effect.scenceParamId === undefined
            ? {}
            : { paramId: effect.scenceParamId }),
          ...(effect.cmdVersion === undefined
            ? {}
            : { cmdVersion: effect.cmdVersion }),
          variant: index + 1,
        });
      });
      if (effects.length > 4_096)
        throw new Error('Govee scene library contains too many effects');
    }
  }
  return effects;
}

export async function fetchGoveeEffectLibrary(
  sku: string,
  transport: typeof fetch = fetch,
): Promise<GoveeEffect[]> {
  const normalizedSku = SkuSchema.parse(sku.toUpperCase());
  const response = await transport(
    `${GOVEE_EFFECT_LIBRARY_URL}?sku=${encodeURIComponent(normalizedSku)}`,
    {
      headers: { AppVersion: '5.6.01', 'User-Agent': 'GoveeHome/5.6.01' },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    throw new Error(`Govee scene library HTTP ${response.status}`);
  if (!response.body) throw new Error('Govee scene library response is empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_LIBRARY_BYTES)
        throw new Error('Govee scene library response is too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return parseGoveeEffectLibrary(
    normalizedSku,
    JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
  );
}

type EffectCommandInput = Pick<
  GoveeEffect,
  'sku' | 'sceneCode' | 'sceneType' | 'sceneParam'
>;

function frame(payload: Uint8Array): Buffer {
  if (payload.length > 19)
    throw new Error('Govee frame payload exceeds 19 bytes');
  const result = Buffer.alloc(20);
  result.set(payload);
  let checksum = 0;
  for (const byte of payload) checksum ^= byte;
  result[19] = checksum;
  return result;
}

/** H60A6's variable-length A4 frames have an XOR byte and no padding. */
function exactFrame(payload: Buffer): Buffer {
  return Buffer.concat([
    payload,
    Buffer.from([payload.reduce((checksum, byte) => checksum ^ byte, 0)]),
  ]);
}

function littleEndian16(value: number): Buffer {
  const result = Buffer.alloc(2);
  result.writeUInt16LE(value);
  return result;
}

/**
 * Re-encode the H60A6 graffiti value as the app does: merge groups by RGB,
 * retaining the last pixel list per color, renumber priorities, and drop slack.
 * Reference: govee-ble-local 1.10.0 wire/build.py h60a6_graffiti_value.
 */
function h60a6GraffitiValue(value: Buffer): Buffer {
  if (value.length < 7 || value[0] !== 0x20 || value[6]! > 127)
    throw new Error('Invalid H60A6 graffiti header');
  const layers: Buffer[] = [];
  let offset = 7;
  for (let index = 0; index < value[6]!; index++) {
    if (offset + 2 > value.length)
      throw new Error('Truncated H60A6 graffiti layer');
    const length = value.readUInt16LE(offset);
    offset += 2;
    if (length < 15 || offset + length > value.length)
      throw new Error('Invalid H60A6 graffiti layer length');
    const body = value.subarray(offset, offset + length);
    offset += length;
    // The app keeps layers only up to the first non-graffiti layer.
    if (body[0] !== 3) break;
    const groupCount = body.readUInt16LE(3);
    let cursor = 5;
    const groups = new Map<string, Buffer>();
    for (let group = 0; group < groupCount; group++) {
      if (cursor + 5 > body.length - 10)
        throw new Error('Truncated H60A6 graffiti group');
      const pixelCount = body.readUInt16LE(cursor);
      const end = cursor + 5 + pixelCount;
      if (end > body.length - 10)
        throw new Error('Invalid H60A6 graffiti pixel count');
      groups.set(
        body.subarray(cursor + 2, cursor + 5).toString('hex'),
        body.subarray(cursor, end),
      );
      cursor = end;
    }
    const tail = Buffer.from(body.subarray(cursor, cursor + 10));
    if (!tail.subarray(6).equals(Buffer.alloc(4)))
      throw new Error('Invalid H60A6 graffiti reserved bytes');
    tail[3] = index + 1;
    const pixels = Buffer.concat([...groups.values()]);
    const rebuiltBody = Buffer.concat([
      Buffer.from([3]),
      littleEndian16(2 + pixels.length),
      littleEndian16(groups.size),
      pixels,
      tail,
    ]);
    layers.push(
      Buffer.concat([littleEndian16(rebuiltBody.length), rebuiltBody]),
    );
  }
  const header = Buffer.from(value.subarray(0, 7));
  header[6] = layers.length;
  return Buffer.concat([header, ...layers]);
}

/** Pure upload framing; these bytes are sent through LAN ptReal, without BLE IO. */
function h60a6SceneFrames(parameter: Buffer): Buffer[] {
  if (parameter[0] !== 0x50)
    throw new Error('Unsupported H60A6 scene parameter prefix');
  const value = parameter.subarray(1);
  // DIY is tried before graffiti: a valid DIY may also begin with byte 0x20.
  if (value.length >= 5 && value.readUInt16LE(0) + 2 === value.length) {
    const backgroundEnd = 4 + value[3]! * 3;
    if (backgroundEnd >= value.length)
      throw new Error('Truncated H60A6 DIY background');
    let offset = backgroundEnd + 1;
    for (let layer = 0; layer < value[2]!; layer++) {
      if (offset + 2 > value.length)
        throw new Error('Truncated H60A6 DIY layer');
      const length = value.readUInt16LE(offset);
      offset += 2;
      if (
        length < 1 ||
        offset + length > value.length ||
        value[offset]! < 1 ||
        value[offset]! > 10
      )
        throw new Error('Invalid H60A6 DIY layer');
      offset += length;
    }
    const body = Buffer.concat([Buffer.from([1, 0, 0x58]), value]);
    const count = Math.max(2, Math.ceil(body.length / 17));
    if (count > 254) throw new Error('H60A6 scene requires too many frames');
    body[1] = count;
    return Array.from({ length: count }, (_, index) =>
      frame(
        Buffer.concat([
          Buffer.from([0xa3, index === count - 1 ? 0xff : index]),
          body.subarray(index * 17, (index + 1) * 17),
        ]),
      ),
    );
  }
  const graffiti = h60a6GraffitiValue(value);
  const chunks: Buffer[] = [];
  const rest = graffiti.subarray(12);
  for (let offset = 0; offset < rest.length; offset += 16)
    chunks.push(rest.subarray(offset, offset + 16));
  if (chunks.length === 0) chunks.push(Buffer.alloc(0));
  const count = chunks.length + 1;
  return [
    exactFrame(
      Buffer.concat([
        Buffer.from([0xa4, 0, 0, 1]),
        littleEndian16(count),
        Buffer.from([0x58]),
        graffiti.subarray(0, 12),
      ]),
    ),
    ...chunks.map((chunk, index) =>
      exactFrame(
        Buffer.concat([
          Buffer.from([0xa4]),
          littleEndian16(index === chunks.length - 1 ? 0xffff : index + 1),
          chunk,
        ]),
      ),
    ),
  ];
}

/**
 * BLE frames tunneled over LAN ptReal. Generic type-2 framing follows
 * https://github.com/wez/govee2mqtt/blob/main/src/ble.rs (Forest fixture).
 * H6022 needs model-specific prefixes from
 * https://github.com/AlgoClaw/Govee/blob/main/decoded/v1.2/model_specific_parameters.json
 * H60A6 type-5 staging follows the pure govee-ble-local 1.10.0 scene planner:
 * https://github.com/Brady-Woods/govee-ble-local (scenes/__init__.py, wire/build.py).
 * Catalog presence does not prove that a firmware version will play an effect.
 */
export function encodeGoveeEffectFrames(effect: EffectCommandInput): Buffer[] {
  const sku = SkuSchema.parse(effect.sku.toUpperCase());
  const parsed = EffectSchema.parse({
    sceneCode: effect.sceneCode,
    sceneType: effect.sceneType,
    scenceParam: effect.sceneParam,
  });
  // The public app catalog includes a special Sunrise entry with code zero.
  // Upstream LAN bridges skip it; its special configuration is unsupported here.
  if (parsed.sceneCode === 0)
    throw new Error('Govee scene code zero is an unsupported Sunrise entry');
  let parameter = Buffer.from(parsed.scenceParam, 'base64');
  const frames: Buffer[] = [];
  if (parameter.length > 0 && sku === 'H60A6' && parsed.sceneType === 5) {
    frames.push(...h60a6SceneFrames(parameter));
  } else if (parameter.length > 0) {
    let prefix: Buffer;
    if (sku === 'H6022' && parameter[0] === 0x41) {
      parameter = parameter.subarray(1);
      prefix = Buffer.from([0x58, 0x5a]);
    } else if (sku === 'H6022' && parameter[0] === 0x00) {
      parameter = parameter.subarray(1);
      prefix = Buffer.from([0x04]);
    } else if (parsed.sceneType === 1 || parsed.sceneType === 2) {
      prefix = Buffer.from([parsed.sceneType]);
    } else {
      throw new Error(
        `Unverified Govee scene parameter format for ${sku}, type ${parsed.sceneType}`,
      );
    }
    const body = Buffer.concat([Buffer.from([0x01, 0x00]), prefix, parameter]);
    const count = Math.ceil(body.length / 17);
    if (count > 254) throw new Error('Govee scene requires too many frames');
    body[1] = count;
    for (let index = 0; index < count; index++) {
      frames.push(
        frame(
          Buffer.concat([
            Buffer.from([0xa3, index === count - 1 ? 0xff : index]),
            body.subarray(index * 17, (index + 1) * 17),
          ]),
        ),
      );
    }
  }
  frames.push(
    frame(
      Buffer.from([
        0x33,
        0x05,
        0x04,
        parsed.sceneCode & 0xff,
        parsed.sceneCode >> 8,
      ]),
    ),
  );
  return frames;
}

/** Sending UDP is only delivery intent: devStatus does not report the scene. */
export function encodeGoveeEffectCommand(effect: EffectCommandInput): {
  msg: { cmd: 'ptReal'; data: { command: string[] } };
} {
  return {
    msg: {
      cmd: 'ptReal',
      data: {
        command: encodeGoveeEffectFrames(effect).map((bytes) =>
          bytes.toString('base64'),
        ),
      },
    },
  };
}
