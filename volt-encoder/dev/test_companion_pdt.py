#!/usr/bin/env python3
"""Unit tests for caption/video timeline alignment (offline; no network, no models).

WHAT THIS GUARDS. Subtitles are only ever as well aligned as the clock used to place
them, so the encoder keeps exactly ONE clock: the media timeline of the stream it
delivers, read from each CMAF segment's own tfdt. Every number a player uses to put a
cue on screen (the video EXT-X-PROGRAM-DATE-TIME, the subtitle EXT-X-PROGRAM-DATE-TIME,
and the WebVTT X-TIMESTAMP-MAP) is derived from that one clock, so they agree by
construction.

THE REGRESSIONS THESE LOCK OUT, both measured on real runs:
  * PDT stamped from each segment's FILE MTIME. That stamps the encoder's write
    schedule, not the media: nominally 4.000s segments came out 8.8s and 11.2s apart on
    a box that was not keeping up, and players align a subtitle rendition to video by
    PDT, so cues landed wherever the encoder happened to stutter.
  * caption audio pulled by a SECOND, independent ffmpeg join to the live source and
    reconciled afterwards by comparing file mtimes. Median sync error 15.7s, and a
    different error every run.
  * ingesting an HLS MASTER playlist, where ffmpeg's first video stream is the LOWEST
    rung: the whole ladder was upscaled from 192x108 while every variant was downloaded.

Run: python3 test_companion_pdt.py
"""
import os
import tempfile
import time

import encoder

p = f = 0


def ok(c, m):
    global p, f
    if c:
        p += 1
        print("PASS", m)
    else:
        f += 1
        print("FAIL", m)


def parse_pdts(text):
    return [l.split(":", 1)[1] for l in text.splitlines()
            if l.startswith("#EXT-X-PROGRAM-DATE-TIME:")]


def iso_to_epoch(s):
    import datetime
    return datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%fZ").replace(
        tzinfo=datetime.timezone.utc).timestamp()


def mk_init(path, timescale):
    with open(path, "wb") as fh:
        fh.write(b"\x00\x00\x00\x20mdhd" + bytes([0, 0, 0, 0]) + b"\x00" * 8
                 + timescale.to_bytes(4, "big") + b"\x00" * 4)


def mk_seg(path, base_time):
    with open(path, "wb") as fh:
        fh.write(b"\x00\x00\x00\x14tfdt" + bytes([1, 0, 0, 0]) + int(base_time).to_bytes(8, "big"))


def fresh_caches():
    encoder._TS_CACHE.clear()
    encoder._PTS_CACHE.clear()
    encoder._EPOCH.clear()


# ---------------------------------------------------------------------------
# 1. box readers
# ---------------------------------------------------------------------------
tmp = tempfile.mkdtemp()
os.makedirs(os.path.join(tmp, "720p"))
mk_init(os.path.join(tmp, "720p", "init.mp4"), 90000)
mk_seg(os.path.join(tmp, "720p", "seg_1.m4s"), 400 * 90000)
ok(encoder._mp4_timescale(os.path.join(tmp, "720p", "init.mp4")) == 90000, "mdhd timescale parsed")
ok(encoder._mp4_tfdt_time(os.path.join(tmp, "720p", "seg_1.m4s")) == 400 * 90000, "tfdt parsed")
fresh_caches()
ok(abs(encoder._seg_pts(tmp, "720p/seg_1.m4s") - 400.0) < 1e-9, "segment PTS = tfdt / timescale")
ok(encoder._seg_pts(tmp, "720p/seg_999.m4s") is None, "missing segment -> None, never a guess")

# ---------------------------------------------------------------------------
# 2. video companion PDT comes from the media timeline, not from write times
# ---------------------------------------------------------------------------
tmp2 = tempfile.mkdtemp()
os.makedirs(os.path.join(tmp2, "720p"))
mk_init(os.path.join(tmp2, "720p", "init.mp4"), 90000)
N, EXTINF, REAL_SPACING = 20, 4.0, 3.7   # nominal 4.0s, actually written every 3.7s
now = time.time()
lines = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-TARGETDURATION:5",
         "#EXT-X-MEDIA-SEQUENCE:0", '#EXT-X-MAP:URI="720p/init.mp4"']
for i in range(N):
    seg = os.path.join(tmp2, "720p", f"seg_{i}.m4s")
    mk_seg(seg, int(i * EXTINF * 90000))
    mt = now - (N - 1 - i) * REAL_SPACING
    os.utime(seg, (mt, mt))
    lines += [f"#EXTINF:{EXTINF:.3f},", f"720p/seg_{i}.m4s"]
