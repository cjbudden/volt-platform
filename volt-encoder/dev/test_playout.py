"""Unit checks for playout.py: the manifest-level splice. Pure logic, no media.

    PYTHONPATH=bin python3 dev/test_playout.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "bin"))
import playout as P  # noqa: E402

SEG = 4.0
EPOCH = 1_000_000.0


def iso(t):
    return f"T{t:.3f}"


def shaka(label, first, last, disc_before=None):
    lines = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-TARGETDURATION:4", f'#EXT-X-MAP:URI="{label}/init.mp4"']
    for n in range(first, last + 1):
        if disc_before == n:
            lines.append("#EXT-X-DISCONTINUITY")
        lines += [f"#EXTINF:{SEG:.3f},", f"{label}/seg_{n}.m4s"]
    return "\n".join(lines) + "\n"


def filler(label, n=3):
    ts = 48000 if label == "audio" else 12800
    return {"init": f"filler/{label}/init.mp4", "timescale": ts,
            "segments": [{"uri": f"filler/{label}/seg_{i}.m4s", "dur": SEG, "d": int(SEG * ts)} for i in range(1, n + 1)]}


FILLERS = {"720p": filler("720p"), "360p": filler("360p"), "audio": filler("audio")}


def true_pdt(uri, jump_at=None, jump_to=0.0):
    n = P._seg_key(uri)
    if jump_at is not None and n >= jump_at:
        return EPOCH + jump_to + (n - jump_at) * SEG
    return EPOCH + (n - 1) * SEG


class Sim:
    """Drive a Playout like the encoder does: a pass every second, the packager
    writing a segment every SEG seconds while the source is up."""

    def __init__(self, fillers=FILLERS, hold=2.4, pdt=true_pdt):
        self.p = P.Playout(fillers, window_sec=120, hold_sec=hold, pdt_of=pdt)
        self.slots, self.dropped = [], []
        self.p.media_of = lambda uri: (int(round((pdt(uri) - EPOCH + 10) * 90000)), int(SEG * 90000), 90000)
        self.p.on_slot = lambda src, dst, t: self.slots.append((src, dst, t))
        self.p.on_drop = lambda uri: self.dropped.append(uri)
        self.now = 0.0
        self.last = 0                      # newest segment the packager has written
        self.next_at = SEG                 # when the packager writes the next one
        self.appends = []                  # times the lead playlist grew

    def run(self, seconds, up=True, disc_before=None):
        for _ in range(int(seconds)):
            self.now += 1.0
            if not up:
                self.next_at = self.now + SEG
            elif self.now >= self.next_at:
                self.last += 1
                self.next_at += SEG
            if self.last:
                first = max(1, self.last - 20)
                pl = {"stream_0.m3u8": shaka("720p", first, self.last, disc_before),
                      "stream_1.m3u8": shaka("360p", first, self.last, disc_before),
                      "stream_2.m3u8": shaka("audio", first, self.last, disc_before)}
                before = len(self.p.tracks["stream_0.m3u8"].entries) if "stream_0.m3u8" in self.p.tracks else 0
                self.p.update(self.now, pl, "stream_0.m3u8")
                after = len(self.p.tracks["stream_0.m3u8"].entries)
                if after > before:
                    self.appends.append(self.now)

    def entries(self, name="stream_0.m3u8"):
        return self.p.tracks[name].entries


passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS {name}")
    else:
        failed += 1
        print(f"FAIL {name} {detail}")


# ---- steady live --------------------------------------------------------------
s = Sim()
s.run(40)
e = s.entries()
check("steady live: every packager segment is delivered", [x.uri for x in e] == [f"720p/seg_{n}.m4s" for n in range(1, s.last + 1)])
check("steady live: no discontinuity", not any(x.disc for x in e))
check("steady live: PDT is the encoder's one clock (epoch + tfdt)", all(abs(x.pdt - true_pdt(x.uri)) < 1e-9 for x in e))
check("steady live: no splice", s.p.splices == 0 and s.p.mode == "live")

# ---- outage -------------------------------------------------------------------
s.run(30, up=False)
e = s.entries()
kinds = [x.kind for x in e]
nfill = kinds.count("filler")
check("outage: the loop is spliced in", nfill >= 6, f"(filler slots {nfill})")
check("outage: one splice, mode filler", s.p.splices == 1 and s.p.mode == "filler")
first_f = kinds.index("filler")
check("outage: discontinuity on the first loop segment only", e[first_f].disc and not any(x.disc for x in e[first_f + 1:]))
check("outage: loop segments use the loop's own init", all(x.init == "filler/720p/init.mp4" for x in e[first_f:]))
srcs = [a for a, b, t in s.slots if b.startswith("filler/720p/")]
check("outage: the loop starts from its top", srcs[0].endswith("seg_1.m4s"))
check("outage: and loops round", [x.rsplit("_", 1)[1] for x in srcs[:4]] == ["1.m4s", "2.m4s", "3.m4s", "1.m4s"])
ts720 = [t for a, b, t in s.slots if b.startswith("filler/720p/")]
check("outage: slot copies get a decode time continuing from the slot before", ts720[:4] == [0, 51200, 102400, 153600])
check("outage: every loop slot has its own URI", len({x.uri for x in e[first_f:]}) == len(e[first_f:]))
gaps = [b.pdt - (a.pdt + a.dur) for a, b in zip(e, e[1:])]
check("outage: delivered PDT has no holes and no overlaps", all(abs(g) < 1e-6 for g in gaps), str([round(g, 3) for g in gaps if abs(g) > 1e-6]))
lens = {n: [x.kind for x in t.entries].count("filler") for n, t in s.p.tracks.items()}
check("outage: every rendition and the audio got the same loop slots", len(set(lens.values())) == 1, str(lens))
iv = [b - a for a, b in zip(s.appends, s.appends[1:])]
check("outage: a new segment is listed at least every segment + hold", max(iv) <= SEG + 2.4 + 1.0, str(max(iv)))

# ---- back to live -------------------------------------------------------------
edge_before = s.p.tracks["stream_0.m3u8"].edge()
s.run(20)
e = s.entries()
back = next(i for i in range(len(e) - 1, -1, -1) if e[i].kind == "live" and e[i - 1].kind == "filler")
check("resume: back to live", s.p.mode == "live")
check("resume: discontinuity on the first live segment", e[back].disc)
check("resume: live init again", e[back].init == "720p/init.mp4")
check("resume: the first live segment starts exactly at the loop's end", abs(e[back].pdt - (e[back - 1].pdt + e[back - 1].dur)) < 1e-6)
check("resume: later live segments keep the same shift", all(abs((x.pdt - true_pdt(x.uri)) - s.p.tracks["stream_0.m3u8"].shift) < 1e-6 for x in e[back:]))
check("resume: subtitles get the same shift via shift_at", abs(s.p.shift_at(true_pdt(e[back].uri)) - s.p.tracks["stream_0.m3u8"].shift) < 1e-9)
check("resume: and media before the outage keeps shift 0", s.p.shift_at(EPOCH) == 0.0)
dl = {n: [x.disc for x in t.entries].count(True) for n, t in s.p.tracks.items()}
check("resume: every track has the same discontinuities", len(set(dl.values())) == 1, str(dl))

# ---- render ---------------------------------------------------------------------
txt = s.p.render("stream_1.m3u8", iso)
check("render: discontinuity sequence header", "#EXT-X-DISCONTINUITY-SEQUENCE:0" in txt)
check("render: two discontinuities, two loop/live map switches", txt.count("#EXT-X-DISCONTINUITY\n") == 2 and txt.count('URI="filler/360p/init.mp4"') == 1)
check("render: first line is EXTM3U and every segment has a PDT", txt.startswith("#EXTM3U") and txt.count("#EXT-X-PROGRAM-DATE-TIME") == txt.count("#EXTINF"))

# ---- window / sequences -------------------------------------------------------------
s2 = Sim()
s2.p.window_sec = 24
for t in s2.p.tracks.values():
    t.window_sec = 24
s2.run(20)
for t in s2.p.tracks.values():
    t.window_sec = 24
s2.run(20, up=False)
s2.run(60)
t0 = s2.p.tracks["stream_0.m3u8"]
check("window: trimmed to the DVR window", sum(x.dur for x in t0.entries) <= 24 + SEG)
check("window: media sequence advanced", t0.media_seq > 0)
check("window: discontinuity sequence counts tags that scrolled out", t0.disc_seq == 2 and not any(x.disc for x in t0.entries), f"(disc_seq {t0.disc_seq})")
r = s2.p.render("stream_0.m3u8", iso)
check("window: the first segment still carries its init", r.splitlines()[5].startswith("#EXT-X-MAP"))

# ---- packager's own discontinuity (source timestamps jumped) -----------------------
def jumping(uri):
    return true_pdt(uri, jump_at=8, jump_to=-500.0)


s3 = Sim(pdt=jumping)
s3.run(28, disc_before=8)
s3.run(12, disc_before=8)
e3 = s3.entries()
i8 = next(i for i, x in enumerate(e3) if x.uri.endswith("seg_8.m4s"))
check("source disc: carried into the delivered playlist", e3[i8].disc)
check("source disc: PDT stays continuous even though the source clock jumped back 500s",
      abs(e3[i8].pdt - (e3[i8 - 1].pdt + e3[i8 - 1].dur)) < 1e-6)
check("source disc: no loop for an on-time segment", s3.p.splices == 0)

# ---- no filler built yet -> never splice (plain copy) -------------------------------
s4 = Sim(fillers={})
s4.run(20)
s4.run(20, up=False)
check("no filler: nothing is spliced", s4.p.splices == 0 and all(x.kind == "live" for x in s4.entries()))

# ---- a late but not lost segment does not flash the loop ------------------------------
s5 = Sim()
s5.run(20)
s5.next_at += 1.5                             # the packager is 1.5s late with one segment
s5.run(20)
check("jitter: a segment 1.5s late does not splice", s5.p.splices == 0)

# ---- forced (pre-flight test) -----------------------------------------------------
s7 = Sim()
s7.run(20)
s7.p.forced = True
s7.run(16)
k7 = [x.kind for x in s7.entries()]
check("forced: the loop is delivered while the source is still up", k7.count("filler") >= 3 and s7.p.mode == "filler")
s7.p.forced = False
s7.run(10)
e7 = s7.entries()
check("forced: lifting it returns to live with a discontinuity", s7.p.mode == "live" and e7[-1].kind == "live"
      and any(x.disc and x.kind == "live" for x in e7))
g7 = [b.pdt - (a.pdt + a.dur) for a, b in zip(e7, e7[1:])]
check("forced: PDT continuous through it", all(abs(g) < 1e-6 for g in g7))

# ---- DASH ---------------------------------------------------------------------------
import re as _re  # noqa: E402


def reps(kind, t):
    lab = t.label or "x"
    if lab.startswith("audio"):
        return {"set": "audio", "set_attrs": {"contentType": "audio"}, "attrs": {"id": "a", "bandwidth": 128000}}
    return {"set": "video", "set_attrs": {"contentType": "video"}, "attrs": {"id": lab, "bandwidth": 1}}


sd = Sim()
sd.run(40)
sd.run(30, up=False)
sd.run(30)
mpd = sd.p.render_mpd(iso, reps, SEG, sd.now)
pers = _re.findall(r'<Period id="(p\d+)" start="PT([\d.]+)S"', mpd)
durs = _re.findall(r'<Period id="p\d+" start="PT([\d.]+)S"(?: duration="PT([\d.]+)S")?>', mpd)
check("dash: three Periods (live, loop, live)", [p for p, _ in pers] == ["p0", "p1", "p2"], str(pers))
pp = sd.p.periods()
check("dash: Period kinds", [k for _, k, _, _ in pp] == ["live", "filler", "live"])
check("dash: each Period starts where the one before ends", all(abs(a[3] - b[2]) < 1e-6 for a, b in zip(pp, pp[1:])))
starts = [float(x) for _, x in pers]
check("dash: closed Periods carry a duration that reaches the next start, the open one none",
      all(d and abs(float(a) + float(d) - float(b)) < 0.002 for (a, d), (b, _) in zip(durs, durs[1:])) and durs[-1][1] == "", str(durs))
check("dash: Period@start matches the HLS PDT", all(abs(st - (p[2] - sd.p.ast)) < 0.002 for st, p in zip(starts, pp)))
check("dash: loop Period addresses its own slot copies", 'media="filler/720p/p1_$Number$.m4s"' in mpd and 'media="720p/seg_$Number$.m4s"' in mpd)
loop_p = mpd.split('<Period id="p1"')[1].split("</Period>")[0]
check("dash: loop timeline starts at 0 with no PTO offset", 'presentationTimeOffset="0"' in loop_p and '<S t="0" d="51200"' in loop_p)
check("dash: every track is in every Period (video x3 + audio)", all(mpd.split(f'<Period id="{p}"')[1].split("</Period>")[0].count("<Representation") == 3 for p, _ in pers))

# ---- DASH: audio cut ~1.4s away from video (as the packager really does) ----------
def pdt_off(uri):
    return true_pdt(uri) - (1.4 if uri.startswith("audio/") else 0.0)


def coverage(mpd):
    """For every Period and Representation: (period, media, rel start, rel end, period dur)."""
    import xml.etree.ElementTree as ET
    root = ET.fromstring(mpd)
    for el in root.iter():
        el.tag = el.tag.split("}", 1)[-1]
    out = []
    for per in root.findall("Period"):
        pd = per.get("duration")
        pd = float(pd[2:-1]) if pd else None
        for rep in per.iter("Representation"):
            tpl = rep.find("SegmentTemplate")
            ts, pto = int(tpl.get("timescale")), int(tpl.get("presentationTimeOffset"))
            ss = []
            for S in tpl.find("SegmentTimeline").findall("S"):
                t, d, r = int(S.get("t")), int(S.get("d")), int(S.get("r", "0"))
                for _ in range(r + 1):
                    ss.append((t, d))
                    t += d
            jumps = sum(1 for (a, da), (b, _) in zip(ss, ss[1:]) if b != a + da)
            out.append((per.get("id"), tpl.get("media"), (ss[0][0] - pto) / ts, (ss[-1][0] + ss[-1][1] - pto) / ts, pd, jumps))
    return out


so = Sim(pdt=pdt_off)
so.p.media_of = lambda uri: (int(round((pdt_off(uri) - EPOCH + 10) * 90000)), int(SEG * 90000), 90000)
so.run(40)
so.run(30, up=False)
so.run(30)
mo = so.p.render_mpd(iso, reps, SEG, so.now)
cov = coverage(mo)
check("dash offset audio: still three Periods", sorted({c[0] for c in cov}) == ["p0", "p1", "p2"], str(sorted({c[0] for c in cov})))
holes = [c for c in cov if c[2] > 0.001 or (c[4] is not None and c[3] < c[4] - 0.001)]
check("dash offset audio: every track covers its whole Period (no hole for the player to wait on)", not holes, str(holes))
p1 = [c for c in cov if c[0] == "p1"]
check("dash offset audio: the loop Period starts where audio ran out (1.4s before video)",
      abs(float(mo.split('<Period id="p1" start="PT')[1].split("S")[0]) - float(mo.split('<Period id="p0" start="PT')[1].split("S")[0])
          - (40 - 4 - 1.4 - 0.0)) < 4.01, str(p1))
mo2 = so.p.render_mpd(iso, reps, SEG, so.now + 1)
check("dash offset audio: Period starts do not move between updates",
      [x for x in mo.split() if x.startswith("start=")] == [x for x in mo2.split() if x.startswith("start=")])

# the other way round too (audio cut AFTER video), and at every pass, not just the end:
# an OPEN Period never lists media past where its shortest track ends
for off in (1.4, -2.6):
    def pdt_o(uri, off=off):
        return true_pdt(uri) - (off if uri.startswith("audio/") else 0.0)
    sx = Sim(pdt=pdt_o)
    sx.p.media_of = lambda uri, f=pdt_o: (int(round((f(uri) - EPOCH + 10) * 90000)), int(SEG * 90000), 90000)
    bad, holes_x, shape_bad = [], [], []
    for phase, secs_, up in (("live", 40, True), ("loop", 30, False), ("back", 30, True)):
        for _ in range(secs_):
            sx.run(1, up=up)
            m = sx.p.render_mpd(iso, reps, SEG, sx.now)
            if not m:
                continue
            cv = coverage(m)
            last = cv[-1][0]
            per_n = {}
            for c in cv:
                per_n[c[0]] = per_n.get(c[0], 0) + 1
            ns = list(per_n.values())
            if any(b < a for a, b in zip(ns, ns[1:])):
                shape_bad.append((phase, per_n))
            mine = [c for c in cv if c[0] == last]
            if len({round(c[3], 3) for c in mine if "audio" in c[1]} | set()) and mine:
                short = min(c[3] for c in mine)
                bad += [(phase, c) for c in mine if c[3] > short + 4.001]
            holes_x += [c for c in cv if c[0] != last and (c[2] > 0.001 or c[3] < c[4] - 0.001 or c[3] > c[4] + 0.02)]
    check(f"dash audio offset {off:+}: no Period ever lacks a track the Period before it has", not shape_bad, str(shape_bad[:2]))
    check(f"dash audio offset {off:+}: open Period never runs a track a segment past the others", not bad, str(bad[:3]))
    check(f"dash audio offset {off:+}: closed Periods covered by every track exactly (no hole, nothing past the end)", not holes_x, str(holes_x[:3]))

# the media clock jumping on ONE track at a time (a package channel's source switch: the
# packager declares it per playlist, at different segments): every jump gets a Period
# boundary, so no Representation's timeline ever jumps
def media_jump(uri):
    n = P._seg_key(uri)
    at = 15 if uri.startswith("audio/") else 16
    base = int(round((true_pdt(uri) - EPOCH + 10) * 90000))
    return (base + (7_000_000 if n >= at else 0), int(SEG * 90000), 90000)


sj = Sim()
sj.p.media_of = media_jump
sj.run(100)
mj = sj.p.render_mpd(iso, reps, SEG, sj.now)
cj = coverage(mj)
check("dash per-track clock jump: no Representation timeline jumps", all(c[5] == 0 for c in cj), str([c for c in cj if c[5]][:3]))
check("dash per-track clock jump: a Period at each track's jump (3 Periods)", len({c[0] for c in cj}) == 3, str(sorted({c[0] for c in cj})))
check("dash per-track clock jump: closed Periods covered exactly by every track",
      not [c for c in cj if c[4] is not None and (c[2] > 0.001 or abs(c[3] - c[4]) > 0.02)], str([c for c in cj if c[4] is not None][:6]))
made = [d for _s, d, _t in so.slots if "/p1_" in d]
check("dash offset audio: loop Period slots are written once each", len(made) == len(set(made)) and made, str(made[:6]))
live2 = mpd.split('<Period id="p2"')[1].split("</Period>")[0]
pto2 = int(_re.search(r'presentationTimeOffset="(\d+)"', live2).group(1))
t2 = int(_re.search(r'<S t="(\d+)"', live2).group(1))
check("dash: back-to-live Period PTO is the first live segment's decode time", pto2 == t2)
check("dash: valid XML", __import__("xml.dom.minidom").dom.minidom.parseString(mpd) is not None)

sw = Sim()
sw.p.window_sec = 24
sw.run(10)
for t in sw.p.tracks.values():
    t.window_sec = 24
sw.run(10, up=False)
sw.run(60)
check("dash: loop slots that leave the window are dropped (disk is reclaimed)", len(sw.dropped) > 0 and all("/s_" in u for u in sw.dropped))

# ---- truncated packager playlist is ignored -------------------------------------------
s6 = Sim()
s6.run(12)
n = len(s6.entries())
s6.p.update(s6.now + 1, {"stream_0.m3u8": "#EXTM3U\n#EXTINF:4.000,\n720p/se"}, "stream_0.m3u8")
check("truncated: a half-written playlist changes nothing", len(s6.entries()) == n)

print(f"\nplayout: {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
