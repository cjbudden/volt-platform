#!/usr/bin/env bash
# Guide icon: the image a channel or station carries in the EPG.
# Order, first that exists: the guide icon set by hand, the channel's own logo
# (brand_ref), the icon of a linked imported feed channel, a metadata logo.
# Covers create and settings saves, the JSON guide and the XMLTV export, the
# guide-icon endpoint (set, clear, bad values, tenancy), the lineup showing our
# image on a linked row, and "keep their logo" only when we have none.
# Run from volt-app/ with DATABASE_URL set.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8509}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*' PUBLIC_BASE_URL="http://localhost:$PORT"
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4
pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
B="http://localhost:$PORT/api"; J='content-type:application/json'
ACC=0000000a-0000-0000-0000-0000000007e1; OTH=0000000a-0000-0000-0000-0000000007e2
G=0000000d-0000-0000-0000-0000000007e1
BARE=0000000e-0000-0000-0000-0000000007e1   # no image of its own, linked to a feed channel
OTHCH=0000000e-0000-0000-0000-0000000007e9
SRC=0000000f-0000-0000-0000-0000000007e1
q(){ psql "$DATABASE_URL" -tA -c "$1"; }
jget(){ python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
DELETE FROM channels WHERE group_id='$G';
INSERT INTO accounts(id,name) VALUES ('$ACC','IconCo'),('$OTH','OtherIconCo') ON CONFLICT (id) DO NOTHING;
INSERT INTO users(id,account_id,email,password_hash,role,status,display_name) VALUES
  ('0000000b-0000-0000-0000-0000000007e1','$ACC','ic@icon.example','x','owner','active','Ic'),
  ('0000000b-0000-0000-0000-0000000007e2','$OTH','oth@othericon.example','x','owner','active','Oth') ON CONFLICT (id) DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('0000000c-0000-0000-0000-0000000007e1','$ACC','HD','[{"height":360,"bitrate_kbps":800}]','transcode') ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id,max_channels) VALUES ('$G','$ACC','G','0000000c-0000-0000-0000-0000000007e1',20) ON CONFLICT (id) DO NOTHING;
INSERT INTO channels(id,group_id,name,status,tz,kind) VALUES ('$BARE','$G','Bare TV','ended','Australia/Sydney','tv');
INSERT INTO epg_import_sources(id,account_id,name,kind,url) VALUES ('$SRC','$ACC','Feed','url','http://127.0.0.1:9/x.xml') ON CONFLICT (id) DO NOTHING;
INSERT INTO epg_channel_aliases(account_id,source_id,external_id,display_name,icon,channel_id) VALUES
  ('$ACC','$SRC','bare.feed','Bare','https://img.example/bare.png','$BARE')
  ON CONFLICT (source_id, external_id) DO UPDATE SET channel_id=EXCLUDED.channel_id, icon=EXCLUDED.icon;
SQL
OTHG=$(q "SELECT id FROM groups WHERE account_id='$OTH' LIMIT 1")
[ -z "$OTHG" ] && { q "INSERT INTO groups(id,account_id,name) VALUES ('0000000d-0000-0000-0000-0000000007e2','$OTH','G')" >/dev/null; OTHG=0000000d-0000-0000-0000-0000000007e2; }
q "INSERT INTO channels(id,group_id,name,status,tz,kind) VALUES ('$OTHCH','$OTHG','Not yours','ended','UTC','tv') ON CONFLICT (id) DO NOTHING" >/dev/null
npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE email IN ('ic@icon.example','oth@othericon.example')\",[h]); await pool.end();})()" >/dev/null 2>&1
npx tsx src/index.ts >/tmp/guide_icon_api.log 2>&1 &
API=$!
for i in $(seq 1 60); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
login(){ curl -s -X POST "$B/auth/login" -H "$J" -d "{\"email\":\"$1\",\"password\":\"volt1234\"}" | sed -n 's/.*"access":"\([^"]*\)".*/\1/p'; }
A="authorization: Bearer $(login ic@icon.example)"; O="authorization: Bearer $(login oth@othericon.example)"
LOGO="/library/$ACC/brands/news.png"; SQUARE="/library/$ACC/brands/news-square.png"
gc(){ curl -s "$B/epg/channels" -H "$A" | jget "[(c['iconFrom'], c['iconRef']) for c in d if c['id']=='$1'][0]"; }
xml(){ curl -s "$B/epg/xmltv?download=0" -H "$A"; }

