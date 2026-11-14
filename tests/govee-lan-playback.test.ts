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
    expect(p.wait).toHaveBeenCalledTimes(2);
  });
  it('allows a physical ON taking 410 ms even when UDP status replies are immediate', async () => {
    const p = port([0]);
    const initial = await p.status();
    let elapsed = 0;
    p.status.mockImplementation(async () => ({
      ...initial,
      onOff: elapsed >= 410 ? 1 : 0,
    }));
    const wait = vi.fn(async (ms: number) => {
      elapsed += ms;
    });
    await sendGoveeLanEffect('192.0.2.2', effect, { ...p, wait }, true);
    expect(elapsed).toBe(600);
    expect(
      p.send.mock.calls.map((x) => (x[1] as { msg: { cmd: string } }).msg.cmd),
    ).toEqual(['turn', 'ptReal']);
  });
  it('does not send an effect if permission is revoked during activation settling', async () => {
    const p = port([0, 1]);
    let current = true;
    p.guard = vi.fn(async () => {
      if (!current) throw new Error('exit');
    });
    await expect(
      sendGoveeLanEffect(
        '192.0.2.2',
        effect,
        {
          ...p,
          wait: async () => {
            current = false;
          },
        },
        true,
      ),
    ).rejects.toThrow('exit');
    expect(p.send).toHaveBeenCalledOnce();
    expect(p.send.mock.calls[0]?.[1]).toMatchObject({ msg: { cmd: 'turn' } });
    expect(p.status).toHaveBeenCalledOnce();
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
    let current = true;
    const status = p.status;
    p.status = vi.fn(async () => {
      const value = await status();
      current = false;
      return value;
    });
    p.guard = vi.fn(async () => {
      if (!current) throw new Error('exit');
    });
    await expect(
      sendGoveeLanEffect('192.0.2.2', effect, p, true),
    ).rejects.toThrow('exit');
    expect(p.send).not.toHaveBeenCalled();
  });
  it('reuses a corroborated same-command ON preflight without another read', async () => {
    const p = port([1]);
    const initialStatus = await p.status();
    p.status.mockClear();
    await sendGoveeLanEffect(
      '192.0.2.2',
      effect,
      { ...p, initialStatus },
      true,
    );
    expect(p.status).not.toHaveBeenCalled();
    expect(p.send).toHaveBeenCalledTimes(1);
  });
  it('does not globally activate an engine scene whose baseline is already managed', async () => {
    const p = port([0]);
    await sendGoveeLanEffect('192.0.2.2', effect, p);
    expect(p.status).not.toHaveBeenCalled();
    expect(p.send).toHaveBeenCalledTimes(1);
  });
  it('rejects mode-only native OFF even while the engine guard still permits ON', async () => {
    const p = port([0]);
    await expect(
      sendGoveeLanEffect('192.0.2.2', effect, { ...p, requireOn: true }, true),
    ).rejects.toThrow('requires native ON');
    expect(p.status).toHaveBeenCalledOnce();
    expect(p.send).not.toHaveBeenCalled();
    expect(p.wait).not.toHaveBeenCalled();
  });
  it('sends only the scene for a mode-only native ON snapshot', async () => {
    const p = port([1]);
    await sendGoveeLanEffect('192.0.2.2', effect, {
      ...p,
      requireOn: true,
    });
    expect(p.status).toHaveBeenCalledOnce();
    expect(p.send).toHaveBeenCalledOnce();
    expect(p.send.mock.calls[0]?.[1]).toMatchObject({ msg: { cmd: 'ptReal' } });
  });
  it('uses a same-command mode-only preflight without issuing a duplicate status query', async () => {
    const p = port([1]);
    const initialStatus = await p.status();
    p.status.mockClear();
    await sendGoveeLanEffect('192.0.2.2', effect, {
      ...p,
      initialStatus,
      requireOn: true,
    });
    expect(p.status).not.toHaveBeenCalled();
    expect(p.send).toHaveBeenCalledOnce();
  });
  it('honors revocation while awaiting the mode-only native status reply', async () => {
    const p = port([1]);
    let current = true;
    const status = p.status;
    p.status = vi.fn(async () => {
      const result = await status();
      current = false;
      return result;
    });
    p.guard = vi.fn(async () => {
      if (!current) throw new Error('exit');
    });
    await expect(
      sendGoveeLanEffect('192.0.2.2', effect, { ...p, requireOn: true }),
    ).rejects.toThrow('exit');
    expect(p.send).not.toHaveBeenCalled();
  });
});
