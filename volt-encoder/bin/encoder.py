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

import glob
import json
import os
import re
import shlex
import signal
import subprocess
import sys
import threading
import time

import source_selector
import events as events_mod

WORK_DIR = os.environ.get("WORK_DIR", "/work")
OUT_DIR = os.path.join(WORK_DIR, "out")
UDP_BASE_PORT = int(os.environ.get("UDP_BASE_PORT", "20000"))  # rendition i -> 127.0.0.1:(UDP_BASE_PORT + i)
# Dedicated audio-elementary-stream ports sit well above the video renditions so
# they never collide: audio track a -> UDP_BASE_PORT + AUDIO_IDX_BASE + a.
AUDIO_IDX_BASE = 100
# Shaka Packager binary name/path. Distros/installs vary (`packager`,
# `shaka-packager`, or a downloaded `packager-osx-arm64`), so allow an override.
PACKAGER_BIN = os.environ.get("PACKAGER_BIN", "packager")

_children = []   # (name, Popen, critical)
BASE_OUT_DIR = None   # local mode: the channel origin root (runs live in runs/<RUN_ID>)
RUN_ID = None         # this run's unique, date-ordered id (local mode)
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


def is_local(cfg):
    """Local-storage mode: write CMAF straight to a local origin dir the control
    plane serves, and skip the S3 uploader. Enabled by output.mode=="local" in
    the job config (or LOCAL_MODE=1 in the env). This is the on-box path used by
    the local encoder service; production still mirrors OUT_DIR to S3."""
    out = cfg.get("output") or {}
    if str(out.get("mode", "")).lower() == "local":
        return True
    return os.environ.get("LOCAL_MODE") == "1"


def resolve_out_dir(cfg):
    """Where Shaka writes the packaged CMAF + manifests.

    PER-RUN NAMESPACE (local mode): every run writes to its OWN date-stamped dir,
    <base>/runs/<runId>, and <base>/current_run.txt names the live run. Nothing is ever
    overwritten: previous runs survive as the channel's recordings (uniquely named,
    ordered by runId) and are pruned only by the recording/retention policy in
    manage_runs(). The control plane serves the stable /origin/<id>/live/* URL by
    resolving the pointer, so player and share URLs survive restarts.

    Cloud mode is unchanged (WORK_DIR/out, mirrored to S3 by the uploader)."""
    global BASE_OUT_DIR, RUN_ID
    out = cfg.get("output") or {}
    d = out.get("dir") or os.environ.get("OUTPUT_DIR")
    if is_local(cfg) and d:
        BASE_OUT_DIR = os.path.abspath(d)
        RUN_ID = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        return os.path.join(BASE_OUT_DIR, "runs", RUN_ID)
    return os.path.join(WORK_DIR, "out")


def manage_runs(cfg, base, run_id):
    """Per-run output housekeeping at channel start (local mode only).

    The rules Christian set:
      * NEVER overwrite previous outputs: every run has its own runs/<runId> dir, so
        collisions cannot happen by construction. Previous runs ARE the recordings.
      * Recording ENABLED (a retention is set): keep old runs; prune only the ones
        older than the retention window. Clip/VOD tooling references run paths that
        never change.
      * Recording DISABLED: old runs serve no purpose, clear them out at start.
      * Always: delete a stale _failover_control.json (a leftover forced mode must not
        survive a restart) and MIGRATE any legacy pre-runs layout (root manifests +
        rendition dirs from the old over-the-top scheme, or the interim _prevruns
        archive) into uniquely named runs/legacy-* dirs so they obey the same
        retention rules instead of shadowing or being lost."""
    import shutil
    if not base or not os.path.isdir(base):
        return
    runs_root = os.path.join(base, "runs")
    os.makedirs(runs_root, exist_ok=True)

    # stale forced-failover mode must never survive a restart
    try:
        os.remove(os.path.join(base, "_failover_control.json"))
    except OSError:
        pass

    # ---- migrate the legacy over-the-top layout (one-time) -------------------
    legacy = [n for n in os.listdir(base)
              if n not in ("runs", "_prevruns") and (
                  os.path.isdir(os.path.join(base, n)) and n not in ("thumbs",)
                  or n.endswith((".m3u8", ".mpd", ".m4s", ".mp4", ".ts")))]
    if legacy:
        dest = os.path.join(runs_root, f"legacy-{int(time.time())}")
        os.makedirs(dest, exist_ok=True)
        for n in legacy:
            try:
                shutil.move(os.path.join(base, n), os.path.join(dest, n))
            except OSError:
                pass
        log(f"startup: migrated {len(legacy)} legacy item(s) into {dest}")
    prev = os.path.join(base, "_prevruns")
    if os.path.isdir(prev):
        for n in os.listdir(prev):
            try:
                shutil.move(os.path.join(prev, n), os.path.join(runs_root, f"legacy-{n}"))
            except OSError:
                pass
        shutil.rmtree(prev, ignore_errors=True)

    # ---- retention pruning ---------------------------------------------------
    rec = cfg.get("recording") or {}
    enabled = bool(rec.get("enabled"))
    retention_sec = rec.get("retention_sec")
    now = time.time()
    kept = removed = 0
    for n in sorted(os.listdir(runs_root)):
        if n == run_id:
            continue
        p = os.path.join(runs_root, n)
        try:
            age = now - os.path.getmtime(p)
        except OSError:
            continue
        if not enabled:
            shutil.rmtree(p, ignore_errors=True)
            removed += 1
        elif retention_sec and age > float(retention_sec):
            shutil.rmtree(p, ignore_errors=True)
            removed += 1
        else:
            kept += 1
    log(f"runs: id={run_id} recording={'on' if enabled else 'off'} "
        f"retention={retention_sec or 'none'}s previous kept={kept} pruned={removed}")


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
    required = ["channel_id", "workflow", "segment_seconds", "inputs"]
    if not is_local(cfg):
        required.append("s3")  # S3 destination only required when uploading
    for key in required:
        if key not in cfg:
            die(f"job config missing required field: {key}")
    if cfg["workflow"] not in ("package_only", "transcode"):
        die(f"workflow must be package_only or transcode, got {cfg['workflow']!r}")
    if not cfg["inputs"]:
        die("job config has no inputs")
    if not is_local(cfg) and "bucket" not in cfg["s3"]:
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


def _lang3(code):
    """Normalise a language tag to a 3-letter code Shaka/HLS likes (best effort)."""
    if not code:
        return None
    c = str(code).strip().lower().replace("_", "-").split("-")[0]
    two_to_three = {
        "en": "eng", "ms": "msa", "zh": "zho", "ta": "tam", "hi": "hin",
        "id": "ind", "ar": "ara", "es": "spa", "fr": "fra", "de": "deu",
        "pt": "por", "ja": "jpn", "ko": "kor", "th": "tha", "vi": "vie",
    }
    if len(c) == 2:
        return two_to_three.get(c, c)
    return c or None


