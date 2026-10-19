"""
INGEST ARGUMENTS PER PROTOCOL: how ffmpeg opens each kind of contribution feed,
with the settings the console collects for it (stream_inputs.params, sent by
the control plane as inp["params"]). See volt-app/docs/SOURCES.md.

  srt      caller / listener, latency, passphrase + key length, stream id
  rtmp(s)  server URL with the stream key (the control plane joins them)
  dash     the MPD, with the same reconnect behaviour as HLS
  ndi      libndi_newtek input: the source name, extra IPs, and a generated
           NDI config for groups and the discovery server
  st2110   an SDP (fetched or written from the inline text) opened over RTP,
           joined on the receive interface when one is given

HLS keeps its own path in encoder.py (live-edge probing, variant choice).

PACKAGING an NDI or ST 2110 source: they carry uncompressed video, so the
relay ENCODES the rendition once (its own height and bitrate, one segment per
GOP) instead of copying. Everything else is copied untouched.

Pure functions apart from writing the NDI config / SDP files into work_dir,
so they are unit tested (test_ingest_args.py).
"""
import json
import os
import re
import subprocess
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

ENCODE_ON_PACKAGE = ("ndi", "st2110")


def _params(inp):
    p = inp.get("params") or {}
    return p if isinstance(p, dict) else {}


def srt_url(url, params):
    """The SRT URL with the console's settings as query options, without
    overriding anything already written into the URL by hand.

    ffmpeg's srt `latency` is in MICROSECONDS; the console asks in ms."""
    parts = urlsplit(url)
    q = dict(parse_qsl(parts.query, keep_blank_values=True))
    mode = str(params.get("mode") or "").strip()
    if mode in ("caller", "listener") and "mode" not in q:
        q["mode"] = mode
    if params.get("latency") not in (None, "") and "latency" not in q:
        q["latency"] = str(int(float(params["latency"]) * 1000))
    if params.get("passphrase") and "passphrase" not in q:
        q["passphrase"] = str(params["passphrase"])
        if params.get("pbkeylen") and "pbkeylen" not in q:
            q["pbkeylen"] = str(params["pbkeylen"])
    if params.get("streamid") and "streamid" not in q:
        q["streamid"] = str(params["streamid"])
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(q, safe="#!:,=/"), parts.fragment))


def _http_flags():
    return ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_on_network_error", "1",
            "-reconnect_delay_max", "4"]


_ndi_support = None


def ffmpeg_has_ndi():
    """Is this ffmpeg built with the NDI SDK (libndi_newtek)? Asked once."""
    global _ndi_support
    if _ndi_support is None:
        try:
            out = subprocess.run(["ffmpeg", "-hide_banner", "-formats"], capture_output=True, text=True, timeout=10).stdout
            _ndi_support = "libndi_newtek" in out
        except Exception:  # noqa: BLE001
            _ndi_support = False
    return _ndi_support


def write_ndi_config(params, work_dir):
    """NDI groups and the discovery server are SDK settings, read from
    $NDI_CONFIG_DIR/ndi-config.v1.json. Returns the dir, or None when there is
    nothing to set."""
    groups = str(params.get("groups") or "").strip()
    ds = str(params.get("discoveryServer") or "").strip()
    if not groups and not ds:
        return None
    cfg = {"ndi": {}}
    if ds:
        cfg["ndi"]["networks"] = {"discovery": ds}
    if groups:
        cfg["ndi"]["groups"] = {"recv": groups}
    d = os.path.join(work_dir, "ndi")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "ndi-config.v1.json"), "w") as f:
        json.dump(cfg, f)
    return d


