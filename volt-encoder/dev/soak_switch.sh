#!/usr/bin/env bash
# ============================================================================
#  soak_switch.sh: SWITCHING CONTINUITY SOAK, package_only, over SRT.
#
#  Two aligned ABR ladders from e2e/source-ladder.sh (primary on 9000/9001,
#  backup on 9010/9011 with a different picture), the REAL encoder + Shaka
#  with input failover and auto failback, and a cycle repeated for the whole
#  soak:
#     kill the primary  -> backup on air
#     restore primary   -> primary back after the failback hold
#     every FILLER_EVERY-th cycle (default 3) also kill the backup while the primary is down
#                       -> filler (slate) on air, then both back
#  A player simulation follows the DELIVERED playlists (master_cc.m3u8) for
#  the whole soak, and playcheck watches every variant for sequence gaps,
#  rewinds and stalls. PASS needs: no player stall, no playcheck violation,
#  and the encoder switching at every cue.
#
#    cd volt-encoder && SOAK_SEC=1800 CYCLE_SEC=90 dev/soak_switch.sh
#  Defaults: 30 minutes, a cycle every 90 s. Needs ffmpeg with SRT, python3
#  and Shaka (PACKAGER_BIN). Exit code 0 = PASS.
# ============================================================================
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
BIN=$(cd "$HERE/../bin" && pwd)
LADDER=$(cd "$HERE/../../e2e" && pwd)/source-ladder.sh
SOAK_SEC=${SOAK_SEC:-1800}; CYCLE_SEC=${CYCLE_SEC:-90}; FILLER_EVERY=${FILLER_EVERY:-3}
ROOT=${SOAK_DIR:-$HERE/_soak/switch}
rm -rf "$ROOT"; mkdir -p "$ROOT"/{origin,work}
ffmpeg -loglevel error -y -f lavfi -i "color=c=0xC8C800:s=854x480" -frames:v 1 "$ROOT/slate.png"

ladder() {  # ladder <base_port> <pattern> -> pid
  BASE_PORT=$1 PATTERN=$2 bash "$LADDER" > "$ROOT/src_$1.log" 2>&1 &
  echo $!
}
P=$(ladder 9000 testsrc2); B=$(ladder 9010 smptebars)
sleep 2

cat > "$ROOT/job.json" <<JSON
{"channel_id":"soak-switch","workflow":"package_only","segment_seconds":2,"fps":25,"dvr_seconds":120,
 "preserved_segments":0,"gpu":false,"output":{"mode":"local","dir":"$ROOT/origin"},
 "inputs":[
  {"rendition_label":"480p","role":"primary","protocol":"srt","url":"srt://127.0.0.1:9000?mode=caller","height":480,"bitrate_kbps":1200,"has_audio":true},
  {"rendition_label":"240p","role":"primary","protocol":"srt","url":"srt://127.0.0.1:9001?mode=caller","height":240,"bitrate_kbps":400},
  {"rendition_label":"480p","role":"backup","protocol":"srt","url":"srt://127.0.0.1:9010?mode=caller","height":480,"bitrate_kbps":1200,"has_audio":true},
  {"rendition_label":"240p","role":"backup","protocol":"srt","url":"srt://127.0.0.1:9011?mode=caller","height":240,"bitrate_kbps":400}],
 "redundancy":{"input_failover":true,"auto_failback":true,"input_loss_behavior":"slate",
   "filler":{"slate_ref":"$ROOT/slate.png"}}}
JSON

