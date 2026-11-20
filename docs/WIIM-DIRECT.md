# Direct WiiM transport: measurements and design

This document records live measurements against a WiiM Amp Ultra on the local
network (`Linkplay.5.2.833833`, hardware `AmlogicA113`) and the resulting design
for lowering Optical-switch latency and communicating directly with the WiiM
without going through Home Assistant.

## 1. Optical switch latency breakdown

Every number below was measured on the real WiiM Amp Ultra and a PipeWire
48 kHz desktop (`clock.quantum = 1024`, ~21.3 ms per quantum).

### Measured stages

| Stage                                                    |                         Baseline |                                                 Optimized |                Measured delta | Notes                                                                                                                                                        |
| -------------------------------------------------------- | -------------------------------: | --------------------------------------------------------: | ----------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PipeWire capture to first loud 20 ms frame (`pw-record`) |        ~33 ms (`--latency 20ms`) |                                 ~21 ms (`--latency 10ms`) |                        −12 ms | Warm stream on temporary null sink; `parec` was ~42 ms.                                                                                                      |
| Audibility confirmation (`min_audible_ms`)               |              ~417 ms (at 400 ms) |                 ~405 ms (at 400 ms) / ~213 ms (at 200 ms) | −12 ms (or −204 ms at 200 ms) | Tunable in the control panel (`200–5000 ms`).                                                                                                                |
| Prefetch `getPlayerStatus` at sound start                | Overlapped (~64–160 ms cold TLS) |                     Overlapped; **keeps TLS socket warm** |         0 ms on critical path | Runs while waiting for confirmation.                                                                                                                         |
| `setPlayerCmd:switchmode:optical` delivery               | 83–146 ms (`HTTP/1.0`, cold TLS) |                       **6–10 ms** (`HTTP/1.1` keep-alive) |            **−75 to −138 ms** | Cold trials: 82.9, 96.3, 145.8 ms (~2.5 ms TCP + ~57 ms TLS 1.3; TLS session resumption is not supported by the device). Warm trials: 9.6, 8.6, 8.1, 6.1 ms. |
| WiiM internal hardware/DSP switch                        |                      ~440–465 ms |                                               ~440–465 ms |           0 ms (device floor) | Confirmed across all three device interfaces below.                                                                                                          |
| **Total: sound start to confirmed Optical**              |     **~970–1030 ms** (at 400 ms) | **~855–940 ms** (at 400 ms) / **~660–745 ms** (at 200 ms) |         **~100–130 ms saved** | Warm switch + verify: 446–533 ms vs cold 549–607 ms.                                                                                                         |

### Evidence for the ~450 ms device floor

During `setPlayerCmd:switchmode:optical`, three independent signals were
observed concurrently:

1. **HTTPS `getPlayerStatus` immediately after `OK`:** blocks inside the device
   until the switch finishes, returning `mode: "43"` at **446–533 ms** (warm)
   or **549–607 ms** (cold).
2. **UPnP `AVTransport#GetPlayType` on port 49152 (plain HTTP, ~8–11 ms RTT):**
   does _not_ block; polled every ~30 ms, it still reports `"31"` (Wi-Fi/Spotify)
   through **428 ms** and flips to `"43"` (Optical) at **448–457 ms**.
3. **UPnP GENA `NOTIFY` push (`/upnp/event/rendertransport1`):** arrives at
   **456–468 ms** with `CurrentTrackURI=OPTICAL`, `TransportState=STOPPED`,
   followed **8–11 ms later** by `TransportState=PLAYING` (464–479 ms).

### Keep-alive behavior

The WiiM HTTPS server on port 443 supports `HTTP/1.1` persistent connections
with `Content-Length` framing (`getPlayerStatus` drops from ~64 ms cold to
~5–6 ms warm) and does **not** support TLS 1.3 session ticket resumption
(`session_reused = false`, ~60 ms). Idle keep-alive connections stayed open at
+2 s and +5 s and were closed by the device before +10 s. Reusing a connection
with a 4 s idle cap cleanly bridges both the 200–400 ms prefetch-to-switch
window and the 2 s busy-recheck loop, with a single transparent reconnect if the
device closes early.

### Alternatives evaluated and rejected

- **Speculative switching (switch on frame 1, roll back on short sound):**
  _Not recommended._ Because the device's ~450 ms switch is non-atomic and tears
  down the active Wi-Fi/Spotify pipeline, rolling back after a 100 ms
  notification ping drops streaming state and flaps inputs for roughly a second.
  Keeping a real confirmation window (tunable down to `200 ms` in the control
  panel) reaches **~660–745 ms** total without false-switching on UI blips.
