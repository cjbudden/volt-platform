#!/usr/bin/env bash
# EPG repeats e2e: copy day with preview/rules/undo, day repeat, programme
# repeat, both together, scoped edits and deletes, top-up idempotency, clear
# day undo, event repeats. Run from volt-app/ with DATABASE_URL set.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8484}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*' ORCH_TICK_SECONDS=3600
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4
npx tsx src/index.ts >/tmp/epg_repeat_api.log 2>&1 &
API=$!
for i in $(seq 1 60); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
# Fixture ids end in e7. They used to end in b1, the ids scripts/seed-check.ts
# gives root@adminco.example, so in the seeded check database the user insert
# was skipped by ON CONFLICT and the suite could never sign in.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO accounts(id,name) VALUES ('0000000a-0000-0000-0000-0000000000e7'::uuid,'RepeatCo') ON CONFLICT (id) DO NOTHING;
INSERT INTO users(id,account_id,email,password_hash,role,status,display_name) VALUES
  ('0000000b-0000-0000-0000-0000000000e7'::uuid,'0000000a-0000-0000-0000-0000000000e7'::uuid,'rep@repeatco.example','x','owner','active','Rep Admin')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES
  ('0000000c-0000-0000-0000-0000000000e7'::uuid,'0000000a-0000-0000-0000-0000000000e7'::uuid,'HD','[{"height":360,"bitrate_kbps":800}]','transcode')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id) VALUES
  ('0000000d-0000-0000-0000-0000000000e7'::uuid,'0000000a-0000-0000-0000-0000000000e7'::uuid,'G','0000000c-0000-0000-0000-0000000000e7'::uuid)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO channels(id,group_id,name,status,tz) VALUES
  ('0000000e-0000-0000-0000-0000000000bb'::uuid,'0000000d-0000-0000-0000-0000000000e7'::uuid,'Repeat Channel','ended','Australia/Sydney')
  ON CONFLICT (id) DO NOTHING;
DELETE FROM programmes WHERE channel_id='0000000e-0000-0000-0000-0000000000bb'::uuid;
DELETE FROM programme_series WHERE channel_id='0000000e-0000-0000-0000-0000000000bb'::uuid;
DELETE FROM events WHERE name='Repeat Event';
SQL
npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE email='rep@repeatco.example'\",[h]); await pool.end();})()" >/dev/null 2>&1
BASE="http://localhost:$PORT" npx tsx test/epg-repeat.http.ts
rc=$?
kill $API 2>/dev/null; wait $API 2>/dev/null
exit $rc
