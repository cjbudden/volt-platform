"""Live HTML graphics burned into the picture (build queue 1.10).

Graphics assigned "Burned into the video" (or "Both") on a TRANSCODE channel or
event are drawn into the encode itself, so every viewer, recording, clip and
third-party player gets them. The design and its measurements are the spike,
volt-app/docs/SPIKE_live_graphics_burnin.md; this is the production cut of it.

THE PIECES
  * The renderer (volt-encoder/gfx/burn_renderer.js): Node + headless Chromium,
    one page holding every burned graphic of the stream in its own sandboxed
    iframe, laid out exactly as the Volt player lays out its overlay (same
    placement maths, same /gfx/<version>/ package, same postMessage bridge).
    It follows the control plane's burn feed and, only when something changes,
    captures the REGION (the union of the graphics' boxes, never the whole
    canvas: a full 1920x1080 transparent overlay cost +32 % encode CPU in the
    spike, a box +2 to +4 %) to a PNG with alpha, written tmp + rename.
  * This module: the ffmpeg side. One extra input reads that PNG
    (`image2 -loop 1`, re-read every frame, thread_queue_size 1) and the graph
    composites ONCE, at the top rung's height, before the ladder splits, so the
    blend is not repeated per rendition.
  * The control plane (services/graphics/burnFeed.ts): GET
    /api/streams/:id/burn-graphics, and `graphics_burn` in the job config.

WHY IT NEVER TAKES THE CHANNEL DOWN (spike section 5)
  * ffmpeg refuses to start if the PNG is missing, so seed() writes a
    transparent one of the right size before the transcoder is spawned.
  * A torn or half-written PNG stalls the main path 2.5 s, so every writer
    (the renderer and seed / clear here) writes a temp file and renames it.
    Nothing ever unlinks the file: a deleted input freezes the graphic until
    the transcoder restarts.
  * The graphic input is NOT wall-clock paced (no -re), so a slow or hung
    renderer can never hold the picture up; the overlay just repeats the last
    frame it read.
  * If the renderer stays dead, DeadMan clears the graphic (writes a
    transparent PNG) after DEAD_AFTER_SEC: a score that can no longer change is
    worse on air than no score.
  * If this host cannot run the renderer at all (no Node, no Chromium,
    playwright-core not installed), renderer_problem() says why and the encoder
    builds the ordinary graph: the channel runs exactly as before, without
    burned graphics, and the log says so.
"""
import math
import os
import shutil
import struct
import subprocess
import threading
import time
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
GFX_DIR = os.environ.get("GFX_RENDERER_DIR") or os.path.join(os.path.dirname(HERE), "gfx")
RENDERER = os.path.join(GFX_DIR, "burn_renderer.js")
CANVAS = (1920, 1080)
DEAD_AFTER_SEC = 10.0


def _even(n):
    return max(2, int(round(n / 2.0)) * 2)


def transparent_png(w, h):
    """A fully transparent RGBA PNG, w x h, from the standard library alone."""
    raw = b"".join(b"\x00" + b"\x00\x00\x00\x00" * w for _ in range(h))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def write_atomic(path, data):
    """Temp file, then rename over the old one: a reader never sees half a PNG."""
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def png_size(path):
    """(w, h) of a PNG, or None if it is not one."""
    try:
        with open(path, "rb") as f:
            head = f.read(24)
        if head[:8] != b"\x89PNG\r\n\x1a\n" or head[12:16] != b"IHDR":
            return None
        return struct.unpack(">II", head[16:24])
    except OSError:
        return None


def seed(path, region):
    """Before every transcoder spawn: the PNG must exist, be valid and be the
    region's size (an old file from a run with another region would be placed
    and scaled for the wrong box)."""
    w, h = int(region[2]), int(region[3])
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    if png_size(path) != (w, h):
        write_atomic(path, transparent_png(w, h))
    return path


