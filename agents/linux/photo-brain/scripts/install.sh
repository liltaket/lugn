#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'lugn-photo-brain install: %s\n' "$1" >&2
  exit 1
}

[[ $# -le 1 ]] || fail 'usage: install.sh [path/to/release/lugn-photo-brain]'
crate_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
home_dir="${HOME:?HOME must be set}"
config_home="${XDG_CONFIG_HOME:-$home_dir/.config}"
[[ "$home_dir" = /* && "$config_home" = /* ]] || fail 'HOME and XDG_CONFIG_HOME must be absolute paths.'

target_dir="${CARGO_TARGET_DIR:-$crate_dir/target}"
binary_source="${1:-$target_dir/release/lugn-photo-brain}"
binary_dir="$home_dir/.local/bin"
config_dir="$config_home/lugn-photo-brain"
config_file="$config_dir/config.toml"
environment_file="$config_dir/environment"
unit_dir="$config_home/systemd/user"
unit_name='lugn-photo-brain.service'

[[ -f "$binary_source" && -x "$binary_source" ]] || fail 'Release binary missing or not executable; run cargo build --release or pass its path.'
[[ -f "$crate_dir/config.example.toml" ]] || fail 'config.example.toml is missing.'
[[ -f "$crate_dir/$unit_name" ]] || fail 'The systemd user service file is missing.'
for file in "$config_file" "$environment_file"; do
  [[ ! -L "$file" ]] || fail "$(basename -- "$file") must not be a symbolic link."
  [[ ! -e "$file" || -f "$file" ]] || fail "$(basename -- "$file") must be a regular file."
done
command -v systemctl >/dev/null 2>&1 || fail 'systemctl is required.'
systemctl --user show-environment >/dev/null 2>&1 || fail 'A systemd user manager is required; run this as the desktop user.'

mkdir -p -- "$binary_dir" "$unit_dir"
install -d -m 700 -- "$config_dir"
install -m 755 -- "$binary_source" "$binary_dir/lugn-photo-brain"
if [[ ! -e "$config_file" ]]; then
  # noclobber also prevents overwriting a config created during installation.
  (umask 077; set -o noclobber; cat -- "$crate_dir/config.example.toml" > "$config_file")
fi
chmod 600 -- "$config_file"
if [[ ! -e "$environment_file" ]]; then
  (umask 077; set -o noclobber; printf '# LUGN_PHOTO_BRAIN_TOKEN=\n' > "$environment_file")
fi
chmod 600 -- "$environment_file"
install -m 644 -- "$crate_dir/$unit_name" "$unit_dir/$unit_name"
systemctl --user daemon-reload
systemctl --user enable "$unit_name"

printf 'Installed %s\n' "$binary_dir/lugn-photo-brain"
printf 'Config: %s (mode 0600; existing contents preserved)\n' "$config_file"
printf 'Token: LUGN_PHOTO_BRAIN_TOKEN in %s (mode 0600)\n' "$environment_file"
printf 'Enabled at login (default.target). The service has not been started.\n'
printf 'Edit both files first, check with: lugn-photo-brain status\n'
printf 'then run: systemctl --user start %s\n' "$unit_name"
