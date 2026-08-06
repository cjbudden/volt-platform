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

for fn in list(globals().values()):
    if callable(fn) and getattr(fn, "__name__", "").startswith("test_"):
        fn()
print("\n" + ("ALL PASSED" if not FAILS else f"{len(FAILS)} FAILED: {FAILS}"))
sys.exit(1 if FAILS else 0)
