#!/usr/bin/env bash
# Continuously mirror the local packager output dir to S3.
#
#   s3-uploader.sh <local_dir> <s3_dest> <interval_seconds>
#
# CloudFront serves viewers from S3, so viewer traffic never touches this
# container — this sidecar is the only thing that egresses. The live segments
# it uploads ARE the recording (live-to-VOD is built in; no reprocessing).
#
# `aws s3 sync` only copies new/changed objects, so each pass is cheap. New
# CMAF segments + rewritten manifests go up every <interval>. On SIGTERM we
# do one final sync so the last segments and the closing manifest land.
set -euo pipefail

LOCAL_DIR="${1:?usage: s3-uploader.sh <local_dir> <s3_dest> <interval>}"
S3_DEST="${2:?missing s3 destination}"
INTERVAL="${3:-2}"

# For local e2e against MinIO (or any S3-compatible endpoint), set
# AWS_ENDPOINT_URL. In real AWS leave it unset and the CLI uses the region.
EP=(); [ -n "${AWS_ENDPOINT_URL:-}" ] && EP=(--endpoint-url "$AWS_ENDPOINT_URL")

# Manifests must be no-cache (they change every segment); segments are
# immutable and can cache long. CloudFront/S3 honour these on GET.
SEG_CACHE="public,max-age=31536000,immutable"
MANIFEST_CACHE="no-cache,no-store,max-age=0"

sync_segments() {
  # Everything except manifests: immutable, long TTL.
  aws s3 sync "${EP[@]}" "$LOCAL_DIR" "$S3_DEST" \
    --no-progress \
    --exclude "*.m3u8" --exclude "*.mpd" \
    --cache-control "$SEG_CACHE" || true
}

sync_manifests() {
  # Manifests last, after their segments exist, so players never 404 a
  # segment a manifest references. Short/no cache.
  aws s3 sync "${EP[@]}" "$LOCAL_DIR" "$S3_DEST" \
    --no-progress \
    --exclude "*" --include "*.m3u8" --include "*.mpd" \
    --content-type "application/vnd.apple.mpegurl" \
    --cache-control "$MANIFEST_CACHE" || true
}

final_sync() {
  echo "[s3-uploader] final sync on shutdown"
  sync_segments
  sync_manifests
  exit 0
}
trap final_sync SIGTERM SIGINT

echo "[s3-uploader] mirroring $LOCAL_DIR -> $S3_DEST every ${INTERVAL}s"
while true; do
  sync_segments
  sync_manifests
  sleep "$INTERVAL"
done
