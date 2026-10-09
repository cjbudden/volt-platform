#!/usr/bin/env bash
# ============================================================================
#  DOES EVERY STATION ACTUALLY PLAY? And if not, is it the station or is it us?
#
#  That second question is the whole design. A station probe is only as honest
#  as the network it runs on, and this exact machine has had intermittent DNS:
#  "Failed to resolve hostname ice5.somafm.com" for a station that plays
#  perfectly from anywhere else. A checker that deleted whatever failed once
#  would have removed a healthy station on a bad afternoon, permanently, and
#  the evidence for the deletion would have been a fault in the checker's own
#  network.
#
#  So it will not condemn a station on:
#    - a NAME RESOLUTION failure. That is this machine's DNS, not their server.
#    - a single failure. Every source gets three tries.
#    - a bad day. If more than half of all stations fail, it removes nothing
#      and says so: that pattern is an internet connection, not eight stations
#      going dark at once.
#
#  AND IT TRIES TO REPAIR BEFORE IT REMOVES. When a source fails to connect,
#  two conservative variants of the SAME host and path are probed: without the
#  explicit port, and over the other scheme. A stale ":8443" is why KPFA looked
#  dead when it was one character from working. A repair is only ever adopted
#  when audio actually arrived from it; nothing is guessed.
#
#  Evidence of "works" is ffprobe finding an audio stream, which is the same
#  evidence the encoder itself acts on. A 200 response is not enough: plenty of
#  dead mounts return a cheerful 200 and no audio.
#
#  Usage:
#    bash volt-station-check.sh              # report only, changes nothing
#    FIX=1 bash volt-station-check.sh        # apply verified URL repairs
#    FIX=1 REMOVE=1 bash volt-station-check.sh   # repair, then delete the dead
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")"; ROOT="$(pwd)"
DBURL="${DATABASE_URL:-postgres://volt:volt@localhost:5432/volt}"
TRIES="${TRIES:-3}"
TIMEOUT="${PROBE_TIMEOUT:-20}"

command -v ffprobe >/dev/null 2>&1 || { echo "  ffprobe is required (it comes with ffmpeg)."; exit 1; }

# ---------------------------------------------------------------------------
#  A PORTABLE TIMEOUT. macOS does not ship `timeout`: it is GNU coreutils, and
#  on a Mac it exists only as `gtimeout` if somebody installed coreutils from
#  Homebrew. The first version of this script assumed it, and on a Mac every
#  single probe failed with "timeout: command not found" -- which the script
#  then dutifully reported as nine dead stations.
#
#  So: use whichever real one exists, and otherwise run the probe in the
#  background and kill it. The fallback is the plain-bash equivalent and needs
#  nothing installed.
# ---------------------------------------------------------------------------
if command -v gtimeout >/dev/null 2>&1; then
  with_timeout() { gtimeout "$@"; }
elif command -v timeout >/dev/null 2>&1; then
  with_timeout() { timeout "$@"; }
else
  with_timeout() {
    local secs="$1"; shift
    "$@" & local pid=$! i=0 ticks=$(( secs * 10 ))
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt "$ticks" ]; do sleep 0.1; i=$((i+1)); done
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; return 124
    fi
    wait "$pid"; return $?
  }
fi

if command -v psql >/dev/null 2>&1 && (exec 3<>/dev/tcp/localhost/5432) 2>/dev/null; then
  pg() { psql "$DBURL" -v ON_ERROR_STOP=1 "$@"; }
elif command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx volt-pg; then
  pg() { docker exec -i volt-pg psql -U volt -d volt -v ON_ERROR_STOP=1 "$@"; }
else
  echo "  Cannot reach Postgres. Start it (docker start volt-pg) and re-run."; exit 1
fi

