#!/usr/bin/env bash
# Fast core-encode check WITHOUT Docker — proves ingest → CMAF → HLS+DASH works
# using the encoder's own build_shaka() command builder. Needs only: ffmpeg,
# Shaka Packager (`packager` on PATH), python3. Runs in ~20s, writes to a temp
# dir, and asserts the manifests + segments are produced and decodable.
#
# This is the same pipeline the Docker harness runs, minus MinIO/SRT/containers —
# handy for a tight inner loop while working on the encoder.
set -euo pipefail
cd "$(dirname "$0")"
ENC=../volt-encoder/bin
OUT=$(mktemp -d)/out; mkdir -p "$OUT"
command -v packager >/dev/null || { echo "Shaka 'packager' not on PATH — see volt-encoder/Dockerfile for the release URL"; exit 2; }

WORK_DIR="$(dirname "$OUT")" python3 - "$ENC" "$OUT" <<'PY'
import os,sys,time,subprocess
enc,out=sys.argv[1],sys.argv[2]
os.environ['WORK_DIR']=os.path.dirname(out)
sys.path.insert(0,enc)
import encoder as e
cfg={"channel_id":"local","workflow":"package_only","segment_seconds":2,"fps":25,
     "s3":{"bucket":"x"},
     "inputs":[{"rendition_label":"480p","has_audio":True},{"rendition_label":"240p"}]}
sp=subprocess.Popen(e.build_shaka(cfg,None))
time.sleep(1.5)
b0,b1=e.udp_out(0),e.udp_out(1)
ff=["ffmpeg","-hide_banner","-loglevel","error","-re",
    "-f","lavfi","-i","testsrc2=size=854x480:rate=25",
    "-f","lavfi","-i","sine=frequency=1000:sample_rate=48000",
    "-map","0:v","-map","1:a","-c:v","libx264","-preset","veryfast","-b:v","1200k",
      "-g","50","-keyint_min","50","-sc_threshold","0","-c:a","aac","-b:a","128k","-f","mpegts",b0,
    "-map","0:v","-c:v","libx264","-preset","veryfast","-vf","scale=426:240","-b:v","400k",
      "-g","50","-keyint_min","50","-sc_threshold","0","-f","mpegts",b1]
fp=subprocess.Popen(ff)
time.sleep(16)
for p in (fp,sp):
    p.terminate()
    try:p.wait(timeout=5)
    except:p.kill()
PY

fail=0
[ -f "$OUT/master.m3u8" ] && echo "  ✓ HLS master.m3u8" || { echo "  ✗ no HLS master"; fail=1; }
[ -f "$OUT/manifest.mpd" ] && echo "  ✓ DASH manifest.mpd" || { echo "  ✗ no DASH mpd"; fail=1; }
N=$(find "$OUT" -name 'seg_*.m4s' | wc -l | tr -d '[:space:]')
[ "$N" -gt 0 ] && echo "  ✓ $N CMAF segments" || { echo "  ✗ no segments"; fail=1; }
if [ -f "$OUT/480p/init.mp4" ] && [ -f "$OUT/480p/seg_1.m4s" ]; then
  cat "$OUT/480p/init.mp4" "$OUT/480p/seg_1.m4s" > "$OUT/_probe.mp4"
  ffprobe -hide_banner -loglevel error -show_entries stream=codec_name,width,height -of csv=p=0 "$OUT/_probe.mp4" | grep -q 'h264,854,480' \
    && echo "  ✓ 480p segment decodes (h264 854x480)" || { echo "  ✗ 480p segment not decodable"; fail=1; }
fi
echo; [ "$fail" -eq 0 ] && echo "CORE ENCODE: PASS ($OUT)" || echo "CORE ENCODE: FAIL"
exit $fail
