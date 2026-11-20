from __future__ import annotations

import asyncio
import json
import time
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from conftest import FakeLugn, FakePlayer, FakeStt, FakeTransport, chunks, silence, tone
from door_bridge import httpjson
from door_bridge.config import LugnConfig, RescoreConfig, SttConfig, VoiceConfig
from door_bridge.executor import Executor
from door_bridge.stt_client import SttClient
from door_bridge.voice import Journal, VoicePipeline, VoiceRun

UTTERANCE = silence(600) + tone(700, -20) + silence(100) + tone(300, -22) + silence(900)


def make(tmp_path: Path, *, stt: Any = None, lugn: FakeLugn | None = None, transport: FakeTransport | None = None,
         rescore: RescoreConfig | None = None, **voice: Any) -> tuple[VoicePipeline, FakeTransport, FakeLugn, FakePlayer, Any]:
    cfg = replace(VoiceConfig(journal_path=str(tmp_path / "voice.jsonl")), **voice)
    transport = transport or FakeTransport()
    lugn = lugn or FakeLugn()
    stt = stt or FakeStt()
    player = FakePlayer()
    pipeline = VoicePipeline(cfg=cfg, transport=transport, stt=stt, stt_confident=stt.confident,
                             executor=Executor(lugn, LugnConfig()), earcons=player,
                             journal=Journal(cfg.journal_path, cfg.journal_max_bytes), rescore=rescore)
    return pipeline, transport, lugn, player, stt


async def start(pipeline: VoicePipeline) -> VoiceRun:
    port = await pipeline.handle_start("conv", 0, None, "okay_nabu")
    assert port == 0
    run = pipeline.active
    assert run is not None
    await asyncio.sleep(0)
    return run


async def speak(pipeline: VoicePipeline, pcm: bytes) -> None:
    for c in chunks(pcm):
        await pipeline.handle_audio(c, None)


def journal(tmp_path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in (tmp_path / "voice.jsonl").read_text().splitlines()]


def run_ends(t: FakeTransport) -> int:
    return t.names().count("RUN_END")


async def test_happy_path(tmp_path: Path) -> None:
    pipeline, t, lugn, player, stt = make(tmp_path)
    run = await start(pipeline)
    await speak(pipeline, UTTERANCE)
    await run.wait()
    assert t.names() == ["RUN_START", "STT_START", "STT_VAD_START", "STT_VAD_END", "STT_END",
                         "INTENT_START", "INTENT_END", "RUN_END"]
    assert lugn.calls == [("lighting.set", {"target": "lighting.ceiling", "values": {"power": True}},
                           f"voice-{run.id}", "röst: Tänd taklampan.")]
    assert player.played == ["ok"]
    rec = journal(tmp_path)
    assert len(rec) == 1 and rec[0]["outcome"] == "done" and rec[0]["intent"]["action"] == "ceiling.on"
    assert rec[0]["endpoint"]["end_reason"] == "speech_end"
    assert rec[0]["run_end"] == {"sent": True}
    assert pipeline.active is None
    # STT got the speech, trimmed of leading silence beyond 300 ms, not the whole stream
    assert 0 < len(stt.calls[0]) < len(UTTERANCE)


async def test_late_audio_after_vad_end_is_ignored(tmp_path: Path) -> None:
    pipeline, t, *_ = make(tmp_path, stt=FakeStt(delay=0.05))
    run = await start(pipeline)
    await speak(pipeline, UTTERANCE)
    await speak(pipeline, tone(500, -10))
    await run.wait()
    assert t.names().count("STT_VAD_START") == 1
    assert run_ends(t) == 1


async def test_worker_timeout_ends_run_once(tmp_path: Path) -> None:
    def slow_transport(*args: Any, **kwargs: Any) -> httpjson.Response:
        time.sleep(0.5)
        raise httpjson.HttpError("timed out")

    stt = SttClient(SttConfig(workers=("http://a:1", "http://b:1"), request_timeout_s=0.1, total_budget_s=0.3),
                    transport=slow_transport)
    pipeline, t, lugn, player, _ = make(tmp_path, stt=stt)
    run = await start(pipeline)
    await speak(pipeline, UTTERANCE)
    await run.wait()
    assert t.names()[-2:] == ["ERROR", "RUN_END"]
    assert run_ends(t) == 1
    assert lugn.calls == []
    assert player.played == ["error"]
    rec = journal(tmp_path)[0]
    assert rec["outcome"] == "stt_unavailable"
    assert rec["stt"]["attempts"][0]["error"] == "timeout"