def probe_audio_tracks(url):
    """ffprobe the source for its audio streams so the transcoder can carry EACH one
    as its own track in the manifest. Returns a list of {lang, name}; never raises —
    on any failure it falls back to a single unlabelled track so encoding still runs."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a",
             "-show_entries", "stream=index:stream_tags=language,title",
             "-of", "json", "-analyzeduration", "4000000", "-probesize", "4000000", url],
            capture_output=True, text=True, timeout=20,
        )
        streams = (json.loads(out.stdout or "{}").get("streams") or [])
        tracks = []
        for i, s in enumerate(streams):
            tags = s.get("tags") or {}
            lang = _lang3(tags.get("language"))
            name = tags.get("title") or (lang.upper() if lang else f"Audio {i + 1}")
            tracks.append({"lang": lang, "name": name})
        if tracks:
            log(f"audio: probed {len(tracks)} track(s): "
                + ", ".join(t["name"] for t in tracks))
            return tracks
    except Exception as e:  # noqa: BLE001
        log(f"audio: probe failed ({e}); assuming a single track")
    return [{"lang": None, "name": "Audio 1"}]


def audio_tracks(cfg):
    """Memoised audio-track list for the TRANSCODE path (probed from the mezzanine)."""
    cached = cfg.get("_audio_tracks")
    if cached is not None:
        return cached
    src = cfg["inputs"][0]
    tracks = probe_audio_tracks(src["url"])
    cfg["_audio_tracks"] = tracks
    return tracks


def _hls_edge_flags(url, back_sec=12):
    """Choose the ffmpeg flags that make an HLS ingest START AT THE LIVE EDGE.

    There are two kinds of source playlist and they need OPPOSITE handling:
      * A truly-live playlist (no #EXT-X-ENDLIST) -> `-live_start_index -1` begins at the
        newest segment. Correct.
      * A BOUNDED playlist (has #EXT-X-ENDLIST — a Wowza/CloudFront nDVR window, an event
        recording, a catch-up URL) -> ffmpeg treats it as a FILE and `-live_start_index`
        is IGNORED, so it begins at segment 0 and replays the ENTIRE window forward (the
        "day-old content that slowly catches up" bug, confirmed by test). For this case we
        must SEEK to the end with `-sseof -N` (start N seconds before EOF = the live edge).

    So we probe the playlist once for ENDLIST and pick the right flag. On any probe failure
    we fall back to seeking the edge (`-sseof`), which is the safer default for a source we
    already know can be a bounded window."""
    endlist = None
    try:
        import urllib.request
        from urllib.parse import urljoin
        def _get(u):
            req = urllib.request.Request(u, headers={"User-Agent": "volt-encoder/1.0"})
            return urllib.request.urlopen(req, timeout=8).read().decode("utf-8", "ignore")
        txt = _get(url)
        # if this is a MASTER playlist, follow the first variant to reach the media playlist
        if "#EXT-X-STREAM-INF" in txt and "#EXTINF" not in txt:
            lines = txt.splitlines()
            for i, l in enumerate(lines):
                if l.startswith("#EXT-X-STREAM-INF") and i + 1 < len(lines) and lines[i + 1].strip():
                    txt = _get(urljoin(url, lines[i + 1].strip()))
                    break
        endlist = "#EXT-X-ENDLIST" in txt
    except Exception as e:  # noqa: BLE001
        log(f"ingest: HLS edge probe failed ({e}); seeking to the edge to be safe")
    if endlist is False:
        log("ingest: HLS source is live (no ENDLIST) -> start at the newest segment")
        return ["-fflags", "+genpts", "-live_start_index", "-1", "-http_persistent", "0"]
    log(f"ingest: HLS source is a bounded window (ENDLIST={endlist}) -> seek {back_sec}s before the edge")
    return ["-fflags", "+genpts", "-sseof", f"-{back_sec}", "-http_persistent", "0"]


def input_args(inp):
    """Protocol-specific FFmpeg input flags for a contribution feed."""
    proto = inp["protocol"].lower()
    url = inp["url"]
    if proto == "srt":
        return ["-fflags", "+genpts", "-i", url]
    if proto in ("rtmp", "rtmps"):
        return ["-i", url]
    if proto == "hls":
        # START AT THE LIVE EDGE — see _hls_edge_flags for why this must adapt to whether
        # the source playlist is live or a bounded (ENDLIST) DVR window.
        return [*_hls_edge_flags(url), "-i", url]
    die(f"unsupported input protocol: {proto}")


def start_relay(inp, idx):
    """package_only: pull one already-encoded rendition and re-mux to UDP TS.
    No re-encode (-c copy) — cheap, CPU-light, preserves the client's GOPs."""
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-nostdin"]
    cmd += input_args(inp)
    cmd += ["-c", "copy", "-f", "mpegts", udp_out(idx)]
    name = f"relay:{inp.get('rendition_label', idx)}"
    return spawn(name, cmd)


def _fetch_watermark(cfg):
    """Download the watermark/brand image once so ffmpeg can overlay it. Returns a
    local path or None (fetch failure just skips the overlay, never fails the job)."""
    wm = cfg.get("watermark")
    if not wm or not wm.get("url"):
        return None
    dest = os.path.join(WORK_DIR, "watermark.img")
    try:
        import urllib.request
        urllib.request.urlretrieve(wm["url"], dest)
        log(f"watermark: fetched {wm['url']} -> {dest}")
        return dest
    except Exception as e:  # noqa: BLE001
        log(f"watermark: fetch failed ({e}); overlay skipped")
        return None


def prepare_filler_slate(cfg):
    """Resolve the failover filler slate to a real LOCAL file so ffmpeg can ALWAYS open it.

    The control plane sends slate_ref as a library URL (like the watermark). ffmpeg cannot
    loop a bare '/library/..' path or, reliably, an http image with `-loop 1`, so we download
    it once (exactly as we do the watermark) and rewrite the config to the local path. If there
    is no slate, or the download fails, we GENERATE a plain slate locally so the filler never
    dies: a dead filler is what took the whole output down when the primary flapped. Only
    relevant when input failover is on and the loss behaviour uses a slate/loop."""
    red = cfg.get("redundancy") or {}
    if not red.get("input_failover"):
        return
    if red.get("input_loss_behavior", "slate") not in ("slate", "vod_loop"):
        return
    filler = red.get("filler") or {}
    ref = filler.get("slate_ref")
    dest = os.path.join(WORK_DIR, "slate.png")
    resolved = None
    if ref and re.match(r"^https?://", ref, re.I):
        try:
            import urllib.request
            urllib.request.urlretrieve(ref, dest)
            log(f"filler slate: fetched {ref} -> {dest}")
            resolved = dest
        except Exception as e:  # noqa: BLE001
            log(f"filler slate: fetch failed ({e}); generating a plain slate")
    elif ref and os.path.exists(ref):
        resolved = ref  # already a real local file
    elif ref:
        log(f"filler slate: ref '{ref}' is not a URL or an existing file; generating a plain slate")
    if not resolved:
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                 "-f", "lavfi", "-i", "color=c=0x0A0E18:s=1280x720",
                 "-frames:v", "1", dest], check=True)
            log("filler slate: generated a plain fallback slate")
            resolved = dest
        except Exception as e:  # noqa: BLE001
            log(f"filler slate: fallback generation failed ({e}); filler may not start")
    if resolved:
        filler["slate_ref"] = resolved
        red["filler"] = filler
        cfg["redundancy"] = red


