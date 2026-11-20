"""One voice run per wake word: listen, endpoint, transcribe, act, end.

Invariants:
- A run is finalized exactly once (journal line, earcon, RUN_END).
- RUN_END is sent exactly once unless the node is gone (disconnect) or has
  already started a newer run (superseded); then it is skipped and journaled.
- Every await has a deadline; the whole run has a hard timeout.
"""

from __future__ import annotations

import asyncio
import enum
import json
import logging
import os
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Protocol

from .audio import SAMPLE_RATE, pcm_to_wav
from .config import RescoreConfig, VoiceConfig
from .earcons import Kind, Player
from .endpointing import Endpointer
from .executor import Executor
from .intents import IntentResult, action_name, parse
from .rescore import Decision, candidates, decide, should_rescore
from .stt_client import SttApi, SttFailure, Transcript

log = logging.getLogger(__name__)


class VoiceEvent(enum.IntEnum):
    """Same values as aioesphomeapi.VoiceAssistantEventType."""

    ERROR = 0
    RUN_START = 1
    RUN_END = 2
    STT_START = 3
    STT_END = 4
    INTENT_START = 5
    INTENT_END = 6
    STT_VAD_START = 11
    STT_VAD_END = 12


class VoiceTransport(Protocol):
    def send_event(self, event: VoiceEvent, data: dict[str, str] | None = None) -> bool: ...

    def ambient_floor_dbfs(self) -> float | None: ...


class Journal:
    """Append-only JSON lines with one size-based rollover (`.1`)."""

    def __init__(self, path: str, max_bytes: int) -> None:
        self.path = Path(path).expanduser()
        self.max_bytes = max_bytes

    def write(self, record: dict[str, Any]) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            if self.path.exists() and self.path.stat().st_size > self.max_bytes:
                os.replace(self.path, self.path.with_name(self.path.name + ".1"))
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        except OSError as error:
            log.warning("voice journal write failed: %s", error)


PRE_ROLL_MS = 500
_ERROR_OUTCOMES = {"stt_unavailable", "run_timeout", "exception", "lugn_failed"}
_EARCON_FOR: dict[str, Kind] = {
    # "done" played its tone when the command was understood, before the call.
    "dry_run": "ok", "not_understood": "not_understood",
    # No tone for a run without speech: that is usually a false wake, and the
    # listening tick already told a real user that the node heard them.
    "low_confidence": "not_understood",
    "stt_unavailable": "error", "run_timeout": "error", "exception": "error",
    "lugn_failed": "error", "disconnected": "error",
}


