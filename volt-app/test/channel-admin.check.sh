#!/usr/bin/env bash
# Channel create/delete for administrators, through the REAL control plane:
#   * a create that fails says why (readable validation, a full group names
#     its TV and radio counts); groups report how many are radio;
#   * only administrators delete channels; the delete shows what it will take
#     with it first, refuses a live channel, and is in the audit log once;
#   * EVERY delete in the API is logged, including routes that do not write
#     their own audit row, and refused deletes are logged with the reason;
#   * the audit log report (/api/audit) is admin-only, filterable, account-
#     scoped and exports CSV safely.
# Run from volt-app/ with DATABASE_URL set.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8521}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*' \
  PUBLIC_BASE_URL="http://localhost:$PORT" THUMBS_ENABLED=0
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4
pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
B="http://localhost:$PORT/api"; J='content-type:application/json'
ACC=0000000a-0000-0000-0000-00000000ca01; OTH=0000000a-0000-0000-0000-00000000ca02
ADM=0000000b-0000-0000-0000-00000000ca01; OPR=0000000b-0000-0000-0000-00000000ca02; OUS=0000000b-0000-0000-0000-00000000ca03
G=0000000d-0000-0000-0000-00000000ca01; G2=0000000d-0000-0000-0000-00000000ca02; GO=0000000d-0000-0000-0000-00000000ca03
TV=0000000e-0000-0000-0000-00000000ca01; RAD=0000000e-0000-0000-0000-00000000ca02; LIVE=0000000e-0000-0000-0000-00000000ca03
PROF=0000000f-0000-0000-0000-00000000ca01
q(){ psql "$DATABASE_URL" -tA -c "$1"; }
jget(){ python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
DELETE FROM audit_log WHERE account_id IN ('$ACC','$OTH');
DELETE FROM channels WHERE group_id IN ('$G','$G2','$GO');
DELETE FROM output_profiles WHERE account_id IN ('$ACC','$OTH');
INSERT INTO accounts(id,name) VALUES ('$ACC','ChanAdminCo'),('$OTH','OtherChanCo') ON CONFLICT (id) DO NOTHING;
INSERT INTO users(id,account_id,email,password_hash,role,status,display_name) VALUES
  ('$ADM','$ACC','adm@chanadmin.example','x','admin','active','Adm'),
  ('$OPR','$ACC','op@chanadmin.example','x','operator','active','Op'),
  ('$OUS','$OTH','adm@otherchan.example','x','owner','active','Oth') ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name,max_channels) VALUES ('$G','$ACC','Full',2),('$G2','$ACC','Roomy',10),('$GO','$OTH','Theirs',10)
  ON CONFLICT (id) DO UPDATE SET max_channels = EXCLUDED.max_channels;
INSERT INTO channels(id,group_id,name,status,kind) VALUES
  ('$TV','$G','Berita','ended','tv'),('$RAD','$G','Klasik FM','ended','radio'),('$LIVE','$G2','On Air','live','tv');
INSERT INTO output_profiles(id,account_id,name,rungs) VALUES ('$PROF','$ACC','Old ladder','[]');
SQL
npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE id IN ('$ADM','$OPR','$OUS')\",[h]); await pool.end();})()" >/dev/null 2>&1
npx tsx src/index.ts >/tmp/channel_admin_api.log 2>&1 &
API=$!
trap "kill $API 2>/dev/null" EXIT; [ -n "${KEEP:-}" ] && trap - EXIT
for i in $(seq 1 80); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
login(){ curl -s -X POST "$B/auth/login" -H "$J" -d "{\"email\":\"$1\",\"password\":\"volt1234\"}" | sed -n 's/.*"access":"\([^"]*\)".*/\1/p'; }
A="authorization: Bearer $(login adm@chanadmin.example)"; P="authorization: Bearer $(login op@chanadmin.example)"
O="authorization: Bearer $(login adm@otherchan.example)"
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }
audits(){ q "SELECT count(*) FROM audit_log WHERE account_id='$ACC' $1"; }
sleep_audit(){ sleep 0.3; }   # the request-level row is written as the response finishes

