#!/usr/bin/env python3
"""filler_build.py: pre-build a channel's fallback loop, MATCHED to its ladder, packaged once.

    python3 filler_build.py <spec.json> <out_dir>

The loop (an uploaded video, or a slate image) is encoded once per rendition at that
rendition's exact width, height, frame rate, H.264 profile/level, pixel format and
bitrate, with one closed GOP per segment, then packaged by Shaka into CMAF segments
the same length as the live segments. The result is spliced into the DELIVERED
playlists on a loss (see playout.py), so:

  * nothing is encoded at failover time, and no encoder has to run to show the loop;
  * the packager never sees the filler. On a package_only channel the old path fed a
    freshly encoded filler into Shaka and Shaka stopped dead on "H.264 decoder
    configuration has changed", taking the channel down at the moment it was meant to
    be saved;
  * the player gets a discontinuity and an EXT-X-MAP for the loop's own init segment,
    the standard ad-insertion shape every HLS player handles, and because the loop
    matches the rendition it replaces there is no resolution or profile change for the
    decoder to cope with.

spec.json:
  {"segment_seconds": 4,
   "source": {"kind": "video"|"image", "path": "/abs/loop.mp4"},
   "video": [{"label": "720p", "width": 1280, "height": 720, "fps": 25,
              "bitrate_kbps": 2500, "x264_profile": "high", "x264_level": "3.1",
              "pix_fmt": "yuv420p"}, ...],
   "audio": {"sample_rate": 48000, "channels": 2, "bitrate_kbps": 128} | null,
   "max_loop_seconds": 60}

Writes <out_dir>/filler.json describing every track's init and segments, and the
CMAF under <out_dir>/<label>/ and <out_dir>/audio/.
"""
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time

FFMPEG = os.environ.get("FFMPEG_BIN", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE_BIN", "ffprobe")
PACKAGER = os.environ.get("PACKAGER_BIN", "packager")


def log(msg):
    print(f"[filler-build] {msg}", file=sys.stderr, flush=True)


def spec_hash(spec):
    """Identity of a build: the spec plus the source file's size and mtime. The same
    channel with the same ladder and the same loop reuses its build across runs."""
    s = dict(spec)
    src = (spec.get("source") or {}).get("path")
    try:
        st = os.stat(src)
        s["_src"] = [st.st_size, int(st.st_mtime)]
    except (OSError, TypeError):
        s["_src"] = None
    return hashlib.sha1(json.dumps(s, sort_keys=True).encode()).hexdigest()[:16]


def _duration(path):
    try:
        r = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                            "-of", "default=nw=1:nk=1", path], capture_output=True, text=True, timeout=30)
        return float(r.stdout.strip() or 0) or None
    except Exception:  # noqa: BLE001
        return None


def _has_audio(path):
    try:
        r = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "a", "-show_entries",
                            "stream=index", "-of", "csv=p=0", path], capture_output=True, text=True, timeout=30)
        return bool(r.stdout.strip())
    except Exception:  # noqa: BLE001
        return False


def _even(n):
    n = int(round(n))
    return n - (n % 2)


def loop_seconds(spec):
    seg = float(spec["segment_seconds"])
    src = spec["source"]
    cap = float(spec.get("max_loop_seconds") or 60)
    if src.get("kind") == "image":
        n = 2
    else:
        d = _duration(src["path"]) or seg * 2
        n = max(2, int(round(min(d, cap) / seg)))
    return n * seg


def _run(cmd, what):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        tail = (r.stderr or "").strip().splitlines()[-3:]
        raise RuntimeError(f"{what} failed: {' | '.join(tail)}")


