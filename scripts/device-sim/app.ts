import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { hostname, networkInterfaces, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import {
  CommandError,
  COMMAND_HELP,
  runCommand,
  statusOf,
} from './commands.js';
import { StreamRecorder } from './recording.js';
import { ScenarioDriver, type ScenarioMode } from './scenario.js';
import { SimClock } from './sim-clock.js';
import { SimRoom } from './sim-room.js';

/** Well-known code accepted by `--dev-code`, for scripted tests only. */
export const DEV_PAIRING_CODE = 'DEV0-0000';

export type SimOptions = {
  host: string;
  port: number;
  /** Loopback control-panel API port, or null for none. */
  panelPort: number | null;
  /** Loopback simulator control endpoint port, or null for none. */
  controlPort: number | null;
  extraAllowedHosts?: string[];
  speed?: number;
  startAt?: number;
  seed?: number;
  scenario?: ScenarioMode;
  stateDir?: string;
  fixedPairingCode?: string;
  record?: string;
  shiftPhoneClock?: boolean;
  /** Manual virtual time, for tests: only `advanceBy` moves it. */
  manualClock?: boolean;
  log?: (line: string) => void;
};

export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

/** LAN IPv4 addresses a phone could use to reach this machine. */
export function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter(
      (entry): entry is NonNullable<typeof entry> =>
        !!entry && entry.family === 'IPv4' && !entry.internal,
    )
    .map((entry) => entry.address);
}

/**
 * The listener answers only exact Host values. For a wildcard bind this is
 * every local address plus the machine's (mDNS) name, so the URL printed in
 * the banner works from a phone on the same network.
 */
export function allowedHostsFor(
  host: string,
  port: number,
  extra: readonly string[] = [],
): string[] {
  const names = new Set<string>(['127.0.0.1', 'localhost']);
  if (host === '0.0.0.0' || host === '::') {
    for (const address of lanAddresses()) names.add(address);
    const name = hostname().toLowerCase();
    names.add(name);
    names.add(name.endsWith('.local') ? name : `${name}.local`);
  } else if (!isLoopback(host)) names.add(host);
  const hosts = [...names].map((name) =>
    isIP(name) === 6 ? `[${name}]:${port}` : `${name}:${port}`,
  );
  for (const entry of extra)
    hosts.push(entry.includes(':') ? entry : `${entry}:${port}`);
  return [...new Set(hosts.map((entry) => entry.toLowerCase()))];
}

/** URLs to type into the app, best first. */
export function appUrls(host: string, port: number): string[] {
  if (host === '0.0.0.0' || host === '::') {
    const name = hostname().toLowerCase();
    return [
      ...lanAddresses().map((address) => `http://${address}:${port}`),
      `http://${name.endsWith('.local') ? name : `${name}.local`}:${port}`,
      `http://127.0.0.1:${port}`,
    ];
  }
  return [`http://${isLoopback(host) ? '127.0.0.1' : host}:${port}`];
}

function webAssetsDirectory(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    resolve(here, '../../web'),
    resolve(here, '../../../web'),
  ])
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  return undefined;
}

export type RunningSim = {
  room: SimRoom;
  driver: ScenarioDriver;
  clock: SimClock;
  allowedHosts: string[];
  urls: string[];
  controlUrl: string | undefined;
  recorder: StreamRecorder | undefined;
  command(line: string): Promise<string>;
  stop(): Promise<void>;
};

