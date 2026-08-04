#!/usr/bin/env python3
"""
Volt encoder/packager orchestrator.

One process == one channel/event. It reads a job config (JSON), then:

  package_only:
    - for each rendition input, start an FFmpeg relay that pulls the
      contribution feed (SRT/RTMP(S)/HLS) and re-muxes to MPEG-TS on a
      local UDP port (no re-encode: -c copy). This isolates the flaky
      public network from Shaka and gives Shaka a stable local source.
    - Shaka Packager reads every rendition's UDP input together and emits
      CMAF single-file segments + synchronised HLS and DASH manifests,
      optionally cbcs-encrypted with keys fetched from the SPEKE server.

  transcode:
    - one FFmpeg process pulls the single mezzanine and fans it out to the
      full ladder (scale + x264/NVENC), each rendition to its own local UDP
      port, with aligned closed GOPs. Shaka then packages exactly as above.

  In both cases a sidecar `s3-uploader.sh` mirrors the local output dir to
  S3 continuously (CloudFront serves viewers from S3, so viewer traffic
  never touches this box). The live segments on S3 ARE the recording.

The job config schema is documented in ../job.example.json.
"""

import json
import os
import re
import shlex
import signal
import subprocess
import sys
import time

import source_selector
import events as events_mod

WORK_DIR = os.environ.get("WORK_DIR", "/work")
OUT_DIR = os.path.join(WORK_DIR, "out")
UDP_BASE_PORT = 20000  # rendition i -> 127.0.0.1:(UDP_BASE_PORT + i)

_children = []   # (name, Popen, critical)
_selectors = []  # SourceSelector instances (own their own poller threads)
_events = None   # EventLog (status snapshot + per-stream event log)


def log(msg):
    print(f"[volt-encoder] {msg}", flush=True)


def die(msg, code=1):
    log(f"FATAL: {msg}")
    sys.exit(code)


def load_config():
    path = os.environ.get("JOB_CONFIG", "/job/config.json")
    raw = os.environ.get("JOB_CONFIG_JSON")
    if raw:
        cfg = json.loads(raw)
    else:
        if not os.path.exists(path):
            die(f"job config not found at {path} (set JOB_CONFIG or JOB_CONFIG_JSON)")
        with open(path) as fh:
            cfg = json.load(fh)
    validate_config(cfg)
    return cfg


def primary_inputs(cfg):
    """Live path uses primary-role inputs only (backups are the failover pool,
    not a parallel encode). Inputs with no role default to primary."""
    return [i for i in cfg["inputs"] if i.get("role", "primary") == "primary"]


def backup_inputs(cfg):
    return [i for i in cfg["inputs"] if i.get("role") == "backup"]


def ladder_from_inputs(inputs):
    """Derive the rendition shape (height/bitrate) the filler must match, from
    a package_only ladder. Height comes from the rendition label ('1080p'->1080)."""
    ladder = []
    for i, inp in enumerate(inputs):
        label = inp.get("rendition_label", f"r{i}")
        m = re.match(r"(\d+)\s*p?$", str(label))
        height = int(m.group(1)) if m else 720
        ladder.append({"height": height,
                       "bitrate_kbps": inp.get("rendition_bitrate_kbps")
                       or inp.get("bitrate_kbps") or 2500})
    return ladder


def redundancy_on(cfg):
    red = cfg.get("redundancy")
    return bool(red and red.get("input_failover"))


def validate_config(cfg):
    for key in ("channel_id", "workflow", "segment_seconds", "s3", "inputs"):
        if key not in cfg:
            die(f"job config missing required field: {key}")
    if cfg["workflow"] not in ("package_only", "transcode"):
        die(f"workflow must be package_only or transcode, got {cfg['workflow']!r}")
    if not cfg["inputs"]:
        die("job config has no inputs")
    if "bucket" not in cfg["s3"]:
        die("s3.bucket is required")
    # renditions cap (primary ladder) mirrors accounts.max_renditions (hard max 8)
    n = len(primary_inputs(cfg)) if cfg["workflow"] == "package_only" \
        else len(cfg.get("ladder", []))
    if n > 8:
        die(f"{n} renditions exceeds hard max of 8")


