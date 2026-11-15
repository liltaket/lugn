import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, unlink } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { GoveeStaticColorSchema } from '../core/schemas.js';

const Target = z.string().regex(/^lighting\.[a-z0-9_]{1,80}$/);
const Token = z.string().regex(/^[A-Za-z0-9:_.\/-]{1,128}$/);
const CapabilitySchema = z
  .object({
    effects: z.array(z.string().min(1).max(255)).max(4096),
    zones: z.boolean(),
    staticColor: z.boolean().optional(),
    colorTemperature: z
      .object({ min: z.number().positive(), max: z.number().positive() })
      .strict()
      .refine((range) => range.min <= range.max)
      .optional(),
  })
  .strict()
  .refine(
    (capability) =>
      new Set(capability.effects).size === capability.effects.length,
  );
const CapabilitiesSchema = z
  .record(Target, CapabilitySchema)
  .refine((targets) => Object.keys(targets).length <= 64);

export const GoveeControlRequestSchema = z
  .object({
    requestId: Token,
    target: Target,
    controlId: Token,
    effect: z.string().min(1).max(255).optional(),
    staticColor: GoveeStaticColorSchema.optional(),
    /** Periodic step: require an already powered fixture; never activate it. */
    modeOnly: z.literal(true).optional(),
    zones: z
      .object({ main: z.boolean(), ring: z.boolean() })
      .strict()
      .refine((zones) => zones.main || zones.ring)
      .optional(),
    /** Staged or already-lit masks may disable the unwanted zone first. */
    zoneOrder: z.literal('disable-first').optional(),
  })
  .strict()
  .refine(
    (request) => !request.staticColor || (!request.effect && !request.modeOnly),
  )
  .refine((request) => !request.zoneOrder || request.zones !== undefined)
  .refine((request) => !request.modeOnly || request.effect !== undefined)
  .refine(
    (request) =>
      request.effect !== undefined ||
      request.zones !== undefined ||
      request.staticColor !== undefined,
  );
const CancelSchema = z
  .object({ target: Target, controlId: Token.optional() })
  .strict();

export type GoveeControlRequest = z.infer<typeof GoveeControlRequestSchema>;
export type GoveeControlCapabilities = z.infer<typeof CapabilitiesSchema>;
export type GoveeControlDelivery = {
  transport: 'lan' | 'platform' | 'mixed';
  effect?: 'udp_sent' | 'cloud_accepted';
  zones?: 'udp_sent' | 'cloud_accepted';
  staticColor?: 'cloud_accepted';
};
export type GoveeWriteGuard = () => Promise<void>;

/** These codes deliberately carry no transport errors, credentials or response bodies. */
export class GoveeControlError extends Error {
  constructor(
    readonly status: 409 | 502 | 503,
    readonly code: 'stale' | 'delivery_failed' | 'unavailable',
  ) {
    super(code);
    this.name = 'GoveeControlError';
  }
}

type WriteJob = {
  controlId: string;
  revoked: boolean;
  done: Promise<unknown>;
};
type TargetQueue = {
  tail: Promise<unknown>;
  jobs: Set<WriteJob>;
  cancelled: Set<string>;
  lastControlId?: string;
};

/**
 * Serializes physical writes, never ownership/lease-acquisition HTTP. Callers must
 * bound their network I/O and await guard() immediately before each physical send.
 * A drain waits for sent API work to return; it cannot retract hardware work the
 * remote API already accepted.
 */
export class GoveeWriteCoordinator {
  private readonly targets = new Map<string, TargetQueue>();
  private stopped = false;

  constructor(private readonly maxPendingPerTarget = 8) {
    if (!Number.isInteger(maxPendingPerTarget) || maxPendingPerTarget < 1)
      throw new Error('Invalid Govee queue bound');
  }

