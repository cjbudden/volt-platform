#!/usr/bin/env bash
# ============================================================================
#  THE PLAYER'S PUBLIC SURFACE — the one that runs on other people's websites.
#
#  Every other API in this codebase is reached with a session JWT by somebody
#  who has already logged in. This one is reached by a <script> tag on a domain
#  we do not control, carrying a key that is visible in view-source. That
#  changes what the tests have to prove.
#
#  A PUBLISHABLE KEY IS NOT A SECRET, and is not treated as one. Anyone can
#  read it off the page. What it provides is attribution and revocation: which
#  app, whose account, and can it be switched off. The ORIGIN ALLOW-LIST is the
#  thing that stops a lifted key working somewhere else, so the tests below are
#  mostly about that boundary rather than about the key itself.
#
#  THE FOUR BOUNDARIES.
#
#    1. No key, a secret key, or a disabled app: refused.
#    2. A valid key from an origin that is not on the list: refused, and the
#       message says WHY, because the person reading it is a developer pasting
#       an embed and "forbidden" would send them to check their key.
#    3. A valid key for ANOTHER TENANT'S station: 404, identical to a station
#       that does not exist. Anything else makes the endpoint an oracle for
#       guessing uuids.
#    4. Telemetry takes its origin from the HEADER, never the body. The
#       commonest support question is "it works on one of our sites and not the
#       other", and a client-supplied origin would answer it wrongly.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."
. "$(dirname "$0")/lib/portable.sh"   # setsid/timeout/stat differ on macOS; see that file
: "${DATABASE_URL:?set DATABASE_URL}"

PORT=8147
WORK=$(mktemp -d)
# NOTE the guard on SRV. `kill -TERM -0` is not a no-op: 0 means "my own
# process group", so an unguarded cleanup on an early exit -- a seed that
# failed, a port already in use -- signals the test runner itself, and the
# suite looks like it hung rather than like it bailed out.
cleanup(){ [ -n "${SRV:-}" ] && kill -TERM -"$SRV" 2>/dev/null; rm -rf "$WORK"; return 0; }
trap cleanup EXIT

pass=0; fail=0
ok(){ if eval "$2"; then echo "  PASS $1"; pass=$((pass+1)); else echo "  FAIL $1"; fail=$((fail+1)); fi; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }
jget(){ node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(String(eval('j.'+process.argv[1])))}catch(e){console.log('')}});var j" --input-type=commonjs 2>/dev/null; }

A1=00000000-0000-0000-0000-00000997a001
A2=00000000-0000-0000-0000-00000997a002
U1=00000000-0000-0000-0000-00000997f001
U2=00000000-0000-0000-0000-00000997f002
G1=00000000-0000-0000-0000-00000997b001
G2=00000000-0000-0000-0000-00000997b002
ST=00000000-0000-0000-0000-00000997c001
OTHER=00000000-0000-0000-0000-00000997c002

psql "$DATABASE_URL" -q -c "
DELETE FROM accounts WHERE id IN ('$A1','$A2');
INSERT INTO accounts(id,name) VALUES ('$A1','Alpha Radio'),('$A2','Beta Radio');
INSERT INTO users(id,account_id,email,password_hash,role,status)
  VALUES ('$U1','$A1','a@x.test','x','owner','active'),('$U2','$A2','b@x.test','x','owner','active');
INSERT INTO groups(id,account_id,name) VALUES ('$G1','$A1','g1'),('$G2','$A2','g2');
INSERT INTO channels(id,group_id,name,status,kind,metadata)
  VALUES ('$ST','$G1','Jazz FM','live','radio','{\"description\":\"Smooth all night\"}'),
         ('$OTHER','$G2','Beta Secret Station','live','radio','{}');
" >/dev/null 2>&1 || { echo "FATAL could not seed"; echo; echo "== RESULT: 0 passed, 1 failed =="; exit 1; }

if curl -fsS --max-time 1 "localhost:$PORT/health" >/dev/null 2>&1; then
  echo "SKIP something is already listening on :$PORT"
  echo; echo "== RESULT: 0 passed, 0 failed =="; exit 0
fi

export PORT JWT_ACCESS_SECRET=playersecret JWT_REFRESH_SECRET=y INGEST_TOKEN=z
export ORCH_LAUNCHER=mock WEB_DIST_DIR= ORCH_TICK_SECONDS=3600 AUTO_CONNECT=false
vsetsid npx tsx src/index.ts >"$WORK/api.log" 2>&1 &
SRV=$!
for i in $(seq 1 40); do curl -fsS "localhost:$PORT/health" >/dev/null 2>&1 && break || sleep 0.5; done
if ! curl -fsS --max-time 2 "localhost:$PORT/health" >/dev/null 2>&1; then
  echo "FATAL the control plane did not come up:"; tail -8 "$WORK/api.log"
  echo; echo "== RESULT: 0 passed, 1 failed =="; exit 1
fi

