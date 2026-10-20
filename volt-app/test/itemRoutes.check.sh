#!/usr/bin/env bash
# One item by id for the list-standard collections that had a list but no
# item route (filler assets, scheduled clips, publish targets, publications,
# programmes), so every member's canonical `self` link resolves (deep links).
# Tenant scoping: another account's id is a 404, never a 403 or a leak.
# Paging links: the list standard's Link header carries first/prev/last.
# Needs DATABASE_URL -> a migrated Postgres (scripts/check.js gives each suite one).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?set DATABASE_URL}"
export JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET:-devsecret}
export JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET:-devrefresh}
export INGEST_TOKEN=${INGEST_TOKEN:-dev-ingest}
export PORT=${ITEM_ROUTES_PORT:-18093}
export ORCH_LAUNCHER=mock
LOG=$(mktemp "${TMPDIR:-/tmp}/volt-item-routes.XXXXXX")
A=00000000-0000-0000-0000-0000000001a1
X=00000000-0000-0000-0000-0000000001a2
G=00000000-0000-0000-0000-0000000001b1
D=00000000-0000-0000-0000-0000000001d1
C=00000000-0000-0000-0000-0000000001c1
F=00000000-0000-0000-0000-0000000001f1
S=00000000-0000-0000-0000-000000000151
V=00000000-0000-0000-0000-000000000161
T=00000000-0000-0000-0000-000000000171
P=00000000-0000-0000-0000-000000000181
E=00000000-0000-0000-0000-000000000191

npx tsx src/index.ts >"$LOG" 2>&1 & SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 1 60); do curl -fsS "localhost:$PORT/health" >/dev/null 2>&1 && break || sleep 1; done
PLAT=$(psql "$DATABASE_URL" -tAc "SELECT enum_range(NULL::publish_platform)::text[]" | tr -d '{}' | cut -d, -f1)
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 <<SQL
INSERT INTO accounts(id,name) VALUES ('$A','Item A'),('$X','Item X') ON CONFLICT DO NOTHING;
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('$D','$A','p','[{"height":1080,"bitrate_kbps":5000}]','package_only') ON CONFLICT DO NOTHING;
INSERT INTO groups(id,account_id,name,output_profile_id,max_channels,max_concurrent) VALUES ('$G','$A','g','$D',10,5) ON CONFLICT DO NOTHING;
INSERT INTO channels(id,group_id,name,status) VALUES ('$C','$G','item-news','scheduled') ON CONFLICT DO NOTHING;
INSERT INTO filler_assets(id,account_id,kind,name) VALUES ('$F','$A','slate','Slate one') ON CONFLICT DO NOTHING;
INSERT INTO scheduled_clips(id,channel_id,title,start_epoch_ms,end_epoch_ms) VALUES ('$S','$C','Clip one',1000,2000) ON CONFLICT DO NOTHING;
INSERT INTO vod_assets(id,channel_id,title,master_key,start_epoch_ms,end_epoch_ms,duration_ms) VALUES ('$V','$C','Asset one','vod/x/master.m3u8',0,1000,1000) ON CONFLICT DO NOTHING;
INSERT INTO publish_targets(id,account_id,platform,name) VALUES ('$T','$A','$PLAT','Target one') ON CONFLICT DO NOTHING;
INSERT INTO publications(id,vod_asset_id,platform,target_id) VALUES ('$P','$V','$PLAT','$T') ON CONFLICT DO NOTHING;
INSERT INTO programmes(id,channel_id,title,starts_at,ends_at) VALUES ('$E','$C','Programme one',now(),now()+interval '1 hour') ON CONFLICT DO NOTHING;
SQL
tok(){ node -e "console.log(require('jsonwebtoken').sign({sub:'u',account_id:'$1',role:'owner'},process.env.JWT_ACCESS_SECRET,{expiresIn:3600}))"; }
TA=$(tok $A); TX=$(tok $X)
BASE="http://localhost:$PORT"
pass=0; fail=0
ok(){ echo "  ✓ $1"; pass=$((pass+1)); }
no(){ echo "  ✗ $1"; fail=$((fail+1)); }
code(){ curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $1" "$BASE$2"; }
body(){ curl -fsS -H "Authorization: Bearer $1" "$BASE$2"; }

echo "== item routes =="
for pair in "filler-assets/$F:Slate one" "scheduled-clips/$S:Clip one" "publish-targets/$T:Target one" "publications/$P:$T" "epg/$E:Programme one"; do
  path=${pair%%:*}; want=${pair#*:}
  B=$(body "$TA" "/api/$path" || true)
  echo "$B" | grep -q "\"id\":\"${path#*/}\"" && echo "$B" | grep -q "$want" && ok "GET /api/$path returns the item" || no "GET /api/$path: $(echo "$B" | head -c 160)"
  [ "$(code "$TX" "/api/$path")" = 404 ] && ok "another account gets 404 for /api/$path" || no "another account can read /api/$path"
done
[ "$(code "$TA" "/api/filler-assets/00000000-0000-0000-0000-000000000000")" = 404 ] && ok "unknown id is 404" || no "unknown id is not 404"
# Non-id paths under the same mount are untouched by the item route.
[ "$(code "$TA" "/api/epg/owners")" = 200 ] && ok "/api/epg/owners still answers (item route only matches ids)" || no "/api/epg/owners shadowed"
[ "$(code "$TA" "/api/filler-assets/not-an-id")" = 404 ] && ok "a non-id is not taken by the item route" || no "non-id matched the item route"

echo "== list standard paging links =="
psql "$DATABASE_URL" -q -c "INSERT INTO filler_assets(account_id,kind,name) SELECT '$A','slate','Extra '||g FROM generate_series(1,6) g"
H=$(curl -fsS -D - -o /dev/null -H "Authorization: Bearer $TA" "$BASE/api/filler-assets?limit=3")
echo "$H" | grep -i '^link:' | grep -q 'rel="next"' && echo "$H" | grep -i '^link:' | grep -q 'rel="first"' && echo "$H" | grep -i '^link:' | grep -q 'rel="last"' && ok "page one: next, first, last" || no "page one links: $(echo "$H" | grep -i '^link:')"
echo "$H" | grep -i '^link:' | grep -q 'rel="prev"' && no "page one has prev" || ok "page one has no prev"
NEXT=$(echo "$H" | tr -d '\r' | grep -i '^x-next-cursor:' | awk '{print $2}')
H2=$(curl -fsS -D - -o /dev/null -H "Authorization: Bearer $TA" "$BASE/api/filler-assets?limit=3&cursor=$NEXT")
echo "$H2" | grep -i '^link:' | grep -q 'rel="prev"' && echo "$H2" | tr -d '\r' | grep -qi '^x-prev-cursor:' && ok "page two: prev link and X-Prev-Cursor" || no "page two prev: $(echo "$H2" | grep -i '^link:')"
P1=$(body "$TA" "/api/filler-assets?limit=3" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).map(x=>x.id).join()))")
PREV=$(echo "$H2" | tr -d '\r' | grep -i '^x-prev-cursor:' | awk '{print $2}')
PB=$(body "$TA" "/api/filler-assets?limit=3&cursor=$PREV" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).map(x=>x.id).join()))")
[ "$P1" = "$PB" ] && ok "prev from page two is page one" || no "prev page differs: $P1 vs $PB"
PLAIN=$(body "$TA" "/api/filler-assets?limit=3")
echo "$PLAIN" | grep -q '^\[' && ok "plain JSON body is still a bare array" || no "plain body changed"

echo
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
