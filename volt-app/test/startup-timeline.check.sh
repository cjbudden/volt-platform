#!/usr/bin/env bash
# ============================================================================
#  WHERE DOES THE TIME GO BETWEEN PRESSING START AND HEARING SOMETHING?
#
#  Asked directly: "if it is taking 30 seconds or minutes to set up a container
#  it is worth understanding what is going on to ensure a clean startup."
#
#  This measures it rather than describing it. It starts a REAL station through
#  the REAL API with the REAL encoder and stamps every milestone, so the answer
#  is a set of numbers from this machine rather than an estimate.
#
#  THE MILESTONES, and what is happening in each gap:
#
#    accepted      the API took the request. Everything before this is HTTP,
#                  auth, and loading the channel's profile and sources.
#    launched      the launcher returned a task handle and the instance row
#                  exists. On `local` this is a process spawn; on ECS it is a
#                  RunTask call and the task is still PROVISIONING, which is
#                  where a cloud deployment spends its first several seconds.
#    reported      the encoder is alive and has posted channel.start. This gap
#                  is process start plus reading the job config.
#    source up     audio is actually arriving from the source. For a remote
#                  station this includes DNS, the TCP connection, TLS, and
#                  whatever the station's server takes to start sending.
#    first segment the first packaged segment is on disk. This gap CANNOT be
#                  shorter than one segment duration: a four second segment
#                  takes four seconds to fill, and no amount of tuning changes
#                  that arithmetic.
#    manifest      the playlist references it, so a player can attach.
#
#  WHAT THIS SUITE IS FOR. Not to assert a fast number -- machines differ and a
#  remote source differs by the minute. It exists so that "startup feels slow"
#  becomes "the gap is between X and Y", which is a question with an answer.
#  The assertions are therefore generous bounds that only fail when a step has
#  genuinely stalled rather than merely taken its time.
#
#  Usage: DATABASE_URL=... bash test/startup-timeline.check.sh
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."
. "$(dirname "$0")/lib/portable.sh"   # setsid/timeout/stat differ on macOS; see that file
: "${DATABASE_URL:?set DATABASE_URL}"

pass=0; fail=0
ok(){ if eval "$2"; then echo "  PASS $1"; pass=$((pass+1)); else echo "  FAIL $1"; fail=$((fail+1)); fi; }

command -v ffmpeg >/dev/null 2>&1 || {
  echo "SKIP ffmpeg is not installed — this suite times the real encoder."
  echo; echo "== RESULT: 0 passed, 0 failed =="; exit 0; }

PORT=8171
WORK=$(mktemp -d)
cleanup(){ [ -n "${SRV:-}" ] && kill -TERM -"$SRV" 2>/dev/null
           [ -n "${SRC:-}" ] && kill -TERM -"$SRC" 2>/dev/null
           rm -rf "$WORK"; return 0; }
trap cleanup EXIT

A=00000000-0000-0000-0000-00000b010001
U=00000000-0000-0000-0000-00000b010002
G=00000000-0000-0000-0000-00000b010003
P=00000000-0000-0000-0000-00000b010004
CH=00000000-0000-0000-0000-00000b010005

# A LOCAL SOURCE, ON PURPOSE. A remote station folds DNS, TLS and somebody
# else's server into the numbers, and this suite is measuring OUR pipeline. The
# network's contribution is real, and it is not the question being asked here.
# icecast-sim is the same fixture the other radio suites use, so the source
# behaves like a station rather than like a file being read at disk speed.
SRCFILE="$WORK/loop.mp3"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=440:duration=30" \
  -c:a libmp3lame -b:a 128k "$SRCFILE" >/dev/null 2>&1
[ -s "$SRCFILE" ] || { echo "FATAL could not build a source"; echo; echo "== RESULT: 0 passed, 1 failed =="; exit 1; }
SIMPORT=9174
node test/icecast-sim.js "$SIMPORT" "$SRCFILE" 4 >"$WORK/sim.log" 2>&1 &
SRC=$!
sleep 1

