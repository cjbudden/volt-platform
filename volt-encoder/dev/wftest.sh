#!/usr/bin/env bash
# ============================================================================
#  wftest.sh — failover / failback / fallback-to-loop / watermark, end to end,
#  against the REAL encoder + Shaka, with sources you can kill on cue.
#
#    cd volt-encoder && dev/wftest.sh [vod_loop|slate] [transcode|package_only]
#
#  Needs ffmpeg, python3 and Shaka (PACKAGER_BIN, default `packager`). ~4.5 min.
#
#  Sources are synthetic live HLS feeds served over HTTP, each a different
#  colour so every output segment can be classified by what it shows:
#    primary = RED, backup = BLUE, loop = GREEN, slate = YELLOW.
#  A white square watermark is burned in bottom-right (transcode only).
#
#  Timeline (seconds from start):
#     0   start primary + backup + encoder
#    60   kill -9 primary           -> expect BACKUP on air
#   110   kill -9 backup            -> expect LOOP (or SLATE) on air
#   160   restart primary           -> expect PRIMARY back after the failback hold
#   230   stop, then classify every delivered segment and check continuity
# ============================================================================
set -uo pipefail
LOSS=${1:-vod_loop}; WF=${2:-transcode}
HERE=$(cd "$(dirname "$0")" && pwd)
BIN=${BIN:-$(cd "$HERE/../bin" && pwd)}
[ -z "${PYTHON_BIN:-}" ] && [ -x "$HERE/../.venv/bin/python3" ] && PYTHON_BIN="$HERE/../.venv/bin/python3"
NAME=wf_${LOSS}_${WF}; ROOT=$HERE/_wftest/$NAME
A=$HERE/_wftest/assets; mkdir -p "$A"
# test assets, generated once: yellow slate, green 12s loop (not faststart, like most
# uploads), white square watermark
[ -s "$A/slate.png" ] || ffmpeg -loglevel error -y -f lavfi -i "color=c=0xC8C800:s=1280x720" -frames:v 1 "$A/slate.png"
[ -s "$A/loop.mp4" ]  || ffmpeg -loglevel error -y -f lavfi -i "color=c=0x00B400:s=640x360:r=25,drawbox=x='mod(t*80,600)':y=150:w=40:h=40:c=white:t=fill" -f lavfi -i "sine=f=660:r=48000" -t 12 -c:v libx264 -preset veryfast -g 50 -c:a aac -shortest "$A/loop.mp4"
[ -s "$A/wm.png" ]    || ffmpeg -loglevel error -y -f lavfi -i "color=c=white:s=120x120" -frames:v 1 "$A/wm.png"
rm -rf "$ROOT"; mkdir -p "$ROOT"/{www/primary,www/backup,origin,work}
cp "$A"/slate.png "$A"/loop.mp4 "$A"/wm.png "$ROOT/www/"
PORT=${PORT:-9100}
fuser -k $PORT/tcp 2>/dev/null; sleep 0.3
( cd "$ROOT/www" && exec python3 -m http.server $PORT >/dev/null 2>&1 ) & HTTP=$!

src() {  # src <name> <colour>
  local d="$ROOT/www/$1"
  ffmpeg -hide_banner -loglevel error -re \
    -f lavfi -i "color=c=$2:s=640x360:r=25,drawbox=x='mod(t*80,600)':y=150:w=40:h=40:c=white:t=fill" \
    -f lavfi -i "sine=f=440:r=48000" \
    -c:v libx264 -preset ultrafast -tune zerolatency -g 50 -keyint_min 50 -sc_threshold 0 -b:v 800k \
    -c:a aac -b:a 96k -f hls -hls_time 2 -hls_list_size 8 -hls_flags delete_segments+independent_segments \
    "$d/index.m3u8" > "$ROOT/src_$1.log" 2>&1 &
  echo $!
}
P=$(src primary 0xC80000); B=$(src backup 0x0000C8)
for i in $(seq 1 40); do [ -s "$ROOT/www/primary/index.m3u8" ] && [ -s "$ROOT/www/backup/index.m3u8" ] && break; sleep 0.5; done
sleep 4

