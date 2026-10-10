#!/usr/bin/env bash
# XMLTV import lineup e2e: a feed shaped like xmltv.net's Sydney guide (the
# same name on three numbers, SD and HD simulcasts, radio, regional suffixes).
# Try it records the lineup without importing; auto-matching leaves the
# ambiguous ones alone; suggestions are one to one; accept suggestions, mark
# not used, create Volt channels from feed channels; one feed channel per Volt
# channel; not-used channels are skipped without warnings; new channels follow
# the source's rule; taking a channel out of use removes its future programmes;
# tenancy. With XMLTV_REAL_FEED=<path to a real XMLTV file> it also reads that.
# Run from volt-app/ with DATABASE_URL set.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8502}"
FPORT="${FPORT:-8503}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*' PUBLIC_BASE_URL="http://localhost:$PORT"
fuser -k "$PORT"/tcp "$FPORT"/tcp 2>/dev/null; sleep 0.4
pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
B="http://localhost:$PORT"; J='content-type:application/json'
W=$(mktemp -d)
ACC=0000000a-0000-0000-0000-0000000007b1; OTH=0000000a-0000-0000-0000-0000000007b2
G=0000000d-0000-0000-0000-0000000007b1
SBS=0000000e-0000-0000-0000-0000000007b1; SEVEN=0000000e-0000-0000-0000-0000000007b2; DJ=0000000e-0000-0000-0000-0000000007b3; ABC=0000000e-0000-0000-0000-0000000007b4
q(){ psql "$DATABASE_URL" -tA -c "$1"; }
jget(){ python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

# feed.xml: <name>|<lcn>|<id> rows, 4 programmes each over the next 2 days (an empty count = no programmes)
feed(){ python3 - "$W/feed.xml" "$@" <<'PY'
import sys, datetime
out, rows = sys.argv[1], sys.argv[2:]
now = datetime.datetime.now(datetime.timezone.utc).replace(minute=0, second=0, microsecond=0)
x = ['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE tv SYSTEM "xmltv.dtd">', '<tv source-info-name="test">']
for r in rows:
    name, lcn, cid, n = r.split('|')
    x.append(f'<channel id="{cid}"><display-name>{name}</display-name><lcn>{lcn}</lcn><icon src="https://img.example/{cid}.png?a=1&amp;b=2"/></channel>')
for r in rows:
    name, lcn, cid, n = r.split('|')
    for i in range(int(n or 0)):
        s = now + datetime.timedelta(hours=12 * i); e = s + datetime.timedelta(hours=12)
        x.append(f'<programme start="{s:%Y%m%d%H%M%S} +0000" stop="{e:%Y%m%d%H%M%S} +0000" channel="{cid}"><title>{name.strip()} show {i}</title></programme>')
x.append('</tv>')
open(out, 'w').write('\n'.join(x))
PY
}
BASE=('SBS Sydney|3|251831auepg|4' 'SBS HD Sydney|30|251832auepg|4' '7 Sydney|7|1auepg|4' '7 Sydney|70|70auepg|4' '7 Sydney|71|71auepg|4'
      'ABC TV NSW|2|abc.nsw|4' 'Double J Sydney|200|dj.syd|4' 'Extra|97|extra.syd|4' '7mate Sydney|73|73auepg|' '7mate HD Sydney|74|74auepg|4'
      'Nickelodeon Sydney|13|13auepg|4' 'gecko NSW|17|17auepg|4')
feed "${BASE[@]}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO accounts(id,name) VALUES ('$ACC','LineupCo'),('$OTH','OtherLineupCo') ON CONFLICT (id) DO NOTHING;
INSERT INTO users(id,account_id,email,password_hash,role,status,display_name) VALUES
  ('0000000b-0000-0000-0000-0000000007b1','$ACC','lu@lineup.example','x','owner','active','Lu'),
  ('0000000b-0000-0000-0000-0000000007b2','$OTH','oth@otherlineup.example','x','owner','active','Oth') ON CONFLICT (id) DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('0000000c-0000-0000-0000-0000000007b1','$ACC','HD','[{"height":360,"bitrate_kbps":800}]','transcode') ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id,max_channels) VALUES ('$G','$ACC','G','0000000c-0000-0000-0000-0000000007b1',20) ON CONFLICT (id) DO NOTHING;
