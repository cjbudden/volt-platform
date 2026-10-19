#!/usr/bin/env bash
# Plan at the account, allocation at the group (docs/PLAN_AND_GROUPS.md),
# through the REAL control plane:
#   * GET /api/plan: the plan, use, allocation, who may change it;
#   * the owner changes the plan in a single-client deployment, an admin
#     cannot, nobody can in a SaaS deployment except a system administrator;
#     the plan cannot drop below use or below what the groups are given;
#   * a new channel needs room in the plan AND the group;
#   * account admins create groups, share out the plan (never more than the
#     plan, never below a group's use), choose the default; operators cannot;
#   * a group is not removed while it is the default or in use (409 with the
#     counts), is removed when empty, and every attempt is in the audit log.
# Run from volt-app/ with DATABASE_URL set.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8523}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*' \
  PUBLIC_BASE_URL="http://localhost:$PORT" THUMBS_ENABLED=0 VOLT_DEPLOYMENT=single
pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
B="http://localhost:$PORT/api"; J='content-type:application/json'
ACC=0000000a-0000-0000-0000-00000000d001
OWN=0000000b-0000-0000-0000-00000000d001; ADM=0000000b-0000-0000-0000-00000000d002; OPR=0000000b-0000-0000-0000-00000000d003; SYS=0000000b-0000-0000-0000-00000000d004
G1=0000000d-0000-0000-0000-00000000d001; G2=0000000d-0000-0000-0000-00000000d002
P1=0000000c-0000-0000-0000-00000000d001
q(){ psql "$DATABASE_URL" -tA -c "$1"; }
jget(){ python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
DELETE FROM audit_log WHERE account_id='$ACC';
DELETE FROM events WHERE group_id IN (SELECT id FROM groups WHERE account_id='$ACC');
DELETE FROM channels WHERE group_id IN (SELECT id FROM groups WHERE account_id='$ACC');
DELETE FROM groups WHERE account_id='$ACC';
INSERT INTO accounts(id,name,plan_tier,max_channels,max_concurrent_sources) VALUES ('$ACC','PlanCo','standard',6,3)
  ON CONFLICT (id) DO UPDATE SET max_channels=6, max_concurrent_sources=3, plan_tier='standard';
INSERT INTO users(id,account_id,email,password_hash,role,status,platform_role) VALUES
  ('$OWN','$ACC','own@planco.example','x','owner','active',NULL),
  ('$ADM','$ACC','adm@planco.example','x','admin','active',NULL),
  ('$OPR','$ACC','op@planco.example','x','operator','active',NULL),
  ('$SYS','$ACC','sys@planco.example','x','operator','active','saas_admin') ON CONFLICT (id) DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('$P1','$ACC','HD','[]','package_only') ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,max_concurrent,is_default) VALUES
  ('$G1','$ACC','Main','$P1',4,2,true),('$G2','$ACC','Sport','$P1',2,1,false);
INSERT INTO channels(group_id,name,status,kind) VALUES ('$G1','One','ended','tv'),('$G1','Two FM','ended','radio'),('$G2','Sport 1','ended','tv');
SQL
npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE account_id='$ACC'\",[h]); await pool.end();})()" >/dev/null 2>&1
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4
npx tsx src/index.ts >/tmp/plan_groups_api.log 2>&1 &
API=$!
trap 'kill $API 2>/dev/null' EXIT
for i in $(seq 1 80); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
login(){ curl -s -X POST "$B/auth/login" -H "$J" -d "{\"email\":\"$1\",\"password\":\"volt1234\"}" | sed -n 's/.*"access":"\([^"]*\)".*/\1/p'; }
O="authorization: Bearer $(login own@planco.example)"; A="authorization: Bearer $(login adm@planco.example)"
P="authorization: Bearer $(login op@planco.example)"; S="authorization: Bearer $(login sys@planco.example)"

