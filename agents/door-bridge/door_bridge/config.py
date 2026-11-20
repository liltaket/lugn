"""TOML configuration. Secrets come from environment variables or files only."""

from __future__ import annotations

import base64
import binascii
import os
import tomllib
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class NodeConfig:
    host: str = "lugn-door.local"
    port: int = 6053
    name: str = "lugn-door"
    # Exactly one of these provides the noise PSK. A file may hold the bare key
    # or an ESPHome secrets.yaml with an `api_encryption_key:` line.
    encryption_key_env: str = ""
    encryption_key_file: str = ""
    # Ambient level sensor used as the endpointer's noise floor hint.
    ambient_sensor_name: str = "Ljudnivå RMS"


@dataclass(frozen=True)
class LugnConfig:
    url: str = "http://127.0.0.1:8787"
    # Same rule as Lugn: a name ending in _B64 holds a base64url-encoded token.
    token_env: str = ""
    token_file: str = ""
    # A scene change waits for every light; it took over 2 s on the real room.
    timeout_s: float = 10.0
    ceiling_target: str = "lighting.ceiling"
    music_target: str = "music.room"
    all_on_scene: str = "scene.focus_light"
    brightness_step: int = 10
    volume_step: float = 0.05
    # Voice never sets a volume above this, absolute or stepped.
    max_voice_volume: float = 0.6


@dataclass(frozen=True)
class SttConfig:
    workers: tuple[str, ...] = ()
    token_env: str = ""
    connect_timeout_s: float = 0.8
    request_timeout_s: float = 6.0
    total_budget_s: float = 8.0
    # A worker that failed is skipped for this long while another remains.
    failure_cooldown_s: float = 60.0
    min_avg_logprob: float = -0.7
    max_no_speech_prob: float = 0.5


@dataclass(frozen=True)
class RescoreConfig:
    """Closed-vocabulary rescoring when the free transcript misses (see rescore.py).

    Scores are mean log-probabilities per token. The defaults are the operating
    point measured in the README: no wrong action on the evaluation set, and
    none either with every threshold two grid steps looser.
    """

    enabled: bool = True
    # Score the phrases after the worker's command prompt (measured: worse).
    prompt: bool = False
    min_logprob: float = -2.0
    margin: float = 1.0
    opposite_margin: float = 2.0
    refusal_margin: float = 1.0
    free_text_margin: float = 1.0
    timeout_s: float = 4.0


@dataclass(frozen=True)
class VoiceConfig:
    dry_run: bool = False
    frame_ms: int = 30
    speech_margin_db: float = 7.0
    # The voice stream is amplified on the node (voice_assistant gain_factor 8
    # = +18 dB) but the ambient level sensor is not; this is added to the
    # sensor's level before it is compared with the stream.
    stream_gain_db: float = 18.0
    # Absolute floor under the ambient-relative threshold. In a quiet room the
    # ambient level decides; -50 dBFS here rejected speech from 2 m away.
    min_speech_dbfs: float = -62.0
    min_speech_ms: int = 150
    silence_end_ms: int = 700
    max_utterance_ms: int = 6000
    no_speech_timeout_ms: int = 3000
    # The first part of the stream that may still be the wake word's tail.
    wake_tail_ms: int = 600
    run_timeout_s: float = 20.0
    journal_path: str = "~/.local/state/lugn-door-bridge/voice.jsonl"
    journal_max_bytes: int = 20 * 1024 * 1024
    # Keep the last N utterances as WAV for debugging (0 = off).
    keep_audio: int = 0
    audio_dir: str = "~/.local/state/lugn-door-bridge/audio"


@dataclass(frozen=True)
class EarconConfig:
    enabled: bool = True
    audio_device: str = ""
    volume: float = 0.35
    listening: bool = True
    # Optional directory with pre-rendered <kind>.wav files (e.g. Piper speech).
    prompts_dir: str = ""


@dataclass(frozen=True)
class FeaturesConfig:
    enabled: bool = True
    directory: str = "~/.local/state/lugn-door-bridge/features"
    interval_s: float = 1.0
    lugn_poll_s: float = 8.0
    sensor_max_age_s: float = 2.5
    retention_days: int = 30
    max_total_bytes: int = 2 * 1024**3
    min_free_bytes: int = 1024**3
    flush_every_s: float = 10.0


@dataclass(frozen=True)
class Config:
    node: NodeConfig = field(default_factory=NodeConfig)
    lugn: LugnConfig = field(default_factory=LugnConfig)
    stt: SttConfig = field(default_factory=SttConfig)
    rescore: RescoreConfig = field(default_factory=RescoreConfig)
    voice: VoiceConfig = field(default_factory=VoiceConfig)
    earcons: EarconConfig = field(default_factory=EarconConfig)
    features: FeaturesConfig = field(default_factory=FeaturesConfig)


