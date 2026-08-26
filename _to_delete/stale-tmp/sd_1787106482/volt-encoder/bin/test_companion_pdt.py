#!/usr/bin/env python3
"""Unit tests for the caption-companion PDT stamping (offline; no network).

Guards the fix for the caption-disappearance bug: a single PDT anchor at the window's
first segment, extrapolated by nominal EXTINF, accumulated ~0.3s error per segment when
the real wall spacing was ~3.7s (measured live), pushing every subtitle cue ~22s away
from the frames at the live edge of a full 300s window. Per-segment stamps from real
mtimes cannot accumulate anything.

Run: python3 test_companion_pdt.py
"""
import os
import re
import tempfile
import time
import encoder

p = f = 0
def ok(c, m):
    global p, f
    if c: p += 1; print("PASS", m)
    else: f += 1; print("FAIL", m)

def parse_pdts(text):
    out = []
    for l in text.splitlines():
        if l.startswith("#EXT-X-PROGRAM-DATE-TIME:"):
            out.append(l.split(":", 1)[1])
    return out

def iso_to_epoch(s):
    import datetime
    return datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%fZ").replace(
        tzinfo=datetime.timezone.utc).timestamp()

# ---- video companion: per-segment PDT from real mtimes, no accumulation ----
tmp = tempfile.mkdtemp()
os.makedirs(os.path.join(tmp, "480p"))
now = time.time()
N, EXTINF, REAL_SPACING = 20, 4.0, 3.7   # nominal 4.0s but written every 3.7s (as measured)
lines = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-TARGETDURATION:5",
         "#EXT-X-MEDIA-SEQUENCE:0", '#EXT-X-MAP:URI="480p/init.mp4"']
for i in range(N):
    seg = os.path.join(tmp, "480p", f"seg_{i}.m4s")
    open(seg, "w").write("x")
    mt = now - (N - 1 - i) * REAL_SPACING
    os.utime(seg, (mt, mt))
    lines += [f"#EXTINF:{EXTINF:.3f},", f"480p/seg_{i}.m4s"]
text = encoder._pdt_companion_playlist("\n".join(lines) + "\n", now, tmp)

pdts = parse_pdts(text)
ok(len(pdts) == N, f"PDT stamped on EVERY segment ({len(pdts)}/{N})")

# the LIVE EDGE stamp must match the newest segment's real write time, not an
# extrapolation from the window start
edge_start = iso_to_epoch(pdts[-1])
true_edge_start = now - EXTINF     # newest seg mtime(=now) - its duration
ok(abs(edge_start - true_edge_start) < 0.01,
   f"live-edge PDT exact from mtime (err {abs(edge_start - true_edge_start):.3f}s)")

# and show the OLD single-anchor scheme would have been ~ (EXTINF-REAL)*N wrong here
old_scheme_edge = (iso_to_epoch(pdts[0]) + EXTINF) + (N - 1) * EXTINF - EXTINF
drift_old = abs(old_scheme_edge - true_edge_start)
ok(drift_old > 4.0, f"regression guard: single-anchor extrapolation would drift {drift_old:.1f}s here")

# a segment file that cannot be stat'd continues from the previous stamp
lines2 = list(lines[:5])
lines2 += [f"#EXTINF:{EXTINF:.3f},", "480p/seg_0.m4s",
           f"#EXTINF:{EXTINF:.3f},", "480p/MISSING.m4s",
           f"#EXTINF:{EXTINF:.3f},", "480p/seg_2.m4s"]
text2 = encoder._pdt_companion_playlist("\n".join(lines2) + "\n", now, tmp)
pd2 = parse_pdts(text2)
ok(len(pd2) == 3, "missing segment still stamped (continuity)")
gap = iso_to_epoch(pd2[1]) - (iso_to_epoch(pd2[0]) + EXTINF)
ok(abs(gap) < 0.01, "missing segment PDT continues from previous stamp")

# ---- subtitle playlist: per-chunk PDT from the measured capture map ----
chunk, t0 = 8.0, 1000.0
pdt_map = {5: 1041.7, 6: 1049.6}   # measured (drifted) capture starts
sub = encoder._live_sub_playlist(range(5, 8), chunk, 5, t0, pdt_map=pdt_map)
spd = parse_pdts(sub)
ok(len(spd) == 3, "subtitle playlist stamps every chunk")
ok(abs(iso_to_epoch(spd[0]) - 1041.7) < 0.01, "chunk 5 uses MEASURED capture time")
ok(abs(iso_to_epoch(spd[1]) - 1049.6) < 0.01, "chunk 6 uses MEASURED capture time")
ok(abs(iso_to_epoch(spd[2]) - (t0 + 7 * chunk)) < 0.01, "unmeasured chunk falls back to t0 + i*chunk")
ok("#EXT-X-MEDIA-SEQUENCE:5" in sub, "media sequence preserved")
seq = [l for l in sub.splitlines() if l and not l.startswith('#')]
ok(seq == ["sub_5.vtt", "sub_6.vtt", "sub_7.vtt"], "segment URIs in order")