fresh_caches()
text = encoder._pdt_companion_playlist("\n".join(lines) + "\n", tmp2, EXTINF)
pdts = parse_pdts(text)
ok(len(pdts) == N, f"PDT stamped on EVERY segment ({len(pdts)}/{N})")

steps = [iso_to_epoch(b) - iso_to_epoch(a) for a, b in zip(pdts, pdts[1:])]
worst = max(abs(s - EXTINF) for s in steps)
ok(worst < 0.002, f"PDT advances by exactly EXTINF (worst step error {worst:.4f}s)")
ok(abs(REAL_SPACING - EXTINF) > 0.2,
   f"regression guard: write times here are {abs(REAL_SPACING - EXTINF):.1f}s/segment off the media clock")
ok(all(a < b for a, b in zip(pdts, pdts[1:])), "PDT is monotonic")

text_again = encoder._pdt_companion_playlist("\n".join(lines) + "\n", tmp2, EXTINF)
ok(parse_pdts(text_again) == pdts, "PDT identical on regeneration (nothing jitters under the player)")

lines2 = list(lines[:5]) + [f"#EXTINF:{EXTINF:.3f},", "720p/seg_0.m4s",
                            f"#EXTINF:{EXTINF:.3f},", "720p/MISSING.m4s",
                            f"#EXTINF:{EXTINF:.3f},", "720p/seg_2.m4s"]
pd2 = parse_pdts(encoder._pdt_companion_playlist("\n".join(lines2) + "\n", tmp2, EXTINF))
ok(len(pd2) == 3, "missing segment still stamped (continuity)")
ok(abs(iso_to_epoch(pd2[1]) - (iso_to_epoch(pd2[0]) + EXTINF)) < 0.01,
   "missing segment PDT continues from the previous stamp")

# ---------------------------------------------------------------------------
# 3. one epoch: video and subtitles are stamped off the SAME anchor
# ---------------------------------------------------------------------------
epoch = encoder._media_epoch(tmp2, EXTINF)
ok(epoch is not None, "media epoch anchors from a real segment")
ok(abs(epoch - iso_to_epoch(pdts[0])) < 0.002, "a segment at PTS 0 is stamped exactly at the epoch")
ok(encoder._media_epoch(tmp2, EXTINF) == epoch, "epoch is anchored ONCE and never moves")
sub = encoder._live_sub_playlist([(4, epoch + 16.0, 8.0), (6, epoch + 24.0, 8.0)], 8.0, 4)
spd = parse_pdts(sub)
ok(abs(iso_to_epoch(spd[0]) - iso_to_epoch(pdts[4])) < 0.002,
   "the subtitle segment covering PTS 16s carries the SAME wall clock as the video segment at PTS 16s")
ok(abs((iso_to_epoch(spd[1]) - iso_to_epoch(spd[0])) - 8.0) < 0.002,
   "subtitle PDT advances by exactly the window length")

# ---------------------------------------------------------------------------
# 4. subtitle playlist shape
# ---------------------------------------------------------------------------
ok("#EXT-X-MEDIA-SEQUENCE:4" in sub, "media sequence preserved")
ok([l for l in sub.splitlines() if l and not l.startswith("#")] == ["sub_4.vtt", "sub_6.vtt"],
   "segment URIs in order")
ok("#EXT-X-TARGETDURATION:8" in sub, "target duration covers the listed segments")
ok("#EXT-X-TARGETDURATION:9" in encoder._live_sub_playlist([(0, 100.0, 8.4)], 8.0, 0),
   "target duration is the CEILING of the longest EXTINF")
empty = encoder._live_sub_playlist([], 8.0, 0)
ok("#EXTM3U" in empty and "sub_" not in empty,
   "empty placeholder playlist valid (the track must exist before the first cue)")

# ---------------------------------------------------------------------------
# 5. the WebVTT segment itself
# ---------------------------------------------------------------------------
class FC:
    def __init__(s, a, b, t):
        s.start, s.end, s.text, s.lang = a, b, t, "en"


vtt = os.path.join(tmp2, "test.vtt")
encoder._write_sub_segment(vtt, [FC(8.5, 11.0, "hello")], 8.0, 16.0, mpegts=414 * 90000)
body = open(vtt).read()
ok(f"X-TIMESTAMP-MAP=MPEGTS:{414 * 90000},LOCAL:00:00:00.000" in body,
   "VTT carries the true 90kHz map (a constant map was the display killer)")
