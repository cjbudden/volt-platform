#!/usr/bin/env bash
# EPG extended features e2e: owner-generic guides (channel + EVENT), slot
# controls (geo, replacement), PATCH, copy/clear day, owners list, post-airing
# auto-clip with metadata harvest, and a window-query performance smoke.
# Run from volt-app/ with DATABASE_URL set (shared dev DB; idempotent seeds).
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8483}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*'
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4

pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }

CH=0000000e-0000-0000-0000-0000000000aa

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO accounts(id,name) VALUES ('0000000a-0000-0000-0000-0000000000a1'::uuid,'RecCo') ON CONFLICT (id) DO NOTHING;
INSERT INTO users(id,account_id,email,password_hash,role,status,display_name) VALUES
  ('0000000b-0000-0000-0000-0000000000a1'::uuid,'0000000a-0000-0000-0000-0000000000a1'::uuid,'rec@recco.example','x','owner','active','Rec Admin')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES
  ('0000000c-0000-0000-0000-0000000000a1'::uuid,'0000000a-0000-0000-0000-0000000000a1'::uuid,'HD','[{"height":360,"bitrate_kbps":800}]','transcode')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id) VALUES
  ('0000000d-0000-0000-0000-0000000000a1'::uuid,'0000000a-0000-0000-0000-0000000000a1'::uuid,'G','0000000c-0000-0000-0000-0000000000a1'::uuid)
  ON CONFLICT (id) DO NOTHING;
INSERT INTO channels(id,group_id,name,status) VALUES
  ('0000000e-0000-0000-0000-0000000000aa'::uuid,'0000000d-0000-0000-0000-0000000000a1'::uuid,'Rec Channel','ended')
  ON CONFLICT (id) DO NOTHING;
