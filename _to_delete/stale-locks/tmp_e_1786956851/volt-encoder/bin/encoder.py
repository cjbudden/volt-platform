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
    """Where Shaka writes the packaged CMAF + manifests. In local mode this is
    the origin directory the control plane exposes at /origin/<channel>; the
    directory IS the live edge + DVR + recording (no S3 hop)."""
    out = cfg.get("output") or {}
    d = out.get("dir") or os.environ.get("OUTPUT_DIR")
    if is_local(cfg) and d:
        return os.path.abspath(d)
    return os.path.join(WORK_DIR, "out")


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


def input_args(inp):
    """Protocol-specific FFmpeg input flags for a contribution feed."""
    proto = inp["protocol"].lower()
    url = inp["url"]
    if proto == "srt":
        return ["-fflags", "+genpts", "-i", url]
    if proto in ("rtmp", "rtmps"):
        return ["-i", url]
    if proto == "hls":
        # START AT THE LIVE EDGE. Without this, ffmpeg opens the source playlist at
        # the OLDEST segment in its window (or segment 0), so everything we package
        # is minutes behind real time and every restart resumes from that same old
        # point. -live_start_index -1 tells the HLS demuxer to begin at the newest
        # segment, so the packaged output tracks the true live edge and a restart
        # re-acquires live rather than replaying old content.
        #   http_persistent 0 avoids a stale keep-alive connection re-serving an old
        #   playlist view; +genpts keeps timestamps monotonic for the -c copy relay.
        # NOTE: we deliberately do NOT use -re here — the source playlist is already
        # live-paced; -re would pin playback to whatever (old) segment we opened at.
        return [
            "-fflags", "+genpts",
            "-live_start_index", "-1",
            "-http_persistent", "0",
            "-i", url,
        ]
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


def start_transcode(cfg, keys_unused):
    """transcode: one mezzanine -> full ladder, aligned closed GOPs, each
    rendition to its own UDP port. GPU (NVENC) if requested, else x264."""
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
    return [spawn("transcode", cmd)]


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


def _live_sub_playlist(indices, chunk, media_seq, first_pdt_wall):
    """A LIVE WebVTT media playlist (no ENDLIST) with EXT-X-PROGRAM-DATE-TIME so the
    player aligns the cues to the video by wall-clock (same clock the companion video
    playlists carry)."""
    lines = ["#EXTM3U", "#EXT-X-VERSION:7",
             f"#EXT-X-TARGETDURATION:{int(round(chunk))}",
             f"#EXT-X-MEDIA-SEQUENCE:{media_seq}",
             f"#EXT-X-PROGRAM-DATE-TIME:{_iso(first_pdt_wall)}"]
    for i in indices:
        lines.append(f"#EXTINF:{chunk:.3f},")
        lines.append(f"sub_{i}.vtt")
    return "\n".join(lines) + "\n"


def _write_sub_segment(path, cues, seg_start, seg_end):
    """One HLS WebVTT segment. Cues are written RELATIVE to the segment start (0..chunk)
    and LOCAL:0 in the timestamp map, so with the playlist's PROGRAM-DATE-TIME the player
    places each fragment by date and the cue offset within it."""
    from captions import cue_block, Cue
    body = ["WEBVTT", "X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000", ""]
    for c in cues:
        if c.end > seg_start and c.start < seg_end:
            rel = Cue(max(0.0, c.start - seg_start), max(0.0, c.end - seg_start), c.text, c.lang)
            body.append(cue_block(rel))
            body.append("")
    with open(path, "w") as fh:
        fh.write("\n".join(body).rstrip() + "\n")


