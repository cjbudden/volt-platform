#!/usr/bin/env bash
# ============================================================================
#  A STATION THAT CANNOT REACH ITS SOURCE MUST SAY SO.
#
#  Reported from a demo machine, and the sentence that matters is: "there is
#  either something wrong or all those source stations are blocking our IP or
#  something, but even if that was the case we are not showing errors."
#
#  He was right on both counts. The source really had failed — the run log said
#  "Failed to resolve hostname ice5.somafm.com" — and nothing anywhere told him
#  so. Two separate defects made a broken station look like a quiet one:
#
#    1. source.up FIRED ON LAUNCH. It was emitted the moment Popen returned,
#       which is a statement about having started ffmpeg, not about the source.
#       A station whose hostname does not resolve reported its source healthy
#       and then died 37ms later, and auto connect flickered it green again
#       every twenty seconds.
#
#    2. THE REASON NEVER LEFT THE CONTAINER. The stop event said "encoder
#       exited rc=251". The line that would have told him it was DNS was three
#       lines up in a log file on a task that, on a real deployment, no longer
#       exists.
#
#  Both are asserted here against the REAL encoder and a REAL unreachable
#  source, because both defects were in what the encoder chooses to report and
#  a mocked one would report whatever the mock was told to.
#
#  Usage: bash test/radio-source-failure.check.sh
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."
. "$(dirname "$0")/lib/portable.sh"   # setsid/timeout/stat differ on macOS; see that file

pass=0; fail=0
ok(){ if eval "$2"; then echo "  PASS $1"; pass=$((pass+1)); else echo "  FAIL $1"; fail=$((fail+1)); fi; }

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "SKIP ffmpeg is not installed — this suite tests what the encoder reports when ffmpeg fails."
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
cleanup(){ [ -n "${STATION:-}" ] && kill -TERM -"$STATION" 2>/dev/null; rm -rf "$WORK"; return 0; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
#  A HOSTNAME THAT CANNOT RESOLVE. .invalid is reserved by RFC 2606 precisely
#  so that it never resolves anywhere, which makes this the same failure the
#  demo machine hit rather than an approximation of it — and unlike a made-up
#  name it cannot be caught by someone's wildcard DNS.
# ---------------------------------------------------------------------------
CH=00000000-0000-0000-0000-0000009981a1
cat > "$WORK/job.json" <<JSON
{
  "channel_id": "$CH",
  "protocol": "icecast",
  "url": "http://station.invalid/stream.mp3",
  "bitrate_kbps": 128,
  "segment_seconds": 2,
  "outputs": { "mp3": false, "hls": true, "dash": true },
  "output": { "mode": "local", "dir": "$WORK/origin/$CH" }
}
JSON

echo "== a station whose source does not resolve =="
env JOB_CONFIG_JSON="$(cat "$WORK/job.json")" WORK_DIR="$WORK" \
  "$PY" "$RADIO" > "$WORK/station.log" 2>&1
RC=$?

ok "it exits rather than pretending to be on air" '[ "'$RC'" != "0" ]'
ok "and no segment was written" \
   '! ls "$WORK/origin/'$CH'"/runs/*/audio/*.m4s >/dev/null 2>&1'

echo "== it never claims the source is up =="
# THE HEADLINE. This is what made a broken station look fine in the console.
ok "no source.up event for a source that never arrived" \
   '! grep -q "\"type\": *\"source.up\"" "$WORK/station.log"'
ok "nor a packager.up, which would read as healthy output" \
   '! grep -q "\"type\": *\"packager.up\"" "$WORK/station.log"'

echo "== and the stop says WHY, in words an operator can act on =="
ok "the stop event is reported" 'grep -q "channel.stop" "$WORK/station.log"'
ok "it still carries the exit code" 'grep -q "encoder exited rc=" "$WORK/station.log"'
# The whole point: rc=251 alone sends someone hunting for a log file that will
# not exist on a real deployment.
ok "and the reason names the unresolvable host, not just a number" \
   'grep -qi "resolve\|not known\|nodename" "$WORK/station.log"'
ok "the reason reaches the EVENT, not only the console output" \
   '"$PY" - "$WORK/station.log" <<'"'"'P'"'"'
import json, sys, re
stop = [json.loads(m.group(0))
        for line in open(sys.argv[1])
        for m in [re.search(r"\{.*\}", line)] if m
        and "\"channel.stop\"" in line]
sys.exit(0 if stop and len(str(stop[-1]["detail"].get("reason",""))) > 25 else 1)
P'

echo "== a healthy station is unaffected =="
# The guard on the fix. Waiting for evidence must not mean never reporting it:
# a station that IS working has to go on air and say so, as before.
SRC="$WORK/source.mp3"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=440:duration=30" \
  -c:a libmp3lame -b:a 128k "$SRC" >/dev/null 2>&1
CH2=00000000-0000-0000-0000-0000009981a2
cat > "$WORK/job2.json" <<JSON
{
  "channel_id": "$CH2",
  "protocol": "file",
  "url": "$SRC",
  "bitrate_kbps": 128,
  "segment_seconds": 2,
  "outputs": { "mp3": false, "hls": true, "dash": true },
  "output": { "mode": "local", "dir": "$WORK/origin/$CH2" }
}
JSON
vsetsid env JOB_CONFIG_JSON="$(cat "$WORK/job2.json")" WORK_DIR="$WORK" \
  "$PY" "$RADIO" > "$WORK/station2.log" 2>&1 &
STATION=$!
for i in $(seq 1 30); do
  grep -q "source.up" "$WORK/station2.log" 2>/dev/null && break
  sleep 1
done
ok "a working station does report its source up" \
   'grep -q "source.up" "$WORK/station2.log"'
ok "and reports the packager up with it" \
   'grep -q "packager.up" "$WORK/station2.log"'
ok "having actually written a segment first" \
   'ls "$WORK/origin/'$CH2'"/runs/*/audio/*.m4s >/dev/null 2>&1'
ok "and it is still running" 'kill -0 "$STATION" 2>/dev/null'

kill -TERM -"$STATION" 2>/dev/null; wait "$STATION" 2>/dev/null; STATION=

echo
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
