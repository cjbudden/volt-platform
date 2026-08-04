#!/usr/bin/env bash
# Generate the test asset: 20s, 25fps, 720p, GOP 50 (2s), with the FRAME NUMBER and
# timecode burned in so frame-accuracy is verifiable. Then segment to standalone
# MPEG-TS (each segment independently decodable) at 2s. Produces source.mp4 +
# index.m3u8 + index0..9.ts.
set -euo pipefail
cd "$(dirname "$0")"
FONT="${FONT:-/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf}"

ffmpeg -y -f lavfi -i "color=c=0x101820:s=1280x720:r=25:d=20" \
  -vf "drawtext=fontfile=$FONT:text='FRAME %{eif\:n\:d}':x=(w-tw)/2:y=280:fontsize=90:fontcolor=white,drawtext=fontfile=$FONT:text='%{pts\:hms}':x=(w-tw)/2:y=400:fontsize=48:fontcolor=0x8ab4ff,drawbox=x=0:y=0:w=iw:h=ih:t=6:color=0x2563eb" \
  -c:v libx264 -profile:v high -pix_fmt yuv420p -g 50 -keyint_min 50 -sc_threshold 0 \
  -x264-params "keyint=50:min-keyint=50:scenecut=0" -b:v 3000k source.mp4

ffmpeg -y -i source.mp4 -c copy -f hls -hls_time 2 -hls_segment_type mpegts \
  -hls_playlist_type vod -hls_list_size 0 index.m3u8

echo "generated: $(ls index*.ts | wc -l) segments + source.mp4 + index.m3u8"
