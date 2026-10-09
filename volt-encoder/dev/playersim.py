#!/usr/bin/env python3
"""playersim.py: would a live player have stalled? Measured, not assumed.

    python3 dev/playersim.py --dir <run dir> --seconds 200 [--behind 3] [--json]
    python3 dev/playersim.py --url http://host/origin/<id>/live/master_cc.m3u8 --seconds 200

Polls the DELIVERED master's first video variant every 0.5s and records the moment
each segment first appears. Then replays a standard live player against that record:
it joins `--behind` segments behind the edge (hls.js liveSyncDurationCount, 3 by
default), plays at 1x, needs each segment ~0.5s before its playhead reaches it (fetch
plus append), and rebuffers whenever a segment was not listed in time.

Prints the stall count and total stalled seconds, plus what was delivered (live
segments, loop segments, discontinuities). "Seamless" here means: 0 stalls.

Headless Chromium has no H.264 decoder, so a real browser cannot be scripted against
these streams in CI; this measures the one thing a player's buffer depends on, which
is whether the next segment was there when it was needed.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request


def fetch(src):
    if re.match(r"^https?://", src):
        with urllib.request.urlopen(src, timeout=5) as r:
            return r.read().decode("utf-8", "replace")
    with open(src, encoding="utf-8") as f:
        return f.read()


def join(base, rel):
    if re.match(r"^https?://", rel):
        return rel
    if re.match(r"^https?://", base):
        return base.rsplit("/", 1)[0] + "/" + rel
    return os.path.join(os.path.dirname(base), rel)


def lead_variant(master):
    lines = fetch(master).splitlines()
    for i, l in enumerate(lines):
        if l.startswith("#EXT-X-STREAM-INF"):
            for x in lines[i + 1:]:
                if x.strip() and not x.startswith("#"):
                    return join(master, x.strip())
    return None


def parse(text):
    seq, out, disc, dur, mapuri = 0, [], False, None, None
    for l in text.splitlines():
        if l.startswith("#EXT-X-MEDIA-SEQUENCE:"):
            seq = int(l.split(":")[1])
        elif l.startswith("#EXT-X-DISCONTINUITY") and not l.startswith("#EXT-X-DISCONTINUITY-SEQUENCE"):
            disc = True
        elif l.startswith("#EXT-X-MAP:"):
            mo = re.search(r'URI="([^"]+)"', l)
            mapuri = mo.group(1) if mo else mapuri
        elif l.startswith("#EXTINF:"):
            dur = float(l[8:].split(",")[0])
        elif l.strip() and not l.startswith("#") and dur is not None:
            out.append({"uri": l.strip(), "dur": dur, "disc": disc, "map": mapuri})
            disc, dur = False, None
    return seq, out


def parse_mpd(text):
    """Every video segment the MPD lists for its FIRST video Representation in each
    Period, as (key, start_seconds_on_the_presentation_timeline, duration, period kind)."""
    import xml.etree.ElementTree as ET
    root = ET.fromstring(text)
    for el in root.iter():
        if "}" in el.tag:
            el.tag = el.tag.split("}", 1)[1]
    out = []
    from datetime import datetime
    ast_s = root.get("availabilityStartTime")
    ast = datetime.fromisoformat(ast_s.replace("Z", "+00:00")).timestamp() if ast_s else None

    def secs(v):
        mo = re.match(r"PT([\d.]+)S", v or "PT0S")
        return float(mo.group(1)) if mo else 0.0
    for per in root.findall("Period"):
        pstart = secs(per.get("start"))
        pend = pstart + secs(per.get("duration")) if per.get("duration") else None
        vid = None
        for aset in per.findall("AdaptationSet"):
            if aset.get("contentType") == "video" or "video" in (aset.get("mimeType") or ""):
                vid = aset
                break
        if vid is None:
            continue
        rep = vid.find("Representation")
        tpl = rep.find("SegmentTemplate") if rep is not None else None
        if tpl is None:
            continue
        ts = int(tpl.get("timescale", "1"))
        pto = int(tpl.get("presentationTimeOffset", "0"))
        num = int(tpl.get("startNumber", "1"))
        media = tpl.get("media", "")
        kind = "loop" if "filler/" in media else "live"
        for S in tpl.find("SegmentTimeline").findall("S"):
            t, d, r = int(S.get("t")), int(S.get("d")), int(S.get("r", "0"))
            for _ in range(r + 1):
                st = pstart + (t - pto) / ts
                dd = d / ts
                # the player plays a Period's media only inside the Period: cut to it
                if pend is not None and st >= pend - 1e-3:
                    t += d
                    num += 1
                    continue
                if pend is not None:
                    dd = min(dd, pend - st)
                if st < pstart:
                    dd, st = dd - (pstart - st), pstart
                out.append(((per.get("id"), num), st, dd, kind,
                            media.replace("$Number$", str(num)),
                            None if ast is None else ast + pstart + (t - pto) / ts + d / ts))
                t += d
                num += 1
    return out


def main_dash(a):
    src = a.url
    t0 = time.time()
    seen, errors, periods = {}, 0, set()
    while time.time() - t0 < a.seconds:
        now = time.time()
        try:
            segs = parse_mpd(fetch(src))
        except Exception:  # noqa: BLE001
            errors += 1
            time.sleep(0.5)
            continue
        for key, start, dur, kind, uri, avail in segs:
            periods.add(key[0])
            if key not in seen:
                seen[key] = {"t": now, "start": start, "dur": dur, "kind": kind, "uri": uri, "avail": avail}
            else:                            # a Period that closed since: its cut applies
                seen[key]["start"], seen[key]["dur"] = start, dur
        time.sleep(0.5)
    try:                                     # segments a Period's later cut removed
        fin = parse_mpd(fetch(src))
        fin_keys, fin_pers = {x[0] for x in fin}, {x[0][0] for x in fin}
        for k in [k for k in seen if k[0] in fin_pers and k not in fin_keys]:
            del seen[k]
    except Exception:  # noqa: BLE001
        pass
    if len(seen) < a.behind + 2:
        print("FAIL the MPD never listed enough segments")
        sys.exit(1)
    order = sorted(seen.values(), key=lambda s: s["start"])
    if a.dump:
        with open(a.dump, "w") as fh:
            json.dump([dict(s, key=list(k)) for k, s in seen.items()], fh)
    # timeline sanity: the presentation timeline has no holes or overlaps across Periods
    # (an OVERLAP where one Period hands over to the next is normal: the player cuts the
    # earlier Period's media at its end. Only a HOLE leaves the player nothing to play.)
    holes = [(round(x["start"] + x["dur"], 3), round(y["start"], 3)) for x, y in zip(order, order[1:])
             if abs(y["start"] - (x["start"] + x["dur"])) > 0.05]
    # join `behind` segments back from the edge as first seen
    # join the way the HLS check does: at the first moment MORE than `behind` segments
    # are listed, `behind` segments back from the edge
    times = sorted({s["t"] for s in order})
    first_t = times[-1]
    for tt in times:
        if sum(1 for s in order if s["t"] <= tt) > a.behind:
            first_t = tt
            break
    listed = [s for s in order if s["t"] <= first_t]
    start_idx = max(0, len(listed) - a.behind)
    play = order[start_idx:]
    play_wall = first_t + 1.0
    pos, stalls, stalled = 0.0, [], 0.0
    for s in play:
        need = play_wall + pos - 0.5
        if s["t"] > need:
            late = s["t"] - need
            stalls.append({"start": round(s["start"], 1), "late_sec": round(late, 2), "kind": s["kind"]})
            stalled += late
            play_wall += late
        pos += s["dur"]
    # A clock-driven client (dash.js, Shaka, ExoPlayer) does not wait for the listing:
    # it requests segment N at AST + Period@start + its end. Every segment must be
    # listed (and so on disk) by then, or that request 404s.
    early = [{"start": round(s["start"], 1), "kind": s["kind"], "listed_after_avail_sec": round(s["t"] - s["avail"], 2)}
             for s in play if s.get("avail") is not None and s["t"] - 0.5 > s["avail"]]
    seq, last = [], None
    for s in play:
        if s["kind"] != last:
            seq.append([s["kind"], 0])
            last = s["kind"]
        seq[-1][1] += 1
    res = {"segments_played": len(play), "periods": len(periods), "timeline_holes": holes[:5],
           "stalls": len(stalls), "stalled_sec": round(stalled, 2), "stall_detail": stalls[:10],
           "sequence": " -> ".join(f"{k} x{n}" for k, n in seq), "poll_errors": errors,
           "requested_before_listed": len(early), "early_detail": early[:10]}
    if a.json:
        print(json.dumps(res))
    print(f"DASH: played {len(play)} segments over {len(periods)} Period(s) ({res['sequence']})")
    bad = False
    if holes:
        print(f"FAIL timeline holes/overlaps between segments: {holes[:5]}")
        bad = True
    if stalls:
        print(f"FAIL {len(stalls)} stall(s), {res['stalled_sec']}s stalled: {stalls[:5]}")
        bad = True
    if early:
        print(f"FAIL {len(early)} segment(s) listed after their AST availability time (a clock-driven player would 404): {early[:5]}")
        bad = True
    if bad:
        sys.exit(1)
    print("OK no stalls, a continuous timeline across Periods, and every segment listed before its availability time")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir")
    ap.add_argument("--url")
    ap.add_argument("--seconds", type=int, default=120)
    ap.add_argument("--behind", type=int, default=3)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--dump", help="DASH: write every segment's first-seen record here")
    a = ap.parse_args()
    if a.url and a.url.split("?")[0].endswith(".mpd"):
        for _ in range(180):
            try:
                fetch(a.url)
                break
            except Exception:  # noqa: BLE001
                time.sleep(0.5)
        return main_dash(a)
    master = a.url or os.path.join(a.dir, "master_cc.m3u8")
    t_end = time.time() + 90
    variant = None
    while time.time() < t_end:
        try:
            variant = lead_variant(master)
            if variant and parse(fetch(variant))[1]:
                break
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.5)
    if not variant:
        print(f"FAIL no delivered playlist at {master}")
        sys.exit(1)

    seen = {}            # absolute index -> {first_seen, dur, uri, disc, kind}
    t0 = time.time()
    first_listing = None
    errors = 0
    while time.time() - t0 < a.seconds:
        now = time.time()
        try:
            seq, segs = parse(fetch(variant))
        except Exception:  # noqa: BLE001
            errors += 1
            time.sleep(0.5)
            continue
        if first_listing is None and len(segs) > a.behind:
            first_listing = (now, seq, segs)
        for i, s in enumerate(segs):
            k = seq + i
            if k not in seen:
                seen[k] = {"t": now, "dur": s["dur"], "uri": s["uri"], "disc": s["disc"],
                           "kind": "loop" if s["uri"].startswith("filler/") or "/filler/" in s["uri"] else "live"}
        time.sleep(0.5)

    if not first_listing:
        print("FAIL never saw enough segments to join")
        sys.exit(1)
    jt, jseq, jsegs = first_listing
    start_k = jseq + len(jsegs) - a.behind      # join `behind` segments from the edge
    keys = sorted(k for k in seen if k >= start_k)
    play_wall = jt + 1.0                         # 1s to start up
    pos = 0.0                                    # media seconds since join
    stalls, stalled = [], 0.0
    MARGIN = 0.5
    for k in keys:
        s = seen[k]
        need = play_wall + pos - MARGIN
        if s["t"] > need:
            late = s["t"] - need
            stalls.append({"segment": k, "late_sec": round(late, 2), "kind": s["kind"]})
            stalled += late
            play_wall += late
        pos += s["dur"]
    played = [seen[k] for k in keys]
    res = {"variant": variant, "segments_played": len(played),
           "live": sum(1 for s in played if s["kind"] == "live"),
           "loop": sum(1 for s in played if s["kind"] == "loop"),
           "discontinuities": sum(1 for s in played if s["disc"]),
           "stalls": len(stalls), "stalled_sec": round(stalled, 2), "stall_detail": stalls[:10],
           "poll_errors": errors}
    seq_str, last = [], None
    for s in played:
        if s["kind"] != last:
            seq_str.append([s["kind"], 0])
            last = s["kind"]
        seq_str[-1][1] += 1
    res["sequence"] = " -> ".join(f"{k} x{n}" for k, n in seq_str)
    if a.json:
        print(json.dumps(res))
    print(f"played {res['segments_played']} segments ({res['sequence']}), "
          f"{res['discontinuities']} discontinuities")
    if stalls:
        print(f"FAIL {len(stalls)} stall(s), {res['stalled_sec']}s stalled: {stalls[:5]}")
        sys.exit(1)
    print("OK no stalls: a player behind the live edge never waited for a segment")


if __name__ == "__main__":
    main()