async def test_hanging_stt_hits_run_timeout(tmp_path: Path) -> None:
    pipeline, t, lugn, player, _ = make(tmp_path, stt=FakeStt(hang=True), run_timeout_s=0.5)
    run = await start(pipeline)
    await speak(pipeline, UTTERANCE)
    await run.wait()
    assert journal(tmp_path)[0]["outcome"] == "run_timeout"
    assert run_ends(t) == 1 and player.played == ["error"] and lugn.calls == []


async def test_disconnect_while_listening(tmp_path: Path) -> None:
    pipeline, t, lugn, player, stt = make(tmp_path)
    run = await start(pipeline)
    await speak(pipeline, silence(200) + tone(400, -20))
    t.connected = False
    pipeline.on_disconnect()
    await speak(pipeline, silence(1000))  # stray audio after the drop
    await run.wait()
    assert run.finished and pipeline.active is None
    assert stt.calls == [] and lugn.calls == []
    rec = journal(tmp_path)
    assert len(rec) == 1
    assert rec[0]["outcome"] == "disconnected"
    assert rec[0]["run_end"] == {"sent": False, "skipped": "disconnected"}
    assert run_ends(t) == 0
    assert player.played == ["error"]


async def test_disconnect_during_transcription(tmp_path: Path) -> None:
    pipeline, t, lugn, player, stt = make(tmp_path, stt=FakeStt(hang=True))
    run = await start(pipeline)
    await speak(pipeline, UTTERANCE)
    for _ in range(5):
        await asyncio.sleep(0)
    assert stt.calls, "transcription should have started"
    t.connected = False
    pipeline.on_disconnect()
    pipeline.on_disconnect()  # repeated callbacks are harmless
    await run.wait()
    assert lugn.calls == []
    assert [r["outcome"] for r in journal(tmp_path)] == ["disconnected"]


async def test_no_speech(tmp_path: Path) -> None:
    pipeline, t, lugn, player, stt = make(tmp_path)
    run = await start(pipeline)
    await speak(pipeline, silence(3200))
    await run.wait()
    assert t.names() == ["RUN_START", "STT_START", "STT_VAD_END", "RUN_END"]
    assert stt.calls == [] and player.played == []
    assert journal(tmp_path)[0]["outcome"] == "no_speech"


async def test_audio_stall_is_bounded(tmp_path: Path) -> None:
    pipeline, t, *_ = make(tmp_path, max_utterance_ms=300, no_speech_timeout_ms=200)
    run = await start(pipeline)
    t0 = time.monotonic()
    await run.wait()  # no audio at all
    assert time.monotonic() - t0 < 3
    rec = journal(tmp_path)[0]
    assert rec["audio_stalled"] is True and rec["outcome"] == "no_speech"
    assert run_ends(t) == 1


async def test_low_confidence_never_acts(tmp_path: Path) -> None:
    pipeline, t, lugn, player, _ = make(tmp_path, stt=FakeStt("Tänd taklampan.", logprob=-1.4))
    run = await start(pipeline)
    await speak(pipeline, UTTERANCE)
    await run.wait()
    assert lugn.calls == [] and player.played == ["not_understood"]
    rec = journal(tmp_path)[0]
    assert rec["outcome"] == "low_confidence" and rec["rejected"] == "low_avg_logprob"
    assert "INTENT_START" not in t.names() and run_ends(t) == 1


async def test_unknown_command(tmp_path: Path) -> None:
    pipeline, t, lugn, player, _ = make(tmp_path, stt=FakeStt("Släck inte lampan."))
    run = await start(pipeline)
    await speak(pipeline, UTTERANCE)
    await run.wait()
    assert lugn.calls == [] and player.played == ["not_understood"]
    assert journal(tmp_path)[0]["intent"]["reason"] == "negation"


RESCORE = RescoreConfig(min_logprob=-1.0, margin=1.0, opposite_margin=2.0, refusal_margin=2.0, free_text_margin=0.5)


