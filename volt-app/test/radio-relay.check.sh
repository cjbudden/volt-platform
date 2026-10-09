#!/usr/bin/env bash
# ============================================================================
#  A DEAD MP3 RELAY MUST COST YOU MP3, NOT THE STATION.
#
#  Reported from a demo machine: a station that produced nothing at all, exited
#  about a second after every start, and was relaunched every twenty seconds.
#  The run logs said only this:
#
#      Connection to tcp://localhost:8000 failed: Connection refused
#      Error opening output icecast://…/<id>.mp3: Connection refused
#      Error opening output files: Connection refused
#
#  ONE FFMPEG CARRIES EVERY OUTPUT. It opens them ALL before it encodes
#  anything, so a refused icecast:// connection does not cost the MP3 — it
#  kills the process, and the HLS and DASH that were going to disk are never
#  written either. config.ts had claimed the opposite ("the MP3 output fails
#  while HLS and DASH carry on regardless") since the relay was introduced, and
#  it was simply not true.
#
#  What this suite asserts, against the REAL ffmpeg and a REAL absent relay,
#  because the whole failure was in what ffmpeg does with its output list and a
#  mocked one would test the mock:
#
#    1. With no relay listening, the station still goes on air: HLS segments
#       and a DASH manifest appear on disk.
#    2. It does not exit. The old behaviour was death within a second or two.
#    3. It says why, so an operator finds the reason rather than a silent gap.
#    4. The MP3 output is genuinely dropped rather than retried in a loop.
#    5. A station whose ONLY output is MP3 still fails loudly — a station with
#       nothing to serve must not report itself as on air.
#
#  Usage: bash test/radio-relay.check.sh
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."
. "$(dirname "$0")/lib/portable.sh"   # setsid/timeout/stat differ on macOS; see that file

pass=0; fail=0
ok(){ if eval "$2"; then echo "  PASS $1"; pass=$((pass+1)); else echo "  FAIL $1"; fail=$((fail+1)); fi; }

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "SKIP ffmpeg is not installed — this suite tests what ffmpeg does with a refused output."
  echo; echo "== RESULT: 0 passed, 0 failed =="; exit 0
fi
PY=${PYTHON_BIN:-python3}
RADIO=../volt-encoder/bin/radio.py
[ -f "$RADIO" ] || RADIO=$(cd "$(dirname "$0")/../../volt-encoder/bin" 2>/dev/null && pwd)/radio.py
if [ ! -f "$RADIO" ]; then
  echo "SKIP could not find volt-encoder/bin/radio.py"
  echo; echo "== RESULT: 0 passed, 0 failed =="; exit 0
fi

WORK=$(mktemp -d)
chmod 755 "$WORK"
# NOTE the guard on STATION. `kill -TERM -0` is not a no-op: 0 means "my own
# process group", so an unguarded cleanup signals the test runner itself and
# the suite appears to hang after printing a clean result.
cleanup(){ [ -n "${STATION:-}" ] && kill -TERM -"$STATION" 2>/dev/null; rm -rf "$WORK"; return 0; }
trap cleanup EXIT

# A real, finite audio source. A station is normally endless; ninety seconds is
# plenty to prove segments are being written and the process is not dying.
SRC="$WORK/source.mp3"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=440:duration=90" \
  -c:a libmp3lame -b:a 128k "$SRC" >/dev/null 2>&1
[ -s "$SRC" ] || { echo "FATAL could not generate a source"; echo; echo "== RESULT: 0 passed, 1 failed =="; exit 1; }

# A PORT WITH NOTHING ON IT. Deliberately not just any high port: bound and
# released so it is known to be free, which is what "connection refused" needs.
DEADPORT=$("$PY" - <<'P'
import socket
s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); print(p)
P
)
CH=00000000-0000-0000-0000-0000009980a1