def _pdt_companion_playlist(text, now, out_dir):
    """Copy a Shaka video media playlist and inject EXT-X-PROGRAM-DATE-TIME so the video
    carries a wall-clock the subtitle track aligns to.

    RELIABILITY: the PDT must be a STABLE, real content timestamp — not an estimate.
    We anchor the FIRST segment's PDT to that segment file's mtime (when the encoder
    actually wrote it, i.e. the real wall-clock of that content), minus its duration to
    get the segment START. mtime never changes once written, so the timeline does not
    jitter between regenerations, and it reflects the SAME real clock the subtitle
    segments use (both produced live on this box) — so cues line up with frames. If the
    file cannot be stat'd we fall back to the old now - total estimate."""
    lines = text.splitlines()
    first_uri, first_dur, pend = None, 0.0, None
    for l in lines:
        if l.startswith("#EXTINF:"):
            try: pend = float(l[len("#EXTINF:"):].split(",")[0])
            except ValueError: pend = None
        elif l and not l.startswith("#"):
            first_uri, first_dur = l, (pend or 0.0)
            break
    start_wall = None
    if first_uri:
        try:
            start_wall = os.path.getmtime(os.path.join(out_dir, first_uri)) - first_dur
        except OSError:
            start_wall = None
    if start_wall is None:
        total = 0.0
        for l in lines:
            if l.startswith("#EXTINF:"):
                try: total += float(l[len("#EXTINF:"):].split(",")[0])
                except ValueError: pass
        start_wall = now - total
    out, stamped = [], False
    for l in lines:
        if (not stamped) and l.startswith("#EXTINF:"):
            out.append(f"#EXT-X-PROGRAM-DATE-TIME:{_iso(start_wall)}")
            stamped = True
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
                with open(os.path.join(out_dir, cc_name), "w") as fh:
                    fh.write(_pdt_companion_playlist(vtext, now, out_dir))
                out.append(cc_name)
            except OSError:
                out.append(line)  # fall back to the plain playlist if unreadable
            expect_uri = False
            continue
        out.append(line)
    with open(os.path.join(out_dir, "master_cc.m3u8"), "w") as fh:
        fh.write("\n".join(out) + "\n")


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
    with open(os.path.join(out_dir, "manifest_cc.mpd"), "w") as fh:
        fh.write(mpd)


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
    tmp = os.path.join(WORK_DIR, "cap_audio")
    os.makedirs(tmp, exist_ok=True)
    audio_url = _captions_audio_url(cfg)

    # continuous audio segmenter: fixed-length mono 16k WAV chunks for whisper
    aseg = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
            "-fflags", "+genpts", "-live_start_index", "-1", "-http_persistent", "0",
            "-i", audio_url, "-vn", "-ac", "1", "-ar", "16000",
            "-f", "segment", "-segment_time", str(chunk), "-reset_timestamps", "1",
            os.path.join(tmp, "cap_%05d.wav")]
    # wall-clock anchor for program time 0 (when the audio segmenter starts reading the
    # live edge). Subtitle segment i -> PDT cap_t0 + i*chunk; the companion video
    # playlists carry a matching wall-clock so the player aligns cues to frames.
    cap_t0 = time.time()
    spawn("caption-audio", aseg, critical=False)
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
        errs = 0
        produced = False
        win = max(3, int(round(float(cfg.get("dvr_seconds", 300)) / chunk)))
        while True:
            try:
                wavs = sorted(glob.glob(os.path.join(tmp, "cap_*.wav")))
                for w in wavs[:-1]:  # skip the chunk still being written
                    if w in seen:
                        continue
                    seen.add(w)
                    mo = re.search(r"cap_(\d+)\.wav", w)
                    if not mo:
                        continue
                    idx = int(mo.group(1))
                    base = idx * chunk
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
                    for c in cues:
                        store.setdefault(c.lang, []).append(c)
                    first = max(0, idx - win + 1)
                    for l in langs:
                        _write_sub_segment(os.path.join(sub_root, l, f"sub_{idx}.vtt"),
                                           store.get(l, []), base, base + chunk)
                        with open(os.path.join(sub_root, l, "subs.m3u8"), "w") as fh:
                            # PDT anchor for the first segment in the window = program time
                            # first*chunk after the caption clock started.
                            fh.write(_live_sub_playlist(range(first, idx + 1), chunk, first, cap_t0 + first * chunk))
                    # NOTE: the companion manifests are refreshed by the decoupled
                    # companion thread (fast, fixed cadence) — NOT here — so video stays
                    # smooth regardless of transcribe timing.
                    if _events:
                        _events.event("caption.offset", est_offset_sec=est, proc_sec=round(proc, 1),
                                      chunk_sec=chunk, realtime=bool(proc < chunk), langs=langs)
            except Exception as e:  # noqa: BLE001
                log(f"captions worker error: {e}")
            time.sleep(1)

    threading.Thread(target=worker, name="captions", daemon=True).start()
    # Fast, decoupled companion regeneration so the player's video stays smooth.
    start_companion_refresher(out_dir, langs, default_lang, chunk)


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

    global _events, OUT_DIR
    cfg = load_config()
    OUT_DIR = resolve_out_dir(cfg)
    os.makedirs(OUT_DIR, exist_ok=True)
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
