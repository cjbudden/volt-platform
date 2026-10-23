#!/usr/bin/env python3
"""Graphics burned into the picture: the encoder's side (gfx_burn.py, build queue 1.10).

The pure parts (the PNG, the region, the filter graph, the rung arguments, the
seed and the dead-man), then the real thing with ffmpeg: the encoder's own graph
and rung settings on a live (realtime) source, the graphic file replaced while
it runs, and the PIXELS of the output read back at known times: transparent
before, the first graphic where it should be after the first change, the second
after the second, the watermark still there, nothing drawn outside the box, no
stall while the file is replaced 25 times a second. Last, start_transcode itself
with the renderer's spawn caught: it composites when the job asks and the host
can, and builds exactly the old command when it cannot.

Needs ffmpeg with libx264. Usage: python3 volt-encoder/bin/test_gfx_burn.py
"""
import importlib.util
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import zlib

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gfx_burn as gb  # noqa: E402
import ladder_args as la  # noqa: E402

ok = bad = 0


def check(msg, cond, detail=""):
    global ok, bad
    if cond:
        ok += 1
        print(f"PASS {msg}")
    else:
        bad += 1
        print(f"FAIL {msg}" + (f" -- {detail}" if detail else ""))


def solid_png(w, h, rgba):
    raw = b"".join(b"\x00" + bytes(rgba) * w for _ in range(h))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


W = tempfile.mkdtemp(prefix="gfxburn-")

# ---------------------------------------------------------------- the PNG
print("== the transparent PNG ==")
p = os.path.join(W, "t.png")
with open(p, "wb") as f:
    f.write(gb.transparent_png(64, 18))
pr = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height,pix_fmt", "-of", "csv=p=0", p],
                    capture_output=True, text=True)
check("ffmpeg reads it: 64x18 with alpha", pr.stdout.strip() == "64,18,rgba", pr.stdout + pr.stderr)
check("png_size reads the header", gb.png_size(p) == (64, 18))
check("png_size says None for something that is not a PNG", gb.png_size(__file__) is None)

# ---------------------------------------------------------------- the region
print("== the region ==")
check("odd values made even, rounded outward (the box never cuts the graphic)", gb.norm_region([101, 61, 399, 121]) == [100, 60, 400, 122], str(gb.norm_region([101, 61, 399, 121])))
check("kept inside the canvas", gb.norm_region([1800, 1000, 400, 200]) == [1800, 1000, 120, 80], str(gb.norm_region([1800, 1000, 400, 200])))
check("never empty", gb.norm_region([0, 0, 0, 0])[2:] == [2, 2])

# ---------------------------------------------------------------- the graph
print("== the filter graph ==")
ladder = [{"height": 720, "bitrate_kbps": 1500}, {"height": 360, "bitrate_kbps": 500}]
args, graph, labels = gb.composite_graph(ladder, [300, 90, 600, 180], "/x/burn.png", fps=25)
check("one image input, re-read every frame, a queue of one",
      args[:2] == ["-thread_queue_size", "1"] and args[-8:] == ["-f", "image2", "-loop", "1", "-framerate", "25", "-i", "/x/burn.png"], str(args))
check("and not probed (a probe buffers 5 s of the PNG as it was at start)",
      args[args.index("-analyzeduration") + 1] == "0" and int(args[args.index("-probesize") + 1]) <= 4096, str(args))
check("never -re on the graphic (it would add 1.6 s to the main path)", "-re" not in args)
check("never format=auto (+62 % encode CPU)", "format=auto" not in graph)
check("the picture is scaled once to the top rung's height", graph.startswith("[0:v:0]scale=-2:720[base]"), graph)
check("the graphic is scaled from the 1080 canvas to 720 and placed at 2/3 of its canvas position",
      "[1:v]scale=400:120[gfx]" in graph and "overlay=200:60:eof_action=repeat:repeatlast=1[comp]" in graph, graph)
check("composited ONCE, then split per rung", graph.count("overlay=") == 1 and "[comp]split=2[s0][s1]" in graph, graph)
check("each rung scaled from the composite", "[s0]scale=-2:720[v0]" in graph and "[s1]scale=-2:360[v1]" in graph)
check("labels per rung", labels == ["v0", "v1"])
_, g2, _ = gb.composite_graph(ladder, [300, 90, 600, 180], "/x/burn.png", fps=25, wm_path="/x/wm.png",
                              wm={"position": "tl", "offset_x": 24, "offset_y": 24, "opacity": 80, "scale": 10})
