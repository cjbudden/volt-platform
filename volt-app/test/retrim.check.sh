#!/usr/bin/env bash
# Non-destructive clip re-trim: create a clip, change its in/out, confirm the
# range/duration/manifest key update and the source recording is untouched.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?set DATABASE_URL}"
export JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET:-devsecret} JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET:-devrefresh} INGEST_TOKEN=${INGEST_TOKEN:-dev-ingest}
export PORT=${PORT:-8103} ORCH_LAUNCHER=mock
A=00000000-0000-0000-0000-0000000000a1; U=00000000-0000-0000-0000-0000000000f1; G=00000000-0000-0000-0000-0000000000b1; C=00000000-0000-0000-0000-0000000000c1; D=00000000-0000-0000-0000-0000000000d1; R=00000000-0000-0000-0000-0000000000e1
pass=0; fail=0; ok(){ echo "  ✓ $1"; pass=$((pass+1)); }; no(){ echo "  ✗ $1"; fail=$((fail+1)); }
jf(){ node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(eval('JSON.parse(s)'+process.argv[1]))}catch(e){console.log('ERR')}})" "$1"; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }

psql "$DATABASE_URL" -q -f migrations/0001_init.sql
psql "$DATABASE_URL" -q -c "
INSERT INTO accounts(id,name) VALUES ('$A','RTM');
INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES ('$U','$A','a@x','x','owner','active');
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('$D','$A','p','[]','package_only');
INSERT INTO groups(id,account_id,name,output_profile_id) VALUES ('$G','$A','g','$D');
INSERT INTO channels(id,group_id,name,status) VALUES ('$C','$G','n','live');
INSERT INTO recordings(id,kind,channel_id,day_utc,status,start_epoch_ms,master_key,hi_res_rendition) VALUES ('$R','channel_day','$C','2026-07-30','recording',0,'channel/$C','1080p');"

fuser -k "$PORT"/tcp 2>/dev/null || true; sleep 1
npx tsx src/index.ts >/tmp/volt-retrim.log 2>&1 & SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -fsS "localhost:$PORT/health" >/dev/null 2>&1 && break || sleep 1; done
T=$(node -e "console.log(require('jsonwebtoken').sign({sub:'$U',account_id:'$A',role:'owner'},process.env.JWT_ACCESS_SECRET,{expiresIn:3600}))")
BASE="http://localhost:$PORT"; JS="Content-Type: application/json"; AUTH="Authorization: Bearer $T"

echo "== create a clip 1000..9000 =="
CLIP=$(curl -s -X POST -H "$AUTH" -H "$JS" $BASE/api/recordings/$R/clip -d '{"title":"Highlight","startMs":1000,"endMs":9000,"outputKind":"both"}')
VID=$(echo "$CLIP" | jf '.id')
echo "$CLIP" | grep -q 'clip-1000-9000' && ok "clip created with range 1000-9000 in its key" || no "clip create: $(echo "$CLIP"|head -c140)"

echo "== re-trim to 2000..6000 (non-destructive) =="
TR=$(curl -s -X PATCH -H "$AUTH" -H "$JS" $BASE/api/vod/$VID/trim -d '{"startMs":2000,"endMs":6000}')
[ "$(echo "$TR" | jf '.start_epoch_ms')" = "2000" ] && ok "start updated to 2000" || no "start: $(echo "$TR"|head -c140)"
[ "$(echo "$TR" | jf '.end_epoch_ms')" = "6000" ] && ok "end updated to 6000" || no "end wrong"
[ "$(echo "$TR" | jf '.duration_ms')" = "4000" ] && ok "duration recomputed to 4000" || no "duration wrong"
echo "$TR" | grep -q 'clip-2000-6000' && ok "manifest key re-pointed to clip-2000-6000" || no "master_key not updated"
[ "$(echo "$TR" | jf '.thumb_status')" = "processing" ] && ok "marked for re-derivation (thumb_status=processing)" || no "not re-queued"

echo "== source recording untouched =="
RECST=$(psql "$DATABASE_URL" -tAc "SELECT status FROM recordings WHERE id='$R'")
[ "$RECST" = "recording" ] && ok "source recording is unchanged (non-destructive)" || no "recording changed ($RECST)"

echo "== invalid range rejected =="
[ "$(code -X PATCH -H "$AUTH" -H "$JS" $BASE/api/vod/$VID/trim -d '{"startMs":9000,"endMs":1000}')" = "400" ] && ok "endMs<=startMs → 400" || no "bad range not rejected"

echo
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
