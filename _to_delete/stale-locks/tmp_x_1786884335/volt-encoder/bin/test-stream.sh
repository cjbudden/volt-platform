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
#    Watermark (BURNED into the picture, mirrors the production transcode encoder):
#    --watermark SRC   logo image, a local file path OR an http(s) URL (fetched once)
#    --wm-pos POS      tl|tr|bl|br|tc|bc (default br)
#    --wm-scale N      logo height as a percent of the frame height (default 12)
#    --wm-opacity N    0 to 100 (default 100)
#    --wm-x N          pixel offset from the edge, horizontal (default 24)
#    --wm-y N          pixel offset from the edge, vertical (default 24)
#
#  Renditions: 720p/2.8M, 480p/1.6M, 360p/1.2M (H.264 + AAC), CMAF/fMP4 (light test defaults).
#  Stop with:  kill $(cat <pidfile>)   (or Ctrl-C)
# ============================================================================
set -euo pipefail

OUT=""; NAME="VOLT TEST"; DVR_SEC=60; SEG=4; DASH=0; SOURCE=""; INPUT_URL=""; PIDFILE=""
WATERMARK=""; WM_POS="br"; WM_SCALE=12; WM_OPACITY=100; WM_X=24; WM_Y=24
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2;;
    --name) NAME="$2"; shift 2;;
    --dvr-sec) DVR_SEC="$2"; shift 2;;
    --seg) SEG="$2"; shift 2;;
    --dash) DASH=1; shift;;
    --source) SOURCE="$2"; shift 2;;
    --input-url) INPUT_URL="$2"; shift 2;;   # ingest an external live HLS/URL source
    --watermark) WATERMARK="$2"; shift 2;;   # burn a logo into the picture
    --wm-pos) WM_POS="$2"; shift 2;;
    --wm-scale) WM_SCALE="$2"; shift 2;;
    --wm-opacity) WM_OPACITY="$2"; shift 2;;
    --wm-x) WM_X="$2"; shift 2;;
    --wm-y) WM_Y="$2"; shift 2;;
    --pid) PIDFILE="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[ -n "$OUT" ] || { echo "--out DIR is required" >&2; exit 2; }
command -v ffmpeg >/dev/null || { echo "ffmpeg not found on PATH" >&2; exit 3; }

mkdir -p "$OUT"
# HLS list size: number of segments kept live. 0 => keep all (event DVR).
if [ "$DVR_SEC" = "0" ]; then LIST_SIZE=0; else LIST_SIZE=$(( DVR_SEC / SEG )); [ "$LIST_SIZE" -lt 1 ] && LIST_SIZE=1; fi

# ---- source: external live URL, a looped file, OR the synthetic test card -----
# AMAP = which input carries audio (source input 0, or the sine on input 1).
if [ -n "$INPUT_URL" ]; then
  # ingest an external live HLS (or any ffmpeg-readable URL); reconnect on drop.
  IN=(-reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 5 -i "$INPUT_URL")
  VF="null,drawtext=text='$NAME':x=24:y=24:fontsize=30:fontcolor=white:box=1:boxcolor=black@0.4:boxborderw=8,drawtext=text='%{localtime\:%X}':x=24:y=h-52:fontsize=32:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=8"
  AMAP="0:a"
elif [ -n "$SOURCE" ]; then
  IN=(-stream_loop -1 -re -i "$SOURCE")
  VF="scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,drawtext=text='%{localtime\:%X}':x=(w-tw)/2:y=h-70:fontsize=44:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=10"
  AMAP="0:a"
else
  # testsrc2 (color pattern that changes) + a sine tone.
  IN=(-re -f lavfi -i "testsrc2=size=1280x720:rate=25" -f lavfi -i "sine=frequency=440:sample_rate=48000")
  VF="drawtext=text='$NAME':x=(w-tw)/2:y=120:fontsize=64:fontcolor=white:box=1:boxcolor=black@0.45:boxborderw=16,drawtext=text='%{localtime\:%X}':x=(w-tw)/2:y=h-90:fontsize=72:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=14,drawtext=text='LIVE TEST \\= frame %{n}':x=(w-tw)/2:y=h-180:fontsize=34:fontcolor=0x99aadd:box=1:boxcolor=black@0.4:boxborderw=8"
  AMAP="1:a"
fi

echo "== Volt test stream =="
echo "   out=$OUT  name='$NAME'  dvr=${DVR_SEC}s (list=$LIST_SIZE)  seg=${SEG}s  dash=$DASH  source=${INPUT_URL:-${SOURCE:-testcard}}"

