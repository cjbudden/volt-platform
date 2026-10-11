#!/usr/bin/env bash
# Re-key hand-typed (version 0) ids to random UUIDs: a dry run changes nothing;
# --apply moves keys and every reference (uuid, uuid[], text image paths,
# jsonb), renames the library and origin folders named by an old id and
# rewrites index files that mention one; foreign keys still line up; generated
# (version 4) ids are left alone; a second run finds nothing; it refuses while
# the app is serving. Uses its own scratch database. Run from volt-app/ with
# DATABASE_URL pointing at any database on the same server.
set -uo pipefail
cd "$(dirname "$0")/.."
pass=0; fail=0
ok(){ if eval "$2"; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
SCR="volt_rekey_check_$$"
ADMIN=$(echo "$DATABASE_URL" | sed -E 's#/([^/?]+)(\?|$)#/postgres\2#')
DB=$(echo "$DATABASE_URL" | sed -E "s#/([^/?]+)(\\?|\$)#/$SCR\\2#")
W=$(mktemp -d)
cleanup(){ psql "$ADMIN" -qc "DROP DATABASE IF EXISTS $SCR" >/dev/null 2>&1; rm -rf "$W"; }
trap cleanup EXIT
psql "$ADMIN" -qc "CREATE DATABASE $SCR" || exit 1
DATABASE_URL="$DB" node scripts/migrate.js >/dev/null 2>&1 || { echo "FAIL migrate"; exit 1; }
q(){ psql "$DB" -tA -c "$1"; }
A=00000000-0000-0000-0000-00000000a001; C=00000000-0000-0000-0000-0000000c0001
psql "$DB" -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO accounts(id,name) VALUES ('$A','RTM');
INSERT INTO users(id,account_id,email,password_hash,role,status) VALUES ('00000000-0000-0000-0000-0000000a0001','$A','a@rtm.example','x','owner','active');
INSERT INTO output_profiles(id,account_id,name,rungs,workflow_type) VALUES ('00000000-0000-0000-0000-00000000d001','$A','HD','[]','transcode');
INSERT INTO groups(id,account_id,name,output_profile_id) VALUES ('00000000-0000-0000-0000-00000000b001','$A','Main','00000000-0000-0000-0000-00000000d001');
INSERT INTO channels(id,group_id,name,status,tz,kind,brand_ref,metadata) VALUES
  ('$C','00000000-0000-0000-0000-00000000b001','RTM News 24','ended','UTC','tv','/library/$A/brands/logo.png','{"logo":"/library/$A/brands/logo.png"}'),
  (gen_random_uuid(),'00000000-0000-0000-0000-00000000b001','Made in the app','ended','UTC','tv',NULL,'{}');
SQL
KEEP=$(q "SELECT id FROM channels WHERE name='Made in the app'")
mkdir -p "$W/origin/$C/rec" "$W/img/library/$A/brands" "$W/clips" "$W/filler"
echo "{\"channel\":\"$C\"}" > "$W/origin/$C/rec/index.json"; echo png > "$W/img/library/$A/brands/logo.png"
run(){ DATABASE_URL="$DB" PORT="${RK_PORT:-8597}" ORIGIN_DIR="$W/origin" IMAGE_STORE_DIR="$W/img" CLIPS_DIR="$W/clips" FILLER_DIR="$W/filler" \
       JWT_ACCESS_SECRET=x JWT_REFRESH_SECRET=y npx tsx scripts/rekey-placeholder-ids.ts "$@" 2>&1; }

OUT=$(run)
ok "a dry run lists the hand-typed ids" 'echo "$OUT" | grep -q "RTM News 24" && echo "$OUT" | grep -q "Dry run"'
ok "and changes nothing" '[ "$(q "SELECT count(*) FROM channels WHERE id='"'"'$C'"'"'")" = 1 ]'

( python3 -m http.server 8597 --bind 127.0.0.1 >/dev/null 2>&1 & echo $! > "$W/srv.pid" ); sleep 0.6
OUT=$(run --apply)
ok "it refuses while something serves on the app's port" 'echo "$OUT" | grep -q "Stop it first" && [ "$(q "SELECT count(*) FROM accounts WHERE id='"'"'$A'"'"'")" = 1 ]'
kill "$(cat "$W/srv.pid")" 2>/dev/null; sleep 0.3

OUT=$(run --apply)
NA=$(q "SELECT id FROM accounts WHERE name='RTM'"); NC=$(q "SELECT id FROM channels WHERE name='RTM News 24'")
ok "the account and channel get version 4 ids" '[[ "$NA" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4 ]] && [[ "$NC" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4 ]]'
ok "no version 0 id is left anywhere" '[ "$(q "SELECT (SELECT count(*) FROM accounts WHERE id::text ~ '"'"'^........-....-0'"'"') + (SELECT count(*) FROM users WHERE id::text ~ '"'"'^........-....-0'"'"') + (SELECT count(*) FROM groups WHERE id::text ~ '"'"'^........-....-0'"'"') + (SELECT count(*) FROM output_profiles WHERE id::text ~ '"'"'^........-....-0'"'"') + (SELECT count(*) FROM channels WHERE id::text ~ '"'"'^........-....-0'"'"')")" = 0 ]'
ok "references follow: user, group and profile point at the new ids" '[ "$(q "SELECT count(*) FROM users u JOIN groups g ON g.account_id=u.account_id JOIN output_profiles p ON p.id=g.output_profile_id JOIN channels c ON c.group_id=g.id WHERE u.account_id='"'"'$NA'"'"' AND c.id='"'"'$NC'"'"'")" = 1 ]'
ok "the image path names the new account id" '[ "$(q "SELECT brand_ref FROM channels WHERE id='"'"'$NC'"'"'")" = "/library/$NA/brands/logo.png" ]'
ok "and so does the same path inside jsonb" '[ "$(q "SELECT metadata->>'"'"'logo'"'"' FROM channels WHERE id='"'"'$NC'"'"'")" = "/library/$NA/brands/logo.png" ]'
ok "an id the app generated is untouched" '[ "$(q "SELECT count(*) FROM channels WHERE id='"'"'$KEEP'"'"'")" = 1 ]'
ok "the library folder moved with the account" '[ -f "$W/img/library/$NA/brands/logo.png" ] && [ ! -e "$W/img/library/$A" ]'
ok "the origin folder moved with the channel" '[ -d "$W/origin/$NC/rec" ] && [ ! -e "$W/origin/$C" ]'
ok "and its index file names the new id" 'grep -q "$NC" "$W/origin/$NC/rec/index.json"'
OUT=$(run --apply)
ok "a second run finds nothing" 'echo "$OUT" | grep -q "No hand-typed ids"'

echo; echo "rekey-placeholder-ids.check: $pass passed, $fail failed"
[ "$fail" = 0 ]
