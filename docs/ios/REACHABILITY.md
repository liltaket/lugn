# iOS app reachability

How the native iOS app reaches the paired-device listener (`/api/v1`, see
[IOS-API.md](../IOS-API.md)) on the Lugn host, over Tailscale and at home.

Status: **research and plan only. Nothing in the runbook has been executed.**
Researched 2026-11-16. No production host was changed.

Evidence labels used below:

- **[Apple]**, **[Tailscale]**, **[Go]**: vendor documentation, quoted in the
  sources list.
- **[source]**: Tailscale's open-source `ipn/ipnlocal/serve.go` (main branch,
  read 2026-11-16) or this repository's code.
- **[observed]**: checked read-only on another node in the same tailnet that
  already runs `tailscale serve` (Tailscale 1.104.5).
- **[unverified]**: inference or third-party reports. Confirm during the
  runbook.

## Recommendation

Run Tailscale on the Lugn host and let **`tailscale serve` terminate HTTPS** on
the tailnet with a public Let's Encrypt certificate for the host's MagicDNS
name. It proxies to the device listener, which **binds loopback only**:

```text
iPhone / Simulator (Tailscale on)
   │ https://brunocam.<tailnet>.ts.net:8789   (HTTP/2, public cert, no ATS exception)
   ▼
tailscaled on the Lugn host  ── listens only on the tailscale0 addresses
   │ http://127.0.0.1:8789     (Host header preserved)
   ▼
Lugn device listener  device.host = 127.0.0.1
```

> **Decision update (2026-11-16, owner):** Tailscale will **not** be installed on
> the Lugn host (BrunoCAM). The first prototype runs over the **LAN only**:
> the device listener binds the host's LAN address (plain HTTP, token auth) and
> the app uses a narrowly scoped ATS exception (`NSAllowsLocalNetworking`) plus
> the Local Network permission. Remote access, later, goes through a machine
> that already has Tailscale (option B below: SSH tunnel + `tailscale serve`
> on that machine). Option A is kept as reference only. Treat the "no ATS
> exception / no Local Network" claims below as applying to A/B, not to the
> LAN prototype.

- The app stores one base URL. The same URL works at home and away. At home,
  traffic goes through the tunnel too, normally on a direct LAN path between
  the two peers [unverified, check with `tailscale ping`].
- The app needs **no ATS exception, no CA profile and no Local Network
  permission**.
- There is **no LAN-only path in v1**. If Tailscale is off on the phone, the
  app shows "Tailscale is not connected" and nothing is sent anywhere else.
- If `sudo` on the Lugn host has to wait, the same design works today through
  the existing relay on the always-on tailnet machine (option B). That adds a
  second machine and an SSH tunnel, so it is the interim option.

## Decision table

