# Phone signals (iOS app design)

Status: **design, not implemented.** This document plans how the native iOS app
collects context from the phone and streams it to Lugn as hints. It is written
for a free personal Apple developer team, which is what the app is signed with
today. Server-side ingest (`POST /api/v1/phone/observations`) is not
implemented yet; the `phone:ingest` scope already exists (see
[IOS-API.md](../IOS-API.md)).

> **Wire contract note (added after the server shipped):** the server endpoint
> now exists and is authoritative. Where the payload sketches below differ,
> `docs/api/openapi.v1.yaml`, `docs/api/fixtures/phone-observations-*.json` and
> `src/core/phone.ts` win. The real request is
> `{sessionId, observations: [{eventId, sequence, observedAt (ms), type, ...}]}`
> with `type` one of `app`, `geofence`, `power`, `focus`, `wake_alarm`, `motion`,
> `network` (`kind`: wifi/cellular/none/unknown, `homeNetwork`), not the
> `{deviceId, batchId, events:[{kind,payload}]}` shape proposed here. The design
> rationale (queueing, ordering, retries, permissions, free-team limits) still
> applies.

Phone signals are **hints, never ground truth.** The LiDAR presence sensor
decides whether the room is occupied ([PRESENCE.md](../PRESENCE.md)). A phone
observation never runs a command, never creates a wake plan by itself, and
never clears an `occupied` state. The server decides what a hint means and
keeps provenance. Missing phone data means "unknown", not "away".

## Evidence labels

Each claim carries one of these labels.

| Label            | Meaning                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[HA]**         | Read in the Home Assistant iOS companion source (`home-assistant/ios`, `main` as of 2026-11-16) or its docs and issues. File paths are relative to that repository. |
| **[Apple]**      | Read in Apple's developer documentation (JSON doc endpoints, fetched 2026-11-16), including availability and deprecation metadata.                                  |
| **[Forum]**      | Apple Developer Forums. Labelled with whether an Apple engineer wrote it.                                                                                           |
| **[Unverified]** | My understanding or recall, not confirmed in this session. It must be checked on a device before anything depends on it.                                            |

---

## 1. Platform constraints that shape everything

### Free personal team

Apple's capability matrix lists what the free "Apple Developer" tier can sign
**[Apple]** (developer.apple.com/help/account/reference/supported-capabilities-ios):

| Free team: available                                                                                                          | Free team: **not** available (needs the paid program)                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Background modes (`location`, `fetch`, `processing`), App Groups, Keychain sharing, Data protection, HealthKit, HomeKit, Maps | **Access WiFi Information** (no SSID), **Communication Notifications** (no `INFocusStatusCenter`), **Push notifications** (no APNs, so no silent push and no Live Activity push), **Network Extensions** (no `NEAppPushManager` "Local Push"), **Siri** (SiriKit Intents extension), Time Sensitive notifications, Associated domains, iCloud |

Other free-team limits **[Apple]** (developer.apple.com/support/compare-memberships):

- Provisioning profiles expire **7 days** after issue. After that the app does
  not launch, and that includes background launches. Every signal stops
  silently until someone rebuilds and reinstalls from Xcode.
- At most 10 App IDs (each expiring after 7 days), 3 devices, and 3 apps per
  device. No TestFlight.

These do **not** need a capability, so they work on a free team: App Intents
(including `SetFocusFilterIntent` and Shortcuts actions), CoreMotion,
`NWPathMonitor`, local notifications, `BGTaskScheduler` (only the background
mode is needed), and background `URLSession`. AlarmKit needs only an
`NSAlarmKitUsageDescription` Info.plist key **[Apple]** and no listed
capability. That it actually works on a free team is **[Unverified]**.

### Background execution model

- A suspended iOS app runs no code. It is woken only by specific events:
  region/condition monitoring, significant location change, visits, a
  `BGAppRefreshTask`, a background `URLSession` completing, an App Intent run
  (from Shortcuts or a Focus filter), or the user opening it. Silent push would
  be another wake source, but it is not available on a free team.
- Each wake gets a short window. A `BGAppRefreshTask` gets "up to 30 seconds"
  **[Apple]**. Region wakes are short too. HA measures what remains through
  `beginBackgroundTask` and caps a one-shot GPS fix at `remaining - 5 s`
  (`Sources/Shared/Location/LocationTrigger.swift`) **[HA]**.
- **Force-quit.** Apple's general documentation says the system usually does
  not relaunch an app the user swiped away. For region monitoring the
  evidence conflicts:
  - An Apple engineer wrote in March 2026 that the app "will indeed be
    relaunched using Region Monitoring even if force quit", with "a throttle
    of once launch every 3-5 minutes", and that "the minimum radius could vary
    between 100 to 500 meters" **[Forum, Apple engineer, thread 818908]**.
  - A May 2026 report found that on iOS 26.4.2 neither region monitoring nor
    significant-change relaunched a force-quit app, although the same code did
    on iOS 18 **[Forum, no Apple reply, thread 826964]**.
  - **Design rule:** never depend on relaunch after a force-quit. Tell the user
    not to swipe the app away, and let the server degrade to "unknown".
