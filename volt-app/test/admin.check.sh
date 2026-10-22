#!/usr/bin/env bash
# Admin section end-to-end:
#   - /auth/me shape (role, features map, access model)
#   - user management: create/patch, role guards (owner-only actions, rank cap,
#     last-active-owner), disable blocks login
#   - user groups: per-feature none/view/manage enforced centrally, patch takes
#     effect immediately (cache invalidation), viewer capped at view
#   - apps & API keys: secret key = admin bearer, publishable rejected on the
#     admin surface, revoke kills the key
#   - platform (system admin): create client account + primary owner (login
#     works), non-platform 403, suspend blocks login AND the account's keys
# Run from volt-app/ with DATABASE_URL set.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8487}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*'
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4

pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
# J <json> <dot.path> -> value ('' if missing)
J(){ python3 -c "
import json,sys
try:
  d=json.loads(sys.argv[1])
  for k in sys.argv[2].split('.'):
    d=d[int(k)] if isinstance(d,list) else d.get(k)
    if d is None: break
  print('' if d is None else d)
except Exception: print('')
" "$1" "$2"; }

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
-- instances rows block channel deletion (FK SET NULL vs owner CHECK): clear them first
DELETE FROM instances WHERE channel_id IN (
  SELECT c.id FROM channels c JOIN groups g ON g.id=c.group_id
   JOIN accounts a ON a.id=g.account_id WHERE a.name IN ('AdminCo','NewClient Co'));
DELETE FROM accounts WHERE name IN ('AdminCo','NewClient Co');
DELETE FROM users WHERE email LIKE '%@adminco.example' OR email='newowner@client.example';
INSERT INTO accounts(id,name) VALUES ('0000000a-0000-0000-0000-0000000000b1'::uuid,'AdminCo');
INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES
  ('0000000b-0000-0000-0000-0000000000b1'::uuid,'0000000a-0000-0000-0000-0000000000b1'::uuid,'root@adminco.example','x','owner','active');
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES
  ('0000000c-0000-0000-0000-0000000000b1'::uuid,'0000000a-0000-0000-0000-0000000000b1'::uuid,'HD','[{"height":360,"bitrate_kbps":800}]','transcode');
INSERT INTO groups(id,account_id,name,output_profile_id) VALUES
  ('0000000d-0000-0000-0000-0000000000b1'::uuid,'0000000a-0000-0000-0000-0000000000b1'::uuid,'G','0000000c-0000-0000-0000-0000000000b1'::uuid);
SQL

npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE email='root@adminco.example'\",[h]); await pool.end();})()" >/dev/null 2>&1

npx tsx src/index.ts >/tmp/admin_api.log 2>&1 &
API=$!
for i in $(seq 1 40); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
B="http://localhost:$PORT/api"

login(){ curl -s -X POST "$B/auth/login" -H 'content-type:application/json' -d "{\"email\":\"$1\",\"password\":\"$2\"}"; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }

TOK=$(J "$(login root@adminco.example volt1234)" access); AO="authorization: Bearer $TOK"
ok "owner logged in" '[ -n "$TOK" ]'

# ---- /auth/me ----------------------------------------------------------------
ME=$(curl -s "$B/auth/me" -H "$AO")
ok "me: role owner" '[ "$(J "$ME" role)" = owner ]'
ok "me: full feature access" '[ "$(J "$ME" features.channels)" = manage ] && [ "$(J "$ME" features.epg)" = manage ]'
ok "me: account + access model served" '[ "$(J "$ME" account.name)" = AdminCo ] && [ -n "$(J "$ME" model.levels.0)" ]'

# ---- users CRUD + role guards --------------------------------------------------
mkuser(){ curl -s -X POST "$B/users" -H "$AO" -H 'content-type:application/json' -d "{\"email\":\"$1\",\"password\":\"volt123456\",\"role\":\"$2\"}"; }
AD=$(mkuser admin@adminco.example admin);   ADID=$(J "$AD" id)
OP=$(mkuser op@adminco.example operator);   OPID=$(J "$OP" id)
VW=$(mkuser view@adminco.example viewer);   VWID=$(J "$VW" id)
ok "create admin/operator/viewer" '[ -n "$ADID" ] && [ -n "$OPID" ] && [ -n "$VWID" ]'
ok "duplicate email rejected" '[ "$(code -X POST "$B/users" -H "$AO" -H "content-type:application/json" -d "{\"email\":\"op@adminco.example\",\"password\":\"volt123456\"}")" = 400 ]'

AT=$(J "$(login admin@adminco.example volt123456)" access); AA="authorization: Bearer $AT"
OT=$(J "$(login op@adminco.example volt123456)" access);    OA="authorization: Bearer $OT"
VT=$(J "$(login view@adminco.example volt123456)" access);  VA="authorization: Bearer $VT"
ok "all three can sign in" '[ -n "$AT" ] && [ -n "$OT" ] && [ -n "$VT" ]'

ok "viewer: content read allowed" '[ "$(code "$B/channels" -H "$VA")" = 200 ]'
ok "viewer: content write 403" '[ "$(code -X POST "$B/epg" -H "$VA" -H "content-type:application/json" -d "{}")" = 403 ]'
C=$(code -X POST "$B/epg" -H "$OA" -H 'content-type:application/json' -d '{}')
ok "operator: content write passes access gate (validation, not 403)" '[ "$C" = 400 ] || [ "$C" = 422 ]'
ok "operator: user management 403" '[ "$(code "$B/users" -H "$OA")" = 403 ]'
ok "operator: admin read-open surface (groups) 200" '[ "$(code "$B/groups" -H "$OA")" = 200 ]'
ok "operator: admin surface write 403" '[ "$(code -X POST "$B/groups" -H "$OA" -H "content-type:application/json" -d "{\"name\":\"nope\"}")" = 403 ]'
ok "admin: user list 200" '[ "$(code "$B/users" -H "$AA")" = 200 ]'
ok "admin cannot create an owner" '[ "$(code -X POST "$B/users" -H "$AA" -H "content-type:application/json" -d "{\"email\":\"o2@adminco.example\",\"password\":\"volt123456\",\"role\":\"owner\"}")" = 403 ]'
OWNID=$(psql "$DATABASE_URL" -tA -c "SELECT id FROM users WHERE email='root@adminco.example'" | head -1 | tr -cd 'a-f0-9-')
ok "admin cannot touch an owner" '[ "$(code -X PATCH "$B/users/$OWNID" -H "$AA" -H "content-type:application/json" -d "{\"role\":\"viewer\"}")" = 403 ]'

# ---- user groups: per-feature access ------------------------------------------
G1=$(curl -s -X POST "$B/user-groups" -H "$AO" -H 'content-type:application/json' \
  -d '{"name":"Channel desk","description":"channels only","permissions":{"channels":"manage","epg":"none"}}')
G1ID=$(J "$G1" id)
ok "group created (channels:manage, epg:none)" '[ -n "$G1ID" ]'
ok "assign operator to group" '[ "$(code -X PATCH "$B/users/$OPID" -H "$AO" -H "content-type:application/json" -d "{\"userGroupId\":\"$G1ID\"}")" = 200 ]'
ok "operator: epg hidden by group (403)" '[ "$(code "$B/epg/owners" -H "$OA")" = 403 ]'
ok "operator: channels still allowed" '[ "$(code "$B/channels" -H "$OA")" = 200 ]'
ok "group patch epg->view applies immediately" '[ "$(code -X PATCH "$B/user-groups/$G1ID" -H "$AO" -H "content-type:application/json" -d "{\"permissions\":{\"channels\":\"manage\",\"epg\":\"view\"}}")" = 200 ] && [ "$(code "$B/epg/owners" -H "$OA")" = 200 ]'
ok "operator: epg write still blocked at view level" '[ "$(code -X POST "$B/epg" -H "$OA" -H "content-type:application/json" -d "{}")" = 403 ]'
# Since the roles model (migration 0047) a role change re-derives the tier from
# the roles, so the viewer tier is asked for explicitly: the cap is what is tested.
ok "viewer in manage-group still capped at view" '[ "$(code -X PATCH "$B/users/$VWID" -H "$AO" -H "content-type:application/json" -d "{\"userGroupId\":\"$G1ID\",\"role\":\"viewer\"}")" = 200 ] && [ "$(code -X POST "$B/channels" -H "$VA" -H "content-type:application/json" -d "{}")" = 403 ]'
CB=$(code -X POST "$B/user-groups" -H "$AO" -H 'content-type:application/json' -d '{"name":"bad","permissions":{"nonsense":"manage"}}')
ok "bad permission key rejected" '[ "$CB" = 400 ] || [ "$CB" = 422 ]'

# ---- last-owner guard + disable -------------------------------------------------
# The only owner can only be reached by themselves, and changing your own
# access is refused outright (403) before the last-owner guard (400) is consulted.
# Either refusal keeps the account owned.
LO=$(code -X PATCH "$B/users/$OWNID" -H "$AO" -H "content-type:application/json" -d "{\"role\":\"admin\"}")
ok "last active owner cannot be demoted ($LO)" '[ "$LO" = 400 ] || [ "$LO" = 403 ]'
ok "disable operator" '[ "$(code -X PATCH "$B/users/$OPID" -H "$AO" -H "content-type:application/json" -d "{\"status\":\"disabled\"}")" = 200 ]'
ok "disabled user cannot sign in" '[ -z "$(J "$(login op@adminco.example volt123456)" access)" ]'
ok "re-enable restores sign-in" '[ "$(code -X PATCH "$B/users/$OPID" -H "$AO" -H "content-type:application/json" -d "{\"status\":\"active\"}")" = 200 ] && [ -n "$(J "$(login op@adminco.example volt123456)" access)" ]'

# ---- apps & API keys -------------------------------------------------------------
SK=$(curl -s -X POST "$B/apps/secret-keys" -H "$AO"); SKRAW=$(J "$SK" key); SKID=$(J "$SK" id)
ok "secret key minted (sk_..., shown once)" 'case "$SKRAW" in sk_*) true;; *) false;; esac'
ok "sk bearer works on content API" '[ "$(code "$B/channels" -H "authorization: Bearer $SKRAW")" = 200 ]'
ok "sk bearer works on admin API" '[ "$(code "$B/users" -H "authorization: Bearer $SKRAW")" = 200 ]'
APP=$(curl -s -X POST "$B/apps" -H "$AO" -H 'content-type:application/json' \
  -d '{"name":"Web player","type":"web","restrictions":{"referrers":["watch.example.com"]}}')
APPID=$(J "$APP" id); PK=$(J "$APP" publishableKey.key)
ok "app registered with publishable key (pk_...)" '[ -n "$APPID" ] && case "$PK" in pk_*) true;; *) false;; esac'
ok "publishable key rejected on the admin surface" '[ "$(code "$B/channels" -H "authorization: Bearer $PK")" = 401 ]'
NK=$(curl -s -X POST "$B/apps/$APPID/keys" -H "$AO")
ok "publishable key rotation issues a fresh pk" 'case "$(J "$NK" key)" in pk_*) true;; *) false;; esac'
KEYS=$(curl -s "$B/apps/keys" -H "$AO")
ok "account key list shows secret + app keys" 'python3 -c "
import json,sys; ks=json.loads(sys.argv[1])
kinds={k[\"kind\"] for k in ks}
sys.exit(0 if {\"secret\",\"publishable\"}<=kinds else 1)" "$KEYS"'
ok "revoked secret key stops working" '[ "$(code -X DELETE "$B/apps/keys/$SKID" -H "$AO")" = 204 ] && [ "$(code "$B/channels" -H "authorization: Bearer $SKRAW")" = 401 ]'

# ---- platform: system-admin client account creation ------------------------------
ok "non-platform user gets 403 on /platform" '[ "$(code "$B/platform/accounts" -H "$AA")" = 403 ]'
psql "$DATABASE_URL" -q -c "UPDATE users SET platform_role='saas_admin' WHERE email='root@adminco.example'"
# /api/platform wants a platform session (password + authenticator), not the
# owner's ordinary token: test/lib/platform-session.sh steps up the way the console does.
. test/lib/platform-session.sh
PT=$(platform_session "$B" "$TOK"); PO="authorization: Bearer $PT"
ok "saas_admin sees the tenant list" '[ "$(code "$B/platform/accounts" -H "$PO")" = 200 ]'
NEW=$(curl -s -X POST "$B/platform/accounts" -H "$PO" -H 'content-type:application/json' \
  -d '{"name":"NewClient Co","planTier":"pro","maxChannels":10,"ownerEmail":"newowner@client.example","ownerPassword":"client123456"}')
NEWID=$(J "$NEW" account.id)
ok "client account created with credentials shown once" '[ -n "$NEWID" ] && [ "$(J "$NEW" credentials.password)" = client123456 ]'
NT=$(J "$(login newowner@client.example client123456)" access); NA="authorization: Bearer $NT"
ok "new primary owner can sign in" '[ -n "$NT" ]'
NME=$(curl -s "$B/auth/me" -H "$NA")
ok "new owner lands in the new tenant as owner" '[ "$(J "$NME" account.name)" = "NewClient Co" ] && [ "$(J "$NME" role)" = owner ]'
ok "new account got default group + HD profile" '[ "$(psql "$DATABASE_URL" -tA -c "SELECT count(*) FROM groups WHERE account_id='"'"'$NEWID'"'"'" | head -1)" = 1 ] && [ "$(psql "$DATABASE_URL" -tA -c "SELECT count(*) FROM output_profiles WHERE account_id='"'"'$NEWID'"'"'" | head -1)" = 1 ]'
SK2=$(curl -s -X POST "$B/apps/secret-keys" -H "$NA"); SK2RAW=$(J "$SK2" key)
ok "new tenant minted its own secret key" 'case "$SK2RAW" in sk_*) true;; *) false;; esac'
ok "suspend account" '[ "$(code -X PATCH "$B/platform/accounts/$NEWID" -H "$PO" -H "content-type:application/json" -d "{\"status\":\"suspended\"}")" = 200 ]'
ok "suspended: login blocked" '[ -z "$(J "$(login newowner@client.example client123456)" access)" ]'
ok "suspended: account API keys rejected" '[ "$(code "$B/channels" -H "authorization: Bearer $SK2RAW")" = 401 ]'
ok "reactivate restores login" '[ "$(code -X PATCH "$B/platform/accounts/$NEWID" -H "$PO" -H "content-type:application/json" -d "{\"status\":\"active\"}")" = 200 ] && [ -n "$(J "$(login newowner@client.example client123456)" access)" ]'

kill $API 2>/dev/null
echo
echo "admin.check: $pass passed, $fail failed"
[ "$fail" = 0 ]