echo "-- the plan"
R=$(curl -s "$B/plan" -H "$O")
ok "plan: allowance, use and allocation" '[ "$(echo "$R" | jget "(d[\"maxChannels\"], d[\"used\"][\"total\"], d[\"used\"][\"radio\"], d[\"allocated\"], d[\"unallocated\"])")" = "(6, 3, 1, 6, 0)" ]'
ok "plan: the owner may change it (single-client)" '[ "$(echo "$R" | jget "d[\"canEdit\"]")" = True ]'
ok "plan: groups listed with use" '[ "$(echo "$R" | jget "[(g[\"name\"], g[\"used\"], g[\"is_default\"]) for g in d[\"groups\"]]")" = "[('"'"'Main'"'"', 2, True), ('"'"'Sport'"'"', 1, False)]" ]'
R=$(curl -s "$B/plan" -H "$A")
ok "plan: an admin sees it read-only, with the reason" '[ "$(echo "$R" | jget "(d[\"canEdit\"], \"owner\" in d[\"editReason\"])")" = "(False, True)" ]'
ok "plan: an admin cannot change it (403)" '[ "$(code -X PATCH "$B/plan" -H "$A" -H "$J" -d "{\"maxChannels\":20}")" = 403 ]'
ok "plan: an operator can read it" '[ "$(code "$B/plan" -H "$P")" = 200 ]'
ok "plan: a system administrator may change it" '[ "$(curl -s "$B/plan" -H "$S" | jget "d[\"canEdit\"]")" = True ]'
C=$(curl -s -w '\n%{http_code}' -X PATCH "$B/plan" -H "$O" -H "$J" -d '{"maxChannels":2}')
ok "plan: not below what exists (409)" '[ "$(echo "$C" | tail -1)" = 409 ] && [[ "$(echo "$C" | head -1)" == *"3 channels and stations exist"* ]]'
C=$(curl -s -w '\n%{http_code}' -X PATCH "$B/plan" -H "$O" -H "$J" -d '{"maxChannels":5}')
ok "plan: not below what groups are given (409)" '[ "$(echo "$C" | tail -1)" = 409 ] && [[ "$(echo "$C" | head -1)" == *"given 6"* ]]'
R=$(curl -s -X PATCH "$B/plan" -H "$O" -H "$J" -d '{"maxChannels":10,"planTier":"pro","maxConcurrent":4}')
ok "plan: the owner raises it" '[ "$(echo "$R" | jget "(d[\"maxChannels\"], d[\"planTier\"], d[\"maxConcurrent\"], d[\"unallocated\"])")" = "(10, '"'"'pro'"'"', 4, 4)" ]'
sleep 0.2
ok "plan: the change is in the audit log" '[ "$(q "SELECT detail#>>'"'"'{changes,max_channels,to}'"'"' FROM audit_log WHERE account_id='"'"'$ACC'"'"' AND entity_type='"'"'plan'"'"'")" = 10 ]'

echo "-- groups share out the plan"
ok "groups: an operator cannot create one (403)" '[ "$(code -X POST "$B/groups" -H "$P" -H "$J" -d "{\"name\":\"X\",\"workflowType\":\"transcode\",\"maxChannels\":1}")" = 403 ]'
C=$(curl -s -w '\n%{http_code}' -X POST "$B/groups" -H "$A" -H "$J" -d '{"name":"Radio","workflowType":"package_only","maxChannels":5,"maxConcurrent":1}')
ok "groups: no more than the plan has left (409, names the free share)" '[ "$(echo "$C" | tail -1)" = 409 ] && [[ "$(echo "$C" | head -1)" == *"at most 4"* ]]'
R=$(curl -s -X POST "$B/groups" -H "$A" -H "$J" -d '{"name":"Radio","workflowType":"package_only","maxChannels":4,"maxConcurrent":1}')
G3=$(echo "$R" | jget 'd["id"]')
ok "groups: an admin creates one with its own profile" '[ "$(echo "$R" | jget "(d[\"name\"], d[\"workflow_type\"], d[\"max_channels\"], d[\"is_default\"])")" = "('"'"'Radio'"'"', '"'"'package_only'"'"', 4, False)" ]'
ok "groups: a duplicate name is refused (400)" '[ "$(code -X POST "$B/groups" -H "$A" -H "$J" -d "{\"name\":\"radio\",\"workflowType\":\"transcode\",\"maxChannels\":1}")" = 400 ]'
ok "groups: running at once cannot exceed the plan (409)" '[ "$(code -X PATCH "$B/groups/$G2" -H "$A" -H "$J" -d "{\"maxConcurrent\":9}")" = 409 ]'
C=$(curl -s -w '\n%{http_code}' -X PATCH "$B/groups/$G1" -H "$A" -H "$J" -d '{"maxChannels":1}')
ok "groups: not below what a group holds (409)" '[ "$(echo "$C" | tail -1)" = 409 ] && [[ "$(echo "$C" | head -1)" == *"needs at least 2"* ]]'
ok "groups: an admin lowers a share" '[ "$(curl -s -X PATCH "$B/groups/$G1" -H "$A" -H "$J" -d "{\"maxChannels\":3}" | jget "d[\"max_channels\"]")" = 3 ]'
ok "groups: an operator cannot change a share (403)" '[ "$(code -X PATCH "$B/groups/$G1" -H "$P" -H "$J" -d "{\"maxChannels\":4}")" = 403 ]'

