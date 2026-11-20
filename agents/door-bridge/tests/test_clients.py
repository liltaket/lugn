from __future__ import annotations

import base64
import json
import threading
import time
import urllib.request
from typing import Any

import pytest

from door_bridge import httpjson, lugn_client
from door_bridge.audio import pcm_to_wav, wav_to_pcm
from door_bridge.config import ConfigError, SttConfig, decode_env_secret, load_config, read_secret_file
from door_bridge.lugn_client import LugnClient, LugnError, voice_reason
from door_bridge.stt_client import SttClient, SttFailure
from stt_worker.server import make_server, parse_wav

GOOD = {"text": "Tänd taklampan.", "avg_logprob": -0.21, "no_speech_prob": 0.02, "language": "sv",
        "duration_ms": 900, "processing_ms": 300}


class Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def transport_for(behaviour: dict[str, Any], calls: list[str]) -> Any:
    def transport(method: str, url: str, **kwargs: Any) -> httpjson.Response:
        calls.append(url)
        b = behaviour[url.split("/v1")[0]]
        if b == "refuse":
            raise httpjson.HttpError("ConnectionRefusedError")
        if b == "500":
            return httpjson.Response(500, b"{}")
        if b == "garbage":
            return httpjson.Response(200, b"not json")
        if b == "slow":
            time.sleep(0.3)
        return httpjson.Response(200, json.dumps(GOOD).encode())

    return transport


async def test_failover_and_cooldown() -> None:
    calls: list[str] = []
    clock = Clock()
    cfg = SttConfig(workers=("http://worker-a:8790", "http://worker-b:8790"), failure_cooldown_s=60)
    stt = SttClient(cfg, transport=transport_for({"http://worker-a:8790": "refuse", "http://worker-b:8790": "ok"}, calls),
                    clock=clock)
    tr, attempts = await stt.transcribe(b"\x00\x00" * 1600, 16000)
    assert tr.worker == "http://worker-b:8790" and tr.text == "Tänd taklampan."
    assert [a["worker"] for a in attempts] == ["http://worker-a:8790", "http://worker-b:8790"]
    calls.clear()
    clock.t = 30  # worker-a is cooling down: worker-b goes first
    await stt.transcribe(b"\x00\x00" * 1600, 16000)
    assert calls == ["http://worker-b:8790/v1/transcribe"]
    calls.clear()
    clock.t = 100  # cooldown over: back to the configured order
    await stt.transcribe(b"\x00\x00" * 1600, 16000)
    assert calls[0] == "http://worker-a:8790/v1/transcribe"


@pytest.mark.parametrize("behaviour", ["refuse", "500", "garbage"])
async def test_all_workers_fail(behaviour: str) -> None:
    calls: list[str] = []
    stt = SttClient(SttConfig(workers=("http://a:1", "http://b:1")),
                    transport=transport_for({"http://a:1": behaviour, "http://b:1": behaviour}, calls))
    with pytest.raises(SttFailure) as info:
        await stt.transcribe(b"\x00\x00" * 160, 16000)
    assert len(info.value.attempts) == 2


async def test_budget_bounds_total_time() -> None:
    calls: list[str] = []
    stt = SttClient(SttConfig(workers=("http://a:1", "http://b:1", "http://c:1"), total_budget_s=0.4,
                              request_timeout_s=5),
                    transport=transport_for({"http://a:1": "slow", "http://b:1": "slow", "http://c:1": "slow"},
                                            calls))
    # slow (0.3 s) answers fit the budget; prove the budget caps a hung worker instead
    stt._transport = lambda *a, **k: (time.sleep(2), httpjson.Response(200, b"{}"))[1]  # type: ignore[assignment]
    t0 = time.monotonic()
    with pytest.raises(SttFailure):
        await stt.transcribe(b"\x00\x00" * 160, 16000)
    assert time.monotonic() - t0 < 1.0


