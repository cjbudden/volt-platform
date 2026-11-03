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
* TRICK-PLAY (build queue 3.2b-5), only when the channel's output profile has
  the switch on (the timeline says `trickPlay`; read once, at start, like a
  live channel): v<height>.iframes.m3u8 per video rung, one entry per listed
  segment, a byte range from the segment's moof to the end of its opening
  keyframe. Nothing new is encoded or stored: the ranges point into the same
  segments the media playlists list, so breaks, slates and loops are covered
  exactly as they air. Finding a range costs one small ranged read of the
  segment's head, once per segment (cached, and loops repeat their segments).
  The master lists them once every rung has one.

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
LIVE_EDGE_SEC = 10.0

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
            # $RepresentationID$ and $Bandwidth$ are the ASSET's, resolved here: the
            # channel's MPD gives its Representations its own ids (v360, v360_trick),
            # so a template carried over unresolved named files that do not exist
            # (ffmpeg's DASH muxer writes them; Shaka Packager writes literal names).
            rid, rbw = r.get("id") or "", r.get("bandwidth") or ""

            def sub(v, rid=rid, rbw=rbw):
                return v.replace("$RepresentationID$", rid).replace("$Bandwidth$", rbw) if v else v
            rep = {
                "id": r.get("id"), "bandwidth": int(r.get("bandwidth", "0")), "codecs": r.get("codecs", ""),
                "mime": r.get("mimeType", ""), "width": r.get("width"), "height": int(r.get("height") or 0),
                "sar": r.get("sar"), "sample_rate": r.get("audioSamplingRate"),
                "timescale": int(st.get("timescale", "1")), "init": sub(st.get("initialization")), "media": sub(st.get("media")),
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
    def __init__(self, init, segs, base, key_base=None):
        self.init = base + init if init and not init.startswith(("/", "http")) else init
        self.segs = []
        t = 0.0
        for i, (u, d) in enumerate(segs):
            # src: where the segment is STORED (a /clips/ path or a bucket key), for
            # reading its head (trick-play); uri is how a player fetches it.
            src = (key_base + u) if key_base is not None and not u.startswith(("/", "http")) else None
            self.segs.append({"uri": base + u if not u.startswith(("/", "http")) else u, "dur": d, "start": t, "index": i, "src": src})
            t += d
        self.duration = t

    def cut(self, a, b):
        """Segments whose midpoint is in [a, b)."""
        return [s for s in self.segs if a - EPS <= s["start"] + s["dur"] / 2 < b - EPS]


class AssetMedia:
    """An asset's tracks, read from its VOD master (+ MPD for DASH)."""
    def __init__(self, master_text, media_texts, url_base, mpd_text=None, key_base=None):
        variants, audio = parse_master(master_text)
        self.video = {}
        for v in variants:
            init, segs = parse_media_playlist(media_texts[v["uri"]])
            tr = Track(init, segs, url_base, key_base)
            tr.meta = v
            self.video[v["height"]] = tr
        self.audio = None
        if audio and audio in media_texts:
            init, segs = parse_media_playlist(media_texts[audio])
            self.audio = Track(init, segs, url_base, key_base)
        self.dash = parse_mpd_timelines(mpd_text) if mpd_text else None
        self.url_base = url_base
        # DASH trick track (build queue 3.2b-6): trick.json beside the asset's MPD,
        # written by the control plane (services/trickplay/ladder.ts) once its
        # keyframe segments are in place. None until then.
        self.trick = None
        self.folder = None

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
            # Nothing playable for this gap (no loop or slate packaged). Keep a
            # marker so schedule() knows the time it would have filled is a
            # HOLE in the guide, not drift, and closes it up rather than leaving
            # dead air (a playlist that stops growing stalls every player).
            parts.append({"key": f"{it['id']}:hole", "kind": "hole", "asset": None, "in": 0.0, "out": float(it.get("durationSec") or 0),
                          "sched": start})
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
        self.holes = []                   # [(guide time, seconds closed up)], for the heartbeat

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
        after_hole = False
        self.holes = []
        for i in range(start_i, len(parts)):
            p = parts[i]
            if p.get("kind") == "hole":
                after_hole = True
                continue
            a = assets[p["asset"]]
            vt = a.track(lead) if lead != "audio" else a.audio
            vsegs = vt.cut(p["in"], p["out"]) if vt else []
            if not vsegs:
                continue
            if i > start_i and abs(t_anchor - p["sched"]) > max(self.seg, 1.0) and p["sched"] > t_anchor and not p.get("elastic"):
                # "At the live edge": the junction is ahead of us, or so recently
                # behind that the first segment after it (up to a long segment
                # plus a tick) is not listed yet. Further back than that is a
                # restart after downtime, which re-anchors to the guide as before.
                if after_hole and t_anchor >= now - LIVE_EDGE_SEC:
                    # An unfilled gap at the live edge: jumping to the guide would
                    # leave nothing to list for the whole gap and every player
                    # rebuffers (iOS stops for good). Close it up instead: the
                    # channel runs early by the gap until a loop or slate (which
                    # is elastic, and takes up to the next fixed start) absorbs it.
                    self.holes.append((p["sched"], p["sched"] - t_anchor))
                else:
                    t_anchor = p["sched"]  # drifted behind the guide (a restart, a guide edit): re-anchor at the scheduled start
            after_hole = False
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
                    entries[n].append({"uri": sg["uri"], "src": sg.get("src"), "dur": sg["dur"], "pdt": pdt, "map": tr.init, "key": p["key"], "idx": sg["index"],
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

    def iframes(self, name, kf):
        """The I-frame playlist of a video track: one entry per listed segment,
        the byte range of its opening keyframe (kf: segment uri -> (offset,
        length), see keyframe_range). Numbered like the media playlist (an entry
        has its segment's media sequence number and discontinuity count), so a
        player can line the two up. A segment whose range is not known yet
        cannot be skipped without breaking that numbering, so the list starts
        after the last such segment; None when nothing can be listed."""
        pub = self.t[name]["pub"]
        start = 0
        for k, sg in enumerate(pub):
            if kf.get(sg["uri"]) is None:
                start = k + 1
        pub = pub[start:]
        if not pub:
            return None
        target = max(1, int(math.ceil(max(s["dur"] for s in pub))))
        L = ["#EXTM3U", "#EXT-X-VERSION:7", f"#EXT-X-TARGETDURATION:{target}",
             f"#EXT-X-MEDIA-SEQUENCE:{pub[0]['msn']}", f"#EXT-X-DISCONTINUITY-SEQUENCE:{pub[0]['dnum']}", "#EXT-X-I-FRAMES-ONLY"]
        cur_map = None
        for k, sg in enumerate(pub):
            if k > 0 and sg["disc"]:
                L.append("#EXT-X-DISCONTINUITY")
            if sg["map"] != cur_map or (k > 0 and sg["disc"]):
                L.append(f'#EXT-X-MAP:URI="{sg["map"]}"')
                cur_map = sg["map"]
            off, ln = kf[sg["uri"]]
            L.append(f"#EXT-X-PROGRAM-DATE-TIME:{iso(sg['pdt'])}")
            L.append(f"#EXTINF:{sg['dur']:.3f},")
            L.append(f"#EXT-X-BYTERANGE:{ln}@{off}")
            L.append(sg["uri"])
        return "\n".join(L) + "\n"

    # ------------------------------------------------------------------ DASH out

    def dash(self, assets, now, triggers=(), dash_events=None, trick=False):
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
                # Ids, so the trick-mode set below can name the video set it belongs to.
                as_id = "1" if kind == "audio" else "0"
                out.append(f'    <AdaptationSet id="{as_id}" {ctype} segmentAlignment="true" startWithSAP="1">')
                emitted = {}
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
                    out.extend(_segment_template(ts, pto, init, media, nums[0], times, "        "))
                    out.append('      </Representation>')
                    emitted[n] = (rep, ts, pto, init, nums, times)
                out.append('    </AdaptationSet>')
                # DASH TRICK-MODE (build queue 3.2b-6 (a)): the asset's keyframe
                # segments (services/trickplay/ladder.ts) for its trick rendition, on
                # the same numbers and timeline, in a set of their own marked with the
                # dashif trickmode property. Only where the asset has them (trick.json)
                # and the rendition airs in this period; nothing else changes.
                if kind == "video" and trick and a.trick:
                    hit = next(((n, e) for n, e in emitted.items() if str(e[0].get("id")) == str(a.trick["rep"])), None)
                    if hit:
                        n, (rep, ts, pto, init, nums, times) = hit
                        fr = (a.track(n).meta or {}).get("frame_rate") if a.track(n) is not None and hasattr(a.track(n), "meta") else None
                        try:
                            fps = float(fr) if fr else 25.0
                        except ValueError:
                            fps = 25.0
                        rate = max(1, int(round(self.seg * fps)))
                        attrs = [f'id="{n}_trick"', f'bandwidth="{int(a.trick.get("bandwidth") or 1)}"', f'codecs="{rep["codecs"]}"', 'mimeType="video/mp4"']
                        if rep.get("width"):
                            attrs += [f'width="{rep["width"]}"', f'height="{rep["height"]}"']
                        attrs += [f'maxPlayoutRate="{rate}"', 'codingDependency="false"']
                        out.append('    <AdaptationSet id="2" contentType="video" segmentAlignment="true" startWithSAP="1">')
                        out.append('      <EssentialProperty schemeIdUri="http://dashif.org/guidelines/trickmode" value="0"/>')
                        out.append(f'      <Representation {" ".join(attrs)}>')
                        out.extend(_segment_template(ts, pto, init, a.url_base + a.trick["media"], nums[0], times, "        "))
                        out.append('      </Representation>')
                        out.append('    </AdaptationSet>')
            out.append('  </Period>')
        out.append('</MPD>')
        return "\n".join(out) + "\n"


def _segment_template(ts, pto, init, media, start, times, ind):
    out = [f'{ind}<SegmentTemplate timescale="{ts}" presentationTimeOffset="{pto}" initialization="{xml_attr(init)}" media="{xml_attr(media)}" startNumber="{start}">',
           f'{ind}  <SegmentTimeline>']
    for j, (t0, d0) in enumerate(times):
        out.append(f'{ind}    <S t="{t0}" d="{d0}"/>' if j == 0 or times[j - 1][0] + times[j - 1][1] != t0 else f'{ind}    <S d="{d0}"/>')
    out += [f'{ind}  </SegmentTimeline>', f'{ind}</SegmentTemplate>']
    return out


def xml_attr(v):
    return (str(v).replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;"))


def hex_to_b64(h):
    import base64
    h = h[2:] if h.lower().startswith("0x") else h
    return base64.b64encode(bytes.fromhex(h)).decode()


# ---------------------------------------------------------------------- trick-play

TRICK_HEAD_BYTES = 16384   # a moof is a few hundred bytes to a few KB; read more only if it is bigger


def _box_walk(d, i, end):
    while i + 8 <= end:
        size = int.from_bytes(d[i:i + 4], "big")
        typ = d[i + 4:i + 8]
        hdr = 8
        if size == 1:
            if i + 16 > end:
                return
            size, hdr = int.from_bytes(d[i + 8:i + 16], "big"), 16
        elif size == 0:
            size = end - i
        if size < hdr:
            return
        yield typ, i, i + hdr, i + size
        i += size


def keyframe_range(head):
    """(offset, length) of a CMAF segment's opening keyframe, from the start of
    its first moof to the end of its first sample: what an I-frame playlist's
    BYTERANGE names (the same rule as on-demand, services/trickplay/iframes.ts).

    `head` is the segment's first bytes. Returns ("more", n) when the moof is
    not all in `head` (read n bytes and ask again), or None when there is no
    usable keyframe: no moof, the sample size is not in the moof (it would be
    in the init's trex), or the first sample is not a sync sample.
    """
    n = len(head)
    for typ, hs, ps, pe in _box_walk(head, 0, n):
        if typ != b"moof":
            continue
        if pe > n:
            return ("more", pe)
        moof_start = hs
        traf = next(((p2, e2) for t2, _h2, p2, e2 in _box_walk(head, ps, pe) if t2 == b"traf"), None)
        if traf is None:
            return None
        tfhd = trun = None
        for t3, _h3, p3, e3 in _box_walk(head, traf[0], traf[1]):
            if t3 == b"tfhd":
                tfhd = (p3, e3)
            elif t3 == b"trun" and trun is None:
                trun = (p3, e3)
        if tfhd is None or trun is None:
            return None
        # tfhd: base data offset, default sample size and flags
        f = int.from_bytes(head[tfhd[0] + 1:tfhd[0] + 4], "big")
        o = tfhd[0] + 8
        base = moof_start  # default-base-is-moof (CMAF), and the rule for the first traf without one
        if f & 0x01:
            base = int.from_bytes(head[o:o + 8], "big")
            o += 8
        if f & 0x02:
            o += 4
        if f & 0x08:
            o += 4
        def_size = def_flags = None
        if f & 0x10:
            def_size = int.from_bytes(head[o:o + 4], "big")
            o += 4
        if f & 0x20:
            def_flags = int.from_bytes(head[o:o + 4], "big")
        # trun: data offset, first sample's size and flags
        tf = int.from_bytes(head[trun[0] + 1:trun[0] + 4], "big")
        if int.from_bytes(head[trun[0] + 4:trun[0] + 8], "big") < 1:
            return None
        o = trun[0] + 8
        data = 0
        if tf & 0x001:
            data = int.from_bytes(head[o:o + 4], "big", signed=True)
            o += 4
        first_flags = None
        if tf & 0x004:
            first_flags = int.from_bytes(head[o:o + 4], "big")
            o += 4
        if tf & 0x100:
            o += 4
        size = def_size
        if tf & 0x200:
            size = int.from_bytes(head[o:o + 4], "big")
            o += 4
        if tf & 0x400 and first_flags is None:
            first_flags = int.from_bytes(head[o:o + 4], "big")
        flags = first_flags if first_flags is not None else def_flags
        if not size:
            return None
        if flags is not None and flags & 0x00010000:  # sample_is_non_sync_sample
            return None
        end = base + data + size
        if end <= moof_start:
            return None
        return (moof_start, end - moof_start)
    return None


def video_codecs(codecs):
    """The video part of a variant's CODECS: an I-frame stream has no audio."""
    v = [c for c in (codecs or "").split(",") if c.strip() and not c.strip().startswith(("mp4a", "ac-3", "ec-3", "opus", "flac"))]
    return ",".join(c.strip() for c in v)


def master_with_iframes(master, play, kf):
    """The master with an EXT-X-I-FRAME-STREAM-INF per video rung, or None while
    any rung has no I-frame playlist yet (the master never names a playlist that
    is not there). BANDWIDTH is the peak keyframe rate over what is listed."""
    lines = master.splitlines()
    rungs = [(i, lines[i + 1].strip()[:-len(".m3u8")]) for i, L in enumerate(lines)
             if L.startswith("#EXT-X-STREAM-INF:") and i + 1 < len(lines) and lines[i + 1].strip()[:-len(".m3u8")] in play.t]
    if not rungs or any(play.iframes(n, kf) is None for _, n in rungs):
        return None
    extra = []
    for i, name in rungs:
        L = lines[i]
        pub = [sg for sg in play.t[name]["pub"] if kf.get(sg["uri"])]
        peak = max(int(kf[sg["uri"]][1] * 8 / max(sg["dur"], 0.001)) for sg in pub)
        co = re.search(r'CODECS="([^"]+)"', L)
        res = re.search(r"RESOLUTION=(\d+x\d+)", L)
        attrs = [f"BANDWIDTH={peak}"]
        vc = video_codecs(co.group(1) if co else "")
        if vc:
            attrs.append(f'CODECS="{vc}"')
        if res:
            attrs.append(f"RESOLUTION={res.group(1)}")
        attrs.append(f'URI="{name}.iframes.m3u8"')
        extra.append("#EXT-X-I-FRAME-STREAM-INF:" + ",".join(attrs))
    return "\n".join([L for L in lines if L] + extra) + "\n"


def master_playlist(assets_any, tracks, ladder=None):
    """The multivariant playlist. Each variant's attributes come from an asset
    that carries that exact rung (its real CODECS and BANDWIDTH); a rung no
    asset carries yet takes its RESOLUTION and BANDWIDTH from the channel's
    ladder rather than borrowing the nearest rung's, which is what put a 720p
    picture under a 1080p RESOLUTION."""
    rung = {int(r["height"]): r for r in ((ladder or {}).get("rungs") or [])}
    L = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"]
    has_audio = "audio" in tracks
    if has_audio:
        L.append('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"')
    for n in tracks:
        if n == "audio":
            continue
        tr = assets_any.track(n)
        m = dict(getattr(tr, "meta", {}) or {})
        h = int(n[1:])
        if h in rung and m.get("height") != h:
            r = rung[h]
            m.update(height=h, width=int(r.get("width") or round(h * 16 / 9 / 2) * 2),
                     bandwidth=int(int(r.get("bitrate_kbps", 0)) * 1100 + (128000 if has_audio else 0)) or m.get("bandwidth"))
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

def _http(url, token=None, timeout=5, data=None):
    headers = {"Accept": "application/json"}
    if token:
        headers["X-Volt-Ingest-Token"] = token
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, headers=headers, data=body, method="POST" if data is not None else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode()
        return json.loads(raw) if raw and r.headers.get_content_type() == "application/json" else raw


def _get(url, token, timeout=5):
    return _http(url, token, timeout)


def _write(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(text)
    os.replace(tmp, path)


CONTENT_TYPES = {".m3u8": "application/vnd.apple.mpegurl", ".mpd": "application/dash+xml", ".json": "application/json"}


class KeyframeCache:
    """Keyframe ranges of segments, found by reading each segment's head once.
    Bounded (loops and house spots repeat their segments, so the window plus
    a few thousand recent ones covers them). A failed read is retried on later
    ticks, up to three times, then the segment stays out of the I-frame list
    (and the list starts after it, see Playout.iframes)."""
    def __init__(self, reader, cap=5000):
        self.reader, self.cap, self.kf, self.tries = reader, cap, {}, {}

    def resolve(self, segs):
        for sg in segs:
            u = sg["uri"]
            if u in self.kf or not sg.get("src") or self.tries.get(u, 0) >= 3:
                continue
            try:
                head = self.reader.read_range(sg["src"], 0, TRICK_HEAD_BYTES)
                r = keyframe_range(head)
                if isinstance(r, tuple) and r and r[0] == "more" and r[1] <= 1 << 20:
                    r = keyframe_range(self.reader.read_range(sg["src"], 0, r[1]))
                if isinstance(r, tuple) and r and r[0] != "more":
                    self.kf[u] = r
                    continue
                self.tries[u] = 3  # read fine, no usable keyframe: do not ask again
            except Exception as e:
                self.tries[u] = self.tries.get(u, 0) + 1
                print(f"[fast] keyframe of {sg['src']} not read: {e}", file=sys.stderr)
        if len(self.kf) > self.cap:
            for u in list(self.kf)[: len(self.kf) - self.cap]:
                del self.kf[u]


class LocalSink:
    """Playlists into a directory the control plane serves (/origin/<id>/fast/)."""
    def __init__(self, out_dir):
        self.dir = out_dir
        os.makedirs(out_dir, exist_ok=True)

    def put(self, name, text):
        _write(os.path.join(self.dir, name), text)


class S3Sink:
    """Playlists straight into the origin bucket CloudFront serves.

    put_object per changed file, no-cache, the right content type (the encoder's
    sync sidecar labels an MPD as an HLS playlist; a DASH player that checks the
    type refuses it). Unchanged files are not re-sent: master.m3u8 is written
    once, the media playlists and MPD once a second.
    """
    def __init__(self, bucket, prefix, endpoint=None, region=None, client=None):
        self.bucket, self.prefix = bucket, prefix.strip("/")
        self.last = {}
        if client is not None:
            self.s3 = client
        else:
            try:
                import boto3
                self.s3 = boto3.client("s3", endpoint_url=endpoint or None, region_name=region or os.environ.get("AWS_REGION"))
            except ImportError:  # the encoder image has botocore (through awscli) but not boto3
                import botocore.session
                self.s3 = botocore.session.get_session().create_client("s3", endpoint_url=endpoint or None, region_name=region or os.environ.get("AWS_REGION"))

    def put(self, name, text):
        h = hash(text)
        if self.last.get(name) == h:
            return
        ext = os.path.splitext(name)[1]
        self.s3.put_object(Bucket=self.bucket, Key=f"{self.prefix}/{name}", Body=text.encode(),
                           ContentType=CONTENT_TYPES.get(ext, "text/plain"), CacheControl="no-cache, no-store, max-age=0")
        self.last[name] = h


class MediaReader:
    """Reads an asset's VOD playlists wherever the library keeps them.

    master_key '/clips/vod/<id>/master.m3u8'  the control plane's disk (local runs)
    master_key 'vod/<id>/master.m3u8'         the origin bucket (production): S3
                                              GetObject when a client is given, else
                                              HTTP from `media_base` (the CDN)
    """
    def __init__(self, clips_dir="clips", s3=None, bucket=None, media_base=None):
        self.clips_dir, self.s3, self.bucket, self.media_base = clips_dir, s3, bucket, (media_base or "").rstrip("/")

    def read(self, key):
        if key.startswith("/clips/"):
            with open(self.clips_dir.rstrip("/") + key[len("/clips"):]) as f:
                return f.read()
        k = key.lstrip("/")
        if self.s3 is not None and self.bucket:
            return self.s3.get_object(Bucket=self.bucket, Key=k)["Body"].read().decode()
        if self.media_base:
            with urllib.request.urlopen(f"{self.media_base}/{k}", timeout=10) as r:
                return r.read().decode()
        raise OSError(f"no way to read {key}: not under /clips and no S3 or media base configured")

    def read_range(self, key, start, end):
        """Bytes [start, end) of a stored file (fewer at its end): the head of a
        segment, for its keyframe range. Never the whole segment."""
        if key.startswith("/clips/"):
            with open(self.clips_dir.rstrip("/") + key[len("/clips"):], "rb") as f:
                f.seek(start)
                return f.read(end - start)
        k = key.lstrip("/")
        rng = f"bytes={start}-{end - 1}"
        if self.s3 is not None and self.bucket:
            return self.s3.get_object(Bucket=self.bucket, Key=k, Range=rng)["Body"].read()
        if self.media_base:
            req = urllib.request.Request(f"{self.media_base}/{k}", headers={"Range": rng})
            with urllib.request.urlopen(req, timeout=10) as r:
                b = r.read()
                return b[start:end] if r.status == 200 else b
        raise OSError(f"no way to read {key}: not under /clips and no S3 or media base configured")

    def exists(self, key):
        try:
            self.read(key)
            return True
        except Exception:
            return False


def load_asset(master_key, clips_dir="clips", url_prefix="", reader=None):
    """An asset's tracks from its master playlist key. Segment URLs come out
    root-relative to the key's folder (`/clips/vod/<id>/...` or `/vod/<id>/...`),
    prefixed with `url_prefix` (the CDN, in production) so a playlist works from
    any host, including the per-viewer stitcher."""
    reader = reader or MediaReader(clips_dir)
    folder = os.path.dirname("/" + master_key.lstrip("/"))
    url_base = url_prefix.rstrip("/") + folder + "/"
    master = reader.read(master_key)
    variants, audio = parse_master(master)
    media = {}
    for u in [v["uri"] for v in variants] + ([audio] if audio else []):
        media[u] = reader.read(f"{folder}/{u}")
    mpd = None
    try:
        mpd = reader.read(f"{folder}/manifest.mpd")
    except Exception:
        mpd = None
    am = AssetMedia(master, media, url_base, mpd, key_base=folder + "/")
    am.folder = folder
    load_trick(am, reader)
    return am


def load_trick(am, reader):
    """The asset's trick.json (3.2b-6), when it has one and DASH to list it in."""
    if am.trick is not None or not am.dash or not am.folder:
        return am.trick
    try:
        t = json.loads(reader.read(f"{am.folder}/trick.json"))
        if t.get("version") == 1 and t.get("media") and t.get("rep") is not None:
            am.trick = t
    except Exception:
        pass
    return am.trick


def config_from_env_and_args():
    """Arguments, or FAST_CONFIG_JSON (how the ECS task is configured), or both
    (arguments win)."""
    import argparse
    env = json.loads(os.environ.get("FAST_CONFIG_JSON") or "{}")
    s3 = env.get("s3") or {}
    ap = argparse.ArgumentParser(description="Volt FAST playout: a live channel from packaged VOD")
    ap.add_argument("--channel", default=env.get("channel_id"))
    ap.add_argument("--api", default=env.get("api") or os.environ.get("VOLT_API", "http://localhost:3000"))
    ap.add_argument("--token", default=env.get("token") or os.environ.get("INGEST_TOKEN", "dev-ingest-token"))
    ap.add_argument("--out", default=env.get("out_dir"), help="local output dir (origin/<channel>/fast)")
    ap.add_argument("--s3-bucket", default=s3.get("bucket"))
    ap.add_argument("--s3-prefix", default=s3.get("prefix"))
    ap.add_argument("--s3-endpoint", default=s3.get("endpoint") or os.environ.get("AWS_ENDPOINT_URL"))
    ap.add_argument("--media-base", default=env.get("media_base"), help="HTTP base for library media when not read from S3")
    ap.add_argument("--clips-dir", default=env.get("clips_dir") or os.environ.get("CLIPS_DIR", "clips"))
    ap.add_argument("--url-prefix", default=env.get("url_prefix", ""), help="prefix for segment URLs (the CDN), default root-relative")
    ap.add_argument("--dvr", type=float, default=float(env.get("dvr_seconds", 120)))
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--timeline-file", help="read the timeline from a file instead of the API (tests)")
    a = ap.parse_args()
    if not a.channel:
        raise SystemExit("--channel (or FAST_CONFIG_JSON.channel_id) is required")
    if not a.out and not a.s3_bucket:
        raise SystemExit("an output is required: --out <dir> or --s3-bucket")
    return a


def main():
    import signal
    a = config_from_env_and_args()
    sink = S3Sink(a.s3_bucket, a.s3_prefix or f"channel/{a.channel}/fast", a.s3_endpoint) if a.s3_bucket else LocalSink(a.out)
    reader = MediaReader(a.clips_dir, getattr(sink, "s3", None), a.s3_bucket, a.media_base)
    api_ok = not a.timeline_file

    # STATE comes from the control plane first: a restarted task on another
    # server has no disk of its own, and the media sequence must carry on.
    state = None
    if api_ok:
        try:
            r = _http(f"{a.api}/api/fast-playout/{a.channel}/state", a.token)
            state = (r or {}).get("state") if isinstance(r, dict) else None
        except Exception as e:
            print(f"[fast] no saved state from the control plane ({e}); starting fresh", file=sys.stderr)
    if state is None and a.out and os.path.exists(os.path.join(a.out, "state.json")):
        state = json.load(open(os.path.join(a.out, "state.json")))

    stopping = {"now": False}
    signal.signal(signal.SIGTERM, lambda *_: stopping.__setitem__("now", True))

    assets, play, tl, tl_at, trig, trig_at, beat_at, unreadable = {}, None, None, 0, [], 0, 0, set()
    play_ladder = None
    trick, kfc, master_txt, master_has_iframes = False, KeyframeCache(reader), None, False
    trick_at = 0
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
                        if aid and mk and aid not in assets and aid not in unreadable:
                            try:
                                assets[aid] = load_asset(mk, a.clips_dir, a.url_prefix, reader)
                            except Exception as e:
                                unreadable.add(aid)
                                print(f"[fast] asset {aid} not readable: {e}", file=sys.stderr)
                if play is None:
                    # THE CHANNEL'S LADDER (timeline "ladder", services/fast/ladder.ts) decides
                    # the tracks; every asset is packaged to it. Without one (an older control
                    # plane, an audio channel), the first asset's rungs, as before.
                    ladder = tl.get("ladder") or None
                    want = [int(r["height"]) for r in ladder["rungs"]] if ladder and ladder.get("rungs") else None
                    contents = [assets[i["assetId"]] for i in tl["items"] if i["kind"] == "content" and i.get("assetId") in assets]
                    first = next((x for x in contents if want and all(h in x.video for h in want)), None) or (contents[0] if contents else None)
                    if first is None:
                        print("[fast] nothing playable in the timeline yet", file=sys.stderr)
                        unreadable.clear()
                        time.sleep(5)
                        tl = None
                        continue
                    tracks = [f"v{h}" for h in (want or sorted(first.video, reverse=True))] + (["audio"] if first.audio else [])
                    play = Playout(tracks, dvr_sec=a.dvr, seg_sec=float(tl.get("segmentSec", 2)), state=state)
                    master_txt = master_playlist(first, tracks, ladder)
                    sink.put("master.m3u8", master_txt)
                    # read once, like a live channel's profile: a change takes effect on the next start
                    trick = bool(tl.get("trickPlay"))
                    play_ladder = (ladder or {}).get("groupId")
                elif (tl.get("ladder") or {}).get("groupId") != play_ladder:
                    # the channel's ladder changed: the tracks are fixed for this run (a player
                    # holding the old master would lose its variants), so the new one takes
                    # effect when the playout restarts
                    print("[fast] the channel's ladder changed; it takes effect when the playout restarts", file=sys.stderr)
                    play_ladder = (tl.get("ladder") or {}).get("groupId")
                play.schedule(expand_parts(tl["items"], assets, play.seg), assets, now)
            if api_ok and now - trig_at > 5:
                try:
                    trig = _get(f"{a.api}/api/streams/{a.channel}/timed-events?from={iso(now - a.dvr)}&to={iso(now + 120)}", a.token).get("triggers", [])
                except Exception:
                    pass  # keep the last good list
                trig_at = now
            play.tick(now)
            if play.holes and now - getattr(play, "_hole_warned", 0) > 300:
                play._hole_warned = now
                print(f"[fast] {len(play.holes)} gap(s) in the guide have no loop or slate packaged; closed up (first at {iso(play.holes[0][0])}, {play.holes[0][1]:.1f}s). Set a loop or slate for this channel.", file=sys.stderr)
            for n in play.tracks:
                txt = play.hls(n, trig)
                if txt:
                    sink.put(f"{n}.m3u8", txt)
            if trick:
                vids = [n for n in play.tracks if n != "audio"]
                for n in vids:
                    kfc.resolve(play.t[n]["pub"])
                    txt = play.iframes(n, kfc.kf)
                    if txt:
                        sink.put(f"{n}.iframes.m3u8", txt)
                if not master_has_iframes:
                    m2 = master_with_iframes(master_txt, play, kfc.kf)
                    if m2:
                        sink.put("master.m3u8", m2)
                        master_has_iframes = True
            if trick and now - trick_at > 60:
                # trick tracks made since the asset was loaded (3.2b-6): the control
                # plane builds them when the channel first asks for its timeline
                trick_at = now
                for am in assets.values():
                    load_trick(am, reader)
            mpd = play.dash(assets, now, trig, trick=trick)
            if mpd:
                sink.put("manifest.mpd", mpd)
            if a.out:
                _write(os.path.join(a.out, "state.json"), json.dumps(play.state()))
            if api_ok and (now - beat_at > 5 or stopping["now"]):
                lead = play.t[play.tracks[0]]
                last = lead["pub"][-1] if lead["pub"] else None
                try:
                    _http(f"{a.api}/api/fast-playout/{a.channel}/heartbeat", a.token, data={
                        "state": play.state(), "lastPdt": iso(last["pdt"] + last["dur"]) if last else None,
                        "mediaSequence": lead["msn"], "tracks": play.tracks, "unreadable": sorted(unreadable),
                        "stopping": stopping["now"],
                        # gaps in the guide with no loop or slate to fill them, closed up (the channel runs early)
                        "unfilledGaps": [{"at": iso(t), "sec": round(d, 3)} for t, d in play.holes[:20]],
                    })
                except Exception as e:
                    print(f"[fast] heartbeat failed: {e}", file=sys.stderr)
                beat_at = now
        except Exception as e:  # never die on one bad tick; the last good playlists stay up
            print(f"[fast] tick failed: {e}", file=sys.stderr)
        if a.once or stopping["now"]:
            break
        time.sleep(1.0)


if __name__ == "__main__":
    main()
