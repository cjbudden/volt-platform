#!/usr/bin/env bash
# ============================================================================
#  RESET THE RECORDED DATA. Configuration survives.
#
#  volt-clean.sh bounds disk. This is the other thing: it takes the system back
#  to "nothing has ever been broadcast" without taking it back to "nothing has
#  ever been set up". After it runs you still have your accounts, channels,
#  events, EPG schedule, output profiles, apps and API keys, media library,
#  player configs and retention rules. What you no longer have is any trace of
#  anything having run.
#
#  WHY BOTH HALVES, ALWAYS TOGETHER. In this system a recording is not a file:
#  it is a time range over the origin segments themselves (see the range
#  playlist routes in modules/recordings.ts). Clearing the disk alone leaves
#  rows describing media that is gone, and the console lists recordings that
#  404 on play. Clearing the database alone leaves gigabytes nothing points at.
#  Neither half is a safe operation on its own, so this script does both or
#  neither.
#
#  WHAT IS CLEARED
#    on disk    every origin channel's output, the encoder's local scratch,
#               and the _to_delete staging folder
#    in the db  recordings and their containers, VOD assets and their clip
#               segments, media objects/locations/events, publications,
#               segments, QC events and asset reviews, jobs and job attempts,
#               instances, hosts, host samples and the usage ledger, stream
#               status/events/concurrency, play sessions, analytics rollups,
#               player events, notifications and their deliveries, the track
#               metadata cache, and abandoned upload sessions
#    reset      every channel and event back to stopped, with the auto connect
#               bookkeeping cleared
#
#  WHAT IS SPARED
#    accounts, users, groups, channels, events, programmes and series,
#    dayparts, output profiles, stream inputs, apps and API keys, DRM and
#    identity config, filler assets, the media library (files and folders),
#    metadata schemas, publish targets, retention rules and stages, player
#    configs, share links, support tickets, compute rates, the audit log
#
#  A NOTE ON THE AUDIT LOG. It is deliberately not cleared. It is the record of
#  who did what, and wiping it as part of a data reset is how an audit trail
#  quietly stops being one. Clear it by hand if you really mean to.
#
#  Usage:
#    bash volt-reset-recorded-data.sh          # asks you to type RESET
#    YES=1 bash volt-reset-recorded-data.sh    # no prompt, for scripted use
#    DRY=1 bash volt-reset-recorded-data.sh    # show the counts, change nothing
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")"; ROOT="$(pwd)"

DBURL="${DATABASE_URL:-postgres://volt:volt@localhost:5432/volt}"
ORIGIN="$ROOT/volt-app/origin"
SCRATCH="$ROOT/volt-encoder/_local_out"

# ---------------------------------------------------------------------------
#  How to talk to Postgres. A local psql if there is one, otherwise the Docker
#  container run-on-mac.sh starts. Either way the caller does not have to care.
# ---------------------------------------------------------------------------
if command -v psql >/dev/null 2>&1 && (exec 3<>/dev/tcp/localhost/5432) 2>/dev/null; then
  pg() { psql "$DBURL" -v ON_ERROR_STOP=1 "$@"; }
elif command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx volt-pg; then
  pg() { docker exec -i volt-pg psql -U volt -d volt -v ON_ERROR_STOP=1 "$@"; }
else
  cat <<'MSG'
  Cannot reach Postgres.

  Start it the way run-on-mac.sh does, then re-run this script:
      docker start volt-pg
  or bring up your local Postgres on :5432.
MSG
  exit 1
fi

# ---------------------------------------------------------------------------
#  Refuse to do this underneath a running control plane. Deleting the rows a
#  live orchestrator is mid-way through writing produces a mess that looks like
#  a bug in the app rather than like a reset.
# ---------------------------------------------------------------------------
if (exec 3<>/dev/tcp/localhost/8080) 2>/dev/null; then
  echo "  The control plane is still up on :8080. Stop run-on-mac.sh first (Ctrl-C), then re-run."
  exit 1
fi

