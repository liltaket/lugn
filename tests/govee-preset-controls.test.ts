import { describe, expect, it, vi } from 'vitest';
import {
  combineGoveePresetControls,
  type GoveePresetControls,
} from '../src/runtime/govee-preset-controls.js';
describe('complementary Govee scene transports', () => {
  const target = 'lighting.ceiling';
  function fixture() {
    const local: GoveePresetControls = {
      capabilities: () => ({ [target]: { effects: ['Forest'], zones: false } }),
      apply: vi.fn(async () => ({
        transport: 'lan' as const,
        effect: 'udp_sent' as const,
      })),
    };
    const platform: GoveePresetControls = {
      capabilities: () => ({
        [target]: {
          effects: [],
          zones: true,
          colorTemperature: { min: 2700, max: 6500 },
        },
      }),
      apply: vi.fn(async () => ({
        transport: 'platform' as const,
        zones: 'cloud_accepted' as const,
      })),
    };
    return {
      local,
      platform,
      controls: combineGoveePresetControls(local, platform),
    };
  }
  it('retains local effects while adding verified API zones and Kelvin bounds', () => {
    expect(fixture().controls.capabilities()[target]).toEqual({
      effects: ['Forest'],
      zones: true,
      colorTemperature: { min: 2700, max: 6500 },
    });
  });
  it('routes a non-LAN static color reset to the verified platform transport', async () => {
    const f = fixture();
    f.local.capabilities = () => ({});
    f.platform.capabilities = () => ({
      [target]: { effects: ['Party'], zones: false, staticColor: true },
    });
    expect(f.controls.capabilities()[target]?.staticColor).toBe(true);
    const command = {
      target,
      requestId: 'r',
      controlId: 'g',
      staticColor: { rgb: [1, 2, 3] as [number, number, number] },
    };
    await f.controls.apply(command, async () => undefined);
    expect(f.platform.apply).toHaveBeenCalledWith(
      command,
      expect.any(Function),
    );
    expect(f.local.apply).not.toHaveBeenCalled();
  });
  it('applies fixture animation before its final zone mask', async () => {
    const f = fixture();
    const order: string[] = [];
    f.local.apply = vi.fn(async () => {
      order.push('effect');
      return { transport: 'lan' as const, effect: 'udp_sent' as const };
    });
    f.platform.apply = vi.fn(async () => {
      order.push('zones');
      return {
        transport: 'platform' as const,
        zones: 'cloud_accepted' as const,
      };
    });
    const result = await f.controls.apply(
      {
        target,
        requestId: 'r',
        controlId: 'g',
        effect: 'Forest',
        zones: { main: false, ring: true },
      },
      async () => undefined,
    );
    expect(order).toEqual(['effect', 'zones']);
    expect(result).toEqual({
      transport: 'mixed',
      effect: 'udp_sent',
      zones: 'cloud_accepted',
    });
  });
  it('does not apply a delayed mask after ownership changes during the effect write', async () => {
    const f = fixture();
    let current = true;
    f.local.apply = async () => {
      current = false;
      return { transport: 'lan' as const, effect: 'udp_sent' as const };
    };
    await expect(
      f.controls.apply(
        {
          target,
          requestId: 'r',
          controlId: 'g',
          effect: 'Forest',
          zones: { main: false, ring: true },
        },
        async () => {
          if (!current) throw new Error('superseded');
        },
      ),
    ).rejects.toThrow('superseded');
    expect(f.platform.apply).not.toHaveBeenCalled();
  });
  it('preserves the mode-only restriction across both effect and zone transports', async () => {
    const f = fixture();
    await f.controls.apply(
      {
        target,
        requestId: 'r',
        controlId: 'g',
        effect: 'Forest',
        zones: { main: false, ring: true },
        modeOnly: true,
      },
      async () => undefined,
    );
    expect(f.local.apply).toHaveBeenCalledWith(
      expect.objectContaining({ effect: 'Forest', modeOnly: true }),
      expect.any(Function),
    );
    expect(f.platform.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        zones: { main: false, ring: true },
        modeOnly: true,
      }),
      expect.any(Function),
    );
  });
});
