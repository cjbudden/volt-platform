#!/usr/bin/env python3
"""classify.py <run_dir> [timeline] — what did the viewer actually see, segment by segment.

Decodes the first frame of every delivered 360p segment (init + seg), reads the mean
colour of a patch that the moving box and watermark never touch, and names it:
RED=primary, BLUE=backup, GREEN=loop, YELLOW=slate. Also reports whether the
watermark (a white square, bottom-right) is present. Prints run-lengths so a
failover sequence reads as one line: RED x14 -> BLUE x12 -> GREEN x12 -> RED x15.
"""
import glob, os, re, subprocess, sys, tempfile

run = sys.argv[1]
W, H = 160, 90
if run.endswith((".ts", ".mp4")) and os.path.isfile(run):
    # A RECORDING made by a real player (gpac following the live MPD): one frame per
    # 4 seconds of what it actually played, classified like the segments are
    rend = os.path.basename(run)
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", run, "-vf", f"fps=0.25,scale={W}:{H}",
                        "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True)
    frames = [r.stdout[i:i + W * H * 3] for i in range(0, len(r.stdout) - W * H * 3 + 1, W * H * 3)]
    segs = [f"frame{i}" for i in range(len(frames))]
    _frames = dict(zip(segs, frames))
    inits = {}
elif run.endswith(".mpd"):
    # DELIVERED DASH: every segment of the first video Representation of each Period,
    # in presentation order, each decoded with that Period's own init
    import xml.etree.ElementTree as ET
    base = os.path.dirname(run)
    root = ET.parse(run).getroot()
    for el in root.iter():
        if "}" in el.tag:
            el.tag = el.tag.split("}", 1)[1]
    rend = os.path.basename(run)
    segs, inits = [], {}
    want_h = os.environ.get("CLASSIFY_HEIGHT", "360")
    for per in root.findall("Period"):
        reps = [r for a in per.findall("AdaptationSet") if a.get("contentType") == "video" for r in a.findall("Representation")]
        rep = next((r for r in reps if r.get("height") == want_h), reps[0] if reps else None)
        if rep is None:
            continue
        tpl = rep.find("SegmentTemplate")
        num = int(tpl.get("startNumber"))
        init = os.path.join(base, tpl.get("initialization"))
        for S in tpl.find("SegmentTimeline").findall("S"):
            for _ in range(int(S.get("r", "0")) + 1):
                p_ = os.path.join(base, tpl.get("media").replace("$Number$", str(num)))
                segs.append(p_)
                inits[p_] = init
                num += 1
elif run.endswith(".m3u8"):
    # DELIVERED playlist mode: what the player was handed, loop splices included,
    # each segment decoded with the init its own EXT-X-MAP names
    base = os.path.dirname(run)
    rend = os.path.basename(run)
    items, cur = [], None
    for l in open(run).read().splitlines():
        if l.startswith("#EXT-X-MAP:"):
            cur = re.search(r'URI="([^"]+)"', l).group(1)
        elif l.strip() and not l.startswith("#"):
            items.append((os.path.join(base, l.split("?")[0]), os.path.join(base, cur)))
    segs = [i for i, _ in items]
    inits = dict(items)
else:
    rend = "360p" if os.path.isdir(os.path.join(run, "360p")) else sorted(
        d for d in os.listdir(run) if re.match(r"\d+p$", d))[0]
    d = os.path.join(run, rend)
    segs = sorted(glob.glob(os.path.join(d, "seg_*.m4s")), key=lambda p: int(re.findall(r"\d+", os.path.basename(p))[0]))
    inits = {p: os.path.join(d, "init.mp4") for p in segs}

def frame(seg):
    if seg.startswith("frame"):
        return _frames.get(seg)
    init = open(inits[seg], "rb").read()
    with tempfile.NamedTemporaryFile(suffix=".mp4") as t:
        t.write(init + open(seg, "rb").read()); t.flush()
        for n in (2, 0):                  # frame 2 (the watermark is on by then), or a
            r = subprocess.run(["ffmpeg", "-v", "error", "-i", t.name, "-frames:v", "1", "-vf", f"select=gte(n\\,{n}),scale={W}:{H}",
                                "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True)
            if len(r.stdout) == W * H * 3:  # segment cut to its Period may be shorter
                return r.stdout
        return None

def mean(buf, x0, y0, x1, y1):
    s = [0, 0, 0]; n = 0
    for y in range(y0, y1):
        for x in range(x0, x1):
            i = (y * W + x) * 3
            for k in range(3): s[k] += buf[i + k]
            n += 1
    return [v / n for v in s]

def name(rgb):
    r, g, b = rgb
    if r > 150 and g > 150 and b < 90: return "YELLOW(slate)"
    if r > 120 and g < 70 and b < 70: return "RED(primary)"
    if b > 120 and r < 70 and g < 70: return "BLUE(backup)"
    if g > 120 and r < 70 and b < 70: return "GREEN(loop)"
    if max(rgb) < 40: return "BLACK"
    return f"OTHER{tuple(int(v) for v in rgb)}"

rows = []
for n, p in enumerate(segs, 1):
    f = frame(p)
    if f is None:
        rows.append((n, "UNDECODABLE", None)); continue
    c = name(mean(f, 4, 4, 40, 40))                 # top-left patch: box runs at y~40%, wm is br
    wm = mean(f, W - 22, H - 22, W - 6, H - 6)      # where a br watermark lands at scale 20%
    rows.append((n, c, min(wm) > 200))

runs = []
for n, c, wm in rows:
    if runs and runs[-1][0] == c:
        runs[-1][2] = n; runs[-1][3] += 1; runs[-1][4] += int(bool(wm))
    else:
        runs.append([c, n, n, 1, int(bool(wm))])
print(f"{len(rows)} segments ({rend}), 4s each")
for c, a, b, k, wm in runs:
    print(f"  seg {a:>3}-{b:<3} ({k*4:>4}s)  {c:<16} watermark on {wm}/{k}")
print("SEQUENCE: " + " -> ".join(f"{c.split('(')[0]} x{k}" for c, a, b, k, wm in runs))
