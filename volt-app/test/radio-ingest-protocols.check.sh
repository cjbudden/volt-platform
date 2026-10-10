#!/usr/bin/env bash
# ============================================================================
#  CAN A STATION ACTUALLY INGEST ALL THREE SOURCE KINDS?
#
#  The Radio form offers icecast, hls and srt. Until now only one of those was
#  ever exercised. The other two were accepted by the form, stored in the row,
#  and handed to an ffmpeg whose input flags treated every source as "an HTTP
#  byte stream", which is true of exactly one of them.
#
#  WHY A PURE-FUNCTION TEST WAS NOT ENOUGH HERE. radio-args.check.ts already
#  pins the argv and diffs the TypeScript and Python builders against each
#  other, so the two cannot drift. But both can be wrong together: an argv that
#  two implementations agree on is still an argv that has never been handed to
#  ffmpeg. The specific thing that decided this suite should exist is that a
#  playlist source with the wrong entry point does not fail. It works, and puts
#  the station permanently behind live, which no assertion about a string can
#  see.
#
#  So this runs THE PRODUCTION ARGV -- read out of radio.py itself, not
#  reimplemented here -- against a real local source of each kind, and looks for
#  audio on disk at the other end.
#
#  THE THREE SOURCES, all local, on purpose. A public station folds DNS, TLS,
#  somebody else's CDN and their uptime into the result, which is a fine thing
#  to check by hand and a terrible thing to gate a suite on.
#
#    icecast   test/icecast-sim.js  -- the control. If this fails, the harness
#                                      is broken and the other two results mean
#                                      nothing.
#    hls       ffmpeg writing a live playlist, served by python3 -m http.server
#    srt       scripts/srt-radio-source.sh, which LISTENS while the station
#              CALLS -- see that file for why that direction is the rule
#
#  Usage: bash test/radio-ingest-protocols.check.sh      (no database)
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."
. "$(dirname "$0")/lib/portable.sh"   # setsid/timeout/stat differ on macOS; see that file

pass=0; fail=0
ok(){   if eval "$2"; then echo "  PASS $1"; pass=$((pass+1)); else echo "  FAIL $1"; fail=$((fail+1)); fi; }
note(){ echo "     $1"; }

command -v ffmpeg >/dev/null 2>&1 || {
  echo "SKIP ffmpeg is not installed — this suite runs the real pipeline."
  echo; echo "== RESULT: 0 passed, 0 failed =="; exit 0; }

RADIO_PY="../volt-encoder/bin/radio.py"
[ -f "$RADIO_PY" ] || {
  echo "SKIP radio.py not reachable from here"
  echo; echo "== RESULT: 0 passed, 0 failed =="; exit 0; }