echo "-- a new channel needs room in the plan and in the group"
q "UPDATE accounts SET max_channels=3 WHERE id='$ACC'; UPDATE groups SET max_channels=1 WHERE id='$G3'; UPDATE groups SET max_channels=2 WHERE id='$G1'" >/dev/null
C=$(curl -s -w '\n%{http_code}' -X POST "$B/channels" -H "$O" -H "$J" -d "{\"groupId\":\"$G3\",\"name\":\"Over\"}")
ok "create: the plan is used up (409, plan wording)" '[ "$(echo "$C" | tail -1)" = 409 ] && [[ "$(echo "$C" | head -1)" == *"Your plan allows 3"* ]]'
q "UPDATE accounts SET max_channels=10 WHERE id='$ACC'" >/dev/null
C=$(curl -s -w '\n%{http_code}' -X POST "$B/channels" -H "$O" -H "$J" -d "{\"groupId\":\"$G1\",\"name\":\"Over\"}")
ok "create: the group's share is used up (409, group wording)" '[ "$(echo "$C" | tail -1)" = 409 ] && [[ "$(echo "$C" | head -1)" == *"is given 2"* ]]'
ok "create: room in both, created" '[ "$(code -X POST "$B/channels" -H "$O" -H "$J" -d "{\"groupId\":\"$G3\",\"name\":\"Fits\"}")" = 201 ]'

echo "-- the default group, and removing groups"
R=$(curl -s "$B/groups/$G1/usage" -H "$A")
ok "usage: the default group says so" '[ "$(echo "$R" | jget "(d[\"isDefault\"], \"default group\" in d[\"blocker\"])")" = "(True, True)" ]'
C=$(curl -s -w '\n%{http_code}' -X DELETE "$B/groups/$G1" -H "$A")
ok "remove: never the default group (409)" '[ "$(echo "$C" | tail -1)" = 409 ] && [ "$(echo "$C" | head -1 | jget "d[\"code\"]")" = default_group ]'
q "INSERT INTO events(group_id,name,status,scheduled_start,scheduled_end) VALUES ('$G2','Final','scheduled',now()+interval '1 day',now()+interval '1 day 2 hours')" >/dev/null
R=$(curl -s "$B/groups/$G2/usage" -H "$A")
ok "usage: counts channels, stations and events" '[ "$(echo "$R" | jget "(d[\"counts\"][\"channels\"], d[\"counts\"][\"stations\"], d[\"counts\"][\"events\"], d[\"counts\"][\"eventsUpcoming\"])")" = "(1, 0, 1, 1)" ]'
C=$(curl -s -w '\n%{http_code}' -X DELETE "$B/groups/$G2" -H "$A")
ok "remove: not while in use (409 with the counts)" '[ "$(echo "$C" | tail -1)" = 409 ] && [[ "$(echo "$C" | head -1 | jget "d[\"error\"]")" == *"1 TV channel, 1 event (1 not yet ended)"* ]]'
ok "remove: an operator cannot (403)" '[ "$(code -X DELETE "$B/groups/$G2" -H "$P")" = 403 ]'
ok "default: an admin makes Sport the default" '[ "$(curl -s -X PATCH "$B/groups/$G2" -H "$A" -H "$J" -d "{\"isDefault\":true}" | jget "d[\"is_default\"]")" = True ]'
ok "default: exactly one default afterwards" '[ "$(q "SELECT string_agg(name, '"'"','"'"') FROM groups WHERE account_id='"'"'$ACC'"'"' AND is_default")" = Sport ]'
q "DELETE FROM channels WHERE group_id='$G3'" >/dev/null
ok "remove: an empty group goes (204)" '[ "$(code -X DELETE "$B/groups/$G3" -H "$A")" = 204 ]'
sleep 0.3
ok "remove: in the audit log once" '[ "$(q "SELECT count(*) FROM audit_log WHERE account_id='"'"'$ACC'"'"' AND action='"'"'delete'"'"' AND entity_id='"'"'$G3'"'"'")" = 1 ]'
ok "remove: refusals are in the audit log too" '[ "$(q "SELECT count(*) FROM audit_log WHERE account_id='"'"'$ACC'"'"' AND action='"'"'delete_refused'"'"' AND entity_type='"'"'group'"'"'")" = 3 ]'

echo; echo "plan-groups: $pass passed, $fail failed"
[ "$fail" = 0 ]
