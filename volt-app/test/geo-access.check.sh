#!/usr/bin/env bash
# ACCOUNT-WIDE GEO ACCESS and VIEW AS A VIEWER ELSEWHERE (docs/ACCOUNT_SETTINGS.md).
#   * an account administrator sets "everywhere except" or "only in" for the
#     whole account; operators cannot; an empty allow list is refused; audited;
#   * the play gate refuses a blocked country before any other rule, and says
#     which layer decided: the account, then the channel's own geo setting;
#   * the public live URL answers 451 there, a share link refuses with geo_blocked;
#   * GET /channels/:id/access-check gives the operator the same decision.
# Run from volt-app/ with DATABASE_URL set (migration 0053 applied).
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8531}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*' \
  PUBLIC_BASE_URL="http://localhost:$PORT" THUMBS_ENABLED=0 TRUST_EDGE_GEO=1
pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
B="http://localhost:$PORT/api"; J='content-type:application/json'
ACC=0000000a-0000-0000-0000-00000000c701; ADM=0000000b-0000-0000-0000-00000000c701; OPR=0000000b-0000-0000-0000-00000000c702
G=0000000d-0000-0000-0000-00000000c701; CH=0000000e-0000-0000-0000-00000000c701; P1=0000000c-0000-0000-0000-00000000c701
q(){ psql "$DATABASE_URL" -tA -c "$1"; }
jget(){ python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
DELETE FROM audit_log WHERE account_id='$ACC';
INSERT INTO accounts(id,name,max_channels) VALUES ('$ACC','GeoCo',10) ON CONFLICT (id) DO NOTHING;
UPDATE accounts SET geo_access=NULL WHERE id='$ACC';
INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES ('$ADM','$ACC','adm@geoco.example','x','admin','active'),('$OPR','$ACC','op@geoco.example','x','operator','active') ON CONFLICT (id) DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('$P1','$ACC','Pkg','[]','package_only') ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,is_default) VALUES ('$G','$ACC','Main','$P1',10,true) ON CONFLICT (id) DO NOTHING;
INSERT INTO channels(id,group_id,name,status,kind,geo_mode,geo_countries) VALUES ('$CH','$G','Geo TV','ended','tv','worldwide','{}') ON CONFLICT (id) DO NOTHING;
UPDATE channels SET geo_mode='worldwide', geo_countries='{}' WHERE id='$CH';
SQL
npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE id IN ('$ADM','$OPR')\",[h]); await pool.end();})()" >/dev/null 2>&1
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4
npx tsx src/index.ts >/tmp/geo_access_api.log 2>&1 & API=$!
trap 'kill $API 2>/dev/null' EXIT
for i in $(seq 1 80); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
login(){ curl -s -X POST "$B/auth/login" -H "$J" -d "{\"email\":\"$1\",\"password\":\"volt1234\"}" | sed -n 's/.*"access":"\([^"]*\)".*/\1/p'; }
A="authorization: Bearer $(login adm@geoco.example)"; O="authorization: Bearer $(login op@geoco.example)"
chk(){ curl -s "$B/channels/$CH/access-check?country=$1" -H "$A" | jget '(d["allowed"], d["layer"])'; }

ok "no restriction: a viewer in IL can watch" '[ "$(chk IL)" = "(True, '"'"'none'"'"')" ]'
ok "an operator cannot set the account rule (403)" '[ "$(code -X PATCH "$B/account-settings" -H "$O" -H "$J" -d "{\"geoAccess\":{\"mode\":\"block\",\"countries\":[\"IL\"]}}")" = 403 ]'
ok "an empty allow list is refused (422)" '[ "$(code -X PATCH "$B/account-settings" -H "$A" -H "$J" -d "{\"geoAccess\":{\"mode\":\"allow\",\"countries\":[]}}")" = 422 ]'
R=$(curl -s -X PATCH "$B/account-settings" -H "$A" -H "$J" -d '{"geoAccess":{"mode":"block","countries":["il","IL"]}}')
ok "an administrator blocks IL account-wide (normalised, once)" '[ "$(echo "$R" | jget "d[\"geoAccess\"]")" = "{'"'"'mode'"'"': '"'"'block'"'"', '"'"'countries'"'"': ['"'"'IL'"'"']}" ]'
ok "the change is audited" '[ "$(q "SELECT count(*) FROM audit_log WHERE account_id='"'"'$ACC'"'"' AND entity_type='"'"'account_geo_access'"'"'")" = 1 ]'
sleep 0.3
ok "access check: IL is blocked by the account layer" '[ "$(chk IL)" = "(False, '"'"'account'"'"')" ]'
ok "access check: AU can still watch" '[ "$(chk AU)" = "(True, '"'"'none'"'"')" ]'
ok "public live URL: 451 for a viewer in IL" '[ "$(code -H "CloudFront-Viewer-Country: IL" "http://localhost:$PORT/live/$CH/master.m3u8")" = 451 ]'
ok "public live URL: not geo-refused for AU (404: not on air)" '[ "$(code -H "CloudFront-Viewer-Country: AU" "http://localhost:$PORT/live/$CH/master.m3u8")" = 404 ]'
TOK=$(curl -s -X POST "$B/share-links" -H "$A" -H "$J" -d "{\"resourceKind\":\"channel\",\"resourceId\":\"$CH\",\"ttlSec\":3600}" | jget 'd["token"]')
ok "share link: refused in IL (geo_blocked)" '[ "$(curl -s -X POST "$B/share/$TOK/resolve?geo=IL" -H "$J" -d "{}" | jget "d.get(\"reason\")")" = geo_blocked ]'
ok "share link: opens in AU" '[ "$(curl -s -X POST "$B/share/$TOK/resolve?geo=AU" -H "$J" -d "{}" | jget "d.get(\"ok\")")" = True ]'
q "UPDATE channels SET geo_mode='block', geo_countries='{NZ}' WHERE id='$CH'" >/dev/null
sleep 0.3
ok "the channel's own geo is the next layer (NZ blocked by the channel)" '[ "$(chk NZ)" = "(False, '"'"'channel'"'"')" ]'
ok "the account layer still decides first for IL" '[ "$(chk IL)" = "(False, '"'"'account'"'"')" ]'
ok "access check needs a two-letter country (400)" '[ "$(code "$B/channels/$CH/access-check?country=Israel" -H "$A")" = 400 ]'
R=$(curl -s -X PATCH "$B/account-settings" -H "$A" -H "$J" -d '{"geoAccess":null}')
ok "null removes the account rule" '[ "$(echo "$R" | jget "d[\"geoAccess\"]")" = None ]'

echo; echo "geo-access: $pass passed, $fail failed"
[ "$fail" = 0 ]
