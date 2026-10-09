#!/usr/bin/env bash
# SaaS layer: analytics ingest + reports, SaaS-admin platform dashboard, support
# tickets, and CROSS-TENANT ISOLATION. Needs DATABASE_URL -> empty Postgres.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?set DATABASE_URL}"
export JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET:-devsecret} JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET:-devrefresh} INGEST_TOKEN=${INGEST_TOKEN:-dev-ingest}
export PORT=${PORT:-8094} ORCH_LAUNCHER=mock
pass=0; fail=0; ok(){ echo "  ✓ $1"; pass=$((pass+1)); }; no(){ echo "  ✗ $1"; fail=$((fail+1)); }
# two tenants; U1 is also a SaaS platform admin
A1=00000000-0000-0000-0000-0000000000a1; U1=00000000-0000-0000-0000-0000000000f1; G1=00000000-0000-0000-0000-0000000000b1; C1=00000000-0000-0000-0000-0000000000c1; D1=00000000-0000-0000-0000-0000000000d1
A2=00000000-0000-0000-0000-0000000000a2; U2=00000000-0000-0000-0000-0000000000f2; G2=00000000-0000-0000-0000-0000000000b2; C2=00000000-0000-0000-0000-0000000000c2; D2=00000000-0000-0000-0000-0000000000d2

psql "$DATABASE_URL" -q -f migrations/0001_init.sql
psql "$DATABASE_URL" -q <<SQL
-- Clear this suite's rows first. Email is unique, so on a database that
-- already had saas@volt.example the whole INSERT aborted as one statement, the
-- users were never created, and every assertion after it failed on a missing
-- fixture rather than on the behaviour under test.
DELETE FROM users WHERE email IN ('saas@volt.example','client@other.example');
DELETE FROM accounts WHERE id IN ('$A1','$A2');
INSERT INTO accounts(id,name) VALUES ('$A1','RTM'),('$A2','OtherCo');
INSERT INTO users(id,account_id,email,password_hash,role,status,platform_role) VALUES
 ('$U1','$A1','saas@volt.example','x','owner','active','saas_admin'),
 ('$U2','$A2','client@other.example','x','owner','active',NULL);
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('$D1','$A1','p','[]','package_only'),('$D2','$A2','p','[]','package_only');
INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,max_concurrent) VALUES ('$G1','$A1','g','$D1',10,5),('$G2','$A2','g','$D2',10,5);
INSERT INTO channels(id,group_id,name,status) VALUES ('$C1','$G1','rtm-news','live'),('$C2','$G2','other-news','live');
INSERT INTO refresh_tokens(user_id,token_hash,expires_at) VALUES ('$U1','h',now()+interval '1 day');
SQL

fuser -k "$PORT"/tcp 2>/dev/null || true; sleep 1
npx tsx src/index.ts >/tmp/volt-saas.log 2>&1 & SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -fsS "localhost:$PORT/health" >/dev/null 2>&1 && break || sleep 1; done
mint(){ node -e "console.log(require('jsonwebtoken').sign({sub:'$1',account_id:'$2',role:'owner'},process.env.JWT_ACCESS_SECRET,{expiresIn:3600}))"; }
T1=$(mint $U1 $A1); T2=$(mint $U2 $A2)
BASE="http://localhost:$PORT"; JS="Content-Type: application/json"
jf(){ node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(eval('JSON.parse(s)'+process.argv[1]))}catch(e){console.log('ERR')}})" "$1"; }

echo "== cross-tenant isolation =="
N1=$(curl -fsS -H "Authorization: Bearer $T1" "$BASE/api/channels" | jf '.length')
N2=$(curl -fsS -H "Authorization: Bearer $T2" "$BASE/api/channels" | jf '.length')
NM1=$(curl -fsS -H "Authorization: Bearer $T1" "$BASE/api/channels" | jf '[0].name')
NM2=$(curl -fsS -H "Authorization: Bearer $T2" "$BASE/api/channels" | jf '[0].name')
[ "$N1" = "1" ] && [ "$N2" = "1" ] && ok "each tenant sees only its own channel (A1=$N1,A2=$N2)" || no "tenant channel counts wrong ($N1/$N2)"
[ "$NM1" = "rtm-news" ] && [ "$NM2" = "other-news" ] && ok "tenants see DIFFERENT channels (no leakage)" || no "channel leakage ($NM1/$NM2)"