- **Locked device.** Monitoring only starts after the first unlock following a
  reboot **[Apple]**. Region wakes can happen while the phone is locked, so the
  queue database and the bearer token must be readable after first unlock.
  Use the `.completeUntilFirstUserAuthentication` file protection class and the
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` Keychain class. With
  `complete` protection, a wake on a locked phone cannot read the token, so the
  event is lost **[Unverified for this app; standard iOS data-protection
  behaviour]**.
- **API churn.** `CLLocationManager.startMonitoring(for:)`, `CLCircularRegion`
  and `requestState(for:)` are deprecated as of iOS 27.3. `CLMonitor`
  (iOS 17+) is the replacement, and `CLServiceSession` (iOS 18+) declares the
  authorization goal **[Apple]**. HA still uses the deprecated
  `CLLocationManager` region API (`Sources/App/ZoneManager/ZoneManager.swift`)
  **[HA]**.

**Assumed deployment target: iOS 18 or later** (the Mac simulators run
27.2). If the target drops below 18, `CLServiceSession` must be replaced with
plain `requestAlwaysAuthorization()`.

---

## 2. Per-signal design

### Summary

| Signal                | Kind(s)                           | Primary API                                                                                         | Wakes the app?                         | Battery                  | Free team                            | Priority |
| --------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------ | ------------------------------------ | -------- |
| App heartbeat         | `app.heartbeat`                   | Scene phase plus every wake                                                                         | n/a (rides on other wakes)             | Negligible               | Yes                                  | P0       |
| Geofence arrive/leave | `geofence.enter`, `geofence.exit` | `CLMonitor` + `CLServiceSession(.always)`                                                           | **Yes**, including after termination   | Low                      | Yes (`location` background mode)     | P0       |
| Charging and battery  | `power.state`                     | `UIDevice` battery notifications while running, snapshot on every wake, plus a Shortcuts automation | Only through a Shortcuts automation    | Negligible               | Yes                                  | P1       |
| Focus / Sleep         | `focus.state`                     | `SetFocusFilterIntent` (App Intents)                                                                | **Yes** (iOS runs the filter)          | Negligible               | Yes. `INFocusStatusCenter` is **No** | P1       |
| Wake alarm            | `alarm.next`                      | Shortcuts automation into an App Intent. Optionally AlarmKit for alarms Lugn owns                   | Through Shortcuts                      | Negligible               | Yes; AlarmKit **[Unverified]**       | P2       |
| Wi-Fi / network hint  | `network.hint`                    | `NWPathMonitor` + LAN probe of the Lugn host. Shortcuts Wi-Fi automation for a named network        | Through the Shortcuts Wi-Fi automation | Negligible               | Yes. SSID read is **No**             | P2       |
| Motion activity       | `motion.activity`                 | `CMMotionActivityManager` history query on each wake                                                | No                                     | Negligible (coprocessor) | Yes                                  | P3       |

### 2.1 Geofence arrive/leave

**API.** Use one `CLMonitor` named `lugn.geofence`, with
`CLMonitor.CircularGeographicCondition` conditions. Hold a
`CLServiceSession(authorization: .always)` while the signal is enabled.

- **Conditions.** The default is a single `home` condition with a **150 m**
  radius around a point the user confirms on a map. An optional `approach`
  ring of 1–2 km gives earlier prelight hints. HA treats 100 m as the
  practical minimum. It splits smaller zones into three 100 m circles named
  `<zone>@<angle>`, because small regions false-enter
  (`AppZone.circularRegionsForMonitoring`, HA issue #784) **[HA]**. An Apple
  engineer gives an effective minimum of 100–500 m **[Forum]**. The app limit
  is 20 conditions of all types **[Apple]**.
- **Launch path.** In `application(_:didFinishLaunchingWithOptions:)`, before
  anything else, recreate the monitor **with the same name** and start
  iterating `monitor.events`. Apple requires recreating it on relaunch
  **[Apple]**. Recreate the `CLServiceSession` immediately on a background
  launch too **[Apple]**. Keep iterating for the life of the process.
- **State mapping.** `.satisfied` becomes `geofence.enter`, `.unsatisfied`
  becomes `geofence.exit`, and `.unknown` / `.unmonitored` are dropped. That
  mirrors HA's `ZoneManagerIgnoreReason.unknownRegionState` **[HA]**.
  `CLMonitor.Event` exposes `date`, `identifier`, `state` and the iOS 18
  diagnostics: `authorizationDenied`, `authorizationDeniedGlobally`,
  `authorizationRestricted`, `insufficientlyInUse`, `accuracyLimited`,
  `conditionLimitExceeded`, `conditionUnsupported`, `persistenceUnavailable`
  and `serviceSessionRequired` **[Apple]**. Put the diagnostic flags on the
  next heartbeat so the server and the UI can say why geofencing is degraded.
- **Dedupe.**
  - Persist the last reported state per condition. Drop an event whose state
    equals it.
  - The first event after `add` is an initial determination, not a
    transition. Send it with `initial: true` instead of suppressing it. HA
    suppresses it outright (`collector.ignoreNextState(for:)`) **[HA]**, but
    our server benefits from knowing the starting state.
  - HA also suppresses repeated exits of the same zone through different
    sub-regions for 5 minutes (`multiRegionExitDeduplicationInterval`)
    **[HA]**. With one circle per zone we do not need that.
- **No debounce on the phone.** The wake window is too short to wait in.
  Record `observedAt = event.date` and send immediately. The server applies
  hysteresis and combines the hint with LiDAR and Home Assistant `home`/`away`.
- **No GPS fix after a region event.** HA starts a one-shot
  `startUpdatingLocation` after every region event (up to 20 s;
  `ZoneManagerEvent.shouldOneShotLocation`) to send coordinates. That is the
  main thing eating its background window:
  - The open issue #6127 (iOS 27.0.1, 2026-10/11) shows region wakes
    happening but the work failing with `BackgroundTaskError.outOfTime`, so
    nothing was sent until the phone joined home Wi-Fi **[HA]**.
  - Lugn needs only "inside/outside home", so it sends the condition id and
    state, with **no coordinates**. That is both more reliable and more
    private.
- **Background behaviour.** The system wakes or launches the app on a state
  change. Apple's old guidance gives 3–5 minutes average latency
  **[Apple, `startMonitoring(for:)` discussion]**, and region monitoring
  "requires network connectivity" to be timely **[Apple]**. Exits are
  typically slower than enters. Measuring this on our phone is a real-device
  task.
- **Failure modes.**
  - When-in-use only: events need `CLBackgroundActivitySession` (with a
    visible indicator) and no launch from terminated. Treat this as a degraded
    state.
  - iOS has silently downgraded "Always" to "Ask Next Time" after an OS update
    (HA #3822, iOS 26) **[HA]**. Check authorization on every wake and every
    foreground, and send it in the heartbeat.
  - Approximate location: geofencing does not work under reduced accuracy
    **[Unverified; my recall of WWDC20 guidance]**. The `accuracyLimited`
    diagnostic **[Apple]** should confirm it on a device.
  - Other failure modes: force-quit (see §1), the 7-day profile expiry,
    Background App Refresh being off (this does not affect region wakes
    **[Unverified]**), and the tunnel or LAN being unreachable at wake time.
    In that last case the event stays queued, and the next wake flushes it.
- **Battery.** Region monitoring uses cell and Wi-Fi changes, not continuous
  GPS, so its cost is low **[Apple guidance; magnitude Unverified]**.
- **Free team.** The `location` background mode is free **[Apple]**.

**Optional extra wakes.** Significant-change monitoring delivers updates
after about 500 m of movement and no more often than every 5 minutes, and it
relaunches a terminated app **[Apple]**. Visit monitoring
(`startMonitoringVisits`) is not deprecated **[Apple]**. Neither is needed
for the home geofence. Expose them behind one toggle, "Extra väckningar",
**off by default**: they cost some battery and their only value is more flush
opportunities.

### 2.2 Charging and battery

**API.**

- Read `UIDevice.current.batteryState`, `batteryLevel` and
  `ProcessInfo.processInfo.isLowPowerModeEnabled`. Set
  `isBatteryMonitoringEnabled = true`. HA observes
  `batteryStateDidChangeNotification` (`BatterySensor.swift`) **[HA]**.
- Those notifications only arrive while the process runs **[Unverified;
  standard behaviour]**. So:
  1. Take a snapshot on **every** wake and every foreground.
  2. Subscribe to live changes while the app is running.
  3. Offer a **Shortcuts personal automation**, "Laddare: Ansluts / Kopplas
     från", that runs our `ReportPowerIntent`. This is the only way to learn
     about a cable plugged in at 23:10 while the app is suspended.

**Payload.** `{ state: "charging"|"full"|"unplugged"|"unknown", level: 0–1 | null, lowPowerMode: Bool, source: "live"|"snapshot"|"shortcut" }`.

**Dedupe.** Suppress the event when it equals the last enqueued
`power.state` on `state` and `lowPowerMode`, and when `level` changed by
less than 5 percentage points.

**Failure modes.**

- The Simulator reports `.unknown` and level −1, so the hardware must sit
  behind a protocol.
- Shortcuts automations can be disabled by the user, and they need "Run
  Immediately" (no confirmation). That option exists since iOS 17
  **[Unverified]**.

**Use on the server.** "Charging after 22:00 and stationary" suggests the
person is in bed. This is a hint for the Godnatt flow only.

### 2.3 Focus and Sleep

**API: `SetFocusFilterIntent`** (App Intents, iOS 16+) **[Apple]**.

- "When someone engages a Focus, the system executes your app's custom
  `SetFocusFilterIntent`" **[Apple]**.
- The user adds the **Lugn** filter to each Focus (Settings › Fokus ›
  Sömn › Fokusfilter › Lugn) and picks a mode parameter: `sömn`, `arbete`,
  `personligt`, `stör ej` or `annat`.
- HA's equivalent (`FocusNameFocusFilterAppIntent.swift`) notes:
  - iOS performs the filter with the chosen value when the Focus turns on,
    and "with none when it ends".
  - It is "the only way iOS tells an app _which_ Focus is on".
  - The app may have been launched just for this, so the report must sit
    inside a background task with a timeout (HA uses 20 s) **[HA]**.
  - `isDiscoverable = false` hides it from the Shortcuts editor **[HA]**.
- `SetFocusFilterIntent.current` lets the app read the active filter on
  every wake. HA treats `SetFocusFilterIntentError.notFound` as "no filtered
  Focus on" **[HA]**.

**Not used: `INFocusStatusCenter`.**

- It needs the Communication Notifications capability. Apple's sample lists
  it as a requirement, and an Apple Forums answer says Focus status "will only
  be available to apps that have the Communication Notifications capability"
  **[Apple sample; Forum]**.
- That capability is paid-only **[Apple matrix]**.
- HA uses it (with that entitlement) plus an Intents extension handling
  `INShareFocusStatusIntent`. HA's notes:
  - Read the status from the intent, because "in an extension the center
    answers 'not focused' whatever is on".
  - Wait a 5 s settle delay, because switching Focus "pushes 'not focused'
    for the Focus that ended" before the new one's filter runs
    (`FocusStatusIntentHandler.swift`) **[HA]**.
- Revisit when the paid account arrives. Even then, the filter is what gives
  the name.

**Payload.** `{ active: Bool, mode: "sleep"|"work"|"personal"|"dnd"|"other"|null, source: "filter"|"filterCurrent"|"shortcut" }`.

**Coalescing.** `focus.state` is an edge kind, so it is never coalesced. A
switch from Sleep to Work can produce `active:false` followed by
`active:true,mode:work` within seconds. The phone sends both, in `seq` order.
**The server** must treat an `active:false` followed by an `active:true`
within 5 s as a switch, not as "Focus ended". This is HA's settle-delay lesson,
moved to the side that has time to wait.

**Battery.** Nothing runs until iOS invokes the filter.

**Failure modes.**

- The user never adds the filter. Onboarding has to deep-link and explain the
  steps.
- iOS does not always run the filter when the Focus is toggled by a schedule
  **[Unverified; test the Sleep schedule on a device]**.
- Whether Focus filters can be configured in the Simulator is
  **[Unverified]**.

**Fallback.** A Shortcuts automation ("Sömn: Läggdags börjar / Vaknar",
"Fokus: Sömn slås på/av") that runs `ReportFocusIntent`.

### 2.4 Wake alarm

**No public API reads the Clock app's alarms.** AlarmKit (iOS 26+) only
schedules and lists the calling app's **own** alarms **[Apple]**: "Use
AlarmKit to create custom alarms and timers in your app". It needs
`NSAlarmKitUsageDescription`; without it "apps can't schedule alarms"
**[Apple]**.

Paths, in order of preference:

1. **Shortcuts into `ReportNextAlarmIntent`.** A nightly personal automation
   (for example "Sömn: Varva ner börjar", or 21:30) runs the Clock action
   "Hämta alla alarm", filters the enabled ones, and passes the next date into
   our intent. Whether that action exists and returns dates in the current
   iOS is **[Unverified]**. A second automation, "Alarm: Stoppas"
   (wake-up alarm), can report that the alarm fired. That needs an extra kind;
   see open questions.
2. **AlarmKit, owned by Lugn.** Lugn already asks for a wake time in
   Godnatt ([BEDTIME.md](../BEDTIME.md)). The app could **schedule** the wake
   alarm from the server's confirmed wake plan, so the alarm and the God
   morgon light share one source of truth. `alarm.next` then reports the
   alarms Lugn scheduled (`source: "alarmkit"`). This changes the direction of
   the flow (server to phone), so it is a product decision. Spike it in week 2. Whether it works on a free team is **[Unverified]**.
3. **Manual.** The heartbeat carries nothing. The server keeps using the
   Godnatt question.

**Payload.** `{ nextAt: ISO-8601 | null, label: String | null, source: "shortcut"|"alarmkit"|"manual" }`.
`nextAt: null` means "no alarm" and is distinct from "unknown", which means no
event was sent.

**Server rule.** `alarm.next` may **prefill or suggest** a wake time. It never
creates a wake plan. That stays consistent with "No wake plan is created by
installation, startup…" ([BEDTIME.md](../BEDTIME.md)).

### 2.5 Wi-Fi / network hint

**SSID is not readable on a free team.**
`NEHotspotNetwork.fetchCurrent` needs the Access WiFi Information entitlement
(paid-only) **and** location permission. HA notes that "iOS only shares the
network name with apps that have location access". It also needs Precise
Location, and Always for background reads (HA `Localizable.strings`,
`settings.connection_section.network_detection_permission.message`)
**[HA, Apple matrix]**.

What we do instead:

- **`NWPathMonitor`** (free): `status`, interface type (`wifi`, `cellular`,
  `wiredEthernet`, `other`), `isExpensive` and `isConstrained`. It only runs
  while the process runs. With Tailscale's VPN up, the path may report
  `other`, or report both the tunnel and Wi-Fi **[Unverified; test on the
  device]**.
- **LAN probe.** When on Wi-Fi, send a short (1.5 s timeout)
  `GET /api/v1/me` to the server's **LAN** address, not the MagicDNS name. A
  success means "on the home LAN". This needs the Local Network permission
  (`NSLocalNetworkUsageDescription`, free). The listener's `allowedHosts` must
  include the LAN `host:port` ([IOS-API.md](../IOS-API.md)).
- **Shortcuts Wi-Fi automation.** "Wi-Fi: Ansluter till / Lämnar
  ‹hemnätet›" runs `ReportNetworkIntent(label: "hemma")`. The user chooses
  the network in Shortcuts, and our app only ever sees the label. This is the
  only background-capable Wi-Fi signal on a free team.
- **HA lessons** **[HA]**:
  - An empty SSID read is often a roam between access points. HA keeps the
    last known state for a 60 s grace period (`emptyNetworkStateGrace`).
    Treat a single `none` reading the same way.
  - HA refreshes network info before it decides where to send (Focus handler,
    Focus filter). Our uploader likewise refreshes the path before choosing
    the LAN or Tailscale URL.

**Payload.** `{ interface: "wifi"|"cellular"|"wired"|"other"|"none", expensive: Bool, constrained: Bool, homeLan: Bool | null, label: String | null, source: "path"|"probe"|"shortcut" }`.

**Coalescing.** Keep only the latest unsent event, and suppress unchanged
values.

**Role on the server.** `homeLan == true` is a strong "phone is home" hint.
It is useful against slow geofence exits and enters. It is also a flush
trigger (§3.5).

### 2.6 Motion activity

**API.** `CMMotionActivityManager`, with `NSMotionUsageDescription` (free).

- Live updates arrive only while the app is running.
- On each wake, query the last 10 minutes, as HA does in `ActivitySensor`
  with `queryActivityStarting(from: now-10min, to: now)`. Report the latest
  activity's types and confidence **[HA]**.
- It does not wake the app. The M-series coprocessor records the data, so the
  cost is negligible **[Unverified magnitude]**.

**Payload.** `{ activity: "stationary"|"walking"|"running"|"automotive"|"cycling"|"unknown", confidence: "low"|"medium"|"high", startedAt: ISO-8601 }`.

**Value.** Low, so it ships last. It is useful as a secondary hint:
`automotive` combined with `geofence.exit` reads as a real departure, and a
`stationary` stretch near bedtime helps Godnatt. HA's open issue #6127 shows
`sensor.activity` stuck on `stationary` in the background, which is a reminder
that the value is only as fresh as the last wake **[HA]**.

### 2.7 App foreground heartbeat

**When.**

- When the scene becomes active (as HA does on `didBecomeActive`, including a
  location update on app open, `LifecycleManager.swift`) **[HA]**.
- Every 5 minutes while in the foreground.
- On **every** background wake, with the wake reason.

Sending it on every wake is our equivalent of HA's
`sensor.last_update_trigger`. HA's `LocationUpdateTrigger` enumerates its
sources: region enter/exit, significant change, background fetch, push, URL
scheme, Siri, app shortcut, launch, periodic, signaled, `Retry`
**[HA]**. HA users diagnose everything from that one value, so we make it
first-class.

**Payload.**

```json
{
  "wakeReason": "geofence",
  "appState": "background",
  "app": {
    "version": "0.3.0",
    "build": "42",
    "provisioningExpiresAt": "2026-11-23T09:00:00Z"
  },
  "os": "27.2",
  "lowPowerMode": false,
  "backgroundRefresh": "available",
  "permissions": {
    "location": "always",
    "preciseLocation": true,
    "motion": "authorized",
    "localNetwork": "unknown",
    "alarmKit": "notDetermined"
  },
  "geofenceDiagnostics": ["insufficientlyInUse"],
  "signals": {
    "geofence": true,
    "power": true,
    "focus": true,
    "alarm": false,
    "network": true,
    "motion": false
  },
  "queue": { "depth": 3, "oldestObservedAt": "…", "lastAckAt": "…" },
  "clock": { "deviceTime": "…", "lastServerTime": "…", "uptimeSeconds": 12345 }
}
```

- `provisioningExpiresAt` comes from `embedded.mobileprovision` in the app
  bundle (`ExpirationDate`). The server can then warn "Appen slutar fungera om
  1 dag" before the 7-day expiry kills every signal **[Unverified that the
  file is present and readable on device installs; it normally is for
  development builds]**.
- `signals` lets the server tell "disabled" apart from "stale".
- `clock` lets the server estimate device clock skew. `GET /api/v1/me`
  returns the server clock ([IOS-API.md](../IOS-API.md)).

**Coalescing.** Keep only the latest unsent heartbeat.

**Server use.** The age of the last heartbeat is the phone's liveness. With no
heartbeat for N hours, every phone hint becomes `unknown`.

---

## 3. App-side architecture

```text
 ┌──────────── system wake sources ───────────────────────────────────────┐
 │ CLMonitor events · App Intents (Focus filter, Shortcuts) · BGAppRefresh │
 │ background URLSession · scene active · NWPathMonitor                    │
 └───────────────┬─────────────────────────────────────────────────────────┘
                 ▼
   SignalSource (one per signal) ── EventDraft ──▶ SignalHub (actor)
                                                   │  toggles, coalescing, wake bookkeeping
                                                   ▼
                                     EventQueue (actor, SQLite on disk)
                                                   │  id, seq, observedAt, state, batch
                                                   ▼
                                     Uploader (inside SignalHub.flush)
                                                   │  batch → POST /api/v1/phone/observations
                                                   ▼
                                  ObservationTransport (URLSession; LAN or Tailscale)
