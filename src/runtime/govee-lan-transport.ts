import { createSocket, type Socket, type RemoteInfo } from 'node:dgram';
import { isIP } from 'node:net';
import { z } from 'zod';

export type GoveeLanTransportConfig = {
  interfaceAddress: string;
  broadcastAddress?: string | undefined;
  devices: readonly { id: string; sku: string; device: string }[];
};

const Byte = z.number().int().min(0).max(255);
const MessageSchema = z.object({
  msg: z.object({ cmd: z.string(), data: z.unknown() }),
});
const ScanSchema = z.object({
  device: z.string(),
  sku: z.string(),
  ip: z.ipv4(),
});
export const GoveeLanStatusSchema = z.object({
  onOff: z.union([z.literal(0), z.literal(1)]),
  brightness: z.number().int().min(0).max(100),
  color: z.object({ r: Byte, g: Byte, b: Byte }),
  colorTemInKelvin: z.number().int().min(0).max(10000),
});
export type GoveeLanStatus = z.infer<typeof GoveeLanStatusSchema>;

export class GoveeLanTransportError extends Error {
  constructor(
    readonly code:
      | 'not_started'
      | 'stopped'
      | 'not_discovered'
      | 'status_timeout'
      | 'busy'
      | 'send_failed'
      | 'socket_error',
  ) {
    super(`Govee LAN ${code}`);
    this.name = 'GoveeLanTransportError';
  }
}

type Dependencies = {
  createSocket?: () => Socket;
  now?: () => number;
  discoveryTimeoutMs?: number;
  statusTimeoutMs?: number;
  sendTimeoutMs?: number;
  bindTimeoutMs?: number;
  cacheTtlMs?: number;
  refreshAfterMs?: number;
  onError?: () => void;
};
type LanDevice = { ip: string; seenAt: number; discoveredAt: number };
type AddressWaiter = {
  promise: Promise<string>;
  resolve: (ip: string) => void;
  reject: (error: Error) => void;
};
type Discovery = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  seen: Set<string>;
  sent: boolean;
  timer: ReturnType<typeof setTimeout>;
};
type StatusJob = {
  resolve: (status: GoveeLanStatus) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  sent: boolean;
  settled: boolean;
};
type StatusQueue = { active?: StatusJob; pending: StatusJob[] };

/**
 * One reply socket for all configured fixtures. Only discovery and status reads
 * are automatic; callers explicitly supply every physical control command.
 *
 * devStatus has no transaction ID. Requests to an IP are serialized and never
 * share a pre-write response, but a late UDP duplicate still cannot be proven to
 * belong to a particular query. Command verification must compare actual values.
 */
export class GoveeLanTransport {
  private readonly socket: Socket;
  private readonly now: () => number;
  private readonly discoveryTimeoutMs: number;
  private readonly statusTimeoutMs: number;
  private readonly sendTimeoutMs: number;
  private readonly bindTimeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly refreshAfterMs: number;
  private readonly devices = new Map<string, LanDevice>();
  private readonly addressWaiters = new Map<string, AddressWaiter>();
  private readonly statusQueues = new Map<string, StatusQueue>();
  private readonly pendingSends = new Set<(error: Error) => void>();
  private statusCount = 0;
  private discovery: Discovery | undefined;
  private startPromise: Promise<void> | undefined;
  private rejectBind: ((error: Error) => void) | undefined;
  private bound = false;
  private stopped = false;

