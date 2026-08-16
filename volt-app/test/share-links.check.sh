#!/usr/bin/env bash
# Share links end-to-end: admin creates a link, public resolves it (isolated to one
# resource), PIN gate, revoke, expiry, cross-account isolation, standalone page.
# Boots the API on a fresh DB. Run from volt-app/ with DATABASE_URL set.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8477}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*'
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4

pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }

# --- seed two tenants + a VOD asset in tenant A ---
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO accounts(id,name) VALUES ('0000000a-0000-0000-0000-000000000001'::uuid,'ShareCo'),('0000000a-0000-0000-0000-000000000002'::uuid,'OtherCo');
INSERT INTO users(id,account_id,email,password_hash,role,status,display_name)
  VALUES ('0000000b-0000-0000-0000-000000000001'::uuid,'0000000a-0000-0000-0000-000000000001'::uuid,'jordan@shareco.example','x','owner','active','Jordan Vale'),
         ('0000000b-0000-0000-0000-000000000002'::uuid,'0000000a-0000-0000-0000-000000000002'::uuid,'other@otherco.example','x','owner','active','Other Admin');
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('0000000c-0000-0000-0000-000000000001'::uuid,'0000000a-0000-0000-0000-000000000001'::uuid,'HD','[]','package_only');
INSERT INTO groups(id,account_id,name,output_profile_id) VALUES ('0000000d-0000-0000-0000-000000000001'::uuid,'0000000a-0000-0000-0000-000000000001'::uuid,'G','0000000c-0000-0000-0000-000000000001'::uuid);
INSERT INTO channels(id,group_id,name,status) VALUES ('0000000e-0000-0000-0000-000000000001'::uuid,'0000000d-0000-0000-0000-000000000001'::uuid,'Channel 6','live');
INSERT INTO vod_assets(id,channel_id,kind,title,master_key,start_epoch_ms,end_epoch_ms,duration_ms,output_kind,formats,metadata,thumb_status,published)
  VALUES ('0000000f-0000-0000-0000-000000000001'::uuid,'0000000e-0000-0000-0000-000000000001'::uuid,'clip','Metro Special — Press Pack','channel/x/clip-0-1454000',0,1454000,1454000,'both','{"hls":true,"dash":true}','{"category":"News","date":"28 Aug 2024","format":"MXF · 1080i50","reference":"INRAOUHJQEK","description":"Opens on a metro station."}','ready',true);
SQL

# password for the seeded owner: set a real argon2 hash via the app's hasher
npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE email IN ('jordan@shareco.example','other@otherco.example')\",[h]); await pool.end();})()" >/dev/null 2>&1

# --- boot API ---
npx tsx src/index.ts >/tmp/share_api.log 2>&1 &
API=$!
for i in $(seq 1 40); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 0.25; done

TOKA=$(curl -s -X POST "http://localhost:$PORT/api/auth/login" -H 'content-type:application/json' -d '{"email":"jordan@shareco.example","password":"volt1234"}' | sed -n 's/.*"access":"\([^"]*\)".*/\1/p')
TOKB=$(curl -s -X POST "http://localhost:$PORT/api/auth/login" -H 'content-type:application/json' -d '{"email":"other@otherco.example","password":"volt1234"}' | sed -n 's/.*"access":"\([^"]*\)".*/\1/p')
ok "admin A logged in" '[ -n "$TOKA" ]'

# --- create a share link (allow_download + metadata + notify) ---
CREATE=$(curl -s -X POST "http://localhost:$PORT/api/share-links" -H "authorization: Bearer $TOKA" -H 'content-type:application/json' \
  -d '{"resourceKind":"vod","resourceId":"0000000f-0000-0000-0000-000000000001","accessPeriod":"7 days","message":"Here is the Metro Special press pack.","recipients":["press@partner.example"],"accessType":"allow_download","allowHiRes":true,"allowMetadata":true,"notifyOnOpen":true}')
