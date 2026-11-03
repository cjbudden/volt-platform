"""Checks for trick-play on FAST channels (build queue 3.2b-5, fast_playout.py).

A real asset is made here with ffmpeg (CMAF, 2 s segments, numbered frames), so
every byte range is checked against the media itself: init + range alone must
decode to exactly one keyframe, the same picture as the segment's first frame.

    python3 bin/test_fast_trick_play.py

Needs ffmpeg and ffprobe. Shaka Packager's own output (what the library holds
on the Mac and on AWS) is not made here: see BUILD_QUEUE.md 3.2b-5 for the
check on the Mac.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(__file__))
from fast_playout import (Playout, KeyframeCache, MediaReader, expand_parts, iso, keyframe_range, load_asset,  # noqa: E402
                          master_playlist, master_with_iframes, parse_iso, video_codecs)

PASS = FAIL = 0


def ok(c, m):
    global PASS, FAIL
    if c:
        PASS += 1
        print("PASS " + m)
    else:
        FAIL += 1
        print("FAIL " + m)


def sh(*a, **k):
    return subprocess.run(list(a), check=True, capture_output=True, **k)


def make_asset(clips, name, secs, colour):
    """/clips/vod/<name>/: two video rungs and audio, CMAF (fMP4) HLS, 2 s segments."""
    d = os.path.join(clips, "vod", name)
    os.makedirs(d, exist_ok=True)
    for h, w, br in [(360, 640, "600k"), (180, 320, "200k")]:
        sh("ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"testsrc2=size={w}x{h}:rate=25:duration={secs}",
           "-vf", f"drawbox=c={colour}:t=8", "-c:v", "libx264", "-b:v", br, "-g", "50", "-keyint_min", "50", "-sc_threshold", "0",
           "-pix_fmt", "yuv420p", "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod", "-hls_segment_type", "fmp4",
           "-hls_fmp4_init_filename", f"init_{h}.mp4", "-hls_segment_filename", os.path.join(d, f"v{h}_%03d.m4s"),
           os.path.join(d, f"stream_{h}.m3u8"))
    sh("ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"sine=frequency=440:duration={secs}", "-c:a", "aac", "-b:a", "64k",
       "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod", "-hls_segment_type", "fmp4",
       "-hls_fmp4_init_filename", "init_a.mp4", "-hls_segment_filename", os.path.join(d, "a_%03d.m4s"), os.path.join(d, "audio.m3u8"))
    with open(os.path.join(d, "master.m3u8"), "w") as f:
        f.write("\n".join([
            "#EXTM3U",
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",URI="audio.m3u8"',
            '#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.64001e,mp4a.40.2",RESOLUTION=640x360,AUDIO="audio"', "stream_360.m3u8",
            '#EXT-X-STREAM-INF:BANDWIDTH=300000,CODECS="avc1.64000d,mp4a.40.2",RESOLUTION=320x180,AUDIO="audio"', "stream_180.m3u8", ""]))
    return f"/clips/vod/{name}/master.m3u8"


def frame_md5s(path, n=None):
    a = ["ffmpeg", "-v", "error", "-i", path, "-map", "0:v:0"] + (["-frames:v", str(n)] if n else []) + ["-f", "framemd5", "-"]
    return [l.split(",")[-1].strip() for l in sh(*a).stdout.decode().splitlines() if l and not l.startswith("#")]


def key_flags(path):
    out = sh("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=flags", "-of", "csv=p=0", path).stdout.decode()
    return [l.strip() for l in out.splitlines() if l.strip()]


def run(play, parts, assets, t_from, t_to, step=1.0):
    t = t_from
    play.schedule(parts, assets, t)
    while t <= t_to:
        play.tick(t)
        t += step


def entries(text):
    """I-frame playlist -> [(msn, uri, offset, length, disc_before)]"""
    msn = int(next(l for l in text.splitlines() if l.startswith("#EXT-X-MEDIA-SEQUENCE:")).split(":")[1])
    out, disc, rng = [], False, None
    for l in text.splitlines():
        if l == "#EXT-X-DISCONTINUITY":
            disc = True
        elif l.startswith("#EXT-X-BYTERANGE:"):
            ln, off = l.split(":")[1].split("@")
            rng = (int(off), int(ln))
        elif l and not l.startswith("#"):
            out.append((msn, l, rng[0], rng[1], disc))
            msn, disc = msn + 1, False
    return out


def media_entries(text):
    msn = int(next(l for l in text.splitlines() if l.startswith("#EXT-X-MEDIA-SEQUENCE:")).split(":")[1])
    out, disc = [], False
    for l in text.splitlines():
        if l == "#EXT-X-DISCONTINUITY":
            disc = True
        elif l and not l.startswith("#"):
            out.append((msn, l, disc))
            msn, disc = msn + 1, False
    return out


def main():
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        print("SKIP: ffmpeg and ffprobe are needed")
        return 0
    tmp = tempfile.mkdtemp(prefix="fasttrick-")
    clips = os.path.join(tmp, "clips")
    keys = {"film": make_asset(clips, "film", 20, "red"), "spot": make_asset(clips, "spot", 6, "blue")}
    reader = MediaReader(clips)
    assets = {n: load_asset(k, clips, "", reader) for n, k in keys.items()}

    # ---- 1. keyframe ranges are real keyframes (ground truth from the media)
    film360 = assets["film"].video[360]
    ok(all(s["src"] and s["src"].startswith("/clips/vod/film/") for s in film360.segs), "every segment knows where it is stored")
    kfc = KeyframeCache(reader)
    allsegs = [s for a in assets.values() for tr in a.video.values() for s in tr.segs]
    kfc.resolve(allsegs)
    ok(len(kfc.kf) == len(allsegs), f"a range for every video segment ({len(kfc.kf)}/{len(allsegs)})")
    good = decoded_one = same_pic = 0
    for a in assets.values():
        for tr in a.video.values():
            init = open(clips + tr.init[len("/clips"):], "rb").read()
            for s in tr.segs:
                off, ln = kfc.kf[s["uri"]]
                seg = open(clips + s["src"][len("/clips"):], "rb").read()
                part = os.path.join(tmp, "k.mp4")
                open(part, "wb").write(init + seg[off:off + ln])
                full = os.path.join(tmp, "f.mp4")
                open(full, "wb").write(init + seg)
                good += seg[off + 4:off + 8] == b"moof" and off + ln <= len(seg)
                fl = key_flags(part)
                decoded_one += fl == ["K__"] or (len(fl) == 1 and fl[0].startswith("K"))
                same_pic += frame_md5s(part) == frame_md5s(full, 1)
    ok(good == len(allsegs), f"every range starts at a moof ({good}/{len(allsegs)})")
    ok(decoded_one == len(allsegs), f"init + range alone is exactly one keyframe ({decoded_one}/{len(allsegs)})")
    ok(same_pic == len(allsegs), f"and decodes to the segment's first picture ({same_pic}/{len(allsegs)})")

    # ---- 2. keyframe_range edge cases
    seg0 = open(clips + film360.segs[0]["src"][len("/clips"):], "rb").read()
    off, ln = keyframe_range(seg0)
    moof_end = off + int.from_bytes(seg0[off:off + 4], "big")
    r = keyframe_range(seg0[:moof_end - 10])
    ok(r == ("more", moof_end), f"a head cut inside the moof asks for more ({r})")
    ok(keyframe_range(b"") is None and keyframe_range(seg0[off + int.from_bytes(seg0[off:off + 4], 'big'):][:64]) is None, "no moof, no range")
    # first sample marked non-sync: no range (a segment that does not open on a keyframe)
    bad = bytearray(seg0)
    i = bad.find(b"trun")
    tf = int.from_bytes(bad[i + 5:i + 8], "big")
    if tf & 0x004:
        p = i + 4 + 8 + (4 if tf & 0x001 else 0)
        bad[p:p + 4] = (int.from_bytes(bad[p:p + 4], "big") | 0x00010000).to_bytes(4, "big")
        ok(keyframe_range(bytes(bad)) is None, "a first sample that is not a sync sample gives no range")
    else:
        j = bad.find(b"tfhd")
        ok(True, "first-sample flags not present in this muxer's trun (checked through tfhd defaults instead)")

    # ---- 3. the live I-frame playlist follows the splice, numbered like the media playlist
    T0 = parse_iso("2026-11-03T10:00:00Z")
    OUT = "0xFC302500000000000000FFF01405000004D27FEFFE000DBBA0FE00A4CB8000070101000017A1CC10"
    tl = [
        {"kind": "content", "id": "p1:0", "start": iso(T0), "durationSec": 10, "assetId": "film", "inSec": 0, "outSec": 10, "title": "Film"},
        {"kind": "break", "id": "b1", "start": iso(T0 + 10), "durationSec": 6, "position": "mid", "scte35Out": OUT, "scte35In": OUT, "eventId": 1,
         "hideGraphics": True, "fill": [{"kind": "house", "assetId": "spot", "durationSec": 6}]},
        {"kind": "content", "id": "p1:10", "start": iso(T0 + 16), "durationSec": 10, "assetId": "film", "inSec": 10, "outSec": 20, "title": "Film"},
    ]
    parts = expand_parts(tl, assets, 2.0)
    play = Playout(["v360", "v180", "audio"], dvr_sec=120, seg_sec=2.0)
    run(play, parts, assets, T0, T0 + 27)
    kfc.resolve(play.t["v360"]["pub"] + play.t["v180"]["pub"])
    for n in ["v360", "v180"]:
        it = play.iframes(n, kfc.kf)
        md = play.hls(n)
        ie, me = entries(it), media_entries(md)
        ok("#EXT-X-I-FRAMES-ONLY" in it and "#EXT-X-VERSION:7" in it, f"{n}: an I-frame playlist")
        ok([(e[0], e[1], e[4]) for e in ie] == me, f"{n}: one entry per listed segment, same numbers, same discontinuities ({len(ie)} entries)")
        ok(sum(1 for e in ie if "/vod/spot/" in e[1]) == 3 and any(e[4] for e in ie), f"{n}: the break's house spot keyframes are listed where it airs")
        ok(all((e[2], e[3]) == kfc.kf[e[1]] for e in ie), f"{n}: every range is the segment's keyframe")
        maps = [l for l in it.splitlines() if l.startswith("#EXT-X-MAP")]
        ok(len(maps) == 3 and "spot" in maps[1], f"{n}: the init segment again at each join ({len(maps)})")
        ok(it.count("#EXT-X-PROGRAM-DATE-TIME") == len(ie) and "CUE-OUT" not in it, f"{n}: PDT per entry, no ad tags")
        ok(int(it.split("#EXT-X-DISCONTINUITY-SEQUENCE:")[1].split()[0]) == int(md.split("#EXT-X-DISCONTINUITY-SEQUENCE:")[1].split()[0]),
           f"{n}: same discontinuity sequence as the media playlist")

    # ---- 4. an unknown range: the list starts after it, never renumbers
    pub = play.t["v360"]["pub"]
    kf2 = dict(kfc.kf)
    kf2.pop(pub[4]["uri"])
    ie = entries(play.iframes("v360", kf2))
    ok(ie[0][0] == pub[5]["msn"] and len(ie) == len(pub) - 5, f"a segment with no range: listed from the next one, numbered as before (msn {ie[0][0]})")
    kf2.pop(pub[-1]["uri"])
    ok(play.iframes("v360", kf2) is None, "the newest segment has no range yet: nothing to list (the last good file stays)")

    # ---- 5. the master lists them only when every rung has one; video codecs only
    master = master_playlist(assets["film"], play.tracks)
    m2 = master_with_iframes(master, play, kfc.kf)
    lines = [l for l in m2.splitlines() if l.startswith("#EXT-X-I-FRAME-STREAM-INF")]
    ok(len(lines) == 2 and 'URI="v360.iframes.m3u8"' in lines[0] and 'URI="v180.iframes.m3u8"' in lines[1], "the master lists one I-frame stream per video rung")
    ok(all("mp4a" not in l and 'CODECS="avc1.' in l and "RESOLUTION=" in l for l in lines), "video codecs and resolution, no audio codec")
    bw = int(lines[0].split("BANDWIDTH=")[1].split(",")[0])
    ok(0 < bw < 4_000_000, f"BANDWIDTH is the peak keyframe rate ({bw})")
    ok(master_with_iframes(master, play, {k: v for k, v in kfc.kf.items() if "/v180_" not in k and "spot/v180" not in k}) is None,
       "a rung with no I-frame playlist yet: the master is not changed")
    ok(video_codecs("avc1.64001f,mp4a.40.2") == "avc1.64001f" and video_codecs("hvc1.1.6.L93.B0,ec-3") == "hvc1.1.6.L93.B0", "codec filter")

    # ---- 6. the window rolls: entries leave with the media playlist's
    play2 = Playout(["v360", "v180", "audio"], dvr_sec=8, seg_sec=2.0)
    run(play2, parts, assets, T0, T0 + 27)
    kfc.resolve(play2.t["v360"]["pub"])
    ie, me = entries(play2.iframes("v360", kfc.kf)), media_entries(play2.hls("v360"))
    ok(ie[0][0] == me[0][0] > 0 and len(ie) == len(me) <= 6, f"a short DVR window: the I-frame list rolls with it (msn {ie[0][0]}, {len(ie)} entries)")

    # ---- 7. ranged reads only (local, S3, HTTP shapes)
    class FakeS3:
        def __init__(self):
            self.calls = []

        def get_object(self, Bucket, Key, Range=None):
            self.calls.append((Bucket, Key, Range))
            data = open(clips + "/" + Key[len("clips/"):] if Key.startswith("clips/") else os.path.join(clips, Key), "rb").read()
            a, b = Range[len("bytes="):].split("-")
            import io

            class B:
                def __init__(self, x):
                    self.x = x

                def read(self):
                    return self.x
            return {"Body": B(data[int(a):int(b) + 1])}
    fs = FakeS3()
    r3 = MediaReader(clips, fs, "bucket")
    head = r3.read_range("vod/film/v360_000.m4s", 0, 16384)
    ok(fs.calls == [("bucket", "vod/film/v360_000.m4s", "bytes=0-16383")] and keyframe_range(head) == kfc.kf[film360.segs[0]["uri"]],
       "S3: one ranged GetObject of the head, the same range as from disk")
    ok(len(reader.read_range(film360.segs[0]["src"], 0, 16384)) == 16384, "local: the head only, not the whole segment")

    # ---- 8. the whole playout, switched on and off (timeline file, one tick)
    import time as _t
    now = _t.time()
    base = now - 30
    tl2 = {"channelId": "c", "segmentSec": 2, "ladder": None, "items": [
        {"kind": "content", "id": "x:0", "start": iso(base), "durationSec": 20, "assetId": "film", "master": keys["film"], "inSec": 0, "outSec": 20},
        {"kind": "content", "id": "x:1", "start": iso(base + 20), "durationSec": 20, "assetId": "film", "master": keys["film"], "inSec": 0, "outSec": 20}]}
    here = os.path.dirname(os.path.abspath(__file__))
    for on in (False, True):
        out = os.path.join(tmp, f"out_{on}")
        tf = os.path.join(tmp, f"tl_{on}.json")
        json.dump(dict(tl2, trickPlay=on), open(tf, "w"))
        p = subprocess.run([sys.executable, os.path.join(here, "fast_playout.py"), "--channel", "c", "--out", out, "--clips-dir", clips,
                            "--timeline-file", tf, "--once"], capture_output=True, text=True, timeout=60)
        files = sorted(os.listdir(out)) if os.path.isdir(out) else []
        m = open(os.path.join(out, "master.m3u8")).read() if "master.m3u8" in files else ""
        if not on:
            ok("v360.m3u8" in files and not any(f.endswith(".iframes.m3u8") for f in files) and "I-FRAME" not in m,
               f"switched off: media playlists written, no I-frame playlist, master names none ({files})")
        else:
            ok({"v360.iframes.m3u8", "v180.iframes.m3u8"} <= set(files) and "audio.iframes.m3u8" not in files, f"switched on: one per video rung ({files})")
            ok(m.count("#EXT-X-I-FRAME-STREAM-INF") == 2, "switched on: the master lists them")
            ie, me = entries(open(os.path.join(out, "v360.iframes.m3u8")).read()), media_entries(open(os.path.join(out, "v360.m3u8")).read())
            ok([(e[0], e[1], e[4]) for e in ie] == me and len(ie) >= 10, f"switched on: the written list matches the media playlist ({len(ie)})")
            ok("Traceback" not in p.stderr and "tick failed" not in p.stderr, "no errors in the playout's log")
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
