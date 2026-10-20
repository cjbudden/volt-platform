#!/usr/bin/env python3
"""Radio's delivered copies with in-stream triggers (radio.py refresh_delivered).

The playlists are the shape ffmpeg writes for a station (checked against a real
run of radio.py on 20 Oct 2026): HLS with PROGRAM-DATE-TIME between #EXTINF and
the segment, and a dynamic DASH MPD with availabilityStartTime. Usage:
    python3 volt-encoder/bin/test_radio_triggers.py
"""
import os
import sys
import tempfile
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(__file__))
import radio  # noqa: E402
import timed_events as te  # noqa: E402

ok = bad = 0


def check(msg, got, want):
    global ok, bad
    if got == want:
        ok += 1
        print(f"PASS {msg}")
    else:
        bad += 1
        print(f"FAIL {msg} -- expected [{want}] got [{got}]")


HLS = """#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.000000,
#EXT-X-PROGRAM-DATE-TIME:2026-10-20T04:48:47.592+1000
seg_00000.m4s
#EXTINF:4.000000,
#EXT-X-PROGRAM-DATE-TIME:2026-10-20T04:48:51.592+1000
seg_00001.m4s
"""
MPD = """<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" availabilityStartTime="__AST__" timeShiftBufferDepth="PT1M20.0S">
\t<Period id="0" start="PT0.0S">
\t\t<AdaptationSet id="0" contentType="audio"></AdaptationSet>
\t</Period>
</MPD>
"""


def trig(id_, start_iso, dur, title):
    s = te._parse_iso(start_iso)
    return {"id": id_, "start": start_iso, "duration": dur,
            "hls": f'#EXT-X-DATERANGE:ID="{id_}",CLASS="com.boomlabs.volt.graphic",START-DATE="{start_iso}",DURATION={dur:.3f},X-ID="{id_}",X-GRAPHIC="up-next",X-TITLE="{title}"',
            "dash": {"schemeIdUri": "urn:com:boomlabs:volt:graphic:2026", "value": "up-next",
                     "messageData": '{"graphic":"up-next","title":"%s"}' % title},
            "_start": s, "_end": s + dur}


def run_dir():
    d = tempfile.mkdtemp()
    paths = {"run": d, "audio": os.path.join(d, "audio"), "dash": os.path.join(d, "dash")}
    os.makedirs(paths["audio"]); os.makedirs(paths["dash"])
    with open(os.path.join(d, "master.m3u8"), "w") as fh:
        fh.write(radio.master_playlist(96))
    return paths


up = trig("up-next:p1", "2026-10-19T18:49:00.000Z", 20, "Sorotan")
# DASH keeps only what can still matter NOW (inject_mpd's own rule), so its
# Period starts 13 s before a trigger that starts 30 s from now.
_iso = lambda t: datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
_t0 = int(time.time()) + 30
MPD = MPD.replace("__AST__", _iso(_t0 - 13))
up_dash = trig("up-next:p1", _iso(_t0), 20, "Sorotan")
up = {**up, "dash": up_dash["dash"]}
up_live = up_dash
outs = {"hls": True, "dash": True, "mp3": False}

print("== before ffmpeg has written anything ==")
p = run_dir()
state = {}
check("nothing is written", radio.refresh_delivered(p, outs, 96, [up], state), [])
check("the master still points at ffmpeg's own playlist", "audio/index.m3u8\n" in open(os.path.join(p["run"], "master.m3u8")).read(), True)