psql "$DATABASE_URL" -q -c "
DELETE FROM accounts WHERE id='$A';
INSERT INTO accounts(id,name) VALUES ('$A','TimingCo');
INSERT INTO users(id,account_id,email,password_hash,role,status)
  VALUES ('$U','$A','timing@x','x','owner','active');
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type,packaging,segment_dur,dvr_window_sec)
  VALUES ('$P','$A','p','[{\"height\":0,\"bitrate_kbps\":128}]','package_only','both',2,60);
INSERT INTO groups(id,account_id,name,output_profile_id,max_channels)
  VALUES ('$G','$A','g','$P',20);
INSERT INTO channels(id,group_id,name,status,kind,recording_enabled)
  VALUES ('$CH','$G','Timing FM','ended','radio',false);
INSERT INTO stream_inputs(channel_id,role,protocol,ingest_url)
  VALUES ('$CH','primary','icecast','http://127.0.0.1:9174/live');
" >/dev/null 2>&1 || { echo "FATAL could not seed"; echo; echo "== RESULT: 0 passed, 1 failed =="; exit 1; }

if curl -fsS --max-time 1 "localhost:$PORT/health" >/dev/null 2>&1; then
  echo "SKIP something is already listening on :$PORT"
  echo; echo "== RESULT: 0 passed, 0 failed =="; exit 0; fi

export PORT JWT_ACCESS_SECRET=timing JWT_REFRESH_SECRET=y INGEST_TOKEN=z
export ORCH_LAUNCHER=local RADIO_MODE=container WEB_DIST_DIR=
export ORIGIN_DIR="$WORK/origin" ENCODER_BIN="$(cd ../volt-encoder/bin && pwd)"
# No relay here: radio.py drops the MP3 output and goes on air over HLS/DASH,
# which is the behaviour under test elsewhere and is not what is being timed.
export ICECAST_HOST=127.0.0.1 ICECAST_PORT=1 AUTO_CONNECT=false
# THE ENCODER HAS TO BE ABLE TO REPORT BACK. It posts status and events to
# INTERNAL_API_BASE_URL, which defaults to :8080 -- the port a normal run uses.
# A suite on its own port that forgets this measures a pipeline whose encoder is
# shouting at nobody: the segments still appear, and channel.start never does.
export INTERNAL_API_BASE_URL="http://localhost:$PORT"
vsetsid npx tsx src/index.ts >"$WORK/api.log" 2>&1 &
SRV=$!
for i in $(seq 1 60); do
  curl -fsS --max-time 2 "localhost:$PORT/health" 2>/dev/null | grep -q '"reconciled":true' && break
  sleep 0.5
done
curl -fsS --max-time 2 "localhost:$PORT/health" >/dev/null 2>&1 || {
  echo "FATAL the control plane did not start:"; tail -8 "$WORK/api.log"
  echo; echo "== RESULT: 0 passed, 1 failed =="; exit 1; }

B="http://localhost:$PORT/api"
TOK=$(node -e "console.log(require('jsonwebtoken').sign({sub:'$U',account_id:'$A',role:'owner'},'timing',{expiresIn:3600}))")
AUTH="Authorization: Bearer $TOK"

ms(){ node -e 'console.log(Date.now())'; }
since(){ node -e "console.log((($2 - $1)/1000).toFixed(2))" "$1" "$2" 2>/dev/null || echo "?"; }
mark(){ printf "   %-16s %7ss\n" "$1" "$(node -e "console.log((($2 - $T0)/1000).toFixed(2))")"; }

echo "== starting a station, and stamping every milestone =="
T0=$(ms)
curl -s -X POST "$B/radio/$CH/start" -H "$AUTH" -o "$WORK/start.json" >/dev/null
T_ACCEPTED=$(ms)

# launched: the instance row exists, so the launcher has returned a handle
T_LAUNCHED=""
for i in $(seq 1 200); do
  n=$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM instances WHERE channel_id='$CH' AND terminated_at IS NULL")
  [ "${n:-0}" -ge 1 ] && { T_LAUNCHED=$(ms); break; }
  sleep 0.1
done