  run<T>(
    target: string,
    controlId: string,
    isCurrent: () => boolean | Promise<boolean>,
    operation: (guard: GoveeWriteGuard) => Promise<T>,
  ): Promise<T> {
    if (this.stopped)
      return Promise.reject(new GoveeControlError(503, 'unavailable'));
    let queue = this.targets.get(target);
    if (!queue) {
      if (this.targets.size >= 64)
        return Promise.reject(new GoveeControlError(503, 'unavailable'));
      queue = {
        tail: Promise.resolve(),
        jobs: new Set(),
        cancelled: new Set(),
      };
      this.targets.set(target, queue);
    }
    if (queue.cancelled.has(controlId))
      return Promise.reject(new GoveeControlError(409, 'stale'));
    if (queue.jobs.size >= this.maxPendingPerTarget)
      return Promise.reject(new GoveeControlError(503, 'unavailable'));
    const targetQueue = queue;
    targetQueue.lastControlId = controlId;
    const job: WriteJob = {
      controlId,
      revoked: false,
      done: Promise.resolve(),
    };
    const assertCurrent = () => {
      if (this.stopped || job.revoked || targetQueue.cancelled.has(controlId))
        throw new GoveeControlError(409, 'stale');
    };
    const guard: GoveeWriteGuard = async () => {
      assertCurrent();
      let current: boolean;
      try {
        current = await isCurrent();
      } catch {
        throw new GoveeControlError(503, 'unavailable');
      }
      assertCurrent();
      if (!current) throw new GoveeControlError(409, 'stale');
    };
    const result = targetQueue.tail
      .catch(() => undefined)
      .then(async () => {
        await guard();
        const value = await operation(guard);
        await guard();
        return value;
      })
      .finally(() => targetQueue.jobs.delete(job));
    job.done = result;
    targetQueue.jobs.add(job);
    // Attach a rejection handler now, including for a queued request whose caller
    // disconnects. Individual callers still receive the original rejection.
    targetQueue.tail = result.catch(() => undefined);
    return result;
  }

  async cancel(target: string, controlId?: string): Promise<void> {
    let queue = this.targets.get(target);
    if (!queue) {
      if (controlId === undefined) return;
      if (this.targets.size >= 64)
        throw new GoveeControlError(503, 'unavailable');
      queue = {
        tail: Promise.resolve(),
        jobs: new Set(),
        cancelled: new Set(),
      };
      this.targets.set(target, queue);
    }
    const jobs = [...queue.jobs].filter(
      (job) => controlId === undefined || job.controlId === controlId,
    );
    const cancelledIds =
      controlId === undefined
        ? [
            ...jobs.map((job) => job.controlId),
            ...(queue.lastControlId ? [queue.lastControlId] : []),
          ]
        : [controlId];
    for (const id of cancelledIds) {
      queue.cancelled.add(id);
      // IDs are unique session generations. Old IDs also require the caller's
      // live ownership check; the bounded cache protects recent cancelled IDs.
      if (queue.cancelled.size > 1024)
        queue.cancelled.delete(queue.cancelled.values().next().value!);
    }
    for (const job of jobs) job.revoked = true;
    await Promise.allSettled(jobs.map((job) => job.done));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const jobs = [...this.targets.values()].flatMap((queue) => [...queue.jobs]);
    for (const job of jobs) job.revoked = true;
    await Promise.allSettled(jobs.map((job) => job.done));
  }
}

export type GoveeControlServerOptions = {
  socketPath: string;
  coordinator?: GoveeWriteCoordinator;
  capabilities: () =>
    GoveeControlCapabilities | Promise<GoveeControlCapabilities>;
  owns: (target: string, controlId: string) => boolean | Promise<boolean>;
  apply: (
    request: GoveeControlRequest,
    guard: GoveeWriteGuard,
  ) => Promise<GoveeControlDelivery>;
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const BODY_LIMIT = 16 * 1024;
function body(request: IncomingMessage): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')
  ) {
    request.resume();
    return Promise.reject(new HttpError(400, 'invalid_request'));
  }
  const length = Number(request.headers['content-length']);
  if (Number.isFinite(length) && length > BODY_LIMIT) {
    request.resume();
    return Promise.reject(new HttpError(413, 'request_too_large'));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        failed = true;
        chunks.length = 0;
        reject(new HttpError(413, 'request_too_large'));
      } else if (!failed) chunks.push(chunk);
    });
    request.on('error', () => reject(new HttpError(400, 'invalid_request')));
    request.on('aborted', () => reject(new HttpError(400, 'invalid_request')));
    request.on('end', () => {
      if (failed) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid_request'));
      }
    });
  });
}

function reply(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function prepareSocket(path: string): Promise<void> {
  if (!isAbsolute(path) || Buffer.byteLength(path) > 100)
    throw new GoveeControlError(503, 'unavailable');
  const directory = await lstat(dirname(path));
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0
  )
    throw new GoveeControlError(503, 'unavailable');
  const existing = await lstat(path).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (!existing) return;
  if (!existing.isSocket() || existing.uid !== process.getuid?.())
    throw new GoveeControlError(503, 'unavailable');
  const stale = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ path });
    socket.setTimeout(300);
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve(error.code === 'ECONNREFUSED' || error.code === 'ENOENT');
    });
  });
  if (!stale) throw new GoveeControlError(503, 'unavailable');
  const current = await lstat(path).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (!current) return;
  if (current.dev !== existing.dev || current.ino !== existing.ino)
    throw new GoveeControlError(503, 'unavailable');
  await unlink(path);
}

