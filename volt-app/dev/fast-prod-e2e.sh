#!/usr/bin/env bash
# FAST in its production shape on one box: moto (S3 + the "CDN"), redis
# (Valkey), two API processes (ROLE=all and ROLE=api-public), the playout
# configured as its ECS task is, and a signing edge in front of the bucket. See dev/fast-prod-e2e.ts for what it checks.
#
#   volt-app$ DATABASE_URL=... FAST_LAB=<lab> CHROME=<chromium> PACKAGER_BIN=<packager> bash dev/fast-prod-e2e.sh
#
# <lab>/clips/vod/<name>/ packaged assets (filmA filmB ep1 promo slate adX), SLATE_SRC (default <lab>/src/slate.mp4)
# a source the slate is re-encoded from. Chromium from Playwright plays VP9/Opus, not H.264: package the lab in VP9.
set -uo pipefail
pkill -f "bin/fast_playout[.]py" 2>/dev/null
cd "$(dirname "$0")/.."
S3P=${S3P:-5055}; CP=${CP:-5057}; RP=${RP:-6390}; PA=${PA:-8487}; PB=${PB:-8488}
export S3_BUCKET=volt-prod-e2e AWS_ENDPOINT_URL=http://127.0.0.1:$S3P S3_FORCE_PATH_STYLE=1
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
export CDN_BASE_URL=http://127.0.0.1:$CP REDIS_URL=redis://127.0.0.1:$RP
export JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z CORS_ORIGIN='*'
export ORCH_LAUNCHER=local FAST_OUTPUT=s3 VOD_STORE=s3 FAST_STALE_SEC=12
export CLIPS_DIR=/tmp/fast_prod_clips ORIGIN_DIR=/tmp/fast_prod_origin
mkdir -p "$CLIPS_DIR/vod" "$ORIGIN_DIR"
for p in $S3P $CP $RP $PA $PB 8499; do fuser -k $p/tcp 2>/dev/null; done; sleep 0.5
moto_server -p $S3P >/tmp/fast_prod_moto.log 2>&1 &
redis-server --port $RP --save '' --appendonly no >/tmp/fast_prod_redis.log 2>&1 &
for i in $(seq 1 40); do curl -sf "$AWS_ENDPOINT_URL" >/dev/null && break; sleep 0.25; done
python3 -c "import boto3; boto3.client('s3', endpoint_url='$AWS_ENDPOINT_URL').create_bucket(Bucket='$S3_BUCKET')"
python3 dev/fast-cdn-shim.py $CP >/tmp/fast_prod_cdn.log 2>&1 &   # CloudFront + OAC stand-in
PORT=$PA ROLE=all PUBLIC_BASE_URL=http://127.0.0.1:$PB npx tsx src/index.ts >/tmp/fast_prod_a.log 2>&1 &
PORT=$PB ROLE=api-public PUBLIC_BASE_URL=http://127.0.0.1:$PB npx tsx src/index.ts >/tmp/fast_prod_b.log 2>&1 &
for p in $PA $PB; do for i in $(seq 1 120); do curl -sf "http://localhost:$p/health" >/dev/null && break; sleep 0.25; done; done
BASE_A=http://127.0.0.1:$PA BASE_B=http://127.0.0.1:$PB npx tsx dev/fast-prod-e2e.ts
rc=$?
for p in $S3P $CP $RP $PA $PB; do fuser -k $p/tcp 2>/dev/null; done
pkill -f "bin/fast_playout[.]py" 2>/dev/null
exit $rc
