import { EventEmitter } from 'node:events';
import type { Socket } from 'node:dgram';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GoveeLanTransport,
  GoveeLanTransportError,
  type GoveeLanStatus,
  type GoveeLanTransportConfig,
} from '../src/runtime/govee-lan-transport.js';

const config: GoveeLanTransportConfig = {
  interfaceAddress: '192.168.10.132',
  broadcastAddress: '192.168.10.255',
  devices: [
    { id: 'strip', sku: 'H612A', device: 'AA:BB:CC:DD:EE:FF:00:01' },
    { id: 'ceiling', sku: 'H60A6', device: 'AA:BB:CC:DD:EE:FF:00:02' },
  ],
};
const ips = ['192.168.10.158', '192.168.10.180'];
const goodStatus = (brightness = 20): GoveeLanStatus => ({
  onOff: 1,
  brightness,
  color: { r: 255, g: 100, b: 0 },
  colorTemInKelvin: 4000,
});
type Packet = {
  ip: string;
  port: number;
  msg: { cmd: string; data: unknown };
};
class FakeSocket extends EventEmitter {
  readonly sent: Packet[] = [];
  readonly bind = vi.fn((_port: number, _ip: string, callback: () => void) => {
    callback();
    return this;
  });
  readonly setMulticastInterface = vi.fn(() => this);
  readonly setMulticastTTL = vi.fn(() => this);
  readonly setBroadcast = vi.fn(() => this);
  readonly close = vi.fn(() => {
    this.emit('close');
    return this;
  });
  onSend: (packet: Packet) => void = () => undefined;
  holdSends = false;
  failSends = false;
  failForIps = new Set<string>();
  readonly callbacks: Array<(error: Error | null) => void> = [];
  send(
    bytes: Buffer,
    port: number,
    ip: string,
    callback: (error: Error | null) => void,
  ): void {
    const packet = { ip, port, ...JSON.parse(bytes.toString()) } as Packet;
    this.sent.push(packet);
    if (this.holdSends) this.callbacks.push(callback);
    else
      callback(
        this.failSends || this.failForIps.has(ip)
          ? new Error('fixture socket failure')
          : null,
      );
    this.onSend(packet);
  }
  receive(ip: string, cmd: string, data: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify({ msg: { cmd, data } })), {
      address: ip,
      family: 'IPv4',
      port: 4001,
      size: 100,
    });
  }
  scans(indexes = [0, 1]): void {
    for (const index of indexes)
      this.receive(ips[index]!, 'scan', {
        device: config.devices[index]!.device.toLowerCase(),
        sku: config.devices[index]!.sku,
        ip: ips[index],
      });
  }
  count(cmd: string): number {
    return this.sent.filter((packet) => packet.msg.cmd === cmd).length;
  }
}
const transports: GoveeLanTransport[] = [];
function fixture() {
  vi.useFakeTimers();
  const socket = new FakeSocket();
  socket.onSend = (packet) => {
    if (packet.msg.cmd === 'scan') socket.scans();
  };
  const transport = new GoveeLanTransport(config, {
    createSocket: () => socket as unknown as Socket,
  });
  transports.push(transport);
  return { socket, transport };
}
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
afterEach(() => {
  for (const transport of transports.splice(0)) transport.stop();
  vi.useRealTimers();
});

