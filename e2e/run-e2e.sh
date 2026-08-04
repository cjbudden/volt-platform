#!/usr/bin/env bash
# Volt local end-to-end test. Brings up the stack, lets the pipeline run, then
# asserts the CORE ENCODING output landed in MinIO and the control plane saw
# live status + events. Exit 0 = pass. Requires: docker + docker compose.
set -euo pipefail
cd "$(dirname "$0")"

CH=00000000-0000-0000-0000-0000000000c1
BUCKET=volt-e2e
RUN_SECONDS=${RUN_SECONDS:-30}
COMPOSE="docker compose -f docker-compose.e2e.yml"
pass=0; fail=0
ok(){ echo "  ✓ $1"; pass=$((pass+1)); }
no(){ echo "  ✗ $1"; fail=$((fail+1)); }

cleanup(){ echo "== tearing down =="; $COMPOSE down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== building + starting stack =="
$COMPOSE up -d --build

echo "== waiting for API health =="
for i in $(seq 1 40); do
  curl -fsS localhost:8080/health >/dev/null 2>&1 && break || sleep 2
done
curl -fsS localhost:8080/health >/dev/null 2>&1 && ok "API healthy" || { no "API never became healthy"; exit 1; }

echo "== letting the pipeline run ${RUN_SECONDS}s (ingest → package → MinIO) =="
sleep "$RUN_SECONDS"

echo "== assertions =="
# 1) manifests written to MinIO (objects are files under /data/<bucket>)
if $COMPOSE exec -T minio sh -c "find /data/$BUCKET -name master.m3u8 | grep -q ." ; then ok "HLS master.m3u8 in MinIO"; else no "HLS master.m3u8 missing"; fi
if $COMPOSE exec -T minio sh -c "find /data/$BUCKET -name manifest.mpd | grep -q ." ; then ok "DASH manifest.mpd in MinIO"; else no "DASH manifest.mpd missing"; fi
SEGS=$($COMPOSE exec -T minio sh -c "find /data/$BUCKET -name 'seg_*.m4s' | wc -l" | tr -d '[:space:]')
[ "${SEGS:-0}" -gt 0 ] && ok "CMAF segments present ($SEGS)" || no "no CMAF segments"

# 2) control plane saw live status + events (mint a JWT with the API's secret)
TOKEN=$($COMPOSE exec -T api node -e "console.log(require('jsonwebtoken').sign({sub:'u',account_id:'00000000-0000-0000-0000-0000000000a1',role:'owner'},process.env.JWT_ACCESS_SECRET,{expiresIn:3600}))" | tr -d '\r')
STATUS=$(curl -fsS -H "Authorization: Bearer $TOKEN" "localhost:8080/api/status/channel/$CH" || echo '{}')
echo "     status: $STATUS"
echo "$STATUS" | grep -q '"output_available":true' && ok "control plane: output_available=true" || no "output not reported available"
EVTYPES=$(curl -fsS -H "Authorization: Bearer $TOKEN" "localhost:8080/api/status/channel/$CH/events" || echo '[]')
echo "$EVTYPES" | grep -q 'packager.up' && ok "event log has packager.up" || no "no packager.up event"
echo "$EVTYPES" | grep -q 'channel.start' && ok "event log has channel.start" || no "no channel.start event"

echo
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
