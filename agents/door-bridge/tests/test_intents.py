import pytest

from door_bridge.intents import action_name, normalize, parse

POSITIVE = [
    # ceiling light
    ("Tänd taklampan", "ceiling.on"),
    ("tänd taklampan.", "ceiling.on"),
    ("Tända taklampan", "ceiling.on"),
    ("Tände taklampan.", "ceiling.on"),
    ("Tänd tak lampan", "ceiling.on"),
    ("Tänd tacklampan", "ceiling.on"),
    ("Tänd taktlampan.", "ceiling.on"),
    ("Parsa musiken.", "music.pause"),
    ("Sätt på missljus.", "scene.soft"),
    ("Sätt på missljuset.", "scene.soft"),
    ("Tänd lampan", "ceiling.on"),
    ("Tänd ljuset!", "ceiling.on"),
    ("Tänd taket", "ceiling.on"),
    ("Tänd i taket", "ceiling.on"),
    ("Sätt på taklampan", "ceiling.on"),
    ("Slå på lampan", "ceiling.on"),
    ("Taklampan på", "ceiling.on"),
    ("Hej Jarvis, tänd taklampan", "ceiling.on"),
    ("Jarvis tänd lampan tack", "ceiling.on"),
    ("Kan du tända lampan?", "ceiling.on"),
    ("Snälla, tänd taklampan.", "ceiling.on"),
    ("Släck taklampan", "ceiling.off"),
    ("Släcka taklampan.", "ceiling.off"),
    ("Släckt taklampan", "ceiling.off"),
    ("Släck lampan", "ceiling.off"),
    ("Släck ljuset", "ceiling.off"),
    ("Släck taket", "ceiling.off"),
    ("Stäng av taklampan", "ceiling.off"),
    ("Slå av lampan", "ceiling.off"),
    ("Lampan av", "ceiling.off"),
    ("Släck lampan nu", "ceiling.off"),
    # whole room
    ("Tänd allt", "scene.all_on"),
    ("Tänd alla lampor", "scene.all_on"),
    ("Släck allt", "scene.all_off"),
    ("Släck allt.", "scene.all_off"),
    ("Släck alla lamporna", "scene.all_off"),
    ("Helt släckt", "scene.all_off"),
    ("Helt släckt, tack.", "scene.all_off"),
    # scenes
    ("Mysljus", "scene.soft"),
    ("Mys ljus", "scene.soft"),
    ("Sätt på mysljus", "scene.soft"),
    ("Sätt på mysljus.", "scene.soft"),
    ("Aktivera mysljus", "scene.soft"),
    ("Vardagsljus", "scene.everyday"),
    ("Byt till vardagsljus", "scene.everyday"),
    ("Fokus", "scene.focus"),
    ("Fokusljus", "scene.focus"),
    ("Sätt på fokus", "scene.focus"),
    ("Filmkväll", "scene.movie"),
    ("Film kväll", "scene.movie"),
    ("Starta filmkväll", "scene.movie"),
    # brightness
    ("Ljusare", "brightness.up"),
    ("Gör det ljusare", None),  # "det" is not a known lamp word
    ("Gör taklampan ljusare", "brightness.up"),
    ("Mer ljus", "brightness.up"),
    ("Mörkare", "brightness.down"),
    ("Gör lampan mörkare", "brightness.down"),
    ("Sänk ljuset", "brightness.down"),
    # music
    ("Pausa", "music.pause"),
    ("Pausa musiken", "music.pause"),
    ("Pausa musiken.", "music.pause"),
    ("Stoppa musiken", "music.pause"),
    ("Paus musiken", "music.pause"),
    ("Spela", "music.play"),
    ("Spela musiken", "music.play"),
    ("Spela musik", "music.play"),
    ("Fortsätt spela", "music.play"),
    ("Starta musiken", "music.play"),
    # volume
    ("Höj volymen", "volume.up"),
    ("Höj volymen.", "volume.up"),
    ("Höja volymen", "volume.up"),
    ("Höj ljudet", "volume.up"),
    ("Höj volymen lite", "volume.up"),
    ("Skruva upp", "volume.up"),
    ("Högre", "volume.up"),
    ("Sänk volymen", "volume.down"),
    ("Sänka volymen", "volume.down"),
    ("Sänk ljudet", "volume.down"),
    ("Skruva ner volymen", "volume.down"),
    ("Lägre", "volume.down"),
    ("Volym 30", "volume.set.30"),
    ("Volym 30%", "volume.set.30"),
    ("Volym 30 procent", "volume.set.30"),
    ("Volymen 25 procent.", "volume.set.25"),
    ("Volym trettio", "volume.set.30"),
    ("Volym trettiofem procent", "volume.set.35"),
    ("Volym trettio fem", "volume.set.35"),
    ("Volym tjugo", "volume.set.20"),
    ("Volym fem", "volume.set.5"),
    ("Volym noll", "volume.set.0"),
    ("Volym hundra", "volume.set.100"),
    ("Sätt volymen till 40", "volume.set.40"),
    ("Sätt volymen på fyrtio procent", "volume.set.40"),
    ("Ställ volymen på 20", "volume.set.20"),
    ("Höj volymen till 45 procent", "volume.set.45"),
    ("Sänk volymen till tio", "volume.set.10"),
]

