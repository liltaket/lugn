#!/usr/bin/env bash
set -euo pipefail
if ! command -v systemd-analyze >/dev/null; then
  echo 'Govee systemd parsing fixture skipped: systemd-analyze unavailable.'
  exit 0
fi
repo_root=$(cd "$(dirname "$0")/.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/home with space" "$fixture/release with space/dist/runtime"
printf '#!/bin/sh\nexit 0\n' > "$fixture/bin/systemctl"
chmod +x "$fixture/bin/systemctl"
touch "$fixture/release with space/dist/runtime/govee-effects-bridge.js"
touch "$fixture/runtime config.json" "$fixture/private env" "$fixture/bridge config.json" "$fixture/platform secret.env"
# Real systemd parsing catches directives that silently treat quotes as path bytes.
HOME="$fixture/home with space" PATH="$fixture/bin:$PATH" bash "$repo_root/deploy/install-govee-effects-service.sh" \
  "$(command -v node)" "$fixture/release with space" "$fixture/runtime config.json" \
  "$fixture/private env" "$fixture/bridge config.json" "$fixture/platform secret.env"
unit="$fixture/home with space/.config/systemd/user/lugn-govee-effects.service"
[[ $(rg -c '^EnvironmentFile=' "$unit") == 2 ]]
output=$(systemd-analyze --user verify "$unit" 2>&1)
if [[ "$output" == *'lugn-govee-effects.service:'* ]]; then
  printf '%s\n' "$output" >&2
  exit 1
fi
printf 'Govee service systemd parsing fixture passed.\n'
