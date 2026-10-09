#!/usr/bin/env bash
# Social publishing through the HTTP API with a running worker: sandbox
# accounts, the composer's validation (422 with reasons), the job carrying a
# post to published with progress, the public sandbox post page, retry after a
# failure, take down, the OAuth callback refusing a forged state, admin-only
# linking, and tenant isolation. Run from volt-app/ with DATABASE_URL set.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8497}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*' PUBLIC_BASE_URL="http://localhost:$PORT" SOCIAL_SANDBOX_STEP_MS=20
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4
pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
B="http://localhost:$PORT"; J='content-type:application/json'
ACC=0000000a-0000-0000-0000-000000000601; OTH=0000000a-0000-0000-0000-000000000602
ASSET=0000000f-0000-0000-0000-000000000601
q(){ psql "$DATABASE_URL" -tA -c "$1"; }
jget(){ python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO accounts(id,name) VALUES ('$ACC','PostCo'),('$OTH','OtherPostCo') ON CONFLICT (id) DO NOTHING;
INSERT INTO users(id,account_id,email,password_hash,role,status,display_name) VALUES
  ('0000000b-0000-0000-0000-000000000601','$ACC','owner@postco.example','x','owner','active','Owner'),
  ('0000000b-0000-0000-0000-000000000602','$ACC','op@postco.example','x','operator','active','Operator'),
  ('0000000b-0000-0000-0000-000000000603','$OTH','owner@other.example','x','owner','active','Other') ON CONFLICT (id) DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('0000000c-0000-0000-0000-000000000601','$ACC','HD','[{"height":360,"bitrate_kbps":800}]','transcode') ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id) VALUES ('0000000d-0000-0000-0000-000000000601','$ACC','G','0000000c-0000-0000-0000-000000000601') ON CONFLICT (id) DO NOTHING;
INSERT INTO channels(id,group_id,name,status) VALUES ('0000000e-0000-0000-0000-000000000601','0000000d-0000-0000-0000-000000000601','Post Ch','ended') ON CONFLICT (id) DO NOTHING;
INSERT INTO vod_assets(id,channel_id,kind,title,master_key,start_epoch_ms,end_epoch_ms,duration_ms,metadata,thumb_status)
  VALUES ('$ASSET','0000000e-0000-0000-0000-000000000601','clip','Match highlights','/clips/x/hls/index.m3u8',0,2000,2000,'{"description":"Best bits","tags":["sport"]}','ready') ON CONFLICT (id) DO NOTHING;
SQL
npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE email IN ('owner@postco.example','op@postco.example','owner@other.example')\",[h]); await pool.end();})()" >/dev/null 2>&1
npx tsx src/index.ts >/tmp/social_api.log 2>&1 &
API=$!
for i in $(seq 1 60); do curl -sf "$B/health" >/dev/null && break; sleep 0.25; done
login(){ curl -s -X POST "$B/api/auth/login" -H "$J" -d "{\"email\":\"$1\",\"password\":\"volt1234\"}" | sed -n 's/.*"access":"\([^"]*\)".*/\1/p'; }
A="authorization: Bearer $(login owner@postco.example)"; OP="authorization: Bearer $(login op@postco.example)"; A2="authorization: Bearer $(login owner@other.example)"

P=$(curl -s "$B/api/social/platforms" -H "$A")
ok "platforms listed, none set up, callback on the public host" '[ "$(echo "$P" | jget "[p[\"configured\"] for p in d[\"platforms\"]]")" = "[False, False, False, False, False]" ] && echo "$P" | grep -q "localhost:$PORT/api/social/callback/youtube"'
C=$(curl -s -o /tmp/sa_body -w '%{http_code}' -X POST "$B/api/social/connect/youtube" -H "$A")
ok "connecting an unset platform is a 400 naming the settings ($C)" '[ "$C" = 400 ] && grep -q YOUTUBE_CLIENT_ID /tmp/sa_body'
C=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/social/sandbox/youtube" -H "$OP" -H "$J" -d '{}')
ok "an operator cannot link accounts ($C)" '[ "$C" = 403 ]'
YT=$(curl -s -X POST "$B/api/social/sandbox/youtube" -H "$A" -H "$J" -d '{"label":"Demo"}' | jget 'd["id"]')
XS=$(curl -s -X POST "$B/api/social/sandbox/x" -H "$A" -H "$J" -d '{"label":"demo news"}' | jget 'd["id"]')
ok "two sandbox accounts linked" '[ -n "$YT" ] && [ -n "$XS" ] && [ "$(curl -s "$B/api/social/accounts" -H "$A" | jget "len(d)")" = 2 ]'
ok "the X sandbox account reads as a handle" '[ "$(q "SELECT account_label FROM publish_targets WHERE id='"'"'$XS'"'"'")" = "@demo_news" ]'

D=$(curl -s "$B/api/social/publish/$ASSET/defaults" -H "$A")
ok "composer defaults come from the asset" '[ "$(echo "$D" | jget "d[\"youtube\"][\"title\"]+\"|\"+d[\"x\"][\"description\"]")" = "Match highlights|Match highlights