async def test_no_workers() -> None:
    with pytest.raises(SttFailure, match="no_workers"):
        await SttClient(SttConfig()).transcribe(b"", 16000)


def test_confidence_gate() -> None:
    from door_bridge.stt_client import Transcript

    stt = SttClient(SttConfig(min_avg_logprob=-0.7, max_no_speech_prob=0.5))
    t = Transcript("Tänd", -0.2, 0.1, "sv", 1, "w", 1)
    assert stt.confident(t) == (True, "ok")
    assert stt.confident(Transcript(" ", -0.2, 0.1, "sv", 1, "w", 1))[1] == "empty_transcript"
    assert stt.confident(Transcript("x", -0.9, 0.1, "sv", 1, "w", 1))[1] == "low_avg_logprob"
    assert stt.confident(Transcript("x", -0.1, 0.8, "sv", 1, "w", 1))[1] == "no_speech_prob"


async def test_lugn_client_request_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}

    def fake(method: str, url: str, *, body: bytes | None, headers: dict[str, str], **kw: Any) -> httpjson.Response:
        seen.update(method=method, url=url, body=json.loads(body) if body else None, headers=headers, kw=kw)
        if url.endswith("/capabilities/lighting.adjust"):
            return httpjson.Response(400, b'{"error":"target_not_configured"}')
        return httpjson.Response(200, b'{"accepted":true}')

    monkeypatch.setattr(lugn_client.httpjson, "request", fake)
    client = LugnClient("http://127.0.0.1:8787/", "secret", timeout_s=2)
    out = await client.invoke("lighting.set", {"target": "lighting.ceiling", "values": {"power": True}},
                              request_id="voice-abc", reason=voice_reason("Tänd taklampan."))
    assert out == {"accepted": True}
    assert seen["url"] == "http://127.0.0.1:8787/capabilities/lighting.set"
    assert seen["headers"]["authorization"] == "Bearer secret"
    assert seen["body"] == {"input": {"target": "lighting.ceiling", "values": {"power": True}},
                            "requestId": "voice-abc", "reason": "röst: Tänd taklampan."}
    assert seen["kw"]["connect_timeout"] == 2
    with pytest.raises(LugnError) as info:
        await client.invoke("lighting.adjust", {})
    assert info.value.status == 400 and info.value.code == "target_not_configured"


async def test_lugn_client_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(lugn_client.httpjson, "request", lambda *a, **k: time.sleep(1.5))
    with pytest.raises(LugnError, match="timeout"):
        await LugnClient("http://127.0.0.1:8787", None, timeout_s=0.2).get_state()


def test_reason_is_bounded() -> None:
    assert len(voice_reason("a" * 1000)) == 256


def test_b64_token_matches_lugn_rule() -> None:
    encoded = base64.urlsafe_b64encode(b"token-123/+?").decode().rstrip("=")
    assert decode_env_secret("LUGN_TOKEN_B64", {"LUGN_TOKEN_B64": encoded}) == "token-123/+?"
    assert decode_env_secret("LUGN_TOKEN", {"LUGN_TOKEN": "plain"}) == "plain"
    with pytest.raises(ConfigError):
        decode_env_secret("X_B64", {"X_B64": "!!!"})
    with pytest.raises(ConfigError):
        decode_env_secret("MISSING", {})


def test_secret_file_forms(tmp_path: Any) -> None:
    yaml = tmp_path / "secrets.yaml"
    yaml.write_text('wifi_ssid: "x"\napi_encryption_key: "abc+def="  # note\n')
    assert read_secret_file(str(yaml), "api_encryption_key") == "abc+def="
    bare = tmp_path / "key"
    bare.write_text("abc+def=\n")
    assert read_secret_file(str(bare), "api_encryption_key") == "abc+def="


