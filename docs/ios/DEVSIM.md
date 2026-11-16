# Device simulator (`npm run device-sim`)

A developer-only Lugn server for building the iOS app and designs against
**live, moving data** without lamps, a speaker, the STL27L sensor, Home
Assistant or MQTT. It runs the real engine, routines, computer suggestions,
phone ingress, the `/api/v1` paired-device listener and the loopback
control-panel API, wired to simulated devices. A scripted day plays in a loop,
so presence, lights, music, air quality, Godnatt, suggestions and faults keep
changing. The `why` feed comes from the engine's own decisions.

It is never part of the production runtime: the code lives in
`scripts/device-sim/`, compiles to `dist-devsim/` (gitignored), and
`npm run build` / `dist/` do not include it. It needs no config file, no
credentials and no network access besides its own listeners. State goes to a
fresh temporary directory unless you pass `--state-dir`.

## Run it

Node 22 or newer (`engines` in `package.json`). Check with `node --version`.

### Linux

```sh
npm ci
npm run device-sim                     # loopback only: http://127.0.0.1:8789
npm run device-sim -- --lan --speed 10 # reachable from a phone on the LAN
```

### Mac (where Xcode and the iOS Simulator run)

```sh
# Node 22+: for example `brew install node@22` and follow its PATH hint,
# or `nvm install 22 && nvm use 22`.
git clone <the Lugn repository> && cd lugn   # or pull the branch
npm ci
npm run device-sim -- --speed 10
```

- **iOS Simulator on the same Mac:** the default bind is enough. In the app,
  enter `http://127.0.0.1:8789`.
- **iPhone on the same Wi-Fi:** `npm run device-sim -- --lan --speed 10`, then
  enter the first URL from the banner (the Mac's LAN address, for example
  `http://192.168.1.23:8789`, or `http://<mac-name>.local:8789`). macOS may ask
  whether `node` may accept incoming connections: allow it.
- **Simulator on the Mac, sim on a Linux box:** start it on Linux with
  `--lan` and use the Linux machine's LAN URL in the app. Open the port if a
  firewall runs (`sudo ufw allow 8789/tcp`).

The first build takes a few seconds (`tsc`); later starts are incremental.
Arguments go after `--`. `npm run device-sim -- --help` lists every option.

### LAN, plain HTTP

The prototype decision is LAN-only, plain HTTP on a private address, with no
Tailscale on the Lugn host (see [REACHABILITY.md](REACHABILITY.md)). The
simulator follows that: `--lan` (same as `--host 0.0.0.0`) or
`--host <LAN IP>` binds the LAN and prints a warning, because tokens and
pairing codes travel unencrypted and anyone on the network holding a code can
pair. Use a trusted home or office network only.

The listener checks the `Host` header exactly like production. With `--lan`
it accepts every local address and `<hostname>.local`, all listed in the
banner. If the app reaches the machine by another name, add
`--allowed-host <name>:8789`.

App side (Debug builds): plain HTTP to a LAN or loopback address needs
`NSAllowsLocalNetworking` under `NSAppTransportSecurity` (not
`NSAllowsArbitraryLoads`), and a physical phone needs the Local Network
permission (`NSLocalNetworkUsageDescription`).

## Pair the app

The banner shows the server URL and a pairing code:

```text
╔═══════════════════════════════════════════════════════════════╗
║  Server URL for the app:  http://192.168.1.23:8789            ║
║  Pairing code:            7K3Q-M9TD                           ║
╚═══════════════════════════════════════════════════════════════╝
```

Enter both in the app; it calls `POST /api/v1/pair` as documented in
[IOS-API.md](../IOS-API.md). A code lasts 15 minutes of wall time. When it is
used or expires, a new one is printed (`>>> New pairing code: …`). Type `pair`
for another one at any time, or create one through the control-panel API
(`curl -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:8788/devices/pairing`).

- `--dev-code` additionally accepts the fixed code `DEV0-0000` any number of
  times, for UI tests and scripts. `--pairing-code XXXX-XXXX` sets another
  fixed code. Never combine these with `--lan` on a network you do not trust.
- Tokens live in the state directory. Without `--state-dir` every start is a
  fresh server and the app must pair again (it receives `401`). With
  `--state-dir ~/.lugn-devsim` the token survives restarts of the simulator.

## The scripted day