/** Boots the simulated room, its listeners, the scenario and optional recorder. */
export async function startSim(options: SimOptions): Promise<RunningSim> {
  const log = options.log ?? (() => undefined);
  const temporary = options.stateDir === undefined;
  const stateDir =
    options.stateDir ?? (await mkdtemp(join(tmpdir(), 'lugn-device-sim-')));
  if (!temporary) await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const clock = new SimClock({
    ...(options.startAt === undefined ? {} : { startAt: options.startAt }),
    speed: options.speed ?? 1,
    manual: options.manualClock ?? false,
  });
  // Allowed Host values name the port, so a requested free port is picked first.
  const port = options.port === 0 ? await freePort(options.host) : options.port;
  const allowedHosts = allowedHostsFor(
    options.host,
    port,
    options.extraAllowedHosts,
  );
  const webAssets = webAssetsDirectory();
  const room = new SimRoom({
    clock,
    stateDir,
    host: options.host,
    port,
    allowedHosts,
    controlPanelPort: options.panelPort,
    ...(webAssets === undefined ? {} : { webAssetsDirectory: webAssets }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.fixedPairingCode === undefined
      ? {}
      : { fixedPairingCode: options.fixedPairingCode }),
    shiftPhoneClock: options.shiftPhoneClock ?? true,
    log,
  });
  const driver = new ScenarioDriver(room, {
    mode: options.scenario ?? 'loop',
    log: (line) => log(`scenario · ${line}`),
  });
  let control: Server | undefined;
  let recorder: StreamRecorder | undefined;
  const stopWhy = watchWhy(room, log);
  try {
    await room.start();
    if (options.controlPort !== null)
      control = await startControl(
        options.controlPort,
        (line) => runCommand(line, room, driver),
        () => statusOf(room, driver),
      );
    if (options.record) {
      const token = await room.pairInternal('device-sim recorder');
      recorder = new StreamRecorder(
        options.record,
        { port, host: allowedHosts[0]!, token },
        { speed: () => clock.speed, log },
      );
      await recorder.start();
    }
    driver.start();
  } catch (error) {
    stopWhy();
    await driver.stop();
    await recorder?.stop();
    await closeServer(control);
    await room.stop();
    clock.dispose();
    if (temporary) await rm(stateDir, { recursive: true, force: true });
    throw error;
  }
  const controlAddress = control?.address();
  return {
    room,
    driver,
    clock,
    allowedHosts,
    urls: appUrls(options.host, port),
    controlUrl:
      controlAddress && typeof controlAddress === 'object'
        ? `http://127.0.0.1:${controlAddress.port}`
        : undefined,
    recorder,
    command: (line) => runCommand(line, room, driver),
    async stop() {
      stopWhy();
      await driver.stop();
      await recorder?.stop();
      await closeServer(control);
      await room.stop();
      clock.dispose();
      if (temporary) await rm(stateDir, { recursive: true, force: true });
    },
  };
}

/** Logs each new why-feed entry, so the console narrates real engine decisions. */
function watchWhy(room: SimRoom, log: (line: string) => void): () => void {
  const seen = new Set<string>();
  let pending: NodeJS.Immediate | undefined;
  let primed = false;
  const check = () => {
    pending = undefined;
    const why = room.view().why;
    for (const entry of [...why].reverse()) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      if (primed)
        log(
          `why · ${entry.outcome} · ${entry.text}${entry.trigger ? ` (${entry.trigger})` : ''}`,
        );
    }
    primed = true;
    if (seen.size > 500)
      for (const id of [...seen].slice(0, 250)) seen.delete(id);
  };
  const unsubscribe = room.engine.stream.subscribe(() => {
    pending ??= setImmediate(check);
  });
  return () => {
    unsubscribe();
    if (pending) clearImmediate(pending);
  };
}

/**
 * Loopback-only operator endpoint. Browser requests (any Origin header) are
 * refused so a web page cannot drive the simulator.
 */
function startControl(
  port: number,
  run: (line: string) => Promise<string>,
  status: () => unknown,
): Promise<Server> {
  const server = createServer((request, response) => {
    const reply = (
      code: number,
      body: string,
      type = 'text/plain; charset=utf-8',
    ) => {
      response.writeHead(code, {
        'content-type': type,
        'cache-control': 'no-store',
      });
      response.end(body.endsWith('\n') ? body : `${body}\n`);
    };
    if (request.headers.origin !== undefined)
      return reply(403, 'browser origin refused');
    const path = new URL(request.url ?? '/', 'http://sim.invalid').pathname;
    if (request.method === 'GET' && path === '/sim/status')
      return reply(200, JSON.stringify(status(), null, 2), 'application/json');
    if (request.method === 'GET' && path === '/sim/help')
      return reply(200, COMMAND_HELP);
    if (request.method !== 'POST' || path !== '/sim/command')
      return reply(
        404,
        'try GET /sim/status, GET /sim/help or POST /sim/command',
      );
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 4_096) request.destroy();
    });
    request.on('end', () => {
      let line = body.trim();
      if (line.startsWith('{')) {
        try {
          line = String(
            (JSON.parse(line) as { command?: unknown }).command ?? '',
          );
        } catch {
          return reply(400, 'invalid JSON; send {"command":"…"} or plain text');
        }
      }
      run(line).then(
        (answer) => reply(200, answer || 'ok'),
        (error: unknown) =>
          reply(
            error instanceof CommandError ? 400 : 500,
            error instanceof Error ? error.message : String(error),
          ),
      );
    });
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolvePromise(server);
    });
  });
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  const closed = new Promise<void>((resolvePromise) =>
    server.close(() => resolvePromise()),
  );
  server.closeAllConnections();
  await closed;
}

function freePort(host: string): Promise<number> {
  const server = createServer();
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}
