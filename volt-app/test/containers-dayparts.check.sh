#!/usr/bin/env bash
# ============================================================================
#  CONTAINERS, DAYPARTS, COVERAGE — against the live API and real rows.
#
#  Nothing here is a fixture. The script logs in, reads whatever the database
#  holds, and asserts the API's answers agree with SQL and with the broadcast-day
#  rules. If the seed changes the assertions still hold, because they are derived
#  from the same data.
#
#  What it guards:
#    * every recording has a container, and every container's day is a LABEL
#      (YYYY-MM-DD), not a UTC-midnight timestamp five hours from the truth;
#    * a container's frozen tz and anchor are stored, so editing the channel
#      cannot retroactively re-file history;
#    * daypart sets reject the only two things that can be wrong, and the UK
#      preset is what a channel gets;
#    * coverage reports real gaps and refuses an unclippable range with a reason.
#
#  Usage: API=http://localhost:8080 DATABASE_URL=... bash test/containers-dayparts.check.sh
# ============================================================================
set -uo pipefail
API="${API:-http://localhost:8080}"
EMAIL="${EMAIL:-root@adminco.example}"
PASS_WORD="${PASS_WORD:-volt1234}"
PSQL="psql ${DATABASE_URL:-postgres://volt:volt@localhost:5432/volt} -tA -c"