| #     | Option                                                                        | iOS ATS                                                                                                                                              | Phone setup                                                        | Works without Tailscale on the phone? | SSE / URLSession                                                                               | Server risk                                                                                                                                                                            | Verdict                                          |
| ----- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **A** | `tailscale serve --https` on the Lugn host → `127.0.0.1:8789`                 | None needed (public CA, TLS 1.2+)                                                                                                                    | Tailscale app only                                                 | No (clean failure)                    | h2 [observed]; streaming responses flush immediately [source]+[Go]; no proxy timeouts [source] | Node stays loopback-only; tailscaled owns the network socket; no boot-order problem                                                                                                    | **Recommended**                                  |
| B     | Same, but `serve` runs on the always-on tailnet machine over the SSH tunnel   | None                                                                                                                                                 | Tailscale app only                                                 | No                                    | As A, plus an SSH hop (`ServerAliveInterval=15`)                                               | No root on the Lugn host; depends on a second machine and its tunnel                                                                                                                   | Interim, no-sudo option                          |
| C     | Caddy on the Lugn host using the Tailscale cert (`get_certificate tailscale`) | None                                                                                                                                                 | Tailscale app only                                                 | No                                    | Caddy flushes SSE                                                                              | Caddy needs tailscaled socket/cert permission and must bind the tailscale IP; more moving parts than A for the same result                                                             | Not worth it                                     |
| D     | Caddy internal CA on the LAN (like the panel on :8443), `brunocam.local:8789` | Passes only once the root is user-trusted [unverified]; `.local` also wants `NSAllowsLocalNetworking`                                                | Install and fully trust the Caddy root on each phone and Simulator | Yes, LAN only                         | Fine                                                                                           | Adds a LAN listener; Local Network prompt; Bonjour/mDNS dependence; root CA on the phone trusts anything that CA signs                                                                 | Defer; only if LAN-without-Tailscale is required |
| E     | Plain HTTP on the tailscale0 IP (the current IOS-API.md wording)              | iOS 17+ needs `NSExceptionDomains` for the IP/CIDR; a `ts.net` name needs `NSExceptionAllowsInsecureHTTPLoads`, which App Review asks you to justify | Tailscale app only                                                 | No, but see the leak risk             | HTTP/1.1 only, so SSE and commands use separate connections                                    | Bearer token can leave in clear text if the tunnel is down and a `100.x` route exists elsewhere (carrier CGNAT) [unverified]; Lugn fails to start if tailscale0 is not up yet [source] | Reject                                           |
| F     | `0.0.0.0` + source-CIDR allowlist (`100.64.0.0/10`, LAN)                      | As E                                                                                                                                                 | —                                                                  | Yes (plain HTTP on Wi-Fi)             | As E                                                                                           | Lugn has no source-address allowlist today (Host check only) [source], so this needs new code; listens on every interface                                                              | Reject                                           |

## Findings

### 1. App Transport Security

- `NSAllowsLocalNetworking` "controls whether App Transport Security (ATS)
  allows your app to connect to unqualified domains, `.local` domains, and IP
  addresses" [Apple]. iOS 10–16 allowed all three by default. **From iOS 17,
  ATS no longer allows connections to IP addresses by default.** You must list
  addresses or CIDR ranges in `NSExceptionDomains` [Apple]. For this app
  (iOS 26+), plain HTTP to `100.x.y.z` therefore needs an `NSExceptionDomains`
  entry such as `100.64.0.0/10` with `NSExceptionAllowsInsecureHTTPLoads`.
- A MagicDNS FQDN (`host.<tailnet>.ts.net`) is neither unqualified nor
  `.local`, so `NSAllowsLocalNetworking` does not cover it. Plain HTTP to it
  needs an `NSExceptionDomains` entry for `<tailnet>.ts.net` with
  `NSIncludesSubdomains` and `NSExceptionAllowsInsecureHTTPLoads` [Apple]. A
  bare short name such as `brunocam` counts as unqualified and would be
  covered. It depends on the MagicDNS search domain being active, though,
  which is fragile [unverified].
- A domain exception does not apply when the app connects by IP: "If you
  exclude a DNS domain name and your app contacts a host by IP address, the
  ATS exclusion for the domain name doesn't apply" [Apple].
- App Review asks for a justification for `NSAllowsArbitraryLoads`,
  `NSAllowsArbitraryLoadsForMedia`, `NSAllowsArbitraryLoadsInWebContent`,
  `NSExceptionAllowsInsecureHTTPLoads` and `NSExceptionMinimumTLSVersion`.
  `NSAllowsLocalNetworking` and IP entries in `NSExceptionDomains` are not on
  that list [Apple]. A free-signed personal build is never reviewed. A future
  TestFlight build goes through beta review [unverified that beta review
  checks ATS keys].
- **Least bad:** HTTPS with a public certificate needs **no ATS key at all**.
  If plain HTTP is ever needed, use a narrow `NSExceptionDomains` entry, never
  `NSAllowsArbitraryLoads`.
- ATS covers URLSession, not lower-level APIs: "ATS doesn't apply to calls
  your app makes to lower-level networking interfaces like the Network
  framework" [Apple]. Do not use that as a workaround.

### 2. TLS and SSE