INSERT INTO channels(id,group_id,name,status,tz,xmltv_id,kind) VALUES
  ('$SBS','$G','SBS','ended','Australia/Sydney',NULL,'tv'),
  ('$SEVEN','$G','7 Sydney','ended','Australia/Sydney',NULL,'tv'),
  ('$DJ','$G','Double J','ended','Australia/Sydney',NULL,'radio'),
  ('$ABC','$G','ABC Main','ended','Australia/Sydney','abc.nsw','tv') ON CONFLICT (id) DO NOTHING;
DELETE FROM channels WHERE group_id='$G' AND id NOT IN ('$SBS','$SEVEN','$DJ','$ABC');
DELETE FROM programmes WHERE channel_id IN (SELECT id FROM channels WHERE group_id='$G');
DELETE FROM epg_import_sources WHERE account_id IN ('$ACC','$OTH');
SQL
npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE email IN ('lu@lineup.example','oth@otherlineup.example')\",[h]); await pool.end();})()" >/dev/null 2>&1
( cd "$W" && python3 -m http.server "$FPORT" --bind 127.0.0.1 >/dev/null 2>&1 ) & FILES=$!
npx tsx src/index.ts >/tmp/xmltv_lineup_api.log 2>&1 &
API=$!
for i in $(seq 1 60); do curl -sf "$B/health" >/dev/null && break; sleep 0.25; done
login(){ curl -s -X POST "$B/api/auth/login" -H "$J" -d "{\"email\":\"$1\",\"password\":\"volt1234\"}" | sed -n 's/.*"access":"\([^"]*\)".*/\1/p'; }
A="authorization: Bearer $(login lu@lineup.example)"; A2="authorization: Bearer $(login oth@otherlineup.example)"
progs(){ q "SELECT count(*) FROM programmes WHERE channel_id='$1'"; }
lineup(){ curl -s "$B/api/epg/import/sources/$SID/channels" -H "$A"; }
alias_(){ q "SELECT id FROM epg_channel_aliases WHERE source_id='$SID' AND external_id='$1'"; }
st(){ q "SELECT CASE WHEN channel_id IS NOT NULL THEN 'used' WHEN ignored THEN 'not_used' ELSE 'waiting' END FROM epg_channel_aliases WHERE source_id='$SID' AND external_id='$1'"; }

SID=$(curl -s -X POST "$B/api/epg/import/sources" -H "$A" -H "$J" -d "{\"name\":\"Sydney lineup\",\"kind\":\"url\",\"url\":\"http://127.0.0.1:$FPORT/feed.xml\",\"refreshHours\":24,\"minDaysAhead\":0}" | jget 'd["id"]')
ok "source created, new channels wait for review by default" '[ -n "$SID" ] && [ "$(q "SELECT new_channels FROM epg_import_sources WHERE id='"'"'$SID'"'"'")" = review ]'

