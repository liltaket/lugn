import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectories: string[] = [];

function makeInstallFixture() {
  const root = mkdtempSync(join(tmpdir(), 'lugn installer test '));
  temporaryDirectories.push(root);

  const repo = join(root, 'repo %p with spaces');
  const home = join(root, 'home %h with spaces');
  const bin = join(root, 'node bin %u with spaces');
  const installer = join(repo, 'deploy', 'install-user-service.sh');

  mkdirSync(dirname(installer), { recursive: true });
  mkdirSync(join(repo, 'dist', 'runtime'), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  copyFileSync(
    join(repositoryRoot, 'deploy', 'install-user-service.sh'),
    installer,
  );
  writeFileSync(join(repo, 'config.example.json'), '{}\n');
  writeFileSync(join(repo, 'dist', 'runtime', 'main.js'), '');

  const fakeNode = join(bin, 'node');
  writeFileSync(fakeNode, '#!/bin/sh\n[ "$1" = -e ]\n');
  chmodSync(fakeNode, 0o755);

  writeFileSync(
    join(bin, 'systemctl'),
    '#!/bin/sh\ncase "$*" in\n  "--user show-environment"|"--user daemon-reload") exit 0 ;;\n  *) exit 97 ;;\nesac\n',
  );
  chmodSync(join(bin, 'systemctl'), 0o755);

  const result = spawnSync('/bin/bash', [installer], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
    },
  });
  expect(result.status, result.stderr).toBe(0);

  const unitFile = join(home, '.config', 'systemd', 'user', 'lugn.service');
  return { bin, home, repo, unitFile };
}

function escapePath(path: string, forExec = false): string {
  return [...path]
    .map((character) => {
      const controls: Record<string, string> = {
        ' ': '\\x20',
        '\t': '\\x09',
        '\n': '\\x0a',
        '\r': '\\x0d',
        '\v': '\\x0b',
        '\f': '\\x0c',
        '\\': '\\x5c',
        '"': '\\x22',
        "'": '\\x27',
        '%': '%%',
        $: forExec ? '$$' : '$',
      };
      return controls[character] ?? character;
    })
    .join('');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('systemd user-service installer', () => {
  it('escapes absolute paths without quoting them as unit values', () => {
    const { bin, home, repo, unitFile } = makeInstallFixture();
    const unit = readFileSync(unitFile, 'utf8');
    const config = join(home, '.config', 'lugn', 'config.json');
    const environment = join(home, '.config', 'lugn', 'lugn.env');
    const canonicalRepo = realpathSync(repo);

    expect(unit).toContain(`WorkingDirectory=${escapePath(canonicalRepo)}`);
    expect(unit).toContain(`EnvironmentFile=${escapePath(environment)}`);
    expect(unit).toContain(
      `ExecStart=:${escapePath(join(bin, 'node'), true)} ${escapePath(join(canonicalRepo, 'dist/runtime/main.js'), true)} ${escapePath(config, true)}`,
    );
    expect(unit).not.toContain('WorkingDirectory="/');
    expect(unit).not.toContain('EnvironmentFile="/');
    expect(unit).not.toContain('ExecStart="/');
  });

  it('produces a unit accepted by systemd-analyze when available', () => {
    const { unitFile } = makeInstallFixture();
    if (!existsSync('/usr/bin/systemd-analyze')) return;

    const result = spawnSync(
      '/usr/bin/systemd-analyze',
      ['--user', 'verify', unitFile],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
  });
});