# ---------------------------------------------------------------------------
# DRM: fetch content keys from the SPEKE server (Axinom) and hand raw keys to
# Shaka. Shaka does not speak SPEKE/CPIX itself, so speke_client.py does the
# CPIX POST and returns {key_id, key, iv, pssh...} which we translate into
# Shaka's --keys / --pssh flags.
# ---------------------------------------------------------------------------
def fetch_drm_keys(drm):
    if not drm or drm.get("mode", "none") == "none":
        return None
    log(f"fetching DRM keys from SPEKE server for content_id={drm.get('content_id')}")
    args = [
        sys.executable, "/app/bin/speke_client.py",
        "--url", drm["speke_url"],
        "--content-id", drm["content_id"],
        "--auth", drm.get("auth", ""),
        "--systems", ",".join(drm.get("systems", ["widevine", "playready", "fairplay"])),
    ]
    try:
        out = subprocess.check_output(args, timeout=30)
    except subprocess.CalledProcessError as exc:
        die(f"SPEKE key request failed: {exc}")
    except subprocess.TimeoutExpired:
        die("SPEKE key request timed out")
    keys = json.loads(out)
    log(f"received {len(keys.get('keys', []))} content key(s) from SPEKE")
    return keys


def shaka_drm_flags(keys):
    """Translate SPEKE key material into Shaka raw-key cbcs flags."""
    if not keys:
        return []
    flags = ["--enable_raw_key_encryption", "--protection_scheme", "cbcs"]
    for k in keys["keys"]:
        parts = [f"label={k.get('label', '')}",
                 f"key_id={k['key_id']}",
                 f"key={k['key']}"]
        flags += ["--keys", ":".join(parts)]
    for system, pssh in keys.get("pssh", {}).items():
        # Shaka accepts concatenated raw pssh boxes for the systems in play.
        pass
    if keys.get("pssh_hex"):
        flags += ["--pssh", keys["pssh_hex"]]
    if keys.get("hls_key_uri"):
        flags += ["--hls_key_uri", keys["hls_key_uri"]]
    return flags


# ---------------------------------------------------------------------------
# FFmpeg relay/transcode process builders. Each rendition lands on its own
# local UDP port so Shaka reads a set of aligned local sources.
# ---------------------------------------------------------------------------
def udp_out(idx):
    # The bus is READ by Shaka Packager, whose UDP option parser only accepts a
    # small set of fields (reuse/buffer_size/interface/timeout) — NOT ffmpeg's
    # pkt_size/overrun_nonfatal, which make it reject the input. reuse+buffer_size
    # are valid for BOTH Shaka (reader) and ffmpeg (writer), so one URL serves both.
    return f"udp://127.0.0.1:{UDP_BASE_PORT + idx}?reuse=1&buffer_size=2097152"


def input_args(inp):
    """Protocol-specific FFmpeg input flags for a contribution feed."""
    proto = inp["protocol"].lower()
    url = inp["url"]
    if proto == "srt":
        return ["-fflags", "+genpts", "-i", url]
    if proto in ("rtmp", "rtmps"):
        return ["-i", url]
    if proto == "hls":
        return ["-re" if inp.get("realtime") else "-fflags", "+genpts", "-i", url] \
            if inp.get("realtime") else ["-fflags", "+genpts", "-i", url]
    die(f"unsupported input protocol: {proto}")


def start_relay(inp, idx):
    """package_only: pull one already-encoded rendition and re-mux to UDP TS.
    No re-encode (-c copy) — cheap, CPU-light, preserves the client's GOPs."""
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-nostdin"]
    cmd += input_args(inp)
    cmd += ["-c", "copy", "-f", "mpegts", udp_out(idx)]
    name = f"relay:{inp.get('rendition_label', idx)}"
    return spawn(name, cmd)