echo "== platform auth (SaaS admin vs client) =="
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T2" "$BASE/api/platform/overview")
[ "$code" = "403" ] && ok "non-platform user blocked from /api/platform (403)" || no "client reached platform (got $code)"
OV=$(curl -fsS -H "Authorization: Bearer $T1" "$BASE/api/platform/overview")
echo "$OV" | grep -q '"active":2' && ok "overview: 2 active channels across tenants" || no "overview channels: $(echo "$OV"|head -c160)"
[ "$(echo "$OV" | jf '.admins.active')" -ge 1 ] && ok "overview: active admins counted" || no "active admins not counted"
echo "$OV" | grep -q '"database":"ok"' && ok "overview: API/system status reported" || no "no api status"
# Assert CONTAINMENT, not a global total. The claim worth making is that the
# platform list crosses the tenant boundary and shows both of this suite's
# accounts; "the database contains exactly two accounts" is a different claim,
# it was never the point, and it made the check fail on any database that had
# anything else in it.
ACL=$(curl -fsS -H "Authorization: Bearer $T1" "$BASE/api/platform/accounts")
echo "$ACL" | grep -q "$A1" && echo "$ACL" | grep -q "$A2" \
  && ok "platform account list crosses the tenant boundary (both tenants present)" \
  || no "account list missing a tenant: $(echo "$ACL" | head -c 160)"

echo "== analytics ingest + reports =="
APP=$(curl -s -X POST -H "Authorization: Bearer $T1" -H "$JS" "$BASE/api/apps" -d '{"name":"RTM Web","type":"web","restrictions":{}}')
PK=$(echo "$APP" | jf '.publishableKey.key')
[ -n "$PK" ] && [ "$PK" != "ERR" ] && [ "$PK" != "undefined" ] && ok "publishable key issued for analytics" || no "no PK (app resp: $(echo "$APP"|head -c150))"
AVR=$(curl -s -X POST -H "$JS" "$BASE/api/availability" -d "{\"appKey\":\"$PK\",\"assetId\":\"$C1\"}")
PBT=$(echo "$AVR" | jf '.playbackToken')
[ -n "$PBT" ] && [ "$PBT" != "undefined" ] && ok "playback token from availability" || no "no playback token (avail resp: $(echo "$AVR"|head -c150))"
# a viewing session: start -> heartbeat -> (still live)
curl -fsS -X POST -H "$JS" "$BASE/api/analytics/beacon" -d "{\"playbackToken\":\"$PBT\",\"sessionId\":\"session-0001\",\"event\":\"start\"}" >/dev/null
curl -fsS -X POST -H "$JS" "$BASE/api/analytics/beacon" -d "{\"playbackToken\":\"$PBT\",\"sessionId\":\"session-0002\",\"event\":\"start\"}" >/dev/null
RT=$(curl -fsS -H "Authorization: Bearer $T1" "$BASE/api/analytics/realtime")
[ "$(echo "$RT" | jf '.total_concurrent')" = "2" ] && ok "realtime concurrency = 2 live sessions" || no "realtime concurrency: $RT"
# end a session -> rolls up
curl -fsS -X POST -H "$JS" "$BASE/api/analytics/beacon" -d "{\"playbackToken\":\"$PBT\",\"sessionId\":\"session-0001\",\"event\":\"end\",\"seconds\":120}" >/dev/null
AUD=$(curl -fsS -H "Authorization: Bearer $T1" "$BASE/api/analytics/audience")
[ "$(echo "$AUD" | jf '.total_views')" -ge 1 ] && ok "audience rollup recorded a view" || no "audience: $AUD"
echo "$AUD" | grep -q 'by_app' && ok "audience carries by-app/device/geo breakdown" || no "no by-app dimension"
# platform viewers reflects concurrency
[ "$(curl -fsS -H "Authorization: Bearer $T1" "$BASE/api/platform/overview" | jf '.viewers.active')" -ge 1 ] && ok "platform overview shows active viewers" || no "platform viewers not reflected"

echo "== support tickets =="
TK=$(curl -fsS -X POST -H "Authorization: Bearer $T2" -H "$JS" "$BASE/api/tickets" -d '{"subject":"Stream stalled","priority":"high"}')
TID=$(echo "$TK" | jf '.id')
echo "$TID" | grep -q '-' && ok "client filed a ticket" || no "ticket create: $TK"
# saas admin sees it cross-tenant + can triage
echo "$(curl -fsS -H "Authorization: Bearer $T1" "$BASE/api/platform/tickets")" | grep -q 'Stream stalled' && ok "SaaS admin sees the ticket cross-tenant" || no "ticket not visible to platform"
RS=$(curl -fsS -X PATCH -H "Authorization: Bearer $T1" -H "$JS" "$BASE/api/platform/tickets/$TID" -d '{"status":"resolved"}')
echo "$RS" | grep -q '"status":"resolved"' && ok "SaaS admin resolved the ticket" || no "ticket triage: $RS"
# client CANNOT hit platform tickets
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T2" "$BASE/api/platform/tickets")
[ "$code" = "403" ] && ok "client blocked from platform ticket triage (403)" || no "client reached triage ($code)"

echo
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