WORK=$(mktemp -d)
PIDS=""
cleanup(){ for p in $PIDS; do vkilltree "$p"; done; rm -rf "$WORK"; return 0; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
#  THE ARGV COMES OUT OF radio.py. Not out of a copy of it written here.
#
#  A test that rebuilds the command it is testing is a test of the copy. This
#  imports the module the container runs and asks it what it would do, so a
#  change to the real builder is felt here immediately.
# ---------------------------------------------------------------------------
argv_for(){ # protocol url outdir  -> prints the argv, one token per line
  python3 - "$RADIO_PY" "$1" "$2" "$3" <<'PY'
import json, os, sys
py, proto, url, out = sys.argv[1:5]
sys.path.insert(0, os.path.dirname(os.path.abspath(py)))
import radio
cfg = {"channel_id": "ch", "protocol": proto, "url": url,
       "outputs": {"mp3": False, "hls": True, "dash": False},
       "bitrate_kbps": 128, "segment_seconds": 2, "icecast": None}
for a in radio.build_args(cfg, {"audio": out, "dash": out + "/dash"}):
    print(a)
PY
}

run_pipeline(){ # protocol url label  -> writes segments into $WORK/out-<label>
  proto="$1"; url="$2"; label="$3"
  out="$WORK/out-$label"; mkdir -p "$out"
  argv_for "$proto" "$url" "$out" > "$WORK/argv-$label.txt" 2>"$WORK/argv-$label.err" || return 1
  # Read the argv back into a real array, so a URL with & or ? in it survives.
  args=(); while IFS= read -r line; do args+=("$line"); done < "$WORK/argv-$label.txt"
  vtimeout 25 ffmpeg "${args[@]}" >"$WORK/ff-$label.log" 2>&1
  return 0
}

segments(){ ls "$WORK/out-$1"/seg_*.m4s 2>/dev/null | wc -l | tr -d ' '; }

# ===========================================================================
echo "== the flags each protocol gets, read out of the production builder =="
# ===========================================================================
ICE_ARGV=$(argv_for icecast "http://127.0.0.1:9/x" "$WORK/x" | tr '\n' ' ')
HLS_ARGV=$(argv_for hls     "http://127.0.0.1:9/x.m3u8" "$WORK/x" | tr '\n' ' ')
SRT_ARGV=$(argv_for srt     "srt://127.0.0.1:9/?mode=caller" "$WORK/x" | tr '\n' ' ')

ok "an icecast source reconnects, because one long HTTP body drops" \
   '[[ "$ICE_ARGV" == *"-reconnect 1"* ]]'
ok "and asks for nothing playlist-shaped" \
   '[[ "$ICE_ARGV" != *"-live_start_index"* ]]'

# THE ASSERTION THIS SUITE WAS WRITTEN FOR.
#
# ffmpeg's default entry point into a live playlist is three segments back from
# the end. With a six second source that is EIGHTEEN SECONDS behind real time,
# for the entire run, and it does not look like a fault: the station is on air,
# the meters move, and it is simply late. -1 is the newest complete segment,
# which is as close to live as HLS gets.
#
# Since 11 Oct 2026: -2 and -re. Read at full speed a 10 s-segment source left
# the station in bursts, the Icecast relay timed the mp3 out after 10 s of
# nothing and every station restart cut the recording into pieces. -re paces the
# source at real time and needs one segment in hand, so -2: one segment behind
# live, not three.
ok "an HLS source starts ONE segment back (one in hand for -re), not three" \
   '[[ "$HLS_ARGV" == *"-live_start_index -2"* ]]'
ok "and is read at real time, so the audio leaves evenly, not in 10 s bursts" \
   '[[ "$HLS_ARGV" == *"-re "* ]]'
ok "and does not reuse connections across a CDN's segment host" \
   '[[ "$HLS_ARGV" == *"-http_persistent 0"* ]]'
ok "an SRT source generates timestamps, as encoder.py already does" \
   '[[ "$SRT_ARGV" == *"-fflags +genpts"* ]]'
ok "and gets no HTTP reconnect flags, which mean nothing to libsrt" \
   '[[ "$SRT_ARGV" != *"-reconnect"* ]]'

# ===========================================================================
echo
echo "== icecast: the control, so a failure below is about the protocol =="
# ===========================================================================
SRCFILE="$WORK/loop.mp3"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=440:duration=40" \
  -c:a libmp3lame -b:a 128k "$SRCFILE" >/dev/null 2>&1
if [ ! -s "$SRCFILE" ]; then
  echo "  FAIL could not build a source file"; fail=$((fail+1))
else
  node test/icecast-sim.js 9181 "$SRCFILE" 4 >"$WORK/sim.log" 2>&1 &
  PIDS="$PIDS $!"
  sleep 1
  run_pipeline icecast "http://127.0.0.1:9181/live" ice
  ok "an Icecast mount produces segments" '[ "$(segments ice)" -ge 2 ]'
  note "$(segments ice) segments"
fi

# ===========================================================================
echo
echo "== hls: a real live playlist, refetched, with an edge to find =="
# ===========================================================================
#  A LIVE playlist, not a file. -hls_list_size 6 with delete_segments gives a
#  sliding window with no ENDLIST, which is what a station's playlist is and is
#  the only shape where the entry point matters at all.
HLSDIR="$WORK/hlssrc"; mkdir -p "$HLSDIR"
ffmpeg -hide_banner -loglevel error -nostdin -re \
  -f lavfi -i "sine=frequency=660:sample_rate=44100" \
  -af "tremolo=f=2:d=0.7" -c:a aac -b:a 128k -ac 2 \
  -f hls -hls_time 2 -hls_list_size 6 -hls_flags delete_segments+program_date_time \
  -hls_segment_filename "$HLSDIR/s_%05d.ts" "$HLSDIR/index.m3u8" \
  >"$WORK/hlssrc.log" 2>&1 &
PIDS="$PIDS $!"
( cd "$HLSDIR" && exec python3 -m http.server 9182 >/dev/null 2>&1 ) &
PIDS="$PIDS $!"

# Wait for the playlist to have a window in it, rather than sleeping a guess.
for i in $(seq 1 60); do
  [ -s "$HLSDIR/index.m3u8" ] && [ "$(ls "$HLSDIR"/s_*.ts 2>/dev/null | wc -l)" -ge 3 ] && break
  sleep 0.5
done
if [ ! -s "$HLSDIR/index.m3u8" ]; then
  echo "  FAIL the local HLS source never produced a playlist"; fail=$((fail+1))
  tail -3 "$WORK/hlssrc.log"
else
  ok "the fixture playlist is LIVE (no ENDLIST), like a station's" \
     '! grep -q "EXT-X-ENDLIST" "'"$HLSDIR"'/index.m3u8"'
  run_pipeline hls "http://127.0.0.1:9182/index.m3u8" hls
  ok "an HLS playlist source produces segments" '[ "$(segments hls)" -ge 2 ]'
  note "$(segments hls) segments"
  if [ "$(segments hls)" -lt 2 ]; then tail -5 "$WORK/ff-hls.log"; fi
fi

# ===========================================================================
echo
echo "== srt: contribution in, with the station as the CALLER =="
# ===========================================================================
if ! ffmpeg -hide_banner -protocols 2>/dev/null | tr ' ' '\n' | grep -qx srt; then
  echo "  SKIP this ffmpeg was built without libsrt, so SRT cannot be tested here"
  echo "     macOS: brew install ffmpeg   Debian/Ubuntu: apt install ffmpeg"
else
  PORT=9183 bash scripts/srt-radio-source.sh >"$WORK/srtsrc.log" 2>&1 &
  PIDS="$PIDS $!"
  sleep 2
  run_pipeline srt "srt://127.0.0.1:9183?mode=caller&latency=200" srt
  ok "an SRT contribution feed produces segments" '[ "$(segments srt)" -ge 2 ]'
  note "$(segments srt) segments"
  if [ "$(segments srt)" -lt 2 ]; then tail -5 "$WORK/ff-srt.log"; fi

  # The rule, asserted rather than only written down: the fixture is the one
  # that listens. A station that listened would need a fixed address, a UDP
  # load balancer and a security group, and could not be moved or reaped with
  # the rest of the fleet.
  ok "the STUDIO listens and the station calls, never the other way round" \
     'grep -q "mode=listener" "'"$WORK"'/srtsrc.log"'
fi

echo
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
