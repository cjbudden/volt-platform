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
INSERT INTO channels(id,group_id,name,status) VALUES
  ('00000000-0000-0000-0000-0000000000c2','$G','api-sport','scheduled'),
  ('00000000-0000-0000-0000-0000000000c3','$G','api-music','scheduled'),
  ('00000000-0000-0000-0000-0000000000c4','$G','api-kids','scheduled') ON CONFLICT DO NOTHING;
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
has "$CH" '/api/status?channelId=' "member has typed status link"
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

echo "== paging, siblings, breadcrumb, search (navigability) =="
J(){ node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d);const f=new Function('o','return ('+process.argv[1]+')');console.log(JSON.stringify(f(o)))})" "$1"; }
chk(){ [ "$(echo "$1" | J "$2")" = "true" ] && ok "$3" || no "$3 — $(echo "$1" | J "$4" 2>/dev/null | head -c 300)"; }
P1=$(curl -fsS -H "$AUTH" -H "$LD" "$BASE/api/channels?limit=2&sort=name")
chk "$P1" "o['hydra:member'].length===2" "limit=2 gives a 2-member page" "o['hydra:member'].length"
chk "$P1" "o['hydra:totalItems']===4" "totalItems counts every match, not the page" "o['hydra:totalItems']"
chk "$P1" "!!o['hydra:view'].first && !o['hydra:view'].first.includes('cursor=')" "view.first has no cursor" "o['hydra:view']"
chk "$P1" "/cursor=/.test(o['hydra:view'].next)" "view.next carries the cursor" "o['hydra:view']"
chk "$P1" "o['hydra:member'][0].nextSibling===o['hydra:member'][1]['@id'] && o['hydra:member'][1].previousSibling===o['hydra:member'][0]['@id']" "members link to their siblings in view order" "o['hydra:member'].map(m=>[m.previousSibling,m.nextSibling])"
chk "$P1" "o['hydra:search']['@type']==='hydra:IriTemplate' && o['hydra:search']['hydra:template'].includes('{?q,')" "collection publishes its filters as an IriTemplate" "o['hydra:search']"
NEXT=$(echo "$P1" | J "o['hydra:view'].next" | tr -d '"')
P2=$(curl -fsS -H "$AUTH" -H "$LD" "$NEXT")
chk "$P2" "o['hydra:member'].length===2 && !o['hydra:view'].next" "following next reaches the last page" "o['hydra:view']"
chk "$P2" "o['hydra:member'][0].name==='api-news'" "page 2 continues the sorted view" "o['hydra:member'].map(m=>m.name)"
chk "$P2" "/cursor=/.test(o['hydra:view'].previous) && !!o['hydra:view'].last" "page 2 offers previous and last" "o['hydra:view']"
PREV=$(echo "$P2" | J "o['hydra:view'].previous" | tr -d '"')
P3=$(curl -fsS -H "$AUTH" -H "$LD" "$PREV")
chk "$P3" "o['hydra:member'].map(m=>m.name).join()===$(echo "$P1" | J "o['hydra:member'].map(m=>m.name).join()")" "following previous returns to page 1" "o['hydra:member'].map(m=>m.name)"
EN2=$(curl -fsS -H "$AUTH" -H "$LD" "$BASE/api/channels/$C")
chk "$EN2" "Array.isArray(o.breadcrumb) && o.breadcrumb[0]['@id'].endsWith('/api') && o.breadcrumb.at(-1)['@id']===o['@id']" "entity breadcrumb runs entry point -> self" "o.breadcrumb"
chk "$EN2" "o.breadcrumb.at(-1).title==='api-news'" "breadcrumb names the item" "o.breadcrumb"
chk "$EN2" "o.siblings.endsWith('/api/channels')" "entity links to its siblings" "o.siblings"
RE1=$(curl -fsS -H "$AUTH" -H "$LD" "$BASE/api/recordings/$R" || echo '{}')
chk "$RE1" "!o.breadcrumb || o.breadcrumb.some(c=>c['@id'].endsWith('/api/channels/$C'))" "a recording's breadcrumb runs through its channel" "o.breadcrumb"