def start_transcode(cfg, keys_unused):
    """transcode: one mezzanine -> full ladder, aligned closed GOPs, each
    rendition to its own UDP port. GPU (NVENC) if requested, else x264."""
    ladder = cfg["ladder"]
    seg = cfg["segment_seconds"]
    src = cfg["inputs"][0]
    gpu = cfg.get("gpu", False)
    fps = cfg.get("fps", 25)
    gop = int(seg * fps)  # closed GOP == segment length so boundaries align

    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-nostdin"]
    if gpu:
        cmd += ["-hwaccel", "cuda"]
    cmd += input_args(src)

    for i, r in enumerate(ladder):
        vcodec = ["-c:v", "h264_nvenc", "-preset", "p4"] if gpu else \
                 ["-c:v", "libx264", "-preset", "veryfast"]
        cmd += ["-map", "0:v:0"]
        cmd += ["-vf", f"scale=-2:{r['height']}"]
        cmd += vcodec
        cmd += ["-b:v", f"{r['bitrate_kbps']}k",
                "-maxrate", f"{int(r['bitrate_kbps']*1.1)}k",
                "-bufsize", f"{r['bitrate_kbps']*2}k",
                "-g", str(gop), "-keyint_min", str(gop),
                "-sc_threshold", "0",           # closed GOP, no scene-cut
                "-force_key_frames", f"expr:gte(t,n_forced*{seg})",
                "-r", str(fps)]
        cmd += ["-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k", "-ac", "2"]
        cmd += ["-f", "mpegts", udp_out(i)]
    return [spawn("transcode", cmd)]


# ---------------------------------------------------------------------------
# Shaka Packager: consume the UDP renditions, emit CMAF + HLS + DASH to OUT_DIR.
# ---------------------------------------------------------------------------
def build_shaka(cfg, keys):
    seg = cfg["segment_seconds"]
    channel = cfg["channel_id"]
    if cfg["workflow"] == "package_only":
        rends = [(i, inp.get("rendition_label", f"r{i}"), inp.get("has_audio", i == 0))
                 for i, inp in enumerate(primary_inputs(cfg))]
    else:
        rends = [(i, f"{r['height']}p", i == 0) for i, r in enumerate(cfg["ladder"])]

    cmd = ["packager"]
    for idx, label, has_audio in rends:
        vseg = f"{OUT_DIR}/{label}/seg_$Number$.m4s"
        vinit = f"{OUT_DIR}/{label}/init.mp4"
        cmd.append(
            f"in={udp_out(idx)},stream=video,"
            f"init_segment={vinit},segment_template={vseg}"
        )
        if has_audio:
            aseg = f"{OUT_DIR}/audio/seg_$Number$.m4s"
            ainit = f"{OUT_DIR}/audio/init.mp4"
            cmd.append(
                f"in={udp_out(idx)},stream=audio,"
                f"init_segment={ainit},segment_template={aseg}"
            )

    cmd += [
        "--segment_duration", str(seg),
        "--fragment_duration", str(seg),
        "--minimum_update_period", str(seg),
        "--time_shift_buffer_depth", str(cfg.get("dvr_seconds", 300)),
        "--preserved_segments_outside_live_window",
        str(cfg.get("preserved_segments", 0)),   # 0 => keep everything (recording)
        "--mpd_output", f"{OUT_DIR}/manifest.mpd",
        "--hls_master_playlist_output", f"{OUT_DIR}/master.m3u8",
        "--hls_playlist_type", "LIVE",
    ]
    cmd += shaka_drm_flags(keys)
    return cmd


# ---------------------------------------------------------------------------
# process management
# ---------------------------------------------------------------------------
def spawn(name, cmd, critical=True):
    # critical=False for selector-managed children (relays/forwarders/filler):
    # their death is EXPECTED (a source dropping) and handled by failover, so it
    # must not trip the whole-container teardown below.
    log(f"start {name}: {' '.join(shlex.quote(c) for c in cmd)}")
    proc = subprocess.Popen(cmd)
    _children.append((name, proc, critical))
    return proc


def start_uploader(cfg):
    s3 = cfg["s3"]
    dest = f"s3://{s3['bucket']}/{s3.get('prefix', cfg['channel_id']).rstrip('/')}/"
    cmd = ["/app/bin/s3-uploader.sh", OUT_DIR, dest,
           str(cfg.get("upload_interval_seconds", 2))]
    return spawn("s3-uploader", cmd)