async def voice_run(tmp_path: Path, stt: FakeStt, **kw: Any) -> tuple[FakeTransport, FakeLugn, FakePlayer,
                                                                       dict[str, Any]]:
    pipeline, t, lugn, player, _ = make(tmp_path, stt=stt, rescore=RESCORE, **kw)
    run = await start(pipeline)
    await speak(pipeline, UTTERANCE)
    await run.wait()
    return t, lugn, player, journal(tmp_path)[0]


async def test_rescore_recovers_a_distant_command(tmp_path: Path) -> None:
    stt = FakeStt("Sen ta flampan.", scores={"Tänd taklampan.": -0.4, "Sen ta flampan.": -0.6,
                                              "Släck taklampan.": -3.1, "Tänd allt.": -2.5})
    t, lugn, player, rec = await voice_run(tmp_path, stt)
    assert lugn.calls == [("lighting.set", {"target": "lighting.ceiling", "values": {"power": True}},
                           lugn.calls[0][2], "röst: Tänd taklampan. (hört: Sen ta flampan.)")]
    assert player.played == ["ok"] and rec["outcome"] == "done"
    assert rec["transcript"] == "Sen ta flampan."
    assert rec["intent"] == {"normalized": "sen ta flampan", "reason": "no_match", "action": "ceiling.on",
                             "source": "rescore"}
    r = rec["rescore"]
    assert r["trigger"] == "no_match" and r["accepted"] is True and r["reason"] == "accepted"
    assert r["best"]["phrase"] == "Tänd taklampan." and r["runner_up"]["action"] == "scene.all_on"
    assert r["margins"] == {"runner_up": 2.1, "opposite": 2.7, "refusal": 5.6, "free_text": 0.2}
    assert r["worker"] == "http://w" and "rescore_end" in rec["ms"]
    candidates, prefer, prompt = stt.score_calls[0]
    assert candidates[-1] == "Sen ta flampan." and prefer == "http://w" and prompt is False
    assert t.names().count("INTENT_START") == 1 and t.names()[-2:] == ["INTENT_END", "RUN_END"]


async def test_rescore_rejects_a_close_opposite(tmp_path: Path) -> None:
    stt = FakeStt("Sen ta flampan.", scores={"Tänd taklampan.": -0.5, "Släck taklampan.": -1.9})
    _, lugn, player, rec = await voice_run(tmp_path, stt)
    assert lugn.calls == [] and player.played == ["not_understood"] and rec["outcome"] == "not_understood"
    assert rec["intent"]["action"] is None
    assert rec["rescore"]["reason"] == "opposite_too_close" and rec["rescore"]["accepted"] is False
    assert rec["rescore"]["opposite"] == {"action": "ceiling.off", "score": -1.9}


async def test_rescore_rejects_a_lost_negation(tmp_path: Path) -> None:
    stt = FakeStt("Släck in lampan.", scores={"Släck lampan.": -0.6, "Släck inte lampan.": -0.9,
                                               "Släck in lampan.": -0.8})
    _, lugn, _, rec = await voice_run(tmp_path, stt)
    assert lugn.calls == [] and rec["outcome"] == "not_understood"
    assert rec["rescore"]["reason"] == "refusal_too_close" and rec["rescore"]["refusal_score"] == -0.9


async def test_rescore_rejects_speech_that_is_not_a_command(tmp_path: Path) -> None:
    said = "Jag tänkte att vi kunde äta middag sen."
    stt = FakeStt(said, scores={said: -0.2, "Tänd allt.": -0.9})
    _, lugn, _, rec = await voice_run(tmp_path, stt)
    assert lugn.calls == [] and rec["outcome"] == "not_understood"
    assert rec["rescore"]["reason"] == "free_text_better" and rec["rescore"]["free_text_score"] == -0.2


async def test_rescore_confirms_a_low_confidence_match(tmp_path: Path) -> None:
    stt = FakeStt("Släck lampan!", logprob=-0.9, scores={"Släck lampan!": -0.3, "Tänd lampan.": -3.0})
    _, lugn, _, rec = await voice_run(tmp_path, stt)
    assert rec["outcome"] == "done" and rec["rejected"] == "low_avg_logprob"
    assert lugn.calls[0][1] == {"target": "lighting.ceiling", "values": {"power": False}}
    assert rec["rescore"]["trigger"] == "low_confidence"


