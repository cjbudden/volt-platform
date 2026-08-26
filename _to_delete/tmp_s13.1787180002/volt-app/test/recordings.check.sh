#!/usr/bin/env bash
# Recordings end-to-end: the review/clip workflow against REAL on-disk segments.
#   - seed a channel + a closed recording whose window covers two real encoder
#     runs (produced by the volt-encoder with recording enabled)
#   - timeline reports the per-run spans + audio
#   - range master/media manifests: cross-run DISCONTINUITY, per-run MAP,
#     per-segment PDT, ENDLIST; segments actually download from /origin
#   - clip + publish create vod_assets; bad ranges rejected; tenant isolated
#   - channels API: recordingEnabled on create + patch
# Run from volt-app/ with DATABASE_URL set. Needs a two-run recording at
# $REC_ORIGIN/<streamdir>/runs/* (default /tmp/rectest, streamdir 'origin').
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8479}"
REC_ORIGIN="${REC_ORIGIN:-/tmp/rectest}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*'
export ORIGIN_DIR="$REC_ORIGIN"
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4

pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }

CH=0000000e-0000-0000-0000-0000000000aa
REC=00000010-0000-0000-0000-0000000000aa

# the real segments live under $REC_ORIGIN/origin/runs/*; expose them under the
# channel's UUID (that's the streamId the index scans)
[ -e "$REC_ORIGIN/$CH" ] || ln -s "$REC_ORIGIN/origin" "$REC_ORIGIN/$CH"

# window bounds derived from the actual runs on disk
read -r WSTART WEND <<EOF
$(python3 - "$REC_ORIGIN/origin/runs" <<'PY'
import os, sys, glob
runs = sorted(os.listdir(sys.argv[1]))
segs = lambda r: glob.glob(os.path.join(sys.argv[1], r, '*', 'seg_*.m4s'))
first = min(os.path.getmtime(s) for s in segs(runs[0]))
last = max(os.path.getmtime(s) for s in segs(runs[-1]))
print(int(first*1000 - 20000), int(last*1000 + 20000))
PY
)
EOF

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
DELETE FROM vod_assets WHERE recording_id = '$REC'::uuid;
DELETE FROM recordings WHERE id = '$REC'::uuid;
DELETE FROM channels WHERE id = '$CH'::uuid;
DELETE FROM channels WHERE name = 'NoRec' AND group_id = '0000000d-0000-0000-0000-0000000000a1'::uuid;  -- prior runs (idempotent reruns)
INSERT INTO accounts(id,name) VALUES ('0000000a-0000-0000-0000-0000000000a1'::uuid,'RecCo'),('0000000a-0000-0000-0000-0000000000a2'::uuid,'OtherCo')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO users(id,account_id,email,password_hash,role,status,display_name) VALUES
  ('0000000b-0000-0000-0000-0000000000a1'::uuid,'0000000a-0000-0000-0000-0000000000a1'::uuid,'rec@recco.example','x','owner','active','Rec Admin'),
  ('0000000b-0000-0000-0000-0000000000a2'::uuid,'0000000a-0000-0000-0000-0000000000a2'::uuid,'other@recotherco.example','x','owner','active','Other Admin')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES
  ('0000000c-0000-0000-0000-0000000000a1'::uuid,'0000000a-0000-0000-0000-0000000000a1'::uuid,'HD','[{"height":360,"bitrate_kbps":800}]','transcode')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id) VALUES
  ('0000000d-0000-0000-0000-0000000000a1'::uuid,'0000000a-0000-0000-0000-0000000000a1'::uuid,'G','0000000c-0000-0000-0000-0000000000a1'::uuid)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO channels(id,group_id,name,status) VALUES ('$CH'::uuid,'0000000d-0000-0000-0000-0000000000a1'::uuid,'Rec Channel','ended');
INSERT INTO recordings(id,kind,channel_id,day_utc,title,status,start_epoch_ms,end_epoch_ms,duration_ms,master_key)
  VALUES ('$REC'::uuid,'channel_day','$CH'::uuid,CURRENT_DATE,'Soak capture','complete',$WSTART,$WEND,$WEND-$WSTART,'channel/$CH/rec');