B="http://localhost:$PORT"
JS="Content-Type: application/json"
T1=$(node -e "console.log(require('jsonwebtoken').sign({sub:'$U1',account_id:'$A1',role:'owner'},'playersecret',{expiresIn:3600}))")
T2=$(node -e "console.log(require('jsonwebtoken').sign({sub:'$U2',account_id:'$A2',role:'owner'},'playersecret',{expiresIn:3600}))")

# An app restricted to one domain, and the publishable key it mints.
APP=$(curl -s -X POST -H "Authorization: Bearer $T1" -H "$JS" $B/api/apps \
  -d '{"name":"Site player","type":"web","restrictions":{"referrers":["radio.example.com"]}}')
PK=$(echo "$APP" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).publishableKey.key))")
# An unrestricted app, to prove the refusals above are about the ALLOW-LIST and
# not about the key being rejected for some other reason.
APP2=$(curl -s -X POST -H "Authorization: Bearer $T1" -H "$JS" $B/api/apps \
  -d '{"name":"Anywhere","type":"web","restrictions":{}}')
PK2=$(echo "$APP2" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).publishableKey.key))")
SK=$(curl -s -X POST -H "Authorization: Bearer $T1" -H "$JS" $B/api/apps/secret-keys -d '{}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).key))")
# Beta's own key, for the cross-tenant test.
BAPP=$(curl -s -X POST -H "Authorization: Bearer $T2" -H "$JS" $B/api/apps \
  -d '{"name":"Beta player","type":"web","restrictions":{}}')
BPK=$(echo "$BAPP" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).publishableKey.key))")

echo "== the session handshake needs a valid publishable key =="
ok "a key was minted" 'echo "$PK" | grep -q "^pk_"'
ok "no key at all is refused" '[ "$(code -X POST -H "$JS" $B/api/player/session -d "{\"appKey\":\"nope1234\",\"channelId\":\"'$ST'\"}")" = "401" ]'
ok "a SECRET key is refused: this surface is for publishable keys only" \
   '[ "$(code -X POST -H "$JS" $B/api/player/session -d "{\"appKey\":\"'$SK'\",\"channelId\":\"'$ST'\"}")" = "401" ]'

echo "== the origin allow-list is what stops a lifted key =="
ok "the allowed origin works" \
   '[ "$(code -X POST -H "$JS" -H "Origin: https://radio.example.com" $B/api/player/session -d "{\"appKey\":\"'$PK'\",\"channelId\":\"'$ST'\"}")" = "200" ]'
ok "another site with the same key is refused" \
   '[ "$(code -X POST -H "$JS" -H "Origin: https://stolen.example.net" $B/api/player/session -d "{\"appKey\":\"'$PK'\",\"channelId\":\"'$ST'\"}")" = "403" ]'
REFUSAL=$(curl -s -X POST -H "$JS" -H "Origin: https://stolen.example.net" $B/api/player/session -d "{\"appKey\":\"$PK\",\"channelId\":\"$ST\"}")
# The reader is a developer pasting an embed. "Forbidden" would send them to
# check their key when the problem is their domain.
ok "and the refusal names the origin, so the fix is obvious" 'echo "$REFUSAL" | grep -qi "stolen.example.net"'
ok "an unrestricted app works from anywhere, so the refusals above are about the list" \
   '[ "$(code -X POST -H "$JS" -H "Origin: https://anything.test" $B/api/player/session -d "{\"appKey\":\"'$PK2'\",\"channelId\":\"'$ST'\"}")" = "200" ]'

echo "== a station belonging to another tenant is not discoverable =="
ok "Beta's station is 404 to Alpha's key" \
   '[ "$(code -X POST -H "$JS" -H "Origin: https://anything.test" $B/api/player/session -d "{\"appKey\":\"'$PK2'\",\"channelId\":\"'$OTHER'\"}")" = "404" ]'
ok "and an id that names nothing is the SAME 404, so this is not an oracle" \
   '[ "$(code -X POST -H "$JS" -H "Origin: https://anything.test" $B/api/player/session -d "{\"appKey\":\"'$PK2'\",\"channelId\":\"00000000-0000-0000-0000-0000deadbeef\"}")" = "404" ]'
ok "Beta reaches its own station with its own key" \
   '[ "$(code -X POST -H "$JS" -H "Origin: https://anything.test" $B/api/player/session -d "{\"appKey\":\"'$BPK'\",\"channelId\":\"'$OTHER'\"}")" = "200" ]'

echo "== the session carries everything the player needs, in one request =="
S=$(curl -s -X POST -H "$JS" -H "Origin: https://radio.example.com" $B/api/player/session -d "{\"appKey\":\"$PK\",\"channelId\":\"$ST\"}")
ok "the station name" 'echo "$S" | grep -q "Jazz FM"'
ok "all three delivery formats, so a blocked one needs no second round trip" \
   'echo "$S" | grep -q "\"hls\"" && echo "$S" | grep -q "\"dash\"" && echo "$S" | grep -q "\"mp3\""'
