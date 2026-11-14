#!/usr/bin/env bash
set -euo pipefail
# Explicit paths preserve the existing Lugn config, secrets, state and service.
if [[ $# != 5 && $# != 6 ]]; then
  echo 'Usage: install-govee-effects-service.sh NODE RELEASE LUGN_CONFIG ENV_FILE BRIDGE_CONFIG [PLATFORM_ENV_FILE]' >&2
  exit 2
fi
node_path=$(realpath "$1")
release_path=$(realpath "$2")
runtime_config=$(realpath "$3")
environment_path=$(realpath "$4")
bridge_config=$(realpath "$5")
platform_environment=""
extra_environment=""
if [[ $# == 6 ]]; then
  platform_environment=$(realpath "$6")
  extra_environment="EnvironmentFile=$platform_environment"
fi
for path in "$node_path" "$release_path" "$runtime_config" "$environment_path" "$bridge_config" "$platform_environment"; do
  if [[ "$path" == *'"'* || "$path" == *$'\n'* || "$path" == *'%'* || "$path" == *'\\'* ]]; then
    echo 'Unsupported systemd path' >&2
    exit 2
  fi
done
[[ -x "$node_path" && -f "$release_path/dist/runtime/govee-effects-bridge.js" ]]
cache_path="$HOME/.local/state/lugn-govee"
mkdir -p "$HOME/.config/systemd/user" "$cache_path"
chmod 700 "$cache_path"
unit_path="$HOME/.config/systemd/user/lugn-govee-effects.service"
if [[ -f "$unit_path" ]]; then cp -p "$unit_path" "$unit_path.backup-$(date +%Y%m%dT%H%M%S)"; fi
cat > "$unit_path" <<UNIT
[Unit]
Description=Local Govee app effect selectors for Home Assistant
After=network-online.target lugn.service
Wants=network-online.target lugn.service

[Service]
Type=simple
WorkingDirectory=$release_path
EnvironmentFile=$environment_path
$extra_environment
ExecStart="$node_path" "$release_path/dist/runtime/govee-effects-bridge.js" "$runtime_config" "$bridge_config"
Restart=on-failure
RestartSec=10
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths="$cache_path"
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
UMask=0077

[Install]
WantedBy=default.target
UNIT
systemd-analyze --user verify "$unit_path"
systemctl --user daemon-reload
printf 'Installed %s (not started). Cache must be %s in bridge config.\n' "$unit_path" "$cache_path"
