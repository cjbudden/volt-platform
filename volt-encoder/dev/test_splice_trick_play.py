#!/usr/bin/env python3
"""I-frame playlists that follow the playout splice (build queue 3.2b-7 (c)). Offline.

WHAT THIS GUARDS:
  * While playout splices the channel loop in (the source is late, or an operator
    forces the slate or loop), each video variant's delivered I-frame playlist lists
    exactly what its delivered media playlist lists: the same segments and loop
    slots, the same media sequence and discontinuity sequence, the same
    discontinuities. A scrubbing viewer sees the loop under a break, never the
    programme it replaced (live segments consumed while forced are never listed).
  * Every byte range is a real keyframe: init + range alone decodes to exactly one
    picture, the same as the delivered segment's first picture.
  * Entries roll with the window like the media playlist; a segment whose range is
    not known yet starts the list after it rather than breaking the numbering.
  * The delivered master names the delivered I-frame playlists (never the
    packager's, which index the unspliced segments) and leaves a line out until
    its playlist exists. Switched off (no I-frame lines from the packager), nothing
    is written or listed.

Media is made here with ffmpeg (fMP4, 4 s segments). Shaka Packager's own live
output is not available here: see BUILD_QUEUE.md 3.2b-7 for the check on the Mac.

Run: python3 test_splice_trick_play.py   (from volt-encoder/dev)
"""
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "bin"))
import encoder  # noqa: E402
import mp4util  # noqa: E402
import playout as P  # noqa: E402

p = f = 0


def ok(c, m):
    global p, f
    if c:
        p += 1
        print("PASS", m)
    else:
        f += 1
        print("FAIL", m)


def sh(*a):
    return subprocess.run(list(a), check=True, capture_output=True)


SEGD = 4.0


def make(d, folder, w, h, secs, colour):
    """d/<folder>/init.mp4 and seg_<n>.m4s from 1: 4 s segments, a keyframe every 2 s."""
    out = os.path.join(d, folder)
    os.makedirs(out, exist_ok=True)
    sh("ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"testsrc2=size={w}x{h}:rate=25:duration={secs}",
       "-vf", f"drawbox=c={colour}:t=10", "-c:v", "libx264", "-preset", "ultrafast", "-g", "50", "-keyint_min", "50",
       "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-f", "hls", "-hls_time", "4", "-hls_playlist_type", "vod",
       "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4", "-start_number", "1",
       "-hls_segment_filename", os.path.join(out, "seg_%d.m4s"), os.path.join(out, "ffmpeg.m3u8"))
    return sorted(int(x[4:-4]) for x in os.listdir(out) if x.startswith("seg_"))


def frame_md5s(path, n=None):
    a = ["ffmpeg", "-v", "error", "-i", path, "-map", "0:v:0"] + (["-frames:v", str(n)] if n else []) + ["-f", "framemd5", "-"]
    return [l.split(",")[-1].strip() for l in sh(*a).stdout.decode().splitlines() if l and not l.startswith("#")]


def key_flags(path):
    o = sh("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=flags", "-of", "csv=p=0", path).stdout.decode()
    return [l.strip() for l in o.splitlines() if l.strip()]


def listing(text, iframes):
    """playlist -> (media seq, disc seq, [(uri, disc_before, map, range)])"""
    L = text.splitlines()
    msn = int(next(l for l in L if l.startswith("#EXT-X-MEDIA-SEQUENCE:")).split(":")[1])
    dsn = int(next(l for l in L if l.startswith("#EXT-X-DISCONTINUITY-SEQUENCE:")).split(":")[1])
    out, disc, cmap, rng = [], False, None, None
    for l in L:
        if l == "#EXT-X-DISCONTINUITY":
            disc = True
        elif l.startswith("#EXT-X-MAP:"):
            cmap = l.split('URI="')[1].split('"')[0]
        elif l.startswith("#EXT-X-BYTERANGE:"):
            ln, off = l.split(":")[1].split("@")
            rng = (int(off), int(ln))
        elif l and not l.startswith("#"):
            out.append((l, disc, cmap, rng if iframes else None))
            disc, rng = False, None
    return msn, dsn, out


