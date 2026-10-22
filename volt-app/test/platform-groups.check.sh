#!/usr/bin/env bash
# Account groups (System admin) and a channel created into one: a client with
# only a packaging group gets a transcode group; the group's profile makes it
# a transcode group; only the SaaS admin can add groups; duplicate names are
# refused; and a transcode channel created into the new group keeps its logo
# and its watermark (position, offsets, size, opacity), the fields the New
# channel form now sends. Run from volt-app/ with DATABASE_URL set.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8508}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*'
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4
pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
B="http://localhost:$PORT/api"; J='content-type:application/json'
ACC=0000000a-0000-0000-0000-0000000007d1
q(){ psql "$DATABASE_URL" -tA -c "$1"; }
jget(){ python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
-- Room in the plan for a second group: since plan allocation (services/plan.ts)
-- a new group's channel cap has to fit what the plan has not given out yet.
INSERT INTO accounts(id,name,max_channels,max_concurrent_sources) VALUES ('$ACC','PackOnlyCo',20,10) ON CONFLICT (id) DO NOTHING;
INSERT INTO users(id,account_id,email,password_hash,role,status,display_name) VALUES
  ('0000000b-0000-0000-0000-0000000007d1','$ACC','owner@packonly.example','x','owner','active','Owner') ON CONFLICT (id) DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('0000000c-0000-0000-0000-0000000007d1','$ACC','Pack','[{"height":1080,"bitrate_kbps":5000}]','package_only') ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id) VALUES ('0000000d-0000-0000-0000-0000000007d1','$ACC','Main','0000000c-0000-0000-0000-0000000007d1') ON CONFLICT (id) DO NOTHING;
-- The SaaS admin is this suite's own fixture. It used to borrow
-- root@adminco.example, which only exists when admin.check.sh ran first
-- against the same database, so on its own database the suite never signed in.
INSERT INTO accounts(id,name) VALUES ('0000000a-0000-0000-0000-0000000007d2','PlatformOpsCo') ON CONFLICT (id) DO NOTHING;
INSERT INTO users(id,account_id,email,password_hash,role,status,platform_role) VALUES
  ('0000000b-0000-0000-0000-0000000007d2','0000000a-0000-0000-0000-0000000007d2','saas@platformops.example','x','owner','active','saas_admin') ON CONFLICT (id) DO NOTHING;
SQL
npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE email IN ('owner@packonly.example','saas@platformops.example')\",[h]); await pool.end();})()" >/dev/null 2>&1
npx tsx src/index.ts >/tmp/platform_groups_api.log 2>&1 &
API=$!
for i in $(seq 1 60); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
login(){ curl -s -X POST "$B/auth/login" -H "$J" -d "{\"email\":\"$1\",\"password\":\"volt1234\"}" | sed -n 's/.*"access":"\([^"]*\)".*/\1/p'; }
# /api/platform takes a platform session (password + authenticator code).
. test/lib/platform-session.sh
S="authorization: Bearer $(platform_session "$B" "$(login saas@platformops.example)")"; O="authorization: Bearer $(login owner@packonly.example)"

G=$(curl -s "$B/platform/accounts/$ACC/groups" -H "$S")
ok "the client starts with one packaging group" '[ "$(echo "$G" | jget "[(g[\"name\"], g[\"workflow_type\"]) for g in d]")" = "[('"'"'Main'"'"', '"'"'package_only'"'"')]" ]'
ok "so the client's own group list offers no transcode group" '[ "$(curl -s "$B/groups" -H "$O" | jget "sum(1 for g in d if g[\"workflow_type\"]==\"transcode\")")" = 0 ]'
C=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/platform/accounts/$ACC/groups" -H "$O" -H "$J" -d '{"name":"Sneaky","workflowType":"transcode"}')
ok "a client owner cannot add groups ($C)" '[ "$C" = 403 ]'
R=$(curl -s -X POST "$B/platform/accounts/$ACC/groups" -H "$S" -H "$J" -d '{"name":"Transcode","workflowType":"transcode","maxChannels":4,"maxConcurrent":2}')
TG=$(echo "$R" | jget 'd["id"]')
ok "the SaaS admin adds a transcode group with its own profile and default ladder" '[ "$(echo "$R" | jget "(d[\"workflow_type\"], d[\"max_channels\"], [r[\"height\"] for r in d[\"rungs\"]])")" = "('"'"'transcode'"'"', 4, [1080, 720, 480])" ]'
ok "it is audited" '[ "$(q "SELECT count(*) FROM audit_log WHERE action='"'"'platform.group_create'"'"' AND entity_id='"'"'$TG'"'"'")" = 1 ]'
C=$(curl -s -o /tmp/pg_body -w '%{http_code}' -X POST "$B/platform/accounts/$ACC/groups" -H "$S" -H "$J" -d '{"name":"transcode","workflowType":"transcode"}')
ok "a second group with the same name is refused ($C)" '[ "$C" = 400 ] && grep -q "already has a group" /tmp/pg_body'
ok "the client now sees a transcode group" '[ "$(curl -s "$B/groups" -H "$O" | jget "[g[\"name\"] for g in d if g[\"workflow_type\"]==\"transcode\"]")" = "['"'"'Transcode'"'"']" ]'

CH=$(curl -s -X POST "$B/channels" -H "$O" -H "$J" -d "{\"groupId\":\"$TG\",\"name\":\"Berita\",\"brandRef\":\"/library/logo.png\",\"outputLadder\":[{\"height\":480,\"bitrateKbps\":1200}],\"sources\":[{\"role\":\"primary\",\"protocol\":\"hls\",\"ingestUrl\":\"http://127.0.0.1:9/berita_1080/playlist.m3u8\"}],\"watermark\":{\"enabled\":true,\"ref\":\"/library/logo.png\",\"position\":\"tr\",\"offsetX\":40,\"offsetY\":30,\"opacity\":80,\"scale\":10},\"metadata\":{\"name\":\"Berita\",\"language\":\"Malay\"}}")
CID=$(echo "$CH" | jget 'd["id"]')
ok "a transcode channel is created into the new group" '[ -n "$CID" ] && [ "$(q "SELECT group_id FROM channels WHERE id='"'"'$CID'"'"'")" = "$TG" ]'
ok "with its logo and its watermark as set in the form" '[ "$(q "SELECT brand_ref||'"'"'|'"'"'||watermark_enabled||'"'"'|'"'"'||watermark_position||'"'"'|'"'"'||watermark_offset_x||'"'"'|'"'"'||watermark_offset_y||'"'"'|'"'"'||watermark_opacity||'"'"'|'"'"'||watermark_scale FROM channels WHERE id='"'"'$CID'"'"'")" = "/library/logo.png|true|tr|40|30|80|10" ]'
ok "and the EPG name from the form" '[ "$(q "SELECT metadata->>'"'"'name'"'"' FROM channels WHERE id='"'"'$CID'"'"'")" = Berita ]'
G=$(curl -s "$B/platform/accounts/$ACC/groups" -H "$S")
ok "the group list counts it" '[ "$(echo "$G" | jget "[g[\"channel_count\"] for g in d if g[\"name\"]==\"Transcode\"][0]")" = 1 ]'

kill $API 2>/dev/null
echo; echo "platform-groups.check: $pass passed, $fail failed"
[ "$fail" = 0 ]
