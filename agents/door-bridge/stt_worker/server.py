"""Small HTTP speech-to-text worker (faster-whisper, Swedish).

POST /v1/transcribe  body: 16 kHz PCM16 mono WAV (max 30 s)
  -> {text, avg_logprob, no_speech_prob, language, duration_ms, processing_ms, model}
GET  /health         -> {status, model, device, compute_type}

Standard library HTTP so the same file runs on Linux and Windows. One
transcription at a time; others wait for the lock (bounded by the client's
timeout).
"""

from __future__ import annotations

import hmac
import io
import json
import logging
import struct
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Protocol

log = logging.getLogger("stt_worker")
SAMPLE_RATE = 16_000
MAX_SECONDS = 30
MAX_BODY = MAX_SECONDS * SAMPLE_RATE * 2 + 1024

DEFAULT_PROMPT = (
    "Tänd taklampan. Släck taklampan. Tänd allt. Släck allt. Mysljus. "
    "Vardagsljus. Fokus. Filmkväll. Helt släckt. Ljusare. Mörkare. "
    "Pausa musiken. Spela musiken. Höj volymen. Sänk volymen. Volym 30 procent."
)


class Engine(Protocol):
    name: str
    device: str
    compute_type: str

    def transcribe(self, pcm16: bytes) -> dict[str, Any]: ...


class WhisperEngine:
    def __init__(self, model: str, *, device: str = "cpu", compute_type: str = "int8", cpu_threads: int = 0,
                 beam_size: int = 1, initial_prompt: str | None = DEFAULT_PROMPT,
                 download_root: str | None = None) -> None:
        from faster_whisper import WhisperModel

        self.name = model
        self.device = device
        self.compute_type = compute_type
        self.beam_size = beam_size
        self.initial_prompt = initial_prompt
        self._model = WhisperModel(model, device=device, compute_type=compute_type, cpu_threads=cpu_threads,
                                   download_root=download_root)

    def transcribe(self, pcm16: bytes) -> dict[str, Any]:
        import numpy as np

        audio = np.frombuffer(pcm16, dtype="<i2").astype(np.float32) / 32768.0
        segments, info = self._model.transcribe(
            audio, language="sv", task="transcribe", beam_size=self.beam_size, temperature=0.0,
            condition_on_previous_text=False, initial_prompt=self.initial_prompt,
            without_timestamps=True, vad_filter=False)
        segs = list(segments)
        text = " ".join(s.text.strip() for s in segs).strip()
        return {
            "text": text,
            # Conservative aggregates: the worst segment decides.
            "avg_logprob": min((s.avg_logprob for s in segs), default=-10.0),
            "no_speech_prob": max((s.no_speech_prob for s in segs), default=1.0),
            "language": info.language,
        }


def parse_wav(body: bytes) -> bytes:
    try:
        with wave.open(io.BytesIO(body), "rb") as w:
            if (w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getcomptype()) != (1, 2, SAMPLE_RATE, "NONE"):
                raise ValueError("expected 16 kHz PCM16 mono WAV")
            return w.readframes(w.getnframes())
    except (wave.Error, EOFError, struct.error) as error:
        raise ValueError(f"invalid WAV: {error}") from error


def make_handler(engine: Engine, token: str | None) -> type[BaseHTTPRequestHandler]:
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        server_version = "lugn-stt-worker/0.1"
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args: Any) -> None:
            log.debug("%s " + fmt, self.address_string(), *args)

        def _send(self, status: int, payload: dict[str, Any]) -> None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self) -> bool:
            if not token:
                return True
            header = self.headers.get("authorization", "")
            return hmac.compare_digest(header.encode(), f"Bearer {token}".encode())

        def do_GET(self) -> None:  # noqa: N802
            if self.path != "/health":
                self._send(404, {"error": "not_found"})
                return
            self._send(200, {"status": "ok", "model": engine.name, "device": engine.device,
                             "compute_type": engine.compute_type, "busy": lock.locked()})

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/v1/transcribe":
                self._send(404, {"error": "not_found"})
                return
            if not self._authorized():
                self._send(401, {"error": "unauthorized"})
                return
            try:
                length = int(self.headers.get("content-length", "0"))
            except ValueError:
                length = -1
            if length <= 0 or length > MAX_BODY:
                self.close_connection = True
                self._send(413 if length > MAX_BODY else 400, {"error": "bad_length"})
                return
            body = self.rfile.read(length)
            try:
                pcm = parse_wav(body)
            except ValueError as error:
                self._send(400, {"error": "bad_audio", "detail": str(error)})
                return
            started = time.monotonic()
            with lock:
                waited = time.monotonic() - started
                t0 = time.monotonic()
                try:
                    result = engine.transcribe(pcm)
                except Exception as error:  # noqa: BLE001 - report, keep serving
                    log.exception("transcription failed")
                    self._send(500, {"error": "transcription_failed", "detail": type(error).__name__})
                    return
                processing = time.monotonic() - t0
            duration_ms = len(pcm) * 1000 // (SAMPLE_RATE * 2)
            log.info("transcribed %d ms in %.0f ms (waited %.0f ms): %r", duration_ms, processing * 1000,
                     waited * 1000, result.get("text"))
            self._send(200, {**result, "duration_ms": duration_ms, "processing_ms": int(processing * 1000),
                             "queue_ms": int(waited * 1000), "model": engine.name})

    return Handler


def make_server(host: str, port: int, engine: Engine, token: str | None = None) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), make_handler(engine, token))
    server.daemon_threads = True
    return server