# ---------------------------------------------------------------------------
#  Probe: does audio actually arrive? Returns 0 and prints the codec if so.
#  The failure text is left in $PROBE_ERR so the caller can tell a dead station
#  from a broken network.
# ---------------------------------------------------------------------------
# The failure text goes to a FILE, not a variable. probe() is always called
# inside $( ), and a variable set inside a command substitution dies with the
# subshell -- which is why the first version of this reported dead stations
# with a blank reason, the one thing the report exists to tell you.
ERRFILE=$(mktemp); trap 'rm -f "$ERRFILE"' EXIT
probe() {
  local url="$1" out rc
  out=$(with_timeout "$TIMEOUT" ffprobe -v error -select_streams a:0 \
        -show_entries stream=codec_name,sample_rate -of csv=p=0 \
        -analyzeduration 3000000 -i "$url" 2>&1); rc=$?
  if [ $rc -eq 0 ] && [ -n "$out" ]; then echo "$out" | head -1; return 0; fi
  # THE WHOLE OUTPUT IS KEPT, not just its last line, and that is not tidiness.
  # ffmpeg prints the root cause FIRST and the consequences after it: a failed
  # DNS lookup is followed by "Input/output error", which is what tail -1 gives
  # you. Classifying on that line alone read every unresolvable host as a dead
  # station, which is exactly the mistake this script exists to avoid making on
  # a machine with intermittent DNS.
  if [ $rc -eq 124 ] && [ -z "$out" ]; then
    echo "timed out after ${TIMEOUT}s with no response" > "$ERRFILE"
  else
    echo "$out" > "$ERRFILE"
  fi
  return 1
}

# The most explanatory line, by the same rule: earliest recognised cause wins,
# and ffmpeg's "[tcp @ 0x...]" component prefixes are noise.
summarise() {
  local f="$1" ln low
  while read -r ln; do
    ln=$(echo "$ln" | sed -E 's/^\[[^]]+\][[:space:]]*//')
    [ -z "$ln" ] && continue
    low=$(echo "$ln" | tr 'A-Z' 'a-z')
    case "$low" in
      *resolve*|*"not known"*|*nodename*|*refused*|*"timed out"*|*unreachable*|\
      *"403"*|*"404"*|*"401"*|*"invalid data"*|*"end of file"*|*handshake*)
        echo "${ln:0:110}"; return ;;
    esac
  done < "$f"
  sed -E 's/^\[[^]]+\][[:space:]]*//' "$f" | grep -v '^[[:space:]]*$' | tail -1 | cut -c1-110
}

probe_repeatedly() {
  local url="$1" i codec
  for i in $(seq 1 "$TRIES"); do
    if codec=$(probe "$url"); then echo "$codec"; return 0; fi
    sleep 1
  done
  return 1
}

# Same host, same path, one thing changed. Never a URL invented from nothing.
variants() {
  local url="$1"
  # strip an explicit port
  echo "$url" | sed -E 's#^(https?://[^/:]+):[0-9]+#\1#'
  # the other scheme
  case "$url" in
    https://*) echo "http://${url#https://}" ;;
    http://*)  echo "https://${url#http://}" ;;
  esac
}

# ---------------------------------------------------------------------------
#  IS THE PROBE ITSELF WORKING? Ask before believing a word it says.
#
#  A harness that cannot run reports every station dead, and a report of "9 of 9
#  dead" is indistinguishable from a real outage unless somebody checks. That is
#  not hypothetical: the missing `timeout` above produced exactly that, and the
#  only thing standing between it and nine deleted stations was the
#  more-than-half refusal at the end. A refusal is a backstop, not a diagnosis.
#
#  So the probe is proven against a source that cannot fail: a second of silence
#  generated locally, no network involved. If that cannot be read, the fault is
#  here and the run stops without judging anything.
# ---------------------------------------------------------------------------
SELFTEST=$(mktemp -u).wav
if ! ffmpeg -hide_banner -loglevel error -y -f lavfi -i "anullsrc=r=44100:cl=mono" \
       -t 1 "$SELFTEST" >/dev/null 2>&1; then
  echo "  Could not generate a self-test file with ffmpeg. Stopping rather than"
  echo "  reporting stations dead on a probe that has not been shown to work."
  exit 1
fi
if ! probe "$SELFTEST" >/dev/null; then
  echo "  THE PROBE ITSELF IS BROKEN, so nothing here would be evidence about"
  echo "  your stations. It could not read a file it just created:"
  echo
  sed 's/^/      /' "$ERRFILE" | head -5
  echo
  echo "  Fix that first. Nothing has been checked and nothing has been changed."
  rm -f "$SELFTEST"; exit 1
fi
rm -f "$SELFTEST"

echo "== stations =="
pg -tAc "SELECT c.id||E'\t'||c.name||E'\t'||coalesce(si.ingest_url,'')
           FROM channels c
           LEFT JOIN stream_inputs si
             ON si.channel_id=c.id AND si.role='primary'
          WHERE c.kind='radio'
          ORDER BY c.name" > /tmp/volt-stations.$$ || { echo "  could not read the stations"; exit 1; }

TOTAL=0; OKN=0
DEAD_IDS=(); DEAD_NAMES=(); DEAD_N=0; NETWORK_FAULT=0
FIXED=0

