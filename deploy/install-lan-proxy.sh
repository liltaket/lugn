#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: install-lan-proxy.sh <hostname> <lan-bind-ip> <trusted-lan-cidr>

Installs a systemd --user service for Caddy. Install the official Caddy binary
at ~/.local/bin/caddy first. Example:
  deploy/install-lan-proxy.sh brunocam.local 192.168.10.132 192.168.10.0/24
EOF
  exit 2
}

fail() {
  printf 'lugn LAN proxy: %s\n' "$1" >&2
  exit 1
}

[[ $# -eq 3 ]] || usage
proxy_host="$1"
proxy_bind="$2"
proxy_cidr="$3"
home_dir="${HOME:?HOME must be set}"
[[ "$home_dir" = /* ]] || fail 'HOME must be an absolute path.'
[[ ! -L "$home_dir" ]] || fail 'HOME must not be a symbolic link.'
home_dir="$(cd -- "$home_dir" && pwd -P)"

command -v systemctl >/dev/null 2>&1 || fail 'systemctl is required.'
systemctl --user show-environment >/dev/null 2>&1 || fail 'systemd --user is unavailable for this account.'
command -v python3 >/dev/null 2>&1 || fail 'python3 is required for input validation.'
caddy_bin="$home_dir/.local/bin/caddy"
[[ -f "$caddy_bin" && -x "$caddy_bin" && ! -L "$caddy_bin" ]] ||
  fail "install the official executable Caddy binary at $caddy_bin first."

python3 - "$proxy_host" "$proxy_bind" "$proxy_cidr" <<'PY'
import ipaddress
import re
import sys

host, bind, cidr = sys.argv[1:]
labels = host.split(".")
valid_host = (
    len(host) <= 253
    and len(labels) >= 2
    and all(
        1 <= len(label) <= 63
        and re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?", label)
        for label in labels
    )
)
if not valid_host:
    raise SystemExit("lugn LAN proxy: hostname must be a lowercase DNS name")

try:
    bind_ip = ipaddress.ip_address(bind)
    network = ipaddress.ip_network(cidr, strict=False)
except ValueError as error:
    raise SystemExit(f"lugn LAN proxy: invalid LAN bind IP or CIDR: {error}")

private_networks = (
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
)
if (
    bind_ip.version != 4
    or network.version != 4
    or bind_ip.is_unspecified
    or not any(network.subnet_of(private) for private in private_networks)
    or bind_ip not in network
):
    raise SystemExit(
        "lugn LAN proxy: bind IP and CIDR must be inside the same RFC1918 IPv4 LAN"
    )
PY

config_root="$home_dir/.config/lugn-lan-proxy"
data_root="$home_dir/.local/share/caddy"
unit_root="$home_dir/.config/systemd/user"
caddyfile="$config_root/Caddyfile"
environment_file="$config_root/proxy.env"
unit_file="$unit_root/lugn-lan-proxy.service"
template="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/lugn-lan-proxy.Caddyfile"

for path in \
  "$home_dir/.config" "$config_root" "$home_dir/.local" \
  "$home_dir/.local/share" "$data_root" \
  "$home_dir/.config/systemd" "$unit_root"; do
  [[ ! -L "$path" ]] || fail "$path must not be a symbolic link."
done
[[ -f "$template" ]] || fail 'the Caddyfile template is missing.'
install -d -m 700 "$config_root" "$data_root" "$unit_root"

managed_file() {
  local path="$1"
  local marker="$2"
  [[ ! -L "$path" ]] || fail "$path must not be a symbolic link."
  if [[ -e "$path" ]]; then
    [[ -f "$path" ]] || fail "$path must be a regular file."
    grep -Fq "$marker" "$path" ||
      fail "$path already exists and is not managed by this installer."
  fi
}

managed_file "$caddyfile" '# Managed by deploy/install-lan-proxy.sh'
managed_file "$environment_file" '# Managed by deploy/install-lan-proxy.sh'
managed_file "$unit_file" '# Managed by deploy/install-lan-proxy.sh'

temporary_caddyfile="$(mktemp "$config_root/.Caddyfile.XXXXXX")"
temporary_environment="$(mktemp "$config_root/.proxy.env.XXXXXX")"
temporary_unit="$(mktemp "$unit_root/.lugn-lan-proxy.service.XXXXXX")"
trap 'rm -f -- "$temporary_caddyfile" "$temporary_environment" "$temporary_unit"' EXIT

{
  printf '# Managed by deploy/install-lan-proxy.sh\n'
  cat -- "$template"
} >"$temporary_caddyfile"
cat >"$temporary_environment" <<EOF
# Managed by deploy/install-lan-proxy.sh
LUGN_PROXY_HOST=$proxy_host
LUGN_PROXY_PORT=8443
LUGN_PROXY_BIND=$proxy_bind
LUGN_PROXY_LAN_CIDR=$proxy_cidr
EOF
cat >"$temporary_unit" <<'EOF'
# Managed by deploy/install-lan-proxy.sh
[Unit]
Description=Lugn LAN HTTPS proxy
Requires=lugn.service
After=lugn.service
PartOf=lugn.service

[Service]
Type=simple
EnvironmentFile=%h/.config/lugn-lan-proxy/proxy.env
Environment=XDG_DATA_HOME=%h/.local/share
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=%h/.local/share/caddy
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ExecStart=%h/.local/bin/caddy run --config %h/.config/lugn-lan-proxy/Caddyfile --adapter caddyfile
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

chmod 600 "$temporary_caddyfile" "$temporary_environment" "$temporary_unit"
export LUGN_PROXY_HOST="$proxy_host"
export LUGN_PROXY_PORT=8443
export LUGN_PROXY_BIND="$proxy_bind"
export LUGN_PROXY_LAN_CIDR="$proxy_cidr"
export XDG_DATA_HOME="$home_dir/.local/share"
"$caddy_bin" validate --config "$temporary_caddyfile" --adapter caddyfile

mv -f -- "$temporary_caddyfile" "$caddyfile"
mv -f -- "$temporary_environment" "$environment_file"
mv -f -- "$temporary_unit" "$unit_file"
trap - EXIT
systemctl --user daemon-reload

printf 'Installed %s\n' "$unit_file"
printf 'Caddy configuration: %s\n' "$caddyfile"
printf 'LAN listener: https://%s:8443/ui/ (bind %s; allow %s)\n' \
  "$proxy_host" "$proxy_bind" "$proxy_cidr"
printf 'Trusted origin for Lugn: https://%s:8443\n' "$proxy_host"
printf 'Start after reviewing the configuration: systemctl --user enable --now lugn-lan-proxy.service\n'
