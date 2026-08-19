#!/usr/bin/env bash
# synctest.sh — run a real channel against a real source and MEASURE whether the
# subtitles line up, in seconds. One command, one verdict, repeatable.
#
#   ./synctest.sh <name> <seconds> [job.json]
#
# What it does, in order:
#   1. runs the real encoder (transcode + packager + live captions) for <seconds>
#   2. decodes the audio the run ACTUALLY DELIVERED and transcribes it offline at
#      high quality with word timestamps: that is the yardstick
#   3. reports how far every published cue sits from the words it belongs to, plus
#      timeline health, caption coverage and word error rate
#   4. plays the output in headless Chromium with hls.js and reports what a viewer
#      would actually see: cue-on-screen sync, start-up time, stalls
#
# Nothing here trusts the encoder's own account of itself. Every number is read back
# off the delivered stream.
#
# Env:
#   PACKAGER_BIN   path to Shaka Packager (default: packager)
#   REF_MODEL      whisper model for the offline yardstick (default: base.en;
#                  use medium.en when you want the strictest reference and have time)
#   SKIP_PLAYER=1  skip the browser stage (needs playwright + chromium)
set -uo pipefail
ENC="$(cd "$(dirname "$0")" && pwd)"
NAME="${1:?usage: synctest.sh <name> <seconds> [job.json]}"
SECS="${2:?usage: synctest.sh <name> <seconds> [job.json]}"
JOB="${3:-$ENC/job.synctest.json}"
REF_MODEL="${REF_MODEL:-base.en}"

ROOT="$ENC/_synctest/$NAME"
rm -rf "$ROOT"; mkdir -p "$ROOT/origin"
sed "s#ORIGIN_DIR#$ROOT/origin#" "$JOB" > "$ROOT/job.json"

echo "== synctest $NAME: ${SECS}s =="
echo "   job:    $ROOT/job.json"
echo "   output: $ROOT/origin"

export WORK_DIR="$ROOT/work" LOCAL_MODE=1 JOB_CONFIG="$ROOT/job.json"
export PACKAGER_BIN="${PACKAGER_BIN:-packager}"
export PYTHONPATH="$ENC/bin"
mkdir -p "$WORK_DIR"

T0=$(date +%s.%N)
python3 "$ENC/bin/encoder.py" > "$ROOT/encoder.log" 2>&1 &
ENCP=$!
cleanup() { kill -INT "$ENCP" 2>/dev/null; sleep 3; kill -9 "$ENCP" 2>/dev/null; }
trap cleanup INT TERM

# START-UP: time to the first playable manifest and to the first caption. Dead air at
# channel start is a viewer-visible cost, so it is measured on every run, not guessed.
( T_MAN=""; T_CUE=""
  while :; do
    [ -z "$T_MAN" ] && ls "$ROOT"/origin/runs/*/master.m3u8 >/dev/null 2>&1 \
      && T_MAN=$(echo "$(date +%s.%N) - $T0" | bc) && echo "first_manifest_sec $T_MAN" >> "$ROOT/startup.txt"
    [ -z "$T_CUE" ] && ls "$ROOT"/origin/runs/*/subtitles/*/sub_*.vtt >/dev/null 2>&1 \
      && T_CUE=$(echo "$(date +%s.%N) - $T0" | bc) && echo "first_caption_sec $T_CUE" >> "$ROOT/startup.txt"
    [ -n "$T_MAN" ] && [ -n "$T_CUE" ] && break
    sleep 0.2
  done ) &
WATCH=$!

echo "   running..."
sleep "$SECS"
cleanup
kill "$WATCH" 2>/dev/null
sleep 2

echo
echo "-- start-up ------------------------------------------------------------"
cat "$ROOT/startup.txt" 2>/dev/null || echo "   (not captured)"

echo
echo "-- ingest health -------------------------------------------------------"
ING=$(grep -c "prematurely\|Error submitting packet\|spectral data" "$ROOT/encoder.log")
echo "   truncated source fetches / corrupt packets: $ING   (want 0)"

echo
echo "-- clean stop ----------------------------------------------------------"
# only count real media children; the shell running this script also carries $ROOT
LEFT=$(pgrep -f "$ROOT" 2>/dev/null | xargs -r ps -o comm= -p 2>/dev/null | grep -cE 'ffmpeg|packager' )
echo "   encoder/packager processes still alive after stop: $LEFT   (want 0)"
grep -o '"type":"channel.stop".*' "$ROOT/encoder.log" | tail -1

echo
echo "-- measured against the delivered audio ---------------------------------"
python3 "$ENC/bin/syncheck.py" "$ROOT" --model "$REF_MODEL" | tee "$ROOT/syncheck.json"

if [ "${SKIP_PLAYER:-0}" != "1" ]; then
  echo
  echo "-- what a real player shows ---------------------------------------------"
  # --vod closes the DVR window so the browser can play the WHOLE of it; a live
  # playlist would leave a stopped channel with only a few seconds before the edge
  python3 "$ENC/bin/playercheck.py" "$ROOT" --vod --seconds 90 | tee "$ROOT/playercheck.json"
fi

echo
echo "== artefacts in $ROOT =="