# ---- a channel created with a logo and no guide icon: the guide shows the logo
CH=$(curl -s -X POST "$B/channels" -H "$A" -H "$J" -d "{\"groupId\":\"$G\",\"name\":\"Icon News\",\"brandRef\":\"$LOGO\",\"sources\":[{\"role\":\"primary\",\"protocol\":\"hls\",\"ingestUrl\":\"http://127.0.0.1:9/a.m3u8\"}]}" | jget 'd["id"]')
ok "a new channel with a logo and no guide icon stores none" '[ -n "$CH" ] && [ -z "$(q "SELECT guide_icon_ref FROM channels WHERE id='"'"'$CH'"'"'")" ]'
ok "the guide uses the channel logo" '[ "$(gc $CH)" = "('"'"'brand'"'"', '"'"'$LOGO'"'"')" ]'
ok "and the XMLTV <icon> is the logo, as an absolute SIGNED image URL" 'xml | grep -q "<icon src=\"http://localhost:$PORT/img/[A-Za-z0-9_-]\{22\}/256x256,inside/library/$ACC/brands/news.png\"/>"'

# ---- a guide icon set in the channel's settings wins
V=$(q "SELECT version FROM channels WHERE id='$CH'")
C=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$B/channels/$CH" -H "$A" -H "$J" -d "{\"guideIconRef\":\"$SQUARE\",\"version\":$V}")
ok "settings save a guide icon ($C)" '[ "$C" = 200 ] && [ "$(q "SELECT guide_icon_ref FROM channels WHERE id='"'"'$CH'"'"'")" = "$SQUARE" ]'
ok "the guide now uses the guide icon, not the logo" '[ "$(gc $CH)" = "('"'"'guide'"'"', '"'"'$SQUARE'"'"')" ]'
ok "and so does the XMLTV export" 'xml | grep -q "news-square.png"'
ok "the logo is untouched" '[ "$(q "SELECT brand_ref FROM channels WHERE id='"'"'$CH'"'"'")" = "$LOGO" ]'

# ---- the guide-icon endpoint (the EPG page's Set guide icon / Use logo)
R=$(curl -s -X PUT "$B/epg/channels/$CH/guide-icon" -H "$A" -H "$J" -d '{"ref":null}')
ok "clearing it goes back to the logo" '[ "$(echo "$R" | jget "(d[\"guideIconRef\"], d[\"iconFrom\"])")" = "(None, '"'"'brand'"'"')" ]'
R=$(curl -s -X PUT "$B/epg/channels/$CH/guide-icon" -H "$A" -H "$J" -d '{"ref":"https://cdn.example/sq.png"}')
ok "an http(s) image URL is accepted" '[ "$(echo "$R" | jget "d[\"iconFrom\"]")" = guide ]'
C=$(curl -s -o /tmp/gi_body -w '%{http_code}' -X PUT "$B/epg/channels/$CH/guide-icon" -H "$A" -H "$J" -d '{"ref":"javascript:alert(1)"}')
ok "anything else is refused ($C)" '[ "$C" = 400 ] && grep -q "library image" /tmp/gi_body'
C=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$B/epg/channels/$OTHCH/guide-icon" -H "$A" -H "$J" -d '{"ref":null}')
ok "another account's channel is not found ($C)" '[ "$C" = 404 ]'

