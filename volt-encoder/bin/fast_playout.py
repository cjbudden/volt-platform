"""fast_playout.py: a live channel built from packaged VOD, with no encoder.

What it does
------------
A FAST (VOD-to-live) channel's guide is a run of programmes, each pointing at an
on-demand asset that is already packaged (CMAF, the channel's ladder). This writes
the channel's LIVE playlists from those assets' segments, on the wall clock:

    HLS   master.m3u8, v<height>.m3u8 per rung, audio.m3u8
    DASH  manifest.mpd (dynamic, one Period per part)

so a viewer sees an ordinary live channel. Nothing is encoded or transcoded while
it runs: the "playout" is a few kilobytes of text rewritten every couple of
seconds, which is why one small process can run many channels.

What it reads
-------------
* the TIMELINE from the control plane (GET /api/fast-playout/<id>/timeline): the
  guide cut into parts: content (asset, in, out), breaks (SCTE-35 + the house fill
  for the shared output), grid pads (filler). The guide, not the lineup, so a swap
  someone makes in the guide is what goes to air.
* each asset's own VOD playlists (master + media) and MPD, once, cached.
* the in-stream triggers (programme markers, Up next) from the timed-events feed,
  the same feed the live encoder uses.

Rules
-----
* EVERY PART JOIN IS A DISCONTINUITY (new init segment, new timestamps), on every
  track at the same place, so ABR keeps working across it.
* A segment is listed once its wall-clock END has passed, like a live encoder's.
* PDT is continuous: each part starts where the previous one ended (by the video
  lead track). If that drifts from the guide by more than a segment (a restart,
  a guide edit), the next part re-anchors to its scheduled start.
* Audio is cut by MEDIA TIME against the video cut (a segment belongs to the part
  its midpoint falls in), so lip sync holds across every splice.
* Ad breaks carry SCTE-35 (EXT-X-DATERANGE SCTE35-OUT / CUE-OUT / CUE-OUT-CONT /
  CUE-IN in HLS; urn:scte:scte35:2014:xml+bin EventStream in DASH) and our own
  graphics-hide marker, so a FAST platform's ad insertion, our stitcher and the
  player's graphics all key on the same break.
* MEDIA SEQUENCE NUMBERS NEVER REPEAT OR GO BACK: state.json keeps the counters,
  so a restart continues the numbering.

The core (Playout) is pure: no IO, an injected clock. main() does the IO.
"""
import json
import math
import os
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

EPS = 0.02

# ---------------------------------------------------------------------- parsing

def parse_iso(s):
    if s is None:
        return None
    s = s.strip().replace("Z", "+00:00")
    m = re.match(r"^(.*T\d\d:\d\d:\d\d)(\.\d+)?([+-]\d\d:?\d\d)?$", s)
    if not m:
        return None
    base, frac, off = m.group(1), m.group(2) or "", m.group(3) or "+00:00"
    if len(off) == 5:
        off = off[:3] + ":" + off[3:]
    dt = datetime.fromisoformat(base + off)
    return dt.timestamp() + (float(frac) if frac else 0.0)


