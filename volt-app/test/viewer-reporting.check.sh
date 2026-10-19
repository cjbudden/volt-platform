#!/usr/bin/env bash
# VIEWER REPORTING, locally, with no AWS (docs/REPORTING_TESTING.md).
#   * the simulator's viewers come back in the reports exactly: views, watch
#     time, peak at once, device and country;
#   * the channel page's Realtime viewers card reads the live number;
#   * a share-link preview is a viewer, filed as "Share link";
#   * an expired playback token carries a session's heartbeats and end, but
#     cannot begin a new one (except a share page's, which holds one token).
# Run from volt-app/ with DATABASE_URL set.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8535}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*' \
  PUBLIC_BASE_URL="http://localhost:$PORT" THUMBS_ENABLED=0 ANALYTICS_FLUSH_SEC=2 ANALYTICS_CONCURRENCY_SEC=2
pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
B="http://localhost:$PORT/api"; J='content-type:application/json'
ACC=0000000a-0000-0000-0000-00000000e801; ADM=0000000b-0000-0000-0000-00000000e801
G=0000000d-0000-0000-0000-00000000e801; CH=0000000e-0000-0000-0000-00000000e801; P1=0000000c-0000-0000-0000-00000000e801
q(){ psql "$DATABASE_URL" -tA -c "$1"; }
jget(){ python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO accounts(id,name,max_channels) VALUES ('$ACC','ViewCo',10) ON CONFLICT (id) DO NOTHING;
INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES ('$ADM','$ACC','adm@viewco.example','x','admin','active') ON CONFLICT (id) DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('$P1','$ACC','Pkg','[]','package_only') ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,is_default) VALUES ('$G','$ACC','Main','$P1',10,true) ON CONFLICT (id) DO NOTHING;
INSERT INTO channels(id,group_id,name,status,kind) VALUES ('$CH','$G','View TV','ended','tv') ON CONFLICT (id) DO NOTHING;
DELETE FROM analytics_rollups WHERE account_id='$ACC'; DELETE FROM play_sessions WHERE account_id='$ACC'; DELETE FROM stream_concurrency WHERE account_id='$ACC';
SQL
npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE id='$ADM'\",[h]); await pool.end();})()" >/dev/null 2>&1
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4
npx tsx src/index.ts >/tmp/viewer_reporting_api.log 2>&1 & API=$!
trap 'kill $API 2>/dev/null' EXIT
for i in $(seq 1 80); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
A="authorization: Bearer $(curl -s -X POST "$B/auth/login" -H "$J" -d '{"email":"adm@viewco.example","password":"volt1234"}' | sed -n 's/.*"access":"\([^"]*\)".*/\1/p')"

echo "-- the simulator: 5 viewers, 20 s, a heartbeat every 5 s"
npx tsx scripts/simulate-viewers.ts --api "http://localhost:$PORT" --channel $CH --viewers 5 --minutes 0.34 --beat 5 --ramp 1 --leave 0 \
  --email adm@viewco.example --password volt1234 > /tmp/viewer_sim.log 2>&1 &
SIM=$!
for i in $(seq 1 30); do [ "$(curl -s "$B/channels/$CH" -H "$A" | jget 'd["viewers"]["current"]' 2>/dev/null)" = 5 ] && break; sleep 0.5; done
ok "the channel page shows 5 watching while they watch" '[ "$(curl -s "$B/channels/$CH" -H "$A" | jget "d[\"viewers\"][\"current\"]")" = 5 ]'
ok "realtime: 5 on this channel" '[ "$(curl -s "$B/analytics/realtime" -H "$A" | jget "d[\"total_concurrent\"]")" = 5 ]'
wait $SIM
R=$(curl -s "$B/analytics/asset?kind=channel&id=$CH" -H "$A")
ok "reported views: 5" '[ "$(echo "$R" | jget "d[\"daily\"][0][\"total_views\"]")" = 5 ]'
ok "reported watch time matches what was sent" '[ "$(echo "$R" | jget "d[\"daily\"][0][\"watch_seconds\"]")" = "$(sed -n "s/.*seconds watched \([0-9]*\).*/\1/p" /tmp/viewer_sim.log)" ]'
ok "reported peak at once: 5" '[ "$(echo "$R" | jget "d[\"daily\"][0][\"peak_concurrent\"]")" = 5 ]'
ok "by device and by country are filled" '[ "$(echo "$R" | jget "(sum(d[\"daily\"][0][\"by_device\"].values()), sum(d[\"daily\"][0][\"by_geo\"].values()))")" = "(5, 5)" ]'
ok "the simulator says sent and reported agree" 'grep -q "REPORTED views 5" /tmp/viewer_sim.log'

echo "-- a share-link preview is a viewer"
TOK=$(curl -s -X POST "$B/share-links" -H "$A" -H "$J" -d "{\"resourceKind\":\"channel\",\"resourceId\":\"$CH\",\"ttlSec\":3600}" | jget 'd["token"]')
PT=$(curl -s -X POST "$B/share/$TOK/resolve" -H "$J" -d '{}' | jget 'd["playbackToken"]')
ok "the share page gets a playback token" '[ -n "$PT" ]'
ok "its start beacon is accepted" '[ "$(code -X POST "$B/analytics/beacon" -H "$J" -d "{\"playbackToken\":\"$PT\",\"sessionId\":\"share-check-1\",\"event\":\"start\"}")" = 202 ]'
sleep 3
ok "...and filed as a Share link view" '[ "$(q "SELECT client_app FROM play_sessions WHERE account_id='"'"'$ACC'"'"' AND session_key='"'"'share-check-1'"'"'")" = "Share link" ]'

echo "-- expired tokens"
OLD=$(npx tsx -e "import jwt from 'jsonwebtoken'; console.log(jwt.sign({typ:'playback',aid:'$ACC',app:null,asset:'$CH',kind:'channel',geo:null,exp:Math.floor(Date.now()/1000)-600}, process.env.PLAYBACK_TOKEN_SECRET || 'x'))" 2>/dev/null)
SHR=$(npx tsx -e "import jwt from 'jsonwebtoken'; console.log(jwt.sign({typ:'playback',aid:'$ACC',app:null,asset:'$CH',kind:'channel',geo:null,src:'share',exp:Math.floor(Date.now()/1000)-600}, process.env.PLAYBACK_TOKEN_SECRET || 'x'))" 2>/dev/null)
ok "an expired token carries a heartbeat (202)" '[ "$(code -X POST "$B/analytics/beacon" -H "$J" -d "{\"playbackToken\":\"$OLD\",\"sessionId\":\"expired-session-1\",\"event\":\"heartbeat\",\"seconds\":10}")" = 202 ]'
ok "an expired token cannot start a session (401)" '[ "$(code -X POST "$B/analytics/beacon" -H "$J" -d "{\"playbackToken\":\"$OLD\",\"sessionId\":\"expired-session-2\",\"event\":\"start\"}")" = 401 ]'
ok "a share page's expired token can (the viewer came back to the tab)" '[ "$(code -X POST "$B/analytics/beacon" -H "$J" -d "{\"playbackToken\":\"$SHR\",\"sessionId\":\"share-exp\",\"event\":\"start\"}")" = 202 ]'
ok "a forged token is refused (401)" '[ "$(code -X POST "$B/analytics/beacon" -H "$J" -d "{\"playbackToken\":\"x.y.z\",\"sessionId\":\"forged-session-1\",\"event\":\"start\"}")" = 401 ]'

echo; echo "viewer-reporting: $pass passed, $fail failed"
[ "$fail" = 0 ]