- **`tailscale serve`** gets a Let's Encrypt certificate for the node's
  MagicDNS name through DNS-01. Private keys stay on the node. Certificates
  last 90 days, and certificates used by Serve renew automatically [Tailscale].
  On another node in this tailnet, a Serve endpoint presents a
  `Let's Encrypt` chain that verifies with the system trust store and
  negotiates ALPN `h2` [observed]. HTTPS certificates are therefore already
  enabled for the tailnet.
- **Privacy cost:** issued certificates go to the public Certificate
  Transparency logs, "this includes the fully qualified domain name of your
  devices" [Tailscale]. The tailnet name is already public through the
  existing certificate. Option A adds the Lugn host's machine name. Keep the
  machine name non-sensitive.
- **Proxy behaviour** [source]:
  - The inbound `Host` is preserved (`r.Out.Host = r.In.Host`). Lugn's exact
    `allowedHosts` check therefore sees `brunocam.<tailnet>.ts.net:8789`.
  - The proxy sets `X-Forwarded-For` (overwriting any client value),
    `X-Forwarded-Host` and `X-Forwarded-Proto: https`. It strips and re-adds
    `Tailscale-User-*` identity headers (not set for tagged nodes).
  - There is no custom `FlushInterval`. Go's ReverseProxy flushes responses
    with `ContentLength -1` immediately [Go]. Lugn's SSE response is chunked
    with no `Content-Length` (`src/runtime/device-events.ts`), so events are
    not buffered. A live check is in runbook step 9.
  - The frontend `http.Server` sets no read, write or idle timeouts. The
    backend transport has `IdleConnTimeout: 90s`, which applies to idle pooled
    connections, not to an active stream. Lugn's own 15 s heartbeats and
    30-minute stream cap stay in charge.
  - Lugn sends `connection: keep-alive` on SSE. That header is hop-by-hop and
    illegal in HTTP/2. Go's ReverseProxy drops hop-by-hop headers, so it does
    not reach an h2 client [Go, unverified for this exact header].
- **URLSession:** over HTTPS, URLSession negotiates HTTP/2 through ALPN. The
  SSE stream and commands share one connection [unverified on device]. Use a
  standard (not background) session for SSE, consumed with
  `bytes(for:)` / `AsyncBytes.lines`. Set `timeoutIntervalForRequest` above
  the 45 s dead-stream rule, for example 60 s, and enforce the 45 s silence
  rule in the app. Apple describes this timeout as a wait for additional data,
  and its default is 60 s [third-party summary; the Apple reference page did
  not render].
- **Caddy with a Tailscale cert (C):** it would work, but it duplicates what
  Serve already does. It needs Caddy to reach tailscaled's socket and bind the
  tailscale IP, and it brings back the boot-ordering problem.
- **Caddy internal CA (D):** the phone and every Simulator must install and
  fully trust a private root. Whether ATS accepts a user-trusted root is
  [unverified]. That root can sign any name, so it is broader trust than this
  app needs.
- **Certificate pinning: not worth it.** The leaf and intermediate rotate on
  each 90-day renewal. A private personal app gains little over WebPKI
  validation of the exact `ts.net` name, the Tailscale ACL and the per-device
  bearer token. Pinning would add outage risk at every renewal. Revisit only
  if the app ever leaves the tailnet.

### 3. Local Network permission, discovery, Tailscale on the phone

- **Tailscale traffic does not need Local Network permission.** "A local
  network is an IP network associated with a broadcast-capable network
  interface. Such interfaces include Wi-Fi and Ethernet, but not cellular
  (WWAN) or VPN" [Apple TN3179]. Traffic to a `100.x` peer goes through the
  VPN interface. Resolving a non-`.local` name with the system resolver also
  needs no permission [Apple]. Expect no prompt with option A [inference from
  TN3179; confirm on the iPhone].
- **The Simulator does not enforce it:** "The simulator doesn't support local
  network privacy. Test your local network privacy behavior on a real device"
  [Apple].
