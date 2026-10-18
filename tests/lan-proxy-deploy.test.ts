import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const installer = resolve('deploy/install-lan-proxy.sh');
let temporaryRoot: string | undefined;

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

it('installs a separate LAN-only Caddy user service with a validated exact origin', async () => {
  const { home, existingLugnUnit, reloadMarker, path } = await createSandbox();
  const result = spawnInstaller(
    home,
    path,
    'brunocam.local',
    '192.168.10.132',
    '192.168.10.0/24',
    reloadMarker,
  );

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(
    'https://brunocam.local:8443/ui/ (bind 192.168.10.132; allow 192.168.10.0/24)',
  );
  expect(await readFile(existingLugnUnit, 'utf8')).toBe('existing Lugn unit\n');
  expect(await readFile(reloadMarker, 'utf8')).toBe('reloaded\n');

  const configRoot = join(home, '.config/lugn-lan-proxy');
  const caddyfile = await readFile(join(configRoot, 'Caddyfile'), 'utf8');
  const environment = await readFile(join(configRoot, 'proxy.env'), 'utf8');
  const unit = await readFile(
    join(home, '.config/systemd/user/lugn-lan-proxy.service'),
    'utf8',
  );
  expect(caddyfile).toContain('tls internal');
  expect(caddyfile).toContain('bind {$LUGN_PROXY_BIND}');
  expect(caddyfile).toContain(
    '@outside_lan not remote_ip {$LUGN_PROXY_LAN_CIDR}',
  );
  expect(caddyfile).toContain('reverse_proxy 127.0.0.1:8787');
  expect(caddyfile).not.toContain('8788');
  expect(environment).toContain('LUGN_PROXY_HOST=brunocam.local');
  expect(environment).toContain('LUGN_PROXY_BIND=192.168.10.132');
  expect(environment).toContain('LUGN_PROXY_LAN_CIDR=192.168.10.0/24');
  expect(unit).toContain('Requires=lugn.service');
  expect(unit).toContain('ExecStart=%h/.local/bin/caddy run');
  expect(unit).toContain('WantedBy=default.target');
  expect(unit).not.toContain('8788');
  expect((await stat(join(configRoot, 'proxy.env'))).mode & 0o777).toBe(0o600);
  expect(
    (await stat(join(home, '.config/systemd/user/lugn-lan-proxy.service')))
      .mode & 0o777,
  ).toBe(0o600);
});

it.each([
  ['wildcard bind', 'brunocam.local', '0.0.0.0', '192.168.10.0/24'],
  ['public allow range', 'brunocam.local', '192.168.10.132', '0.0.0.0/0'],
  [
    'bind outside allow range',
    'brunocam.local',
    '192.168.11.132',
    '192.168.10.0/24',
  ],
  [
    'Caddyfile injection in hostname',
    'brunocam.local\nrespond hello',
    '192.168.10.132',
    '192.168.10.0/24',
  ],
])(
  'rejects unsafe proxy input before writing files (%s)',
  async (_case, host, bind, cidr) => {
    const { home, path, reloadMarker } = await createSandbox();
    const result = spawnInstaller(home, path, host, bind, cidr, reloadMarker);

    expect(result.status).not.toBe(0);
    expect(await exists(join(home, '.config/lugn-lan-proxy/Caddyfile'))).toBe(
      false,
    );
    expect(await exists(reloadMarker)).toBe(false);
  },
);

it('refuses to replace an unrelated existing Caddyfile', async () => {
  const { home, path, reloadMarker } = await createSandbox();
  const configRoot = join(home, '.config/lugn-lan-proxy');
  await mkdir(configRoot, { recursive: true });
  const caddyfile = join(configRoot, 'Caddyfile');
  await writeFile(caddyfile, 'user-owned config\n');

  const result = spawnInstaller(
    home,
    path,
    'brunocam.local',
    '192.168.10.132',
    '192.168.10.0/24',
    reloadMarker,
  );

  expect(result.status).not.toBe(0);
  expect(await readFile(caddyfile, 'utf8')).toBe('user-owned config\n');
});

async function createSandbox(): Promise<{
  home: string;
  existingLugnUnit: string;
  reloadMarker: string;
  path: string;
}> {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'lugn-lan-proxy-'));
  const home = join(temporaryRoot, 'home');
  const fakeBin = join(temporaryRoot, 'bin');
  const caddyBin = join(home, '.local/bin');
  const unitRoot = join(home, '.config/systemd/user');
  await mkdir(fakeBin, { recursive: true });
  await mkdir(caddyBin, { recursive: true });
  await mkdir(unitRoot, { recursive: true });

  const caddyPath = join(caddyBin, 'caddy');
  await writeFile(
    caddyPath,
    `#!/bin/sh
set -eu
[ "$1" = validate ]
[ "$LUGN_PROXY_HOST" = brunocam.local ]
[ "$LUGN_PROXY_PORT" = 8443 ]
[ "$LUGN_PROXY_BIND" = 192.168.10.132 ]
[ "$LUGN_PROXY_LAN_CIDR" = 192.168.10.0/24 ]
test -f "$3"
grep -q 'reverse_proxy 127.0.0.1:8787' "$3"
`,
  );
  await chmod(caddyPath, 0o700);

  const reloadMarker = join(temporaryRoot, 'systemd-reloaded');
  const systemctlPath = join(fakeBin, 'systemctl');
  await writeFile(
    systemctlPath,
    `#!/bin/sh
set -eu
[ "$1" = --user ]
case "$2" in
  show-environment) exit 0 ;;
  daemon-reload) printf 'reloaded\\n' > "$SYSTEMCTL_RELOAD_MARKER" ;;
  *) exit 1 ;;
esac
`,
  );
  await chmod(systemctlPath, 0o700);

  const existingLugnUnit = join(unitRoot, 'lugn.service');
  await writeFile(existingLugnUnit, 'existing Lugn unit\n');
  return {
    home,
    existingLugnUnit,
    reloadMarker,
    path: `${fakeBin}:${process.env['PATH'] ?? '/usr/bin:/bin'}`,
  };
}

function spawnInstaller(
  home: string,
  path: string,
  host: string,
  bind: string,
  cidr: string,
  reloadMarker: string,
) {
  return spawnSync('bash', [installer, host, bind, cidr], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: home,
      PATH: path,
      SYSTEMCTL_RELOAD_MARKER: reloadMarker,
    },
    encoding: 'utf8',
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
