#!/usr/bin/env bash
# CPU AND DATA RECEIVED ON THE GATES, and STOPPED ON PURPOSE IS NOT AN ERROR.
#   * an encoder heartbeat carrying metrics is stored; the channel page gets the
#     encoder's CPU and each input's rate and total;
#   * a heartbeat without metrics keeps the last reading; a stale one is dropped;
#   * without an encoder reading, the host's sampled CPU stands in, marked as such;
#   * Stop records "stop command issued" in the log and the channel then reads
#     STOPPED with no error, whatever the teardown reported; Start logs its own.
# Run from volt-app/ with DATABASE_URL set (migration 0054 applied).
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8533}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*' \
  PUBLIC_BASE_URL="http://localhost:$PORT" THUMBS_ENABLED=0
pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
B="http://localhost:$PORT/api"; J='content-type:application/json'
ACC=0000000a-0000-0000-0000-00000000d701; ADM=0000000b-0000-0000-0000-00000000d701
G=0000000d-0000-0000-0000-00000000d701; CH=0000000e-0000-0000-0000-00000000d701; P1=0000000c-0000-0000-0000-00000000d701
q(){ psql "$DATABASE_URL" -tA -c "$1"; }
jget(){ python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO accounts(id,name,max_channels) VALUES ('$ACC','MeterCo',10) ON CONFLICT (id) DO NOTHING;
INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES ('$ADM','$ACC','adm@meterco.example','x','admin','active') ON CONFLICT (id) DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('$P1','$ACC','Pkg','[]','package_only') ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,is_default) VALUES ('$G','$ACC','Main','$P1',10,true) ON CONFLICT (id) DO NOTHING;
INSERT INTO channels(id,group_id,name,status,kind) VALUES ('$CH','$G','Meter TV','ended','tv') ON CONFLICT (id) DO NOTHING;
DELETE FROM stream_inputs WHERE channel_id='$CH';
INSERT INTO stream_inputs(channel_id,role,protocol,ingest_url,rendition_label,rendition_bitrate_kbps) VALUES ('$CH','primary','hls','http://example.invalid/720p.m3u8','720p',2800);
DELETE FROM stream_status WHERE channel_id='$CH'; DELETE FROM stream_events WHERE channel_id='$CH';
UPDATE instances SET terminated_at=now() WHERE channel_id='$CH' AND terminated_at IS NULL;
UPDATE channels SET status='ended', desired_state='stopped', stop_requested_at=NULL, stop_requested_by=NULL WHERE id='$CH';
SQL
npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE id='$ADM'\",[h]); await pool.end();})()" >/dev/null 2>&1
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4
npx tsx src/index.ts >/tmp/stream_metrics_api.log 2>&1 & API=$!
trap 'kill $API 2>/dev/null' EXIT
for i in $(seq 1 80); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
A="authorization: Bearer $(curl -s -X POST "$B/auth/login" -H "$J" -d '{"email":"adm@meterco.example","password":"volt1234"}' | sed -n 's/.*"access":"\([^"]*\)".*/\1/p')"
I="X-Volt-Ingest-Token: z"

echo "-- start (mock launcher), then the encoder's heartbeat"
curl -s -o /dev/null -X POST "$B/channels/$CH/start" -H "$A"
ok "Start logs that a start command was issued" '[ "$(q "SELECT count(*) FROM stream_events WHERE channel_id='"'"'$CH'"'"' AND type='"'"'start.requested'"'"'")" = 1 ]'
rep(){ curl -s -o /dev/null -w '%{http_code}' -X POST "$B/streams/$CH/report" -H "$I" -H "$J" -d "$1"; }
BOOT=$(date +%s%3N)
ok "a heartbeat with metrics is accepted" '[ "$(rep "{\"kind\":\"channel\",\"id\":\"$CH\",\"status\":{\"output_available\":true,\"active_source\":\"primary\",\"fallback_in_use\":false,\"filler_in_use\":false,\"packager_ok\":true,\"sources\":{\"primary\":{\"state\":\"up\"}},\"seq\":1,\"boot_ms\":$BOOT,\"metrics\":{\"cpu_pct\":37.5,\"cpu_cores\":2,\"ingest\":{\"primary:720p\":{\"role\":\"primary\",\"label\":\"720p\",\"bytes\":5000000,\"bps\":2700000}}}}}")" = 202 ]'
D=$(curl -s "$B/channels/$CH" -H "$A")
ok "the channel page gets the encoder's CPU" '[ "$(echo "$D" | jget "(d[\"metrics\"][\"cpu\"][\"pct\"], d[\"metrics\"][\"cpu\"][\"source\"])")" = "(37.5, '"'"'encoder'"'"')" ]'
ok "...and the input's rate and total" '[ "$(echo "$D" | jget "(d[\"metrics\"][\"ingest\"][0][\"bps\"], d[\"metrics\"][\"ingest\"][0][\"bytes\"], d[\"metrics\"][\"ingest\"][0][\"label\"])")" = "(2700000, 5000000, '"'"'720p'"'"')" ]'
rep "{\"kind\":\"channel\",\"id\":\"$CH\",\"status\":{\"output_available\":true,\"active_source\":\"primary\",\"fallback_in_use\":false,\"filler_in_use\":false,\"packager_ok\":true,\"sources\":{\"primary\":{\"state\":\"up\"}},\"seq\":2,\"boot_ms\":$BOOT}}" >/dev/null
ok "a report without metrics keeps the last reading" '[ "$(curl -s "$B/channels/$CH" -H "$A" | jget "d[\"metrics\"][\"cpu\"][\"pct\"]")" = 37.5 ]'
q "UPDATE stream_status SET metrics = jsonb_set(metrics, '{at_ms}', to_jsonb((extract(epoch from now())*1000 - 120000)::bigint)) WHERE channel_id='$CH'" >/dev/null
ok "a reading two minutes old is not shown as current" '[ "$(curl -s "$B/channels/$CH" -H "$A" | jget "(d[\"metrics\"][\"cpu\"], d[\"metrics\"][\"ingest\"])")" = "(None, [])" ]'
HOST=$(q "SELECT host_id FROM instances WHERE channel_id='$CH' AND terminated_at IS NULL AND host_id IS NOT NULL LIMIT 1")
if [ -n "$HOST" ]; then
  q "INSERT INTO host_samples(host_id, source, cpu_pct, tasks_on_host) VALUES ('$HOST','onbox',61.0,3)" >/dev/null
  ok "without an encoder reading, the host CPU stands in, marked as the host's" '[ "$(curl -s "$B/channels/$CH" -H "$A" | jget "(d[\"metrics\"][\"cpu\"][\"pct\"], d[\"metrics\"][\"cpu\"][\"source\"], d[\"metrics\"][\"cpu\"][\"tasksOnHost\"])")" = "(61.0, '"'"'host'"'"', 3)" ]'
fi

echo "-- stop: on purpose, no errors"
curl -s -o /dev/null -X POST "$B/channels/$CH/stop" -H "$A"
# the teardown's own noise arriving after the stop
rep "{\"kind\":\"channel\",\"id\":\"$CH\",\"event\":{\"type\":\"input.error\",\"detail\":{\"message\":\"relay killed\"}}}" >/dev/null
rep "{\"kind\":\"channel\",\"id\":\"$CH\",\"event\":{\"type\":\"channel.stop\",\"detail\":{\"reason\":\"exited rc=255\"}}}" >/dev/null
D=$(curl -s "$B/channels/$CH" -H "$A")
ok "Stop logs that a stop command was issued" '[ "$(q "SELECT count(*) FROM stream_events WHERE channel_id='"'"'$CH'"'"' AND type='"'"'stop.requested'"'"'")" = 1 ]'
ok "after Stop the channel reads STOPPED, with no error" '[ "$(echo "$D" | jget "(d[\"health\"][\"overall\"], d[\"health\"][\"primaryError\"])")" = "('"'"'stopped'"'"', None)" ]'
ok "...no gate is red or amber" '[ "$(echo "$D" | jget "any(g[\"status\"] in (\"failed\",\"degraded\") for g in d[\"health\"][\"gates\"])")" = False ]'
ok "...and the list agrees" '[ "$(curl -s "$B/channels" -H "$A" | jget "[c.get(\"pipelineState\") for c in d if c[\"id\"]==\"$CH\"][0]")" = stopped ]'
ok "no metrics while stopped" '[ "$(echo "$D" | jget "d[\"metrics\"]")" = None ]'

echo; echo "stream-metrics: $pass passed, $fail failed"
[ "$fail" = 0 ]
