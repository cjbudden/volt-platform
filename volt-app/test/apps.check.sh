#!/usr/bin/env bash
# Apps + API keys: register app → publishable key (once), /availability gate
# (valid key + referrer → playback token; wrong origin → 403; bad key → 401),
# secret key issuance, key metering. Needs DATABASE_URL -> empty Postgres.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?set DATABASE_URL}"
export JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET:-devsecret} JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET:-devrefresh} INGEST_TOKEN=${INGEST_TOKEN:-dev-ingest}
export PORT=${PORT:-8093} ORCH_LAUNCHER=mock
A=00000000-0000-0000-0000-0000000000a1
G=00000000-0000-0000-0000-0000000000b1; D=00000000-0000-0000-0000-0000000000d1
C=00000000-0000-0000-0000-0000000000c1
pass=0; fail=0; ok(){ echo "  ✓ $1"; pass=$((pass+1)); }; no(){ echo "  ✗ $1"; fail=$((fail+1)); }

psql "$DATABASE_URL" -q -f migrations/0001_init.sql
# A REAL asset to ask about. This used to pass the literal string "vod-123",
# which worked only because the availability gate never checked that the asset
# existed or belonged to the key's account -- so a publishable key could mint a
# playback token for anything, including another tenant's channel.
psql "$DATABASE_URL" -q -c "
DELETE FROM accounts WHERE id = '$A';
INSERT INTO accounts(id,name) VALUES ('$A','RTM');
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('$D','$A','p','[]','package_only');
INSERT INTO groups(id,account_id,name,output_profile_id) VALUES ('$G','$A','g','$D');
INSERT INTO channels(id,group_id,name,status) VALUES ('$C','$G','app-news','live');"

fuser -k "$PORT"/tcp 2>/dev/null || true; sleep 1
npx tsx src/index.ts >/tmp/volt-apps.log 2>&1 & SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -fsS "localhost:$PORT/health" >/dev/null 2>&1 && break || sleep 1; done
TOKEN=$(node -e "console.log(require('jsonwebtoken').sign({sub:'u',account_id:'$A',role:'owner'},process.env.JWT_ACCESS_SECRET,{expiresIn:3600}))")
BASE="http://localhost:$PORT"; AUTH="Authorization: Bearer $TOKEN"; JS="Content-Type: application/json"
jget(){ node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(eval('('+JSON.stringify(JSON.parse(s))+')')$1)}catch(e){console.log('')}})"; }

echo "== register web app → publishable key (shown once) =="
APP=$(curl -fsS -X POST -H "$AUTH" -H "$JS" "$BASE/api/apps" -d '{"name":"RTM Web","type":"web","restrictions":{"referrers":["*.rtm.example"]}}')
PK=$(echo "$APP" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).publishableKey.key))")
echo "$PK" | grep -q '^pk_live_' && ok "publishable key issued (pk_live_…)" || no "no publishable key: $APP"
APPID=$(echo "$APP" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).id))")

echo "== /availability gate =="
# valid key + matching Origin → token
AV=$(curl -fsS -X POST -H "$JS" -H "Origin: https://watch.rtm.example" "$BASE/api/availability" -d "{\"appKey\":\"$PK\",\"assetId\":\"$C\"}")
echo "$AV" | grep -q '"available":true' && ok "availability granted for allowed origin" || no "availability denied: $AV"
PBT=$(echo "$AV" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).playbackToken)}catch(e){console.log('')}})")
[ -n "$PBT" ] && ok "playback token minted" || no "no playback token"
# token is a playback-typed JWT
# The token names WHAT the asset is as well as which one. Without `kind` the
# beacon guessed from the id's first characters, which no real uuid matches, so
# every channel session was filed as VOD and channel concurrency read zero.
node -e "const j=require('jsonwebtoken');const d=j.verify('$PBT',process.env.JWT_ACCESS_SECRET);process.exit(d.typ==='playback'&&d.asset==='$C'&&d.kind==='channel'?0:1)" && ok "playback token is typ=playback bound to the asset and its kind" || no "playback token invalid"

# wrong origin → 403
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$JS" -H "Origin: https://evil.example" "$BASE/api/availability" -d "{\"appKey\":\"$PK\",\"assetId\":\"$C\"}")
[ "$code" = "403" ] && ok "disallowed origin blocked (403)" || no "wrong origin not blocked (got $code)"

# bad key → 401
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$JS" -H "Origin: https://watch.rtm.example" "$BASE/api/availability" -d '{"appKey":"pk_live_bogus","assetId":"x"}')
[ "$code" = "401" ] && ok "invalid key rejected (401)" || no "bad key not rejected (got $code)"

echo "== secret key + metering =="
SK=$(curl -fsS -X POST -H "$AUTH" -H "$JS" "$BASE/api/apps/secret-keys" -d '{}')
echo "$SK" | grep -q 'sk_live_' && ok "secret (management) key issued" || no "no secret key: $SK"
# metering: after 1 successful availability, request_count >= 1
RC=$(psql "$DATABASE_URL" -tAc "SELECT request_count FROM api_keys WHERE app_id='$APPID' AND kind='publishable'")
[ "${RC:-0}" -ge 1 ] && ok "per-key metering incremented ($RC)" || no "metering not counted ($RC)"

echo
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