```

### 3.1 `SignalHub` (actor)

- A single owner of signal state and flush policy, created first in
  `didFinishLaunching` so the CLMonitor can be recreated before its events
  are dropped.
- It holds the enabled set (persisted), the sources, the `EventQueue`, the
  transport, a `BackgroundRunner` (a wrapper over `beginBackgroundTask`) and a
  `SignalClock`.
- `ingest(_:)`:
  1. Drop the draft if its signal is disabled or a global pause is active.
  2. Apply per-kind suppression against the last enqueued value.
  3. Persist through `EventQueue.append`. The event is durable **before** any
     network call. This is HA's lesson: start the background task before any
     async work (`ZoneManager.perform(event:)`) **[HA]**.
  4. Schedule a flush. Urgent kinds (`geofence.*`, `focus.state`) flush
     immediately. Other kinds use a 1 s coalescing window, like HA's
     `signalCoalescingInterval = 1` **[HA]**.
- `flush(trigger:)` is serial (one in-flight batch). It takes a background
  task named after the trigger, sends batches until the queue is empty, the
  deadline is within 3 s, or a retryable error occurs, and then ends the
  background task.
- On every wake it records `wakeReason` and enqueues a heartbeat.

### 3.2 `EventQueue` (actor, disk-backed, idempotent)

**Storage.** SQLite through the system `libsqlite3`, in WAL mode, in
`Application Support/Signals/queue.sqlite`, with file protection
`.completeUntilFirstUserAuthentication`. An App Group container is needed
only if a future extension writes events. App Intents run in the app process
unless an App Intents extension is added.

**Tables.**

- `meta(key, value)`: `nextSeq`, `installId`.
- `events(id TEXT PK, seq INTEGER UNIQUE, kind, observedAt, payload BLOB, enqueuedAt, batchId NULL, attempts, nextAttemptAt, state CHECK(state IN ('pending','inFlight','acked','rejected')))`.
- `log`: the transparency log (§4.4). A view over `events` plus outcomes,
  kept for 7 days.

**Fields.**

- **Identity.** `id` is a UUIDv4 created at enqueue time and never
  regenerated. Retries resend the same id.
- **Ordering.** `seq` is a per-install monotonic `UInt64`, allocated in the
  **same transaction** as the insert, so it has no gaps on crash and is never
  reused. It resets only on a new pairing, when the queue is cleared.
- **Timing.** `observedAt` is the device wall-clock time of the observation.
  For geofence it is `CLMonitor.Event.date`; otherwise it is the moment of
  reading. `seq`, not `observedAt`, decides order. HA learned this the hard
  way: "`Date` moves backwards whenever the system clock is corrected, which
  would make a stale value look new". It numbers reads with a counter
  (`SensorContainer.readOrdering`) **[HA]**.

**Coalescing per kind.**

| Kind                                                             | Policy                                                                                                |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `geofence.enter`, `geofence.exit`, `focus.state`                 | Never coalesced. Every edge is delivered.                                                             |
| `app.heartbeat`, `network.hint`, `motion.activity`, `alarm.next` | Latest unsent wins: a newer draft replaces a `pending` event of the same kind that is not in a batch. |
| `power.state`                                                    | Unchanged values are suppressed; real transitions are kept.                                           |

HA does the same "recency wins" for state data. A newer location or sensor
request **cancels the in-flight one** (`WebhookResponseLocation.shouldReplace`
returns true) **[HA]**. We do not cancel in-flight batches, because the
server dedupes by id. We just avoid queueing stale snapshots.

**Batching.**

- `nextBatch()` first returns an existing `inFlight` batch, so the same
  `batchId` with the same events is resent after a crash or timeout.
- Otherwise it forms a new batch from `pending` events whose
  `nextAttemptAt <= now`, in ascending `seq`, up to 50 events and 64 KiB,
  assigns a fresh `batchId`, and marks those events `inFlight` in one
  transaction.
- The size cap is a guess until the server's `x-lugn-max-bytes` for this
  route is known **[Unverified]**.

**Outcomes.**

| Result                      | Action                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2xx                         | Each id the server lists as accepted or duplicate is marked `acked`. Ids listed as rejected become `rejected` (a poison event, kept in the log and never retried).                                                                                                                                                                                           |
| 400 / 413 / 415             | Split the batch in half and retry the halves. A single-event batch that still fails becomes `rejected`. This keeps one bad payload from blocking the queue.                                                                                                                                                                                                  |
| 401                         | Stop all sending, mark the device unpaired, and keep the queue but hide it. On re-pairing (a new `deviceId`), **discard** the old queue: hints from before re-pairing are stale and belong to a revoked identity.                                                                                                                                            |
| 429                         | Honour `Retry-After` / `retryAfterSeconds`.                                                                                                                                                                                                                                                                                                                  |
| 5xx, timeout, network error | Exponential backoff with full jitter: 2 s, 5 s, 15 s, 60 s, 5 min, 15 min (cap). HA's `SensorUpdateRetry.delays = [15, 60, 120, 300, 900]`, and it only holds the process alive for waits ≤ 30 s (`heldAliveUpTo`); longer waits fire on the next wake **[HA]**. We do the same: a background flush never sleeps longer than the remaining window minus 3 s. |

**Bounds.**

- Drop `pending` events older than 24 h (stale hints are harmful) and log
  them as `expired`.
- Cap the queue at 2,000 rows. The oldest coalescible kinds are evicted
  first; edges go last.
- When the user disables a signal, purge that signal's pending events.

### 3.3 Wire schema

The server shape is fixed by the task. Field rules below are a proposal for
the server thread.

```json
POST /api/v1/phone/observations
Authorization: Bearer lgn1.<deviceId>.<secret>
Content-Type: application/json

