#!/usr/bin/env bash
# SOURCE PREVIEW RELAY (modules/sourcePreview.ts): a channel's HLS input can be
# played in the console through the control plane when the source refuses
# playback from other sites.
#   * a preview address is issued only for an input of a channel the caller's
#     account owns, and only for http(s) inputs;
#   * the playlist comes back with every address rewritten through the relay
#     (child playlists, segments, EXT-X-MAP), signed;
#   * segments pass through byte for byte; a tampered or foreign address and a
#     bad token are refused.
# Run from volt-app/ with DATABASE_URL set.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8527}"; HP=8528
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*' \
  PUBLIC_BASE_URL="http://localhost:$PORT" THUMBS_ENABLED=0
pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
B="http://localhost:$PORT"; J='content-type:application/json'
ACC=0000000a-0000-0000-0000-00000000f001; ADM=0000000b-0000-0000-0000-00000000f001
G=0000000d-0000-0000-0000-00000000f001; CH=0000000e-0000-0000-0000-00000000f001; P1=0000000c-0000-0000-0000-00000000f001
IN1=0000000f-0000-0000-0000-00000000f001; IN2=0000000f-0000-0000-0000-00000000f002
q(){ psql "$DATABASE_URL" -tA -c "$1"; }
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }

D=$(mktemp -d); mkdir -p "$D/v0"
printf '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\nv0/index.m3u8\n' > "$D/master.m3u8"
printf '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.0,\ns0.m4s\n#EXT-X-ENDLIST\n' > "$D/v0/index.m3u8"
head -c 4096 /dev/urandom > "$D/v0/s0.m4s"; head -c 100 /dev/urandom > "$D/v0/init.mp4"
(cd "$D" && exec python3 -m http.server $HP >/dev/null 2>&1) & HTTPD=$!

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO accounts(id,name,max_channels) VALUES ('$ACC','PreviewCo',10) ON CONFLICT (id) DO NOTHING;
INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES ('$ADM','$ACC','adm@previewco.example','x','admin','active') ON CONFLICT (id) DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('$P1','$ACC','Pkg','[]','package_only') ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,is_default) VALUES ('$G','$ACC','Main','$P1',10,true) ON CONFLICT (id) DO NOTHING;
INSERT INTO channels(id,group_id,name,status,kind) VALUES ('$CH','$G','Preview TV','ended','tv') ON CONFLICT (id) DO NOTHING;
DELETE FROM stream_inputs WHERE channel_id='$CH';
INSERT INTO stream_inputs(id,channel_id,role,protocol,ingest_url,rendition_label,rendition_bitrate_kbps) VALUES
  ('$IN1','$CH','primary','hls','http://localhost:$HP/master.m3u8','720p',2000),
  ('$IN2','$CH','backup','srt','srt://localhost:9000',NULL,NULL);
SQL
npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE id='$ADM'\",[h]); await pool.end();})()" >/dev/null 2>&1
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4
npx tsx src/index.ts >/tmp/source_preview_api.log 2>&1 & API=$!
trap 'kill $API $HTTPD 2>/dev/null; rm -rf "$D"' EXIT
for i in $(seq 1 80); do curl -sf "$B/health" >/dev/null && break; sleep 0.25; done
A="authorization: Bearer $(curl -s -X POST "$B/api/auth/login" -H "$J" -d '{"email":"adm@previewco.example","password":"volt1234"}' | sed -n 's/.*"access":"\([^"]*\)".*/\1/p')"

U=$(curl -s "$B/api/channels/$CH/inputs/$IN1/preview" -H "$A" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
ok "a preview address is issued for the channel's HLS input" '[[ "$U" == /api/source-preview/*/index.m3u8 ]]'
ok "not for a push (SRT) input (400)" '[ "$(code "$B/api/channels/$CH/inputs/$IN2/preview" -H "$A")" = 400 ]'
ok "not without signing in (401)" '[ "$(code "$B/api/channels/$CH/inputs/$IN1/preview")" = 401 ]'
OTHER=$(q "SELECT c.id FROM channels c JOIN groups g ON g.id=c.group_id WHERE g.account_id<>'$ACC' LIMIT 1")
ok "not for another account's channel (404)" '[ -z "$OTHER" ] || [ "$(code "$B/api/channels/$OTHER/inputs/$IN1/preview" -H "$A")" = 404 ]'

M=$(curl -s "$B$U")
ok "the master comes back with its child playlist relayed" 'echo "$M" | grep -q "^pl?u=.*&s=" && ! echo "$M" | grep -q "localhost:$HP"'
BASE=$(dirname "$U")
CHILD=$(echo "$M" | grep "^pl?" | head -1)
C=$(curl -s "$B$BASE/$CHILD")
ok "the media playlist relays its segments and its init map" 'echo "$C" | grep -q "^seg?u=" && echo "$C" | grep -q "EXT-X-MAP:URI=\"seg?u="'
SEG=$(echo "$C" | grep "^seg?" | head -1)
curl -s "$B$BASE/$SEG" -o "$D/got.m4s"
ok "a segment passes through byte for byte" 'cmp -s "$D/got.m4s" "$D/v0/s0.m4s"'
ok "a relayed address with a forged signature is refused (403)" '[ "$(code "$B$BASE/${SEG%%&s=*}&s=forged")" = 403 ]'
EVIL=$(printf 'http://localhost:%s/health' "$PORT" | base64 | tr '+/' '-_' | tr -d '=')
ok "an address that did not come from the playlist is refused (403)" '[ "$(code "$B$BASE/seg?u=$EVIL&s=$(echo "$SEG" | sed -n "s/.*&s=//p")")" = 403 ]'
ok "a bad token is refused (403)" '[ "$(code "$B/api/source-preview/abc.def/index.m3u8")" = 403 ]'
ok "the relay allows playback from the console's origin (CORS)" '[ "$(curl -sI "$B$U" | grep -i "^access-control-allow-origin" | tr -d "\r" | cut -d" " -f2)" = "*" ]'

echo; echo "source-preview: $pass passed, $fail failed"
[ "$fail" = 0 ]