def write_sdp(params, work_dir, idx, fetch=None):
    """The ST 2110 SDP as a local file: written from the inline text, or
    fetched from its URL. Returns the path."""
    sdp = str(params.get("sdp") or "").strip()
    if not sdp:
        raise ValueError("an ST 2110 input needs its SDP")
    path = os.path.join(work_dir, f"st2110-{idx}.sdp")
    if re.match(r"^https?://", sdp, re.I):
        if fetch is None:
            import urllib.request
            def fetch(u):  # noqa: E306
                return urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "volt-encoder/1.0"}), timeout=10).read().decode("utf-8", "ignore")
        sdp = fetch(sdp)
    if not sdp.lstrip().startswith("v=0"):
        raise ValueError("the ST 2110 SDP does not start with v=0")
    with open(path, "w") as f:
        f.write(sdp.replace("\r\n", "\n").strip() + "\n")
    return path


def open_args(inp, work_dir, q=None, idx=0, env=None):
    """Everything up to and including `-i <source>` for a non-HLS input.
    `env` (a dict) receives variables the process needs (NDI config dir)."""
    proto = (inp.get("protocol") or "").lower()
    url = inp["url"]
    params = _params(inp)
    q = q or []
    if proto == "srt":
        return ["-fflags", "+genpts", *q, "-i", srt_url(url, params)]
    if proto in ("rtmp", "rtmps"):
        return [*q, "-i", url]
    if proto == "dash":
        return [*_http_flags(), *q, "-i", url]
    if proto == "ndi":
        if not ffmpeg_has_ndi():
            raise RuntimeError(
                "this ingest node's ffmpeg has no NDI support (libndi_newtek). Run the channel on an "
                "NDI-enabled ingest node, or bridge NDI to SRT and use an SRT source")
        cfg_dir = write_ndi_config(params, work_dir)
        if cfg_dir is not None and env is not None:
            env["NDI_CONFIG_DIR"] = cfg_dir
        args = ["-f", "libndi_newtek"]
        ips = ",".join(x for x in re.split(r"[\s,]+", str(params.get("extraIps") or "")) if x)
        if ips:
            args += ["-extra_ips", ips]
        args += ["-wait_sources", "5"]
        return [*args, *q, "-i", url]
    if proto == "st2110":
        sdp_path = write_sdp(params, work_dir, idx)
        args = ["-protocol_whitelist", "file,udp,rtp,http,https,tcp,tls",
                "-reorder_queue_size", "0", "-buffer_size", str(256 * 1024 * 1024)]
        iface = str(params.get("interfaceIp") or "").strip()
        if iface:
            args += ["-localaddr", iface]   # which NIC joins the multicast
        return [*args, *q, "-f", "sdp", "-i", sdp_path]
    raise ValueError(f"unsupported input protocol: {proto}")


def needs_encode(inp):
    """A packaging relay that must encode rather than copy."""
    return bool(inp.get("encode")) or (inp.get("protocol") or "").lower() in ENCODE_ON_PACKAGE


def height_of(inp, default=1080):
    m = re.match(r"(\d{3,4})", str(inp.get("rendition_label") or ""))
    return int(m.group(1)) if m else default


def encode_rendition_args(inp, seg=4, fps=25):
    """Encode ONE packaging rendition from an uncompressed source: its own
    height and bitrate, a GOP of exactly one segment (so it lines up with the
    other renditions), audio as AAC 48 kHz stereo on the first rendition."""
    seg = float(inp.get("_seg") or seg)
    fps = int(inp.get("_fps") or fps)
    kbps = int(inp.get("bitrate_kbps") or inp.get("rendition_bitrate_kbps") or 4000)
    gop = int(seg * fps)
    args = ["-map", "0:v:0", "-vf", f"scale=-2:{height_of(inp)}", "-pix_fmt", "yuv420p",
            "-c:v", "libx264", "-preset", "veryfast",
            "-b:v", f"{kbps}k", "-maxrate", f"{int(kbps * 1.1)}k", "-bufsize", f"{kbps * 2}k",
            "-g", str(gop), "-keyint_min", str(gop), "-sc_threshold", "0",
            "-force_key_frames", f"expr:gte(t,n_forced*{seg:g})", "-r", str(fps)]
    if inp.get("has_audio", True):
        args += ["-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000"]
    else:
        args += ["-an"]
    return args