Best bits" ]'
LONG=$(python3 -c "print('a'*290)")
C=$(curl -s -o /tmp/sa_body -w '%{http_code}' -X POST "$B/api/social/publish/$ASSET" -H "$A" -H "$J" -d "{\"targets\":[{\"targetId\":\"$XS\",\"post\":{\"description\":\"$LONG\"}}]}")
ok "an over-long X caption is refused with the reason ($C)" '[ "$C" = 422 ] && grep -q "280" /tmp/sa_body'
C=$(curl -s -o /tmp/sa_body -w '%{http_code}' -X POST "$B/api/social/publish/$ASSET" -H "$A2" -H "$J" -d "{\"targets\":[{\"targetId\":\"$YT\",\"post\":{\"title\":\"x\"}}]}")
ok "another tenant cannot publish this asset ($C)" '[ "$C" = 404 ]'
R=$(curl -s -X POST "$B/api/social/publish/$ASSET" -H "$A" -H "$J" -d "{\"targets\":[{\"targetId\":\"$YT\",\"post\":{\"title\":\"Match highlights\",\"description\":\"Best bits\",\"tags\":[\"sport\"],\"privacy\":\"unlisted\"}},{\"targetId\":\"$XS\",\"post\":{\"description\":\"Best bits [fail]\"}}]}")
ok "publish accepted for two accounts" '[ "$(echo "$R" | jget "len(d[\"publications\"])")" = 2 ]'
for i in $(seq 1 40); do
  PEND=$(q "SELECT count(*) FROM publications WHERE vod_asset_id='$ASSET' AND status='pending'")
  [ "$PEND" = 0 ] && break; sleep 0.25
done
L=$(curl -s "$B/api/social/publications?assetId=$ASSET" -H "$A")
ok "the worker published YouTube with progress complete" '[ "$(echo "$L" | jget "[ (p[\"status\"],p[\"progress\"]) for p in d if p[\"platform\"]==\"youtube\"][0]")" = "('"'"'published'"'"', 100)" ]'
ok "the X post failed on purpose with the reason" '[ "$(echo "$L" | jget "[p[\"status\"] for p in d if p[\"platform\"]==\"x\"][0]")" = failed ] && echo "$L" | grep -q "on purpose"'
URL=$(echo "$L" | jget '[p["external_url"] for p in d if p["platform"]=="youtube"][0]')
PAGE=$(curl -s "$URL")
ok "the sandbox post page shows the post, marked as a sandbox" 'echo "$PAGE" | grep -q "Sandbox YouTube post" && echo "$PAGE" | grep -q "Match highlights" && echo "$PAGE" | grep -q "unlisted"'
XP=$(echo "$L" | jget '[p["id"] for p in d if p["platform"]=="x"][0]')
C=$(curl -s -o /tmp/sa_body -w '%{http_code}' -X POST "$B/api/social/publications/$XP/retry" -H "$A" -H "$J" -d '{"post":{"description":"Best bits, fixed"}}')
ok "retry with an edited post is accepted ($C)" '[ "$C" = 200 ]'
for i in $(seq 1 40); do [ "$(q "SELECT status FROM publications WHERE id='$XP'")" = published ] && break; sleep 0.25; done
ok "and publishes" '[ "$(q "SELECT status||'"'"'|'"'"'||(post->>'"'"'description'"'"') FROM publications WHERE id='"'"'$XP'"'"'")" = "published|Best bits, fixed" ]'
YP=$(echo "$L" | jget '[p["id"] for p in d if p["platform"]=="youtube"][0]')
curl -s -o /dev/null -X POST "$B/api/social/publications/$YP/remove" -H "$A"
ok "take down marks it removed" '[ "$(q "SELECT status FROM publications WHERE id='"'"'$YP'"'"'")" = removed ]'
S=$(curl -s -X POST "$B/api/social/sync-views" -H "$A" | jget 'd["synced"]')
ok "views sync runs ($S)" '[ "$S" -ge 1 ]'

LOC=$(curl -s -o /dev/null -w '%{redirect_url}' "$B/api/social/callback/youtube?state=forged&code=abc")
ok "a forged OAuth state is refused and the person is sent back to say so" 'echo "$LOC" | grep -q "/social?" && echo "$LOC" | grep -q "error="'
C=$(curl -s -o /dev/null -w '%{http_code}' "$B/social-sandbox/00000000-0000-0000-0000-000000000000")
ok "an unknown sandbox page is a 404 ($C)" '[ "$C" = 404 ]'
C=$(curl -s -o /dev/null -w '%{http_code}' "$B/api/social/accounts")
ok "the account list needs a sign-in ($C)" '[ "$C" = 401 ]'
ok "another tenant sees none of these accounts" '[ "$(curl -s "$B/api/social/accounts" -H "$A2" | jget "len(d)")" = 0 ]'

kill $API 2>/dev/null
echo; echo "social-api.check: $pass passed, $fail failed"
[ "$fail" = 0 ]
