# Paired-device API on BrunoCAM over the LAN

Deployment plan and checklist for turning on the paired-device listener
(`/api/v1`, config key `device`, see [IOS-API.md](../IOS-API.md) and
[OPERATIONS.md](../OPERATIONS.md#paired-device-api-native-app)) on the
production Lugn host BrunoCAM, **LAN only**. The owner decided on 2026-11-16 not
to install Tailscale on that host (see the decision update in
[REACHABILITY.md](REACHABILITY.md)).

Status: **plan only. Nothing here has been executed.** Written 2026-11-16. The
live host was inspected read-only over the existing key-only SSH login. No
service was restarted, no file on the host was changed and no secret was read
or printed.

Evidence labels:

- **[observed]**: seen on BrunoCAM or Kuffe on 2026-11-16 with read-only
  commands. Runtime values (CPU, memory, uptime) are a snapshot and will drift.
- **[source]**: this repository's code at `70048e0`, with file and line.
- **[Apple]**, **[Caddy]**: vendor documentation, as cited in REACHABILITY.md.
- **[unverified]**: inference. Confirm it while running the checklist.

## Facts this plan rests on

| Fact                                                                                                                                                                                                             | Evidence   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| BrunoCAM: Raspberry Pi, aarch64, 4 cores, 905 MiB RAM, Debian 13. Only network interface is `wlan0`, `192.168.10.132/24`, address from DHCP (netplan). IPv6 ULA `fd68:…:66e1/64` is also present.                | [observed] |
| Listening TCP today: `0.0.0.0:22`, `0.0.0.0:8080` (doorway sensor), `0.0.0.0:8788` (Hub display), `127.0.0.1:8787` (Lugn API and panel). **Nothing on 8789**, and **8443 is not listening**.                     | [observed] |
| `lugn-lan-proxy.service` (Caddy, 8443) is enabled but has been inactive since 2026-11-14 12:54 with `Result=success`.                                                                                            | [observed] |
| No host firewall is active: `ufw` is not installed, `nftables.service` and `firewalld` are inactive, `/usr/sbin/nft` exists. The loaded ruleset needs root to list, so "no rules" is [unverified].               | [observed] |
| The running release is `~/lugn-govee-221c985`, launched by `90-lugn-release.conf` with `~/.config/lugn/config-lugn2-test-91335a4.json`. The active config has **no `device` key**.                               | [observed] |
| `221c985` is on the **unmerged branch `govee-lan-effects-control`**. It shares merge base `967e08c` with this iOS branch. The device API (`daadacd`, `fca6116`, `34d0742`) is on neither `main` nor that branch. | [source]   |
| `git merge-tree 221c985 70048e0` merges without conflicts. The only file both lines touch is `src/application/lugn-engine.ts`. `package-lock.json` is unchanged on the iOS line.                                 | [source]   |
| Lugn's API bearer env var is `LUGN_API_TOKEN_B64` (base64url-decoded at load, `src/runtime/config.ts:814`). `/health` also needs the bearer (`src/runtime/http-server.ts:185`).                                  | [observed] |
| User unit: `After=network.target`, `Restart=on-failure`, `RestartSec=3`, `EnvironmentFile=~/.config/lugn/lugn.env`. Lingering is on.                                                                             | [observed] |
| `journalctl --user` finds no files for `bruno`. `journalctl _SYSTEMD_USER_UNIT=lugn.service` works because `bruno` is in `adm`.                                                                                  | [observed] |
| mDNS: avahi publishes `brunocam.local` (`publish-workstation=yes`, `use-ipv6=yes`), and it resolves to `192.168.10.132` on the host.                                                                             | [observed] |
| The web panel has **no pairing UI**. `/ui/api/devices*` exists only as a session API (no matches for pairing under `web/`).                                                                                      | [source]   |

### CPU and memory headroom

Two samples, 2026-11-16 about 17:50 CET [observed]:

| Measure                                | `top`, 5 s                          | `/proc` delta, 30 s |
| -------------------------------------- | ----------------------------------- | ------------------- |
| Host idle (of 4 cores)                 | 69 %                                | 56 %                |
| Doorway sensor (`python3 -m app.main`) | 109 % of one core                   | 217 % of one core   |
| Lugn (`main.js`)                       | 4.4 % of one core                   | 9.7 % of one core   |
| Govee bridge                           | 0.4 % of one core                   | 2.8 % of one core   |
| Load average                           | 1.1–1.2                             |                     |
| Memory                                 | 425 MiB available, 95 MiB swap used |                     |
| RSS: Lugn / Govee bridge / sensor      | 164 / 138 / 137 MiB                 |                     |
| SoC temperature                        | 72 °C                               |                     |
| `vcgencmd get_throttled`               | `0x60000`                           |                     |

The sensor used far more than the ~72 % of one core recorded on 2026-11-10.
The cause is unknown: someone may have had the sensor page open, or something
changed [unverified]. `0x60000` means ARM frequency capping and throttling
**have happened since boot**. Neither is active now. The scarce resource is
CPU during build and while the sensor is busy, plus RAM: 425 MiB is available,
and `tsc` and `npm ci` on a Pi can use a large share of that [unverified,
measure it].

The device listener's own cost has **not been measured**. An idle listener
should cost almost nothing. Each open SSE stream rebuilds the `StateView`
(`src/application/state-view.ts`, 682 lines) on engine publishes, so measure
it with one stream open (step B5).

## 1. Config diff

Add this block to the **active** config,
`~/.config/lugn/config-lugn2-test-91335a4.json`, as a sibling of `http`:

```diff
   "statePath": "/home/bruno/.local/state/lugn/lighting-intent-lugn2-test-91335a4.json",
+  "device": {
+    "enabled": true,
+    "host": "192.168.10.132",
+    "port": 8789,
+    "allowedHosts": ["192.168.10.132:8789", "brunocam.local:8789"]
+  },
```

- Leave `device.phone` out. The defaults apply: `motion` and `network` off,
  and **`arrivalPrelight.enabled: false`**. Keep it off for the first rollout
  so no phone input can affect lighting ([PRESENCE.md](../PRESENCE.md#phone-hints)).
- `port: 8789` is free [observed]. Config validation rejects 8787 and 8788
  (`src/runtime/config.ts:358`).
- Lugn stores paired devices in
  `~/.local/state/lugn/lighting-intent-lugn2-test-91335a4.json.devices.json`
  (mode `0600`, token digests only). The unit can already write to that
  directory.

### Binding: the LAN IPv4 address or `0.0.0.0`

| Option                                          | Pros                                                                                                                                                                                                  | Cons                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`"host": "192.168.10.132"` (recommended)**    | Listens on exactly one socket. Loopback, IPv6 and any future interface (USB Ethernet, Docker, a VPN) are never exposed. Same pattern as the Govee bridge's `192.168.10.132:4002` and the Caddy proxy. | The bind fails if `wlan0` has no address when Lugn starts. A failed device bind **aborts the whole Lugn startup** (`src/runtime/main.ts:950`, inside the startup `try`) [source]. A changed DHCP lease kills the listener until a restart.           |
| `"host": "0.0.0.0", "allowAllInterfaces": true` | The bind never fails at boot, so Lugn's startup does not depend on Wi-Fi timing.                                                                                                                      | Listens on every IPv4 interface that exists now or later. Today that is only `wlan0` and `lo` [observed], but a future interface is exposed silently. The firewall rule stops being optional. Lugn has no source-address filter of its own [source]. |

Boot behaviour with the LAN address: `After=network.target` does not wait for
DHCP. If the address is missing, Lugn exits and systemd retries every 3 s.
The default start limit (5 starts in 10 s) should not trip at that rate
[unverified]. Each retry re-runs the Home Assistant seeding. Lugn itself also
needs the network for Home Assistant at startup, so this adds little new
dependence [unverified]. Optional hardening without sudo: a user drop-in with
`ExecStartPre=/bin/sh -c 'for i in $(seq 60); do ip -4 addr show wlan0 | grep -q "inet 192.168.10.132/" && exit 0; sleep 1; done; exit 1'`.
User units cannot order themselves after the system's `network-online.target`,
so that target is not a fix.

A socket bound to an address that disappears during a Wi-Fi drop should keep
working once the **same** address returns [unverified for this host]. That is
one more reason for the DHCP reservation (section 5).

### `allowedHosts` and why the Host check matters on a LAN

Every request's `Host` must exactly match one entry, port included, or the
listener answers `421 host_not_allowed` before authentication
(`src/runtime/device-server.ts:299`) [source]. URLSession sends
`192.168.10.132:8789` for an IP URL and `brunocam.local:8789` for the mDNS
URL [unverified, standard HTTP behaviour]. List only the names the app will
use. Each entry's port must equal `device.port` (`device-config.ts:99`).

It matters on a LAN because of **DNS rebinding**: any web page opened on any
LAN browser can point its own domain at `192.168.10.132`. After the rebind the
browser treats requests to the listener as same-origin and may send them
without an `Origin` header. The `Host` header still carries the attacker's
domain, so the exact allowlist is the control that stops it. A browser could
otherwise burn the pairing-guess budget, probe the API or, with a token taken
from elsewhere, drive it. The `Origin` → `403` check covers cross-origin
browser requests. The Host check covers the rebinding case. The Host check is
**not** a defence against a native LAN client, which can send any Host it
likes. Only the token stops that client.

### Firewall: TCP 8789 from the LAN CIDR only (optional, needs sudo)

No firewall runs today [observed], and binding the LAN address already keeps
the listener off every other interface. With no router port forward, a rule
is **defence in depth**, not a boundary against a LAN attacker. Do not enable
`nftables.service` with the stock `/etc/nftables.conf`. On Debian that file
starts with `flush ruleset` and a policy-accept skeleton [unverified on this
host, read it first], and a later edit could cut off SSH, `8080`, `8788`,
mDNS or the Govee UDP traffic. Add a **separate table that only touches port
8789**:

```nft
# /etc/nftables.d/lugn-device.nft   (new file; validate with: sudo nft -c -f <file>)
table inet lugn_device
delete table inet lugn_device
table inet lugn_device {
  set conns { type ipv4_addr; size 256; flags dynamic; }
  chain input {
    type filter hook input priority 0; policy accept;
    tcp dport 8789 iif "lo" accept
    tcp dport 8789 meta nfproto ipv6 drop
    tcp dport 8789 ip saddr != 192.168.10.0/24 drop
    # Optional: cap concurrent connections per LAN source (SSE uses 1–2).
    tcp dport 8789 ct state new add @conns { ip saddr ct count over 16 } reject with tcp reset
  }
}
```

Persist it with a root oneshot unit, `lugn-device-firewall.service`, that runs
`nft -f /etc/nftables.d/lugn-device.nft`, so no other rule on the host is
touched. Roll back with `sudo nft delete table inet lugn_device` and disable
that unit. The syntax is [unverified]. Check it with `nft -c -f` first. The
existing NOPASSWD drop-in (`/etc/sudoers.d/020_agent-deploy`) does **not**
cover `nft` or unit installs, so this step needs the sudo password through the
secure prompt. Also confirm in the router that neither a port forward nor
UPnP exposes 8789. Lugn does no UPnP [source].

### Could Caddy front it instead?

Yes. Caddy v2.11.7 is installed at `~/.local/bin/caddy`, and its internal CA
root already exists [observed]. The shape would be: Lugn `device.host:
"127.0.0.1"`, port 8789. A second Caddy site, `brunocam.local:8789`, bound to
`192.168.10.132` with `tls internal`, the same `not remote_ip 192.168.10.0/24`
→ `403`, and `reverse_proxy 127.0.0.1:8789`. `allowedHosts` becomes
`["brunocam.local:8789"]`. Caddy must use **the same port number** as Lugn,
because `allowedHosts` ports must equal `device.port` and Caddy forwards the
client's Host unchanged.

| Gains                                                                          | Costs                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The token and pairing exchange are encrypted on Wi-Fi.                         | Every iPhone needs the Caddy root installed as a profile **and** enabled under Settings → General → About → Certificate Trust Settings. Each Simulator needs `xcrun simctl keychain booted add-root-cert`. Whether ATS accepts a user-trusted root is [unverified].                      |
| Caddy's `remote_ip` gives the source-CIDR filter Lugn lacks, **without sudo**. | That root can sign **any** name. Its private key on the Pi becomes a credential that could MITM every site for devices that trust it. App-level pinning of the root instead of system trust is possible, but its interplay with ATS is [unverified].                                     |
| Matches the existing `8443` panel pattern.                                     | `deploy/install-lan-proxy.sh` hard-codes one site (`8443` → `127.0.0.1:8787`), so this needs a repo change. The proxy is down today [observed], and its `PartOf=lugn.service` means a `stop` of Lugn stops it and a later `start` does not bring it back.                                |
|                                                                                | Behind any proxy, every request reaches Lugn from `127.0.0.1`, so the per-address pairing and failed-auth budgets become **one shared budget** [source]. A LAN peer can then lock the owner out of pairing for a minute.                                                                 |
|                                                                                | Another resident process: Caddy RSS is roughly tens of MiB [unverified, measure it], out of the 425 MiB available. TLS handshakes on the Pi 3 are a small CPU cost. SSE should pass through, because Caddy flushes `text/event-stream` immediately [Caddy, unverified for this version]. |

Verdict: **not for the first rollout**. It is the right upgrade if the owner
wants the token encrypted on the LAN before the remote path exists. The
remote path (section 6) gives the phone real TLS without any private CA.

## 2. Threat model: a plaintext bearer token on a home LAN

### Who can see or steal the token

- **Passive Wi-Fi capture.** On WPA2-Personal, anyone who knows the Wi-Fi
  password and captures a device's handshake can decrypt that device's
  traffic. That includes guests and any compromised IoT device that has the
  password. WPA3-SAE does not allow this. The router's mode is
  [unverified].
- **Active LAN attacker.** Any host on `192.168.10.0/24` can ARP-spoof the
  phone or the Pi, read the token from any request and alter responses. A
  cheap smart plug or bulb counts if it is compromised.
- **mDNS spoofing.** Any LAN host can answer the phone's `brunocam.local`
  query with its own address. The phone then sends the bearer token straight
  to the attacker. An IP-literal URL avoids that specific attack, but not ARP
  spoofing.
- **The pairing exchange itself is plaintext.** `POST /api/v1/pair` returns
  the new token in the response body, so an attacker who is already on the
  path gets the token at the moment it is created.

### What a stolen token can do

A token stays valid **until it is revoked**. There is no expiry and no
rotation endpoint (`src/runtime/device-registry.ts`; no TTL on stored
devices) [source]. With all three scopes (the default when a code names no
scopes) the holder can:

**`state:read`**: `GET /api/v1/state` and live SSE `GET /api/v1/events`:

- Whether the room is occupied, the person count, the exit countdown and Home
  Assistant home/away. In short, whether anyone is home.
- The room session, every light's observed and intended state, music
  playback including the track, volume authority and quiet hours.
- Upcoming routines and the Godnatt / God morgon plan, which reveal sleep and
  wake times.
- Temperature, humidity, CO₂, PM2.5, the desktop activity summary and
  suggestions.
- Paired phones' latest hints and facts: wake alarm, Focus, charging,
  geofence inside or outside.
- The newest 30 "why" explanations.

**`commands:write`**: `POST /api/v1/commands`, the 17 names in
`DeviceCommandNames` (`src/core/device-api.ts:465`), executed through
`src/runtime/device-commands.ts` as **a human actor**
(`{ type: "user", id: "mobile:<deviceId>" }`, source `lugn.mobile`), so
manual-override rules treat each one as the owner's own tap:

| Command                                                                                                                                                      | Effect a LAN attacker could cause                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lighting.activateScene`, `lighting.reapplyScene`, `lighting.set`, `lighting.adjust`                                                                         | Turn lights on, off or to any brightness, at any hour, and override automation as a "manual" change.                                                                           |
| `music.play`, `music.pause`, `music.setVolume`, `music.fadeVolume`, `music.cancelFade`, `music.selectSource`, `music.playPreset`, `music.setVolumeAuthority` | Start playback or set volume on `music.room`. **Quiet hours do not block an explicit `music.play`**, because it counts as a manual action (IOS-API.md). Take volume authority. |
| `switch.set`                                                                                                                                                 | None today. The active config has no switches [observed], so it returns `404 target_not_configured`.                                                                           |
| `presence.setCountOne`                                                                                                                                       | Tell the sensor the room holds one person. This can keep occupancy and lights on [unverified exact downstream effect].                                                         |
| `routines.bedtime`, `routines.action`                                                                                                                        | Trigger or change Godnatt / God morgon routine actions. Bedtime needs the current `generation`, which the attacker can read from state.                                        |
| `suggestions.respond`                                                                                                                                        | Accept, reject or dismiss computer-context suggestions.                                                                                                                        |

**`phone:ingest`**: `POST /api/v1/phone/observations` as that device:

- Fake geofence, Focus, wake-alarm and charging hints in the state view.
- Nothing acts on them except `arrivalPrelight`, which is **off**. If someone
  later turns it on, a fake geofence `enter` lets the sensor's prelight run
  while Home Assistant reports away.
- These hints never mark the room occupied or empty and never run commands
  ([PRESENCE.md](../PRESENCE.md#phone-hints)).

**Denial of service with the token:**

- Rate limits are per device (`device-server.ts:104–128`), so an attacker
  using the owner's token spends the **owner's** budget. The owner's app then
  gets `429`.
- A third SSE stream replaces the oldest, so the attacker can repeatedly cut
  the owner's live stream.

**What the token cannot do** [source]:

- No sensor configuration, `presence.setCount` or `recalibrate`, button
  presses, Govee bridge controls, camera or panel access.
- No access to the loopback machine API on 8787, and no pairing or
  revocation, which live on 8787 and `/ui/api` only.
- The Home Assistant token is unreachable.
- It cannot create, list or revoke other devices.

**Without a token**, a LAN host can:

- Guess pairing codes. There are 32⁸ ≈ 10¹² codes, limited to 5 attempts per
  minute per address, and 10 wrong guesses invalidate every outstanding code,
  so guessing only works as a nuisance.
- Send floods. The listener runs **in the same Node process as the room
  engine**, so a flood of `401`s competes with the Govee and presence
  automations for the event loop. Header and request timeouts exist (10 s and
  15 s), but there is no per-source connection cap in Lugn [source]. The
  optional nft `ct count` rule above is the only cap.

### Mitigations

Available now, without code changes:

1. **No WAN exposure.** Keep the bind on the LAN address, add no router port
   forward and confirm UPnP does not map 8789.
2. **Least scope per pairing.** Pair the first phone with
   `["state:read", "commands:write"]` and leave out `phone:ingest` until the
   phone-signals module ships.
3. **Short pairing window.** Use `ttlSeconds: 120` and enter the code at once.
4. **Revoke per device** on loss, on a suspected leak, or before handing the
   phone to anyone:
   `POST /devices/<id>/revoke` on the loopback API. It is immediate and
   persistent, and it closes that device's streams.
5. **Manual rotation.** Re-pair, then revoke the old device id, for example
   monthly and after any guest has had the Wi-Fi password. Check `lastSeenAt`
   in `GET /devices` for a device that should be idle. It resets on restart.
6. **Prefer the IP-literal URL** if ATS allows it (section 5). It removes
   mDNS spoofing.
7. **Network hygiene.** Use WPA3 if the router and every client support it,
   and put guests and IoT devices on a separate SSID or VLAN with client
   isolation.
8. **Keep `arrivalPrelight` off** while the transport is plaintext.

Later, with code or other infrastructure (not part of this rollout):

- Token expiry and a rotate endpoint.
- A `device.allowedSourceCidrs` filter in Lugn.
- A per-source connection cap in Lugn.
- TLS, either through Caddy (above) or the remote path (section 6).

## 3. Rollout order, health checks and rollback

The main production risk is the **new server build**, not the flag. Production
runs a branch the iOS work has never been combined with, so the rollout
separates "new build, listener off" (step A) from "listener on" (step B).

### Phase 0: preconditions (owner)

- [ ] The decisions at the end of this document are made.
- [ ] A DHCP reservation exists for BrunoCAM's `wlan0` MAC → `192.168.10.132`,
      checked in the router UI (section 5).
- [ ] Optional firewall: the sudo password is available through the secure
      prompt.

### Phase 1: integration build (on Kuffe, not on the Pi)

- [ ] Create one commit containing both `221c985` (the Govee ceiling fixes
      deployed today) and the device-API line. The cleanest route is merging
      `govee-lan-effects-control` and this branch into `main`. A dedicated
      integration branch also works. **Deploying this branch alone would
      revert the ceiling fixes in production.**
- [ ] Run `npm ci && npm run check` (format, lint, typecheck, all tests). A
      clean textual merge does not prove the merged `lugn-engine.ts` behaves
      correctly.
- [ ] Record `<sha>`.

### Phase 2: baseline (read-only, before touching anything)

Run the health check below and save its output as the "before" record.

### Phase 3: stage `~/lugn-<sha>` on BrunoCAM

This is the owner's established sudo-less release switch
(see the deploy notes and the `.before-<sha>` drop-in backups [observed]):

- [ ] Copy the tree: `git archive <sha> | ssh bruno@brunocam.local 'mkdir ~/lugn-<sha> && tar -x -C ~/lugn-<sha>'`.
- [ ] Install and build **niced**, so the sensor and Lugn keep the CPU:
      `cd ~/lugn-<sha> && nice -n 19 ionice -c3 npm ci && nice -n 19 ionice -c3 npm run build`.
      Watch `free -m` while it runs. If available memory falls below about
      150 MiB, stop and use the alternative: build `dist/` on Kuffe, copy
      `dist/`, `package.json` and `package-lock.json`, then run
      `nice -n 19 npm ci --omit=dev` on the Pi. Production dependencies have
      no native addons; only `protobufjs` has a JS postinstall [source].
- [ ] Config check with the **active** config (use `node` directly; the npm
      script would rebuild):
      `node --env-file=$HOME/.config/lugn/lugn.env dist/runtime/config-check.js $HOME/.config/lugn/config-lugn2-test-91335a4.json`.
- [ ] Preflight (read-only against Home Assistant):
      `node --env-file=… dist/runtime/preflight.js <active config>`.

### Phase 4, step A: switch the build with the listener off

- [ ] Back up the drop-in:
      `cp -p ~/.config/systemd/user/lugn.service.d/90-lugn-release.conf{,.before-<sha>}`.
- [ ] Edit both paths (`WorkingDirectory` and the `main.js` path in
      `ExecStart`) to `~/lugn-<sha>`. Leave the config path unchanged. The
      config still has **no `device` key**.
- [ ] Run `systemctl --user daemon-reload && systemctl --user restart lugn.service`.
      Use **`restart`, not `stop` then `start`**: `PartOf=` stops the LAN proxy
      on `stop` and does not start it again.
- [ ] Run the post-check. Expect no 8789 listener, `/devices` →
      `404 {"error":"device_api_disabled"}`, and no
      `paired-device API listening` log line.
- [ ] Soak through at least one empty → occupied → empty presence cycle and
      one Govee scene change. Ideally soak 24 h, including one Godnatt / God
      morgon run.

**How "unchanged with the listener off" is established.**
`device.enabled: false` (or an absent section) drops the whole section at load
(`src/runtime/config.ts:711`). With it gone, no `DeviceRegistry`, no
`PhoneIngress` and no `LugnDeviceServer` are created (`main.ts:771`, `876`,
`891`), and no device code runs. The build still differs in code that always
runs:

- `RoomState` and `GET /state` always carry a new
  `phone: { "devices": {} }` key.
- The engine has a `phone` publish path, which is never called while the
  section is off.
- The prelight away check now consults an arrival hint, which is never set
  while the section is off.
- `/devices` routes answer `device_api_disabled`.

Check that the `/state` consumers tolerate the extra key: the panel, the Hub
display, the Kuffe tailnet dashboard and the desk-pet gateway on the MacBook.
The desk-pet schema strictness is [unverified]. Everything else is the merged
Govee code, which step A exercises for real.

### Phase 5, step B: enable the listener

- [ ] Back up the config:
      `cp -p config-lugn2-test-91335a4.json{,.before-device-<UTC timestamp>}`
      (same pattern as the existing backups [observed]).
- [ ] Add the section 1 block. Run config-check (`enabled: true`).
- [ ] Run `systemctl --user restart lugn.service`, then the post-check. Expect
      `192.168.10.132:8789` in `ss`, the
      `[lugn] paired-device API listening at http://192.168.10.132:8789/api/v1`
      log line and `NRestarts` unchanged.
- [ ] B4: probe from Kuffe (`192.168.10.126`, same LAN):

```sh
curl -sS http://192.168.10.132:8789/api/v1/me                                   # 401 {"error":"unauthorized"}
curl -sS --resolve brunocam.local:8789:192.168.10.132 http://brunocam.local:8789/api/v1/me   # 401
curl -sS -H 'Host: evil.example:8789' http://192.168.10.132:8789/api/v1/me      # 421 host_not_allowed
curl -sS -H 'Origin: http://evil.example' http://192.168.10.132:8789/api/v1/me  # 403 browser_origin_not_allowed
curl -sS -m 3 -g 'http://[fd68:6529:9dfb:437b:ba27:ebff:fec1:66e1]:8789/'       # connection refused (IPv4-only bind)
```

- [ ] B5: throwaway pairing from Kuffe (section 4) and an SSE timing check.
      `curl -sN -H "Authorization: Bearer $T" http://192.168.10.132:8789/api/v1/events`
      should show `retry: 5000` and a `snapshot` at once, then a heartbeat
      about every 15 s. A scene change from the panel or a Hub should produce
      a `patch` within about a second. While that stream is open, take a 60 s
      CPU sample. **Then revoke the test device.**
- [ ] Optional: install the firewall table and repeat B4.

### Phase 6: phone

Do this only after section 5's conditions hold. Then update the inventory
(new `lugn-device-api` service: `brunocam`, http, bind `192.168.10.132`, port 8789) and change the "reached over Tailscale only" wording in
[IOS-API.md](../IOS-API.md) to the LAN decision.

### Health check (run before and after each phase, read-only)

```sh
ssh bruno@brunocam.local 'bash -s' <<'SH'
systemctl --user is-active lugn.service lugn-govee-effects.service lugn-lan-proxy.service
systemctl is-active doorway-intelligence.service
systemctl --user show lugn.service -p NRestarts -p ActiveEnterTimestamp -p MainPID
ss -ltnH | awk '{print $4}' | sort -u
free -m | sed -n 2p; uptime; cat /sys/class/thermal/thermal_zone0/temp
journalctl _SYSTEMD_USER_UNIT=lugn.service --since '-15 min' --no-pager -o cat \
  | grep -iE 'error|warn|EADDR|listening' | tail -20
SH
# Bearer checks without printing the token: only status and integration states are printed.
ssh bruno@brunocam.local '~/.local/lib/node-v22.23.3/bin/node --env-file=$HOME/.config/lugn/lugn.env --input-type=module -' <<'JS'
const t = Buffer.from(process.env.LUGN_API_TOKEN_B64, 'base64url').toString('utf8');
const get = (p) => fetch(`http://127.0.0.1:8787${p}`, { headers: { authorization: `Bearer ${t}` } });
const h = await get('/health'); console.log('health', h.status, JSON.stringify(await h.json()));
const s = await (await get('/state')).json();
console.log('revision', s.revision, 'presence', s.presence?.state, 'phone key', 'phone' in s);
const d = await get('/devices'); console.log('devices', d.status, (await d.text()).slice(0, 200));
JS
```

Add a CPU sample over 60 s: per-PID `/proc/<pid>/stat` utime+stime deltas for
Lugn, the Govee bridge and the sensor, plus host idle from `/proc/stat`, the
method used for the table above. Also check:

- The owner confirms one panel scene change and one physical presence
  transition.
- The Kuffe tailnet dashboard loads.
- A Hub shows `8788` content.

**Rollback triggers:**

- `NRestarts` increases.
- `/health` reports `degraded` while it was `ok` before.
- Lugn uses more than about 5 percentage points of one core above baseline
  for a sustained period, or available memory falls below 200 MiB.
- Sensor events arrive late, or a Govee scene fails.
- Any `EADDRNOTAVAIL` or `EADDRINUSE` appears in the log.

### Rollback

| From                 | Do                                                                                                                                          | Result                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Step B (listener on) | Restore `config-…json.before-device-<ts>` or set `"enabled": false`, then `systemctl --user restart lugn.service`                           | Back to step A. Same build, no listener.                    |
| Step A (new build)   | `mv 90-lugn-release.conf.before-<sha> 90-lugn-release.conf`, then `systemctl --user daemon-reload && systemctl --user restart lugn.service` | Back to `221c985`. The `.devices.json` file is left unused. |
| Firewall             | `sudo nft delete table inet lugn_device`, then disable `lugn-device-firewall.service`                                                       | No host rules, as today.                                    |

Every restart, forward or back, clears:

- pairing codes, phone hints, command receipts, the `why` feed and
  `lastSeenAt`;
- SSE streams, which reconnect with a new `instanceId`.

Lighting intent is persisted and reseeded from Home Assistant without replaying
commands (OPERATIONS.md).

## 4. Creating the first pairing code

The panel **does not show pairing yet**. `/ui/api/devices/pairing` exists
behind the Clerk session with its CSRF checks, but no page calls it [source].
Use the authenticated **loopback** API from an SSH session on BrunoCAM. This
reads the `_B64` token inside Node and never prints it:

```sh
ssh bruno@brunocam.local '~/.local/lib/node-v22.23.3/bin/node --env-file=$HOME/.config/lugn/lugn.env --input-type=module -' <<'JS'
const t = Buffer.from(process.env.LUGN_API_TOKEN_B64, 'base64url').toString('utf8');
const r = await fetch('http://127.0.0.1:8787/devices/pairing', {
  method: 'POST',
  headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
  body: JSON.stringify({ scopes: ['state:read', 'commands:write'], ttlSeconds: 120 }),
});
console.log(r.status, await r.text());   // 201 {"code":"XXXX-XXXX","expiresAt":…,"scopes":[…]}
JS
```

- The code is a **credential for its lifetime**. If an agent runs this
  command, the code lands in the T3 transcript. Prefer the owner running it
  in their own terminal. Otherwise accept that it is single-use and expires
  within 120 s.
- The rules: at most 4 codes outstanding, 10 wrong guesses invalidate all of
  them, creating a code resets that counter, and a restart drops unused codes
  [source].
- **Do a throwaway pairing first**, from Kuffe, before the phone:

  ```sh
  curl -sS -X POST -H 'Content-Type: application/json' \
    -d '{"code":"XXXX-XXXX","name":"Kuffe test","platform":"ios"}' \
    http://192.168.10.132:8789/api/v1/pair
  ```

  Keep the returned token only in a shell variable, or in a mode-0600 file in
  the scratchpad. Check `GET /api/v1/me`, `/state` and `/events` (step B5).
  Then revoke the device with the loopback
  `POST /devices/<dev_id>/revoke` and confirm that `/api/v1/me` → `401`.

- **The phone:** create a new code and type it in the app together with the
  base URL (section 5). Confirm the new device in `GET /devices` (name,
  `scopes`, `revokedAt: null`).

## 5. Before a phone may use the LAN listener

- [ ] **Stable server address.** Add a router DHCP reservation for
      BrunoCAM's `wlan0` MAC. The address has been stable and is already used
      in config and inventory [observed], but whether a reservation exists is
      [unverified]. Without one, a lease change silently kills the listener
      (bound address) or breaks the app's stored URL.
- [ ] **Same L2 network.** The phone joins the same SSID or VLAN as
      `192.168.10.0/24`, not a guest network with client isolation.
- [ ] **ATS.** For `http://brunocam.local:8789`, `NSAllowsLocalNetworking`
      covers `.local` names [Apple]. For `http://192.168.10.132:8789`,
      REACHABILITY.md's research says that iOS 17+ needs an
      `NSExceptionDomains` entry for that address with
      `NSExceptionAllowsInsecureHTTPLoads`. Whether `NSAllowsLocalNetworking`
      alone covers IP literals on iOS 26 is [unverified]: test it on the
      device. Never use `NSAllowsArbitraryLoads`.
- [ ] **Local Network permission (iPhone).** Add
      `NSLocalNetworkUsageDescription` to Info.plist. The first connection to
      a Wi-Fi-subnet address or a `.local` name triggers the prompt, and it
      must be allowed (Settings → Privacy & Security → Local Network → Lugn).
      A denied connection waits with `localNetworkDenied` and retries after a
      later grant. **In the background the system denies silently** [Apple].
      Map that state to a clear message in the app.
- [ ] **mDNS from iOS.** iOS resolves `.local` through mDNSResponder, which
      falls under the same permission [Apple]. avahi also publishes the ULA
      IPv6 address [observed, `use-ipv6=yes`], while the listener binds IPv4
      only. Happy Eyeballs should fall back to IPv4 quickly after the refused
      IPv6 connection [unverified]. The Host header stays
      `brunocam.local:8789` either way.
- [ ] **Simulator on the Mac.** The Simulator uses the Mac's network and
      resolver, and it has **no Local Network prompt** [Apple], so test the
      permission flow on the iPhone. It reaches the LAN listener only if the
      Mac itself is on the home LAN. Test with Safari in the Simulator at
      `http://brunocam.local:8789/api/v1/me`, which should return `401` JSON.
      On macOS, check resolution with `dscacheutil -q host -a name brunocam.local`;
      `host` and `nslookup` bypass mDNS.
- [ ] **Off the LAN.** On cellular, or with the Mac away, the app must show
      "not on the home network", and no request may go anywhere else. No
      fallback URL exists in v1.

## 6. Later: remote access through Kuffe (option B), in 10 lines

1. Kuffe already runs Tailscale and `lugn-brunocam-tunnel.service`, an SSH forward from `127.0.0.1:18787` to BrunoCAM `127.0.0.1:8787` [inventory].
2. Add `-L 127.0.0.1:18789:127.0.0.1:8789` to that unit's `ExecStart` and restart it. This briefly interrupts the tailnet dashboard.
3. On Kuffe: `tailscale serve --bg --https=8789 http://127.0.0.1:18789`, which serves tailnet-only HTTPS with a public Let's Encrypt cert. Never use Funnel.
4. BrunoCAM's listener must then be reachable on its loopback. Either bind `127.0.0.1` (drops the LAN path) or keep `192.168.10.132` and tunnel to that address instead (`-L …:192.168.10.132:8789`).
5. Add `kuffe.tail51fda2.ts.net:8789` to `allowedHosts`. Serve preserves the Host header [source in REACHABILITY.md].
6. The app gains a second base URL, `https://kuffe.tail51fda2.ts.net:8789`. HTTPS needs no ATS exception, and Tailscale traffic needs no Local Network permission.
7. The token is TLS-protected on that path. The phone needs Tailscale connected. Kuffe and its SSH tunnel become dependencies.
8. Through the tunnel every request arrives from `127.0.0.1`. The pairing and failed-auth budgets for remote clients become one shared budget.
9. Option: once the remote path works, drop the LAN listener and use Tailscale everywhere. That gives one URL, TLS always and no Local Network prompt.
10. Rollback: `tailscale serve --https=8789 off` on Kuffe, remove the `-L`, remove the `allowedHosts` entry, then restart both units.

What changes then:

- The plaintext-on-Wi-Fi exposure in section 2 shrinks to zero if the LAN
  listener is dropped, or stays as it is if both paths are kept.
- Tokens stay the same; no re-pairing is needed.
- `IOS-API.md` and the inventory gain the relay entry.

## Open questions and unverified claims

- Why the doorway sensor used 109–217 % of one core instead of the ~72 %
  recorded on 2026-11-10. It must be explained before adding load.
- Whether `0x60000` (past throttling) recurs during an on-Pi build.
- The device listener's CPU and RSS cost with one SSE stream open. It is not
  measured.
- Whether a DHCP reservation exists. The router's Wi-Fi security mode
  (WPA2 or WPA3) and guest isolation.
- ATS for an IP-literal URL with only `NSAllowsLocalNetworking` on iOS 26.
- Whether `/state` consumers (desk-pet gateway especially) accept the new
  `phone` key.
- The nft syntax and Debian's stock `/etc/nftables.conf` on this host.
- Lugn's restart behaviour when `wlan0` has no address at boot (start-limit
  arithmetic).
- Whether the Mac used for the Simulator is physically on the home LAN.
- The cause of `lugn-lan-proxy.service` being down since 2026-11-14. The
  `PartOf=` interaction is inferred, not confirmed.

## Decisions for the owner

1. **Integration.** Merge `govee-lan-effects-control` and the device-API line
   into `main` before deploying (recommended), or deploy from a dedicated
   integration branch.
2. **Bind.** `192.168.10.132` (recommended, with a DHCP reservation), or
   `0.0.0.0` + `allowAllInterfaces` (with the firewall made mandatory).
3. **App URL.** `brunocam.local` (ATS-simple, exposed to mDNS spoofing), or the
   IP literal (no mDNS dependency, may need an `NSExceptionDomains` entry). Or
   allow both in `allowedHosts`.
4. **Firewall.** Add the nft table now (needs the sudo password), or accept
   bind plus no port forward for v1.
5. **Scopes for the first phone.** `state:read` + `commands:write` only
   (recommended), or all three.
6. **Build location.** Build on the Pi with `nice` (the established method),
   or build `dist/` on Kuffe and run `npm ci --omit=dev` on the Pi.
7. **Caddy TLS on the LAN.** Defer (recommended), or do it before the phone
   pairs.
8. **The LAN panel proxy**, down since 2026-11-14. Restart it (an
   independent decision; it is not needed for this plan).
