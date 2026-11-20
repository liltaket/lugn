"""Adaptive-volume dataset: one JSON row per second, gzip files per local day.

Schema (v1) is documented in README.md. Rows combine the node's audio sensors
with cached Lugn context, and carry labels for user volume changes.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import logging
import re
import shutil
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Protocol

from .config import FeaturesConfig, LugnConfig
from .lugn_client import LugnApi, LugnError

log = logging.getLogger(__name__)
SCHEMA_VERSION = 1
FILE_RE = re.compile(r"^features-(\d{4}-\d{2}-\d{2})\.jsonl\.gz$")
HUMAN_ACTORS = {"user", "physical_remote", "home_assistant"}
POLICY_KEYS = ("mode", "activeOwner", "lastIntentActor", "policyEnabled", "policyActive", "activityReason",
               "baseline", "configuredBaseline", "target", "effectiveTarget", "manualReference", "dailyOffset",
               "personOffset", "sourceOffset", "passiveReductionActive", "source")


# --- Lugn context --------------------------------------------------------------


def _get(d: Any, *path: str) -> Any:
    for key in path:
        if not isinstance(d, dict):
            return None
        d = d.get(key)
    return d


def extract_context(state: dict[str, Any], policies: dict[str, Any], ceiling: str) -> dict[str, Any]:
    """Compact, separately-staged view of Lugn's state relevant to loudness."""
    presence = state.get("presence") or {}
    ctx: dict[str, Any] = {
        "presence": {
            "state": presence.get("state"),
            "count": presence.get("personCount"),
            "exit_pending": bool(presence.get("exitPending")),
            "home": _get(presence, "home", "state"),
            "session": _get(state, "session", "state"),
        },
        "lighting": {
            "scene": _get(state, "lighting", "currentScene"),
            "ceiling_power": _get(state, "lighting", "devices", ceiling, "observed", "power"),
            "ceiling_brightness": _get(state, "lighting", "devices", ceiling, "observed", "brightness"),
        },
        "music": {},
    }
    devices = _get(state, "music", "devices") or {}
    fades = _get(state, "music", "fades") or {}
    for target, dev in sorted(devices.items()):
        if not isinstance(dev, dict):
            continue
        observed = dev.get("observed") or {}
        requested = dev.get("requested") or {}
        fade = fades.get(target) if isinstance(fades, dict) else None
        policy = policies.get(target)
        ctx["music"][target] = {
            "availability": dev.get("availability"),
            "playback": observed.get("playback"),
            "volume": observed.get("volume"),
            "source": observed.get("source"),
            "requested_volume": requested.get("volume"),
            "requested_playback": requested.get("playback"),
            "requested_source": requested.get("source"),
            "preset": requested.get("preset"),
            "observed_at": dev.get("observedAt"),
            "fade": None if not isinstance(fade, dict) else {
                "status": fade.get("status"), "target_volume": fade.get("targetVolume"),
                "expected_volume": fade.get("expectedVolume")},
            "policy": None if not isinstance(policy, dict) else {k: policy.get(k) for k in POLICY_KEYS},
        }
    return ctx


@dataclass
class LabelTracker:
    """Turns Lugn's last-volume-change and decision history into one-time labels."""

    seen_change: dict[str, float] = field(default_factory=dict)
    seen_decision_at: dict[str, float] = field(default_factory=dict)
    seeded: bool = False

    def update(self, state: dict[str, Any], policy_raw: dict[str, Any]) -> list[dict[str, Any]]:
        labels: list[dict[str, Any]] = []
        changes = _get(state, "music", "volumeChanges") or {}
        for target, change in sorted(changes.items()):
            at = change.get("observedAt") if isinstance(change, dict) else None
            if not isinstance(at, (int, float)) or self.seen_change.get(target) == at:
                continue
            self.seen_change[target] = at
            if not self.seeded:
                continue
            actor = _get(change, "provenance", "actor") or {}
            labels.append({
                "type": "volume_change", "target": target, "volume": change.get("volume"),
                "observed_at": at, "actor": actor.get("type"), "actor_id": actor.get("id"),
                "source": _get(change, "provenance", "source"),
                "reason": _get(change, "provenance", "reason"),
                "attribution": change.get("attribution"),
                "user_initiated": actor.get("type") in HUMAN_ACTORS,
            })
        for target, raw in sorted(policy_raw.items()):
            decisions = raw.get("decisions") if isinstance(raw, dict) else None
            if not isinstance(decisions, list):
                continue
            last = self.seen_decision_at.get(target, -1.0)
            newest = last
            for d in decisions:
                at = d.get("at") if isinstance(d, dict) else None
                if not isinstance(at, (int, float)) or at <= last:
                    continue
                newest = max(newest, at)
                if self.seeded:
                    labels.append({"type": "decision", "target": target, "at": at,
                                   "kind": _get(d, "reason", "kind"), "value": _get(d, "reason", "value"),
                                   "owner": d.get("owner"), "policy_enabled": d.get("policyEnabled")})
            self.seen_decision_at[target] = newest
        self.seeded = True
        return labels