def test_config_example_loads_and_rejects_unknown(tmp_path: Any) -> None:
    from pathlib import Path

    example = Path(__file__).resolve().parent.parent / "config.example.toml"
    cfg = load_config(example)
    assert cfg.lugn.url == "http://127.0.0.1:8787" and cfg.stt.workers
    assert load_config(example, dry_run=True).voice.dry_run is True
    bad = tmp_path / "bad.toml"
    bad.write_text("[voice]\nmax_utterance = 5\n")
    with pytest.raises(ConfigError, match="unknown keys"):
        load_config(bad)
    bad.write_text('[lugn]\ntimeout_s = "2"\n')
    with pytest.raises(ConfigError):
        load_config(bad)
    from door_bridge.config import RescoreConfig

    assert cfg.rescore == RescoreConfig()  # the example documents the defaults
    bad.write_text("[rescore]\nmargin = 1.0\nopposite_margin = 0.5\n")
    with pytest.raises(ConfigError, match="rescore"):
        load_config(bad)


def test_wav_roundtrip() -> None:
    pcm = b"\x01\x00\xff\x7f" * 100
    assert wav_to_pcm(pcm_to_wav(pcm)) == (pcm, 16000)
    assert parse_wav(pcm_to_wav(pcm)) == pcm
    with pytest.raises(ValueError):
        parse_wav(pcm_to_wav(pcm, 44100))
    with pytest.raises(ValueError):
        parse_wav(b"garbage")


class FakeEngine:
    name, device, compute_type = "fake", "cpu", "int8"

    def __init__(self) -> None:
        self.seen: list[int] = []

    def transcribe(self, pcm16: bytes) -> dict[str, Any]:
        self.seen.append(len(pcm16))
        return {"text": "Släck allt.", "avg_logprob": -0.3, "no_speech_prob": 0.01, "language": "sv"}

    def score(self, pcm16: bytes, candidates: list[str], *, with_prompt: bool) -> list[dict[str, Any]]:
        self.seen.append(len(pcm16))
        self.scored = (candidates, with_prompt)
        return [{"tokens": len(c), "sum_logprob": -0.1 * i * len(c), "mean_logprob": -0.1 * i, "min_logprob": -0.2 * i}
                for i, c in enumerate(candidates)]


@pytest.fixture
def worker() -> Any:
    engine = FakeEngine()
    server = make_server("127.0.0.1", 0, engine, token="tok")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}", engine
    server.shutdown()
    server.server_close()


def test_worker_endpoints(worker: Any) -> None:
    base, engine = worker
    health = json.loads(urllib.request.urlopen(base + "/health", timeout=2).read())
    assert health["status"] == "ok" and health["model"] == "fake"
    wav = pcm_to_wav(b"\x00\x00" * 16000)
    resp = httpjson.request("POST", base + "/v1/transcribe", body=wav,
                            headers={"content-type": "audio/wav", "authorization": "Bearer tok"},
                            connect_timeout=1, read_timeout=2)
    data = resp.json()
    assert resp.status == 200 and data["text"] == "Släck allt." and data["duration_ms"] == 1000
    assert engine.seen == [32000]
    unauth = httpjson.request("POST", base + "/v1/transcribe", body=wav, headers={}, connect_timeout=1,
                              read_timeout=2)
    assert unauth.status == 401
    bad = httpjson.request("POST", base + "/v1/transcribe", body=b"RIFFjunk",
                           headers={"authorization": "Bearer tok"}, connect_timeout=1, read_timeout=2)
    assert bad.status == 400


async def test_stt_client_against_worker(worker: Any) -> None:
    base, _ = worker
    stt = SttClient(SttConfig(workers=("http://127.0.0.1:9", base)), token="tok")
    tr, attempts = await stt.transcribe(b"\x00\x00" * 8000, 16000)
    assert tr.text == "Släck allt." and tr.worker == base and tr.processing_ms is not None
    assert "error" in attempts[0]


