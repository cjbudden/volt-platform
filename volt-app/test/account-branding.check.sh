#!/usr/bin/env bash
# ACCOUNT BRANDING (docs/ACCOUNT_SETTINGS.md): a logo and two colours per
# account, set in Admin > Account settings and used by the share page.
#   * anyone signed in reads it; only account administrators and owners change it;
#   * colours are #RRGGBB only, the logo an image-library path or http(s) address;
#   * the share page view carries the brand, and so does its PIN screen, but a
#     link that does not exist reveals nothing;
#   * every change is in the audit log; null goes back to the default.
# Run from volt-app/ with DATABASE_URL set (migration 0052 applied).
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8529}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*' \
  PUBLIC_BASE_URL="http://localhost:$PORT" THUMBS_ENABLED=0
pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
B="http://localhost:$PORT/api"; J='content-type:application/json'
ACC=0000000a-0000-0000-0000-00000000b001; ADM=0000000b-0000-0000-0000-00000000b001; OPR=0000000b-0000-0000-0000-00000000b002
G=0000000d-0000-0000-0000-00000000b001; CH=0000000e-0000-0000-0000-00000000b001; P1=0000000c-0000-0000-0000-00000000b001
q(){ psql "$DATABASE_URL" -tA -c "$1"; }
jget(){ python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
DELETE FROM audit_log WHERE account_id='$ACC';
INSERT INTO accounts(id,name,max_channels) VALUES ('$ACC','BrandCo',10) ON CONFLICT (id) DO NOTHING;
UPDATE accounts SET brand_logo_ref=NULL, brand_primary=NULL, brand_secondary=NULL WHERE id='$ACC';
INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES ('$ADM','$ACC','adm@brandco.example','x','admin','active'),('$OPR','$ACC','op@brandco.example','x','operator','active') ON CONFLICT (id) DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('$P1','$ACC','Pkg','[]','package_only') ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,is_default) VALUES ('$G','$ACC','Main','$P1',10,true) ON CONFLICT (id) DO NOTHING;
INSERT INTO channels(id,group_id,name,status,kind) VALUES ('$CH','$G','Brand TV','ended','tv') ON CONFLICT (id) DO NOTHING;
SQL
npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE id IN ('$ADM','$OPR')\",[h]); await pool.end();})()" >/dev/null 2>&1
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4
npx tsx src/index.ts >/tmp/account_branding_api.log 2>&1 & API=$!
trap 'kill $API 2>/dev/null' EXIT
for i in $(seq 1 80); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
login(){ curl -s -X POST "$B/auth/login" -H "$J" -d "{\"email\":\"$1\",\"password\":\"volt1234\"}" | sed -n 's/.*"access":"\([^"]*\)".*/\1/p'; }
A="authorization: Bearer $(login adm@brandco.example)"; O="authorization: Bearer $(login op@brandco.example)"

R=$(curl -s "$B/account-settings" -H "$O")
ok "anyone signed in reads it: the defaults, and an operator cannot edit" '[ "$(echo "$R" | jget "(d[\"primary\"], d[\"logo\"], d[\"canEdit\"])")" = "('"'"'#2563eb'"'"', None, False)" ]'
ok "an operator cannot change it (403)" '[ "$(code -X PATCH "$B/account-settings" -H "$O" -H "$J" -d "{\"primary\":\"#000000\"}")" = 403 ]'
ok "a colour that is not #RRGGBB is refused (422)" '[ "$(code -X PATCH "$B/account-settings" -H "$A" -H "$J" -d "{\"primary\":\"red\"}")" = 422 ]'
ok "a CSS injection in a colour is refused (422)" '[ "$(code -X PATCH "$B/account-settings" -H "$A" -H "$J" -d "{\"secondary\":\"#fff;}body{display:none\"}")" = 422 ]'
ok "a javascript: logo is refused (422)" '[ "$(code -X PATCH "$B/account-settings" -H "$A" -H "$J" -d "{\"logo\":\"javascript:alert(1)\"}")" = 422 ]'
R=$(curl -s -X PATCH "$B/account-settings" -H "$A" -H "$J" -d '{"logo":"/library/brandco/logo.png","primary":"#C8102E","secondary":"#1f2937"}')
ok "an administrator sets the logo and colours (stored lower case)" '[ "$(echo "$R" | jget "(d[\"logo\"], d[\"primary\"], d[\"secondary\"])")" = "('"'"'/library/brandco/logo.png'"'"', '"'"'#c8102e'"'"', '"'"'#1f2937'"'"')" ]'
ok "the change is in the audit log" '[ "$(q "SELECT count(*) FROM audit_log WHERE account_id='"'"'$ACC'"'"' AND entity_type='"'"'account_branding'"'"'")" = 1 ]'

T1=$(curl -s -X POST "$B/share-links" -H "$A" -H "$J" -d "{\"resourceKind\":\"channel\",\"resourceId\":\"$CH\",\"ttlSec\":3600}" | jget 'd["token"]')
V=$(curl -s -X POST "$B/share/$T1/resolve" -H "$J" -d '{}')
ok "the share page view carries the brand" '[ "$(echo "$V" | jget "(d[\"brand\"][\"account\"], d[\"brand\"][\"logo\"], d[\"brand\"][\"primary\"], d[\"brand\"][\"secondary\"])")" = "('"'"'BrandCo'"'"', '"'"'/library/brandco/logo.png'"'"', '"'"'#c8102e'"'"', '"'"'#1f2937'"'"')" ]'
T2=$(curl -s -X POST "$B/share-links" -H "$A" -H "$J" -d "{\"resourceKind\":\"channel\",\"resourceId\":\"$CH\",\"ttlSec\":3600,\"authMode\":\"pin\",\"pin\":\"4321\"}" | jget 'd["token"]')
V=$(curl -s -X POST "$B/share/$T2/resolve" -H "$J" -d '{}')
ok "the PIN screen is branded too (401 with the brand)" '[ "$(echo "$V" | jget "(d[\"reason\"], d[\"brand\"][\"primary\"])")" = "('"'"'pin_required'"'"', '"'"'#c8102e'"'"')" ]'
V=$(curl -s -X POST "$B/share/shr_doesnotexist000000000000000000/resolve" -H "$J" -d '{}')
ok "a link that does not exist reveals no brand" '[ "$(echo "$V" | jget "\"brand\" in d")" = False ]'
ok "the share page HTML applies the brand" '[ "$(curl -s "http://localhost:$PORT/share/$T1" | grep -c "applyBrand(d.brand)")" = 1 ]'

R=$(curl -s -X PATCH "$B/account-settings" -H "$A" -H "$J" -d '{"logo":null,"primary":null,"secondary":null}')
ok "null puts the defaults back" '[ "$(echo "$R" | jget "(d[\"logo\"], d[\"primary\"], d[\"custom\"][\"primary\"])")" = "(None, '"'"'#2563eb'"'"', False)" ]'

echo; echo "account-branding: $pass passed, $fail failed"
[ "$fail" = 0 ]
