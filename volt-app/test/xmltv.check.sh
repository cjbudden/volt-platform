#!/usr/bin/env bash
# XMLTV export e2e: console/API pull, per-channel XMLTV ids, conditional GET,
# gzip, as-run vs scheduled, scope (cancelled, window, guide-disabled, tenant),
# the JSON channel list, and partner feeds (create, poll, .gz, rescope,
# disable, rotate, revoke). Every XML body is validated against the XMLTV DTD.
# Run from volt-app/ with DATABASE_URL set.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8491}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*' PUBLIC_BASE_URL="http://localhost:$PORT"
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4

pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
W=$(mktemp -d); cp test/fixtures/xmltv.dtd "$W/xmltv.dtd"
valid(){ ( cd "$W" && xmllint --noout --valid "$1" 2>"$1.err" ); }
B="http://localhost:$PORT"

ACC=0000000a-0000-0000-0000-0000000000c7
OTHER=0000000a-0000-0000-0000-0000000000c8
CH=0000000e-0000-0000-0000-0000000000c7
CH2=0000000e-0000-0000-0000-0000000000c9
CHOFF=0000000e-0000-0000-0000-0000000000ca
CHX=0000000e-0000-0000-0000-0000000000c8

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO accounts(id,name) VALUES ('$ACC','GuideCo'),('$OTHER','OtherCo') ON CONFLICT (id) DO NOTHING;
INSERT INTO users(id,account_id,email,password_hash,role,status,display_name) VALUES
  ('0000000b-0000-0000-0000-0000000000c7','$ACC','guide@guideco.example','x','owner','active','Guide Admin')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES
  ('0000000c-0000-0000-0000-0000000000c7','$ACC','HD','[{"height":360,"bitrate_kbps":800}]','transcode'),
  ('0000000c-0000-0000-0000-0000000000c8','$OTHER','HD','[{"height":360,"bitrate_kbps":800}]','transcode')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id) VALUES
  ('0000000d-0000-0000-0000-0000000000c7','$ACC','G','0000000c-0000-0000-0000-0000000000c7'),
  ('0000000d-0000-0000-0000-0000000000c8','$OTHER','G','0000000c-0000-0000-0000-0000000000c8')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO channels(id,group_id,name,status,tz,kind) VALUES
  ('$CH','0000000d-0000-0000-0000-0000000000c7','Guide News','ended','Australia/Brisbane','tv'),
  ('$CH2','0000000d-0000-0000-0000-0000000000c7','Guide FM','ended','Europe/London','radio'),
  ('$CHOFF','0000000d-0000-0000-0000-0000000000c7','Hidden Guide','ended','UTC','tv'),
  ('$CHX','0000000d-0000-0000-0000-0000000000c8','Not Yours','ended','UTC','tv')
  ON CONFLICT (id) DO NOTHING;
UPDATE channels SET epg_enabled=false WHERE id='$CHOFF';
UPDATE channels SET xmltv_id=NULL WHERE id IN ('$CH','$CH2','$CHOFF','$CHX');
DELETE FROM programmes WHERE channel_id IN ('$CH','$CH2','$CHOFF','$CHX');
DELETE FROM epg_feeds WHERE account_id IN ('$ACC','$OTHER');
INSERT INTO programmes(channel_id,title,starts_at,ends_at,metadata,status,actual_start,actual_end) VALUES
  ('$CH','Morning <News> & More', date_trunc('hour',now())+interval '2 hours', date_trunc('hour',now())+interval '3 hours',
     '{"description":"Top stories","genre":"News","tags":["politics"],"rating":"PG","season":2,"episodeNumber":5,"credits.presenter":["A. Anchor"]}','scheduled',NULL,NULL),
  ('$CH','Aired Show', date_trunc('hour',now())-interval '5 hours', date_trunc('hour',now())-interval '4 hours','{}','aired',
     date_trunc('hour',now())-interval '5 hours'+interval '137 seconds', date_trunc('hour',now())-interval '4 hours'+interval '60 seconds'),
  ('$CH','Cancelled Show', date_trunc('hour',now())+interval '4 hours', date_trunc('hour',now())+interval '5 hours','{}','cancelled',NULL,NULL),
  ('$CH','Far Future', now()+interval '40 days', now()+interval '40 days 1 hour','{}','scheduled',NULL,NULL),
  ('$CH2','Late Jazz', date_trunc('hour',now())+interval '1 hour', date_trunc('hour',now())+interval '3 hours','{"genre":"Jazz"}','scheduled',NULL,NULL),
  ('$CHOFF','Should Not Appear', now()+interval '1 hour', now()+interval '2 hours','{}','scheduled',NULL,NULL),
  ('$CHX','Other Tenant Show', now()+interval '1 hour', now()+interval '2 hours','{}','scheduled',NULL,NULL);
