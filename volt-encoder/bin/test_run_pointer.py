"""Tests for run_pointer.py (build queue 2.2: per-run S3 prefixes): the stable
playlists at a stream's root point into the live run, playlists still name
each other where they were, nothing outside the run is touched, and the
pointer never goes back to an older run. Run: python3 test_run_pointer.py
"""
import os
import posixpath
import tempfile

import run_pointer as rp

PASS = FAIL = 0


def ok(cond, name):
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
        print("FAIL", name)


def w(root, rel, text):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as fh:
        fh.write(text)


RUN = "20261112T192200Z"
MASTER = """#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="en",URI="subtitles/en/subs.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x720,SUBTITLES="subs"
720p/index_cc.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=300000,URI="720p/iframe.m3u8"
"""
MEDIA = """#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:12
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key-1",KEYFORMAT="com.apple.streamingkeydelivery"
#EXT-X-PROGRAM-DATE-TIME:2026-11-12T19:22:00.000Z
#EXTINF:4.0,
seg_12.m4s
#EXTINF:4.0,
seg_13.m4s?v=1
#EXT-X-DISCONTINUITY
#EXT-X-MAP:URI="../filler/720p/init.mp4"
#EXTINF:4.0,
../filler/720p/seg_1.m4s
#EXTINF:4.0,
https://cdn.example.net/ads/a.m4s
#EXTINF:4.0,
/clips/abs.m4s
#EXTINF:4.0,
../../outside/seg.m4s
"""
SUBS = """#EXTM3U
#EXTINF:4.0,
sub_3.vtt
"""
MPD = """<?xml version="1.0"?>
<MPD type="dynamic"><Period id="p0"><AdaptationSet>
<SegmentTemplate media="720p/seg_$Number$.m4s" initialization="720p/init.mp4" startNumber="1"/>
<Representation id="720p"/></AdaptationSet>
<AdaptationSet><SegmentTemplate media="subtitles/en/sub_$Number$.vtt"/></AdaptationSet>
</Period></MPD>"""
MPD_BASE = """<MPD><BaseURL>./</BaseURL><Period><BaseURL>https://x.example/</BaseURL>
<SegmentTemplate media="720p/seg_$Number$.m4s"/></Period></MPD>"""

