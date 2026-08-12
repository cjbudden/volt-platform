#!/usr/bin/env bash
# Synthetic live contribution feed. Emits a 3-rung ABR ladder (720p+audio/480p/360p),
# keyframe/timestamp aligned. Transport: hls (local files, any ffmpeg) or srt (listener).
#   synth_source.sh <dir> hls   |   synth_source.sh <dir> srt
set -euo pipefail
DIR="${1:?usage: synth_source.sh <dir> [hls|srt]}"; T="${2:-hls}"
FPS="${FPS:-25}"; SEG="${SEG:-2}"; GOP=$((FPS*SEG)); mkdir -p "$DIR"
common_v="-hide_banner -loglevel error -re -f lavfi -i testsrc2=size=1280x720:rate=${FPS} -f lavfi -i sine=frequency=800:sample_rate=48000 -filter_complex [0:v]split=3[v0][v1][v2];[v1]scale=854:480[v1s];[v2]scale=640:360[v2s]"
if [ "$T" = "srt" ]; then
  exec ffmpeg $common_v \
    -map "[v0]" -map 1:a -c:v libx264 -preset veryfast -b:v 2500k -g "$GOP" -keyint_min "$GOP" -sc_threshold 0 -force_key_frames "expr:gte(t,n_forced*${SEG})" -c:a aac -b:a 128k -ac 2 -f mpegts "srt://0.0.0.0:9000?mode=listener" \
    -map "[v1s]" -c:v libx264 -preset veryfast -b:v 1200k -g "$GOP" -keyint_min "$GOP" -sc_threshold 0 -force_key_frames "expr:gte(t,n_forced*${SEG})" -f mpegts "srt://0.0.0.0:9001?mode=listener" \
    -map "[v2s]" -c:v libx264 -preset veryfast -b:v 800k -g "$GOP" -keyint_min "$GOP" -sc_threshold 0 -force_key_frames "expr:gte(t,n_forced*${SEG})" -f mpegts "srt://0.0.0.0:9002?mode=listener"
else
  H="-f hls -hls_time $SEG -hls_list_size 6 -hls_flags delete_segments+append_list+omit_endlist -hls_segment_type mpegts"
  exec ffmpeg $common_v \
    -map "[v0]" -map 1:a -c:v libx264 -preset veryfast -b:v 2500k -g "$GOP" -keyint_min "$GOP" -sc_threshold 0 -force_key_frames "expr:gte(t,n_forced*${SEG})" -c:a aac -b:a 128k -ac 2 $H -hls_segment_filename "$DIR/720p_%d.ts" "$DIR/720p.m3u8" \
    -map "[v1s]" -c:v libx264 -preset veryfast -b:v 1200k -g "$GOP" -keyint_min "$GOP" -sc_threshold 0 -force_key_frames "expr:gte(t,n_forced*${SEG})" $H -hls_segment_filename "$DIR/480p_%d.ts" "$DIR/480p.m3u8" \
    -map "[v2s]" -c:v libx264 -preset veryfast -b:v 800k -g "$GOP" -keyint_min "$GOP" -sc_threshold 0 -force_key_frames "expr:gte(t,n_forced*${SEG})" $H -hls_segment_filename "$DIR/360p_%d.ts" "$DIR/360p.m3u8"
fi