print("\n== the first good cycle ==")
open(os.path.join(p["audio"], "index.m3u8"), "w").write(HLS)
open(os.path.join(p["dash"], "manifest.mpd"), "w").write(MPD)
wrote = radio.refresh_delivered(p, outs, 96, [up], state)
radio.refresh_delivered(p, {"hls": False, "dash": True}, 96, [up_live], state)
check("the HLS copy, the master and the DASH copy", wrote, ["audio/index_cc.m3u8", "master.m3u8", "dash/manifest_cc.mpd"])
cc = open(os.path.join(p["audio"], "index_cc.m3u8")).read()
check("the copy carries the Up next DATERANGE", cc.count('#EXT-X-DATERANGE:ID="up-next:p1"'), 1)
check("in the header, before the first segment", cc.index("#EXT-X-DATERANGE") < cc.index("#EXTINF"), True)
check("and keeps every segment", cc.count(".m4s"), 2)
master = open(os.path.join(p["run"], "master.m3u8")).read()
check("the master now leads to the copy", master.strip().endswith("audio/index_cc.m3u8"), True)
check("the master is otherwise the same", master.replace("audio/index_cc.m3u8", "audio/index.m3u8"), radio.master_playlist(96))
mpd = open(os.path.join(p["dash"], "manifest_cc.mpd")).read()
check("the DASH copy carries an EventStream", 'schemeIdUri="urn:com:boomlabs:volt:graphic:2026"' in mpd, True)
check("13 s into the Period, from availabilityStartTime", 'presentationTime="13000"' in mpd, True)

print("\n== later cycles ==")
check("the master is rewritten once only", radio.refresh_delivered(p, outs, 96, [up], state), ["audio/index_cc.m3u8", "dash/manifest_cc.mpd"])
open(os.path.join(p["audio"], "index.m3u8"), "w").write(HLS.rsplit("seg_00001.m4s", 1)[0] + "seg_000")   # caught mid-write
before = open(os.path.join(p["audio"], "index_cc.m3u8")).read()
radio.refresh_delivered(p, outs, 96, [up], state)
check("a playlist caught mid-write leaves the last good copy", open(os.path.join(p["audio"], "index_cc.m3u8")).read(), before)
open(os.path.join(p["audio"], "index.m3u8"), "w").write(HLS)
radio.refresh_delivered(p, outs, 96, [], state)
check("no triggers: the copy is ffmpeg's playlist as it is", open(os.path.join(p["audio"], "index_cc.m3u8")).read().rstrip("\n"), HLS.rstrip("\n"))
radio.refresh_delivered(p, outs, 96, [{"junk": True}], state)
check("a broken trigger list fails open", open(os.path.join(p["audio"], "index_cc.m3u8")).read().rstrip("\n"), HLS.rstrip("\n"))

print("\n== the clock ffmpeg writes ==")
# Python 3.10 (Ubuntu 22.04, the images) rejects these unless normalised.
check("+1000 offset", te._parse_iso("2026-10-20T04:48:47.592+1000"), te._parse_iso("2026-10-19T18:48:47.592Z"))
check("+0000 in a UTC container", te._parse_iso("2026-10-19T18:48:47.592+0000"), te._parse_iso("2026-10-19T18:48:47.592Z"))
check("+10:00 still", te._parse_iso("2026-10-20T04:48:47.592+10:00"), te._parse_iso("2026-10-19T18:48:47.592Z"))
check("one fraction digit", te._parse_iso("2026-10-19T18:48:47.5Z"), te._parse_iso("2026-10-19T18:48:47.500Z"))
check("nonsense", te._parse_iso("yesterday"), None)

print("\n== outputs ==")
q = run_dir()
open(os.path.join(q["audio"], "index.m3u8"), "w").write(HLS)
check("HLS only: no DASH copy", radio.refresh_delivered(q, {"hls": True, "dash": False, "mp3": False}, 96, [up], {}), ["audio/index_cc.m3u8", "master.m3u8"])
check("no timed_events in the job: nothing starts", radio.start_delivered_copies({}, q, outs), None)
check("mp3 only: nothing starts", radio.start_delivered_copies({"timed_events": {"url": "http://x"}}, q, {"hls": False, "dash": False, "mp3": True}), None)

print(f"\n{ok} passed, {bad} failed")
sys.exit(1 if bad else 0)