class VoiceRun:
    def __init__(self, pipeline: VoicePipeline, conversation_id: str, wake_word: str | None) -> None:
        self.p = pipeline
        cfg = pipeline.cfg
        self.id = uuid.uuid4().hex[:12]
        self.started = pipeline.clock()
        floor = pipeline.transport.ambient_floor_dbfs()
        if floor is not None:
            floor += cfg.stream_gain_db
        self.endpointer = Endpointer(cfg, floor)
        self._audio = bytearray()
        self._audio_cap = (cfg.max_utterance_ms + 1000) * SAMPLE_RATE // 1000 * 2
        self._ended = asyncio.Event()
        self._mic_open = True
        self.finished = False
        self.outcome: str | None = None
        self._task: asyncio.Task[None] | None = None
        self.run_end_sent = 0
        self.record: dict[str, Any] = {
            "v": 1, "run": self.id, "at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "conversation_id": conversation_id or None, "wake_word": wake_word,
            "dry_run": cfg.dry_run, "ambient_floor_dbfs": None if floor is None else round(floor, 1),
            "ms": {},
        }

    # -- inputs from the node ------------------------------------------------

    def start(self) -> None:
        # Sent before any audio can arrive, so VAD events always follow RUN_START.
        self.p.transport.send_event(VoiceEvent.RUN_START)
        self.p.transport.send_event(VoiceEvent.STT_START)
        self._task = asyncio.get_running_loop().create_task(self._main(), name=f"voice-run-{self.id}")

    def feed(self, pcm: bytes) -> None:
        if not self._mic_open or self.finished or self.endpointer.done:
            return
        room = self._audio_cap - len(self._audio)
        if room > 0:
            self._audio.extend(pcm[:room])
        reason = self.endpointer.feed(pcm)
        if self.endpointer.speech_started_now:
            self._mark("speech_start")
            self.p.transport.send_event(VoiceEvent.STT_VAD_START)
        if reason is not None:
            self._ended.set()

    def audio_ended(self) -> None:
        self.endpointer.finish()
        self._ended.set()

    def cancel(self, reason: str) -> None:
        """Finalize now (synchronously) and stop the run's task."""
        if self.finished:
            return
        self.outcome = reason
        self._finish()
        if self._task is not None and not self._task.done():
            self._task.cancel()

    async def wait(self) -> None:
        if self._task is not None:
            await asyncio.gather(self._task, return_exceptions=True)

    # -- the run ---------------------------------------------------------------

    def _mark(self, name: str) -> None:
        self.record["ms"][name] = int((self.p.clock() - self.started) * 1000)

    async def _main(self) -> None:
        try:
            async with asyncio.timeout(self.p.cfg.run_timeout_s):
                await self._pipeline()
        except asyncio.TimeoutError:
            self.outcome = self.outcome or "run_timeout"
        except asyncio.CancelledError:
            self.outcome = self.outcome or "cancelled"
        except Exception as error:  # noqa: BLE001 - a run must always end
            log.exception("voice run %s failed", self.id)
            self.outcome = self.outcome or "exception"
            self.record["error"] = f"{type(error).__name__}: {error}"[:300]
        finally:
            self._finish()

    async def _pipeline(self) -> None:
        cfg, send = self.p.cfg, self.p.transport.send_event
        self.p.earcons.play("listening")
        try:
            await asyncio.wait_for(self._ended.wait(), cfg.max_utterance_ms / 1000 + 1.5)
        except asyncio.TimeoutError:
            self.record["audio_stalled"] = True
            self.endpointer.finish()
        self._mic_open = False
        send(VoiceEvent.STT_VAD_END)  # the node does not endpoint; this stops its mic
        self._mark("vad_end")
        snap = self.endpointer.snapshot()
        self.record["endpoint"] = snap.__dict__
        if snap.end_reason == "no_speech" or snap.speech_start_ms is None:
            # Quiet or distant speech can stay below the frame threshold while
            # its peaks clear it. Let STT decide then: its no-speech and
            # confidence gates and the grammar still guard every action.
            if snap.peak_dbfs is None or snap.peak_dbfs < self.endpointer.threshold_dbfs:
                self.p.keep_audio(self.id, bytes(self._audio))
                self.outcome = "no_speech"
                return
            self.record["weak_speech"] = True
            pcm = bytes(self._audio)
        else:
            # 500 ms of pre-roll: a soft first consonant ("t" in "tänd") stays
            # under the frame threshold, and cutting it made "tänd taklampan"
            # come back as "sen ta flampan".
            start_byte = max(0, snap.speech_start_ms - PRE_ROLL_MS) * SAMPLE_RATE // 1000 * 2
            pcm = bytes(self._audio[start_byte:])
        self.record["audio_ms"] = len(pcm) * 1000 // (SAMPLE_RATE * 2)
        self.p.keep_audio(self.id, pcm)
        try:
            transcript, attempts = await self.p.stt.transcribe(pcm, SAMPLE_RATE)
        except SttFailure as failure:
            self.record["stt"] = {"error": failure.reason, "attempts": failure.attempts}
            self.outcome = "stt_unavailable"
            log.warning("voice run %s: no STT worker answered: %s", self.id, failure.attempts)
            return
        self._mark("stt_end")
        self.record["stt"] = {"attempts": attempts, "worker": transcript.worker, "latency_ms": transcript.latency_ms,
                              "processing_ms": transcript.processing_ms}
        self.record["transcript"] = transcript.text
        self.record["avg_logprob"] = round(transcript.avg_logprob, 3)
        self.record["no_speech_prob"] = round(transcript.no_speech_prob, 3)
        self.record["language"] = transcript.language
        send(VoiceEvent.STT_END, {"text": transcript.text or " "})

        confident, why = self.p.stt_confident(transcript)
        intent = parse(transcript.text)
        trigger = should_rescore(transcript.text, why, intent) if self.p.rescore.enabled else None
        if not confident:
            self.record["rejected"] = why
            if trigger is None:
                self.outcome = "low_confidence"
                return
        send(VoiceEvent.INTENT_START)
        action = intent.action if confident else None
        self.record["intent"] = {"normalized": intent.normalized, "reason": intent.reason,
                                 "action": action_name(action)}
        spoken = transcript.text
        if action is None and trigger is not None:
            decision = await self._rescore(pcm, transcript, intent, trigger)
            if decision is not None and decision.phrase is not None:
                action = parse(decision.phrase).action
                self.record["intent"].update(action=action_name(action), source="rescore")
                spoken = f"{decision.phrase} (hört: {transcript.text.strip()})"
        if action is None:
            self.outcome = "not_understood" if confident else "low_confidence"
            send(VoiceEvent.INTENT_END)
            return
        if cfg.dry_run:
            planned = self.p.executor.plan(action)
            self.record["planned"] = ({"capability": planned[0], "input": planned[1]} if planned
                                      else {"action": action_name(action), "needs": "music.getState"})
            self.outcome = "dry_run"
            send(VoiceEvent.INTENT_END)
            return
        # Feedback as soon as the command is understood; a scene change can take
        # seconds in Lugn. A failed call still ends with the error tone.
        try:
            self.p.earcons.play("ok")
        except Exception:  # noqa: BLE001 - feedback is a courtesy
            log.exception("earcon failed")
        execution = await self.p.executor.execute(action, transcript=spoken, request_id=f"voice-{self.id}")
        self._mark("lugn_end")
        self.record["lugn"] = {"ok": execution.ok, "calls": execution.calls, "error": execution.error}
        self.outcome = "done" if execution.ok else "lugn_failed"
        send(VoiceEvent.INTENT_END)

    async def _rescore(self, pcm: bytes, transcript: Transcript, intent: IntentResult,
                       trigger: str) -> Decision | None:
        """Score the command phrases against this audio; journal why it did or did not act."""
        cfg = self.p.rescore
        entry: dict[str, Any] = {"trigger": trigger}
        self.record["rescore"] = entry
        try:
            result = await self.p.stt.score(pcm, SAMPLE_RATE, candidates(transcript.text), prefer=transcript.worker,
                                            prompt=cfg.prompt, budget_s=cfg.timeout_s)
        except SttFailure as failure:
            entry.update(accepted=False, reason="unavailable", attempts=failure.attempts)
            return None
        self._mark("rescore_end")
        decision = decide(cfg, transcript.text, intent, result.scores)
        entry.update(decision.record)
        entry.update(worker=result.worker, latency_ms=result.latency_ms, processing_ms=result.processing_ms)
        log.info("voice run %s: rescore %s %s (%s)", self.id, decision.reason, decision.record["best"]["action"],
                 decision.record["margins"])
        return decision

    def _finish(self) -> None:
        if self.finished:
            return
        self.finished = True
        self._mic_open = False
        outcome = self.outcome or "cancelled"
        self.record["outcome"] = outcome
        transport = self.p.transport
        if outcome in ("superseded", "disconnected", "shutdown"):
            self.record["run_end"] = {"sent": False, "skipped": outcome}
        else:
            if outcome in _ERROR_OUTCOMES:
                transport.send_event(VoiceEvent.ERROR, {"code": outcome.replace("_", "-"), "message": outcome})
            delivered = transport.send_event(VoiceEvent.RUN_END)
            self.run_end_sent += 1
            self.record["run_end"] = {"sent": delivered}
        self._mark("total")
        earcon = _EARCON_FOR.get(outcome)
        if earcon is not None:
            try:
                self.p.earcons.play(earcon)
            except Exception:  # noqa: BLE001 - feedback is a courtesy
                log.exception("earcon failed")
        self.p.journal.write(self.record)
        log.info("voice run %s: %s %r", self.id, outcome, self.record.get("transcript"))
        self.p.run_finished(self)


