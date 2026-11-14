# Govee live transport benchmark

The live harness runs on BrunoCAM, where Home Assistant and the Govee devices
are reachable. It loads the configuration and compiled transports from the
selected Lugn release. Copy this script to the host separately if that release
does not contain it:

    install -m 0700 scripts/benchmark-govee.mjs /home/bruno/.cache/benchmark-govee.mjs

Preview targets and sample counts first. Without the --execute flag, the script
only loads configuration and prints a plan:

    node --env-file=/home/bruno/.config/lugn/lugn.env --env-file=/home/bruno/.config/lugn/govee-platform.env /home/bruno/.cache/benchmark-govee.mjs --release /home/bruno/lugn-govee-<release> --config /home/bruno/.config/lugn/config-lugn2-test-91335a4.json --bridge /home/bruno/.config/lugn/govee-effects.json --phase effects --samples 6 --out /home/bruno/.cache/govee-effects.json

Add the --execute flag only after checking the plan. The effects phase requires
the Govee companion running. It alternates Forest and Aurora through the
companion selector (or a second distinct app effect when Aurora is unavailable),
after taking a session-only Lugn lease and dimming the selected target to 10%.
Keep the tested target's selector unused during the run: the
legacy MQTT result has no unique request ID, so a concurrent selection cannot
be unambiguously matched. Retained and stale results are ignored. The harness
tracks the current lease ID after each matching result and restores only while
it still owns that lease.

Effect timing ends when the companion reports udp_sent or cloud_accepted.
This confirms command delivery/acceptance only; it does not confirm that the
visible animation started or that individual zones changed.

The static phase requires the Govee companion stopped. Before sending any light
command, the harness exclusively binds UDP port 4002 to check that the LAN
transport can own it, closes that probe socket, then starts the compiled LAN
transport. Lugn itself remains running. The phase compares direct LAN
brightness, Home Assistant REST, a warm Home Assistant WebSocket when
connected, and Govee Platform brightness when configured. Each method
alternates 10% and 11%. All methods on LAN fixtures use the same independent
UDP devStatus brightness readback. GU10 has no LAN readback, so its methods
use Home Assistant state feedback, which is software state rather than
independent hardware confirmation.

Command acknowledgement and feedback have separate timings. LAN acknowledgement
is the local UDP send callback, MQTT acknowledgement is the local QoS 0 publish
callback, and REST/WebSocket/Platform acknowledgements are their service/API
responses. These do not by themselves prove the lamp changed. guardMs records
the lease ownership check separately from dispatch latency.

H60A6 zone state is absent from current feedback. The target is skipped unless
the --baseline flag explicitly supplies a zone mask whose two zones match each
other and the whole-fixture power state. This avoids changing an unknown
ring-only or main-only state. Example, with the object key replaced by the
target's bridge device ID:

    {
      "ceiling": {
        "status": {
          "onOff": 0,
          "brightness": 40,
          "color": { "r": 255, "g": 220, "b": 180 },
          "colorTemInKelvin": 4000
        },
        "zones": { "main": false, "ring": false }
      }
    }

The harness reapplies captured brightness and color while its lease is owned,
then ends that expected lease so Lugn can restore the original power intent.
An initially off Matter light may normalize brightness when it turns off, so
the artifact's restored marker does not guarantee those brightness fields are
unchanged. A user takeover wins; in that case the harness leaves the target
alone. It never applies a room-wide scene or turns off other lights.

The JSON artifact is written mode 0600. It includes every sample, including
failures and timeouts, plus per-method counts and acknowledgement/feedback
p50, p95 and maximums. Credentials, authorization headers and raw error bodies
are omitted. The --samples value is bounded to 1–30 (default 6).

Run node scripts/benchmark-govee.mjs --self-check for host-only argument and
summary helper checks. No hardware activity is performed by this check.

## Comparable operations and limits

`--operation temperature` is the static default. It alternates 3000/4000 K and
allows 50 K of mired rounding. `--operation brightness` tests 10/11% with explicit
8-bit HA brightness values. Percent conversion can still differ by model; the
artifact retains any mismatched native readbacks rather than counting HA
acceptance as convergence. Every trial records its pre-read and chooses a target
different from that value. All methods start from a verified ON condition outside
the measured interval. Independent UDP feedback is used for every control method
on a LAN fixture. GU10 uses HA software feedback and is reported separately.

The 120 ms feedback polling interval contributes quantization to convergence
latency: this is an upper bound on observing matching device-reported state, not
an optical LED-on timestamp. UDP send, HA service acknowledgement and Govee cloud
acceptance are distinct outcomes. Effects have no active-scene readback, so the
effects benchmark measures delivery diagnostics only.

Legacy cloud diagnostics lack an effect/request ID; matching relies on a fresh
timestamp under exclusive selector use. A confirmed exit revokes permission for
further positive benchmark writes and positive restoration, while cleanup may
still release its expected logical lease. Matter OFF may normalize a fixture's
stored master level; the harness restores known settings before handback and
reports restoration separately from command delivery.
