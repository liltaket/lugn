import { describe, expect, it } from 'vitest';
import {
  encodeGoveeEffectCommand,
  encodeGoveeEffectFrames,
  fetchGoveeEffectLibrary,
  parseGoveeEffectLibrary,
} from '../src/adapters/govee-lan-effects.js';

const forest = {
  sku: 'H612A',
  sceneCode: 212,
  sceneType: 2,
  sceneParam:
    'AyYAAQAKAgH/GQG0CgoCyBQF//8AAP//////AP//lP8AFAGWAAAAACMAAg8FAgH/FAH7AAAB+goEBP8AtP8AR///4/8AAAAAAAAAABoAAAABAgH/BQHIFBQC7hQBAP8AAAAAAAAAAA==',
};

// Public H60A6 catalog parameters; expected frames independently generated with
// govee-ble-local 1.10.0 scene_upload_frames(..., 'B_h60a6', {0,1,3,5}), MTU 20.
const ceilingForest = {
  sku: 'H60A6',
  sceneCode: 19073,
  sceneType: 5,
  sceneParam:
    'UCwAAgEA/wAUEQAFZAYBBP//AAD/AJn/AP/DABEABU0KAQT//wD/Ov//hAAA+f8=',
};
const ceilingAurora = {
  sku: 'H60A6',
  sceneCode: 19074,
  sceneType: 5,
  sceneParam:
    'UCAA/wAMAAGyAAOlAAYAGgAAAP8CCRQVFi8wMUFCQ1ZXWGJjZHFyc3h5eoGCgx4AAKfVAQoPEBESEzIzNDU2PD0+P0BZWltcXV5fYGF0dXZ3GwAA/mwDCBcYGSwtLkRFRlNUVWVmZ25vcHt8fX5/gIQKAAD/AAUGHyAhIiMkJSYeAAD/TwQHGhscHR4nKCkqK0dISUpLTE1OT1BRUmhpamtsbQoAAP/SAAsMDQ43ODk6OwIAZAEQJwAAAAA=',
};

function library() {
  return {
    data: {
      categories: [
        {
          categoryName: 'Natural',
          scenes: [
            {
              sceneId: 100,
              sceneName: 'Universe',
              lightEffects: [
                {
                  sceneCode: 200,
                  sceneType: 2,
                  scenceParam: 'AQ==',
                  scenceName: 'A',
                },
                {
                  sceneCode: 2499,
                  sceneType: 2,
                  scenceParam: 'Ag==',
                  scenceName: 'B',
                },
              ],
            },
            {
              sceneId: 101,
              sceneName: 'Sunrise',
              lightEffects: [{ sceneCode: 0, sceneType: 0, scenceParam: '' }],
            },
          ],
        },
      ],
    },
  };
}

function libraryWithOverrides(specialEffect: unknown[]) {
  const payload = library();
  Object.assign(payload.data.categories[0]!.scenes[0]!.lightEffects[0]!, {
    scenceParamId: 7,
    cmdVersion: 0,
    specialEffect,
  });
  return payload;
}

const modelOverride = {
  supportSku: ['H612A'],
  scenceParamId: 77,
  scenceParam: 'Aw==',
  cmdVersion: 1,
};

