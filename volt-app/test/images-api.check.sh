#!/usr/bin/env bash
# Image service through the REAL control plane: upload an image to the library,
# get the account's signing key, sign through the API, render through /img,
# and prove the refusals (unsigned, tampered, other account, other account's
# key, guards). Also builds a URL with the SDK and the signing key, the way the
# console and partner apps do, and checks the console-facing config.
# Run from volt-app/ with DATABASE_URL set.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8517}"
CACHE_DIR="$(mktemp -d)"; STORE_DIR="$(mktemp -d)"
export PORT JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y INGEST_TOKEN=z ORCH_LAUNCHER=mock CORS_ORIGIN='*' \
  PUBLIC_BASE_URL="http://localhost:$PORT" IMAGE_STORE_DIR="$STORE_DIR" IMAGE_CACHE_DIR="$CACHE_DIR" \
  IMAGE_SIGNING_SECRET="images-api-check-secret-0123456789abcdef"
fuser -k "$PORT"/tcp 2>/dev/null; sleep 0.4
pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
B="http://localhost:$PORT/api"; J='content-type:application/json'
ACC=0000000a-0000-0000-0000-00000000ae01; OTH=0000000a-0000-0000-0000-00000000ae02
q(){ psql "$DATABASE_URL" -tA -c "$1"; }
jget(){ python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO accounts(id,name) VALUES ('$ACC','ImageCo'),('$OTH','OtherImageCo') ON CONFLICT (id) DO NOTHING;
INSERT INTO users(id,account_id,email,password_hash,role,status,display_name) VALUES
  ('0000000b-0000-0000-0000-00000000ae01','$ACC','img@image.example','x','owner','active','Img'),
  ('0000000b-0000-0000-0000-00000000ae02','$OTH','oth@otherimage.example','x','owner','active','Oth') ON CONFLICT (id) DO NOTHING;
DELETE FROM media_files WHERE account_id IN ('$ACC','$OTH');
SQL
npx tsx -e "import {hashPassword} from './src/auth/password'; import {query,pool} from './src/db'; (async()=>{const h=await hashPassword('volt1234'); await query(\"UPDATE users SET password_hash=\$1 WHERE email IN ('img@image.example','oth@otherimage.example')\",[h]); await pool.end();})()" >/dev/null 2>&1
npx tsx src/index.ts >/tmp/images_api.log 2>&1 &
API=$!
trap 'kill $API 2>/dev/null; rm -rf "$CACHE_DIR" "$STORE_DIR"' EXIT
for i in $(seq 1 80); do curl -sf "http://localhost:$PORT/health" >/dev/null && break; sleep 0.25; done
login(){ curl -s -X POST "$B/auth/login" -H "$J" -d "{\"email\":\"$1\",\"password\":\"volt1234\"}" | sed -n 's/.*"access":"\([^"]*\)".*/\1/p'; }
A="authorization: Bearer $(login img@image.example)"; O="authorization: Bearer $(login oth@otherimage.example)"
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }
hdr(){ curl -s -D - -o /dev/null "$1" | tr -d '\r' | sed -n "s/^$2: //Ip"; }

# ---- upload a 1200x800 PNG into the library
PNG=$(node -e "require('sharp')({create:{width:1200,height:800,channels:3,background:'#336699'}}).png().toBuffer().then(b=>process.stdout.write(b.toString('base64')))")
C=$(code -X POST "$B/files" -H "$A" -H "$J" -d "{\"folder\":\"posters\",\"name\":\"grand final.png\",\"kind\":\"poster\",\"dataBase64\":\"$PNG\"}")
ok "upload an image to the library (201)" '[ "$C" = 201 ]'
KEY="library/$ACC/posters/grand final.png"

# ---- the old unsigned shape is gone
ok "unsigned /img URL is refused (403)" '[ "$(code "http://localhost:$PORT/img/320x200,cover/library/$ACC/posters/grand%20final.png")" = 403 ]'