SQL

npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE email IN ('rec@recco.example','other@recotherco.example')\",[h]); await pool.end();})()" >/dev/null 2>&1

npx tsx src/index.ts >/tmp/rec_api.log 2>&1 &
API=$!
for i in $(seq 1 40); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 0.25; done

TOK=$(curl -s -X POST "http://localhost:$PORT/api/auth/login" -H 'content-type:application/json' -d '{"email":"rec@recco.example","password":"volt1234"}' | sed -n 's/.*"access":"\([^"]*\)".*/\1/p')
TOKB=$(curl -s -X POST "http://localhost:$PORT/api/auth/login" -H 'content-type:application/json' -d '{"email":"other@recotherco.example","password":"volt1234"}' | sed -n 's/.*"access":"\([^"]*\)".*/\1/p')
A="authorization: Bearer $TOK"
ok "admin logged in" '[ -n "$TOK" ]'

# ---- list
LIST=$(curl -s "http://localhost:$PORT/api/recordings" -H "$A")
ok "recordings list has the capture with its source link" 'echo "$LIST" | grep -q "Rec Channel" && echo "$LIST" | grep -q "$REC"'

# ---- timeline
TL=$(curl -s "http://localhost:$PORT/api/recordings/$REC/timeline" -H "$A")
echo "$TL" > /tmp/rec_timeline.json
SPANS=$(echo "$TL" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["spans"]))')
ok "timeline reports 2 per-run spans" '[ "$SPANS" = "2" ]'
ok "timeline reports audio" 'echo "$TL" | grep -q "\"hasAudio\":true"'
ok "timeline links back to the channel" 'echo "$TL" | grep -q "\"streamId\":\"$CH\""'

FROM=$(echo "$TL" | python3 -c 'import json,sys; s=json.load(sys.stdin)["spans"]; print(int(s[0]["endMs"]-12000))')
TO=$(echo "$TL" | python3 -c 'import json,sys; s=json.load(sys.stdin)["spans"]; print(int(s[1]["startMs"]+12000))')

# ---- range manifests
MASTER=$(curl -s "http://localhost:$PORT/api/recordings/$REC/range/master.m3u8?from=$FROM&to=$TO" -H "$A")
ok "range master has audio group + variant" 'echo "$MASTER" | grep -q "EXT-X-MEDIA:TYPE=AUDIO" && echo "$MASTER" | grep -q "EXT-X-STREAM-INF"'
VID=$(curl -s "http://localhost:$PORT/api/recordings/$REC/range/video.m3u8?from=$FROM&to=$TO" -H "$A")
echo "$VID" > /tmp/rec_video.m3u8
DISC=$(echo "$VID" | grep -c '^#EXT-X-DISCONTINUITY$')
MAPS=$(echo "$VID" | grep -c '^#EXT-X-MAP:')
PDTS=$(echo "$VID" | grep -c '^#EXT-X-PROGRAM-DATE-TIME:')
EXTS=$(echo "$VID" | grep -c '^#EXTINF:')
ok "video range spans runs: 1 discontinuity, 2 maps" '[ "$DISC" = "1" ] && [ "$MAPS" = "2" ]'
ok "video range: PDT on every segment + VOD endlist" '[ "$PDTS" = "$EXTS" ] && [ "$EXTS" -ge 4 ] && echo "$VID" | grep -q "EXT-X-ENDLIST"'
AUD=$(curl -s "http://localhost:$PORT/api/recordings/$REC/range/audio.m3u8?from=$FROM&to=$TO" -H "$A")
ok "audio range playlist present" 'echo "$AUD" | grep -q "EXT-X-ENDLIST"'

# a segment referenced by the playlist actually downloads from the public origin
SEG=$(echo "$VID" | grep '\.m4s$' | head -1)
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT$SEG")
ok "referenced segment serves from /origin ($CODE)" '[ "$CODE" = "200" ]'
INIT=$(echo "$VID" | sed -n 's/^#EXT-X-MAP:URI="\([^"]*\)".*/\1/p' | head -1)
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT$INIT")
ok "referenced init serves from /origin ($CODE)" '[ "$CODE" = "200" ]'