- **Alternative switch transports (UPnP, port 8819):** UPnP `AVTransport` and
  `RenderingControl` on port 49152 expose no input-selection action
  (`SetPlayMode` selects loop/shuffle mode only). Port 8819 (LinkPlay binary
  control) is open, undocumented, and cannot beat the ~450 ms internal DSP
  switch floor since warm HTTPS already delivers the command in 6–10 ms.
- **WiiM built-in Optical Auto-Sense (`autoSenseVersion: "1.0"`):** According to
  WiiM documentation, built-in auto-sensing waits ~17 s of idle/pause on the
  prior source plus >3 s of continuous optical signal, and reacts to carrier
  presence rather than audible PCM. It is an order of magnitude slower and can
  misfire when Linux keeps S/PDIF clocked; the loudness-gated agent remains the
  fast path.

## 2. Direct WiiM API surface (verified read-only)

Open TCP ports observed on the WiiM Amp Ultra: `443` (HTTPS HTTP API,
self-signed TLS 1.3), `49152` (UPnP/DLNA plain HTTP + GENA events), `8443`
(TLS, HTTP 404 on `/`), `59152` (HTTP 404 on `/`), and `8819` (LinkPlay
`communication_port`). Port 80 is closed.

### HTTPS HTTP API (`https://<host>/httpapi.asp?command=...`)

| Command                         | Verified response (read-only)                                                                                                                                                                                                                                                                                                 | Warm / Cold RTT |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `getPlayerStatus`               | JSON: `mode` (`0` idle, `10` Wi-Fi, `31` Spotify, `40` Line In, `41` Bluetooth, `43` Optical, `47` HDMI), `status` (`play`/`pause`/`stop`/`load`), `vol` (`0`–`100`), `mute` (`0`/`1`), `eq`, `loop`, `curpos` (ms), `totlen` (ms), hex UTF-8 `Title`/`Artist`/`Album`, `plicount`, `plicurr`                                 | ~5 ms / ~64 ms  |
| `getStatusEx`                   | JSON: `DeviceName`, `GroupName`, `firmware`, `project`, `hardware`, `Release`, `RSSI`, `wlanSnr`, `wlanFreq`, `wlanDataRate`, `max_volume`, `temperature_cpu`, `temperature_tmp102`, `BleRemoteConnected`, `BleRemoteBatterylevel`, `BleRemoteRSSI`, `plm_support`, `autoSenseVersion`, `EQ_support`, `group`, `wmrm_version` | ~103 ms cold    |
| `getMetaInfo`                   | JSON `metaData`: `title`, `artist`, `album`, `subtitle`, `albumArtURI`, `sampleRate`, `bitDepth`, `bitRate`, `trackId`                                                                                                                                                                                                        | ~63 ms cold     |
| `getPresetInfo`                 | JSON: `preset_num`, `preset_list[]` with `number`, `name`, `source`, `picurl`                                                                                                                                                                                                                                                 | ~68 ms cold     |
| `EQGetList`                     | JSON array of 24 named EQ presets                                                                                                                                                                                                                                                                                             | ~120 ms cold    |
| `EQGetBand`                     | JSON: `source_name`, `EQStat`, `Name`, `channelMode`, 10-band values                                                                                                                                                                                                                                                          | ~157 ms cold    |
| `getNewAudioOutputHardwareMode` | JSON: `hardware`, `source`, `audiocast`                                                                                                                                                                                                                                                                                       | ~64 ms cold     |
| `getChannelBalance`             | Numeric string (e.g. `0.00`)                                                                                                                                                                                                                                                                                                  | ~74 ms cold     |
| `getShutdown`                   | Sleep timer seconds (`0` when off)                                                                                                                                                                                                                                                                                            | ~114 ms cold    |
| `multiroom:getSlaveList`        | JSON: `slaves`, `wmrm_version`, `surround`, `group_type`                                                                                                                                                                                                                                                                      | ~63 ms cold     |
| `wlanGetConnectState`           | `OK`                                                                                                                                                                                                                                                                                                                          | ~127 ms cold    |

Commands tested that returned `unknown command` on this firmware (avoid relying
on them): `getAudioInput`, `getAutoSense`, `getOpticalAutoSense`,
`getTriggerOutStatus`, `getDeviceInfo`, `getLED`, `getLight`,
`getSubwooferStatus`, `getCrossOver`, `getPlayMode`, `getVolume`, `getMute`,
`getAudioCastStatus`, `getNewAudioInputHardwareMode`, `getInputMode`,
`getAllPresetInfo`, `getCurrentPreset`, `getSystemStatus`, `getNetworkStatus`,
`getWiFiInfo`.

### UPnP / DLNA (`http://<host>:49152`)

Plain HTTP (no TLS handshake, ~8–15 ms cold RTT):

