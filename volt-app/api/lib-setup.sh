#!/usr/bin/env bash
# Shared by capture_api.sh and verify.sh: a throwaway database, the API running
# on it with test settings, the seeded test users, and a channel group,
# channel (with a source), recording and VOD asset.
# Leaves: PORT, SRV (the server pid), ACCOUNT_ID, G, C, R, V.
: "${DATABASE_URL:?set DATABASE_URL to a throwaway Postgres database (it is recreated)}"
DB_NAME="${DATABASE_URL##*/}"; DB_NAME="${DB_NAME%%\?*}"
ADMIN_URL="${DATABASE_URL%/*}/postgres"
export JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET:-capture-access-secret}
export JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET:-capture-refresh-secret}
export INGEST_TOKEN=${INGEST_TOKEN:-dev-ingest}
export PORT=${PORT:-8180}
export ORCH_LAUNCHER=mock PREWARM_ENABLED=false NODE_ENV=development
export SECURITY_CODE_ECHO=1 SMS_PROVIDER=log SMTP_URL= NOTIFY_FROM=
export SEED_DOMAIN=${SEED_DOMAIN:-volt.test} SEED_PASSWORD=${SEED_PASSWORD:-VoltTest!2026} SEED_PLATFORM_STAFF=1
export KEY_USAGE_FLUSH_SEC=1

echo "== fresh database $DB_NAME =="
psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE)" -c "CREATE DATABASE \"$DB_NAME\""

echo "== starting the API on :$PORT =="
fuser -k "$PORT"/tcp 2>/dev/null || true
npx tsx src/index.ts >/tmp/volt-capture.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true; fuser -k "$PORT"/tcp 2>/dev/null || true' EXIT
for i in $(seq 1 90); do curl -fsS "localhost:$PORT/health/ready" >/dev/null 2>&1 && break || sleep 1; done
curl -fsS "localhost:$PORT/health/ready" >/dev/null || { tail -40 /tmp/volt-capture.log; exit 1; }

echo "== seeding test users =="
SEED_OUT=$(npx tsx scripts/seed-access.ts)
echo "$SEED_OUT" | sed -n '1,14p'
ACCOUNT_ID=$(echo "$SEED_OUT" | sed -n 's/^Account \([0-9a-f-]\{36\}\).*/\1/p')
G=00000000-0000-0000-0000-0000000000b1
D=00000000-0000-0000-0000-0000000000d1
C=00000000-0000-0000-0000-0000000000c1
R=00000000-0000-0000-0000-0000000000e1
V=00000000-0000-0000-0000-0000000000f1
psql "$DATABASE_URL" -q <<SQL
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('$D','$ACCOUNT_ID','Pass-through','[{"height":1080,"bitrate_kbps":5000}]','package_only') ON CONFLICT DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,max_concurrent) VALUES ('$G','$ACCOUNT_ID','RTM Main','$D',10,5) ON CONFLICT DO NOTHING;
INSERT INTO channels(id,group_id,name,status) VALUES ('$C','$G','api-news','scheduled') ON CONFLICT DO NOTHING;
INSERT INTO stream_inputs(channel_id,role,protocol,ingest_url) VALUES ('$C','primary','srt','srt://contribution.example:9000?streamid=api-news');
INSERT INTO recordings(id,kind,channel_id,day_utc,status,start_epoch_ms,master_key,hi_res_rendition) VALUES ('$R','channel_day','$C','2026-07-30','recording',0,'channel/$C','1080p') ON CONFLICT DO NOTHING;
INSERT INTO vod_assets(id,channel_id,recording_id,kind,title,master_key,start_epoch_ms,end_epoch_ms,duration_ms) VALUES ('$V','$C','$R','clip','Opening highlight','vod/$V/master.m3u8',0,60000,60000) ON CONFLICT DO NOTHING;
SQL

