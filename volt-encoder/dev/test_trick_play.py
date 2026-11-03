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
    drops them while playout splices breaks and slates in: the I-frame playlists
    index the packager's own segments, so a scrubbing viewer would see the
    programme under a break.

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
ok("I-FRAME" not in cc, "with playout splicing, the delivered master lists no I-frame playlist")
ok("stream_0_cc.m3u8" in cc and "stream_2_cc.m3u8" in cc, "(its spliced variants and audio are still listed)")
encoder._PLAYOUT = None

print(f"\ntest_trick_play: {p} passed, {f} failed")
sys.exit(1 if f else 0)
