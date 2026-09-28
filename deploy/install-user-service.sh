#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
home_dir="${HOME:?HOME must be set}"
[[ "$home_dir" = /* ]] || {
  printf 'lugn install: HOME must be an absolute path.\n' >&2
  exit 1
}
config_home="$home_dir/.config"
config_root="$config_home/lugn"
systemd_root="$config_home/systemd"
unit_dir="$systemd_root/user"
config_file="$config_root/config.json"
environment_file="$config_root/lugn.env"
unit_file="$unit_dir/lugn.service"

fail() {
  printf 'lugn install: %s\n' "$1" >&2
  exit 1
}

command -v systemctl >/dev/null 2>&1 || fail 'systemctl is required.'
systemctl --user show-environment >/dev/null 2>&1 || fail 'systemd --user is unavailable for this account.'
command -v node >/dev/null 2>&1 || fail 'Node.js 22 or newer is required.'
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || fail 'Node.js 22 or newer is required.'
node_path="$(command -v node)"
[[ -f "$repo_dir/dist/runtime/main.js" ]] || fail 'Build Lugn first with npm ci && npm run build.'
[[ -f "$repo_dir/config.example.json" ]] || fail 'config.example.json was not found in the repository.'

for path in "$config_home" "$config_root" "$systemd_root" "$unit_dir"; do
  [[ ! -L "$path" ]] || fail "$path must not be a symbolic link."
done
install -d -m 700 "$config_root" "$unit_dir"
for path in "$config_file" "$environment_file" "$unit_file"; do
  [[ ! -L "$path" ]] || fail "$path must not be a symbolic link."
  if [[ -e "$path" && ! -f "$path" ]]; then
    fail "$path must be a regular file."
  fi
done
if [[ ! -e "$config_file" ]]; then
  install -m 600 "$repo_dir/config.example.json" "$config_file"
fi
if [[ ! -e "$environment_file" ]]; then
  install -m 600 /dev/null "$environment_file"
fi
chmod 600 "$config_file" "$environment_file"

systemd_path() {
  local value="$1"
  local mode="${2:-path}"
  local escaped=""
  local character

  [[ "$value" = /* ]] || fail 'systemd paths must be absolute.'

  while [[ -n "$value" ]]; do
    character="${value:0:1}"
    value="${value:1}"
    case "$character" in
      ' ') escaped+='\\x20' ;;
      $'\t') escaped+='\\x09' ;;
      $'\n') escaped+='\\x0a' ;;
      $'\r') escaped+='\\x0d' ;;
      $'\v') escaped+='\\x0b' ;;
      $'\f') escaped+='\\x0c' ;;
      '\\') escaped+='\\x5c' ;;
      '"') escaped+='\\x22' ;;
      "'") escaped+='\\x27' ;;
      '%') escaped+='%%' ;;
      '$')
        if [[ "$mode" = exec ]]; then
          escaped+='$$'
        else
          escaped+='$'
        fi
        ;;
      *) escaped+="$character" ;;
    esac
  done

  printf '%s' "$escaped"
}

temporary_unit="$(mktemp "$unit_dir/.lugn.service.XXXXXX")"
trap 'rm -f -- "$temporary_unit"' EXIT
cat >"$temporary_unit" <<EOF
[Unit]
Description=Lugn local room controller
After=network.target

[Service]
Type=simple
WorkingDirectory=$(systemd_path "$repo_dir")
EnvironmentFile=$(systemd_path "$environment_file")
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ExecStart=$(systemd_path "$node_path" exec) $(systemd_path "$repo_dir/dist/runtime/main.js" exec) $(systemd_path "$config_file" exec)
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
chmod 600 "$temporary_unit"
mv -f -- "$temporary_unit" "$unit_file"
trap - EXIT
systemctl --user daemon-reload

printf 'Installed %s\n' "$unit_file"
printf 'Config: %s\n' "$config_file"
printf 'Secret environment file: %s (mode 0600)\n' "$environment_file"
printf '\nEdit config.json with your Home Assistant entities and MQTT settings. Add the referenced secret variables to lugn.env without sharing them.\n'
printf 'Then start Lugn with: systemctl --user enable --now lugn.service\n'
printf 'Inspect status with: systemctl --user status lugn.service\n'
printf 'Read logs with: journalctl --user -u lugn.service -f\n'