# ---- range validation + tenant isolation
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/api/recordings/$REC/range/video.m3u8?from=$TO&to=$TO" -H "$A")
ok "empty/invalid range rejected ($CODE)" '[ "$CODE" = "404" ] || [ "$CODE" = "400" ]'
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/api/recordings/$REC/timeline" -H "authorization: Bearer $TOKB")
ok "other tenant cannot see the recording ($CODE)" '[ "$CODE" = "404" ]'

# ---- clip + publish
CLIP=$(curl -s -X POST "http://localhost:$PORT/api/recordings/$REC/clip" -H "$A" -H 'content-type:application/json' \
  -d "{\"title\":\"Boundary clip\",\"startMs\":$FROM,\"endMs\":$TO,\"outputKind\":\"both\"}")
ok "clip created as vod asset" 'echo "$CLIP" | grep -q "\"kind\":\"clip\"" && echo "$CLIP" | grep -q "Boundary clip"'
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:$PORT/api/recordings/$REC/clip" -H "$A" -H 'content-type:application/json' \
  -d "{\"title\":\"bad\",\"startMs\":$TO,\"endMs\":$FROM}")
ok "reversed clip range rejected ($CODE)" '[ "$CODE" = "400" ]'
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:$PORT/api/recordings/$REC/clip" -H "$A" -H 'content-type:application/json' \
  -d "{\"title\":\"bad\",\"startMs\":1000,\"endMs\":2000}")
ok "out-of-window clip rejected ($CODE)" '[ "$CODE" = "400" ]'
PUB=$(curl -s -X POST "http://localhost:$PORT/api/recordings/$REC/publish" -H "$A" -H 'content-type:application/json' -d '{}')
ok "publish full recording creates vod asset" 'echo "$PUB" | grep -q "\"kind\":\"full_event\""'
DET=$(curl -s "http://localhost:$PORT/api/recordings/$REC" -H "$A")
N=$(echo "$DET" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["vod_assets"]))')
ok "recording detail lists both assets" '[ "$N" = "2" ]'
LIST=$(curl -s "http://localhost:$PORT/api/recordings" -H "$A")
ok "list rolls up vod_count=2" 'echo "$LIST" | grep -q "\"vod_count\":2"'

# ---- content search: EPG programmes + transcript ---------------------------
# seed: a programme airing INSIDE the window, one outside; a transcript index in
# run 1 (the durable jsonl) and a VTT-only run 2 (fallback path, mtime-placed)
python3 - "$REC_ORIGIN/origin/runs" <<'PY'
import os, sys, glob, json
runs = sorted(os.listdir(sys.argv[1]))
def span(r):
    segs = glob.glob(os.path.join(sys.argv[1], r, '*', 'seg_*.m4s'))
    ts = [os.path.getmtime(s) for s in segs]
    return min(ts), max(ts)
r1s, r1e = span(runs[0]); r2s, r2e = span(runs[1])
# run 1: durable transcript.jsonl
with open(os.path.join(sys.argv[1], runs[0], 'transcript.jsonl'), 'w') as f:
    f.write(json.dumps({"lang": "en", "start_ms": int((r1s+5)*1000), "end_ms": int((r1s+9)*1000),
                        "text": "the prime minister announced new interest rates today"}) + "\n")
    f.write(json.dumps({"lang": "en", "start_ms": int((r1s+15)*1000), "end_ms": int((r1s+18)*1000),
                        "text": "markets reacted quickly to the decision"}) + "\n")
# run 2: VTT only (pre-index recording) — mtime transplanted into the window
d = os.path.join(sys.argv[1], runs[1], 'subtitles', 'en')
os.makedirs(d, exist_ok=True)
p = os.path.join(d, 'sub_0.vtt')
open(p, 'w').write("WEBVTT\n\n00:00:01.000 --> 00:00:04.000\ngoal scored by the home team\n\n")
os.utime(p, (r2s+8, r2s+8))
print("SEEDED", int(r1s*1000), int(r2s*1000))
PY
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
DELETE FROM programmes WHERE channel_id='$CH'::uuid;
INSERT INTO programmes(channel_id,title,starts_at,ends_at) VALUES
 ('$CH'::uuid,'Berita Utama Morning News', to_timestamp($WSTART/1000.0+15), to_timestamp($WSTART/1000.0+45)),
 ('$CH'::uuid,'Offwindow Show', to_timestamp($WEND/1000.0+3600), to_timestamp($WEND/1000.0+7200));