- `AVTransport` (`/upnp/control/rendertransport1`, `/upnp/event/rendertransport1`):
  - `GetInfoEx` (~15 ms): single-call snapshot with `CurrentTransportState`,
    `TrackMetaData` (DIDL-Lite XML), `TrackURI`, `RelTime`, `TrackDuration`,
    `CurrentVolume`, `CurrentMute`, `PlayType`, `PreSwitchMode`, `PlayMedium`,
    `SpotifyActive`, `SlaveFlag`, `SlaveList`.
  - `GetTransportInfo`, `GetPlayType` (~8–15 ms).
- `RenderingControl` (`/upnp/control/rendercontrol1`, `/upnp/event/rendercontrol1`):
  - `GetVolume`, `GetMute`, `GetSimpleDeviceInfo` (~9–11 ms),
    `GetControlDeviceInfo` (~48 ms).
- `PlayQueue` (`/upnp/control/PlayQueue1`, `/upnp/event/PlayQueue1`):
  - `GetKeyMapping` (~11 ms): all 20 preset slots, including routine UUIDs
    (slots assigned to WiiM routines appear here even when omitted from
    `getPresetInfo`).

### Push events (UPnP GENA)

Subscribing to `/upnp/event/rendertransport1` and `/upnp/event/rendercontrol1`
with `SUBSCRIBE` (`NT: upnp:event`, `TIMEOUT: Second-120`) succeeded with
`HTTP/1.1 200 OK`, immediately pushed an initial `SEQ=0` `LastChange` XML
snapshot on both services, pushed real-time state/input changes within ~10 ms
of hardware completion during live switch tests, and accepted `UNSUBSCRIBE`
cleanly.

## 3. Architecture decision

Split ownership cleanly along availability and locality lines:

1. **Lugn runtime (always-on host) owns the direct WiiM music adapter
   (`src/adapters/wiim-music.ts`):**
   - Room automation (presence exit/return, daily volume curves, fades, Nest
     Hub dashboards, BILRESA buttons) runs 24/7 even when the desktop PC is
     asleep or powered off.
   - Implements the existing `MusicAdapter` contract with zero device-protocol
     details in domain logic (`MusicController`, `LugnEngine`).
   - Uses **UPnP GENA push** (`AVTransport` + `RenderingControl` on `:49152`)
     for immediate state/volume/input change notifications, paired with a
     warmed **HTTPS HTTP/1.1 keep-alive** client (`:443`) for consistent
     `getPlayerStatus` snapshots, direct physical `readStatus()` verification,
     and commands (`play`, `pause`, `vol`, `switchmode`, `MCUKeyShortClick`).
     Falls back automatically to periodic polling if GENA callbacks cannot be
     established.
   - **Home Assistant remains intact as fallback:** `homeAssistant.music`
     continues to work unchanged, and targets can be configured in `wiim.music`
     or `homeAssistant.music` (mutually exclusive per semantic target ID).
   - Configured WiiM hosts must pass the LAN-only check (private/link-local
     IPv4 or `.local`).
2. **Linux desktop agent owns fast audio-driven Optical switching
   (`agents/linux/src/wiim.rs`, `agents/linux/src/optical.rs`):**
   - PipeWire PCM capture lives on the desktop; switching directly over a
     warmed HTTP/1.1 keep-alive TLS socket avoids an MQTT + Lugn hop and
     reaches the ~450 ms device floor.

### What extra information Lugn gains without Home Assistant

- **True physical input mode** (`mode` code → explicit source label such as
  `Optical In`, `Spotify`, `WiFi`, `Bluetooth`, `Line In`, `HDMI`) directly from
  the device rather than a cached HA entity attribute.
- **Lower-latency volume and playback feedback** (~10–25 ms via GENA push +
  keep-alive read instead of HA integration polling), improving fade tracking
  and manual-override attribution.
- **Direct physical `readStatus()` verification** during command recovery
  instead of reading Home Assistant's stored entity cache.
- **Device diagnostics** (`firmware`, `RSSI`, `max_volume`, remote battery,
  active EQ name, and saved preset inventory from `getPresetInfo`) available
  read-only from the adapter for future operational views.

## 4. Verification notes

- **Hardware-verified on WiiM Amp Ultra:** all read-only HTTP API endpoints
  listed above, UPnP SOAP read calls, UPnP GENA `SUBSCRIBE`/`NOTIFY`/`UNSUBSCRIBE`,
  HTTP/1.1 keep-alive reuse and idle expiry, and `setPlayerCmd:switchmode:optical`
  (leaving the device on Optical with volume, mute, EQ, presets, and power
  untouched).
- **Not sent to physical hardware (unit/mock-verified only):** write commands
  for volume (`setPlayerCmd:vol:<0-100>`), play/pause
  (`setPlayerCmd:play`/`pause`), non-optical source selection, and preset
  triggers (`MCUKeyShortClick:<n>`). These follow the documented LinkPlay/WiiM
  HTTP API and should be spot-checked on hardware when enabling `wiim.music`
  in production.