async def test_rescore_low_confidence_reject_keeps_the_outcome(tmp_path: Path) -> None:
    stt = FakeStt("Snyggt av trampan.", logprob=-1.2, scores={"Snyggt av trampan.": -0.3})
    _, lugn, player, rec = await voice_run(tmp_path, stt)
    assert lugn.calls == [] and player.played == ["not_understood"]
    assert rec["outcome"] == "low_confidence" and rec["rescore"]["reason"] == "below_floor"


async def test_rescore_never_runs_on_refusals_or_no_speech(tmp_path: Path) -> None:
    for i, stt in enumerate([FakeStt("Släck inte lampan."), FakeStt("Vad är klockan?"), FakeStt("<|nospeech|>"),
                             FakeStt("Tänd taklampan.", no_speech=0.9)]):
        directory = tmp_path / str(i)
        directory.mkdir()
        _, lugn, _, rec = await voice_run(directory, stt)
        assert stt.score_calls == [] and lugn.calls == [] and "rescore" not in rec


async def test_rescore_unavailable_is_a_miss(tmp_path: Path) -> None:
    stt = FakeStt("Sen ta flampan.", score_fail=True)
    _, lugn, player, rec = await voice_run(tmp_path, stt)
    assert lugn.calls == [] and player.played == ["not_understood"] and rec["outcome"] == "not_understood"
    assert rec["rescore"]["reason"] == "unavailable" and rec["rescore"]["accepted"] is False


async def test_rescore_off_by_default(tmp_path: Path) -> None:
    stt = FakeStt("Sen ta flampan.", scores={"Tänd taklampan.": -0.1})
    pipeline, _, lugn, _, _ = make(tmp_path, stt=stt)
    run = await start(pipeline)
    await speak(pipeline, UTTERANCE)
    await run.wait()
    assert stt.score_calls == [] and lugn.calls == []


async def test_dry_run_never_calls_lugn(tmp_path: Path) -> None:
    pipeline, t, lugn, player, _ = make(tmp_path, dry_run=True)
    run = await start(pipeline)
    await speak(pipeline, UTTERANCE)
    await run.wait()
    assert lugn.calls == []
    rec = journal(tmp_path)[0]
    assert rec["outcome"] == "dry_run" and rec["dry_run"] is True
    assert rec["planned"] == {"capability": "lighting.set",
                              "input": {"target": "lighting.ceiling", "values": {"power": True}}}


async def test_lugn_failure(tmp_path: Path) -> None:
    pipeline, t, lugn, player, _ = make(tmp_path, lugn=FakeLugn(fail="target_not_configured"))
    run = await start(pipeline)
    await speak(pipeline, UTTERANCE)
    await run.wait()
    rec = journal(tmp_path)[0]
    assert rec["outcome"] == "lugn_failed" and rec["lugn"]["error"] == "target_not_configured"
    # The command was understood (tone at once), then Lugn failed (error tone).
    assert player.played == ["ok", "error"] and t.names()[-2:] == ["ERROR", "RUN_END"]


