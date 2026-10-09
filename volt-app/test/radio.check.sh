#!/usr/bin/env bash
# Radio (audio-only) end-to-end, fully offline via the Icecast simulator:
#   - create a radio station (kind=radio, icecast source, mp3+hls+dash outputs)
#   - start: audio-only HLS master + fMP4 segments + PDT, DASH manifest,
#     MP3 fan-out with ICY headers + injected StreamTitle
#   - ICY capture: now-playing changes become timed programme rows with
#     song/ad/content classification; /log search + class filter; EPG reuse
#   - stop: recording closes; timeline is audioOnly with spans; audio-only
#     range master/media playlists serve; mp3 endpoint 404s
# Run from volt-app/ with DATABASE_URL set. Needs ffmpeg + node.
set -uo pipefail
cd "$(dirname "$0")/.."
. "$(dirname "$0")/lib/portable.sh"   # setsid/timeout/stat differ on macOS; see that file
PORT="${PORT:-8490}"
SIMPORT="${SIMPORT:-9156}"
# PINNED TO THE LEGACY PATH ON PURPOSE. RADIO_MODE now defaults to 'container',
# and this suite covers the in-process pipeline that is being retired: the MP3
# fan-out with per-listener ICY injection, and the on-air gate enforced by the
# control plane holding the socket. The container path has its own end-to-end
# suite against a real relay (radio-container.check.sh). When the in-process
# path is deleted, this pin and the assertions that depend on it go with it.
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*' RADIO_MODE=inprocess
fuser -k "$PORT"/tcp 2>/dev/null; fuser -k "$SIMPORT"/tcp 2>/dev/null; sleep 0.4

pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }
J(){ python3 -c "
import json,sys
try:
  d=json.loads(sys.argv[1])
  for k in sys.argv[2].split('.'):
    d=d[int(k)] if isinstance(d,list) else d.get(k)
    if d is None: break
  print('' if d is None else d)
except Exception: print('')
" "$1" "$2"; }

# ---- fixtures: loop mp3 + icecast simulator (4s title rotation) --------------
LOOP=/tmp/radio_loop_e2e.mp3
[ -f "$LOOP" ] || ffmpeg -hide_banner -loglevel error -f lavfi -i "sine=frequency=220:beep_factor=4:duration=30" \
  -filter_complex "aformat=channel_layouts=stereo,volume=0.6" -c:a libmp3lame -b:a 128k "$LOOP" -y
node test/icecast-sim.js "$SIMPORT" "$LOOP" 4 >/tmp/radio_sim.log 2>&1 &
SIM=$!
sleep 1

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
-- instances rows block channel deletion (FK SET NULL vs owner CHECK): clear them first
DELETE FROM instances WHERE channel_id IN (
  SELECT c.id FROM channels c JOIN groups g ON g.id=c.group_id
   JOIN accounts a ON a.id=g.account_id WHERE a.name='RadioCo');
DELETE FROM accounts WHERE name='RadioCo';
DELETE FROM users WHERE email='radio@radioco.example';
INSERT INTO accounts(id,name) VALUES ('0000000a-0000-0000-0000-0000000000c1'::uuid,'RadioCo');
INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES
  ('0000000b-0000-0000-0000-0000000000c1'::uuid,'0000000a-0000-0000-0000-0000000000c1'::uuid,'radio@radioco.example','x','owner','active');
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES
  ('0000000c-0000-0000-0000-0000000000c1'::uuid,'0000000a-0000-0000-0000-0000000000c1'::uuid,'Audio','[]','package_only');
INSERT INTO groups(id,account_id,name,output_profile_id) VALUES
  ('0000000d-0000-0000-0000-0000000000c1'::uuid,'0000000a-0000-0000-0000-0000000000c1'::uuid,'Stations','0000000c-0000-0000-0000-0000000000c1'::uuid);
SQL

npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE email='radio@radioco.example'\",[h]); await pool.end();})()" >/dev/null 2>&1

npx tsx src/index.ts >/tmp/radio_check_api.log 2>&1 &
API=$!
for i in $(seq 1 40); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
sleep 1
B="http://localhost:$PORT/api"

TOK=$(J "$(curl -s -X POST "$B/auth/login" -H 'content-type:application/json' -d '{"email":"radio@radioco.example","password":"volt1234"}')" access)
A="authorization: Bearer $TOK"
ok "owner logged in" '[ -n "$TOK" ]'

# ---- create ------------------------------------------------------------------
CH=$(curl -s -X POST "$B/channels" -H "$A" -H 'content-type:application/json' -d "{
  \"groupId\":\"0000000d-0000-0000-0000-0000000000c1\",\"name\":\"Sim FM e2e\",\"kind\":\"radio\",
  \"radio\":{\"bitrateKbps\":128,\"metadataCapture\":true,\"outputs\":{\"mp3\":true,\"hls\":true,\"dash\":true}},
  \"sources\":[{\"role\":\"primary\",\"protocol\":\"icecast\",\"ingestUrl\":\"http://localhost:$SIMPORT/live\"}]}")
CID=$(J "$CH" id)
ok "radio station created (kind=radio, icecast source)" '[ -n "$CID" ] && [ "$(J "$CH" kind)" = radio ]'
LIST=$(curl -s "$B/radio" -H "$A")
ok "station appears on /api/radio with output urls" 'echo "$LIST" | grep -q "$CID" && echo "$LIST" | grep -q "stream.mp3"'
ok "tv list does not show the station" '! curl -s "$B/channels?kind=tv" -H "$A" | grep -q "$CID"'

# ---- start + outputs -----------------------------------------------------------
S=$(curl -s -X POST "$B/radio/$CID/start" -H "$A")
ok "start returns live + running pipeline" '[ "$(J "$S" status)" = live ] && [ "$(J "$S" pipeline.running)" = True ]'
sleep 14
M=$(curl -s "http://localhost:$PORT/origin/$CID/live/master.m3u8")
ok "HLS master is audio-only (mp4a, no avc1)" 'echo "$M" | grep -q "mp4a.40.2" && ! echo "$M" | grep -q avc1'
PL=$(curl -s "http://localhost:$PORT/origin/$CID/live/audio/index.m3u8")
ok "audio playlist has fMP4 segments + PDT" 'echo "$PL" | grep -q "seg_00000.m4s" && echo "$PL" | grep -q PROGRAM-DATE-TIME && echo "$PL" | grep -q "init.mp4"'
ok "DASH manifest serves" '[ "$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/origin/$CID/live/dash/manifest.mpd")" = 200 ]'
curl -s -H 'Icy-MetaData: 1' -D /tmp/rc_mp3h.txt -o /tmp/rc_mp3b.bin --max-time 4 "http://localhost:$PORT/radio/$CID/stream.mp3" || true
ok "MP3 fan-out: ICY headers + audio bytes" 'grep -qi "icy-metaint" /tmp/rc_mp3h.txt && [ "$(vsize /tmp/rc_mp3b.bin)" -gt 20000 ]'
ok "MP3 fan-out: StreamTitle injected" 'grep -aq "StreamTitle=" /tmp/rc_mp3b.bin'

# ---- metadata log ---------------------------------------------------------------
sleep 12   # let several rotations land (sim rotates every 4s)
NP=$(curl -s "$B/radio/$CID/nowplaying" -H "$A")
ok "nowplaying: title + class + station headers" '[ -n "$(J "$NP" title)" ] || [ "$(J "$NP" class)" = ad ]; [ "$(J "$NP" station.name)" = "Sim FM" ]'
LOG=$(curl -s "$B/radio/$CID/log" -H "$A")
NSONG=$(J "$LOG" counts.song); NAD=$(J "$LOG" counts.ad); NCON=$(J "$LOG" counts.content)
ok "log has classified entries (song+ad+content)" '[ "${NSONG:-0}" -ge 1 ] && [ "${NAD:-0}" -ge 1 ] && [ "${NCON:-0}" -ge 1 ]'
QL=$(curl -s "$B/radio/$CID/log?q=cola" -H "$A")
ok "log title search finds the advert" 'echo "$QL" | grep -qi "Crunchy Cola"'
CL=$(curl -s "$B/radio/$CID/log?class=song" -H "$A")
ok "log class filter returns only songs" 'python3 -c "
import json,sys; d=json.loads(sys.argv[1])
es=d[\"entries\"]; assert es and all(e[\"class\"]==\"song\" for e in es)
" "$CL"'
FROM=$(date -u -d '-1 hour' +%Y-%m-%dT%H:%M:%SZ); TO=$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)
EPG=$(curl -s "$B/epg?channelId=$CID&from=$FROM&to=$TO" -H "$A")
ok "log entries are real EPG programme rows" 'python3 -c "
import json,sys; d=json.loads(sys.argv[1]); assert len(d)>=3
" "$EPG"'

# ---- monitoring parity: five gates, QC, levels, event log --------------------------
sleep 10   # let the monitor take a few level samples
QC=$(curl -s "$B/radio/$CID/qc" -H "$A")
ok "five gates reported (server/input/encoder/output/public)" 'python3 -c "
import json,sys; d=json.loads(sys.argv[1])
gs=[g[\"gate\"] for g in d[\"health\"][\"gates\"]]
assert gs==[\"server\",\"input\",\"encoder\",\"output\",\"public\"], gs
" "$QC"'
ok "gates healthy while running (server/input/encoder/output)" 'python3 -c "
import json,sys; d=json.loads(sys.argv[1])
g={x[\"gate\"]:x[\"status\"] for x in d[\"health\"][\"gates\"]}
assert all(g[k]==\"healthy\" for k in (\"server\",\"input\",\"encoder\",\"output\")), g
" "$QC"'
ok "not published yet: public gate READY, overall ready" '[ "$(J "$QC" health.overall)" = ready ]'
ok "QC verdict is real programme audio" '[ "$(J "$QC" qc.verdict)" = audio ]'
ok "QC playlist invariant checks are passing" 'python3 -c "
import json,sys; d=json.loads(sys.argv[1])[\"qc\"]
assert d[\"checks\"][\"ok\"] >= 1 and d[\"checks\"][\"failed\"] == 0, d[\"checks\"]
" "$QC"'
LV=$(curl -s "$B/radio/$CID/levels?limit=5" -H "$A")
ok "levels feed carries measured dBFS + ~100ms frames" 'python3 -c "
import json,sys; d=json.loads(sys.argv[1])
s=d[\"samples\"][-1]
assert -60 < s[\"rmsDb\"] < 0, s[\"rmsDb\"]
assert len(s[\"frames\"]) >= 10, len(s[\"frames\"])
assert d[\"level\"] and d[\"verdict\"]==\"audio\"
" "$LV"'
EVL=$(curl -s "$B/radio/$CID/events" -H "$A")
ok "event log records the station start" 'echo "$EVL" | grep -q "Station started"'
ok "event log is clean (no false errors from decoder chatter)" 'python3 -c "
import json,sys; d=json.loads(sys.argv[1])[\"entries\"]
bad=[e for e in d if e[\"level\"]==\"down\"]
assert not bad, bad[:2]
" "$EVL"'

# ---- on-air split: start = private, go on air = public ------------------------------
ok "public MP3 is CLOSED before going on air" '[ "$(code "http://localhost:$PORT/live/$CID/stream.mp3")" = 404 ]'
ok "public HLS is CLOSED before going on air" '[ "$(code "http://localhost:$PORT/live/$CID/master.m3u8")" = 404 ]'
ok "private preview MP3 still serves" '[ "$(code --max-time 3 "http://localhost:$PORT/radio/$CID/stream.mp3")" = 200 ]'
AIR=$(curl -s -X POST "$B/radio/$CID/air" -H "$A" -H 'content-type:application/json' -d '{"on":true}')
ok "go on air succeeds" '[ "$(J "$AIR" on_air)" = True ]'
sleep 1
ok "public MP3 now serves" '[ "$(code --max-time 3 "http://localhost:$PORT/live/$CID/stream.mp3")" = 200 ]'
ok "public HLS now redirects to the origin" '[ "$(code "http://localhost:$PORT/live/$CID/master.m3u8")" = 302 ]'
ok "public DASH now redirects to the origin" '[ "$(code "http://localhost:$PORT/live/$CID/manifest.mpd")" = 302 ]'
QC2=$(curl -s "$B/radio/$CID/qc" -H "$A")
ok "on air: public gate healthy, overall onair" '[ "$(J "$QC2" health.overall)" = onair ] && [ "$(J "$QC2" health.onAir)" = True ]'
ok "take off air closes the public URLs again" '[ "$(code -X POST "$B/radio/$CID/air" -H "$A" -H "content-type:application/json" -d "{\"on\":false}")" = 200 ] && [ "$(code "http://localhost:$PORT/live/$CID/stream.mp3")" = 404 ]'
curl -s -X POST "$B/radio/$CID/air" -H "$A" -H 'content-type:application/json' -d '{"on":true}' >/dev/null

# ---- stop + recording ------------------------------------------------------------
RECID=$(psql "$DATABASE_URL" -tA -c "SELECT id FROM recordings WHERE channel_id='$CID' ORDER BY created_at DESC LIMIT 1" | head -1 | tr -cd 'a-f0-9-')
ok "recording opened on start" '[ -n "$RECID" ]'
curl -s -X POST "$B/radio/$CID/stop" -H "$A" >/dev/null
sleep 2
ok "stop closes the recording" '[ "$(psql "$DATABASE_URL" -tA -c "SELECT status FROM recordings WHERE id='"'"'$RECID'"'"'" | head -1)" = complete ]'
ok "stopping also takes the station off air" '[ "$(psql "$DATABASE_URL" -tA -c "SELECT on_air FROM channels WHERE id='"'"'$CID'"'"'" | head -1)" = f ]'
ok "mp3 endpoint 404s when off" '[ "$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/radio/$CID/stream.mp3")" = 404 ]'
ok "event log records the stop" 'curl -s "$B/radio/$CID/events" -H "$A" | grep -q "Station stopped"'
TL=$(curl -s "$B/recordings/$RECID/timeline" -H "$A")
ok "timeline: audioOnly with spans" '[ "$(J "$TL" audioOnly)" = True ] && [ -n "$(J "$TL" spans.0.startMs)" ]'
FROMMS=$(python3 -c "import json;d=json.loads('''$TL''');print(int(d['spans'][0]['startMs']))")
TOMS=$(python3 -c "import json;d=json.loads('''$TL''');print(int(d['spans'][0]['endMs']))")
RM=$(curl -s "$B/recordings/$RECID/range/master.m3u8?from=$FROMMS&to=$TOMS" -H "$A")
ok "audio-only range master (no video variant)" 'echo "$RM" | grep -q "audio.m3u8" && ! echo "$RM" | grep -q "video.m3u8"'
RA=$(curl -s "$B/recordings/$RECID/range/audio.m3u8?from=$FROMMS&to=$TOMS" -H "$A")
ok "range audio playlist spans the run" 'echo "$RA" | grep -q "seg_00000.m4s" && echo "$RA" | grep -q ENDLIST'
ok "no orphaned ffmpeg" '[ "$(pgrep -f "ffmpeg.*$CID" | wc -l)" = 0 ]'

kill $API $SIM 2>/dev/null
echo
echo "radio.check: $pass passed, $fail failed"
[ "$fail" = 0 ]
