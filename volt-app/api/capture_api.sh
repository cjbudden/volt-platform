#!/usr/bin/env bash
# REBUILD THE API REFERENCE FROM A LIVE RUN.
#
# Makes an empty database, starts the API on it (migrations run on boot),
# seeds the test users (ACCESS_CONTROL.md section 10) plus a channel group,
# channel and recording, then runs api/build.ts, which calls every request,
# keeps the real responses and writes:
#
#   api/Volt.postman_collection.json + api/Volt.postman_environment.json
#   docs/API.md, docs/api-playground.html
#
# and refreshes docs/API_ROUTES.md (every route, from the running app).
#
#   DATABASE_URL=postgres://user:pass@localhost:5432/volt_capture ./api/capture_api.sh
#
# DATABASE_URL is DROPPED and recreated: point it at a throwaway database.
set -euo pipefail
cd "$(dirname "$0")/.."
source api/lib-setup.sh

echo "== every route, from the running app =="
npx tsx scripts/api-routes.ts

echo "== running every request and writing the reference =="
BASE_URL="http://localhost:$PORT" ACCOUNT_ID="$ACCOUNT_ID" GROUP_ID="$G" CHANNEL_ID="$C" RECORDING_ID="$R" VOD_ID="$V" npx tsx api/build.ts
echo "== done =="