# ---- Try it: the lineup before any import
T=$(curl -s -X POST "$B/api/epg/import/sources/$SID/test" -H "$A")
ok "Try it records the 12-channel lineup and imports nothing" '[ "$(echo "$T" | jget "d[\"channels\"]")" = 12 ] && [ "$(q "SELECT count(*) FROM epg_channel_aliases WHERE source_id='"'"'$SID'"'"'")" = 12 ] && [ "$(q "SELECT count(*) FROM programmes p JOIN channels c ON c.id=p.channel_id WHERE c.group_id='"'"'$G'"'"'")" = 0 ]'
ok "only the XMLTV id match is used automatically (ABC); the rest wait" '[ "$(echo "$T" | jget "d[\"lineup\"]")" = "{'"'"'used'"'"': 1, '"'"'notUsed'"'"': 0, '"'"'waiting'"'"': 11}" ] && [ "$(st abc.nsw)" = used ]'
ok "none of the three '7 Sydney' is matched by name" '[ "$(st 1auepg)$(st 70auepg)$(st 71auepg)" = waitingwaitingwaiting ]'
L=$(lineup)
ok "the lineup is in channel-number order with numbers and counts" '[ "$(echo "$L" | jget "[c[\"lcn\"] for c in d][:4]")" = "['"'"'2'"'"', '"'"'3'"'"', '"'"'7'"'"', '"'"'13'"'"']" ] && [ "$(echo "$L" | jget "[c[\"programmesInFeed\"] for c in d if c[\"lcn\"]==\"73\"][0]")" = 0 ]'
ok "same-named siblings are listed (7 Sydney on 7: 70, 71)" '[ "$(echo "$L" | jget "[c[\"sameNameAs\"] for c in d if c[\"lcn\"]==\"7\"][0]")" = "['"'"'70'"'"', '"'"'71'"'"']" ]'
ok "suggestions are one to one: SBS on 3 (not 30), 7 Sydney on 7, Double J on 200" '[ "$(echo "$L" | jget "sorted((c[\"lcn\"], c[\"suggestion\"][\"channelName\"]) for c in d if c[\"suggestion\"])")" = "[('"'"'200'"'"', '"'"'Double J'"'"'), ('"'"'3'"'"', '"'"'SBS'"'"'), ('"'"'7'"'"', '"'"'7 Sydney'"'"')]" ]'

# ---- choose
ALL=$(echo "$L" | python3 -c "import json,sys; print(json.dumps([c['id'] for c in json.load(sys.stdin)]))")
R=$(curl -s -X POST "$B/api/epg/import/sources/$SID/channels/bulk" -H "$A" -H "$J" -d "{\"aliasIds\":$ALL,\"action\":\"accept_suggestions\"}")
ok "accept suggestions on the whole lineup takes exactly the 3 suggested" '[ "$(echo "$R" | jget "d[\"done\"]")" = 3 ] && [ "$(st 251831auepg)$(st 1auepg)$(st dj.syd)" = usedusedused ] && [ "$(st 251832auepg)" = waiting ]'
C=$(curl -s -o "$W/b" -w '%{http_code}' -X PUT "$B/api/epg/import/aliases/$(alias_ 70auepg)" -H "$A" -H "$J" -d "{\"channelId\":\"$SEVEN\"}")
ok "a second feed channel on 7 Sydney is refused, naming the one it has ($C)" '[ "$C" = 409 ] && grep -q "7 Sydney (7)" "$W/b"'
NU=$(python3 -c "import json; print(json.dumps(['$(alias_ 70auepg)','$(alias_ 71auepg)','$(alias_ 251832auepg)','$(alias_ 73auepg)','$(alias_ 74auepg)','$(alias_ 13auepg)']))")
R=$(curl -s -X POST "$B/api/epg/import/sources/$SID/channels/bulk" -H "$A" -H "$J" -d "{\"aliasIds\":$NU,\"action\":\"not_used\"}")
ok "six marked not used" '[ "$(echo "$R" | jget "d[\"done\"]")" = 6 ] && [ "$(st 70auepg)$(st 13auepg)" = not_usednot_used ]'
R=$(curl -s -X POST "$B/api/epg/import/sources/$SID/channels/bulk" -H "$A" -H "$J" -d "{\"aliasIds\":[\"$(alias_ extra.syd)\"],\"action\":\"create\",\"kind\":\"tv\"}")
ok "create without a group is refused" 'echo "$R" | grep -q "group"'
R=$(curl -s -X POST "$B/api/epg/import/sources/$SID/channels/bulk" -H "$A" -H "$J" -d "{\"aliasIds\":[\"$(alias_ extra.syd)\"],\"action\":\"create\",\"groupId\":\"$G\",\"kind\":\"tv\",\"tz\":\"Australia/Sydney\"}")
NEW=$(q "SELECT channel_id FROM epg_channel_aliases WHERE source_id='$SID' AND external_id='extra.syd'")
ok "create makes a Volt channel named from the feed, with their id as its XMLTV id, and uses it" '[ "$(echo "$R" | jget "d[\"done\"]")" = 1 ] && [ "$(q "SELECT name||'"'"'|'"'"'||xmltv_id||'"'"'|'"'"'||kind||'"'"'|'"'"'||tz FROM channels WHERE id='"'"'$NEW'"'"'")" = "Extra|extra.syd|tv|Australia/Sydney" ] && [ "$(q "SELECT mapped_by FROM epg_channel_aliases WHERE source_id='"'"'$SID'"'"' AND external_id='"'"'extra.syd'"'"'")" = created ]'
ok "the new channel is in the audit log as created from this import" '[ "$(q "SELECT count(*) FROM audit_log WHERE entity_id='"'"'$NEW'"'"' AND action='"'"'create'"'"'")" -ge 1 ]'