def shutdown(*_):
    log("shutdown: terminating children")
    if _events:
        _events.channel_stop()
    for sel in _selectors:
        sel.stop()
    for name, proc, _crit in _children:
        if proc.poll() is None:
            proc.terminate()
    deadline = time.time() + 10
    for name, proc, _crit in _children:
        try:
            proc.wait(timeout=max(0, deadline - time.time()))
        except subprocess.TimeoutExpired:
            log(f"kill {name}")
            proc.kill()
    sys.exit(0)


def main():
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    global _events
    cfg = load_config()
    os.makedirs(OUT_DIR, exist_ok=True)
    nrend = len(primary_inputs(cfg)) if cfg["workflow"] == "package_only" \
        else len(cfg.get("ladder", []))
    log(f"channel={cfg['channel_id']} workflow={cfg['workflow']} renditions={nrend}")

    # Event log + live status snapshot. Reports to the control plane's ingest
    # endpoint (if configured) and writes a local status file every change.
    red = cfg.get("redundancy") or {}
    report = cfg.get("status_report") or {}
    _events = events_mod.EventLog(
        channel_id=cfg["channel_id"],
        clock=lambda: int(time.time() * 1000),
        report_url=report.get("url"),
        report_token=report.get("token"),
        status_path=os.path.join(WORK_DIR, "status.json"),
        emit=lambda line: print(line, flush=True),
        has_backup=bool(backup_inputs(cfg)),
        has_filler=redundancy_on(cfg) and red.get("input_loss_behavior", "slate") in ("slate", "vod_loop"),
    )
    _events.channel_start(cfg["workflow"], nrend)

    keys = fetch_drm_keys(cfg.get("drm"))

    # Shaka first so its UDP listeners are up before FFmpeg starts pushing.
    shaka = spawn("packager", build_shaka(cfg, keys))
    time.sleep(1)
    _events.packager(True)

    selector = None
    if cfg["workflow"] == "package_only":
        if redundancy_on(cfg):
            # The source-selector owns the bus ports Shaka reads: it runs the
            # primary + backup relays and the filler, and forwards the active
            # group to the bus with health-driven failover + filler-on-loss.
            prim, bak = primary_inputs(cfg), backup_inputs(cfg)
            selector = source_selector.SourceSelector(
                cfg, ladder=ladder_from_inputs(prim),
                primary=prim, backup=bak,
                spawn=lambda name, cmd: spawn(name, cmd, critical=False),
                log=log, work_dir=WORK_DIR, event_log=_events)
            _selectors.append(selector)
            log(f"redundancy: input_failover on — {len(prim)} primary / "
                f"{len(bak)} backup rendition(s), "
                f"loss_behavior={cfg['redundancy'].get('input_loss_behavior','slate')}")
            selector.start()
        else:
            for i, inp in enumerate(primary_inputs(cfg)):
                start_relay(inp, i)
            # no failover monitor on this path; assume primary feeding on start
            _events.source_state("primary", True, renditions=nrend)
    else:
        if redundancy_on(cfg):
            # Transcode failover needs the selector to feed a single chosen
            # mezzanine into the encoder (an extra source-bus hop) — not yet
            # wired. Run on the primary mezzanine for now.
            log("redundancy: input_failover requested on a transcode job — "
                "mezzanine failover not yet wired; running primary only (see README)")
        start_transcode(cfg, keys)
        _events.source_state("primary", True, renditions=nrend)

    start_uploader(cfg)

    # Supervise: if any critical child dies, tear the whole channel down so
    # ECS restarts a clean container (renditions must stay in lockstep).
    try:
        while True:
            for name, proc, critical in _children:
                if critical and proc.poll() is not None:
                    log(f"critical child {name} exited rc={proc.returncode}; "
                        f"tearing down channel")
                    shutdown()
            time.sleep(2)
    except KeyboardInterrupt:
        shutdown()


if __name__ == "__main__":
    main()
