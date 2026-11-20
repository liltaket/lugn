# Lugn door bridge

Host-side service for the ESP32-S3 door node (`agents/esp32-door`). It runs
next to Lugn on BrunoCAM and:

- owns the node's **voice pipeline** over one encrypted native-API connection:
  wake word on the node, end-of-speech detection here, speech-to-text on an
  optional LAN worker, a deterministic Swedish command grammar, and the action
  through **Lugn's capability API** (voice is a client of Lugn, never a second
  control plane);
- records the **adaptive-volume dataset**: one row per second with the node's
  audio levels and Lugn's room/music context.

Nothing heavy runs on the Pi: no ML, no numpy, standard-library HTTP. Measured
on x86: endpointing costs 0.7 ms CPU per second of audio; the process uses about
40 MB RSS.

```
door_bridge/
  node.py         aioesphomeapi client + ReconnectLogic, sensor cache, voice event transport
  voice.py        per-run state machine, journal
  endpointing.py  energy endpointer with hangover (audio-time, deterministic)
  intents.py      Swedish command grammar -> typed actions
  executor.py     action -> Lugn capability calls (volume cap, relative steps)
  lugn_client.py  loopback capability client (bearer, 2 s timeout)
  stt_client.py   ordered worker list, failover, cooldown, confidence gate
  earcons.py      tones synthesized at start, played with aplay
  features.py     dataset rows, Lugn context poller, daily gzip writer with retention
stt_worker/       separate HTTP service (faster-whisper, Swedish), Linux and Windows
tools/            optional dev-machine tools: Piper prompts, STT smoke test
systemd/          user unit template for BrunoCAM
```

## Install and run

Bridge (Python 3.11+):

```sh
python3 -m venv ~/.local/share/lugn-door-bridge/venv
~/.local/share/lugn-door-bridge/venv/bin/pip install -r requirements.txt
cp config.example.toml ~/.config/lugn-door-bridge/config.toml   # then edit
python -m door_bridge check --config ~/.config/lugn-door-bridge/config.toml
python -m door_bridge run   --config ~/.config/lugn-door-bridge/config.toml
```

Secrets are never inline. The node key comes from `encryption_key_file` (a file
with the bare key, or an ESPHome `secrets.yaml`, whose `api_encryption_key:` line
is read) or `encryption_key_env`. The Lugn token comes from `token_env`; as in
Lugn (`src/runtime/config.ts`), a name ending in `_B64` holds a base64url value
that is decoded first. The systemd template reads a dedicated environment file
holding only those variables.

**Only one client may own the voice pipeline.** ESPHome accepts the first voice
subscriber and only logs an error for later ones, so Home Assistant must not
adopt the node, and the bridge cannot detect being refused.

### Dry run

```sh
python -m door_bridge run --config config.toml --dry-run [--with-earcons]
```

Connects to the real node, runs the full voice path including STT and the
grammar, and journals what it _would_ call (`"planned"`), but never contacts
Lugn, not even for reads (feature rows then have `"lugn": null`). Earcons are off
in a dry run unless `--with-earcons` is given. `keep_audio = N` in `[voice]` keeps
the last N utterances as WAV files for inspection.

`python -m door_bridge parse "Tänd taklampan"` shows how a transcript maps.

### STT worker

On a stronger LAN machine (Linux or Windows; never the Pi):

```sh
python -m venv venv && venv/bin/pip install -r stt_worker/requirements.txt   # Windows: venv\Scripts\pip
python -m stt_worker --model KBLab/kb-whisper-small --host 0.0.0.0 --port 8790 --threads 4
```

`POST /v1/transcribe` takes a 16 kHz PCM16 mono WAV (at most 30 s) and returns
`{text, avg_logprob, no_speech_prob, language, duration_ms, processing_ms, queue_ms, model}`.
`GET /health` reports the model. Language is forced to `sv`; decoding is
greedy at temperature 0 and biased by an `initial_prompt` with the command
vocabulary (`--no-prompt` disables it). `--token-env NAME` requires
`Authorization: Bearer` from clients (set `[stt] token_env` in the bridge).
Requests are serialized; the model is loaded and warmed at start.

The bridge treats STT as optional: workers are tried in order with short
timeouts and an overall budget; a failed worker is skipped for
`failure_cooldown_s` while another remains. When none answers, the run ends with
the error earcon and a journal line. A transcript is acted on only when
`avg_logprob >= min_avg_logprob` and `no_speech_prob <= max_no_speech_prob`.

## Voice run

1. Node sends start (after its wake word): the bridge answers port 0 (API
   audio) and sends `RUN_START`, `STT_START`.