check("the watermark is composited under the graphics, once",
      "movie=/x/wm.png,format=rgba,colorchannelmixer=aa=0.800,scale=-1:72[wm]" in g2
      and "[base][wm]overlay=24:24[wmo]" in g2 and "[wmo][gfx]overlay=" in g2 and g2.count("overlay=") == 2, g2)

# ---------------------------------------------------------------- the rung arguments
print("== a rung fed from the graph ==")
plain = la.video_rung_args(ladder[0], seg=4, fps=25)
mapped = la.video_rung_args(ladder[0], seg=4, fps=25, vmap="v0")
check("maps the graph's output label, no -vf", mapped[:2] == ["-map", "[v0]"] and "-vf" not in mapped, str(mapped[:4]))
check("every encoder setting after it is the same as a plain rung", mapped[2:] == plain[4:], f"{mapped[2:]} vs {plain[4:]}")
check("a plain rung is unchanged (golden head)", plain[:4] == ["-map", "0:v:0", "-vf", "scale=-2:720"])

# ---------------------------------------------------------------- seed
print("== seed before every spawn ==")
sp = os.path.join(W, "gfx", "burn.png")
gb.seed(sp, [0, 0, 120, 40])
check("missing: written, the region's size", gb.png_size(sp) == (120, 40))
with open(sp, "wb") as f:
    f.write(solid_png(120, 40, (255, 0, 0, 255)))
m0 = os.path.getmtime(sp)
time.sleep(0.02)
gb.seed(sp, [0, 0, 120, 40])
check("right size already: kept (the renderer's last frame is not wiped)", os.path.getmtime(sp) == m0)
gb.seed(sp, [0, 0, 200, 40])
check("a size from another run: replaced", gb.png_size(sp) == (200, 40))
check("no temp file left behind", [n for n in os.listdir(os.path.dirname(sp)) if ".tmp" in n] == [])

# ---------------------------------------------------------------- dead-man
print("== the dead-man ==")
logs = []
now = [time.time()]
dp = os.path.join(W, "dm.png")
with open(dp, "wb") as f:
    f.write(solid_png(40, 20, (0, 255, 0, 255)))
dm = gb.DeadMan(dp, [0, 0, 40, 20], after=10, log=logs.append, clock=lambda: now[0])
check("a fresh frame: alive", dm.check() is True and not dm.cleared)
now[0] += 11
check("not refreshed for longer than the limit: cleared", dm.check() is False and dm.cleared)
with open(dp, "rb") as f:
    data = f.read()
check("cleared means a transparent PNG of the region's size", data == gb.transparent_png(40, 20))
n_logs = len(logs)
now[0] += 30
check("still dead: not cleared again, not logged again", dm.check() is False and len(logs) == n_logs, str(logs))
time.sleep(0.02)
with open(dp, "wb") as f:
    f.write(solid_png(40, 20, (0, 0, 255, 255)))
now[0] = time.time()
check("the renderer draws again: alive, and the log says so", dm.check() is True and not dm.cleared and "drawing again" in logs[-1], str(logs))

# ---------------------------------------------------------------- real pixels
print("== the encoder's graph on a live source: the pixels at known times ==")
if not shutil.which("ffmpeg"):
    check("ffmpeg is installed", False, "install ffmpeg to run the pixel checks")
