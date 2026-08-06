#!/usr/bin/env bash
# ============================================================================
#  Volt TEST STREAM generator — a self-contained live encoder for the test build.
#
#  Produces a REAL live HLS (multi-rendition) + optional DASH ladder from a
#  synthetic test pattern (moving test card, a running wall-clock burned into the
#  picture so you can SEE it's live, plus a sine tone). Writes a rolling live
#  playlist into an origin directory the control plane serves, so the app's output
#  player can actually play it back and you can scrub the DVR window.
#
#  Usage:
#    test-stream.sh --out DIR [--name LABEL] [--dvr-sec N] [--dash] [--source FILE]
#
#    --out DIR      output origin directory (required), e.g. origin/<channelId>
#    --name LABEL   text burned into the slate (default "VOLT TEST")
#    --dvr-sec N    DVR window in seconds (HLS list size); 0 = keep everything
#                   (event mode). Default 60.
#    --seg N        segment duration seconds (default 4)
#    --dash         also emit a DASH manifest (stream.mpd)
#    --source FILE  loop this media file instead of the synthetic test card
#    --pid FILE     write the ffmpeg pid here (for stop)
#
#  Renditions: 720p/2.8M, 480p/1.6M, 360p/1.2M (H.264 + AAC), CMAF/fMP4 (light test defaults).
#  Stop with:  kill $(cat <pidfile>)   (or Ctrl-C)
# ============================================================================
set -euo pipefail

OUT=""; NAME="VOLT TEST"; DVR_SEC=60; SEG=4; DASH=0; SOURCE=""; PIDFILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2;;
    --name) NAME="$2"; shift 2;;
    --dvr-sec) DVR_SEC="$2"; shift 2;;
    --seg) SEG="$2"; shift 2;;
    --dash) DASH=1; shift;;
    --source) SOURCE="$2"; shift 2;;
    --pid) PIDFILE="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[ -n "$OUT" ] || { echo "--out DIR is required" >&2; exit 2; }
command -v ffmpeg >/dev/null || { echo "ffmpeg not found on PATH" >&2; exit 3; }

mkdir -p "$OUT"
# HLS list size: number of segments kept live. 0 => keep all (event DVR).
if [ "$DVR_SEC" = "0" ]; then LIST_SIZE=0; else LIST_SIZE=$(( DVR_SEC / SEG )); [ "$LIST_SIZE" -lt 1 ] && LIST_SIZE=1; fi

# ---- source: synthetic test card + running clock + tone, OR a looped file ----
if [ -n "$SOURCE" ]; then
  IN=(-stream_loop -1 -re -i "$SOURCE")
  VF="scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,drawtext=text='%{localtime\:%X}':x=(w-tw)/2:y=h-80:fontsize=54:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=10"
  AIN=()
else
  # testsrc2 (color pattern that changes) at 1080p50 + a sine tone.
  IN=(-re -f lavfi -i "testsrc2=size=1280x720:rate=25" -f lavfi -i "sine=frequency=440:sample_rate=48000")
  VF="drawtext=text='$NAME':x=(w-tw)/2:y=120:fontsize=64:fontcolor=white:box=1:boxcolor=black@0.45:boxborderw=16,drawtext=text='%{localtime\:%X}':x=(w-tw)/2:y=h-90:fontsize=72:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=14,drawtext=text='LIVE TEST \\= frame %{n}':x=(w-tw)/2:y=h-180:fontsize=34:fontcolor=0x99aadd:box=1:boxcolor=black@0.4:boxborderw=8"
  AIN=()
fi

echo "== Volt test stream =="
echo "   out=$OUT  name='$NAME'  dvr=${DVR_SEC}s (list=$LIST_SIZE)  seg=${SEG}s  dash=$DASH  source=${SOURCE:-testcard}"

# three-rendition ladder via -filter_complex split+scale; map to var_stream_map
ffmpeg -hide_banner -loglevel warning -y \
  "${IN[@]}" \
  -filter_complex "[0:v]${VF},split=3[v1][v2][v3];\
[v1]scale=1280:720[v1o];[v2]scale=854:480[v2o];[v3]scale=640:360[v3o]" \
  -map "[v1o]" -map "[v2o]" -map "[v3o]" -map 1:a -map 1:a -map 1:a \
  -c:v libx264 -preset ultrafast -tune zerolatency -g $((SEG*25)) -keyint_min $((SEG*25)) -sc_threshold 0 \
  -b:v:0 2800k -maxrate:v:0 3000k -bufsize:v:0 4200k \
  -b:v:1 2800k -maxrate:v:1 3000k -bufsize:v:1 4200k \
  -b:v:2 1200k -maxrate:v:2 1280k -bufsize:v:2 1800k \
  -c:a aac -b:a 128k -ac 2 \
  -f hls \
  -hls_time "$SEG" -hls_list_size "$LIST_SIZE" \
  -hls_flags "independent_segments+program_date_time$([ "$LIST_SIZE" = 0 ] && echo '' || echo '+delete_segments')" \
  -hls_segment_type fmp4 \
  -master_pl_name master.m3u8 \
  -var_stream_map "v:0,a:0,name:720p v:1,a:1,name:480p v:2,a:2,name:360p" \
  -hls_segment_filename "$OUT/%v_seg%05d.m4s" \
  "$OUT/%v.m3u8" &
FFPID=$!
[ -n "$PIDFILE" ] && echo "$FFPID" > "$PIDFILE"
echo "   ffmpeg pid $FFPID"

# optional DASH from the same source (separate process to keep it simple)
if [ "$DASH" = "1" ]; then
  ffmpeg -hide_banner -loglevel warning -y "${IN[@]}" \
    -filter_complex "[0:v]${VF},split=3[d1][d2][d3];[d1]scale=1280:720[d1o];[d2]scale=854:480[d2o];[d3]scale=640:360[d3o]" \
    -map "[d1o]" -map "[d2o]" -map "[d3o]" -map 1:a \
    -c:v libx264 -preset ultrafast -tune zerolatency -g $((SEG*25)) -keyint_min $((SEG*25)) -sc_threshold 0 \
    -b:v:0 5000k -b:v:1 2800k -b:v:2 1200k -c:a aac -b:a 128k -ac 2 \
    -f dash -seg_duration "$SEG" -window_size "${LIST_SIZE:-12}" -streaming 1 -ldash 1 \
    -use_timeline 1 -use_template 1 \
    "$OUT/stream.mpd" &
  echo "   dash pid $!"
fi

wait $FFPID
