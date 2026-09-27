#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/lugn installer fixture.XXXXXX")"
trap 'rm -rf -- "$fixture_root"' EXIT

repo="$fixture_root/repo \$cash %p with spaces"
home="$fixture_root/home %h with spaces"
bin="$fixture_root/node \$bin %u with spaces"
installer="$repo/deploy/install-user-service.sh"
unit_file="$home/.config/systemd/user/lugn.service"

mkdir -p "$repo/deploy" "$repo/dist/runtime" "$home" "$bin"
cp "$repo_root/deploy/install-user-service.sh" "$installer"
printf '{}\n' >"$repo/config.example.json"
: >"$repo/dist/runtime/main.js"

cat >"$bin/node" <<'EOF'
#!/bin/sh
[ "${1:-}" = -e ]
EOF
cat >"$bin/systemctl" <<'EOF'
#!/bin/sh
case "$*" in
  "--user show-environment"|"--user daemon-reload") exit 0 ;;
  *) exit 97 ;;
esac
EOF
chmod 755 "$bin/node" "$bin/systemctl"

PATH="$bin:/usr/bin:/bin" HOME="$home" /bin/bash "$installer" >/dev/null
repo_dir="$(cd -- "$repo" && pwd -P)"

unit_has_line() {
  local expected="$1"
  if ! /usr/bin/grep -Fqx -- "$expected" "$unit_file"; then
    printf 'Expected unit line not found: %s\n' "$expected" >&2
    return 1
  fi
}

escape_spaces_and_specifiers() {
  local value="$1"
  value="${value//%/%%}"
  value="${value// /\\x20}"
  printf '%s' "$value"
}

config="$home/.config/lugn/config.json"
environment="$home/.config/lugn/lugn.env"
unit_has_line "WorkingDirectory=$(escape_spaces_and_specifiers "$repo_dir")"
unit_has_line "EnvironmentFile=$(escape_spaces_and_specifiers "$environment")"
unit_has_line "ExecStart=:$(escape_spaces_and_specifiers "$bin/node") $(escape_spaces_and_specifiers "$repo_dir/dist/runtime/main.js") $(escape_spaces_and_specifiers "$config")"

if /usr/bin/grep -Eq '^(WorkingDirectory|EnvironmentFile|ExecStart)="/' "$unit_file"; then
  printf 'Path values must not be wrapped in quotes.\n' >&2
  exit 1
fi

if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze --user verify "$unit_file"
else
  printf 'systemd-analyze unavailable; generated-value assertions passed.\n'
fi

printf 'systemd installer fixture passed.\n'