DELETE FROM events WHERE name='EPG Event';
SQL
EV=$(psql "$DATABASE_URL" -tA -c "INSERT INTO events(group_id,name,scheduled_start,scheduled_end)
  VALUES ('0000000d-0000-0000-0000-0000000000a1'::uuid,'EPG Event', now()+interval '1 day', now()+interval '1 day 4 hours') RETURNING id" | head -1 | tr -cd 'a-f0-9-')
psql "$DATABASE_URL" -q -c "DELETE FROM programmes WHERE channel_id='$CH'::uuid OR event_id='$EV'::uuid"

npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE email='rec@recco.example'\",[h]); await pool.end();})()" >/dev/null 2>&1

npx tsx src/index.ts >/tmp/epg_api.log 2>&1 &
API=$!
for i in $(seq 1 40); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 0.25; done

TOK=$(curl -s -X POST "http://localhost:$PORT/api/auth/login" -H 'content-type:application/json' -d '{"email":"rec@recco.example","password":"volt1234"}' | sed -n 's/.*"access":"\([^"]*\)".*/\1/p')
A="authorization: Bearer $TOK"
ok "admin logged in" '[ -n "$TOK" ]'

ISO() { python3 -c "import datetime,sys; print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=int(sys.argv[1]))).replace(microsecond=0).isoformat().replace('+00:00','Z'))" "$1"; }

# ---- channel guide: create with full slot controls --------------------------
P1=$(curl -s -X POST "http://localhost:$PORT/api/epg" -H "$A" -H 'content-type:application/json' -d "{
  \"channelId\":\"$CH\",\"title\":\"Morning News\",\"startsAt\":\"$(ISO 60)\",\"endsAt\":\"$(ISO 120)\",
  \"geoMode\":\"allow\",\"geoCountries\":[\"MY\",\"SG\"],
  \"replacementKind\":\"slate\",\"replacementRef\":\"/library/x/slates/s.png\",
  \"metadata\":{\"description\":\"Daily bulletin\",\"category\":\"News\"}}")
P1ID=$(echo "$P1" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
ok "programme created with geo + replacement" 'echo "$P1" | grep -q "\"geo_mode\":\"allow\"" && echo "$P1" | grep -q "\"replacement_kind\":\"slate\""'

# blank end resolves to the NEXT programme's start
P0=$(curl -s -X POST "http://localhost:$PORT/api/epg" -H "$A" -H 'content-type:application/json' -d "{
  \"channelId\":\"$CH\",\"title\":\"Breakfast Show\",\"startsAt\":\"$(ISO 0)\"}")
E0=$(echo "$P0" | python3 -c 'import json,sys; print(json.load(sys.stdin)["ends_at"][:16])')
ok "blank end resolves to next programme's start ($E0)" '[ "$E0" = "$(ISO 60 | cut -c1-16)" ]'

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:$PORT/api/epg" -H "$A" -H 'content-type:application/json' \
  -d "{\"channelId\":\"$CH\",\"title\":\"bad\",\"startsAt\":\"$(ISO 300)\",\"replacementKind\":\"vod\"}")
ok "replacement without ref rejected ($CODE)" '[ "$CODE" = "400" ]'

# ---- overlap conflict surfaced (soft) ---------------------------------------
POV=$(curl -s -X POST "http://localhost:$PORT/api/epg" -H "$A" -H 'content-type:application/json' -d "{
  \"channelId\":\"$CH\",\"title\":\"Overlap Special\",\"startsAt\":\"$(ISO 90)\",\"endsAt\":\"$(ISO 150)\"}")
ok "overlap allowed and surfaced on create" 'echo "$POV" | grep -q "Morning News"'
CONF=$(curl -s "http://localhost:$PORT/api/epg/conflicts?channelId=$CH" -H "$A")
ok "conflict report lists the overlap" 'echo "$CONF" | grep -q "Overlap Special"'

# ---- patch ------------------------------------------------------------------
PP=$(curl -s -X PATCH "http://localhost:$PORT/api/epg/$P1ID" -H "$A" -H 'content-type:application/json' \
  -d '{"title":"Morning News LIVE","autoVod":true,"replacementKind":"none","replacementRef":null}')
ok "patch updates title/autoVod/replacement" 'echo "$PP" | grep -q "Morning News LIVE" && echo "$PP" | grep -q "\"auto_vod\":true" && echo "$PP" | grep -q "\"replacement_kind\":\"none\""'

# ---- event schedule ---------------------------------------------------------
PE=$(curl -s -X POST "http://localhost:$PORT/api/epg" -H "$A" -H 'content-type:application/json' -d "{
  \"eventId\":\"$EV\",\"title\":\"Opening Ceremony\",\"startsAt\":\"$(ISO 1440)\",\"endsAt\":\"$(ISO 1500)\"}")
ok "event programme created" 'echo "$PE" | grep -q "Opening Ceremony" && echo "$PE" | grep -q "\"event_id\":\"$EV\""'
EL=$(curl -s "http://localhost:$PORT/api/epg?eventId=$EV&from=$(ISO 1400)&to=$(ISO 1600)" -H "$A")
ok "event guide window lists it" 'echo "$EL" | grep -q "Opening Ceremony"'
CLW=$(curl -s "http://localhost:$PORT/api/epg?channelId=$CH&from=$(ISO 1400)&to=$(ISO 1600)" -H "$A")
ok "guides are isolated per owner" '! echo "$CLW" | grep -q "Opening Ceremony"'

# ---- owners list ------------------------------------------------------------
OW=$(curl -s "http://localhost:$PORT/api/epg/owners" -H "$A")
echo "$OW" > /tmp/epg_owners.json
OWOK=$(python3 - "$CH" "$EV" <<'PY'
import json, sys
rs = json.load(open('/tmp/epg_owners.json'))
ch = [r for r in rs if r["id"] == sys.argv[1]]
ev = [r for r in rs if r["id"] == sys.argv[2]]
print("yes" if ch and ev and ch[0]["programme_count"] >= 3 and ev[0]["programme_count"] == 1 and ch[0]["auto_clip_count"] >= 1 else "no")
PY
)
ok "owners list rolls up both guides ($OWOK)" '[ "$OWOK" = "yes" ]'

# ---- copy day / clear day ---------------------------------------------------
DS=$(python3 -c "import datetime; d=datetime.datetime.now(datetime.timezone.utc).replace(hour=0,minute=0,second=0,microsecond=0); print(d.isoformat().replace('+00:00','Z'))")
DE=$(python3 -c "import datetime; d=datetime.datetime.now(datetime.timezone.utc).replace(hour=0,minute=0,second=0,microsecond=0)+datetime.timedelta(days=1); print(d.isoformat().replace('+00:00','Z'))")
CP=$(curl -s -X POST "http://localhost:$PORT/api/epg/copy-day" -H "$A" -H 'content-type:application/json' \
  -d "{\"channelId\":\"$CH\",\"fromStart\":\"$DS\",\"fromEnd\":\"$DE\",\"dayOffsets\":[1,2]}")
CPOK=$(echo "$CP" | python3 -c 'import json,sys; r=json.load(sys.stdin); print("yes" if r["created"]==r["copied"]*2 and r["created"]>0 else json.dumps(r))')
ok "copy day clones onto 2 days ($CPOK)" '[ "$CPOK" = "yes" ]'
DS2=$(python3 -c "import datetime; d=datetime.datetime.now(datetime.timezone.utc).replace(hour=0,minute=0,second=0,microsecond=0)+datetime.timedelta(days=2); print(d.isoformat().replace('+00:00','Z'))")
DE2=$(python3 -c "import datetime; d=datetime.datetime.now(datetime.timezone.utc).replace(hour=0,minute=0,second=0,microsecond=0)+datetime.timedelta(days=3); print(d.isoformat().replace('+00:00','Z'))")
CLR=$(curl -s -X POST "http://localhost:$PORT/api/epg/clear-day" -H "$A" -H 'content-type:application/json' \
  -d "{\"channelId\":\"$CH\",\"fromStart\":\"$DS2\",\"fromEnd\":\"$DE2\"}")
ok "clear day removes the clones" 'echo "$CLR" | python3 -c "import json,sys; assert json.load(sys.stdin)[\"deleted\"]>0" 2>/dev/null'

# ---- post-airing auto clip with metadata harvest ----------------------------
RECID=00000010-0000-0000-0000-000000000e1b
PSTART=$(python3 -c "import time; print(int((time.time()-3600)*1000))")
PEND=$(python3 -c "import time; print(int((time.time()-600)*1000))")
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
DELETE FROM vod_assets WHERE recording_id='$RECID'::uuid;
DELETE FROM recordings WHERE id='$RECID'::uuid;
INSERT INTO recordings(id,kind,channel_id,day_utc,title,status,start_epoch_ms,end_epoch_ms,duration_ms,master_key)
  VALUES ('$RECID'::uuid,'channel_day','$CH'::uuid,CURRENT_DATE-2,'cover','complete',$PSTART-600000,$PEND+600000,3600000,'channel/x/rec');
SQL
TPAST_S=$(python3 -c "import datetime; print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(minutes=50)).replace(microsecond=0).isoformat().replace('+00:00','Z'))")
TPAST_E=$(python3 -c "import datetime; print((datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(minutes=20)).replace(microsecond=0).isoformat().replace('+00:00','Z'))")
PA=$(curl -s -X POST "http://localhost:$PORT/api/epg" -H "$A" -H 'content-type:application/json' -d "{
  \"channelId\":\"$CH\",\"title\":\"Auto Clip Show\",\"startsAt\":\"$TPAST_S\",\"endsAt\":\"$TPAST_E\",
  \"autoVod\":true,\"metadata\":{\"description\":\"Cut me automatically\",\"category\":\"Sport\"}}")
PAID=$(echo "$PA" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
FIRED=$(npx tsx -e "import {orchestrator} from './src/services/orchestrator'; (async()=>{const n=await orchestrator.fireProgrammeClips(); console.log('fired',n); process.exit(0)})()" 2>/dev/null | tail -1)
ROW=$(psql "$DATABASE_URL" -tA -c "SELECT clip_status||'|'||COALESCE(clip_asset_id::text,'null') FROM programmes WHERE id='$PAID'")
ok "auto clip fired on tick ($FIRED -> $ROW)" '[ "${ROW%%|*}" = "created" ] && [ "${ROW##*|}" != "null" ]'
AID=${ROW##*|}
ASSET=$(psql "$DATABASE_URL" -tA -c "SELECT title||'|'||COALESCE(metadata->>'category','') FROM vod_assets WHERE id='$AID'")
ok "asset named + metadata harvested from the programme ($ASSET)" '[ "$ASSET" = "Auto Clip Show|Sport" ]'
PB=$(curl -s -X POST "http://localhost:$PORT/api/epg" -H "$A" -H 'content-type:application/json' -d "{
  \"eventId\":\"$EV\",\"title\":\"Uncovered Show\",\"startsAt\":\"$TPAST_S\",\"endsAt\":\"$TPAST_E\",\"autoVod\":true}")
PBID=$(echo "$PB" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
npx tsx -e "import {orchestrator} from './src/services/orchestrator'; (async()=>{await orchestrator.fireProgrammeClips(); process.exit(0)})()" >/dev/null 2>&1
ERRROW=$(psql "$DATABASE_URL" -tA -c "SELECT clip_status||'|'||COALESCE(clip_error,'') FROM programmes WHERE id='$PBID'")
ok "no covering recording -> honest error ($ERRROW)" '[ "${ERRROW%%|*}" = "error" ]'

# ---- performance smoke: 3000 programmes, 24h window stays fast --------------
psql "$DATABASE_URL" -q -c "INSERT INTO programmes(channel_id,title,starts_at,ends_at)
  SELECT '$CH'::uuid, 'Bulk '||g, now() + (g||' hours')::interval, now() + (g||' hours')::interval + interval '55 minutes'
  FROM generate_series(100, 3100) g"
T0=$(python3 -c "import time; print(time.time())")
N=$(curl -s "http://localhost:$PORT/api/epg?channelId=$CH&from=$(ISO 14400)&to=$(ISO 15840)" -H "$A" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
T1=$(python3 -c "import time; print(time.time())")
MS=$(python3 -c "print(int(($T1-$T0)*1000))")
ok "24h window over 3000-programme guide: $N rows in ${MS}ms" '[ "$N" -ge 20 ] && [ "$MS" -lt 500 ]'
NN=$(curl -s "http://localhost:$PORT/api/epg/now-next?channelId=$CH" -H "$A")
ok "now/next hot path serves" 'echo "$NN" | grep -q "\"next\""'
psql "$DATABASE_URL" -q -c "DELETE FROM programmes WHERE channel_id='$CH'::uuid AND title LIKE 'Bulk %'"

kill $API 2>/dev/null
echo; echo "epg-extended.check: $pass passed, $fail failed"
[ "$fail" = 0 ]