# ---- import: used channels only, quiet about the not used
R=$(curl -s -X POST "$B/api/epg/import/sources/$SID/run" -H "$A")
ok "programmes only for the 5 used channels (20)" '[ "$(q "SELECT count(*) FROM programmes p JOIN channels c ON c.id=p.channel_id WHERE c.group_id='"'"'$G'"'"'")" = 20 ] && [ "$(progs $SBS)" = 4 ] && [ "$(progs $NEW)" = 4 ]'
ok "counts: 5 used, 6 not used skipped quietly, 1 waiting" '[ "$(echo "$R" | jget "(d[\"counts\"][\"mappedChannels\"], d[\"counts\"][\"ignoredChannels\"], d[\"counts\"][\"unmappedChannels\"])")" = "(5, 6, 1)" ]'
ok "the warning names only the waiting channel (gecko), not the not-used ones" 'echo "$R" | grep -q "gecko NSW (17)" && ! echo "$R" | grep -q "Nickelodeon"'
curl -s -o /dev/null -X PUT "$B/api/epg/import/aliases/$(alias_ 17auepg)" -H "$A" -H "$J" -d '{"ignored":true}'
R=$(curl -s -X POST "$B/api/epg/import/sources/$SID/run" -H "$A")
ok "with every channel decided the run is clean" '[ "$(echo "$R" | jget "d[\"status\"]")" = ok ]'

# ---- new channels follow the source's rule
curl -s -o /dev/null -X PATCH "$B/api/epg/import/sources/$SID" -H "$A" -H "$J" -d '{"newChannels":"ignore"}'
feed "${BASE[@]}" 'Brand New HD|500|new.syd|4'
R=$(curl -s -X POST "$B/api/epg/import/sources/$SID/run" -H "$A")
ok "with new channels set to not used, a new feed channel arrives not used and the run stays clean" '[ "$(st new.syd)" = not_used ] && [ "$(echo "$R" | jget "d[\"status\"]")" = ok ]'
curl -s -o /dev/null -X PATCH "$B/api/epg/import/sources/$SID" -H "$A" -H "$J" -d '{"newChannels":"review"}'
feed "${BASE[@]}" 'Brand New HD|500|new.syd|4' 'Another New|501|new2.syd|4'
R=$(curl -s -X POST "$B/api/epg/import/sources/$SID/run" -H "$A")
ok "set back to review, the next new one waits and is named" '[ "$(st new2.syd)" = waiting ] && echo "$R" | grep -q "Another New (501)" && [ "$(st new.syd)" = not_used ]'