- **It would apply to** option D: resolving `.local` names, outgoing TCP to a
  Wi-Fi-subnet address and Bonjour browsing all require it. The app would
  need `NSLocalNetworkUsageDescription`, and `NSBonjourServices` if it
  browses. A denied connection waits with `localNetworkDenied` and retries
  automatically after a later grant. In the background the system denies
  silently without prompting [Apple].
- **Discovery:** use a stored base URL. In v1 the operator enters it once
  next to the pairing code (a later QR code can carry both). Bonjour only
  helps the LAN-without-Tailscale path. It needs a server-side mDNS
  advertisement, the Local Network prompt and a LAN TLS story. Defer it
  together with option D.
- **Tailscale must be connected on the phone.** While Tailscale is enabled,
  the client sets "a broad VPN On Demand policy", so the tunnel comes back
  after restarts and crashes. Only one VPN app can use On Demand at a time. If
  another VPN connects, iOS disables On Demand for Tailscale until it is
  reconnected manually. Custom On Demand rules replace the default, and a
  "Never" rule disconnects it [Tailscale]. The app cannot start the tunnel
  itself. It should map DNS and connect failures for the `ts.net` host
  (`NSURLErrorCannotFindHost`, `-1004`, timeouts) to a clear "Tailscale is
  not connected" state.
- **Battery:** idle drain from Tailscale on iOS is reported anecdotally as
  anywhere from none to noticeable, and recent releases claim improvements
  [unverified]. Lugn itself adds load only while its SSE stream is open in the
  foreground.
- **Backgrounding:** a suspended app runs no code, and the system "may choose
  to reclaim resources out from underneath a network socket" [Apple TN2277].
  Follow IOS-API.md: close SSE on `.background`. On `.active`, `GET /state`
  and reconnect with `Last-Event-ID`. Background-session URLSession is meant
  for upload and download, and DTS steers data tasks to a standard session
  [Apple forums]. Phone observations sent from background wakes (geofence and
  similar) need a standard session inside `beginBackgroundTask`, a short
  timeout and a persistent retry queue. They also depend on the tunnel already
  being up [unverified wake behaviour].

### 4. Server bind policy and threat model

- **Bind loopback only:** `device.host = "127.0.0.1"`. tailscaled exposes the
  port on the tailscale0 addresses only. On the observed node, Serve's
  sockets are bound to the tailnet IPv4/IPv6 addresses `%tailscale0` and
  coexist with `127.0.0.1:<same port>` listeners [observed]. Nothing listens
  on the LAN or Wi-Fi interface.
- **Why not bind the tailscale0 IP directly:** the device listener starts
  inside Lugn's startup, and a failure there tears down the whole runtime
  (`src/runtime/main.ts`, `await deviceServer?.start()` inside the startup
  `try`) [source]. If tailscaled is not up at boot, the bind fails and the
  room controller does not start. Binding loopback removes that dependency.
- **Why not `0.0.0.0` + CIDR:** Lugn only checks the Host header. It has no
  source-address filter [source], so this would need new code and would
  listen on every interface, including the LAN, in plain HTTP.
- **What can reach the API, by vantage point:**
  - **Internet:** nothing. Serve endpoints are "tailnet only". Never enable
    Funnel on this port.
  - **LAN device without Tailscale:** nothing. There is no LAN socket.
  - **Tailnet device allowed by the ACL:** the pairing and `401` surface
    only. Without a token it can guess pairing codes (short-lived, at most 4
    outstanding, ten wrong guesses invalidate all of them). Behind Serve every
    request arrives from `127.0.0.1` [source], so the per-address budgets
    (pairing 5/min, failed auth 10/min) become **one shared budget**. That is
    stricter against guessing. It also means an allowed tailnet peer can
    deliberately burn the pairing budget or invalidate codes (nuisance DoS).
    Valid tokens are not blocked by the failed-auth limiter.
  - **Holder of a stolen device token:** everything that token's scopes grant
    (state, commands, phone ingest) until it is revoked. Revoke it from the
    panel or the loopback API. Tokens live in the iOS Keychain.
  - **Local process on the Lugn host:** can reach `127.0.0.1:8789`, as with
    the existing loopback machine API. It still needs a Host header from
    `allowedHosts` and a token.
