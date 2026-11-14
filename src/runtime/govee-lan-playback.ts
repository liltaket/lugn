import {
  encodeGoveeEffectCommand,
  type GoveeEffect,
} from '../adapters/govee-lan-effects.js';
import type { GoveeLanStatus } from './govee-lan-transport.js';

/** Native power is used only under an explicit, live activation grant. */
export async function sendGoveeLanEffect(
  ip: string,
  effect: GoveeEffect,
  port: {
    guard(): Promise<void>;
    status(ip: string): Promise<GoveeLanStatus>;
    send(ip: string, command: unknown): Promise<void>;
    wait?: (ms: number) => Promise<void>;
    /** A same-command preflight, bounded by the caller and corroborated by HA power. */
    initialStatus?: GoveeLanStatus;
  },
  activate = false,
): Promise<void> {
  const command = encodeGoveeEffectCommand(effect);
  if (activate) {
    let status = port.initialStatus ?? (await port.status(ip));
    if (status.onOff === 0) {
      await port.guard();
      await port.send(ip, { msg: { cmd: 'turn', data: { value: 1 } } });
      for (let attempt = 0; attempt < 3; attempt++) {
        await port.guard();
        status = await port.status(ip);
        if (status.onOff === 1) break;
        if (attempt < 2)
          await (
            port.wait ?? ((ms) => new Promise((ok) => setTimeout(ok, ms)))
          )(80);
      }
      if (status.onOff !== 1)
        throw new Error('Govee native activation unconfirmed');
    }
  }
  await port.guard();
  // Scene uploads are never blindly retried: their active state is not readable.
  await port.send(ip, command);
}
