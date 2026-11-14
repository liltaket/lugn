import { createServer as createNetServer } from 'node:net';
import { request } from 'node:http';
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GoveeControlError,
  GoveeWriteCoordinator,
  startGoveeControlServer,
  type GoveeControlServerOptions,
} from '../src/runtime/govee-control-server.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('Govee device-write coordination', () => {
  it('serializes one target while allowing another fixture to progress', async () => {
    const coordinator = new GoveeWriteCoordinator();
    const started = gate(),
      finish = gate();
    const calls: string[] = [];
    const first = coordinator.run(
      'lighting.ceiling',
      'old',
      () => true,
      async () => {
        calls.push('old-send');
        started.release();
        await finish.promise;
        calls.push('old-return');
      },
    );
    await started.promise;
    const second = coordinator.run(
      'lighting.ceiling',
      'new',
      () => true,
      async () => {
        calls.push('new-send');
      },
    );
    await coordinator.run(
      'lighting.table',
      'table',
      () => true,
      async () => {
        calls.push('table-send');
      },
    );
    expect(calls).toEqual(['old-send', 'table-send']);
    finish.release();
    await Promise.all([first, second]);
    expect(calls).toEqual(['old-send', 'table-send', 'old-return', 'new-send']);
  });

  it('revokes old queued and active work immediately but drains the sent request', async () => {
    const coordinator = new GoveeWriteCoordinator();
    const started = gate(),
      network = gate();
    const secondWrite = vi.fn();
    const first = coordinator.run(
      'lighting.ceiling',
      'old',
      () => true,
      async (guard) => {
        started.release();
        await network.promise;
        await guard();
        secondWrite();
      },
    );
    const firstResult = first.catch((error: unknown) => error);
    await started.promise;
    const queued = coordinator.run(
      'lighting.ceiling',
      'queued',
      () => true,
      async () => {
        secondWrite();
      },
    );
    const queuedResult = queued.catch((error: unknown) => error);
    let drained = false;
    const cancel = coordinator.cancel('lighting.ceiling').then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    network.release();
    await cancel;
    expect(secondWrite).not.toHaveBeenCalled();
    expect(await firstResult).toMatchObject({ status: 409, code: 'stale' });
    expect(await queuedResult).toMatchObject({ status: 409, code: 'stale' });
    expect(drained).toBe(true);
    await expect(
      coordinator.run(
        'lighting.ceiling',
        'old',
        () => true,
        async () => 'replayed',
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      coordinator.run(
        'lighting.ceiling',
        'fresh',
        () => true,
        async () => 'sent',
      ),
    ).resolves.toBe('sent');
  });

  it('cancels only a named generation and rejects its subsequent replay', async () => {
    const coordinator = new GoveeWriteCoordinator();
    const network = gate(),
      started = gate();
    const first = coordinator
      .run(
        'lighting.ceiling',
        'cancelled',
        () => true,
        async (guard) => {
          started.release();
          await network.promise;
          await guard();
        },
      )
      .catch((error: unknown) => error);
    await started.promise;
    const next = coordinator.run(
      'lighting.ceiling',
      'survives',
      () => true,
      async () => 'next',
    );
    const cancel = coordinator.cancel('lighting.ceiling', 'cancelled');
    network.release();
    await cancel;
    expect(await first).toBeInstanceOf(GoveeControlError);
    await expect(next).resolves.toBe('next');
    await expect(
      coordinator.run(
        'lighting.ceiling',
        'cancelled',
        () => true,
        async () => undefined,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rechecks cancellation after an asynchronous ownership check', async () => {
    const coordinator = new GoveeWriteCoordinator();
    const checking = gate(),
      checked = gate();
    const send = vi.fn();
    const job = coordinator
      .run(
        'lighting.ceiling',
        'old',
        async () => {
          checking.release();
          await checked.promise;
          return true;
        },
        async () => {
          send();
        },
      )
      .catch((error: unknown) => error);
    await checking.promise;
    const cancel = coordinator.cancel('lighting.ceiling', 'old');
    checked.release();
    await cancel;
    expect(await job).toMatchObject({ status: 409 });
    expect(send).not.toHaveBeenCalled();
  });

  it('tombstones a named cancellation even before its delayed apply arrives', async () => {
    const coordinator = new GoveeWriteCoordinator();
    await coordinator.cancel('lighting.ceiling', 'cancelled-before-arrival');
    await expect(
      coordinator.run(
        'lighting.ceiling',
        'cancelled-before-arrival',
        () => true,
        async () => 'late',
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      coordinator.run(
        'lighting.ceiling',
        'new-generation',
        () => true,
        async () => 'new',
      ),
    ).resolves.toBe('new');
  });

  it('bounds pending work, and stopping drains instead of starting queued writes', async () => {
    const coordinator = new GoveeWriteCoordinator(2);
    const started = gate(),
      network = gate();
    const first = coordinator
      .run(
        'lighting.ceiling',
        'first',
        () => true,
        async () => {
          started.release();
          await network.promise;
        },
      )
      .catch((error: unknown) => error);
    await started.promise;
    const send = vi.fn();
    const second = coordinator
      .run(
        'lighting.ceiling',
        'second',
        () => true,
        async () => {
          send();
        },
      )
      .catch((error: unknown) => error);
    await expect(
      coordinator.run(
        'lighting.ceiling',
        'excess',
        () => true,
        async () => undefined,
      ),
    ).rejects.toMatchObject({ status: 503 });
    const stopping = coordinator.stop();
    network.release();
    await stopping;
    expect(await first).toMatchObject({ status: 409 });
    expect(await second).toMatchObject({ status: 409 });
    expect(send).not.toHaveBeenCalled();
    await expect(
      coordinator.run(
        'lighting.table',
        'later',
        () => true,
        async () => undefined,
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'govee-ctl-'));
  await chmod(path, 0o700);
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function fixture(overrides: Partial<GoveeControlServerOptions> = {}) {
  const dir = await directory();
  const options: GoveeControlServerOptions = {
    socketPath: join(dir, 'control.sock'),
    capabilities: () => ({
      'lighting.ceiling': {
        effects: ['Forest', 'Aurora'],
        zones: true,
        colorTemperature: { min: 2700, max: 6500 },
      },
      'lighting.table': { effects: ['Forest'], zones: false },
    }),
    owns: () => true,
    apply: vi.fn<GoveeControlServerOptions['apply']>(
      async (_command, guard) => {
        await guard();
        return { transport: 'lan', effect: 'udp_sent' };
      },
    ),
    ...overrides,
  };
  const server = await startGoveeControlServer(options);
  cleanups.push(() => server.stop());
  return { ...server, options };
}
function call(socketPath: string, path: string, value?: unknown, raw?: string) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const data =
      raw ?? (value === undefined ? undefined : JSON.stringify(value));
    const req = request(
      {
        socketPath,
        path,
        method: data === undefined ? 'GET' : 'POST',
        headers:
          data === undefined
            ? {}
            : {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
              },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          try {
            resolve({
              status: response.statusCode!,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}
const command = {
  requestId: 'request-1',
  target: 'lighting.ceiling',
  controlId: 'generation-1',
  effect: 'Forest',
};

describe('Govee Unix command server', () => {
  it('exposes capabilities only on a private socket and returns delivery-only evidence', async () => {
    const f = await fixture();
    expect((await lstat(f.socketPath)).mode & 0o777).toBe(0o600);
    const caps = await call(f.socketPath, '/capabilities');
    expect(caps).toMatchObject({
      status: 200,
      body: {
        targets: {
          'lighting.ceiling': { colorTemperature: { min: 2700, max: 6500 } },
        },
      },
    });
    expect(await call(f.socketPath, '/apply', command)).toMatchObject({
      status: 200,
      body: {
        requestId: command.requestId,
        target: command.target,
        controlId: command.controlId,
        status: 'sent',
        durationMs: expect.any(Number),
        delivery: { transport: 'lan', effect: 'udp_sent' },
      },
    });
    expect(f.options.apply).toHaveBeenCalledOnce();
  });

  it('rejects unsupported options, targets, zones and extra fields before applying', async () => {
    const f = await fixture();
    for (const input of [
      { ...command, effect: 'not a catalog label' },
      { ...command, target: 'lighting.unknown' },
      {
        ...command,
        target: 'lighting.table',
        zones: { main: true, ring: false },
      },
      { ...command, extra: 'secret-do-not-echo' },
      { ...command, effect: undefined },
      { ...command, zones: { main: true } },
      { ...command, zones: { main: false, ring: false } },
      { ...command, modeOnly: false },
      { ...command, staticColor: { colorTemperature: 4000 } },
      { ...command, effect: undefined, staticColor: {} },
      {
        ...command,
        effect: undefined,
        staticColor: { rgb: [1, 2, 3], colorTemperature: 4000 },
      },
      { ...command, effect: undefined, staticColor: { power: true } },
      {
        ...command,
        effect: undefined,
        zones: { main: false, ring: true },
        modeOnly: true,
      },
    ]) {
      const response = await call(f.socketPath, '/apply', input);
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).not.toContain('secret-do-not-echo');
    }
    expect(f.options.apply).not.toHaveBeenCalled();
  });

  it('accepts a color-only reset on a capable target and rejects invalid combinations', async () => {
    const f = await fixture({
      capabilities: () => ({
        'lighting.ceiling': {
          effects: ['Forest'],
          zones: true,
          staticColor: true,
        },
      }),
    });
    const reset = {
      ...command,
      effect: undefined,
      staticColor: { colorTemperature: 4000 },
    };
    expect((await call(f.socketPath, '/apply', reset)).status).toBe(200);
    for (const input of [
      { ...reset, effect: 'Forest' },
      { ...reset, zones: { main: true, ring: false } },
      { ...reset, modeOnly: true },
      { ...reset, staticColor: { colorTemperature: 4000, brightness: 50 } },
    ])
      expect((await call(f.socketPath, '/apply', input)).status).toBe(400);
    expect(f.options.apply).toHaveBeenCalledOnce();
  });

  it('rejects superseded ownership and sanitizes unavailable/error responses', async () => {
    const owns = vi.fn(async () => false);
    const f = await fixture({ owns });
    expect(await call(f.socketPath, '/apply', command)).toEqual({
      status: 409,
      body: { error: 'stale' },
    });
    expect(f.options.apply).not.toHaveBeenCalled();
    owns.mockRejectedValueOnce(new Error('token-must-not-appear'));
    expect(await call(f.socketPath, '/apply', command)).toEqual({
      status: 503,
      body: { error: 'unavailable' },
    });
    owns.mockResolvedValue(true);
    vi.mocked(f.options.apply).mockRejectedValueOnce(
      new Error('private-device-response'),
    );
    expect(await call(f.socketPath, '/apply', command)).toEqual({
      status: 502,
      body: { error: 'delivery_failed' },
    });
  });

  it('rejects malformed/oversized JSON without disabling subsequent requests', async () => {
    const f = await fixture();
    expect((await call(f.socketPath, '/apply', undefined, '{')).status).toBe(
      400,
    );
    expect(
      (await call(f.socketPath, '/apply', undefined, 'x'.repeat(16 * 1024 + 1)))
        .status,
    ).toBe(413);
    expect((await call(f.socketPath, '/capabilities')).status).toBe(200);
    expect(f.options.apply).not.toHaveBeenCalled();
  });

  it('reports unavailable capabilities without leaking source errors', async () => {
    const f = await fixture({
      capabilities: () => {
        throw new Error('private metadata response');
      },
    });
    expect(await call(f.socketPath, '/capabilities')).toEqual({
      status: 503,
      body: { error: 'unavailable' },
    });
    expect(await call(f.socketPath, '/apply', command)).toEqual({
      status: 503,
      body: { error: 'unavailable' },
    });
    expect(f.options.apply).not.toHaveBeenCalled();
  });

  it('does not acknowledge cancellation until an active API write has drained', async () => {
    const started = gate(),
      network = gate(),
      revoked = gate();
    const coordinator = new GoveeWriteCoordinator();
    const cancelWrites = coordinator.cancel.bind(coordinator);
    vi.spyOn(coordinator, 'cancel').mockImplementation((target, controlId) => {
      const result = cancelWrites(target, controlId);
      revoked.release();
      return result;
    });
    const lateSend = vi.fn();
    const f = await fixture({
      coordinator,
      apply: async (_request, guard) => {
        started.release();
        await network.promise;
        await guard();
        lateSend();
        return { transport: 'platform', effect: 'cloud_accepted' };
      },
    });
    const applying = call(f.socketPath, '/apply', command);
    await started.promise;
    let drained = false;
    const cancel = call(f.socketPath, '/cancel', {
      target: command.target,
    }).then((response) => {
      drained = true;
      return response;
    });
    await revoked.promise;
    expect(drained).toBe(false);
    network.release();
    expect(await cancel).toEqual({ status: 200, body: { status: 'drained' } });
    expect(await applying).toEqual({ status: 409, body: { error: 'stale' } });
    expect(lateSend).not.toHaveBeenCalled();
  });

  it('preserves a regular file or symlink at the requested path', async () => {
    const dir = await directory();
    const socketPath = join(dir, 'control.sock');
    await writeFile(socketPath, 'keep');
    const options: GoveeControlServerOptions = {
      socketPath,
      capabilities: () => ({}),
      owns: () => true,
      apply: async () => ({ transport: 'lan' }),
    };
    await expect(startGoveeControlServer(options)).rejects.toMatchObject({
      status: 503,
    });
    expect(await readFile(socketPath, 'utf8')).toBe('keep');
    await unlink(socketPath);
    await symlink(join(dir, 'missing'), socketPath);
    await expect(startGoveeControlServer(options)).rejects.toMatchObject({
      status: 503,
    });
    expect((await lstat(socketPath)).isSymbolicLink()).toBe(true);
  });

  it('does not remove an existing live server socket', async () => {
    const dir = await directory();
    const socketPath = join(dir, 'control.sock');
    const server = createNetServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const before = await lstat(socketPath);
    await expect(
      startGoveeControlServer({
        socketPath,
        capabilities: () => ({}),
        owns: () => true,
        apply: async () => ({ transport: 'lan' }),
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect((await lstat(socketPath)).ino).toBe(before.ino);
  });

  it('reclaims a stale owned socket and preserves a replacement during shutdown', async () => {
    const dir = await directory();
    const bound = join(dir, 'old.sock'),
      socketPath = join(dir, 'control.sock');
    const old = createNetServer();
    await new Promise<void>((resolve) => old.listen(bound, resolve));
    await link(bound, socketPath);
    await new Promise<void>((resolve) => old.close(() => resolve()));
    const f = await fixture({ socketPath });
    expect((await call(socketPath, '/capabilities')).status).toBe(200);
    await unlink(socketPath);
    await writeFile(socketPath, 'replacement');
    await f.stop();
    expect(await readFile(socketPath, 'utf8')).toBe('replacement');
  });
});