U=http://127.0.0.1:$PORT
if [ "$WF" = "package_only" ]; then
  INPUTS="[{\"rendition_label\":\"360p\",\"role\":\"primary\",\"protocol\":\"hls\",\"url\":\"$U/primary/index.m3u8\",\"height\":360,\"bitrate_kbps\":800,\"has_audio\":true},
           {\"rendition_label\":\"360p\",\"role\":\"backup\",\"protocol\":\"hls\",\"url\":\"$U/backup/index.m3u8\",\"height\":360,\"bitrate_kbps\":800,\"has_audio\":true}]"
  WM=""
else
  INPUTS="[{\"rendition_label\":\"mezzanine\",\"role\":\"primary\",\"protocol\":\"hls\",\"url\":\"$U/primary/index.m3u8\",\"has_audio\":true},
           {\"rendition_label\":\"mezzanine\",\"role\":\"backup\",\"protocol\":\"hls\",\"url\":\"$U/backup/index.m3u8\",\"has_audio\":true}]"
  WM=",\"watermark\":{\"url\":\"$U/wm.png\",\"position\":\"br\",\"offset_x\":16,\"offset_y\":16,\"opacity\":100,\"scale\":20}"
fi
cat > "$ROOT/job.json" <<JSON
{"channel_id":"$NAME","workflow":"$WF","segment_seconds":4,"fps":25,"dvr_seconds":600,
 "preserved_segments":0,"gpu":false,"output":{"mode":"local","dir":"$ROOT/origin"},
 "inputs":$INPUTS,
 "ladder":[{"height":360,"bitrate_kbps":800},{"height":240,"bitrate_kbps":400}],
 "redundancy":{"input_failover":true,"auto_failback":true,"input_loss_behavior":"$LOSS",
   "filler":{"slate_ref":"$U/slate.png","vod_loop_url":"$U/loop.mp4"}}$WM}
JSON

export WORK_DIR="$ROOT/work" LOCAL_MODE=1 JOB_CONFIG="$ROOT/job.json" PACKAGER_BIN=${PACKAGER_BIN:-packager} PYTHONPATH="$BIN"
T0=$(date +%s)
"${PYTHON_BIN:-python3}" "$BIN/encoder.py" > "$ROOT/encoder.log" 2>&1 & ENC=$!
mark(){ echo "$(( $(date +%s) - T0 )) $1" | tee -a "$ROOT/timeline.txt"; }
mark start
for i in $(seq 1 60); do ls "$ROOT"/origin/runs/*/master.m3u8 >/dev/null 2>&1 && break; sleep 1; done
RUN=$(ls -d "$ROOT"/origin/runs/* | head -1)
# the delivered master appears once every rendition has its spliced playlist
for i in $(seq 1 40); do [ -f "$RUN/master_cc.m3u8" ] && break; sleep 0.5; done
python3 "$HERE/playcheck.py" --dir "$RUN" --seconds 215 --json > "$ROOT/playcheck.txt" 2>&1 & PC=$!
# what a player behind the live edge experiences: the DELIVERED playlists (with the
# loop spliced in) and, for comparison, the packager's own
python3 "$HERE/playersim.py" --url "$RUN/master_cc.m3u8" --seconds 215 --json > "$ROOT/playersim.txt" 2>&1 & PS=$!
python3 "$HERE/playersim.py" --url "$RUN/master.m3u8" --seconds 215 --json > "$ROOT/playersim_raw.txt" 2>&1 & PR=$!
# DASH: the same check against the delivered multi-Period MPD, and a REAL DASH client
# (gpac, when installed) following it live through every Period change and recording
# what it played
python3 "$HERE/playersim.py" --url "$RUN/manifest_cc.mpd" --seconds 215 --json --dump "$ROOT/dash_seen.json" > "$ROOT/playersim_dash.txt" 2>&1 & PD=$!
DPORT=$((PORT + 1)); fuser -k $DPORT/tcp 2>/dev/null
( cd "$RUN" && exec python3 -m http.server --protocol HTTP/1.1 $DPORT >/dev/null 2>&1 ) & HTTP2=$!
GP=""
if command -v gpac >/dev/null 2>&1; then
  # join once a few segments exist, like a viewer would, and follow it to the end
  ( until [ $(( $(date +%s) - T0 )) -ge 30 ]; do sleep 1; done
    exec timeout 195 gpac -i "http://127.0.0.1:$DPORT/manifest_cc.mpd" -o "$ROOT/dash_rec.ts" -logs=dash@info > "$ROOT/gpac.log" 2>&1 ) & GP=$!
fi

# REAL browser players (Chrome with H.264 + the console's own hls.js and dash.js), when
# CHROME_BIN is set: one with the library's live start, one with the console's start
BW=""
if [ -n "${CHROME_BIN:-}" ]; then
  ( until [ $(( $(date +%s) - T0 )) -ge 20 ]; do sleep 1; done
    for f in ${BROWSER_SET:-master_cc.m3u8 manifest_cc.mpd}; do for sn in ${BROWSER_SNAP:-none product}; do
      node "$HERE/browsercheck.mjs" --url "http://127.0.0.1:$DPORT/$f" --seconds 205 --snap $sn \
        --log "$ROOT/browser_${f%%.*}_$sn.log" --dash-log "${DASH_LOG:-2}" > "$ROOT/browser_${f%%.*}_$sn.txt" 2>&1 &
    done; done; wait ) & BW=$!
fi
until [ $(( $(date +%s) - T0 )) -ge 60 ]; do sleep 1; done;  kill -9 $P; mark "primary KILLED"
until [ $(( $(date +%s) - T0 )) -ge 110 ]; do sleep 1; done; kill -9 $B; mark "backup KILLED"
until [ $(( $(date +%s) - T0 )) -ge 160 ]; do sleep 1; done
rm -f "$ROOT"/www/primary/*; P=$(src primary 0xC80000); mark "primary RESTARTED"
until [ $(( $(date +%s) - T0 )) -ge 230 ]; do sleep 1; done; mark stop
wait $PC $PS $PR $PD
[ -n "$GP" ] && wait $GP 2>/dev/null
[ -n "$BW" ] && wait $BW 2>/dev/null
cp "$RUN"/stream_*_cc.m3u8 "$ROOT/" 2>/dev/null
kill -INT $ENC; sleep 4; kill -9 $ENC 2>/dev/null; kill -9 $P $HTTP $HTTP2 2>/dev/null
pkill -9 -f "$ROOT" 2>/dev/null

echo; echo "== source events (encoder's own account) =="
grep -oE '"type":"(source\.[a-z_]+|failover[a-z_.]*|filler[a-z_.]*)"[^}]*' "$ROOT/encoder.log" | head -30
echo; echo "== what the player was handed (delivered 360p playlist, by colour) =="
CC=$(awk '/RESOLUTION=[0-9]+x360/{getline; print; exit}' "$RUN/master_cc.m3u8" 2>/dev/null)
if [ -n "$CC" ] && [ -f "$RUN/$CC" ]; then
  cp "$ROOT/$CC" "$RUN/$CC" 2>/dev/null
  python3 "$HERE/classify.py" "$RUN/$CC" | tee "$ROOT/classify.txt"
else
  echo "   (no delivered playlist; packager output instead)"
  python3 "$HERE/classify.py" "$RUN" | tee "$ROOT/classify.txt"
fi
grep -oE '"type":"playout\.[a-z]+"[^}]*' "$ROOT/encoder.log" | head -12
echo; echo "== would a player have stalled? =="
echo "   delivered (with splice): $(tail -1 "$ROOT/playersim.txt")"
echo "                            $(grep -m1 '^played' "$ROOT/playersim.txt")"
echo "   packager only (before):  $(tail -1 "$ROOT/playersim_raw.txt")"
echo
echo "== DASH (delivered manifest_cc.mpd) =="
echo "   periods/segments: $(grep -m1 '^DASH:' "$ROOT/playersim_dash.txt")"
echo "   player:           $(tail -1 "$ROOT/playersim_dash.txt")"
python3 "$HERE/classify.py" "$RUN/manifest_cc.mpd" | grep SEQUENCE | sed 's/^/   listed:   /'
if [ -s "$ROOT/dash_rec.ts" ]; then
  echo "   a real DASH client (gpac) played, 1 frame per 4s:"
  python3 "$HERE/classify.py" "$ROOT/dash_rec.ts" | grep SEQUENCE | sed 's/^/   played:   /'
  grep -ciE "error|fail" "$ROOT/gpac.log" | sed 's/^/   gpac errors: /'
fi
if [ -n "$BW" ]; then
  echo; echo "== a real browser (Chrome, the console's hls.js and dash.js), colour on screen each second =="
  for x in "$ROOT"/browser_*.txt; do echo "   $(basename "$x" .txt):"; grep -vE '^\{' "$x" | sed 's/^/     /'; done
fi
echo; echo "== playback continuity (playcheck) =="; tail -4 "$ROOT/playcheck.txt"
echo "artefacts: $ROOT"