def norm_region(region, canvas=CANVAS):
    """The region as even integers inside the canvas (yuv420 needs even sizes)."""
    x, y, w, h = [float(v) for v in region]
    # Rounded OUTWARD: the box only ever grows to even pixels, never cuts the graphic.
    x1, y1 = x + w, y + h
    x = max(0, min(canvas[0] - 2, int(math.floor(x / 2.0)) * 2))
    y = max(0, min(canvas[1] - 2, int(math.floor(y / 2.0)) * 2))
    x1 = min(canvas[0], int(math.ceil(x1 / 2.0)) * 2)
    y1 = min(canvas[1], int(math.ceil(y1 / 2.0)) * 2)
    return [x, y, max(2, x1 - x), max(2, y1 - y)]


def _wm_chain(cur, height, wm_path, wm):
    """The channel's static watermark, composited once at the composite height.
    Same placement rules as encoder._overlay_vf (scale = % of the frame height,
    corner or edge with pixel offsets), so it looks the same as the per-rung one."""
    mx = int(wm.get("offset_x", 24)); my = int(wm.get("offset_y", 24))
    pos = str(wm.get("position") or "br").lower()
    xy = {
        "tl": f"{mx}:{my}",
        "tr": f"main_w-overlay_w-{mx}:{my}",
        "bl": f"{mx}:main_h-overlay_h-{my}",
        "br": f"main_w-overlay_w-{mx}:main_h-overlay_h-{my}",
        "tc": f"(main_w-overlay_w)/2:{my}",
        "bc": f"(main_w-overlay_w)/2:main_h-overlay_h-{my}",
    }.get(pos, f"main_w-overlay_w-{mx}:main_h-overlay_h-{my}")
    op = max(0.0, min(1.0, float(wm.get("opacity", 100)) / 100.0))
    wmh = max(1, int(round(height * float(wm.get("scale", 12)) / 100.0)))
    return [f"movie={wm_path},format=rgba,colorchannelmixer=aa={op:.3f},scale=-1:{wmh}[wm]",
            f"[{cur}][wm]overlay={xy}[wmo]"], "wmo"


def composite_graph(ladder, region, png_path, *, fps=25, input_index=1, src="0:v:0",
                    wm_path=None, wm=None, canvas=CANVAS):
    """(extra_input_args, filter_complex, [output labels per rung]).

    The picture is scaled ONCE to the top rung's height, the watermark and the
    graphics are composited there, then it is split and each rung scaled from
    it. The rungs were each scaled from the source anyway, so the extra work is
    the blend, once, over the region only.

    Positions are on the 1920x1080 canvas, as in the player, and scaled by
    H / 1080: a 16:9 picture. (A 4:3 source is pillarboxed by the ladder's
    scale=-2 rungs the same way as before; the graphic is then placed as for a
    16:9 frame of that height, top-left aligned.)

    format stays the default yuv420: format=auto converted the whole 1080p
    picture to RGB and back every frame (+62 % encode CPU in the spike).
    """
    H = max(int(r["height"]) for r in ladder)
    k = H / float(canvas[1])
    x, y, w, h = norm_region(region, canvas)
    gw, gh = _even(w * k), _even(h * k)
    gx, gy = int(round(x * k)), int(round(y * k))
    # NO PROBING on the graphic input. ffmpeg's stream probe reads up to 5 s of
    # an input before it starts, and on an unpaced looping image that is 125
    # frames of the PNG as it was at start, buffered and played first: every
    # change in the first 5 s after a (re)start was never drawn (measured,
    # test_gfx_burn.py, ffmpeg 4.4 and 6.1). The PNG needs no probing: its
    # size is in its header.
    args = ["-thread_queue_size", "1", "-analyzeduration", "0", "-probesize", "4096",
            "-f", "image2", "-loop", "1", "-framerate", str(fps), "-i", png_path]
    chain = [f"[{src}]scale=-2:{H}[base]"]
    cur = "base"
    if wm_path and wm:
        more, cur = _wm_chain(cur, H, wm_path, wm)
        chain += more
    chain.append(f"[{input_index}:v]scale={gw}:{gh}[gfx]")
    chain.append(f"[{cur}][gfx]overlay={gx}:{gy}:eof_action=repeat:repeatlast=1[comp]")
    outs = [f"v{i}" for i in range(len(ladder))]
    chain.append(f"[comp]split={len(ladder)}" + "".join(f"[s{i}]" for i in range(len(ladder))))
    for i, r in enumerate(ladder):
        chain.append(f"[s{i}]scale=-2:{int(r['height'])}[{outs[i]}]")
    return args, ";".join(chain), outs