# ---- a linked feed channel: our image wins; theirs only fills in
ok "a linked channel with no image of its own uses the feed's icon" '[ "$(gc $BARE)" = "('"'"'feed'"'"', '"'"'https://img.example/bare.png'"'"')" ]'
L=$(curl -s "$B/epg/import/sources/$SRC/channels" -H "$A")
AID=$(echo "$L" | jget "[r['id'] for r in d if r['externalId']=='bare.feed'][0]")
ok "the lineup says the linked channel has no image yet" '[ "$(echo "$L" | jget "[r[\"channelIconRef\"] for r in d if r[\"externalId\"]==\"bare.feed\"][0]")" = None ]'
C=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/epg/import/sources/$SRC/channels/$AID/use-icon" -H "$O")
ok "another account cannot adopt the icon ($C)" '[ "$C" = 404 ]'
R=$(curl -s -X POST "$B/epg/import/sources/$SRC/channels/$AID/use-icon" -H "$A")
ok "keep their logo: it becomes the channel's logo" '[ "$(q "SELECT brand_ref FROM channels WHERE id='"'"'$BARE'"'"'")" = "https://img.example/bare.png" ]'
ok "and it is audited" '[ "$(q "SELECT count(*) FROM audit_log WHERE entity_id='"'"'$BARE'"'"' AND detail::text LIKE '"'"'%XMLTV import%'"'"'")" -ge 1 ]'
C=$(curl -s -o /tmp/gi_body -w '%{http_code}' -X POST "$B/epg/import/sources/$SRC/channels/$AID/use-icon" -H "$A")
ok "it never replaces an image the channel already has ($C)" '[ "$C" = 400 ] && grep -q "already has its own image" /tmp/gi_body'
q "UPDATE channels SET brand_ref='$LOGO' WHERE id='$BARE'" >/dev/null
ok "once the linked channel has its own logo the guide shows ours, not theirs" '[ "$(gc $BARE)" = "('"'"'brand'"'"', '"'"'$LOGO'"'"')" ]'
ok "and the lineup shows our image on the linked row" '[ "$(curl -s "$B/epg/import/sources/$SRC/channels" -H "$A" | jget "[r[\"channelIconRef\"] for r in d if r[\"externalId\"]==\"bare.feed\"][0]")" = "$LOGO" ]'

# ---- a radio station created with artwork and its own guide icon
G2=$(q "SELECT id FROM groups WHERE account_id='$ACC' LIMIT 1")
ST=$(curl -s -X POST "$B/channels" -H "$A" -H "$J" -d "{\"groupId\":\"$G\",\"name\":\"Icon FM\",\"kind\":\"radio\",\"radio\":{\"outputs\":{\"mp3\":true,\"hls\":false,\"dash\":false}},\"brandRef\":\"$LOGO\",\"guideIconRef\":\"$SQUARE\",\"sources\":[{\"role\":\"primary\",\"protocol\":\"icecast\",\"ingestUrl\":\"http://127.0.0.1:9/live\"}]}" | jget 'd["id"]')
ok "a new station keeps its artwork and its guide icon" '[ "$(q "SELECT brand_ref||'"'"'|'"'"'||guide_icon_ref FROM channels WHERE id='"'"'$ST'"'"'")" = "$LOGO|$SQUARE" ]'
ok "the station list returns the guide icon for the settings form" '[ "$(curl -s "$B/radio" -H "$A" | jget "[r[\"guide_icon_ref\"] for r in d if r[\"id\"]==\"$ST\"][0]")" = "$SQUARE" ]'

# Not about icons: the station's received-metadata log 500ed on every station
# page (an untyped $5 in its count query). Found while checking this form.
C=$(curl -s -o /tmp/gi_body -w '%{http_code}' "$B/radio/$ST/log" -H "$A")
ok "the station's received-metadata log loads ($C)" '[ "$C" = 200 ] && grep -q "\"counts\"" /tmp/gi_body'
C=$(curl -s -o /dev/null -w '%{http_code}' "$B/radio/$ST/log?minSec=30&class=ad" -H "$A")
ok "and with its filters ($C)" '[ "$C" = 200 ]'

kill $API 2>/dev/null
echo; echo "guide-icon.check: $pass passed, $fail failed"
[ "$fail" = 0 ]
