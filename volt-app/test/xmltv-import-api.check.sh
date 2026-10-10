#!/usr/bin/env bash
# XMLTV import from a hosted guide API, kept N days ahead, against a stand-in
# API (test/lib/fake-guide-api.py): a per-day template with an API key header,
# the key never sent back, Try it, the scheduled run filling today + 6 days,
# a provider that over-publishes cut at the window, a failed day left alone
# while the days around it are diffed, the coverage floor warning and alerting
# once, failed runs retrying sooner (15 then 30 min) with one alert, ETag 304
# on an unchanged guide, template and header mistakes refused, and tenant
# isolation. Run from volt-app/ with DATABASE_URL set.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8498}"
FPORT="${FPORT:-8499}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*' PUBLIC_BASE_URL="http://localhost:$PORT"
fuser -k "$PORT"/tcp "$FPORT"/tcp 2>/dev/null; sleep 0.4
pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
B="http://localhost:$PORT"; J='content-type:application/json'
W=$(mktemp -d)
ACC=0000000a-0000-0000-0000-0000000000a1; OTH=0000000a-0000-0000-0000-0000000000a2
G=0000000d-0000-0000-0000-0000000000a1; CH=0000000e-0000-0000-0000-0000000000a1
q(){ psql "$DATABASE_URL" -tA -c "$1"; }
jget(){ python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
setstate(){ echo "$1" > "$W/state.json"; }
due(){ q "UPDATE epg_import_sources SET next_run_at = now() - interval '1 second' WHERE id='$1'" >/dev/null
       npx tsx -e "import {runDueImports} from './src/services/xmltvImport'; import {pool} from './src/db'; runDueImports().then(async n=>{console.log(n); await pool.end()})" 2>/dev/null | tail -1; }
lastrun(){ q "SELECT status||'|'||coalesce(error,'')||'|'||warnings::text||'|'||counts::text FROM epg_import_runs WHERE source_id='$1' ORDER BY started_at DESC LIMIT 1"; }
ptitles(){ q "SELECT string_agg(title, ',' ORDER BY starts_at) FROM programmes WHERE channel_id='$CH' AND source_ref LIKE 'xmltv:$1:%'"; }

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO accounts(id,name) VALUES ('$ACC','GuideApiCo'),('$OTH','OtherApiCo') ON CONFLICT (id) DO NOTHING;
INSERT INTO users(id,account_id,email,password_hash,role,status,display_name) VALUES
  ('0000000b-0000-0000-0000-0000000000a1','$ACC','api@guideapi.example','x','owner','active','Api'),
  ('0000000b-0000-0000-0000-0000000000a2','$OTH','oth@otherapi.example','x','owner','active','Oth') ON CONFLICT (id) DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('0000000c-0000-0000-0000-0000000000a1','$ACC','HD','[{"height":360,"bitrate_kbps":800}]','transcode') ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id) VALUES ('$G','$ACC','G','0000000c-0000-0000-0000-0000000000a1') ON CONFLICT (id) DO NOTHING;
INSERT INTO channels(id,group_id,name,status,tz,xmltv_id) VALUES ('$CH','$G','Alpha','ended','UTC','alpha.api') ON CONFLICT (id) DO NOTHING;
DELETE FROM programmes WHERE channel_id='$CH';
DELETE FROM epg_import_sources WHERE account_id IN ('$ACC','$OTH');
DELETE FROM notifications WHERE account_id='$ACC';
SQL
npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE email IN ('api@guideapi.example','oth@otherapi.example')\",[h]); await pool.end();})()" >/dev/null 2>&1
setstate '{"key":"k1"}'; : > "$W/log.txt"
python3 test/lib/fake-guide-api.py "$W" "$FPORT" & FAKE=$!
npx tsx src/index.ts >/tmp/xmltv_import_api_api.log 2>&1 &
API=$!
for i in $(seq 1 60); do curl -sf "$B/health" >/dev/null && break; sleep 0.25; done
login(){ curl -s -X POST "$B/api/auth/login" -H "$J" -d "{\"email\":\"$1\",\"password\":\"volt1234\"}" | sed -n 's/.*"access":"\([^"]*\)".*/\1/p'; }
A="authorization: Bearer $(login api@guideapi.example)"; A2="authorization: Bearer $(login oth@otherapi.example)"
F="http://127.0.0.1:$FPORT"
TODAY=$(python3 -c "import datetime;print(datetime.datetime.now(datetime.timezone.utc).date())")

