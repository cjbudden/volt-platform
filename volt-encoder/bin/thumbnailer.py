#!/usr/bin/env python3
"""
Volt thumbnailer — keyscreen images without a GPU encode.

Generating stills is decode-and-scale, not encoding, so this is a cheap CPU job:
one FFmpeg pass with `-skip_frame nokey` decodes ONLY keyframes (I-frames) of the
hi-res source, which for a storyboard at ~1 frame / 10 s is very fast. It produces:

  * poster.jpg       — a single representative keyscreen still
  * sb_NNN.jpg       — storyboard sprite sheet(s): a grid of small thumbs
  * thumbs.vtt       — WebVTT thumbnails mapping each time range to a sprite
                       region (#xywh=), for player scrub-bar previews

Then it uploads the outputs to S3 and POSTs their keys to the control plane
(`/api/media/thumbnails`). Triggered on event end / recording completion — reads
the hi-res source (the transcode mezzanine, or the top rendition of a packaging
recording) straight from S3. No GPU, no re-encode of video.

An animated hover-preview (short MP4/GIF) is the only thing that would need an
encode; it's an optional extra, not built here.

Job config (JSON at THUMB_CONFIG, default /job/thumb.json):
  {
    "target": "recording" | "vod",
    "id": "<uuid>",
    "source": "s3://bucket/rtm/news/2026-07-19/1080p/index.m3u8" | local path,
    "duration_sec": 3600,
    "out_s3": "s3://bucket/rtm/news/2026-07-19/thumbs",
    "grid": {"cols": 5, "rows": 5}, "interval_sec": 10,
    "thumb_width": 320, "aspect": [16, 9],
    "poster_at_sec": 30,
    "report": {"url": "https://api.ols.internal/api/media/thumbnails", "token": "..."}
  }
"""

import json
import math
import os
import subprocess
import sys
import urllib.request


# ---------------------------------------------------------------------------
# pure builders (unit-tested)
# ---------------------------------------------------------------------------
def thumb_height(width, aspect):
    h = int(round(width * aspect[1] / aspect[0]))
    return h - (h % 2)  # keep even for scalers


def build_poster_cmd(source, out_path, width, aspect, at_sec=0):
    """One representative still. -ss before -i seeks fast on keyframes."""
    h = thumb_height(width, aspect)
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-ss", str(at_sec), "-skip_frame", "nokey", "-i", source,
        "-frames:v", "1", "-vf", f"scale={width}:{h}", "-q:v", "3",
        out_path,
    ]


def build_storyboard_cmd(source, out_pattern, width, aspect, interval_sec, cols, rows):
    """Tile keyframes into CxR sprite sheets. `fps=1/interval` picks one frame
    every interval_sec; `tile` packs them; the muxer rolls to a new file each
    time a full sheet is emitted."""
    h = thumb_height(width, aspect)
    vf = f"fps=1/{interval_sec},scale={width}:{h},tile={cols}x{rows}"
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-skip_frame", "nokey", "-i", source,
        "-vf", vf, "-an", "-q:v", "4",
        "-start_number", "0",   # first sheet is sb_000.jpg to match the WebVTT
        out_pattern,
    ]


def _ts(seconds):
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def build_webvtt(duration_sec, interval_sec, cols, rows, width, aspect, sheet_name):
    """WebVTT thumbnails: one cue per interval, each pointing at a #xywh region
    of the sprite sheet it lives on. `sheet_name(i)` returns the filename for
    sheet index i (0-based)."""
    h = thumb_height(width, aspect)
    per_sheet = cols * rows
    n = max(1, math.ceil(duration_sec / interval_sec))
    lines = ["WEBVTT", ""]
    for i in range(n):
        start = i * interval_sec
        end = min((i + 1) * interval_sec, duration_sec)
        idx_in_sheet = i % per_sheet
        sheet = i // per_sheet
        col = idx_in_sheet % cols
        row = idx_in_sheet // cols
        x, y = col * width, row * h
        lines.append(f"{_ts(start)} --> {_ts(end)}")
        lines.append(f"{sheet_name(sheet)}#xywh={x},{y},{width},{h}")
        lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# orchestration (side effects)
# ---------------------------------------------------------------------------
def log(m):
    print(f"[thumbnailer] {m}", flush=True)


def run(cmd):
    log(" ".join(cmd))
    subprocess.run(cmd, check=True)


def s3_cp(local, s3):
    run(["aws", "s3", "cp", local, s3, "--only-show-errors"])


def register(cfg, keys):
    rep = cfg.get("report") or {}
    if not rep.get("url"):
        return
    body = json.dumps({"target": cfg["target"], "id": cfg["id"], "status": "ready", **keys}).encode()
    req = urllib.request.Request(rep["url"], data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    if rep.get("token"):
        req.add_header("X-Volt-Ingest-Token", rep["token"])
    try:
        urllib.request.urlopen(req, timeout=15).read()
        log("registered thumbnails with control plane")
    except Exception as exc:  # noqa: BLE001
        log(f"registration failed (non-fatal): {exc}")


def main():
    raw = os.environ.get("THUMB_CONFIG_JSON")
    if raw:
        cfg = json.loads(raw)
    else:
        path = os.environ.get("THUMB_CONFIG", "/job/thumb.json")
        with open(path) as fh:
            cfg = json.load(fh)

    workdir = os.environ.get("WORK_DIR", "/work")
    os.makedirs(workdir, exist_ok=True)
    src = cfg["source"]
    width = cfg.get("thumb_width", 320)
    aspect = cfg.get("aspect", [16, 9])
    grid = cfg.get("grid", {"cols": 5, "rows": 5})
    cols, rows = grid["cols"], grid["rows"]
    interval = cfg.get("interval_sec", 10)
    duration = cfg["duration_sec"]
    out_s3 = cfg["out_s3"].rstrip("/")

    poster = os.path.join(workdir, "poster.jpg")
    sb_pattern = os.path.join(workdir, "sb_%03d.jpg")
    vtt = os.path.join(workdir, "thumbs.vtt")

    run(build_poster_cmd(src, poster, width, aspect, cfg.get("poster_at_sec", 0)))
    run(build_storyboard_cmd(src, sb_pattern, width, aspect, interval, cols, rows))

    with open(vtt, "w") as fh:
        fh.write(build_webvtt(duration, interval, cols, rows, width, aspect,
                              lambda i: f"sb_{i:03d}.jpg"))

    # upload
    s3_cp(poster, f"{out_s3}/poster.jpg")
    s3_cp(vtt, f"{out_s3}/thumbs.vtt")
    run(["aws", "s3", "cp", workdir, out_s3, "--recursive",
         "--exclude", "*", "--include", "sb_*.jpg", "--only-show-errors"])

    register(cfg, {
        "poster_key": f"{out_s3}/poster.jpg",
        "storyboard_key": f"{out_s3}/sb_000.jpg",
        "thumbs_vtt_key": f"{out_s3}/thumbs.vtt",
    })
    log("done")


if __name__ == "__main__":
    main()
