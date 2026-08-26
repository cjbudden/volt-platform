#!/usr/bin/env bash
# Events end-to-end: same core workflow as channels + the scheduled window.
#   - create with sources, early server spin-up, recording toggle, auto-VOD flag
#   - schedule validation, versioned edit, source replacement
#   - start/stop (mock launcher): recording row linked to the event, closed on
#     stop; auto_vod=false means NO derived VOD, auto_vod=true derives one
#   - scheduler tick provisions an event whose server window has opened
# Run from volt-app/ with DATABASE_URL set.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8481}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*'
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4

pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO accounts(id,name) VALUES ('0000000a-0000-0000-0000-0000000000a1'::uuid,'RecCo') ON CONFLICT (id) DO NOTHING;
INSERT INTO users(id,account_id,email,password_hash,role,status,display_name) VALUES
  ('0000000b-0000-0000-0000-0000000000a1'::uuid,'0000000a-0000-0000-0000-0000000000a1'::uuid,'rec@recco.example','x','owner','active','Rec Admin')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES
  ('0000000c-0000-0000-0000-0000000000a1'::uuid,'0000000a-0000-0000-0000-0000000000a1'::uuid,'HD','[{"height":360,"bitrate_kbps":800}]','transcode')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id) VALUES
  ('0000000d-0000-0000-0000-0000000000a1'::uuid,'0000000a-0000-0000-0000-0000000000a1'::uuid,'G','0000000c-0000-0000-0000-0000000000a1'::uuid)
  ON CONFLICT (id) DO NOTHING;
-- instances rows block event deletion (FK SET NULL vs owner CHECK) — clear them first
DELETE FROM instances WHERE event_id IN (
  SELECT e.id FROM events e JOIN groups g ON g.id=e.group_id
   WHERE g.account_id='0000000a-0000-0000-0000-0000000000a1'::uuid
     AND e.name IN ('Cup Final','Cup Final v2','AutoVod On','SchedTest'));
DELETE FROM events e USING groups g WHERE e.group_id=g.id AND g.account_id='0000000a-0000-0000-0000-0000000000a1'::uuid
  AND e.name IN ('Cup Final','Cup Final v2','AutoVod On','SchedTest');
SQL

npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE email='rec@recco.example'\",[h]); await pool.end();})()" >/dev/null 2>&1

npx tsx src/index.ts >/tmp/events_api.log 2>&1 &
API=$!
for i in $(seq 1 40); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 0.25; done

TOK=$(curl -s -X POST "http://localhost:$PORT/api/auth/login" -H 'content-type:application/json' -d '{"email":"rec@recco.example","password":"volt1234"}' | sed -n 's/.*"access":"\([^"]*\)".*/\1/p')
A="authorization: Bearer $TOK"
ok "admin logged in" '[ -n "$TOK" ]'

ISO() { python3 -c "import datetime,sys; print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=int(sys.argv[1]))).strftime('%Y-%m-%dT%H:%M:00Z'))" "$1"; }
S1=$(ISO 60); E1=$(ISO 180); SRV1=$(ISO 45)

# ---- create with the full channel-parity shape ------------------------------
EV=$(curl -s -X POST "http://localhost:$PORT/api/events" -H "$A" -H 'content-type:application/json' -d "{
  \"groupId\":\"0000000d-0000-0000-0000-0000000000a1\",\"name\":\"Cup Final\",
  \"scheduledStart\":\"$S1\",\"scheduledEnd\":\"$E1\",\"serverStart\":\"$SRV1\",\"serverStop\":\"$E1\",
  \"recordingEnabled\":true,\"recordingRetentionSec\":604800,\"autoVod\":false,
  \"sources\":[{\"role\":\"primary\",\"protocol\":\"srt\",\"ingestUrl\":\"srt://in.example:9000?streamid=cup\"},
               {\"role\":\"backup\",\"protocol\":\"hls\",\"ingestUrl\":\"https://backup.example/a.m3u8\"}],
  \"inputFailoverEnabled\":true,\"inputLossBehavior\":\"slate\"}")
EID=$(echo "$EV" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
echo "$EV" > /tmp/event_create.json
ok "event created" '[ -n "$EID" ]'
ok "auto_vod stored off, recording on, retention sec kept" 'echo "$EV" | grep -q "\"auto_vod\":false" && echo "$EV" | grep -q "\"recording_enabled\":true" && echo "$EV" | grep -q "\"recording_retention_sec\":\"\?604800"'
ok "server window opens before on-air" 'python3 -c "import json,sys;d=json.load(open(\"/tmp/event_create.json\"));import datetime;exit(0 if d[\"server_start\"]<d[\"scheduled_start\"] else 1)"'
G=$(curl -s "http://localhost:$PORT/api/events/$EID" -H "$A")
N=$(echo "$G" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["inputs"]))')
ok "event carries its 2 sources" '[ "$N" = "2" ]'

# ---- validation + versioned edit --------------------------------------------
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:$PORT/api/events" -H "$A" -H 'content-type:application/json' \
  -d "{\"groupId\":\"0000000d-0000-0000-0000-0000000000a1\",\"name\":\"bad\",\"scheduledStart\":\"$E1\",\"scheduledEnd\":\"$S1\"}")
ok "end-before-start rejected ($CODE)" '[ "$CODE" = "400" ] || [ "$CODE" = "422" ]'
VER=$(echo "$G" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')
P=$(curl -s -X PATCH "http://localhost:$PORT/api/events/$EID" -H "$A" -H 'content-type:application/json' \
  -d "{\"name\":\"Cup Final v2\",\"autoVod\":true,\"version\":$VER}")
ok "patch updates name + autoVod" 'echo "$P" | grep -q "Cup Final v2" && echo "$P" | grep -q "\"auto_vod\":true"'
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "http://localhost:$PORT/api/events/$EID" -H "$A" -H 'content-type:application/json' \
  -d '{"name":"stale write","version":1}')
ok "stale version rejected ($CODE)" '[ "$CODE" = "409" ]'
P=$(curl -s -X PATCH "http://localhost:$PORT/api/events/$EID" -H "$A" -H 'content-type:application/json' \
  -d "{\"sources\":[{\"role\":\"primary\",\"protocol\":\"srt\",\"ingestUrl\":\"srt://in2.example:9000?streamid=cup\"}]}")
N=$(curl -s "http://localhost:$PORT/api/events/$EID" -H "$A" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["inputs"]))')
ok "patch replaces sources (now 1)" '[ "$N" = "1" ]'

