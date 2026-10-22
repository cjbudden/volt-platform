#!/usr/bin/env bash
# THE EVENT PAGE'S THREE CHANNEL ROUTES, FOR EVENTS (build queue 1.2).
# The event page is built from the channel page's panels, and three of them
# called channel-only routes that answer 404 for an event. Now:
#   * GET  /api/events/:id/access-check          (view as a viewer elsewhere)
#   * GET  /api/events/:id/inputs/:inputId/preview (source preview relay)
#   * POST /api/events/:id/health/reset          (Clear QC; also /reset-health)
# Each answers for the caller's own event only (404 for another account's),
# in the same shape as the channel route, and the preview token it issues
# reaches the event's input and nothing else.
# Run from volt-app/ with DATABASE_URL set.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8537}"; HP=8538
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*' \
  PUBLIC_BASE_URL="http://localhost:$PORT" THUMBS_ENABLED=0
pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
B="http://localhost:$PORT/api"; J='content-type:application/json'
ACC=0000000a-0000-0000-0000-00000000e201; ADM=0000000b-0000-0000-0000-00000000e201
G=0000000d-0000-0000-0000-00000000e201; P1=0000000c-0000-0000-0000-00000000e201
CH=0000000e-0000-0000-0000-00000000e201; EV=00000010-0000-0000-0000-00000000e201
IN1=0000000f-0000-0000-0000-00000000e201; IN2=0000000f-0000-0000-0000-00000000e202; INC=0000000f-0000-0000-0000-00000000e203
ACC2=0000000a-0000-0000-0000-00000000e202; G2=0000000d-0000-0000-0000-00000000e202; EV2=00000010-0000-0000-0000-00000000e202
IN3=0000000f-0000-0000-0000-00000000e204
q(){ psql "$DATABASE_URL" -tA -c "$1"; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }
jget(){ python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
keys(){ python3 -c "import json,sys; print(','.join(sorted(json.load(sys.stdin).keys())))"; }

D=$(mktemp -d); mkdir -p "$D/v0"
printf '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\nv0/index.m3u8\n' > "$D/master.m3u8"
printf '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\ns0.ts\n#EXT-X-ENDLIST\n' > "$D/v0/index.m3u8"
head -c 4096 /dev/urandom > "$D/v0/s0.ts"
(cd "$D" && exec python3 -m http.server $HP >/dev/null 2>&1) & HTTPD=$!

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO accounts(id,name,max_channels) VALUES ('$ACC','EventRoutesCo',10),('$ACC2','OtherCo',10) ON CONFLICT (id) DO NOTHING;
-- Account-wide geo: nothing from IL. Set before the API starts (it is cached).
UPDATE accounts SET geo_access='{"mode":"block","countries":["IL"]}'::jsonb WHERE id='$ACC';
INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES ('$ADM','$ACC','adm@eventroutes.example','x','admin','active') ON CONFLICT (id) DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('$P1','$ACC','Pkg','[]','package_only') ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,is_default) VALUES ('$G','$ACC','Main','$P1',10,true),('$G2','$ACC2','Main','$P1',10,true) ON CONFLICT (id) DO NOTHING;
INSERT INTO channels(id,group_id,name,status,kind) VALUES ('$CH','$G','Routes TV','ended','tv') ON CONFLICT (id) DO NOTHING;
INSERT INTO events(id,group_id,name,status,scheduled_start,scheduled_end) VALUES
  ('$EV','$G','Cup Final','ended',now()-interval '2 hours',now()-interval '1 hour'),
  ('$EV2','$G2','Other Final','ended',now()-interval '2 hours',now()-interval '1 hour') ON CONFLICT (id) DO NOTHING;
UPDATE events SET resume_gave_up_at=now(), resume_last_error='exited rc=1', desired_state='running' WHERE id='$EV';
INSERT INTO stream_inputs(id,event_id,role,protocol,ingest_url) VALUES
  ('$IN1','$EV','primary','hls','http://localhost:$HP/master.m3u8'),
  ('$IN2','$EV','backup','srt','srt://localhost:9000'),
  ('$IN3','$EV2','primary','hls','http://localhost:$HP/master.m3u8') ON CONFLICT (id) DO NOTHING;