SQL

npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE email='guide@guideco.example'\",[h]); await pool.end();})()" >/dev/null 2>&1

npx tsx src/index.ts >/tmp/xmltv_api.log 2>&1 &
API=$!
for i in $(seq 1 60); do curl -sf "$B/health" >/dev/null && break; sleep 0.25; done

TOK=$(curl -s -X POST "$B/api/auth/login" -H 'content-type:application/json' -d '{"email":"guide@guideco.example","password":"volt1234"}' | sed -n 's/.*"access":"\([^"]*\)".*/\1/p')
A="authorization: Bearer $TOK"
ok "admin logged in" '[ -n "$TOK" ]'

# ---- auth + validation -------------------------------------------------------
C=$(curl -s -o /dev/null -w '%{http_code}' "$B/api/epg/xmltv")
ok "export needs auth (got $C)" '[ "$C" = 401 ]'
C=$(curl -s -o /dev/null -w '%{http_code}' -H "$A" "$B/api/epg/xmltv?futureDays=120")
ok "window over 93 days refused (got $C)" '[ "$C" = 400 ]'
C=$(curl -s -o /dev/null -w '%{http_code}' -H "$A" "$B/api/epg/xmltv?times=sometimes")
ok "unknown time basis refused, not defaulted (got $C)" '[ "$C" = 400 ]'

# ---- the export ----------------------------------------------------------------
curl -s -D "$W/h1" -o "$W/a.xml" -H "$A" "$B/api/epg/xmltv"
ok "200 application/xml" 'grep -qi "^content-type: application/xml" "$W/h1"'
ok "served as a download" 'grep -qi "^content-disposition: attachment; filename=\"volt-guide-" "$W/h1"'
ok "validates against xmltv.dtd" 'valid "$W/a.xml" || { cat "$W/a.xml.err" | head -5; false; }'
ok "both guide-enabled channels present (uuid ids by default)" 'grep -q "<channel id=\"$CH\">" "$W/a.xml" && grep -q "<channel id=\"$CH2\">" "$W/a.xml"'
ok "guide-disabled channel left out" '! grep -q "$CHOFF" "$W/a.xml" && ! grep -q "Should Not Appear" "$W/a.xml"'
ok "another tenant left out" '! grep -q "Other Tenant Show" "$W/a.xml" && ! grep -q "$CHX" "$W/a.xml"'
ok "cancelled programme left out" '! grep -q "Cancelled Show" "$W/a.xml"'
ok "outside the window left out" '! grep -q "Far Future" "$W/a.xml"'
ok "title escaped" 'grep -q "Morning &lt;News&gt; &amp; More" "$W/a.xml"'
ok "metadata mapped (desc, category, keyword, rating, xmltv_ns, presenter)" 'grep -q "<desc>Top stories</desc>" "$W/a.xml" && grep -q "<category>News</category>" "$W/a.xml" && grep -q "<keyword>politics</keyword>" "$W/a.xml" && grep -q "<value>PG</value>" "$W/a.xml" && grep -q "system=\"xmltv_ns\">1.4.<" "$W/a.xml" && grep -q "<presenter>A. Anchor</presenter>" "$W/a.xml"'
ok "Brisbane channel times carry +1000" 'grep -q "channel=\"$CH\"" "$W/a.xml" && grep -A0 "Morning" -B1 "$W/a.xml" | grep -q "+1000"'
ok "radio programme marked no-video" 'grep -A8 "Late Jazz" "$W/a.xml" | grep -q "<present>no</present>"'
ok "counts header" 'grep -qi "^x-volt-guide-counts: channels=2; programmes=3" "$W/h1"'
ok "time basis header says scheduled" 'grep -qi "^x-volt-time-basis: scheduled" "$W/h1"'