else:
    region = [150, 90, 600, 180]          # canvas px: at 720p that is 100,60 400x120
    png = os.path.join(W, "live", "burn.png")
    gb.seed(png, region)
    wm = os.path.join(W, "wm.png")
    with open(wm, "wb") as f:
        f.write(solid_png(32, 32, (0, 0, 255, 255)))
    gin, graph, labels = gb.composite_graph(ladder, region, png, fps=25, wm_path=wm,
                                            wm={"position": "br", "offset_x": 24, "offset_y": 24, "opacity": 100, "scale": 10})
    outs = [os.path.join(W, f"r{i}.ts") for i in range(len(ladder))]
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
           "-re", "-f", "lavfi", "-i", "color=c=black:s=1280x720:r=25", *gin, "-filter_complex", graph]
    for i, r in enumerate(ladder):
        cmd += la.video_rung_args(r, seg=1, fps=25, vmap=labels[i]) + ["-t", "9", "-f", "mpegts", outs[i]]
    red, green = solid_png(600, 180, (230, 20, 20, 255)), solid_png(600, 180, (20, 200, 40, 255))
    t_start = time.time()
    proc = subprocess.Popen(cmd, stderr=subprocess.PIPE, text=True)

    def writer():
        # 0 to 3 s transparent (the seed); 3 s red; 6 s green; between 4 and 5 s the
        # file is replaced 25 times a second (red each time), as during a transition.
        time.sleep(3.0 - (time.time() - t_start))
        gb.write_atomic(png, red)
        time.sleep(4.0 - (time.time() - t_start))
        t_end = t_start + 5.0
        while time.time() < t_end:
            gb.write_atomic(png, red)
            time.sleep(0.04)
        time.sleep(max(0, 6.0 - (time.time() - t_start)))
        gb.write_atomic(png, green)

    th = threading.Thread(target=writer)
    th.start()
    _, err = proc.communicate(timeout=60)
    th.join()
    check("the encode ran to the end", proc.returncode == 0, err[-400:] if err else "")

    def pixel(path, t, x, y, h):
        out = subprocess.run(["ffmpeg", "-v", "error", "-ss", str(t), "-i", path, "-frames:v", "1",
                              "-vf", f"crop=2:2:{x}:{y}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                             capture_output=True)
        b = out.stdout
        return tuple(b[:3]) if len(b) >= 3 else None

    def is_red(c): return c is not None and c[0] > 170 and c[1] < 80 and c[2] < 80
    def is_green(c): return c is not None and c[1] > 140 and c[0] < 90 and c[2] < 110
    def is_black(c): return c is not None and max(c) < 40
    def is_blue(c): return c is not None and c[2] > 170 and c[0] < 80 and c[1] < 80

    if proc.returncode == 0:
        nfr = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
                              "stream=nb_read_frames", "-of", "csv=p=0", outs[0]], capture_output=True, text=True).stdout.split()[0]
        check(f"no frame lost while the file was replaced (225 frames in 9 s, got {nfr})", nfr == "225", nfr)
        a = pixel(outs[0], 1.5, 300, 120, 720)
        check(f"before the first change the box is transparent: the picture shows (720p, 1.5 s: {a})", is_black(a))
        a = pixel(outs[0], 3.8, 300, 120, 720)
        check(f"a change 3 s after start is drawn within a second (720p centre, 3.8 s: {a})", is_red(a))
        a = pixel(outs[0], 3.8, 104, 64, 720)
        check(f"from its top-left corner (canvas 150,90 is 100,60 at 720p; 3.8 s: {a})", is_red(a))
        a = pixel(outs[0], 3.8, 94, 64, 720)
        check(f"and not left of it ({a})", is_black(a))
        a = pixel(outs[0], 3.8, 496, 176, 720)
        check(f"to its bottom-right corner (500,180 at 720p; {a})", is_red(a))
        a = pixel(outs[0], 3.8, 506, 186, 720)
        check(f"and not past it ({a})", is_black(a))
        a = pixel(outs[0], 3.8, 900, 500, 720)
        check(f"nothing drawn outside the box ({a})", is_black(a))
        a = pixel(outs[0], 4.5, 300, 120, 720)
        check(f"steady while the file is replaced 25 times a second (4.5 s: {a})", is_red(a))
        a = pixel(outs[0], 7.5, 300, 120, 720)
        check(f"the second change is drawn (7.5 s: {a})", is_green(a))
        a = pixel(outs[0], 7.5, 1220, 660, 720)
        check(f"the watermark is still burned in, composited once (bottom right, {a})", is_blue(a))
        a = pixel(outs[1], 3.8, 150, 60, 360)
        check(f"the 360p rung carries the same graphic, scaled with the picture (150,60; {a})", is_red(a))
        a = pixel(outs[1], 3.8, 46, 26, 360)
        check(f"in the same place (just outside its corner at 360p: {a})", is_black(a))
        a = pixel(outs[1], 7.5, 150, 60, 360)
        check(f"and its second change ({a})", is_green(a))

