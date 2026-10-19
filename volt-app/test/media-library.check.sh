#!/usr/bin/env bash
# Image library through the REAL control plane: an upload records the file's
# own metadata (EXIF, GPS, IPTC/XMP) in the database; search finds images by
# place, keyword, camera, title and name, and finds folders; the folder tree
# loads lazily; metadata can be refreshed and backfilled; the thumbnails API
# is scoped to the caller's account.
# Run from volt-app/ with DATABASE_URL set.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8519}"
STORE_DIR="$(mktemp -d)"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*' \
  PUBLIC_BASE_URL="http://localhost:$PORT" IMAGE_STORE_DIR="$STORE_DIR" THUMBS_ENABLED=0 \
  IMAGE_SIGNING_SECRET="media-library-check-secret-0123456789abcdef"
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4
pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
B="http://localhost:$PORT/api"; J='content-type:application/json'
ACC=0000000a-0000-0000-0000-00000000ab01; OTH=0000000a-0000-0000-0000-00000000ab02
G=0000000d-0000-0000-0000-00000000ab01; CH=0000000e-0000-0000-0000-00000000ab01
q(){ psql "$DATABASE_URL" -tA -c "$1"; }
jget(){ python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO accounts(id,name) VALUES ('$ACC','LibCo'),('$OTH','OtherLibCo') ON CONFLICT (id) DO NOTHING;
INSERT INTO users(id,account_id,email,password_hash,role,status,display_name) VALUES
  ('0000000b-0000-0000-0000-00000000ab01','$ACC','lib@lib.example','x','owner','active','Lib'),
  ('0000000b-0000-0000-0000-00000000ab02','$OTH','oth@otherlib.example','x','owner','active','Oth') ON CONFLICT (id) DO NOTHING;
INSERT INTO groups(id,account_id,name) VALUES ('$G','$ACC','G') ON CONFLICT (id) DO NOTHING;
INSERT INTO channels(id,group_id,name,status,tz,kind) VALUES ('$CH','$G','Lib News','ended','Australia/Brisbane','tv') ON CONFLICT (id) DO NOTHING;
DELETE FROM media_files WHERE account_id IN ('$ACC','$OTH');
DELETE FROM media_folders WHERE account_id IN ('$ACC','$OTH');
SQL
npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE email IN ('lib@lib.example','oth@otherlib.example')\",[h]); await pool.end();})()" >/dev/null 2>&1
npx tsx src/index.ts >/tmp/media_library_api.log 2>&1 &
API=$!
trap 'kill $API 2>/dev/null; rm -rf "$STORE_DIR"' EXIT
for i in $(seq 1 80); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
login(){ curl -s -X POST "$B/auth/login" -H "$J" -d "{\"email\":\"$1\",\"password\":\"volt1234\"}" | sed -n 's/.*"access":"\([^"]*\)".*/\1/p'; }
A="authorization: Bearer $(login lib@lib.example)"; O="authorization: Bearer $(login oth@otherlib.example)"
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }

# ---- a photo with EXIF + GPS + XMP place names, and a plain logo
PHOTO=$(node -e "
const sharp=require('sharp');
const xmp='<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:photoshop=\"http://ns.adobe.com/photoshop/1.0/\"><dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">Grand Final crowd</rdf:li></rdf:Alt></dc:title><dc:subject><rdf:Bag><rdf:li>football</rdf:li><rdf:li>crowd</rdf:li></rdf:Bag></dc:subject><photoshop:City>Melbourne</photoshop:City><photoshop:Country>Australia</photoshop:Country></rdf:Description></rdf:RDF></x:xmpmeta>';
sharp({create:{width:640,height:427,channels:3,background:'#246'}}).jpeg().withExif({IFD0:{Make:'Canon',Model:'Canon EOS R5'},IFD2:{DateTimeOriginal:'2026:09:26 14:30:00',OffsetTimeOriginal:'+10:00'},IFD3:{GPSLatitudeRef:'S',GPSLatitude:'37/1 49/1 12/1',GPSLongitudeRef:'E',GPSLongitude:'144/1 59/1 0/1'}}).withXmp(xmp).toBuffer().then(b=>process.stdout.write(b.toString('base64')))")
LOGO=$(node -e "require('sharp')({create:{width:200,height:200,channels:4,background:'#f80'}}).png().toBuffer().then(b=>process.stdout.write(b.toString('base64')))")
R=$(curl -s -X POST "$B/files" -H "$A" -H "$J" -d "{\"folder\":\"sport/afl\",\"name\":\"crowd.jpg\",\"kind\":\"poster\",\"dataBase64\":\"$PHOTO\"}")
ID=$(echo "$R" | jget 'd["id"]')
ok "upload answers with the new row" '[ -n "$ID" ]'
ok "the row is in the database" '[ "$(q "SELECT count(*) FROM media_files WHERE id='"'"'$ID'"'"'")" = 1 ]'
ok "GPS is recorded" '[ "$(q "SELECT round(gps_lat::numeric,2)||'"'"','"'"'||round(gps_lng::numeric,2) FROM media_files WHERE id='"'"'$ID'"'"'")" = "-37.82,144.98" ]'
ok "the place name is recorded" '[ "$(q "SELECT location FROM media_files WHERE id='"'"'$ID'"'"'")" = "Melbourne, Australia" ]'
ok "camera, date taken, title and keywords are recorded" '[ "$(q "SELECT camera||'"'"'|'"'"'||to_char(taken_at AT TIME ZONE '"'"'UTC'"'"','"'"'YYYY-MM-DD HH24:MI'"'"')||'"'"'|'"'"'||title||'"'"'|'"'"'||array_to_string(keywords,'"'"','"'"') FROM media_files WHERE id='"'"'$ID'"'"'")" = "Canon EOS R5|2026-09-26 04:30|Grand Final crowd|football,crowd" ]'
ok "source is upload, with a checksum" '[ "$(q "SELECT source||length(checksum) FROM media_files WHERE id='"'"'$ID'"'"'")" = upload64 ]'
ok "the API shows the metadata" '[ "$(curl -s "$B/files/$ID" -H "$A" | jget "d[\"metadata\"][\"format\"]")" = jpeg ]'
ok "the search vector is not sent to clients" '[ "$(curl -s "$B/files/$ID" -H "$A" | jget "\"search\" in d")" = False ]'
C=$(code -X POST "$B/files" -H "$A" -H "$J" -d "{\"folder\":\"brands\",\"name\":\"logo.png\",\"kind\":\"brand\",\"dataBase64\":\"$LOGO\"}")
ok "a plain image uploads too" '[ "$C" = 201 ]'
DUP=$(curl -s -X POST "$B/files" -H "$A" -H "$J" -d "{\"folder\":\"sport\",\"name\":\"crowd-copy.jpg\",\"dataBase64\":\"$PHOTO\"}" | jget 'len(d["duplicateOf"])')
ok "the same bytes uploaded again are flagged as a duplicate" '[ "$DUP" = 1 ]'

# ---- search
n(){ curl -s "$B/files?$1" -H "$A" | jget 'len(d)'; }
ok "search by place" '[ "$(n "q=melbourne")" = 2 ]'
ok "search by keyword prefix" '[ "$(n "q=footb")" = 2 ]'
ok "search by camera" '[ "$(n "q=canon%20r5")" = 2 ]'
ok "search by title words" '[ "$(n "q=grand%20crowd")" = 2 ]'
ok "search by a fragment of a name" '[ "$(n "q=ogo")" = 1 ]'
ok "nothing for an unrelated word" '[ "$(n "q=zebra")" = 0 ]'
ok "filter: has a location" '[ "$(n "hasLocation=1")" = 2 ]'
ok "filter: near Melbourne (10 km)" '[ "$(n "near=-37.81,144.96,10")" = 2 ]'
ok "filter: not near Sydney" '[ "$(n "near=-33.86,151.21,50")" = 0 ]'
ok "filter: taken in a window" '[ "$(n "from=2026-09-26T00:00:00Z&to=2026-09-27T00:00:00Z")" = 2 ]'
ok "filter: source" '[ "$(n "source=upload")" = 3 ]'
ok "total count header" '[ "$(curl -s -D - -o /dev/null "$B/files?q=melbourne" -H "$A" | tr -d "\r" | sed -n "s/^x-total-count: //Ip")" = 2 ]'
ok "bad near is a 400" '[ "$(code "$B/files?near=north" -H "$A")" = 400 ]'
ok "another account finds none of it" '[ "$(curl -s "$B/files?q=melbourne" -H "$O" | jget "len(d)")" = 0 ]'
S=$(curl -s "$B/files/search?q=afl" -H "$A")
ok "one search box finds folders" '[ "$(echo "$S" | jget "[f[\"path\"] for f in d[\"folders\"]]")" = "['"'"'sport/afl'"'"']" ]'
ok "and files" '[ "$(curl -s "$B/files/search?q=crowd" -H "$A" | jget "d[\"total\"]")" = 2 ]'

# ---- folders: lazy tree and search
ok "root children" '[ "$(curl -s "$B/files/folders?parent=" -H "$A" | jget "[f[\"path\"] for f in d[\"folders\"]]")" = "['"'"'brands'"'"', '"'"'sport'"'"']" ]'
ok "children of sport, with totals and hasChildren" '[ "$(curl -s "$B/files/folders?parent=sport" -H "$A" | jget "[(f[\"path\"],f[\"total\"],f[\"hasChildren\"]) for f in d[\"folders\"]]")" = "[('"'"'sport/afl'"'"', 1, False)]" ]'
ok "sport counts everything under it" '[ "$(curl -s "$B/files/folders?parent=" -H "$A" | jget "[f[\"total\"] for f in d[\"folders\"] if f[\"path\"]==\"sport\"][0]")" = 2 ]'
ok "folder search" '[ "$(curl -s "$B/files/folders?q=af" -H "$A" | jget "len(d[\"folders\"])")" = 1 ]'
ok "the full tree is still there for old clients" '[ "$(curl -s "$B/files/folders" -H "$A" | jget "len(d[\"folders\"])")" = 3 ]'

# ---- metadata refresh and backfill
q "UPDATE media_files SET checksum=NULL, gps_lat=NULL, location=NULL WHERE id='$ID'" >/dev/null
BF=$(curl -s -X POST "$B/files/metadata/backfill" -H "$A")
ok "backfill re-reads files missing metadata" '[ "$(echo "$BF" | jget "d[\"refreshed\"]")" = 1 ] && [ "$(echo "$BF" | jget "d[\"remaining\"]")" = 0 ]'
ok "and restores what the file says" '[ "$(q "SELECT location FROM media_files WHERE id='"'"'$ID'"'"'")" = "Melbourne, Australia" ]'
ok "one file can be refreshed" '[ "$(code -X POST "$B/files/$ID/metadata/refresh" -H "$A")" = 200 ]'
ok "but not another account's" '[ "$(code -X POST "$B/files/$ID/metadata/refresh" -H "$O")" = 404 ]'

# ---- thumbnails API: scoping and shape
NOW=$(date +%s000)
ok "storyboard needs a stream" '[ "$(code "$B/thumbnails/storyboard?from=1&to=2" -H "$A")" = 400 ]'
ok "storyboard of another account's channel is 404" '[ "$(code "$B/thumbnails/storyboard?stream=$CH&from=$((NOW-3600000))&to=$NOW" -H "$O")" = 404 ]'
SB=$(curl -s "$B/thumbnails/storyboard?stream=$CH&from=$((NOW-3600000))&to=$NOW" -H "$A")
ok "storyboard answers its layout" '[ "$(echo "$SB" | jget "(d[\"tileW\"],d[\"tileH\"],d[\"intervalMs\"])")" = "(160, 90, 10000)" ]'
ok "a span over 48 h is refused" '[ "$(code "$B/thumbnails/storyboard?stream=$CH&from=0&to=$NOW" -H "$A")" = 400 ]'
ok "range VTT is WebVTT" '[ "$(curl -s "$B/thumbnails/vtt?stream=$CH&from=$((NOW-3600000))&to=$NOW" -H "$A" | head -1)" = WEBVTT ]'
ok "unknown VOD asset VTT is 404" '[ "$(code "$B/thumbnails/vod/00000000-0000-0000-0000-000000000000.vtt" -H "$A")" = 404 ]'
ok "build is accepted" '[ "$(code -X POST "$B/thumbnails/build" -H "$A" -H "$J" -d "{\"stream\":\"$CH\",\"from\":$((NOW-3600000)),\"to\":$NOW}")" = 202 ]'
ok "status lists hours" '[ "$(curl -s "$B/thumbnails/status?stream=$CH" -H "$A" | jget "d[\"folder\"]")" = thumbnails/Lib-News ]'

echo; echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
