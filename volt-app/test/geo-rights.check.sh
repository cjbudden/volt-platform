#!/usr/bin/env bash
# Geo/rights in the play gate: a current programme with a blackout blocks the
# viewer's country and offers the replacement asset; other regions play normally.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?set DATABASE_URL}"
export JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET:-devsecret} JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET:-devrefresh} INGEST_TOKEN=${INGEST_TOKEN:-dev-ingest}
export PORT=${PORT:-8101} ORCH_LAUNCHER=mock
A=00000000-0000-0000-0000-0000000000a1; U=00000000-0000-0000-0000-0000000000f1; G=00000000-0000-0000-0000-0000000000b1; C=00000000-0000-0000-0000-0000000000c1; D=00000000-0000-0000-0000-0000000000d1; REPL=00000000-0000-0000-0000-00000000dead
pass=0; fail=0; ok(){ echo "  ✓ $1"; pass=$((pass+1)); }; no(){ echo "  ✗ $1"; fail=$((fail+1)); }
jf(){ node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(eval('JSON.parse(s)'+process.argv[1]))}catch(e){console.log('ERR')}})" "$1"; }

psql "$DATABASE_URL" -q -f migrations/0001_init.sql
psql "$DATABASE_URL" -q -c "
INSERT INTO accounts(id,name) VALUES ('$A','RTM');
INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES ('$U','$A','a@x','x','owner','active');
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('$D','$A','p','[]','package_only');
INSERT INTO groups(id,account_id,name,output_profile_id) VALUES ('$G','$A','g','$D');
INSERT INTO channels(id,group_id,name,status) VALUES ('$C','$G','n','live');
-- The replacement must be a REAL asset in this account. It used to be a bare
-- uuid with no row behind it, which passed only because the availability gate
-- never checked that the asset it was about to mint a token for existed or
-- belonged to the caller. It does now, so a dangling replacement is treated as
-- no replacement -- correctly, and this fixture has to mean what it says.
INSERT INTO vod_assets(id,channel_id,kind,title,master_key,start_epoch_ms,end_epoch_ms,duration_ms)
 VALUES ('$REPL','$C','clip','Blackout slate','vod/$REPL/master.m3u8',0,60000,60000);
-- a currently-airing programme with a US blackout + replacement
INSERT INTO programmes(channel_id,title,starts_at,ends_at,geo_mode,geo_countries,replacement_asset_id)
 VALUES ('$C','Blackout Match', now()-interval '1 hour', now()+interval '1 hour', 'block', '{US}', '$REPL');"

fuser -k "$PORT"/tcp 2>/dev/null || true; sleep 1
npx tsx src/index.ts >/tmp/volt-geo.log 2>&1 & SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -fsS "localhost:$PORT/health" >/dev/null 2>&1 && break || sleep 1; done
T=$(node -e "console.log(require('jsonwebtoken').sign({sub:'$U',account_id:'$A',role:'owner'},process.env.JWT_ACCESS_SECRET,{expiresIn:3600}))")
BASE="http://localhost:$PORT"; JS="Content-Type: application/json"
PK=$(curl -s -X POST -H "Authorization: Bearer $T" -H "$JS" $BASE/api/apps -d '{"name":"W","type":"web","restrictions":{}}' | jf '.publishableKey.key')

echo "== check-access respects blackout =="
US=$(curl -s -X POST -H "$JS" $BASE/api/access/check -d "{\"appKey\":\"$PK\",\"assetId\":\"$C\",\"geo\":\"US\"}")
[ "$(echo "$US" | jf '.allowed')" = "false" ] && ok "US viewer blocked (blackout)" || no "US not blocked: $US"
echo "$US" | grep -q "$REPL" && ok "blocked response offers replacement asset" || no "no replacement offered"
GB=$(curl -s -X POST -H "$JS" $BASE/api/access/check -d "{\"appKey\":\"$PK\",\"assetId\":\"$C\",\"geo\":\"GB\"}")
[ "$(echo "$GB" | jf '.allowed')" = "true" ] && ok "GB viewer allowed" || no "GB wrongly blocked: $GB"

echo "== availability serves replacement in blacked-out region =="
AVUS=$(curl -s -X POST -H "$JS" $BASE/api/availability -d "{\"appKey\":\"$PK\",\"assetId\":\"$C\",\"geo\":\"US\"}")
[ "$(echo "$AVUS" | jf '.mode')" = "replacement" ] && ok "US availability → mode=replacement" || no "US availability mode: $AVUS"
[ "$(echo "$AVUS" | jf '.assetId')" = "$REPL" ] && ok "US token is for the replacement asset" || no "replacement asset id wrong"
echo "$AVUS" | grep -q playbackToken && ok "replacement still yields a playback token" || no "no token for replacement"
AVGB=$(curl -s -X POST -H "$JS" $BASE/api/availability -d "{\"appKey\":\"$PK\",\"assetId\":\"$C\",\"geo\":\"GB\"}")
[ "$(echo "$AVGB" | jf '.mode')" = "play" ] && ok "GB availability → mode=play (normal)" || no "GB availability mode: $AVGB"

echo
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