def prepare_failover_inputs(inputs):
    """Attach live-edge flags + a realtime-pacing hint to each HLS/HTTP failover input so the
    source-selector's relays (a) start at the LIVE EDGE of the source playlist rather than
    replaying a bounded DVR window from the start, and (b) pace to realtime so their liveness
    signal is smooth (see relay_cmd in source_selector for why this stops health flapping).
    Push protocols (SRT/RTMP) arrive at realtime already and need neither."""
    for inp in inputs:
        proto = (inp.get("protocol") or "").lower()
        if proto in ("hls", "http", "https"):
            try:
                inp["_edge_flags"] = _hls_edge_flags(inp["url"])
            except Exception as e:  # noqa: BLE001
                log(f"failover input: edge-flag probe failed ({e}); using default flags")
            inp["_pace"] = True


def _overlay_vf(scale_h, wm_path, wm):
    """Build the -vf graph: scale the frame, load+size+fade the logo, overlay it at the
    chosen corner/edge with the given pixel offsets. scale = % of the frame HEIGHT."""
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
    wmh = max(1, int(round(scale_h * float(wm.get("scale", 12)) / 100.0)))
    return (f"movie={wm_path},format=rgba,colorchannelmixer=aa={op:.3f},scale=-1:{wmh}[wm];"
            f"[in]scale=-2:{scale_h}[bg];[bg][wm]overlay={xy}")


def start_transcode(cfg, keys_unused, source_override=None):
    """transcode: one mezzanine -> full ladder, aligned closed GOPs, each
    rendition to its own UDP port. GPU (NVENC) if requested, else x264.

    source_override: when input failover is on, read the selector's single chosen-source
    feed (a local UDP mpegts) instead of the raw ingest URL, so a primary/backup/filler
    switch happens upstream of the transcoder."""
    ladder = cfg["ladder"]
    seg = cfg["segment_seconds"]
    src = cfg["inputs"][0]
    gpu = cfg.get("gpu", False)
    fps = cfg.get("fps", 25)
    gop = int(seg * fps)  # closed GOP == segment length so boundaries align
    wm = cfg.get("watermark") if cfg.get("watermark", {}).get("url") else None
    wm_path = _fetch_watermark(cfg) if wm else None
    tracks = audio_tracks(cfg)  # one AAC elementary stream per source audio track

    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-nostdin"]
    if gpu:
        cmd += ["-hwaccel", "cuda"]
    if source_override:
        # WIDE PROBE WINDOW on the selector feed: the UDP bus starts mid-stream and the
        # audio PID can arrive seconds after the video (source burstiness, relay start
        # order). With ffmpeg's default ~5s analyze window the optional audio map
        # (0:a:0?) sometimes probed BEFORE audio appeared and the whole run went out
        # silent. 10s of analysis catches late audio; cost is a slightly slower start.
        cmd += ["-fflags", "+genpts", "-analyzeduration", "10000000", "-probesize", "10000000",
                "-i", source_override]
    else:
        cmd += input_args(src)

    # VIDEO: one video-only rendition per ladder rung (audio is carried separately as
    # its own elementary stream below, so Shaka can assign it as a distinct manifest
    # track — the standard demuxed HLS/DASH shape).
    for i, r in enumerate(ladder):
        vcodec = ["-c:v", "h264_nvenc", "-preset", "p4"] if gpu else \
                 ["-c:v", "libx264", "-preset", "veryfast"]
        cmd += ["-map", "0:v:0"]
        cmd += ["-vf", _overlay_vf(r['height'], wm_path, wm) if wm_path else f"scale=-2:{r['height']}"]
        cmd += vcodec
        cmd += ["-b:v", f"{r['bitrate_kbps']}k",
                "-maxrate", f"{int(r['bitrate_kbps']*1.1)}k",
                "-bufsize", f"{r['bitrate_kbps']*2}k",
                "-g", str(gop), "-keyint_min", str(gop),
                "-sc_threshold", "0",           # closed GOP, no scene-cut
                "-force_key_frames", f"expr:gte(t,n_forced*{seg})",
                "-r", str(fps),
                "-an"]                          # video-only; audio is separate
        cmd += ["-f", "mpegts", udp_out(i)]

    # AUDIO: transcode EACH source audio track to its own AAC MPEG-TS on a dedicated
    # port. Track 0 always exists; extra tracks (multi-language sources) each get one.
    for a, _t in enumerate(tracks):
        cmd += ["-map", f"0:a:{a}?", "-c:a", "aac", "-b:a", "128k", "-ac", "2",
                "-f", "mpegts", udp_out(AUDIO_IDX_BASE + a)]
    # SUPERVISED: a transcoder death (mid-stream TS error, codec hiccup) previously took
    # the whole channel down until a manual restart. Respawned, it rejoins the UDP feed
    # (or re-pulls the source) and the packager continues the same timeline.
    return [spawn_supervised("transcode", cmd)]


# ---------------------------------------------------------------------------
# Shaka Packager: consume the UDP renditions, emit CMAF + HLS + DASH to OUT_DIR.
# ---------------------------------------------------------------------------
def _audio_descriptor(in_url, slot, lang, name, default):
    """A Shaka audio stream descriptor. Each track gets its OWN output dir (audio,
    audio_1, audio_2, …) so multiple tracks never collide, plus language + a display
    name so players show a proper track picker. The first track is the DEFAULT."""
    sub = "audio" if slot == 0 else f"audio_{slot}"
    aseg = f"{OUT_DIR}/{sub}/seg_$Number$.m4s"
    ainit = f"{OUT_DIR}/{sub}/init.mp4"
    parts = [f"in={in_url}", "stream=audio",
             f"init_segment={ainit}", f"segment_template={aseg}",
             "hls_group_id=audio", f"hls_name={name or ('Audio ' + str(slot + 1))}"]
    if lang:
        parts.append(f"language={lang}")
    if default:
        parts.append("dash_roles=main")
    return ",".join(parts)


def build_shaka(cfg, keys):
    seg = cfg["segment_seconds"]
    channel = cfg["channel_id"]
    transcode = cfg["workflow"] != "package_only"
    if not transcode:
        rends = [(i, inp.get("rendition_label", f"r{i}"), inp.get("has_audio", i == 0))
                 for i, inp in enumerate(primary_inputs(cfg))]
    else:
        rends = [(i, f"{r['height']}p", False) for i, r in enumerate(cfg["ladder"])]

    cmd = [PACKAGER_BIN]
    # VIDEO streams (audio for transcode is added separately below; for package_only
    # audio still rides with each input that carries it).
    audio_slot = 0
    for idx, label, has_audio in rends:
        vseg = f"{OUT_DIR}/{label}/seg_$Number$.m4s"
        vinit = f"{OUT_DIR}/{label}/init.mp4"
        cmd.append(
            f"in={udp_out(idx)},stream=video,"
            f"init_segment={vinit},segment_template={vseg}"
        )
        # package_only: keep each source input's audio, but give every track its OWN
        # output dir + language so multiple audio inputs no longer overwrite one another.
        if not transcode and has_audio:
            inp = primary_inputs(cfg)[idx]
            lang = _lang3(inp.get("language") or inp.get("lang"))
            name = inp.get("audio_name") or inp.get("audio_label") or (lang.upper() if lang else None)
            cmd.append(_audio_descriptor(udp_out(idx), audio_slot, lang, name, audio_slot == 0))
            audio_slot += 1

    # transcode: one manifest audio track per source audio stream, from its dedicated port.
    if transcode:
        for a, t in enumerate(audio_tracks(cfg)):
            cmd.append(_audio_descriptor(udp_out(AUDIO_IDX_BASE + a), a, t.get("lang"), t.get("name"), a == 0))

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