def chromium_path():
    """The Chromium (or Chrome) the renderer will launch, or None."""
    env = os.environ.get("GFX_CHROMIUM_PATH") or os.environ.get("CHROMIUM_PATH")
    cands = ([env] if env else []) + [
        "/opt/pw-browsers/chromium", "/usr/bin/chromium", "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
    for c in cands:
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def node_bin():
    return os.environ.get("GFX_NODE") or shutil.which("node")


def renderer_problem():
    """None if this host can run the renderer, else a sentence saying why not."""
    node = node_bin()
    if not node:
        return "Node.js is not installed"
    if not os.path.isfile(RENDERER):
        return f"the renderer is missing ({RENDERER})"
    if not chromium_path():
        return "no Chromium or Chrome found (set GFX_CHROMIUM_PATH)"
    try:
        r = subprocess.run([node, "-e", "require.resolve('playwright-core')"], cwd=GFX_DIR,
                           capture_output=True, timeout=20)
        if r.returncode != 0:
            return f"playwright-core is not installed (npm ci in {GFX_DIR})"
    except Exception as e:  # noqa: BLE001
        return f"node did not run ({e})"
    return None


def renderer_cmd(gb, png_path, stream_id):
    """The renderer's command line from the job's graphics_burn block."""
    x, y, w, h = norm_region(gb["region"])
    cmd = [node_bin(), RENDERER,
           "--feed", gb["feed_url"],
           "--api", gb.get("api_base", ""),
           "--out", png_path,
           "--region", f"{x},{y},{w},{h}",
           "--fps", str(gb.get("fps", 25)),
           "--poll-ms", str(gb.get("poll_ms", 500)),
           "--stream", str(stream_id)]
    chrome = chromium_path()
    if chrome:
        cmd += ["--chrome", chrome]
    return cmd


def renderer_env(gb):
    """The ingest token goes in the environment, never on the command line
    (the encoder logs every command it starts)."""
    env = dict(os.environ)
    if gb.get("token"):
        env["VOLT_INGEST_TOKEN"] = gb["token"]
    return env


class DeadMan:
    """Clears the graphic if the renderer stops refreshing it.

    The renderer re-writes the current frame every 2 s even when nothing
    changes, so a file older than `after` seconds means it is dead or hung.
    The graphic is then cleared once (transparent PNG); a renderer that comes
    back simply draws again."""

    def __init__(self, path, region, after=DEAD_AFTER_SEC, log=print, clock=time.time):
        self.path, self.region, self.after, self.log, self.clock = path, region, after, log, clock
        self.cleared_at = None      # mtime of our own clearing write, while the renderer is away
        self._stop = threading.Event()

    @property
    def cleared(self):
        return self.cleared_at is not None

    def check(self):
        """True while the renderer is refreshing the graphic."""
        try:
            mtime = os.path.getmtime(self.path)
        except OSError:
            mtime = None
        if self.cleared_at is not None and mtime is not None and mtime <= self.cleared_at:
            return False            # still only our transparent frame: nothing to do
        if mtime is None or self.clock() - mtime > self.after:
            write_atomic(self.path, transparent_png(int(self.region[2]), int(self.region[3])))
            self.cleared_at = os.path.getmtime(self.path)
            self.log(f"graphics burn-in: the renderer has not refreshed the graphic for "
                     f"{self.after:.0f}s; cleared it until the renderer is back")
            return False
        if self.cleared_at is not None:
            self.log("graphics burn-in: the renderer is drawing again")
        self.cleared_at = None
        return True

    def start(self, every=1.0):
        def run():
            while not self._stop.wait(every):
                try:
                    self.check()
                except Exception as e:  # noqa: BLE001
                    self.log(f"graphics burn-in: dead-man check failed ({e})")
        threading.Thread(target=run, name="gfx-deadman", daemon=True).start()
        return self

    def stop(self):
        self._stop.set()