# ---- mistakes refused before saving
C=$(curl -s -o "$W/b" -w '%{http_code}' -X POST "$B/api/epg/import/sources" -H "$A" -H "$J" -d "{\"name\":\"x\",\"kind\":\"url\",\"url\":\"$F/day/today.xml\",\"requestMode\":\"per_day\"}")
ok "per day without {date} is refused ($C)" '[ "$C" = 400 ] && grep -q "{date}" "$W/b"'
C=$(curl -s -o "$W/b" -w '%{http_code}' -X POST "$B/api/epg/import/sources" -H "$A" -H "$J" -d "{\"name\":\"x\",\"kind\":\"url\",\"url\":\"$F/day/{date}.xml\",\"requestMode\":\"per_day\",\"daysAhead\":4,\"minDaysAhead\":6}")
ok "a minimum above the days ahead is refused ($C)" '[ "$C" = 400 ]'
C=$(curl -s -o "$W/b" -w '%{http_code}' -X POST "$B/api/epg/import/sources" -H "$A" -H "$J" -d "{\"name\":\"x\",\"kind\":\"url\",\"url\":\"$F/day/{date}.xml\",\"requestMode\":\"per_day\",\"headers\":{\"host\":\"evil\"}}")
ok "a Host header is refused ($C)" '[ "$C" = 400 ]'

# ---- the per-day API source
S=$(curl -s -X POST "$B/api/epg/import/sources" -H "$A" -H "$J" -d "{\"name\":\"Guide API\",\"kind\":\"url\",\"url\":\"$F/day/{date}.xml\",\"requestMode\":\"per_day\",\"daysAhead\":6,\"minDaysAhead\":5,\"dateFormat\":\"YYYY-MM-DD\",\"refreshHours\":6,\"fallbackTz\":\"UTC\",\"headers\":{\"X-Api-Key\":\"wrong\"}}")
SID=$(echo "$S" | jget 'd["id"]')
ok "source created with today + 6 days planned (7 requests)" '[ -n "$SID" ] && [ "$(echo "$S" | jget "len(d[\"plannedRequests\"])")" = 7 ] && echo "$S" | grep -q "/day/$TODAY.xml"'
ok "the header name comes back, its value never does" 'echo "$S" | grep -q "\"headerNames\":\[\"x-api-key\"\]" && ! echo "$S" | grep -q wrong'
ok "the value is stored sealed" '! q "SELECT request_headers FROM epg_import_sources WHERE id='"'"'$SID'"'"'" | grep -q wrong'
T=$(curl -s -X POST "$B/api/epg/import/sources/$SID/test" -H "$A")
ok "Try it with the wrong key shows the API's own reason" '[ "$(echo "$T" | jget "d[\"status\"]")" = failed ] && echo "$T" | grep -q "401" && echo "$T" | grep -q "invalid api key"'
curl -s -o /dev/null -X PATCH "$B/api/epg/import/sources/$SID" -H "$A" -H "$J" -d '{"headers":{"x-api-key":"k1"}}'
T=$(curl -s -X POST "$B/api/epg/import/sources/$SID/test" -H "$A")
ok "Try it with the right key reads today: 1 channel, 4 programmes" '[ "$(echo "$T" | jget "(d[\"status\"],d[\"channels\"],d[\"programmes\"])")" = "('"'"'ok'"'"', 1, 4)" ]'
ok "Try it wrote nothing" '[ "$(q "SELECT count(*) FROM programmes WHERE channel_id='"'"'$CH'"'"'")" = 0 ]'
: > "$W/log.txt"
N=$(due "$SID")
ok "the scheduler runs it ($N)" '[ "$N" = 1 ]'
ok "seven day requests, each with the key" '[ "$(grep -c "^/day/" "$W/log.txt")" = 7 ] && [ "$(grep -c "key=k1" "$W/log.txt")" = 7 ]'
ok "28 programmes, today to today + 6" '[ "$(q "SELECT count(*) FROM programmes WHERE channel_id='"'"'$CH'"'"'")" = 28 ]'
ok "run ok, channel matched by its XMLTV id" '[ "$(lastrun "$SID" | cut -d"|" -f1)" = ok ]'
ok "coverage is 6 to 7 days ahead and not low" '[ "$(q "SELECT (coverage_until > now() + interval '"'"'6 days'"'"' AND coverage_until <= now() + interval '"'"'7 days'"'"' AND coverage_low_since IS NULL)::text FROM epg_import_sources WHERE id='"'"'$SID'"'"'")" = true ]'
ok "next refresh in 6 h" '[ "$(q "SELECT round(extract(epoch from next_run_at - now())/3600) FROM epg_import_sources WHERE id='"'"'$SID'"'"'")" = 6 ]'
L=$(curl -s "$B/api/epg/import/sources" -H "$A")
ok "the list shows days ahead and coverage" '[ "$(echo "$L" | jget "(d[0][\"daysAhead\"], d[0][\"minDaysAhead\"], d[0][\"requestMode\"], 6 <= d[0][\"coverageDaysAhead\"] <= 7)")" = "(6, 5, '"'"'per_day'"'"', True)" ]'
CL=$(curl -s "$B/api/epg/import/sources/$SID/channels" -H "$A")
ok "each channel shows how far ahead its guide reaches" '[ "$(echo "$CL" | jget "6 <= d[0][\"guideDaysAhead\"] <= 7")" = True ]'

