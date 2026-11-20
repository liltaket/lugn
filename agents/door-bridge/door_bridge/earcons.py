"""Short confirmation sounds, synthesized at start and played with `aplay`.

No audio files live in git. Optional pre-rendered speech (see
tools/render_prompts.py) replaces a tone when `<prompts_dir>/<kind>.wav` exists.
"""

from __future__ import annotations

import asyncio
import logging
import math
from array import array
from pathlib import Path
from typing import Literal, Protocol

from .audio import pcm_to_wav

Kind = Literal["listening", "ok", "not_understood", "error", "cancelled"]
KINDS: tuple[Kind, ...] = ("listening", "ok", "not_understood", "error", "cancelled")
RATE = 44_100
LEAD_IN_S = 0.02  # the Pi's DAC clips the first ~20 ms after the device opens
PLAY_TIMEOUT_S = 4.0
log = logging.getLogger(__name__)

# (frequency Hz, duration s) per note; 0 Hz is a rest.
_NOTES: dict[Kind, list[tuple[float, float]]] = {
    "listening": [(880.0, 0.07)],
    "ok": [(659.26, 0.08), (987.77, 0.14)],
    "not_understood": [(587.33, 0.10), (0, 0.05), (587.33, 0.10)],
    "error": [(440.0, 0.12), (311.13, 0.22)],
    "cancelled": [(523.25, 0.09), (392.0, 0.12)],
}


def render(kind: Kind, volume: float) -> bytes:
    """A soft bell-like tone sequence as a 44.1 kHz mono WAV."""
    gain = max(0.0, min(1.0, volume)) * 0.6 * 32767
    samples = array("h", [0] * int(RATE * LEAD_IN_S))
    for freq, dur in _NOTES[kind]:
        n = int(RATE * dur)
        if freq <= 0:
            samples.extend([0] * n)
            continue
        attack = int(RATE * 0.004)
        for i in range(n):
            t = i / RATE
            env = (i / attack if i < attack else 1.0) * math.exp(-t / (dur * 0.45))
            value = math.sin(2 * math.pi * freq * t) + 0.18 * math.sin(4 * math.pi * freq * t)
            samples.append(int(max(-32767, min(32767, gain * env * value / 1.18))))
    samples.extend([0] * int(RATE * 0.06))
    return pcm_to_wav(samples.tobytes(), RATE)


class Player(Protocol):
    def play(self, kind: Kind) -> None: ...


class AplayPlayer:
    """Fire-and-forget playback; a sound still playing makes the next one drop."""

    def __init__(self, *, volume: float, audio_device: str = "", prompts_dir: str = "",
                 enabled: bool = True, listening: bool = False) -> None:
        self._enabled = enabled
        self._listening = listening
        self._device = audio_device
        self._sounds: dict[Kind, bytes] = {}
        prompts = Path(prompts_dir).expanduser() if prompts_dir else None
        for kind in KINDS:
            spoken = prompts / f"{kind}.wav" if prompts else None
            if spoken is not None and spoken.is_file():
                self._sounds[kind] = spoken.read_bytes()
            else:
                self._sounds[kind] = render(kind, volume)
        self._task: asyncio.Task[None] | None = None
        self.played: list[Kind] = []

    def play(self, kind: Kind) -> None:
        if not self._enabled or (kind == "listening" and not self._listening):
            return
        if self._task is not None and not self._task.done():
            log.info("earcon %s dropped: previous still playing", kind)
            return
        self.played.append(kind)
        self._task = asyncio.get_running_loop().create_task(self._run(self._sounds[kind]))

    async def _run(self, wav: bytes) -> None:
        args = ["-q", "-t", "wav"] + (["-D", self._device] if self._device else []) + ["-"]
        try:
            proc = await asyncio.create_subprocess_exec(
                "aplay", *args, stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        except OSError as error:
            log.warning("earcon: aplay unavailable: %s", error)
            return
        try:
            await asyncio.wait_for(proc.communicate(wav), PLAY_TIMEOUT_S)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            log.warning("earcon: aplay timed out")
        if proc.returncode not in (0, None, -9):
            log.warning("earcon: aplay exited with %s", proc.returncode)


def write_all(directory: Path, volume: float) -> list[Path]:
    directory.mkdir(parents=True, exist_ok=True)
    out = []
    for kind in KINDS:
        path = directory / f"{kind}.wav"
        path.write_bytes(render(kind, volume))
        out.append(path)
    return out