describe('Govee LAN discovery', () => {
  it('binds the existing reply port and finishes as soon as all configured devices reply', async () => {
    const { socket, transport } = fixture();
    await transport.start();
    expect(socket.bind).toHaveBeenCalledWith(
      4002,
      config.interfaceAddress,
      expect.any(Function),
    );
    expect(socket.setMulticastInterface).toHaveBeenCalledWith(
      config.interfaceAddress,
    );
    expect(socket.setMulticastTTL).toHaveBeenCalledWith(1);
    expect(socket.setBroadcast).toHaveBeenCalledWith(true);
    expect(socket.sent.map(({ ip, port }) => [ip, port])).toEqual([
      ['239.255.255.250', 4001],
      [config.broadcastAddress, 4001],
    ]);
    expect(vi.getTimerCount()).toBe(0);
    expect(await transport.address('ceiling')).toBe(ips[1]);
  });

  it('resolves a stale target on its first identity reply without waiting for other lamps', async () => {
    const { socket, transport } = fixture();
    await transport.start();
    socket.onSend = () => undefined;
    await vi.advanceTimersByTimeAsync(60001);
    const address = transport.address('ceiling');
    await flush();
    expect(socket.count('scan')).toBe(4);
    socket.scans([1]);
    expect(await address).toBe(ips[1]);
    // The shared scan can continue collecting the other fixture in the background.
    expect(vi.getTimerCount()).toBe(1);
    transport.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('continues when broadcast discovery works but multicast cannot be sent', async () => {
    const { socket, transport } = fixture();
    socket.failForIps.add('239.255.255.250');
    socket.onSend = (packet) => {
      if (packet.ip === config.broadcastAddress) socket.scans();
    };
    await transport.start();
    expect(await transport.address('ceiling')).toBe(ips[1]);
    expect(socket.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares background refresh and returns a still-valid cached address immediately', async () => {
    const { socket, transport } = fixture();
    await transport.start();
    socket.onSend = () => undefined;
    await vi.advanceTimersByTimeAsync(30001);
    const a = transport.address('strip'),
      b = transport.address('ceiling');
    expect(await a).toBe(ips[0]);
    expect(await b).toBe(ips[1]);
    expect(socket.count('scan')).toBe(4);
    const scan = transport.discover();
    expect(transport.discover()).toBe(scan);
    await vi.advanceTimersByTimeAsync(1200);
    await scan;
  });

  it('does not let frequent status extend identity freshness indefinitely', async () => {
    const { socket, transport } = fixture();
    await transport.start();
    socket.onSend = () => undefined;
    await vi.advanceTimersByTimeAsync(59000);
    socket.receive(ips[0]!, 'devStatus', goodStatus());
    socket.receive(ips[1]!, 'devStatus', { ...goodStatus(), brightness: 101 });
    expect(await transport.address('strip')).toBe(ips[0]);
    // Liveness must not suppress background identity refresh.
    expect(socket.count('scan')).toBe(4);
    await vi.advanceTimersByTimeAsync(2000);
    const strip = transport.address('strip');
    socket.scans([0]);
    expect(await strip).toBe(ips[0]);
    const missing = transport.address('ceiling');
    const assertion = expect(missing).rejects.toMatchObject({
      code: 'not_discovered',
    });
    await vi.advanceTimersByTimeAsync(1200);
    await assertion;
  });

  it('does not accept a scan with a different ID, SKU or claimed source IP', async () => {
    const { socket, transport } = fixture();
    await transport.start();
    socket.onSend = () => undefined;
    await vi.advanceTimersByTimeAsync(60001);
    const missing = transport.address('ceiling');
    const assertion = expect(missing).rejects.toMatchObject({
      code: 'not_discovered',
    });
    const identity = config.devices[1]!;
    socket.receive(ips[1]!, 'scan', { ...identity, ip: ips[0] });
    socket.receive(ips[1]!, 'scan', { ...identity, ip: ips[1], sku: 'H6022' });
    socket.receive(ips[1]!, 'scan', {
      ...identity,
      ip: ips[1],
      device: config.devices[0]!.device,
    });
    await vi.advanceTimersByTimeAsync(1200);
    await assertion;
  });

  it('evicts an old identity when DHCP assigns its address to another configured device', async () => {
    const { socket, transport } = fixture();
    await transport.start();
    socket.onSend = () => undefined;
    socket.receive(ips[0]!, 'scan', { ...config.devices[1], ip: ips[0] });
    expect(await transport.address('ceiling')).toBe(ips[0]);
    const missing = transport.address('strip');
    const assertion = expect(missing).rejects.toMatchObject({
      code: 'not_discovered',
    });
    await vi.advanceTimersByTimeAsync(1200);
    await assertion;
  });
});

describe('Govee LAN status reads', () => {
  it('uses one new query per call and serializes reads to the same IP', async () => {
    const { socket, transport } = fixture();
    await transport.start();
    const first = transport.status(ips[0]!),
      second = transport.status(ips[0]!);
    expect(socket.count('devStatus')).toBe(1);
    socket.receive(ips[0]!, 'devStatus', goodStatus(10));
    expect(await first).toEqual(goodStatus(10));
    await flush();
    expect(socket.count('devStatus')).toBe(2);
    let resolved = false;
    void second.then(() => {
      resolved = true;
    });
    await flush();
    expect(resolved).toBe(false);
    socket.receive(ips[0]!, 'devStatus', goodStatus(11));
    expect(await second).toEqual(goodStatus(11));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets unrelated device reads progress concurrently', async () => {
    const { socket, transport } = fixture();
    await transport.start();
    const first = transport.status(ips[0]!),
      second = transport.status(ips[1]!);
    expect(socket.count('devStatus')).toBe(2);
    socket.receive(ips[1]!, 'devStatus', goodStatus(22));
    expect(await second).toEqual(goodStatus(22));
    socket.receive(ips[0]!, 'devStatus', goodStatus(33));
    expect(await first).toEqual(goodStatus(33));
  });

  it('ignores malformed or unrelated status until a valid requested peer replies', async () => {
    const { socket, transport } = fixture();
    await transport.start();
    const status = transport.status(ips[0]!);
    let resolved = false;
    void status.then(() => {
      resolved = true;
    });
    for (const invalid of [
      {},
      { ...goodStatus(), onOff: 2 },
      { ...goodStatus(), brightness: -1 },
      { ...goodStatus(), brightness: 20.5 },
      { ...goodStatus(), color: { r: 256, g: 0, b: 0 } },
      { ...goodStatus(), colorTemInKelvin: 10001 },
    ])
      socket.receive(ips[0]!, 'devStatus', invalid);
    socket.receive(ips[1]!, 'devStatus', goodStatus());
    socket.receive(ips[0]!, 'ptReal', goodStatus());
    socket.emit('message', Buffer.from('{'), { address: ips[0] });
    socket.emit('message', Buffer.alloc(16385), { address: ips[0] });
    await flush();
    expect(resolved).toBe(false);
    socket.receive(ips[0]!, 'devStatus', goodStatus());
    expect(await status).toEqual(goodStatus());
  });

  it('times out and advances the queue without leaking the earlier listener', async () => {
    const { socket, transport } = fixture();
    await transport.start();
    const first = transport.status(ips[0]!),
      second = transport.status(ips[0]!);
    const assertion = expect(first).rejects.toMatchObject({
      code: 'status_timeout',
    });
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(socket.count('devStatus')).toBe(2);
    socket.receive(ips[0]!, 'devStatus', goodStatus(21));
    expect(await second).toEqual(goodStatus(21));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds per-IP waiters and rejects them immediately on stop', async () => {
    const { socket, transport } = fixture();
    await transport.start();
    const reads = Array.from({ length: 8 }, () => transport.status(ips[0]!));
    const outcomes = Promise.allSettled(reads);
    await expect(transport.status(ips[0]!)).rejects.toMatchObject({
      code: 'busy',
    });
    transport.stop();
    expect(
      (await outcomes).every(
        (outcome) =>
          outcome.status === 'rejected' && outcome.reason.code === 'stopped',
      ),
    ).toBe(true);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    transport.stop();
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it('rediscoveries a timed-out cached device and retries its new address once', async () => {
    const { socket, transport } = fixture();
    await transport.start();
    const movedIp = '192.168.10.190';
    socket.onSend = (packet) => {
      if (packet.msg.cmd === 'scan')
        socket.receive(movedIp, 'scan', { ...config.devices[0], ip: movedIp });
      if (packet.msg.cmd === 'devStatus' && packet.ip === movedIp)
        socket.receive(movedIp, 'devStatus', goodStatus(44));
    };
    const reachable = transport.ensureReachable('strip');
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await reachable).toEqual({ ip: movedIp, status: goodStatus(44) });
    expect(
      socket.sent
        .filter((packet) => packet.msg.cmd === 'devStatus')
        .map((packet) => packet.ip),
    ).toEqual([ips[0], movedIp]);
  });

  it('does not return a valid status from an address reassigned to another identity mid-query', async () => {
    const { socket, transport } = fixture();
    await transport.start();
    const movedIp = '192.168.10.190';
    const reachable = transport.ensureReachable('strip');
    await flush();
    socket.receive(ips[0]!, 'scan', { ...config.devices[1], ip: ips[0] });
    socket.onSend = (packet) => {
      if (packet.msg.cmd === 'scan')
        socket.receive(movedIp, 'scan', { ...config.devices[0], ip: movedIp });
      if (packet.msg.cmd === 'devStatus' && packet.ip === movedIp)
        socket.receive(movedIp, 'devStatus', goodStatus(45));
    };
    socket.receive(ips[0]!, 'devStatus', goodStatus(99));
    expect(await reachable).toEqual({ ip: movedIp, status: goodStatus(45) });
  });
});

describe('Govee LAN lifecycle', () => {
  it('rejects pending discovery, status and sends on a socket error and can retry later reads', async () => {
    const { socket, transport } = fixture();
    await transport.start();
    socket.onSend = () => undefined;
    await vi.advanceTimersByTimeAsync(60001);
    const address = transport.address('strip');
    const status = transport.status(ips[1]!);
    socket.holdSends = true;
    const send = transport.send(ips[1]!, { msg: { cmd: 'test', data: {} } });
    const outcomes = Promise.allSettled([address, status, send]);
    socket.emit('error', new Error('fixture error'));
    expect(
      (await outcomes).every(
        (result) =>
          result.status === 'rejected' && result.reason.code === 'socket_error',
      ),
    ).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    socket.holdSends = false;
    const fresh = transport.status(ips[1]!);
    socket.receive(ips[1]!, 'devStatus', goodStatus());
    expect(await fresh).toEqual(goodStatus());
  });

  it('bounds missing send callbacks and safely ignores a callback arriving after stop', async () => {
    const { socket, transport } = fixture();
    await transport.start();
    socket.holdSends = true;
    const pending = transport.send(ips[0]!, { msg: { cmd: 'test', data: {} } });
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'send_failed',
    });
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    transport.stop();
    for (const callback of socket.callbacks) callback(null);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not leave start pending when stopped while bind is incomplete', async () => {
    const { socket, transport } = fixture();
    let bound: (() => void) | undefined;
    socket.bind.mockImplementation((_port, _ip, callback) => {
      bound = callback;
      return socket;
    });
    const start = transport.start();
    const assertion = expect(start).rejects.toBeInstanceOf(
      GoveeLanTransportError,
    );
    transport.stop();
    await assertion;
    bound?.();
    expect(socket.count('scan')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await expect(transport.start()).rejects.toMatchObject({ code: 'stopped' });
  });

  it('bounds a bind that never completes and closes the half-started transport', async () => {
    const { socket, transport } = fixture();
    socket.bind.mockImplementation(() => socket);
    const assertion = expect(transport.start()).rejects.toMatchObject({
      code: 'socket_error',
    });
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