  constructor(
    private readonly config: GoveeLanTransportConfig,
    private readonly dependencies: Dependencies = {},
  ) {
    if (
      isIP(config.interfaceAddress) !== 4 ||
      (config.broadcastAddress !== undefined &&
        isIP(config.broadcastAddress) !== 4) ||
      config.devices.length < 1 ||
      config.devices.length > 64 ||
      new Set(config.devices.map((device) => device.id)).size !==
        config.devices.length
    )
      throw new Error('Invalid Govee LAN transport configuration');
    this.socket = (dependencies.createSocket ?? (() => createSocket('udp4')))();
    this.now = dependencies.now ?? Date.now;
    this.discoveryTimeoutMs = dependencies.discoveryTimeoutMs ?? 1200;
    this.statusTimeoutMs = dependencies.statusTimeoutMs ?? 2000;
    this.sendTimeoutMs = dependencies.sendTimeoutMs ?? 2000;
    this.bindTimeoutMs = dependencies.bindTimeoutMs ?? 2000;
    this.cacheTtlMs = dependencies.cacheTtlMs ?? 60000;
    this.refreshAfterMs = dependencies.refreshAfterMs ?? this.cacheTtlMs / 2;
    for (const duration of [
      this.discoveryTimeoutMs,
      this.statusTimeoutMs,
      this.sendTimeoutMs,
      this.bindTimeoutMs,
      this.cacheTtlMs,
      this.refreshAfterMs,
    ])
      if (!Number.isFinite(duration) || duration <= 0)
        throw new Error('Invalid Govee LAN transport timeout');
    this.socket.on('message', this.onMessage);
    this.socket.on('error', this.onSocketError);
    this.socket.on('close', this.onSocketClose);
  }

