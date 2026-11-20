"""Run the STT worker: `python -m stt_worker --model KBLab/kb-whisper-small`."""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time

from .server import DEFAULT_PROMPT, WhisperEngine, make_server

log = logging.getLogger("stt_worker")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="stt_worker")
    ap.add_argument("--model", default="KBLab/kb-whisper-small",
                    help="Hugging Face id or local CTranslate2 model directory")
    ap.add_argument("--host", default="127.0.0.1", help="bind address (0.0.0.0 for the LAN)")
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--device", default="cpu", help="cpu, cuda or auto")
    ap.add_argument("--compute-type", default="int8", help="int8, int8_float16, float16, float32")
    ap.add_argument("--threads", type=int, default=0, help="CPU threads (0 = library default)")
    ap.add_argument("--beam-size", type=int, default=1)
    ap.add_argument("--no-prompt", action="store_true", help="do not bias decoding toward commands")
    ap.add_argument("--download-root", default=None, help="model cache directory")
    ap.add_argument("--token-env", default="", help="env var holding a bearer token clients must send")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s", stream=sys.stderr)
    token = os.environ.get(args.token_env, "") if args.token_env else ""
    if args.token_env and not token:
        print(f"{args.token_env} is empty", file=sys.stderr)
        return 2
    t0 = time.monotonic()
    engine = WhisperEngine(args.model, device=args.device, compute_type=args.compute_type,
                           cpu_threads=args.threads, beam_size=args.beam_size,
                           initial_prompt=None if args.no_prompt else DEFAULT_PROMPT,
                           download_root=args.download_root)
    engine.transcribe(b"\x00\x00" * 16000)  # warm up
    log.info("model %s ready in %.1f s", args.model, time.monotonic() - t0)
    server = make_server(args.host, args.port, engine, token or None)
    log.info("listening on http://%s:%d", args.host, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