echo "-- create says why it failed"
R=$(curl -s -X POST "$B/channels" -H "$A" -H "$J" -d "{\"groupId\":\"$G2\"}")
ok "validation errors are readable, not just 'ValidationError'" '[[ "$(echo "$R" | jget "d[\"error\"]")" == "Check these fields: name"* ]]'
ok "the validation code is still there for programs" '[ "$(echo "$R" | jget "d[\"code\"]")" = ValidationError ]'
R=$(curl -s -w '\n%{http_code}' -X POST "$B/channels" -H "$A" -H "$J" -d "{\"groupId\":\"$G\",\"name\":\"Third\"}")
ok "a full group answers 409" '[ "$(echo "$R" | tail -1)" = 409 ]'
MSG=$(echo "$R" | head -1 | jget 'd["error"]')
ok "the 409 names the limit and both kinds" '[[ "$MSG" == *"is given 2 channels and stations of the plan"*"1 TV channel and 1 radio station"* ]]'
R=$(curl -s "$B/groups" -H "$A")
ok "groups report their radio count" '[ "$(echo "$R" | jget "[g for g in d if g[\"name\"]==\"Full\"][0][\"radio_count\"]")" = 1 ]'
ok "and the total" '[ "$(echo "$R" | jget "[g for g in d if g[\"name\"]==\"Full\"][0][\"channel_count\"]")" = 2 ]'
ok "a group with room still creates" '[ "$(code -X POST "$B/channels" -H "$A" -H "$J" -d "{\"groupId\":\"$G2\",\"name\":\"Fresh\"}")" = 201 ]'

echo "-- only administrators delete channels"
ok "an operator cannot delete a channel (403)" '[ "$(code -X DELETE "$B/channels/$TV" -H "$P")" = 403 ]'
sleep_audit
ok "the refused delete is logged with the reason" '[ "$(audits "AND action='"'"'delete_refused'"'"' AND entity_id='"'"'$TV'"'"' AND user_id='"'"'$OPR'"'"' AND detail->>'"'"'reason'"'"' LIKE '"'"'%admin role%'"'"'")" = 1 ]'
ok "the channel is still there" '[ "$(q "SELECT count(*) FROM channels WHERE id='"'"'$TV'"'"'")" = 1 ]'
# the reconciler ends a "live" channel with nothing running, so mark it live just before
q "UPDATE channels SET status='live' WHERE id='$LIVE'" >/dev/null
R=$(curl -s "$B/channels/$LIVE/delete-impact" -H "$A")
ok "impact of a live channel names the blocker" '[ "$(echo "$R" | jget "d[\"blocker\"]")" = "Stop the channel before deleting it" ]'
ok "deleting a live channel is refused (400)" '[ "$(code -X DELETE "$B/channels/$LIVE" -H "$A")" = 400 ]'
sleep_audit
ok "that refusal is logged too" '[ "$(audits "AND action='"'"'delete_refused'"'"' AND entity_id='"'"'$LIVE'"'"' AND detail->>'"'"'reason'"'"' LIKE '"'"'Stop the channel%'"'"'")" = 1 ]'
R=$(curl -s "$B/channels/$TV/delete-impact" -H "$A")
ok "impact lists what goes with it" '[ "$(echo "$R" | jget "sorted(d[\"counts\"].keys())")" = "['"'"'clips'"'"', '"'"'programmes'"'"', '"'"'published_clips'"'"', '"'"'recordings'"'"', '"'"'scheduled_clips'"'"', '"'"'sources'"'"']" ]'
ok "a stopped channel has no blocker" '[ "$(echo "$R" | jget "d[\"blocker\"]")" = None ]'
ok "another account cannot see the impact (404)" '[ "$(code "$B/channels/$TV/delete-impact" -H "$O")" = 404 ]'
ok "an administrator deletes it (204)" '[ "$(code -X DELETE "$B/channels/$TV" -H "$A")" = 204 ]'
sleep_audit
ok "the delete is in the log exactly once" '[ "$(audits "AND action='"'"'delete'"'"' AND entity_id='"'"'$TV'"'"'")" = 1 ]'
ok "with the name and what was removed" '[ "$(q "SELECT detail#>>'"'"'{snapshot,name}'"'"' || '"'"'|'"'"' || (detail#>'"'"'{snapshot,removed}'"'"' ? '"'"'recordings'"'"')::text FROM audit_log WHERE action='"'"'delete'"'"' AND entity_id='"'"'$TV'"'"'")" = "Berita|true" ]'
ok "a radio station is deleted the same way" '[ "$(code -X DELETE "$B/channels/$RAD" -H "$A")" = 204 ]'
ok "deleting something already gone is a 404 and is not logged" '[ "$(code -X DELETE "$B/channels/$TV" -H "$A")" = 404 ] && sleep 0.3 && [ "$(audits "AND entity_id='"'"'$TV'"'"'")" = 2 ]'
ok "now the full group has room again" '[ "$(code -X POST "$B/channels" -H "$A" -H "$J" -d "{\"groupId\":\"$G\",\"name\":\"Berita\"}")" = 201 ]'

