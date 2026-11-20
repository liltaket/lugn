from __future__ import annotations

import gzip
import json
import os
from dataclasses import replace
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from conftest import FakeLugn
from door_bridge.config import FeaturesConfig, LugnConfig
from door_bridge.features import (
    DailyGzipWriter,
    FeatureLogger,
    LabelTracker,
    LugnContextPoller,
    extract_context,
)

STATE: dict[str, Any] = {
    "session": {"state": "active"},
    "presence": {"state": "occupied", "personCount": 2, "home": {"state": "home"}},
    "lighting": {"currentScene": "scene.soft_light",
                 "devices": {"lighting.ceiling": {"observed": {"power": False}}}},
    "music": {
        "devices": {"music.room": {"availability": "available", "observedAt": 5,
                                   "observed": {"playback": "playing", "volume": 0.31, "source": "Optical In"},
                                   "requested": {"volume": 0.31, "preset": "optical"}}},
        "fades": {},
        "volumeChanges": {"music.room": {"volume": 0.31, "observedAt": 100.0, "attribution": "external",
                                         "provenance": {"actor": {"type": "physical_remote"}}}},
    },
}
POLICY = {"volume": {"mode": "auto", "activeOwner": "lugn", "baseline": 0.3, "target": 0.3,
                     "effectiveTarget": 0.37, "sourceOffset": 0.07, "dailyOffset": 0.0, "personOffset": 0.0,
                     "policyEnabled": True},
          "decisions": [{"at": 50.0, "reason": {"kind": "volume", "value": "active"}, "owner": "lugn"}]}


def test_extract_context_keeps_every_volume_stage() -> None:
    ctx = extract_context(STATE, {"music.room": POLICY["volume"]}, "lighting.ceiling")
    assert ctx["presence"] == {"state": "occupied", "count": 2, "exit_pending": False, "home": "home",
                               "session": "active"}
    room = ctx["music"]["music.room"]
    assert room["volume"] == 0.31 and room["source"] == "Optical In" and room["preset"] == "optical"
    assert room["policy"]["sourceOffset"] == 0.07 and room["policy"]["mode"] == "auto"
    assert room["policy"]["effectiveTarget"] == 0.37
    assert ctx["lighting"]["ceiling_power"] is False


def test_extract_context_tolerates_empty_state() -> None:
    ctx = extract_context({}, {}, "lighting.ceiling")
    assert ctx["music"] == {} and ctx["presence"]["count"] is None


def test_labels_seed_then_emit_once() -> None:
    tracker = LabelTracker()
    assert tracker.update(STATE, {"music.room": POLICY}) == []  # history before start is not a label
    assert tracker.update(STATE, {"music.room": POLICY}) == []
    newer = json.loads(json.dumps(STATE))
    newer["music"]["volumeChanges"]["music.room"].update(
        observedAt=200.0, volume=0.4, provenance={"actor": {"type": "user", "id": "http"}, "source": "lugn.http"})
    policy = json.loads(json.dumps(POLICY))
    policy["decisions"].append({"at": 210.0, "reason": {"kind": "volume", "value": "manual_hold"},
                                "owner": "manual"})
    labels = tracker.update(newer, {"music.room": policy})
    assert [l["type"] for l in labels] == ["volume_change", "decision"]
    assert labels[0]["user_initiated"] is True and labels[0]["volume"] == 0.4
    assert labels[1]["value"] == "manual_hold"
    assert tracker.update(newer, {"music.room": policy}) == []


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def read_rows(path: Path) -> list[dict[str, Any]]:
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        return [json.loads(line) for line in fh]


def test_writer_rotates_daily_and_appends_members(tmp_path: Path) -> None:
    cfg = FeaturesConfig(directory=str(tmp_path), min_free_bytes=0)
    clock = Clock()
    w = DailyGzipWriter(cfg, clock=clock)
    d1, d2 = date(2026, 11, 20), date(2026, 11, 21)
    w.write({"n": 1}, d1)
    w.write({"n": 2}, d1)
    w.write({"n": 3}, d2)
    w.close()
    w2 = DailyGzipWriter(cfg, clock=clock)  # restart appends a new gzip member
    w2.write({"n": 4}, d2)
    w2.close()
    assert [r["n"] for r in read_rows(tmp_path / "features-2026-11-20.jsonl.gz")] == [1, 2]
    assert [r["n"] for r in read_rows(tmp_path / "features-2026-11-21.jsonl.gz")] == [3, 4]


def test_unflushed_rows_survive_a_crash_after_flush(tmp_path: Path) -> None:
    cfg = FeaturesConfig(directory=str(tmp_path), min_free_bytes=0, flush_every_s=10)
    clock = Clock()
    w = DailyGzipWriter(cfg, clock=clock)
    day = date(2026, 11, 20)
    for n in range(5):
        clock.t += 3
        w.write({"n": n}, day)
    # no close(): the process died; rows up to the last sync flush are readable
    data = (tmp_path / "features-2026-11-20.jsonl.gz").read_bytes()
    import zlib

    text = zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(data).decode()
    assert [json.loads(line)["n"] for line in text.splitlines()][:4] == [0, 1, 2, 3]


