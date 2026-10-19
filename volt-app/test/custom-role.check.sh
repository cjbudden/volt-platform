#!/usr/bin/env bash
# A CUSTOM ROLE does exactly what it says, end to end (docs/PERMISSIONS_MAP.md).
# The example: an "EPG Administrator" who creates and edits guides, enters
# programmes and runs XMLTV feeds, and nothing else.
#   * an administrator creates the role (EPG manage only) and a user in it;
#   * the user can do all of the EPG work: owners, programmes, copy, XMLTV
#     export feeds and import sources;
#   * everything else is refused: channels, stations and events (read and
#     write), removals, users, roles, the audit log, groups and the plan writes;
#   * EPG routes that would make or change channels need channel access too:
#     creating channels from an import lineup is refused;
#   * the user cannot give themselves, or anyone, more than they hold.
# Run from volt-app/ with DATABASE_URL set.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8525}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*' \
  PUBLIC_BASE_URL="http://localhost:$PORT" THUMBS_ENABLED=0
pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
B="http://localhost:$PORT/api"; J='content-type:application/json'
ACC=0000000a-0000-0000-0000-00000000e001; ADM=0000000b-0000-0000-0000-00000000e001
G=0000000d-0000-0000-0000-00000000e001; CH=0000000e-0000-0000-0000-00000000e001; P1=0000000c-0000-0000-0000-00000000e001
q(){ psql "$DATABASE_URL" -tA -c "$1"; }
jget(){ python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
DELETE FROM audit_log WHERE account_id='$ACC';
DELETE FROM users WHERE account_id='$ACC' AND id<>'$ADM';
DELETE FROM user_groups WHERE account_id='$ACC' AND NOT is_system;
DELETE FROM epg_import_sources WHERE account_id='$ACC';
DELETE FROM programmes WHERE channel_id='$CH';
INSERT INTO accounts(id,name,max_channels) VALUES ('$ACC','EpgCo',10) ON CONFLICT (id) DO NOTHING;
INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES ('$ADM','$ACC','adm@epgco.example','x','admin','active') ON CONFLICT (id) DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('$P1','$ACC','HD','[]','package_only') ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,is_default) VALUES ('$G','$ACC','Main','$P1',10,true) ON CONFLICT (id) DO NOTHING;
INSERT INTO channels(id,group_id,name,status,kind) VALUES ('$CH','$G','EPG News','ended','tv') ON CONFLICT (id) DO NOTHING;
SQL
npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE id='$ADM'\",[h]); await pool.end();})()" >/dev/null 2>&1
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4
npx tsx src/index.ts >/tmp/custom_role_api.log 2>&1 &
API=$!
trap 'kill $API 2>/dev/null' EXIT
for i in $(seq 1 80); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
login(){ curl -s -X POST "$B/auth/login" -H "$J" -d "{\"email\":\"$1\",\"password\":\"$2\"}" | sed -n 's/.*"access":"\([^"]*\)".*/\1/p'; }
A="authorization: Bearer $(login adm@epgco.example volt1234)"

echo "-- an administrator makes the role and a user"
R=$(curl -s -X POST "$B/user-groups" -H "$A" -H "$J" -d '{"name":"EPG Administrator","description":"Creates and edits guides, programmes and XMLTV feeds.","tier":"operator","permissions":{"epg":"manage"}}')
ROLE=$(echo "$R" | jget 'd["id"]')
ok "role created" '[ -n "$ROLE" ] && [ "$(echo "$R" | jget "d[\"permissions\"][\"epg\"]")" = manage ]'
R=$(curl -s -X POST "$B/users" -H "$A" -H "$J" -d "{\"email\":\"epg@epgco.example\",\"password\":\"guide-editor-2026\",\"roleIds\":[\"$ROLE\"]}")
ok "user created in the role" '[ -n "$(echo "$R" | jget "d[\"id\"]")" ]'
q "UPDATE users SET status='active' WHERE email='epg@epgco.example'" >/dev/null
E="authorization: Bearer $(login epg@epgco.example guide-editor-2026)"
ok "the user signs in" '[ "$E" != "authorization: Bearer " ]'
ME=$(curl -s "$B/auth/me" -H "$E")
ok "their access: EPG manage, everything else none" '[ "$(echo "$ME" | jget "(d[\"features\"][\"epg\"], d[\"features\"][\"media\"], d[\"features\"][\"channels\"], d[\"features\"][\"users\"])")" = "('"'"'manage'"'"', '"'"'none'"'"', '"'"'none'"'"', '"'"'none'"'"')" ]'

