#!/usr/bin/env python3
"""Deterministic tests for the thumbnailer builders + WebVTT. No ffmpeg/S3.
Run: python3 bin/test_thumbnailer.py"""
import sys
sys.path.insert(0, "bin"); sys.path.insert(0, ".")
import thumbnailer as t

FAILS = []
def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond: FAILS.append(name)

def test_thumb_height():
    check("16:9 320 -> 180", t.thumb_height(320, [16, 9]) == 180)
    check("height kept even", t.thumb_height(321, [16, 9]) % 2 == 0)

def test_poster_cmd():
    cmd = t.build_poster_cmd("s3://b/x.m3u8", "/w/poster.jpg", 320, [16, 9], at_sec=30)
    j = " ".join(cmd)
    check("keyframe-only decode (no encode path)", "-skip_frame" in cmd and "nokey" in cmd)
    check("single frame", "-frames:v" in cmd and "1" in cmd)
    check("seek to poster_at", "-ss" in cmd and "30" in cmd)
    check("scales 320:180", "scale=320:180" in j)

def test_storyboard_cmd():
    cmd = t.build_storyboard_cmd("src.ts", "/w/sb_%03d.jpg", 320, [16, 9], 10, 5, 5)
    j = " ".join(cmd)
    check("keyframe-only", "-skip_frame" in cmd)
    check("one frame / 10s", "fps=1/10" in j)
    check("tiles 5x5", "tile=5x5" in j)
    check("no audio", "-an" in cmd)

def test_accurate_variants():
    # local CMAF path: accurate poster seeks after -i and drops skip_frame
    p = t.build_poster_cmd("/o/master.m3u8", "/o/poster.jpg", 320, [16, 9], at_sec=8, accurate=True)
    check("accurate poster: no skip_frame", "-skip_frame" not in p)
    check("accurate poster: -ss after -i", p.index("-i") < p.index("-ss"))
    sb = t.build_storyboard_cmd("/o/master.m3u8", "/o/sb_%03d.jpg", 320, [16, 9], 4, 5, 5, accurate=True)
    check("accurate storyboard: no skip_frame", "-skip_frame" not in sb)
    check("accurate storyboard: still tiles 5x5", "tile=5x5" in " ".join(sb))

def test_vtt_structure():
    # 25s duration, 10s interval -> 3 cues (0-10,10-20,20-25)
    vtt = t.build_webvtt(25, 10, 5, 5, 320, [16, 9], lambda i: f"sb_{i:03d}.jpg")
    check("starts WEBVTT", vtt.startswith("WEBVTT"))
    check("has 3 cues", vtt.count("-->") == 3)
    check("first cue 0->10", "00:00:00.000 --> 00:00:10.000" in vtt)
    check("last cue clamps to duration 25", "00:00:20.000 --> 00:00:25.000" in vtt)
    check("first region top-left", "sb_000.jpg#xywh=0,0,320,180" in vtt)
    check("second region shifts x by width", "sb_000.jpg#xywh=320,0,320,180" in vtt)

def test_vtt_sheet_rollover():
    # 2x2 grid = 4 per sheet; interval 1s; 6s -> 6 cues, cue #5 (index4) on sheet1
    vtt = t.build_webvtt(6, 1, 2, 2, 100, [1, 1], lambda i: f"sb_{i:03d}.jpg")
    check("6 cues", vtt.count("-->") == 6)
    check("index0 sheet0 top-left", "sb_000.jpg#xywh=0,0,100,100" in vtt)
    check("index3 sheet0 bottom-right", "sb_000.jpg#xywh=100,100,100,100" in vtt)
    check("index4 rolls to sheet1 top-left", "sb_001.jpg#xywh=0,0,100,100" in vtt)

def test_ts_format():
    check("ts 0", t._ts(0) == "00:00:00.000")
    check("ts 3661.5", t._ts(3661.5) == "01:01:01.500")

