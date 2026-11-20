# Door node

The door node is a Seeed XIAO ESP32-S3 Sense (ESP32-S3R8, 8 MB flash, 8 MB
octal PSRAM, DVP camera, PDM microphone) aimed at the room door. It is a
**sensor head**. It never switches lights or music itself. It provides three
inputs:

1. **Presence evidence.** Camera frames of the door area, as a second,
   independent view next to the STL27L lidar.
2. **Voice.** An on-device wake word. The following utterance streams to the
   door bridge, which turns a small Swedish command grammar into ordinary Lugn
   capability calls. Replies play on BrunoCAM's speakers.
3. **Room sound.** Broadband and octave-band levels once per second. They
   build the data set for a future adaptive music volume.

Priorities, in order: correct presence, a node that keeps working and can
always be updated remotely, then features.

```text
            ┌──────────── door node (ESP32-S3, ESPHome) ────────────┐
 mic ──PDM──┤ micro_wake_word ─► voice_assistant (API audio)        │
            │ sound_level / audio_bands (1 Hz numbers)              │
 camera ────┤ esp32_camera (VGA JPEG, ≤2 fps, on demand)            │
            └──────────── encrypted ESPHome native API :6053 ───────┘
                                     │  (one client owns voice)
                         ┌───────────▼────────────┐   HTTP, optional, failover
                         │ door bridge (BrunoCAM) ├──────────► STT worker(s)
                         │ endpointing, grammar,  │            (desktop PC, other)
                         │ earcons (aplay),       │
                         │ feature logger         │
                         └───┬───────────────┬────┘
              loopback HTTP  │               │ JSONL data set
           capability calls  ▼               ▼
                           Lugn        local state dir
```

## Firmware

The firmware is [ESPHome](https://esphome.io) (pinned `min_version`), built
from `agents/esp32-door/`. ESPHome was chosen over a hand-written ESP-IDF
image because remote updates must be dependable:

- **Encrypted OTA.** The ESPHome OTA v2 upload is authenticated and encrypted
  with the API key. The web server offers a second OTA path.
- **Rollback.** `enable_ota_rollback` is on. A new image that resets before
  it has run 60 s is rolled back by the bootloader. This already happened
  once during bring-up: an image that hung in camera probing rolled back on
  its own, and the node stayed reachable.
- **Safe mode.** Five boots in a row that never reach "good" start a minimal
  image (WiFi, API, OTA) for 10 minutes.
- **Fallback access point.** After 3 minutes without WiFi the node opens
  `Lugn-Door-Fallback` with a captive portal. The node never reboots only
  because no client is connected (`api.reboot_timeout: 0s`), so the wake word
  and sound levels keep running when consumers are down.
- **USB recovery.** The full factory flash (8 MB) was saved before the first
  install and can be written back over USB.

The node must **not** be adopted by Home Assistant. Only one API client can
own the voice pipeline. Home Assistant subscribes to it automatically when it
adopts a device, and would take it from the bridge. Home Assistant cannot
adopt the node without the API key.

### Hardware findings (2026-11-20)

- **Camera.** At first it did not answer on SCCB (I²C); every probe address
  timed out until the module was reseated in its connector. Without a camera,
  probing blocked setup past the 5 s task watchdog, and after five boots the
  node fell into safe mode. The watchdog is now 15 s, so a missing camera only
  fails its own component. `door-node-no-camera.yaml` leaves the camera out.
  With the module seated, the sensor's colour-bar test pattern
  (`camera-test-pattern.yaml`) arrived intact. That separates data-path faults
  from optical ones: the first all-black frames were optical. The 2X default
  gain ceiling left a dim room black, so the ceiling is 16X with the second
  auto-exposure stage on.
- **Heat.** The die read 87 °C after boot and 94 °C with the wake word
  running, on a desk in open air. Light modem sleep brought it to 79–81 °C.
  A lower transmit power (11 dB instead of 19.5 dB) made no measurable
  difference, but it is kept: the AP is received at about −40 dBm. The camera
  adds heat, and the board has no camera power-down pin. Plan for a heatsink
  and a ventilated mount, and watch the `Chiptemperatur` sensor. Light modem
  sleep delays packets sent _to_ the node by up to a beacon interval (pings
  of 100–300 ms); audio from the node is not affected.
- **Microphone.** PDM on GPIO42 (clock) and GPIO41 (data), left channel. The
  right channel is silent.

## Presence: how the camera may influence the count

The lidar stays the primary source. The camera exists to make presence **more
correct**, and a second sensor makes presence worse if it is trusted before it
has been measured. Rollout is therefore staged, and each stage has to be
justified by data before the next one starts:

1. **Evidence only.** The bridge (or the sensor process) grabs frames when the
   lidar reports door activity, plus a slow background rate. The result is
   journaled next to the lidar's own door journal (`recordings/journal/` in
   stl27-presence). Nothing changes the count. This answers whether the camera
   sees the passages the lidar misses (`unexplained_crossing`,
   `episodes_dropped_untrusted`) and how often it is wrong.
