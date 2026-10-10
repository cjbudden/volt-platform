#!/usr/bin/env bash
# XMLTV import e2e: upload and URL sources, gzip and Latin-1 input, channel
# mapping (auto by XMLTV id, auto by name, unmapped skipped and listed, manual
# map), time zones for times without an offset, the re-import diff (idempotent,
# changed, removed), clips protected, remapping moves future programmes,
# failure reported to the inbox, scheduled refresh, delete, tenant isolation,
# and an export -> import round trip between two accounts.
# Run from volt-app/ with DATABASE_URL set.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8494}"
FPORT="${FPORT:-8495}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*' PUBLIC_BASE_URL="http://localhost:$PORT"
fuser -k "$PORT"/tcp "$FPORT"/tcp 2>/dev/null; sleep 0.4
pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
B="http://localhost:$PORT"
W=$(mktemp -d)
ACC=0000000a-0000-0000-0000-0000000000f1
OTH=0000000a-0000-0000-0000-0000000000f2
G=0000000d-0000-0000-0000-0000000000f1
CHA=0000000e-0000-0000-0000-0000000000f1   # xmltv_id match
CHB=0000000e-0000-0000-0000-0000000000f2   # name match
CHC=0000000e-0000-0000-0000-0000000000f3   # manual target
CHD=0000000e-0000-0000-0000-0000000000f4   # free target for a remap
CHX=0000000e-0000-0000-0000-0000000000f9   # other tenant
q(){ psql "$DATABASE_URL" -tA -c "$1"; }

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO accounts(id,name) VALUES ('$ACC','ImportCo'),('$OTH','OtherCo') ON CONFLICT (id) DO NOTHING;
INSERT INTO users(id,account_id,email,password_hash,role,status,display_name) VALUES
  ('0000000b-0000-0000-0000-0000000000f1','$ACC','imp@importco.example','x','owner','active','Imp'),
  ('0000000b-0000-0000-0000-0000000000f2','$OTH','oth@otherco.example','x','owner','active','Oth') ON CONFLICT (id) DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES
  ('0000000c-0000-0000-0000-0000000000f1','$ACC','HD','[{"height":360,"bitrate_kbps":800}]','transcode'),
  ('0000000c-0000-0000-0000-0000000000f2','$OTH','HD','[{"height":360,"bitrate_kbps":800}]','transcode') ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id) VALUES
  ('$G','$ACC','G','0000000c-0000-0000-0000-0000000000f1'),
  ('0000000d-0000-0000-0000-0000000000f2','$OTH','G','0000000c-0000-0000-0000-0000000000f2') ON CONFLICT (id) DO NOTHING;
INSERT INTO channels(id,group_id,name,status,tz,xmltv_id) VALUES
  ('$CHA','$G','Alpha TV','ended','Australia/Sydney','alpha.tv.example'),
  ('$CHB','$G','Bravo Radio','ended','Europe/London',NULL),
  ('$CHC','$G','Charlie','ended','UTC',NULL),
  ('$CHD','$G','Delta Spare','ended','UTC',NULL),
  ('$CHX','0000000d-0000-0000-0000-0000000000f2','Delta Elsewhere','ended','UTC','delta.example') ON CONFLICT (id) DO NOTHING;
DELETE FROM programmes WHERE channel_id IN ('$CHA','$CHB','$CHC','$CHD','$CHX');
DELETE FROM epg_import_sources WHERE account_id IN ('$ACC','$OTH');
DELETE FROM notifications WHERE account_id='$ACC';
SQL
npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE email IN ('imp@importco.example','oth@otherco.example')\",[h]); await pool.end();})()" >/dev/null 2>&1