2. Audio is buffered and endpointed: threshold = max(`min_speech_dbfs`,
   ambient + `stream_gain_db` + `speech_margin_db`), where ambient is the quietest `Ljudnivå RMS`
   value of the last 6 s (the newest one may contain the wake word). Speech
   starts after `min_speech_ms` voiced audio; it ends after `silence_end_ms`
   (700 ms) of silence; at most `max_utterance_ms` (6 s); no speech within
   `no_speech_timeout_ms` (3 s) ends the run. `STT_VAD_START`/`STT_VAD_END` are
   sent; `STT_VAD_END` is what stops the node's microphone. When no frame run
   counts as speech but the loudest frame cleared the threshold (distant speech),
   the whole buffer still goes to STT (`weak_speech` in the journal); STT's gates
   and the grammar decide. `keep_audio` also keeps runs without speech.
3. Transcribe, gate on confidence, `STT_END`; parse, `INTENT_START`/`INTENT_END`;
   execute; earcon; `RUN_END`.

Every run is finalized exactly once (journal line, earcon, `RUN_END`) on success,
error, timeout (`run_timeout_s`, plus a stall guard on missing audio), device
stop, or exception. `RUN_END` is skipped only when the node is gone
(disconnect) or has already started a newer run (a late `RUN_END` would stop the
new one); the journal records `"run_end": {"sent": false, "skipped": ...}`.
`ERROR` precedes `RUN_END` for `stt_unavailable`, `run_timeout`, `exception` and
`lugn_failed`. No TTS events are sent: the node has no speaker.

Journal (`voice.jsonl`, one JSON object per run, rolled to `.1` at 20 MB):
`run, at, conversation_id, wake_word, dry_run, ambient_floor_dbfs, endpoint
{threshold_dbfs, audio_ms, speech_start_ms, speech_ms, end_reason, peak_dbfs},
audio_ms, stt {worker, latency_ms, processing_ms, attempts[]}, transcript,
avg_logprob, no_speech_prob, intent {normalized, reason, action}, lugn {ok,
calls[], error} | planned, outcome, run_end, ms {speech_start, vad_end, stt_end,
lugn_end, total}`.

Outcomes: `done`, `dry_run`, `no_speech`, `low_confidence`, `not_understood`,
`stt_unavailable`, `lugn_failed`, `run_timeout`, `exception`, `device_stop`,
`disconnected`, `superseded`, `shutdown`.

### Commands

The whole normalized utterance must match one pattern; there is no keyword
spotting. Normalization lowercases, strips punctuation, maps inflections
(`tända`→`tänd`) and a few observed Whisper near-homophones, and turns Swedish
number words into digits. Wake-word remnants and politeness (`okay nabu`, `hej jarvis`,
`snälla`, `kan du`, `tack`) are ignored. A negation (`inte`, `sluta`...), a
question (question word first, or `?` unless it is a `kan du ...?` request), two
commands, or more than eight words means no action and the "not understood"
earcon.

| Say                                                                    | Capability                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| tänd / släck taklampan (lampan, ljuset, taket), sätt på / stäng av ... | `lighting.set {target: ceiling, values: {power}}`                                    |
| tänd allt                                                              | `lighting.activateScene {sceneId: all_on_scene}` (default `scene.focus_light`)       |
| släck allt, helt släckt                                                | `lighting.activateScene {sceneId: "scene.all_off"}`                                  |
| mysljus, vardagsljus, fokus, filmkväll (optionally "sätt på ...")      | `scene.soft_light`, `scene.everyday_light`, `scene.focus_light`, `scene.movie_light` |
| ljusare / mörkare, mer / mindre ljus                                   | `lighting.adjust {target: ceiling, brightnessDelta: ±10}`                            |
| pausa (musiken), spela (musiken)                                       | `music.pause` / `music.play {target}`                                                |
| höj / sänk volymen (ljudet), skruva upp / ner                          | `music.getState`, then `music.setVolume` ±0.05                                       |
| volym 30 (procent), sätt volymen till trettio                          | `music.setVolume {volume: 0.30}`                                                     |

Voice never sets a volume above `max_voice_volume` (0.6): an absolute request
above it is refused, a step stops at it. Every call carries
`requestId: "voice-<run>"` and `reason: "röst: <transcript>"`.

### Earcons