echo "-- every delete is logged, even by routes that log nothing themselves"
ok "deleting an output profile works" '[ "$(code -X DELETE "$B/output-profiles/$PROF" -H "$A")" = 204 ]'
sleep_audit
ok "and is in the audit log, by the person, from the request" '[ "$(audits "AND action='"'"'delete'"'"' AND entity_type='"'"'output_profile'"'"' AND entity_id='"'"'$PROF'"'"' AND user_id='"'"'$ADM'"'"' AND detail->>'"'"'logged_by'"'"'='"'"'request'"'"'")" = 1 ]'

echo "-- the audit log report"
ok "operators cannot read the audit log (403)" '[ "$(code "$B/audit" -H "$P")" = 403 ]'
R=$(curl -s "$B/audit" -H "$A")
ok "administrators can" '[ "$(echo "$R" | jget "d[\"total\"] >= 6")" = True ]'
ok "newest first, with who did it" '[ "$(echo "$R" | jget "d[\"items\"][0][\"user_email\"] in (\"adm@chanadmin.example\",\"op@chanadmin.example\")")" = True ]'
R=$(curl -s "$B/audit?action=delete&entityType=channel" -H "$A")
ok "filter: channel deletes" '[ "$(echo "$R" | jget "d[\"total\"]")" = 2 ]'
ok "the row carries the channel name" '[ "$(echo "$R" | jget "sorted(i[\"name\"] for i in d[\"items\"])")" = "['"'"'Berita'"'"', '"'"'Klasik FM'"'"']" ]'
ok "filter: refused deletes" '[ "$(curl -s "$B/audit?action=delete_refused" -H "$A" | jget "d[\"total\"]")" = 2 ]'
ok "filter: by person" '[ "$(curl -s "$B/audit?userId=$OPR" -H "$A" | jget "d[\"total\"]")" = 1 ]'
ok "search: text in the detail" '[ "$(curl -s "$B/audit?q=Klasik" -H "$A" | jget "d[\"total\"]")" = 1 ]'
ok "search: a % is literal, not a wildcard" '[ "$(curl -s "$B/audit?q=%25" -H "$A" | jget "d[\"total\"]")" = 0 ]'
ok "dates: a future 'from' finds nothing" '[ "$(curl -s "$B/audit?from=2999-01-01" -H "$A" | jget "d[\"total\"]")" = 0 ]'
ok "a bad date is a 400" '[ "$(code "$B/audit?from=yesterday-ish" -H "$A")" = 400 ]'
ok "paging" '[ "$(curl -s "$B/audit?limit=2&offset=1" -H "$A" | jget "len(d[\"items\"])")" = 2 ]'
R=$(curl -s "$B/audit/facets" -H "$A")
ok "facets list the actions" '[ "$(echo "$R" | jget "sorted(a[\"action\"] for a in d[\"actions\"])")" = "['"'"'create'"'"', '"'"'delete'"'"', '"'"'delete_refused'"'"']" ]'
ok "facets list the people" '[ "$(echo "$R" | jget "len(d[\"users\"])")" = 2 ]'
ok "another account sees none of it" '[ "$(curl -s "$B/audit" -H "$O" | jget "d[\"total\"]")" = 0 ]'
q "INSERT INTO audit_log(account_id,action,entity_type,detail) VALUES ('$ACC','update','channel','{\"actor\":\"=HYPERLINK(1)\"}')" >/dev/null
H=$(curl -s -D - -o /tmp/claude-0/audit.csv "$B/audit/export.csv" -H "$A")
ok "CSV export is a download" '[[ "$H" == *"text/csv"* && "$H" == *"attachment; filename=\"audit-log-"* ]]'
ok "CSV has the header row" '[ "$(head -1 /tmp/claude-0/audit.csv | tr -d "\r")" = "created_at,action,entity_type,entity_id,name,user_email,actor,detail" ]'
ok "CSV defuses spreadsheet formulas" 'grep -q "'"'"'=HYPERLINK(1)" /tmp/claude-0/audit.csv'
ok "operators cannot export (403)" '[ "$(code "$B/audit/export.csv" -H "$P")" = 403 ]'

echo; echo "channel-admin: $pass passed, $fail failed"
[ "$fail" = 0 ]