# ---- watermark burn-in --------------------------------------------------------
# Bake the logo into the picture BEFORE the rendition split, so every rendition
# carries it in-pixel (a true burn-in, not a player overlay). This mirrors the
# production transcode encoder (_overlay_vf in encoder.py): scale the logo to a
# percent of the frame height, apply opacity, and place it at the chosen corner
# with pixel offsets. PRE is the filter chain that feeds split=3; when there is
# no watermark it is just the base VF, so behaviour is unchanged.
WM_FILE=""
if [ -n "$WATERMARK" ]; then
  case "$WATERMARK" in
    http://*|https://*)
      WM_FILE="$OUT/.watermark.img"
      if command -v curl >/dev/null; then curl -fsSL "$WATERMARK" -o "$WM_FILE" || WM_FILE="";
      elif command -v wget >/dev/null; then wget -qO "$WM_FILE" "$WATERMARK" || WM_FILE="";
      else WM_FILE=""; fi
      [ -n "$WM_FILE" ] && [ -s "$WM_FILE" ] && echo "   watermark: fetched $WATERMARK" || { echo "   watermark: fetch failed, overlay skipped"; WM_FILE=""; }
      ;;
    *)
      if [ -f "$WATERMARK" ]; then WM_FILE="$WATERMARK"; else echo "   watermark: file not found ($WATERMARK), overlay skipped"; fi
      ;;
  esac
fi

if [ -n "$WM_FILE" ]; then
  WMH=$(( 720 * WM_SCALE / 100 )); [ "$WMH" -lt 1 ] && WMH=1
  OP=$(awk "BEGIN{printf \"%.3f\", ${WM_OPACITY}/100}")
  case "$WM_POS" in
    tl) XY="${WM_X}:${WM_Y}";;
    tr) XY="main_w-overlay_w-${WM_X}:${WM_Y}";;
    bl) XY="${WM_X}:main_h-overlay_h-${WM_Y}";;
    tc) XY="(main_w-overlay_w)/2:${WM_Y}";;
    bc) XY="(main_w-overlay_w)/2:main_h-overlay_h-${WM_Y}";;
    br|*) XY="main_w-overlay_w-${WM_X}:main_h-overlay_h-${WM_Y}";;
  esac
  # single-quote the filename so spaces are safe; escape any embedded quote/backslash.
  WM_ESC=$(printf '%s' "$WM_FILE" | sed -e 's/\\/\\\\/g' -e "s/'/\\\\'/g")
  WM_LOAD="movie='${WM_ESC}',format=rgba,colorchannelmixer=aa=${OP},scale=-1:${WMH}[wm];"
  PRE="${WM_LOAD}[0:v]${VF}[wbase];[wbase][wm]overlay=${XY}"
  echo "   watermark: burn-in pos=$WM_POS scale=${WM_SCALE}% opacity=${WM_OPACITY}% offset=${WM_X},${WM_Y}"
else
  PRE="[0:v]${VF}"
fi

# three-rendition ladder via -filter_complex split+scale; map to var_stream_map
ffmpeg -hide_banner -loglevel warning -y \
  "${IN[@]}" \
  -filter_complex "${PRE},split=3[v1][v2][v3];\
[v1]scale=1280:720[v1o];[v2]scale=854:480[v2o];[v3]scale=640:360[v3o]" \
  -map "[v1o]" -map "[v2o]" -map "[v3o]" -map "$AMAP" -map "$AMAP" -map "$AMAP" \
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
    -filter_complex "${PRE},split=3[d1][d2][d3];[d1]scale=1280:720[d1o];[d2]scale=854:480[d2o];[d3]scale=640:360[d3o]" \
    -map "[d1o]" -map "[d2o]" -map "[d3o]" -map "$AMAP" \
    -c:v libx264 -preset ultrafast -tune zerolatency -g $((SEG*25)) -keyint_min $((SEG*25)) -sc_threshold 0 \
    -b:v:0 5000k -b:v:1 2800k -b:v:2 1200k -c:a aac -b:a 128k -ac 2 \
    -f dash -seg_duration "$SEG" -window_size "${LIST_SIZE:-12}" -streaming 1 -ldash 1 \
    -use_timeline 1 -use_template 1 \
    "$OUT/stream.mpd" &
  echo "   dash pid $!"
fi

wait $FFPID
