#!/usr/bin/env python3
"""source_probe.py: what a source (or one of our own packaged renditions) actually is.

    python3 source_probe.py <url-or-path> [--seconds 6]          -> JSON on stdout
    python3 source_probe.py --rendition <dir>                    -> one CMAF rendition dir

Returns the parameters a filler has to match for a player (and the packager) to accept
a switch onto it: codec, H.264 profile and level, width, height, frame rate, pixel
format, bitrate, and the audio's codec, sample rate, channel count and bitrate.

One definition, used by the control plane when a source is added (it stores the
result and pre-builds the loop from it) and by the encoder when it has to build or
check a loop itself. Stdlib only, plus ffprobe.

Bitrate is the awkward one. A container often does not state it (HLS media playlists,
SRT, most TS), so when the stream does not say, it is MEASURED: packet sizes summed over
a few seconds. An HLS master's BANDWIDTH is taken when the URL is a master.
"""
import json
import os
import re
import subprocess
import sys
import urllib.request

FFPROBE = os.environ.get("FFPROBE_BIN", "ffprobe")


def _run(args, timeout=25):
    r = subprocess.run([FFPROBE, "-v", "error", *args], capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0 and not r.stdout:
        raise RuntimeError((r.stderr or "ffprobe failed").strip().splitlines()[-1][:200])
    return json.loads(r.stdout or "{}")


def _fps(rate):
    try:
        n, d = (rate or "0/1").split("/")
        v = float(n) / float(d or 1)
        return round(v, 3) if v > 0 else None
    except (ValueError, ZeroDivisionError):
        return None


_PROFILE = {
    "constrained baseline": "baseline", "baseline": "baseline", "main": "main",
    "extended": "main", "high": "high", "high 10": "high10", "high 4:2:2": "high422",
}


def x264_profile(name):
    """ffprobe's profile name -> the x264 -profile:v value that produces it."""
    return _PROFILE.get(str(name or "").strip().lower(), "high")


def x264_level(level):
    """ffprobe reports H.264 level as an int (31 -> 3.1, 40 -> 4.0)."""
    try:
        lv = int(level)
    except (TypeError, ValueError):
        return None
    if lv <= 0:
        return None
    return f"{lv // 10}.{lv % 10}"


def _http_get(url, timeout=8):
    req = urllib.request.Request(url, headers={"User-Agent": "volt-probe/1.0"})
    return urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8", "ignore")


def _master_bandwidth(url):
    """BANDWIDTH of the highest variant when `url` is an HLS master, else None.
    Also returns the variant URL actually probed."""
    if not re.match(r"^https?://", url or "", re.I) or ".m3u8" not in url:
        return None, url
    try:
        txt = _http_get(url)
    except Exception:  # noqa: BLE001
        return None, url
    if "#EXT-X-STREAM-INF" not in txt or "#EXTINF" in txt:
        return None, url
    from urllib.parse import urljoin
    best = None
    lines = txt.splitlines()
    for i, l in enumerate(lines):
        if l.startswith("#EXT-X-STREAM-INF"):
            bw = re.search(r"BANDWIDTH=(\d+)", l)
            res = re.search(r"RESOLUTION=(\d+)x(\d+)", l)
            uri = next((x.strip() for x in lines[i + 1:i + 3] if x.strip() and not x.startswith("#")), None)
            if not uri:
                continue
            key = (int(res.group(2)) if res else 0, int(bw.group(1)) if bw else 0)
            if best is None or key > best[0]:
                best = (key, urljoin(url, uri))
    if not best:
        return None, url
    return best[0][1] // 1000 or None, best[1]


def _measured_kbps(url, seconds, stream):
    """Sum packet sizes of one stream over `seconds` of media."""
    try:
        d = _run(["-select_streams", stream, "-read_intervals", f"%+{seconds}",
                  "-show_entries", "packet=size,pts_time,dts_time", "-of", "json", url], timeout=seconds + 25)
    except Exception:  # noqa: BLE001
        return None
    pk = d.get("packets") or []
    times = [float(p.get("pts_time") or p.get("dts_time") or 0) for p in pk if (p.get("pts_time") or p.get("dts_time"))]
    if len(pk) < 2 or not times:
        return None
    span = max(times) - min(times)
    if span <= 0.5:
        return None
    return int(round(sum(int(p.get("size") or 0) for p in pk) * 8 / span / 1000))


def probe(url, seconds=6):
    bw, probed = _master_bandwidth(url)
    d = _run(["-show_entries",
              "stream=index,codec_type,codec_name,profile,level,width,height,pix_fmt,r_frame_rate,"
              "avg_frame_rate,bit_rate,sample_rate,channels:format=bit_rate,duration",
              "-of", "json", "-analyzeduration", "4000000", "-probesize", "4000000", probed])
    streams = d.get("streams") or []
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    out = {"url": url, "probed_url": probed, "video": None, "audio": None}
    if v:
        kbps = int(v["bit_rate"]) // 1000 if str(v.get("bit_rate") or "").isdigit() else None
        src = "stream"
        if not kbps:
            kbps = _measured_kbps(probed, seconds, "v:0")
            src = "measured" if kbps else None
        if not kbps and bw:
            kbps, src = bw, "master BANDWIDTH"
        out["video"] = {
            "codec": v.get("codec_name"), "profile": v.get("profile"), "level": v.get("level"),
            "x264_profile": x264_profile(v.get("profile")), "x264_level": x264_level(v.get("level")),
            "width": v.get("width"), "height": v.get("height"), "pix_fmt": v.get("pix_fmt"),
            "fps": _fps(v.get("avg_frame_rate")) or _fps(v.get("r_frame_rate")),
            "bitrate_kbps": kbps, "bitrate_source": src,
        }
    if a:
        akbps = int(a["bit_rate"]) // 1000 if str(a.get("bit_rate") or "").isdigit() else None
        if not akbps:
            akbps = _measured_kbps(probed, seconds, "a:0")
        out["audio"] = {"codec": a.get("codec_name"), "sample_rate": int(a.get("sample_rate") or 0) or None,
                        "channels": a.get("channels"), "bitrate_kbps": akbps}
    return out


def probe_rendition(rdir, max_segments=3):
    """Probe one of OUR packaged CMAF renditions (init.mp4 + seg_N.m4s): exactly what the
    live output is, which is what a filler spliced into that rendition must match."""
    init = os.path.join(rdir, "init.mp4")
    segs = sorted((f for f in os.listdir(rdir) if re.match(r"seg_\d+\.m4s$", f)),
                  key=lambda f: int(re.findall(r"\d+", f)[0]))
    if not os.path.exists(init) or not segs:
        return None
    pick = segs[-max_segments:]
    blob = os.path.join(rdir, ".probe.mp4")
    with open(blob, "wb") as fh:
        fh.write(open(init, "rb").read())
        for s in pick:
            fh.write(open(os.path.join(rdir, s), "rb").read())
    try:
        d = probe(blob, seconds=30)
        dur = None
        try:
            fd = _run(["-show_entries", "format=duration", "-of", "json", blob])
            dur = float((fd.get("format") or {}).get("duration") or 0) or None
        except Exception:  # noqa: BLE001
            pass
        size = sum(os.path.getsize(os.path.join(rdir, s)) for s in pick)
        if dur:
            kbps = int(round(size * 8 / dur / 1000))
            for k in ("video", "audio"):
                if d.get(k) is not None:
                    d[k]["bitrate_kbps"] = kbps
                    if k == "video":
                        d[k]["bitrate_source"] = "measured from output segments"
    finally:
        try:
            os.remove(blob)
        except OSError:
            pass
    d["url"] = rdir
    return d


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(2)
    try:
        if args[0] == "--rendition":
            res = probe_rendition(args[1])
        else:
            secs = int(args[args.index("--seconds") + 1]) if "--seconds" in args else 6
            res = probe(args[0], secs)
        print(json.dumps(res))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