2. **Measured.** Compare camera events against corrections and reports from
   the flight recorder, per lighting condition (day, lamp light, dark). The
   OV2640 has no IR, so darkness is a known blind spot. The camera may only
   ever be one input among several.
3. **Fusion in the sensor.** Perception belongs to the sensor side
   (see [Presence](PRESENCE.md#stl27l-role)). If stage 2 shows value, the camera
   resolves specific lidar uncertainty, for example an AMBIGUOUS passage or a
   suspected missed exit. It does not run a second, independent counter.
   Lugn keeps consuming one normalized occupancy stream, and `unknown` stays
   `unknown`.

Detector placement follows from the CPU budget. BrunoCAM's lidar pipeline must
not be starved, so the Pi never runs a person detector continuously. Detection
runs only on door events, at ≤1 fps, or on a stronger host. No stage depends on
a desktop PC being on.

Mounting: aim at the threshold from the side or from above, so that the
direction of passage is visible and the window is not in view (backlight).

## Voice

- **Wake word on the node.** micro_wake_word with its VAD model and the stock
  "Okay Nabu" model, the one micro_wake_word is developed and tuned around.
  No Swedish model exists. A custom "Hej …" model would need recordings of
  the household's own voices, because the only Swedish synthetic voices are
  single-speaker, so a stock model is the reliable choice. The `Wake word`
  switch turns listening off.
- **Bridge on BrunoCAM** (`agents/door-bridge/`). It owns the run. It decides
  where the utterance ends, sends audio to a speech-to-text worker, matches a
  deterministic Swedish grammar and calls Lugn's loopback capability API, the
  same API every other client uses (no second control plane). It plays a short
  confirmation or error sound through `aplay` and ends every run with
  `RUN_END`, also on timeouts and disconnects.
- **Speech-to-text is optional compute.** Whisper is far too slow on a Pi 3B,
  and the published Swedish Vosk model cannot be restricted to a grammar on
  905 MB. The worker (faster-whisper with KBLab's Swedish kb-whisper) runs on a
  stronger host, such as a desktop PC. The bridge fails over between workers with short
  timeouts. When none answers, it plays the error sound and does nothing.
- **Precision over recall.** A wrong action ("släck" heard as "tänd") is worse
  than a miss. Unknown, negated or low-confidence transcripts never act.

## Adaptive volume data set

Goal: learn what music volume is right for the current room situation, then
propose or apply it as one more input to Lugn's volume policy (see
[Music](MUSIC.md#volume-policy)).

The data comes first. Once per second the bridge writes one versioned JSONL
row with:

- The node's sound features: RMS and peak level, A-weighted level, octave
  bands from 63 Hz to 8 kHz, and spectral flatness.
- Lugn context: occupancy and count, home or away, and for each player its
  volume, mute state, source or preset, playing state and Auto/Manual
  authority.

Every volume stage that can be read is logged on its own (source volume,
player or amplifier volume, optical offset) rather than as one product. The
model then learns how combinations of stages sound in the room. Human volume
changes are the labels.

Training happens offline on a stronger host. A model must beat the current
curve on held-out days before it may influence volume. Continuous learning
means periodic retraining behind that gate, not unobserved online drift.
Inference is small and runs on BrunoCAM.

Privacy: the node sends only numbers for this data set. Audio leaves the node
only after the wake word, and only to the bridge.

## Operations

See `agents/esp32-door/README.md` for building, updating, recovery and
the entity list.
