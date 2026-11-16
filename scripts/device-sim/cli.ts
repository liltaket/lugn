/**
 * Developer-only simulated Lugn server for the iOS app. Not part of the
 * production build (`tsconfig.build.json` covers `src/` only).
 *
 *   npm run device-sim -- [options]
 *   npm run device-replay -- <recording.jsonl> [options]
 *
 * See docs/ios/DEVSIM.md.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import {
  allowedHostsFor,
  appUrls,
  DEV_PAIRING_CODE,
  isLoopback,
  startSim,
} from './app.js';
import { CommandError, formatVirtualTime } from './commands.js';
import { loadRecording } from './recording.js';
import { ReplayServer } from './replay.js';
import { nextStockholmTime, type ScenarioMode } from './scenario.js';
import { normalizeCode } from './sim-room.js';

const USAGE = `Usage:
  npm run device-sim -- [options]
  npm run device-replay -- <recording.jsonl> [options]

Simulator options:
  --host <ip>            bind address (default 127.0.0.1). Use --lan or
                         --host 0.0.0.0 so a phone on the same network can connect
  --lan                  same as --host 0.0.0.0
  --port <n>             paired-device API port (default 8789)
  --allowed-host <h:p>   extra Host header value to accept (repeatable)
  --panel-port <n>       loopback control-panel API port (default 8788)
  --no-panel             do not start the control-panel API
  --control-port <n>     loopback simulator control endpoint (default 8790)
  --no-control           do not start the control endpoint
  --speed <factor>       virtual time speed, e.g. 20 (default 1)
  --start <HH:MM>        start the virtual clock at today's HH:MM (Stockholm)
  --scenario <mode>      loop (default) | calm (no faults) | off (manual only)
  --seed <n>             random seed for device latency and air drift
  --dev-code             also accept the fixed pairing code ${DEV_PAIRING_CODE}
  --pairing-code <code>  also accept this fixed code (XXXX-XXXX)
  --state-dir <dir>      keep paired tokens between runs (default: temp dir)
  --record <file>        record the SSE stream and state snapshots (JSONL)
  --no-phone-clock-shift judge real phones' timestamps on the virtual clock as-is
  --quiet                do not narrate why-feed entries

Replay options:
  --host, --lan, --port, --allowed-host, --dev-code, --pairing-code as above
  --speed <factor>       playback speed (default 1)
  --loop                 start over at the end
  --start-at <seconds>   begin this far into the recording
  --pause-at <seconds>   freeze at this point (deterministic screenshots)
`;

function fail(message: string): never {
  console.error(`device-sim: ${message}\n\n${USAGE}`);
  process.exit(2);
}

function int(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 65_535)
    fail(`--${name} must be a port number`);
  return number;
}

function number(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    fail(`--${name} must be a number`);
  return parsed;
}

const PAIRING_CODE = /^[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}$/i;

const { values, positionals } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        host: { type: 'string' },
        lan: { type: 'boolean' },
        port: { type: 'string' },
        'allowed-host': { type: 'string', multiple: true },
        'panel-port': { type: 'string' },
        'no-panel': { type: 'boolean' },
        'control-port': { type: 'string' },
        'no-control': { type: 'boolean' },
        speed: { type: 'string' },
        start: { type: 'string' },
        scenario: { type: 'string' },
        seed: { type: 'string' },
        'dev-code': { type: 'boolean' },
        'pairing-code': { type: 'string' },
        'state-dir': { type: 'string' },
        record: { type: 'string' },
        'no-phone-clock-shift': { type: 'boolean' },
        quiet: { type: 'boolean' },
        loop: { type: 'boolean' },
        'start-at': { type: 'string' },
        'pause-at': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
})();

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const host = values.lan ? '0.0.0.0' : (values.host ?? '127.0.0.1');
const port = int(values.port, 'port', 8789);
const fixedCode = values['dev-code']
  ? DEV_PAIRING_CODE
  : values['pairing-code'];
if (fixedCode !== undefined && !PAIRING_CODE.test(fixedCode))
  fail('--pairing-code must look like 7K3Q-M9TD (no I, L, O or U)');
const time = () => new Date().toLocaleTimeString('sv-SE');

function warnIfExposed(): void {
  if (isLoopback(host)) return;
  console.warn(`
  ⚠  The simulator listens on ${host} — reachable from your local network.
     Plain HTTP, development only: bearer tokens and pairing codes travel
     unencrypted, and anyone on this network holding a pairing code can pair.
     Use it on a trusted home/office LAN, never on public Wi-Fi.${
       fixedCode
         ? `\n     The fixed pairing code ${fixedCode} is accepted: anyone who knows it can pair.`
         : ''
     }
`);
}

function banner(
  code: string | undefined,
  urls: string[],
  extra: string[],
): void {
  const lines = [
    'Lugn device simulator (developer only, simulated devices)',
    '',
    `Server URL for the app:  ${urls[0]}`,
    ...urls.slice(1).map((url) => `                    or:  ${url}`),
    `Pairing code:            ${code ?? '(none)'}`,
    ...(fixedCode ? [`Fixed dev code:          ${fixedCode}`] : []),
    ...extra,
  ];
  const width = Math.max(...lines.map((line) => line.length)) + 4;
  const rule = '═'.repeat(width);
  console.log(`\n╔${rule}╗`);
  for (const line of lines) console.log(`║  ${line.padEnd(width - 2)}║`);
  console.log(`╚${rule}╝\n`);
}

async function runSimulator(): Promise<void> {
  const scenario = (values.scenario ?? 'loop') as ScenarioMode;
  if (!['loop', 'calm', 'off'].includes(scenario))
    fail('--scenario must be loop, calm or off');
  let startAt: number | undefined;
  if (values.start !== undefined) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(values.start))
      fail('--start must be HH:MM');
    // Today's HH:MM in Stockholm, earlier or later than now.
    const day = (at: number) =>
      new Date(at).toLocaleDateString('sv-SE', {
        timeZone: 'Europe/Stockholm',
      });
    const next = nextStockholmTime(Date.now(), values.start);
    const previous = next - 24 * 3_600_000;
    startAt = day(previous) === day(Date.now()) ? previous : next;
  }
  const speed = number(values.speed, 'speed') ?? 1;
  if (speed <= 0 || speed > 1000) fail('--speed must be in (0, 1000]');
  warnIfExposed();
  const quiet = values.quiet ?? false;
  let sim: Awaited<ReturnType<typeof startSim>>;
  try {
    sim = await startSim({
      host,
      port,
      panelPort: values['no-panel']
        ? null
        : int(values['panel-port'], 'panel-port', 8788),
      controlPort: values['no-control']
        ? null
        : int(values['control-port'], 'control-port', 8790),
      extraAllowedHosts: values['allowed-host'] ?? [],
      speed,
      ...(startAt === undefined ? {} : { startAt }),
      ...(values.seed === undefined ? {} : { seed: Number(values.seed) }),
      scenario,
      ...(values['state-dir'] === undefined
        ? {}
        : { stateDir: values['state-dir'] }),
      ...(fixedCode === undefined
        ? {}
        : { fixedPairingCode: normalizeCode(fixedCode)! }),
      ...(values.record === undefined ? {} : { record: values.record }),
      shiftPhoneClock: !values['no-phone-clock-shift'],
      log: (line) => {
        if (quiet && line.startsWith('why ·')) return;
        const label = virtualLabel();
        console.log(`[${time()}${label ? ` | sim ${label}` : ''}] ${line}`);
      },
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'EADDRINUSE')
      fail(
        `a port is already in use (${(error as Error).message}); pick others with --port, --panel-port, --control-port`,
      );
    if (code === 'EADDRNOTAVAIL')
      fail(`${host} is not an address of this machine`);
    throw error;
  }
  virtualLabel = () =>
    `${formatVirtualTime(sim.clock.now())} ×${sim.clock.speed}`;
  const extra = [
    `Allowed Host headers:    ${sim.allowedHosts.join(', ')}`,
    ...(sim.room.controlPanelUrl
      ? [`Control-panel API:       ${sim.room.controlPanelUrl} (loopback)`]
      : []),
    ...(sim.controlUrl
      ? [`Simulator control:       ${sim.controlUrl}/sim/command (loopback)`]
      : []),
    ...(values.record ? [`Recording to:            ${values.record}`] : []),
    `Scenario:                ${scenario}, speed ×${speed}`,
    'Type "help" for commands, Ctrl-C to stop.',
  ];
  banner(sim.room.pairingCode?.code, sim.urls, extra);
  sim.room.onPairingCode = (code) =>
    console.log(
      `\n>>> New pairing code: ${code.code}  (server ${sim.urls[0]})\n`,
    );

  const input = createInterface({ input: process.stdin, terminal: false });
  input.on('line', (line) => {
    if (!line.trim()) return;
    sim.command(line).then(
      (answer) => answer && console.log(answer),
      (error: unknown) =>
        console.log(
          error instanceof CommandError
            ? error.message
            : `failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) process.exit(1);
    stopping = true;
    input.close();
    console.log('\nstopping…');
    await sim.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

let virtualLabel = () => '';

async function runReplay(file: string | undefined): Promise<void> {
  if (!file) fail('replay needs a recording file');
  const recording = await loadRecording(file).catch((error: unknown) =>
    fail(error instanceof Error ? error.message : String(error)),
  );
  warnIfExposed();
  const stateDir = await mkdtemp(join(tmpdir(), 'lugn-device-replay-'));
  const replay = new ReplayServer({
    recording,
    host,
    port,
    allowedHosts: allowedHostsFor(host, port, values['allowed-host'] ?? []),
    stateDir,
    speed: number(values.speed, 'speed') ?? 1,
    loop: values.loop ?? false,
    ...(values['start-at'] === undefined
      ? {}
      : { startAt: number(values['start-at'], 'start-at')! }),
    ...(values['pause-at'] === undefined
      ? {}
      : { pauseAt: number(values['pause-at'], 'pause-at')! }),
    ...(fixedCode === undefined
      ? {}
      : { fixedPairingCode: normalizeCode(fixedCode)! }),
    log: (line) => console.log(`[${time()}] ${line}`),
  });
  await replay.start();
  banner(replay.pairingCode, appUrls(host, port), [
    `Replaying:               ${file} (${(replay.duration / 1000).toFixed(0)} s)`,
    'Read-only: commands and phone observations return 503 replay_read_only.',
    'Ctrl-C to stop.',
  ]);
  const stop = async () => {
    await replay.stop();
    await rm(stateDir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

if (positionals[0] === 'replay') await runReplay(positionals[1]);
else if (positionals.length > 0) fail(`unexpected argument ${positionals[0]}`);
else await runSimulator();