def test_retention_by_age_and_size(tmp_path: Path) -> None:
    today = date(2026, 11, 20)
    for age in (40, 31, 29, 2, 1):
        p = tmp_path / f"features-{(today - timedelta(days=age)).isoformat()}.jsonl.gz"
        p.write_bytes(os.urandom(1000))
    (tmp_path / "unrelated.txt").write_text("keep")
    cfg = FeaturesConfig(directory=str(tmp_path), retention_days=30, max_total_bytes=2500, min_free_bytes=0)
    w = DailyGzipWriter(cfg, clock=Clock())
    w.write({"n": 1}, today)
    w.close()
    names = sorted(p.name for p in tmp_path.iterdir())
    # 40 and 31 days: too old; 29: dropped for size; the newest two plus today remain
    assert names == ["features-2026-11-18.jsonl.gz", "features-2026-11-19.jsonl.gz",
                     "features-2026-11-20.jsonl.gz", "unrelated.txt"]


def test_free_space_floor(tmp_path: Path) -> None:
    free = {"bytes": 10}
    cfg = FeaturesConfig(directory=str(tmp_path), min_free_bytes=100)
    clock = Clock()
    w = DailyGzipWriter(cfg, clock=clock, disk_usage=lambda _: SimpleNamespace(free=free["bytes"]))
    day = date(2026, 11, 20)
    assert w.write({"n": 1}, day) is False
    assert w.write({"n": 2}, day) is False
    assert not (tmp_path / "features-2026-11-20.jsonl.gz").exists()
    free["bytes"] = 1000
    clock.t += 31
    assert w.write({"n": 3}, day) is True
    w.close()
    rows = read_rows(tmp_path / "features-2026-11-20.jsonl.gz")
    assert rows == [{"n": 3, "dropped": 2}]


class FakeNode:
    connected = True
    catalog_revision = 1

    def __init__(self, values: dict[str, float | None]) -> None:
        self.values = values

    def sensor_values(self, max_age_s: float) -> dict[str, float | None]:
        return dict(self.values)


async def test_logger_rows_with_context_and_missing_sensors(tmp_path: Path) -> None:
    cfg = FeaturesConfig(directory=str(tmp_path), min_free_bytes=0)
    lugn = FakeLugn(state=STATE, policy={"music.room": POLICY})
    poller = LugnContextPoller(lugn, LugnConfig(), poll_s=8)
    await poller.poll_once()
    node = FakeNode({"ljudniva_rms": -48.5, "ljudniva_topp": None})
    writer = DailyGzipWriter(cfg)
    logger = FeatureLogger(cfg, node, poller, writer, catalog=lambda: {"ljudniva_rms": {"name": "Ljudnivå RMS"}},
                           wall=lambda: 1_795_000_000.0)
    row = logger.tick()
    logger.tick()
    writer.close()
    assert row["kind"] == "sample" and row["v"] == 1 and row["seq"] == 0
    assert row["audio"] == {"ljudniva_rms": -48.5, "ljudniva_topp": None}
    assert row["lugn"]["presence"]["count"] == 2
    assert row["lugn"]["music"]["music.room"]["policy"]["sourceOffset"] == 0.07
    assert 0 <= row["hour"] < 24 and "labels" not in row
    files = list(tmp_path.glob("features-*.jsonl.gz"))
    rows = read_rows(files[0])
    assert [r["kind"] for r in rows] == ["catalog", "sample", "sample"]


async def test_poller_failure_and_staleness() -> None:
    clock = Clock()
    lugn = FakeLugn(fail="down")
    poller = LugnContextPoller(lugn, LugnConfig(), poll_s=8, clock=clock)
    await poller.poll_once()
    ctx, labels = poller.take()
    assert ctx is not None and ctx["error"] and labels == []
    lugn.fail = None
    lugn.state = STATE
    await poller.poll_once()
    ctx, _ = poller.take()
    assert ctx is not None and ctx["error"] is None and ctx["age_s"] == 0
    clock.t += 100
    ctx, _ = poller.take()
    assert ctx is not None and "presence" not in ctx and ctx["age_s"] == 100


def test_disabled_cfg_defaults() -> None:
    cfg = replace(FeaturesConfig(), retention_days=30)
    assert cfg.max_total_bytes == 2 * 1024**3


def test_diagnostics_are_logged_apart_with_a_longer_max_age(tmp_path: Path) -> None:
    from door_bridge.features import FeatureLogger

    class Node:
        connected = True
        catalog_revision = 1

        def sensor_values(self, max_age_s: float) -> dict[str, float | None]:
            # The level is fresh; the temperature is 40 s old.
            return {"ljudniva_rms": -43.0, "spektral_platthet": 0.7, "wifi_signal": -43.0,
                    "chiptemperatur": 79.0 if max_age_s > 40 else None}

    class Writer:
        def __init__(self) -> None:
            self.rows: list[dict[str, Any]] = []

        def write(self, row: dict[str, Any], day: Any) -> None:
            self.rows.append(row)

    meta = {"ljudniva_rms": {"unit": "dB"}, "spektral_platthet": {"unit": ""}, "wifi_signal": {"unit": "dBm"},
            "chiptemperatur": {"unit": "°C"}}
    writer = Writer()
    log = FeatureLogger(FeaturesConfig(directory=str(tmp_path)), Node(), None, writer,  # type: ignore[arg-type]
                        catalog=lambda: meta, wall=lambda: 1_795_000_000.0)
    row = log.tick()
    assert row["audio"] == {"ljudniva_rms": -43.0, "spektral_platthet": 0.7}
    assert row["diag"] == {"wifi_signal": -43.0, "chiptemperatur": 79.0}
