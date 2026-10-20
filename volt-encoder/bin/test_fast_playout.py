"""Checks for fast_playout.py: a VOD-built live channel, on a simulated clock.

Uses real packaged assets when FAST_LAB is set (a clips dir made by vod_encoder.py,
see volt-app/docs/DESIGN_fast_channels.md, "Checking it"); otherwise synthetic
playlists with the same shape (2 s video, audio on its own grid, init per rendition).

    python3 bin/test_fast_playout.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from fast_playout import (Playout, AssetMedia, expand_parts, parse_iso, iso, master_playlist, load_asset, parse_media_playlist)  # noqa: E402

PASS = FAIL = 0


def ok(c, m):
    global PASS, FAIL
    if c:
        PASS += 1
        print("PASS " + m)
    else:
        FAIL += 1
        print("FAIL " + m)


def synth(name, secs, seg=2.0):
    """A packaged asset: two video rungs, audio with a short first segment and its own grid."""
    def media(prefix, durs):
        L = ["#EXTM3U", "#EXT-X-PLAYLIST-TYPE:VOD", f'#EXT-X-MAP:URI="{prefix}/init.mp4"']
        for i, d in enumerate(durs):
            L += [f"#EXTINF:{d:.3f},", f"{prefix}/seg_{i + 1}.m4s"]
        return "\n".join(L + ["#EXT-X-ENDLIST"])
    n = int(secs // seg)
    vd = [seg] * n + ([secs - n * seg] if secs - n * seg > 0.01 else [])
    ad = [2.005] * int(secs // 2.005) + [round(secs - int(secs // 2.005) * 2.005, 3)]
    ad = [d for d in ad if d > 0.001]
    master = "\n".join(["#EXTM3U", '#EXT-X-MEDIA:TYPE=AUDIO,URI="stream_2.m3u8",GROUP-ID="audio",NAME="Audio"',
                        '#EXT-X-STREAM-INF:BANDWIDTH=2600000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720,AUDIO="audio"', "stream_1.m3u8",
                        '#EXT-X-STREAM-INF:BANDWIDTH=900000,CODECS="avc1.64001e,mp4a.40.2",RESOLUTION=640x360,AUDIO="audio"', "stream_0.m3u8"])
    return AssetMedia(master, {"stream_1.m3u8": media("720p", vd), "stream_0.m3u8": media("360p", vd), "stream_2.m3u8": media("audio", ad)},
                      f"/clips/vod/{name}/")


LAB = os.environ.get("FAST_LAB")
if LAB:
    assets = {n: load_asset(f"/clips/vod/{n}/master.m3u8", LAB, "") for n in ["filmA", "filmB", "promo", "slate"]}
else:
    assets = {"filmA": synth("filmA", 60), "filmB": synth("filmB", 46), "promo": synth("promo", 10), "slate": synth("slate", 6)}

T0 = parse_iso("2026-10-20T10:00:00Z")
OUT = "0xFC302500000000000000FFF01405000004D27FEFFE000DBBA0FE00A4CB8000070101000017A1CC10"
timeline = [
    {"kind": "content", "id": "p1:0", "start": iso(T0), "durationSec": 20, "assetId": "filmA", "inSec": 0, "outSec": 20, "title": "Film A"},
    {"kind": "break", "id": "b1", "start": iso(T0 + 20), "durationSec": 30, "position": "mid", "scte35Out": OUT, "scte35In": OUT, "eventId": 1,
     "hideGraphics": True, "fill": [{"kind": "house", "assetId": "promo", "durationSec": 10}, {"kind": "slate", "assetId": "slate", "durationSec": 20}]},
    {"kind": "content", "id": "p1:20", "start": iso(T0 + 50), "durationSec": 40, "assetId": "filmA", "inSec": 20, "outSec": 60, "title": "Film A"},
    {"kind": "filler", "id": "p1:pad", "start": iso(T0 + 90), "durationSec": 10, "fill": [{"kind": "house", "assetId": "promo", "durationSec": 10}]},
    {"kind": "content", "id": "p2:0", "start": iso(T0 + 100), "durationSec": 46, "assetId": "filmB", "inSec": 0, "outSec": 46, "title": "Film B"},
    {"kind": "content", "id": "p3:0", "start": iso(T0 + 146), "durationSec": 60, "assetId": "filmA", "inSec": 0, "outSec": 60, "title": "Film A again"},
]
parts = expand_parts(timeline, assets, 2.0)
ok([p["key"] for p in parts] == ["p1:0", "b1:f0", "b1:f1:0", "b1:f1:1", "b1:f1:2", "b1:f1:3", "p1:20", "p1:pad:f0", "p2:0", "p3:0"],
   f"parts: content, break (promo + 6 s slate looped to 20 s: 6+6+6+2), content, pad, content ({[p['key'] for p in parts]})")
ok(parts[1].get("break_open") and parts[5].get("break_close") and parts[2].get("break") and not parts[6].get("break"), "break open/close marked; a pad is not a break")

tracks = ["v720", "v360", "audio"]


def run(play, t_from, t_to, step=1.0, resched=20, seen=None, check=True):
    seen = seen if seen is not None else {n: {} for n in tracks}
    good = {"consistent": True, "contiguous": True, "pdt": True}
    t = t_from
    last_sched = None
    while t <= t_to:
        if last_sched is None or t - last_sched >= resched:
            play.schedule(parts, assets, t)
            last_sched = t
        play.tick(t)
        for n in tracks:
            txt = play.hls(n)
            if not txt:
                continue
            msn = dsn = None
            entries, d, disc, pdt = [], None, False, None
            for l in txt.splitlines():
                if l.startswith("#EXT-X-MEDIA-SEQUENCE:"):
                    msn = int(l.split(":")[1])
                elif l.startswith("#EXT-X-DISCONTINUITY-SEQUENCE:"):
                    dsn = int(l.split(":")[1])
                    d = dsn
                elif l == "#EXT-X-DISCONTINUITY":
                    disc = True
                elif l.startswith("#EXT-X-PROGRAM-DATE-TIME:"):
                    pdt = parse_iso(l.split(":", 1)[1])
                elif l and not l.startswith("#"):
                    if disc:
                        d += 1
                    entries.append((msn + len(entries), l, d, pdt))
                    disc = False
            for k, (m, u, dd, p) in enumerate(entries):
                prev = seen[n].get(m)
                if prev and (prev[0] != u or prev[1] != dd or abs(prev[2] - p) > 0.001):
                    good["consistent"] = False
                seen[n].setdefault(m, (u, dd, p))
        t += step
    return seen, good


play = Playout(tracks, dvr_sec=30, seg_sec=2.0)
seen, good = run(play, T0 + 1, T0 + 150)
ok(good["consistent"], "every refresh agrees on each media sequence number (same segment, discontinuity number, PDT)")
for n in tracks:
    ms = sorted(seen[n])
    ok(ms == list(range(ms[0], ms[-1] + 1)), f"{n}: media sequence contiguous, no gaps ({ms[0]}..{ms[-1]})")
order = [seen["v720"][m][0] for m in sorted(seen["v720"])]
filmA = [u for u in order if "/filmA/" in u]
ok(filmA[:30] == [f"/clips/vod/filmA/720p/seg_{i}.m4s" for i in range(1, 31)], "Film A plays every segment once, in order, across its break")
ok(order.count("/clips/vod/filmB/720p/seg_23.m4s") == 1, "Film B plays through to its last segment")
i_brk = order.index("/clips/vod/promo/720p/seg_1.m4s")
ok(order[i_brk - 1] == "/clips/vod/filmA/720p/seg_10.m4s" and order[i_brk + 5] == "/clips/vod/slate/720p/seg_1.m4s", "the break starts after segment 10 (20 s): promo, then slate")
ok(order.count("/clips/vod/slate/720p/seg_1.m4s") >= 3, "the slate loops to fill the break")
pd = [seen["v720"][m][2] for m in sorted(seen["v720"])]
ok(all(b > a for a, b in zip(pd, pd[1:])), "PDT strictly increasing on the lead track")
ok(abs(seen["v720"][sorted(seen["v720"])[order.index("/clips/vod/filmA/720p/seg_11.m4s")]][2] - (T0 + 50)) < 0.01, "content resumes at the scheduled 10:00:50")
ok(abs(seen["v720"][sorted(seen["v720"])[order.index("/clips/vod/filmB/720p/seg_1.m4s")]][2] - (T0 + 100)) < 0.01, "Film B starts at the scheduled 10:01:40")

# audio and video agree at every join
def pdt_of(n, uri):
    for m, v in seen[n].items():
        if v[0] == uri:
            return v[2]
ok(abs(pdt_of("audio", "/clips/vod/filmB/audio/seg_1.m4s") - pdt_of("v720", "/clips/vod/filmB/720p/seg_1.m4s")) < 0.1, "audio and video start Film B together")
ok(abs(pdt_of("audio", "/clips/vod/promo/audio/seg_1.m4s") - pdt_of("v720", "/clips/vod/promo/720p/seg_1.m4s")) < 0.1, "and the break")
# discontinuity numbers match across tracks at the same part
dv = seen["v720"][sorted(seen["v720"])[order.index("/clips/vod/filmB/720p/seg_1.m4s")]][1]
da = next(v[1] for v in seen["audio"].values() if v[0] == "/clips/vod/filmB/audio/seg_1.m4s")
ok(dv == da, f"the same discontinuity number on video and audio at a join ({dv}, {da})")

# tags
txt_at_break = None
p2 = Playout(tracks, dvr_sec=60, seg_sec=2.0)
p2.schedule(parts, assets, T0 + 30)
p2.tick(T0 + 30)
p2.tick(T0 + 54)
h = p2.hls("v720")
ok('CLASS="com.boomlabs.volt.ad"' in h and "SCTE35-OUT=0xFC30" in h and 'X-HIDE-GRAPHICS="all"' in h, "break DATERANGE with SCTE35-OUT and the graphics-hide flag")
ok("#EXT-X-CUE-OUT:DURATION=30.000" in h and "#EXT-X-CUE-OUT-CONT:ElapsedTime=" in h and "#EXT-X-CUE-IN" in h, "CUE-OUT, CUE-OUT-CONT, CUE-IN")
lines = h.splitlines()
ci = lines.index("#EXT-X-CUE-IN")
ok(any("filmA/720p/seg_11" in x for x in lines[ci:ci + 5]), "CUE-IN sits on the first segment back in the film")
ok(h.count("#EXT-X-DISCONTINUITY\n") >= 5, "a discontinuity at every part join")
ok(h.count("#EXT-X-MAP:") >= 5, "a new init segment at every part join")

# triggers are written, but not a second copy of the break
trig = [{"graphic": "up-next", "start": iso(T0 + 40), "duration": 12, "hls": '#EXT-X-DATERANGE:ID="up-next:p1",CLASS="com.boomlabs.volt.graphic",START-DATE="' + iso(T0 + 40) + '",DURATION=12.000'},
        {"graphic": "ad-break", "start": iso(T0 + 20), "duration": 30, "hls": '#EXT-X-DATERANGE:ID="brk:b1",CLASS="com.boomlabs.volt.ad"'}]
h2 = p2.hls("v720", trig)
ok("up-next:p1" in h2 and h2.count('#EXT-X-DATERANGE:ID="brk:b1"') == 1, "in-stream triggers written, the break only once")

# restart: a new process with the saved state continues the numbering
st = json.loads(json.dumps(play.state()))
before = max(seen["v720"])
p3 = Playout(tracks, dvr_sec=30, seg_sec=2.0, state=st)
seen3, good3 = run(p3, T0 + 151, T0 + 210, seen=seen)
after = sorted(m for m in seen3["v720"] if m > before)
ok(good3["consistent"] and after and after[0] == before + 1, f"after a restart the media sequence carries on ({before} -> {after[0] if after else None})")
ok(seen3["v720"][after[0]][0] != seen["v720"][before][0], "and does not repeat the last segment")

# master
m = master_playlist(assets["filmA"], tracks)
ok("v720.m3u8" in m and "v360.m3u8" in m and 'URI="audio.m3u8"' in m and "RESOLUTION=1280x720" in m, "master lists the rungs and the audio")

# DASH
mpd = p2.dash(assets, T0 + 54)
import xml.etree.ElementTree as ET
if assets["filmA"].dash:
    root = ET.fromstring(mpd)
    ns = {"d": "urn:mpeg:dash:schema:mpd:2011"}
    pers = root.findall("d:Period", ns)
    ok(len(pers) >= 4, f"DASH: one Period per part ({len(pers)})")
    ok(root.get("type") == "dynamic" and root.get("availabilityStartTime"), "DASH: dynamic, with availabilityStartTime")
    sc = [e for e in root.iter("{urn:mpeg:dash:schema:mpd:2011}EventStream") if e.get("schemeIdUri") == "urn:scte:scte35:2014:xml+bin"]
    ok(len(sc) == 1, "DASH: SCTE-35 EventStream on the break's first period")
    starts = [float(pp.get("start")[2:-1]) for pp in pers]
    ok(all(b > a for a, b in zip(starts, starts[1:])), "DASH: periods in order")
else:
    ok(mpd is not None, "DASH: written (synthetic assets have no MPD; run with FAST_LAB for the full DASH checks)")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
