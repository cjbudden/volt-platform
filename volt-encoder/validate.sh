#!/usr/bin/env bash
# Volt encoder local validation — TEST ALL. Runs the REAL encoder against a synthetic
# source over BOTH ingest transports (HLS and SRT), with no cloud and no external feed,
# and prints PASS/FAIL for every function. SRT is a required capability: if ffmpeg lacks
# it, the SRT phase FAILS with the fix. Exit 0 only if everything passes.
set -uo pipefail
ENC="$(cd "$(dirname "$0")" && pwd)"; . "$ENC/bin/_common.sh"
RUNSECS="${RUNSECS:-18}"
echo "== Volt encoder — local validation (test all) =="
volt_ensure_deps "$ENC" || exit 2
HAVE_SRT=0; volt_have_srt && HAVE_SRT=1
echo "  ffmpeg=$(command -v ffmpeg)  packager=$(command -v packager)"
echo "  SRT ingest: $([ "$HAVE_SRT" = 1 ] && echo yes || echo 'NO — required for full test')"; echo

pass=0; fail=0
chk(){ if eval "$2"; then printf "  PASS  %s\n" "$1"; pass=$((pass+1)); else printf "  FAIL  %s\n" "$1"; fail=$((fail+1)); fi; }

run_pipeline(){ # $1 transport -> echoes WORK dir (all noise redirected to logs)
  local t="$1" W SRC OUT; W="$(mktemp -d)"; SRC="$W/src"; OUT="$W/out"; mkdir -p "$SRC" "$OUT"
  volt_write_job "$t" "$SRC" "$W/job.json"
  "$ENC/bin/synth_source.sh" "$SRC" "$t" >"$W/source.log" 2>&1 & echo $! >"$W/src.pid"
  [ "$t" = srt ] && sleep 3 || sleep 5
  WORK_DIR="$W" JOB_CONFIG="$W/job.json" python3 "$ENC/bin/run_local_live.py" >"$W/encoder.log" 2>&1 & echo $! >"$W/enc.pid"
  sleep "$RUNSECS"
  kill -INT "$(cat "$W/enc.pid")" 2>/dev/null; sleep 2; kill "$(cat "$W/src.pid")" 2>/dev/null; wait 2>/dev/null
  printf '%s' "$W"
}
assert_pipeline(){ # $1 label $2 workdir
  local L="$1" W="$2" OUT="$2/out" N
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
  chk "[$L] status.json written" "[ -f '$W/status.json' ]"
}

echo "Phase 1 — HLS ingest:"; WH="$(run_pipeline hls)"; assert_pipeline HLS "$WH"; echo
echo "Phase 2 — SRT ingest:"
if [ "$HAVE_SRT" = 1 ]; then WS="$(run_pipeline srt)"; assert_pipeline SRT "$WS"
else
  chk "[SRT] ffmpeg built with SRT (REQUIRED to test SRT ingest)" false
  echo "        fix: brew install ffmpeg   (or: brew upgrade ffmpeg) — the Homebrew build includes SRT."
fi
echo
if [ "$fail" -eq 0 ]; then echo "RESULT: ALL $pass CHECKS PASSED"; exit 0
else echo "RESULT: $fail FAILED, $pass passed. (logs under the temp work dirs above)"; exit 1; fi