with tempfile.TemporaryDirectory() as t:
    run = os.path.join(t, "out")
    stage = os.path.join(t, "stage")
    w(run, "master_cc.m3u8", MASTER)
    w(run, "720p/index_cc.m3u8", MEDIA)
    w(run, "720p/init.mp4", "x")
    w(run, "filler/720p/seg_1.m4s", "x")
    w(run, "manifest_cc.mpd", MPD)
    w(run, "720p/seg_12.m4s", "x")
    w(run, "notes.json", "{}")
    # subtitles/ made by the separate captions task live at the root, not in
    # this run: the run's master names them but the run has no such folder

    written = rp.build(run, RUN, stage)
    ok(sorted(written) == ["720p/index_cc.m3u8", "manifest_cc.mpd", "master_cc.m3u8"], f"every playlist staged, nothing else {written}")
    ok(open(os.path.join(stage, "current_run.txt")).read() == RUN, "current_run.txt names the run")
    ok(not os.path.exists(os.path.join(stage, "notes.json")), "non-playlists are not staged")

    m = open(os.path.join(stage, "master_cc.m3u8")).read()
    ok("\n720p/index_cc.m3u8\n" in m, "master still names the media playlist beside it")
    ok('URI="720p/iframe.m3u8"' in m, "I-frame playlist reference unchanged")
    ok('URI="subtitles/en/subs.m3u8"' in m, "subtitle playlist reference unchanged")

    p = open(os.path.join(stage, "720p/index_cc.m3u8")).read()
    base = f"../runs/{RUN}/720p/"
    ok(f'#EXT-X-MAP:URI="{base}init.mp4"' in p, "init segment points into the run")
    ok(f"\n{base}seg_12.m4s\n" in p, "segment points into the run")
    ok(f"\n{base}seg_13.m4s?v=1\n" in p, "query string kept, segment still moved (pruned locally is fine: judged by folder)")
    ok(f'URI="../runs/{RUN}/filler/720p/init.mp4"' in p and f"\n../runs/{RUN}/filler/720p/seg_1.m4s\n" in p,
       "the run's own loop segments point into the run")
    ok('URI="skd://key-1"' in p, "key URI with a scheme unchanged")
    ok("\nhttps://cdn.example.net/ads/a.m4s\n" in p, "absolute URL unchanged")
    ok("\n/clips/abs.m4s\n" in p, "root-relative URL unchanged")
    ok("\n../../outside/seg.m4s\n" in p, "a URI that climbs out of the run unchanged")
    ok("#EXT-X-MEDIA-SEQUENCE:12" in p and "#EXT-X-DISCONTINUITY" in p, "tags kept as they were")
    # the rewritten URI resolves to the run's file from the stable copy's place
    ok(posixpath.normpath(posixpath.join("720p", f"{base}seg_12.m4s")) == f"runs/{RUN}/720p/seg_12.m4s",
       "resolves to runs/<run>/720p/seg_12.m4s")

    d = open(os.path.join(stage, "manifest_cc.mpd")).read()
    ok(f'media="runs/{RUN}/720p/seg_$Number$.m4s"' in d and f'initialization="runs/{RUN}/720p/init.mp4"' in d,
       "DASH segment template points into the run")
    ok('media="subtitles/en/sub_$Number$.vtt"' in d, "DASH subtitles made outside the run unchanged")

    # the run's own subtitles: the folder exists in the run, so its cues move
    w(run, "subtitles/en/subs.m3u8", SUBS)
    rp.build(run, RUN, stage)
    s = open(os.path.join(stage, "subtitles/en/subs.m3u8")).read()
    ok(f"\n../../runs/{RUN}/subtitles/en/sub_3.vtt\n" in s, "in-process subtitle cues point into the run")
    d = open(os.path.join(stage, "manifest_cc.mpd")).read()
    ok(f'media="runs/{RUN}/subtitles/en/sub_$Number$.vtt"' in d, "and so does DASH once the run makes them")

    # an MPD with a BaseURL: only the relative BaseURL moves, never both
    w(run, "b.mpd", MPD_BASE)
    rp.build(run, RUN, stage)
    b = open(os.path.join(stage, "b.mpd")).read()
    ok(f"<BaseURL>runs/{RUN}/</BaseURL>" in b, f"relative BaseURL points into the run {b}")
    ok("<BaseURL>https://x.example/</BaseURL>" in b, "absolute BaseURL unchanged")
    ok('media="720p/seg_$Number$.m4s"' in b, "attributes under a BaseURL are not prefixed twice")

    # a run with no playlist yet stages nothing, so the pointer cannot move to it
    empty = os.path.join(t, "empty")
    os.makedirs(os.path.join(empty, "720p"))
    ok(rp.build(empty, RUN, stage) == [] and not os.path.exists(os.path.join(stage, "current_run.txt")),
       "no playlist, no pointer")
    # a stale stage from the last pass never leaks into this one
    ok(os.listdir(stage) == [], "stage emptied every pass")

    try:
        rp.build(run, "../evil", stage)
        ok(False, "bad run id refused")
    except ValueError:
        ok(True, "bad run id refused")

# the pointer only ever moves forward
ok(rp.may_publish(RUN, ""), "no pointer yet: publish")
ok(rp.may_publish(RUN, RUN + "\n"), "own pointer: publish")
ok(rp.may_publish(RUN, "20261112T180000Z"), "older run's pointer: publish (the run boundary)")
ok(not rp.may_publish(RUN, "20261112T200000Z"), "newer run's pointer: never take it back")
ok(rp.may_publish(RUN, "<Error>NoSuchKey</Error>"), "unreadable pointer: publish")

with tempfile.TemporaryDirectory() as t:
    f = os.path.join(t, "p")
    open(f, "w").write("20261112T200000Z")
    ok(rp.main(["may-publish", RUN, f]) == 1, "CLI refuses under a newer run")
    ok(rp.main(["may-publish", RUN, os.path.join(t, "missing")]) == 0, "CLI allows with no pointer file")

print(f"run_pointer: {PASS} passed, {FAIL} failed")
raise SystemExit(1 if FAIL else 0)