- **ACL recommendation:** tag the Lugn host (for example `tag:lugn`) and allow
  only your own devices to reach `tcp:8789` on it. Allow nothing from
  `tag:lugn` outward unless it is needed. Tagging also disables key expiry for
  that node, and it drops the `Tailscale-User-*` headers, which Lugn does not
  use. Lugn's trust stays **device-token only**. Do not add identity-header
  trust. Doing so would need an explicit "trusted proxy" setting, because any
  local process can forge headers on loopback.
- Optional later hardening (code change, not part of this plan): trust
  `X-Forwarded-For` only when the socket peer is loopback and a
  `device.trustLoopbackProxy` flag is set. That restores per-peer rate limits
  behind Serve.

### 5. Mac Simulator

- The Simulator has no network stack of its own. Apps in it use the Mac's
  network and resolver, so with the Mac's Tailscale connected (and "Use
  Tailscale DNS" on) it should reach `https://brunocam.<tailnet>.ts.net:8789`
  [unverified; single third-party source]. Test it with Safari in the
  Simulator at `/api/v1/me`, which should return `401`.
- There is no Local Network prompt in the Simulator [Apple]. ATS is enforced
  the same way as on a device [unverified, but no Apple source says
  otherwise]. Option A needs no exceptions in either place.
- MagicDNS gotcha on macOS: `host` and `nslookup` bypass the system resolver
  and fail for MagicDNS names even when apps work [Tailscale]. Test with
  `curl` or `dscacheutil -q host -a name <name>` instead.
- Option D would need `xcrun simctl keychain booted add-root-cert <root.crt>`
  for every Simulator device. Option A avoids that.

## Runbook (NOT EXECUTED)

> **Not executed.** Run these steps later by hand, one at a time, checking
> each result. They change the production room controller host and the
> tailnet policy. Read the Lugn deploy notes (release drop-in, active config
> path, base64url bearer token) before step 6. `<tailnet>` is the tailnet DNS
> name shown on the Tailscale admin DNS page. `bruno` is the service account.

### 0. Preconditions

- `sudo` on the Lugn host. Supply the password through the secure prompt and
  never write it into a file in the repository or shell history.
- Admin access to the Tailscale admin console (ACL editor, machines page).
- Lugn deployed at a release that includes the device listener (commits
  `daadacd` and `fca6116` or later).

### 1. Baseline (read-only, on the Lugn host)

```sh
uname -m; . /etc/os-release; echo "$PRETTY_NAME"
systemctl --user status lugn.service --no-pager | head -5
ss -ltnH | awk '{print $4}' | sort        # note: nothing on :8789 yet
uptime                                    # CPU headroom is scarce on this host
```

### 2. Install Tailscale

Follow Tailscale's Linux install page for the distribution printed above.
The scripted form is:

```sh
curl -fsSL https://tailscale.com/install.sh -o ~/tailscale-install.sh
less ~/tailscale-install.sh               # review before running
sudo sh ~/tailscale-install.sh
rm ~/tailscale-install.sh
tailscale version
```

### 3. Join the tailnet without changing host DNS, routes or SSH

```sh
sudo tailscale up --hostname=brunocam --ssh=false --accept-dns=false --accept-routes=false
```

- Open the printed login URL on a trusted device. It is a credential, so do
  not paste it into logs or commits.
- `--accept-dns=false` keeps the host's own resolver, which Lugn uses for
  `.local` and LAN names. The server never needs to resolve tailnet names.

```sh
sudo tailscale set --operator=bruno       # lets the bruno account manage serve without sudo
tailscale status --self                   # shows the brunocam node
tailscale ip -4                           # note: never put this in Lugn config
```

### 4. Tailnet policy (admin console)

1. Machines → brunocam: confirm the name, then either disable key expiry or
   apply the tag from step 2 below.