echo "$CREATE" > /tmp/share_create.json
URL=$(echo "$CREATE" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
RAW=$(echo "$CREATE" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
ok "create returns a one-time url + token" '[ -n "$URL" ] && [ -n "$RAW" ]'
ok "url points at /share/<token>" 'echo "$URL" | grep -q "/share/shr_"'

# --- public resolve (no auth) returns ONLY this asset ---
R=$(curl -s -X POST "http://localhost:$PORT/api/share/$RAW/resolve" -H 'content-type:application/json' -d '{}')
echo "$R" > /tmp/share_resolve.json
ok "resolve ok" 'echo "$R" | grep -q "\"ok\":true"'
ok "resolve carries the title" 'echo "$R" | grep -q "Metro Special"'
ok "resolve carries a playback token" 'echo "$R" | grep -q "playbackToken"'
ok "resolve exposes brand + sharedBy" 'echo "$R" | grep -q "Jordan Vale" && echo "$R" | grep -q "ShareCo"'
ok "resolve shows allowed downloads" 'echo "$R" | grep -q "\"hiRes\":true" && echo "$R" | grep -q "\"metadata\":true"'
ok "resolve says no sign-in required" 'echo "$R" | grep -q "\"signInRequired\":false"'

# --- the standalone page loads and is isolated (no console/nav links) ---
PAGE=$(curl -s "http://localhost:$PORT/share/$RAW")
ok "share page is HTML" 'echo "$PAGE" | grep -qi "<!doctype html>"'
ok "share page has no link to the admin console" '! echo "$PAGE" | grep -q "/console"'
ok "share page marked noindex" 'echo "$PAGE" | grep -q "noindex"'

# --- metadata download allowed; hi_res allowed; player NOT allowed ---
MD=$(curl -s -o /tmp/md.json -w "%{http_code}" "http://localhost:$PORT/api/share/$RAW/download/metadata")
ok "metadata download allowed (200)" '[ "$MD" = "200" ]'
HR=$(curl -s -w "%{http_code}" "http://localhost:$PORT/api/share/$RAW/download/hi_res" -o /tmp/hr.json)
ok "hi-res download allowed (200)" '[ "$HR" = "200" ]'

# --- cross-tenant: admin B cannot create a link for A's asset ---
XC=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:$PORT/api/share-links" -H "authorization: Bearer $TOKB" -H 'content-type:application/json' \
  -d '{"resourceKind":"vod","resourceId":"0000000f-0000-0000-0000-000000000001","accessPeriod":"7 days"}')
ok "cross-tenant create is 404 (cannot share another account's asset)" '[ "$XC" = "404" ]'
ok "admin B list does not see A's link" '[ "$(curl -s "http://localhost:$PORT/api/share-links" -H "authorization: Bearer $TOKB")" = "[]" ]'

# --- PIN-protected link requires the PIN ---
CP=$(curl -s -X POST "http://localhost:$PORT/api/share-links" -H "authorization: Bearer $TOKA" -H 'content-type:application/json' \
  -d '{"resourceKind":"vod","resourceId":"0000000f-0000-0000-0000-000000000001","accessPeriod":"1 day","pin":"2468"}')
PRAW=$(echo "$CP" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
P1=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:$PORT/api/share/$PRAW/resolve" -H 'content-type:application/json' -d '{}')
ok "PIN link without pin is 401" '[ "$P1" = "401" ]'
P2=$(curl -s -X POST "http://localhost:$PORT/api/share/$PRAW/resolve" -H 'content-type:application/json' -d '{"pin":"2468"}')
ok "PIN link with correct pin resolves" 'echo "$P2" | grep -q "\"ok\":true"'

# --- revoke kills it ---
LID=$(curl -s "http://localhost:$PORT/api/share-links" -H "authorization: Bearer $TOKA" | sed -n 's/.*"id":"\([0-9a-f-]*\)".*/\1/p' | head -1)
curl -s -X POST "http://localhost:$PORT/api/share-links/$LID/revoke" -H "authorization: Bearer $TOKA" >/dev/null
# revoke the FIRST link (the download one) — find its id by resolving is gone; revoke all then re-check the main link
curl -s "http://localhost:$PORT/api/share-links" -H "authorization: Bearer $TOKA" | grep -o '"id":"[0-9a-f-]*"' | sed 's/"id":"//;s/"//' | while read id; do curl -s -X POST "http://localhost:$PORT/api/share-links/$id/revoke" -H "authorization: Bearer $TOKA" >/dev/null; done
RV=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:$PORT/api/share/$RAW/resolve" -H 'content-type:application/json' -d '{}')
ok "revoked link resolve is 410" '[ "$RV" = "410" ]'

# --- expired link: force expiry in the DB and confirm 410 ---
CE=$(curl -s -X POST "http://localhost:$PORT/api/share-links" -H "authorization: Bearer $TOKA" -H 'content-type:application/json' \
  -d '{"resourceKind":"vod","resourceId":"0000000f-0000-0000-0000-000000000001","accessPeriod":"1 day"}')
ERAW=$(echo "$CE" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
EHASH=$(npx tsx -e "import {sha256} from './src/services/shareLinks'; process.stdout.write(sha256('$ERAW'))" 2>/dev/null)
psql "$DATABASE_URL" -q -c "UPDATE share_links SET expires_at=now()-interval '1 hour' WHERE token_hash='$EHASH'"
EX=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:$PORT/api/share/$ERAW/resolve" -H 'content-type:application/json' -d '{}')
ok "expired link resolve is 410" '[ "$EX" = "410" ]'

# ===========================================================================
# Sharing a LIVE CHANNEL + editing a link in place (recipients, custom expiry,
# PATCH, rotate). The channel share is a separate workflow from on air: it must
# work without the channel being published.
# ===========================================================================
FUTURE=$(node -e "console.log(new Date(Date.now()+3*86400000).toISOString())")
CH=$(curl -s -X POST "http://localhost:$PORT/api/share-links" -H "authorization: Bearer $TOKA" -H 'content-type:application/json' \
  -d "{\"resourceKind\":\"channel\",\"resourceId\":\"0000000e-0000-0000-0000-000000000001\",\"expiresAt\":\"$FUTURE\",\"label\":\"Client approval\",\"recipients\":[\"client@partner.example\"],\"sendEmail\":true,\"maxViews\":2,\"notifyOnOpen\":true}")
CHRAW=$(echo "$CH" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
CHID=$(echo "$CH" | sed -n 's/.*"id":"\([0-9a-f-]*\)".*/\1/p')
ok "channel share link created" '[ -n "$CHRAW" ]'
ok "custom expiresAt is honoured (not the 7-day default)" 'echo "$CH" | grep -q "$(echo $FUTURE | cut -c1-10)"'
ok "sendEmail reports the deliveries it made" 'echo "$CH" | grep -q "\"sent\":1"'
CHR=$(curl -s -X POST "http://localhost:$PORT/api/share/$CHRAW/resolve" -H 'content-type:application/json' -d '{}')
ok "channel share resolves without the channel being on air" 'echo "$CHR" | grep -q "\"ok\":true"'
ok "channel share is flagged live" 'echo "$CHR" | grep -q "\"live\":true"'
ok "channel share reports whether output is available right now" 'echo "$CHR" | grep -q "\"available\":"'

# --- list: scoped to a resource, exposes has_pin, never the hash ---
LIST=$(curl -s "http://localhost:$PORT/api/share-links?resourceKind=channel&resourceId=0000000e-0000-0000-0000-000000000001" -H "authorization: Bearer $TOKA")
ok "list can be scoped to one resource" '[ "$(echo "$LIST" | grep -o "\"resource_kind\":\"vod\"" | wc -l)" = "0" ]'
ok "list says whether a PIN is set, without leaking it" 'echo "$LIST" | grep -q "\"has_pin\":false" && ! echo "$LIST" | grep -q "pin_hash"'
ok "list carries the recipients it was sent to" 'echo "$LIST" | grep -q "client@partner.example"'

# --- PATCH: extend, cap, PIN on, then PIN off ---
PA=$(curl -s -X PATCH "http://localhost:$PORT/api/share-links/$CHID" -H "authorization: Bearer $TOKA" -H 'content-type:application/json' \
  -d '{"extendSec":604800,"maxViews":10,"pin":"7391","label":"Client approval v2"}')
NEWEXP=$(echo "$PA" | sed -n 's/.*"expires_at":"\([^"]*\)".*/\1/p')
ok "PATCH extends the expiry past the custom date it was created with" 'node -e "process.exit(new Date(process.argv[1])>new Date(process.argv[2])?0:1)" "$NEWEXP" "$FUTURE"'
ok "PATCH raises the view cap" 'echo "$PA" | grep -q "\"max_views\":10"'
ok "PATCH sets a PIN (reported as has_pin, never the value)" 'echo "$PA" | grep -q "\"has_pin\":true" && ! echo "$PA" | grep -q "7391"'
PN=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:$PORT/api/share/$CHRAW/resolve" -H 'content-type:application/json' -d '{}')
ok "the new PIN is enforced on the SAME url (401)" '[ "$PN" = "401" ]'
curl -s -X PATCH "http://localhost:$PORT/api/share-links/$CHID" -H "authorization: Bearer $TOKA" -H 'content-type:application/json' -d '{"pin":null}' >/dev/null
PC=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:$PORT/api/share/$CHRAW/resolve" -H 'content-type:application/json' -d '{}')
ok "clearing the PIN opens the same url again (200)" '[ "$PC" = "200" ]'
ok "a 2-character PIN is rejected" '[ "$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "http://localhost:$PORT/api/share-links/$CHID" -H "authorization: Bearer $TOKA" -H "content-type:application/json" -d "{\"pin\":\"12\"}")" = "400" ]'

# --- rotate: a new URL works, the old one is dead ---
ROT=$(curl -s -X POST "http://localhost:$PORT/api/share-links/$CHID/rotate" -H "authorization: Bearer $TOKA" -H 'content-type:application/json' -d '{"sendEmail":true}')
NEWRAW=$(echo "$ROT" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
ok "rotate issues a different token" '[ -n "$NEWRAW" ] && [ "$NEWRAW" != "$CHRAW" ]'
ok "rotate re-sends to the stored recipients" 'echo "$ROT" | grep -q "\"sent\":1"'
ok "the rotated url resolves" '[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:$PORT/api/share/$NEWRAW/resolve" -H "content-type:application/json" -d "{}")" = "200" ]'
ok "the old url is dead after rotate (404)" '[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:$PORT/api/share/$CHRAW/resolve" -H "content-type:application/json" -d "{}")" = "404" ]'

# --- cross-tenant PATCH / rotate are 404 ---
ok "admin B cannot PATCH A's link" '[ "$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "http://localhost:$PORT/api/share-links/$CHID" -H "authorization: Bearer $TOKB" -H "content-type:application/json" -d "{\"label\":\"x\"}")" = "404" ]'
ok "admin B cannot rotate A's link" '[ "$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:$PORT/api/share-links/$CHID/rotate" -H "authorization: Bearer $TOKB" -H "content-type:application/json" -d "{}")" = "404" ]'

# --- email deliveries actually landed in the notification store ---
DLV=$(psql "$DATABASE_URL" -tA -c "SELECT count(*) FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.topic='share_link'")
ok "share invites are recorded as notification deliveries" '[ "$DLV" -ge 2 ]'

kill $API 2>/dev/null
echo ""
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" = "0" ]