ok "the saved configuration" 'echo "$S" | grep -q "primaryColor"'
ok "and where to send telemetry" 'echo "$S" | grep -q "\"report\""'
ok "but NO key, token or secret comes back" '! echo "$S" | grep -qiE "sk_live|secret|password"'

echo "== now-playing falls back to the station rather than rendering empty =="
NP=$(curl -s -X POST -H "$JS" -H "Origin: https://radio.example.com" $B/api/player/now-playing -d "{\"appKey\":\"$PK\",\"channelId\":\"$ST\"}")
ok "there is always something to show" 'echo "$NP" | grep -q "Jazz FM"'
ok "with the station description under it" 'echo "$NP" | grep -q "Smooth all night"'
ok "flagged as a station fallback, not a track" 'echo "$NP" | grep -q "\"source\":\"station\""'
ok "and it is scoped like everything else" \
   '[ "$(code -X POST -H "$JS" -H "Origin: https://anything.test" $B/api/player/now-playing -d "{\"appKey\":\"'$PK2'\",\"channelId\":\"'$OTHER'\"}")" = "404" ]'

echo "== telemetry =="
ok "events are accepted" \
   '[ "$(code -X POST -H "$JS" -H "Origin: https://radio.example.com" $B/api/player/events -d "{\"appKey\":\"'$PK'\",\"channelId\":\"'$ST'\",\"sessionId\":\"abc123def\",\"events\":[{\"event\":\"player.load\"},{\"event\":\"play\"}]}")" = "204" ]'
# 422 is this codebase's answer to a schema violation, everywhere. Asserting
# 400 here would have been me imposing my own convention on one endpoint.
ok "an unknown event name is rejected rather than stored as junk" \
   '[ "$(code -X POST -H "$JS" -H "Origin: https://radio.example.com" $B/api/player/events -d "{\"appKey\":\"'$PK'\",\"channelId\":\"'$ST'\",\"sessionId\":\"abc123def\",\"events\":[{\"event\":\"whatever\"}]}")" = "422" ]'
ok "and telemetry from a disallowed origin is refused too" \
   '[ "$(code -X POST -H "$JS" -H "Origin: https://stolen.example.net" $B/api/player/events -d "{\"appKey\":\"'$PK'\",\"channelId\":\"'$ST'\",\"sessionId\":\"abc123def\",\"events\":[{\"event\":\"play\"}]}")" = "403" ]'

# The origin must come from the HEADER. A body-supplied origin would make the
# one question this data exists to answer unanswerable.
# Telemetry is written in batches (scale/batches.ts, about once a second): wait for one.
sleep 2
ORIGIN_ROW=$(psql "$DATABASE_URL" -tAc "SELECT origin FROM player_events WHERE session_id='abc123def' LIMIT 1")
ok "the recorded origin is the request header" '[ "$ORIGIN_ROW" = "https://radio.example.com" ]'

echo "== the console can read it back =="
REP=$(curl -s -H "Authorization: Bearer $T1" "$B/api/player-config/$ST/report?hours=1")
ok "the report answers" 'echo "$REP" | grep -q byOrigin'
ok "counting SESSIONS, because one broken embed reloading is one problem" 'echo "$REP" | grep -q sessions'
ok "another tenant cannot read it" \
   '[ "$(code -H "Authorization: Bearer $T2" "$B/api/player-config/'$ST'/report")" = "404" ]'

echo "== configuration is saved and applied =="
ok "a colour is saved" \
   '[ "$(code -X PUT -H "Authorization: Bearer $T1" -H "$JS" $B/api/player-config/'$ST' -d "{\"layout\":\"card\",\"primaryColor\":\"#ff8800\"}")" = "200" ]'
ok "a bad colour is refused rather than stored" \
   '[ "$(code -X PUT -H "Authorization: Bearer $T1" -H "$JS" $B/api/player-config/'$ST' -d "{\"primaryColor\":\"orange\"}")" = "422" ]'
ok "an unknown layout is refused" \
   '[ "$(code -X PUT -H "Authorization: Bearer $T1" -H "$JS" $B/api/player-config/'$ST' -d "{\"layout\":\"fancy\"}")" = "422" ]'
S2=$(curl -s -X POST -H "$JS" -H "Origin: https://radio.example.com" $B/api/player/session -d "{\"appKey\":\"$PK\",\"channelId\":\"$ST\"}")
ok "and the saved colour reaches the player" 'echo "$S2" | grep -q "#ff8800"'
ok "saving twice updates rather than duplicating" \
   '[ "$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM player_configs WHERE channel_id='"'"'$ST'"'"'")" = "1" ]'
ok "another tenant cannot write it" \
   '[ "$(code -X PUT -H "Authorization: Bearer $T2" -H "$JS" $B/api/player-config/'$ST' -d "{\"primaryColor\":\"#000000\"}")" = "404" ]'

psql "$DATABASE_URL" -q -c "DELETE FROM accounts WHERE id IN ('$A1','$A2');" >/dev/null 2>&1

echo
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
