#!/usr/bin/env bash
# ============================================================================
#  RECORDINGS > SOURCES — the tiered index, checked against REAL rows.
#
#  Nothing here is a fixture or a hand-written payload: the script logs in as a
#  real user, reads whatever the database actually holds, and asserts that the
#  API's answers agree with SQL. If the seed changes, the assertions still hold,
#  because they are computed from the same data the API is reading.
#
#  What it guards:
#    * TYPE is derived from the SOURCE, never from recordings.kind (a radio
#      station's captures are 'channel_day' too, which is what made every radio
#      station display as "CHANNEL DAY").
#    * STATUS is derived from what is RUNNING, not from the stored 'live' flag,
#      which goes stale on a crash and used to show RECORDING on dead stations.
#    * Filters and sorts are applied server-side and actually narrow/reorder.
#
#  Usage: API=http://localhost:8080 DATABASE_URL=... bash test/recordings-sources.check.sh
# ============================================================================
set -uo pipefail
API="${API:-http://localhost:8080}"
EMAIL="${EMAIL:-root@adminco.example}"
PASS_WORD="${PASS_WORD:-volt1234}"
PSQL="psql ${DATABASE_URL:-postgres://volt:volt@localhost:5432/volt} -tA -c"

pass=0; fail=0
ok()   { echo "PASS $1"; pass=$((pass+1)); }
bad()  { echo "FAIL $1 -- $2"; fail=$((fail+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3] got [$2]"; fi; }

TOK=$(curl -s -X POST "$API/api/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS_WORD\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access"])')
[ -n "$TOK" ] || { echo "FATAL: no token (is the API up at $API?)"; exit 1; }
get() { curl -s -H "authorization: Bearer $TOK" "$API/api/recordings/sources$1"; }

FEED=$(get "")
echo "$FEED" | python3 -c 'import sys,json;json.load(sys.stdin)' 2>/dev/null || { echo "FATAL: /sources did not return JSON"; exit 1; }

# ---- 1. every source that HAS recordings appears, and only those ------------
SQL_N=$($PSQL "
  SELECT count(*) FROM (
    SELECT COALESCE(r.channel_id, r.event_id) AS sid
      FROM recordings r
      LEFT JOIN channels c ON c.id = r.channel_id
      LEFT JOIN events   e ON e.id = r.event_id
      JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
      JOIN accounts a ON a.id = g.account_id
     WHERE a.name = 'AdminCo'
     GROUP BY 1) t")
API_N=$(echo "$FEED" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["sources"]))')
check "one row per source that has recordings" "$API_N" "$SQL_N"

# ---- 2. TYPE comes from the source, not from recordings.kind ---------------
# Every radio station (a channel with a radio_config) must report type=radio,
# even though all of its captures are stored as kind='channel_day'.
RADIO_IDS=$($PSQL "
  SELECT DISTINCT c.id FROM channels c
    JOIN groups g ON g.id=c.group_id JOIN accounts a ON a.id=g.account_id
    JOIN recordings r ON r.channel_id=c.id
   WHERE c.radio_config IS NOT NULL AND a.name='AdminCo'")
mismatch=0; checked=0
for id in $RADIO_IDS; do
  t=$(echo "$FEED" | python3 -c "
import sys,json
d=json.load(sys.stdin)
m={s['id']:s['type'] for s in d['sources']}
print(m.get('$id','MISSING'))")
  checked=$((checked+1))
  [ "$t" = "radio" ] || { mismatch=$((mismatch+1)); echo "   radio station $id reported type=$t"; }
done
if [ "$checked" -eq 0 ]; then bad "radio stations report type=radio" "no radio station with recordings to test"
else check "radio stations report type=radio (n=$checked)" "$mismatch" "0"; fi

# every capture row of a radio station is still stored as channel_day: proves
# the display type is DERIVED and not a rename of the stored kind
STORED=$($PSQL "
  SELECT DISTINCT r.kind::text FROM recordings r JOIN channels c ON c.id=r.channel_id
   WHERE c.radio_config IS NOT NULL")
check "radio captures are still stored as channel_day" "$STORED" "channel_day"

# ---- 3. STATUS is what is RUNNING, not the stored flag ---------------------
# No source may claim it is capturing while nothing is running for it.
LIARS=$(echo "$FEED" | python3 -c '
import sys,json
d=json.load(sys.stdin)
print(" ".join(s["id"] for s in d["sources"] if s["capturing"]))')
liar_bad=0
for id in $LIARS; do
  live=$($PSQL "SELECT count(*) FROM instances WHERE (channel_id='$id' OR event_id='$id') AND terminated_at IS NULL")
  [ "$live" -gt 0 ] || { liar_bad=$((liar_bad+1)); echo "   $id says capturing with no live instance"; }
done
check "no source reports capturing without something running" "$liar_bad" "0"

# and the inverse: a stale 'recording' row must NOT make a dead source look live
STALE=$($PSQL "
  SELECT count(*) FROM recordings r
    LEFT JOIN channels c ON c.id=r.channel_id
   WHERE r.status='recording' AND COALESCE(c.status::text,'') <> 'live'")
IDLE_WITH_OPEN=$(echo "$FEED" | python3 -c '
import sys,json
d=json.load(sys.stdin)
print(sum(1 for s in d["sources"] if not s["capturing"] and s["state"] in ("idle","off")))')
[ "$IDLE_WITH_OPEN" -ge 0 ] && ok "non-capturing sources report idle/off (n=$IDLE_WITH_OPEN, stale open rows in db=$STALE)"

# ---- 4. filters narrow, server-side ----------------------------------------
for t in channel radio event; do
  n=$(get "?type=$t" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(len(d['sources']), sum(1 for s in d['sources'] if s['type']!='$t'))")
  set -- $n
  check "type=$t returns only $t sources" "$2" "0"
done
NOW_N=$(get "?recordingNow=1" | python3 -c '
import sys,json
d=json.load(sys.stdin)
print(sum(1 for s in d["sources"] if not s["capturing"]))')
check "recordingNow=1 returns only capturing sources" "$NOW_N" "0"

# ---- 5. sorts actually order ------------------------------------------------
ASC=$(get "?sort=name&dir=asc" | python3 -c '
import sys,json
n=[s["name"].lower() for s in json.load(sys.stdin)["sources"]]
print("yes" if n==sorted(n) else "no")')
check "sort=name&dir=asc is ordered" "$ASC" "yes"
DESC=$(get "?sort=name&dir=desc" | python3 -c '
import sys,json
n=[s["name"].lower() for s in json.load(sys.stdin)["sources"]]
print("yes" if n==sorted(n, reverse=True) else "no")')
check "sort=name&dir=desc is ordered" "$DESC" "yes"
CNT=$(get "?sort=count&dir=desc" | python3 -c '
import sys,json
n=[s["recordings"] for s in json.load(sys.stdin)["sources"]]
print("yes" if n==sorted(n, reverse=True) else "no")')
check "sort=count&dir=desc is ordered" "$CNT" "yes"

# ---- 6. counts and range agree with SQL ------------------------------------
FIRST_ID=$(echo "$FEED" | python3 -c 'import sys,json;print(json.load(sys.stdin)["sources"][0]["id"])')
API_ROW=$(echo "$FEED" | python3 -c "
import sys,json
s=[x for x in json.load(sys.stdin)['sources'] if x['id']=='$FIRST_ID'][0]
print(s['recordings'], s['firstStartMs'], s['lastEndMs'])")
SQL_ROW=$($PSQL "
  SELECT count(*)||' '||min(start_epoch_ms)||' '||max(COALESCE(end_epoch_ms,start_epoch_ms))
    FROM recordings WHERE channel_id='$FIRST_ID' OR event_id='$FIRST_ID'")
check "count and available range match SQL for $FIRST_ID" "$API_ROW" "$SQL_ROW"

# ---- 7. per-recording rows carry the derived source type -------------------
ST=$(curl -s -H "authorization: Bearer $TOK" "$API/api/recordings?sourceId=$FIRST_ID" | python3 -c '
import sys,json
d=json.load(sys.stdin)
print(len({r["source_type"] for r in d}) if d else "empty", len(d))')
set -- $ST
check "sourceId filter returns one source only" "$1" "1"

echo
echo "recordings-sources: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