pass=0; fail=0
ok(){ echo "PASS $1"; pass=$((pass+1)); }
bad(){ echo "FAIL $1 -- $2"; fail=$((fail+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3] got [$2]"; fi; }

TOK=$(curl -s -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS_WORD\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access"])')
[ -n "$TOK" ] || { echo "FATAL: no token (is the API up at $API?)"; exit 1; }
get(){ curl -s -H "authorization: Bearer $TOK" "$API/api$1"; }
put(){ curl -s -X PUT -H "authorization: Bearer $TOK" -H 'content-type: application/json' -d "$2" "$API/api$1"; }

# ---- 1. every recording landed in a container ------------------------------
ORPHANS=$($PSQL "SELECT count(*) FROM recordings WHERE container_id IS NULL")
check "every recording has a container" "$ORPHANS" "0"

TYPED=$($PSQL "SELECT count(*) FROM recordings WHERE recording_type IS NULL")
check "every recording has a recording_type" "$TYPED" "0"

# a radio station's captures are typed radio_station while still STORED as
# channel_day — proving the type is derived from the source, not from the slice
RADIO_TYPES=$($PSQL "
  SELECT DISTINCT r.recording_type::text FROM recordings r
    JOIN channels c ON c.id = r.channel_id
   WHERE c.radio_config IS NOT NULL")
check "radio captures are typed radio_station" "$RADIO_TYPES" "radio_station"
RADIO_KIND=$($PSQL "
  SELECT DISTINCT r.kind::text FROM recordings r
    JOIN channels c ON c.id = r.channel_id
   WHERE c.radio_config IS NOT NULL")
check "and are still STORED as channel_day" "$RADIO_KIND" "channel_day"

# ---- 1b. a recording opened while the server runs gets filed ---------------
# Filing used to happen only at boot, so a recording opened at 09:00 stayed
# unfiled until the next restart: invisible to every question asked by broadcast
# day. The orchestrator now files on its tick, and this waits for that to happen
# rather than asserting the function in isolation, because the wiring is the part
# that was missing.
TESTCH=$($PSQL "
  SELECT c.id FROM channels c
    JOIN groups g ON g.id = c.group_id JOIN accounts a ON a.id = g.account_id
   WHERE a.name='AdminCo' LIMIT 1")
NOWMS=$($PSQL "SELECT (extract(epoch from now())*1000)::bigint")
NEWREC=$($PSQL "
  INSERT INTO recordings(kind, channel_id, day_utc, status, hi_res_rendition, master_key,
                         start_epoch_ms, end_epoch_ms, duration_ms)
  VALUES ('channel_day', '$TESTCH', (now() at time zone 'utc')::date + 400, 'complete', '720p',
          'test/unfiled', $NOWMS, $NOWMS + 1000, 1000)
  RETURNING id" | head -1)
FILED=no
for _ in $(seq 1 22); do
  HAS=$($PSQL "SELECT count(*) FROM recordings WHERE id='$NEWREC' AND container_id IS NOT NULL")
  [ "$HAS" = "1" ] && { FILED=yes; break; }
  sleep 2
done
check "a recording opened while the server runs is filed on the tick" "$FILED" "yes"
NEWTYPE=$($PSQL "SELECT count(*) FROM recordings WHERE id='$NEWREC' AND recording_type IS NOT NULL")
check "and is given its recording type" "$NEWTYPE" "1"
$PSQL "DELETE FROM recordings WHERE id='$NEWREC'" > /dev/null

# ---- 2. containers freeze their clock --------------------------------------
FROZEN=$($PSQL "SELECT count(*) FROM recording_containers WHERE tz IS NULL OR anchor_hour IS NULL")
check "every container froze its tz and anchor" "$FROZEN" "0"

ANCHORED=$($PSQL "SELECT count(*) FROM recording_containers WHERE anchor_hour <> 6")
check "containers use the 06:00 broadcast anchor" "$ANCHORED" "0"

# the day must START at the anchor in local time, never at UTC midnight
UTC_MIDNIGHT=$($PSQL "
  SELECT count(*) FROM recording_containers
   WHERE to_char(to_timestamp(starts_at_ms/1000.0) AT TIME ZONE tz, 'HH24:MI') <> '06:00'")
check "every container starts at 06:00 in its own timezone" "$UTC_MIDNIGHT" "0"

# a day is 23, 24 or 25 hours — never anything else
ODD=$($PSQL "
  SELECT count(*) FROM recording_containers
   WHERE round((ends_at_ms - starts_at_ms)/3600000.0) NOT IN (23,24,25)")
check "no container has an impossible length" "$ODD" "0"

# ---- 3. the day is a label, not a timestamp --------------------------------
# Prefer a channel with the MOST recorded time, so the coverage assertions have
# something real to measure rather than a row whose media never landed.
CH=$($PSQL "
  SELECT c.id FROM channels c
    JOIN recordings r ON r.channel_id = c.id
    JOIN groups g ON g.id = c.group_id JOIN accounts a ON a.id = g.account_id
   WHERE a.name='AdminCo' AND c.radio_config IS NOT NULL
   GROUP BY c.id
   ORDER BY sum(COALESCE(r.duration_ms,0)) DESC NULLS LAST, c.id
   LIMIT 1")
[ -n "$CH" ] || { echo "FATAL: no radio channel with recordings"; exit 1; }

# A usable window: the channel's recorded span, padded, and clamped to the
# timeline's 32-day cap. COALESCE the end to NOW because an open recording has
# no end yet — without that a still-recording channel yields from == to and the
# endpoint correctly refuses an empty window.
read -r FROM TO <<<"$($PSQL "
  SELECT (min(start_epoch_ms) - 3600000)::text || ' ' ||
         LEAST(
           max(COALESCE(end_epoch_ms, (extract(epoch from now())*1000)::bigint)) + 3600000,
           min(start_epoch_ms) + 30::bigint * 86400000
         )::text
    FROM recordings WHERE channel_id='$CH'")"
[ "$TO" -gt "$FROM" ] || { echo "FATAL: derived an empty window ($FROM..$TO)"; exit 1; }

TL=$(get "/channels/$CH/timeline?from=$FROM&to=$TO")
DAYFMT=$(echo "$TL" | python3 -c '
import sys,json,re
d=json.load(sys.stdin)
cs=d.get("containers",[])
print("ok" if cs and all(re.fullmatch(r"\d{4}-\d{2}-\d{2}", c["day"]) for c in cs) else "bad")')
check "container days are YYYY-MM-DD labels, not timestamps" "$DAYFMT" "ok"

# ---- 4. the timeline answers all three lanes in one call -------------------
LANES=$(echo "$TL" | python3 -c '
import sys,json
d=json.load(sys.stdin)
have=[k for k in ("media","days","dayparts","programmes","containers","clock") if k in d]
print(len(have))')
check "the timeline returns every lane in one response" "$LANES" "6"

TZOK=$(echo "$TL" | python3 -c 'import sys,json;print(json.load(sys.stdin)["clock"]["tz"])')
check "the timeline reports the channel clock" "$TZOK" "Europe/London"

DAYSOK=$(echo "$TL" | python3 -c '
import sys,json
d=json.load(sys.stdin)["days"]
# days must tile: each starts exactly where the previous ended
print("ok" if all(d[i]["startMs"]==d[i-1]["endMs"] for i in range(1,len(d))) else "bad")')
check "broadcast days tile with no gap or overlap" "$DAYSOK" "ok"

# ---- 5. dayparts -----------------------------------------------------------
APPLIED=$(put "/channels/$CH/dayparts" '{"presetId":"radio_uk"}')
NAMES=$(echo "$APPLIED" | python3 -c '
import sys,json
print(",".join(x["name"] for x in json.load(sys.stdin)["dayparts"]))')
check "the UK radio preset is applied in clock order" "$NAMES" \
  "Overnight,Breakfast,Mid-morning,Afternoon,Drive,Evening,Late"

DUP=$(put "/channels/$CH/dayparts" '{"dayparts":[{"name":"A","startsLocal":"06:00"},{"name":"B","startsLocal":"06:00"}]}' \
  | python3 -c 'import sys,json;print("error" in json.load(sys.stdin))')
check "two dayparts at the same time are rejected" "$DUP" "True"

BADTIME=$(put "/channels/$CH/dayparts" '{"dayparts":[{"name":"A","startsLocal":"25:00"}]}' \
  | python3 -c 'import sys,json;print("error" in json.load(sys.stdin))')
check "an impossible clock time is rejected" "$BADTIME" "True"

UNKNOWN=$(put "/channels/$CH/dayparts" '{"presetId":"nope"}' \
  | python3 -c 'import sys,json;print("error" in json.load(sys.stdin))')
check "an unknown preset is rejected" "$UNKNOWN" "True"

put "/channels/$CH/dayparts" '{"presetId":"radio_uk"}' > /dev/null

PRESETS=$(get "/daypart-presets" | python3 -c '
import sys,json;print(",".join(p["id"] for p in json.load(sys.stdin)["presets"]))')
check "all presets are offered" "$PRESETS" "radio_uk,tv_uk,radio_us,tv_us,none"

# ---- 6. coverage -----------------------------------------------------------
COV=$(get "/channels/$CH/coverage?from=$FROM&to=$TO")
HASGAPS=$(echo "$COV" | python3 -c '
import sys,json;d=json.load(sys.stdin);print("yes" if d["coveragePct"]<100 else "no")')
if [ "$HASGAPS" = "yes" ]; then
  REASON=$(echo "$COV" | python3 -c '
import sys,json;d=json.load(sys.stdin);print((d.get("reason") or {}).get("code","none"))')
  PCT=$(echo "$COV" | python3 -c '
import sys,json;print(json.load(sys.stdin)["coveragePct"])')
  # ZERO COVERAGE AND PARTIAL COVERAGE ARE DIFFERENT REFUSALS, and the resolver
  # is right to name them differently: nothing recorded at all is `no_media`,
  # while something recorded with holes in it is `coverage_gap`. This asserted
  # `coverage_gap` unconditionally, so it failed against a channel that simply
  # had no segments — a fixture difference reported as a product fault. Assert
  # the reason that matches the coverage actually measured.
  if [ "$PCT" = "0" ] || [ "$PCT" = "0.0" ]; then
    check "an empty range is refused as no_media" "$REASON" "no_media"
  else
    check "an incomplete range is refused as coverage_gap" "$REASON" "coverage_gap"
    GAPS=$(echo "$COV" | python3 -c '
import sys,json;print("yes" if json.load(sys.stdin)["gaps"] else "no")')
    check "and the gaps are named" "$GAPS" "yes"
  fi
else
  CLIP=$(echo "$COV" | python3 -c 'import sys,json;print(json.load(sys.stdin)["clippable"])')
  check "a fully covered range is clippable" "$CLIP" "True"
fi

SUM=$(echo "$COV" | python3 -c '
import sys,json
d=json.load(sys.stdin)
# covered + gaps must account for the whole window, with a little slack for
# segment-boundary rounding at the edges
tot=d["coveredMs"]+sum(g["ms"] for g in d["gaps"])
print("ok" if abs(tot-d["window"]["ms"])<5000 else "off by %d ms" % (tot-d["window"]["ms"]))')
check "covered time plus gaps accounts for the window" "$SUM" "ok"

# ---- 7. a window that is too wide is refused, not answered slowly ----------
WIDE=$(get "/channels/$CH/coverage?from=0&to=9999999999999" \
  | python3 -c 'import sys,json;print("error" in json.load(sys.stdin))')
check "an unbounded window is refused" "$WIDE" "True"

echo
echo "containers-dayparts: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
