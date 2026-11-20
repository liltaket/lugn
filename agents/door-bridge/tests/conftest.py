from __future__ import annotations

import math
import sys
from array import array
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from door_bridge.lugn_client import LugnError  # noqa: E402
from door_bridge.stt_client import Scores, SttFailure, Transcript  # noqa: E402
from door_bridge.voice import VoiceEvent  # noqa: E402

RATE = 16_000


def tone(ms: int, dbfs: float, freq: float = 220.0) -> bytes:
    """A sine at the given RMS level (stands in for voiced speech)."""
    amp = 32768 * 10 ** (dbfs / 20) * math.sqrt(2)
    n = RATE * ms // 1000
    return array("h", [int(amp * math.sin(2 * math.pi * freq * i / RATE)) for i in range(n)]).tobytes()


def silence(ms: int) -> bytes:
    return b"\x00\x00" * (RATE * ms // 1000)


def chunks(pcm: bytes, size: int = 1024) -> list[bytes]:
    return [pcm[i:i + size] for i in range(0, len(pcm), size)]


class FakeTransport:
    def __init__(self, floor: float | None = -70.0) -> None:
        self.connected = True
        self.events: list[tuple[VoiceEvent, dict[str, str] | None]] = []
        self.floor = floor

    def send_event(self, event: VoiceEvent, data: dict[str, str] | None = None) -> bool:
        if not self.connected:
            return False
        self.events.append((event, data))
        return True

    def ambient_floor_dbfs(self) -> float | None:
        return self.floor

    def names(self) -> list[str]:
        return [e.name for e, _ in self.events]


class FakeStt:
    def __init__(self, text: str = "Tänd taklampan.", *, logprob: float = -0.2, no_speech: float = 0.01,
                 delay: float = 0.0, fail: bool = False, hang: bool = False,
                 scores: dict[str, float] | None = None, score_fail: bool = False) -> None:
        self.text, self.logprob, self.no_speech = text, logprob, no_speech
        self.delay, self.fail, self.hang = delay, fail, hang
        self.calls: list[bytes] = []
        # Rescoring: text -> mean log-probability; anything unlisted scores -6.
        self.scores, self.score_fail = scores or {}, score_fail
        self.score_calls: list[tuple[list[str], str, bool]] = []

    async def score(self, pcm: bytes, sample_rate: int, candidates: list[str], *, prefer: str, prompt: bool,
                    budget_s: float) -> Scores:
        self.score_calls.append((candidates, prefer, prompt))
        if self.score_fail:
            raise SttFailure("no_worker_scored", [{"worker": prefer, "error": "unsupported"}])
        return Scores([self.scores.get(c, -6.0) for c in candidates], prefer, 7, 6, [{"worker": prefer, "ms": 7}])

    async def transcribe(self, pcm: bytes, sample_rate: int) -> tuple[Transcript, list[dict[str, Any]]]:
        import asyncio

        self.calls.append(pcm)
        if self.hang:
            await asyncio.Event().wait()
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail:
            raise SttFailure("no_worker_answered", [{"worker": "http://w", "error": "timeout"}])
        return Transcript(self.text, self.logprob, self.no_speech, "sv", len(pcm) // 32, "http://w", 5), []

    def confident(self, t: Transcript) -> tuple[bool, str]:
        if t.no_speech_prob > 0.5:
            return False, "no_speech_prob"
        if t.avg_logprob < -0.7:
            return False, "low_avg_logprob"
        return bool(t.text.strip()), "ok"


class FakeLugn:
    def __init__(self, *, volume: float | None = 0.3, fail: str | None = None, state: dict[str, Any] | None = None,
                 policy: dict[str, Any] | None = None) -> None:
        self.calls: list[tuple[str, dict[str, Any], str | None, str | None]] = []
        self.volume = volume
        self.fail = fail
        self.state = state or {}
        self.policy = policy or {}
        self.state_calls = 0

    async def invoke(self, name: str, input: dict[str, Any], *, request_id: str | None = None,
                     reason: str | None = None) -> dict[str, Any]:
        self.calls.append((name, input, request_id, reason))
        if self.fail:
            raise LugnError("boom", status=400, code=self.fail)
        if name == "music.getState":
            return {"device": {"observed": {"volume": self.volume}, "availability": "available"}}
        if name == "music.getPolicy":
            return self.policy.get(input["target"], {})
        return {"accepted": True, "status": "pending", "commandId": "c1"}

    async def get_state(self) -> dict[str, Any]:
        self.state_calls += 1
        if self.fail:
            raise LugnError("down")
        return self.state


class FakePlayer:
    def __init__(self) -> None:
        self.played: list[str] = []

    def play(self, kind: str) -> None:
        if kind != "listening":  # the wake tick is not part of an outcome
            self.played.append(kind)


@pytest.fixture
def transport() -> FakeTransport:
    return FakeTransport()