echo "== coverage: every list endpoint, not only the registry =="
JB=$(curl -fsS -H "$AUTH" -H "$LD" "$BASE/api/jobs")
chk "$JB" "o['@type']==='hydra:Collection' && o['volt:memberKey']==='jobs'" "wrapped list { jobs } is a Hydra Collection" "o['@type']"
US=$(curl -fsS -H "$AUTH" -H "$LD" "$BASE/api/users")
chk "$US" "o['@type']==='hydra:Collection' && o['hydra:member'].every(m=>m['@type']==='volt:User')" "users members are typed volt:User" "o['hydra:member'].map(m=>m['@type'])"
HI=$(curl -sS -H "$AUTH" -H "$LD" "$BASE/api/channels/$C/history")
chk "$HI" "!o['hydra:member'] || o.up.endsWith('/api/channels/$C')" "a sub-resource links up to its item" "o"
chk "$HI" "!JSON.stringify(o).includes('volt:Channel')" "a sub-resource is not mislabelled as a Channel" "o"

echo "== discovery: entry point, operations, vocabulary =="
E2=$(curl -fsS "$BASE/api")
chk "$E2" "['radio','jobs','users','apps','shareLinks','tickets'].every(k=>typeof o[k]==='string')" "entry point links radio, EPG, jobs, users, apps, share links, tickets" "Object.keys(o)"
chk "$E2" "o.operation[0].target.endsWith('/api/auth/login') && o.operation[0]['hydra:method']==='POST' && !o.login" "entry point advertises sign-in as a POST operation, not a GET link" "o.operation"
chk "$E2" "o.epg['@type']==='hydra:IriTemplate' && o.publications['@type']==='hydra:IriTemplate'" "scoped collections (EPG, publications) are templates, not dead links" "[o.epg,o.publications]"
chk "$EN2" "o.history && o.history.endsWith('/api/channels/$C/history') && o.epg.includes('/api/epg?channelId=')" "entity links drill down to its sub-resources and its EPG" "Object.keys(o)"
ST=$(curl -fsS -H "$AUTH" -H "$LD" "$(echo "$EN2" | J "o.status" | tr -d '"')")
chk "$ST" "o['@type']==='hydra:Collection'" "a never-run channel's status link answers (200), not 404" "o"
chk "$E2" "Object.keys(o).filter(k=>typeof o[k]==='string'&&o[k].includes('/api/')).length>=25" "entry point reaches at least 25 collections" "Object.keys(o).length"
DOC2=$(curl -fsS "$BASE/api/doc")
chk "$DOC2" "o['hydra:supportedClass'].find(c=>c['@id']==='volt:Channel')['hydra:supportedOperation'].some(x=>x['hydra:method']==='POST'&&/\/channels\/\{id\}\/start$/.test(x.target))" "doc declares POST /channels/{id}/start" "o['hydra:supportedClass'].find(c=>c['@id']==='volt:Channel')['hydra:supportedOperation'].map(x=>x['hydra:method']+' '+x.target)"
chk "$DOC2" "o['hydra:supportedClass'].find(c=>c['@id']==='volt:Channel')['hydra:supportedProperty'].some(p=>p['hydra:title']==='name')" "doc declares Channel properties" "0"
chk "$DOC2" "o['hydra:supportedClass'].length>=25" "doc describes at least 25 classes" "o['hydra:supportedClass'].length"
CX2=$(curl -fsS "$BASE/api/context.jsonld")
chk "$CX2" "o['@context'].volt.endsWith('/api/doc#')" "volt: vocabulary dereferences to /api/doc" "o['@context'].volt"

echo "== plain JSON advertises the hypermedia view =="
HD=$(curl -fsS -D - -o /dev/null -H "$AUTH" "$BASE/api/channels?limit=2")
echo "$HD" | grep -i '^link:' | grep -q 'rel="alternate"; type="application/ld+json"' && ok "plain JSON carries Link rel=alternate ld+json" || no "no alternate Link header: $(echo "$HD" | grep -i link)"
echo "$HD" | grep -i '^link:' | grep -q 'rel="next"' && ok "plain JSON still carries the list standard's rel=next" || no "rel=next lost"
FJ=$(curl -fsS -H "$AUTH" "$BASE/api/channels?format=jsonld&limit=1")
chk "$FJ" "o['@type']==='hydra:Collection'" "?format=jsonld selects the hypermedia view" "o['@type']"

echo
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
