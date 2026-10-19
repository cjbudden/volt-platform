#!/usr/bin/env python3
"""In-stream graphic triggers in the delivered manifests (timed_events.py).

Runs against REAL delivered manifests captured from a local run (testdata/
timed_events): a PDT-stamped HLS media playlist with discontinuities and a
seven-Period DASH MPD written by the playout splice. Usage:
    python3 volt-encoder/bin/test_timed_events.py
"""
import os
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(__file__))
import timed_events as te  # noqa: E402

HERE = os.path.join(os.path.dirname(__file__), "testdata", "timed_events")
ok = bad = 0


def check(msg, got, want):
    global ok, bad
    if got == want:
        ok += 1
        print(f"PASS {msg}")
    else:
        bad += 1
        print(f"FAIL {msg} -- expected [{want}] got [{got}]")


def trig(id_, start_iso, dur, cls="com.boomlabs.volt.graphic", graphic="up-next", title="Evening Bulletin"):
    hls = (f'#EXT-X-DATERANGE:ID="{id_}",CLASS="{cls}",START-DATE="{start_iso}"'
           + (f",DURATION={dur:.3f}" if dur is not None else "") + f',X-GRAPHIC="{graphic}",X-TITLE="{title}"')
    scheme = "urn:com:boomlabs:volt:graphic:2026" if graphic == "up-next" else "urn:com:boomlabs:volt:programme:2026"
    s = te._parse_iso(start_iso)
    return {"id": id_, "class": cls, "graphic": graphic, "start": start_iso, "duration": dur, "hls": hls,
            "dash": {"schemeIdUri": scheme, "value": graphic, "id": id_, "start": start_iso,
                     "durationMs": None if dur is None else int(dur * 1000),
                     "messageData": '{"graphic":"%s","title":"%s & <co>"}' % (graphic, title)},
            "_start": s, "_end": float("inf") if dur is None else s + dur}


hls = open(os.path.join(HERE, "stream_1_cc.m3u8")).read()
mpd = open(os.path.join(HERE, "manifest_cc.mpd")).read()

print("== HLS: the window comes from the playlist's own PDT ==")
win = te.playlist_window(hls)
check("a window is found", win is not None, True)
check("it starts at the first PDT", te._iso_ms(win[0]), "2026-10-17T04:24:51.204Z")
check("and ends at the last PDT plus its segment", te._iso_ms(win[1]), "2026-10-17T04:29:51.204Z")
check("a playlist with no PDT has no window", te.playlist_window("#EXTM3U\n#EXTINF:4,\na.m4s\n"), None)

inside = trig("up-next:p1", "2026-10-17T04:27:00.000Z", 12)
ahead = trig("up-next:p2", "2026-10-17T04:30:30.000Z", 12)        # 39 s after the window: within AHEAD
far = trig("up-next:p3", "2026-10-17T05:30:00.000Z", 12)          # an hour out
past = trig("up-next:p0", "2026-10-17T04:00:00.000Z", 12)         # long gone
openp = trig("prog-1", "2026-10-17T04:00:00.000Z", None, cls="com.boomlabs.volt.programme", graphic="programme")
out = te.inject_hls(hls, [inside, ahead, far, past, openp])
tags = [l for l in out.split("\n") if l.startswith("#EXT-X-DATERANGE:")]
check("the triggers in or just after the window are written", len(tags), 3)
check("the one an hour out is not", any("p3" in t for t in tags), False)
check("nor the one long gone", any("p0" in t for t in tags), False)
check("an open-ended programme that started earlier still covers the window", any("prog-1" in t for t in tags), True)
lines = out.split("\n")
first_inf = next(i for i, l in enumerate(lines) if l.startswith("#EXTINF:"))
last_tag = max(i for i, l in enumerate(lines) if l.startswith("#EXT-X-DATERANGE:"))
check("tags sit in the header, before the first segment", last_tag < first_inf, True)
check("and before that segment's PDT, which belongs to it", lines[last_tag + 1].startswith("#EXT-X-PROGRAM-DATE-TIME:"), True)
check("no segment is lost", out.count("#EXTINF:"), hls.count("#EXTINF:"))
again = te.inject_hls(out, [inside, ahead, far, past, openp])
check("idempotent: writing twice does not duplicate", again, out)
check("an empty list removes stale tags", te.inject_hls(out, []).count("#EXT-X-DATERANGE"), 0)
check("a playlist without PDT is returned untouched", te.inject_hls("#EXTM3U\n#EXTINF:4,\na.m4s", [inside]), "#EXTM3U\n#EXTINF:4,\na.m4s")
check("garbage in returns the input", te.inject_hls(hls, [{"bad": 1}]), hls)