_shutting_down = False


def spawn_supervised(name, cmd_or_builder, backoff=3.0):
    """Spawn a child and RESPAWN it whenever it exits unexpectedly (until shutdown).

    Production hardening: a network hiccup kills ffmpeg (an HLS source that 404s for a
    while, a mid-stream TS error in the transcoder, the caption audio puller losing its
    connection) and a dead child previously stayed dead for the rest of the run, which
    read as 'transcription stopped working' / 'the transcode failed' / 'it never
    recovered'. Every long-running child is supervised: on exit it is relaunched after
    `backoff` seconds, forever, unless the encoder is shutting down.

    cmd_or_builder is a list, or a ZERO-ARG CALLABLE rebuilt per respawn (so e.g. the
    caption ingest re-probes the source's live edge instead of reusing stale flags)."""
    def build():
        return cmd_or_builder() if callable(cmd_or_builder) else cmd_or_builder

    state = {"proc": spawn(name, build(), critical=False)}

    def watch():
        while not _shutting_down:
            p = state["proc"]
            if p.poll() is None:
                time.sleep(1.0)
                continue
            if _shutting_down:
                return
            log(f"{name}: exited rc={p.returncode}; respawning in {backoff:.0f}s")
            time.sleep(backoff)
            if _shutting_down:
                return
            try:
                state["proc"] = spawn(name, build(), critical=False)
            except Exception as e:  # noqa: BLE001
                log(f"{name}: respawn failed ({e}); retrying")

    threading.Thread(target=watch, name=f"sup:{name}", daemon=True).start()
    return state


def start_uploader(cfg):
    s3 = cfg["s3"]
    dest = f"s3://{s3['bucket']}/{s3.get('prefix', cfg['channel_id']).rstrip('/')}/"
    cmd = ["/app/bin/s3-uploader.sh", OUT_DIR, dest,
           str(cfg.get("upload_interval_seconds", 2))]
    return spawn("s3-uploader", cmd)


# ---------------------------------------------------------------------------
# Live captions integration.
#
# The captions ENGINE (whisper transcribe + NLLB translate + WebVTT segmentation)
# is built and unit-tested in captions.py. This is the LIVE INTEGRATION: a
# dedicated ffmpeg segments the program audio into fixed chunks; each completed
# chunk is transcribed (+ translated) via the captions adapters; cues are shifted
# to program time; and per-language LIVE WebVTT renditions plus a captions-aware
# companion HLS master (master_cc.m3u8) and DASH manifest (manifest_cc.mpd) are
# written — because Shaka owns and rewrites master.m3u8 / manifest.mpd every
# segment, so we cannot patch those in place. Players that want subtitles load the
# _cc manifest.
#
# ESTIMATED LIVE OFFSET: whisper is not streaming, so each chunk is transcribed as
# a finite clip. The offset needed to keep subs aligned is chunk_seconds + the
# measured transcribe+translate time + a small margin. We measure it per chunk and
# report caption.offset (with realtime=proc<chunk) so the UI shows the real value.
# ---------------------------------------------------------------------------
def _captions_audio_url(cfg):
    """The audio-bearing input to transcribe (has_audio primary, else the first)."""
    ins = primary_inputs(cfg) or cfg["inputs"]
    for i in ins:
        if i.get("has_audio"):
            return i["url"]
    return ins[0]["url"]


def _iso(epoch):
    """EXT-X-PROGRAM-DATE-TIME timestamp (UTC millis)."""
    import datetime
    dt = datetime.datetime.utcfromtimestamp(epoch)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(round((epoch - int(epoch)) * 1000)):03d}Z"


def _atomic_write(path, text):
    """Write a file ATOMICALLY (temp in same dir + rename).

    open(path, 'w') TRUNCATES the file before writing, so anything reading the
    playlist in that window (the control plane serving it, a player fetching)
    receives an EMPTY or PARTIAL playlist — measured live: 69 empty reads in a
    2-minute hammer test. A player that swallows one errors the level, retries,
    and visibly stalls/repeats. os.replace is atomic on POSIX and macOS: readers
    always see either the old complete file or the new complete file."""
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w") as fh:
        fh.write(text)
    os.replace(tmp, path)


def _live_sub_playlist(indices, chunk, media_seq, t0, pdt_map=None):
    """A LIVE WebVTT media playlist (no ENDLIST) with EXT-X-PROGRAM-DATE-TIME on EVERY
    segment so the player aligns the cues to the video by wall-clock.

    Like the video companion, each chunk's PDT comes from its REAL capture time when
    known (pdt_map: chunk index -> wall-clock start, taken from the audio chunk file's
    mtime), not from an assumed-perfect `t0 + i*chunk` clock — an ingest that runs even
    slightly off realtime would otherwise accumulate drift over a session and push the
    cues away from the frames they belong to. Chunks with no measured time continue
    from t0 + i*chunk (start-up placeholder / fallback)."""
    lines = ["#EXTM3U", "#EXT-X-VERSION:7",
             f"#EXT-X-TARGETDURATION:{int(round(chunk))}",
             f"#EXT-X-MEDIA-SEQUENCE:{media_seq}"]
    for i in indices:
        wall = (pdt_map or {}).get(i, t0 + i * chunk)
        lines.append(f"#EXT-X-PROGRAM-DATE-TIME:{_iso(wall)}")
        lines.append(f"#EXTINF:{chunk:.3f},")
        lines.append(f"sub_{i}.vtt")
    return "\n".join(lines) + "\n"


def _mp4_timescale(init_path):
    """Media timescale from an fMP4 init segment's mdhd box (single-track init)."""
    try:
        data = open(init_path, "rb").read(65536)
        i = data.find(b"mdhd")
        if i < 0:
            return None
        ver = data[i + 4]
        off = i + 8 + (16 if ver == 1 else 8)
        ts = int.from_bytes(data[off:off + 4], "big")
        return ts or None
    except OSError:
        return None


def _mp4_tfdt_time(seg_path):
    """baseMediaDecodeTime (media units) from a CMAF segment's tfdt box: the exact
    PTS at which this segment's content starts on the video timeline."""
    try:
        data = open(seg_path, "rb").read(65536)
        i = data.find(b"tfdt")
        if i < 0:
            return None
        ver = data[i + 4]
        if ver == 1:
            return int.from_bytes(data[i + 8:i + 16], "big")
        return int.from_bytes(data[i + 8:i + 12], "big")
    except OSError:
        return None


