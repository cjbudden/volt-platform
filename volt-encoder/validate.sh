#!/usr/bin/env bash
# Volt encoder local validation. Runs the REAL encoder against a synthetic source,
# no cloud and no external feed, and prints PASS/FAIL for every function.
# HLS ingest is tested natively (any ffmpeg). SRT ingest is tested natively only if
# your ffmpeg has SRT; if not, use ./validate-docker.sh which tests ALL (incl. SRT)
# inside a Linux container whose ffmpeg has SRT (the production runtime).
set -uo pipefail
ENC="$(cd "$(dirname "$0")" && pwd)"; . "$ENC/bin/_common.sh"
RUNSECS="${RUNSECS:-18}"
echo "== Volt encoder — local validation =="
volt_ensure_deps "$ENC" || exit 2
HAVE_SRT=0; volt_have_srt && HAVE_SRT=1
echo "  ffmpeg=$(command -v ffmpeg)  packager=$(command -v packager)"
echo "  SRT ingest here: $([ "$HAVE_SRT" = 1 ] && echo yes || echo 'no (tested via validate-docker.sh)')"; echo

pass=0; fail=0
chk(){ if eval "$2"; then printf "  PASS  %s\n" "$1"; pass=$((pass+1)); else printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); fi; }
run_pipeline(){ local t="$1" W SRC OUT; W="$(mktemp -d)"; SRC="$W/src"; OUT="$W/out"; mkdir -p "$SRC" "$OUT"
  volt_write_job "$t" "$SRC" "$W/job.json"
  "$ENC/bin/synth_source.sh" "$SRC" "$t" >"$W/source.log" 2>&1 & echo $! >"$W/src.pid"
  [ "$t" = srt ] && sleep 3 || sleep 5
  WORK_DIR="$W" JOB_CONFIG="$W/job.json" python3 "$ENC/bin/run_local_live.py" >"$W/encoder.log" 2>&1 & echo $! >"$W/enc.pid"
  sleep "$RUNSECS"; kill -INT "$(cat "$W/enc.pid")" 2>/dev/null; sleep 2; kill "$(cat "$W/src.pid")" 2>/dev/null; wait 2>/dev/null
  printf '%s' "$W"; }
assert_pipeline(){ local L="$1" W="$2" OUT="$2/out" N
  chk "[$L] source: synthetic $L ladder started" "grep -q 'channel.start' '$W/encoder.log'"
  chk "[$L] relay pulled contribution feed (-c copy)" "grep -q 'start relay' '$W/encoder.log'"
  chk "[$L] packager launched" "grep -q 'start packager' '$W/encoder.log'"
  chk "[$L] HLS master.m3u8" "[ -f '$OUT/master.m3u8' ]"
  chk "[$L] DASH manifest.mpd" "[ -f '$OUT/manifest.mpd' ]"
  chk "[$L] 3 ABR renditions" "[ \"\$(grep -c EXT-X-STREAM-INF '$OUT/master.m3u8' 2>/dev/null)\" = 3 ]"
  N=$(find "$OUT" -name 'seg_*.m4s' 2>/dev/null | wc -l | tr -d ' '); chk "[$L] CMAF segments ($N)" "[ '${N:-0}' -gt 0 ]"
  chk "[$L] audio track" "[ -f '$OUT/audio/init.mp4' ]"
  if [ -f "$OUT/720p/init.mp4" ] && [ -f "$OUT/720p/seg_1.m4s" ]; then
    cat "$OUT/720p/init.mp4" "$OUT/720p/seg_1.m4s" > "$OUT/_p.mp4"
    chk "[$L] 720p decodes h264 1280x720" "ffprobe -hide_banner -loglevel error -show_entries stream=codec_name,width,height -of csv=p=0 '$OUT/_p.mp4' | grep -q 'h264,1280,720'"
  else chk "[$L] 720p decodes h264 1280x720" false; fi
  chk "[$L] status.json written" "[ -f '$W/status.json' ]"; }

echo "Phase 1 — HLS ingest:"; WH="$(run_pipeline hls)"; assert_pipeline HLS "$WH"; echo
echo "Phase 2 — SRT ingest:"
if [ "$HAVE_SRT" = 1 ]; then WS="$(run_pipeline srt)"; assert_pipeline SRT "$WS"
else
  echo "  SKIPPED here — this ffmpeg has no SRT (it lists only 'srtp')."
  echo "  Test SRT ingest the production way (Linux ffmpeg with SRT, in Docker):"
  echo "      bash validate-docker.sh"
  echo "  (or install an SRT-enabled ffmpeg natively — see RUN_LOCAL.md)."
fi
echo
if [ "$fail" -eq 0 ]; then echo "RESULT: ALL $pass CHECKS PASSED$([ "$HAVE_SRT" = 1 ] || echo ' (HLS; run validate-docker.sh for SRT)')"; exit 0
else echo "RESULT: $fail FAILED, $pass passed."; exit 1; fi