`ok`, `not_understood`, `error`, `cancelled` (no speech) and an optional
`listening` tone (off: the node's mic would hear it) are synthesized at start and
piped to `aplay` (fire and forget, 4 s timeout, dropped while one is playing).
`python -m door_bridge earcons --out DIR` writes them for auditioning. For
spoken Swedish confirmations, render them on a dev machine with
`tools/render_prompts.py --voice sv_SE-nst-medium.onnx --out prompts/`
(Piper; `pip install -r tools/requirements.txt`), copy the WAVs to the Pi and
set `[earcons] prompts_dir`.

## Adaptive-volume dataset (schema v1)

Files: `<features.directory>/features-YYYY-MM-DD.jsonl.gz` (local date), one
JSON object per line. Written as a gzip stream with a sync flush every
`flush_every_s`; a restart appends a new gzip member (standard readers such as
`zcat` and Python's `gzip` read all members). Files older than `retention_days`
(30) are deleted, then the oldest until the total is below `max_total_bytes`
(2 GiB). Below `min_free_bytes` (1 GiB) free, nothing is written; the next
written row carries `"dropped": <rows skipped>`.

`kind: "catalog"` (first row of each file and whenever the node's entity list
changes): `{v, t, revision, sensors: {<key>: {name, unit, device_class}}}`.
Sensor keys are ASCII slugs of the entity names (`Ljudnivå RMS` →
`ljudniva_rms`), so new firmware sensors (A-weighted level, octave bands
63..8000 Hz, spectral flatness, later the camera) appear without a code change.

`kind: "sample"` (every `interval_s`):

| field                      | meaning                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `v`                        | schema version (1)                                                                                                                         |
| `seq`                      | row counter since start                                                                                                                    |
| `t`                        | Unix time, seconds                                                                                                                         |
| `local`, `hour`, `weekday` | local ISO time, fractional hour, Monday=0                                                                                                  |
| `node`                     | `{connected, catalog (revision), voice_active}`; rows during a voice run include the speaker's voice                                       |
| `audio`                    | `{<sensor key>: value}` for every sound sensor (unit dB/dBFS, and spectral flatness); `null` when missing or older than `sensor_max_age_s` |
| `diag`                     | the node's other sensors (temperature, WiFi signal, memory, uptime); `null` when older than 120 s                                          |
| `lugn`                     | `null` (dry run or no data yet), `{error, age_s}` when stale, otherwise the context below                                                  |
| `labels`                   | present only when something happened since the last row                                                                                    |
| `dropped`                  | rows skipped before this one (free-space floor or write error)                                                                             |

`lugn` (polled every `lugn_poll_s` with `GET /state` and `music.getPolicy` per
player, cached; `age_s` is the cache age):

- `presence`: `state` (occupied/confirmed_empty/unknown), `count` (person count),
  `exit_pending`, `home` (home/away/unknown), `session` (room session state);
- `lighting`: `scene`, `ceiling_power`, `ceiling_brightness`;
- `music.<target>`, one object per player, each volume stage kept separate:
  - observed: `availability`, `playback`, `volume` (player's 0..1 scale as
    reported), `source`, `observed_at`;
  - requested: `requested_volume`, `requested_playback`, `requested_source`,
    `preset` (spotify_dj/optical);
  - `fade`: `{status, target_volume, expected_volume}` or null;
  - `policy` (from `music.getPolicy`): `mode` (auto/manual authority),
    `activeOwner`, `lastIntentActor`, `policyEnabled`, `policyActive`,
    `activityReason`, `baseline`, `configuredBaseline`, `target` (automatic
    target), `effectiveTarget`, `manualReference`, `dailyOffset`,
    `personOffset`, `sourceOffset` (the optical correction),
    `passiveReductionActive`, `source`.

Not observable through Lugn, so not logged: the source's own level (Spotify
client volume, the optical source's digital level), amplifier gain and speaker
placement. The node's measured level is the ground truth that integrates them.

`labels[]`:

- `{type: "volume_change", target, volume, observed_at, actor, actor_id, source,
reason, attribution, user_initiated}` from `music.volumeChanges` when its
  `observedAt` changes. `user_initiated` is true for actor types `user`,
  `physical_remote` and `home_assistant`. `attribution` is Lugn's
  `correlated`/`matched`/`external`. Voice changes show `reason: "röst: ..."`.
- `{type: "decision", target, at, kind, value, owner, policy_enabled}` for each
  new entry in the player's decision history.

History that already existed when the bridge started is not emitted as labels.

## Tests

```sh
pip install -r requirements-dev.txt
python -m pytest
```

Fakes stand in for the node, the worker and Lugn (the worker HTTP tests bind
127.0.0.1 only). `tools/smoke_stt.py` renders commands with Piper, runs them
through the endpointer and a real worker, and reports transcripts, latency and
the parsed actions; it never plays audio.
