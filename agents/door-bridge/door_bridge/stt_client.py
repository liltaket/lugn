"""Speech-to-text through an ordered list of optional LAN workers."""

from __future__ import annotations

import asyncio
import base64
import json
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

from . import httpjson
from .audio import pcm_to_wav
from .config import SttConfig


@dataclass(frozen=True)
class Transcript:
    text: str
    avg_logprob: float
    no_speech_prob: float
    language: str
    duration_ms: int
    worker: str
    latency_ms: int
    processing_ms: int | None = None


@dataclass
class SttFailure(Exception):
    reason: str
    attempts: list[dict[str, Any]] = field(default_factory=list)

    def __str__(self) -> str:
        return self.reason


@dataclass(frozen=True)
class Scores:
    """Mean log-probability per token of each candidate, in request order."""

    scores: list[float]
    worker: str
    latency_ms: int
    processing_ms: int | None
    attempts: list[dict[str, Any]]


class SttApi(Protocol):
    async def transcribe(self, pcm: bytes, sample_rate: int) -> tuple[Transcript, list[dict[str, Any]]]: ...

    async def score(self, pcm: bytes, sample_rate: int, candidates: list[str], *, prefer: str, prompt: bool,
                    budget_s: float) -> Scores: ...


Transport = Callable[..., httpjson.Response]