# ---- sign through the API (the first published contract)
S=$(curl -s -X POST "$B/images/sign" -H "$A" -H "$J" -d '{"path":"posters/grand final.png","fit":"fit-in","width":1280,"height":720,"filters":{"format":"webp","quality":82,"sharpen":60},"expiresIn":3600}')
URL=$(echo "$S" | jget 'd["url"]')
ok "POST /api/images/sign returns a URL on the image base" '[[ "$URL" == http://localhost:$PORT/img/* ]]'
ok "the spec carries the upload version (v=)" 'echo "$S" | jget "d[\"spec\"]" | grep -q ",v=[0-9]\{14\}"'
ok "the signed URL renders (200)" '[ "$(code "$URL")" = 200 ]'
ok "rendered as webp" '[ "$(hdr "$URL" content-type)" = image/webp ]'
ok "immutable for a year" '[ "$(hdr "$URL" cache-control)" = "public, max-age=31536000, immutable" ]'
ok "second fetch is served from memory" '[ "$(hdr "$URL" x-image-cache)" = MEMORY ]'
ok "the derivative is in the cache directory" '[ -n "$(find "$CACHE_DIR/img" -type f | head -1)" ]'
DIM=$(curl -s "$URL" | node -e "let b=[];process.stdin.on('data',c=>b.push(c)).on('end',()=>require('sharp')(Buffer.concat(b)).metadata().then(m=>console.log(m.width+'x'+m.height)))")
ok "fit-in 1280x720 of a 1200x800 source stays inside the box, no upscale ($DIM)" '[ "$DIM" = 1080x720 ]'
TAMPER=$(echo "$URL" | sed 's/1280x720/1281x720/')
ok "a tampered URL is refused (403)" '[ "$(code "$TAMPER")" = 403 ]'

# ---- batch
N=$(curl -s -X POST "$B/images/sign" -H "$A" -H "$J" -d '{"items":[{"path":"posters/grand final.png","width":320,"height":180},{"path":"posters/grand final.png","width":64,"height":64,"grayscale":true,"format":"png"}]}' | jget 'len(d["items"])')
ok "batch signing returns every item" '[ "$N" = 2 ]'

# ---- guards and tenancy at sign time
ok "oversize is refused at sign time (400)" '[ "$(code -X POST "$B/images/sign" -H "$A" -H "$J" -d "{\"path\":\"posters/grand final.png\",\"width\":9000}")" = 400 ]'
ok "another account cannot sign this account's image (403)" '[ "$(code -X POST "$B/images/sign" -H "$O" -H "$J" -d "{\"key\":\"$KEY\",\"width\":100}")" = 403 ]'
ok "signing needs a session (401)" '[ "$(code -X POST "$B/images/sign" -H "$J" -d "{\"path\":\"x.png\",\"width\":100}")" = 401 ]'

# ---- the console path: signing key + SDK
SK=$(curl -s "$B/images/signing-key" -H "$A")
K=$(echo "$SK" | jget 'd["key"]')
ok "signing key is per account" '[ "$K" != "$(curl -s "$B/images/signing-key" -H "$O" | jget "d[\"key\"]")" ]'
ok "signing key is never cached" '[ "$(curl -s -D - -o /dev/null "$B/images/signing-key" -H "$A" | tr -d "\r" | sed -n "s/^cache-control: //Ip")" = "private, no-store" ]'
SDKURL=$(npx tsx -e "import {imageUrl} from './src/services/images/sdk'; console.log(imageUrl({baseUrl:'http://localhost:$PORT', key:'$KEY', accountKey:'$K', width:400, height:400, focus:'smart', format:'jpeg', quality:70}))")
ok "an SDK-built URL renders (200)" '[ "$(code "$SDKURL")" = 200 ]'
OK2=$(curl -s "$B/images/signing-key" -H "$O" | jget 'd["key"]')
FORGED=$(npx tsx -e "import {imageUrl} from './src/services/images/sdk'; console.log(imageUrl({baseUrl:'http://localhost:$PORT', key:'$KEY', accountKey:'$OK2', width:400, height:400}))")
ok "another account's key cannot reach this account's image (403)" '[ "$(code "$FORGED")" = 403 ]'
ok "config lists limits and the base URL" '[ "$(curl -s "$B/images/config" -H "$A" | jget "d[\"maxDimension\"]")" = 4096 ]'
ok "stats count the renders" '[ "$(curl -s "$B/images/stats" -H "$A" | jget "d[\"renders\"] >= 2")" = True ]'

# ---- originals keep their safety headers
ok "originals are served nosniff" '[ "$(hdr "http://localhost:$PORT/library/$ACC/posters/grand%20final.png" x-content-type-options)" = nosniff ]'

echo; echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