while IFS=$'\t' read -r id name url; do
  [ -z "${id:-}" ] && continue
  TOTAL=$((TOTAL+1))
  if [ -z "$url" ]; then
    printf "  %-24s %-6s %s\n" "$name" "DEAD" "no primary source configured"
    DEAD_IDS[$DEAD_N]="$id"; DEAD_NAMES[$DEAD_N]="$name (no source)"; DEAD_N=$((DEAD_N+1)); continue
  fi
  if codec=$(probe_repeatedly "$url"); then
    printf "  %-24s %-6s %s\n" "$name" "OK" "$codec"
    OKN=$((OKN+1)); continue
  fi
  err=$(summarise "$ERRFILE")

  # THIS MACHINE'S DNS, NOT THEIR SERVER. Never grounds for deletion. Matched
  # against the FULL output rather than the summary, so a resolve failure buried
  # above an "Input/output error" is still recognised for what it is.
  if grep -qiE "resolve|nodename|name or service not known" "$ERRFILE"; then
    printf "  %-24s %-6s %s\n" "$name" "DNS" "cannot resolve the hostname here; NOT counted against the station"
    NETWORK_FAULT=$((NETWORK_FAULT+1)); continue
  fi

  # Try to repair before condemning.
  repaired=""
  while read -r cand; do
    [ -z "$cand" ] && continue
    [ "$cand" = "$url" ] && continue
    if codec=$(probe "$cand"); then repaired="$cand"; break; fi
  done < <(variants "$url")

  if [ -n "$repaired" ]; then
    printf "  %-24s %-6s %s\n" "$name" "FIX" "$url"
    printf "  %-24s %-6s -> %s  (%s)\n" "" "" "$repaired" "$codec"
    if [ "${FIX:-0}" = "1" ]; then
      pg -q -c "UPDATE stream_inputs SET ingest_url='$repaired'
                 WHERE channel_id='$id' AND role='primary'" >/dev/null && FIXED=$((FIXED+1))
    fi
    OKN=$((OKN+1)); continue
  fi

  printf "  %-24s %-6s %s\n" "$name" "DEAD" "${err:-no audio stream found}"
  DEAD_IDS[$DEAD_N]="$id"; DEAD_NAMES[$DEAD_N]="$name"; DEAD_N=$((DEAD_N+1))
done < /tmp/volt-stations.$$
rm -f /tmp/volt-stations.$$

echo
echo "== $OKN of $TOTAL playing, $DEAD_N dead, $NETWORK_FAULT unresolvable from here =="
[ "${FIX:-0}" = "1" ] && [ "$FIXED" -gt 0 ] && echo "   $FIXED source URL(s) corrected"

if [ "$NETWORK_FAULT" -gt 0 ]; then
  echo "   NOTE: $NETWORK_FAULT station(s) could not be resolved by this machine's DNS."
  echo "   They have been left alone. That is a local fault and says nothing about them."
fi

if [ "$DEAD_N" -eq 0 ]; then echo; echo "== nothing to remove =="; exit 0; fi

# A BAD DAY IS NOT EIGHT DEAD STATIONS. If most of the fleet failed, the thing
# that is broken is the connection, and deleting on that evidence is how you
# lose a working demo to a flaky afternoon.
if [ "$TOTAL" -gt 2 ] && [ "$(( $DEAD_N * 2 ))" -gt "$TOTAL" ]; then
  echo
  echo "== REFUSING TO REMOVE: $DEAD_N of $TOTAL stations failed =="
  echo "   More than half the fleet failing at once is an internet connection,"
  echo "   not a fleet. Check the network and run this again."
  exit 1
fi

echo
echo "== dead =="
i=0; while [ "$i" -lt "$DEAD_N" ]; do echo "   ${DEAD_NAMES[$i]}"; i=$((i+1)); done

if [ "${REMOVE:-0}" != "1" ]; then
  echo
  echo "   Report only. Re-run with FIX=1 REMOVE=1 to apply repairs and delete these."
  exit 0
fi

echo
i=0; while [ "$i" -lt "$DEAD_N" ]; do
  pg -q -c "DELETE FROM channels WHERE id='${DEAD_IDS[$i]}'" >/dev/null \
    && echo "   removed ${DEAD_NAMES[$i]}" \
    || echo "   could NOT remove ${DEAD_NAMES[$i]}"
  i=$((i+1))
done
echo
echo "== done =="
