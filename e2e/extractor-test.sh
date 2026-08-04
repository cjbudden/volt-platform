#!/usr/bin/env bash
# Proves the VOD extractor produces REAL, decodable clip output — no Docker/cloud.
# 1) ffmpeg makes a 20s CMAF-segmented source (2 renditions) via Shaka packager,
# 2) the extractor cuts a 6s..14s clip (manifest + progressive MP4),
# 3) asserts the clip manifest + segments exist and the MP4 decodes to h264.
# Needs: ffmpeg, ffprobe, Shaka `packager`, node/tsx. ~25s.
set -euo pipefail
cd "$(dirname "$0")"
command -v packager >/dev/null || { echo "Shaka packager not on PATH"; exit 2; }
ROOT=$(mktemp -d)
REC="$ROOT/recA"; OUT="$ROOT/clip"; mkdir -p "$REC" "$OUT"
APP=../volt-app
pass=0; fail=0
ok(){ echo "  ✓ $1"; pass=$((pass+1)); }
no(){ echo "  ✗ $1"; fail=$((fail+1)); }

echo "== 1. produce a 20s CMAF recording (480p+240p, 2s segments) =="
# feed two pre-encoded TS renditions into Shaka over stdin pipes via files
ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=854x480:rate=25 -f lavfi -i sine=frequency=1000:sample_rate=48000 \
  -t 20 -map 0:v -map 1:a -c:v libx264 -preset veryfast -b:v 1200k -g 50 -keyint_min 50 -sc_threshold 0 -c:a aac -b:a 128k -f mpegts "$ROOT/480.ts" -y 2>/dev/null
ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=426x240:rate=25 \
  -t 20 -map 0:v -c:v libx264 -preset veryfast -b:v 400k -g 50 -keyint_min 50 -sc_threshold 0 -f mpegts "$ROOT/240.ts" -y 2>/dev/null

packager \
  "in=$ROOT/480.ts,stream=video,init_segment=$REC/480p/init.mp4,segment_template=$REC/480p/seg_\$Number\$.m4s" \
  "in=$ROOT/480.ts,stream=audio,init_segment=$REC/480p/audio_init.mp4,segment_template=$REC/480p/aseg_\$Number\$.m4s" \
  "in=$ROOT/240.ts,stream=video,init_segment=$REC/240p/init.mp4,segment_template=$REC/240p/seg_\$Number\$.m4s" \
  --segment_duration 2 --fragment_duration 2 \
  --hls_master_playlist_output "$REC/master.m3u8" >/dev/null 2>&1 || true

N480=$(find "$REC/480p" -name 'seg_*.m4s' | wc -l | tr -d ' ')
[ "$N480" -ge 8 ] && ok "recording has 480p CMAF segments ($N480)" || no "expected ~10 480p segments, got $N480"

echo "== 2. extract a 6s..14s clip (manifest + progressive) =="
cat > "$ROOT/job.json" <<JSON
{
  "segMs": 2000,
  "outputKind": "both",
  "outDir": "$OUT",
  "renditions": [
    {"id":"480p","bandwidthBps":1330000,"width":854,"height":480,"codecs":"avc1.640028"},
    {"id":"240p","bandwidthBps":430000,"width":426,"height":240,"codecs":"avc1.640015"}
  ],
  "clipSpec": [{"recordingDir":"$REC","startMs":6000,"endMs":14000}]
}
JSON
RES=$(cd "$APP" && npx tsx src/tools/extract-clip.ts "$ROOT/job.json")
echo "     extractor: $RES"

echo "== 3. assertions =="
[ -f "$OUT/master.m3u8" ] && ok "clip master.m3u8 written" || no "no clip master"
[ -f "$OUT/480p/index.m3u8" ] && ok "clip 480p media playlist written" || no "no 480p media playlist"
NSEG=$(find "$OUT/480p" -name 's_*.m4s' | wc -l | tr -d ' ')
# 6s..14s over 2s segments => ~4 segments (seq 4..7)
[ "$NSEG" -ge 4 ] && ok "clip has the in-range segments ($NSEG)" || no "clip segment count wrong ($NSEG)"
grep -q 'EXT-X-PLAYLIST-TYPE:VOD' "$OUT/480p/index.m3u8" && ok "clip playlist is VOD" || no "clip playlist not VOD"
grep -q 'EXT-X-MAP:URI=' "$OUT/480p/index.m3u8" && ok "clip playlist has init MAP" || no "no init MAP"

[ -f "$OUT/progressive.mp4" ] && ok "progressive MP4 produced" || no "no progressive MP4"
if [ -f "$OUT/progressive.mp4" ]; then
  INFO=$(ffprobe -hide_banner -loglevel error -show_entries stream=codec_name,width,height -of csv=p=0 "$OUT/progressive.mp4" | head -1)
  echo "     mp4 stream: $INFO"
  echo "$INFO" | grep -q 'h264,854,480' && ok "progressive MP4 decodes (h264 854x480)" || no "MP4 not decodable as expected ($INFO)"
  DUR=$(ffprobe -hide_banner -loglevel error -show_entries format=duration -of csv=p=0 "$OUT/progressive.mp4")
  echo "     mp4 duration: ${DUR}s (expect ~8s)"
fi

rm -rf "$ROOT"
echo
echo "== RESULT: $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