def _video_pts_of_wall(out_dir, wall, seg_dur):
    """Map a WALL-CLOCK instant onto the video's PTS timeline (seconds).

    Uses the newest video segment as the reference sample: its tfdt gives the PTS its
    content STARTS at, its mtime is the wall-clock its content END was written. So
    pts(wall) = (tfdt/timescale + seg_dur) + (wall - mtime). The reference is re-sampled
    from the newest segment every call, so pacing drift cannot accumulate (same principle
    as the per-segment PDT stamps). Returns None if no segment can be read."""
    try:
        rend = None
        for name in sorted(os.listdir(out_dir)):
            if os.path.isfile(os.path.join(out_dir, name, "init.mp4")):
                rend = os.path.join(out_dir, name)
                break
        if not rend:
            return None
        segs = glob.glob(os.path.join(rend, "seg_*.m4s"))
        if not segs:
            return None
        newest = max(segs, key=os.path.getmtime)
        ts = _mp4_timescale(os.path.join(rend, "init.mp4"))
        base = _mp4_tfdt_time(newest)
        if not ts or base is None:
            return None
        pts_end = base / ts + seg_dur
        return pts_end + (wall - os.path.getmtime(newest))
    except OSError:
        return None


def _write_sub_segment(path, cues, seg_start, seg_end, mpegts=None):
    """One HLS WebVTT segment. Cues are written RELATIVE to the segment start (0..chunk).

    ALIGNMENT (the make-or-break part): players place WebVTT cues via the
    X-TIMESTAMP-MAP header, which must carry the VIDEO's REAL 90kHz PTS for this
    chunk's start. A constant (like MPEGTS:0) maps every chunk's cues to the same
    spot on the timeline, so captions show only while the playhead is near that one
    spot: the 'worked for two chunks then stopped forever' failure. `mpegts` is the
    true PTS in 90kHz units (from _video_pts_of_wall); when unknown the map is
    omitted and players fall back to fragment-anchored placement.

    READABILITY (the anti-stacking rules):
      * a cue lives in EXACTLY ONE segment: the one containing its START. Writing a
        spanning cue into every overlapped segment created near-duplicate copies
        (each mapped through a slightly different measured clock) that STACKED on
        screen. A cue may extend past its segment's end; players handle that.
      * duration is clamped to 1.0..7.0s: whisper emits both blink-length fragments
        (unreadable) and 20s+ run-ons (three lines parked on screen)."""
    from captions import cue_block, Cue
    body = ["WEBVTT"]
    if mpegts is not None:
        body.append(f"X-TIMESTAMP-MAP=MPEGTS:{int(mpegts)},LOCAL:00:00:00.000")
    body.append("")
    mine = sorted((c for c in cues if seg_start <= c.start < seg_end), key=lambda c: c.start)
    for i, c in enumerate(mine):
        dur = min(7.0, max(1.0, c.end - c.start))
        rel_start = max(0.0, c.start - seg_start)
        rel_end = rel_start + dur
        # never overlap the NEXT cue: the minimum-duration clamp could stretch a short
        # cue over its successor, which renders as two lines stacked
        if i + 1 < len(mine):
            nxt = max(0.0, mine[i + 1].start - seg_start)
            if rel_end > nxt > rel_start:
                rel_end = nxt
        rel = Cue(rel_start, rel_end, c.text, c.lang)
        body.append(cue_block(rel))
        body.append("")
    _atomic_write(path, "\n".join(body).rstrip() + "\n")


def _pdt_companion_playlist(text, now, out_dir):
    """Copy a Shaka video media playlist and inject EXT-X-PROGRAM-DATE-TIME so the video
    carries a wall-clock the subtitle track aligns to.

    RELIABILITY: PDT is stamped on EVERY segment, each from that segment file's OWN
    mtime (the real wall-clock when the encoder wrote it) minus its duration. A single
    anchor at the window's first segment, extrapolated forward by the nominal EXTINF,
    accumulates error across the whole window whenever the real wall spacing differs
    from the nominal duration (measured live: ~3.7s wall per 4.0s segment, ~22s of
    error at the live edge of a 300s window) — which silently pushed every subtitle
    cue outside the played region a few minutes into a run. Per-segment stamps from
    real mtimes cannot accumulate anything: the edge is exact, the DVR window is
    exact, and mtimes never change so the timeline never jitters between
    regenerations. A segment that cannot be stat'd continues from the previous stamp
    (spec-compliant: players interpolate between PDT tags)."""
    lines = text.splitlines()
    out = []
    pend = None            # duration parsed from the preceding EXTINF
    prev_start = None      # stamped start of the previous segment (monotonicity floor)
    prev_end = None        # wall-clock end of the previous segment (continuity fallback)
    total_listed = 0.0
    for l in lines:
        if l.startswith("#EXTINF:"):
            try: pend = float(l[len("#EXTINF:"):].split(",")[0])
            except ValueError: pend = None
            out.append(l)
        elif l and not l.startswith("#") and pend is not None:
            dur = pend or 0.0
            try:
                measured = os.path.getmtime(os.path.join(out_dir, l)) - dur
            except OSError:
                measured = prev_end if prev_end is not None else (now - total_listed - dur)
            # JITTER GUARD: mtimes are the long-term anchor, but under CPU
            # contention segment writes land LATE and BUNCH (measured live:
            # 0.9..5.2s spacing for nominal 4.0s segments; a loaded laptop is
            # worse) — raw mtime PDT then jitters or goes BACKWARDS, which
            # players punish with re-fetches, stalls and caption drift. So:
            # within a run, PDT spacing follows EXTINF and each segment pulls
            # HALF of the measured error, converging on the real wall clock
            # (steady-state error is bounded by one pacing delta) without
            # visible jitter; a >1.5s disagreement is a real gap/discontinuity
            # and re-anchors hard. PDT is strictly monotonic: never backwards.
            if prev_start is None:
                start_wall = measured
            else:
                err = measured - prev_end
                if err > 1.5:
                    # segment written well AFTER continuity: a real hole in the
                    # stream (source loss, restart) — re-anchor to the measured
                    # clock so the gap is honest
                    start_wall = measured
                else:
                    # on time, jittered, or BUNCHED (a stream can't start before
                    # the previous segment ended, so a backwards 'measurement' is
                    # always write-contention noise): hold continuity, pull half
                    # the error (clamped) toward the measured clock
                    start_wall = prev_end + 0.5 * max(err, -1.0)
                start_wall = max(start_wall, prev_start + 0.001)
            out.append(f"#EXT-X-PROGRAM-DATE-TIME:{_iso(start_wall)}")
            out.append(l)
            prev_start = start_wall
            prev_end = start_wall + dur
            total_listed += dur
            pend = None
        else:
            out.append(l)
    return "\n".join(out) + "\n"


