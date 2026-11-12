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
    "source": "s3://bucket/thumbs/<recording id>/source.m3u8" | local path,
                (an s3:// playlist is fetched and its segments signed: resolve_source)
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
import posixpath
import re
import subprocess
import sys
import urllib.request


# ---------------------------------------------------------------------------
# pure builders (unit-tested)
# ---------------------------------------------------------------------------
def thumb_height(width, aspect):
    h = int(round(width * aspect[1] / aspect[0]))
    return h - (h % 2)  # keep even for scalers


def _input(source, protocols=None):
    """The `-i` part. A playlist on local disk whose segments are https links
    (a recording in the bucket, signed by presign_playlist) needs ffmpeg told
    it may follow them: by default a file playlist may only open files."""
    pre = ["-protocol_whitelist", protocols] if protocols else []
    return pre + ["-i", source]


def build_poster_cmd(source, out_path, width, aspect, at_sec=0, accurate=False, protocols=None):
    """One representative still. Fast path: -ss before -i seeks on keyframes of a
    long mezzanine (cheap). `accurate` path (local CMAF fMP4 origin): -ss AFTER -i
    and no -skip_frame — fragmented MP4 keyframe-seek/skip is unreliable, so we
    decode to the timestamp instead. The origin is short, so this stays cheap."""
    h = thumb_height(width, aspect)
    if accurate:
        return [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            *_input(source, protocols), "-ss", str(at_sec),
            "-frames:v", "1", "-vf", f"scale={width}:{h}", "-q:v", "3",
            out_path,
        ]
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-ss", str(at_sec), "-skip_frame", "nokey", *_input(source, protocols),
        "-frames:v", "1", "-vf", f"scale={width}:{h}", "-q:v", "3",
        out_path,
    ]


def build_storyboard_cmd(source, out_pattern, width, aspect, interval_sec, cols, rows, accurate=False, protocols=None):
    """Tile keyframes into CxR sprite sheets. `fps=1/interval` picks one frame
    every interval_sec; `tile` packs them; the muxer rolls to a new file each
    time a full sheet is emitted. `accurate` (local CMAF) drops -skip_frame nokey
    so the fps filter samples real frames rather than sparse fMP4 keyframes."""
    h = thumb_height(width, aspect)
    vf = f"fps=1/{interval_sec},scale={width}:{h},tile={cols}x{rows}"
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    if not accurate:
        cmd += ["-skip_frame", "nokey"]
    cmd += [*_input(source, protocols), "-vf", vf, "-an", "-q:v", "4",
            "-start_number", "0",   # first sheet is sb_000.jpg to match the WebVTT
            out_pattern]
    return cmd


HTTP_PROTOCOLS = "file,http,https,tcp,tls,crypto"
_URI_ATTR = re.compile(r'URI="([^"]+)"')


def split_s3(uri):
    """s3://bucket/key -> (bucket, key)."""
    rest = uri[len("s3://"):]
    bucket, _, key = rest.partition("/")
    return bucket, key


def presign_playlist(text, playlist_uri, presign):
    """Turn a playlist kept in the bucket into one ffmpeg can read: every media
    address (segment lines and URI="..." in tags such as EXT-X-MAP) becomes a
    signed https link. s3:// addresses are signed as they are; relative ones
    (a rendition playlist beside its segments) are taken from the playlist's
    own folder first; http(s) links are left alone. `presign(bucket, key)`
    returns the link. Signing here, in the task, and not in the control plane,
    because the control plane's credentials could expire before a day-long
    storyboard pass reaches the last segment."""
    base_bucket, base_key = split_s3(playlist_uri)
    base_dir = base_key.rsplit("/", 1)[0] + "/" if "/" in base_key else ""

    def sign(ref):
        if ref.startswith(("http://", "https://", "data:")):
            return ref
        if ref.startswith("s3://"):
            return presign(*split_s3(ref))
        return presign(base_bucket, posixpath.normpath(base_dir + ref))

    out = []
    for line in text.splitlines():
        t = line.strip()
        if not t:
            out.append(line)
        elif t.startswith("#"):
            out.append(_URI_ATTR.sub(lambda m: f'URI="{sign(m.group(1))}"', line) if "URI=" in t else line)
        else:
            out.append(sign(t))
    return "\n".join(out) + "\n"


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