def _section(cls: type, raw: dict[str, Any], name: str) -> Any:
    known = {f.name: f for f in fields(cls)}
    unknown = set(raw) - set(known)
    if unknown:
        raise ConfigError(f"[{name}] unknown keys: {', '.join(sorted(unknown))}")
    values: dict[str, Any] = {}
    for key, value in raw.items():
        default = getattr(cls(), key)
        if isinstance(default, tuple):
            if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
                raise ConfigError(f"[{name}] {key} must be a list of strings")
            value = tuple(value)
        elif isinstance(default, bool):
            if not isinstance(value, bool):
                raise ConfigError(f"[{name}] {key} must be true or false")
        elif isinstance(default, float):
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                raise ConfigError(f"[{name}] {key} must be a number")
            value = float(value)
        elif isinstance(default, int):
            if not isinstance(value, int) or isinstance(value, bool):
                raise ConfigError(f"[{name}] {key} must be an integer")
        elif isinstance(default, str) and not isinstance(value, str):
            raise ConfigError(f"[{name}] {key} must be a string")
        values[key] = value
    return cls(**values)


def load_config(path: str | Path | None, *, dry_run: bool | None = None) -> Config:
    raw: dict[str, Any] = {}
    if path is not None:
        with open(path, "rb") as handle:
            raw = tomllib.load(handle)
    sections = {
        "node": NodeConfig, "lugn": LugnConfig, "stt": SttConfig, "rescore": RescoreConfig,
        "voice": VoiceConfig, "earcons": EarconConfig, "features": FeaturesConfig,
    }
    unknown = set(raw) - set(sections)
    if unknown:
        raise ConfigError(f"unknown sections: {', '.join(sorted(unknown))}")
    built = {name: _section(cls, raw.get(name, {}), name) for name, cls in sections.items()}
    if dry_run is not None:
        v = built["voice"]
        built["voice"] = VoiceConfig(**{**{f.name: getattr(v, f.name) for f in fields(v)}, "dry_run": dry_run})
    cfg = Config(**built)
    _validate(cfg)
    return cfg


def _validate(cfg: Config) -> None:
    if not 0 < cfg.lugn.max_voice_volume <= 1:
        raise ConfigError("[lugn] max_voice_volume must be in (0, 1]")
    if not 0 < cfg.lugn.volume_step <= 0.2:
        raise ConfigError("[lugn] volume_step must be in (0, 0.2]")
    r = cfg.rescore
    if not (r.min_logprob <= 0 and r.margin > 0 and r.opposite_margin >= r.margin and r.refusal_margin >= r.margin
            and r.free_text_margin >= 0 and r.timeout_s > 0):
        raise ConfigError("[rescore] needs min_logprob <= 0, margin > 0, opposite_margin and refusal_margin "
                          ">= margin, free_text_margin >= 0 and timeout_s > 0")
    if cfg.voice.frame_ms not in (10, 20, 30, 40, 50):
        raise ConfigError("[voice] frame_ms must be 10..50 in steps of 10")
    for url in cfg.stt.workers:
        if not url.startswith(("http://", "https://")):
            raise ConfigError(f"[stt] worker URL must be http(s): {url}")


def decode_env_secret(name: str, environ: dict[str, str] | None = None) -> str:
    """Read a secret from the environment; `_B64` names are base64url (Lugn's rule)."""
    env = os.environ if environ is None else environ
    value = env.get(name, "")
    if not value.strip():
        raise ConfigError(f"environment variable {name} is empty or missing")
    if not name.endswith("_B64"):
        return value
    try:
        padded = value + "=" * (-len(value) % 4)
        decoded = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
    except (binascii.Error, UnicodeError, ValueError) as error:
        raise ConfigError(f"{name} is not valid base64url") from error
    if "\x00" in decoded or base64.urlsafe_b64encode(decoded.encode()).decode().rstrip("=") != value.rstrip("="):
        raise ConfigError(f"{name} is not canonical base64url")
    return decoded


def read_secret_file(path: str, yaml_key: str | None = None) -> str:
    text = Path(path).expanduser().read_text(encoding="utf-8")
    if yaml_key:
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith(f"{yaml_key}:"):
                value = stripped.split(":", 1)[1].strip()
                if " #" in value:
                    value = value.split(" #", 1)[0].strip()
                return value.strip("'\"")
    lines = [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    if len(lines) != 1 or ":" in lines[0]:
        raise ConfigError(f"{path} must hold exactly one secret value")
    return lines[0]


def resolve_secret(env_name: str, file_path: str, *, what: str, yaml_key: str | None = None,
                   required: bool = True) -> str | None:
    if env_name and file_path:
        raise ConfigError(f"{what}: set either an env name or a file, not both")
    if env_name:
        return decode_env_secret(env_name)
    if file_path:
        return read_secret_file(file_path, yaml_key)
    if required:
        raise ConfigError(f"{what}: no env name or file configured")
    return None
