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
#
# A SHORT WINDOW ON THE TASK DISK (LOCAL_KEEP_SECONDS, build queue 2.4c).
# The packager keeps every segment of the run locally (Shaka's
# preserved_segments_outside_live_window 0), which is right on the Mac, where
# the local run IS the recording. On AWS the recording is the copy in S3, and a
# whole run on the task disk fills a 30 GiB root in about six hours of a 1080p
# ladder. With LOCAL_KEEP_SECONDS set, each pass whose segment sync succeeded
# removes local media segments last written more than the window before that
# pass began. Such a file existed, unchanged, when the sync started, and the
# sync finished without an error, so it is in S3 before it goes. A failed sync
# removes nothing. Manifests and init segments always stay (every segment needs
# its init, and the packager rewrites the manifests). The window is never
# shorter than the job's DVR window plus two minutes, so the live playlist never
# points at a segment that is gone. Unset or 0: every segment stays (the Mac).
# `aws s3 sync` never deletes remote objects, so S3 keeps the whole run.
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

# The job's DVR window (dvr_seconds), read the way encoder.py reads its config.
job_dvr_seconds() {
  python3 - <<'PY' 2>/dev/null || echo 0
import json, os
raw = os.environ.get("JOB_CONFIG_JSON")
try:
    cfg = json.loads(raw) if raw else json.load(open(os.environ.get("JOB_CONFIG", "/job/config.json")))
    print(int(float(cfg.get("dvr_seconds") or 0)))
except Exception:
    print(0)
PY
}

KEEP_SECONDS=0
if [[ "${LOCAL_KEEP_SECONDS:-0}" =~ ^[0-9]+$ ]] && [ "${LOCAL_KEEP_SECONDS:-0}" -gt 0 ]; then
  DVR="$(job_dvr_seconds)"; [[ "$DVR" =~ ^[0-9]+$ ]] || DVR=0
  KEEP_SECONDS="$LOCAL_KEEP_SECONDS"
  [ $((DVR + 120)) -gt "$KEEP_SECONDS" ] && KEEP_SECONDS=$((DVR + 120))
fi
CUTOFF_MARK="$(mktemp -t volt-keep.XXXXXX)"

sync_segments() {
  # Everything except manifests: immutable, long TTL. Returns the sync's own
  # status so the prune below only follows a sync that finished cleanly.
  aws s3 sync "${EP[@]}" "$LOCAL_DIR" "$S3_DEST" \
    --no-progress \
    --exclude "*.m3u8" --exclude "*.mpd" \
    --cache-control "$SEG_CACHE"
}

prune_local() {
  # $1: the epoch second the successful sync started. Only numbered media
  # segments (seg_N.m4s/.ts/.aac, sub_N.vtt) go; init.mp4, manifests and the
  # end-of-run caption file are not numbered segments and are never touched.
  [ "$KEEP_SECONDS" -gt 0 ] || return 0
  touch -d "@$(( $1 - KEEP_SECONDS ))" "$CUTOFF_MARK" || return 0
  local n
  n=$(find "$LOCAL_DIR" -type f -regextype posix-extended \
        -regex '.*/(seg|sub)_[0-9]+\.(m4s|ts|aac|vtt)' \
        ! -newer "$CUTOFF_MARK" -print -delete 2>/dev/null | wc -l) || true
  [ "${n:-0}" -gt 0 ] && echo "[s3-uploader] removed $n local segments older than ${KEEP_SECONDS}s (already in S3)"
  return 0
}

sync_pass() {
  local started ok=1
  started=$(date +%s)
  sync_segments || ok=0
  sync_manifests
  [ "$ok" = 1 ] && prune_local "$started"
  return 0
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
  # No prune here: the task is ending and its disk goes with it.
  echo "[s3-uploader] final sync on shutdown"
  sync_segments || true
  sync_manifests
  rm -f "$CUTOFF_MARK" 2>/dev/null || true
  exit 0
}
trap final_sync SIGTERM SIGINT

if [ "$KEEP_SECONDS" -gt 0 ]; then
  echo "[s3-uploader] mirroring $LOCAL_DIR -> $S3_DEST every ${INTERVAL}s, keeping ${KEEP_SECONDS}s of segments locally"
else
  echo "[s3-uploader] mirroring $LOCAL_DIR -> $S3_DEST every ${INTERVAL}s, keeping every segment locally"
fi
while true; do
  sync_pass
  # sleep in the background so SIGTERM is handled at once, not after the sleep
  sleep "$INTERVAL" & wait $! || true
done
