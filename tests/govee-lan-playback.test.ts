import { describe, expect, it, vi } from 'vitest';
import { sendGoveeLanEffect } from '../src/runtime/govee-lan-playback.js';
import type { GoveeEffect } from '../src/adapters/govee-lan-effects.js';

const effect: GoveeEffect = {
  sku: 'H612A',
  id: 'forest',
  name: 'Forest',
  category: 'Natural',
  sceneCode: 212,
  sceneType: 2,
  sceneParam: '',
  variant: 1,
};
function port(powers: number[]) {
  return {
    guard: vi.fn(async () => undefined),
    status: vi.fn(
      async () =>
        ({
          onOff: powers.length > 1 ? powers.shift()! : powers[0]!,
          brightness: 10,
          color: { r: 0, g: 0, b: 0 },
          colorTemInKelvin: 2700,
        }) as {
          onOff: 0 | 1;
          brightness: number;
          color: { r: number; g: number; b: number };
          colorTemInKelvin: number;
        },
    ),
    send: vi.fn<(ip: string, command: unknown) => Promise<void>>(
      async () => undefined,
    ),
    wait: vi.fn(async () => undefined),
  };
}
describe('guarded native Govee activation', () => {
  it('skips redundant whole-fixture ON when already on', async () => {
    const p = port([1]);
    await sendGoveeLanEffect('192.0.2.2', effect, p, true);
    expect(p.send).toHaveBeenCalledTimes(1);
    expect(p.send.mock.calls[0]?.[1]).toMatchObject({ msg: { cmd: 'ptReal' } });
  });
  it('requires observed ON before sending an animation after native activation', async () => {
    const p = port([0, 0, 1]);
    await sendGoveeLanEffect('192.0.2.2', effect, p, true);
    expect(
      p.send.mock.calls.map((x) => (x[1] as { msg: { cmd: string } }).msg.cmd),
    ).toEqual(['turn', 'ptReal']);
    expect(p.wait).toHaveBeenCalledTimes(1);
  });
  it('does not retry an unconfirmed power write or send the scene', async () => {
    const p = port([0]);
    await expect(
      sendGoveeLanEffect('192.0.2.2', effect, p, true),
    ).rejects.toThrow('unconfirmed');
    expect(p.send).toHaveBeenCalledTimes(1);
    expect(p.send.mock.calls[0]?.[1]).toMatchObject({ msg: { cmd: 'turn' } });
  });
  it('honors a revoked grant after an asynchronous status reply', async () => {
    const p = port([0]);
    p.guard
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('exit'));
    await expect(
      sendGoveeLanEffect('192.0.2.2', effect, p, true),
    ).rejects.toThrow('exit');
    expect(p.send).not.toHaveBeenCalled();
  });
  it('does not globally activate an engine scene whose baseline is already managed', async () => {
    const p = port([0]);
    await sendGoveeLanEffect('192.0.2.2', effect, p);
    expect(p.status).not.toHaveBeenCalled();
    expect(p.send).toHaveBeenCalledTimes(1);
  });
});