def _video_cmd(spec, v, L, dst):
    seg = float(spec["segment_seconds"])
    src = spec["source"]
    fps = float(v.get("fps") or 25)
    w, h = _even(v["width"]), _even(v["height"])
    gop = int(round(seg * fps))
    kbps = int(v.get("bitrate_kbps") or 1500)
    prof = v.get("x264_profile") or "high"
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
    if src.get("kind") == "image":
        cmd += ["-loop", "1", "-framerate", str(fps), "-i", src["path"]]
    else:
        cmd += ["-stream_loop", "-1", "-i", src["path"]]
    base = (f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps}")
    pixfmt = v.get('pix_fmt') or 'yuv420p'
    wm = spec.get("watermark") or {}
    if wm.get("path") and os.path.exists(wm["path"]):
        # the channel's burned-in watermark goes on the loop too, at the same place and
        # size as the live encoder puts it (encoder._overlay_vf), so the brand does not
        # vanish for the length of an outage. A looped second INPUT rather than a
        # movie= source: movie= is not ready for the first frame, which left every
        # loop restart without the watermark for one frame.
        mx, my = int(wm.get("offset_x", 24)), int(wm.get("offset_y", 24))
        xy = {"tl": f"{mx}:{my}", "tr": f"main_w-overlay_w-{mx}:{my}",
              "bl": f"{mx}:main_h-overlay_h-{my}", "br": f"main_w-overlay_w-{mx}:main_h-overlay_h-{my}",
              "tc": f"(main_w-overlay_w)/2:{my}", "bc": f"(main_w-overlay_w)/2:main_h-overlay_h-{my}",
              }.get(str(wm.get("position") or "br").lower(), f"main_w-overlay_w-{mx}:main_h-overlay_h-{my}")
        op = max(0.0, min(1.0, float(wm.get("opacity", 100)) / 100.0))
        wmh = max(1, int(round(h * float(wm.get("scale", 12)) / 100.0)))
        cmd += ["-loop", "1", "-i", wm["path"]]
        fc = (f"[1:v]format=rgba,colorchannelmixer=aa={op:.3f},scale=-1:{wmh}[wm];"
              f"[0:v]{base}[bg];[bg][wm]overlay={xy}:shortest=1,format={pixfmt}[v]")
        cmd += ["-t", f"{L:.3f}", "-filter_complex", fc, "-map", "[v]"]
    else:
        cmd += ["-t", f"{L:.3f}", "-map", "0:v:0", "-vf", f"{base},format={pixfmt}"]
    cmd += ["-c:v", "libx264", "-preset", "medium", "-profile:v", prof]
    if v.get("x264_level"):
        cmd += ["-level:v", str(v["x264_level"])]
    if prof == "baseline":
        cmd += ["-bf", "0"]
    cmd += ["-b:v", f"{kbps}k", "-maxrate", f"{int(kbps * 1.1)}k", "-bufsize", f"{kbps * 2}k",
            "-g", str(gop), "-keyint_min", str(gop), "-sc_threshold", "0",
            "-force_key_frames", f"expr:gte(t,n_forced*{seg})", "-an", dst]
    return cmd


def _audio_cmd(spec, a, L, dst):
    src = spec["source"]
    sr = int(a.get("sample_rate") or 48000)
    ch = 1 if int(a.get("channels") or 2) == 1 else 2
    kbps = int(a.get("bitrate_kbps") or 128)
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
    if src.get("kind") != "image" and _has_audio(src["path"]):
        cmd += ["-stream_loop", "-1", "-i", src["path"], "-map", "0:a:0"]
    else:
        cmd += ["-f", "lavfi", "-i", f"anullsrc=channel_layout={'mono' if ch == 1 else 'stereo'}:sample_rate={sr}"]
    cmd += ["-t", f"{L:.3f}", "-vn", "-c:a", "aac", "-ar", str(sr), "-ac", str(ch),
            "-b:a", f"{kbps}k", dst]
    return cmd


def _parse_vod_playlist(path):
    """[(uri, dur)] + init uri from a Shaka VOD media playlist."""
    segs, init, pend = [], None, None
    for l in open(path).read().splitlines():
        if l.startswith("#EXT-X-MAP:"):
            mo = re.search(r'URI="([^"]+)"', l)
            init = mo.group(1) if mo else None
        elif l.startswith("#EXTINF:"):
            pend = float(l[8:].split(",")[0])
        elif l and not l.startswith("#") and pend is not None:
            segs.append({"uri": l, "dur": pend})
            pend = None
    return init, segs


