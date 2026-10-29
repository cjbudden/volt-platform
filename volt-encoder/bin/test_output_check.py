"""Negative and positive tests for output_check.py and gop_align.py.

Every fault is INJECTED and must be reported; a clean output must report
nothing. Run: python3 test_output_check.py
"""
import os
import struct
import tempfile

import gop_align
import output_check as oc

PASS = FAIL = 0


def ok(cond, name):
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
        print("FAIL", name)


def track(kind, folder, starts, dur, first_no=10, seq=5):
    return {"kind": kind, "folder": folder, "seq": seq,
            "segs": [(first_no + i, s, dur) for i, s in enumerate(starts)]}


def codes(tracks, seg=3.6, prev=None):
    f, st = oc.check(tracks, seg, prev)
    return {x["code"] for x in f}, st


aligned = lambda n=6, d=3.6, o=0.0: [o + i * d for i in range(n)]

# ---- clean output: nothing reported -------------------------------------
clean = {"a": track("audio", "audio", aligned(), 3.6), "v1": track("video", "1080p", aligned(), 3.6),
         "v2": track("video", "720", aligned(), 3.6)}
c, _ = codes(clean)
ok(c == set(), "aligned output is clean")

# ---- index_misaligned: the Berita case (video 3.6 s, audio 4 s) ----------
berita = {"a": track("audio", "audio", aligned(6, 3.992, 156.0), 3.992),
          "v": track("video", "1080p", aligned(6, 3.6, 158.4), 3.6)}
c, _ = codes(berita, 4)
ok("index_misaligned" in c, "audio/video seg numbers at different times is reported")

# ---- av_skew: audio stalled 20 s behind ---------------------------------
c, _ = codes({"a": track("audio", "audio", aligned(6, 3.6, 0), 3.6, first_no=1),
              "v": track("video", "1080p", aligned(6, 3.6, 20), 3.6, first_no=100)})
ok("av_skew" in c, "audio stalled behind video is reported")

# ---- rendition_skew -------------------------------------------------------
c, _ = codes({"v1": track("video", "1080p", aligned(), 3.6), "v2": track("video", "720", aligned(6, 3.6, 1.0), 3.6)})
ok("rendition_skew" in c, "renditions disagreeing about time is reported")

# ---- timeline_backwards (a relay restarted and reset its clock) ----------
starts = aligned(3) + [2.0, 5.6, 9.2]
c, _ = codes({"v": track("video", "1080p", starts, 3.6)})
ok("timeline_backwards" in c, "a jump back in one track is reported")

# ---- a forward hole (filler covered it) is NOT a fault ---------------------
starts = aligned(3) + [30.0, 33.6, 37.2]
c, _ = codes({"v": track("video", "1080p", starts, 3.6)})
ok(c == set(), "a forward hole is not reported (the loop covers it)")

# ---- numbers differ but boundaries line up: NOT a fault ----------------------
c, _ = codes({"a": track("audio", "audio", aligned(6, 3.6, 97.2), 3.598, first_no=23),
              "v": track("video", "1080p", aligned(6, 3.6, 97.24), 3.6, first_no=21)})
ok("index_misaligned" not in c, "audio two segments ahead in numbering but cut together is fine")

# ---- sequence_regressed (a player reloading is sent back) ----------------
_, st = codes(clean)
again = {k: {**v, "seq": v["seq"] - 3} for k, v in clean.items()}
c, _ = codes(again, prev=st)
ok("sequence_regressed" in c, "media sequence going down is reported")
c, _ = codes(clean, prev=st)
ok("sequence_regressed" not in c, "steady media sequence is not reported")

# ---- OutputWatch: one event per change, ok on clear ------------------------
seen = []
feed = [berita, berita, clean, clean, berita, clean]
w = oc.OutputWatch("x", 4, emit=lambda t, **d: seen.append((t, d.get("state"))), read=lambda _d: feed.pop(0))
for _ in range(6):
    w.tick()
ok(seen == [("output.timeline", "fault"), ("output.timeline", "ok")], f"watch emits on change only, and a one-check blip is not reported: {seen}")

# ---- read_tracks against real fMP4 boxes ----------------------------------
def box(t, payload):
    return struct.pack(">I", 8 + len(payload)) + t + payload

def init(ts):
    mdhd = box(b"mdhd", b"\0\0\0\0" + b"\0" * 8 + struct.pack(">I", ts) + b"\0" * 8)
    return box(b"moov", box(b"trak", box(b"mdia", mdhd)))

def seg(t):
    return box(b"moof", box(b"traf", box(b"tfdt", b"\1\0\0\0" + struct.pack(">Q", t))))

with tempfile.TemporaryDirectory() as d:
    for folder, ts, dur, base in (("1080p", 90000, 3.6, 0), ("audio", 44100, 3.992, 0)):
        os.makedirs(os.path.join(d, folder))
        open(os.path.join(d, folder, "init.mp4"), "wb").write(init(ts))
        lines = ["#EXTM3U", "#EXT-X-MEDIA-SEQUENCE:1", f'#EXT-X-MAP:URI="{folder}/init.mp4"']
        for i in range(6):
            open(os.path.join(d, folder, f"seg_{i + 1}.m4s"), "wb").write(seg(int((base + i * dur) * ts)))
            lines += [f"#EXTINF:{dur},", f"{folder}/seg_{i + 1}.m4s"]
        open(os.path.join(d, "stream_0.m3u8" if folder == "audio" else "stream_1.m3u8"), "w").write("\n".join(lines))
    tr = oc.read_tracks(d)
    ok(tr["stream_0.m3u8"]["kind"] == "audio" and tr["stream_1.m3u8"]["kind"] == "video", "track kinds from folders")
    ok(abs(tr["stream_1.m3u8"]["segs"][-1][1] - 18.0) < 1e-6, "video start read from tfdt")
    f, _ = oc.check(tr, 4)
    ok({x["code"] for x in f} == {"index_misaligned"}, "real boxes: 4s audio vs 3.6s video is caught")

# ---- gop_align -------------------------------------------------------------
ok(gop_align.aligned_segment(4, 3.6)[0] == 3.6, "4s target on a 3.6s GOP -> 3.6s")
ok(gop_align.aligned_segment(6, 2.0)[0] == 6.0, "6s target on a 2s GOP stays 6s")
ok(gop_align.aligned_segment(4, 2.002)[0] == 4.004, "29.97 GOP rounds to whole GOPs")
ok(gop_align.aligned_segment(4, None)[0] == 4.0, "unknown GOP keeps the target")
ok(gop_align.aligned_segment(4, 3.6, 0.4)[0] == 4.0, "irregular GOP keeps the target")
ok(gop_align.aligned_segment(4, 30.0)[0] == 4.0, "a GOP longer than 12s keeps the target")
ok(gop_align.source_gop([0, 3.6, 7.2, 10.8, 10.8, 14.4]) == (3.6, 0.0), "GOP from keyframe times")
ok(gop_align.probeable({"protocol": "hls", "url": "https://x/a.m3u8"}), "HLS over HTTP is probed")
ok(not gop_align.probeable({"protocol": "srt", "url": "srt://0.0.0.0:9000"}), "a push source is not probed")
ok(gop_align.probe_keyframes("x", run=lambda *a, **k: (_ for _ in ()).throw(OSError())) == [], "a failed probe returns nothing")

print(f"{PASS} passed, {FAIL} failed")
raise SystemExit(1 if FAIL else 0)
