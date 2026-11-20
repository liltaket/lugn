"""Small HTTP speech-to-text worker (faster-whisper, Swedish).

POST /v1/transcribe  body: 16 kHz PCM16 mono WAV (max 30 s)
  -> {text, avg_logprob, no_speech_prob, language, duration_ms, processing_ms, model}
POST /v1/score       body: JSON {audio: base64 WAV (as above), candidates: [text, ...], prompt: bool}
  -> {scores: [{text, tokens, mean_logprob, sum_logprob, min_logprob}], duration_ms, processing_ms, model}
GET  /health         -> {status, model, device, compute_type}

Standard library HTTP so the same file runs on Linux and Windows. One
transcription at a time; others wait for the lock (bounded by the client's
timeout).
"""

from __future__ import annotations

import base64
import binascii
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
MAX_CANDIDATES = 64
MAX_CANDIDATE_CHARS = 200
MAX_SCORE_BODY = MAX_BODY * 4 // 3 + 4 + MAX_CANDIDATES * (MAX_CANDIDATE_CHARS * 6 + 8) + 1024

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

    def score(self, pcm16: bytes, candidates: list[str], *, with_prompt: bool) -> list[dict[str, Any]]: ...


SCORE_BATCH = 16
FLOOR_LOGPROB = -23.0  # log(1e-10): a token the model rules out


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
        # KBLab's tokenizer.json ships BPE dropout 0.2, which makes every
        # encode() random: the prompt (and every scored candidate) would be
        # tokenized differently per request.
        bpe = self._model.hf_tokenizer.model
        if getattr(bpe, "dropout", None):
            bpe.dropout = None

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

    def score(self, pcm16: bytes, candidates: list[str], *, with_prompt: bool) -> list[dict[str, Any]]:
        """Teacher-forced log-probabilities of each candidate text for this audio.

        The audio is encoded once; every candidate is forced through the
        decoder with the same start sequence greedy decoding uses (optionally
        after the command prompt). Probabilities are over text tokens only,
        as in Whisper's word alignment.
        """
        import ctranslate2
        import numpy as np
        from faster_whisper.audio import pad_or_trim
        from faster_whisper.tokenizer import Tokenizer

        model = self._model
        audio = np.frombuffer(pcm16, dtype="<i2").astype(np.float32) / 32768.0
        features = model.feature_extractor(audio)
        num_frames = max(1, min(features.shape[-1] - 1, model.feature_extractor.nb_max_frames))
        # On the CPU side, so it can be replicated per candidate (a CUDA
        # StorageView has no numpy view); align() moves it back to the device.
        mel = np.ascontiguousarray(np.expand_dims(pad_or_trim(features), 0))
        encoded = np.asarray(model.model.encode(ctranslate2.StorageView.from_array(mel), to_cpu=True))
        tokenizer = Tokenizer(model.hf_tokenizer, model.model.is_multilingual, task="transcribe", language="sv")
        start: list[int] = []
        if with_prompt and self.initial_prompt:
            start = [tokenizer.sot_prev, *tokenizer.encode(" " + self.initial_prompt.strip())]
        start += [*tokenizer.sot_sequence, tokenizer.no_timestamps]
        # Special tokens (e.g. a literal "<|nospeech|>") are not text: drop them.
        tokens = [[t for t in tokenizer.encode(" " + c.strip()) if t < tokenizer.eot] for c in candidates]
        out: list[dict[str, Any]] = [{"tokens": 0, "sum_logprob": FLOOR_LOGPROB, "mean_logprob": FLOOR_LOGPROB,
                                      "min_logprob": FLOOR_LOGPROB} for _ in candidates]
        todo = [i for i, toks in enumerate(tokens) if toks]
        for start_at in range(0, len(todo), SCORE_BATCH):
            index = todo[start_at:start_at + SCORE_BATCH]
            chunk = [tokens[i] for i in index]
            batch = ctranslate2.StorageView.from_array(np.ascontiguousarray(np.repeat(encoded, len(chunk), axis=0)))
            results = model.model.align(batch, start, chunk, [num_frames] * len(chunk))
            for i, toks, result in zip(index, chunk, results):
                probs = np.asarray(result.text_token_probs, dtype=np.float64)
                logp = np.log(np.clip(probs, np.exp(FLOOR_LOGPROB), 1.0))
                out[i] = {"tokens": len(toks), "sum_logprob": float(logp.sum()), "mean_logprob": float(logp.mean()),
                          "min_logprob": float(logp.min())}
        return out


