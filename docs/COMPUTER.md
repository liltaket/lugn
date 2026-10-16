# Computer observations

Lugn optionally consumes the Linux Desktop Agent MQTT v1 protocol. Configure
both services with the same broker, topic prefix and unique device ID. The
canonical wire schemas and fixtures are maintained with the Linux agent under
`agents/linux/protocol/` in the companion agent PR. Lugn's deterministic tests
include copies of its examples under `tests/fixtures/computer-mqtt/`.

## Configuration

Add `computers` to the existing `mqtt` configuration. Credentials still come
from `usernameEnv` and `passwordEnv`; all adapters share the MQTT subscriber.
Existing STL27L settings remain in the same `mqtt` object.

```json
{
  "computers": [
    {
      "deviceId": "desktop",
      "baseTopic": "lugn/computers",
      "maxAgeMs": 90000
    }
  ]
}
```

The default is an empty list, which disables computer integration. Device IDs
must be unique, 1–64 ASCII letters, digits, underscores or hyphens, starting
with a letter or digit. Prefixes must be concrete topics without MQTT wildcards.
`maxAgeMs` is 1000–300000 milliseconds, default 90000. Set it comfortably above
the agent heartbeat interval (default 30000 ms); for example, three intervals.
Lugn's existing MQTT presence subscription is unchanged.

Each computer subscribes at QoS 1 to:

- `{baseTopic}/{deviceId}/state`: complete, retained v1 JSON snapshots.
- `{baseTopic}/{deviceId}/availability`: retained v1 JSON online/offline, including Last Will.
- `{baseTopic}/{deviceId}/events`: non-retained v1 JSON `state_changed` notifications.

There is no computer command topic, control capability or automation policy.

## Liveness and recovery

The adapter validates device identity, version, UUID session, safe-integer
sequence/timestamp, nested fields and bounds before normalizing a snapshot.
Payloads are limited to 256 KiB, strings to 512 JavaScript code units, media
players/artists to 64, and audio application/role lists to 128. The Linux producer
uses equal or tighter UTF-8 byte and aggregate metadata bounds. Additional v1
fields are ignored; unsupported versions and malformed snapshots invalidate
current readings. Malformed event notifications are ignored.

Online requires all of the following:

- the broker connection is active;
- online availability matches the snapshot's process session;
- a live, non-retained snapshot has arrived since the last disconnect/offline;
- its source timestamp is younger than `maxAgeMs` and at most 5 seconds ahead;
- its sequence advances within that session.

Availability and state may arrive in either order. Retained availability is
accepted; retained state is only a cache and never establishes liveness. After
a broker reconnect, the dashboard can remain unknown until the next live
heartbeat. QoS duplicates and out-of-order state do not extend freshness.
Freshness expires using monotonic elapsed time, bounded by source timestamp age
at receipt, so wall-clock changes after receipt cannot prolong a snapshot.

Offline availability immediately clears readings. Broker loss, expired,
malformed or missing data produces unknown readings; none means unlocked,
inactive, silent or physically absent. A new online session replaces the old
session; delayed offline/state/events from recent retired sessions are ignored.
Deduplication and retired-session history are bounded to 64 sessions per device.
Events are validated and deduplicated separately, exposed as `lastEvent` with
source/receipt timestamps, and never change readings or refresh liveness.

## State and dashboard

`state.computer.devices[deviceId]` appears in existing state snapshots, HTTP
state endpoints, operational overview/SSE, and resumable `computer` stream
patches. Each observation contains availability, freshness/reason, timestamps,
session/sequence, desktop readings, advisory activity and the last live change
notification. Computer readings are ephemeral and are not restored as intent.

Readings include NetworkManager connectivity, lock state, idle state, active
application, fullscreen, PipeWire playback/application roles, and MPRIS player
metadata. `null` means unknown; `false` is an observed negative. `media: []`
means discovery succeeded and found no players, while `media: null` is unknown.
Network connectivity and MQTT agent availability are separate observations.
PipeWire running streams do not prove audible sound. The agent supplies idle
state, not elapsed idle seconds.

The operational dashboard shows a compact computer section only when configured,
with secondary details expandable. `Bedömd aktivitet` displays the agent's
classification separately from readings. It is advisory context, not physical
room occupancy, music-player intent or a requested automation. No computer
observation changes lighting, music, room sessions or presence.

## Validation

`tests/computer-mqtt.test.ts` covers wire examples, observation transitions,
retained packets, duplicate/out-of-order deliveries, source age and expiry,
malformed payloads, session changes, broker reconnects and non-authoritative
events. Engine/stream and composed-runtime checks cover API delivery and
observation-only behavior. Hardware and real-broker interoperability should be
verified with the companion Linux agent before marking the Draft PR ready.

## Optical now playing on Nest dashboards

Map the receiver's actual computer input to a configured MQTT computer in
`homeAssistant.music`:

```json
{
  "music.room": {
    "entityId": "media_player.room",
    "sources": ["Spotify", "Optical In"],
    "computerAudio": {
      "deviceId": "kuffe",
      "source": "Optical In"
    }
  }
}
```

The source is an exact Home Assistant observed input name. A requested Optical
preset or the receiver's title `4` does not confirm that input. Both Nest roles
receive the same `computerNowPlaying` presentation context over polling and SSE.
When the receiver is playing the mapped input and both receiver and computer
observations are trustworthy, the Hub shows the selected computer title,
artist/channel without application names or repeated source labels. Titles are
shortened to 56 characters and artist/channel to 42. Spotify DJ and
other inputs retain their receiver metadata. Playback and volume controls
continue controlling the receiver; the media projection does not rewrite
physical observations or create automation intent.

Selection only considers fresh online computer media reported as `Playing`
with a useful title. It prefers a unique active application/DesktopEntry match,
then unique application-name audio corroboration, then the most recently
observed transition into Playing, then a meaningful title/artist/album change.
Equal candidates keep the prior winner when still eligible; otherwise the
screen says multiple media are playing. There is no intrinsic video/music
preference. After a known pause/idle transition, the browser retains the last
playing title for eight seconds, labelled as last played (or paused when the
receiver explicitly reports paused). Polling does not extend this deadline; new
playing media appears immediately. Unknown/stale data, ambiguity, source changes,
and producer/server restarts clear the presentation cache immediately. A page
opened while already paused has no cached title. Physical observations and the
backend selector remain unchanged.

Heartbeats, first discovery and identity enrichment do not establish recency.
Fingerprints survive the producer's transient `media: null` refresh within a
healthy session; unknown data is hidden, and unchanged recovery is no new
track. Offline/stale data and new producer sessions rebase selection history.
Known player removal clears that player's history. These times describe changes
observed by Lugn, not actual playback-start time or transitions missed offline.

PipeWire application names can corroborate some MPRIS players but cannot
reliably distinguish browser tabs. Global `audio.playing`/roles do not identify
the sounding player, and silent Playing video remains a candidate. The v1 feed
contains no reliable audible-loudness measurement; selection does not claim to
pick the loudest stream. If no reliable title exists, or either link is stale,
the Hub shows a generic idle/unknown Optical status instead of `4` or an old song.
