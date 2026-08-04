#!/usr/bin/env bash
# Asserts the JSON-LD + Hydra layer: entrypoint, context, ApiDocumentation,
# collection + entity decoration, typed-link navigation, and that plain JSON is
# UNCHANGED when ld+json isn't requested. Needs DATABASE_URL -> empty Postgres.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?set DATABASE_URL}"
export JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET:-devsecret}
export JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET:-devrefresh}
export INGEST_TOKEN=${INGEST_TOKEN:-dev-ingest}
export PORT=${PORT:-8091}
export ORCH_LAUNCHER=mock
A=00000000-0000-0000-0000-0000000000a1
G=00000000-0000-0000-0000-0000000000b1
D=00000000-0000-0000-0000-0000000000d1
C=00000000-0000-0000-0000-0000000000c1
R=00000000-0000-0000-0000-0000000000e1

psql "$DATABASE_URL" -q -f migrations/0001_init.sql
psql "$DATABASE_URL" -q <<SQL
INSERT INTO accounts(id,name) VALUES ('$A','RTM') ON CONFLICT DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('$D','$A','p','[{"height":1080,"bitrate_kbps":5000}]','package_only') ON CONFLICT DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,max_concurrent) VALUES ('$G','$A','g','$D',10,5) ON CONFLICT DO NOTHING;
INSERT INTO channels(id,group_id,name,status) VALUES ('$C','$G','api-news','scheduled') ON CONFLICT DO NOTHING;
INSERT INTO recordings(id,kind,channel_id,day_utc,status,start_epoch_ms,master_key,hi_res_rendition) VALUES ('$R','channel_day','$C','2026-07-30','recording',0,'channel/$C','1080p') ON CONFLICT DO NOTHING;
SQL

npx tsx src/index.ts >/tmp/volt-hyper.log 2>&1 & SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -fsS "localhost:$PORT/health" >/dev/null 2>&1 && break || sleep 1; done
TOKEN=$(node -e "console.log(require('jsonwebtoken').sign({sub:'u',account_id:'$A',role:'owner'},process.env.JWT_ACCESS_SECRET,{expiresIn:3600}))")
BASE="http://localhost:$PORT"
LD='Accept: application/ld+json'
AUTH="Authorization: Bearer $TOKEN"
pass=0; fail=0
ok(){ echo "  ✓ $1"; pass=$((pass+1)); }
no(){ echo "  ✗ $1"; fail=$((fail+1)); }
has(){ echo "$1" | grep -q "$2" && ok "$3" || no "$3 — got: $(echo "$1" | head -c 200)"; }
hasnt(){ echo "$1" | grep -q "$2" && no "$3 (unexpected)" || ok "$3"; }

echo "== entrypoint / discovery =="
E=$(curl -fsS "$BASE/api")
has "$E" '"@type"' "entrypoint has @type"
has "$E" 'hydra:EntryPoint' "entrypoint is hydra:EntryPoint"
has "$E" '/api/channels' "entrypoint links to channels"
has "$E" '/api/doc' "entrypoint links to ApiDocumentation"
CX=$(curl -fsS "$BASE/api/context.jsonld")
has "$CX" 'hydra' "context defines hydra"
has "$CX" 'schema' "context defines schema.org"
DOC=$(curl -fsS "$BASE/api/doc")
has "$DOC" 'hydra:ApiDocumentation' "doc is ApiDocumentation"
has "$DOC" 'hydra:supportedClass' "doc lists supportedClass"

echo "== collection decoration (ld+json) =="
CH=$(curl -fsS -H "$AUTH" -H "$LD" "$BASE/api/channels")
has "$CH" 'hydra:Collection' "channels is a Hydra Collection"
has "$CH" 'hydra:member' "collection has member"
has "$CH" 'hydra:totalItems' "collection has totalItems"
has "$CH" 'hydra:PartialCollectionView' "collection has view"
has "$CH" '"@id"' "members carry @id"
has "$CH" '/api/status/channel/' "member has typed status link"
has "$CH" '/api/recordings?channelId=' "member has typed recordings link"

echo "== entity decoration (ld+json) =="
EN=$(curl -fsS -H "$AUTH" -H "$LD" "$BASE/api/channels/$C")
has "$EN" 'volt:Channel' "entity typed volt:Channel"
has "$EN" "\"@id\":" "entity has @id"
has "$EN" 'hydra:Operation' "entity exposes operations"
has "$EN" '"up":' "entity has up link"
has "$EN" '"collection":' "entity has collection link"

echo "== typed-link navigation (follow member.recordings) =="
REC=$(curl -fsS -H "$AUTH" -H "$LD" "$BASE/api/recordings?channelId=$C")
has "$REC" 'hydra:Collection' "recordings collection resolves"
has "$REC" '/api/vod?recordingId=' "recording links onward to vod"
has "$REC" '"up":' "recording walks up to channel"

echo "== content negotiation: plain JSON is UNCHANGED =="
PLAIN=$(curl -fsS -H "$AUTH" "$BASE/api/channels")
hasnt "$PLAIN" '@context' "plain channels has no @context"
hasnt "$PLAIN" 'hydra:member' "plain channels is a bare array"
echo "$PLAIN" | grep -q '"id"' && ok "plain channels still returns rows" || no "plain channels empty"

echo
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
