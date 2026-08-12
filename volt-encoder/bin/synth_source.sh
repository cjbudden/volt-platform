#!/usr/bin/env bash
# Synthetic live contribution feed: one FFmpeg emitting a 3-rung ABR ladder over
# SRT (listener mode), keyframe- and timestamp-aligned so the packaging encoder
# can line the renditions up. Stands in for a real OBS / hardware encoder / SRT
# contribution feed, so the local pipeline never depends on an external stream.
#   9000: 720p + audio    9001: 480p    9002: 360p
set -euo pipefail
FPS="${FPS:-25}"; SEG="${SEG:-2}"; GOP=$((FPS*SEG))
exec ffmpeg -hide_banner -loglevel error \
  -re -f lavfi -i "testsrc2=size=1280x720:rate=${FPS}" \
  -f lavfi -i "sine=frequency=800:sample_rate=48000" \
  -filter_complex "[0:v]split=3[v0][v1][v2];[v1]scale=854:480[v1s];[v2]scale=640:360[v2s]" \
  -map "[v0]" -map 1:a -c:v libx264 -preset veryfast -b:v 2500k \
    -g "$GOP" -keyint_min "$GOP" -sc_threshold 0 -force_key_frames "expr:gte(t,n_forced*${SEG})" \
    -c:a aac -b:a 128k -ac 2 -f mpegts "srt://0.0.0.0:9000?mode=listener" \
  -map "[v1s]" -c:v libx264 -preset veryfast -b:v 1200k \
    -g "$GOP" -keyint_min "$GOP" -sc_threshold 0 -force_key_frames "expr:gte(t,n_forced*${SEG})" \
    -f mpegts "srt://0.0.0.0:9001?mode=listener" \
  -map "[v2s]" -c:v libx264 -preset veryfast -b:v 800k \
    -g "$GOP" -keyint_min "$GOP" -sc_threshold 0 -force_key_frames "expr:gte(t,n_forced*${SEG})" \
    -f mpegts "srt://0.0.0.0:9002?mode=listener"