cat > "$WORK/job.json" <<JSON
{
  "channel_id": "$CH",
  "protocol": "file",
  "url": "$SRC",
  "bitrate_kbps": 128,
  "segment_seconds": 2,
  "outputs": { "mp3": true, "hls": true, "dash": true },
  "icecast": {
    "host": "127.0.0.1",
    "port": $DEADPORT,
    "username": "source",
    "password": "hackme",
    "mount": "$CH.mp3"
  },
  "output": { "mode": "local", "dir": "$WORK/origin/$CH" }
}
JSON

echo "== a station with no relay still goes on air =="
vsetsid env JOB_CONFIG_JSON="$(cat "$WORK/job.json")" WORK_DIR="$WORK" \
  "$PY" "$RADIO" > "$WORK/station.log" 2>&1 &
STATION=$!

# Give it time to probe, start, and write a couple of segments.
for i in $(seq 1 30); do
  ls "$WORK/origin/$CH"/runs/*/audio/*.m4s >/dev/null 2>&1 && break
  sleep 1
done

ok "HLS segments were written despite the dead relay" \
   'ls "$WORK/origin/'$CH'"/runs/*/audio/*.m4s >/dev/null 2>&1'
ok "and the HLS playlist exists" \
   'ls "$WORK/origin/'$CH'"/runs/*/audio/index.m3u8 >/dev/null 2>&1'
ok "and DASH too" \
   'ls "$WORK/origin/'$CH'"/runs/*/dash/manifest.mpd >/dev/null 2>&1'

# THE HEADLINE. The old behaviour was rc=195 within about a second.
ok "the station is STILL RUNNING, not dead a second after start" \
   'kill -0 "$STATION" 2>/dev/null'

echo "== and it says why, rather than leaving a silent gap =="
ok "the log names the unreachable relay" \
   'grep -qi "relay unreachable" "$WORK/station.log"'
ok "and says what it did about it" \
   'grep -qi "without it\|HLS/DASH" "$WORK/station.log"'
ok "an output.degraded event is reported, so the console can show it" \
   'grep -q "output.degraded" "$WORK/station.log"'
ok "the station still reported itself started" \
   'grep -q "channel.start" "$WORK/station.log"'

echo "== the MP3 output is dropped, not retried in a loop =="
# The old failure signature. Any of these means the relay is still in the
# output list and ffmpeg is still dying on it.
ok "no connection-refused error from ffmpeg" \
   '! grep -qi "Connection refused" "$WORK/station.log"'
ok "no rc=195 exit" '! grep -q "rc=195" "$WORK/station.log"'
ok "only one run directory: it did not restart" \
   '[ "$(ls "$WORK/origin/'$CH'"/runs 2>/dev/null | wc -l | tr -d " ")" = "1" ]'

kill -TERM -"$STATION" 2>/dev/null; wait "$STATION" 2>/dev/null; STATION=

echo "== but a station with NOTHING left to serve fails loudly =="
# mp3 was the only output. Dropping it leaves nothing, and a station that
# serves nothing must not report itself as on air.
CH2=00000000-0000-0000-0000-0000009980a2
cat > "$WORK/job2.json" <<JSON
{
  "channel_id": "$CH2",
  "protocol": "file",
  "url": "$SRC",
  "bitrate_kbps": 128,
  "outputs": { "mp3": true, "hls": false, "dash": false },
  "icecast": { "host": "127.0.0.1", "port": $DEADPORT, "username": "source", "password": "hackme", "mount": "$CH2.mp3" },
  "output": { "mode": "local", "dir": "$WORK/origin/$CH2" }
}
JSON
env JOB_CONFIG_JSON="$(cat "$WORK/job2.json")" WORK_DIR="$WORK" \
  "$PY" "$RADIO" > "$WORK/station2.log" 2>&1
RC2=$?
ok "it exits non-zero" '[ "'$RC2'" != "0" ]'
ok "and says that no outputs remain" 'grep -qi "no outputs remain" "$WORK/station2.log"'
ok "rather than claiming to be on air" '! grep -q "channel.start" "$WORK/station2.log"'

echo
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