# ---- as-run ----------------------------------------------------------------------
curl -s -o "$W/s.xml" -H "$A" "$B/api/epg/xmltv?tz=utc"
curl -s -o "$W/r.xml" -H "$A" "$B/api/epg/xmltv?tz=utc&times=asrun"
SCHED=$(grep -B1 "<title>Aired Show" "$W/s.xml" | sed -n 's/.*start="\([^"]*\)".*/\1/p')
ASRUN=$(grep -B1 "<title>Aired Show" "$W/r.xml" | sed -n 's/.*start="\([^"]*\)".*/\1/p')
ok "scheduled start on the hour ($SCHED)" 'echo "$SCHED" | grep -q "0000 +0000$"'
ok "as-run start is the observed 2m17s late ($ASRUN)" 'echo "$ASRUN" | grep -q "0217 +0000$"'
ok "as-run document validates" 'valid "$W/r.xml"'

# ---- conditional GET + gzip -------------------------------------------------------
ET=$(grep -i '^etag:' "$W/h1" | sed 's/^[Ee][Tt][Aa][Gg]: *//' | tr -d '\r')
C=$(curl -s -o /dev/null -w '%{http_code}' -H "$A" -H "if-none-match: $ET" "$B/api/epg/xmltv")
ok "unchanged guide answers 304 ($C)" '[ "$C" = 304 ]'
PID=$(psql "$DATABASE_URL" -tA -c "SELECT id FROM programmes WHERE channel_id='$CH' AND title LIKE 'Morning%'")
curl -s -o /dev/null -X PATCH "$B/api/epg/$PID" -H "$A" -H 'content-type:application/json' -d '{"title":"Morning News"}'
C=$(curl -s -o /dev/null -w '%{http_code}' -H "$A" -H "if-none-match: $ET" "$B/api/epg/xmltv")
ok "an edit invalidates the ETag ($C)" '[ "$C" = 200 ]'
curl -s -D "$W/hg" -o "$W/g.bin" -H "$A" -H 'accept-encoding: gzip' "$B/api/epg/xmltv"
ok "gzip when asked" 'grep -qi "^content-encoding: gzip" "$W/hg" && gunzip -c "$W/g.bin" > "$W/g.xml" && valid "$W/g.xml"'

