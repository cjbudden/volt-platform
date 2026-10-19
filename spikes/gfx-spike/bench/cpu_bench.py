#!/usr/bin/env python3
"""Encoder CPU cost of graphics burn-in, measured as CPU-seconds per 30 s of 1080p25.

Method: each variant runs the SAME 3-rung x264 ladder (1080/720/480, veryfast, the
flags from volt-encoder/bin/ladder_args.py) over the same 30 s 1080p25 h264 source,
as fast as possible (no -re), and we read user+sys CPU of the ffmpeg child from
getrusage. CPU-seconds is independent of wall clock and of whether the 2 vCPU box
keeps realtime, so it is the honest unit for "how much does the overlay cost".
Each variant runs REPEAT times; we report the median.

Usage: python3 bench/cpu_bench.py [repeat]
"""
import os, resource, subprocess, sys, time, statistics, json

HERE = os.path.dirname(os.path.abspath(__file__))
A = os.path.join(HERE, "..", "assets")
SRC = os.path.join(A, "src1080.mp4")
REPEAT = int(sys.argv[1]) if len(sys.argv) > 1 else 3
LADDER = [(1080, 5000), (720, 3000), (480, 1200)]
SEG, FPS = 4, 25
GOP = SEG * FPS


def rung_enc(i, kbps):
    return ["-map", f"[v{i}]", "-c:v", "libx264", "-preset", "veryfast",
            "-b:v", f"{kbps}k", "-maxrate", f"{int(kbps*1.1)}k", "-bufsize", f"{kbps*2}k",
            "-g", str(GOP), "-keyint_min", str(GOP), "-sc_threshold", "0",
            "-force_key_frames", f"expr:gte(t,n_forced*{SEG})", "-r", str(FPS), "-an",
            "-f", "null", "-"]


def scales(src_label):
    n = len(LADDER)
    outs = "".join(f"[s{i}]" for i in range(n))
    g = f"[{src_label}]split={n}{outs};"
    g += ";".join(f"[s{i}]scale=-2:{h}[v{i}]" for i, (h, _) in enumerate(LADDER))
    return g


def variant(name):
    inputs = ["-i", SRC]
    if name == "baseline":
        g = scales("0:v")
    elif name in ("once_bbox", "once_bbox_anim", "once_full", "once_full_anim"):
        if name == "once_bbox":
            inputs += ["-f", "image2", "-loop", "1", "-framerate", "25", "-i", os.path.join(A, "bug.png")]
        elif name == "once_full":
            inputs += ["-f", "image2", "-loop", "1", "-framerate", "25", "-i", os.path.join(A, "bug_full.png")]
        elif name == "once_bbox_anim":
            inputs += ["-stream_loop", "-1", "-framerate", "25", "-i", os.path.join(A, "anim", "a%03d.png")]
        else:
            inputs += ["-stream_loop", "-1", "-framerate", "25", "-i", os.path.join(A, "anim", "f%03d.png")]
        xy = "0:0" if "full" in name else "80:60"
        FMT = ":format=auto" if os.environ.get("OVL_AUTO") else ""
        g = f"[0:v][1:v]overlay={xy}:eof_action=pass{FMT}[c];" + scales("c")
    elif name == "ticker_drawtext":
        # native crawl: band + text from a reloadable file, x scrolls at 120 px/s
        tf = os.path.join(A, "ticker.txt")
        if not os.path.exists(tf):
            open(tf, "w").write("Breaking: Volt ships HTML graphics   *   Markets: NZX up 0.4%   *   Weather: fine in Auckland, 19C")
        g = (f"[0:v]drawbox=x=0:y=1010:w=iw:h=56:color=0x0b1f4d@0.92:t=fill,"
             f"drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:textfile={tf}:reload=25:"
             f"fontsize=30:fontcolor=white:y=1010+(56-th)/2:x=w-mod(t*120\\,w+tw)[c];" + scales("c"))
    elif name == "per_rung_static":
        # today's encoder.py shape: movie= per rung, logo scaled per rung
        n = len(LADDER)
        g = f"[0:v]split={n}" + "".join(f"[s{i}]" for i in range(n)) + ";"
        parts = []
        for i, (h, _) in enumerate(LADDER):
            wmh = round(h * 12 / 100)
            parts.append(f"movie={os.path.join(A,'logo.png')},format=rgba,colorchannelmixer=aa=1.000,"
                         f"scale=-1:{wmh}[wm{i}];[s{i}]scale=-2:{h}[bg{i}];"
                         f"[bg{i}][wm{i}]overlay=main_w-overlay_w-24:main_h-overlay_h-24[v{i}]")
        g += ";".join(parts)
    elif name == "per_rung_dynamic":
        # dynamic gfx input split and scaled per rung, overlaid per rung
        inputs += ["-stream_loop", "-1", "-framerate", "25", "-i", os.path.join(A, "anim", "a%03d.png")]
        n = len(LADDER)
        g = f"[0:v]split={n}" + "".join(f"[s{i}]" for i in range(n)) + ";"
        g += f"[1:v]split={n}" + "".join(f"[g{i}]" for i in range(n)) + ";"
        parts = []
        for i, (h, _) in enumerate(LADDER):
            k = h / 1080
            parts.append(f"[g{i}]scale={int(620*k)//2*2}:{int(68*k)//2*2}[gs{i}];[s{i}]scale=-2:{h}[bg{i}];"
                         f"[bg{i}][gs{i}]overlay={int(80*k)}:{int(60*k)}:eof_action=pass[v{i}]")
        g += ";".join(parts)
    else:
        raise SystemExit(name)
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y"] + inputs + \
          ["-filter_complex", g]
    for i, (_, kbps) in enumerate(LADDER):
        cmd += rung_enc(i, kbps)
    # bound the run to the main source length
    cmd[cmd.index("-filter_complex"):cmd.index("-filter_complex")] = ["-t", "30"]
    return cmd


def run(cmd):
    t0 = time.time()
    p = subprocess.Popen(cmd)
    _, status, ru = os.wait4(p.pid, 0)
    return ru.ru_utime + ru.ru_stime, time.time() - t0, status


VARIANTS = ["baseline", "ticker_drawtext", "once_bbox", "once_bbox_anim", "once_full", "once_full_anim",
            "per_rung_static", "per_rung_dynamic"]

if __name__ == "__main__":
    only = os.environ.get("ONLY")
    res = {}
    for r in range(REPEAT):
        for v in VARIANTS:
            if only and v not in only.split(","):
                continue
            cpu, wall, st = run(variant(v))
            res.setdefault(v, []).append((cpu, wall))
            print(f"run{r} {v:18s} cpu={cpu:6.1f}s wall={wall:5.1f}s rc={st}", flush=True)
    base = statistics.median(c for c, _ in res["baseline"]) if "baseline" in res else None
    print("\nvariant              cpu_s(median)  wall_s  delta_vs_baseline  fps_equiv")
    for v, xs in res.items():
        c = statistics.median(x[0] for x in xs); w = statistics.median(x[1] for x in xs)
        d = f"{(c/base-1)*100:+.1f}%" if base else "-"
        print(f"{v:20s} {c:10.1f} {w:9.1f}   {d:>10s}   {750/w:6.1f}")
    json.dump(res, open(os.path.join(HERE, "..", "out", "cpu_bench.json"), "w"), indent=1)
