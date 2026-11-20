from dataclasses import replace

from conftest import chunks, silence, tone
from door_bridge.audio import frame_dbfs
from door_bridge.config import VoiceConfig
from door_bridge.endpointing import Endpointer

CFG = VoiceConfig()


def run(pcm: bytes, floor: float | None = -70.0, cfg: VoiceConfig = CFG, size: int = 1024) -> Endpointer:
    ep = Endpointer(cfg, floor)
    for c in chunks(pcm, size):
        if ep.feed(c):
            break
    return ep


def test_frame_level() -> None:
    assert abs(frame_dbfs(tone(30, -20)) - -20) < 0.3
    assert frame_dbfs(silence(30)) == -120.0
    assert frame_dbfs(b"") == -120.0


def test_end_after_hangover() -> None:
    ep = run(silence(300) + tone(1000, -25) + silence(2000))
    assert ep.end_reason == "speech_end"
    assert ep.speech_start_ms == 300
    # 300 ms lead + 1000 ms speech + 700 ms hangover
    assert 1990 <= ep.audio_ms <= 2040


def test_short_pause_inside_speech_does_not_end() -> None:
    ep = run(tone(600, -25) + silence(500) + tone(600, -25) + silence(1000))
    assert ep.end_reason == "speech_end"
    assert ep.audio_ms >= 600 + 500 + 600 + 700 - 30


def test_click_is_not_speech() -> None:
    ep = run(silence(200) + tone(60, -10) + silence(3500))
    assert ep.speech_start_ms is None
    assert ep.end_reason == "no_speech"
    assert ep.audio_ms == 3000


def test_no_speech_timeout() -> None:
    ep = run(silence(5000))
    assert ep.end_reason == "no_speech" and ep.audio_ms == 3000


def test_max_utterance() -> None:
    ep = run(tone(8000, -25))
    assert ep.end_reason == "max_utterance" and ep.audio_ms == 6000


def test_threshold_follows_ambient_floor() -> None:
    # Speech at -40 dBFS in a -60 room is speech; the same level is noise in a -38 room.
    assert run(silence(700) + tone(800, -40) + silence(1000), floor=-60).end_reason == "speech_end"
    loud_room = run(tone(800, -40) + silence(3000), floor=-38)
    assert loud_room.speech_start_ms is None and loud_room.end_reason == "no_speech"


def test_min_threshold_without_floor() -> None:
    ep = Endpointer(CFG, None)
    assert ep.threshold_dbfs == max(CFG.min_speech_dbfs, -65 + CFG.speech_margin_db)


def test_noise_under_threshold() -> None:
    import random

    rng = random.Random(1)
    amp = int(32768 * 10 ** (-62 / 20) * 1.7)
    noise = b"".join(rng.randint(-amp, amp).to_bytes(2, "little", signed=True) for _ in range(16000 * 4))
    ep = run(noise, floor=-62)
    assert ep.end_reason == "no_speech"


def test_odd_chunk_sizes_are_equivalent() -> None:
    pcm = silence(250) + tone(900, -22) + silence(1200)
    a, b = run(pcm, size=1024), run(pcm, size=333)
    assert a.snapshot() == b.snapshot()


def test_finish_without_decision() -> None:
    ep = run(tone(400, -20), cfg=replace(CFG))
    assert ep.end_reason is None
    assert ep.finish() == "speech_end"
    ep2 = Endpointer(CFG, -70)
    assert ep2.finish() == "no_speech"


def test_speech_started_flag_fires_once() -> None:
    ep = Endpointer(CFG, -70)
    fired = 0
    for c in chunks(tone(1500, -20) + silence(1000)):
        ep.feed(c)
        fired += ep.speech_started_now
    assert fired == 1


def test_wake_word_tail_is_dropped_and_listening_goes_on() -> None:
    # The stream opens on the end of "Okay Nabu", then the user pauses and
    # speaks the command (measured: tail 0-0.5 s, silence, command after 0.9 s).
    pcm = tone(450, -28) + silence(900) + tone(700, -35) + silence(900)
    ep = run(pcm, floor=-55)
    assert ep.end_reason == "speech_end"
    assert ep.tail_ignored_ms is not None and ep.tail_ignored_ms <= 500
    assert ep.speech_start_ms is not None and ep.speech_start_ms >= 1300


def test_command_said_in_one_breath_with_the_wake_word_is_kept() -> None:
    pcm = silence(250) + tone(1200, -30) + silence(900)
    ep = run(pcm, floor=-55)
    assert ep.end_reason == "speech_end" and ep.tail_ignored_ms is None
    assert ep.speech_start_ms is not None and ep.speech_start_ms <= 300


def test_tail_alone_ends_as_no_speech_after_a_fresh_timeout() -> None:
    pcm = tone(450, -28) + silence(4000)
    ep = run(pcm, floor=-55)
    assert ep.end_reason == "no_speech" and ep.tail_ignored_ms is not None
    assert ep.audio_ms >= ep.tail_ignored_ms + CFG.no_speech_timeout_ms