class LugnContextPoller:
    def __init__(self, lugn: LugnApi, lugn_cfg: LugnConfig, poll_s: float,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._lugn = lugn
        self._ceiling = lugn_cfg.ceiling_target
        self._poll_s = poll_s
        self._clock = clock
        self.context: dict[str, Any] | None = None
        self.fetched_at: float | None = None
        self.error: str | None = None
        self.labels = LabelTracker()
        self._pending_labels: list[dict[str, Any]] = []

    async def poll_once(self) -> None:
        try:
            state = await self._lugn.get_state()
            policies: dict[str, Any] = {}
            for target in sorted((_get(state, "music", "devices") or {}).keys()):
                try:
                    policies[target] = await self._lugn.invoke("music.getPolicy", {"target": target})
                except LugnError as error:
                    log.debug("music.getPolicy %s failed: %s", target, error)
            flat = {t: p.get("volume") for t, p in policies.items() if isinstance(p, dict)}
            self.context = extract_context(state, flat, self._ceiling)
            self._pending_labels.extend(self.labels.update(state, policies))
            self.fetched_at = self._clock()
            self.error = None
        except LugnError as error:
            self.error = str(error)[:200]

    def take(self) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
        labels, self._pending_labels = self._pending_labels, []
        if self.context is None or self.fetched_at is None:
            return ({"error": self.error} if self.error else None), labels
        age = self._clock() - self.fetched_at
        if age > self._poll_s * 4:
            return {"error": self.error or "stale", "age_s": round(age, 1)}, labels
        return {**self.context, "age_s": round(age, 1), "error": self.error}, labels

    async def run(self) -> None:
        while True:
            await self.poll_once()
            await asyncio.sleep(self._poll_s)


# --- Writer ---------------------------------------------------------------------


class DiskUsage(Protocol):
    def __call__(self, path: str) -> Any: ...


class DailyGzipWriter:
    """Appends rows to features-YYYY-MM-DD.jsonl.gz with bounded retention.

    Each flush is a zlib sync point, so a crash loses at most one flush interval;
    a restart appends a new gzip member, which every gzip reader accepts.
    """

    def __init__(self, cfg: FeaturesConfig, *, clock: Callable[[], float] = time.monotonic,
                 disk_usage: DiskUsage = shutil.disk_usage) -> None:
        self.cfg = cfg
        self.dir = Path(cfg.directory).expanduser()
        self._clock = clock
        self._disk_usage = disk_usage
        self._day: date | None = None
        self._fh: gzip.GzipFile | None = None
        self._last_flush = clock()
        self._free_checked_at = -1e18
        self._free_ok = True
        self._retention_at = -1e18
        self.dropped = 0
        self.written = 0

    def _path(self, day: date) -> Path:
        return self.dir / f"features-{day.isoformat()}.jsonl.gz"

    def write(self, row: dict[str, Any], day: date) -> bool:
        now = self._clock()
        if now - self._free_checked_at >= 30:
            self._free_checked_at = now
            try:
                self.dir.mkdir(parents=True, exist_ok=True)
                self._free_ok = self._disk_usage(str(self.dir)).free >= self.cfg.min_free_bytes
            except OSError:
                self._free_ok = False
            if not self._free_ok:
                log.warning("features: free space below floor; not writing")
                self.close()
        if not self._free_ok:
            self.dropped += 1
            return False
        if self.dropped:
            row = {**row, "dropped": self.dropped}
        try:
            if self._day != day or self._fh is None:
                self.close()
                self.dir.mkdir(parents=True, exist_ok=True)
                self._day = day
                self._fh = gzip.open(self._path(day), "ab", compresslevel=6)
                self.enforce_retention(day)
            elif now - self._retention_at >= 3600:
                self.enforce_retention(day)
            assert self._fh is not None
            self._fh.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode() + b"\n")
            if now - self._last_flush >= self.cfg.flush_every_s:
                self._fh.flush()
                self._last_flush = now
        except OSError as error:
            log.warning("features: write failed: %s", error)
            self.close()
            self.dropped += 1
            return False
        self.dropped = 0
        self.written += 1
        return True

    def enforce_retention(self, today: date) -> list[Path]:
        self._retention_at = self._clock()
        removed: list[Path] = []
        files: list[tuple[date, Path]] = []
        for p in self.dir.glob("features-*.jsonl.gz"):
            m = FILE_RE.match(p.name)
            if m:
                files.append((date.fromisoformat(m.group(1)), p))
        files.sort()
        cutoff = today - timedelta(days=self.cfg.retention_days)
        keep: list[tuple[date, Path]] = []
        for d, p in files:
            if d < cutoff and d != self._day:
                p.unlink(missing_ok=True)
                removed.append(p)
            else:
                keep.append((d, p))
        total = sum(p.stat().st_size for _, p in keep if p.exists())
        for d, p in keep:
            if total <= self.cfg.max_total_bytes:
                break
            if d == self._day:
                continue
            size = p.stat().st_size
            p.unlink(missing_ok=True)
            removed.append(p)
            total -= size
        for p in removed:
            log.info("features: removed %s", p.name)
        return removed

    def close(self) -> None:
        if self._fh is not None:
            try:
                self._fh.close()
            except OSError:
                pass
        self._fh = None


