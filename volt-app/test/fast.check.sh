#!/usr/bin/env bash
# FAST channels e2e: create a playlist channel, build a lineup (rotation pool +
# series slot), preview it, set ads (markers, house ads, slate), activate (the
# guide and its breaks are written), the playout timeline, the graphics
# triggers around a break, Go to break on a live channel, ad decisions from a
# fake VAST server (fill, timeout fallback), and the ad report.
# Run from volt-app/ with DATABASE_URL set.
#
# With FAST_LAB=<clips dir of packaged assets> (see docs/DESIGN_fast_channels.md,
# "Checking it") the library rows point at real media; without it, at fake keys.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8486}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*' ORCH_TICK_SECONDS=3600
export CLIPS_DIR="${CLIPS_DIR:-/tmp/fast_check_clips}" ORIGIN_DIR="${ORIGIN_DIR:-/tmp/fast_check_origin}"
mkdir -p "$CLIPS_DIR/vod" "$ORIGIN_DIR"
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4
npx tsx src/index.ts >/tmp/fast_check_api.log 2>&1 &
API=$!
for i in $(seq 1 80); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO accounts(id,name) VALUES ('0000000a-0000-0000-0000-0000000000f1'::uuid,'FastCo') ON CONFLICT (id) DO NOTHING;
INSERT INTO users(id,account_id,email,password_hash,role,status,display_name) VALUES
  ('0000000b-0000-0000-0000-0000000000f1'::uuid,'0000000a-0000-0000-0000-0000000000f1'::uuid,'fast@fastco.example','x','owner','active','Fast Admin')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES
  ('0000000c-0000-0000-0000-0000000000f1'::uuid,'0000000a-0000-0000-0000-0000000000f1'::uuid,'HD','[{"height":360,"bitrate_kbps":800}]','transcode')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id) VALUES
  ('0000000d-0000-0000-0000-0000000000f1'::uuid,'0000000a-0000-0000-0000-0000000000f1'::uuid,'G','0000000c-0000-0000-0000-0000000000f1'::uuid)
  ON CONFLICT (id) DO NOTHING;
UPDATE accounts SET max_channels = GREATEST(COALESCE(max_channels, 0), 20) WHERE id = '0000000a-0000-0000-0000-0000000000f1'::uuid;
UPDATE groups SET max_channels = GREATEST(COALESCE(max_channels, 0), 20) WHERE id = '0000000d-0000-0000-0000-0000000000f1'::uuid;
INSERT INTO channels(id,group_id,name,status,tz) VALUES
  ('0000000e-0000-0000-0000-0000000000f2'::uuid,'0000000d-0000-0000-0000-0000000000f1'::uuid,'Live News','live','Australia/Brisbane')
  ON CONFLICT (id) DO NOTHING;
SQL
npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE email='fast@fastco.example'\",[h]); await pool.end();})()" >/dev/null 2>&1
BASE="http://localhost:$PORT" npx tsx test/fast.http.ts
rc=$?
kill $API 2>/dev/null; wait $API 2>/dev/null
# npx leaves the server itself running; left behind, it keeps the scheduler lock
fuser -k "$PORT"/tcp 2>/dev/null
exit $rc