def _write_companion(out_dir, langs, default_lang, now):
    """Build master_cc.m3u8 that (a) carries the SUBTITLES group and (b) points each
    video variant at a PDT-stamped companion playlist, so the player aligns subs to
    frames by wall-clock. Returns nothing; writes master_cc.m3u8 + *_cc.m3u8."""
    src_path = os.path.join(out_dir, "master.m3u8")
    if not os.path.exists(src_path):
        return
    try:
        src = open(src_path).read().splitlines()
    except OSError:
        return
    # Only advertise a subtitle language once ITS playlist actually exists, so the
    # companion is a valid, smooth video manifest from the first segment (before any
    # captions are produced) and never points the player at a missing subs playlist.
    present = [l for l in langs
               if os.path.exists(os.path.join(out_dir, "subtitles", l, "subs.m3u8"))]
    have_subs = bool(present)
    media = [
        f'#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="{l.upper()}",'
        f'LANGUAGE="{l}",AUTOSELECT=YES,DEFAULT={"YES" if l == default_lang else "NO"},'
        f'URI="subtitles/{l}/subs.m3u8"'
        for l in present
    ]
    out, inserted, expect_uri = [], False, False
    for line in src:
        if line.startswith("#EXT-X-STREAM-INF"):
            if have_subs and not inserted:
                out.extend(media)
                inserted = True
            if have_subs and "SUBTITLES=" not in line:
                line = line + ',SUBTITLES="subs"'
            out.append(line)
            expect_uri = True
            continue
        if expect_uri and line and not line.startswith("#"):
            # this is a video variant playlist URI -> write a PDT-stamped companion
            base = line[:-len(".m3u8")] if line.endswith(".m3u8") else line
            cc_name = f"{base}_cc.m3u8"
            try:
                vtext = open(os.path.join(out_dir, line)).read()
                # SOURCE SANITY: the packager's playlist could itself be caught
                # mid-write; publishing a copy of a truncated source would hand
                # players a broken window for a whole refresh cycle. Skip this
                # cycle (keep the previous good companion) unless it is complete.
                vlines = [x for x in vtext.splitlines() if x.strip()]
                complete = (vlines and vlines[0].startswith("#EXTM3U")
                            and (vlines[-1].startswith("#") or vlines[-1].endswith((".m4s", ".mp4", ".ts"))))
                if complete:
                    _atomic_write(os.path.join(out_dir, cc_name),
                                  _pdt_companion_playlist(vtext, now, out_dir))
                if complete or os.path.exists(os.path.join(out_dir, cc_name)):
                    out.append(cc_name)
                else:
                    out.append(line)
            except OSError:
                out.append(line)  # fall back to the plain playlist if unreadable
            expect_uri = False
            continue
        out.append(line)
    _atomic_write(os.path.join(out_dir, "master_cc.m3u8"), "\n".join(out) + "\n")


def _write_companion_mpd(out_dir, langs, chunk, first_idx):
    """Best-effort: copy Shaka's manifest.mpd and add a text AdaptationSet per language.
    DASH live text alignment likely needs tuning against a real player (flagged)."""
    src_path = os.path.join(out_dir, "manifest.mpd")
    if not os.path.exists(src_path):
        return
    try:
        mpd = open(src_path).read()
    except OSError:
        return
    if "</Period>" not in mpd:
        return
    blocks = []
    for l in langs:
        blocks.append(
            f'<AdaptationSet contentType="text" mimeType="text/vtt" lang="{l}">'
            f'<Representation id="sub_{l}" bandwidth="256">'
            f'<SegmentTemplate media="subtitles/{l}/sub_$Number$.vtt" '
            f'startNumber="{first_idx}" duration="{int(round(chunk))}" timescale="1"/>'
            f'</Representation></AdaptationSet>'
        )
    mpd = mpd.replace("</Period>", "".join(blocks) + "</Period>")
    _atomic_write(os.path.join(out_dir, "manifest_cc.mpd"), mpd)


def _subs_first_idx(out_dir, lang):
    """First subtitle index in the live window (the subs playlist MEDIA-SEQUENCE), used
    as the DASH companion startNumber. 0 if not available yet."""
    try:
        for l in open(os.path.join(out_dir, "subtitles", lang, "subs.m3u8")):
            if l.startswith("#EXT-X-MEDIA-SEQUENCE:"):
                return int(l.split(":", 1)[1])
    except Exception:  # noqa: BLE001
        pass
    return 0


def start_companion_refresher(out_dir, langs, default_lang, chunk, interval=2.0):
    """Regenerate the caption COMPANION manifests on a FAST fixed cadence, DECOUPLED
    from caption production.

    The player watches the companion (master_cc.m3u8 -> stream_*_cc.m3u8) so it can see
    the subtitle group. If the companion only refreshed when a caption chunk finished
    (~8-10s), the companion VIDEO playlist would advance in bursts of 2-3 segments while
    Shaka's real playlist advances every 4s — the player stalls then jumps, which shows
    as a stutter/shiver. Refreshing every ~2s tracks Shaka's live edge so video stays
    smooth, while the PDT and the (existence-gated) subtitle group stay current. This is
    the single owner of the companion manifests; the caption worker only writes the
    subtitle segments + subs.m3u8."""
    def loop():
        while True:
            try:
                if os.path.exists(os.path.join(out_dir, "master.m3u8")):
                    now = time.time()
                    _write_companion(out_dir, langs, default_lang, now)
                    _write_companion_mpd(out_dir, langs, chunk, _subs_first_idx(out_dir, default_lang))
            except Exception as e:  # noqa: BLE001
                log(f"companion refresher error: {e}")
            time.sleep(interval)
    threading.Thread(target=loop, name="companion", daemon=True).start()
    log(f"captions: companion refresher every {interval}s (decoupled from transcribe)")