# ---- XMLTV channel ids -----------------------------------------------------------
C=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$B/api/epg/channels/$CH/xmltv-id" -H "$A" -H 'content-type:application/json' -d '{"xmltvId":"bad id with spaces"}')
ok "invalid xmltv id refused ($C)" '[ "$C" = 400 ]'
R=$(curl -s -X PUT "$B/api/epg/channels/$CH/xmltv-id" -H "$A" -H 'content-type:application/json' -d '{"xmltvId":"news.guideco.example"}')
ok "xmltv id set" 'echo "$R" | grep -q "\"xmltvIdSet\":true"'
C=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$B/api/epg/channels/$CH2/xmltv-id" -H "$A" -H 'content-type:application/json' -d '{"xmltvId":"news.guideco.example"}')
ok "duplicate within the account refused ($C)" '[ "$C" = 409 ]'
C=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$B/api/epg/channels/$CHX/xmltv-id" -H "$A" -H 'content-type:application/json' -d '{"xmltvId":"steal.example"}')
ok "another tenant's channel is not found ($C)" '[ "$C" = 404 ]'
curl -s -o "$W/b.xml" -H "$A" "$B/api/epg/xmltv"
ok "export uses it for the channel and its programmes" 'grep -q "<channel id=\"news.guideco.example\">" "$W/b.xml" && grep -q "channel=\"news.guideco.example\"" "$W/b.xml" && ! grep -q "channel=\"$CH\"" "$W/b.xml"'
J=$(curl -s -H "$A" "$B/api/epg/channels")
ok "GET /api/epg/channels lists xmltv ids as JSON" 'echo "$J" | grep -q "\"xmltvId\":\"news.guideco.example\"" && echo "$J" | grep -q "\"medium\":\"radio\""'
ok "channel list is tenant scoped" '! echo "$J" | grep -q "$CHX"'
curl -s -o "$W/one.xml" -H "$A" "$B/api/epg/xmltv?channelId=$CH2"
ok "channelId narrows the export" 'grep -q "Late Jazz" "$W/one.xml" && ! grep -q "Morning" "$W/one.xml"'

