"""PCM16 helpers (pure Python; cheap enough for 16 kHz mono on a Pi)."""

from __future__ import annotations

import io
import math
import struct
import sys
import wave
from array import array

SAMPLE_RATE = 16_000
FULL_SCALE = 32768.0


def frame_dbfs(pcm: bytes) -> float:
    """RMS level of little-endian PCM16 in dBFS (-120 for silence)."""
    samples = array("h")
    samples.frombytes(pcm[: len(pcm) - (len(pcm) % 2)])
    if sys.byteorder != "little":
        samples.byteswap()
    if not samples:
        return -120.0
    energy = sum(s * s for s in samples) / len(samples)
    if energy <= 0:
        return -120.0
    return max(-120.0, 10 * math.log10(energy / (FULL_SCALE * FULL_SCALE)))


def pcm_to_wav(pcm: bytes, sample_rate: int = SAMPLE_RATE) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return out.getvalue()


def wav_to_pcm(data: bytes) -> tuple[bytes, int]:
    """Return (PCM16 mono bytes, sample rate); raises ValueError otherwise."""
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            if w.getnchannels() != 1 or w.getsampwidth() != 2 or w.getcomptype() != "NONE":
                raise ValueError("expected PCM16 mono WAV")
            return w.readframes(w.getnframes()), w.getframerate()
    except (wave.Error, EOFError, struct.error) as error:
        raise ValueError(f"invalid WAV: {error}") from error
