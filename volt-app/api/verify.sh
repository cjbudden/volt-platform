#!/usr/bin/env bash
# ONE-COMMAND API CHECK, no console needed: a throwaway database, the API on
# it, the seeded test users, then the Postman collection run end to end with
# Newman (public, admin and platform folders, in order).
#
#   DATABASE_URL=postgres://user:pass@localhost:5432/volt_verify ./api/verify.sh
#
# Needs node, psql and newman (npm i -g newman, or npx newman is used).
# DATABASE_URL is DROPPED and recreated: point it at a throwaway database.
set -euo pipefail
cd "$(dirname "$0")/.."
source api/lib-setup.sh

NEWMAN=$(command -v newman || echo "npx --yes newman@6")
echo "== running the Postman collection =="
$NEWMAN run api/Volt.postman_collection.json -e api/Volt.postman_environment.json \
  --env-var "baseUrl=http://localhost:$PORT" --env-var "domain=$SEED_DOMAIN" --env-var "password=$SEED_PASSWORD" \
  --env-var "adminEmail=admin@$SEED_DOMAIN" --env-var "radioEmail=radio@$SEED_DOMAIN" --env-var "sysViewerEmail=viewer@$SEED_DOMAIN" \
  --env-var "viewerEmail=fan@$SEED_DOMAIN" --env-var "staffEmail=staff@$SEED_DOMAIN" --env-var "ingestToken=$INGEST_TOKEN" \
  --env-var "accountId=$ACCOUNT_ID" --env-var "groupId=$G" --env-var "channelId=$C" --env-var "recordingId=$R" --env-var "vodId=$V"