def iso(t):
    ms = int(round(t * 1000))
    return datetime.fromtimestamp(ms // 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S") + ".%03dZ" % (ms % 1000)


def parse_media_playlist(text):
    """VOD media playlist -> (init_uri, [(uri, dur)]). Relative URIs are kept relative."""
    init, segs, pend = None, [], None
    for l in (x.strip() for x in text.splitlines()):
        if not l:
            continue
        if l.startswith("#EXT-X-MAP:"):
            m = re.search(r'URI="([^"]+)"', l)
            init = m.group(1) if m else init
        elif l.startswith("#EXTINF:"):
            pend = float(l[8:].split(",")[0])
        elif not l.startswith("#") and pend is not None:
            segs.append((l, pend))
            pend = None
    return init, segs


def parse_master(text):
    """-> ([{height, bandwidth, codecs, uri, width, frame_rate}], audio_uri)"""
    variants, audio = [], None
    lines = [x.strip() for x in text.splitlines() if x.strip()]
    for i, l in enumerate(lines):
        if l.startswith("#EXT-X-MEDIA:") and "TYPE=AUDIO" in l and audio is None:
            m = re.search(r'URI="([^"]+)"', l)
            audio = m.group(1) if m else None
        elif l.startswith("#EXT-X-STREAM-INF:") and i + 1 < len(lines):
            res = re.search(r"RESOLUTION=(\d+)x(\d+)", l)
            bw = re.search(r"(?:^|[:,])BANDWIDTH=(\d+)", l)
            co = re.search(r'CODECS="([^"]+)"', l)
            fr = re.search(r"FRAME-RATE=([\d.]+)", l)
            variants.append({
                "width": int(res.group(1)) if res else None,
                "height": int(res.group(2)) if res else 0,
                "bandwidth": int(bw.group(1)) if bw else 0,
                "codecs": co.group(1) if co else "",
                "frame_rate": fr.group(1) if fr else None,
                "uri": lines[i + 1],
            })
    return variants, audio


def parse_mpd_timelines(text):
    """Asset MPD -> {'video': {height: rep}, 'audio': rep}; rep = dict(timescale, init, media, start_number, times=[(t,d)], codecs, ...)"""
    ns = {"d": "urn:mpeg:dash:schema:mpd:2011"}
    root = ET.fromstring(text)
    out = {"video": {}, "audio": None}
    for a in root.iterfind(".//d:Period/d:AdaptationSet", ns):
        ctype = a.get("contentType") or ""
        for r in a.iterfind("d:Representation", ns):
            st = r.find("d:SegmentTemplate", ns)
            if st is None:
                continue
            times, t = [], None
            tl = st.find("d:SegmentTimeline", ns)
            for s in (tl.iterfind("d:S", ns) if tl is not None else []):
                if s.get("t") is not None:
                    t = int(s.get("t"))
                d = int(s.get("d"))
                for _ in range(int(s.get("r", "0")) + 1):
                    times.append((t, d))
                    t += d
            rep = {
                "id": r.get("id"), "bandwidth": int(r.get("bandwidth", "0")), "codecs": r.get("codecs", ""),
                "mime": r.get("mimeType", ""), "width": r.get("width"), "height": int(r.get("height") or 0),
                "sar": r.get("sar"), "sample_rate": r.get("audioSamplingRate"),
                "timescale": int(st.get("timescale", "1")), "init": st.get("initialization"), "media": st.get("media"),
                "start_number": int(st.get("startNumber", "1")), "times": times,
                "channels": None,
            }
            acc = r.find("d:AudioChannelConfiguration", ns)
            if acc is not None:
                rep["channels"] = acc.get("value")
            if ctype == "audio" or rep["mime"].startswith("audio"):
                out["audio"] = out["audio"] or rep
            else:
                out["video"][rep["height"]] = rep
    return out


class Track:
    """One rendition of one asset: init + segments with media start times."""
    def __init__(self, init, segs, base):
        self.init = base + init if init and not init.startswith(("/", "http")) else init
        self.segs = []
        t = 0.0
        for i, (u, d) in enumerate(segs):
            self.segs.append({"uri": base + u if not u.startswith(("/", "http")) else u, "dur": d, "start": t, "index": i})
            t += d
        self.duration = t

    def cut(self, a, b):
        """Segments whose midpoint is in [a, b)."""
        return [s for s in self.segs if a - EPS <= s["start"] + s["dur"] / 2 < b - EPS]


class AssetMedia:
    """An asset's tracks, read from its VOD master (+ MPD for DASH)."""
    def __init__(self, master_text, media_texts, url_base, mpd_text=None):
        variants, audio = parse_master(master_text)
        self.video = {}
        for v in variants:
            init, segs = parse_media_playlist(media_texts[v["uri"]])
            tr = Track(init, segs, url_base)
            tr.meta = v
            self.video[v["height"]] = tr
        self.audio = None
        if audio and audio in media_texts:
            init, segs = parse_media_playlist(media_texts[audio])
            self.audio = Track(init, segs, url_base)
        self.dash = parse_mpd_timelines(mpd_text) if mpd_text else None
        self.url_base = url_base

    def track(self, name):
        if name == "audio":
            return self.audio
        h = int(name[1:])
        if h in self.video:
            return self.video[h]
        # nearest rung (prefer the next one down)
        cands = sorted(self.video, key=lambda x: (abs(x - h), -x))
        return self.video[cands[0]] if cands else None

    def dash_rep(self, name):
        if not self.dash:
            return None
        if name == "audio":
            return self.dash["audio"]
        h = int(name[1:])
        v = self.dash["video"]
        if h in v:
            return v[h]
        cands = sorted(v, key=lambda x: (abs(x - h), -x))
        return v[cands[0]] if cands else None


# ---------------------------------------------------------------------- the parts

def expand_parts(items, assets, seg_sec):
    """Timeline items -> parts, each one contiguous run of ONE asset.

    content  -> one part, the asset cut [in, out)
    break    -> one part per fill item (house spot, slate), the first carrying the
                break's opening tags, the last its closing
    filler   -> the same as a break's fill, without break tags
    A slate is looped to its share of the time; anything without media is dropped
    (and the time it would have filled closes up, which the next re-anchor absorbs).
    """
    parts = []
    for it in items:
        start = parse_iso(it["start"])
        if it["kind"] == "content":
            if not assets.get(it.get("assetId")):
                continue
            parts.append({"key": it["id"], "kind": "content", "asset": it["assetId"], "in": float(it["inSec"]), "out": float(it["outSec"]),
                          "sched": start, "title": it.get("title")})
            continue
        fills = [f for f in it.get("fill", []) if f.get("assetId") and assets.get(f["assetId"])]
        t = start
        brk_parts = []
        for k, f in enumerate(fills):
            a = assets[f["assetId"]]
            lead = a.track("v9999")
            dur = float(f["durationSec"])
            if f["kind"] == "slate" and lead is not None and lead.duration > 0:
                # ELASTIC: the slate is what absorbs the difference between the
                # fill and the guide (spots are whole segments, a break is not).
                # Enough loops are laid out to cover a segment over; schedule()
                # then takes only as much as reaches the next scheduled start.
                loops = max(1, int(math.ceil((dur + seg_sec) / lead.duration)))
                for n in range(loops):
                    brk_parts.append({"key": f"{it['id']}:f{k}:{n}", "kind": "fill", "asset": f["assetId"], "in": 0.0, "out": lead.duration, "sched": t,
                                      "elastic": True})
                    t += lead.duration
            else:
                brk_parts.append({"key": f"{it['id']}:f{k}", "kind": "fill", "asset": f["assetId"], "in": 0.0, "out": dur, "sched": t})
                t += dur
        if not brk_parts:
            continue
        if it["kind"] == "break":
            brk_parts[0]["break_open"] = it
            for p in brk_parts:
                p["break"] = it
            brk_parts[-1]["break_close"] = True
        parts.extend(brk_parts)
    return parts


# ---------------------------------------------------------------------- the writer

class Playout:
    """Stateful live writer over a sequence of parts. Pure: give it parts and a clock."""

    def __init__(self, tracks, dvr_sec=120.0, seg_sec=2.0, state=None):
        self.tracks = tracks  # ["v720", "v360", "audio"]; the first is the lead
        self.dvr = dvr_sec
        self.seg = seg_sec
        st = state or {}
        sts = st.get("tracks", {})
        self.t = {n: {"pub": [], "queue": [], "msn": sts.get(n, {}).get("msn", 0), "d": sts.get(n, {}).get("d", 0),
                      "last": sts.get(n, {}).get("last")} for n in tracks}
        self.ast = st.get("ast")          # DASH availabilityStartTime, fixed for the channel's life
        self.anchor = st.get("anchor")    # {"key", "start"}: wall-clock start of the part on air
        self.periods = {}                 # part key -> {start, dur, asset, vidx0, p}

    def state(self):
        return {"tracks": {n: {"msn": v["msn"], "d": v["d"], "last": v["last"]} for n, v in self.t.items()},
                "ast": self.ast, "anchor": self.anchor}

    def schedule(self, parts, assets, now):
        """Lay the parts on the wall clock (by the video lead) and refill every track's queue.

        Called whenever the timeline is re-read. Everything already published
        keeps its number and time: the rebuild starts at the part on air (with
        the start it was given), and each track drops what it has already listed.
        """
        lead = self.tracks[0]
        keys = [p["key"] for p in parts]
        lead_last = self.t[lead]["last"]
        if self.anchor and self.anchor["key"] in keys:
            start_i, t_anchor = keys.index(self.anchor["key"]), self.anchor["start"]
        else:
            edge = lead_last["pdt_end"] if lead_last else now - self.dvr
            start_i = next((i for i, p in enumerate(parts) if p["sched"] + (p["out"] - p["in"]) > edge + EPS), len(parts))
            # a guide edit removed the part on air: carry on from our edge, not from the guide's clock
            t_anchor = edge if lead_last else (parts[start_i]["sched"] if start_i < len(parts) else now)
        entries = {n: [] for n in self.tracks}
        for i in range(start_i, len(parts)):
            p = parts[i]
            a = assets[p["asset"]]
            vt = a.track(lead) if lead != "audio" else a.audio
            vsegs = vt.cut(p["in"], p["out"]) if vt else []
            if not vsegs:
                continue
            if i > start_i and abs(t_anchor - p["sched"]) > max(self.seg, 1.0) and p["sched"] > t_anchor and not p.get("elastic"):
                t_anchor = p["sched"]  # drifted behind the guide (a gap): re-anchor at the scheduled start
            if p.get("elastic"):
                # take slate up to the next fixed start in the guide (the content after the break)
                nxt = next((q["sched"] for q in parts[i + 1:] if not q.get("elastic")), None)
                if nxt is not None:
                    # whole slate segments to the nearest segment of the gap. A slate
                    # packaged in 1 s segments makes this exact (the conditioning a
                    # FAST slate gets); a 2 s slate lands within a second, and the
                    # next elastic fill takes the difference back.
                    take, acc = [], 0.0
                    for sg in vsegs:
                        if t_anchor + acc + sg["dur"] / 2 > nxt + EPS:
                            break
                        take.append(sg)
                        acc += sg["dur"]
                    vsegs = take
                    if not vsegs:
                        continue
            v0 = vsegs[0]["start"]
            v_end = vsegs[-1]["start"] + vsegs[-1]["dur"]
            part_dur = v_end - v0
            self.periods[p["key"]] = {"start": t_anchor, "dur": part_dur, "asset": p["asset"], "vidx0": vsegs[0]["index"], "p": p}
            if i == start_i:
                self.anchor = {"key": p["key"], "start": t_anchor}
            for n in self.tracks:
                tr = a.track(n)
                if tr is None:
                    continue
                segs = vsegs if n == lead else tr.cut(v0, v_end)
                for k, sg in enumerate(segs):
                    pdt = t_anchor + (sg["start"] - v0)
                    tags = []
                    if k == 0 and p.get("break_open"):
                        b = p["break_open"]
                        bid = b["id"]
                        hide = "all" if b.get("hideGraphics", True) else "none"
                        tags.append(f'#EXT-X-DATERANGE:ID="brk:{bid}",CLASS="com.boomlabs.volt.ad",START-DATE="{iso(t_anchor)}",'
                                    f'PLANNED-DURATION={float(b["durationSec"]):.3f},DURATION={float(b["durationSec"]):.3f},SCTE35-OUT={b["scte35Out"]},'
                                    f'X-ID="brk:{bid}",X-GRAPHIC="ad-break",X-BREAK="{bid}",X-HIDE-GRAPHICS="{hide}"')
                        tags.append(f'#EXT-X-CUE-OUT:DURATION={float(b["durationSec"]):.3f}')
                        self.periods[p["key"]]["break_start_pdt"] = t_anchor
                    elif p.get("break"):
                        bs = self._break_start(p["break"]["id"])
                        el = max(0.0, pdt - bs) if bs is not None else 0.0
                        tags.append(f'#EXT-X-CUE-OUT-CONT:ElapsedTime={el:.3f},Duration={float(p["break"]["durationSec"]):.3f}')
                    elif k == 0 and i > 0 and parts[i - 1].get("break_close"):
                        tags.append("#EXT-X-CUE-IN")
                    entries[n].append({"uri": sg["uri"], "dur": sg["dur"], "pdt": pdt, "map": tr.init, "key": p["key"], "idx": sg["index"],
                                       "disc": k == 0, "tags": tags})
            t_anchor += part_dur
        # each track: drop what it has already published
        for n in self.tracks:
            last = self.t[n]["last"]
            q = entries[n]
            if last:
                j = next((x for x, e in enumerate(q) if e["key"] == last["key"] and e["idx"] == last["idx"]), None)
                if j is not None:
                    q = q[j + 1:]
                    if q and q[0]["key"] == last["key"]:
                        q[0]["disc"] = False
                else:
                    q = [e for e in q if e["pdt"] >= last["pdt_end"] - EPS]
                    if q:
                        q[0]["disc"] = True
            self.t[n]["queue"] = q

    def _break_start(self, bid):
        for per in self.periods.values():
            if per["p"].get("break_open", {}).get("id") == bid and "break_start_pdt" in per:
                return per["break_start_pdt"]
        return None

    def tick(self, now):
        """Publish every segment whose end has passed; trim to the DVR window."""
        lead = self.tracks[0]
        for n in self.tracks:
            tr = self.t[n]
            while tr["queue"] and tr["queue"][0]["pdt"] + tr["queue"][0]["dur"] <= now + 1e-6:
                sg = tr["queue"].pop(0)
                if sg["disc"] and (tr["pub"] or tr["msn"] > 0):
                    tr["d"] += 1
                sg["msn"] = tr["msn"]
                sg["dnum"] = tr["d"]
                tr["msn"] += 1
                tr["pub"].append(sg)
                tr["last"] = {"key": sg["key"], "idx": sg["idx"], "pdt_end": sg["pdt"] + sg["dur"]}
                if n == lead and self.anchor and sg["key"] != self.anchor["key"] and sg["key"] in self.periods:
                    self.anchor = {"key": sg["key"], "start": self.periods[sg["key"]]["start"]}
            while tr["pub"] and tr["pub"][0]["pdt"] + tr["pub"][0]["dur"] < now - self.dvr:
                tr["pub"].pop(0)
        if self.ast is None and self.t[lead]["pub"]:
            self.ast = math.floor(self.t[lead]["pub"][0]["pdt"]) - 3600

    # ------------------------------------------------------------------ HLS out

    def hls(self, name, triggers=()):
        tr = self.t[name]
        pub = tr["pub"]
        if not pub:
            return None
        target = max(1, int(math.ceil(max(s["dur"] for s in pub))))
        L = ["#EXTM3U", "#EXT-X-VERSION:7", f"#EXT-X-TARGETDURATION:{target}",
             f"#EXT-X-MEDIA-SEQUENCE:{pub[0]['msn']}", f"#EXT-X-DISCONTINUITY-SEQUENCE:{pub[0]['dnum']}"]
        lo, hi = pub[0]["pdt"], pub[-1]["pdt"] + pub[-1]["dur"] + 90
        for t in triggers:
            if t.get("graphic") == "ad-break":
                continue  # the playout writes each break's own tag, with its SCTE-35
            st = parse_iso(t.get("start"))
            d = t.get("duration")
            if st is None or st > hi or (d is not None and st + float(d) < lo):
                continue
            L.append(t["hls"])
        cur_map = None
        for k, s in enumerate(pub):
            if k > 0 and s["disc"]:
                L.append("#EXT-X-DISCONTINUITY")
            # the init segment again after every discontinuity, even when it is the same file:
            # players that reset their demuxer at a discontinuity expect one
            if s["map"] != cur_map or (k > 0 and s["disc"]):
                L.append(f'#EXT-X-MAP:URI="{s["map"]}"')
                cur_map = s["map"]
            for tg in s["tags"]:
                if k == 0 and tg.startswith("#EXT-X-CUE-IN"):
                    continue
                L.append(tg)
            L.append(f"#EXT-X-PROGRAM-DATE-TIME:{iso(s['pdt'])}")
            L.append(f"#EXTINF:{s['dur']:.3f},")
            L.append(s["uri"])
        return "\n".join(L) + "\n"

    # ------------------------------------------------------------------ DASH out

    def dash(self, assets, now, triggers=(), dash_events=None):
        lead = self.tracks[0]
        pub = self.t[lead]["pub"]
        if not pub or self.ast is None:
            return None
        keys = []
        for s in pub:
            if s["key"] not in keys:
                keys.append(s["key"])
        out = ['<?xml version="1.0" encoding="UTF-8"?>',
               f'<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011" type="dynamic" '
               f'availabilityStartTime="{iso(self.ast)}" publishTime="{iso(now)}" minimumUpdatePeriod="PT{max(1, int(self.seg))}S" '
               f'timeShiftBufferDepth="PT{int(self.dvr)}S" suggestedPresentationDelay="PT{int(self.seg * 3)}S" minBufferTime="PT{int(self.seg)}S">']
        for key in keys:
            per = self.periods.get(key)
            if not per:
                continue
            a = assets[per["asset"]]
            p_start = per["start"] - self.ast
            out.append(f'  <Period id="{xml_attr(key)}" start="PT{p_start:.3f}S">')
            # events: SCTE-35 for a break's first part, our triggers inside this period
            ev = []
            if per["p"].get("break_open"):
                b = per["p"]["break_open"]
                ev.append(("urn:scte:scte35:2014:xml+bin", None, b["id"], 0.0, float(b["durationSec"]),
                           f'<Signal xmlns="http://www.scte.org/schemas/35/2016"><Binary>{hex_to_b64(b["scte35Out"])}</Binary></Signal>'))
            if per["p"].get("break"):
                # The graphics-hide marker in EVERY period of the break: a player
                # clips an event to its own period, so one event on the first
                # period would let graphics back on after the first spot.
                b = per["p"]["break"]
                hide = "all" if b.get("hideGraphics", True) else "none"
                ev.append(("urn:com:boomlabs:volt:ad:2026", "ad-break", f"brk:{b['id']}:{key}", 0.0, per["dur"],
                           json.dumps({"graphic": "ad-break", "break": b["id"], "hide-graphics": hide})))
            for t in triggers:
                if t.get("graphic") == "ad-break":
                    continue
                st = parse_iso(t.get("start"))
                if st is None or not (per["start"] - EPS <= st < per["start"] + per["dur"]):
                    continue
                dd = t.get("dash") or {}
                ev.append((dd.get("schemeIdUri"), dd.get("value"), dd.get("id") or t.get("id"), st - per["start"],
                           (dd.get("durationMs") or 0) / 1000.0 if dd.get("durationMs") else None, dd.get("messageData")))
            by_scheme = {}
            for e in ev:
                by_scheme.setdefault((e[0], e[1]), []).append(e)
            for (scheme, value), es in by_scheme.items():
                vattr = f' value="{xml_attr(value)}"' if value else ""
                out.append(f'    <EventStream schemeIdUri="{xml_attr(scheme)}"{vattr} timescale="1000">')
                for (_, _, eid, rel, dur, body) in es:
                    dattr = f' duration="{int(round(dur * 1000))}"' if dur else ""
                    if scheme.startswith("urn:scte:scte35"):
                        out.append(f'      <Event presentationTime="{int(round(rel * 1000))}"{dattr} id="{abs(hash(eid)) % 2147483647}">{body}</Event>')
                    else:
                        out.append(f'      <Event presentationTime="{int(round(rel * 1000))}"{dattr} id="{abs(hash(eid)) % 2147483647}" messageData="{xml_attr(body or "")}"/>')
                out.append('    </EventStream>')
            for kind in ("video", "audio"):
                names = [n for n in self.tracks if (n == "audio") == (kind == "audio")]
                reps = []
                for n in names:
                    rep = a.dash_rep(n)
                    if rep is None:
                        continue
                    segs = [s for s in self.t[n]["pub"] if s["key"] == key]
                    if not segs:
                        continue
                    reps.append((n, rep, segs))
                if not reps:
                    continue
                ctype = 'contentType="audio"' if kind == "audio" else 'contentType="video"'
                out.append(f'    <AdaptationSet {ctype} segmentAlignment="true" startWithSAP="1">')
                for n, rep, segs in reps:
                    ts = rep["timescale"]
                    tr = a.track(n)
                    by_uri = {m["uri"]: m["index"] for m in tr.segs}
                    nums, times = [], []
                    for sg in segs:
                        mi = by_uri.get(sg["uri"])
                        if mi is None or mi >= len(rep["times"]):
                            continue
                        nums.append(rep["start_number"] + mi)
                        times.append(rep["times"][mi])
                    if not nums:
                        continue
                    # presentationTimeOffset: the media time where the PERIOD starts
                    # (the part's first video segment), in this rep's own timescale,
                    # so audio and video are cut at the same media instant.
                    vrep = a.dash_rep(self.tracks[0])
                    if vrep and per["vidx0"] < len(vrep["times"]):
                        pto = int(round(vrep["times"][per["vidx0"]][0] * ts / vrep["timescale"]))
                    else:
                        pto = times[0][0]
                    attrs = [f'id="{n}"', f'bandwidth="{rep["bandwidth"]}"', f'codecs="{rep["codecs"]}"', f'mimeType="{rep["mime"]}"']
                    if rep.get("width"):
                        attrs += [f'width="{rep["width"]}"', f'height="{rep["height"]}"']
                    if rep.get("sample_rate"):
                        attrs.append(f'audioSamplingRate="{rep["sample_rate"]}"')
                    out.append(f'      <Representation {" ".join(attrs)}>')
                    if rep.get("channels"):
                        out.append(f'        <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="{rep["channels"]}"/>')
                    init = a.url_base + rep["init"]
                    media = a.url_base + rep["media"]
                    out.append(f'        <SegmentTemplate timescale="{ts}" presentationTimeOffset="{pto}" initialization="{xml_attr(init)}" media="{xml_attr(media)}" startNumber="{nums[0]}">')
                    out.append('          <SegmentTimeline>')
                    for j, (t0, d0) in enumerate(times):
                        out.append(f'            <S t="{t0}" d="{d0}"/>' if j == 0 or times[j - 1][0] + times[j - 1][1] != t0 else f'            <S d="{d0}"/>')
                    out.append('          </SegmentTimeline>')
                    out.append('        </SegmentTemplate>')
                    out.append('      </Representation>')
                out.append('    </AdaptationSet>')
            out.append('  </Period>')
        out.append('</MPD>')
        return "\n".join(out) + "\n"


def xml_attr(v):
    return (str(v).replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;"))


def hex_to_b64(h):
    import base64
    h = h[2:] if h.lower().startswith("0x") else h
    return base64.b64encode(bytes.fromhex(h)).decode()


def master_playlist(assets_any, tracks):
    """The multivariant playlist, from the first asset's variant attributes (the ladder is the channel's)."""
    L = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"]
    has_audio = "audio" in tracks
    if has_audio:
        L.append('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"')
    for n in tracks:
        if n == "audio":
            continue
        tr = assets_any.track(n)
        m = getattr(tr, "meta", {}) or {}
        attrs = [f"BANDWIDTH={m.get('bandwidth', 1000000)}", f'CODECS="{m.get("codecs", "avc1.64001f,mp4a.40.2")}"']
        if m.get("width"):
            attrs.append(f"RESOLUTION={m['width']}x{m['height']}")
        if m.get("frame_rate"):
            attrs.append(f"FRAME-RATE={m['frame_rate']}")
        if has_audio:
            attrs.append('AUDIO="audio"')
        L.append("#EXT-X-STREAM-INF:" + ",".join(attrs))
        L.append(f"{n}.m3u8")
    return "\n".join(L) + "\n"


# ---------------------------------------------------------------------- IO loop

def _get(url, token, timeout=5):
    req = urllib.request.Request(url, headers={"X-Volt-Ingest-Token": token, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _write(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(text)
    os.replace(tmp, path)


def load_asset(master_key, clips_dir, url_prefix):
    """master_key '/clips/vod/<id>/master.m3u8' -> AssetMedia, reading the local copy."""
    rel = master_key[len("/clips"):] if master_key.startswith("/clips") else master_key
    d = os.path.dirname(clips_dir.rstrip("/") + rel)
    url_base = url_prefix + os.path.dirname(master_key) + "/"
    master = open(os.path.join(d, os.path.basename(rel))).read()
    variants, audio = parse_master(master)
    media = {}
    for u in [v["uri"] for v in variants] + ([audio] if audio else []):
        media[u] = open(os.path.join(d, u)).read()
    mpd = None
    if os.path.exists(os.path.join(d, "manifest.mpd")):
        mpd = open(os.path.join(d, "manifest.mpd")).read()
    return AssetMedia(master, media, url_base, mpd)


def main():
    import argparse
    ap = argparse.ArgumentParser(description="Volt FAST playout: a live channel from packaged VOD")
    ap.add_argument("--channel", required=True)
    ap.add_argument("--api", default=os.environ.get("VOLT_API", "http://localhost:3000"))
    ap.add_argument("--token", default=os.environ.get("INGEST_TOKEN", "dev-ingest-token"))
    ap.add_argument("--out", required=True, help="output dir (origin/<channel>/fast)")
    ap.add_argument("--clips-dir", default=os.environ.get("CLIPS_DIR", "clips"))
    ap.add_argument("--url-prefix", default="", help="prefix for segment URLs (a CDN origin), default same-origin")
    ap.add_argument("--dvr", type=float, default=120.0)
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--timeline-file", help="read the timeline from a file instead of the API (tests)")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    state_path = os.path.join(a.out, "state.json")
    state = json.load(open(state_path)) if os.path.exists(state_path) else None
    assets, play, tl, tl_at, trig, trig_at = {}, None, None, 0, [], 0
    while True:
        now = time.time()
        try:
            if tl is None or now - tl_at > 20:
                if a.timeline_file:
                    tl = json.load(open(a.timeline_file))
                else:
                    tl = _get(f"{a.api}/api/fast-playout/{a.channel}/timeline?from={iso(now - a.dvr - 3600)}&to={iso(now + 3600)}", a.token)
                tl_at = now
                for it in tl["items"]:
                    for ref in [it] + it.get("fill", []):
                        aid, mk = ref.get("assetId"), ref.get("master")
                        if aid and mk and aid not in assets:
                            try:
                                assets[aid] = load_asset(mk, a.clips_dir, a.url_prefix)
                            except OSError as e:
                                print(f"[fast] asset {aid} not readable: {e}", file=sys.stderr)
                if play is None:
                    first = next((assets[i["assetId"]] for i in tl["items"] if i["kind"] == "content" and i.get("assetId") in assets), None)
                    if first is None:
                        print("[fast] nothing playable in the timeline yet", file=sys.stderr)
                        time.sleep(2)
                        tl = None
                        continue
                    tracks = [f"v{h}" for h in sorted(first.video, reverse=True)] + (["audio"] if first.audio else [])
                    play = Playout(tracks, dvr_sec=a.dvr, seg_sec=float(tl.get("segmentSec", 2)), state=state)
                    _write(os.path.join(a.out, "master.m3u8"), master_playlist(first, tracks))
                play.schedule(expand_parts(tl["items"], assets, play.seg), assets, now)
            if not a.timeline_file and now - trig_at > 5:
                try:
                    trig = _get(f"{a.api}/api/streams/{a.channel}/timed-events?from={iso(now - a.dvr)}&to={iso(now + 120)}", a.token).get("triggers", [])
                except Exception:
                    pass  # keep the last good list
                trig_at = now
            play.tick(now)
            for n in play.tracks:
                txt = play.hls(n, trig)
                if txt:
                    _write(os.path.join(a.out, f"{n}.m3u8"), txt)
            mpd = play.dash(assets, now, trig)
            if mpd:
                _write(os.path.join(a.out, "manifest.mpd"), mpd)
            _write(state_path, json.dumps(play.state()))
        except Exception as e:  # never die on one bad tick; the last good playlists stay up
            print(f"[fast] tick failed: {e}", file=sys.stderr)
        if a.once:
            break
        time.sleep(1.0)


if __name__ == "__main__":
    main()