# ---- a recording in the bucket (build queue 2.3c) ---------------------------
SIGN = lambda b, k: f"https://{b}.s3.test/{k}?sig=1"
REC_PL = """#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:4
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="s3://bk/channel/c1/runs/R1/720p/init.mp4"
#EXTINF:4.000,
s3://bk/channel/c1/runs/R1/720p/seg_1.m4s
#EXT-X-DISCONTINUITY
#EXT-X-MAP:URI="s3://bk/channel/c1/runs/R2/720p/init.mp4"
#EXTINF:4.000,
s3://bk/channel/c1/runs/R2/720p/seg_1.m4s
#EXT-X-ENDLIST
"""

def test_presign_playlist():
    out = t.presign_playlist(REC_PL, "s3://bk/thumbs/r1/source.m3u8", SIGN)
    check("segments signed", "https://bk.s3.test/channel/c1/runs/R2/720p/seg_1.m4s?sig=1" in out)
    check("init maps signed", 'URI="https://bk.s3.test/channel/c1/runs/R1/720p/init.mp4?sig=1"' in out)
    check("no s3:// left", "s3://" not in out)
    check("tags kept (ENDLIST, DISCONTINUITY, EXTINF)", "#EXT-X-ENDLIST" in out and "#EXT-X-DISCONTINUITY" in out and out.count("#EXTINF:4.000,") == 2)
    rel = t.presign_playlist("#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\nseg_1.m4s\n../other/seg_2.m4s\nhttps://cdn/x.m4s\n", "s3://bk/vod/a/720p/index.m3u8", SIGN)
    check("relative segment taken from the playlist's folder", "https://bk.s3.test/vod/a/720p/seg_1.m4s?sig=1" in rel)
    check("relative init taken from the playlist's folder", 'URI="https://bk.s3.test/vod/a/720p/init.mp4?sig=1"' in rel)
    check("dot-dot resolved", "https://bk.s3.test/vod/a/other/seg_2.m4s?sig=1" in rel)
    check("https left alone", "\nhttps://cdn/x.m4s\n" in rel)

def test_resolve_source():
    import tempfile, os
    d = tempfile.mkdtemp()
    fetched = []
    def fetch(u, p):
        fetched.append(u)
        open(p, "w").write(REC_PL)
    src, proto = t.resolve_source("s3://bk/thumbs/r1/source.m3u8", d, presign=SIGN, fetch=fetch)
    check("bucket playlist fetched", fetched == ["s3://bk/thumbs/r1/source.m3u8"])
    check("ffmpeg reads the local signed copy", src == os.path.join(d, "source.m3u8") and "s3://" not in open(src).read())
    check("https allowed for its segments", proto and "https" in proto.split(","))
    same, none = t.resolve_source("/o/vod.m3u8", d, presign=SIGN, fetch=fetch)
    check("a local source is used as given", same == "/o/vod.m3u8" and none is None and len(fetched) == 1)
    p = t.build_poster_cmd(src, "/w/p.jpg", 320, [16, 9], at_sec=5, protocols=proto)
    check("whitelist goes before -i", p.index("-protocol_whitelist") + 2 == p.index("-i"))
    sb = t.build_storyboard_cmd(src, "/w/sb_%03d.jpg", 320, [16, 9], 10, 5, 5, protocols=proto)
    check("storyboard whitelist before -i", sb.index("-protocol_whitelist") + 2 == sb.index("-i"))
    check("no whitelist unless asked", "-protocol_whitelist" not in t.build_poster_cmd("/x.m3u8", "/p.jpg", 320, [16, 9]))

for fn in list(globals().values()):
    if callable(fn) and getattr(fn, "__name__", "").startswith("test_"):
        fn()
print("\n" + ("ALL PASSED" if not FAILS else f"{len(FAILS)} FAILED: {FAILS}"))
sys.exit(1 if FAILS else 0)