async def test_exception_still_ends_run(tmp_path: Path) -> None:
    pipeline, t, lugn, player, _ = make(tmp_path)

    async def explode(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("bug")

    pipeline.executor.execute = explode  # type: ignore[method-assign]
    run = await start(pipeline)
    await speak(pipeline, UTTERANCE)
    await run.wait()
    rec = journal(tmp_path)[0]
    assert rec["outcome"] == "exception" and "bug" in rec["error"]
    assert run_ends(t) == 1


async def test_superseded_run_does_not_end_the_new_one(tmp_path: Path) -> None:
    pipeline, t, lugn, player, _ = make(tmp_path)
    first = await start(pipeline)
    await speak(pipeline, silence(300))
    second = await start(pipeline)
    assert first.finished and not second.finished
    assert run_ends(t) == 0  # a RUN_END now would stop the node's new run
    await speak(pipeline, UTTERANCE)
    await second.wait()
    await first.wait()
    assert run_ends(t) == 1
    assert [r["outcome"] for r in journal(tmp_path)] == ["superseded", "done"]


async def test_device_stop_and_audio_end(tmp_path: Path) -> None:
    pipeline, t, *_ = make(tmp_path)
    run = await start(pipeline)
    await speak(pipeline, tone(400, -20))
    await pipeline.handle_stop(True)
    await run.wait()
    assert journal(tmp_path)[0]["outcome"] == "device_stop" and run_ends(t) == 1

    run = await start(pipeline)
    await speak(pipeline, silence(100) + tone(500, -20))
    await pipeline.handle_stop(False)  # the node ended the stream itself
    await run.wait()
    assert journal(tmp_path)[1]["outcome"] == "done" and run_ends(t) == 2


async def test_shutdown_finishes_active_run(tmp_path: Path) -> None:
    pipeline, t, *_ = make(tmp_path)
    await start(pipeline)
    await pipeline.close()
    assert journal(tmp_path)[0]["outcome"] == "shutdown"


@pytest.mark.parametrize("text,volume,expected", [
    ("Höj volymen", 0.30, ("music.setVolume", {"target": "music.room", "volume": 0.35})),
    ("Sänk volymen", 0.30, ("music.setVolume", {"target": "music.room", "volume": 0.25})),
    ("Sänk volymen", 0.02, ("music.setVolume", {"target": "music.room", "volume": 0.0})),
    ("Höj volymen", 0.58, ("music.setVolume", {"target": "music.room", "volume": 0.6})),
    ("Höj volymen", 0.60, None),
    ("Höj volymen", None, None),
    ("Volym 30 procent", 0.5, ("music.setVolume", {"target": "music.room", "volume": 0.3})),
    ("Volym 80 procent", 0.5, None),
])
async def test_volume_execution(tmp_path: Path, text: str, volume: float | None,
                                expected: tuple[str, dict[str, Any]] | None) -> None:
    lugn = FakeLugn(volume=volume)
    pipeline, t, _, player, _ = make(tmp_path, stt=FakeStt(text), lugn=lugn)
    run = await start(pipeline)
    await speak(pipeline, UTTERANCE)
    await run.wait()
    writes = [(n, i) for n, i, *_ in lugn.calls if n != "music.getState"]
    assert writes == ([expected] if expected else [])
    assert player.played == (["ok"] if expected else ["ok", "error"])


async def test_ambient_floor_is_raised_by_stream_gain(tmp_path: Path) -> None:
    # Measured on the node: the level sensor (gain 1) reads about -43 dBFS while
    # the amplified voice stream carries the same room noise about 12-18 dB
    # higher. Without the gain offset that noise would count as speech.
    room = tone(3500, -43 + VoiceConfig().stream_gain_db, freq=1000.0)
    pipeline, t, lugn, _, stt = make(tmp_path, transport=FakeTransport(floor=-43.0))
    run = await start(pipeline)
    cfg = VoiceConfig()
    assert run.endpointer.threshold_dbfs == pytest.approx(-43.0 + cfg.stream_gain_db + cfg.speech_margin_db)
    await speak(pipeline, room)
    await run.wait()
    assert stt.calls == [] and lugn.calls == []
    assert journal(tmp_path)[0]["outcome"] == "no_speech"
    assert run_ends(t) == 1


async def test_weak_speech_goes_to_stt(tmp_path: Path) -> None:
    # Distant speech: short bursts above the threshold but never min_speech_ms
    # in a row. STT gets the whole buffer; its gates and the grammar decide.
    burst = tone(90, -30) + silence(120)
    pcm = silence(300) + burst * 6 + silence(2600)
    pipeline, t, lugn, _, stt = make(tmp_path)
    run = await start(pipeline)
    await speak(pipeline, pcm)
    await run.wait()
    rec = journal(tmp_path)[0]
    assert rec["endpoint"]["end_reason"] == "no_speech"
    assert rec.get("weak_speech") is True
    assert len(stt.calls) == 1 and rec["outcome"] == "done"
    assert run_ends(t) == 1


async def test_silence_keeps_audio_without_stt(tmp_path: Path) -> None:
    pipeline, t, lugn, _, stt = make(tmp_path, keep_audio=2, audio_dir=str(tmp_path / "audio"))
    run = await start(pipeline)
    await speak(pipeline, silence(3500))
    await run.wait()
    assert stt.calls == [] and journal(tmp_path)[0]["outcome"] == "no_speech"
    assert len(list((tmp_path / "audio").glob("*.wav"))) == 1
