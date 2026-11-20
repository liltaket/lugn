"""Shared Piper helper for the optional dev-machine tools (never runs on the Pi)."""

from __future__ import annotations

import io
import wave
from pathlib import Path


def synthesize(voice_path: Path, text: str, *, sample_rate: int | None = None, length_scale: float = 1.0) -> bytes:
    """Render text with a Piper voice; resample to `sample_rate` when given. Returns WAV bytes."""
    from piper import PiperVoice, SynthesisConfig

    voice = PiperVoice.load(str(voice_path))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        voice.synthesize_wav(text, w, syn_config=SynthesisConfig(length_scale=length_scale))
    data = buf.getvalue()
    if sample_rate is None:
        return data
    return resample_wav(data, sample_rate)


def resample_wav(data: bytes, sample_rate: int) -> bytes:
    import numpy as np
    from faster_whisper.audio import decode_audio

    audio = decode_audio(io.BytesIO(data), sampling_rate=sample_rate)
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return out.getvalue()