# empty placeholder still valid (players need the track to exist from connect)
empty = encoder._live_sub_playlist([], chunk, 0, t0)
ok("#EXTM3U" in empty and "sub_" not in empty, "empty placeholder playlist valid")

# ---- video PTS mapping (the cue timestamp map, the caption display fix) ----
def _mk_init(path, timescale):
    with open(path, "wb") as fh:
        fh.write(b"\x00\x00\x00\x20mdhd" + bytes([0, 0, 0, 0]) + b"\x00" * 8
                 + timescale.to_bytes(4, "big") + b"\x00" * 4)

def _mk_seg(path, base_time, timescale_units=True):
    with open(path, "wb") as fh:
        fh.write(b"\x00\x00\x00\x14tfdt" + bytes([1, 0, 0, 0]) + int(base_time).to_bytes(8, "big"))

tmp2 = tempfile.mkdtemp()
os.makedirs(os.path.join(tmp2, "480p"))
_mk_init(os.path.join(tmp2, "480p", "init.mp4"), 90000)
ok(encoder._mp4_timescale(os.path.join(tmp2, "480p", "init.mp4")) == 90000, "mdhd timescale parsed")

# newest segment: content starts at PTS 400s, written (mtime) at wall 1000.0, 4s segment
segp = os.path.join(tmp2, "480p", "seg_100.m4s")
_mk_seg(segp, 400 * 90000)
os.utime(segp, (1000.0, 1000.0))
ok(encoder._mp4_tfdt_time(segp) == 400 * 90000, "tfdt base time parsed")

# pts(wall): segment END is PTS 404 at wall 1000 -> wall 1010 = PTS 414
pts = encoder._video_pts_of_wall(tmp2, 1010.0, 4.0)
ok(pts is not None and abs(pts - 414.0) < 0.001, f"wall->PTS mapping exact (got {pts})")

# the newest segment is the reference: add a newer one and the mapping follows it
seg2 = os.path.join(tmp2, "480p", "seg_101.m4s")
_mk_seg(seg2, 404 * 90000)
os.utime(seg2, (1003.9, 1003.9))   # written 3.9s later (pacing drift), covers 404..408
pts2 = encoder._video_pts_of_wall(tmp2, 1010.0, 4.0)
ok(pts2 is not None and abs(pts2 - (408 + (1010.0 - 1003.9))) < 0.001,
   f"mapping re-samples from the NEWEST segment (got {pts2})")

# the timestamp map lands in the VTT and is the REAL 90kHz value
class FC:
    def __init__(s, a, b, t): s.start, s.end, s.text, s.lang = a, b, t, "en"
vtt = os.path.join(tmp2, "test.vtt")
encoder._write_sub_segment(vtt, [FC(8.5, 11.0, "hello")], 8.0, 16.0, mpegts=414 * 90000)
body = open(vtt).read()
ok(f"X-TIMESTAMP-MAP=MPEGTS:{414*90000},LOCAL:00:00:00.000" in body,
   "VTT carries the true 90kHz map (constant-0 map was the display killer)")
ok("00:00:00.500 --> 00:00:03.000" in body, "cues stay segment-relative under the map")
encoder._write_sub_segment(vtt, [FC(8.5, 11.0, "hello")], 8.0, 16.0, mpegts=None)
ok("X-TIMESTAMP-MAP" not in open(vtt).read(), "map omitted when PTS unknown")

# ---- anti-stacking rules ----
# a cue belongs to EXACTLY the segment containing its START: a spanning cue must not
# be duplicated into the next segment (near-duplicate copies stacked on screen)
encoder._write_sub_segment(vtt, [FC(6.0, 10.0, "spans the boundary")], 8.0, 16.0, mpegts=None)
ok("spans the boundary" not in open(vtt).read(),
   "cue starting before the segment is NOT duplicated into it")
encoder._write_sub_segment(vtt, [FC(6.0, 10.0, "spans the boundary")], 0.0, 8.0, mpegts=None)
ok("spans the boundary" in open(vtt).read(), "the cue lives in its START segment")
# duration clamps: blink-length cues become readable, run-ons are cut
encoder._write_sub_segment(vtt, [FC(8.0, 8.2, "blink")], 8.0, 16.0, mpegts=None)
ok("00:00:00.000 --> 00:00:01.000" in open(vtt).read(), "short cue clamped up to 1s")
encoder._write_sub_segment(vtt, [FC(8.0, 30.0, "run-on")], 8.0, 16.0, mpegts=None)
ok("00:00:00.000 --> 00:00:07.000" in open(vtt).read(), "long cue clamped down to 7s")

print(f"\n{p} passed, {f} failed")
raise SystemExit(1 if f else 0)
