#!/usr/bin/env bash
# Edit + audit foundation e2e: create stamps created_by + audit; PATCH is partial +
# versioned + audited (only changed fields); optimistic concurrency (stale If-Match →
# 409); no-op PATCH doesn't bump; null clears a field; history lists who changed what.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8478}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*'
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4
pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }

A=0000000a-0000-0000-0000-000000000001
U=0000000b-0000-0000-0000-000000000001
G=0000000d-0000-0000-0000-000000000001
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO accounts(id,name) VALUES ('$A','EditCo');
INSERT INTO users(id,account_id,email,password_hash,role,status,display_name)
  VALUES ('$U','$A','ed@editco.example','x','owner','active','Ed Itor');
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type)
  VALUES ('0000000c-0000-0000-0000-000000000001','$A','HD','[]','package_only');
INSERT INTO groups(id,account_id,name,output_profile_id,max_channels)
  VALUES ('$G','$A','G','0000000c-0000-0000-0000-000000000001',10);
SQL
npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE email='ed@editco.example'\",[h]); await pool.end();})()" >/dev/null 2>&1

npx tsx src/index.ts >/tmp/edit_api.log 2>&1 &
API=$!
for i in $(seq 1 40); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
TOK=$(curl -s -X POST "http://localhost:$PORT/api/auth/login" -H 'content-type:application/json' -d '{"email":"ed@editco.example","password":"volt1234"}' | sed -n 's/.*"access":"\([^"]*\)".*/\1/p')
ok "logged in" '[ -n "$TOK" ]'
AUTH="authorization: Bearer $TOK"

# --- create: stamps created_by + version 1 + audit ---
C=$(curl -s -X POST "http://localhost:$PORT/api/channels" -H "$AUTH" -H 'content-type:application/json' -d "{\"groupId\":\"$G\",\"name\":\"News 24\"}")
CID=$(echo "$C" | sed -n 's/.*"id":"\([0-9a-f-]*\)".*/\1/p' | head -1)
ok "create returns channel" '[ -n "$CID" ]'
ok "create stamps created_by = the user" "echo '$C' | grep -q '\"created_by\":\"$U\"'"
ok "create version = 1" "echo '$C' | grep -q '\"version\":1'"

# --- PATCH partial: change only name -> version 2, updated_by, only name changed ---
P=$(curl -s -X PATCH "http://localhost:$PORT/api/channels/$CID" -H "$AUTH" -H 'content-type:application/json' -d '{"name":"News 24 HD"}')
ok "patch name -> version 2" "echo '$P' | grep -q '\"version\":2'"
ok "patch reports only name changed" "echo '$P' | grep -q '\"_changed\":\[\"name\"\]'"
ok "patch stamps updated_by" "echo '$P' | grep -q '\"updated_by\":\"$U\"'"

# --- no-op PATCH: same value -> no version bump ---
P2=$(curl -s -X PATCH "http://localhost:$PORT/api/channels/$CID" -H "$AUTH" -H 'content-type:application/json' -d '{"name":"News 24 HD"}')
ok "no-op patch does NOT bump version (stays 2)" "echo '$P2' | grep -q '\"version\":2'"
ok "no-op patch reports no changes" "echo '$P2' | grep -q '\"_changed\":\[\]'"

# --- optimistic concurrency: stale If-Match -> 409 ---
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "http://localhost:$PORT/api/channels/$CID" -H "$AUTH" -H 'If-Match: 1' -H 'content-type:application/json' -d '{"name":"Racey"}')
ok "stale If-Match -> 409 conflict" '[ "$CODE" = "409" ]'
# correct version succeeds
P3=$(curl -s -X PATCH "http://localhost:$PORT/api/channels/$CID" -H "$AUTH" -H 'If-Match: 2' -H 'content-type:application/json' -d '{"recordingRetentionDays":14}')
ok "correct If-Match succeeds -> version 3" "echo '$P3' | grep -q '\"version\":3'"

# --- null clears a field (retention -> null) ---
P4=$(curl -s -X PATCH "http://localhost:$PORT/api/channels/$CID" -H "$AUTH" -H 'content-type:application/json' -d '{"recordingRetentionDays":null}')
ok "null clears recording_retention_days" "echo '$P4' | grep -q '\"recording_retention_days\":null'"

# --- history: create + 3 updates, with actor + diff ---
H=$(curl -s "http://localhost:$PORT/api/channels/$CID/history" -H "$AUTH")
ok "history has a create entry" "echo '$H' | grep -q '\"action\":\"create\"'"
ok "history has update entries with the diff" "echo '$H' | grep -q '\"changes\"'"
ok "history attributes the actor (email)" "echo '$H' | grep -q 'ed@editco.example'"

# --- delete writes an audit entry ---
DC=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "http://localhost:$PORT/api/channels/$CID" -H "$AUTH")
ok "delete -> 204" '[ "$DC" = "204" ]'
AUD=$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM audit_log WHERE entity_id='$CID' AND action='delete'")
ok "delete recorded in audit_log" '[ "$AUD" = "1" ]'

# --- events: create stamps created_by + PATCH partial + version ---
EV=$(curl -s -X POST "http://localhost:$PORT/api/events" -H "$AUTH" -H 'content-type:application/json' -d "{\"groupId\":\"$G\",\"name\":\"Grand Final\",\"scheduledStart\":\"2027-01-01T10:00:00Z\",\"scheduledEnd\":\"2027-01-01T12:00:00Z\"}")
EID=$(echo "$EV" | sed -n 's/.*"id":"\([0-9a-f-]*\)".*/\1/p' | head -1)
ok "event create stamps created_by + version 1" "echo '$EV' | grep -q '\"created_by\":\"$U\"' && echo '$EV' | grep -q '\"version\":1'"
EP=$(curl -s -X PATCH "http://localhost:$PORT/api/events/$EID" -H "$AUTH" -H 'content-type:application/json' -d '{"name":"Grand Final 2027"}')
ok "event PATCH name -> version 2, only name changed" "echo '$EP' | grep -q '\"version\":2' && echo '$EP' | grep -q '\"_changed\":\[\"name\"\]'"
ok "event history records the change" "curl -s \"http://localhost:$PORT/api/events/$EID/history\" -H \"$AUTH\" | grep -q '\"action\":\"update\"'"

# --- metadata schema: create + PATCH + history ---
SC=$(curl -s -X POST "http://localhost:$PORT/api/metadata-schemas" -H "$AUTH" -H 'content-type:application/json' -d '{"name":"Movie","targetKind":"vod","fields":[{"key":"director","type":"string"}]}')
SID=$(echo "$SC" | sed -n 's/.*"id":"\([0-9a-f-]*\)".*/\1/p' | head -1)
ok "schema create stamps created_by + version 1" "echo '$SC' | grep -q '\"created_by\":\"$U\"' && echo '$SC' | grep -q '\"version\":1'"
SP=$(curl -s -X PATCH "http://localhost:$PORT/api/metadata-schemas/$SID" -H "$AUTH" -H 'content-type:application/json' -d '{"description":"Feature films"}')
ok "schema PATCH description -> version 2" "echo '$SP' | grep -q '\"version\":2' && echo '$SP' | grep -q '\"_changed\":\[\"description\"\]'"
ok "schema history records create + update" "curl -s \"http://localhost:$PORT/api/metadata-schemas/$SID/history\" -H \"$AUTH\" | grep -q '\"action\":\"create\"'"

kill $API 2>/dev/null
echo ""; echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" = "0" ]
