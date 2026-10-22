#!/usr/bin/env bash
# THE PLAYER SDK'S SERVER SIDE (docs/PLAYER_SDK.md).
#   * the play gate answers an asset id with what to play and what to show
#     (delivery + meta), for VOD and for a channel (null delivery off air);
#   * the guide endpoint returns the published programmes around now, without
#     the radio content log, keyed and scoped to the account;
#   * now-playing carries the last tracks (songs only) for the audio skins;
#   * player configs accept the SDK skins and a theme in options.theme;
#   * the bundle is served with the SDK in it.
# Run from volt-app/ with DATABASE_URL set.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8536}"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*' \
  PUBLIC_BASE_URL="http://localhost:$PORT" THUMBS_ENABLED=0 CDN_BASE_URL=https://cdn.sdkco.example
pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
B="http://localhost:$PORT/api"; J='content-type:application/json'
ACC=0000000a-0000-0000-0000-00000000f501; ADM=0000000b-0000-0000-0000-00000000f501
G=0000000d-0000-0000-0000-00000000f501; CH=0000000e-0000-0000-0000-00000000f501; RD=0000000e-0000-0000-0000-00000000f502
V=0000000f-0000-0000-0000-00000000f501; P1=0000000c-0000-0000-0000-00000000f501
OTHER=0000000e-0000-0000-0000-00000000d701
EV1=0000001e-0000-0000-0000-00000000f501; EV2=0000001e-0000-0000-0000-00000000f502; EV3=0000001e-0000-0000-0000-00000000f503
RV=0000000f-0000-0000-0000-00000000f503
q(){ psql "$DATABASE_URL" -tA -c "$1"; }
jget(){ python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
jj(){ python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(eval(sys.argv[1]), separators=(',',':')))" "$1"; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO accounts(id,name,max_channels) VALUES ('$ACC','SdkCo',10) ON CONFLICT (id) DO NOTHING;
INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES ('$ADM','$ACC','adm@sdkco.example','x','admin','active') ON CONFLICT (id) DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('$P1','$ACC','Pkg','[]','package_only') ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,is_default) VALUES ('$G','$ACC','Main','$P1',10,true) ON CONFLICT (id) DO NOTHING;
INSERT INTO channels(id,group_id,name,status,kind,metadata) VALUES ('$CH','$G','Sdk TV','ended','tv','{"description":"News all day","artworkUrl":"https://img.sdkco.example/tv.png"}') ON CONFLICT (id) DO NOTHING;
INSERT INTO channels(id,group_id,name,status,kind) VALUES ('$RD','$G','Sdk FM','ended','radio') ON CONFLICT (id) DO NOTHING;
INSERT INTO vod_assets(id,channel_id,title,master_key,start_epoch_ms,end_epoch_ms,duration_ms,metadata,poster_key,published)
  VALUES ('$V','$CH','Episode One','vod/sdk/ep1',0,1800000,1800000,'{"description":"The pilot"}','vod/sdk/ep1/poster.jpg',true) ON CONFLICT (id) DO NOTHING;
DELETE FROM programmes WHERE channel_id IN ('$CH','$RD');
INSERT INTO programmes(channel_id,title,starts_at,ends_at,metadata) VALUES
  ('$CH','Morning News', now()-interval '20 min', now()+interval '10 min','{"subtitle":"Headlines","imageUrl":"https://img.sdkco.example/news.jpg"}'),
  ('$CH','Science Hour', now()+interval '10 min', now()+interval '70 min','{"description":"Comets"}'),
  ('$CH','Long Ago', now()-interval '30 hour', now()-interval '29 hour','{}'),
  ('$CH','Dropped', now()+interval '2 hour', now()+interval '3 hour','{}');
UPDATE programmes SET status='cancelled' WHERE channel_id='$CH' AND title='Dropped';
INSERT INTO programmes(channel_id,source_ref,title,starts_at,ends_at,metadata) VALUES
  ('$CH','icy:tv1','Not A Guide Row', now()-interval '1 min', now(),'{"source":"icy","class":"song"}'),
  ('$RD','icy:1','Fleetwood Mac - Dreams', now()-interval '12 min', now()-interval '8 min','{"source":"icy","class":"song"}'),
  ('$RD','icy:2','Sdk FM ident', now()-interval '8 min', now()-interval '7 min','{"source":"icy","class":"content"}'),
  ('$RD','icy:3','Kate Bush - Running Up That Hill', now()-interval '7 min', now()-interval '3 min','{"source":"icy","class":"song"}');
