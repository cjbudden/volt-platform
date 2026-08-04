#!/usr/bin/env bash
# ONE COMMAND to test Volt locally tonight: resets a demo database, seeds realistic
# data (2 tenants, live channels, EPG, VOD, viewers, tickets), and starts the API +
# a real browser console. Then open the printed Console URL and sign in.
#
#   npm install            # first time only
#   ./run-local.sh         # uses DATABASE_URL, else postgres://volt:volt@localhost:5432/volt
#
# Requires: Node 20+, an empty (or disposable) Postgres database, psql on PATH.
set -euo pipefail
cd "$(dirname "$0")"
export DATABASE_URL="${DATABASE_URL:-postgres://volt:volt@localhost:5432/volt}"
export JWT_ACCESS_SECRET="${JWT_ACCESS_SECRET:-dev-access-secret}"
export JWT_REFRESH_SECRET="${JWT_REFRESH_SECRET:-dev-refresh-secret}"
export INGEST_TOKEN="${INGEST_TOKEN:-dev-ingest}"
export PORT="${PORT:-8080}"
export ORCH_LAUNCHER="${ORCH_LAUNCHER:-mock}"   # no AWS needed
export CORS_ORIGIN="${CORS_ORIGIN:-*}"

echo "== resetting demo schema in $DATABASE_URL =="
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f migrations/0001_init.sql

echo "== seeding demo data =="
npx tsx scripts/seed-demo.ts

echo ""
echo "==================================================================="
echo "  Volt is running.  Open the console and sign in:"
echo "     Console : http://localhost:$PORT/console"
echo "     API     : http://localhost:$PORT/api        (Hydra entrypoint)"
echo "     Health  : http://localhost:$PORT/health"
echo "  Logins (password: volt1234):"
echo "     Client admin : admin@rtm.example"
echo "     SaaS admin   : saas@volt.example"
echo "==================================================================="
echo ""
exec npx tsx src/index.ts