echo "-- all of the EPG work"
ok "EPG: the guide owners (channels, stations, events) list" '[ "$(curl -s "$B/epg/owners" -H "$E" | jget "any(o.get(\"name\")==\"EPG News\" for o in d)")" = True ]'
S=$(date -u -d '+1 day' +%Y-%m-%dT10:00:00Z); EN=$(date -u -d '+1 day' +%Y-%m-%dT11:00:00Z)
R=$(curl -s -w '\n%{http_code}' -X POST "$B/epg" -H "$E" -H "$J" -d "{\"channelId\":\"$CH\",\"title\":\"Morning News\",\"startsAt\":\"$S\",\"endsAt\":\"$EN\"}")
PID=$(echo "$R" | head -1 | jget 'd["id"]')
ok "EPG: enter a programme (201)" '[ "$(echo "$R" | tail -1)" = 201 ] && [ -n "$PID" ]'
ok "EPG: edit it" '[ "$(code -X PATCH "$B/epg/$PID" -H "$E" -H "$J" -d "{\"title\":\"Morning News Live\"}")" = 200 ]'
ok "EPG: read the guide" '[ "$(curl -s "$B/epg?channelId=$CH&from=$(date -u +%Y-%m-%dT00:00:00Z)&to=$(date -u -d "+3 day" +%Y-%m-%dT00:00:00Z)" -H "$E" | jget "[p[\"title\"] for p in d]")" = "['"'"'Morning News Live'"'"']" ]'
ok "EPG: guide channels for XMLTV" '[ "$(code "$B/epg/channels" -H "$E")" = 200 ]'
R=$(curl -s -w '\n%{http_code}' -X POST "$B/epg/xmltv/feeds" -H "$E" -H "$J" -d '{"name":"Partner feed"}')
ok "EPG: create an XMLTV export feed (201)" '[ "$(echo "$R" | tail -1)" = 201 ]'
R=$(curl -s -w '\n%{http_code}' -X POST "$B/epg/import/sources" -H "$E" -H "$J" -d '{"name":"Provider guide","kind":"upload"}')
SRC=$(echo "$R" | head -1 | jget 'd["id"]')
ok "EPG: create an XMLTV import source (201)" '[ "$(echo "$R" | tail -1)" = 201 ] && [ -n "$SRC" ]'
ok "EPG: see import sources" '[ "$(code "$B/epg/import/sources" -H "$E")" = 200 ]'
ok "Files: any signed-in user may browse the library for pickers" '[ "$(code "$B/files" -H "$E")" = 200 ]'
ok "Files: may not upload (403)" '[ "$(code -X POST "$B/files" -H "$E" -H "$J" -d "{\"folder\":\"x\",\"name\":\"a.png\",\"kind\":\"brand\",\"dataBase64\":\"AA==\"}")" = 403 ]'
ok "EPG: remove the programme (204)" '[ "$(code -X DELETE "$B/epg/$PID" -H "$E")" = 204 ]'

echo "-- and nothing else"
ok "channels: cannot list (403)" '[ "$(code "$B/channels" -H "$E")" = 403 ]'
ok "channels: cannot create (403)" '[ "$(code -X POST "$B/channels" -H "$E" -H "$J" -d "{\"groupId\":\"$G\",\"name\":\"X\"}")" = 403 ]'
ok "channels: cannot remove (403)" '[ "$(code -X DELETE "$B/channels/$CH" -H "$E")" = 403 ]'
ok "channels: cannot start (403)" '[ "$(code -X POST "$B/channels/$CH/start" -H "$E")" = 403 ]'
ok "radio: cannot list (403)" '[ "$(code "$B/radio/stations" -H "$E")" = 403 ]'
ok "events: cannot list (403)" '[ "$(code "$B/events" -H "$E")" = 403 ]'
ok "recordings: cannot list (403)" '[ "$(code "$B/recordings" -H "$E")" = 403 ]'
ok "users: cannot list (403)" '[ "$(code "$B/users" -H "$E")" = 403 ]'
ok "roles: cannot create (403)" '[ "$(code -X POST "$B/user-groups" -H "$E" -H "$J" -d "{\"name\":\"Mine\",\"tier\":\"operator\",\"permissions\":{\"epg\":\"manage\"}}")" = 403 ]'
ok "audit log: refused (403)" '[ "$(code "$B/audit" -H "$E")" = 403 ]'
ok "groups: cannot create (403)" '[ "$(code -X POST "$B/groups" -H "$E" -H "$J" -d "{\"name\":\"G2\",\"workflowType\":\"transcode\",\"maxChannels\":1}")" = 403 ]'
ok "plan: may read it (forms need it), may not change it (403)" '[ "$(code "$B/plan" -H "$E")" = 200 ] && [ "$(code -X PATCH "$B/plan" -H "$E" -H "$J" -d "{\"maxChannels\":99}")" = 403 ]'
q "INSERT INTO epg_channel_aliases(account_id, source_id, external_id, display_name) VALUES ('$ACC','$SRC','partner.tv','Partner TV')" >/dev/null
AL=$(q "SELECT id FROM epg_channel_aliases WHERE source_id='$SRC' LIMIT 1")
C=$(curl -s -w '\n%{http_code}' -X POST "$B/epg/import/sources/$SRC/channels/bulk" -H "$E" -H "$J" -d "{\"aliasIds\":[\"$AL\"],\"action\":\"create\",\"groupId\":\"$G\"}")
ok "import lineup: creating channels needs channel access (403)" '[ "$(echo "$C" | tail -1)" = 403 ] && [ "$(q "SELECT count(*) FROM channels WHERE group_id='"'"'$G'"'"'")" = 1 ]'
ok "import lineup: marking a channel not used is EPG work (200)" '[ "$(code -X POST "$B/epg/import/sources/$SRC/channels/bulk" -H "$E" -H "$J" -d "{\"aliasIds\":[\"$AL\"],\"action\":\"not_used\"}")" = 200 ]'

echo "-- the administrator sees it all in the audit log"
sleep 0.3
ok "audit: the programme removal is logged against the EPG user" '[ "$(curl -s "$B/audit?action=delete&entityType=programme" -H "$A" | jget "d[\"items\"][0][\"user_email\"]")" = epg@epgco.example ]'
ok "audit: the refused channel removal is logged too" '[ "$(curl -s "$B/audit?action=delete_refused&entityType=channel" -H "$A" | jget "d[\"total\"]")" = 1 ]'

echo; echo "custom-role: $pass passed, $fail failed"
[ "$fail" = 0 ]