# --- Row assembly ----------------------------------------------------------------


# Node diagnostics publish every 30-60 s.
DIAG_MAX_AGE_S = 120.0


class SensorSource(Protocol):
    connected: bool
    catalog_revision: int

    def sensor_values(self, max_age_s: float) -> dict[str, float | None]: ...


class FeatureLogger:
    def __init__(self, cfg: FeaturesConfig, node: SensorSource, poller: LugnContextPoller | None,
                 writer: DailyGzipWriter, *, voice_active: Callable[[], bool] = lambda: False,
                 catalog: Callable[[], dict[str, dict[str, str]]] = dict,
                 wall: Callable[[], float] = time.time) -> None:
        self.cfg = cfg
        self.node = node
        self.poller = poller
        self.writer = writer
        self.voice_active = voice_active
        self.catalog = catalog
        self.wall = wall
        self.seq = 0
        self._catalog_rev_written = -1
        self._catalog_day: date | None = None

    def tick(self) -> dict[str, Any]:
        now = self.wall()
        local = datetime.fromtimestamp(now).astimezone()
        day = local.date()
        if self.node.catalog_revision != self._catalog_rev_written or self._catalog_day != day:
            self.writer.write({"kind": "catalog", "v": SCHEMA_VERSION, "t": round(now, 3),
                               "revision": self.node.catalog_revision, "sensors": self.catalog()}, day)
            self._catalog_rev_written = self.node.catalog_revision
            self._catalog_day = day
        lugn, labels = self.poller.take() if self.poller else (None, [])
        audio, diag = self._split_sensors()
        row: dict[str, Any] = {
            "kind": "sample", "v": SCHEMA_VERSION, "seq": self.seq, "t": round(now, 3),
            "local": local.isoformat(timespec="seconds"),
            "hour": round(local.hour + local.minute / 60 + local.second / 3600, 4),
            "weekday": local.weekday(),
            "node": {"connected": self.node.connected, "catalog": self.node.catalog_revision,
                     "voice_active": self.voice_active()},
            "audio": audio,
            "lugn": lugn,
        }
        if diag:
            row["diag"] = diag
        if labels:
            row["labels"] = labels
        self.seq += 1
        self.writer.write(row, day)
        return row

    def _split_sensors(self) -> tuple[dict[str, float | None], dict[str, float | None]]:
        """Sound features (1 Hz, short max age) apart from slow node diagnostics.

        Diagnostics (temperature, signal, memory) update every 30-60 s; with the
        sound features' max age they would always read None.
        """
        fresh = self.node.sensor_values(self.cfg.sensor_max_age_s)
        meta = self.catalog()
        if not meta:
            return fresh, {}
        slow = self.node.sensor_values(DIAG_MAX_AGE_S)

        def is_sound(key: str) -> bool:
            # Levels are dB/dBFS; spectral flatness has no unit. WiFi signal
            # (dBm), temperature, memory and uptime are diagnostics.
            unit = (meta.get(key, {}).get("unit") or "").strip().lower()
            return unit in ("", "db", "dbfs", "dba", "db(a)")

        audio = {k: v for k, v in fresh.items() if is_sound(k)}
        diag = {k: v for k, v in slow.items() if not is_sound(k)}
        return audio, diag

    async def run(self) -> None:
        interval = self.cfg.interval_s
        next_at = time.monotonic()
        try:
            while True:
                self.tick()
                next_at += interval
                delay = next_at - time.monotonic()
                if delay < -interval:  # fell behind (suspend); do not burst
                    next_at = time.monotonic()
                    delay = 0
                await asyncio.sleep(max(0.0, delay))
        finally:
            self.writer.close()
