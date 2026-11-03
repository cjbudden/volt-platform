#!/usr/bin/env bash
# ============================================================================
#  RADIO AS A CONTAINER, END TO END, WITH NO RELAY (build queue 2.1c-2).
#
#      RADIO_MODE=container   a station is a launched task, not our child
#      ORCH_LAUNCHER=local    which here runs volt-radio's OWN entrypoint,
#                             bin/radio.py, so what is exercised is the code
#                             the image runs rather than a stand-in
#      an Icecast source      the station PULLS an Icecast mount (the input
#                             that stays); test/icecast-sim.js plays it
#
#  What is proven:
#
#    1. THE STATION PLAYS over HLS into the per-run origin layout television
#       uses, and pushes nothing anywhere: there is no relay and no MP3 output.
#    2. MP3 IS OFF unless the account has the feed switched on: the public and
#       preview MP3 addresses answer 404 and none is advertised. With the switch
#       on and the station on air, MP3 is made on demand from the HLS by the
#       control plane, with ICY metadata; off air it is closed again.
#    3. LIVENESS IS ANSWERABLE FROM THE DATABASE, without the in-process map.
#
#  Skips honestly when ffmpeg or radio.py is missing rather than failing.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."
. "$(dirname "$0")/lib/portable.sh"   # setsid/timeout/stat differ on macOS; see that file
: "${DATABASE_URL:?set DATABASE_URL}"

command -v ffmpeg   >/dev/null 2>&1 || { echo "SKIP ffmpeg not installed";   echo; echo "== RESULT: 0 passed, 0 failed =="; exit 0; }
[ -f ../volt-encoder/bin/radio.py ] || { echo "SKIP volt-encoder/bin/radio.py not found"; echo; echo "== RESULT: 0 passed, 0 failed =="; exit 0; }

# FIXED, and deliberately not ${PORT:-...}: inheriting PORT from the
# environment made this suite silently talk to whatever control plane already
# owned that port, with its own database and its own radio mode. Every
# assertion still "ran", against the wrong server.
PORT=8137
ICE_PORT=$((PORT + 40))
WORK=$(mktemp -d)
ORIGIN="$WORK/origin"
mkdir -p "$ORIGIN"

pass=0; fail=0
ok(){ if eval "$2"; then echo "  PASS $1"; pass=$((pass+1)); else echo "  FAIL $1"; fail=$((fail+1)); fi; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }

