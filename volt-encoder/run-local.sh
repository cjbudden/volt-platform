#!/usr/bin/env bash
# Run the REAL Volt encoder as a continuous LOCAL live channel with a built-in player.
# No cloud, no external source.
#   ./run-local.sh            # HLS synthetic source (works with any ffmpeg)
#   MODE=srt ./run-local.sh   # SRT synthetic source (needs ffmpeg built with SRT)
#   PORT=9090 ./run-local.sh  # serve the player on another port
# Watch at http://localhost:8088/  (Ctrl+C stops the channel).
set -uo pipefail
ENC="$(cd "$(dirname "$0")" && pwd)"; . "$ENC/bin/_common.sh"
PORT="${PORT:-8088}"; MODE="${MODE:-hls}"
WORK="$ENC/_local_out"; OUT="$WORK/out"; SRC="$WORK/src"
echo "== Volt encoder — local live channel (mode=$MODE) =="
volt_ensure_deps "$ENC" || exit 2
if [ "$MODE" = srt ] && ! volt_have_srt; then
  echo "ERROR: MODE=srt but this ffmpeg has no SRT. Run without MODE (HLS) or install SRT ffmpeg (brew install ffmpeg)." >&2; exit 2; fi
echo "  ffmpeg=$(command -v ffmpeg)  packager=$(command -v packager)"
rm -rf "$WORK"; mkdir -p "$OUT" "$SRC"; cp "$ENC/player.html" "$WORK/index.html"
volt_write_job "$MODE" "$SRC" "$WORK/job.json"
cleanup(){
  echo; echo "stopping channel..."
  # 1) ask the encoder to shut down gracefully (runs encoder.py's child teardown)
  kill -INT "${ENCP:-0}" 2>/dev/null
  for _ in 1 2 3 4 5; do kill -0 "${ENCP:-0}" 2>/dev/null || break; sleep 1; done
  # 2) hard-stop anything left from THIS run. Every ffmpeg/packager for this run
  #    references the unique _local_out work dir, so matching on it is safe and
  #    will not touch unrelated ffmpeg on your machine.
  pkill -f "run_local_live.py" 2>/dev/null
  pkill -f "$WORK" 2>/dev/null
  [ -n "${SRCP:-}" ] && pkill -P "$SRCP" 2>/dev/null   # synth_source ffmpeg child
  kill "${SRCP:-0}" "${HTTPD:-0}" "${TAILP:-0}" 2>/dev/null
  wait 2>/dev/null; echo "stopped."
}
trap cleanup INT TERM EXIT
echo "  starting synthetic $MODE contribution source..."
"$ENC/bin/synth_source.sh" "$SRC" "$MODE" >"$WORK/source.log" 2>&1 & SRCP=$!
[ "$MODE" = srt ] && sleep 3 || sleep 5
echo "  starting the real encoder (package_only, live)..."
WORK_DIR="$WORK" JOB_CONFIG="$WORK/job.json" python3 "$ENC/bin/run_local_live.py" >"$WORK/encoder.log" 2>&1 & ENCP=$!
( cd "$WORK" && python3 -m http.server "$PORT" >/dev/null 2>&1 ) & HTTPD=$!
sleep 4
cat <<TXT

==================================================================
  LIVE (mode=$MODE). Watch:  http://localhost:${PORT}/
  HLS:  http://localhost:${PORT}/out/master.m3u8
  DASH: http://localhost:${PORT}/out/manifest.mpd
  Logs: $WORK/encoder.log   $WORK/source.log
  Ctrl+C to stop.
==================================================================
TXT
tail -n +1 -f "$WORK/encoder.log" & TAILP=$!
wait "$ENCP"
