"""Checks for the shared edge tokens in fast_playout.py (build queue P2-2f-2).

Where the CDN enforces play tokens, a FAST channel's playlists must name each
title's segments through the shared token the control plane puts in the
timeline (`edgeTokens.byAsset`). Synthetic assets on a simulated clock: HLS
media playlists, I-frame playlists and the DASH MPD carry /t/<token> in front
of every segment and init address in a named title's folder, root-relative
and on the CDN; a folder the timeline names no token for (a prepared loop, an
ad creative) is left plain; tokens off leaves every address as before; a
rotation moves the whole window to the new token; state stays plain.

    python3 bin/test_fast_edge_tokens.py
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from fast_playout import Playout, AssetMedia, expand_parts, parse_iso, iso, edge_uri  # noqa: E402

PASS = FAIL = 0


def ok(c, m):
    global PASS, FAIL
    if c:
        PASS += 1
        print("PASS " + m)
    else:
        FAIL += 1
        print("FAIL " + m)


A = "11111111-1111-4111-8111-111111111111"
B = "22222222-2222-4222-8222-222222222222"
TA, TB, TA2 = "eyJrIjoic2hhcmVkIn0.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "eyJrIjoiYiJ9.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "eyJrIjoibmV4dCJ9.cccccccccccccccccccccccccccccccc"


def synth(folder, secs, seg=2.0):
    n = int(secs // seg)

    def media(prefix):
        L = ["#EXTM3U", "#EXT-X-PLAYLIST-TYPE:VOD", f'#EXT-X-MAP:URI="{prefix}/init.mp4"']
        for i in range(n):
            L += [f"#EXTINF:{seg:.3f},", f"{prefix}/seg_{i + 1}.m4s"]
        return "\n".join(L + ["#EXT-X-ENDLIST"])
    master = "\n".join(["#EXTM3U", '#EXT-X-STREAM-INF:BANDWIDTH=2600000,CODECS="avc1.64001f",RESOLUTION=1280x720', "stream_1.m3u8"])
    mpd = ('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period><AdaptationSet contentType="video">'
           '<Representation id="0" bandwidth="2600000" codecs="avc1.64001f" mimeType="video/mp4" width="1280" height="720">'
           f'<SegmentTemplate timescale="1000" initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number%05d$.m4s" startNumber="1">'
           f'<SegmentTimeline><S t="0" d="{int(seg * 1000)}" r="{n - 1}"/></SegmentTimeline></SegmentTemplate>'
           '</Representation></AdaptationSet></Period></MPD>')
    return AssetMedia(master, {"stream_1.m3u8": media("720p")}, folder, mpd)


assets = {A: synth(f"/clips/vod/{A}/", 40), B: synth(f"https://cdn.example.net/vod/{B}/", 40), "loop": synth("/origin/chan/filler/prebuilt/", 10)}
T0 = parse_iso("2026-11-11T20:00:00Z")
timeline = [
    {"kind": "content", "id": "a", "start": iso(T0), "durationSec": 40, "assetId": A, "inSec": 0, "outSec": 40, "title": "A"},
    {"kind": "filler", "id": "pad", "start": iso(T0 + 40), "durationSec": 10, "fill": [{"kind": "slate", "assetId": "loop", "durationSec": 10}]},
    {"kind": "content", "id": "b", "start": iso(T0 + 50), "durationSec": 40, "assetId": B, "inSec": 0, "outSec": 40, "title": "B"},
]

# ------------------------------------------------------------------ the rewrite
ok(edge_uri(f"/clips/vod/{A}/720p/seg_1.m4s", {A: TA}) == f"/t/{TA}/clips/vod/{A}/720p/seg_1.m4s", "root-relative: the token goes in front of the path")
ok(edge_uri(f"https://cdn.example.net/vod/{B}/720p/seg_1.m4s", {B: TB}) == f"https://cdn.example.net/t/{TB}/vod/{B}/720p/seg_1.m4s", "on the CDN: after the host")
ok(edge_uri(f"/vod/{B.upper()}/x.m4s", {B: TB}) == f"/t/{TB}/vod/{B.upper()}/x.m4s", "an upper-case id in the path finds its token")
ok(edge_uri(f"/clips/{A}/hls/seg_1.ts", {A: TA}) == f"/t/{TA}/clips/{A}/hls/seg_1.ts", "a clip's own folder too")
ok(edge_uri(f"/clips/vod/{B}/x.m4s", {A: TA}) == f"/clips/vod/{B}/x.m4s", "a title no token names: as it is")
ok(edge_uri("/origin/chan/filler/prebuilt/720p/seg_1.m4s", {A: TA}) == "/origin/chan/filler/prebuilt/720p/seg_1.m4s", "not a title's folder: as it is")
ok(edge_uri(f"/clips/vod/{A}/x.m4s", {}) == f"/clips/vod/{A}/x.m4s" and edge_uri(None, {A: TA}) is None, "tokens off or nothing to write: as it is")

# ------------------------------------------------------------------ the playlists
parts = expand_parts(timeline, assets, 2.0)
play = Playout(["v720"], dvr_sec=120, seg_sec=2.0)
t = T0
while t <= T0 + 90:
    play.schedule(parts, assets, t)
    play.tick(t)
    t += 1.0
plain = play.hls("v720")
play.edge = {A: TA, B: TB}
h = play.hls("v720")
segs = [l for l in h.splitlines() if l and not l.startswith("#")]
maps = re.findall(r'#EXT-X-MAP:URI="([^"]+)"', h)
ok(segs and all(s.startswith(f"/t/{TA}/clips/vod/{A}/") for s in segs if A in s) and any(A in s for s in segs), "HLS: every segment of title A carries A's token")
ok(all(s.startswith(f"https://cdn.example.net/t/{TB}/vod/{B}/") for s in segs if B in s) and any(B in s for s in segs), "HLS: title B's, on the CDN, carry B's")
ok(any("/origin/chan/filler/prebuilt/" in s for s in segs) and all(s.startswith("/origin/") for s in segs if "prebuilt" in s), "HLS: the loop between them stays plain")
ok(all(("/t/" in m) == ("prebuilt" not in m) for m in maps) and len(maps) >= 3, "HLS: init segments the same way")
ok(h.replace(f"/t/{TA}", "").replace(f"/t/{TB}", "") == plain, "HLS: nothing else changes (numbers, times, tags)")
ok("/t/" not in str(play.state()) and all("/t/" not in s["uri"] for s in play.t["v720"]["pub"]), "state and the published list keep plain addresses")
kf = {s["uri"]: (0, 100) for s in play.t["v720"]["pub"]}
ifr = play.iframes("v720", kf)
ok(ifr and all(l.startswith(f"/t/{TA}/") for l in ifr.splitlines() if A in l and not l.startswith("#")), "I-frame playlist: the token too, ranges found by the plain address")
mpd = play.dash(assets, T0 + 90)
ok(mpd and f'initialization="/t/{TA}/clips/vod/{A}/init-0.m4s"' in mpd and f'media="https://cdn.example.net/t/{TB}/vod/{B}/chunk-0-$Number%05d$.m4s"' in mpd,
   "DASH: each Period's templates carry their title's token")
ok('initialization="/origin/chan/filler/prebuilt/init-0.m4s"' in mpd, "DASH: the loop's Period stays plain")
play.edge = {A: TA2, B: TB}
h2 = play.hls("v720")
ok(TA not in h2 and h2.count(f"/t/{TA2}/") == h.count(f"/t/{TA}/"), "a rotation: the whole window moves to the new token at once")
play.edge = {}
ok(play.hls("v720") == plain and "/t/" not in play.dash(assets, T0 + 90), "tokens off: every address as before")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
