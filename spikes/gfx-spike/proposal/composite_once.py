#!/usr/bin/env python3
"""Proposed replacement for encoder.py's per-rung `-vf` overlay: composite ONCE, then split.

Drop-in shape for volt-encoder/bin/encoder.py start_transcode() (transcode workflow only;
package_only has no decode stage, so a burned graphic forces the transcode workflow).

    cmd += input_args(src)                       # input 0, unchanged
    gfx_in, graph = composite_graph(cfg, ladder, first_input_index=1)
    cmd += gfx_in                                # one image2 input per burned binding
    cmd += ["-filter_complex", graph]
    for i, r in enumerate(ladder):
        cmd += video_rung_args(r, seg=seg, fps=fps, gpu=gpu, vmap=f"[v{i}]")   # -map [v{i}], no -vf
        cmd += ["-f", "mpegts", udp_out(i)]

video_rung_args() gains `vmap` (map a filter_complex label instead of 0:v:0 and skip -vf).
Audio is untouched: it never enters the filter graph, so A/V timing is unchanged.

Run this file to self-test: it builds the graph for a sample config and runs ffmpeg for 3 s.
"""
import os, subprocess, sys


def composite_graph(cfg, ladder, first_input_index=1, src_label="0:v"):
    """Return (extra_input_args, filter_complex).

    Layers, bottom to top: the existing static watermark (movie=, decoded once), then
    each burned graphics binding (a PNG the sidecar replaces atomically, re-read per frame
    by image2 -loop 1). thread_queue_size 1 measured 300 ms state-to-output vs 576 ms at
    the default. Never add -re to the graphic input (+1.6 s on the MAIN path, measured).
    The file MUST exist before ffmpeg starts (a missing image2 input aborts startup,
    exit 254): seed a 2x2 transparent PNG first. The graphic is rendered at canvas scale (1920x1080) and scaled to
    the SOURCE resolution here, so a 720p source still gets a correctly placed graphic.
    """
    src_w, src_h = cfg.get("source_w", 1920), cfg.get("source_h", 1080)
    k = src_h / 1080.0
    args, chain, cur, n = [], [], src_label, first_input_index
    wm = cfg.get("watermark")
    if wm and wm.get("path"):
        h = max(1, round(src_h * float(wm.get("scale", 12)) / 100))
        op = max(0.0, min(1.0, float(wm.get("opacity", 100)) / 100))
        chain.append(f"movie={wm['path']},format=rgba,colorchannelmixer=aa={op:.3f},scale=-1:{h}[wm]")
        chain.append(f"[{cur}][wm]overlay=main_w-overlay_w-{wm.get('offset_x', 24)}:main_h-overlay_h-{wm.get('offset_y', 24)}[l0]")
        cur = "l0"
    for j, b in enumerate(cfg.get("graphics", [])):
        x, y, w, h = b["bbox"]                      # canvas px, from the template manifest
        args += ["-thread_queue_size", "1", "-f", "image2", "-loop", "1", "-framerate", str(cfg.get("fps", 25)), "-i", b["file"]]
        sw = max(2, int(round(w * k / 2)) * 2)
        chain.append(f"[{n}:v]scale={sw}:-2[g{j}]")
        # format=yuv420 (the default) is load-bearing: format=auto made the 1080p main
        # convert to RGB/444 and back every frame (+62% CPU measured).
        chain.append(f"[{cur}][g{j}]overlay={int(round(x * k))}:{int(round(y * k))}:eof_action=repeat:repeatlast=1[l{j + 1}g]")
        cur = f"l{j + 1}g"; n += 1
    outs = "".join(f"[s{i}]" for i in range(len(ladder)))
    chain.append(f"[{cur}]split={len(ladder)}{outs}")
    for i, r in enumerate(ladder):
        chain.append(f"[s{i}]scale=-2:{r['height']}[v{i}]")
    return args, ";".join(chain)


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    bug = os.path.join(here, "..", "assets", "bug.png")
    logo = os.path.join(here, "..", "assets", "logo.png")
    ladder = [{"height": 1080}, {"height": 720}, {"height": 480}]
    cfg = {"fps": 25, "source_w": 1920, "source_h": 1080, "watermark": {"path": logo},
           "graphics": [{"file": bug, "bbox": [80, 60, 620, 68]}, {"file": bug, "bbox": [100, 900, 620, 68]}]}
    a, g = composite_graph(cfg, ladder)
    print(g)
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=25"] + a + \
          ["-filter_complex", g]
    for i in range(3):
        cmd += ["-map", f"[v{i}]", "-c:v", "libx264", "-preset", "ultrafast", "-t", "3", "-f", "null", "-"]
    r = subprocess.run(cmd)
    print("ffmpeg exit", r.returncode)
    sys.exit(r.returncode)