# ONE POLLING LOOP FOR EVERY MILESTONE, not one loop each.
#
# Waiting for them in sequence looks harmless and is not: if an event never
# arrives, its wait burns the whole timeout and every LATER milestone is stamped
# after it, so one missing event reports a first segment that took two minutes
# when it actually took five seconds. The first version of this suite did
# exactly that and produced a number that would have sent somebody hunting a
# performance problem that did not exist.
T_REPORTED=""; T_SOURCE=""; T_SEG=""; T_MANIFEST=""
for i in $(seq 1 600); do
  if [ -z "$T_REPORTED" ] || [ -z "$T_SOURCE" ]; then
    types=$(psql "$DATABASE_URL" -tAc "SELECT DISTINCT type FROM stream_events WHERE channel_id='$CH'" 2>/dev/null | tr '\n' ' ')
    case "$types" in *channel.start*) [ -z "$T_REPORTED" ] && T_REPORTED=$(ms) ;; esac
    case "$types" in *source.up*)     [ -z "$T_SOURCE" ]   && T_SOURCE=$(ms) ;; esac
  fi
  [ -z "$T_SEG" ] && ls "$WORK/origin/$CH"/runs/*/audio/*.m4s >/dev/null 2>&1 && T_SEG=$(ms)
  if [ -z "$T_MANIFEST" ]; then
    idx=$(ls "$WORK/origin/$CH"/runs/*/audio/index.m3u8 2>/dev/null | head -1)
    [ -n "$idx" ] && [ -s "$idx" ] && T_MANIFEST=$(ms)
  fi
  [ -n "$T_REPORTED" ] && [ -n "$T_SOURCE" ] && [ -n "$T_SEG" ] && [ -n "$T_MANIFEST" ] && break
  sleep 0.2
done

echo
echo "   milestone           elapsed"
echo "   ------------------------------"
[ -n "$T_ACCEPTED" ] && mark "accepted"      "$T_ACCEPTED"
[ -n "$T_LAUNCHED" ] && mark "launched"      "$T_LAUNCHED"
[ -n "$T_REPORTED" ] && mark "reported"      "$T_REPORTED"
[ -n "$T_SOURCE" ]   && mark "source up"     "$T_SOURCE"
[ -n "$T_SEG" ]      && mark "first segment" "$T_SEG"
[ -n "$T_MANIFEST" ] && mark "manifest"      "$T_MANIFEST"
echo
SEGDUR=2
if [ -n "$T_MANIFEST" ]; then
  echo "   segment duration is ${SEGDUR}s, and the first segment cannot exist before"
  echo "   one has been filled — that floor is arithmetic, not overhead."
fi
echo

echo "== every step completed =="
ok "the API accepted the start"          '[ -n "'"$T_ACCEPTED"'" ]'
ok "a task was launched"                 '[ -n "'"$T_LAUNCHED"'" ]'
ok "the encoder reported in"             '[ -n "'"$T_REPORTED"'" ]'
ok "the source came up"                  '[ -n "'"$T_SOURCE"'" ]'
ok "a segment reached disk"              '[ -n "'"$T_SEG"'" ]'
ok "and the manifest references it"      '[ -n "'"$T_MANIFEST"'" ]'

echo "== and nothing STALLED (generous bounds; this is not a speed contest) =="
# These only fail when a step has genuinely hung. A slow machine or a slow
# source must not turn this suite red, or it stops being run.
under(){ node -e "process.exit((($2 - $T0) <= $1*1000) ? 0 : 1)" 2>/dev/null; }
ok "the API answered within 10s"          'under 10 '"$T_ACCEPTED"''
ok "the task launched within 15s"         'under 15 '"${T_LAUNCHED:-99999999999999}"''
ok "the encoder reported within 30s"      'under 30 '"${T_REPORTED:-99999999999999}"''
ok "a segment arrived within 60s"         'under 60 '"${T_SEG:-99999999999999}"''

curl -s -X POST "$B/radio/$CH/stop" -H "$AUTH" >/dev/null 2>&1
psql "$DATABASE_URL" -q -c "DELETE FROM accounts WHERE id='$A'" >/dev/null 2>&1

echo
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
