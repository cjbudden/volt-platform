#!/usr/bin/env bash
# The demo snapshot run-on-mac.sh loads into a FRESH database (or with
# RESET_DB=1) must boot. It used to be a pg_dump from before the migration
# runner, with no schema_migrations ledger: the runner adopted it as 0001,
# applied 0002, and stopped the control plane in 0003 ("column c.radio_config
# does not exist"), so a fresh start on the Mac never came up (build queue
# 1.14-G7a). This loads ../volt_web_demo.sql exactly the way the script does,
# then runs the real migration runner and the control plane against it.
# Needs DATABASE_URL -> a database this suite may wipe (check.js gives each
# suite its own copy).
set -uo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?set DATABASE_URL}"
SNAP=../volt_web_demo.sql
export JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET:-devsecret}
export JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET:-devrefresh}
export INGEST_TOKEN=${INGEST_TOKEN:-dev-ingest}
export ORCH_LAUNCHER=mock
PORT=${SNAP_PORT:-8097}
TMP=$(mktemp -d)
export IMAGE_STORE_DIR=$TMP/images FILLER_DIR=$TMP/filler ORIGIN_DIR=$TMP/origin
pass=0; fail=0
ok(){ echo "  ✓ $1"; pass=$((pass+1)); }
bad(){ echo "  ✗ $1"; fail=$((fail+1)); }
is(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected $3, got $2)"; fi; }
q(){ psql "$DATABASE_URL" -tAc "$1" 2>/dev/null | tr -d '[:space:]'; }

echo "== load the snapshot the way run-on-mac.sh does (empty public schema, ON_ERROR_STOP)"
psql "$DATABASE_URL" -q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null 2>&1
if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$SNAP" >"$TMP/load.log" 2>&1; then ok "the snapshot loads into an empty schema"; else bad "the snapshot loads into an empty schema: $(tail -2 "$TMP/load.log")"; fi
is "it carries the migration ledger" "$(q "SELECT to_regclass('public.schema_migrations') IS NOT NULL")" "t"
is "the ledger starts at 0001 as a real run, not an adoption" "$(q "SELECT checksum <> 'adopted' FROM schema_migrations WHERE id = '0001_init.sql'")" "t"
is "every row id is a generated (version 4) uuid, so the console can save forms that name them" \
  "$(q "SELECT count(*) FROM (SELECT id::text FROM accounts UNION ALL SELECT id::text FROM users UNION ALL SELECT id::text FROM groups UNION ALL SELECT id::text FROM output_profiles) x WHERE split_part(id, '-', 3) NOT LIKE '4%'")" "0"

echo "== the migration runner on top of it"
if npx tsx -e "import { migrate } from './src/services/migrate'; import { pool } from './src/db'; migrate().then(async (m) => { console.log('applied', m.applied.length); await pool.end(); }).catch(async (e) => { console.error(e.message); await pool.end(); process.exit(1); })" >"$TMP/migrate.log" 2>&1; then
  ok "migrations apply cleanly ($(grep -o 'applied [0-9]*$' "$TMP/migrate.log" | tail -1) new)"
else bad "migrations apply cleanly: $(tail -2 "$TMP/migrate.log")"; fi
MISSING=0
for f in migrations/[0-9][0-9][0-9][0-9]_*.sql; do id=$(basename "$f"); [ "$(q "SELECT 1 FROM schema_migrations WHERE id = '$id'")" = "1" ] || MISSING=$((MISSING+1)); done
is "every migration in the tree is recorded afterwards" "$MISSING" "0"

echo "== the demo it gives"
is "the RTM account is there" "$(q "SELECT count(*) FROM accounts WHERE name = 'RTM'")" "1"
is "with its admin login" "$(q "SELECT count(*) FROM users WHERE email = 'admin@rtm.example'")" "1"
is "and exactly one default channel group" "$(q "SELECT count(*) FROM groups g JOIN accounts a ON a.id = g.account_id WHERE a.name = 'RTM' AND g.is_default")" "1"

echo "== the control plane boots on it and the demo login works"
# Its own process group, so the whole tree (npx, tsx and node) goes at the end:
# killing only the npx wrapper leaves the server answering on the port for
# whatever runs next. Job control (set -m) gives the background job a group of
# its own on Linux and on the Mac alike; setsid is not on macOS.
fuser -k "$PORT"/tcp >/dev/null 2>&1; sleep 0.3
set -m
PORT=$PORT npx tsx src/index.ts >"$TMP/api.log" 2>&1 & SRV=$!
set +m
trap 'kill -- -$SRV 2>/dev/null; rm -rf "$TMP"' EXIT
up=0; for i in $(seq 1 60); do curl -fsS "localhost:$PORT/health" >/dev/null 2>&1 && { up=1; break; }; sleep 1; done
is "the API answers /health" "$up" "1"
TOKEN=$(curl -s -X POST "localhost:$PORT/api/auth/login" -H 'content-type: application/json' -d '{"email":"admin@rtm.example","password":"volt1234"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).access||'')}catch{console.log('')}})")
[ -n "$TOKEN" ] && ok "admin@rtm.example signs in with the documented password" || bad "admin@rtm.example signs in with the documented password"
G=$(q "SELECT g.id FROM groups g JOIN accounts a ON a.id = g.account_id WHERE a.name = 'RTM' AND g.is_default")
CODE=$(curl -s -o "$TMP/ch.json" -w '%{http_code}' -X POST "localhost:$PORT/api/channels" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "{\"name\":\"Snapshot check\",\"groupId\":\"$G\"}")
is "a channel can be created in the default group" "$CODE" "201"

echo
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
