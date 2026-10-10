#!/usr/bin/env bash
# XMLTV import: the source's time zone. A correct feed (UTC offsets, like
# xmltv.net's) read as stamped; Try it reporting the offsets and showing
# programmes as they will land; the source zone winning over a channel's own
# zone for times with no offset; a mislabelled feed (Sydney local times stamped
# +0000) fixed by "ignore the offsets", which clears the shifted programmes and
# re-reads at once; dates for {date} in the source zone. Run from volt-app/
# with DATABASE_URL set.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8504}"
FPORT="${FPORT:-8505}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*' PUBLIC_BASE_URL="http://localhost:$PORT"
fuser -k "$PORT"/tcp "$FPORT"/tcp 2>/dev/null; sleep 0.4
pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
B="http://localhost:$PORT"; J='content-type:application/json'
W=$(mktemp -d)
ACC=0000000a-0000-0000-0000-0000000007c1
G=0000000d-0000-0000-0000-0000000007c1
CH=0000000e-0000-0000-0000-0000000007c1
q(){ psql "$DATABASE_URL" -tA -c "$1"; }
jget(){ python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
# Three evenings of a 19:00 Sydney news bulletin, written three ways.
D=$(python3 -c "import datetime as d; print((d.datetime.now(d.timezone.utc)+d.timedelta(days=2)).strftime('%Y%m%d'))")
feed(){ # $1 = offset suffix for the stamps ("" for none), $2 = the hour written
  python3 - "$W/$3" "$1" "$2" "$D" <<'PY'
import sys
out, off, hh, d = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
sfx = (' ' + off) if off else ''
x = '<tv><channel id="news.syd"><display-name>News Sydney</display-name></channel>'
x += f'<programme start="{d}{hh}0000{sfx}" stop="{d}{hh}3000{sfx}" channel="news.syd"><title>Evening News</title></programme>'
x += f'<programme start="{d}{hh}3000{sfx}" stop="{d}{int(hh)+1:02d}0000{sfx}" channel="news.syd"><title>Current Affairs</title></programme></tv>'
open(out, 'w').write(x)
PY
}
# The expected instant: 19:00 in Sydney on day D, in UTC.
WANT=$(python3 -c "
import datetime as d, zoneinfo
t=d.datetime.strptime('$D 19:00','%Y%m%d %H:%M').replace(tzinfo=zoneinfo.ZoneInfo('Australia/Sydney'))
print(t.astimezone(d.timezone.utc).strftime('%Y-%m-%d %H:%M'))")
UTCH=$(python3 -c "print('$WANT'.split()[1][:2])")
feed '+0000' "$UTCH" correct.xml          # a correct feed: UTC with +0000
feed '+0000' 19 mislabelled.xml           # Sydney local times wrongly stamped +0000
feed '' 19 nooffset.xml                   # Sydney local times with no offset

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO accounts(id,name) VALUES ('$ACC','ZoneCo') ON CONFLICT (id) DO NOTHING;
INSERT INTO users(id,account_id,email,password_hash,role,status,display_name) VALUES ('0000000b-0000-0000-0000-0000000007c1','$ACC','tz@zone.example','x','owner','active','Tz') ON CONFLICT (id) DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('0000000c-0000-0000-0000-0000000007c1','$ACC','HD','[{"height":360,"bitrate_kbps":800}]','transcode') ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id) VALUES ('$G','$ACC','G','0000000c-0000-0000-0000-0000000007c1') ON CONFLICT (id) DO NOTHING;
-- the channel is on London time (the default every channel gets): the source zone must win
INSERT INTO channels(id,group_id,name,status,tz,xmltv_id) VALUES ('$CH','$G','News','ended','Europe/London','news.syd') ON CONFLICT (id) DO NOTHING;
DELETE FROM programmes WHERE channel_id='$CH';
DELETE FROM epg_import_sources WHERE account_id='$ACC';
SQL
npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE email='tz@zone.example'\",[h]); await pool.end();})()" >/dev/null 2>&1
( cd "$W" && python3 -m http.server "$FPORT" --bind 127.0.0.1 >/dev/null 2>&1 ) & FILES=$!
npx tsx src/index.ts >/tmp/xmltv_tz_api.log 2>&1 &
API=$!
for i in $(seq 1 60); do curl -sf "$B/health" >/dev/null && break; sleep 0.25; done
A="authorization: Bearer $(curl -s -X POST "$B/api/auth/login" -H "$J" -d '{"email":"tz@zone.example","password":"volt1234"}' | sed -n 's/.*"access":"\([^"]*\)".*/\1/p')"
news(){ q "SELECT to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI') FROM programmes WHERE channel_id='$CH' AND title='Evening News' ORDER BY starts_at"; }
count(){ q "SELECT count(*) FROM programmes WHERE channel_id='$CH'"; }
mk(){ curl -s -X POST "$B/api/epg/import/sources" -H "$A" -H "$J" -d "{\"name\":\"$1\",\"kind\":\"url\",\"url\":\"http://127.0.0.1:$FPORT/$2\",\"minDaysAhead\":0,\"fallbackTz\":\"Australia/Sydney\"$3}" | jget 'd["id"]'; }

# ---- a correct feed
S1=$(mk "Correct" correct.xml '')
ok "a new source reads times as stamped by default" '[ "$(q "SELECT time_mode FROM epg_import_sources WHERE id='"'"'$S1'"'"'")" = offsets ]'
T=$(curl -s -X POST "$B/api/epg/import/sources/$S1/test" -H "$A")
ok "Try it reports the feed's offsets (+0000 on both)" '[ "$(echo "$T" | jget "d[\"offsets\"]")" = "[{'"'"'offset'"'"': '"'"'+0000'"'"', '"'"'count'"'"': 2}]" ]'
ok "and shows the news as it will land: 19:00 Sydney" '[ "$(echo "$T" | jget "d[\"samples\"][0][\"startsAt\"][:16].replace(\"T\",\" \")")" = "$WANT" ] && [ "$(echo "$T" | jget "d[\"timeReading\"]")" = "{'"'"'zone'"'"': '"'"'Australia/Sydney'"'"', '"'"'mode'"'"': '"'"'offsets'"'"'}" ]'
curl -s -o /dev/null -X POST "$B/api/epg/import/sources/$S1/run" -H "$A"
ok "imported at 19:00 Sydney ($(news))" '[ "$(news)" = "$WANT" ]'
curl -s -o /dev/null -X DELETE "$B/api/epg/import/sources/$S1" -H "$A"

# ---- no offset: the source zone wins over the channel's (London)
S2=$(curl -s -X POST "$B/api/epg/import/sources" -H "$A" -H "$J" -d "{\"name\":\"No offset\",\"kind\":\"url\",\"url\":\"http://127.0.0.1:$FPORT/nooffset.xml\",\"minDaysAhead\":0}" | jget 'd["id"]')
curl -s -o /dev/null -X POST "$B/api/epg/import/sources/$S2/run" -H "$A"
LONDON=$(news)
ok "with no source zone, a time with no offset is read in the channel's zone (London: $LONDON)" '[ "$LONDON" != "$WANT" ] && [ -n "$LONDON" ]'
R=$(curl -s -X PATCH "$B/api/epg/import/sources/$S2" -H "$A" -H "$J" -d '{"fallbackTz":"Australia/Sydney"}')
ok "setting the source zone clears what was read at the old times and asks for a re-read now" '[ "$(echo "$R" | jget "(d[\"reread\"][\"removedProgrammes\"], d[\"reread\"][\"reimporting\"])")" = "(2, True)" ] && [ "$(count)" = 0 ] && [ "$(q "SELECT (next_run_at <= now())::text FROM epg_import_sources WHERE id='"'"'$S2'"'"'")" = true ]'
curl -s -o /dev/null -X POST "$B/api/epg/import/sources/$S2/run" -H "$A"
ok "re-read: the source zone wins, 19:00 Sydney ($(news))" '[ "$(news)" = "$WANT" ] && [ "$(count)" = 2 ]'
R=$(curl -s -X PATCH "$B/api/epg/import/sources/$S2" -H "$A" -H "$J" -d '{"name":"No offset feed"}')
ok "an edit that does not touch times does not re-read" '[ "$(echo "$R" | jget "\"reread\" in d")" = False ] && [ "$(count)" = 2 ]'
curl -s -o /dev/null -X DELETE "$B/api/epg/import/sources/$S2" -H "$A"

# ---- a mislabelled feed
S3=$(mk "Mislabelled" mislabelled.xml '')
curl -s -o /dev/null -X POST "$B/api/epg/import/sources/$S3/run" -H "$A"
ok "read as stamped, the mislabelled feed puts the news 11 hours late ($(news))" '[ "$(news)" != "$WANT" ]'
R=$(curl -s -X PATCH "$B/api/epg/import/sources/$S3" -H "$A" -H "$J" -d '{"timeMode":"local"}')
ok "switching to 'ignore the offsets' clears the shifted programmes" '[ "$(echo "$R" | jget "d[\"reread\"][\"removedProgrammes\"]")" = 2 ] && [ "$(echo "$R" | jget "d[\"timeMode\"]")" = local ]'
T=$(curl -s -X POST "$B/api/epg/import/sources/$S3/test" -H "$A")
ok "Try it now shows 19:00 Sydney" '[ "$(echo "$T" | jget "d[\"samples\"][0][\"startsAt\"][:16].replace(\"T\",\" \")")" = "$WANT" ]'
N=$(npx tsx -e "import {runDueImports} from './src/services/xmltvImport'; import {pool} from './src/db'; runDueImports().then(async n=>{console.log(n); await pool.end()})" 2>/dev/null | tail -1)
ok "the scheduler re-reads it straight away ($N)" '[ "$N" = 1 ]'
ok "and the news is at 19:00 Sydney with nothing left at the wrong time ($(news))" '[ "$(news)" = "$WANT" ] && [ "$(count)" = 2 ]'
C=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$B/api/epg/import/sources/$S3" -H "$A" -H "$J" -d '{"timeMode":"sideways"}')
ok "an unknown time mode is refused ($C)" '[ "$C" = 422 ]'
C=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$B/api/epg/import/sources/$S3" -H "$A" -H "$J" -d '{"fallbackTz":"Mars/Olympus"}')
ok "an unknown zone is refused ($C)" '[ "$C" = 400 ]'

# ---- {date} follows the source zone
S4=$(curl -s -X POST "$B/api/epg/import/sources" -H "$A" -H "$J" -d "{\"name\":\"Kiritimati\",\"kind\":\"url\",\"url\":\"http://127.0.0.1:$FPORT/{date}.xml\",\"requestMode\":\"per_day\",\"daysAhead\":1,\"minDaysAhead\":0,\"fallbackTz\":\"Pacific/Kiritimati\",\"enabled\":false}")
WANTD=$(python3 -c "import datetime as d, zoneinfo; print(d.datetime.now(zoneinfo.ZoneInfo('Pacific/Kiritimati')).strftime('%Y-%m-%d'))")
ok "{date} is today in the source zone (UTC+14: $WANTD)" '[ "$(echo "$S4" | jget "d[\"plannedRequests\"][0][\"day\"]")" = "$WANTD" ]'

kill $API $FILES 2>/dev/null
rm -rf "$W"
echo; echo "xmltv-timezone.check: $pass passed, $fail failed"
[ "$fail" = 0 ]
