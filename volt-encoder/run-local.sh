#!/usr/bin/env bash
# Run the REAL Volt encoder as a continuous LOCAL live channel, with NO cloud and
# NO external source. A synthetic SRT ladder feeds the real encoder; Shaka packages
# live HLS+DASH into ./_local_out/out, served with a built-in player.
#
#   ./run-local.sh              # synthetic source (always works, fully offline)
#   PORT=9090 ./run-local.sh    # serve the player on a different port
#
# Watch it at:  http://localhost:8088/   (Ctrl+C to stop the channel)
set -uo pipefail
ENC="$(cd "$(dirname "$0")" && pwd)"
. "$ENC/bin/_common.sh"
PORT="${PORT:-8088}"
WORK="$ENC/_local_out"; OUT="$WORK/out"

echo "== Volt encoder — local live channel =="
volt_ensure_deps "$ENC" || exit 2
echo "  ffmpeg=$(command -v ffmpeg)  packager=$(command -v packager)"
rm -rf "$WORK"; mkdir -p "$OUT"
cp "$ENC/player.html" "$WORK/index.html"

cleanup(){ echo; echo "stopping channel..."; kill -INT "${ENCP:-0}" 2>/dev/null; sleep 1; kill "${SRC:-0}" "${HTTPD:-0}" 2>/dev/null; wait 2>/dev/null; echo "stopped."; }
trap cleanup INT TERM EXIT

echo "  starting synthetic SRT contribution ladder (720p/480p/360p)..."
FPS=25 SEG=2 "$ENC/bin/synth_source.sh" >"$WORK/source.log" 2>&1 & SRC=$!
sleep 3
echo "  starting the real encoder (package_only, live)..."
WORK_DIR="$WORK" JOB_CONFIG="$ENC/job.local-synth.json" python3 "$ENC/bin/run_local_live.py" >"$WORK/encoder.log" 2>&1 & ENCP=$!
( cd "$WORK" && python3 -m http.server "$PORT" >/dev/null 2>&1 ) & HTTPD=$!
sleep 4

cat <<TXT

==================================================================
  LIVE. Watch it here:  http://localhost:${PORT}/
  HLS master:           http://localhost:${PORT}/out/master.m3u8
  DASH manifest:        http://localhost:${PORT}/out/manifest.mpd
  Logs:                 $WORK/encoder.log   $WORK/source.log
  This runs continuously. Press Ctrl+C to stop the channel.
==================================================================
TXT
# stream encoder log until the user stops
tail -n +1 -f "$WORK/encoder.log" &
wait "$ENCP"
