#!/usr/bin/env bash
# Settings lock while running: a running channel refuses CHANGES to what the
# encoder reads at start (sources, ladder, DVR, failover/filler, watermark,
# captions) with 409 locked_while_running, accepts the same values sent back,
# keeps everything else editable, exposes encoderRunning on the detail payload,
# and unlocks once stopped. Run from volt-app/ with DATABASE_URL set.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8493}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*'
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4
pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
B="http://localhost:$PORT"
ACC=0000000a-0000-0000-0000-0000000000d1
CH=0000000e-0000-0000-0000-0000000000d1

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO accounts(id,name) VALUES ('$ACC','LockCo') ON CONFLICT (id) DO NOTHING;
INSERT INTO users(id,account_id,email,password_hash,role,status,display_name) VALUES
  ('0000000b-0000-0000-0000-0000000000d1','$ACC','lock@lockco.example','x','owner','active','Lock Admin') ON CONFLICT (id) DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES
  ('0000000c-0000-0000-0000-0000000000d1','$ACC','HD','[{"height":360,"bitrate_kbps":800}]','transcode') ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id) VALUES
  ('0000000d-0000-0000-0000-0000000000d1','$ACC','G','0000000c-0000-0000-0000-0000000000d1') ON CONFLICT (id) DO NOTHING;
INSERT INTO channels(id,group_id,name,status) VALUES ('$CH','0000000d-0000-0000-0000-0000000000d1','Lock Channel','ended') ON CONFLICT (id) DO NOTHING;
DELETE FROM instances WHERE channel_id='$CH';
DELETE FROM stream_inputs WHERE channel_id='$CH';
INSERT INTO stream_inputs(channel_id,role,protocol,ingest_url) VALUES ('$CH','primary','hls','https://src.example/live/a.m3u8');
UPDATE channels SET dvr_mode='sliding', dvr_window_sec=600, input_loss_behavior='none', watermark_enabled=false WHERE id='$CH';
SQL
npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE email='lock@lockco.example'\",[h]); await pool.end();})()" >/dev/null 2>&1

npx tsx src/index.ts >/tmp/lock_api.log 2>&1 &
API=$!
for i in $(seq 1 60); do curl -sf "$B/health" >/dev/null && break; sleep 0.25; done
TOK=$(curl -s -X POST "$B/api/auth/login" -H 'content-type:application/json' -d '{"email":"lock@lockco.example","password":"volt1234"}' | sed -n 's/.*"access":"\([^"]*\)".*/\1/p')
A="authorization: Bearer $TOK"
ok "admin logged in" '[ -n "$TOK" ]'
patch(){ curl -s -o /tmp/lock_body -w '%{http_code}' -X PATCH "$B/api/channels/$CH" -H "$A" -H 'content-type:application/json' -d "$1"; }
detail(){ curl -s -H "$A" "$B/api/channels/$CH"; }

# ---- stopped: everything editable
C=$(patch '{"dvrWindowSec":900}')
ok "stopped: DVR window changes ($C)" '[ "$C" = 200 ]'
D=$(detail)
ok "detail says not running" 'echo "$D" | grep -q "\"encoderRunning\":false"'

# ---- start (mock launcher opens an instance)
curl -s -o /dev/null -X POST "$B/api/channels/$CH/start" -H "$A"
N=$(psql "$DATABASE_URL" -tA -c "SELECT count(*) FROM instances WHERE channel_id='$CH' AND terminated_at IS NULL")
ok "start opened an instance ($N)" '[ "$N" -ge 1 ]'
D=$(detail)
ok "detail says running and lists the locked keys" 'echo "$D" | grep -q "\"encoderRunning\":true" && echo "$D" | grep -q "\"lockedWhileRunning\":\[\"sources\""'

C=$(patch '{"sources":[{"role":"primary","protocol":"hls","ingestUrl":"https://other.example/b.m3u8"}]}')
ok "running: changing the source is refused ($C)" '[ "$C" = 409 ] && grep -q "locked_while_running" /tmp/lock_body && grep -q "Sources" /tmp/lock_body'
C=$(patch '{"sources":[{"role":"primary","protocol":"hls","ingestUrl":"https://src.example/live/a.m3u8"}]}')
ok "running: re-sending the same source is accepted ($C)" '[ "$C" = 200 ]'
C=$(patch '{"dvrWindowSec":1200}')
ok "running: DVR window change refused ($C)" '[ "$C" = 409 ] && grep -q "DVR window" /tmp/lock_body'
C=$(patch '{"dvrWindowSec":900}')
ok "running: same DVR window accepted ($C)" '[ "$C" = 200 ]'
C=$(patch '{"outputLadder":[{"height":720,"bitrateKbps":2800}]}')
ok "running: ladder change refused ($C)" '[ "$C" = 409 ] && grep -q "Output ladder" /tmp/lock_body'
C=$(patch '{"watermark":{"enabled":true}}')
ok "running: watermark change refused ($C)" '[ "$C" = 409 ] && grep -q "Watermark" /tmp/lock_body'
C=$(patch '{"inputLossBehavior":"slate","fillerSlateRef":"/library/x/s.png"}')
ok "running: filler change refused and both fields named ($C)" '[ "$C" = 409 ] && grep -q "On total source loss" /tmp/lock_body && grep -q "Fallback slate or loop" /tmp/lock_body'
C=$(patch '{"captions":{"enabled":true,"targets":["en","fr"]}}')
ok "running: captions change refused ($C)" '[ "$C" = 409 ] && grep -q "Subtitles" /tmp/lock_body'
C=$(patch '{"name":"Lock Channel Renamed","geoMode":"block","geoCountries":["NZ"],"epgEnabled":false,"autoConnect":false}')
ok "running: name, geo, guide and auto connect still save ($C)" '[ "$C" = 200 ]'
C=$(patch '{"name":"Lock Channel 2","dvrWindowSec":1500}')
ok "running: a mixed edit is refused whole, nothing half-saved ($C)" '[ "$C" = 409 ] && [ "$(psql "$DATABASE_URL" -tA -c "SELECT name FROM channels WHERE id='"'"'$CH'"'"'")" = "Lock Channel Renamed" ]'
SRC=$(psql "$DATABASE_URL" -tA -c "SELECT ingest_url FROM stream_inputs WHERE channel_id='$CH'")
ok "source untouched by the refused edit" '[ "$SRC" = "https://src.example/live/a.m3u8" ]'

# ---- stop: unlocked again
curl -s -o /dev/null -X POST "$B/api/channels/$CH/stop" -H "$A"
C=$(patch '{"dvrWindowSec":1200,"sources":[{"role":"primary","protocol":"hls","ingestUrl":"https://other.example/b.m3u8"}]}')
ok "stopped again: the same changes now save ($C)" '[ "$C" = 200 ]'

kill $API 2>/dev/null
echo; echo "settings-lock.check: $pass passed, $fail failed"
[ "$fail" = 0 ]