INSERT INTO stream_inputs(id,channel_id,role,protocol,ingest_url) VALUES ('$INC','$CH','primary','hls','http://localhost:$HP/master.m3u8') ON CONFLICT (id) DO NOTHING;
-- An earlier run of the event crashed: the health model reads it as an error.
INSERT INTO stream_events(event_id,type,detail,ts) VALUES
  ('$EV','channel.start','{}',now()-interval '300 seconds'),
  ('$EV','channel.stop','{"reason":"exited rc=1"}',now()-interval '240 seconds');
SQL
npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE id='$ADM'\",[h]); await pool.end();})()" >/dev/null 2>&1
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4
npx tsx src/index.ts >/tmp/event_routes_api.log 2>&1 & API=$!
trap 'kill $API $HTTPD 2>/dev/null; rm -rf "$D"' EXIT
for i in $(seq 1 80); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
A="authorization: Bearer $(curl -s -X POST "$B/auth/login" -H "$J" -d '{"email":"adm@eventroutes.example","password":"volt1234"}' | sed -n 's/.*"access":"\([^"]*\)".*/\1/p')"

echo "-- access check"
chk(){ curl -s "$B/events/$EV/access-check?country=$1" -H "$A" | jget '(d["allowed"], d["layer"])'; }
ok "a viewer in AU can watch the event" '[ "$(chk AU)" = "(True, '"'"'none'"'"')" ]'
ok "a viewer in IL is refused by the account layer" '[ "$(chk IL)" = "(False, '"'"'account'"'"')" ]'
ok "same answer shape as the channel route" '[ "$(curl -s "$B/events/$EV/access-check?country=AU" -H "$A" | keys)" = "$(curl -s "$B/channels/$CH/access-check?country=AU" -H "$A" | keys)" ]'
ok "the channel route agrees for the same account (IL)" '[ "$(curl -s "$B/channels/$CH/access-check?country=IL" -H "$A" | jget "d[\"layer\"]")" = account ]'
ok "needs a two-letter country (400)" '[ "$(code "$B/events/$EV/access-check?country=Israel" -H "$A")" = 400 ]'
ok "another account's event is not found (404)" '[ "$(code "$B/events/$EV2/access-check?country=AU" -H "$A")" = 404 ]'
ok "not without signing in (401)" '[ "$(code "$B/events/$EV/access-check?country=AU")" = 401 ]'

echo "-- source preview"
U=$(curl -s "$B/events/$EV/inputs/$IN1/preview" -H "$A" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
ok "a preview address is issued for the event's HLS input" '[[ "$U" == /api/source-preview/*/index.m3u8 ]]'
ok "same answer shape as the channel route" '[ "$(curl -s "$B/events/$EV/inputs/$IN1/preview" -H "$A" | keys)" = "$(curl -s "$B/channels/$CH/inputs/$INC/preview" -H "$A" | keys)" ]'
M=$(curl -s "http://localhost:$PORT$U")
ok "the relay plays the event's input (child playlist rewritten)" 'echo "$M" | grep -q "^pl?u=.*&s=" && ! echo "$M" | grep -q "localhost:$HP"'
BASE=$(dirname "$U"); CHILD=$(echo "$M" | grep "^pl?" | head -1)
SEG=$(curl -s "http://localhost:$PORT$BASE/$CHILD" | grep "^seg?" | head -1)
curl -s "http://localhost:$PORT$BASE/$SEG" -o "$D/got.ts"
ok "a segment passes through byte for byte" 'cmp -s "$D/got.ts" "$D/v0/s0.ts"'
ok "not for a push (SRT) input (400)" '[ "$(code "$B/events/$EV/inputs/$IN2/preview" -H "$A")" = 400 ]'
ok "not for a channel's input asked for through the event (404)" '[ "$(code "$B/events/$EV/inputs/$INC/preview" -H "$A")" = 404 ]'
ok "not for another account's event (404)" '[ "$(code "$B/events/$EV2/inputs/$IN3/preview" -H "$A")" = 404 ]'
# A token is bound to its owner kind: an event token re-labelled as a channel's
# (the k claim dropped) no longer verifies, and the channel query would not find it.
FORGED=$(python3 - "$U" <<'PY'
import sys,base64,json
tok=sys.argv[1].split('/')[3]; body,sig=tok.split('.')
c=json.loads(base64.urlsafe_b64decode(body+'='*(-len(body)%4))); c.pop('k',None)
print(base64.urlsafe_b64encode(json.dumps(c).encode()).decode().rstrip('=')+'.'+sig)
PY
)
ok "an event token with its kind stripped is refused (403)" '[ "$(code "http://localhost:$PORT/api/source-preview/$FORGED/index.m3u8")" = 403 ]'
CU=$(curl -s "$B/channels/$CH/inputs/$INC/preview" -H "$A" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
ok "the channel preview still works (no kind in its token)" 'curl -s "http://localhost:$PORT$CU" | grep -q "^pl?u="'

echo "-- Clear QC"
H(){ curl -s "$B/events/$EV/detail" -H "$A" | jget 'd["health"]["overall"]'; }
ok "before: the crashed event reads as an error" '[ "$(H)" = error ]'
R=$(curl -s -X POST "$B/events/$EV/health/reset" -H "$A")
ok "the reset answers was=error" '[ "$(echo "$R" | jget "d[\"was\"]")" = error ]'
ok "...and is no longer red" '[ "$(echo "$R" | jget "d[\"overall\"]")" != error ] && [ "$(echo "$R" | jget "d[\"primaryError\"]")" = None ]'
ok "the event page agrees after the reset" '[ "$(H)" != error ]'
ok "a qc.reset event is in the event's log, the crash kept" '[ "$(q "SELECT count(*) FROM stream_events WHERE event_id='"'"'$EV'"'"' AND type='"'"'qc.reset'"'"'")" = 1 ] && [ "$(q "SELECT count(*) FROM stream_events WHERE event_id='"'"'$EV'"'"' AND type='"'"'channel.stop'"'"'")" = 1 ]'
ok "the auto connect give-up is cleared and the stopped event stood down" '[ "$(q "SELECT (resume_gave_up_at IS NULL)::text || desired_state FROM events WHERE id='"'"'$EV'"'"'")" = truestopped ]'
ok "the reset is audited against the event" '[ "$(q "SELECT count(*) FROM audit_log WHERE entity_type='"'"'event'"'"' AND entity_id='"'"'$EV'"'"'")" -ge 1 ]'
ok "same answer shape as the channel route" '[ "$(echo "$R" | keys)" = "$(curl -s -X POST "$B/channels/$CH/reset-health" -H "$A" | keys)" ]'
ok "the channel path /reset-health answers for an event too" '[ "$(code -X POST "$B/events/$EV/reset-health" -H "$A")" = 200 ]'
ok "another account's event is not found (404)" '[ "$(code -X POST "$B/events/$EV2/health/reset" -H "$A")" = 404 ]'
ok "not without signing in (401)" '[ "$(code -X POST "$B/events/$EV/health/reset")" = 401 ]'
ok "nothing was written for the other account's event" '[ "$(q "SELECT count(*) FROM stream_events WHERE event_id='"'"'$EV2'"'"' AND type='"'"'qc.reset'"'"'")" = 0 ]'

NEED=$(npx tsx -e "import {requirementFor} from './src/auth/roles'; (async()=>{const o=[]; for (const p of ['/api/events/$EV/health/reset','/api/events/$EV/reset-health']){const q:any=await requirementFor('POST',p); o.push(q?q.features.join('/')+':'+q.level:'none')} console.log(o.join(' ')); process.exit(0)})()" 2>/dev/null | tail -1)
ok "Clear QC on an event needs events: operate, as start and stop do" '[ "$NEED" = "events:operate events:operate" ]'

echo; echo "event-routes: $pass passed, $fail failed"
[ "$fail" = 0 ]
