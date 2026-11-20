"""Closed-vocabulary rescoring: when free transcription misses, score the commands.

Free decoding of distant speech drifts to similar-sounding words ("Tänd
taklampan" -> "Sen ta flampan"). The command set is closed, so the worker can
instead force every canonical phrase (intents.COMMAND_PHRASES) through the
decoder and report how likely each one is for this audio. A phrase is only
acted on when it wins clearly: above an absolute floor, ahead of every other
action, further ahead of its opposite (tänd/släck) and of the negated commands
("släck inte lampan"), and not far behind what the model itself heard (the free
transcript, scored the same way). Anything else is a miss, never a guess.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .config import RescoreConfig
from .intents import COMMAND_PHRASES, OPPOSITES, REFUSAL_PHRASES, IntentResult, action_name

# Free transcripts that are a refusal on purpose are never rescored.
RESCORABLE_REASONS = ("no_match",)
NEG_INF = float("-inf")


def phrases() -> list[tuple[str, str]]:
    """(action name, phrase) in a stable order."""
    return [(action, phrase) for action, group in COMMAND_PHRASES.items() for phrase in group]


def should_rescore(text: str, confident_reason: str, intent: IntentResult) -> str | None:
    """Why this run gets rescored, or None.

    Only speech the model heard as words: never an empty or no-speech
    transcript (the `<|nospeech|>` marker included), never a negation,
    question, two commands or a too-long utterance.
    """
    stripped = text.strip()
    if not stripped or stripped.startswith("<|") or not any(ch.isalpha() for ch in stripped):
        return None
    if confident_reason == "ok":
        return "no_match" if intent.reason in RESCORABLE_REASONS else None
    if confident_reason == "low_avg_logprob" and intent.reason in (*RESCORABLE_REASONS, "matched"):
        return "low_confidence"
    return None


def candidates(free_text: str) -> list[str]:
    """Every phrase, the refusals, then the free transcript as its own competitor."""
    texts = [phrase for _, phrase in phrases()] + list(REFUSAL_PHRASES)
    free = free_text.strip()
    if free not in texts:
        texts.append(free)
    return texts


@dataclass(frozen=True)
class Decision:
    action: str | None
    phrase: str | None
    reason: str  # "accepted" or why not
    record: dict[str, Any]


def decide(cfg: RescoreConfig, free_text: str, intent: IntentResult, scores: list[float]) -> Decision:
    """Apply the acceptance rule to the worker's mean log-probabilities.

    `scores` lines up with `candidates(free_text)`. Each action scores its best
    phrase. The free transcript counts for its action when it parses to one
    (a low-confidence match), otherwise it is the "something else was said"
    competitor.
    """
    table = phrases()
    fixed = len(table) + len(REFUSAL_PHRASES)
    if len(scores) not in (fixed, fixed + 1):
        raise ValueError("score count does not match the candidates")
    best: dict[str, tuple[float, str]] = {}
    for (action, phrase), score in zip(table, scores):
        if action not in best or score > best[action][0]:
            best[action] = (score, phrase)
    refusal = max(scores[len(table):fixed])
    free = free_text.strip()
    free_action = action_name(intent.action)
    other_score = NEG_INF
    if len(scores) == fixed + 1:  # the free transcript is not itself a candidate
        free_score = scores[-1]
        if free_action is None:
            other_score = free_score
        elif free_action not in best or free_score > best[free_action][0]:
            # A low-confidence match, possibly outside the phrase list ("volym 35").
            best[free_action] = (free_score, free)
    ranked = sorted(best.items(), key=lambda item: -item[1][0])
    (top, (s1, phrase)), (second, (s2, _)) = ranked[0], ranked[1]
    opposite = OPPOSITES.get(top)
    s_opp = best[opposite][0] if opposite else NEG_INF
    record: dict[str, Any] = {
        "best": {"action": top, "phrase": phrase, "score": round(s1, 3)},
        "runner_up": {"action": second, "score": round(s2, 3)},
        "opposite": {"action": opposite, "score": round(s_opp, 3)} if opposite else None,
        "refusal_score": round(refusal, 3),
        "free_text_score": None if other_score == NEG_INF else round(other_score, 3),
        "margins": {
            "runner_up": round(s1 - s2, 3),
            "opposite": None if opposite is None else round(s1 - s_opp, 3),
            "refusal": round(s1 - refusal, 3),
            "free_text": None if other_score == NEG_INF else round(s1 - other_score, 3),
        },
    }
    if s1 < cfg.min_logprob:
        reason = "below_floor"
    elif s1 - s2 < cfg.margin:
        reason = "runner_up_too_close"
    elif opposite is not None and s1 - s_opp < cfg.opposite_margin:
        reason = "opposite_too_close"
    elif s1 - refusal < cfg.refusal_margin:
        reason = "refusal_too_close"
    elif other_score - s1 > cfg.free_text_margin:
        reason = "free_text_better"
    else:
        reason = "accepted"
    record["accepted"] = reason == "accepted"
    record["reason"] = reason
    if reason != "accepted":
        return Decision(None, None, reason, record)
    return Decision(top, phrase, reason, record)