# ---- a failed day is left alone; the days around it are diffed
setstate '{"key":"k1","fail":[3],"drop":"Show D2 H12"}'
q "UPDATE programmes SET title='Old D3' WHERE channel_id='$CH' AND title='Show D3 H06'" >/dev/null
due "$SID" >/dev/null
R=$(lastrun "$SID")
ok "status warnings naming 1 of 7 days and the API's reason" 'echo "$R" | grep -q "^warnings" && echo "$R" | grep -q "1 of 7 day" && echo "$R" | grep -q "upstream exploded"'
ok "the programme the API dropped on day 2 is removed" '! ptitles "$SID" | grep -q "Show D2 H12" && ptitles "$SID" | grep -q "Show D2 H18"'
ok "day 3, which failed, is left exactly as it was" 'ptitles "$SID" | grep -q "Old D3" && [ "$(q "SELECT count(*) FROM programmes WHERE channel_id='"'"'$CH'"'"' AND title LIKE '"'"'%D3%'"'"'")" = 4 ]'
ok "a failed day does not fail the run, so no failure alert" '[ "$(q "SELECT count(*) FROM notifications WHERE account_id='"'"'$ACC'"'"' AND topic='"'"'epg.import_failed'"'"'")" = 0 ]'

# ---- a hole: days 3 and 4 missing while 5 and 6 arrive. Coverage stops at the hole.
setstate '{"key":"k1","missing":[3,4]}'
q "DELETE FROM programmes WHERE channel_id='$CH' AND starts_at >= (now() at time zone 'UTC')::date + 3 AND starts_at < (now() at time zone 'UTC')::date + 5" >/dev/null
due "$SID" >/dev/null
R=$(lastrun "$SID")
ok "days 5 and 6 are there, yet coverage stops at the hole (under 4 days)" '[ "$(q "SELECT count(*) FROM programmes WHERE channel_id='"'"'$CH'"'"' AND title LIKE '"'"'Show D6%'"'"'")" = 4 ] && [ "$(q "SELECT (coverage_until < now() + interval '"'"'4 days'"'"')::text FROM epg_import_sources WHERE id='"'"'$SID'"'"'")" = true ]'
ok "the run says the guide is short of 5 days on Alpha" 'echo "$R" | grep -q "short of the 5 days" && echo "$R" | grep -q "Alpha"'
ok "owners are alerted once" '[ "$(q "SELECT count(*) FROM notifications WHERE account_id='"'"'$ACC'"'"' AND topic='"'"'epg.coverage_low'"'"'")" -ge 1 ]'
BEFORE=$(q "SELECT count(*) FROM notifications WHERE account_id='$ACC' AND topic='epg.coverage_low'")
due "$SID" >/dev/null
ok "and not again on the next short run" '[ "$(q "SELECT count(*) FROM notifications WHERE account_id='"'"'$ACC'"'"' AND topic='"'"'epg.coverage_low'"'"'")" = "$BEFORE" ]'
ok "the list flags it low" '[ "$(curl -s "$B/api/epg/import/sources" -H "$A" | jget "d[0][\"coverageLow\"]")" = True ]'
setstate '{"key":"k1"}'
due "$SID" >/dev/null
ok "once the provider catches up, the flag clears" '[ "$(q "SELECT (coverage_low_since IS NULL)::text FROM epg_import_sources WHERE id='"'"'$SID'"'"'")" = true ] && [ "$(lastrun "$SID" | cut -d"|" -f1)" = ok ]'

