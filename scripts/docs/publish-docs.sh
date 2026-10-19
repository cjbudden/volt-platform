#!/usr/bin/env bash
# PUBLISH THE CUSTOMER DOCS. Builds docs-site and puts it live, in an order that
# never serves a page whose scripts are missing:
#   1. build (fails on a broken link, a stale/missing API spec, or a banned term)
#   2. upload the hashed assets (long cache), then the pages (short cache)
#   3. remove files the new build no longer has
#   4. invalidate the CDN so everyone sees the new pages
#
# Settings come from the docs Terraform stack (deploy/terraform-docs) outputs,
# or from the environment:
#   DOCS_BUCKET  DOCS_DISTRIBUTION_ID  VOLT_APP_URL  DOCS_SITE_URL
#
#   scripts/docs/publish-docs.sh                 build + publish
#   scripts/docs/publish-docs.sh --from-terraform  read the four settings from terraform output
#   scripts/docs/publish-docs.sh --dry-run       build, then show what would change
#   scripts/docs/publish-docs.sh --skip-build    publish the existing docs-site/build
#
# Needs: node 20+, the AWS CLI, credentials with the docs stack's publish policy.
# Rollback: the bucket is versioned. Re-run this script from the previous
# release tag (git checkout vX.Y.Z -- docs-site volt-app/docs/openapi.json),
# which is the clean way back; S3 object versions are the emergency way.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SITE="$ROOT/docs-site"
DRY=""; BUILD=1; TF=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY="--dryrun" ;;
    --skip-build) BUILD=0 ;;
    --from-terraform) TF=1 ;;
    *) echo "unknown option $a"; exit 2 ;;
  esac
done

if [ "$TF" = 1 ]; then
  TFD="$ROOT/deploy/terraform-docs"
  DOCS_BUCKET=$(terraform -chdir="$TFD" output -raw bucket)
  DOCS_DISTRIBUTION_ID=$(terraform -chdir="$TFD" output -raw distribution_id)
  VOLT_APP_URL=$(terraform -chdir="$TFD" output -raw app_url)
  DOCS_SITE_URL=$(terraform -chdir="$TFD" output -raw docs_url)
fi
: "${DOCS_BUCKET:?set DOCS_BUCKET (or use --from-terraform)}"
: "${DOCS_DISTRIBUTION_ID:?set DOCS_DISTRIBUTION_ID}"
: "${VOLT_APP_URL:?set VOLT_APP_URL, e.g. https://app.volt.example}"
: "${DOCS_SITE_URL:?set DOCS_SITE_URL, e.g. https://docs.volt.example}"
export VOLT_APP_URL DOCS_SITE_URL

# The spec must match the routes in this checkout, or the reference would lie.
(cd "$ROOT/volt-app" && node scripts/openapi.mjs --check)

if [ "$BUILD" = 1 ]; then
  (cd "$SITE" && npm ci --no-audit --no-fund && npm run build)
fi
OUT="$SITE/build"
[ -f "$OUT/index.html" ] || { echo "no build at $OUT"; exit 1; }
# The sign-in page links back to Volt.
sed -i.bak "s#__VOLT_APP_URL__#${VOLT_APP_URL}#g" "$OUT/_public/signin.html" && rm -f "$OUT/_public/signin.html.bak"

DEST="s3://$DOCS_BUCKET"
echo "publishing $(find "$OUT" -type f | wc -l | tr -d ' ') files to $DEST ($DOCS_SITE_URL)"
# Hashed, immutable assets first: a new page must never reference a missing one.
aws s3 sync "$OUT" "$DEST" $DRY --exclude "*" --include "assets/*" --include "vendor/*" --include "fonts/*" \
  --cache-control "public, max-age=31536000, immutable"
# Then pages and everything else: browsers revalidate, the CDN keeps a day
# (and is invalidated below on every publish).
aws s3 sync "$OUT" "$DEST" $DRY --exclude "assets/*" --exclude "vendor/*" --exclude "fonts/*" \
  --cache-control "public, max-age=0, s-maxage=86400, must-revalidate"
# Finally drop what the new build no longer has.
aws s3 sync "$OUT" "$DEST" $DRY --delete --size-only --exclude "assets/*" --exclude "vendor/*" --exclude "fonts/*" >/dev/null
aws s3 sync "$OUT/assets" "$DEST/assets" $DRY --delete --size-only >/dev/null

if [ -z "$DRY" ]; then
  ID=$(aws cloudfront create-invalidation --distribution-id "$DOCS_DISTRIBUTION_ID" --paths "/*" --query Invalidation.Id --output text)
  echo "invalidation $ID started; live in a minute or two at $DOCS_SITE_URL"
else
  echo "dry run: nothing uploaded, no invalidation"
fi