def _localise(spec, work):
    """Source and watermark may be URLs (the control plane hands over library refs as
    fetchable URLs). Fetch them once into the build dir: the encode loops the source
    with -stream_loop, which has to seek, and seeking over HTTP is exactly what made the
    old runtime filler hang (see encoder.prepare_filler_slate)."""
    import urllib.request
    spec = json.loads(json.dumps(spec))
    for key, name in (("source", "source"), ("watermark", "watermark")):
        obj = spec.get(key) or {}
        p = obj.get("path")
        if p and re.match(r"^https?://", p, re.I):
            ext = os.path.splitext(p.split("?", 1)[0])[1] or ".bin"
            dst = os.path.join(work, f"{name}{ext}")
            urllib.request.urlretrieve(p, dst)
            obj["path"] = dst
    return spec


def build(spec, out_dir):
    t0 = time.time()
    seg = float(spec["segment_seconds"])
    tmp = out_dir.rstrip("/") + ".tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp, exist_ok=True)
    mez = os.path.join(tmp, "_mez")
    os.makedirs(mez, exist_ok=True)
    ident = spec_hash(spec)
    spec = _localise(spec, mez)
    L = loop_seconds(spec)

    pk = [PACKAGER]
    for v in spec["video"]:
        lab = v["label"]
        dst = os.path.join(mez, f"{lab}.mp4")
        _run(_video_cmd(spec, v, L, dst), f"encode {lab}")
        pk.append(f"in={dst},stream=video,init_segment={tmp}/{lab}/init.mp4,"
                  f"segment_template={tmp}/{lab}/seg_$Number$.m4s,playlist_name={lab}.m3u8")
    if spec.get("audio") is not None:
        adst = os.path.join(mez, "audio.mp4")
        _run(_audio_cmd(spec, spec["audio"], L, adst), "encode audio")
        pk.append(f"in={adst},stream=audio,init_segment={tmp}/audio/init.mp4,"
                  f"segment_template={tmp}/audio/seg_$Number$.m4s,playlist_name=audio.m3u8,hls_group_id=audio")
    pk += ["--segment_duration", str(seg), "--hls_master_playlist_output", f"{tmp}/master.m3u8",
           "--hls_playlist_type", "VOD"]
    _run(pk, "package")

    tracks = {}
    for v in spec["video"]:
        init, segs = _parse_vod_playlist(os.path.join(tmp, f"{v['label']}.m3u8"))
        tracks[v["label"]] = {"kind": "video", "init": init, "segments": segs,
                              **{k: v.get(k) for k in ("width", "height", "fps", "bitrate_kbps",
                                                        "x264_profile", "x264_level")}}
    if spec.get("audio") is not None:
        init, segs = _parse_vod_playlist(os.path.join(tmp, "audio.m3u8"))
        tracks["audio"] = {"kind": "audio", "init": init, "segments": segs, **spec["audio"]}
    shutil.rmtree(mez, ignore_errors=True)
    meta = {"hash": ident, "segment_seconds": seg, "loop_seconds": L,
            "source": spec["source"], "has_watermark": bool((spec.get("watermark") or {}).get("path")), "tracks": tracks, "built_at": int(time.time()),
            "build_seconds": round(time.time() - t0, 1)}
    with open(os.path.join(tmp, "filler.json"), "w") as fh:
        json.dump(meta, fh, indent=1)
    shutil.rmtree(out_dir, ignore_errors=True)
    os.replace(tmp, out_dir)
    log(f"built {len(spec['video'])} rendition(s) + {'audio' if spec.get('audio') else 'no audio'}, "
        f"{L:.0f}s loop, {int(L // seg)} segment(s) each, in {meta['build_seconds']}s -> {out_dir}")
    return meta


def load(out_dir):
    try:
        return json.load(open(os.path.join(out_dir, "filler.json")))
    except (OSError, ValueError):
        return None


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    spec = json.load(open(sys.argv[1]))
    try:
        print(json.dumps(build(spec, sys.argv[2])))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
