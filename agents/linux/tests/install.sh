#!/usr/bin/env bash
set -euo pipefail

agent_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

fail() {
  printf 'installer test: %s\n' "$1" >&2
  exit 1
}

# Exercise the real installer and unit in a disposable release tree. Never call
# the host systemctl or copy the development binary into the real user's home.
fixture="$test_root/release"
mkdir -p "$fixture/scripts" "$fixture/systemd" "$fixture/target/release" "$test_root/stubs"
cp "$agent_dir/scripts/install.sh" "$fixture/scripts/install.sh"
cp "$agent_dir/systemd/lugn-linux-agent.service" "$fixture/systemd/"
cp "$agent_dir/config.example.toml" "$fixture/"
printf '#!/bin/sh\nexit 0\n' > "$fixture/target/release/lugn-linux-agent"
chmod 755 "$fixture/target/release/lugn-linux-agent"
cat > "$test_root/stubs/systemctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
[[ "${SYSTEMCTL_UNAVAILABLE:-0}" != 1 ]]
EOF
chmod 755 "$test_root/stubs/systemctl"
export PATH="$test_root/stubs:$PATH"
export SYSTEMCTL_LOG="$test_root/systemctl.log"
export HOME="$test_root/home with spaces %"
unset XDG_CONFIG_HOME

check_install() {
  local config_home="$1"
  cmp "$fixture/config.example.toml" "$config_home/lugn-linux-agent/config.toml" || fail 'example config differs'
  [[ "$(stat -c %a "$config_home/lugn-linux-agent/config.toml")" = 600 ]] || fail 'config is not mode 600'
  [[ "$(stat -c %a "$HOME/.local/bin/lugn-linux-agent")" = 755 ]] || fail 'binary is not mode 755'
  cmp "$fixture/systemd/lugn-linux-agent.service" "$config_home/systemd/user/lugn-linux-agent.service" || fail 'unit differs'
  local expected=$'--user show-environment\n--user daemon-reload\n--user enable lugn-linux-agent.service'
  [[ "$(cat "$SYSTEMCTL_LOG")" = "$expected" ]] || fail 'installer must enable without starting'
}

bash "$fixture/scripts/install.sh" >/dev/null
check_install "$HOME/.config"

# Reinstalling upgrades the binary/unit but preserves edited credentials/config.
printf 'preserved = "private configuration"\n' > "$HOME/.config/lugn-linux-agent/config.toml"
chmod 640 "$HOME/.config/lugn-linux-agent/config.toml"
cp "$HOME/.config/lugn-linux-agent/config.toml" "$test_root/preserved.toml"
bash "$fixture/scripts/install.sh" >/dev/null
cmp "$test_root/preserved.toml" "$HOME/.config/lugn-linux-agent/config.toml" || fail 'existing config overwritten'
[[ "$(stat -c %a "$HOME/.config/lugn-linux-agent/config.toml")" = 600 ]] || fail 'existing config permissions not protected'

# Explicit binary paths and custom XDG configuration directories are supported.
export HOME="$test_root/xdg-home"
export XDG_CONFIG_HOME="$test_root/custom config %"
: > "$SYSTEMCTL_LOG"
cp "$fixture/target/release/lugn-linux-agent" "$test_root/explicit-binary"
bash "$fixture/scripts/install.sh" "$test_root/explicit-binary" >/dev/null
check_install "$XDG_CONFIG_HOME"
[[ ! -e "$HOME/.config" ]] || fail 'custom XDG_CONFIG_HOME ignored'

# Failed preflight must leave the target home untouched.
export HOME="$test_root/unavailable-home"
export XDG_CONFIG_HOME="$HOME/.config"
if SYSTEMCTL_UNAVAILABLE=1 bash "$fixture/scripts/install.sh" >/dev/null 2>&1; then
  fail 'accepted unavailable systemd user manager'
fi
[[ ! -e "$HOME" ]] || fail 'preflight failure modified the target home'

# A linked config must not allow the installer to chmod or overwrite its target.
export HOME="$test_root/linked-home"
export XDG_CONFIG_HOME="$HOME/.config"
mkdir -p "$XDG_CONFIG_HOME/lugn-linux-agent"
chmod 640 "$test_root/preserved.toml"
ln -s "$test_root/preserved.toml" "$XDG_CONFIG_HOME/lugn-linux-agent/config.toml"
if bash "$fixture/scripts/install.sh" >/dev/null 2>&1; then
  fail 'accepted linked config'
fi
[[ "$(stat -c %a "$test_root/preserved.toml")" = 640 ]] || fail 'linked config target modified'

printf 'installer tests passed\n'