{
  "deviceId": "dev_…",
  "batchId": "8a0c…-uuid",
  "events": [
    {
      "id": "0f9b…-uuid",
      "seq": 1041,
      "observedAt": "2026-11-16T17:42:08.412Z",
      "kind": "geofence.exit",
      "payload": { "regionId": "home", "initial": false, "radiusMeters": 150 }
    },
    {
      "id": "a17e…-uuid",
      "seq": 1042,
      "observedAt": "2026-11-16T17:42:09.001Z",
      "kind": "app.heartbeat",
      "payload": { "wakeReason": "geofence", "appState": "background" }
    }
  ]
}
```

| Kind              | Payload                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `app.heartbeat`   | §2.7                                                                                                 |
| `geofence.enter`  | `{ regionId: "home"\|"approach"\|String, initial: Bool, radiusMeters: Number }`. **No coordinates.** |
| `geofence.exit`   | Same as `geofence.enter`.                                                                            |
| `power.state`     | `{ state, level, lowPowerMode, source }` (§2.2)                                                      |
| `focus.state`     | `{ active, mode, source }` (§2.3)                                                                    |
| `alarm.next`      | `{ nextAt, label, source }` (§2.4)                                                                   |
| `network.hint`    | `{ interface, expensive, constrained, homeLan, label, source }` (§2.5)                               |
| `motion.activity` | `{ activity, confidence, startedAt }` (§2.6)                                                         |

**Proposed server contract** (to agree with the server thread):

- `deviceId` must equal the token's device, or the server returns `403`.
- Events are deduped by `id` per device, for at least 7 days or the last
  10,000 ids. Dedupe must be **persisted**, unlike the 24 h in-memory command
  ledger, because a phone may retry a batch after a server restart.
- A replayed `batchId` with identical content returns the stored answer. The
  same `batchId` with different content returns `409`.
- Response:
  `{ accepted: [id], duplicate: [id], rejected: [{ id, error }], highestSeq }`.
- The server records `receivedAt` and derives provenance as
  `phone:<deviceId>`.
- Events out of order by `seq` are accepted. The server orders by `seq`, not
  by arrival.
- A `seq` gap is fine; it is diagnostic only.
- A `seq` lower than one already seen, with an unseen id, means the app was
  reinstalled or its data reset. Accept it and log it.

### 3.4 Transport

- **Foreground and short wakes:** a default `URLSession`
  (`.ephemeral` configuration, 10 s request timeout), sending to the LAN URL
  when `homeLan` is true and to the Tailscale MagicDNS URL otherwise.
- **Fallback when the window is closing:** a background `URLSession`
  (`URLSessionConfiguration.background(withIdentifier: "lugn.signals")`,
  `sessionSendsLaunchEvents = true`) upload **from a file**. HA's approach:
  - While active it uses the background session directly.
  - In the background it tries the regular session first and falls back to
    the background session on a transport error. It does not fall back on an
    API error ("not worth retrying, since we got a real response").
  - It keeps request metadata in `taskDescription` so a relaunched process
    can match completions (`WebhookManager.send`,
    `URLSessionTask+WebhookPersisted.swift`) **[HA]**.
  - We keep `batchId` in `taskDescription`. In
    `application(_:handleEventsForBackgroundURLSession:)`, recreate the
    session and mark the batch `acked` from the response.
  - Background transfers started from the background are discretionary, so
    they may be delayed. That is acceptable for a fallback, and idempotency
    makes a late duplicate harmless **[Unverified timing]**.
- **Tailscale.** The iOS Tailscale app must be connected (on-demand) for
  background traffic. Whether `nsurlsessiond` traffic is routed through it on
  a locked phone is **[Unverified]**.
- **ATS.** The app needs an exception for plain HTTP to the MagicDNS host and
  the LAN ([IOS-API.md](../IOS-API.md)).

### 3.5 Flush triggers

| Trigger                                                                    | Window                          | Notes                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scene becomes active                                                       | Unbounded                       | Also enqueues a heartbeat and starts the SSE stream.                                                                                                                                                                           |
| Scene enters the background                                                | `beginBackgroundTask` (seconds) | A last chance before suspension.                                                                                                                                                                                               |
| CLMonitor event (also after a launch from terminated)                      | Short                           | Enqueue first, then flush. No GPS.                                                                                                                                                                                             |
| App Intent run (Focus filter, Shortcuts)                                   | Short                           | `perform()` awaits the flush with a 15 s cap, then returns.                                                                                                                                                                    |
| `BGAppRefreshTask` (`lugn.signals.refresh`)                                | ≤ 30 s **[Apple]**              | Resubmit the request first (HA: `earliestBeginDate` 15 min). Snapshot power, network and motion, then flush. Not run with Background App Refresh off or in Low Power Mode, and probably not after force-quit **[Unverified]**. |
| `NWPathMonitor` goes `unsatisfied` → `satisfied`, or the interface changes | Only while running              | Also re-runs the LAN probe.                                                                                                                                                                                                    |
| Background URLSession completion                                           | Short                           | Ack the batch; flush the remainder if time is left.                                                                                                                                                                            |
| Enqueue of an urgent kind                                                  | Current window                  | Immediate.                                                                                                                                                                                                                     |

`BGProcessingTask` is **not** used for signals. It runs "only when the device
is idle" **[Apple]**. At most it could compact the transparency log.

---

## 4. Permission and onboarding UX (Swedish)

### 4.1 Principles

- Ask in context, one permission per screen. Every permission can be skipped.
- Each screen says exactly what leaves the phone, and that it goes only to
  the user's own server. HA's location screen does this well: "This option
  shares the device's location only with your Home Assistant system… This
  data stays in your home and is never sent to third parties."
  (`onboarding.location_access.*`) **[HA]**.
- Location is asked for in two steps: "While Using" first, then "Always" with
  its own explanation screen. iOS decides when to show the Always prompt
  again; an app cannot re-ask freely. An HA maintainer: "developers can't ask
  the 'allow always' permission if they have asked it before" (#3822)
  **[HA]**. `CLServiceSession(.always)` "requests a person's authorization to
  meet those requirements if possible, including automatically re-asking as
  needed" **[Apple]**.
- Denied permissions get a calm explanation and an "Öppna Inställningar"
  button (`UIApplication.openSettingsURLString`). We do not nag.

### 4.2 Onboarding flow (after pairing)

1. **"Låt telefonen hjälpa Lugn"** (overview). Body: "Lugn kan få små ledtrådar
   från din telefon, till exempel om du är på väg hem eller har lagt dig. Rummets
   egen närvarosensor bestämmer alltid. Du väljer vad som skickas, och allt går
   bara till din egen Lugn-server." Buttons: **Välj signaler** / **Inte nu**.
2. A checklist of signals with recommended defaults: Hemma/borta on, Laddning
   on, Fokus & sömn on, Nätverk on, Väckarklocka off, Rörelse off. Each row
   opens its own permission screen below.
3. Per-signal screens (§4.3), each ending in the system prompt or Shortcuts
   setup.
4. **"Svep inte bort Lugn"**: "Om du stänger Lugn genom att svepa bort appen
   kan iOS sluta väcka den när du kommer hem. Det är helt okej att låta den
   ligga kvar i bakgrunden – den drar nästan inget batteri."
5. **Done**: "Du kan alltid se exakt vad som skickas under _Inställningar ›
   Telefonsignaler › Visa vad som skickas_."

### 4.3 Copy per permission

**Info.plist usage strings** (shown by iOS inside the system prompt):

| Key                                            | Swedish text                                                                                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NSLocationWhenInUseUsageDescription`          | Lugn använder din plats för att märka när du kommer hem eller går hemifrån. Bara "hemma" eller "borta" skickas till din egen Lugn-server – aldrig var du befinner dig. |
| `NSLocationAlwaysAndWhenInUseUsageDescription` | Välj "Tillåt alltid" så att Lugn märker när du kommer hem eller går, även när appen inte är öppen. Bara hemma/borta skickas till din egen server – aldrig koordinater. |
| `NSMotionUsageDescription`                     | Lugn kan se om du står still, går eller åker, för att bättre förstå om du är på väg hem eller har lagt dig. Bara typen av rörelse skickas till din server.             |
| `NSLocalNetworkUsageDescription`               | Lugn ansluter till din Lugn-server i hemnätverket och kontrollerar om telefonen är på hemma-wifi.                                                                      |
| `NSAlarmKitUsageDescription`                   | Lugn ställer väckningslarm som hör ihop med ditt God morgon-ljus.                                                                                                      |