# ---------------------------------------------------------------- start_transcode
print("== start_transcode ==")
os.environ["WORK_DIR"] = os.path.join(W, "work")
os.makedirs(os.environ["WORK_DIR"], exist_ok=True)
spec = importlib.util.spec_from_file_location("enc_under_test", os.path.join(HERE, "encoder.py"))
enc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(enc)
spawned = []
enc.spawn_supervised = lambda name, cmd, backoff=3.0: spawned.append((name, cmd)) or {"proc": None}
enc.log = lambda m: None


class NoDeadMan:
    def __init__(self, *a, **k): pass
    def start(self): return self


gb.DeadMan = NoDeadMan
base_cfg = lambda: {"channel_id": "c1", "workflow": "transcode", "segment_seconds": 4, "fps": 25,
                    "inputs": [{"protocol": "srt", "url": "srt://0.0.0.0:9000?streamid=k"}],
                    "ladder": ladder}
burn = {"feed_url": "http://cp/api/streams/c1/burn-graphics?kind=channel", "token": "SECRET-TOKEN",
        "api_base": "http://cp", "region": [151, 91, 599, 179], "fps": 25, "poll_ms": 500}

gb.renderer_problem = lambda: None
enc._GFX_BURN.update({"png": None, "done": False})
cfg = base_cfg(); cfg["graphics_burn"] = dict(burn)
enc.start_transcode(cfg, None)
names = [n for n, _ in spawned]
tc = dict(spawned).get("transcode") or []
rd = dict(spawned).get("gfx-renderer") or []
check("the renderer and the transcoder are both started, supervised", names == ["gfx-renderer", "transcode"], str(names))
check("the transcoder composites: an image input and a filter graph", "-filter_complex" in tc and "image2" in tc, " ".join(tc)[:300])
check("the image input is the seeded PNG, and it exists before ffmpeg starts",
      tc[tc.index("image2") + 6] == os.path.join(os.environ["WORK_DIR"], "gfx", "burn.png") and gb.png_size(tc[tc.index("image2") + 6]) == (600, 180),
      str(gb.png_size(os.path.join(os.environ["WORK_DIR"], "gfx", "burn.png"))))
check("each rung maps its graph output", tc.count("[v0]") == 1 and tc.count("[v1]") == 1 and "-vf" not in tc)
check("the renderer gets the feed, the even region and the API base",
      rd[rd.index("--feed") + 1] == burn["feed_url"] and rd[rd.index("--region") + 1] == "150,90,600,180" and rd[rd.index("--api") + 1] == "http://cp", " ".join(rd))
check("the ingest token is not on its command line", "SECRET-TOKEN" not in " ".join(rd))
check("it is in the environment the renderer inherits", os.environ.get("VOLT_INGEST_TOKEN") == "SECRET-TOKEN")
check("audio does not enter the graph", all("0:a:" not in part for part in tc[tc.index("-filter_complex") + 1].split(";")))

spawned.clear()
gb.renderer_problem = lambda: "no Chromium or Chrome found"
enc._GFX_BURN.update({"png": None, "done": False})
cfg = base_cfg(); cfg["graphics_burn"] = dict(burn)
enc.start_transcode(cfg, None)
tc_fallback = dict(spawned).get("transcode") or []
spawned.clear()
enc._GFX_BURN.update({"png": None, "done": False})
enc.start_transcode(base_cfg(), None)
tc_plain = dict(spawned).get("transcode") or []
check("a host that cannot run the renderer: no renderer started", "gfx-renderer" not in [n for n, _ in spawned])
check("and the transcoder command is exactly the one without graphics", tc_fallback == tc_plain and "-filter_complex" not in tc_plain, " ".join(tc_fallback)[:200])

spawned.clear()
gb.renderer_problem = lambda: None
enc._GFX_BURN.update({"png": None, "done": False})
cfg = base_cfg(); cfg["graphics_burn"] = dict(burn); cfg["workflow"] = "package_only"
check("package only: never burns (no picture of ours)", enc.prepare_graphics_burn(cfg) is None and not spawned)

shutil.rmtree(W, ignore_errors=True)
print(f"\n{ok} passed, {bad} failed")
sys.exit(1 if bad else 0)