def _botocore_presigner(expires_sec):
    """Signs with the task's own credentials. botocore comes with the image's
    awscli (Ubuntu's awscli package depends on python3-botocore)."""
    import botocore.session  # noqa: PLC0415  (only needed for a bucket source)
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    client = botocore.session.get_session().create_client("s3", region_name=region)
    return lambda b, k: client.generate_presigned_url(
        "get_object", Params={"Bucket": b, "Key": k}, ExpiresIn=expires_sec)


def resolve_source(src, workdir, presign=None, fetch=None):
    """(source for ffmpeg, protocol whitelist or None). An s3:// playlist (a
    recording's runs, written by the control plane) is fetched and its
    addresses signed into a local playlist; anything else is used as given."""
    if not (src.startswith("s3://") and src.split("?")[0].endswith(".m3u8")):
        return src, None
    raw = os.path.join(workdir, "source_s3.m3u8")
    (fetch or (lambda u, p: run(["aws", "s3", "cp", u, p, "--only-show-errors"])))(src, raw)
    with open(raw) as fh:
        text = fh.read()
    # Six hours: a day of 1080p read once over the network takes well under that.
    signed = presign_playlist(text, src, presign or _botocore_presigner(6 * 3600))
    out = os.path.join(workdir, "source.m3u8")
    with open(out, "w") as fh:
        fh.write(signed)
    log(f"source {src}: {sum(1 for l in signed.splitlines() if l and not l.startswith('#'))} segments signed")
    return out, HTTP_PROTOCOLS


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
    src = cfg["source"]
    width = cfg.get("thumb_width", 320)
    aspect = cfg.get("aspect", [16, 9])
    grid = cfg.get("grid", {"cols": 5, "rows": 5})
    cols, rows = grid["cols"], grid["rows"]
    interval = cfg.get("interval_sec", 10)
    duration = cfg["duration_sec"]

    # Local mode: write the poster/sheets/VTT straight into out_dir (served by
    # the control plane at /origin/<channel>/thumbs) and skip the S3 upload.
    out_dir = cfg.get("out_dir")
    local = bool(out_dir)
    workdir = os.path.abspath(out_dir) if local else workdir
    os.makedirs(workdir, exist_ok=True)

    poster = os.path.join(workdir, "poster.jpg")
    sb_pattern = os.path.join(workdir, "sb_%03d.jpg")
    vtt = os.path.join(workdir, "thumbs.vtt")

    src, protocols = resolve_source(src, workdir)
    # A recording in the bucket is CMAF fMP4 like the local origin, and the
    # keyframe seek misses there the same way (no poster at all from a 48 s,
    # two-run playlist at 5 s or 30 s in the 2.3c check). The accurate poster
    # decodes only up to poster_at_sec (at most 30 s), so it stays cheap. The
    # storyboard keeps the keyframe-only pass: it read the same playlist
    # cleanly, and decoding a whole day would cost hours of CPU.
    poster_accurate = local or protocols is not None
    run(build_poster_cmd(src, poster, width, aspect, cfg.get("poster_at_sec", 0), accurate=poster_accurate, protocols=protocols))
    if not cfg.get("poster_only"):
        run(build_storyboard_cmd(src, sb_pattern, width, aspect, interval, cols, rows, accurate=local, protocols=protocols))
        with open(vtt, "w") as fh:
            fh.write(build_webvtt(duration, interval, cols, rows, width, aspect,
                                  lambda i: f"sb_{i:03d}.jpg"))

    if local:
        register(cfg, {
            "poster_key": poster,
            "storyboard_key": os.path.join(workdir, "sb_000.jpg"),
            "thumbs_vtt_key": vtt,
        })
        log(f"done (local -> {workdir})")
        return

    out_s3 = cfg["out_s3"].rstrip("/")
    s3_cp(poster, f"{out_s3}/poster.jpg")
    if not cfg.get("poster_only"):
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