print("\n== DASH: each trigger in the Period it falls in ==")
now = te._parse_iso("2026-10-17T04:28:32.337Z")                   # the MPD's publishTime
ast = te._parse_iso("2026-10-17T03:48:09.000Z")
# Period p43 runs 2354.590 .. 2492.804 s after AST: 04:27:23.590 .. 04:29:41.804
t43 = trig("up-next:in-p43", "2026-10-17T04:28:00.000Z", 12)
span = trig("up-next:spans", "2026-10-17T04:29:35.000Z", 12)     # starts in p43, runs into p44
m2 = te.inject_mpd(mpd, [t43, span], now=now)
root = ET.fromstring(m2.encode())
ns = "{urn:mpeg:dash:schema:mpd:2011}"
check("the MPD is still valid XML", root.tag, ns + "MPD")
found = {}
for per in root.iter(ns + "Period"):
    st = te._dur_sec(per.get("start"))
    kids = list(per)
    for i, es in enumerate(per.iter(ns + "EventStream")):
        for ev in es.iter(ns + "Event"):
            wall = ast + st + int(ev.get("presentationTime")) / 1000
            found.setdefault(per.get("id"), []).append((round(wall, 3), int(ev.get("duration") or 0), ev.get("messageData")))
    if any(k.tag == ns + "EventStream" for k in kids):
        first_as = next(j for j, k in enumerate(kids) if k.tag == ns + "AdaptationSet")
        last_es = max(j for j, k in enumerate(kids) if k.tag == ns + "EventStream")
        check(f"{per.get('id')}: EventStream comes before the AdaptationSets (schema order)", last_es < first_as, True)
check("the trigger inside p43 lands in p43", [w for w, _d, _m in found.get("p43", []) if abs(w - t43["_start"]) < 0.002] != [], True)
check("at the exact wall clock", any(abs(w - t43["_start"]) < 0.002 for w, _d, _m in found.get("p43", [])), True)
check("a trigger crossing a Period boundary appears in both", "p44" in found and any(d < 12000 for _w, d, _m in found["p44"]), True)
check("its part in p44 starts at p44's start", any(abs(w - (ast + 2492.804)) < 0.002 for w, _d, _m in found["p44"]), True)
check("Periods it does not touch have none", "p39" in found, False)
check("messageData survives XML escaping", any('"title":"Evening Bulletin & <co>"' in (m or "") for _w, _d, m in found["p43"]), True)
m3 = te.inject_mpd(m2, [t43, span], now=now)
check("idempotent: our EventStreams are replaced, not stacked", m3.count("<EventStream"), m2.count("<EventStream"))
check("nothing to say leaves no EventStream", te.inject_mpd(m2, [], now=now).count("<EventStream"), 0)
check("a trigger far in the future is not written yet", te.inject_mpd(mpd, [far], now=now).count("<Event "), 0)
plain = open(os.path.join(HERE, "manifest.mpd")).read()
m4 = te.inject_mpd(plain, [t43], now=te._parse_iso("2026-10-17T04:27:30Z"))
check("a single-Period packager MPD works too", m4.count("<Event "), 1)
check("garbage in returns the input", te.inject_mpd("<MPD/>", [t43], now=now), "<MPD/>")

print("\n== the feed keeps the last good list, then lets it go ==")
clock = [1000.0]
calls = {"n": 0}


def fetch():
    calls["n"] += 1
    if calls["n"] > 1:
        raise OSError("connection refused")
    return {"triggers": [{"id": "x", "start": "2026-10-17T04:28:00Z", "duration": 12, "hls": inside["hls"], "dash": inside["dash"]}]}


f = te.TriggerFeed("http://cp/x", fetch=fetch, clock=lambda: clock[0])
check("first poll succeeds", f.poll_once(), True)
check("one trigger held", len(f.current()), 1)
check("a failed poll keeps it", (f.poll_once(), len(f.current())), (False, 1))
clock[0] += te.STALE_SEC + 1
check("after ten minutes without an answer it is dropped", len(f.current()), 0)
bad_feed = te.TriggerFeed("http://cp/x", fetch=lambda: {"triggers": [{"id": "y", "start": "nonsense", "hls": "x"}]})
bad_feed.poll_once()
check("an unparseable trigger is skipped, not fatal", len(bad_feed.current()), 0)

print(f"\n{ok} passed, {bad} failed")
sys.exit(1 if bad else 0)
