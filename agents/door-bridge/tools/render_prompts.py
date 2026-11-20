"""Optionally pre-render Swedish spoken confirmations with Piper (dev machine only).

    python tools/render_prompts.py --voice sv_SE-nst-medium.onnx --out prompts/

Copy the resulting <kind>.wav files to the Pi and set [earcons] prompts_dir.
Any kind without a file keeps its synthesized tone. Nothing is played here.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from piper_tts import synthesize  # noqa: E402

PHRASES = {
    "ok": "Okej.",
    "not_understood": "Det förstod jag inte.",
    "error": "Det gick inte just nu.",
    "cancelled": "Avbrutet.",
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice", type=Path, required=True, help="Piper .onnx voice (sv_SE)")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    for kind, text in PHRASES.items():
        path = args.out / f"{kind}.wav"
        path.write_bytes(synthesize(args.voice, text))
        print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