DELETE FROM player_configs WHERE account_id='$ACC';
DELETE FROM vod_assets WHERE event_id IN ('$EV1','$EV2','$EV3');
INSERT INTO events(id,group_id,name,status,scheduled_start,scheduled_end,metadata) VALUES
  ('$EV1','$G','Grand Final','scheduled', now()+interval '2 hour', now()+interval '5 hour',
   '{"@type":"SportsEvent","competition":"Premier League","homeTeam":{"id":"h","name":"Lions","logo":"https://img.sdkco.example/lions.png"},"awayTeam":{"id":"a","name":"Tigers"},"preMessage":"Gates open at 6","image":"https://img.sdkco.example/final.jpg"}'),
  ('$EV2','$G','Called Off','scheduled', now()+interval '1 day', now()+interval '1 day 2 hour','{"eventStatus":"https://schema.org/EventCancelled"}'),
  ('$EV3','$G','Last Night','ended', now()-interval '1 day', now()-interval '20 hour','{"endedMessage":"Thanks for watching"}')
  ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, scheduled_start=EXCLUDED.scheduled_start, scheduled_end=EXCLUDED.scheduled_end, metadata=EXCLUDED.metadata;
INSERT INTO vod_assets(id,event_id,title,master_key,start_epoch_ms,end_epoch_ms,duration_ms,published)
  VALUES ('$RV','$EV3','Last Night (replay)','vod/sdk/replay',0,3600000,3600000,true) ON CONFLICT (id) DO NOTHING;
SQL
npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE id='$ADM'\",[h]); await pool.end();})()" >/dev/null 2>&1
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4
npx tsx src/index.ts >/tmp/player_sdk_api.log 2>&1 & API=$!
trap 'kill $API 2>/dev/null' EXIT
for i in $(seq 1 80); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
A="authorization: Bearer $(curl -s -X POST "$B/auth/login" -H "$J" -d '{"email":"adm@sdkco.example","password":"volt1234"}' | sed -n 's/.*"access":"\([^"]*\)".*/\1/p')"
K=$(curl -s -X POST "$B/apps" -H "$A" -H "$J" -d '{"name":"SDK check","type":"web"}' | jget 'd["publishableKey"]["key"]')
ok "an app key for the player" '[ "${K:0:3}" = pk_ ]'

echo "-- the play gate: what to play and what to show"
GV=$(curl -s -X POST "$B/availability" -H "$J" -d "{\"appKey\":\"$K\",\"assetId\":\"$V\"}")
ok "VOD: the asset's own manifests" '[ "$(echo "$GV" | jget "d[\"delivery\"][\"hls\"]")" = https://cdn.sdkco.example/vod/sdk/ep1/master.m3u8 ]'
ok "VOD: title, description, length and poster for the player" '[ "$(echo "$GV" | jj "[d[\"meta\"][k] for k in (\"title\",\"description\",\"durationMs\",\"artworkUrl\",\"live\")]")" = '\''["Episode One","The pilot",1800000,"https://cdn.sdkco.example/vod/sdk/ep1/poster.jpg",false]'\''  ]'
ok "VOD: a playback token for the beacons" '[ -n "$(echo "$GV" | jget "d[\"playbackToken\"]")" ]'
GC=$(curl -s -X POST "$B/availability" -H "$J" -d "{\"appKey\":\"$K\",\"assetId\":\"$CH\"}")
ok "channel off air: playable answer, no delivery yet (the player shows not on air)" '[ "$(echo "$GC" | jj "[d[\"available\"], d[\"delivery\"]]")" = "[true,null]" ]'
ok "channel: meta from the channel (name, description, artwork)" '[ "$(echo "$GC" | jj "[d[\"meta\"][\"title\"], d[\"meta\"][\"artworkUrl\"], d[\"meta\"][\"live\"]]")" = '\''["Sdk TV","https://img.sdkco.example/tv.png",true]'\''  ]'
ok "another account's asset is unknown" '[ "$(code -X POST "$B/availability" -H "$J" -d "{\"appKey\":\"$K\",\"assetId\":\"$OTHER\"}")" = 404 ]'

echo "-- the guide"
E=$(curl -s "$B/player/epg?appKey=$K&channelId=$CH")
ok "the programmes around now, in order" '[ "$(echo "$E" | jj "[p[\"title\"] for p in d[\"programmes\"]]")" = '\''["Morning News","Science Hour"]'\''  ]'
ok "subtitle and image come from the programme metadata" '[ "$(echo "$E" | jj "[d[\"programmes\"][0][\"subtitle\"], d[\"programmes\"][0][\"imageUrl\"]]")" = '\''["Headlines","https://img.sdkco.example/news.jpg"]'\''  ]'
ok "instants are epoch milliseconds" '[ "$(echo "$E" | jget "d[\"programmes\"][0][\"endsAt\"] - d[\"programmes\"][0][\"startsAt\"]")" = 1800000 ]'
ok "the radio content log and cancelled programmes are not in the guide" '! echo "$E" | grep -q "Not A Guide Row\|Dropped"'
ok "only the window around now (a programme from yesterday is not sent)" '! echo "$E" | grep -q "Long Ago"'
ok "a bad key is refused" '[ "$(code "$B/player/epg?appKey=pk_live_nope_nope_nope&channelId=$CH")" = 401 ]'
ok "another account's channel answers 404" '[ "$(code "$B/player/epg?appKey=$K&channelId=$OTHER")" = 404 ]'