npx tsx src/index.ts >/tmp/xmltv_import_api.log 2>&1 &
API=$!
( cd "$W" && python3 -m http.server "$FPORT" --bind 127.0.0.1 >/dev/null 2>&1 ) & FILES=$!
for i in $(seq 1 60); do curl -sf "$B/health" >/dev/null && break; sleep 0.25; done
login(){ curl -s -X POST "$B/api/auth/login" -H 'content-type:application/json' -d "{\"email\":\"$1\",\"password\":\"volt1234\"}" | sed -n 's/.*"access":"\([^"]*\)".*/\1/p'; }
TOK=$(login imp@importco.example); A="authorization: Bearer $TOK"
TOK2=$(login oth@otherco.example); A2="authorization: Bearer $TOK2"
ok "logged in" '[ -n "$TOK" ] && [ -n "$TOK2" ]'
J='content-type:application/json'
jget(){ python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

# Dates relative to today, in the file's own formats.
# python, not date -d: BSD date on a Mac has no -d.
D1=$(python3 -c "import datetime as d; print((d.datetime.now(d.timezone.utc)+d.timedelta(days=1)).strftime('%Y%m%d'))")
D2=$(python3 -c "import datetime as d; print((d.datetime.now(d.timezone.utc)+d.timedelta(days=2)).strftime('%Y%m%d'))")
cat > "$W/guide.xml" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv generator-info-name="ProviderX">
  <channel id="alpha.tv.example"><display-name>Alpha (provider name)</display-name></channel>
  <channel id="bravo-01"><display-name>bravo radio</display-name><icon src="https://p.example/b.png"/></channel>
  <channel id="mystery.example"><display-name>Mystery Channel</display-name></channel>
  <programme start="${D1}080000 +0000" stop="${D1}090000 +0000" channel="alpha.tv.example"><title>Alpha Breakfast</title><desc>Morning</desc><category>News</category><episode-num system="xmltv_ns">1.4.</episode-num></programme>
  <programme start="${D1}090000 +0000" channel="alpha.tv.example"><title>Alpha Midday</title></programme>
  <programme start="${D1}120000 +0000" stop="${D1}130000 +0000" channel="alpha.tv.example"><title>Alpha Lunch</title></programme>
  <programme start="${D1}190000" stop="${D1}200000" channel="bravo-01"><title>Bravo Evening (local time, no offset)</title></programme>
  <programme start="${D1}100000 +0000" stop="${D1}110000 +0000" channel="mystery.example"><title>Mystery Show</title></programme>
  <programme start="${D2}100000 +0000" stop="${D2}110000 +0000" channel="mystery.example"><title>Mystery Show 2</title></programme>
</tv>
XML

# ---- validation
C=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/epg/import/sources" -H "$A" -H "$J" -d '{"name":"bad","kind":"url"}')
ok "a URL source with no URL is refused ($C)" '[ "$C" = 400 ]'
C=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/epg/import/sources" -H "$A" -H "$J" -d '{"name":"bad","kind":"upload","fallbackTz":"Mars/Olympus"}')
ok "an unknown fallback zone is refused ($C)" '[ "$C" = 400 ]'

# ---- upload source
S=$(curl -s -X POST "$B/api/epg/import/sources" -H "$A" -H "$J" -d '{"name":"Provider X upload","kind":"upload"}')
SID=$(echo "$S" | jget 'd["id"]')
ok "upload source created" '[ -n "$SID" ]'
R=$(curl -s -X POST "$B/api/epg/import/sources/$SID/upload" -H "$A" -H 'content-type: application/xml' --data-binary @"$W/guide.xml")
ok "run finished with warnings (one unmapped channel)" '[ "$(echo "$R" | jget "d[\"status\"]")" = warnings ]'
ok "counts: 6 in file, 2 mapped, 1 unmapped, 2 skipped, 4 inserted" '[ "$(echo "$R" | jget "[d[\"counts\"][k] for k in (\"programmesInFile\",\"mappedChannels\",\"unmappedChannels\",\"skippedUnmapped\",\"inserted\")]")" = "[6, 2, 1, 2, 4]" ]'
ok "the warning names the waiting channel by its name" 'echo "$R" | grep -q "Mystery Channel" && echo "$R" | grep -q "waiting for you to choose"'
ok "auto-mapped by XMLTV id" '[ "$(q "SELECT mapped_by FROM epg_channel_aliases WHERE source_id='"'"'$SID'"'"' AND external_id='"'"'alpha.tv.example'"'"'")" = auto:xmltv_id ]'
ok "auto-mapped by name, case-insensitive" '[ "$(q "SELECT channel_id||'"'"'|'"'"'||mapped_by FROM epg_channel_aliases WHERE source_id='"'"'$SID'"'"' AND external_id='"'"'bravo-01'"'"'")" = "$CHB|auto:name" ]'
ok "the other tenant's channel was never a candidate" '[ -z "$(q "SELECT 1 FROM epg_channel_aliases WHERE channel_id='"'"'$CHX'"'"'")" ]'
END=$(q "SELECT to_char(ends_at AT TIME ZONE 'UTC','HH24:MI') FROM programmes WHERE channel_id='$CHA' AND title='Alpha Midday'")
ok "missing stop resolved to the next start ($END)" '[ "$END" = "12:00" ]'
ST=$(q "SELECT to_char(starts_at AT TIME ZONE 'UTC','HH24:MI') FROM programmes WHERE channel_id='$CHB'")
ok "no-offset time read in the channel's zone, London BST 19:00 = 18:00 UTC ($ST)" '[ "$ST" = "18:00" ]'
ok "metadata mapped (desc, genre, season/episode)" '[ "$(q "SELECT (metadata->>'"'"'description'"'"')||(metadata->>'"'"'genre'"'"')||(metadata->>'"'"'season'"'"')||(metadata->>'"'"'episodeNumber'"'"') FROM programmes WHERE title='"'"'Alpha Breakfast'"'"'")" = "MorningNews25" ]'
CH=$(curl -s "$B/api/epg/import/sources/$SID/channels" -H "$A")
ok "the lineup shows the unmapped one as waiting" '[ "$(echo "$CH" | jget "[c[\"state\"] for c in d if c[\"externalId\"]==\"mystery.example\"][0]")" = waiting ]'

# ---- same file again: idempotent
R=$(curl -s -X POST "$B/api/epg/import/sources/$SID/upload" -H "$A" -H 'content-type: application/xml' --data-binary @"$W/guide.xml")
ok "re-import of the same file: nothing inserted, nothing updated, 4 unchanged" '[ "$(echo "$R" | jget "[d[\"counts\"][k] for k in (\"inserted\",\"updated\",\"unchanged\",\"removed\")]")" = "[0, 0, 4, 0]" ]'
ok "no duplicates" '[ "$(q "SELECT count(*) FROM programmes WHERE channel_id IN ('"'"'$CHA'"'"','"'"'$CHB'"'"')")" = 4 ]'

# ---- map the mystery channel by hand, then a changed file: one edit, one removal
AL=$(q "SELECT id FROM epg_channel_aliases WHERE source_id='$SID' AND external_id='mystery.example'")
C=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$B/api/epg/import/aliases/$AL" -H "$A" -H "$J" -d "{\"channelId\":\"$CHX\"}")
ok "mapping to another tenant's channel is refused ($C)" '[ "$C" = 400 ]'
curl -s -o /dev/null -X PUT "$B/api/epg/import/aliases/$AL" -H "$A" -H "$J" -d "{\"channelId\":\"$CHC\"}"
# Lunch leaves the file and an afternoon show arrives after it, so Lunch's slot
# sits inside the span the file still covers: that is what makes it a removal.
sed -e 's#<title>Alpha Breakfast</title>#<title>Alpha Breakfast (extended)</title>#' \
    -e "s#.*Alpha Lunch.*#  <programme start=\"${D1}140000 +0000\" stop=\"${D1}150000 +0000\" channel=\"alpha.tv.example\"><title>Alpha Afternoon</title></programme>#" \
    "$W/guide.xml" > "$W/guide2.xml"
# protect a programme with a clip cut from it: it must survive even when the file drops it
q "UPDATE programmes SET clip_status='created' WHERE channel_id='$CHA' AND title='Alpha Lunch'" >/dev/null
R=$(curl -s -X POST "$B/api/epg/import/sources/$SID/upload" -H "$A" -H 'content-type: application/xml' --data-binary @"$W/guide2.xml")
ok "changed file: mystery (2) and the afternoon show (1) inserted; breakfast and midday's new end updated (2)" '[ "$(echo "$R" | jget "[d[\"counts\"][k] for k in (\"inserted\",\"updated\")]")" = "[3, 2]" ]'
ok "a programme with a clip is never removed by the diff" '[ "$(q "SELECT count(*) FROM programmes WHERE title='"'"'Alpha Lunch'"'"'")" = 1 ]'
q "UPDATE programmes SET clip_status='none' WHERE title='Alpha Lunch'" >/dev/null
R=$(curl -s -X POST "$B/api/epg/import/sources/$SID/upload" -H "$A" -H 'content-type: application/xml' --data-binary @"$W/guide2.xml")
ok "once unprotected, the programme the file dropped is removed (1)" '[ "$(echo "$R" | jget "d[\"counts\"][\"removed\"]")" = 1 ] && [ "$(q "SELECT count(*) FROM programmes WHERE title='"'"'Alpha Lunch'"'"'")" = 0 ]'
ok "the edit landed" '[ "$(q "SELECT count(*) FROM programmes WHERE title='"'"'Alpha Breakfast (extended)'"'"'")" = 1 ]'

# ---- remap mystery: its future programmes leave Charlie
C=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$B/api/epg/import/aliases/$AL" -H "$A" -H "$J" -d "{\"channelId\":\"$CHA\"}")
ok "a Volt channel already fed by this source cannot take a second feed channel ($C)" '[ "$C" = 409 ]'
R=$(curl -s -X PUT "$B/api/epg/import/aliases/$AL" -H "$A" -H "$J" -d "{\"channelId\":\"$CHD\"}")
ok "remapping removes the source's future programmes from the old channel" '[ "$(echo "$R" | jget "d[\"removedFromPrevious\"]")" = 2 ] && [ "$(q "SELECT count(*) FROM programmes WHERE channel_id='"'"'$CHC'"'"'")" = 0 ]'

# ---- gzip + Latin-1 + URL source + schedule
iconv -f UTF-8 -t ISO-8859-1 <<XML | gzip > "$W/latin.xml.gz"
<?xml version="1.0" encoding="ISO-8859-1"?>
<tv><channel id="charlie.example"><display-name>Charlie</display-name></channel>
<programme start="${D1}150000 +0000" stop="${D1}160000 +0000" channel="charlie.example"><title>Café Société</title></programme></tv>
XML
U=$(curl -s -X POST "$B/api/epg/import/sources" -H "$A" -H "$J" -d "{\"name\":\"Nightly feed\",\"kind\":\"url\",\"url\":\"http://127.0.0.1:$FPORT/latin.xml.gz\",\"refreshHours\":12,\"minDaysAhead\":0}")
UID_=$(echo "$U" | jget 'd["id"]')
R=$(curl -s -X POST "$B/api/epg/import/sources/$UID_/run" -H "$A")
ok "URL source, gzipped Latin-1: imported and auto-mapped by name" '[ "$(echo "$R" | jget "d[\"status\"]")" = ok ] && [ "$(q "SELECT title FROM programmes WHERE channel_id='"'"'$CHC'"'"'")" = "Café Société" ]'
ok "next run scheduled 12 h out" '[ "$(q "SELECT round(extract(epoch from next_run_at - now())/3600) FROM epg_import_sources WHERE id='"'"'$UID_'"'"'")" = 12 ]'
q "UPDATE epg_import_sources SET next_run_at = now() - interval '1 minute' WHERE id='$UID_'" >/dev/null
N=$(npx tsx -e "import {runDueImports} from './src/services/xmltvImport'; import {pool} from './src/db'; runDueImports().then(async n=>{console.log(n); await pool.end()})" 2>/dev/null | tail -1)
ok "the scheduler runs a due source ($N)" '[ "$N" = 1 ] && [ "$(q "SELECT count(*) FROM epg_import_runs WHERE source_id='"'"'$UID_'"'"' AND trigger='"'"'schedule'"'"'")" = 1 ]'

# ---- failure: reported, nothing touched, admins told
BEFORE=$(q "SELECT count(*) FROM programmes WHERE channel_id IN ('$CHA','$CHB','$CHC')")
curl -s -o /dev/null -X PATCH "$B/api/epg/import/sources/$UID_" -H "$A" -H "$J" -d "{\"url\":\"http://127.0.0.1:$FPORT/missing.xml\"}"
R=$(curl -s -X POST "$B/api/epg/import/sources/$UID_/run" -H "$A")
ok "a 404 guide fails with the reason" '[ "$(echo "$R" | jget "d[\"status\"]")" = failed ] && echo "$R" | grep -q "404"'
ok "a failed run leaves the guide alone" '[ "$(q "SELECT count(*) FROM programmes WHERE channel_id IN ('"'"'$CHA'"'"','"'"'$CHB'"'"','"'"'$CHC'"'"')")" = "$BEFORE" ]'
IN=$(curl -s "$B/api/notifications/inbox" -H "$A")
ok "the owner was told in their inbox" '[ "$(echo "$IN" | jget "any(i[\"subject\"] == \"EPG import \\\"Nightly feed\\\" failed\" for i in d[\"items\"])")" = True ]'
printf '<tv><channel id="x"><display-name>cut' > "$W/trunc.xml"
R=$(curl -s -X POST "$B/api/epg/import/sources/$SID/upload" -H "$A" -H 'content-type: application/xml' --data-binary @"$W/trunc.xml")
ok "a truncated file fails as truncated" '[ "$(echo "$R" | jget "d[\"status\"]")" = failed ] && echo "$R" | grep -q truncated'

# ---- tenancy
C=$(curl -s -o /dev/null -w '%{http_code}' "$B/api/epg/import/sources/$SID/channels" -H "$A2")
ok "another tenant cannot see the source ($C)" '[ "$C" = 404 ]'
C=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$B/api/epg/import/aliases/$AL" -H "$A2" -H "$J" -d "{\"channelId\":\"$CHX\"}")
ok "another tenant cannot remap its channels ($C)" '[ "$C" = 404 ]'

# ---- round trip: ImportCo's export becomes OtherCo's guide
curl -s -o "$W/export.xml" -H "$A" "$B/api/epg/xmltv?futureDays=7&pastDays=0&download=0"
S2=$(curl -s -X POST "$B/api/epg/import/sources" -H "$A2" -H "$J" -d '{"name":"From ImportCo","kind":"upload"}')
S2ID=$(echo "$S2" | jget 'd["id"]')
q "UPDATE channels SET xmltv_id='alpha.tv.example' WHERE id='$CHX'" >/dev/null
R=$(curl -s -X POST "$B/api/epg/import/sources/$S2ID/upload" -H "$A2" -H 'content-type: application/xml' --data-binary @"$W/export.xml")
EXP=$(q "SELECT count(*) FROM programmes WHERE channel_id='$CHA' AND ends_at > now()")
GOT=$(q "SELECT count(*) FROM programmes WHERE channel_id='$CHX'")
ok "our own export imports cleanly into another account ($GOT of $EXP programmes)" '[ "$GOT" = "$EXP" ] && [ "$GOT" -ge 2 ]'
SAME=$(q "SELECT count(*) FROM programmes a JOIN programmes b ON a.title=b.title AND a.starts_at=b.starts_at AND a.ends_at=b.ends_at WHERE a.channel_id='$CHA' AND b.channel_id='$CHX'")
ok "titles and instants survive the round trip ($SAME)" '[ "$SAME" = "$GOT" ]'

# ---- delete source: future programmes go, the source's runs go
R=$(curl -s -X DELETE "$B/api/epg/import/sources/$SID" -H "$A")
ok "deleting a source removes its future programmes" '[ "$(echo "$R" | jget "d[\"removedProgrammes\"]")" -ge 3 ] && [ -z "$(q "SELECT 1 FROM programmes WHERE source_ref LIKE '"'"'xmltv:$SID:%'"'"'")" ]'

kill $API $FILES 2>/dev/null
echo; echo "xmltv-import.check: $pass passed, $fail failed"
[ "$fail" = 0 ]
