"""Entry point: `python -m door_bridge <command>`."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
import signal
import sys
from pathlib import Path
from typing import Any

from . import __version__
from .config import Config, ConfigError, load_config, resolve_secret
from .earcons import AplayPlayer, write_all
from .executor import Executor
from .features import DailyGzipWriter, FeatureLogger, LugnContextPoller
from .intents import action_name, parse
from .lugn_client import LugnApi, LugnClient, LugnError
from .node import NodeLink
from .stt_client import SttClient
from .voice import Journal, VoicePipeline

log = logging.getLogger("door_bridge")
REQUIRED_CAPABILITIES = ("lighting.set", "lighting.adjust", "lighting.activateScene", "music.play",
                         "music.pause", "music.setVolume", "music.getState", "music.getPolicy")


class _NoLugn:
    """Dry run: Lugn is never called, not even for reads."""

    async def invoke(self, name: str, input: dict[str, Any], *, request_id: str | None = None,
                     reason: str | None = None) -> dict[str, Any]:
        raise LugnError("dry run: Lugn is not called")

    async def get_state(self) -> dict[str, Any]:
        raise LugnError("dry run: Lugn is not called")


def _lugn_token(cfg: Config) -> str | None:
    return resolve_secret(cfg.lugn.token_env, cfg.lugn.token_file, what="lugn token", required=False)


async def run_bridge(cfg: Config, *, with_earcons: bool) -> None:
    psk = resolve_secret(cfg.node.encryption_key_env, cfg.node.encryption_key_file,
                         what="node encryption key", yaml_key="api_encryption_key")
    assert psk is not None
    lugn: LugnApi = _NoLugn() if cfg.voice.dry_run else LugnClient(cfg.lugn.url, _lugn_token(cfg),
                                                                   timeout_s=cfg.lugn.timeout_s)
    stt_token = resolve_secret(cfg.stt.token_env, "", what="stt token", required=False)
    stt = SttClient(cfg.stt, stt_token)
    earcons_on = cfg.earcons.enabled and (with_earcons or not cfg.voice.dry_run)
    player = AplayPlayer(volume=cfg.earcons.volume, audio_device=cfg.earcons.audio_device,
                         prompts_dir=cfg.earcons.prompts_dir, enabled=earcons_on,
                         listening=cfg.earcons.listening)
    node = NodeLink(cfg.node, psk)
    pipeline = VoicePipeline(cfg=cfg.voice, transport=node, stt=stt, stt_confident=stt.confident,
                             executor=Executor(lugn, cfg.lugn), earcons=player,
                             journal=Journal(cfg.voice.journal_path, cfg.voice.journal_max_bytes))
    node.pipeline = pipeline
    tasks: list[asyncio.Task[None]] = []
    if cfg.features.enabled:
        poller = None if cfg.voice.dry_run else LugnContextPoller(lugn, cfg.lugn, cfg.features.lugn_poll_s)
        writer = DailyGzipWriter(cfg.features)
        features = FeatureLogger(
            cfg.features, node, poller, writer,
            voice_active=lambda: pipeline.active is not None,
            catalog=lambda: {m.key: {"name": m.name, "unit": m.unit, "device_class": m.device_class}
                             for m in node.catalog.values()})
        tasks.append(asyncio.create_task(features.run(), name="features"))
        if poller is not None:
            tasks.append(asyncio.create_task(poller.run(), name="lugn-context"))
    log.info("door bridge %s starting (dry_run=%s, earcons=%s, stt workers=%d)", __version__,
             cfg.voice.dry_run, earcons_on, len(cfg.stt.workers))
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, stop.set)
    await node.start()
    try:
        await stop.wait()
    finally:
        log.info("stopping")
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await node.stop()


async def check(cfg: Config) -> int:
    ok = True
    try:
        resolve_secret(cfg.node.encryption_key_env, cfg.node.encryption_key_file,
                       what="node encryption key", yaml_key="api_encryption_key")
        print("node key: present")
    except (ConfigError, OSError) as error:
        print(f"node key: {error}")
        ok = False
    if cfg.voice.dry_run:
        print("lugn: skipped (dry run)")
    else:
        try:
            client = LugnClient(cfg.lugn.url, _lugn_token(cfg), timeout_s=cfg.lugn.timeout_s)
            caps = await client.list_capabilities()
            missing = [c for c in REQUIRED_CAPABILITIES if c not in caps]
            print(f"lugn: {len(caps)} capabilities, missing: {missing or 'none'}")
            ok = ok and not missing
        except (ConfigError, LugnError) as error:
            print(f"lugn: {error}")
            ok = False
    print(f"stt workers: {list(cfg.stt.workers) or 'none configured'}")
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="door_bridge", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("run", help="run the bridge")
    run.add_argument("--config", type=Path, required=True)
    run.add_argument("--dry-run", action="store_true", help="connect and log, never call Lugn")
    run.add_argument("--with-earcons", action="store_true", help="play earcons even in a dry run")
    run.add_argument("-v", "--verbose", action="store_true")
    chk = sub.add_parser("check", help="validate config, secrets and Lugn capabilities")
    chk.add_argument("--config", type=Path, required=True)
    ear = sub.add_parser("earcons", help="write the synthesized earcons as WAV files")
    ear.add_argument("--out", type=Path, required=True)
    ear.add_argument("--volume", type=float, default=0.35)
    prs = sub.add_parser("parse", help="show how a transcript maps to an action")
    prs.add_argument("text", nargs="+")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if getattr(args, "verbose", False) else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s", stream=sys.stderr)
    try:
        if args.cmd == "run":
            cfg = load_config(args.config, dry_run=True if args.dry_run else None)
            asyncio.run(run_bridge(cfg, with_earcons=args.with_earcons))
            return 0
        if args.cmd == "check":
            return asyncio.run(check(load_config(args.config)))
        if args.cmd == "earcons":
            for path in write_all(args.out, args.volume):
                print(path)
            return 0
        if args.cmd == "parse":
            for text in args.text:
                r = parse(text)
                print(json.dumps({"text": text, "normalized": r.normalized, "reason": r.reason,
                                  "action": action_name(r.action)}, ensure_ascii=False))
            return 0
    except ConfigError as error:
        print(f"config error: {error}", file=sys.stderr)
        return 2
    return 1


if __name__ == "__main__":
    sys.exit(main())