def start_captions(cfg, out_dir):
    cap = cfg.get("captions")
    if not cap or not cap.get("enabled"):
        return
    seg = float(cfg.get("segment_seconds", 4))
    chunk = float(cap.get("chunk_seconds") or max(8.0, seg * 2))
    targets = cap.get("targets", []) or []
    src_lang = cap.get("source_lang", "auto")
    engine = cap.get("engine") or "whisper"
    offset_cfg = float(cap.get("offset_sec", 0))
    model_size = cap.get("model_size")
    base_lang = src_lang if src_lang and src_lang != "auto" else "en"
    langs = sorted({base_lang, *targets})
    default_lang = "en" if "en" in langs else langs[0]
    sub_root = os.path.join(out_dir, "subtitles")
    for l in langs:
        os.makedirs(os.path.join(sub_root, l), exist_ok=True)
        # Write an EMPTY live subtitle playlist up-front. hls.js loads the master ONCE,
        # so the subtitle track must be advertised from the very first companion write —
        # otherwise a player that connects before the first cue is produced never gets a
        # subtitle track for the whole session. This empty playlist makes the track exist
        # immediately (no 404) and it fills in as cues arrive.
        _atomic_write(os.path.join(sub_root, l, "subs.m3u8"),
                      _live_sub_playlist([], chunk, 0, time.time()))
    tmp = os.path.join(WORK_DIR, "cap_audio")
    os.makedirs(tmp, exist_ok=True)
    audio_url = _captions_audio_url(cfg)

    # continuous audio segmenter: fixed-length mono 16k WAV chunks for whisper. Must start
    # at the LIVE EDGE (same adaptive HLS handling as the video ingest) or captions would
    # transcribe old audio and never line up.
    #
    # PACING (-re) is essential for SYNC on pull sources: without it ffmpeg gulps a whole
    # source segment (10s here) the instant it is published, so wav chunks close in
    # BURSTS and their mtimes (our measured capture clock for the cue timestamp maps)
    # jitter by up to a source segment against the -re paced video path. That was the
    # words-out-of-step-with-speech error. Paced, both pipelines consume the source at
    # 1x and the two capture clocks track each other.
    # command BUILDER so every (re)spawn re-probes the live edge: a respawn hours into a
    # run must join the stream NOW, not where the original probe pointed. The %05d
    # numbering continues from the highest existing chunk via -segment_start_number.
    def aseg():
        pace = ["-re"] if re.match(r"^https?://", audio_url, re.I) else []
        existing = sorted(glob.glob(os.path.join(tmp, "cap_*.wav")))
        nxt = 0
        if existing:
            mo = re.search(r"cap_(\d+)\.wav", existing[-1])
            nxt = (int(mo.group(1)) + 1) if mo else 0
        return ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
                *_hls_edge_flags(audio_url), *pace,
                "-i", audio_url, "-vn", "-ac", "1", "-ar", "16000",
                "-f", "segment", "-segment_time", str(chunk), "-reset_timestamps", "1",
                "-segment_start_number", str(nxt),
                os.path.join(tmp, "cap_%05d.wav")]
    # wall-clock anchor for program time 0 (when the audio segmenter starts reading the
    # live edge). Subtitle segment i -> PDT cap_t0 + i*chunk; the companion video
    # playlists carry a matching wall-clock so the player aligns cues to frames.
    cap_t0 = time.time()
    # SUPERVISED: if the source drops, this ffmpeg dies; unsupervised it stayed dead and
    # 'transcription stopped working for the rest of the run'. Now it rejoins the live
    # edge as soon as the source is back.
    spawn_supervised("caption-audio", aseg)
    log(f"captions: live worker engine={engine} chunk={chunk}s targets={targets} langs={langs}")

    def cap_event(etype, **detail):
        # surface caption lifecycle/errors to the control plane so the UI can show
        # WHY captions are (not) loading — not a roadblock, but worth knowing.
        try:
            if _events:
                _events.event(etype, **detail)
        except Exception:  # noqa: BLE001
            pass

    def worker():
        cap_event("caption.status", state="starting", engine=engine, langs=langs, chunk_sec=chunk)
        try:
            import captions as capmod
        except Exception as e:  # noqa: BLE001
            log(f"captions: engine import failed ({e}); worker not started")
            cap_event("caption.error", stage="import", reason=str(e),
                      hint="install faster-whisper (+ transformers/torch for translation) in the encoder's python")
            return
        # Build the engine ONCE and reuse across chunks (one warm whisper model + one
        # NLLB translator), then just point it at each new audio chunk. Recreating per
        # chunk would reload the models every time and never keep up live.
        reuse = None
        if engine == "whisper":
            try:
                mt = capmod.make_translator(targets, base_lang)
                reuse = capmod.WhisperAdapter("", src_lang, model_size, translator=mt)
                log("captions: whisper model + translator initialised (warming on first chunk)")
            except Exception as e:  # noqa: BLE001
                log(f"captions: engine init failed ({e}); worker not started")
                cap_event("caption.error", stage="init", reason=str(e),
                          hint="whisper/NLLB model failed to load; check the model download + memory")
                return
        seen = set()
        store = {l: [] for l in langs}
        pdts = {}   # chunk idx -> measured wall-clock START (wav mtime - chunk)
        errs = 0
        produced = False
        win = max(3, int(round(float(cfg.get("dvr_seconds", 300)) / chunk)))
        while True:
            try:
                wavs = sorted(glob.glob(os.path.join(tmp, "cap_*.wav")))
                fresh = [w for w in wavs[:-1] if w not in seen]  # [:-1] skips the chunk still being written
                # LIVE CURRENCY GUARANTEE: captions must track the stream, not a queue. If
                # transcription falls behind (slow chunk, CPU contention, heavy translation)
                # the pending list grows, and processing it in order means NEVER catching up:
                # the offset only compounds (observed 50s+ behind, past the player's hold
                # point = captions invisible while burning maximum compute). So when a
                # backlog builds, jump to the NEWEST pending chunk and record the skipped
                # ones as a caption gap. A live viewer loses a few seconds of captions once;
                # they never lose captions permanently.
                if len(fresh) > 2:
                    for w in fresh[:-1]:
                        seen.add(w)
                    log(f"captions: {len(fresh) - 1} chunk(s) behind; skipping to the newest to stay live")
                    cap_event("caption.skip", skipped=len(fresh) - 1)
                    fresh = fresh[-1:]
                for w in fresh:
                    seen.add(w)
                    mo = re.search(r"cap_(\d+)\.wav", w)
                    if not mo:
                        continue
                    idx = int(mo.group(1))
                    base = idx * chunk
                    # measured capture clock: the wav closes when its last audio sample was
                    # read, so mtime - chunk = the REAL wall-clock start of this chunk.
                    # JITTER GUARD (same rule as the video companion PDT): under CPU
                    # contention the wav close lands LATE, so raw mtimes wobble and the
                    # cues drift audibly out of sync on a loaded machine. Consecutive
                    # chunks are CONTIGUOUS by construction, so hold continuity and pull
                    # 25% of the measured error each chunk; a >75%-of-a-chunk
                    # disagreement is a real discontinuity (skip/restart) and re-anchors.
                    try:
                        measured = os.path.getmtime(w) - chunk
                        prev = pdts.get(idx - 1)
                        if prev is None:
                            pdts[idx] = measured
                        else:
                            expected = prev + chunk
                            err = measured - expected
                            if err > chunk * 0.75:
                                pdts[idx] = measured   # real hole: re-anchor honestly
                            else:
                                # late/bunched wav closes are contention noise (audio
                                # is continuous): hold continuity, pull half the error
                                pdts[idx] = expected + 0.5 * max(err, -chunk * 0.25)
                    except OSError:
                        pass
                    t0 = time.time()
                    try:
                        if reuse is not None:
                            reuse.audio_path = w
                            cues = capmod.apply_offset(reuse.transcribe(targets), base + offset_cfg)
                        else:
                            ad = capmod.make_adapter({"engine": engine, "audio_path": w,
                                                      "source_lang": src_lang, "targets": targets,
                                                      "model_size": model_size})
                            cues = capmod.apply_offset(ad.transcribe(targets), base + offset_cfg)
                    except Exception as e:  # noqa: BLE001
                        errs += 1
                        log(f"captions: chunk {idx} transcribe failed: {e}")
                        if errs == 1 or errs % 10 == 0:
                            cap_event("caption.error", stage="transcribe", chunk=idx, reason=str(e), count=errs)
                        continue
                    proc = time.time() - t0
                    if not produced:
                        produced = True
                        cap_event("caption.status", state="producing", langs=langs)
                    est = round(chunk + proc + 1.0, 1)
                    # CUE HYGIENE before storing: drop empties, and merge a cue that
                    # repeats the LAST stored text for its language (whisper repeats
                    # itself across chunk boundaries and on hallucinated silence, which
                    # rendered as the same line stacked twice on screen).
                    fresh_cues = []   # cues NEW this chunk (not merged into an earlier one)
                    for c in cues:
                        text = (c.text or "").strip()
                        if not text:
                            continue
                        lst = store.setdefault(c.lang, [])
                        if lst and lst[-1].text.strip() == text and c.start - lst[-1].end < 1.5:
                            lst[-1].end = max(lst[-1].end, c.end)   # extend, do not duplicate
                            continue
                        lst.append(c)
                        fresh_cues.append(c)
                    first = max(0, idx - win + 1)
                    # true video PTS (90kHz) at this chunk's wall-clock start, so the
                    # timestamp map puts the cues exactly where the matching frames are
                    w0 = pdts.get(idx)
                    pts = _video_pts_of_wall(out_dir, w0, seg) if w0 is not None else None
                    mpegts = int(round(pts * 90000)) if pts is not None and pts >= 0 else None
                    # SEARCHABLE TRANSCRIPT: append this chunk's cues to a durable
                    # per-run index with MEASURED wall-clock times (chunk wall start +
                    # cue offset within the chunk). The VTT playlist window slides and
                    # its PDT map lives in memory, so this file is what search reads to
                    # answer "when was X said" over a recording, long after the run.
                    if fresh_cues:
                        t_ref = (w0 - base) if w0 is not None else cap_t0
                        try:
                            with open(os.path.join(out_dir, "transcript.jsonl"), "a", encoding="utf-8") as tf:
                                for c in fresh_cues:
                                    tf.write(json.dumps({
                                        "lang": c.lang,
                                        "start_ms": int(round((t_ref + c.start) * 1000)),
                                        "end_ms": int(round((t_ref + c.end) * 1000)),
                                        "text": (c.text or "").strip(),
                                    }, ensure_ascii=False) + "\n")
                        except OSError:
                            pass
                    for l in langs:
                        _write_sub_segment(os.path.join(sub_root, l, f"sub_{idx}.vtt"),
                                           store.get(l, []), base, base + chunk, mpegts=mpegts)
                        # per-chunk PDT from measured capture times (cap_t0 clock is
                        # only the fallback for chunks with no measurement).
                        _atomic_write(os.path.join(sub_root, l, "subs.m3u8"),
                                      _live_sub_playlist(range(first, idx + 1), chunk, first, cap_t0, pdt_map=pdts))
                    # NOTE: the companion manifests are refreshed by the decoupled
                    # companion thread (fast, fixed cadence) — NOT here — so video stays
                    # smooth regardless of transcribe timing.
                    # TRACEABILITY: every chunk's full alignment story in one event/log
                    # line: WHICH chunk, the WALL-CLOCK window its audio covers, and the
                    # VIDEO PTS its cues are pinned to in the manifest. This is the
                    # answer to 'do we know which frames these words belong to'.
                    wall_iso = _iso(w0) if w0 is not None else None
                    pts_sec = round(pts, 2) if pts is not None else None
                    log(f"captions: chunk {idx} audio@{wall_iso or '?'} -> video PTS "
                        f"{pts_sec if pts_sec is not None else 'unmapped'}s proc={proc:.1f}s")
                    if _events:
                        _events.event("caption.offset", est_offset_sec=est, proc_sec=round(proc, 1),
                                      chunk_sec=chunk, realtime=bool(proc < chunk), langs=langs,
                                      chunk=idx, wall_start=wall_iso, video_pts_sec=pts_sec,
                                      # per-chunk detected spoken language (auto mode), so the
                                      # console can show what the AI heard when it changes
                                      detected=getattr(reuse, "_last_lang", None))
            except Exception as e:  # noqa: BLE001
                log(f"captions worker error: {e}")
            time.sleep(1)

    threading.Thread(target=worker, name="captions", daemon=True).start()
    # Fast, decoupled companion regeneration so the player's video stays smooth.
    start_companion_refresher(out_dir, langs, default_lang, chunk)