`--speed <factor>` (default 1) runs virtual time faster: every scenario wait,
Lugn's exit grace, fades, routines, the 23:00 rule and the morning wake-up all
follow it. At `--speed 1` the loop takes about 45 minutes of real time (Godnatt
alone is 15 minutes); `--speed 10` shows a full day in about 5 minutes;
`--speed 30` is good for watching the fade. Between acts the clock jumps
forward, so one loop is one simulated day.

| Act        | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kväll`    | Someone enters (lights on), the computer starts a game and a **Fokus suggestion** appears, a Hub tap picks Vardagsljus (lights converge, observed lagging intent) and consumes it, Spotify starts on the speaker, phone hints arrive, a friend comes in (count 2), a 22 → 38 % **volume curve**, Mysljus, the desk lamp **drops off the network for 12 s** and recovers, someone dims the desk lamp outside Lugn (**override**), the friend leaves, the next two phone commands get **slow acks**, the room empties (**exit pending** 45 s, then **confirmed empty**: off and music paused), a return within the memory time restores everything, a **server restart** (new `instanceId`), a phone heartbeat, the next phone command **fails with 502**, the listener is **offline 8 s** (same `instanceId`), a window opens and closes (CO₂ and temperature react). |
| `läggdags` | Jump to 22:44; phone reports Sleep Focus, charging and a 07:00 wake alarm; **Godnatt starts** (wake 07:00, music on): its **15-minute light fade**, then the music steps; **quiet hours begin at 23:00**; a trip out and back during quiet hours (`Startade inte musik: tyst tid 23–06`); the sensor briefly reports `unknown`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `morgon`   | Jump to 06:50; Focus off; around 07:02 the charger is unplugged and the phone reports walking; Vardagsljus; leaving makes the room empty; Home Assistant reports **away** and the phone leaves the home geofence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `hemkomst` | Jump to 17:40; phone enters the home zone and Home Assistant reports home; the sensor sees someone in the doorway (prelight).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

CO₂, temperature, humidity and PM2.5 drift continuously with the number of
people and the window. The track title changes every few minutes while
Spotify plays.

`--scenario calm` plays the same loop without the fault steps (outage, ack
faults, restart, offline). `--scenario off` starts a quiet room (presence
unknown) for manual control only. `--seed <n>` makes device latency and air
drift reproducible.

The console narrates each step and every new why entry:

```text
[18:11:53 | sim mån 18:12:18 ×30] scenario · kväll · Hub: Vardagsljus (förslaget försvinner)
[18:11:53 | sim mån 18:12:18 ×30] why · acted · Valde Vardagsljus (Hub)
```

## Control it

Type commands into the terminal, or send them to the loopback control endpoint
(port 8790, `--control-port`, `--no-control`):

```sh
curl -d 'scene cozy' http://127.0.0.1:8790/sim/command
curl -d '{"command":"presence empty"}' http://127.0.0.1:8790/sim/command
curl http://127.0.0.1:8790/sim/status      # clock, instanceId, code, scenario position
curl http://127.0.0.1:8790/sim/help
```

The control endpoint and the control-panel API (port 8788, `--panel-port`,
`--no-panel`) always bind `127.0.0.1`, even with `--lan`. The control endpoint
also refuses requests carrying an `Origin` header, so a web page cannot drive
it.

| Command                                                                                                                                      | Effect                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `scene cozy\|everyday\|focus\|movie\|off\|<id>`                                                                                              | Hub tap (Swedish names `mys`, `vardag`, `fokus`, `film` work too)                                       |
| `presence occupied [n]`, `presence empty`, `presence unknown`, `count <n>`                                                                   | Sensor reports; empty goes through the 45 s exit grace                                                  |
| `prelight on\|off`, `home home\|away\|unknown`                                                                                               | Doorway approach signal, Home Assistant home presence                                                   |
| `music play\|pause`, `music volume <0-100>`, `music fade <0-100> [s]`                                                                        | Through Lugn, as a Hub tap                                                                              |
| `music external play\|pause`                                                                                                                 | Someone uses the speaker directly                                                                       |
| `light <bed\|ceiling\|desk> on\|off\|unavailable\|available\|blip [s]\|external <0-100>`                                                     | Light control, outages, changes outside Lugn                                                            |
| `bedtime [HH:MM]`, `bedtime clear`                                                                                                           | Start Godnatt now (wake time default 07:00), or clear the plan                                          |
| `desktop gaming\|video\|music\|desktop\|idle\|off`                                                                                           | Computer activity; `gaming` leads to a Fokus suggestion                                                 |
| `phone heartbeat\|foreground\|background`, `phone focus <mode>`, `phone charging on\|off`, `phone alarm HH:MM`, `phone geofence enter\|exit` | Observations from the simulated phone                                                                   |
| `air window open\|close`, `ha connected\|disconnected`                                                                                       | Air drift, integration health (`health.status` becomes `degraded`)                                      |
| `restart [s]`                                                                                                                                | Listener down for `s` (default 2) wall seconds, back with a **new `instanceId`**: clients must snapshot |
| `offline <s>`                                                                                                                                | Listener unreachable, **same `instanceId`**: Last-Event-ID resume gets a `patch`                        |
| `ack slow <ms> [n]`                                                                                                                          | The next `n` commands run at once but answer late, so state patches arrive before the response          |
| `ack fail [n]`                                                                                                                               | The next `n` commands return `502 command_failed` without running; a retry with the same id runs        |
| `speed <factor>`, `jump 30s\|10m\|2h\|HH:MM`                                                                                                 | Virtual time speed; jump forward (never backwards)                                                      |
| `scenario pause\|resume\|next\|list\|<act>`                                                                                                  | Drive the loop: pause, run the next step now, list steps, go to an act                                  |
| `status`, `pair`, `help`                                                                                                                     |                                                                                                         |

## Time

Everything Lugn sees runs on one virtual clock: state timestamps,
`generatedAt`, `serverTime` in `/me` and heartbeats, countdowns such as
`exitPending.until`, quiet hours and routines. Use `serverTime` for skew, as
in production. With `--speed` above 1 the server clock runs ahead of the phone
by a growing amount; `--start HH:MM` starts the virtual day at another time.

A real phone's observations carry its wall clock. The simulator shifts their
`observedAt` (and a wake alarm's `at`) by the current virtual-minus-wall
offset before validation, so fresh events still count as fresh after a jump.
If the app already corrects timestamps by the server skew, pass
`--no-phone-clock-shift`.

Heartbeats stay at 15 s of wall time. Streams end after 30 minutes of
**virtual** time, so at `--speed 20` the app reconnects with `Last-Event-ID`
about every 90 seconds — a useful exercise of the resume path.

## Record and replay

```sh
npm run device-sim -- --speed 10 --record session.jsonl
npm run device-replay -- session.jsonl --dev-code
npm run device-replay -- session.jsonl --dev-code --pause-at 95   # frozen at 95 s
```

`--record` pairs an internal client (its token is never written) and saves
what an app sees, one JSON object per line: a `header` (with the phone config),
every SSE `snapshot`, `patch` and `heartbeat` with its `id`, `connection`
open/closed markers, and a full `GET /api/v1/state` every 30 s and after every
snapshot. `t` is wall milliseconds since the recording started. The recorder
reconnects with `Last-Event-ID`, so restarts and offline periods are captured
as the app would see them.

`device-replay` serves a recording on the same port and Host rules: pairing
(new code, or `--dev-code`), `/me`, `/state` and `/events` follow the
recording at `--speed` (default 1). `--start-at <s>` skips ahead, `--pause-at
<s>` freezes the state for deterministic screenshot tests, and `--loop` starts
over at the end. Each new stream starts with a snapshot of the current
position; a recorded post-restart snapshot carries the new `instanceId`.
Commands and phone observations return `503 replay_read_only`.

## Tests

`tests/device-sim-clock.test.ts`, `tests/device-sim-scenario.test.ts` and
`tests/device-sim-startup.test.ts` run with `npm test`. The scenario test plays
the whole day on a manual clock and checks that presence, scenes, the
suggestion, the override, Godnatt, quiet hours, home/away, air drift and the
why feed all moved; the startup test checks pairing, the Host check, the
control endpoint, ack faults, phone clock shifting, restart versus offline
resume, and recording plus replay.

## Limitations

- Simulation proves app behaviour against Lugn's logic, not device behaviour.
  Latency (lights 0.25–1.8 s, speaker 0.3–1.2 s of virtual time), outages and
  drift are invented, not measured.
- `restart` restarts the listener only: a new `instanceId`, dropped streams,
  new rate limits and command receipts. The engine keeps its revision, why feed
  and phone state; a real restart resets those too.
- Not simulated: Govee effects, cameras, BILRESA buttons, switches, the Hub
  display, computer playback and Optical suggestions. Scene presets are not
  editable (`canEdit: false`).
- Replay is read-only, ignores `Last-Event-ID` (always snapshot first) and
  synthesizes heartbeats; timestamps inside the data stay as recorded.
- The simulated phone (`Simulerad iPhone`) appears in `phone.devices` without
  being a paired device.