def parse_wav(body: bytes) -> bytes:
    try:
        with wave.open(io.BytesIO(body), "rb") as w:
            if (w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getcomptype()) != (1, 2, SAMPLE_RATE, "NONE"):
                raise ValueError("expected 16 kHz PCM16 mono WAV")
            return w.readframes(w.getnframes())
    except (wave.Error, EOFError, struct.error) as error:
        raise ValueError(f"invalid WAV: {error}") from error


def parse_score_request(body: bytes) -> tuple[bytes, list[str], bool]:
    """Validate a /v1/score body; returns (pcm16, candidates, with_prompt)."""
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeError, ValueError) as error:
        raise ValueError("body is not JSON") from error
    if not isinstance(data, dict):
        raise ValueError("body must be an object")
    candidates = data.get("candidates")
    if (not isinstance(candidates, list) or not 1 <= len(candidates) <= MAX_CANDIDATES
            or not all(isinstance(c, str) and c.strip() and len(c) <= MAX_CANDIDATE_CHARS for c in candidates)):
        raise ValueError(f"candidates must be 1..{MAX_CANDIDATES} non-empty strings of at most "
                         f"{MAX_CANDIDATE_CHARS} characters")
    prompt = data.get("prompt", False)
    if not isinstance(prompt, bool):
        raise ValueError("prompt must be true or false")
    audio = data.get("audio")
    if not isinstance(audio, str):
        raise ValueError("audio must be a base64 WAV string")
    try:
        wav = base64.b64decode(audio, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("audio is not valid base64") from error
    return parse_wav(wav), candidates, prompt


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
            if self.path not in ("/v1/transcribe", "/v1/score"):
                self._send(404, {"error": "not_found"})
                return
            if not self._authorized():
                self._send(401, {"error": "unauthorized"})
                return
            limit = MAX_BODY if self.path == "/v1/transcribe" else MAX_SCORE_BODY
            try:
                length = int(self.headers.get("content-length", "0"))
            except ValueError:
                length = -1
            if length <= 0 or length > limit:
                self.close_connection = True
                self._send(413 if length > limit else 400, {"error": "bad_length"})
                return
            body = self.rfile.read(length)
            candidates: list[str] = []
            prompt = False
            try:
                if self.path == "/v1/transcribe":
                    pcm = parse_wav(body)
                else:
                    pcm, candidates, prompt = parse_score_request(body)
            except ValueError as error:
                self._send(400, {"error": "bad_audio" if self.path == "/v1/transcribe" else "bad_request",
                                 "detail": str(error)})
                return
            started = time.monotonic()
            with lock:
                waited = time.monotonic() - started
                t0 = time.monotonic()
                try:
                    if self.path == "/v1/transcribe":
                        result = engine.transcribe(pcm)
                    else:
                        scores = engine.score(pcm, candidates, with_prompt=prompt)
                        result = {"scores": [{"text": c, **sc} for c, sc in zip(candidates, scores)],
                                  "prompt": prompt}
                except Exception as error:  # noqa: BLE001 - report, keep serving
                    log.exception("%s failed", self.path)
                    failed = "transcription_failed" if self.path == "/v1/transcribe" else "scoring_failed"
                    self._send(500, {"error": failed, "detail": type(error).__name__})
                    return
                processing = time.monotonic() - t0
            duration_ms = len(pcm) * 1000 // (SAMPLE_RATE * 2)
            if self.path == "/v1/transcribe":
                log.info("transcribed %d ms in %.0f ms (waited %.0f ms): %r", duration_ms, processing * 1000,
                         waited * 1000, result.get("text"))
            else:
                log.info("scored %d candidates on %d ms in %.0f ms (waited %.0f ms)", len(candidates),
                         duration_ms, processing * 1000, waited * 1000)
            self._send(200, {**result, "duration_ms": duration_ms, "processing_ms": int(processing * 1000),
                             "queue_ms": int(waited * 1000), "model": engine.name})

    return Handler


def make_server(host: str, port: int, engine: Engine, token: str | None = None) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), make_handler(engine, token))
    server.daemon_threads = True
    return server