echo "-- now playing: the last tracks"
NP=$(curl -s -X POST "$B/player/now-playing" -H "$J" -d "{\"appKey\":\"$K\",\"channelId\":\"$RD\"}")
ok "history lists songs, newest first, idents left out" '[ "$(echo "$NP" | jj "[[h[\"artist\"], h[\"title\"]] for h in d[\"history\"]]")" = '\''[["Kate Bush","Running Up That Hill"],["Fleetwood Mac","Dreams"]]'\''  ]'
ok "each with the time it started" '[ "$(echo "$NP" | jget "all(isinstance(h[\"startedAt\"], int) for h in d[\"history\"])")" = True ]'

echo "-- saving an SDK skin and a theme"
S=$(curl -s -X PUT "$B/player-config/$RD" -H "$A" -H "$J" -d '{"layout":"audio_nowplaying","primaryColor":"#e11d48","options":{"theme":{"radius":6,"logoUrl":"https://img.sdkco.example/l.png","controls":{"history":true}}}}')
ok "the SDK skin is accepted and saved" '[ "$(echo "$S" | jget "d[\"layout\"]")" = audio_nowplaying ]'
ok "the theme is kept in options.theme" '[ "$(echo "$S" | jget "d[\"options\"][\"theme\"][\"radius\"]")" = 6 ]'
ok "the station handshake carries it to the embed" '[ "$(curl -s -X POST "$B/player/session" -H "$J" -d "{\"appKey\":\"$K\",\"channelId\":\"$RD\"}" | jj "[d[\"config\"][\"layout\"], d[\"config\"][\"options\"][\"theme\"][\"radius\"]]")" = '\''["audio_nowplaying",6]'\''  ]'
ok "the console's admin skin cannot be saved" '[ "$(code -X PUT "$B/player-config/$RD" -H "$A" -H "$J" -d "{\"layout\":\"admin\"}")" = 422 ]'
# audio_radio joined the SDK skins after this list was written (volt-player/src/sdk/skins/audio.ts).
ok "the layouts list offers the SDK skins" '[ "$(curl -s "$B/player-config/$RD" -H "$A" | jj "sorted(l[\"id\"] for l in d[\"layouts\"] if l.get(\"sdk\"))")" = '\''["audio_nowplaying","audio_radio","audio_square","audio_wave","video"]'\''  ]'

echo "-- events: the event skin's data"
EVJ=$(curl -s "$B/player/event?appKey=$K&eventId=$EV1")
ok "before the start: phase pre, start time in epoch ms, the promoter's message" '[ "$(echo "$EVJ" | jj "[d[\"presentation\"], d[\"startsAt\"] > 0, d[\"preMessage\"]]")" = '\''["pre",true,"Gates open at 6"]'\'' ]'
ok "the promo: competition, the two teams with a logo, the poster" '[ "$(echo "$EVJ" | jj "[d[\"promo\"][\"template\"], d[\"promo\"][\"headline\"], [x[\"name\"] for x in d[\"promo\"][\"sides\"]], d[\"promo\"][\"sides\"][0][\"imageUrl\"], d[\"promo\"][\"posterUrl\"]]")" = '\''["versus","Premier League",["Lions","Tigers"],"https://img.sdkco.example/lions.png","https://img.sdkco.example/final.jpg"]'\'' ]'
ok "a called-off event is cancelled, not counting down" '[ "$(curl -s "$B/player/event?appKey=$K&eventId=$EV2" | jget "d[\"presentation\"]")" = cancelled ]'
ok "after the end with a published replay: replay, with its asset id" '[ "$(curl -s "$B/player/event?appKey=$K&eventId=$EV3" | jj "[d[\"presentation\"], d[\"replayAssetId\"], d[\"endedMessage\"]]")" = '\''["replay","'$RV'","Thanks for watching"]'\'' ]'
ok "another account's event is unknown" '[ "$(code "$B/player/event?appKey=$K&eventId=0000001e-0000-0000-0000-00000000aaaa")" = 404 ]'
GE=$(curl -s -X POST "$B/availability" -H "$J" -d "{\"appKey\":\"$K\",\"assetId\":\"$EV1\"}")
ok "the gate: an event before it is live has nothing to play yet (the skin counts down)" '[ "$(echo "$GE" | jj "[d[\"available\"], d[\"delivery\"], d[\"meta\"][\"title\"], d[\"meta\"][\"artworkUrl\"]]")" = '\''[true,null,"Grand Final","https://img.sdkco.example/final.jpg"]'\'' ]'
ok "the event skin can be saved in a config" '[ "$(curl -s -X PUT "$B/player-config/$RD" -H "$A" -H "$J" -d "{\"layout\":\"event\"}" | jget "d[\"layout\"]")" = event ]'

echo "-- the bundle"
if [ -f ../volt-player/dist/volt-player.js ]; then
  ok "the bundle carries the SDK (registerSkin, the video skin)" 'curl -s "http://localhost:$PORT/player/volt-player.js" | grep -q "audio_nowplaying" && curl -s "http://localhost:$PORT/player/volt-player.js" | grep -q "registerSkin"'
else echo "SKIP the bundle is not built (cd volt-player && npm run build)"; fi

echo; echo "player-sdk-api: $pass passed, $fail failed"
exit $([ $fail -eq 0 ] && echo 0 || echo 1)
