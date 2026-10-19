#!/usr/bin/env python3
"""Does ffmpeg's `-f image2 -loop 1` re-read a file that changes mid-run, and can it
read a torn (half-written) file?

A writer thread flips gfx.png between a RED and a BLUE noisy 640x360 PNG (~0.7 MB,
so a write takes long enough to be caught mid-way) every 7 ms, for 10 s, while one
ffmpeg overlays it on black at 25 fps realtime and streams rgb24 frames back.
Each output frame is classified per row: all-red, all-blue, mixed (torn), black (no
overlay). Run twice: writer uses direct overwrite, then tmp + rename (atomic).
A third run deletes the file for 1 s mid-run to see what a missing file does.
"""
import os, subprocess, threading, time, sys
import numpy as np
from PIL import Image

D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "out", "torn")
os.makedirs(D, exist_ok=True)
W, H = 640, 360
rng = np.random.default_rng(1)
def noisy(ch):
    a = np.zeros((H, W, 4), np.uint8); a[..., 3] = 255
    a[..., ch] = 150 + rng.integers(0, 100, (H, W), dtype=np.uint8)
    p = os.path.join(D, f"src{ch}.png"); Image.fromarray(a, "RGBA").save(p, compress_level=0); return open(p, "rb").read()
RED, BLUE = noisy(0), noisy(2)
TARGET = os.path.join(D, "gfx.png")

def run(mode, eof="repeat"):
    open(TARGET, "wb").write(RED)
    stop = threading.Event()
    def writer():
        i = 0
        while not stop.is_set():
            data = RED if i % 2 else BLUE; i += 1
            if mode == "direct":
                with open(TARGET, "wb") as f:
                    for k in range(0, len(data), 65536): f.write(data[k:k + 65536]); f.flush()
            else:
                with open(TARGET + ".tmp", "wb") as f: f.write(data)
                os.rename(TARGET + ".tmp", TARGET)
            time.sleep(0.007)
    def deleter():
        time.sleep(4); os.remove(TARGET); time.sleep(1.0); open(TARGET + ".tmp", "wb").write(BLUE); os.rename(TARGET + ".tmp", TARGET)
    p = subprocess.Popen(["ffmpeg", "-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", f"color=c=black:size={W}x{H}:rate=25",
                          "-f", "image2", "-loop", "1", "-framerate", "25", "-i", TARGET,
                          "-filter_complex", f"[0:v][1:v]overlay=0:0:eof_action={eof}", "-t", "10", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    th = threading.Thread(target=deleter if mode == "delete" else writer, daemon=True); th.start()
    cnt = {"red": 0, "blue": 0, "torn": 0, "black": 0}
    seq = []
    while True:
        b = p.stdout.read(W * H * 3)
        if len(b) < W * H * 3: break
        f = np.frombuffer(b, np.uint8).reshape(H, W, 3)
        r = f[:, :, 0].mean(1) > 100; bl = f[:, :, 2].mean(1) > 100
        if r.all(): k = "red"
        elif bl.all(): k = "blue"
        elif not r.any() and not bl.any(): k = "black"
        else: k = "torn"
        cnt[k] += 1; seq.append(k[0])
    stop.set(); err = p.stderr.read().decode(errors="replace").strip().splitlines()
    return cnt, len(err), err[:3], "".join(seq)

if __name__ == "__main__":
    for mode in ("direct", "atomic"):
        c, ne, e, s = run(mode)
        print(f"{mode:7s} frames={sum(c.values())} {c} changes_seen={sum(1 for i in range(1,len(s)) if s[i]!=s[i-1])} ffmpeg_errors={ne} {e}")
    for eof in ("repeat", "pass"):
        c, ne, e, s = run("delete", eof)
        print(f"delete eof_action={eof}: frames={sum(c.values())} {c} errors={ne} {e}\n   timeline: {s}")