export WORK_DIR="$ROOT/work" LOCAL_MODE=1 JOB_CONFIG="$ROOT/job.json" PACKAGER_BIN=${PACKAGER_BIN:-packager} PYTHONPATH="$BIN"
T0=$(date +%s)
python3 "$BIN/encoder.py" > "$ROOT/encoder.log" 2>&1 & ENC=$!
mark(){ echo "$(( $(date +%s) - T0 )) $1" | tee -a "$ROOT/timeline.txt"; }
cleanup(){ kill -INT $ENC 2>/dev/null; sleep 3; kill -9 $ENC $P $B 2>/dev/null; pkill -9 -f "$ROOT" 2>/dev/null; pkill -9 -f "source-ladder.sh" 2>/dev/null; pkill -9 -f "srt://0.0.0.0:90" 2>/dev/null; }
trap cleanup EXIT
mark start
for i in $(seq 1 60); do ls "$ROOT"/origin/runs/*/master_cc.m3u8 >/dev/null 2>&1 && break; sleep 1; done
RUN=$(ls -d "$ROOT"/origin/runs/* 2>/dev/null | head -1)
if [ -z "$RUN" ] || [ ! -f "$RUN/master_cc.m3u8" ]; then echo "FAIL encoder produced no delivered playlist"; tail -20 "$ROOT/encoder.log"; exit 2; fi
mark "delivering"
WATCH=$(( SOAK_SEC - ( $(date +%s) - T0 ) - 5 ))
python3 "$HERE/playersim.py" --url "$RUN/master_cc.m3u8" --seconds $WATCH --json > "$ROOT/playersim.txt" 2>&1 & PS=$!
python3 "$HERE/playcheck.py" --dir "$RUN" --seconds $WATCH --json > "$ROOT/playcheck.txt" 2>&1 & PC=$!

cycles=0; filler_cycles=0
next=$(( $(date +%s) + 15 ))
while [ $(( $(date +%s) + CYCLE_SEC / 2 + 15 )) -lt $(( T0 + SOAK_SEC )) ]; do
  until [ $(date +%s) -ge $next ]; do sleep 1; done
  cycles=$((cycles + 1))
  pkill -9 -f "srt://0.0.0.0:9000" ; pkill -9 -f "srt://0.0.0.0:9001"; kill -9 $P 2>/dev/null; mark "cycle $cycles: primary KILLED"
  if [ $((cycles % FILLER_EVERY)) -eq 0 ]; then
    sleep $(( CYCLE_SEC / 6 ))
    pkill -9 -f "srt://0.0.0.0:9010"; kill -9 $B 2>/dev/null; mark "cycle $cycles: backup KILLED (filler)"
    filler_cycles=$((filler_cycles + 1))
    sleep $(( CYCLE_SEC / 6 ))
    B=$(ladder 9010 smptebars); mark "cycle $cycles: backup RESTORED"
  fi
  sleep $(( CYCLE_SEC / 3 ))
  P=$(ladder 9000 testsrc2); mark "cycle $cycles: primary RESTORED"
  next=$(( $(date +%s) + CYCLE_SEC * 2 / 3 ))
done
wait $PS $PC

echo; echo "== switches the encoder made =="
grep -oE '"type":"(failover\.[a-z_]+|source\.(up|down)|filler\.[a-z_]+|playout\.splice)"[^}]{0,80}' "$ROOT/encoder.log" | sed 's/^/   /' | head -60
to_backup=$(grep -cE '"type":"failover\.[a-z_]*"[^}]*"to": ?"backup"' "$ROOT/encoder.log")
to_filler=$(grep -cE '"to": ?"filler"' "$ROOT/encoder.log")
to_primary=$(grep -cE '"type":"failover\.[a-z_]*"[^}]*"to": ?"primary"' "$ROOT/encoder.log")
echo; echo "== result =="
echo "   cycles $cycles (filler $filler_cycles): switches to backup $to_backup, to filler $to_filler, back to primary $to_primary"
echo "   player:    $(tail -1 "$ROOT/playersim.txt")"
echo "              $(grep -m1 '^played' "$ROOT/playersim.txt")"
echo "   playcheck: $(tail -1 "$ROOT/playcheck.txt")"
ok=1
tail -1 "$ROOT/playersim.txt" | grep -q '^OK' || ok=0
tail -1 "$ROOT/playcheck.txt" | grep -q '^OK' || ok=0
[ "$to_backup" -ge "$cycles" ] && [ "$to_primary" -ge "$cycles" ] || ok=0
[ "$cycles" -ge 1 ] || ok=0
echo "artefacts: $ROOT"
if [ $ok -eq 1 ]; then echo "PASS switching continuity over $cycles cycle(s)"; exit 0; fi
echo "FAIL switching continuity (see above)"; exit 1