# ---- partner feeds -----------------------------------------------------------------
C=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/epg/xmltv/feeds" -H "$A" -H 'content-type:application/json' -d "{\"name\":\"Steal\",\"channelIds\":[\"$CHX\"]}")
ok "a feed cannot be scoped to another tenant's channel ($C)" '[ "$C" = 400 ]'
F=$(curl -s -X POST "$B/api/epg/xmltv/feeds" -H "$A" -H 'content-type:application/json' -d '{"name":"PVR partner","futureDays":3}')
FID=$(echo "$F" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
FURL=$(echo "$F" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
ok "feed created with a one-time URL" 'echo "$FURL" | grep -q "^$B/xmltv/xf_.*\.xml$"'
LIST=$(curl -s -H "$A" "$B/api/epg/xmltv/feeds")
ok "the raw token is never listed again" '! echo "$LIST" | grep -q "${FURL##*/xmltv/}" && ! echo "$LIST" | grep -q "token_hash"'
curl -s -D "$W/hf" -o "$W/f.xml" "$FURL"
ok "feed polls without any auth header, valid XMLTV" 'grep -q "^HTTP/1.1 200" "$W/hf" && valid "$W/f.xml"'
ok "feed is cacheable for 5 minutes, privately" 'grep -qi "^cache-control: private, max-age=300" "$W/hf"'
ok "feed names itself in the document" 'grep -q "feed: PVR partner" "$W/f.xml"'
curl -s -D "$W/hfg" -o "$W/f.gz" "$FURL.gz"
ok ".xml.gz is a gzip file" 'grep -qi "^content-type: application/gzip" "$W/hfg" && gunzip -c "$W/f.gz" > "$W/fg.xml" && valid "$W/fg.xml"'
FET=$(grep -i '^etag:' "$W/hf" | sed 's/^[Ee][Tt][Aa][Gg]: *//' | tr -d '\r')
C=$(curl -s -o /dev/null -w '%{http_code}' -H "if-none-match: $FET" "$FURL")
ok "feed 304 when unchanged ($C)" '[ "$C" = 304 ]'
sleep 0.3
PC=$(psql "$DATABASE_URL" -tA -c "SELECT poll_count FROM epg_feeds WHERE id='$FID'")
ok "polls are metered ($PC)" '[ "$PC" -ge 3 ]'
curl -s -o /dev/null -X PATCH "$B/api/epg/xmltv/feeds/$FID" -H "$A" -H 'content-type:application/json' -d "{\"channelIds\":[\"$CH2\"]}"
curl -s -o "$W/f2.xml" "$FURL"
ok "rescoped feed carries only its channel" 'grep -q "Late Jazz" "$W/f2.xml" && ! grep -q "Morning" "$W/f2.xml"'
curl -s -o /dev/null -X PATCH "$B/api/epg/xmltv/feeds/$FID" -H "$A" -H 'content-type:application/json' -d '{"enabled":false}'
C=$(curl -s -o /dev/null -w '%{http_code}' "$FURL")
ok "disabled feed is 404 ($C)" '[ "$C" = 404 ]'
curl -s -o /dev/null -X PATCH "$B/api/epg/xmltv/feeds/$FID" -H "$A" -H 'content-type:application/json' -d '{"enabled":true}'
ROT=$(curl -s -X POST "$B/api/epg/xmltv/feeds/$FID/rotate" -H "$A")
NURL=$(echo "$ROT" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
C1=$(curl -s -o /dev/null -w '%{http_code}' "$FURL"); C2=$(curl -s -o /dev/null -w '%{http_code}' "$NURL")
ok "rotate kills the old URL ($C1) and the new one works ($C2)" '[ "$C1" = 404 ] && [ "$C2" = 200 ]'
C=$(curl -s -o /dev/null -w '%{http_code}' "$B/xmltv/xf_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.xml")
ok "unknown token is a plain 404 ($C)" '[ "$C" = 404 ]'
psql "$DATABASE_URL" -q -c "UPDATE accounts SET status='suspended' WHERE id='$ACC'" 2>/dev/null
C=$(curl -s -o /dev/null -w '%{http_code}' "$NURL")
psql "$DATABASE_URL" -q -c "UPDATE accounts SET status='active' WHERE id='$ACC'" 2>/dev/null
ok "a suspended account's feeds stop ($C)" '[ "$C" = 404 ]'
C=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$B/api/epg/xmltv/feeds/$FID" -H "$A")
C2=$(curl -s -o /dev/null -w '%{http_code}' "$NURL")
ok "revoke ($C) and the URL is gone ($C2)" '[ "$C" = 204 ] && [ "$C2" = 404 ]'

# ---- scale smoke: 20 channels x 7 days x 48 slots -----------------------------------
psql "$DATABASE_URL" -q <<SQL
INSERT INTO channels(id,group_id,name,status,tz)
  SELECT ('0000000f-0000-0000-0000-0000000'||lpad(g::text,5,'0'))::uuid,'0000000d-0000-0000-0000-0000000000c7','Bulk '||g,'ended','Asia/Manila'
  FROM generate_series(1,20) g ON CONFLICT (id) DO NOTHING;
INSERT INTO programmes(channel_id,title,starts_at,ends_at,metadata)
  SELECT ('0000000f-0000-0000-0000-0000000'||lpad(c::text,5,'0'))::uuid, 'Slot '||s,
         date_trunc('hour',now()) + (s*30||' minutes')::interval, date_trunc('hour',now()) + ((s+1)*30||' minutes')::interval,
         '{"description":"Bulk slot","genre":"Entertainment"}'
  FROM generate_series(1,20) c, generate_series(0,335) s;
SQL
T0=$(python3 -c "import time; print(time.time())")
curl -s -o "$W/big.xml" -H "$A" -H 'accept-encoding: identity' "$B/api/epg/xmltv?futureDays=7&pastDays=0"
T1=$(python3 -c "import time; print(time.time())")
MS=$(python3 -c "print(int(($T1-$T0)*1000))")
NP=$(grep -c "<programme " "$W/big.xml")
SZ=$(wc -c < "$W/big.xml")
ok "6,700+ programmes exported in ${MS}ms (${NP} programmes, ${SZ} bytes)" '[ "$NP" -ge 6700 ] && [ "$MS" -lt 8000 ]'
ok "large document validates" 'valid "$W/big.xml"'

kill $API 2>/dev/null
echo; echo "xmltv.check: $pass passed, $fail failed"
[ "$fail" = 0 ]