cleanup() {
  [ -n "${SRV:-}" ] && { kill -TERM -"$SRV" 2>/dev/null || kill "$SRV" 2>/dev/null; }
  [ -n "${UP:-}"  ] && kill "$UP"  2>/dev/null
  pkill -f "radio.py" 2>/dev/null
  sleep 0.5
  # KEEP_WORK=1 leaves the api and station logs behind. Without it a
  # failure here deletes the only evidence of why.
  if [ "${KEEP_WORK:-}" = "1" ]; then echo "  (work dir kept: $WORK)"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

# ---- an Icecast source to pull --------------------------------------------------
CH=00000000-0000-0000-0000-0000099300c1
ffmpeg -hide_banner -loglevel error -f lavfi -i "sine=frequency=440:duration=60" \
  -c:a libmp3lame -b:a 128k "$WORK/loop.mp3" -y
node test/icecast-sim.js "$ICE_PORT" "$WORK/loop.mp3" 4 >"$WORK/up.log" 2>&1 &
UP=$!
for i in $(seq 1 20); do curl -s -o /dev/null --max-time 1 "http://localhost:$ICE_PORT/" && break || sleep 0.25; done

# ---- fixtures ----------------------------------------------------------------
A=00000000-0000-0000-0000-0000099300a1
U=00000000-0000-0000-0000-0000099300f1
G=00000000-0000-0000-0000-0000099300b1
D=00000000-0000-0000-0000-0000099300d1
psql "$DATABASE_URL" -q -c "
DELETE FROM accounts WHERE id='$A';
INSERT INTO accounts(id,name) VALUES ('$A','StationCo');
INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES ('$U','$A','r@x','x','owner','active');
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('$D','$A','p','[]','package_only');
INSERT INTO groups(id,account_id,name,output_profile_id) VALUES ('$G','$A','g','$D');
INSERT INTO channels(id,group_id,name,status,kind,radio_config,on_air)
  VALUES ('$CH','$G','Pull FM','scheduled','radio','{\"bitrateKbps\":128,\"outputs\":{\"mp3\":true,\"hls\":true,\"dash\":false}}'::jsonb,false);
INSERT INTO stream_inputs(channel_id,role,protocol,ingest_url)
  VALUES ('$CH','primary','icecast','http://localhost:$ICE_PORT/upstream.mp3');" >/dev/null

# ---- the control plane, in container mode ------------------------------------
export PORT
export JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z CORS_ORIGIN='*'
export ORIGIN_DIR="$ORIGIN" ENCODER_BIN="$PWD/../volt-encoder/bin"
export ORCH_LAUNCHER=local RADIO_MODE=container
if curl -fsS --max-time 1 "localhost:$PORT/health" >/dev/null 2>&1; then
  echo "SKIP something is already listening on :$PORT; refusing to test against it"
  echo; echo "== RESULT: 0 passed, 0 failed =="; exit 0
fi
# vsetsid so SRV is a PROCESS GROUP LEADER. `npx tsx` spawns node as a child, so
# killing the recorded pid killed the wrapper and left the actual control plane
# running and holding the port. The next run then found the port busy and
# skipped, which reads as a flaky suite and is really a leaked server.
vsetsid npx tsx src/index.ts >"$WORK/api.log" 2>&1 &
SRV=$!
for i in $(seq 1 40); do curl -fsS "localhost:$PORT/health" >/dev/null 2>&1 && break || sleep 0.5; done
if ! curl -fsS --max-time 2 "localhost:$PORT/health" >/dev/null 2>&1; then
  echo "FATAL the control plane did not come up:"; tail -8 "$WORK/api.log"
  echo; echo "== RESULT: 0 passed, 1 failed =="; exit 1
fi
for i in $(seq 1 40); do curl -fsS "localhost:$PORT/health" >/dev/null 2>&1 && break || sleep 0.5; done
T=$(node -e "console.log(require('jsonwebtoken').sign({sub:'$U',account_id:'$A',role:'owner'},process.env.JWT_ACCESS_SECRET,{expiresIn:3600}))")
AUTH="Authorization: Bearer $T"; B="http://localhost:$PORT/api"

echo "== the station launches as a task =="
curl -s -X POST "$B/radio/$CH/start" -H "$AUTH" -o "$WORK/start.json" -w ''
# POLL for the first segment. A station has to connect to its upstream, probe
# the codec and fill a segment before anything appears, and how long that takes
# depends on the box. A fixed wait here made the suite fail intermittently on
# the two assertions that care, which is worse than being slow.
for i in $(seq 1 40); do
  find "$ORIGIN/$CH/runs" -name '*.m4s' 2>/dev/null | head -1 | grep -q . && break
  sleep 1
done
ARN=$(psql "$DATABASE_URL" -tAc "SELECT task_arn FROM instances WHERE channel_id='$CH' AND terminated_at IS NULL")
ok "an instance row is open" '[ -n "$ARN" ]'
ok "and it is a LAUNCHED task, not an in-process radio: pid" '[ "${ARN#radio:}" = "$ARN" ]'
ok "the launcher ran volt-radio's own entrypoint" '[ -n "$(pgrep -f radio.py)" ]'

echo "== liveness is answerable without the in-process map =="
# This is the read-side migration: the API must call the station running while
# the pipeline lives in a different process entirely.
ST=$(curl -s "$B/radio/$CH" -H "$AUTH")
ok "the API reports the station running" 'echo "$ST" | grep -q "\"running\":true"'

echo "== it actually plays =="
find "$ORIGIN/$CH/runs" -name '*.m4s' 2>/dev/null | head -1 | grep -q . \
  && ok "HLS segments landed in the per-run origin layout" 'true' \
  || ok "HLS segments landed in the per-run origin layout" 'false'
ok "the run pointer was written" '[ -s "$ORIGIN/$CH/current_run.txt" ]'

echo "== no relay, no MP3 from the station =="
ok "the station's job config names no relay" '! grep -q "icecast\"\s*:\s*{" "$WORK/api.log" && [ -z "$(find "$ORIGIN/$CH/runs" -name "*.mp3" 2>/dev/null | head -1)" ]'
ok "the station writes no MP3 and pushes nowhere (its task log names no icecast address)" '! grep -rq "icecast://" "$ORIGIN/$CH/radio-task.log" 2>/dev/null'

echo "== MP3 is off unless the account has the feed =="
curl -s -X POST "$B/radio/$CH/air" -H "$AUTH" -H 'content-type:application/json' -d '{"on":true}' >/dev/null
sleep 2
ok "on air with the feed off, the public MP3 answers 404" '[ "$(code "http://localhost:$PORT/live/$CH/stream.mp3")" = "404" ]'
ok "and the preview MP3 answers 404" '[ "$(code --max-time 3 "http://localhost:$PORT/radio/$CH/stream.mp3")" = "404" ]'
# (The SOURCE url ends upstream.mp3, so look for the station's own MP3 path.)
ok "and no MP3 url is advertised" '! curl -s "$B/radio/$CH" -H "$AUTH" | grep -q "/$CH/stream.mp3"'
# Served, or redirected to the origin on a machine with no CDN.
ok "HLS is public on air" 'c=$(code "http://localhost:$PORT/live/$CH/master.m3u8"); [ "$c" = "200" ] || [ "$c" = "302" ]'

psql "$DATABASE_URL" -q -c "UPDATE accounts SET mp3_feed_enabled = true WHERE id='$A';" >/dev/null
ok "with the feed on, the MP3 url is advertised" 'curl -s "$B/radio/$CH" -H "$AUTH" | grep -q "/live/$CH/stream.mp3"'
curl -s --max-time 8 -H 'Icy-MetaData: 1' -D "$WORK/hdr.txt" "http://localhost:$PORT/live/$CH/stream.mp3" -o "$WORK/heard.mp3" 2>/dev/null
ok "a listener receives audio bytes, made from the HLS" '[ "$(vsize "$WORK/heard.mp3" 2>/dev/null || echo 0)" -gt 20000 ]'
ok "and it is decodable mp3" '[ "$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "$WORK/heard.mp3" 2>/dev/null)" = "mp3" ]'
ok "with ICY metadata for hardware receivers" 'grep -qi "^icy-metaint" "$WORK/hdr.txt"'

echo "== taking it off air closes MP3 again =="
curl -s -X POST "$B/radio/$CH/air" -H "$AUTH" -H 'content-type:application/json' -d '{"on":false}' >/dev/null
sleep 2
ok "the public MP3 is closed again" '[ "$(code "http://localhost:$PORT/live/$CH/stream.mp3")" = "404" ]'
ok "the listener-auth route for a relay is gone" '[ "$(code -X POST "$B/radio/icecast/listener-auth" -d "mount=/$CH.mp3")" != "200" ]'

echo "== stop tears the task down =="
curl -s -X POST "$B/radio/$CH/stop" -H "$AUTH" >/dev/null
# POLL rather than sleep a fixed amount. radio.py's SIGTERM handler brings ffmpeg
# down and waits for it so the last segments and the closing manifest are
# written, which is correct and takes a few seconds; a fixed wait shorter than
# that grace reports a clean shutdown as a leaked process.
for i in $(seq 1 20); do [ -z "$(pgrep -f "bin/radio.py" || true)" ] && break; sleep 1; done
ok "the instance row is closed" '[ "$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM instances WHERE channel_id='"'"'$CH'"'"' AND terminated_at IS NULL")" = "0" ]'
ok "no station process is left behind" '[ -z "$(pgrep -f "bin/radio.py" || true)" ]'

psql "$DATABASE_URL" -q -c "DELETE FROM accounts WHERE id='$A';" >/dev/null 2>&1
echo
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
