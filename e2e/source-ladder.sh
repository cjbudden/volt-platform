#!/usr/bin/env bash
# Test "client": emit a 2-rung ABR ladder over SRT (listener mode), keyframe- and
# timestamp-aligned exactly as the Ingest Requirements demand — so the packaging
# encoder can line the renditions up. One FFmpeg, two SRT listener outputs.
#   9000: 480p + audio    9001: 240p
#
# BASE_PORT moves both (a second ladder for a backup on 9010/9011:
# BASE_PORT=9010), PATTERN picks the picture (testsrc2, smptebars, ...), so a
# soak test can run primary and backup side by side and tell them apart
# (volt-encoder/dev/soak_switch.sh).
set -euo pipefail

FPS=25
SEG=2
GOP=$((FPS * SEG))   # closed GOP == segment length so boundaries align
BASE_PORT=${BASE_PORT:-9000}
PATTERN=${PATTERN:-testsrc2}

exec ffmpeg -hide_banner -loglevel warning \
  -re -f lavfi -i "${PATTERN}=size=854x480:rate=${FPS}" \
  -f lavfi -i "sine=frequency=1000:sample_rate=48000" \
  -map 0:v -map 1:a \
    -c:v libx264 -preset veryfast -b:v 1200k \
    -g "$GOP" -keyint_min "$GOP" -sc_threshold 0 \
    -force_key_frames "expr:gte(t,n_forced*${SEG})" \
    -c:a aac -b:a 128k -ac 2 \
    -f mpegts "srt://0.0.0.0:${BASE_PORT}?mode=listener" \
  -map 0:v \
    -vf "scale=426:240" \
    -c:v libx264 -preset veryfast -b:v 400k \
    -g "$GOP" -keyint_min "$GOP" -sc_threshold 0 \
    -force_key_frames "expr:gte(t,n_forced*${SEG})" \
    -f mpegts "srt://0.0.0.0:$((BASE_PORT + 1))?mode=listener"
