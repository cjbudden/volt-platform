#!/usr/bin/env bash
# The metadata name IS the entity's name. A channel, station or event has one
# required name (Settings); the API always writes it into metadata.name, so the
# content type's `name` can never drift into a second "EPG name". Create, rename,
# a metadata save that sends another name, a station and an event, the guide's
# title, and the one-off migration of drifted rows.
# A rename is reported as one change (name), though metadata.name moves with it.
# Run from volt-app/ with DATABASE_URL set.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8511}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*'
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4
pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
B="http://localhost:$PORT/api"; J='content-type:application/json'
ACC=0000000a-0000-0000-0000-0000000007f1; G=0000000d-0000-0000-0000-0000000007f1
q(){ psql "$DATABASE_URL" -tA -c "$1"; }
jget(){ python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
DELETE FROM channels WHERE group_id='$G'; DELETE FROM events WHERE group_id='$G';
INSERT INTO accounts(id,name) VALUES ('$ACC','NameCo') ON CONFLICT (id) DO NOTHING;
INSERT INTO users(id,account_id,email,password_hash,role,status,display_name) VALUES
  ('0000000b-0000-0000-0000-0000000007f1','$ACC','nm@name.example','x','owner','active','Nm') ON CONFLICT (id) DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('0000000c-0000-0000-0000-0000000007f1','$ACC','HD','[{"height":360,"bitrate_kbps":800}]','transcode') ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,max_concurrent) VALUES ('$G','$ACC','G','0000000c-0000-0000-0000-0000000007f1',20,20) ON CONFLICT (id) DO NOTHING;
SQL
npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE email='nm@name.example'\",[h]); await pool.end();})()" >/dev/null 2>&1
npx tsx src/index.ts >/tmp/metadata_name_api.log 2>&1 &
API=$!
for i in $(seq 1 60); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
A="authorization: Bearer $(curl -s -X POST "$B/auth/login" -H "$J" -d '{"email":"nm@name.example","password":"volt1234"}' | sed -n 's/.*"access":"\([^"]*\)".*/\1/p')"
mdname(){ q "SELECT metadata->>'name' FROM $1 WHERE id='$2'"; }
ver(){ q "SELECT version FROM $1 WHERE id='$2'"; }

CH=$(curl -s -X POST "$B/channels" -H "$A" -H "$J" -d "{\"groupId\":\"$G\",\"name\":\"RTM News 24\",\"metadata\":{\"name\":\"Something else\",\"description\":\"News\"},\"sources\":[{\"role\":\"primary\",\"protocol\":\"hls\",\"ingestUrl\":\"http://127.0.0.1:9/a.m3u8\"}]}" | jget 'd["id"]')
ok "a new channel's metadata name is its name, whatever metadata sent" '[ "$(mdname channels $CH)" = "RTM News 24" ]'
ok "and the rest of the metadata is kept" '[ "$(q "SELECT metadata->>'"'"'description'"'"' FROM channels WHERE id='"'"'$CH'"'"'")" = News ]'
R=$(curl -s -X PATCH "$B/channels/$CH" -H "$A" -H "$J" -d "{\"name\":\"RTM News\",\"version\":$(ver channels $CH)}")
ok "renaming the channel renames the metadata" '[ "$(mdname channels $CH)" = "RTM News" ]'
ok "and the edit history calls it one change: the name" '[ "$(echo "$R" | jget "d[\"_changed\"]")" = "['"'"'name'"'"']" ]'
C=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$B/channels/$CH" -H "$A" -H "$J" -d "{\"metadata\":{\"name\":\"Drift\",\"description\":\"All news\"},\"version\":$(ver channels $CH)}")
ok "a metadata save cannot give it a second name ($C)" '[ "$C" = 200 ] && [ "$(mdname channels $CH)" = "RTM News" ] && [ "$(q "SELECT metadata->>'"'"'description'"'"' FROM channels WHERE id='"'"'$CH'"'"'")" = "All news" ]'
ok "the guide's channel title is the name" '[ "$(curl -s "$B/epg/channels" -H "$A" | jget "[c[\"name\"] for c in d if c[\"id\"]==\"$CH\"][0]")" = "RTM News" ]'

ST=$(curl -s -X POST "$B/channels" -H "$A" -H "$J" -d "{\"groupId\":\"$G\",\"name\":\"Jazz FM\",\"kind\":\"radio\",\"radio\":{\"outputs\":{\"mp3\":true,\"hls\":false,\"dash\":false}},\"sources\":[{\"role\":\"primary\",\"protocol\":\"icecast\",\"ingestUrl\":\"http://127.0.0.1:9/live\"}]}" | jget 'd["id"]')
ok "a station too" '[ "$(mdname channels $ST)" = "Jazz FM" ]'

S=$(date -u -d '+2 days' +%Y-%m-%dT%H:00:00Z 2>/dev/null || date -u -v+2d +%Y-%m-%dT%H:00:00Z); E=$(date -u -d '+2 days 2 hours' +%Y-%m-%dT%H:00:00Z 2>/dev/null || date -u -v+2d -v+2H +%Y-%m-%dT%H:00:00Z)
EV=$(curl -s -X POST "$B/events" -H "$A" -H "$J" -d "{\"groupId\":\"$G\",\"name\":\"Cup Final\",\"scheduledStart\":\"$S\",\"scheduledEnd\":\"$E\",\"metadata\":{\"name\":\"Old title\"}}" | jget 'd["id"]')
ok "an event's metadata name is its name" '[ -n "$EV" ] && [ "$(mdname events $EV)" = "Cup Final" ]'
C=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$B/events/$EV" -H "$A" -H "$J" -d "{\"name\":\"Cup Final 2026\",\"version\":$(ver events $EV)}")
ok "and follows a rename ($C)" '[ "$C" = 200 ] && [ "$(mdname events $EV)" = "Cup Final 2026" ]'

# The one-off migration: rows that drifted before this rule are brought into line.
q "UPDATE channels SET metadata = metadata || '{\"name\":\"Drifted\"}' WHERE id='$CH'" >/dev/null
psql "$DATABASE_URL" -q -f migrations/0043_metadata_name_is_entity_name.sql >/dev/null
ok "migration 0043 puts the name back in the metadata" '[ "$(mdname channels $CH)" = "RTM News" ]'

kill $API 2>/dev/null
echo; echo "metadata-name.check: $pass passed, $fail failed"
[ "$fail" = 0 ]