describe('Govee public effects and LAN frames', () => {
  it('encodes H60A6 Forest with model-specific A3 staging and ordinary activation', () => {
    expect(
      encodeGoveeEffectFrames(ceilingForest).map((bytes) =>
        bytes.toString('hex'),
      ),
    ).toEqual([
      'a3000103582c00020100ff00141100056406014a',
      'a30104ffff0000ff0099ff00ffc3001100054d5a',
      'a3ff0a0104ffff00ff3affff840000f9ff000014',
      '330504814a0000000000000000000000000000f9',
    ]);
  });

  it('encodes H60A6 Aurora with exact-length A4 frames, preserving the unpadded END', () => {
    const frames = encodeGoveeEffectFrames(ceilingAurora);
    expect(frames.map((bytes) => bytes.toString('hex'))).toEqual([
      'a40000010c00582000ff000c0001b20003a50037',
      'a4010006001a000000ff02091415162f30314135',
      'a40200424356575862636471727378797a818293',
      'a40300831e0000a7d5010a0f1011121332333479',
      'a4040035363c3d3e3f40595a5b5c5d5e5f6061ba',
      'a40500747576771b0000fe6c03081718192c2d34',
      'a406002e4445465354556566676e6f707b7c7df6',
      'a407007e7f80840a0000ff0005061f202122234f',
      'a408002425261e0000ff4f04071a1b1c1d1e271f',
      'a4090028292a2b4748494a4b4c4d4e4f505152b9',
      'a40a0068696a6b6c6d0a0000ffd2000b0c0d0e8c',
      'a4ffff3738393a3b02006401102700000000c3',
      '330504824a0000000000000000000000000000fa',
    ]);
    expect(frames.at(-2)?.length).toBe(19);
    for (const bytes of frames)
      expect(bytes.reduce((checksum, byte) => checksum ^ byte, 0)).toBe(0);
    expect(
      encodeGoveeEffectCommand(ceilingAurora).msg.data.command.at(-2),
    ).toBe(frames.at(-2)?.toString('base64'));
  });

  it('rebuilds H60A6 graffiti groups and priorities and drops trailing slack', () => {
    const header = Buffer.from([0x20, 1, 2, 3, 50, 0, 1]);
    const body = Buffer.from([
      3,
      14,
      0,
      2,
      0, // two groups
      1,
      0,
      10,
      20,
      30,
      1, // RGB group with pixel 1
      1,
      0,
      10,
      20,
      30,
      2, // same RGB replaces its pixels with pixel 2
      1,
      2,
      3,
      7,
      100,
      0,
      0,
      0,
      0,
      0, // priority 7 is renumbered
      99, // discarded layer slack
    ]);
    const parameter = Buffer.concat([
      Buffer.from([0x50]),
      header,
      Buffer.from([body.length, 0]),
      body,
      Buffer.from([88]), // discarded value rest
    ]);
    const frames = encodeGoveeEffectFrames({
      ...ceilingAurora,
      sceneParam: parameter.toString('base64'),
    }).slice(0, -1);
    const value = Buffer.concat(
      frames.map((bytes, index) => bytes.subarray(index === 0 ? 7 : 3, -1)),
    );
    expect(value).toEqual(
      Buffer.concat([
        header,
        Buffer.from([
          21,
          0,
          3,
          8,
          0,
          1,
          0, // recomputed body length, inner length, group count
          1,
          0,
          10,
          20,
          30,
          2,
          1,
          2,
          3,
          1,
          100,
          0,
          0,
          0,
          0,
          0,
        ]),
      ]),
    );
  });

  it('keeps H60A6 type-5 support model-specific and rejects malformed staging blobs', () => {
    expect(() =>
      encodeGoveeEffectFrames({ ...ceilingForest, sku: 'H612F' }),
    ).toThrow('Unverified Govee scene parameter format');
    for (const bytes of [
      Buffer.from([0x51, 1, 2, 3]),
      Buffer.from([0x50, 0x20]),
      Buffer.from([0x50, 3, 0, 1, 0, 50]), // declares a missing DIY layer
      Buffer.from([0x50, 0x20, 1, 2, 3, 50, 0, 1, 15, 0]), // short graffiti layer
      Buffer.from([0x50, 0x20, 1, 2, 3, 50, 0, 128]), // oversized layer count
    ]) {
      expect(() =>
        encodeGoveeEffectFrames({
          ...ceilingForest,
          sceneParam: bytes.toString('base64'),
        }),
      ).toThrow();
    }
  });

  it('selects the SKU-specific animation payload and ID without overriding scene metadata', () => {
    const payload = libraryWithOverrides([
      {
        ...modelOverride,
        sceneCode: 42,
        sceneType: 9,
        scenceName: 'Wrong name',
        speedInfo: { supSpeed: true },
      },
    ]);
    const [effect, nextVariant] = parseGoveeEffectLibrary('h612a', payload);
    expect(effect).toMatchObject({
      id: 'H612A:100:7:1',
      paramId: 77,
      name: 'Universe · A',
      category: 'Natural',
      variant: 1,
      sceneCode: 200,
      sceneType: 2,
      sceneParam: 'Aw==',
      cmdVersion: 1,
    });
    expect(nextVariant).toMatchObject({
      id: 'H612A:100:2499:2',
      name: 'Universe · B',
      sceneParam: 'Ag==',
    });
    expect(encodeGoveeEffectFrames(effect!)[0]?.subarray(0, 6)).toEqual(
      Buffer.from([0xa3, 0xff, 1, 1, 2, 3]),
    );
  });

  it('honors empty selected parameters and a zero parameter ID without falling back', () => {
    const [effect] = parseGoveeEffectLibrary(
      'H612A',
      libraryWithOverrides([
        { ...modelOverride, scenceParamId: 0, scenceParam: '' },
      ]),
    );
    expect(effect).toMatchObject({
      id: 'H612A:100:7:1',
      paramId: 0,
      sceneParam: '',
      cmdVersion: 1,
    });
    expect(encodeGoveeEffectFrames(effect!)).toHaveLength(1);
  });

  it('ignores unsupported payload formats for other SKUs and preserves the base animation', () => {
    const [effect] = parseGoveeEffectLibrary(
      'H612F',
      libraryWithOverrides([
        { ...modelOverride, scenceParam: 'not Base64', cmdVersion: 'future' },
        { supportSku: ['H6022'], scenceParam: { unsupported: true } },
      ]),
    );
    expect(effect).toMatchObject({
      id: 'H612F:100:7:1',
      sceneParam: 'AQ==',
      sceneCode: 200,
      sceneType: 2,
      cmdVersion: 0,
    });
  });

  it('accepts null base command versions as absent, as published by the H6022 catalog', () => {
    const payload = libraryWithOverrides([]);
    Object.assign(payload.data.categories[0]!.scenes[0]!.lightEffects[0]!, {
      cmdVersion: null,
    });
    const [effect] = parseGoveeEffectLibrary('H6022', payload);
    expect(effect?.cmdVersion).toBeUndefined();
    expect(effect?.sceneParam).toBe('AQ==');
  });

  it('rejects malformed selected overrides instead of using the base payload', () => {
    for (const override of [
      { ...modelOverride, scenceParam: '!' },
      { ...modelOverride, scenceParam: 'AR==' },
      { ...modelOverride, scenceParam: Buffer.alloc(4097).toString('base64') },
      { ...modelOverride, scenceParam: undefined },
      { ...modelOverride, scenceParamId: -1 },
      { ...modelOverride, cmdVersion: 'one' },
    ]) {
      expect(() =>
        parseGoveeEffectLibrary('H612A', libraryWithOverrides([override])),
      ).toThrow();
    }
  });

  it('rejects multiple matching overrides, including identical duplicates', () => {
    for (const second of [
      modelOverride,
      { ...modelOverride, scenceParam: 'BA==' },
    ]) {
      expect(() =>
        parseGoveeEffectLibrary(
          'H612A',
          libraryWithOverrides([modelOverride, second]),
        ),
      ).toThrow('Ambiguous Govee specialEffect overrides');
    }
  });

  it('bounds override metadata and rejects malformed target lists', () => {
    for (const overrides of [
      Array(1025).fill({ supportSku: [] }),
      [{ ...modelOverride, supportSku: 'H612A' }],
      [{ ...modelOverride, supportSku: [null] }],
      [{ ...modelOverride, supportSku: Array(257).fill('H612A') }],
    ]) {
      expect(() =>
        parseGoveeEffectLibrary('H612A', libraryWithOverrides(overrides)),
      ).toThrow();
    }
  });

  it('matches the independent wez/govee2mqtt Forest packet fixture byte for byte', () => {
    expect(
      encodeGoveeEffectFrames(forest).map((bytes) => bytes.toString('hex')),
    ).toEqual([
      'a30001070203260001000a0201ff1901b40a0ad9',
      'a30102c81405ffff0000ffffffffff00ffff9412',
      'a302ff00140196000000002300020f050201ff0a',
      'a3031401fb000001fa0a0404ff00b4ff0047ffb3',
      'a304ffe3ff00000000000000001a00000001025d',
      'a30501ff0501c8141402ee140100ff0000000092',
      'a3ff00000000000000000000000000000000005c',
      '330504d4000000000000000000000000000000e6',
    ]);
  });

  it('preserves every variant, zero-valued codes, and duplicate display names', () => {
    const payload = library();
    const first = payload.data.categories[0]!;
    first.scenes.push({ ...first.scenes[0]!, sceneId: 102 });
    const effects = parseGoveeEffectLibrary('h612a', payload);
    expect(effects.map((effect) => effect.name)).toEqual([
      'Universe · A',
      'Universe · B',
      'Sunrise',
      'Universe · A',
      'Universe · B',
    ]);
    expect(new Set(effects.map((effect) => effect.id)).size).toBe(5);
    expect(effects[2]).toMatchObject({
      sku: 'H612A',
      sceneCode: 0,
      variant: 1,
    });
  });

  it('uses a single activation frame when there are no parameter bytes', () => {
    const frames = encodeGoveeEffectFrames({
      ...forest,
      sceneCode: 1,
      sceneParam: '',
    });
    expect(frames.map((bytes) => bytes.toString('hex'))).toEqual([
      '3305040100000000000000000000000000000033',
    ]);
  });

  it('handles the H6022 prefix transforms instead of sending generic strip frames', () => {
    const frames = encodeGoveeEffectFrames({
      sku: 'H6022',
      sceneCode: 8478,
      sceneType: 5,
      sceneParam: Buffer.from([0x41, 0x01, 0x02]).toString('base64'),
    });
    expect(frames[0]?.subarray(0, 8)).toEqual(
      Buffer.from([0xa3, 0xff, 0x01, 0x01, 0x58, 0x5a, 0x01, 0x02]),
    );
    const alternate = encodeGoveeEffectFrames({
      sku: 'H6022',
      sceneCode: 1,
      sceneType: 5,
      sceneParam: Buffer.from([0x00, 0x03]).toString('base64'),
    });
    expect(alternate[0]?.subarray(0, 6)).toEqual(
      Buffer.from([0xa3, 0xff, 0x01, 0x01, 0x04, 0x03]),
    );
  });

  it('builds bounded checked frames at first and subsequent chunk boundaries', () => {
    for (const length of [1, 14, 15, 31, 32, 4096]) {
      const frames = encodeGoveeEffectFrames({
        ...forest,
        sceneParam: Buffer.alloc(length, 127).toString('base64'),
      });
      for (const bytes of frames) {
        expect(bytes.length).toBe(20);
        expect(bytes.reduce((checksum, byte) => checksum ^ byte, 0)).toBe(0);
      }
      expect(frames.at(-2)?.[1]).toBe(0xff);
      const dataFrames = frames.slice(0, -1);
      const body = Buffer.concat(
        dataFrames.map((bytes) => bytes.subarray(2, 19)),
      );
      expect(body.subarray(0, 3)).toEqual(
        Buffer.from([1, dataFrames.length, 2]),
      );
      expect(body.subarray(3, 3 + length)).toEqual(Buffer.alloc(length, 127));
    }
  });

  it('rejects invalid or oversized parameters, codes and unsupported formats before IO', () => {
    for (const sceneParam of [
      '!',
      'AQ',
      'AR==',
      Buffer.alloc(4097).toString('base64'),
    ]) {
      expect(() =>
        encodeGoveeEffectFrames({ ...forest, sceneParam }),
      ).toThrow();
    }
    expect(() =>
      encodeGoveeEffectFrames({ ...forest, sceneCode: -1 }),
    ).toThrow();
    expect(() =>
      encodeGoveeEffectFrames({ ...forest, sceneCode: 65536 }),
    ).toThrow();
    expect(() => encodeGoveeEffectFrames({ ...forest, sceneType: 9 })).toThrow(
      'Unverified Govee scene parameter format',
    );
    expect(() => parseGoveeEffectLibrary('../file', library())).toThrow();
    expect(() => parseGoveeEffectLibrary('H612A', { data: {} })).toThrow();
  });

  it('wraps the frames as standard ptReal Base64 command entries', () => {
    expect(encodeGoveeEffectCommand(forest)).toEqual({
      msg: {
        cmd: 'ptReal',
        data: {
          command: encodeGoveeEffectFrames(forest).map((bytes) =>
            bytes.toString('base64'),
          ),
        },
      },
    });
  });

  it('fetches the public catalog without an authorization header', async () => {
    const calls: Array<{ url: string; options: RequestInit | undefined }> = [];
    const transport: typeof fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      return Response.json(library());
    };
    expect(await fetchGoveeEffectLibrary('H612A', transport)).toHaveLength(3);
    expect(calls[0]?.url).toBe(
      'https://app2.govee.com/appsku/v1/light-effect-libraries?sku=H612A',
    );
    expect(calls[0]?.options?.headers).toEqual({
      AppVersion: '5.6.01',
      'User-Agent': 'GoveeHome/5.6.01',
    });
  });

  it('rejects failed, malformed and oversized library responses', async () => {
    await expect(
      fetchGoveeEffectLibrary(
        'H612A',
        async () => new Response('', { status: 503 }),
      ),
    ).rejects.toThrow('HTTP 503');
    await expect(
      fetchGoveeEffectLibrary('H612A', async () => new Response('oops')),
    ).rejects.toThrow();
    await expect(
      fetchGoveeEffectLibrary(
        'H612A',
        async () => new Response(' '.repeat(8_000_001)),
      ),
    ).rejects.toThrow('too large');
  });
});
