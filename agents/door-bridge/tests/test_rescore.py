from __future__ import annotations

import pytest

from door_bridge.config import RescoreConfig
from door_bridge.intents import COMMAND_PHRASES, OPPOSITES, REFUSAL_PHRASES, action_name, parse
from door_bridge.rescore import candidates, decide, phrases, should_rescore

CFG = RescoreConfig(min_logprob=-1.0, margin=1.0, opposite_margin=2.0, refusal_margin=2.0, free_text_margin=0.5)


def scores_for(free_text: str, values: dict[str, float], default: float = -6.0) -> list[float]:
    return [values.get(c, default) for c in candidates(free_text)]


def test_every_phrase_parses_to_its_action() -> None:
    for action, group in COMMAND_PHRASES.items():
        assert group, action
        for phrase in group:
            assert action_name(parse(phrase).action) == action, phrase


def test_refusals_never_act() -> None:
    for phrase in REFUSAL_PHRASES:
        assert parse(phrase).action is None and parse(phrase).reason == "negation", phrase


def test_opposites_and_volume_numbers() -> None:
    assert all(OPPOSITES[OPPOSITES[a]] == a for a in OPPOSITES)
    assert OPPOSITES["ceiling.on"] == "ceiling.off" and OPPOSITES["music.play"] == "music.pause"
    assert {f"volume.set.{n}" for n in range(10, 101, 10)} <= set(COMMAND_PHRASES)
    assert set(OPPOSITES) <= set(COMMAND_PHRASES)


def test_candidates_end_with_the_free_transcript_once() -> None:
    table = [p for _, p in phrases()] + list(REFUSAL_PHRASES)
    assert candidates("Sen ta flampan.") == [*table, "Sen ta flampan."]
    assert candidates(" Tänd taklampan. ") == table  # already a phrase


@pytest.mark.parametrize(("text", "reason", "expected"), [
    ("Sen ta flampan.", "ok", "no_match"),
    ("Snyggt av trampan.", "low_avg_logprob", "low_confidence"),
    ("Tänd taklampan.", "low_avg_logprob", "low_confidence"),
    ("Tänd taklampan.", "ok", None),  # the grammar already acted
    ("Släck inte lampan.", "ok", None),  # a negation is a refusal, not a miss
    ("Släck inte lampan.", "low_avg_logprob", None),
    ("Vad är klockan?", "ok", None),
    ("Okay Nabu.", "ok", None),  # wake-word tail only: empty after fillers
    ("<|nospeech|>", "ok", None),
    ("...", "ok", None),
    ("", "empty_transcript", None),
    ("Tänd taklampan.", "no_speech_prob", None),
])
def test_should_rescore(text: str, reason: str, expected: str | None) -> None:
    assert should_rescore(text, reason, parse(text)) == expected


def test_clear_winner_is_accepted() -> None:
    free = "Sen ta flampan."
    d = decide(CFG, free, parse(free), scores_for(free, {"Tänd taklampan.": -0.4, "Släck taklampan.": -3.0,
                                                         "Tänd allt.": -2.5, free: -0.6}))
    assert d.action == "ceiling.on" and d.phrase == "Tänd taklampan." and d.reason == "accepted"
    assert d.record["best"] == {"action": "ceiling.on", "phrase": "Tänd taklampan.", "score": -0.4}
    assert d.record["runner_up"] == {"action": "scene.all_on", "score": -2.5}
    assert d.record["opposite"] == {"action": "ceiling.off", "score": -3.0}
    assert d.record["margins"] == {"runner_up": 2.1, "opposite": 2.6, "refusal": 5.6, "free_text": 0.2}
    assert d.record["refusal_score"] == -6.0 and d.record["accepted"] is True


def test_opposite_twin_needs_the_stricter_margin() -> None:
    free = "Sen ta flampan."
    # 1.5 ahead of släck: enough against any other action, not against the twin.
    d = decide(CFG, free, parse(free), scores_for(free, {"Tänd taklampan.": -0.5, "Släck lampan.": -2.0}))
    assert d.action is None and d.reason == "opposite_too_close"
    assert d.record["margins"]["opposite"] == 1.5 and d.record["accepted"] is False


def test_a_lost_negation_is_not_an_action() -> None:
    free = "Släck in lampan."  # "Släck inte lampan." heard from across the room
    d = decide(CFG, free, parse(free), scores_for(free, {"Släck lampan.": -0.9, "Släck inte lampan.": -1.5,
                                                         "Tänd lampan.": -4.0, free: -1.0}))
    assert d.action is None and d.reason == "refusal_too_close"
    assert d.record["refusal_score"] == -1.5 and d.record["margins"]["refusal"] == 0.6


def test_runner_up_too_close() -> None:
    free = "Volym 3 procent."
    d = decide(CFG, free, parse(free), scores_for(free, {"Volym 30 procent.": -0.5, "Volym 40 procent.": -0.9}))
    assert d.action is None and d.reason == "runner_up_too_close"


def test_garbage_free_transcript_wins_and_rejects() -> None:
    free = "Jag tänkte att vi kunde äta middag sen."
    d = decide(CFG, free, parse(free), scores_for(free, {"Tänd allt.": -0.9, free: -0.2}))
    assert d.action is None and d.reason == "free_text_better"
    assert d.record["free_text_score"] == -0.2 and d.record["margins"]["free_text"] == -0.7


def test_below_floor() -> None:
    free = "Mmm."
    d = decide(CFG, free, parse(free), scores_for(free, {"Fokus.": -1.6}, default=-8.0))
    assert d.action is None and d.reason == "below_floor"


def test_low_confidence_match_counts_for_its_action() -> None:
    free = "Tänd lampan!"  # parses to ceiling.on but was below the confidence gate
    d = decide(CFG, free, parse(free), scores_for(free, {free: -0.3, "Tänd lampan.": -0.8, "Släck lampan.": -3.0}))
    assert d.action == "ceiling.on" and d.phrase == free
    assert d.record["free_text_score"] is None and d.record["margins"]["free_text"] is None


def test_score_count_mismatch_is_an_error() -> None:
    with pytest.raises(ValueError):
        decide(CFG, "x", parse("x"), [-1.0, -2.0])
