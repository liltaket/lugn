"""STT smoke test: Piper-rendered Swedish commands -> endpointer -> worker -> intents.

    python -I tools/smoke_stt.py --worker http://127.0.0.1:8790 --voice a.onnx --voice b.onnx --out clips/

Needs piper-tts and faster-whisper (for resampling) in the running interpreter.
Clips are written to --out and never played.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import random
import statistics
import sys
import time
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))

from door_bridge.audio import pcm_to_wav  # noqa: E402
from door_bridge.config import SttConfig, VoiceConfig  # noqa: E402
from door_bridge.endpointing import Endpointer  # noqa: E402
from door_bridge.intents import action_name, parse  # noqa: E402
from door_bridge.stt_client import SttClient, SttFailure  # noqa: E402
from piper_tts import synthesize  # noqa: E402

CASES = [
    ("Tänd taklampan.", "ceiling.on"),
    ("Släck taklampan.", "ceiling.off"),
    ("Släck allt.", "scene.all_off"),
    ("Sätt på mysljus.", "scene.soft"),
    ("Höj volymen.", "volume.up"),
    ("Sänk volymen.", "volume.down"),
    ("Filmkväll.", "scene.movie"),
    ("Pausa musiken.", "music.pause"),
    ("Volym trettio procent.", "volume.set.30"),
    ("Släck inte lampan.", None),
    ("Vad är klockan?", None),
    ("Jag tänkte att vi kunde äta middag sen.", None),
]


def _pcm(wav_bytes: bytes) -> bytes:
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1
        return w.readframes(w.getnframes())


def _noise(ms: int, dbfs: float, rng: random.Random) -> bytes:
    amp = 32768 * 10 ** (dbfs / 20) * 1.7  # uniform noise RMS = amp/sqrt(3)
    n = 16 * ms
    return b"".join(int(rng.uniform(-amp, amp)).to_bytes(2, "little", signed=True) for _ in range(n))


def _mix_noise(pcm: bytes, dbfs: float, rng: random.Random) -> bytes:
    import numpy as np

    a = np.frombuffer(pcm, dtype="<i2").astype(np.float32)
    amp = 32768 * 10 ** (dbfs / 20) * 1.7
    a += np.random.default_rng(rng.randrange(1 << 30)).uniform(-amp, amp, len(a)).astype(np.float32)
    return np.clip(a, -32768, 32767).astype("<i2").tobytes()


async def run(args: argparse.Namespace) -> int:
    rng = random.Random(7)
    args.out.mkdir(parents=True, exist_ok=True)
    stt = SttClient(SttConfig(workers=(args.worker,), request_timeout_s=30, total_budget_s=40))
    vcfg = VoiceConfig()
    rows = []
    clips: list[tuple[str, str | None, str, bytes]] = []
    for voice in args.voice:
        for i, (text, expected) in enumerate(CASES):
            speech = _pcm(synthesize(voice, text, sample_rate=16000))
            # Wake-word gap, then the command, then the room going quiet.
            pcm = _noise(250, args.noise_dbfs, rng) + _mix_noise(speech, args.noise_dbfs, rng) \
                + _noise(1500, args.noise_dbfs, rng)
            clips.append((f"{voice.stem}-{i:02d}", expected, text, pcm))
    clips.append(("silence-noise", None, "(room noise only)", _noise(3000, args.noise_dbfs, rng)))
    clips.append(("louder-noise", None, "(noise at -35 dBFS)", _noise(3000, -35, rng)))

    for name, expected, text, pcm in clips:
        (args.out / f"{name}.wav").write_bytes(pcm_to_wav(pcm))
        ep = Endpointer(vcfg, noise_floor_dbfs=args.noise_dbfs)
        for off in range(0, len(pcm), 1024):  # the node sends ~32 ms chunks
            if ep.feed(pcm[off:off + 1024]):
                break
        ep.finish()
        snap = ep.snapshot()
        row = {"clip": name, "said": text, "expected": expected, "endpoint": snap.end_reason,
               "endpoint_audio_ms": snap.audio_ms}
        sent = pcm if snap.speech_start_ms is None else \
            pcm[max(0, snap.speech_start_ms - 300) * 32: snap.audio_ms * 32]
        t0 = time.monotonic()
        try:
            tr, _ = await stt.transcribe(sent, 16000)
        except SttFailure as failure:
            row["error"] = failure.reason
            rows.append(row)
            continue
        row["roundtrip_ms"] = int((time.monotonic() - t0) * 1000)
        conf, why = stt.confident(tr)
        intent = parse(tr.text) if conf else None
        got = action_name(intent.action) if intent else None
        row.update(transcript=tr.text, avg_logprob=round(tr.avg_logprob, 3),
                   no_speech_prob=round(tr.no_speech_prob, 3), processing_ms=tr.processing_ms,
                   audio_ms=tr.duration_ms, confident=why, action=got, correct=(got == expected))
        rows.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
    timed = [r["processing_ms"] for r in rows if r.get("processing_ms") is not None]
    summary = {
        "clips": len(rows), "correct": sum(1 for r in rows if r.get("correct")),
        "processing_ms_median": statistics.median(timed) if timed else None,
        "processing_ms_max": max(timed) if timed else None,
        "roundtrip_ms_median": statistics.median([r["roundtrip_ms"] for r in rows if "roundtrip_ms" in r]),
    }
    print(json.dumps({"summary": summary}, ensure_ascii=False))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--worker", default="http://127.0.0.1:8790")
    ap.add_argument("--voice", type=Path, action="append", required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--noise-dbfs", type=float, default=-55.0)
    return asyncio.run(run(ap.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
