#!/usr/bin/env bash
# EPG/scheduling: RRULE materialization, effective-end resolution, guide window,
# now/next, soft conflict detection. Needs DATABASE_URL -> empty Postgres.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?set DATABASE_URL}"
export JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET:-devsecret} JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET:-devrefresh} INGEST_TOKEN=${INGEST_TOKEN:-dev-ingest}
export PORT=${PORT:-8092} ORCH_LAUNCHER=mock
A=00000000-0000-0000-0000-0000000000a1; G=00000000-0000-0000-0000-0000000000b1
D=00000000-0000-0000-0000-0000000000d1; C=00000000-0000-0000-0000-0000000000c1
pass=0; fail=0; ok(){ echo "  ✓ $1"; pass=$((pass+1)); }; no(){ echo "  ✗ $1"; fail=$((fail+1)); }

psql "$DATABASE_URL" -q -f migrations/0001_init.sql
psql "$DATABASE_URL" -q <<SQL
INSERT INTO accounts(id,name) VALUES ('$A','RTM') ON CONFLICT DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('$D','$A','p','[]','package_only') ON CONFLICT DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,max_concurrent) VALUES ('$G','$A','g','$D',10,5) ON CONFLICT DO NOTHING;
INSERT INTO channels(id,group_id,name,status) VALUES ('$C','$G','epg-ch','scheduled') ON CONFLICT DO NOTHING;
SQL

echo "== pure: expandRrule / resolveEffectiveEnds =="
if npx tsx test/epg-pure.check.ts > /tmp/epg_pure.txt 2>&1; then
  n=$(grep -c '^PASS' /tmp/epg_pure.txt); ok "pure EPG logic ($n assertions)"
else
  no "pure EPG logic failed:"; sed 's/^/     /' /tmp/epg_pure.txt
fi

echo "== HTTP: boot + endpoints =="
fuser -k "$PORT"/tcp 2>/dev/null || true; sleep 1
npx tsx src/index.ts >/tmp/volt-epg.log 2>&1 & SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -fsS "localhost:$PORT/health" >/dev/null 2>&1 && break || sleep 1; done
TOKEN=$(node -e "console.log(require('jsonwebtoken').sign({sub:'u',account_id:'$A',role:'owner'},process.env.JWT_ACCESS_SECRET,{expiresIn:3600}))")
BASE="http://localhost:$PORT"; AUTH="Authorization: Bearer $TOKEN"; JS="Content-Type: application/json"

# series materialization (weekly, 8 weeks) starting tomorrow — within the 90d horizon
DTSTART=$(date -u -d '+1 day' +%Y-%m-%dT18:00:00Z)
SER=$(curl -fsS -X POST -H "$AUTH" -H "$JS" "$BASE/api/epg/series" -d "{\"channelId\":\"$C\",\"title\":\"Nightly News\",\"rrule\":\"FREQ=WEEKLY;COUNT=8\",\"dtstart\":\"$DTSTART\",\"durationMs\":1800000}")
echo "$SER" | grep -q '"materialized":8' && ok "series materialized 8 instances" || no "series materialize: $SER"

# guide window returns them (wide window)
WIN=$(curl -fsS -H "$AUTH" "$BASE/api/epg?channelId=$C&from=$(date -u +%Y-%m-%dT00:00:00Z)&to=$(date -u -d '+120 days' +%Y-%m-%dT00:00:00Z)")
CNT=$(echo "$WIN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).length))")
[ "$CNT" = "8" ] && ok "guide window lists the 8 programmes" || no "guide window count=$CNT"

# one-off with omitted end resolves to next entry's start
NOWISO=$(date -u -d '-5 min' +%Y-%m-%dT%H:%M:%SZ)
SOONISO=$(date -u -d '+30 min' +%Y-%m-%dT%H:%M:%SZ)
curl -fsS -X POST -H "$AUTH" -H "$JS" "$BASE/api/epg" -d "{\"channelId\":\"$C\",\"title\":\"Next Show\",\"startsAt\":\"$SOONISO\"}" >/dev/null
P1=$(curl -fsS -X POST -H "$AUTH" -H "$JS" "$BASE/api/epg" -d "{\"channelId\":\"$C\",\"title\":\"On Now\",\"startsAt\":\"$NOWISO\"}")
# match on seconds (API returns ms precision .000Z)
echo "$P1" | grep -q "${SOONISO%Z}" && ok "omitted end resolved to next programme's start" || no "effective-end via API: $P1"

# now/next
NN=$(curl -fsS -H "$AUTH" "$BASE/api/epg/now-next?channelId=$C")
echo "$NN" | grep -q '"On Now"' && ok "now-next: current programme is 'On Now'" || no "now-next now: $NN"
echo "$NN" | grep -q '"Next Show"' && ok "now-next: next programme is 'Next Show'" || no "now-next next: $NN"

# conflict detection: overlapping programme
curl -fsS -X POST -H "$AUTH" -H "$JS" "$BASE/api/epg" -d "{\"channelId\":\"$C\",\"title\":\"Overlap\",\"startsAt\":\"$NOWISO\",\"endsAt\":\"$SOONISO\"}" >/dev/null
CONF=$(curl -fsS -H "$AUTH" "$BASE/api/epg/conflicts?channelId=$C")
echo "$CONF" | grep -q 'overlap_start' && ok "conflict detector surfaces the overlap" || no "no conflict detected: $CONF"

echo
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