def shutdown(*_):
    global _shutting_down
    _shutting_down = True   # stop every supervisor from respawning
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

    global _events, OUT_DIR
    cfg = load_config()
    OUT_DIR = resolve_out_dir(cfg)
    os.makedirs(OUT_DIR, exist_ok=True)
    if BASE_OUT_DIR:
        # per-run namespace: housekeep old runs per the recording/retention policy,
        # then point /origin/<id>/live/* at THIS run before anything is served.
        manage_runs(cfg, BASE_OUT_DIR, RUN_ID)
        with open(os.path.join(BASE_OUT_DIR, "current_run.txt"), "w") as fh:
            fh.write(RUN_ID)
    nrend = len(primary_inputs(cfg)) if cfg["workflow"] == "package_only" \
        else len(cfg.get("ladder", []))
    log(f"channel={cfg['channel_id']} workflow={cfg['workflow']} "
        f"renditions={nrend} out={OUT_DIR} local={is_local(cfg)}")

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

    # Failover prep (no-op unless input_failover is on): make sure the filler slate is a
    # real local file so the filler can never fail to open it.
    prepare_filler_slate(cfg)

    selector = None
    if cfg["workflow"] == "package_only":
        if redundancy_on(cfg):
            # The source-selector owns the bus ports Shaka reads: it runs the
            # primary + backup relays and the filler, and forwards the active
            # group to the bus with health-driven failover + filler-on-loss.
            prim, bak = primary_inputs(cfg), backup_inputs(cfg)
            prepare_failover_inputs(prim + bak)
            selector = source_selector.SourceSelector(
                cfg, ladder=ladder_from_inputs(prim),
                primary=prim, backup=bak,
                spawn=lambda name, cmd: spawn(name, cmd, critical=False),
                log=log, work_dir=WORK_DIR, event_log=_events,
                # the control plane writes the failover-test file at the channel ROOT
                # (stable across runs), not inside the per-run output dir
                control_dir=BASE_OUT_DIR or OUT_DIR)
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
            # TRANSCODE FAILOVER (single-source): the selector chooses ONE active source
            # (primary / backup / filler) and forwards it to SOURCE_FEED_PORT; the
            # transcoder reads that instead of the raw URL, so a source switch happens
            # UPSTREAM of the encoder and the ladder it produces stays continuous.
            prim, bak = primary_inputs(cfg), backup_inputs(cfg)
            prepare_failover_inputs(prim[:1] + bak[:1])
            top = (cfg.get("ladder") or [{"height": 720, "bitrate_kbps": 4000}])[0]
            selector = source_selector.SourceSelector(
                cfg, ladder=[{"height": top["height"], "bitrate_kbps": top["bitrate_kbps"]}],
                primary=prim[:1], backup=bak[:1],
                spawn=lambda name, cmd: spawn(name, cmd, critical=False),
                log=log, work_dir=WORK_DIR, event_log=_events,
                control_dir=BASE_OUT_DIR or OUT_DIR,   # channel root: stable across runs
                bus_base=source_selector.SOURCE_FEED_PORT)
            _selectors.append(selector)
            log(f"redundancy: transcode input_failover on — primary + {len(bak)} backup, "
                f"loss_behavior={cfg['redundancy'].get('input_loss_behavior','slate')}")
            selector.start()
            feed = f"udp://127.0.0.1:{source_selector.SOURCE_FEED_PORT}?reuse=1&buffer_size=2097152"
            start_transcode(cfg, keys, source_override=feed)
            # NOTE: on the failover path the selector's health loop owns the source up/down
            # events. Do NOT emit a static 'primary up' here — it would contradict the real
            # health signal (claiming primary is up while the selector has failed over).
        else:
            start_transcode(cfg, keys)
            # no health monitor on the direct path; assume primary feeding on start
            _events.source_state("primary", True, renditions=nrend)

    if is_local(cfg):
        log(f"local mode: writing directly to {OUT_DIR}; S3 uploader skipped")
    else:
        start_uploader(cfg)

    # Live captions/translation sidecar (gated on cfg.captions.enabled). Non-critical:
    # a caption failure must never tear the channel down.
    try:
        start_captions(cfg, OUT_DIR)
    except Exception as e:  # noqa: BLE001
        log(f"captions: failed to start ({e}); continuing without captions")

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
