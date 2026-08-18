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

# ==== NEW: view-count expiry (expire after 1 view) ====
CV=$(curl -s -X POST "http://localhost:$PORT/api/share-links" -H "authorization: Bearer $TOKA" -H 'content-type:application/json' \
  -d '{"resourceKind":"vod","resourceId":"0000000f-0000-0000-0000-000000000001","accessPeriod":"7 days","maxViews":1}')
VRAW=$(echo "$CV" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
V1=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:$PORT/api/share/$VRAW/resolve" -H 'content-type:application/json' -d '{}')
V2=$(curl -s -X POST "http://localhost:$PORT/api/share/$VRAW/resolve" -H 'content-type:application/json' -d '{}')
ok "1-view link: first open is 200" '[ "$V1" = "200" ]'
ok "1-view link: second open is view_cap" 'echo "$V2" | grep -q view_cap'

# ==== NEW: send-by-email (system emails the link + message + instructions) ====
SE=$(curl -s -X POST "http://localhost:$PORT/api/share-links" -H "authorization: Bearer $TOKA" -H 'content-type:application/json' \
  -d '{"resourceKind":"vod","resourceId":"0000000f-0000-0000-0000-000000000001","accessPeriod":"7 days","sendEmail":true,"recipients":["press@partner.example"],"message":"Please review."}')
ok "sendEmail returns emailed:1" 'echo "$SE" | grep -q "\"emailed\":1"'
INVITE=$(psql "$DATABASE_URL" -tA -c "SELECT body FROM notifications WHERE topic='share.invite' ORDER BY created_at DESC LIMIT 1")
ok "invite email carries the link" 'echo "$INVITE" | grep -q "/share/shr_"'
ok "invite email carries the message" 'echo "$INVITE" | grep -q "Please review."'
SE2=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:$PORT/api/share-links" -H "authorization: Bearer $TOKA" -H 'content-type:application/json' \
  -d '{"resourceKind":"vod","resourceId":"0000000f-0000-0000-0000-000000000001","accessPeriod":"7 days","sendEmail":true}')
ok "sendEmail without recipients is 400" '[ "$SE2" = "400" ]'

# ==== NEW: email-PIN verification (second factor) ====
EP=$(curl -s -X POST "http://localhost:$PORT/api/share-links" -H "authorization: Bearer $TOKA" -H 'content-type:application/json' \
  -d '{"resourceKind":"vod","resourceId":"0000000f-0000-0000-0000-000000000001","accessPeriod":"7 days","authMode":"email_pin","recipients":["viewer@partner.example"]}')
EPRAW=$(echo "$EP" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
ok "email_pin link created" '[ -n "$EPRAW" ]'
E1=$(curl -s -X POST "http://localhost:$PORT/api/share/$EPRAW/resolve" -H 'content-type:application/json' -d '{}')
ok "email_pin without creds is code_required" 'echo "$E1" | grep -q code_required'
# wrong email: response is GENERIC and no code is armed
curl -s -X POST "http://localhost:$PORT/api/share/$EPRAW/request-code" -H 'content-type:application/json' -d '{"email":"attacker@evil.example"}' >/dev/null
ARMED=$(psql "$DATABASE_URL" -tA -c "SELECT count(*) FROM share_links WHERE auth_mode='email_pin' AND verify_code_hash IS NOT NULL")
ok "request-code with a non-recipient arms nothing" '[ "$ARMED" = "0" ]'
# right email: a code is emailed; fish it out of the recorded notification
curl -s -X POST "http://localhost:$PORT/api/share/$EPRAW/request-code" -H 'content-type:application/json' -d '{"email":"viewer@partner.example"}' >/dev/null
CODE=$(psql "$DATABASE_URL" -tA -c "SELECT body FROM notifications WHERE topic='share.verify' ORDER BY created_at DESC LIMIT 1" | grep -o '[0-9]\{6\}' | head -1)
ok "verification code emailed (6 digits)" '[ -n "$CODE" ]'
E2=$(curl -s -X POST "http://localhost:$PORT/api/share/$EPRAW/resolve" -H 'content-type:application/json' -d "{\"email\":\"viewer@partner.example\",\"code\":\"999999\"}")
ok "wrong code is code_wrong" 'echo "$E2" | grep -q code_wrong'
E3=$(curl -s -X POST "http://localhost:$PORT/api/share/$EPRAW/resolve" -H 'content-type:application/json' -d "{\"email\":\"viewer@partner.example\",\"code\":\"$CODE\"}")
ok "correct email+code resolves the preview" 'echo "$E3" | grep -q "\"ok\":true"'
# expired code path
psql "$DATABASE_URL" -q -c "UPDATE share_links SET verify_expires_at=now()-interval '1 minute' WHERE auth_mode='email_pin'"
E4=$(curl -s -X POST "http://localhost:$PORT/api/share/$EPRAW/resolve" -H 'content-type:application/json' -d "{\"email\":\"viewer@partner.example\",\"code\":\"$CODE\"}")
ok "expired code is code_expired" 'echo "$E4" | grep -q code_expired'
# share page carries the email/code flow
EPAGE=$(curl -s "http://localhost:$PORT/share/$EPRAW")
ok "share page includes the email verification flow" 'echo "$EPAGE" | grep -q "request-code"'

kill $API 2>/dev/null
echo ""
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" = "0" ]
