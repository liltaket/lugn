"""Server-side end-of-speech detection.

The node does not endpoint speech itself, so the bridge decides when to stop
the microphone. Energy per frame against a threshold derived from the room's
ambient level (from the node's level sensor, measured before the wake word),
with a hangover. All timing is in audio time, so it is deterministic.

The stream starts right after the node's wake word, so its first few hundred
milliseconds often hold the end of the wake word itself. A short burst that
starts and ends inside `wake_tail_ms` (plus a short grace) is dropped rather
than taken as the command, and listening goes on.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .audio import SAMPLE_RATE, frame_dbfs
from .config import VoiceConfig

EndReason = Literal["speech_end", "max_utterance", "no_speech"]
DEFAULT_FLOOR_DBFS = -65.0
# A wake-word tail may run this far past `wake_tail_ms` and still be dropped.
WAKE_TAIL_GRACE_MS = 300


@dataclass
class EndpointerSnapshot:
    threshold_dbfs: float
    audio_ms: int
    speech_start_ms: int | None
    speech_ms: int
    end_reason: EndReason | None
    peak_dbfs: float
    tail_ignored_ms: int | None = None


class Endpointer:
    def __init__(self, cfg: VoiceConfig, noise_floor_dbfs: float | None = None,
                 sample_rate: int = SAMPLE_RATE) -> None:
        self._cfg = cfg
        self._frame_bytes = int(sample_rate * cfg.frame_ms / 1000) * 2
        floor = DEFAULT_FLOOR_DBFS if noise_floor_dbfs is None else noise_floor_dbfs
        self.threshold_dbfs = max(cfg.min_speech_dbfs, floor + cfg.speech_margin_db)
        self._pending = bytearray()
        self.audio_ms = 0
        self.speech_start_ms: int | None = None
        self.speech_ms = 0
        self._voiced_run_ms = 0
        self._silent_run_ms = 0
        self.end_reason: EndReason | None = None
        self.peak_dbfs = -120.0
        self.speech_started_now = False
        self.tail_ignored_ms: int | None = None
        self._no_speech_deadline_ms = cfg.no_speech_timeout_ms

    @property
    def done(self) -> bool:
        return self.end_reason is not None

    def feed(self, pcm: bytes) -> EndReason | None:
        """Consume audio; return the end reason once, when it is decided."""
        self.speech_started_now = False
        if self.done:
            return None
        self._pending.extend(pcm)
        fm = self._cfg.frame_ms
        while len(self._pending) >= self._frame_bytes and not self.done:
            frame = bytes(self._pending[: self._frame_bytes])
            del self._pending[: self._frame_bytes]
            level = frame_dbfs(frame)
            self.peak_dbfs = max(self.peak_dbfs, level)
            self.audio_ms += fm
            voiced = level >= self.threshold_dbfs
            if voiced:
                self._voiced_run_ms += fm
                self._silent_run_ms = 0
                if self.speech_start_ms is None and self._voiced_run_ms >= self._cfg.min_speech_ms:
                    self.speech_start_ms = self.audio_ms - self._voiced_run_ms
                    self.speech_ms = self._voiced_run_ms
                    self.speech_started_now = True
                elif self.speech_start_ms is not None:
                    self.speech_ms += fm
            else:
                self._voiced_run_ms = 0
                self._silent_run_ms += fm
            if self.speech_start_ms is not None and self._silent_run_ms >= self._cfg.silence_end_ms:
                speech_end_ms = self.audio_ms - self._silent_run_ms
                if self.speech_start_ms < self._cfg.wake_tail_ms \
                        and speech_end_ms <= self._cfg.wake_tail_ms + WAKE_TAIL_GRACE_MS \
                        and self.tail_ignored_ms is None:
                    # The end of the wake word, not the command: keep listening.
                    self.tail_ignored_ms = speech_end_ms
                    self.speech_start_ms = None
                    self.speech_ms = 0
                    self._no_speech_deadline_ms = max(self._cfg.no_speech_timeout_ms,
                                                      speech_end_ms + self._cfg.no_speech_timeout_ms)
                else:
                    self.end_reason = "speech_end"
            elif self.audio_ms >= self._cfg.max_utterance_ms:
                self.end_reason = "max_utterance" if self.speech_start_ms is not None else "no_speech"
            elif self.speech_start_ms is None and self.audio_ms >= self._no_speech_deadline_ms \
                    and self._voiced_run_ms == 0:
                self.end_reason = "no_speech"
        return self.end_reason

    def finish(self) -> EndReason:
        """The audio stream ended or timed out before a decision."""
        if self.end_reason is None:
            self.end_reason = "speech_end" if self.speech_start_ms is not None else "no_speech"
        return self.end_reason

    def snapshot(self) -> EndpointerSnapshot:
        return EndpointerSnapshot(round(self.threshold_dbfs, 1), self.audio_ms, self.speech_start_ms,
                                  self.speech_ms, self.end_reason, round(self.peak_dbfs, 1),
                                  self.tail_ignored_ms)
