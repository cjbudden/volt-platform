#!/usr/bin/env bash
# ============================================================================
#  Volt cleanup — keep local storage bounded, never leave input/preview data around.
#
#  INPUT / preview scratch is ALWAYS cleared (it is only ever short-lived preview
#  data). OUTPUT (origin) segments are pruned to a short retention so we don't rack
#  up disk (or, in cloud, storage charges). Safe to run any time.
#
#  Usage:
#    bash volt-clean.sh               # clear input scratch; drop origin segments > 2 min
#    RETAIN_MIN=5 bash volt-clean.sh  # keep 5 min of origin segments instead
#    PURGE=1 bash volt-clean.sh       # full reset: wipe ALL origin output + scratch
#
#  NOTE: if you are actively testing DVR catch-up, set RETAIN_MIN at/above the DVR
#  window, or the back-buffer will be trimmed. Default 2 min suits live preview.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")"; ROOT="$(pwd)"
RETAIN_MIN="${RETAIN_MIN:-2}"
ORIGIN="$ROOT/volt-app/origin"
SCRATCH="$ROOT/volt-encoder/_local_out"

echo "== Volt cleanup (retain ${RETAIN_MIN} min, purge=${PURGE:-0}) =="

# 1) INPUT / preview scratch — cleared no matter what (synthetic source + harness out)
if [ -d "$SCRATCH" ]; then
  rm -rf "${SCRATCH:?}/"* 2>/dev/null || true
  echo "  input scratch cleared: volt-encoder/_local_out"
fi

# 2) OUTPUT origin
if [ -d "$ORIGIN" ]; then
  if [ "${PURGE:-0}" = "1" ]; then
    find "$ORIGIN" -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} + 2>/dev/null || true
    echo "  PURGE: removed ALL origin channel output"
  else
    # drop media segments older than RETAIN_MIN; keep manifests + init.mp4 (tiny) so a
    # live channel keeps serving. Bounds storage to ~the preview/DVR window.
    before=$(find "$ORIGIN" -type f \( -name '*.m4s' -o -name '*.ts' \) 2>/dev/null | wc -l | tr -d ' ')
    find "$ORIGIN" -type f \( -name '*.m4s' -o -name '*.ts' \) -mmin +"$RETAIN_MIN" -delete 2>/dev/null || true
    after=$(find "$ORIGIN" -type f \( -name '*.m4s' -o -name '*.ts' \) 2>/dev/null | wc -l | tr -d ' ')
    echo "  origin segments: ${before} -> ${after} (pruned > ${RETAIN_MIN} min)"
    # remove now-empty rendition/channel dirs left with no segments
    find "$ORIGIN" -mindepth 2 -type d -empty -delete 2>/dev/null || true
  fi
fi

# 3) tidy transfer/lock leftovers from the sync bridge
rm -rf "$ROOT/_to_delete" "$ROOT"/_incoming*.tgz "$ROOT"/_step*.tgz "$ROOT"/_docmap.tgz "$ROOT"/_stepfix.tgz 2>/dev/null || true

echo "== done =="