ok("00:00:00.500 --> 00:00:03.000" in body, "cues stay segment-relative under the map")
encoder._write_sub_segment(vtt, [FC(8.5, 11.0, "hello")], 8.0, 16.0, mpegts=None)
ok("X-TIMESTAMP-MAP" not in open(vtt).read(), "map omitted when the PTS is unknown")

encoder._write_sub_segment(vtt, [FC(6.0, 10.0, "spans the boundary")], 8.0, 16.0, mpegts=None)
ok("spans the boundary" not in open(vtt).read(), "a cue starting before the segment is not duplicated in")
encoder._write_sub_segment(vtt, [FC(6.0, 10.0, "spans the boundary")], 0.0, 8.0, mpegts=None)
ok("spans the boundary" in open(vtt).read(), "the cue lives in its START segment")
encoder._write_sub_segment(vtt, [FC(8.0, 8.2, "blink")], 8.0, 16.0, mpegts=None)
ok("00:00:00.000 --> 00:00:01.000" in open(vtt).read(), "short cue clamped up to 1s")
encoder._write_sub_segment(vtt, [FC(8.0, 30.0, "run-on")], 8.0, 16.0, mpegts=None)
ok("00:00:00.000 --> 00:00:07.000" in open(vtt).read(), "long cue clamped down to 7s")
# a cue must not run past its own segment either: it would sit on screen underneath the
# NEXT segment's first cue, which is the same stacking problem across the boundary
encoder._write_sub_segment(vtt, [FC(15.4, 15.6, "late")], 8.0, 16.0, mpegts=None)
body_late = open(vtt).read()
ok("00:00:07.400 --> 00:00:08.000" in body_late,
   f"a cue near the segment end is trimmed to the boundary, not stretched past it")

# ---------------------------------------------------------------------------
# 6. HLS master variant resolution (the ingest correctness fix)
# ---------------------------------------------------------------------------
MASTER = """#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="en",NAME="English"
#EXT-X-STREAM-INF:BANDWIDTH=617000,CODECS="mp4a.40.2,avc1.42C00D",RESOLUTION=192x108,AUDIO="a"
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1900000,CODECS="mp4a.40.2,avc1.640028",RESOLUTION=1280x720,AUDIO="a"
mid.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2716000,CODECS="mp4a.40.2,avc1.640028",RESOLUTION=1920x1080,AUDIO="a"
high.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=151000,CODECS="mp4a.40.2",AUDIO="a"
audio-only.m3u8
"""
vs = encoder.parse_master(MASTER)
ok(len(vs) == 4, f"master parsed ({len(vs)} variants)")
ok([v["height"] for v in vs] == [108, 720, 1080, None], "resolutions parsed; audio-only has none")

_orig_get = encoder._http_get
encoder._http_get = lambda u, timeout=8: MASTER
encoder._VARIANT_CACHE.clear()
u = encoder.resolve_hls_variant("https://h/x/master.m3u8")
ok(u.endswith("/high.m3u8"),
   f"default picks the HIGHEST rung, not ffmpeg's first video stream which is the LOWEST (got {u})")
encoder._VARIANT_CACHE.clear()
ok(encoder.resolve_hls_variant("https://h/x/master.m3u8", "720").endswith("/mid.m3u8"),
   "an explicit height is honoured")
encoder._VARIANT_CACHE.clear()
ok(encoder.resolve_hls_variant("https://h/x/master.m3u8", "lowest").endswith("/low.m3u8"),
   "lowest is selectable")
encoder._VARIANT_CACHE.clear()
encoder._http_get = lambda u, timeout=8: "#EXTM3U\n#EXTINF:4,\nseg.ts\n"
ok(encoder.resolve_hls_variant("https://h/x/media.m3u8") == "https://h/x/media.m3u8",
   "a media playlist passes straight through")
encoder._VARIANT_CACHE.clear()


def _boom(u, timeout=8):
    raise OSError("network down")


encoder._http_get = _boom
ok(encoder.resolve_hls_variant("https://h/x/master.m3u8") == "https://h/x/master.m3u8",
   "a probe failure falls back to the URL as given; it never fails the job")
encoder._http_get = _orig_get
encoder._VARIANT_CACHE.clear()
ok(encoder.resolve_hls_variant("srt://0.0.0.0:9000?mode=listener") == "srt://0.0.0.0:9000?mode=listener",
   "non-HTTP inputs are untouched")
ok(encoder.input_url({"protocol": "srt", "url": "srt://x"}) == "srt://x", "input_url passes SRT through")

print(f"\n{p} passed, {f} failed")
raise SystemExit(1 if f else 0)
