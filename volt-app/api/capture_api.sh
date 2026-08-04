#!/usr/bin/env bash
# Capture REAL request/response for every endpoint and (re)generate the Postman
# collection (with saved examples), docs/API.md, and docs/api-playground.html.
# Same setup as verify.sh: needs node, psql, and DATABASE_URL -> empty Postgres.
#
#   DATABASE_URL=postgres://user:pass@host/volt_capture ./api/capture_api.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?set DATABASE_URL to an empty Postgres database}"
export JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET:-devsecret}
export JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET:-devrefresh}
export INGEST_TOKEN=${INGEST_TOKEN:-dev-ingest}
export PORT=${PORT:-8080}
export S3_BUCKET=${S3_BUCKET:-volt-origin}
export CDN_BASE_URL=${CDN_BASE_URL:-https://cdn.example.com}
export INTERNAL_API_BASE_URL=${INTERNAL_API_BASE_URL:-http://localhost:$PORT}
export ORCH_LAUNCHER=mock

A=00000000-0000-0000-0000-0000000000a1
G=00000000-0000-0000-0000-0000000000b1
D=00000000-0000-0000-0000-0000000000d1
C=00000000-0000-0000-0000-0000000000c1
R=00000000-0000-0000-0000-0000000000e1

echo "== applying schema + seed =="
psql "$DATABASE_URL" -q -f migrations/0001_init.sql
psql "$DATABASE_URL" -q <<SQL
INSERT INTO accounts(id,name) VALUES ('$A','RTM') ON CONFLICT DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('$D','$A','p','[{"height":1080,"bitrate_kbps":5000}]','package_only') ON CONFLICT DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,max_concurrent) VALUES ('$G','$A','g','$D',10,5) ON CONFLICT DO NOTHING;
INSERT INTO channels(id,group_id,name,status) VALUES ('$C','$G','api-news','scheduled') ON CONFLICT DO NOTHING;
INSERT INTO recordings(id,kind,channel_id,day_utc,status,start_epoch_ms,master_key,hi_res_rendition) VALUES ('$R','channel_day','$C','2026-07-30','recording',0,'channel/$C','1080p') ON CONFLICT DO NOTHING;
SQL

echo "== starting API on :$PORT =="
fuser -k "$PORT"/tcp 2>/dev/null || true; sleep 1
npx tsx src/index.ts >/tmp/volt-capture.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -fsS "localhost:$PORT/health" >/dev/null 2>&1 && break || sleep 1; done

TOKEN=$(node -e "console.log(require('jsonwebtoken').sign({sub:'u',account_id:'$A',role:'owner'},process.env.JWT_ACCESS_SECRET,{expiresIn:3600}))")

echo "== capturing request/response for every endpoint =="
BASE_URL="http://localhost:$PORT" TOKEN="$TOKEN" INGEST_TOKEN="$INGEST_TOKEN" \
  GROUP_ID="$G" CHANNEL_ID="$C" RECORDING_ID="$R" \
  python3 /home/claude/capture_api.py

echo "== done =="