TABLES="play_sessions analytics_rollups player_events \
stream_events stream_status stream_concurrency \
qc_events asset_reviews publications clip_segments \
vod_assets recording_containers recordings segments \
media_locations media_events media_objects \
job_attempts jobs \
usage_accruals usage_records host_samples instances compute_hosts \
track_metadata upload_sessions \
notification_deliveries notifications"

echo "== what is there now =="
# to_regclass so a table added by a migration you have not applied is reported
# as absent rather than blowing up the count query.
for t in $TABLES; do
  n=$(pg -tAc "SELECT CASE WHEN to_regclass('$t') IS NULL THEN -1
                           ELSE (SELECT count(*) FROM $t) END" 2>/dev/null || echo "?")
  case "$n" in
    -1) ;;                                  # not in this schema, say nothing
     0) ;;                                  # already empty, say nothing
     *) printf "   %8s  %s\n" "$n" "$t" ;;
  esac
done
DISK=$(du -sh "$ORIGIN" 2>/dev/null | cut -f1)
echo "   ${DISK:-0} on disk in volt-app/origin"

if [ "${DRY:-0}" = "1" ]; then echo; echo "== DRY: nothing changed =="; exit 0; fi

if [ "${YES:-0}" != "1" ]; then
  echo
  printf "Type RESET to clear all of the above: "
  read -r reply
  [ "$reply" = "RESET" ] || { echo "  nothing done"; exit 1; }
fi

# ---------------------------------------------------------------------------
#  ONE TRANSACTION. Half a reset is worse than none: it leaves VOD assets whose
#  recordings are gone, or a usage ledger that outlived the tasks it billed.
#
#  DELETE rather than TRUNCATE ... CASCADE, and the difference matters. The
#  foreign keys pointing INTO this data are mostly ON DELETE SET NULL, so a
#  DELETE clears a programme's link to a VOD asset while leaving the programme,
#  and your EPG schedule survives. TRUNCATE CASCADE would follow the same keys
#  and take the schedule with it.
# ---------------------------------------------------------------------------
echo
echo "== clearing the database =="
pg <<SQL
BEGIN;
DO \$\$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY regexp_split_to_array('$(echo $TABLES)', '\s+') LOOP
    IF t <> '' AND to_regclass(t) IS NOT NULL THEN
      EXECUTE format('DELETE FROM %I', t);
    END IF;
  END LOOP;
END
\$\$;

-- Back to stopped, and with the auto connect bookkeeping cleared, so nothing
-- tries to resume a stream whose instance rows have just been deleted.
UPDATE channels SET status = 'ended', desired_state = 'stopped',
       stop_requested_at = NULL, stop_requested_by = NULL,
       resume_attempts = 0, resume_last_attempt_at = NULL,
       resume_last_error = NULL, resume_gave_up_at = NULL;
UPDATE events   SET status = 'ended', desired_state = 'stopped',
       stop_requested_at = NULL, stop_requested_by = NULL,
       resume_attempts = 0, resume_last_attempt_at = NULL,
       resume_last_error = NULL, resume_gave_up_at = NULL;
COMMIT;
SQL
rc=$?
if [ "$rc" != "0" ]; then
  echo "  the database reset failed and was rolled back. Disk left untouched on purpose:"
  echo "  a half-done reset is the one outcome worth avoiding."
  exit 1
fi

# ---------------------------------------------------------------------------
#  Disk second, and only once the database is actually clear. In that order a
#  failure leaves media with rows describing it, which is recoverable. The
#  other order leaves rows describing media that is gone, which is not.
# ---------------------------------------------------------------------------
echo "== clearing the disk =="
if [ -d "$ORIGIN" ]; then
  find "$ORIGIN" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
  echo "   volt-app/origin emptied"
fi
if [ -d "$SCRATCH" ]; then
  rm -rf "${SCRATCH:?}/"* 2>/dev/null || true
  echo "   volt-encoder/_local_out emptied"
fi
if [ -d "$ROOT/_to_delete" ]; then
  rm -rf "$ROOT/_to_delete" 2>/dev/null || true
  echo "   _to_delete removed"
fi

echo
echo "== done. Configuration intact; nothing has ever been broadcast. =="
df -h "$ROOT" | tail -1