# ---- start/stop: recording linked to the event; auto_vod=false -> no VOD -----
# (autoVod was flipped true above; set it back off for the first start/stop)
curl -s -X PATCH "http://localhost:$PORT/api/events/$EID" -H "$A" -H 'content-type:application/json' -d '{"autoVod":false}' >/dev/null
curl -s -X POST "http://localhost:$PORT/api/events/$EID/start" -H "$A" >/dev/null
ST=$(curl -s "http://localhost:$PORT/api/events/$EID" -H "$A" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
ok "manual start makes the event live" '[ "$ST" = "live" ]'
RECROW=$(psql "$DATABASE_URL" -tA -c "SELECT count(*) FROM recordings WHERE event_id='$EID' AND status='recording'")
ok "recording row created and linked to the event" '[ "$RECROW" = "1" ]'
curl -s -X POST "http://localhost:$PORT/api/events/$EID/stop" -H "$A" >/dev/null
sleep 1
CLOSED=$(psql "$DATABASE_URL" -tA -c "SELECT count(*) FROM recordings WHERE event_id='$EID' AND status='complete' AND end_epoch_ms IS NOT NULL")
ok "recording closed on stop" '[ "$CLOSED" = "1" ]'
NOVOD=$(psql "$DATABASE_URL" -tA -c "SELECT count(*) FROM vod_assets WHERE event_id='$EID'")
ok "auto_vod OFF: no VOD derived" '[ "$NOVOD" = "0" ]'

# ---- second event with auto_vod ON -> full-event VOD derived -----------------
EV2=$(curl -s -X POST "http://localhost:$PORT/api/events" -H "$A" -H 'content-type:application/json' -d "{
  \"groupId\":\"0000000d-0000-0000-0000-0000000000a1\",\"name\":\"AutoVod On\",
  \"scheduledStart\":\"$S1\",\"scheduledEnd\":\"$E1\",\"autoVod\":true,
  \"sources\":[{\"role\":\"primary\",\"protocol\":\"srt\",\"ingestUrl\":\"srt://in.example:9000?streamid=av\"}]}")
EID2=$(echo "$EV2" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
curl -s -X POST "http://localhost:$PORT/api/events/$EID2/start" -H "$A" >/dev/null
sleep 1
curl -s -X POST "http://localhost:$PORT/api/events/$EID2/stop" -H "$A" >/dev/null
sleep 1
VODS=$(psql "$DATABASE_URL" -tA -c "SELECT count(*) FROM vod_assets WHERE event_id='$EID2' AND kind='full_event'")
ok "auto_vod ON: full-event VOD derived on close" '[ "$VODS" = "1" ]'

# ---- scheduler: an event whose server window has opened gets provisioned -----
EV3=$(curl -s -X POST "http://localhost:$PORT/api/events" -H "$A" -H 'content-type:application/json' -d "{
  \"groupId\":\"0000000d-0000-0000-0000-0000000000a1\",\"name\":\"SchedTest\",
  \"scheduledStart\":\"$(ISO -1)\",\"scheduledEnd\":\"$(ISO 120)\",\"serverStart\":\"$(ISO -5)\",\"serverStop\":\"$(ISO 120)\",
  \"sources\":[{\"role\":\"primary\",\"protocol\":\"srt\",\"ingestUrl\":\"srt://in.example:9000?streamid=st\"}]}")
EID3=$(echo "$EV3" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
TICK=$(npx tsx -e "import {orchestrator} from './src/services/orchestrator'; (async()=>{const r=await orchestrator.tick(); console.log(JSON.stringify(r)); process.exit(0)})()" 2>/dev/null | tail -1)
ST3=$(curl -s "http://localhost:$PORT/api/events/$EID3" -H "$A" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
ok "scheduler tick provisions the open window (tick=$TICK, status=$ST3)" '[ "$ST3" = "live" ]'
# cleanup: stop it so nothing lingers
curl -s -X POST "http://localhost:$PORT/api/events/$EID3/stop" -H "$A" >/dev/null

# ---- delete a non-live event --------------------------------------------------
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "http://localhost:$PORT/api/events/$EID" -H "$A")
ok "delete scheduled/ended event ($CODE)" '[ "$CODE" = "204" ]'

kill $API 2>/dev/null
echo; echo "events.check: $pass passed, $fail failed"
[ "$fail" = 0 ]