2. Access controls: add a tag owner and a narrow rule. Adapt this to the
   existing policy style (grants vs ACLs); it is a sketch:

   ```jsonc
   "tagOwners": { "tag:lugn": ["autogroup:admin"] },
   "grants": [
     { "src": ["autogroup:member"], "dst": ["tag:lugn"], "ip": ["tcp:8789"] }
   ]
   ```

   Then `sudo tailscale set --advertise-tags=tag:lugn` on the host. If the
   policy is still the default allow-all, this step is what turns "every
   tailnet device" into "only my devices, only this port".

3. DNS page: confirm MagicDNS and HTTPS Certificates are enabled. They
   already are if other nodes serve HTTPS.

### 5. Serve HTTPS on the tailnet to loopback

```sh
tailscale serve --bg --https=8789 http://127.0.0.1:8789
tailscale serve status        # expect: https://brunocam.<tailnet>.ts.net:8789 (tailnet only) -> proxy http://127.0.0.1:8789
```

- `--bg` persists the configuration across reboots [Tailscale]. Never run
  `tailscale funnel` for this port.
- The first HTTPS request triggers certificate issuance. Let's Encrypt rate
  limits can impose a 34-hour wait if certificates are requested repeatedly
  [Tailscale], so do not reset in a loop.

### 6. Enable the device listener on loopback

Edit the **active** Lugn config (the file named by the `lugn.service` release
drop-in) and add:

```json
"device": {
  "enabled": true,
  "host": "127.0.0.1",
  "port": 8789,
  "allowedHosts": ["brunocam.<tailnet>.ts.net:8789"]
}
```

Then run, from the active release directory with that config:

```sh
npm run config:check                       # must pass
systemctl --user restart lugn.service
systemctl --user status lugn.service --no-pager | head -5
ss -ltnH | grep ':8789'                    # expect 127.0.0.1:8789 (Lugn) and tailnet-IP%tailscale0:8789 (tailscaled) only
curl -sS -H 'Host: brunocam.<tailnet>.ts.net:8789' http://127.0.0.1:8789/api/v1/me   # expect {"error":"unauthorized"}
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8789/api/v1/me             # expect 421 (wrong Host)
```

### 7. Verify from another tailnet machine (Mac or the always-on node)

```sh
curl -sS -w '\nhttp=%{http_version} verify=%{ssl_verify_result}\n' \
  https://brunocam.<tailnet>.ts.net:8789/api/v1/me
# expect: {"error":"unauthorized"}, http=2, verify=0
```

From a LAN device **without** Tailscale, `brunocam.local:8789` must refuse or
time out.

### 8. Pair the phone