SQL

TS=$(curl -s "http://localhost:$PORT/api/recordings/$REC/transcript" -H "$A")
ok "transcript probe reports language + entries" 'echo "$TS" | grep -q "\"languages\":\[\"en\"\]" && echo "$TS" | grep -qv "\"entries\":0"'
TS=$(curl -s "http://localhost:$PORT/api/recordings/$REC/transcript?q=minister%20prime" -H "$A")
echo "$TS" > /tmp/rec_ts_search.json
ok "words match in any order" 'echo "$TS" | grep -q "prime minister announced" && echo "$TS" | grep -q "\"tMs\""'
HITMS=$(echo "$TS" | python3 -c 'import json,sys; m=json.load(sys.stdin)["matches"]; print(m[0]["tMs"] if m else 0)')
ok "transcript hit lands inside the recording window" '[ "$HITMS" -gt "$WSTART" ] && [ "$HITMS" -lt "$WEND" ]'
TS=$(curl -s "http://localhost:$PORT/api/recordings/$REC/transcript?q=goal%20scored" -H "$A")
ok "VTT-only run is searchable via fallback (approx)" 'echo "$TS" | grep -q "home team" && echo "$TS" | grep -q "\"approx\":true"'
TS=$(curl -s "http://localhost:$PORT/api/recordings/$REC/transcript?q=prime&lang=ms" -H "$A")
ok "language filter excludes other tracks" 'echo "$TS" | grep -q "\"matches\":\[\]"'
PR=$(curl -s "http://localhost:$PORT/api/recordings/$REC/programmes" -H "$A")
ok "programmes endpoint returns the in-window airing only" 'echo "$PR" | grep -q "Berita Utama" && ! echo "$PR" | grep -q "Offwindow"'
L=$(curl -s "http://localhost:$PORT/api/recordings?q=Berita" -H "$A")
ok "list search finds recording by EPG programme" 'echo "$L" | grep -q "$REC" && echo "$L" | grep -q "\"matched_by\":\"programme\""'
L=$(curl -s "http://localhost:$PORT/api/recordings?q=interest%20rates" -H "$A")
ok "list search finds recording by spoken words" 'echo "$L" | grep -q "$REC" && echo "$L" | grep -q "\"matched_by\":\"transcript\""'
L=$(curl -s "http://localhost:$PORT/api/recordings?q=Rec%20Channel" -H "$A")
ok "list search finds recording by name" 'echo "$L" | grep -q "\"matched_by\":\"title\""'
L=$(curl -s "http://localhost:$PORT/api/recordings?q=zzznotfound" -H "$A")
ok "no-match search returns nothing" '! echo "$L" | grep -q "$REC"'

# ---- channels: explicit recording switch
CREATED=$(curl -s -X POST "http://localhost:$PORT/api/channels" -H "$A" -H 'content-type:application/json' \
  -d '{"groupId":"0000000d-0000-0000-0000-0000000000a1","name":"NoRec","recordingEnabled":false,"sources":[{"role":"primary","protocol":"hls","ingestUrl":"https://x.example/a.m3u8"}]}')
NEWID=$(echo "$CREATED" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
ok "create honours recordingEnabled=false" 'echo "$CREATED" | grep -q "\"recording_enabled\":false"'
PATCHED=$(curl -s -X PATCH "http://localhost:$PORT/api/channels/$NEWID" -H "$A" -H 'content-type:application/json' -d '{"recordingEnabled":true}')
ok "patch flips recording back on" 'curl -s "http://localhost:$PORT/api/channels/$NEWID" -H "$A" | grep -q "\"recording_enabled\":true"'

kill $API 2>/dev/null
echo; echo "recordings.check: $pass passed, $fail failed"
[ "$fail" = 0 ]