def score_body(candidates: Any, *, prompt: Any = False, audio: Any = None) -> bytes:
    if audio is None:
        audio = base64.b64encode(pcm_to_wav(b"\x00\x00" * 8000)).decode()
    return json.dumps({"audio": audio, "candidates": candidates, "prompt": prompt}).encode()


def test_worker_score_endpoint(worker: Any) -> None:
    base, engine = worker
    auth = {"content-type": "application/json", "authorization": "Bearer tok"}

    def post(body: bytes, headers: dict[str, str] = auth) -> httpjson.Response:
        return httpjson.request("POST", base + "/v1/score", body=body, headers=headers, connect_timeout=1,
                                read_timeout=2)

    resp = post(score_body(["Tänd taklampan.", "Sen ta flampan."], prompt=True))
    data = resp.json()
    assert resp.status == 200 and data["duration_ms"] == 500 and data["prompt"] is True
    assert [s["text"] for s in data["scores"]] == ["Tänd taklampan.", "Sen ta flampan."]
    assert data["scores"][1]["mean_logprob"] == -0.1 and "processing_ms" in data
    assert engine.scored == (["Tänd taklampan.", "Sen ta flampan."], True)
    assert post(score_body(["x"]), headers={}).status == 401
    for bad in (score_body([]), score_body([""]), score_body(["x" * 201]), score_body(["x"] * 65),
                score_body("x"), score_body(["x"], prompt="yes"), score_body(["x"], audio="!!"),
                score_body(["x"], audio=base64.b64encode(b"RIFFjunk").decode()), b"not json", b"[]"):
        resp = post(bad)
        assert resp.status == 400 and resp.json()["error"] == "bad_request", bad[:60]


async def test_stt_client_score(worker: Any) -> None:
    base, _ = worker
    stt = SttClient(SttConfig(workers=("http://127.0.0.1:9", base)), token="tok")
    result = await stt.score(b"\x00\x00" * 8000, 16000, ["a", "b", "c"], prefer=base, prompt=False, budget_s=3)
    assert result.scores == [0.0, -0.1, -0.2] and result.worker == base
    assert [a["worker"] for a in result.attempts] == [base]  # the transcribing worker goes first


async def test_stt_client_score_old_worker_and_failover() -> None:
    calls: list[str] = []
    good = {"scores": [{"text": "a", "mean_logprob": -0.5}], "processing_ms": 40}

    def transport(method: str, url: str, **kwargs: Any) -> httpjson.Response:
        calls.append(url)
        body = json.loads(kwargs["body"])
        assert body["candidates"] == ["a"] and base64.b64decode(body["audio"])[:4] == b"RIFF"
        if url.startswith("http://old"):
            return httpjson.Response(404, b'{"error": "not_found"}')
        if url.startswith("http://bad"):
            return httpjson.Response(200, json.dumps({"scores": [{"text": "a", "mean_logprob": 1.0}]}).encode())
        return httpjson.Response(200, json.dumps(good).encode())

    cfg = SttConfig(workers=("http://old:1", "http://bad:1", "http://new:1"))
    stt = SttClient(cfg, transport=transport)
    result = await stt.score(b"\x00\x00" * 160, 16000, ["a"], prefer="http://old:1", prompt=False, budget_s=2)
    assert result.scores == [-0.5] and result.worker == "http://new:1" and result.processing_ms == 40
    assert [a.get("error") for a in result.attempts] == ["unsupported", "malformed score response: score out of range",
                                                         None]
    only_old = SttClient(SttConfig(workers=("http://old:1",)), transport=transport)
    with pytest.raises(SttFailure) as failure:
        await only_old.score(b"\x00\x00" * 160, 16000, ["a"], prefer="http://old:1", prompt=False, budget_s=2)
    assert failure.value.reason == "no_worker_scored"
    # an old worker is not put in cooldown (its transcriptions still count); a broken one is
    assert "http://old:1" not in stt._failed_at and "http://bad:1" in stt._failed_at
