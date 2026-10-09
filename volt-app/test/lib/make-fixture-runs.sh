#!/usr/bin/env bash
# ============================================================================
#  FIXTURE MEDIA GENERATOR — real segments, made fresh, on demand.
#
#  WHY THIS EXISTS. Two suites (recordings, retrim) test against genuine
#  packaged media rather than rows pretending to be media, which is the right
#  call: a clip that resolves against segments on disk cannot be faked into
#  passing. But the media was generated once, by hand, and left there. That made
#  both suites unreproducible on a clean machine, and worse, it made them ROT:
#  the control plane they start runs the orchestrator over the same origin, and
#  a recording that ages past its retention is swept exactly as designed. The
#  media disappeared, the manifests stayed, and every downstream assertion
#  failed for a reason that had nothing to do with the code under test.
#
#  A suite whose fixture the system under test is entitled to delete has to be
#  able to rebuild it. So this makes it, in seconds, from nothing.
#
#  WHAT IT MAKES. The layout localRecordingIndex actually scans:
#
#      <out>/runs/<runId>/<rendition>/init.mp4
#      <out>/runs/<runId>/<rendition>/seg_<n>.m4s
#      <out>/runs/<runId>/master.m3u8
#
#  TWO runs by default, with a real gap between them, because that is what the
#  suites are about: spans per run, a discontinuity across them, and a range
#  with a hole in it that must be refused unless the caller accepts the gap.
#
#  Usage: make-fixture-runs.sh <out-dir> [runs] [seconds-per-run]
# ============================================================================
set -euo pipefail

OUT="${1:?usage: make-fixture-runs.sh <out-dir> [runs] [seconds]}"
RUNS="${2:-2}"
SECS="${3:-20}"
SEG=4

command -v ffmpeg >/dev/null 2>&1 || { echo "make-fixture-runs: ffmpeg not installed" >&2; exit 1; }

# THE DURATION MUST BE A WHOLE NUMBER OF SEGMENTS.
#
# A trailing part-segment is shorter than the rest, and the even-cadence
# restamping below would then place it with a hole in front of it, because
# placement is (mtime - the segment's OWN measured duration). The media is fine;
# the fixture would just be describing a run that never existed. Round up rather
# than silently producing one.
if [ $(( SECS % SEG )) -ne 0 ]; then
  SECS=$(( (SECS / SEG + 1) * SEG ))
  echo "make-fixture-runs: rounded duration up to ${SECS}s (a whole number of ${SEG}s segments)"
fi

mkdir -p "$OUT/runs"

for i in $(seq 1 "$RUNS"); do
  # Run ids must sort in start order: the index orders runs by name.
  RUN_ID=$(date -u +%Y%m%dT%H%M%SZ)
  RUN="$OUT/runs/$RUN_ID"
  # A same-second collision would silently make two runs one.
  while [ -d "$RUN" ]; do sleep 1; RUN_ID=$(date -u +%Y%m%dT%H%M%SZ); RUN="$OUT/runs/$RUN_ID"; done
  mkdir -p "$RUN"

  # A moving picture with the wall clock burned in, plus a tone. Real frames,
  # real timestamps: PDT on every segment is one of the things asserted.
  # -re, i.e. REALTIME. This is not politeness, it is correctness: the index
  # places a segment by its WRITE TIME minus its duration, because that is how a
  # live run genuinely lands on the wall clock. Encoding 24 seconds of video in
  # one second writes every segment inside that second, and the whole run then
  # measures about a second long however much media it contains. The suites that
  # cut ranges out of it then have nothing to cut.
  ffmpeg -hide_banner -loglevel error -y -re \
    -f lavfi -i "testsrc2=size=640x360:rate=25:duration=$SECS" \
    -re -f lavfi -i "sine=frequency=440:duration=$SECS" \
    -map 0:v -map 1:a \
    -c:v libx264 -preset ultrafast -g 50 -keyint_min 50 -sc_threshold 0 \
    -c:a aac -b:a 128k -ac 2 \
    -f hls -hls_time "$SEG" -hls_list_size 0 \
    -hls_flags program_date_time+independent_segments \
    -hls_segment_type fmp4 -hls_fmp4_init_filename "init.mp4" \
    -master_pl_name "master.m3u8" \
    -var_stream_map "v:0,agroup:aud,name:360p a:0,agroup:aud,name:audio" \
    -hls_segment_filename "$RUN/%v/seg_%d.m4s" \
    "$RUN/%v/index.m3u8" 2>&1 | grep -v '^$' || true

  # ffmpeg appends the variant index when %v is in play, giving init_0.mp4 and
  # init_1.mp4. localRecordingIndex uses the PRESENCE of exactly `init.mp4` to
  # decide what is a rendition directory, so a fixture with init_0.mp4 has no
  # renditions at all as far as the index is concerned, and every span comes
  # back empty. Rename, and fix the playlists that reference them.
  for d in "$RUN"/*/; do
    for f in "$d"init_*.mp4; do
      [ -e "$f" ] || continue
      mv "$f" "${d}init.mp4"
      sed -i "s|$(basename "$f")|init.mp4|g" "$d"index.m3u8 2>/dev/null || true
    done
  done

  # EVEN OUT THE WRITE TIMES.
  #
  # localRecordingIndex places a segment at (its mtime - its duration), which is
  # how a live run genuinely lands on the wall clock. A real encoder writes at a
  # steady cadence, so consecutive segments come out contiguous. ffmpeg reading
  # a lavfi source under -re paces its INPUT, not its muxing, so the write times
  # wobble by more than the 50ms that consumers treat as contiguous, and a clip
  # resolved over this media would report holes that are not in it.
  #
  # Restamping each segment at an exact cadence, from one anchor shared by every
  # rendition, is what makes the fixture behave like the encoder it stands in
  # for. It shapes the fixture, not the code under test.
  python3 - "$RUN" "$SEG" <<'PYEOF'
import os, re, sys, time
run, seg = sys.argv[1], float(sys.argv[2])
anchor = time.time() - 2.0
for d in sorted(os.listdir(run)):
    p = os.path.join(run, d)
    if not os.path.isdir(p):
        continue
    segs = sorted(
        (f for f in os.listdir(p) if re.fullmatch(r'seg_\d+\.m4s', f)),
        key=lambda f: int(re.search(r'\d+', f).group()))
    n = len(segs)
    if not n:
        continue
    # The LAST segment lands on the anchor; earlier ones step back by one
    # segment each, so every rendition of this run ends together.
    for i, f in enumerate(segs):
        t = anchor - (n - 1 - i) * seg
        os.utime(os.path.join(p, f), (t, t))
PYEOF

  if ! find "$RUN" -name 'seg_*.m4s' | head -1 | grep -q .; then
    echo "make-fixture-runs: ffmpeg produced no segments in $RUN" >&2
    exit 1
  fi
  echo "make-fixture-runs: $RUN_ID ($(find "$RUN" -name 'seg_*.m4s' | wc -l) segments)"

  # A REAL gap between runs. Without it the two runs abut and the "range with a
  # hole in it" case, which is the interesting one, cannot be constructed.
  [ "$i" -lt "$RUNS" ] && sleep 2
done

# The live pointer, so /origin/<id>/live/* resolves the way it does in service.
basename "$(find "$OUT/runs" -maxdepth 1 -mindepth 1 -type d | sort | tail -1)" > "$OUT/current_run.txt"