class SttClient:
    def __init__(self, cfg: SttConfig, token: str | None = None, *, transport: Transport = httpjson.request,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._cfg = cfg
        self._token = token
        self._transport = transport
        self._clock = clock
        self._failed_at: dict[str, float] = {}

    def _order(self) -> list[str]:
        now = self._clock()
        fresh = [w for w in self._cfg.workers
                 if now - self._failed_at.get(w, -1e18) >= self._cfg.failure_cooldown_s]
        cooling = [w for w in self._cfg.workers if w not in fresh]
        return fresh + cooling

    async def transcribe(self, pcm: bytes, sample_rate: int) -> tuple[Transcript, list[dict[str, Any]]]:
        """Return the first worker's answer; raise SttFailure when none answers in budget."""
        attempts: list[dict[str, Any]] = []
        if not self._cfg.workers:
            raise SttFailure("no_workers", attempts)
        wav = pcm_to_wav(pcm, sample_rate)
        deadline = self._clock() + self._cfg.total_budget_s
        headers = {"content-type": "audio/wav"}
        if self._token:
            headers["authorization"] = f"Bearer {self._token}"
        for worker in self._order():
            remaining = deadline - self._clock()
            if remaining <= 0.05:
                attempts.append({"worker": worker, "error": "budget_exhausted"})
                break
            started = self._clock()
            read_timeout = min(self._cfg.request_timeout_s, remaining)
            try:
                resp = await asyncio.wait_for(
                    asyncio.to_thread(
                        self._transport, "POST", worker.rstrip("/") + "/v1/transcribe", body=wav,
                        headers=headers, connect_timeout=min(self._cfg.connect_timeout_s, remaining),
                        read_timeout=read_timeout,
                    ),
                    timeout=remaining,
                )
                if resp.status != 200:
                    raise httpjson.HttpError(f"HTTP {resp.status}", status=resp.status)
                transcript = _parse(resp.json(), worker, int((self._clock() - started) * 1000))
            except (asyncio.TimeoutError, httpjson.HttpError, ValueError) as error:
                self._failed_at[worker] = self._clock()
                kind = "timeout" if isinstance(error, asyncio.TimeoutError) else str(error) or type(error).__name__
                attempts.append({"worker": worker, "error": kind[:200],
                                 "ms": int((self._clock() - started) * 1000)})
                continue
            self._failed_at.pop(worker, None)
            attempts.append({"worker": worker, "ms": transcript.latency_ms})
            return transcript, attempts
        raise SttFailure("no_worker_answered", attempts)

    async def score(self, pcm: bytes, sample_rate: int, candidates: list[str], *, prefer: str, prompt: bool,
                    budget_s: float) -> Scores:
        """Score candidate texts against the audio (`POST /v1/score`).

        `prefer` (the worker that transcribed) goes first. Raises SttFailure
        when no worker answers within `budget_s`; a worker without the
        endpoint answers 404 and is not put in cooldown.
        """
        attempts: list[dict[str, Any]] = []
        audio = base64.b64encode(pcm_to_wav(pcm, sample_rate)).decode("ascii")
        body = json.dumps({"audio": audio, "candidates": candidates, "prompt": prompt},
                          ensure_ascii=False).encode("utf-8")
        headers = {"content-type": "application/json"}
        if self._token:
            headers["authorization"] = f"Bearer {self._token}"
        order = [prefer] + [w for w in self._order() if w != prefer] if prefer in self._cfg.workers \
            else self._order()
        deadline = self._clock() + budget_s
        for worker in order:
            remaining = deadline - self._clock()
            if remaining <= 0.05:
                attempts.append({"worker": worker, "error": "budget_exhausted"})
                break
            started = self._clock()
            try:
                resp = await asyncio.wait_for(
                    asyncio.to_thread(
                        self._transport, "POST", worker.rstrip("/") + "/v1/score", body=body, headers=headers,
                        connect_timeout=min(self._cfg.connect_timeout_s, remaining), read_timeout=remaining,
                    ),
                    timeout=remaining,
                )
                ms = int((self._clock() - started) * 1000)
                if resp.status == 404:
                    attempts.append({"worker": worker, "error": "unsupported", "ms": ms})
                    continue
                if resp.status != 200:
                    raise httpjson.HttpError(f"HTTP {resp.status}", status=resp.status)
                scores, processing = _parse_scores(resp.json(), len(candidates))
            except (asyncio.TimeoutError, httpjson.HttpError, ValueError) as error:
                self._failed_at[worker] = self._clock()
                kind = "timeout" if isinstance(error, asyncio.TimeoutError) else str(error) or type(error).__name__
                attempts.append({"worker": worker, "error": kind[:200],
                                 "ms": int((self._clock() - started) * 1000)})
                continue
            attempts.append({"worker": worker, "ms": ms})
            return Scores(scores, worker, ms, processing, attempts)
        raise SttFailure("no_worker_scored", attempts)

    def confident(self, t: Transcript) -> tuple[bool, str]:
        if not t.text.strip():
            return False, "empty_transcript"
        if t.no_speech_prob > self._cfg.max_no_speech_prob:
            return False, "no_speech_prob"
        if t.avg_logprob < self._cfg.min_avg_logprob:
            return False, "low_avg_logprob"
        return True, "ok"


def _parse(data: Any, worker: str, latency_ms: int) -> Transcript:
    if not isinstance(data, dict):
        raise ValueError("worker response is not an object")
    try:
        return Transcript(
            text=str(data["text"]),
            avg_logprob=float(data["avg_logprob"]),
            no_speech_prob=float(data["no_speech_prob"]),
            language=str(data.get("language", "")),
            duration_ms=int(data.get("duration_ms", 0)),
            worker=worker,
            latency_ms=latency_ms,
            processing_ms=int(data["processing_ms"]) if "processing_ms" in data else None,
        )
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError(f"malformed worker response: {error}") from error


def _parse_scores(data: Any, expected: int) -> tuple[list[float], int | None]:
    if not isinstance(data, dict) or not isinstance(data.get("scores"), list):
        raise ValueError("malformed score response")
    items = data["scores"]
    if len(items) != expected:
        raise ValueError("score count does not match the candidates")
    try:
        scores = [float(item["mean_logprob"]) for item in items]
        processing = int(data["processing_ms"]) if "processing_ms" in data else None
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError(f"malformed score response: {error}") from error
    if any(s != s or s > 0 for s in scores):  # NaN or impossible
        raise ValueError("malformed score response: score out of range")
    return scores, processing
