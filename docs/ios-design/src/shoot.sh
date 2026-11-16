#!/usr/bin/env bash
# Renders PNGs of the prototypes with headless Chrome at 402x874 pt, 2x.
# Usage: docs/ios-design/src/shoot.sh [name ...]   (no args: every shot)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
screens="$here/../screens"
png="$here/../png"
chrome="${CHROME:-google-chrome}"
mkdir -p "$png"

# output-name  file  query
shots=(
  "hem hem.html -"
  "hem-ljus hem-ljus.html -"
  "hem-sakra-ytor hem.html safe"
  "offline offline.html -"
  "belysning belysning.html -"
  "belysning-hall-blad belysning.html sheet=mys"
  "belysning-hall-blad-farg belysning.html sheet=party"
  "musik musik.html -"
  "narvaro narvaro.html state=rorelse"
  "narvaro-nagon-ar-kvar narvaro.html state=stilla"
  "narvaro-verkar-tomt narvaro.html state=tomt"
  "godnatt godnatt.html -"
  "godnatt-nedtoning godnatt.html step=fade"
  "godnatt-live-activity godnatt-live.html -"
  "godnatt-dynamic-island godnatt-live.html di"
  "varfor varfor.html -"
  "varfor-avstod varfor.html filter=avstod"
  "telefon telefon.html -"
  "tillstand tillstand.html -"
  "tillstand-ljus tillstand.html theme=light"
)

for s in "${shots[@]}"; do
  read -r name file query <<<"$s"
  if [ "$#" -gt 0 ] && [[ ! " $* " =~ " $name " ]]; then continue; fi
  [ -f "$screens/$file" ] || { echo "skip $name (no $file)"; continue; }
  url="file://$screens/$file"
  [ "$query" != "-" ] && url="$url?$query&shot" || url="$url?shot"
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --no-first-run \
    --force-device-scale-factor=2 --window-size=402,874 \
    --virtual-time-budget=6000 --screenshot="$png/$name.png" "$url" >/dev/null 2>&1
  echo "shot $name"
done
