#!/usr/bin/env bash
# Enforces the API access map: admin routes are unreachable without an admin
# credential; the account SECRET KEY authorizes admin routes (server-to-server);
# publishable keys are refused for admin; public routes work without a session.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?set DATABASE_URL}"
export JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET:-devsecret} JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET:-devrefresh} INGEST_TOKEN=${INGEST_TOKEN:-dev-ingest}
export PORT=${PORT:-8098} ORCH_LAUNCHER=mock
A=00000000-0000-0000-0000-0000000000a1; U=00000000-0000-0000-0000-0000000000f1; G=00000000-0000-0000-0000-0000000000b1; C=00000000-0000-0000-0000-0000000000c1; D=00000000-0000-0000-0000-0000000000d1
pass=0; fail=0; ok(){ echo "  ✓ $1"; pass=$((pass+1)); }; no(){ echo "  ✗ $1"; fail=$((fail+1)); }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }

psql "$DATABASE_URL" -q -f migrations/0001_init.sql
psql "$DATABASE_URL" -q -c "
INSERT INTO accounts(id,name) VALUES ('$A','RTM');
INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES ('$U','$A','a@x','x','owner','active');
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('$D','$A','p','[]','package_only');
INSERT INTO groups(id,account_id,name,output_profile_id) VALUES ('$G','$A','g','$D');
INSERT INTO channels(id,group_id,name,status) VALUES ('$C','$G','n','live');"

fuser -k "$PORT"/tcp 2>/dev/null || true; sleep 1
npx tsx src/index.ts >/tmp/volt-acl.log 2>&1 & SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -fsS "localhost:$PORT/health" >/dev/null 2>&1 && break || sleep 1; done
T=$(node -e "console.log(require('jsonwebtoken').sign({sub:'$U',account_id:'$A',role:'owner'},process.env.JWT_ACCESS_SECRET,{expiresIn:3600}))")
BASE="http://localhost:$PORT"; JS="Content-Type: application/json"

echo "== public routes work WITHOUT a session =="
[ "$(code $BASE/health)" = "200" ] && ok "GET /health public" || no "/health not public"
[ "$(code $BASE/api)" = "200" ] && ok "GET /api (discovery) public" || no "/api not public"
[ "$(code $BASE/api/context.jsonld)" = "200" ] && ok "GET /api/context.jsonld public" || no "context not public"

echo "== admin routes are BLOCKED without any credential (401) =="
for p in /api/channels /api/vod /api/epg /api/recordings /api/analytics/realtime /api/apps; do
  c=$(code $BASE$p); [ "$c" = "401" ] && ok "admin $p → 401 unauthenticated" || no "admin $p unprotected (got $c)"
done

echo "== admin session token grants access =="
[ "$(code -H "Authorization: Bearer $T" $BASE/api/channels)" = "200" ] && ok "session token → /api/channels 200" || no "session token rejected"

echo "== account SECRET KEY authorizes admin routes (server-to-server) =="
# mint a secret key via the session, then use ONLY the key (no JWT)
SK=$(curl -s -X POST -H "Authorization: Bearer $T" -H "$JS" $BASE/api/apps/secret-keys -d '{}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).key))")
echo "$SK" | grep -q '^sk_live_' && ok "secret key issued" || no "no secret key"
[ "$(code -H "Authorization: Bearer $SK" $BASE/api/channels)" = "200" ] && ok "secret key (Bearer) → /api/channels 200" || no "secret key not accepted as Bearer"
[ "$(code -H "X-Volt-Account-Key: $SK" $BASE/api/channels)" = "200" ] && ok "secret key (X-Volt-Account-Key) → 200" || no "account-key header not accepted"
# and it is account-scoped: only this account's channel
N=$(curl -s -H "Authorization: Bearer $SK" $BASE/api/channels | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).length))")
[ "$N" = "1" ] && ok "secret-key access is account-scoped (1 channel)" || no "secret-key scope wrong ($N)"

echo "== publishable key is REFUSED for admin routes =="
APP=$(curl -s -X POST -H "Authorization: Bearer $T" -H "$JS" $BASE/api/apps -d '{"name":"W","type":"web","restrictions":{}}')
PK=$(echo "$APP" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).publishableKey.key))")
c=$(code -H "Authorization: Bearer $PK" $BASE/api/channels); [ "$c" = "401" ] && ok "publishable key → admin route 401" || no "publishable key wrongly allowed ($c)"

echo "== public play surface works with the publishable key =="
[ "$(code -X POST -H "$JS" $BASE/api/access/check -d "{\"appKey\":\"$PK\",\"assetId\":\"$C\"}")" = "200" ] && ok "POST /api/access/check public (pk)" || no "check-access not public"
AV=$(curl -s -X POST -H "$JS" $BASE/api/availability -d "{\"appKey\":\"$PK\",\"assetId\":\"$C\"}")
echo "$AV" | grep -q playbackToken && ok "POST /api/availability public (pk) → token" || no "availability not public"

echo
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