class VoicePipeline:
    """Owns at most one active run; wired to aioesphomeapi's voice callbacks."""

    def __init__(self, *, cfg: VoiceConfig, transport: VoiceTransport, stt: SttApi,
                 stt_confident: Callable[[Any], tuple[bool, str]], executor: Executor, earcons: Player,
                 journal: Journal, clock: Callable[[], float] = time.monotonic,
                 rescore: RescoreConfig | None = None) -> None:
        self.cfg = cfg
        self.rescore = rescore or RescoreConfig(enabled=False)
        self.transport = transport
        self.stt = stt
        self.stt_confident = stt_confident
        self.executor = executor
        self.earcons = earcons
        self.journal = journal
        self.clock = clock
        self.active: VoiceRun | None = None
        self.history: deque[VoiceRun] = deque(maxlen=8)
        self._kept: deque[Path] = deque()

    async def handle_start(self, conversation_id: str, flags: int, audio_settings: Any,
                           wake_word_phrase: str | None) -> int | None:
        if self.active is not None and not self.active.finished:
            self.active.cancel("superseded")
        run = VoiceRun(self, conversation_id, wake_word_phrase)
        self.active = run
        run.start()
        return 0  # port 0: audio comes over the API connection

    async def handle_audio(self, data: bytes, data2: bytes | None = None) -> None:
        if self.active is not None:
            self.active.feed(data)

    async def handle_stop(self, abort: bool) -> None:
        run = self.active
        if run is None or run.finished:
            return
        if abort:
            run.cancel("device_stop")
        else:
            run.audio_ended()

    def on_disconnect(self) -> None:
        if self.active is not None:
            self.active.cancel("disconnected")

    def run_finished(self, run: VoiceRun) -> None:
        self.history.append(run)
        if self.active is run:
            self.active = None

    async def close(self) -> None:
        run = self.active
        if run is not None:
            run.cancel("shutdown")
            await run.wait()

    def keep_audio(self, run_id: str, pcm: bytes) -> None:
        if self.cfg.keep_audio <= 0:
            return
        try:
            directory = Path(self.cfg.audio_dir).expanduser()
            directory.mkdir(parents=True, exist_ok=True)
            path = directory / f"{run_id}.wav"
            path.write_bytes(pcm_to_wav(pcm))
            self._kept.append(path)
            while len(self._kept) > self.cfg.keep_audio:
                self._kept.popleft().unlink(missing_ok=True)
        except OSError as error:
            log.warning("could not keep audio: %s", error)