# ---- taking a channel out of use
R=$(curl -s -X POST "$B/api/epg/import/sources/$SID/channels/bulk" -H "$A" -H "$J" -d "{\"aliasIds\":[\"$(alias_ 251831auepg)\"],\"action\":\"not_used\"}")
ok "marking SBS not used takes its not-yet-aired programmes off SBS" '[ "$(st 251831auepg)" = not_used ] && [ "$(q "SELECT count(*) FROM programmes WHERE channel_id='"'"'$SBS'"'"' AND starts_at > now()")" = 0 ]'
curl -s -o /dev/null -X PUT "$B/api/epg/import/aliases/$(alias_ 251832auepg)" -H "$A" -H "$J" -d "{\"channelId\":\"$SBS\"}"
curl -s -o /dev/null -X POST "$B/api/epg/import/sources/$SID/run" -H "$A"
ok "and the HD feed channel can take SBS instead" '[ "$(st 251832auepg)" = used ] && [ "$(progs $SBS)" -ge 3 ] && [ "$(q "SELECT count(*) FROM programmes WHERE channel_id='"'"'$SBS'"'"' AND title LIKE '"'"'SBS HD%'"'"'")" -ge 3 ]'
L=$(lineup)
ok "the list shows the counts per state" '[ "$(curl -s "$B/api/epg/import/sources" -H "$A" | jget "(d[0][\"mapped\"], d[0][\"notUsed\"], d[0][\"unmapped\"])")" = "(5, 8, 1)" ]'

# ---- another source feeding the same Volt channel is shown
S2=$(curl -s -X POST "$B/api/epg/import/sources" -H "$A" -H "$J" -d '{"name":"Second guide","kind":"upload"}' | jget 'd["id"]')
printf '<tv><channel id="sbs.other"><display-name>SBS</display-name></channel></tv>' > "$W/s2.xml"
curl -s -o /dev/null -X POST "$B/api/epg/import/sources/$S2/upload" -H "$A" -H 'content-type: application/xml' --data-binary @"$W/s2.xml"
ok "a second source maps SBS by name (unique on both sides)" '[ "$(q "SELECT channel_id FROM epg_channel_aliases WHERE source_id='"'"'$S2'"'"'")" = "$SBS" ]'
ok "the first source's lineup says SBS is also fed by it" '[ "$(lineup | jget "[c[\"alsoFedBy\"] for c in d if c[\"externalId\"]==\"251832auepg\"][0]")" = "['"'"'Second guide'"'"']" ]'

# ---- tenancy
C=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/epg/import/sources/$SID/channels/bulk" -H "$A2" -H "$J" -d "{\"aliasIds\":$ALL,\"action\":\"not_used\"}")
ok "another tenant cannot change this lineup ($C)" '[ "$C" = 404 ]'
C=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$B/api/epg/import/aliases/$(alias_ 70auepg)" -H "$A2" -H "$J" -d '{"ignored":false}')
ok "nor one channel of it ($C)" '[ "$C" = 404 ]'

# ---- optional: a real feed
if [ -n "${XMLTV_REAL_FEED:-}" ] && [ -f "$XMLTV_REAL_FEED" ]; then
  cp "$XMLTV_REAL_FEED" "$W/real.xml"
  RS=$(curl -s -X POST "$B/api/epg/import/sources" -H "$A" -H "$J" -d "{\"name\":\"Real feed\",\"kind\":\"url\",\"url\":\"http://127.0.0.1:$FPORT/real.xml\",\"minDaysAhead\":0}" | jget 'd["id"]')
  T=$(curl -s -X POST "$B/api/epg/import/sources/$RS/test" -H "$A")
  ok "real feed: read and its lineup recorded ($(echo "$T" | jget "(d['channels'], d['programmes'])"))" '[ "$(echo "$T" | jget "d[\"status\"]")" = ok ] && [ "$(q "SELECT count(*) FROM epg_channel_aliases WHERE source_id='"'"'$RS'"'"'")" = "$(echo "$T" | jget "d[\"channels\"]")" ]'
fi

kill $API $FILES 2>/dev/null
rm -rf "$W"
echo; echo "xmltv-lineup.check: $pass passed, $fail failed"
[ "$fail" = 0 ]