  start(): Promise<void> {
    if (this.stopped)
      return Promise.reject(new GoveeLanTransportError('stopped'));
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(
          () => finish(new GoveeLanTransportError('socket_error')),
          this.bindTimeoutMs,
        );
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.rejectBind = undefined;
          if (error) reject(error);
          else resolve();
        };
        this.rejectBind = (error) => finish(error);
        try {
          this.socket.bind(4002, this.config.interfaceAddress, () => {
            if (this.stopped) {
              this.closeSocket();
              return;
            }
            this.bound = true;
            finish();
          });
        } catch {
          finish(new GoveeLanTransportError('socket_error'));
        }
      });
      this.assertRunning();
      this.socket.setMulticastInterface(this.config.interfaceAddress);
      this.socket.setMulticastTTL(1);
      if (this.config.broadcastAddress) this.socket.setBroadcast(true);
      await this.discover();
    })();
    // A failed bind cannot leave an apparently reusable half-started transport.
    void this.startPromise.catch(() => this.stop());
    return this.startPromise;
  }

  /** A shared bounded scan; it finishes early when every configured ID replies. */
  discover(): Promise<void> {
    try {
      this.assertRunning();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.discovery) return this.discovery.promise;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    const scan: Discovery = {
      promise,
      resolve,
      reject,
      seen: new Set(),
      sent: false,
      timer: setTimeout(
        () => this.finishDiscovery(scan),
        this.discoveryTimeoutMs,
      ),
    };
    this.discovery = scan;
    const command = {
      msg: { cmd: 'scan', data: { account_topic: 'reserve' } },
    };
    const sends = [this.send('239.255.255.250', command, 4001)];
    if (this.config.broadcastAddress)
      sends.push(this.send(this.config.broadcastAddress, command, 4001));
    void Promise.allSettled(sends).then((results) => {
      if (this.discovery !== scan) return;
      if (results.every((result) => result.status === 'rejected')) {
        this.finishDiscovery(scan, new GoveeLanTransportError('send_failed'));
        return;
      }
      scan.sent = true;
      if (scan.seen.size === this.config.devices.length)
        this.finishDiscovery(scan);
    });
    return promise;
  }

  /** Fresh identity evidence is required after the cache's hard deadline. */
  address(id: string): Promise<string> {
    try {
      this.assertRunning();
      if (!this.config.devices.some((device) => device.id === id))
        throw new GoveeLanTransportError('not_discovered');
    } catch (error) {
      return Promise.reject(error);
    }
    const found = this.devices.get(id);
    const age = found ? this.now() - found.seenAt : Infinity;
    const identityAge = found ? this.now() - found.discoveredAt : Infinity;
    if (
      found &&
      age >= 0 &&
      age < this.cacheTtlMs &&
      identityAge >= 0 &&
      identityAge < this.cacheTtlMs
    ) {
      // Status carries no identity. Even frequently polled peers need periodic
      // identity scans so a DHCP reassignment cannot keep an old mapping alive.
      if (identityAge >= this.refreshAfterMs)
        void this.discover().catch(() => undefined);
      return Promise.resolve(found.ip);
    }
    const existing = this.addressWaiters.get(id);
    if (existing) return existing.promise;
    let resolve!: (ip: string) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    const waiter = { promise, resolve, reject };
    this.addressWaiters.set(id, waiter);
    void this.discover().then(
      () => {
        if (this.addressWaiters.get(id) !== waiter) return;
        this.addressWaiters.delete(id);
        reject(new GoveeLanTransportError('not_discovered'));
      },
      () => {
        if (this.addressWaiters.get(id) !== waiter) return;
        this.addressWaiters.delete(id);
        reject(new GoveeLanTransportError('send_failed'));
      },
    );
    return promise;
  }

  /** A new wire query per call, serialized per IP; never a cached snapshot. */
  status(ip: string): Promise<GoveeLanStatus> {
    try {
      this.assertRunning();
      if (isIP(ip) !== 4) throw new Error('Invalid Govee device address');
    } catch (error) {
      return Promise.reject(error);
    }
    const queue = this.statusQueues.get(ip) ?? { pending: [] };
    if (
      queue.pending.length + (queue.active ? 1 : 0) >= 8 ||
      this.statusCount >= 64
    )
      return Promise.reject(new GoveeLanTransportError('busy'));
    this.statusQueues.set(ip, queue);
    this.statusCount++;
    return new Promise<GoveeLanStatus>((resolve, reject) => {
      queue.pending.push({ resolve, reject, sent: false, settled: false });
      this.pumpStatus(ip, queue);
    });
  }

  /** A timed-out cached peer gets one identity refresh and one fresh read retry. */
  async ensureReachable(
    id: string,
  ): Promise<{ ip: string; status: GoveeLanStatus }> {
    const ip = await this.address(id);
    try {
      const status = await this.status(ip);
      if (this.devices.get(id)?.ip !== ip)
        throw new GoveeLanTransportError('not_discovered');
      return { ip, status };
    } catch (error) {
      if (
        !(error instanceof GoveeLanTransportError) ||
        !['status_timeout', 'send_failed', 'not_discovered'].includes(
          error.code,
        )
      )
        throw error;
      this.assertRunning();
      if (this.devices.get(id)?.ip === ip) this.devices.delete(id);
      const rediscovered = await this.address(id);
      const status = await this.status(rediscovered);
      if (this.devices.get(id)?.ip !== rediscovered)
        throw new GoveeLanTransportError('not_discovered');
      return { ip: rediscovered, status };
    }
  }

  async send(ip: string, command: unknown, port = 4003): Promise<void> {
    this.assertRunning();
    if (this.pendingSends.size >= 64) throw new GoveeLanTransportError('busy');
    if (isIP(ip) !== 4 || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('Invalid Govee destination');
    const json = JSON.stringify(command);
    if (json === undefined) throw new Error('Invalid Govee command');
    const bytes = Buffer.from(json);
    if (bytes.length > 60000) throw new Error('Command too large');
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () => finish(new GoveeLanTransportError('send_failed')),
        this.sendTimeoutMs,
      );
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingSends.delete(cancel);
        if (error) reject(error);
        else resolve();
      };
      const cancel = (error: Error) => finish(error);
      this.pendingSends.add(cancel);
      try {
        this.socket.send(bytes, port, ip, (error) =>
          finish(error ? new GoveeLanTransportError('send_failed') : undefined),
        );
      } catch {
        finish(new GoveeLanTransportError('send_failed'));
      }
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.bound = false;
    this.socket.off('message', this.onMessage);
    this.rejectOutstanding(new GoveeLanTransportError('stopped'));
    this.closeSocket();
  }

  private assertRunning(): void {
    if (this.stopped) throw new GoveeLanTransportError('stopped');
    if (!this.bound) throw new GoveeLanTransportError('not_started');
  }

  private finishDiscovery(scan: Discovery, error?: Error): void {
    if (this.discovery !== scan) return;
    this.discovery = undefined;
    clearTimeout(scan.timer);
    if (error) scan.reject(error);
    else scan.resolve();
  }

  private readonly onMessage = (bytes: Buffer, peer: RemoteInfo): void => {
    if (this.stopped || bytes.length > 16384) return;
    try {
      const parsed = MessageSchema.safeParse(JSON.parse(bytes.toString()));
      if (!parsed.success) return;
      const { cmd, data } = parsed.data.msg;
      if (cmd === 'scan') {
        const scan = ScanSchema.safeParse(data);
        if (!scan.success || scan.data.ip !== peer.address) return;
        const match = this.config.devices.find(
          (device) =>
            device.device.toUpperCase() === scan.data.device.toUpperCase() &&
            device.sku === scan.data.sku,
        );
        if (!match) return;
        // DHCP may reuse an old fixture's address for another configured fixture.
        for (const [id, known] of this.devices)
          if (id !== match.id && known.ip === peer.address)
            this.devices.delete(id);
        const now = this.now();
        this.devices.set(match.id, {
          ip: peer.address,
          seenAt: now,
          discoveredAt: now,
        });
        const waiter = this.addressWaiters.get(match.id);
        if (waiter) {
          this.addressWaiters.delete(match.id);
          waiter.resolve(peer.address);
        }
        if (this.discovery) {
          this.discovery.seen.add(match.id);
          if (
            this.discovery.sent &&
            this.discovery.seen.size === this.config.devices.length
          )
            this.finishDiscovery(this.discovery);
        }
      } else if (cmd === 'devStatus') {
        const status = GoveeLanStatusSchema.safeParse(data);
        if (!status.success) return;
        for (const known of this.devices.values())
          if (known.ip === peer.address) known.seenAt = this.now();
        const queue = this.statusQueues.get(peer.address);
        const active = queue?.active;
        if (queue && active?.sent)
          this.finishStatus(
            peer.address,
            queue,
            active,
            undefined,
            status.data,
          );
      }
    } catch {
      // UDP framing and unconfigured local traffic are untrusted input.
    }
  };

  private pumpStatus(ip: string, queue: StatusQueue): void {
    if (this.stopped || this.statusQueues.get(ip) !== queue || queue.active)
      return;
    const job = queue.pending.shift();
    if (!job) {
      this.statusQueues.delete(ip);
      return;
    }
    queue.active = job;
    job.timer = setTimeout(
      () =>
        this.finishStatus(
          ip,
          queue,
          job,
          new GoveeLanTransportError('status_timeout'),
        ),
      this.statusTimeoutMs,
    );
    job.sent = true;
    void this.send(ip, { msg: { cmd: 'devStatus', data: {} } }).catch(() =>
      this.finishStatus(
        ip,
        queue,
        job,
        new GoveeLanTransportError('send_failed'),
      ),
    );
  }

  private finishStatus(
    ip: string,
    queue: StatusQueue,
    job: StatusJob,
    error?: Error,
    status?: GoveeLanStatus,
  ): void {
    if (job.settled) return;
    job.settled = true;
    if (job.timer !== undefined) clearTimeout(job.timer);
    this.statusCount--;
    if (queue.active === job) delete queue.active;
    else queue.pending = queue.pending.filter((candidate) => candidate !== job);
    if (error) job.reject(error);
    else if (status) job.resolve(status);
    queueMicrotask(() => this.pumpStatus(ip, queue));
  }

  private rejectOutstanding(error: Error): void {
    this.rejectBind?.(error);
    this.rejectBind = undefined;
    if (this.discovery) this.finishDiscovery(this.discovery, error);
    for (const waiter of this.addressWaiters.values()) waiter.reject(error);
    this.addressWaiters.clear();
    for (const [ip, queue] of this.statusQueues) {
      if (queue.active) this.finishStatus(ip, queue, queue.active, error);
      for (const job of [...queue.pending])
        this.finishStatus(ip, queue, job, error);
    }
    this.statusQueues.clear();
    for (const cancel of [...this.pendingSends]) cancel(error);
  }

  private readonly onSocketError = (): void => {
    this.rejectOutstanding(new GoveeLanTransportError('socket_error'));
    try {
      this.dependencies.onError?.();
    } catch {
      // A diagnostic callback cannot strand outstanding network operations.
    }
  };

  private readonly onSocketClose = (): void => {
    this.bound = false;
    if (!this.stopped) {
      this.stopped = true;
      this.rejectOutstanding(new GoveeLanTransportError('socket_error'));
    }
  };

  private closeSocket(): void {
    try {
      this.socket.close();
    } catch {
      // Closing a socket whose bind failed (or has not completed) throws.
    }
  }
}
