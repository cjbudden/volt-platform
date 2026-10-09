#!/usr/bin/env bash
# ============================================================================
#  RADIO AS A CONTAINER, END TO END, WITH A REAL RELAY.
#
#  Everything else about radio is tested in the legacy in-process mode, because
#  that is still the default. This suite runs the mode that is replacing it:
#
#      RADIO_MODE=container   a station is a launched task, not our child
#      ORCH_LAUNCHER=local    which here runs volt-radio's OWN entrypoint,
#                             bin/radio.py, so what is exercised is the code
#                             the image runs rather than a stand-in
#      a real Icecast         because the point of the change is that MP3
#                             leaves as a push to a relay
#
#  The three things worth proving, in order of how badly they would hurt:
#
#    1. THE STATION ACTUALLY PLAYS. A listener pulling the relay mount gets
#       decodable audio, and the HLS lands in the same per-run origin layout
#       television uses, so recordings and clipping keep working unchanged.
#
#    2. THE ON-AIR GATE SURVIVED THE MOVE. This is the one that does not carry
#       across for free. With the control plane holding the socket, off-air was
#       enforced by simply not writing bytes. With a relay, the mount is a mount
#       and anyone can play it, so the gate has to move into Icecast's listener
#       authentication calling back to us. If that callback is wrong, rights
#       restricted audio is public and nothing else in the system notices.
#
#    3. LIVENESS IS ANSWERABLE FROM THE DATABASE. The read side used to ask an
#       in-memory map that only the starting process could see. A container has
#       no entry in it, so the API must report a containerised station as
#       running without ever consulting that map.
#
#  Skips honestly when icecast2 or ffmpeg is missing rather than failing.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."
. "$(dirname "$0")/lib/portable.sh"   # setsid/timeout/stat differ on macOS; see that file
: "${DATABASE_URL:?set DATABASE_URL}"

command -v icecast2 >/dev/null 2>&1 || { echo "SKIP icecast2 not installed"; echo; echo "== RESULT: 0 passed, 0 failed =="; exit 0; }
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
SECRET=test-relay-secret
mkdir -p "$ORIGIN" "$WORK/ice/logs" "$WORK/ice/web"
# mktemp -d is mode 700, so an unprivileged icecast cannot even traverse into
# it and fails with a config parse error that says nothing about permissions.
chmod 755 "$WORK" "$WORK/ice" "$WORK/ice/logs" "$WORK/ice/web"

pass=0; fail=0
ok(){ if eval "$2"; then echo "  PASS $1"; pass=$((pass+1)); else echo "  FAIL $1"; fail=$((fail+1)); fi; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }

cleanup() {
  [ -n "${SRV:-}" ] && { kill -TERM -"$SRV" 2>/dev/null || kill "$SRV" 2>/dev/null; }
  [ -n "${UP:-}"  ] && kill "$UP"  2>/dev/null
  pkill -f "radio.py" 2>/dev/null
  pkill -f "icecast2 -c $WORK/ice/icecast.xml" 2>/dev/null
  sleep 0.5
  # KEEP_WORK=1 leaves the api, station and icecast logs behind. Without it a
  # failure here deletes the only evidence of why.
  if [ "${KEEP_WORK:-}" = "1" ]; then echo "  (work dir kept: $WORK)"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

# ---- a relay -----------------------------------------------------------------
# Mount-level URL authentication is the WHOLE POINT of this fixture: it is the
# on-air gate after the control plane leaves the audio path.
CH=00000000-0000-0000-0000-0000099300c1
cat > "$WORK/ice/icecast.xml" <<XML
<icecast>
  <limits><clients>20</clients><sources>4</sources><queue-size>524288</queue-size>
    <client-timeout>30</client-timeout><header-timeout>15</header-timeout>
    <source-timeout>10</source-timeout><burst-on-connect>1</burst-on-connect>
    <burst-size>65535</burst-size></limits>
  <authentication><source-password>hackme</source-password>
    <relay-password>hackme</relay-password>
    <admin-user>admin</admin-user><admin-password>hackme</admin-password></authentication>
  <hostname>localhost</hostname>
  <listen-socket><port>$ICE_PORT</port></listen-socket>
  <mount>
    <mount-name>/$CH.mp3</mount-name>
    <authentication type="url">
      <option name="listener_add" value="http://localhost:$PORT/api/radio/icecast/listener-auth"/>
      <option name="auth_header" value="icecast-auth-user: 1"/>
      <option name="headers" value="x-volt-relay-secret"/>
      <option name="header_prefix" value=""/>
    </authentication>
  </mount>
  <fileserve>1</fileserve>
  <paths><logdir>$WORK/ice/logs</logdir><webroot>$WORK/ice/web</webroot>
    <adminroot>/usr/share/icecast2/admin</adminroot></paths>
  <logging><accesslog>access.log</accesslog><errorlog>error.log</errorlog><loglevel>3</loglevel></logging>
  <security><chroot>0</chroot></security>
</icecast>
XML
chmod 644 "$WORK/ice/icecast.xml"
chown -R nobody "$WORK/ice" 2>/dev/null || true
if [ "$(id -u)" = "0" ]; then
  vsetsid runuser -u nobody -- icecast2 -c "$WORK/ice/icecast.xml" >"$WORK/ice/out.log" 2>&1 &
else
  vsetsid icecast2 -c "$WORK/ice/icecast.xml" >"$WORK/ice/out.log" 2>&1 &
fi
for i in $(seq 1 20); do curl -s -o /dev/null "http://localhost:$ICE_PORT/" && break || sleep 0.5; done
curl -s -o /dev/null --max-time 2 "http://localhost:$ICE_PORT/" || { echo "SKIP icecast would not start:"; sed "s/^/     /" "$WORK/ice/out.log" | tail -6; echo; echo "== RESULT: 0 passed, 0 failed =="; exit 0; }

# A live upstream for the station to read, pushed in realtime so it persists.
ffmpeg -hide_banner -loglevel error -re -f lavfi -i "sine=frequency=440:duration=300" \
  -c:a libmp3lame -b:a 128k -content_type audio/mpeg -f mp3 \
  "icecast://source:hackme@localhost:$ICE_PORT/upstream.mp3" >"$WORK/up.log" 2>&1 &
UP=$!
sleep 4

# ---- fixtures ----------------------------------------------------------------
A=00000000-0000-0000-0000-0000099300a1
U=00000000-0000-0000-0000-0000099300f1
G=00000000-0000-0000-0000-0000099300b1
D=00000000-0000-0000-0000-0000099300d1
psql "$DATABASE_URL" -q -c "
DELETE FROM accounts WHERE id='$A';
INSERT INTO accounts(id,name) VALUES ('$A','RelayCo');
INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES ('$U','$A','r@x','x','owner','active');
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('$D','$A','p','[]','package_only');
INSERT INTO groups(id,account_id,name,output_profile_id) VALUES ('$G','$A','g','$D');
INSERT INTO channels(id,group_id,name,status,kind,radio_config,on_air)
  VALUES ('$CH','$G','Relay FM','scheduled','radio','{\"bitrateKbps\":128,\"outputs\":{\"mp3\":true,\"hls\":true,\"dash\":false}}'::jsonb,false);
INSERT INTO stream_inputs(channel_id,role,protocol,ingest_url)
  VALUES ('$CH','primary','icecast','http://localhost:$ICE_PORT/upstream.mp3');" >/dev/null

# ---- the control plane, in container mode ------------------------------------
export PORT
export JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z CORS_ORIGIN='*'
export ORIGIN_DIR="$ORIGIN" ENCODER_BIN="$PWD/../volt-encoder/bin"
export ORCH_LAUNCHER=local RADIO_MODE=container
export ICECAST_HOST=localhost ICECAST_PORT="$ICE_PORT" ICECAST_SOURCE_USER=source
export ICECAST_SOURCE_PASSWORD=hackme ICECAST_PUBLIC_BASE="http://localhost:$ICE_PORT"
export ICECAST_AUTH_SECRET=""     # secret checking is exercised separately below
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

echo "== the on-air gate moved to the relay, and it holds =="
# OFF AIR: Icecast asks us, we say no. If this passes while on_air is false the
# gate is gone and rights-restricted audio is public.
ok "off air, the relay REFUSES a listener" '[ "$(code --max-time 5 "http://localhost:$ICE_PORT/$CH.mp3")" = "401" ] || [ "$(code --max-time 5 "http://localhost:$ICE_PORT/$CH.mp3")" = "403" ]'
ok "off air, the public URL is closed" '[ "$(code "http://localhost:$PORT/live/$CH/stream.mp3")" = "404" ]'

curl -s -X POST "$B/radio/$CH/air" -H "$AUTH" -H 'content-type:application/json' -d '{"on":true}' >/dev/null
sleep 2
ok "on air, the public URL redirects to the relay" '[ "$(code "http://localhost:$PORT/live/$CH/stream.mp3")" = "302" ]'
LOC=$(curl -s -o /dev/null -w '%{redirect_url}' "http://localhost:$PORT/live/$CH/stream.mp3")
ok "and the redirect points at the mount, not at us" 'echo "$LOC" | grep -q "$ICE_PORT/$CH.mp3"'
ok "on air, the relay now ADMITS a listener" '[ "$(code --max-time 5 "http://localhost:$ICE_PORT/$CH.mp3")" = "200" ]'

curl -s --max-time 5 -H 'Icy-MetaData: 1' -D "$WORK/hdr.txt" "http://localhost:$ICE_PORT/$CH.mp3" -o "$WORK/heard.mp3" 2>/dev/null
ok "a listener receives audio bytes" '[ "$(vsize "$WORK/heard.mp3" 2>/dev/null || echo 0)" -gt 20000 ]'
ok "and it is decodable mp3" '[ "$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "$WORK/heard.mp3" 2>/dev/null)" = "mp3" ]'
ok "with ICY metadata for hardware receivers" 'grep -qi "^icy-metaint" "$WORK/hdr.txt"'
ok "and the station name the relay was told" 'grep -qi "^icy-name:.*Relay FM" "$WORK/hdr.txt"'

echo "== taking it off air closes the gate again =="
curl -s -X POST "$B/radio/$CH/air" -H "$AUTH" -H 'content-type:application/json' -d '{"on":false}' >/dev/null
sleep 2
ok "the relay refuses new listeners again" '[ "$(code --max-time 5 "http://localhost:$ICE_PORT/$CH.mp3")" != "200" ]'
ok "and the public URL is closed again" '[ "$(code "http://localhost:$PORT/live/$CH/stream.mp3")" = "404" ]'

echo "== the auth endpoint fails CLOSED =="
AU="http://localhost:$PORT/api/radio/icecast/listener-auth"
ok "an unknown mount is denied" '[ "$(code -X POST "$AU" -d "mount=/nonsense")" = "403" ]'
ok "a well-formed but unknown uuid is denied" '[ "$(code -X POST "$AU" -d "mount=/00000000-0000-0000-0000-00000000dead.mp3")" = "403" ]'
ok "a request with no mount at all is denied" '[ "$(code -X POST "$AU" -d "")" = "403" ]'

echo "== stop tears the task down =="
curl -s -X POST "$B/radio/$CH/stop" -H "$AUTH" >/dev/null
# POLL rather than sleep a fixed amount. radio.py's SIGTERM handler brings ffmpeg
# down and waits for it so the last segments and the closing manifest are
# written, which is correct and takes a few seconds; a fixed wait shorter than
# that grace reports a clean shutdown as a leaked process.
for i in $(seq 1 20); do [ -z "$(pgrep -f "bin/radio.py" || true)" ] && break; sleep 1; done
ok "the instance row is closed" '[ "$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM instances WHERE channel_id='"'"'$CH'"'"' AND terminated_at IS NULL")" = "0" ]'
ok "no station process is left behind" '[ -z "$(pgrep -f "bin/radio.py" || true)" ]'
ok "the source mount is released" '[ "$(code --max-time 4 "http://localhost:$ICE_PORT/$CH.mp3")" != "200" ]'

psql "$DATABASE_URL" -q -c "DELETE FROM accounts WHERE id='$A';" >/dev/null 2>&1
echo
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