# ---- the API goes down: retry sooner, alert once
setstate '{"key":"rotated"}'
due "$SID" >/dev/null
ok "every day failing fails the run" '[ "$(lastrun "$SID" | cut -d"|" -f1)" = failed ]'
ok "retry in 15 min, not 6 h" '[ "$(q "SELECT round(extract(epoch from next_run_at - now())/60)||'"'"'|'"'"'||consecutive_failures FROM epg_import_sources WHERE id='"'"'$SID'"'"'")" = "15|1" ]'
due "$SID" >/dev/null
ok "then 30 min" '[ "$(q "SELECT round(extract(epoch from next_run_at - now())/60)||'"'"'|'"'"'||consecutive_failures FROM epg_import_sources WHERE id='"'"'$SID'"'"'")" = "30|2" ]'
ok "one failure alert for the two failures" '[ "$(q "SELECT count(*) FROM notifications WHERE account_id='"'"'$ACC'"'"' AND topic='"'"'epg.import_failed'"'"'")" = 1 ]'
ok "the guide already imported is untouched" '[ "$(q "SELECT count(*) FROM programmes WHERE channel_id='"'"'$CH'"'"'")" = 28 ]'
setstate '{"key":"k1"}'
due "$SID" >/dev/null
ok "recovered: back to the 6 h refresh, failures reset" '[ "$(q "SELECT round(extract(epoch from next_run_at - now())/3600)||'"'"'|'"'"'||consecutive_failures FROM epg_import_sources WHERE id='"'"'$SID'"'"'")" = "6|0" ]'

# ---- one request for the window, a provider that over-publishes, ETag
q "DELETE FROM programmes WHERE channel_id='$CH'" >/dev/null
q "UPDATE epg_import_sources SET enabled=false, next_run_at=NULL WHERE id='$SID'" >/dev/null
W2=$(curl -s -X POST "$B/api/epg/import/sources" -H "$A" -H "$J" -d "{\"name\":\"Window API\",\"kind\":\"url\",\"url\":\"$F/window.xml?from={from}&to={to}\",\"requestMode\":\"single\",\"daysAhead\":7,\"fallbackTz\":\"UTC\",\"headers\":{\"x-api-key\":\"k1\"}}" | jget 'd["id"]')
: > "$W/log.txt"
due "$W2" >/dev/null
ok "the window request carries from and to" 'grep -q "from=$TODAY&to=" "$W/log.txt"'
ok "10 days published, today + 7 kept (32 programmes), the rest counted as beyond the window" '[ "$(q "SELECT count(*) FROM programmes WHERE channel_id='"'"'$CH'"'"'")" = 32 ] && [ "$(lastrun "$W2" | grep -o "\"droppedFar\": [0-9]*" | grep -o "[0-9]*$")" = 8 ]'
due "$W2" >/dev/null
ok "an unchanged guide is a 304 on the next scheduled run" 'tail -1 "$W/log.txt" | grep -q "inm=\"" && lastrun "$W2" | grep -q "\"notModified\": 1"'
ok "and still checks coverage" '[ "$(q "SELECT (coverage_until > now() + interval '"'"'7 days'"'"')::text FROM epg_import_sources WHERE id='"'"'$W2'"'"'")" = true ]'
R=$(curl -s -X POST "$B/api/epg/import/sources/$W2/run" -H "$A")
ok "Import now always reads the whole guide" 'tail -1 "$W/log.txt" | grep -q "inm=None" && [ "$(echo "$R" | jget "d[\"counts\"][\"unchanged\"]")" = 32 ]'

# ---- isolation
C=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/epg/import/sources/$SID/test" -H "$A2")
ok "another tenant cannot try this source ($C)" '[ "$C" = 404 ]'

kill $API $FAKE 2>/dev/null
rm -rf "$W"
echo; echo "xmltv-import-api.check: $pass passed, $fail failed"
[ "$fail" = 0 ]
