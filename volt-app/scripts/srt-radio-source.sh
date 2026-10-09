#!/usr/bin/env bash
# ============================================================================
#  A STUDIO, STANDING IN FOR A REAL ONE, SPEAKING SRT.
#
#  WHY THIS EXISTS AT ALL. Every other seeded station points at a URL on the
#  public internet, because thousands of stations publish over Icecast and a
#  growing number publish over HLS. NOBODY DISTRIBUTES RADIO OVER SRT, so there
#  is no public URL to point at, and there never will be. SRT is a CONTRIBUTION
#  protocol: it carries audio from a studio, an outside broadcast or a remote
#  presenter INTO a platform, over the public internet, with retransmission and
#  encryption. The listener-facing side of that same station is still Icecast
#  and HLS.
#
#  So proving SRT ingest works needs something to contribute. This is it.
#
#  THE DIRECTION IS THE IMPORTANT PART, and it is not arbitrary.
#
#      THIS SCRIPT LISTENS.  THE STATION CALLS.
#
#  It would be one flag to invert that and have the station listen for an
#  incoming feed. It is the wrong flag. A station is a container, and the rule
#  that makes the whole fleet deployable is that A CONTAINER ACCEPTS NO INBOUND
#  CONNECTIONS: it pulls or dials out, pushes segments to storage and pushes
#  status to the API. A container listening on a port needs a stable address, a
#  load balancer that understands UDP, a security group, and it cannot be moved,
#  scaled or reaped like everything else. Radio was containerised precisely to
#  stop being the exception. So the studio listens and the station dials it,
#  which is also how a real SRT contribution link is normally set up: the studio
#  end is the one with the fixed address.
#
#  Usage:
#    bash scripts/srt-radio-source.sh                 # 1 kHz test tone on :9010
#    bash scripts/srt-radio-source.sh --relay <url>   # relay a real station in
#    PORT=9020 bash scripts/srt-radio-source.sh       # somewhere else
#
#  Then start the seeded "Studio SRT (fixture)" station, or point any station at
#      srt://127.0.0.1:9010?mode=caller&latency=200
#
#  Leave it running for as long as you want the station on air. Ctrl-C stops it,
#  and the station will report its source going down, which is itself worth
#  watching once: it is the same path a real contribution feed dropping takes.
# ============================================================================
set -uo pipefail

PORT="${PORT:-9010}"
RELAY=""
TONE_HZ="${TONE_HZ:-440}"

while [ $# -gt 0 ]; do
  case "$1" in
    --relay) RELAY="${2:-}"; shift 2 ;;
    --port)  PORT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1"; exit 2 ;;
  esac
done

command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg is not installed"; exit 1; }

# FAIL HERE, NOT IN THE STATION. An ffmpeg without libsrt does not say "no SRT
# support": it says "Protocol not found", three lines into a log file on a
# container's disk, and the station simply never comes up. Checking the host's
# own build first turns that into one clear sentence.
if ! ffmpeg -hide_banner -protocols 2>/dev/null | tr ' ' '\n' | grep -qx srt; then
  echo "This ffmpeg has no SRT support (built without libsrt)."
  echo "  macOS:  brew install ffmpeg      (the Homebrew build includes libsrt)"
  echo "  Debian/Ubuntu:  apt install ffmpeg"
  exit 1
fi

# MPEG-TS is the payload SRT carries in practice, and it is what encoder.py and
# radio.py both expect on the other end. AAC in TS keeps this honest: a real
# contribution feed is compressed, not raw.
COMMON=(-c:a aac -b:a 128k -ar 48000 -ac 2 -f mpegts)
DEST="srt://0.0.0.0:${PORT}?mode=listener&latency=200"

if [ -n "$RELAY" ]; then
  echo "SRT studio fixture: relaying $RELAY"
  echo "  listening on $DEST"
  echo "  point a station at srt://127.0.0.1:${PORT}?mode=caller&latency=200"
  echo
  # -re is deliberately ABSENT for a live relay: the source already arrives in
  # real time, and pacing an already-paced stream drifts.
  exec ffmpeg -hide_banner -loglevel warning -nostdin \
    -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -i "$RELAY" \
    -map 0:a:0 "${COMMON[@]}" "$DEST"
fi

echo "SRT studio fixture: ${TONE_HZ} Hz test tone with a spoken-word cadence"
echo "  listening on $DEST"
echo "  point a station at srt://127.0.0.1:${PORT}?mode=caller&latency=200"
echo
# A BARE SINE IS A BAD FIXTURE. It is perfectly steady, so the dead-air and
# static detectors see something no real programme ever looks like, and a level
# meter shows a flat line that could equally be a frozen UI. Amplitude-modulating
# it at roughly the rhythm of speech gives the meter something to move to and the
# QC checks something with a shape. `-re` paces it at real time, which is the
# whole point: a contribution feed arrives at 1x, not as fast as the disk allows.
exec ffmpeg -hide_banner -loglevel warning -nostdin -re \
  -f lavfi -i "sine=frequency=${TONE_HZ}:sample_rate=48000" \
  -af "tremolo=f=2:d=0.7,volume=0.5" \
  "${COMMON[@]}" "$DEST"