def hls(label, first, last):
    out = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-TARGETDURATION:4", f'#EXT-X-MAP:URI="{label}/init.mp4"']
    for n in range(first, last + 1):
        out += [f"#EXTINF:{SEGD:.3f},", f"{label}/seg_{n}.m4s"]
    return "\n".join(out) + "\n"


MASTER = """#EXTM3U
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-STREAM-INF:BANDWIDTH=900000,CODECS="avc1.64001e",RESOLUTION=640x360
stream_0.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=300000,CODECS="avc1.64000d",RESOLUTION=320x180
stream_1.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=120000,CODECS="avc1.64001e",RESOLUTION=640x360,URI="360p.iframes.m3u8"
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=40000,CODECS="avc1.64000d",RESOLUTION=320x180,URI="180p.iframes.m3u8"
"""


def main():
    global p, f
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        print("SKIP: ffmpeg and ffprobe are needed")
        return 0
    d = tempfile.mkdtemp(prefix="splicetrick-")
    live = {"360p": make(d, "360p", 640, 360, 160, "red"), "180p": make(d, "180p", 320, 180, 160, "red")}
    make(d, "filler/360p", 640, 360, 12, "blue")
    make(d, "filler/180p", 320, 180, 12, "blue")
    ok(len(live["360p"]) >= 39 and live["360p"] == live["180p"], f"(live media made: {len(live['360p'])} segments a rendition)")

    def fil(label):
        ts = mp4util.timescale(os.path.join(d, "filler", label, "init.mp4"))
        return {"init": f"filler/{label}/init.mp4", "timescale": ts,
                "segments": [{"uri": f"filler/{label}/seg_{i}.m4s", "dur": SEGD, "d": int(SEGD * ts)} for i in (1, 2, 3)]}

    E0 = 1_000_000.0
    po = P.Playout({"360p": fil("360p"), "180p": fil("180p")}, window_sec=120, hold_sec=2.4,
                   pdt_of=lambda uri: E0 + (P._seg_key(uri) - 1) * SEGD)
    po.on_slot = lambda src, dst, t: mp4util.rebase(os.path.join(d, src), os.path.join(d, dst), t)
    dropped = []

    def on_drop(uri):
        dropped.append(uri)
        try:
            os.remove(os.path.join(d, uri))
        except OSError:
            pass
    po.on_drop = on_drop
    encoder._PLAYOUT = po
    encoder._TRIGGERS = None
    encoder._with_triggers = lambda text: text
    encoder._KF_RANGES.clear()

    now, last, nxt = 0.0, 0, SEGD
    listed = set()
    forced_consumed = set()
    snap = None
    for sec in range(175):
        now += 1.0
        up = not (40 <= sec < 70)            # the source drops for 30 s: the loop is spliced in
        po.forced = 100 <= sec < 130         # an operator forces the loop: live keeps arriving
        if not up:
            nxt = now + SEGD
        elif now >= nxt and last < len(live["360p"]):
            last += 1
            nxt += SEGD
            if po.forced:
                forced_consumed.add(last)
        if last:
            first = max(1, last - 20)
            po.update(now, {"stream_0.m3u8": hls("360p", first, last), "stream_1.m3u8": hls("180p", first, last)}, "stream_0.m3u8")
            for t in po.tracks.values():
                listed.update(e.uri for e in t.entries)
        if sec == 120:
            # mid-force: the playlists as a viewer would read them right now
            real = po.update
            po.update = lambda *a, **k: None
            m = encoder._playout_pass(d, MASTER.splitlines(), SEGD)
            po.update = real
            snap = (m, open(os.path.join(d, "stream_0_cc.m3u8")).read(), open(os.path.join(d, "360p.iframes_cc.m3u8")).read())

    real = po.update
    po.update = lambda *a, **k: None
    mapping = encoder._playout_pass(d, MASTER.splitlines(), SEGD)

    print("== the delivered I-frame playlists ==")
    ok(mapping.get("360p.iframes.m3u8") == "360p.iframes_cc.m3u8" and mapping.get("180p.iframes.m3u8") == "180p.iframes_cc.m3u8",
       "each video variant gets a delivered I-frame playlist, named after the packager's")
    kinds = [k for _, k, _, _ in po.periods()]
    ok(po.splices >= 2 and kinds.count("filler") >= 1, f"(the run spliced the loop in {po.splices} times; Periods in the window {kinds})")
    for v, lab in (("stream_0", "360p"), ("stream_1", "180p")):
        mt = open(os.path.join(d, f"{v}_cc.m3u8")).read()
        it = open(os.path.join(d, f"{lab}.iframes_cc.m3u8")).read()
        mm, md, me = listing(mt, False)
        im, idd, ie = listing(it, True)
        ok("#EXT-X-I-FRAMES-ONLY" in it and "#EXT-X-VERSION:7" in it, f"{lab}: an I-frames-only playlist")
        ok([(u, dc, cm) for u, dc, cm, _ in ie] == [(u, dc, cm) for u, dc, cm, _ in me],
           f"{lab}: lists exactly the segments and loop slots its media playlist delivers, with the same discontinuities and inits ({len(ie)} entries)")
        ok((im, idd) == (mm, md) and mm > 0, f"{lab}: same media sequence ({im}) and discontinuity sequence ({idd}) as the media playlist, after the window rolled")
        ok(any(u.startswith(f"filler/{lab}/s_") for u, *_ in ie) and any(u.startswith(f"{lab}/seg_") for u, *_ in ie),
           f"{lab}: loop slots and live segments are both listed")
        ok(not any(u == f"{lab}/seg_{n}.m4s" for u, *_ in ie for n in forced_consumed),
           f"{lab}: none of the {len(forced_consumed)} live segments consumed while the loop was forced is listed")
        ok(all(rg and rg[1] > 0 for *_, rg in ie), f"{lab}: every entry has a byte range")

    print("\n== mid-break, as a viewer would read it ==")
    sm, smt, sit = snap
    ok(sm.get("360p.iframes.m3u8") == "360p.iframes_cc.m3u8", "the I-frame playlist is there during the forced loop")
    se = listing(sit, True)[2]
    tail = [u for u, *_ in se][-5:]
    ok(tail and all(u.startswith("filler/360p/s_") for u in tail), f"its newest entries are loop slots, as the media playlist's are: {tail[-2:]}")
    ok([u for u, *_ in se] == [u for u, *_ in listing(smt, False)[2]], "and it matches the media playlist entry for entry")
    ok(not any(u == f"360p/seg_{n}.m4s" for u, *_ in se for n in forced_consumed), "no programme segment from under the forced loop")

    print("\n== every range is a keyframe (ground truth from the media) ==")
    one = same = n = 0
    checks = listing(open(os.path.join(d, "360p.iframes_cc.m3u8")).read(), True)[2]
    checks += listing(open(os.path.join(d, "180p.iframes_cc.m3u8")).read(), True)[2][:6]
    for u, _dc, cm, (off, ln) in checks:
        init = open(os.path.join(d, cm), "rb").read()
        seg = open(os.path.join(d, u), "rb").read()
        part, full = os.path.join(d, "k.mp4"), os.path.join(d, "full.mp4")
        open(part, "wb").write(init + seg[off:off + ln])
        open(full, "wb").write(init + seg)
        fl = key_flags(part)
        one += len(fl) == 1 and fl[0].startswith("K")
        same += frame_md5s(part) == frame_md5s(full, 1)
        n += 1
    ok(n >= 30 and one == n, f"init + range alone is exactly one keyframe ({one}/{n}, live segments and loop slots)")
    ok(same == n, f"and it is the delivered segment's first picture ({same}/{n})")
    ok(any(u.startswith("filler/") for u, *_ in checks), "(loop slots among them)")

    print("\n== numbering when a range is not known ==")
    tr = po.tracks["stream_0.m3u8"]
    known = encoder._keyframe_lookup(d)
    hole = tr.entries[5].uri
    txt = tr.render_iframes(encoder._iso, lambda u: None if u == hole else known(u))
    hm, hd, he = listing(txt, True)
    exp_d = tr.disc_seq + sum(1 for e in tr.entries[:7] if e.disc)
    ok(hm == tr.media_seq + 6 and [u for u, *_ in he] == [e.uri for e in tr.entries[6:]],
       f"the list starts after the unknown one, numbered as the media playlist numbers it ({hm})")
    ok(hd == exp_d and not txt.split("#EXT-X-I-FRAMES-ONLY")[1].lstrip().startswith("#EXT-X-DISCONTINUITY\n"),
       "its discontinuity sequence counts the ones before it, and the first entry carries no tag")
    ok(tr.render_iframes(encoder._iso, lambda u: None) is None, "nothing known: no playlist")
    os.rename(os.path.join(d, tr.entries[-1].uri), os.path.join(d, "gone.m4s"))
    encoder._KF_RANGES.pop(tr.entries[-1].uri, None)
    ok(encoder._keyframe_lookup(d)(tr.entries[-1].uri) is None and tr.entries[-1].uri not in encoder._KF_RANGES,
       "a file not there yet is not remembered as having no keyframe")
    os.rename(os.path.join(d, "gone.m4s"), os.path.join(d, tr.entries[-1].uri))
    gone = [u for u in dropped if u in encoder._KF_RANGES]
    ok(dropped and not gone, f"ranges of slots that left the window are forgotten ({len(dropped)} dropped)")

    print("\n== the delivered master ==")
    for name in ("master.m3u8",):
        open(os.path.join(d, name), "w").write(MASTER)
    encoder._playout_pass = lambda od, src, seg: dict(mapping)
    encoder._write_companion(d, [], None, 4)
    cc = open(os.path.join(d, "master_cc.m3u8")).read()
    il = [l for l in cc.splitlines() if l.startswith("#EXT-X-I-FRAME-STREAM-INF")]
    ok(len(il) == 2 and 'URI="360p.iframes_cc.m3u8"' in il[0] and 'URI="180p.iframes_cc.m3u8"' in il[1],
       "the master names the delivered I-frame playlists")
    ok(".iframes.m3u8" not in cc, "never the packager's, which index the unspliced segments")
    ok('BANDWIDTH=120000,CODECS="avc1.64001e",RESOLUTION=640x360' in il[0], "(the packager's attributes are kept)")
    part_map = {k: v for k, v in mapping.items() if k != "180p.iframes.m3u8"}
    encoder._playout_pass = lambda od, src, seg: dict(part_map)
    encoder._write_companion(d, [], None, 4)
    cc = open(os.path.join(d, "master_cc.m3u8")).read()
    il = [l for l in cc.splitlines() if l.startswith("#EXT-X-I-FRAME-STREAM-INF")]
    ok(len(il) == 1 and "360p.iframes_cc.m3u8" in il[0] and "180p" not in cc.split("stream_1")[-1],
       "a variant whose I-frame playlist is not there yet is left out, not pointed at the packager's")

    print("\n== switched off ==")
    d2 = tempfile.mkdtemp(prefix="splicetrick-off-")
    for x in ("360p", "180p", "filler"):
        os.symlink(os.path.join(d, x), os.path.join(d2, x))
    off_master = "\n".join(l for l in MASTER.splitlines() if "I-FRAME" not in l)
    del encoder._playout_pass
    import importlib
    importlib.reload(encoder)
    encoder._PLAYOUT = po
    encoder._with_triggers = lambda text: text
    m2 = encoder._playout_pass(d2, off_master.splitlines(), SEGD)
    ok(m2.get("stream_0.m3u8") == "stream_0_cc.m3u8" and not any("iframes" in k for k in m2),
       "no I-frame lines from the packager: none mapped")
    ok(not any("iframes" in x for x in os.listdir(d2)), "and no I-frame playlist written")
    po.update = real

    print(f"\ntest_splice_trick_play: {p} passed, {f} failed")
    shutil.rmtree(d, ignore_errors=True)
    shutil.rmtree(d2, ignore_errors=True)
    return 1 if f else 0


if __name__ == "__main__":
    sys.exit(main())