/** A local-only command endpoint. stop() also stops the shared coordinator. */
export async function startGoveeControlServer(
  options: GoveeControlServerOptions,
): Promise<{
  socketPath: string;
  stop(): Promise<void>;
}> {
  await prepareSocket(options.socketPath);
  const coordinator = options.coordinator ?? new GoveeWriteCoordinator();
  const readCapabilities = async () => {
    try {
      const parsed = CapabilitiesSchema.safeParse(await options.capabilities());
      if (parsed.success) return parsed.data;
    } catch {
      /* The capability source may be temporarily unavailable. */
    }
    throw new GoveeControlError(503, 'unavailable');
  };
  let stopping = false;
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    void (async () => {
      if (stopping) throw new GoveeControlError(503, 'unavailable');
      if (request.method === 'GET' && request.url === '/capabilities') {
        reply(response, 200, { targets: await readCapabilities() });
        return;
      }
      if (
        request.method !== 'POST' ||
        !['/apply', '/cancel'].includes(request.url ?? '')
      ) {
        request.resume();
        throw new HttpError(404, 'not_found');
      }
      const input = await body(request);
      if (request.url === '/cancel') {
        const parsed = CancelSchema.safeParse(input);
        if (!parsed.success) throw new HttpError(400, 'invalid_request');
        await coordinator.cancel(parsed.data.target, parsed.data.controlId);
        reply(response, 200, { status: 'drained' });
        return;
      }
      const parsed = GoveeControlRequestSchema.safeParse(input);
      if (!parsed.success) throw new HttpError(400, 'invalid_request');
      const command = parsed.data;
      const capability = (await readCapabilities())[command.target];
      if (
        !capability ||
        (command.effect !== undefined &&
          !capability.effects.includes(command.effect)) ||
        (command.zones !== undefined && !capability.zones) ||
        (command.staticColor !== undefined && !capability.staticColor)
      )
        throw new HttpError(400, 'unsupported_command');
      response.once('close', () => {
        if (!response.writableEnded)
          void coordinator
            .cancel(command.target, command.controlId)
            .catch(() => undefined);
      });
      if (response.destroyed || request.aborted)
        throw new GoveeControlError(409, 'stale');
      const startedAt = performance.now();
      const delivery = await coordinator.run(
        command.target,
        command.controlId,
        () => options.owns(command.target, command.controlId),
        (guard) => options.apply(command, guard),
      );
      reply(response, 200, {
        requestId: command.requestId,
        target: command.target,
        controlId: command.controlId,
        status: 'sent',
        durationMs: Math.max(0, performance.now() - startedAt),
        delivery,
      });
    })().catch((error: unknown) => {
      if (error instanceof HttpError || error instanceof GoveeControlError)
        reply(response, error.status, { error: error.code });
      else reply(response, 502, { error: 'delivery_failed' });
    });
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.on('error', () => {
    stopping = true;
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  // Bind a private unique name and hard-link the public socket. libuv unlinks its
  // bound name on close; this prevents it deleting a replacement at socketPath.
  const boundPath = join(
    dirname(options.socketPath),
    `.govee-${randomUUID().slice(0, 8)}.sock`,
  );
  let socketIdentity: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(boundPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    await chmod(boundPath, 0o600);
    socketIdentity = await lstat(boundPath);
    await link(boundPath, options.socketPath);
  } catch {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new GoveeControlError(503, 'unavailable');
  }
  let stopPromise: Promise<void> | undefined;
  return {
    socketPath: options.socketPath,
    stop: () => {
      stopPromise ??= (async () => {
        stopping = true;
        const closed = new Promise<void>((resolve) =>
          server.close(() => resolve()),
        );
        await coordinator.stop();
        for (const socket of sockets) socket.destroy();
        await closed;
        const current = await lstat(options.socketPath).catch(
          (error: unknown) => {
            if (isMissing(error)) return undefined;
            throw error;
          },
        );
        if (
          current?.dev === socketIdentity?.dev &&
          current?.ino === socketIdentity?.ino
        )
          await unlink(options.socketPath);
      })();
      return stopPromise;
    },
  };
}
