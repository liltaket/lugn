# Door node firmware

ESPHome firmware for Lugn's door node, a Seeed XIAO ESP32-S3 Sense aimed at
the room door. Design and rollout: [docs/DOOR-NODE.md](../../docs/DOOR-NODE.md).

| File                     | Contents                                                                     |
| ------------------------ | ---------------------------------------------------------------------------- |
| `door-node.yaml`         | Full image: base + camera + audio + voice                                    |
| `mic-test.yaml`          | Bring-up image without the camera (used while the camera is absent)          |
| `packages/base.yaml`     | Board, PSRAM, WiFi + fallback AP, API, OTA, safe mode, diagnostics           |
| `packages/camera.yaml`   | OV2640/OV3660 camera, VGA JPEG, ≤2 fps, snapshot server on :8081             |
| `packages/audio.yaml`    | PDM microphone, sound levels                                                 |
| `packages/voice.yaml`    | micro_wake_word ("Okay Nabu") + voice_assistant                              |
| `tools/probe.py`         | Prints device info and live states over the encrypted API                    |
| `tools/capture.py`       | Records microphone audio to a WAV file through the `start_listening` action  |
| `tools/listen.py`        | Starts one voice run without the wake word (push-to-talk) for the bridge     |
| `components/audio_bands` | Octave band levels, A-weighted level and spectral flatness (host-tested DSP) |
| `audio-bands-test.yaml`  | Compile check for `audio_bands` under a separate node name                   |
| `secrets.example.yaml`   | Keys that `secrets.yaml` must define                                         |

## Setup

```sh
python3 -m venv ~/.local/share/esphome-venv
~/.local/share/esphome-venv/bin/pip install "esphome==2026.11.0"
cp secrets.example.yaml secrets.yaml   # then fill in; never commit it
```

Keep the real file outside the checkout (for example a mode-600 file that
`secrets.yaml` symlinks to), so a fresh worktree cannot lose it. Generate the API key with
`python3 -c "import base64,os;print(base64.b64encode(os.urandom(32)).decode())"`.
Rotating the key requires one install that knows both keys. Use `old_key`
under `ota: encryption:`.

## Update over WiFi (normal path)

```sh
cd agents/esp32-door
~/.local/share/esphome-venv/bin/esphome run door-node.yaml --device lugn-door.local --no-logs
~/.local/share/esphome-venv/bin/esphome logs door-node.yaml --device lugn-door.local
```

After an update, wait about 70 s and check that `ESPHome-version` shows the
new build time and that `Senaste omstartsorsak` is `Reboot request from
esphome.ota`. An image that resets before it has run 60 s is rolled back to
the previous one. The log then shows `OTA rollback detected` and the old
build time. So "OTA successful" alone does not prove the new image runs.

## Recovery ladder

1. OTA as above, or upload `firmware.ota.bin` at `http://lugn-door.local/`.
2. **Safe mode**: the `Starta om i safe mode` button. After five failed boots
   in a row the node enters safe mode by itself. Only WiFi, API and OTA run,
   so a working image can be uploaded.
3. **Fallback AP**: with no WiFi for 3 minutes, join `Lugn-Door-Fallback`
   (password `fallback_ap_password`) and open `http://192.168.4.1/`. There
   you can set WiFi credentials or upload an image.
4. **USB**: hold BOOT while plugging in if the chip does not enumerate. Then
   run `esphome upload door-node.yaml --device /dev/ttyACM0`; the user needs
   the `dialout` group. Before the first install, save the factory image with
   `esptool.py --port /dev/ttyACM0 read_flash 0 0x800000 factory.bin`; it can
   be restored with `esptool.py --port /dev/ttyACM0 write_flash 0 factory.bin`.

## Entities

Diagnostics: `Status`, `Drifttid`, `WiFi-signal`, `Chiptemperatur`,
`Ledigt heap-minne`, `Ledigt PSRAM`, `Senaste omstartsorsak`, `IP-adress`,
`WiFi BSSID` and `ESPHome-version`.

Controls: `Starta om`, `Starta om i safe mode` and `Statuslampa`. The
statuslampa (GPIO21) is also lit while the node listens after the wake word.

Audio, once per second: `Ljudnivå RMS` and `Ljudnivå topp` (dBFS), and from
`audio_bands` `Ljudnivå A-vägd`, `Band 63 Hz` … `Band 8000 Hz` and
`Spektral platthet`. Voice:
`Wake word` (privacy switch, on by default) and `Senaste wake word`. Camera:
`Dörrkamera`, with snapshots on `http://lugn-door.local:8081/`.

The node is not added to Home Assistant; see the design document for why.
