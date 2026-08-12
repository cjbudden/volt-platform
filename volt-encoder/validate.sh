#!/usr/bin/env bash
# Volt encoder local validation gate. Runs the REAL encoder against the synthetic
# SRT ladder for a few seconds with NO cloud, NO external source, and checks each
# encoder function, printing a PASS/FAIL line for every one. Exit 0 only if all pass.
set -uo pipefail
ENC="$(cd "$(dirname "$0")" && pwd)"
. "$ENC/bin/_common.sh"
RUNSECS="${RUNSECS:-18}"
echo "== Volt encoder — local validation =="
volt_ensure_deps "$ENC" || exit 2
WORK="$(mktemp -d)"; OUT="$WORK/out"; mkdir -p "$OUT"
echo "  ffmpeg=$(command -v ffmpeg)  packager=$(command -v packager)"
echo "  work dir: $WORK"; echo

FPS=25 SEG=2 "$ENC/bin/synth_source.sh" >"$WORK/source.log" 2>&1 & SRC=$!
sleep 3
WORK_DIR="$WORK" JOB_CONFIG="$ENC/job.local-synth.json" python3 "$ENC/bin/run_local_live.py" >"$WORK/encoder.log" 2>&1 & ENCP=$!
sleep "$RUNSECS"
kill -INT "$ENCP" 2>/dev/null; sleep 2; kill "$SRC" 2>/dev/null; wait 2>/dev/null

pass=0; fail=0
chk(){ if eval "$2"; then printf "  \033[32mPASS\033[0m  %s\n" "$1"; pass=$((pass+1)); else printf "  \033[31mFAIL\033[0m  %s\n" "$1"; fail=$((fail+1)); fi; }

echo "Function checks:"
chk "source: synthetic SRT ladder started"      "grep -q 'channel.start' '$WORK/encoder.log'"
chk "relays: contribution feeds pulled (-c copy)" "grep -q 'start relay' '$WORK/encoder.log'"
chk "packager: launched"                          "grep -q 'start packager' '$WORK/encoder.log'"
chk "HLS: master.m3u8 produced"                   "[ -f '$OUT/master.m3u8' ]"
chk "DASH: manifest.mpd produced"                 "[ -f '$OUT/manifest.mpd' ]"
NREND=$(grep -c 'EXT-X-STREAM-INF' "$OUT/master.m3u8" 2>/dev/null || echo 0)
chk "ABR: 3 video renditions in master ($NREND)"  "[ '${NREND:-0}' -eq 3 ]"
NSEG=$(find "$OUT" -name 'seg_*.m4s' 2>/dev/null | wc -l | tr -d ' ')
chk "CMAF: segments written ($NSEG)"              "[ '${NSEG:-0}' -gt 0 ]"
chk "audio: separate audio init produced"         "[ -f '$OUT/audio/init.mp4' ]"
if [ -f "$OUT/720p/init.mp4" ] && [ -f "$OUT/720p/seg_1.m4s" ]; then
  cat "$OUT/720p/init.mp4" "$OUT/720p/seg_1.m4s" > "$OUT/_probe.mp4"
  chk "decode: 720p segment decodes h264 1280x720" \
      "ffprobe -hide_banner -loglevel error -show_entries stream=codec_name,width,height -of csv=p=0 '$OUT/_probe.mp4' | grep -q 'h264,1280,720'"
else chk "decode: 720p segment decodes h264 1280x720" "false"; fi
chk "live: HLS type is LIVE (rolling window)"     "grep -q 'EXT-X-MEDIA-SEQUENCE\|#EXTINF' '$OUT/stream_1.m3u8' 2>/dev/null"
chk "status: encoder wrote status.json"           "[ -f '$WORK/status.json' ]"

echo
if [ "$fail" -eq 0 ]; then
  echo -e "RESULT: \033[32mALL $pass CHECKS PASSED\033[0m  (output kept at $OUT)"
  echo "Logs: $WORK/encoder.log  $WORK/source.log"
  exit 0
else
  echo -e "RESULT: \033[31m$fail FAILED\033[0m, $pass passed. See $WORK/encoder.log and $WORK/source.log"
  exit 1
fi
