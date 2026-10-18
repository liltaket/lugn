#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'lugn-linux-agent install: %s\n' "$1" >&2
  exit 1
}

[[ $# -le 1 ]] || fail 'usage: install.sh [path/to/release/lugn-linux-agent]'
agent_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
home_dir="${HOME:?HOME must be set}"
config_home="${XDG_CONFIG_HOME:-$home_dir/.config}"
[[ "$home_dir" = /* && "$config_home" = /* ]] || fail 'HOME and XDG_CONFIG_HOME must be absolute paths.'

binary_source="${1:-$agent_dir/target/release/lugn-linux-agent}"
binary_dir="$home_dir/.local/bin"
config_dir="$config_home/lugn-linux-agent"
config_file="$config_dir/config.toml"
unit_dir="$config_home/systemd/user"
unit_name='lugn-linux-agent.service'

[[ -f "$binary_source" && -x "$binary_source" ]] || fail 'Release binary missing or not executable; run cargo build --release or pass its path.'
[[ -f "$agent_dir/config.example.toml" ]] || fail 'config.example.toml is missing.'
[[ -f "$agent_dir/systemd/$unit_name" ]] || fail 'The systemd user service file is missing.'
[[ ! -L "$config_file" ]] || fail 'config.toml must not be a symbolic link.'
[[ ! -e "$config_file" || -f "$config_file" ]] || fail 'config.toml must be a regular file.'
command -v systemctl >/dev/null 2>&1 || fail 'systemctl is required.'
systemctl --user show-environment >/dev/null 2>&1 || fail 'A systemd user manager is required; run this as the desktop user.'

mkdir -p -- "$binary_dir" "$unit_dir"
install -d -m 700 -- "$config_dir"
install -m 755 -- "$binary_source" "$binary_dir/lugn-linux-agent"
if [[ ! -e "$config_file" ]]; then
  # noclobber also prevents overwriting a config created during installation.
  (umask 077; set -o noclobber; cat -- "$agent_dir/config.example.toml" > "$config_file")
fi
chmod 600 -- "$config_file"
install -m 644 -- "$agent_dir/systemd/$unit_name" "$unit_dir/$unit_name"
systemctl --user daemon-reload
systemctl --user enable "$unit_name"

printf 'Installed %s\n' "$binary_dir/lugn-linux-agent"
printf 'Config: %s (mode 0600; existing contents preserved)\n' "$config_file"
printf 'Enabled graphical-session startup. The service has not been started.\n'
printf 'Edit the config first, then run: systemctl --user start %s\n' "$unit_name"
printf 'Optional MQTT password override: LUGN_MQTT_PASSWORD in %s/environment (mode 0600).\n' "$config_dir"
