#!/bin/sh
# Rebuilds the scene vocabularies (data/photo-scenes*.json) from
# data/photo-scenes.source.json with the SigLIP 2 text towers.
#
#   agents/linux/photo-brain/scripts/build-scenes.sh [so400m|base|all] [extra build_scenes.py options]
#
# Makes a throw-away virtualenv (never committed) under $LUGN_SCENES_CACHE
# (default ~/.cache/lugn-photo-brain/scene-build), downloads the pinned text
# tower and tokenizer once, and writes the JSON files into data/.
# Needs ~1 GB of disk for so400m's int8 text tower and ~1.5 GB of RAM.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cache=${LUGN_SCENES_CACHE:-$HOME/.cache/lugn-photo-brain/scene-build}
which=${1:-all}
[ $# -gt 0 ] && shift
mkdir -p "$cache"
if [ ! -x "$cache/venv/bin/python" ]; then
  if command -v uv >/dev/null 2>&1; then
    uv venv -q --python 3.12 "$cache/venv"
    VIRTUAL_ENV="$cache/venv" uv pip install -q onnxruntime==1.31.1 numpy tokenizers onnx
  else
    python3 -m venv "$cache/venv"
    "$cache/venv/bin/pip" install -q onnxruntime==1.31.1 numpy tokenizers onnx
  fi
fi
case $which in
  all) models="so400m base" ;;
  *) models=$which ;;
esac
for model in $models; do
  nice -n 15 "$cache/venv/bin/python" -I "$here/build_scenes.py" --model "$model" --cache "$cache" "$@"
done