**In-app priming screens:**

- **Hemma/borta (location, step 1).**
  - Title: "Märk när du kommer hem"
  - Body: "Lugn lägger en osynlig cirkel runt ditt hem. När du korsar den får
    servern veta 'hemma' eller 'borta' – inget annat. Koordinater lämnar
    aldrig telefonen."
  - Bullets: "Förtänd lampor när du är på väg hem" · "Släck och pausa musik
    tidigare när du gått" · "Rummets sensor har alltid sista ordet"
  - Primary: **Fortsätt** → "While Using" prompt. Secondary: **Hoppa över**.
- **Hemma/borta (location, step 2, Always).**
  - Title: "Även när appen är stängd"
  - Body: "För att märka att du kommer hem behöver Lugn få veta det även när
    appen inte är öppen. Välj **Ändra till Tillåt alltid** i nästa ruta. Du kan
    ändra detta när som helst i Inställningar."
  - Primary: **Fortsätt**. Secondary: **Bara när appen används** (then the
    signal shows the status "Fungerar bara när appen är öppen").
- **Exakt plats.** Shown only if Precise Location is off.
  - Title: "Slå på Exakt plats"
  - Body: "Med ungefärlig plats kan iOS inte avgöra när du passerar
    hemcirkeln. Slå på **Exakt plats** för Lugn i Inställningar."
  - Button: **Öppna Inställningar**.
- **Hemmets position.**
  - Title: "Var ligger hemmet?"
  - Body: "Dra kartan så att nålen hamnar på ditt hem. Cirkeln är 150 meter –
    mindre än så blir opålitligt."
  - Buttons: **Spara** / **Använd nuvarande plats**.
- **Laddning.**
  - Title: "Laddning och batteri"
  - Body: "Lugn kan se om telefonen laddar, till exempel för att förstå att du
    har lagt dig. Ingen behörighet behövs när appen är öppen. För att det ska
    fungera även när appen är stängd lägger du till en automation i Genvägar."
  - Primary: **Visa hur** (a step-by-step sheet: Genvägar › Automation › Ny ›
    Laddare › Ansluts och Kopplas från › Kör omedelbart › Lugn: Rapportera
    laddning). Secondary: **Bara när appen är öppen**.
- **Fokus och sömn.**
  - Title: "Fokus och sömn"
  - Body: "Lägg till Lugns fokusfilter i de fokuslägen du vill dela, till
    exempel Sömn. Då får servern veta när fokusläget slås på eller av och vilket
    läge det är – inget om dina aviseringar eller kontakter."
  - Steps: "Inställningar › Fokus › Sömn › Lägg till filter › Lugn › välj
    _Sömn_"
  - Primary: **Öppna Fokusinställningar**. Secondary: **Hoppa över**.
- **Väckarklocka.**
  - Title: "Nästa väckning"
  - Body: "iOS låter inte appar läsa dina larm i Klockan. Med en automation i
    Genvägar kan du skicka nästa larmtid till Lugn varje kväll, så att God
    morgon-ljuset kan föreslås till rätt tid. Lugn ställer aldrig in en
    väckning på egen hand."
  - Primary: **Visa hur**. Secondary: **Inte nu**.
- **Nätverk.**
  - Title: "Hemma-wifi"
  - Body: "Lugn kan märka om telefonen är på samma nätverk som servern. Wifi-namnet
    läses aldrig. Vill du att det fungerar även i bakgrunden kan du lägga till
    en automation för ditt hemnätverk i Genvägar."
  - Primary: **Tillåt lokalt nätverk** (the iOS Local Network prompt).
    Secondary: **Hoppa över**.
- **Rörelse.**
  - Title: "Rörelse"
  - Body: "Lugn kan läsa om du står still, går eller åker. Det hjälper till att
    skilja en riktig hemfärd från en promenad runt kvarteret. Bara typen av
    rörelse skickas."
  - Primary: **Fortsätt**. Secondary: **Hoppa över**.
- **Denied** (generic).
  - Title: "Behörighet saknas"
  - Body: "Lugn har inte tillgång till {sak}. Signalen är avstängd tills du
    ändrar det i Inställningar."
  - Button: **Öppna Inställningar**.