Create a pairing code as in [OPERATIONS.md](../OPERATIONS.md#paired-device-api-native-app)
(loopback API or panel). In the app, enter the base URL
`https://brunocam.<tailnet>.ts.net:8789` and the code.

### 9. Prove SSE is not buffered

With a token from a throwaway test pairing (revoke it afterwards):

```sh
curl -sN -H "Authorization: Bearer $TEST_DEVICE_TOKEN" \
  https://brunocam.<tailnet>.ts.net:8789/api/v1/events | ts '%T'
# expect: "retry: 5000" and a snapshot at once, then a heartbeat every ~15 s
```

(`ts` is from `moreutils`; without it, watch the timing by eye.) Toggle a
scene from the panel and confirm a `patch` arrives within about a second.
Then revoke the test device.

### 10. Simulator and iPhone checks

- Mac Tailscale connected → Simulator Safari →
  `https://brunocam.<tailnet>.ts.net:8789/api/v1/me` → `401` JSON.
- iPhone with Tailscale on Wi-Fi and on cellular: pair, stream, background the
  app, foreground it, and confirm the resume patch. Confirm no Local Network
  prompt appears. On home Wi-Fi, `tailscale ping brunocam` from the Mac
  should report a direct path.
- iPhone with Tailscale off: the app shows the not-connected state, and the
  server logs no request.

### 11. Record the topology

Update the infrastructure inventory (machine brunocam: Tailscale name and
access; new service entry for the device API: https, port 8789, tailnet only,
backend loopback). Then change [IOS-API.md](../IOS-API.md) "Reachability and
transport": the client uses HTTPS through Tailscale Serve, and no ATS
exception is needed.

### Rollback

```sh
tailscale serve --https=8789 off           # repeat the original flags with "off"
# set "device.enabled": false in the active config, then:
systemctl --user restart lugn.service
sudo tailscale down                        # or remove the package entirely
```

## Interim option B (no sudo on the Lugn host), NOT EXECUTED

This reuses the existing dashboard relay pattern on the always-on tailnet
machine: SSH tunnel user unit, then Serve.

1. On the Lugn host, do step 6, but with
   `"allowedHosts": ["<relay>.<tailnet>.ts.net:8789"]`.
2. On the relay, add a second forward to the existing tunnel unit's
   `ExecStart` (next to `-L 127.0.0.1:18787:127.0.0.1:8787`):
   `-L 127.0.0.1:18789:127.0.0.1:8789`. Then run
   `systemctl --user daemon-reload && systemctl --user restart lugn-brunocam-tunnel.service`.
   This briefly interrupts the tailnet dashboard.
3. On the relay: `tailscale serve --bg --https=8789 http://127.0.0.1:18789`.
4. The app uses `https://<relay>.<tailnet>.ts.net:8789`. When A goes live,
   add the new name to `allowedHosts`, update the app's stored URL, then
   remove the relay forward and run `tailscale serve --https=8789 off` on the
   relay.

Costs: the relay machine and the tunnel become dependencies of the phone app.
Every request crosses an extra SSH hop.

## Open questions and unverified claims

- No Local Network prompt for Tailscale traffic on a real iPhone. Inferred
  from TN3179's definition, not tested.
- The Simulator reaching MagicDNS names through the Mac's Tailscale: one
  third-party source, not tested.
- URLSession using HTTP/2 to Serve and multiplexing SSE with commands: the
  server side negotiates `h2` [observed], the client side is not tested.
- SSE flushing through Serve: inferred from source and Go docs. Runbook step 9
  is the proof.
- Whether ATS accepts a user-installed, fully trusted root (option D only).
- Whether TestFlight beta review checks ATS keys. Irrelevant for option A.
- Tailscale's CPU and memory cost on the Lugn host, whose CPU is already
  tight. Measure with `uptime`/`top` before and after step 3.
- Battery impact of keeping Tailscale on: anecdotal only.
- Background wakes (geofence) reaching the server while the tunnel is
  reconnecting.
- The current tailnet policy style (grants or ACLs, allow-all or not) was not
  inspected. The step 4 snippet must be adapted to it.

## Sources

- Apple, TN3179 Understanding local network privacy —
  https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy
- Apple, NSAllowsLocalNetworking —
  https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking
- Apple, NSExceptionDomains —
  https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsexceptiondomains
- Apple, Preventing insecure network connections —
  https://developer.apple.com/documentation/security/preventing-insecure-network-connections
- Apple, TN2277 Networking and Multitasking (archived) —
  https://developer.apple.com/library/archive/technotes/tn2277/_index.html
- Apple Developer Forums, data tasks in background sessions —
  https://developer.apple.com/forums/thread/706748
- Tailscale, Serve — https://tailscale.com/kb/1312/serve and CLI reference
  https://tailscale.com/kb/1242/tailscale-serve
- Tailscale, Enabling HTTPS — https://tailscale.com/kb/1153/enabling-https
- Tailscale, VPN On Demand for iOS and macOS —
  https://tailscale.com/kb/1291/ios-vpn-on-demand
- Tailscale, MagicDNS — https://tailscale.com/kb/1081/magicdns
- Tailscale source, `ipn/ipnlocal/serve.go` —
  https://github.com/tailscale/tailscale/blob/main/ipn/ipnlocal/serve.go
- Go, `net/http/httputil.ReverseProxy` —
  https://pkg.go.dev/net/http/httputil#ReverseProxy
