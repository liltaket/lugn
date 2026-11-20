"""Deterministic Swedish command grammar.

The whole (normalized) utterance must match one command pattern exactly; there
is no keyword spotting. A false action is worse than a miss, so anything with a
negation, a question, two commands, or an unknown word is rejected.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Literal, Union

# --- Typed actions ----------------------------------------------------------


@dataclass(frozen=True)
class CeilingPower:
    on: bool


@dataclass(frozen=True)
class ActivateScene:
    scene: Literal["all_on", "all_off", "soft", "everyday", "focus", "movie"]


@dataclass(frozen=True)
class BrightnessStep:
    direction: Literal[1, -1]


@dataclass(frozen=True)
class MusicPlayback:
    play: bool


@dataclass(frozen=True)
class VolumeStep:
    direction: Literal[1, -1]


@dataclass(frozen=True)
class VolumeSet:
    percent: int


Action = Union[CeilingPower, ActivateScene, BrightnessStep, MusicPlayback, VolumeStep, VolumeSet]


@dataclass(frozen=True)
class IntentResult:
    action: Action | None
    normalized: str
    reason: str  # "matched" or why nothing matched


def action_name(action: Action | None) -> str | None:
    if action is None:
        return None
    return {
        CeilingPower: lambda a: f"ceiling.{'on' if a.on else 'off'}",
        ActivateScene: lambda a: f"scene.{a.scene}",
        BrightnessStep: lambda a: f"brightness.{'up' if a.direction > 0 else 'down'}",
        MusicPlayback: lambda a: f"music.{'play' if a.play else 'pause'}",
        VolumeStep: lambda a: f"volume.{'up' if a.direction > 0 else 'down'}",
        VolumeSet: lambda a: f"volume.set.{a.percent}",
    }[type(action)](action)


# --- Normalization ------------------------------------------------------------

_UNITS = {
    "noll": 0, "en": 1, "ett": 1, "två": 2, "tre": 3, "fyra": 4, "fem": 5,
    "sex": 6, "sju": 7, "åtta": 8, "nio": 9, "tio": 10, "elva": 11, "tolv": 12,
    "tretton": 13, "fjorton": 14, "femton": 15, "sexton": 16, "sjutton": 17,
    "arton": 18, "nitton": 19,
}
_TENS = {
    "tjugo": 20, "tjugu": 20, "trettio": 30, "trettie": 30, "trette": 30,
    "fyrtio": 40, "förtio": 40, "förti": 40, "femtio": 50, "femti": 50,
    "sextio": 60, "sexti": 60, "sjuttio": 70, "sjutti": 70, "åttio": 80,
    "åtti": 80, "nittio": 90, "nitti": 90,
}
_HUNDRED = {"hundra", "etthundra"}

# Whisper and speakers inflect the verbs; map them to the imperative.
_WORD_VARIANTS = {
    "tända": "tänd", "tänder": "tänd", "tänt": "tänd", "tände": "tänd",
    "släcka": "släck", "släcker": "släck", "släckte": "släck",
    "tacklampan": "taklampan", "taktlampan": "taklampan",
    # Near-homophones Whisper produced for real commands in the smoke test.
    "parsa": "pausa", "missljus": "mysljus", "missljuset": "mysljuset", "taklampen": "taklampan", "taklamporna": "taklampan",
    "pausa": "pausa", "pausar": "pausa", "paus": "pausa",
    "spela": "spela", "spelar": "spela",
    "höja": "höj", "höjer": "höj",
    "sänka": "sänk", "sänker": "sänk",
    "öka": "öka", "ökar": "öka",
    "minska": "minska", "minskar": "minska",
    "sätta": "sätt", "sätter": "sätt",
    "slå": "slå", "slår": "slå",
    "stänga": "stäng", "stänger": "stäng",
    "starta": "starta", "startar": "starta",
    "stoppa": "stoppa", "stoppar": "stoppa",
    "ställa": "ställ", "ställer": "ställ",
    "aktivera": "aktivera", "aktiverar": "aktivera",
    "skruva": "skruva", "skruvar": "skruva",
    "procenten": "procent", "%": "procent",
    "volymer": "volymen",
    "ner": "ner", "ned": "ner",
    "mys": "mys", "myss": "mys",
}

# Prefix/suffix phrases that carry no command meaning.
_LEADING_FILLERS = (
    "okay nabu", "okej nabu", "ok nabu", "okej nabo", "okay nabo", "ok nabo", "nabu", "nabo",
    "hej jarvis", "hey jarvis", "hej jervis", "hej djarvis", "jarvis",
    "okej", "ok", "okay", "eh", "öh", "äh", "hmm", "snälla",
    "kan du", "kan ni", "skulle du kunna", "vill du", "var snäll och",
    "var så snäll och", "jag vill att du",
)
_TRAILING_FILLERS = ("tack", "snälla", "är du snäll", "tack så mycket", "lite", "nu", "då")
_POLITE_QUESTION_OPENERS = ("kan du", "kan ni", "skulle du kunna", "vill du")

_NEGATIONS = {"inte", "ej", "icke", "aldrig", "inga", "ingen", "inget", "sluta"}
_QUESTION_OPENERS = {
    "vad", "varför", "hur", "när", "vem", "vilken", "vilket", "vilka", "var",
    "är", "har", "finns", "blir", "ska", "kommer", "måste",
}

_PUNCT = re.compile(r"[^\w\s%]", re.UNICODE)


def normalize(text: str) -> str:
    """Lowercase, strip punctuation, map variants and number words."""
    t = unicodedata.normalize("NFC", text).lower().replace(" ", " ")
    t = t.replace("%", " procent ")
    t = _PUNCT.sub(" ", t)
    words = [_WORD_VARIANTS.get(w, w) for w in t.split()]
    return " ".join(_numbers_to_digits(words))


def _numbers_to_digits(words: list[str]) -> list[str]:
    out: list[str] = []
    i = 0
    while i < len(words):
        value, used = _parse_number(words, i)
        if used:
            out.append(str(value))
            i += used
        else:
            out.append(words[i])
            i += 1
    return out


def _parse_number(words: list[str], i: int) -> tuple[int, int]:
    """Parse a Swedish number word sequence starting at i (0..100)."""
    w = words[i]
    if w in _HUNDRED:
        return 100, 1
    compound = _split_compound(w)
    if compound is not None:
        return compound, 1
    if w in _TENS:
        value = _TENS[w]
        if i + 1 < len(words) and words[i + 1] in _UNITS and 1 <= _UNITS[words[i + 1]] <= 9:
            return value + _UNITS[words[i + 1]], 2
        return value, 1
    if w in _UNITS and w not in {"en", "ett"}:
        # "en"/"ett" stay words ("en lampa"); a bare "ett" is never a volume.
        return _UNITS[w], 1
    return 0, 0


def _split_compound(w: str) -> int | None:
    for tens_word, tens in _TENS.items():
        if w.startswith(tens_word) and w != tens_word:
            rest = w[len(tens_word):]
            if rest in _UNITS and 1 <= _UNITS[rest] <= 9:
                return tens + _UNITS[rest]
    return None


def _strip_fillers(t: str) -> str:
    changed = True
    while changed and t:
        changed = False
        for filler in sorted(_LEADING_FILLERS, key=len, reverse=True):
            if t == filler:
                return ""
            if t.startswith(filler + " "):
                t = t[len(filler) + 1:]
                changed = True
                break
        for filler in sorted(_TRAILING_FILLERS, key=len, reverse=True):
            if t.endswith(" " + filler):
                t = t[: -len(filler) - 1]
                changed = True
                break
    return t.strip()


# --- Grammar ------------------------------------------------------------------

_LAMP = r"(?:tak ?lampan|taklampa|lampan|lampa|ljuset|taket|lampan i taket|ljuset i taket|takbelysningen|takljuset)"
_ALL = r"(?:allt|alla lampor|alla lamporna|allt ljus|hela rummet|överallt|alla ljus)"
_MUSIC = r"(?:musiken|musik|låten|spotify)"
_VOLUME = r"(?:volymen|volym|ljudet)"
_ON_VERB = r"(?:tänd|tänd på|sätt på|slå på)"
_OFF_VERB = r"(?:släck|stäng av|slå av|släck ner)"
_SCENE_VERB = r"(?:(?:sätt på|aktivera|starta|välj|byt till|kör|tänd|slå på|ställ in)(?: scenen)? )?"
_SCENES: dict[str, str] = {
    "soft": r"(?:mysljus|mys ljus|mys|mysljuset|myslampor|myslägen|mysläge|mysbelysning)",
    "everyday": r"(?:vardagsljus|vardags ljus|vardagsljuset|vardagsläge)",
    "focus": r"(?:fokus|fokusljus|fokus ljus|fokusläge|fokusljuset)",
    "movie": r"(?:filmkväll|film kväll|filmläge|filmljus|filmkvällen|bio|biokväll)",
}
_NUM = r"(?P<n>\d{1,3})"

_PATTERNS: list[tuple[re.Pattern[str], object]] = []


def _p(pattern: str, action: object) -> None:
    _PATTERNS.append((re.compile(rf"^{pattern}$"), action))


_p(rf"{_ON_VERB} {_LAMP}", CeilingPower(True))
_p(rf"{_LAMP} på", CeilingPower(True))
_p(rf"tänd i taket", CeilingPower(True))
_p(rf"{_OFF_VERB} {_LAMP}", CeilingPower(False))
_p(rf"släckt {_LAMP}", CeilingPower(False))  # Whisper often writes "släckt" for "släck"
_p(rf"{_LAMP} av", CeilingPower(False))
_p(rf"släck i taket", CeilingPower(False))
_p(rf"(?:tänd|tänd på|sätt på|slå på) {_ALL}", ActivateScene("all_on"))
_p(rf"(?:släck|släck ner) {_ALL}", ActivateScene("all_off"))
_p(r"(?:helt släckt|allt släckt|gör det helt släckt)", ActivateScene("all_off"))
for _key, _pat in _SCENES.items():
    _p(rf"{_SCENE_VERB}{_pat}", ActivateScene(_key))  # type: ignore[arg-type]
_p(rf"(?:gör )?(?:{_LAMP} )?ljusare", BrightnessStep(1))
_p(rf"(?:mer ljus|höj ljuset|höj ljusstyrkan|öka ljuset|öka ljusstyrkan)", BrightnessStep(1))
_p(rf"(?:gör )?(?:{_LAMP} )?mörkare", BrightnessStep(-1))
_p(rf"(?:mindre ljus|sänk ljuset|sänk ljusstyrkan|minska ljuset|minska ljusstyrkan|dimma ljuset|dimma)", BrightnessStep(-1))
_p(rf"(?:pausa|stoppa|stäng av) {_MUSIC}", MusicPlayback(False))
_p(r"pausa", MusicPlayback(False))
_p(rf"(?:spela|starta|sätt på|fortsätt|fortsätt spela|spela upp|fortsätt med) {_MUSIC}", MusicPlayback(True))
_p(r"(?:spela|fortsätt spela)", MusicPlayback(True))
_p(rf"(?:höj|öka|skruva upp|höj upp) {_VOLUME}", VolumeStep(1))
_p(r"(?:skruva upp|högre|högre volym|mer ljud)", VolumeStep(1))
_p(rf"(?:sänk|minska|skruva ner|sänk ner) {_VOLUME}", VolumeStep(-1))
_p(r"(?:skruva ner|lägre|lägre volym|mindre ljud)", VolumeStep(-1))
_p(rf"(?:sätt |ställ |ändra |höj |sänk )?{_VOLUME} (?:till |på )?{_NUM}(?: procent)?", "volume_set")


def parse(text: str) -> IntentResult:
    """Map one transcript to at most one action."""
    raw = text.strip()
    normalized = normalize(raw)
    if not normalized:
        return IntentResult(None, normalized, "empty")
    stripped = _strip_fillers(normalized)
    if "?" in raw and not _is_polite_request(normalized):
        return IntentResult(None, normalized, "question")
    if not stripped:
        return IntentResult(None, normalized, "empty")
    words = stripped.split()
    if any(w in _NEGATIONS for w in words):
        return IntentResult(None, normalized, "negation")
    if words[0] in _QUESTION_OPENERS:
        return IntentResult(None, normalized, "question")
    if len(words) > 8:
        return IntentResult(None, normalized, "too_long")
    for pattern, action in _PATTERNS:
        match = pattern.match(stripped)
        if not match:
            continue
        if action == "volume_set":
            n = int(match.group("n"))
            if n > 100:
                return IntentResult(None, normalized, "volume_out_of_range")
            return IntentResult(VolumeSet(n), normalized, "matched")
        return IntentResult(action, normalized, "matched")  # type: ignore[arg-type]
    return IntentResult(None, normalized, "no_match")


def _is_polite_request(normalized: str) -> bool:
    """'Kan du tända lampan?' is a request, not a question."""
    words = normalized.split()
    while words and words[0] in {"hej", "hey", "jarvis", "nabu", "nabo", "okay", "snälla", "okej", "ok"}:
        words = words[1:]
    lead = " ".join(words)
    return any(lead.startswith(p + " ") for p in _POLITE_QUESTION_OPENERS)