NEGATIVE = [
    ("", "empty"),
    ("   ", "empty"),
    ("...", "empty"),
    ("Hej Jarvis", "empty"),
    ("Tack", "no_match"),
    ("Släck inte lampan", "negation"),
    ("Tänd inte taklampan", "negation"),
    ("Sluta spela musiken", "negation"),
    ("Pausa inte musiken", "negation"),
    ("Vad är klockan?", "question"),
    ("Vad är klockan", "question"),
    ("Är lampan tänd?", "question"),
    ("Är lampan tänd", "question"),
    ("Varför är det så mörkt?", "question"),
    ("Hur högt är ljudet?", "question"),
    ("Ska jag släcka lampan?", "question"),
    ("Tänd taklampan?", "question"),
    ("Jag tänkte att vi kunde äta middag sen", "no_match"),
    ("Jag släckte lampan igår", "no_match"),
    ("Lampan är trasig", "no_match"),
    ("Tänd taklampan och släck allt", "no_match"),
    ("Tänd taklampan tänd taklampan", "no_match"),
    ("Tack för att du tittade!", "no_match"),
    ("Undertexter från Amara.org-gemenskapen", "no_match"),
    ("Textning.nu", "no_match"),
    ("Musik", "no_match"),
    ("Volym", "no_match"),
    ("Volym 150", "volume_out_of_range"),
    ("Volym ett", "no_match"),
    ("Höj", "no_match"),
    ("Sänk", "no_match"),
    ("Stäng av", "no_match"),
    ("Släck", "no_match"),
    ("Tänd", "no_match"),
    ("Släckt", "no_match"),
    ("Mörkt", "no_match"),
    ("Stäng av allt", "no_match"),
    ("Tänd ett ljus för mormor", "no_match"),
    ("Spela fotboll", "no_match"),
    ("Höj handen", "no_match"),
    ("Ljuset är för starkt", "no_match"),
    ("Kan du", "empty"),
    ("En två tre fyra fem sex sju åtta nio tio elva tolv", "too_long"),
    ("Hallå", "no_match"),
    ("Okej", "empty"),
]


@pytest.mark.parametrize("text,expected", POSITIVE)
def test_positive(text: str, expected: str | None) -> None:
    result = parse(text)
    assert action_name(result.action) == expected, (text, result)


@pytest.mark.parametrize("text,reason", NEGATIVE)
def test_negative(text: str, reason: str) -> None:
    result = parse(text)
    assert result.action is None, (text, result)
    assert result.reason == reason, (text, result)


@pytest.mark.parametrize("text,expected", [
    ("Volym 30%", "volym 30 procent"),
    ("TÄND  Taklampan!!", "tänd taklampan"),
    ("tjugofem", "25"),
    ("nittionio", "99"),
    ("en lampa", "en lampa"),
    ("Släcka", "släck"),
])
def test_normalize(text: str, expected: str) -> None:
    assert normalize(text) == expected


def test_every_action_kind_reachable() -> None:
    names = {action_name(parse(t).action) for t, _ in POSITIVE}
    assert {"ceiling.on", "ceiling.off", "scene.all_on", "scene.all_off", "scene.soft", "scene.everyday",
            "scene.focus", "scene.movie", "brightness.up", "brightness.down", "music.play", "music.pause",
            "volume.up", "volume.down"} <= names
