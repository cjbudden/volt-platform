#!/usr/bin/env bash
# Fails when a route was added, removed or re-gated without regenerating the
# route reference (docs/API_ROUTES.md). Fix: npm run docs:routes, and for a
# client-facing route add a step to api/build.ts and run api/capture_api.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?set DATABASE_URL (read only: nothing is written)}"
npx tsx scripts/api-routes.ts --check
# The customer API reference (docs/openapi.json, rendered by the docs site) is
# built from the two files above. Fix: npm run docs:openapi.
node scripts/openapi.mjs --check