- **Downgraded by iOS** (the HA #3822 case).
  - Banner: "iOS har ändrat platsbehörigheten för Lugn till 'Fråga nästa
    gång'. Hemma/borta fungerar inte förrän du väljer 'Alltid' igen."
  - Button: **Öppna Inställningar**.
- **Profile expiry** (free team; a local notification 24 h before
  `provisioningExpiresAt`).
  - "Lugn-appen slutar fungera i morgon kl. {tid}. Bygg och installera om från
    Xcode för att telefonsignalerna ska fortsätta."

### 4.4 Settings: per-signal toggles

Settings › **Telefonsignaler**:

```text
 Pausa alla signaler                         [ ]   (1 timme · Till i morgon · Tills vidare)
 ─────────────────────────────────────────────
 ⌂  Hemma/borta              Alltid · senast 17:42 "borta"        [●]
 ⚡  Laddning                 Live när appen är öppen · Genväg ✓   [●]
 ☾  Fokus och sömn           Filter i: Sömn                        [●]
 ⏰  Väckarklocka             Ingen genväg ännu                    [ ]
 ⌁  Nätverk                  Hemmanätet · senast 08:10             [●]
 ↯  Rörelse                  Avstängd                              [ ]
 ─────────────────────────────────────────────
 Visa vad som skickas  ›
 Senaste väckning: Hemma/borta, 17:42 (bakgrund)
 Kö: 0 väntar · senast mottaget av servern 17:42
```

- Each row shows its **status line**:
  - Permission state: "Alltid", "Bara när appen används", "Behörighet saknas"
    or "Ungefärlig plats".
  - Dependency state: "Genväg saknas" or "Filter inte tillagt".
  - The last value and time.
- Tapping a row opens details: what is sent (a sample JSON), why, the
  permission, setup steps, and **Skicka nu** (manual trigger, wake reason
  `manual`).
- Toggling **off** stops the source, purges that signal's pending events, and
  enqueues a heartbeat whose `signals` map lists it as `false`. The server then
  knows the signal is disabled and not stale.
- **Pausa alla** suppresses `ingest` for its duration. It still sends a
  heartbeat with `paused: true` and `pausedUntil`.

### 4.5 "Visa vad som skickas" (transparency view)

- Header: "Det här är allt Lugn-appen har skickat till din server de senaste 7
  dagarna. Inget skickas till någon annan."
- The list is grouped by day, newest first. Each row has:
  - The time, plus "observerat" vs "skickat" when they differ by more than
    60 s.
  - A Swedish summary: "Lämnade hemmet", "Kom hem", "Började ladda (82 %)",
    "Sömn på", "Nästa larm 06:45", "Hemma-wifi", "Står still",
    "Appen vaknade (bakgrund – hemma/borta)".
  - A status chip: **Väntar** · **Skickas…** · **Skickad 17:42** ·
    **Misslyckades – nytt försök 17:45** · **Avvisad av servern** ·
    **För gammal – kastad**.
- Tapping a row shows the exact JSON object as sent (`id`, `seq`,
  `observedAt`, `kind`, `payload`), the `batchId`, the attempts and the last
  error. Button: **Kopiera JSON**.
- Toolbar actions:
  - **Skicka nu** flushes immediately.
  - **Rensa kön** confirms "Händelser som inte har skickats tas bort", then
    clears.
  - **Exportera logg** opens the share sheet with JSON. This is the
    equivalent of HA's exportable event log, which its users and maintainers
    rely on in every location bug report (#6127) **[HA]**.
- The log also records **non-sends**, with their reason: "Ignorerad:
  oförändrat", "Ignorerad: signalen avstängd", "Ignorerad: okänt läge". This
  mirrors HA's `ClientEvent` entries "Didn't update: <reason>" and its
  `ZoneManagerIgnoreReason`, which make silent drops diagnosable **[HA]**.

---

## 5. Test strategy

### 5.1 Simulator and unit tests (deterministic)

- **Clock injection.** `SignalClock` provides `now` (wall time), `uptime`
  (`ContinuousClock.Instant`) and `sleep(for:)`. `TestClock` advances
  manually. Every backoff, TTL, coalescing window and heartbeat interval is
  tested without real waits. HA makes its schedulers replaceable for exactly
  this reason ("tests, which shouldn't spend a second per case") **[HA]**.
- **EventQueue tests** (a temporary SQLite file):
  - `seq` is monotonic across a reopen.
  - A crash between `nextBatch` and the ack resends the **same** `batchId` and
    ids.
  - Coalescing per kind; TTL expiry; the size cap and eviction order.
  - Purge on disable; poison split on 400; 401 halts; 429 honours
    `Retry-After`.
  - Discard on re-pairing.
- **Transport.** A `URLProtocol` stub or a `FakeTransport` actor scripted with
  responses: success, partial reject, duplicate, timeout, 5xx.
- **Contract.** Copy the server fixtures from `docs/api/fixtures/` once the
  phone route exists. Encode `ObservationBatch` and validate it against the
  OpenAPI schema in a test.
- **Geofence logic** behind a `GeofenceSystem` protocol. A fake emits
  `.unknown`, a duplicate `.satisfied`, an initial event after `add`, and
  diagnostics. Assert the mapping, dedupe and `initial` flag.
- **Location in the Simulator:**
  - Use Xcode scheme location simulation with a **GPX** route that starts at
    home, walks 600 m out, waits, and returns. Commit a few GPX files:
    `leave-home.gpx`, `arrive-home.gpx`, `edge-wobble.gpx` (crosses the
    boundary repeatedly, to check dedupe).
  - Drive it from the command line with `xcrun simctl location <udid> set <lat>,<lon>`
    and `xcrun simctl location <udid> start --speed=1.4 <wp1> <wp2> …`. The
    exact flags are **[Unverified]**; check `simctl help location`.
  - That `CLMonitor` delivers events for simulated locations in the
    Simulator is **[Unverified]**. If it does not, the fake system covers the
    logic, and the device covers the integration.
- **App Intents.** Run `ReportPowerIntent`, `ReportNetworkIntent` and
  `ReportNextAlarmIntent` from the Shortcuts app in the Simulator, and also
  by calling `perform()` in unit tests with a fake hub.
- **Focus filter.** Unit-test `perform()` and the `current` handling,
  including `notFound` meaning `active:false`. Whether Settings › Fokus in the
  Simulator can attach a filter is **[Unverified]**.
- **BGAppRefresh.** `BGTaskScheduler.submit` is not supported in the
  Simulator **[Unverified]**; the error `.unavailable` is handled the way HA
  does in `BackgroundRefreshManager` **[HA]**. Test the handler body as a
  plain function.
- **Battery and network** sit behind `PowerReading` / `PathReading`
  protocols. The Simulator's battery is `.unknown`.
- **UI.** The transparency view and toggles get SwiftUI previews with seeded
  queue states (all chip states), plus snapshot or UI tests where the app
  foundation supports them.

### 5.2 Real-iPhone-only checks

Each of these needs a field log: the in-app export plus the server's
`receivedAt`.

1. Geofence exit and enter with the app **suspended**, **terminated by the
   system** (for example after a memory-heavy game) and **force-quit**, each
   with the phone locked. Record the latency (crossing → `observedAt` →
   `receivedAt`) over at least 10 crossings of each kind.
2. The wake budget: no `outOfTime` failures logged around region wakes (the
   HA #6127 failure mode).
3. Reboot without unlocking, then unlock: monitoring resumes and the queue and
   token are readable.
4. "Always" survives an iOS update. The downgrade banner appears if it does
   not.
5. Focus filter runs for a manual Sleep toggle, the **scheduled** Sleep and
   Focus switches (Sleep → Personal). Confirm the server sees one switch.
6. Shortcuts automations run silently ("Kör omedelbart") for the charger,
   Wi-Fi and alarm triggers. Check the "Hämta alla alarm" action output.
7. Tailscale on-demand in the background on a locked phone. Background
   `URLSession` completion relaunches the app and acks.
8. `NWPathMonitor` interface type with Tailscale up. The LAN probe and the
   Local Network prompt.
9. `BGAppRefreshTask` real frequency over 48 h, with Low Power Mode on and
   off.
10. Battery impact over 48 h (Settings › Batteri, per app) with all signals
    on versus geofence only.
11. 7-day expiry: what happens on day 8, whether the reminder notification is
    delivered, and that reinstalling over the top keeps the queue and token
    (same bundle id and team) **[Unverified]**.
12. AlarmKit authorization and scheduling on a free-team build (if the spike
    goes ahead).

---

## 6. Build order: first two weeks (free account)

The goal is to ship the pipeline and the most valuable signal first, with
transparency from day one so field debugging is possible.

**Week 1: pipeline and geofence**

| Day | Deliverable                                                                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `LugnKit/Signals`: wire types, `SignalClock`, `EventQueue` on SQLite, with unit tests for `seq`, batching, crash replay and coalescing.                                                                                                              |
| 2   | `ObservationTransport` with a URLSession implementation and a fake. Backoff/429/401/poison handling. `app.heartbeat` on foreground and every 5 min. **Needs the server route**: coordinate with the server thread, or post to a stub until it lands. |
| 3   | The transparency view and the settings toggles, wired to the real queue. Profile-expiry reading in the heartbeat and the local reminder notification.                                                                                                |
| 4   | `GeofenceMonitor` (CLMonitor + CLServiceSession), launch-path recreation, flush on wake, Keychain and file-protection classes, the two-step location onboarding and the home map picker.                                                             |
| 5   | GPX simulator tests. Install on the iPhone. Start the field log (walks out and back). Fix what the log shows.                                                                                                                                        |

**Week 2: cheap high-value signals, then the rest**

| Day | Deliverable                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6   | `power.state`: a snapshot on every wake, live updates while running, `ReportPowerIntent` and the Shortcuts setup sheet.                                                                                     |
| 7   | `focus.state`: `SetFocusFilterIntent`, reading `current` on wake, onboarding deep link. Field-test Sleep.                                                                                                   |
| 8   | `network.hint`: `NWPathMonitor`, the LAN probe, `ReportNetworkIntent`, the reachability flush trigger, and the `BGAppRefreshTask` registration.                                                             |
| 9   | `alarm.next` through `ReportNextAlarmIntent` (Shortcuts). A half-day AlarmKit spike on the free team; write up the decision.                                                                                |
| 10  | `motion.activity` (if time allows). A 48 h battery and latency review. Re-sign before the 7-day expiry. Update this document with measured numbers and resolve the **[Unverified]** items that were tested. |

**What to ship first:** the queue, heartbeat and transparency view (days
1–3), then the geofence (days 4–5). Everything else rides on that pipeline.

**Deferred until the paid account:**

- APNs (a server-initiated "send your state now", which is HA's
  `PushNotification` trigger).
- `INFocusStatusCenter` (instant Focus on/off without a filter).
- The SSID through Access WiFi Information.
- Local Push through a Network Extension (HA's `NEAppPushManager` works
  only on configured SSIDs, `NotificationManagerLocalPushInterfaceExtension`)
  **[HA]**.
- TestFlight builds without the 7-day expiry.

---

## 7. Swift sketch (types and protocols)

Swift 6 with strict concurrency. Shapes only; bodies are left out or minimal.
This is unverified until it is compiled on the Mac.

```swift
import Foundation
import CoreLocation

// MARK: - Clock and background execution

public protocol SignalClock: Sendable {
    /// Wall-clock time, used only for `observedAt` and display.
    var now: Date { get }
    /// Monotonic time for timers and backoff; unaffected by clock changes.
    var uptime: ContinuousClock.Instant { get }
    func sleep(for duration: Duration) async throws
}

/// Wraps `UIApplication.beginBackgroundTask` so tests can run without UIKit.
public protocol BackgroundRunner: Sendable {
    /// Runs `work` inside a background assertion. `remaining` is the time the
    /// system granted, if known. Throws `BackgroundRunError.outOfTime` on expiry.
    func run<T: Sendable>(
        named name: String,
        _ work: @Sendable (_ remaining: Duration?) async throws -> T
    ) async throws -> T
}

public enum BackgroundRunError: Error, Sendable { case outOfTime, denied }

// MARK: - Wire model

public enum SignalKind: String, Codable, Sendable, CaseIterable {
    case appHeartbeat   = "app.heartbeat"
    case geofenceEnter  = "geofence.enter"
    case geofenceExit   = "geofence.exit"
    case powerState     = "power.state"
    case focusState     = "focus.state"
    case alarmNext      = "alarm.next"
    case networkHint    = "network.hint"
    case motionActivity = "motion.activity"

    public enum Coalescing: Sendable { case never, latestUnsent, suppressUnchanged }

    public var coalescing: Coalescing {
        switch self {
        case .geofenceEnter, .geofenceExit, .focusState: .never
        case .powerState: .suppressUnchanged
        case .appHeartbeat, .alarmNext, .networkHint, .motionActivity: .latestUnsent
        }
    }

    /// Urgent kinds flush immediately instead of waiting for the coalescing window.
    public var isUrgent: Bool { self == .geofenceEnter || self == .geofenceExit || self == .focusState }

    public var signal: SignalID {
        switch self {
        case .appHeartbeat: .heartbeat
        case .geofenceEnter, .geofenceExit: .geofence
        case .powerState: .power
        case .focusState: .focus
        case .alarmNext: .alarm
        case .networkHint: .network
        case .motionActivity: .motion
        }
    }
}

/// User-facing toggle granularity (one toggle can own several kinds).
public enum SignalID: String, Codable, CodingKeyRepresentable, Sendable, CaseIterable {
    case heartbeat, geofence, power, focus, alarm, network, motion
}

public enum WakeReason: String, Codable, Sendable {
    case launch, foreground, background, geofence, significantChange, visit
    case backgroundRefresh, backgroundURLSession, appIntent, focusFilter
    case reachability, manual, retry
}

public struct GeofencePayload: Codable, Sendable, Equatable {
    public var regionId: String
    public var initial: Bool
    public var radiusMeters: Double
}

public struct PowerPayload: Codable, Sendable, Equatable {
    public enum State: String, Codable, Sendable { case charging, full, unplugged, unknown }
    public enum Source: String, Codable, Sendable { case live, snapshot, shortcut }
    public var state: State
    public var level: Double?
    public var lowPowerMode: Bool
    public var source: Source
}

public struct FocusPayload: Codable, Sendable, Equatable {
    public enum Mode: String, Codable, Sendable { case sleep, work, personal, dnd, other }
    public enum Source: String, Codable, Sendable { case filter, filterCurrent, shortcut }
    public var active: Bool
    public var mode: Mode?
    public var source: Source
}

public struct AlarmPayload: Codable, Sendable, Equatable {
    public enum Source: String, Codable, Sendable { case shortcut, alarmkit, manual }
    public var nextAt: Date?
    public var label: String?
    public var source: Source
}

public struct NetworkPayload: Codable, Sendable, Equatable {
    public enum Interface: String, Codable, Sendable { case wifi, cellular, wired, other, none }
    public enum Source: String, Codable, Sendable { case path, probe, shortcut }
    public var interface: Interface
    public var expensive: Bool
    public var constrained: Bool
    public var homeLan: Bool?
    public var label: String?
    public var source: Source
}

public struct MotionPayload: Codable, Sendable, Equatable {
    public enum Activity: String, Codable, Sendable {
        case stationary, walking, running, automotive, cycling, unknown
    }
    public enum Confidence: String, Codable, Sendable { case low, medium, high }
    public var activity: Activity
    public var confidence: Confidence
    public var startedAt: Date
}

public struct HeartbeatPayload: Codable, Sendable, Equatable {
    public var wakeReason: WakeReason
    public var appState: String            // "active" | "background"
    public var appVersion: String
    public var build: String
    public var provisioningExpiresAt: Date?
    public var os: String
    public var lowPowerMode: Bool
    public var backgroundRefresh: String   // "available" | "denied" | "restricted"
    public var permissions: [String: String]
    public var geofenceDiagnostics: [String]
    public var signals: [SignalID: Bool]
    public var paused: Bool
    public var pausedUntil: Date?
    public var queueDepth: Int
    public var lastAckAt: Date?
    public var lastServerTime: Date?
}

public enum SignalPayload: Sendable, Equatable {
    case heartbeat(HeartbeatPayload)
    case geofence(GeofencePayload)
    case power(PowerPayload)
    case focus(FocusPayload)
    case alarm(AlarmPayload)
    case network(NetworkPayload)
    case motion(MotionPayload)
}

/// What a source hands to the hub. `observedAt` is the time of the observation.
public struct EventDraft: Sendable, Equatable {
    public var kind: SignalKind
    public var observedAt: Date
    public var payload: SignalPayload
    /// Payload bytes used for "unchanged" suppression; excludes volatile fields.
    public var dedupeKey: Data?
}

/// One event on the wire. `payload` encodes the associated value only.
public struct ObservationEvent: Encodable, Sendable, Equatable {
    public var id: UUID
    public var seq: UInt64
    public var observedAt: Date
    public var kind: SignalKind
    public var payload: SignalPayload

    public func encode(to encoder: Encoder) throws {
        // Encodes id, seq, observedAt (ISO 8601 with fractional seconds), kind,
        // and the associated payload value under "payload". Elided in this sketch.
        fatalError("sketch")
    }
}

public struct ObservationBatch: Encodable, Sendable {
    public var deviceId: String
    public var batchId: UUID
    public var events: [ObservationEvent]
}

public struct ObservationResponse: Decodable, Sendable {
    public struct Rejection: Decodable, Sendable { public var id: UUID; public var error: String }
    public var accepted: [UUID]
    public var duplicate: [UUID]
    public var rejected: [Rejection]
    public var highestSeq: UInt64?
}

// MARK: - Transport

public enum TransportError: Error, Sendable {
    case unauthorized                          // 401: stop, re-pair
    case rateLimited(retryAfter: Duration)     // 429
    case invalid(status: Int)                  // 400/413/415: split or reject
    case server(status: Int)                   // 5xx: retry
    case network(URLError.Code)                // offline, timeout: retry
}

public protocol ObservationTransport: Sendable {
    func post(_ batch: ObservationBatch, deadline: ContinuousClock.Instant?) async throws(TransportError)
        -> ObservationResponse
}

// MARK: - Event queue

public enum QueuedState: String, Codable, Sendable { case pending, inFlight, acked, rejected, expired }

public struct QueuedEvent: Sendable, Equatable {
    public var event: ObservationEvent
    public var state: QueuedState
    public var batchId: UUID?
    public var attempts: Int
    public var nextAttemptAt: Date
    public var lastError: String?
}

public struct PendingBatch: Sendable {
    public var batchId: UUID
    public var events: [ObservationEvent]
    public var isResend: Bool
}

public struct RetryPolicy: Sendable {
    public var delays: [Duration] = [.seconds(2), .seconds(5), .seconds(15), .seconds(60), .seconds(300), .seconds(900)]
    public var jitter: ClosedRange<Double> = 0...1     // full jitter
    public var maxEventAge: Duration = .seconds(24 * 3600)
    public var maxRows = 2_000
    public var maxBatchEvents = 50
    public var maxBatchBytes = 64 * 1024
}

/// Persistence underneath `EventQueue`; SQLite in the app, in-memory in tests.
public protocol EventStore: Sendable {
    func allocateSeqAndInsert(_ draft: EventDraft, id: UUID, enqueuedAt: Date) async throws -> QueuedEvent
    func latestPending(kind: SignalKind) async throws -> QueuedEvent?
    func lastEnqueued(kind: SignalKind) async throws -> QueuedEvent?
    func replacePayload(id: UUID, with draft: EventDraft) async throws
    func openBatch() async throws -> PendingBatch?
    func formBatch(readyBefore: Date, maxEvents: Int, maxBytes: Int) async throws -> PendingBatch?
    func mark(_ ids: [UUID], _ state: QueuedState, error: String?) async throws
    func reschedule(batchId: UUID, nextAttemptAt: Date, error: String) async throws
    func splitBatch(_ batchId: UUID) async throws
    func purge(kinds: Set<SignalKind>) async throws
    func expire(olderThan: Date) async throws -> Int
    func recent(limit: Int) async throws -> [QueuedEvent]
    func depth() async throws -> Int
    func reset() async throws                   // new pairing: drop everything, seq restarts
}

public actor EventQueue {
    private let store: any EventStore
    private let clock: any SignalClock
    private let policy: RetryPolicy

    public init(store: any EventStore, clock: any SignalClock, policy: RetryPolicy = .init()) {
        self.store = store; self.clock = clock; self.policy = policy
    }

    /// Durable before return. Returns nil when suppressed as unchanged.
    public func append(_ draft: EventDraft) async throws -> QueuedEvent? { nil /* sketch */ }
    /// Resends an open in-flight batch first (same batchId, same ids).
    public func nextBatch() async throws -> PendingBatch? { nil /* sketch */ }
    public func record(_ response: ObservationResponse, for batch: PendingBatch) async throws {}
    public func record(_ error: TransportError, for batch: PendingBatch) async throws -> Duration? { nil }
    public func purge(signal: SignalID) async throws {}
    public func recent(limit: Int = 200) async throws -> [QueuedEvent] { [] }
}

// MARK: - Sources and hub

/// One per signal. Sources never talk to the network; they only emit drafts.
public protocol SignalSource: AnyObject, Sendable {
    var id: SignalID { get }
    /// Begin observing; called at launch for enabled signals and on toggle-on.
    func start(emit: @escaping @Sendable (EventDraft) async -> Void) async
    func stop() async
    /// Fresh reading on a wake (power, network, motion); nil if nothing to report.
    func snapshot(reason: WakeReason) async -> EventDraft?
    func permission() async -> PermissionStatus
}

public enum PermissionStatus: String, Codable, Sendable {
    case notDetermined, granted, limited, denied, restricted, notApplicable, needsShortcut, needsFilter
}

public enum FlushTrigger: Sendable {
    case enqueue(SignalKind), wake(WakeReason), reachabilityChanged, manual
}

public struct FlushOutcome: Sendable {
    public var sent: Int
    public var remaining: Int
    public var stoppedBecause: StopReason
    public enum StopReason: Sendable { case empty, deadline, retryLater(Duration), unauthorized }
}

public actor SignalHub {
    private let queue: EventQueue
    private let transport: any ObservationTransport
    private let runner: any BackgroundRunner
    private let clock: any SignalClock
    private var sources: [SignalID: any SignalSource] = [:]
    private var enabled: Set<SignalID>
    private var pausedUntil: Date?
    private var flushInProgress = false

    public init(queue: EventQueue, transport: any ObservationTransport, runner: any BackgroundRunner,
                clock: any SignalClock, enabled: Set<SignalID>) {
        self.queue = queue; self.transport = transport; self.runner = runner
        self.clock = clock; self.enabled = enabled
    }

    public func register(_ source: any SignalSource) {}
    /// Called first thing in didFinishLaunching and on every wake path.
    public func handleWake(_ reason: WakeReason) async {}
    public func ingest(_ draft: EventDraft) async {}
    public func setEnabled(_ on: Bool, for signal: SignalID) async {}
    public func pause(until: Date?) async {}
    @discardableResult
    public func flush(_ trigger: FlushTrigger) async -> FlushOutcome {
        FlushOutcome(sent: 0, remaining: 0, stoppedBecause: .empty)
    }
}

// MARK: - Geofence

public struct HomeRegion: Codable, Sendable, Equatable {
    public var id: String                  // "home", "approach"
    public var center: CLLocationCoordinate2D
    public var radiusMeters: Double        // ≥ 150 for "home"
}

extension CLLocationCoordinate2D: @retroactive Codable, @retroactive Equatable {
    // Sketch: encode latitude/longitude; equality on both. Stored only on the
    // phone; coordinates are never sent.
    public init(from decoder: Decoder) throws { fatalError("sketch") }
    public func encode(to encoder: Encoder) throws {}
    public static func == (a: Self, b: Self) -> Bool { a.latitude == b.latitude && a.longitude == b.longitude }
}

/// Abstraction over CLMonitor so the mapping logic is testable in the Simulator.
public struct GeofenceSystemEvent: Sendable, Equatable {
    public enum State: Sendable { case satisfied, unsatisfied, unknown, unmonitored }
    public var identifier: String
    public var state: State
    public var date: Date
    public var diagnostics: Set<String>    // "insufficientlyInUse", "accuracyLimited", …
}

public protocol GeofenceSystem: Sendable {
    func add(_ region: HomeRegion) async
    func remove(id: String) async
    func identifiers() async -> [String]
    func events() async -> AsyncStream<GeofenceSystemEvent>
}

/// Production `GeofenceSystem`: `await CLMonitor("lugn.geofence")` plus a held
/// `CLServiceSession(authorization: .always)`; maps `CLMonitor.Event` 1:1.
public actor CoreLocationGeofenceSystem: GeofenceSystem {
    public init() {}
    public func add(_ region: HomeRegion) async {}
    public func remove(id: String) async {}
    public func identifiers() async -> [String] { [] }
    public func events() async -> AsyncStream<GeofenceSystemEvent> { AsyncStream { $0.finish() } }
}

public protocol GeofenceStateStore: Sendable {
    func lastReported(_ id: String) async -> GeofenceSystemEvent.State?
    func setLastReported(_ id: String, _ state: GeofenceSystemEvent.State) async
    func markAwaitingInitial(_ id: String) async
    func takeAwaitingInitial(_ id: String) async -> Bool
}

public actor GeofenceMonitor: SignalSource {
    public nonisolated let id: SignalID = .geofence
    private let system: any GeofenceSystem
    private let state: any GeofenceStateStore
    private var regions: [String: HomeRegion]
    private var task: Task<Void, Never>?
    private var lastDiagnostics: Set<String> = []

    public init(system: any GeofenceSystem, state: any GeofenceStateStore, regions: [HomeRegion]) {
        self.system = system; self.state = state
        self.regions = Dictionary(uniqueKeysWithValues: regions.map { ($0.id, $0) })
    }

    /// Recreates the monitor (same name) and iterates events for the process lifetime.
    public func start(emit: @escaping @Sendable (EventDraft) async -> Void) async {}
    public func stop() async {}
    public func snapshot(reason: WakeReason) async -> EventDraft? { nil }  // edges only
    public func permission() async -> PermissionStatus { .notDetermined }

    /// Replace regions: remove first, then add (HA orders removals before additions).
    public func update(regions: [HomeRegion]) async {}
    public func diagnostics() -> Set<String> { lastDiagnostics }

    /// Pure mapping, unit-tested: drops unknown/unmonitored and unchanged states,
    /// and flags the first event after `add` as `initial`.
    static func draft(for event: GeofenceSystemEvent, region: HomeRegion,
                      lastReported: GeofenceSystemEvent.State?, isInitial: Bool) -> EventDraft? {
        nil /* sketch */
    }
}
```

---

## 8. Top lessons from Home Assistant's implementation

1. **Make the event durable and claim background time before doing anything
   async.** HA starts its background task "before any asynchronous work (like
   fetching the current SSID)" (`ZoneManager.perform`). Its worst open
   reliability issue (#6127, iOS 27.0.1) is region wakes running out of time
   (`BackgroundTaskError.outOfTime`) before anything is sent.
2. **Don't spend the wake on a GPS fix.** HA's one-shot location after every
   region event (up to 20 s) is what competes for the window. Lugn sends
   only the condition id and state, with no coordinates.
3. **Order by a counter, not a clock.** HA numbers reads (`readOrdering`)
   because overlapping runs finish out of order and `Date` moves backwards
   when the clock is corrected. Use `seq` for order and `observedAt` only for
   meaning.
4. **Snapshots are latest-wins; edges are not.** HA replaces in-flight
   location and sensor requests with newer ones ("recency should always
   win"). Copy that for heartbeat, network and motion, and keep every
   geofence and Focus edge.
5. **Retry on a schedule that respects suspension.** HA retries at
   15/60/120/300/900 s, holds the process alive only for waits ≤ 30 s, and
   lets the next wake carry later retries. It also numbers updates so an old
   success cannot cancel a newer failure's retry.
6. **Log every ignore with a reason, and show the wake trigger.**
   `ZoneManagerIgnoreReason`, the client event log and
   `sensor.last_update_trigger` are how HA users and maintainers diagnose
   every location bug. The transparency view and the heartbeat's
   `wakeReason` serve the same purpose for us.
7. **Small or noisy regions and transient reads lie.** Use ≥ 100–150 m
   radii, drop `.unknown` states, and treat the initial determination as
   special. Don't believe a single empty network read (HA's 60 s roam
   grace). Switching Focus emits a transient "off": debounce it on the
   server.
8. **iOS permissions drift, and the app must notice.** iOS 26 silently
   flipped "Always" to "Ask Next Time" (#3822), and apps can't re-prompt
   freely. Check on every wake, report it, and show a precise fix-it banner.
   Bonus: HA refreshes network information inside freshly launched
   extension and intent processes before choosing a URL. A newly woken
   process has no cached state.

## 9. Open questions

- **Server.** Persisted id dedupe window, response shape (§3.3), body-size
  limit for this route, and whether `alarm.fired` should be a ninth kind.
  The server should also own the Focus-switch debounce and geofence
  hysteresis.
- **Product.** Should Lugn **set** the wake alarm through AlarmKit from the
  Godnatt plan? That reverses the data flow.
- **Device facts to measure.** Everything marked **[Unverified]**, above all:
  force-quit relaunch on the current iOS, CLMonitor in the Simulator,
  Tailscale in background transfers, `NWPathMonitor` with the VPN up, the
  Shortcuts "Hämta alla alarm" action, Focus filters on scheduled Sleep, and
  AlarmKit on a free team.

## Sources

- Home Assistant iOS source: `Sources/App/ZoneManager/*`,
  `Sources/Shared/Location/LocationTrigger.swift`,
  `Sources/Shared/Location/CLLocationManager+OneShotLocation.swift`,
  `Sources/Shared/API/Webhook/Networking/WebhookManager.swift`,
  `URLSessionTask+WebhookPersisted.swift`,
  `Sources/Shared/API/Webhook/Sensors/{SensorContainer,SensorUpdateRetry,BatterySensor,ActivitySensor,FocusSensor,LastUpdateSensor}.swift`,
  `Sources/Shared/Intents/FocusStatusIntentHandler.swift`,
  `Sources/App/Settings/Focus/FocusNameFocusFilterAppIntent.swift`,
  `Sources/Shared/Environment/{ConnectivityWrapper,FocusReport}.swift`,
  `Sources/App/{BackgroundRefreshManager,LifecycleManager,AppDelegate}.swift`,
  `Sources/App/Notifications/NotificationManagerLocalPushInterfaceExtension.swift`,
  `Configuration/Entitlements/App-ios.entitlements`,
  `Sources/App/Resources/{Info.plist,en.lproj/Localizable.strings}`:
  https://github.com/home-assistant/ios
- HA companion docs (location, sensors, Local Push):
  https://github.com/home-assistant/companion.home-assistant
- HA issues: #6127 (background updates only after opening the app,
  iOS 27), #3822 (iOS 26 permission flip), #3195, #1825, #661, #784, #1520,
  #1627.
- Apple: CLMonitor, CLMonitor.Event, CLServiceSession, CLBackgroundActivitySession,
  "Monitoring the user's proximity to geographic regions", "Handling location
  updates in the background", `startMonitoringSignificantLocationChanges()`,
  `startMonitoring(for:)` (deprecated iOS 27.3), BGAppRefreshTask,
  BGProcessingTask, "Choosing background strategies for your app",
  SetFocusFilterIntent / Focus, INFocusStatusCenter, "Handling communication
  notifications and Focus status updates", AlarmKit / AlarmManager /
  "Scheduling an alarm with AlarmKit", supported capabilities (iOS) and
  compare memberships: https://developer.apple.com/documentation and
  https://developer.apple.com/help/account/reference/supported-capabilities-ios
- Apple Developer Forums threads 818908 (Apple engineer: region monitoring
  relaunches after force-quit, 100–500 m minimum radius), 826964 (iOS 26.4.2:
  no relaunch after force-quit), 701377, 848531, and the Focus-status
  entitlement thread 682143.
