#!/usr/bin/env python3
"""Trick-play on live channels and events (build queue 3.2b-3). Offline.

WHAT THIS GUARDS:
  * With the output profile's switch on (cfg trick_play), every VIDEO stream the
    packager writes gets an I-frame playlist beside the master, named after its
    rendition; audio streams never do. Off, the packager command is exactly what it
    was before 3.2b-3.
  * A rendition label from a package-only input cannot put a path or a quote into
    the packager's descriptor.
  * The delivered master (master_cc.m3u8) keeps the packager's I-frame lines, and
    while playout splices breaks and slates in never names the packager's (they
    index its own segments, so a scrubbing viewer would see the programme under a
    break); the delivered ones that follow the splice (3.2b-7) are checked in
    test_splice_trick_play.py.

  * DASH trick-mode (3.2b-4, cfg trick_play_dash): one keyframe-only stream,
    cut from one small rendition, DASH only; off, nothing changes. The spliced
    MPD playout writes is built from the HLS media playlists, which this stream
    has none of, so it never appears under a break or slate (checked below).

Run: python3 test_trick_play.py   (from volt-encoder/dev)
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bin"))
import encoder  # noqa: E402

p = f = 0


def ok(c, m):
    global p, f
    if c:
        p += 1
        print("PASS", m)
    else:
        f += 1
        print("FAIL", m)


def cfg(**kw):
    c = {"segment_seconds": 4, "channel_id": "c1", "workflow": "transcode",
         "ladder": [{"height": 720, "bitrate_kbps": 3000}, {"height": 360, "bitrate_kbps": 800}],
         "dvr_seconds": 300}
    c.update(kw)
    return c


encoder.audio_tracks = lambda c: [{"lang": "eng", "name": "English"}]

print("== the packager command ==")
off = encoder.build_shaka(cfg(), None)
on = encoder.build_shaka(cfg(trick_play=True), None)
vid_on = [a for a in on if "stream=video" in a]
aud_on = [a for a in on if "stream=audio" in a]
ok(not any("iframe_playlist_name" in a for a in off), "off (the default): no I-frame playlist asked for")
ok(len(vid_on) == 2 and all("iframe_playlist_name=" in a for a in vid_on), "on: every video stream gets one")
ok("iframe_playlist_name=720p.iframes.m3u8" in vid_on[0] and "iframe_playlist_name=360p.iframes.m3u8" in vid_on[1],
   "named after the rendition, beside the master")
ok(aud_on and not any("iframe_playlist_name" in a for a in aud_on), "audio streams never get one")
ok([a.split(",iframe_playlist_name=")[0] for a in on] == off, "otherwise the command is unchanged")
ok(encoder.build_shaka(cfg(trick_play=False), None) == off, "trick_play false is the same as absent")
ok(encoder.iframe_playlist_name('1080p "main",x/../y') == "1080p__main__x____y.iframes.m3u8",
   "a label cannot carry a quote, a comma or a path into the descriptor")
ok(encoder.iframe_playlist_name("") == "video.iframes.m3u8", "an empty label still gives a name")

print("\n== DASH trick-mode on live (3.2b-4) ==")
dash = encoder.build_shaka(cfg(trick_play_dash=True), None)
tr = [a for a in dash if "trick_play_factor" in a]
ok(not any("trick_play_factor" in a for a in off + on), "off, or HLS only: no trick-mode stream")
ok(len(tr) == 1, "on: exactly one trick-mode stream, not one per rendition (only its keyframes are new bytes)")
ok(tr and "trick_play_factor=1" in tr[0] and "dash_only=1" in tr[0] and "stream=video" in tr[0],
   "every keyframe, video, DASH only (HLS already has its I-frame playlists)")
ok(tr and tr[0].startswith(f"in={encoder.udp_out(1)},") and "/360p_trick/init.mp4" in tr[0]
   and "/360p_trick/seg_$Number$.m4s" in tr[0], "cut from the 360p rung (the smallest at least 360p), into its own folder")
ok([a for a in dash if "trick_play_factor" not in a] == off, "otherwise the command is unchanged")
ok(not any("iframe_playlist_name" in a for a in dash), "DASH trick-mode alone asks for no HLS I-frame playlist")
both = encoder.build_shaka(cfg(trick_play=True, trick_play_dash=True), None)
ok([a for a in both if "trick_play_factor" not in a] == on and len(both) == len(on) + 1, "both: the HLS command plus the one trick stream")
rends = lambda c: [(i, f"{r['height']}p", False) for i, r in enumerate(c["ladder"])]
c3 = cfg(ladder=[{"height": 1080}, {"height": 720}, {"height": 540}, {"height": 234}])
ok(encoder.trick_rendition(c3, rends(c3))[1] == "540p", "a 234p rung is passed over for the smallest at least 360p")
c4 = cfg(ladder=[{"height": 288}, {"height": 216}])
ok(encoder.trick_rendition(c4, rends(c4))[1] == "216p", "no rung at least 360p: the smallest")
pk = cfg(workflow="package_only")
pin = [{"rendition_label": "hd", "rendition_bitrate_kbps": 6000}, {"rendition_label": "sd", "rendition_bitrate_kbps": 1500},
       {"rendition_label": "mid", "rendition_bitrate_kbps": 3000}]
encoder_primary = encoder.primary_inputs
encoder.primary_inputs = lambda c: pin
pr = [(0, "hd", True), (1, "sd", False), (2, "mid", False)]
ok(encoder.trick_rendition(pk, pr)[1] == "sd", "package-only: the lowest bitrate input")
pin[:] = [{"rendition_label": "a"}, {"rendition_label": "b"}]
ok(encoder.trick_rendition(pk, [(0, "a", True), (1, "b", False)])[1] == "b", "package-only, no bitrates: the last input")
pin[:] = [{"rendition_label": 'x/../"y",z', "rendition_bitrate_kbps": 900}]
pkc = encoder.build_shaka(cfg(workflow="package_only", trick_play_dash=True), None)
ptr = [a for a in pkc if "trick_play_factor" in a]
ok(len(ptr) == 1 and "/x_____y__z_trick/" in ptr[0] and '"' not in ptr[0], "a package-only label cannot put a path or a quote into the trick folder")
encoder.primary_inputs = encoder_primary
ok(encoder.trick_rendition(cfg(), []) is None, "no video rendition: none")

print("\n== the delivered master ==")
MASTER = """#EXTM3U
## Generated with https://github.com/shaka-project/shaka-packager version v3.2.0
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,URI="stream_2.m3u8",GROUP-ID="audio",NAME="English",DEFAULT=YES,AUTOSELECT=YES
#EXT-X-STREAM-INF:BANDWIDTH=3300000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720,AUDIO="audio"
stream_0.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=900000,CODECS="avc1.64001e,mp4a.40.2",RESOLUTION=640x360,AUDIO="audio"
stream_1.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=410000,CODECS="avc1.64001f",RESOLUTION=1280x720,URI="720p.iframes.m3u8"
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=120000,CODECS="avc1.64001e",RESOLUTION=640x360,URI="360p.iframes.m3u8"
"""
MEDIA = "#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-MAP:URI=\"720p/init.mp4\"\n#EXTINF:4.000,\n720p/seg_1.m4s\n"


def out_dir():
    d = tempfile.mkdtemp()
    open(os.path.join(d, "master.m3u8"), "w").write(MASTER)
    for n in ("stream_0.m3u8", "stream_1.m3u8", "stream_2.m3u8"):
        open(os.path.join(d, n), "w").write(MEDIA)
    return d


encoder._pdt_companion_playlist = lambda text, d, seg: text
encoder._with_triggers = lambda text: text
d = out_dir()
encoder._PLAYOUT = None
encoder._write_companion(d, [], None, 4)
cc = open(os.path.join(d, "master_cc.m3u8")).read()
iframes = [l for l in cc.splitlines() if l.startswith("#EXT-X-I-FRAME-STREAM-INF")]
ok(len(iframes) == 2 and 'URI="720p.iframes.m3u8"' in iframes[0] and 'URI="360p.iframes.m3u8"' in iframes[1],
   "without playout the delivered master lists both I-frame playlists as the packager wrote them")
ok("stream_0_cc.m3u8" in cc, "(and its variants are the delivered companions)")

d = out_dir()
encoder._PLAYOUT = object()
encoder._playout_pass = lambda od, src, seg: {"stream_0.m3u8": "stream_0_cc.m3u8", "stream_1.m3u8": "stream_1_cc.m3u8", "stream_2.m3u8": "stream_2_cc.m3u8"}
encoder._write_companion(d, [], None, 4)
cc = open(os.path.join(d, "master_cc.m3u8")).read()
ok("I-FRAME" not in cc, "with playout splicing and no delivered I-frame playlist yet, the master lists none (3.2b-7 lists the delivered ones: test_splice_trick_play.py)")
ok("stream_0_cc.m3u8" in cc and "stream_2_cc.m3u8" in cc, "(its spliced variants and audio are still listed)")
encoder._PLAYOUT = None

print("\n== the delivered MPD (3.2b-4) ==")
PKG_MPD = """<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" availabilityStartTime="1970-01-01T00:00:00Z" minimumUpdatePeriod="PT4S"><Period id="0" start="PT0S">\
<AdaptationSet id="0" contentType="video"><Representation id="0" bandwidth="3000000" codecs="avc1.64001f" width="1280" height="720"><SegmentTemplate timescale="90000" initialization="720p/init.mp4" media="720p/seg_$Number$.m4s" startNumber="1"/></Representation>\
<Representation id="1" bandwidth="800000" codecs="avc1.64001e" width="640" height="360"><SegmentTemplate timescale="90000" initialization="360p/init.mp4" media="360p/seg_$Number$.m4s" startNumber="1"/></Representation></AdaptationSet>\
<AdaptationSet id="1" contentType="video" maxWidth="640" maxHeight="360"><EssentialProperty schemeIdUri="http://dashif.org/guidelines/trickmode" value="0"/><Representation id="3" bandwidth="120000" codecs="avc1.64001e" width="640" height="360" maxPlayoutRate="1"><SegmentTemplate timescale="90000" initialization="360p_trick/init.mp4" media="360p_trick/seg_$Number$.m4s" startNumber="1"/></Representation></AdaptationSet>\
<AdaptationSet id="2" contentType="audio" lang="en"><Representation id="2" bandwidth="128000" codecs="mp4a.40.2"><SegmentTemplate timescale="48000" initialization="audio/init.mp4" media="audio/seg_$Number$.m4s" startNumber="1"/></Representation></AdaptationSet>\
</Period></MPD>
"""
d = tempfile.mkdtemp()
open(os.path.join(d, "manifest.mpd"), "w").write(PKG_MPD)
encoder._TRIGGERS = None
encoder._write_companion_mpd(d, [], 4, 0)
cc_mpd = open(os.path.join(d, "manifest_cc.mpd")).read()
ok("dashif.org/guidelines/trickmode" in cc_mpd and "360p_trick/seg_$Number$.m4s" in cc_mpd,
   "without playout the delivered MPD keeps the packager's trick-mode set")

# With playout on, manifest_cc.mpd is the spliced MPD playout builds from the HLS
# media playlists (one track each). The trick stream is dash_only, so it has no
# playlist and is listed from the packager's MPD instead (build queue 3.2b-8, see
# test_splice_trick_dash.py). Driven here exactly as the encoder drives it, with
# the packager's MPD above as the source of every attribute: it names no trick
# SEGMENTS (no SegmentTimeline) and the loop's keyframes are not prepared, so
# nothing may be listed for it: never a guessed segment.
import playout as P  # noqa: E402
SEGD = 4.0


def hls(label, first, last):
    out = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-TARGETDURATION:4", f'#EXT-X-MAP:URI="{label}/init.mp4"']
    for n in range(first, last + 1):
        out += [f"#EXTINF:{SEGD:.3f},", f"{label}/seg_{n}.m4s"]
    return "\n".join(out) + "\n"


def fil(label):
    ts = 48000 if label == "audio" else 12800
    return {"init": f"filler/{label}/init.mp4", "timescale": ts,
            "segments": [{"uri": f"filler/{label}/seg_{i}.m4s", "dur": SEGD, "d": int(SEGD * ts)} for i in (1, 2, 3)]}


E0 = 1_000_000.0
pdt = lambda uri: E0 + (P._seg_key(uri) - 1) * SEGD
po = P.Playout({"720p": fil("720p"), "360p": fil("360p"), "audio": fil("audio")}, window_sec=120, hold_sec=2.4, pdt_of=pdt)
po.media_of = lambda uri: (int(round((pdt(uri) - E0 + 10) * 90000)), int(SEGD * 90000), 90000)
po.on_slot = lambda *a: None
po.on_drop = lambda *a: None
now, last, nxt = 0.0, 0, SEGD
for sec in range(100):
    now += 1.0
    up = not (40 <= sec < 70)            # the source drops for 30 s: the loop is spliced in
    if not up:
        nxt = now + SEGD
    elif now >= nxt:
        last += 1
        nxt += SEGD
    if last:
        first = max(1, last - 20)
        po.update(now, {"stream_0.m3u8": hls("720p", first, last), "stream_1.m3u8": hls("360p", first, last),
                        "stream_2.m3u8": hls("audio", first, last)}, "stream_0.m3u8")
encoder._MPD_INFO.update(mtime=None, by_init={})
encoder._PLAYOUT = po
spliced = po.render_mpd(lambda t: f"T{t:.3f}", encoder._mpd_reps(d), SEGD, now, trick=encoder._mpd_trick(d, SEGD))
kinds = [k for _, k, _, _ in po.periods()]
ok(spliced and "filler" in kinds, "(the spliced MPD has a loop Period: %s)" % kinds)
ok(spliced and "trickmode" not in spliced and "_trick/" not in spliced,
   "with playout splicing and no trick segments named or loop keyframes made, no trick-mode set is listed in any Period")
ok(spliced and "720p/seg_$Number$.m4s" in spliced and 'height="360"' in spliced,
   "(its main video, read from the same packager MPD, is still there)")

print(f"\ntest_trick_play: {p} passed, {f} failed")
sys.exit(1 if f else 0)
