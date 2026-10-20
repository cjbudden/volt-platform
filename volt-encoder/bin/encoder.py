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
import shutil
import threading
import time

import source_selector
import stream_metrics
import ingest_args
from ladder_args import gop_for, video_rung_args, audio_track_args
from packager_log import PackagerLogFilter, resolve_mode as resolve_packager_log_mode
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
# HEALTH ENDPOINT state (health_server.py): the supervisor loop's last turn,
# the latest metrics sample and when this encoder started. HEALTH_PORT turns
# the endpoint on (off by default, so a local run opens no port).
_health = {"loop_beat": None, "metrics": None, "started_at": time.time()}


def _newest_segment_age(out_dir):
    """Seconds since the newest .m4s/.ts under out_dir (one level of rendition dirs)."""
    newest = None
    try:
        with os.scandir(out_dir) as top:
            for d in top:
                if not d.is_dir():
                    continue
                with os.scandir(d.path) as inner:
                    for f in inner:
                        if f.name.endswith((".m4s", ".ts", ".mp4")) and not f.name.startswith("init"):
                            m = f.stat().st_mtime
                            newest = m if newest is None or m > newest else newest
    except OSError:
        return None
    return None if newest is None else max(0.0, time.time() - newest)


def health_snapshot(cfg):
    """What /healthz, /readyz, /metrics and /status read. Never raises on a missing piece."""
    status = dict(_events.status) if _events is not None else {}
    return {
        "stream_id": cfg.get("stream_id") or cfg.get("channel_id"),
        "loop_beat": _health["loop_beat"],
        "started_at": _health["started_at"],
        "segment_seconds": cfg.get("segment_seconds") or 4,
        "segment_age_s": _newest_segment_age(OUT_DIR),
        "children": [(n, p.poll() is None, c) for n, p, c in list(_children)],
        "status": status,
        "metrics": _health["metrics"] or status.get("metrics"),
    }
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
    # ONLY real legacy output moves: rendition dirs (they hold an init.mp4), the old
    # subtitles dir, and root manifests/segments. "Any directory" used to match, so the
    # channel's own working dirs at the root (cap_audio, the pre-built filler/ the
    # control plane writes for the playout splice) were swept into a fake legacy run on
    # every start: the pre-built loop vanished and every restart left a junk run behind.
    def _legacy_dir(n):
        d = os.path.join(base, n)
        return os.path.isdir(d) and (os.path.exists(os.path.join(d, "init.mp4")) or n == "subtitles")
    legacy = [n for n in os.listdir(base)
              if n not in ("runs", "_prevruns", "thumbs", "filler", "cap_audio") and (
                  _legacy_dir(n) or (os.path.isfile(os.path.join(base, n))
                                     and n.endswith((".m3u8", ".mpd", ".m4s", ".mp4", ".ts"))))]
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
def resolve_drm_auth(drm):
    """The SPEKE credential for this job, never written into the job itself.

    The control plane sends `auth_ref` (a Secrets Manager ARN, read with the
    task role) and `tenant_id`; Axinom's Basic credential is
    "<tenant_id>:<management key>". Until 20 Oct 2026 the encoder read only
    `drm.auth`, which the control plane never sends, so every SPEKE request
    in production went out unauthenticated. `env:NAME` reads a variable
    (local runs); a literal `auth` still wins for tests and old jobs.
    """
    if drm.get("auth"):
        return drm["auth"]
    ref = drm.get("auth_ref") or ""
    secret = ""
    if ref.startswith("env:"):
        secret = os.environ.get(ref[4:], "")
    elif ref.startswith("arn:aws:secretsmanager:"):
        # "<arn>#<field>" picks one field of a JSON secret (the shared
        # integrations secret holds several credentials).
        arn, _, field = ref.partition("#")
        try:
            secret = subprocess.check_output(
                ["aws", "secretsmanager", "get-secret-value", "--secret-id", arn,
                 "--query", "SecretString", "--output", "text"], timeout=20).decode().strip()
            if field:
                secret = str(json.loads(secret).get(field) or "")
        except Exception as exc:  # noqa: BLE001
            die(f"could not read the DRM key service credential {arn}: {exc}")
    elif ref:
        die(f"unsupported DRM auth_ref {ref!r}: use a Secrets Manager ARN or env:NAME")
    if not secret:
        return ""
    tenant = drm.get("tenant_id")
    return f"{tenant}:{secret}" if tenant and ":" not in secret else secret


def fetch_drm_keys(drm):
    if not drm or drm.get("mode", "none") == "none":
        return None
    log(f"fetching DRM keys from SPEKE server for content_id={drm.get('content_id')}")
    args = [
        sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "speke_client.py"),
        "--url", drm["speke_url"],
        "--content-id", drm["content_id"],
        "--systems", ",".join(drm.get("systems") or ["widevine", "playready", "fairplay"]),
    ]
    # The credential travels in the environment, not argv (which every
    # process on the host can read).
    env = dict(os.environ, SPEKE_AUTH=resolve_drm_auth(drm))
    try:
        out = subprocess.check_output(args, timeout=30, env=env)
    except subprocess.CalledProcessError as exc:
        die(f"SPEKE key request failed: {exc}")
    except subprocess.TimeoutExpired:
        die("SPEKE key request timed out")
    keys = json.loads(out)
    log(f"received {len(keys.get('keys', []))} content key(s) from SPEKE"
        + (f", FairPlay key URI {keys['hls_key_uri']}" if keys.get("hls_key_uri") else ""))
    return keys


def shaka_drm_flags(keys):
    """Translate SPEKE key material into Shaka raw-key cbcs flags.

    FairPlay end to end (20 Oct 2026): --protection_systems names the systems
    (with FairPlay in it Shaka writes the SAMPLE-AES EXT-X-KEY with
    KEYFORMAT="com.apple.streamingkeydelivery"), --hls_key_uri is the skd://
    URI from the key server, --iv the server's explicit IV, and every PSSH box
    it returned goes to --pssh. Checked against a real Shaka in
    dev/test_fairplay_drm.py: playlists, cbcs init segments, and a decrypt
    back to frames.
    """
    if not keys:
        return []
    # --clear_lead: Shaka leaves the first 5 seconds in the clear by default,
    # and writes no key tag until the first encrypted segment, so the start of
    # every run (and of every recording cut from it) was unprotected. 0 unless
    # DRM_CLEAR_LEAD says otherwise.
    flags = ["--enable_raw_key_encryption", "--protection_scheme", "cbcs",
             "--clear_lead", os.environ.get("DRM_CLEAR_LEAD", "0")]
    for k in keys["keys"]:
        parts = [f"label={k.get('label', '')}",
                 f"key_id={k['key_id']}",
                 f"key={k['key']}"]
        flags += ["--keys", ":".join(parts)]
    ivs = {k["iv"] for k in keys["keys"] if k.get("iv")}
    if len(ivs) == 1:
        flags += ["--iv", ivs.pop()]
    pssh_hex = keys.get("pssh_hex") or "".join((keys.get("pssh") or {}).values())
    if pssh_hex:
        flags += ["--pssh", pssh_hex]
    if keys.get("protection_systems"):
        flags += ["--protection_systems", keys["protection_systems"]]
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
            # START-UP COST: this probe is serial, ahead of the packager and the
            # transcoder, so its window is real dead air at channel start. Against a
            # single resolved variant (see resolve_hls_variant) a 2s analyse window is
            # plenty to see the audio streams; it only needed to be wide when the URL
            # was a master and ffmpeg was opening every rendition at once.
            ["ffprobe", "-v", "error", "-select_streams", "a",
             "-show_entries", "stream=index:stream_tags=language,title",
             "-of", "json", "-analyzeduration", "2000000", "-probesize", "2000000", url],
            capture_output=True, text=True, timeout=12,
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
    # probe the RESOLVED single variant, not the master: probing a master returns one
    # audio stream per variant, which used to become one duplicate manifest audio track
    # per variant (six identical English tracks on the test source).
    tracks = probe_audio_tracks(input_url(src))
    cfg["_audio_tracks"] = tracks
    return tracks


def _http_get(u, timeout=8):
    import urllib.request
    req = urllib.request.Request(u, headers={"User-Agent": "volt-encoder/1.0"})
    return urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8", "ignore")


_VARIANT_CACHE = {}


def parse_master(text):
    """[{uri, bandwidth, width, height}] from an HLS master playlist body."""
    out = []
    lines = text.splitlines()
    for i, l in enumerate(lines):
        if not l.startswith("#EXT-X-STREAM-INF"):
            continue
        attrs = l.split(":", 1)[1] if ":" in l else ""

        def _a(name):
            mo = re.search(name + r'=("[^"]*"|[^,]*)', attrs)
            return mo.group(1).strip('"') if mo else None

        res = _a("RESOLUTION") or ""
        w = h = None
        if "x" in res.lower():
            try:
                w, h = (int(x) for x in res.lower().split("x")[:2])
            except ValueError:
                w = h = None
        uri = next((x.strip() for x in lines[i + 1:i + 3] if x.strip() and not x.startswith("#")), None)
        if uri:
            try:
                bw = int(_a("BANDWIDTH") or 0)
            except ValueError:
                bw = 0
            out.append({"uri": uri, "bandwidth": bw, "width": w, "height": h})
    return out


def resolve_hls_variant(url, want=None):
    """If `url` is an HLS MASTER playlist, resolve it to the ONE variant media playlist
    we should ingest. Anything else is returned unchanged.

    This is not a nicety, it is a correctness fix. Pointed at a master, ffmpeg exposes
    every variant as its own program and OPENS ALL OF THEM, and two things go wrong at
    once:

      * `-map 0:v:0` takes the FIRST video stream in the file, which is the LOWEST rung
        (192x108 on the unified-streaming test source). The whole output ladder was
        being upscaled from a thumbnail while the 1080p rung sat there unused.
      * every variant carries its own audio, so every one of them became a manifest
        audio track (six identical English tracks on the test source), and every one of
        them was downloaded: that is where the "Invalid timestamps" / "Packet corrupt" /
        "Stream ends prematurely" spam and a large part of the slow start came from.

    Resolving to a single media playlist fixes all of that and cuts source bandwidth to
    the one rendition we actually decode.

    `want`: None or "highest" (default) takes the largest resolution then bitrate;
    "lowest" the smallest; a height ("720" / "720p") picks that rung if present.
    """
    if not re.match(r"^https?://", url or "", re.I):
        return url
    key = (url, want)
    if key in _VARIANT_CACHE:
        return _VARIANT_CACHE[key]
    resolved = url
    try:
        txt = _http_get(url)
        if "#EXT-X-STREAM-INF" in txt and "#EXTINF" not in txt:
            from urllib.parse import urljoin
            variants = parse_master(txt)
            # audio-only renditions carry no RESOLUTION; never pick one as the mezzanine
            vids = [v for v in variants if v["height"]] or variants
            pick = None
            if want and str(want).lower() not in ("highest", "best", "auto"):
                if str(want).lower() in ("lowest", "worst"):
                    pick = min(vids, key=lambda v: (v["height"] or 0, v["bandwidth"]))
                else:
                    mo = re.match(r"(\d+)", str(want))
                    if mo:
                        exact = [v for v in vids if v["height"] == int(mo.group(1))]
                        pick = exact[0] if exact else None
            if pick is None:
                pick = max(vids, key=lambda v: (v["height"] or 0, v["bandwidth"]))
            resolved = urljoin(url, pick["uri"])
            log(f"ingest: master playlist with {len(variants)} variant(s) -> using "
                f"{pick['width']}x{pick['height']} @ {pick['bandwidth'] // 1000}kbps "
                f"(one variant only)")
    except Exception as e:  # noqa: BLE001
        log(f"ingest: variant resolve failed ({e}); using the URL as given")
    _VARIANT_CACHE[key] = resolved
    return resolved


def input_url(inp):
    """The URL to actually open for a contribution input. HLS masters resolve to a single
    variant (see resolve_hls_variant); everything else passes through."""
    url = inp["url"]
    if (inp.get("protocol") or "").lower() in ("hls", "http", "https"):
        url = resolve_hls_variant(url, inp.get("variant"))
    return url


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
        return ["-fflags", "+genpts", "-live_start_index", "-1", *_http_resilience_flags()]
    log(f"ingest: HLS source is a bounded window (ENDLIST={endlist}) -> seek {back_sec}s before the edge")
    return ["-fflags", "+genpts", "-sseof", f"-{back_sec}", *_http_resilience_flags()]


def _http_resilience_flags():
    """Keep an HTTP/HLS ingest intact while the box is busy encoding.

    THE FAILURE THIS FIXES, measured: run the ladder on a box with no spare CPU and the
    ingest starts logging "Stream ends prematurely at N, should be M" followed by runs of
    "Error submitting packet to decoder: Invalid data found". Those are TRUNCATED SEGMENT
    DOWNLOADS. ffmpeg demuxes and encodes in one pipeline, so while x264 is working
    nothing is draining the HTTP socket; the connection goes idle, the far end or an
    intermediary closes it, and the rest of that segment is simply lost. It is silent:
    no error is fatal, the run continues, and the damage only shows up downstream as
    audio that is shorter than its own timeline says. On a 480s test run 71 of 116
    delivered audio segments were short and 9% of the audio was missing outright, which
    is both an audible dropout for the viewer and missing words for the recogniser.

    The three flags, and what each one does about it:
      * thread_queue_size — the demuxer runs on its own thread and can read ahead;
        the default queue is a handful of packets, which is no buffer at all against an
        encoder that stalls it for hundreds of milliseconds. This is the one that stops
        the socket going idle in the first place.
      * reconnect / reconnect_streamed / reconnect_on_network_error — when a fetch does
        get cut short, resume it instead of discarding the remainder of the segment.
      * http_persistent — reuse the connection between segment fetches rather than
        opening a new TLS session for every one.

    Verified: the same 110s transcode went from 73 ingest errors and 9% of the audio
    missing to ZERO errors and complete audio."""
    return [
        "-http_persistent", "1",
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_on_network_error", "1",
        "-reconnect_delay_max", "4",
        "-thread_queue_size", os.environ.get("INGEST_QUEUE", "4096"),
    ]


def input_args(inp):
    """Protocol-specific FFmpeg input flags for a contribution feed."""
    proto = inp["protocol"].lower()
    url = input_url(inp)
    # a read-ahead queue on the demux thread benefits every protocol: it stops a busy
    # encoder from starving the reader (see _http_resilience_flags)
    q = ["-thread_queue_size", os.environ.get("INGEST_QUEUE", "4096")]
    if proto == "hls":
        # START AT THE LIVE EDGE — see _hls_edge_flags for why this must adapt to whether
        # the source playlist is live or a bounded (ENDLIST) DVR window.
        return [*_hls_edge_flags(url), "-i", url]
    # SRT / RTMP / DASH / NDI / ST 2110, with the console's per-protocol settings
    # (ingest_args.py). A source this node cannot open stops the job with the reason.
    try:
        return ingest_args.open_args({**inp, "url": url}, WORK_DIR, q, idx=inp.get("_idx", 0), env=os.environ)
    except (ValueError, RuntimeError) as e:
        die(f"input {inp.get('rendition_label') or inp.get('role', 'primary')} ({proto}): {e}")


# INGEST METER (stream_metrics.py): every relay that writes an ffmpeg -progress
# file is listed here as (key, role, label, path); the heartbeat reads how many
# bytes each has received. The key is "<role>:<rendition label>", which is how
# the console matches it to the channel's input.
_ingest_inputs = []


def _ingest_key(inp, idx):
    return f"{inp.get('role', 'primary')}:{inp.get('rendition_label') or idx}"


def _segment_hints(cfg, inputs):
    """An encoded packaging rendition (NDI / ST 2110) needs the segment length
    and frame rate for its GOP; the relays only see their input."""
    for inp in inputs:
        inp["_seg"] = cfg.get("segment_seconds", 4)
        inp["_fps"] = cfg.get("fps", 25)


def start_relay(inp, idx):
    """package_only: pull one already-encoded rendition and re-mux to UDP TS.
    No re-encode (-c copy) — cheap, CPU-light, preserves the client's GOPs.
    -progress every 5 s feeds the ingest meter (bytes received); for a copy
    relay the bytes written are the bytes received."""
    prog = os.path.join(WORK_DIR, f"progress-relay-{idx}.txt")
    _ingest_inputs.append((_ingest_key(inp, idx), inp.get("role", "primary"), inp.get("rendition_label"), prog))
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-nostdin",
           "-progress", prog, "-stats_period", "5"]
    inp.setdefault("_idx", idx)
    cmd += input_args(inp)
    if ingest_args.needs_encode(inp):
        # NDI / ST 2110: uncompressed, so this rendition is encoded once (ingest_args)
        cmd += ingest_args.encode_rendition_args(inp) + ["-f", "mpegts", udp_out(idx)]
    else:
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
    # THE LOOP IS FETCHED TOO, for the same reason as the slate. The filler loops it
    # with `-stream_loop -1`, which has to SEEK: back to the start on every pass,
    # and to the moov atom first on any MP4 that is not faststart (most uploads are
    # not). Over HTTP that needs Range support from whatever serves the library, and
    # without it ffmpeg does not exit, it spins on "Stream ends prematurely" for ever.
    # The process stays alive, so it is never respawned, and fallback-to-loop
    # delivers NOTHING: measured, 50s of dead output while the selector reported the
    # filler engaged. A local file always seeks. On failure we drop the URL so the
    # filler falls back to the motion slate rather than to silence.
    loop_url = filler.get("vod_loop_url")
    if red.get("input_loss_behavior") == "vod_loop" and loop_url and re.match(r"^https?://", loop_url, re.I):
        ext = os.path.splitext(loop_url.split("?", 1)[0])[1] or ".mp4"
        dest_loop = os.path.join(WORK_DIR, f"filler_loop{ext}")
        try:
            import urllib.request
            urllib.request.urlretrieve(loop_url, dest_loop)
            log(f"filler loop: fetched {loop_url} -> {dest_loop}")
            filler["vod_loop_url"] = dest_loop
        except Exception as e:  # noqa: BLE001
            log(f"filler loop: fetch failed ({e}); falling back to the motion slate")
            filler["vod_loop_url"] = None
    # PACKAGE_ONLY: the filler's audio goes straight into Shaka, which cannot change
    # audio configuration mid-stream, so it must match the source (see
    # source_selector._audio_shape). Probe the primary once, here, before anything runs.
    if cfg.get("workflow") == "package_only" and not filler.get("audio"):
        prim = primary_inputs(cfg)
        if prim:
            try:
                out = subprocess.run(
                    ["ffprobe", "-v", "error", "-select_streams", "a:0",
                     "-show_entries", "stream=sample_rate,channels", "-of", "json",
                     "-analyzeduration", "2000000", "-probesize", "2000000", input_url(prim[0])],
                    capture_output=True, text=True, timeout=12)
                st = (json.loads(out.stdout or "{}").get("streams") or [{}])[0]
                if st.get("sample_rate"):
                    filler["audio"] = {"sample_rate": int(st["sample_rate"]),
                                       "channels": int(st.get("channels") or 2)}
                    log(f"filler audio: matched to the source "
                        f"({filler['audio']['sample_rate']} Hz, {filler['audio']['channels']} ch)")
            except Exception as e:  # noqa: BLE001
                log(f"filler audio: probe failed ({e}); using 48 kHz stereo")
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
                # resolve a master to one variant FIRST so the relay opens a single
                # rendition, then probe that playlist for its live/bounded shape
                inp["url"] = input_url(inp)
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


_NVENC_OK = None


def _nvenc_available():
    """Can THIS machine actually run h264_nvenc? Asked once, by encoding one frame.

    A profile's codec backend is a request, not a guarantee, and the default for a new
    output profile is nvenc. On a Mac or any box without an NVIDIA GPU the transcoder
    died on "Cannot load libcuda.so.1" and was respawned every few seconds for as long
    as the channel was up: the console said live, and there was no picture at all.
    Falling back to x264 keeps the channel on air; the log says why."""
    global _NVENC_OK
    if _NVENC_OK is None:
        try:
            r = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                                "-i", "color=s=256x144:d=0.1", "-frames:v", "1",
                                "-c:v", "h264_nvenc", "-f", "null", "-"],
                               capture_output=True, timeout=20)
            _NVENC_OK = r.returncode == 0
        except Exception:  # noqa: BLE001
            _NVENC_OK = False
        if not _NVENC_OK:
            log("transcode: GPU (NVENC) requested but not available on this machine; "
                "encoding with x264 on the CPU instead")
    return _NVENC_OK


def start_transcode(cfg, keys_unused, source_override=None):
    """transcode: one mezzanine -> full ladder, aligned closed GOPs, each
    rendition to its own UDP port. GPU (NVENC) if requested, else x264.

    source_override: when input failover is on, read the selector's single chosen-source
    feed (a local UDP mpegts) instead of the raw ingest URL, so a primary/backup/filler
    switch happens upstream of the transcoder."""
    ladder = cfg["ladder"]
    seg = cfg["segment_seconds"]
    src = cfg["inputs"][0]
    gpu = cfg.get("gpu", False) and _nvenc_available()
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
        vf = _overlay_vf(r['height'], wm_path, wm) if wm_path else None
        cmd += video_rung_args(r, seg=seg, fps=fps, gpu=gpu, vf=vf)
        cmd += ["-f", "mpegts", udp_out(i)]

    # AUDIO: transcode EACH source audio track to its own AAC MPEG-TS on a dedicated
    # port. Track 0 always exists; extra tracks (multi-language sources) each get one.
    for a, _t in enumerate(tracks):
        cmd += audio_track_args(a)
        cmd += ["-f", "mpegts", udp_out(AUDIO_IDX_BASE + a)]
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
def spawn(name, cmd, critical=True, log_filter=None):
    # critical=False for selector-managed children (relays/forwarders/filler):
    # their death is EXPECTED (a source dropping) and handled by failover, so it
    # must not trip the whole-container teardown below.
    log(f"start {name}: {' '.join(shlex.quote(c) for c in cmd)}")
    if log_filter is None:
        proc = subprocess.Popen(cmd)
    else:
        # FILTERED STDERR (packager only, see packager_log.py): the child's stderr is
        # read line by line and rewritten through the filter. The pump must never
        # stop reading, or a full pipe would block the packager, so any filter error
        # drops to raw pass-through for the rest of the run.
        proc = subprocess.Popen(cmd, stderr=subprocess.PIPE, text=True,
                                errors="replace", bufsize=1)
        threading.Thread(target=_pump_filtered, args=(name, proc, log_filter),
                         name=f"log:{name}", daemon=True).start()
    _children.append((name, proc, critical))
    return proc


def _pump_filtered(name, proc, log_filter):
    ok = True
    for raw in proc.stderr:
        line = raw.rstrip("\n")
        if ok:
            try:
                for out in log_filter.feed(line):
                    sys.stderr.write(out + "\n")
                sys.stderr.flush()
                continue
            except Exception as e:  # noqa: BLE001
                ok = False
                log(f"{name}: log filter failed ({e}); passing output through unfiltered")
        sys.stderr.write(line + "\n")
        sys.stderr.flush()
    try:
        for out in log_filter.flush():
            sys.stderr.write(out + "\n")
        sys.stderr.flush()
    except Exception:  # noqa: BLE001
        pass


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
# THE RULE THIS SECTION IS BUILT ON: a subtitle cue is only ever as well aligned
# as the clock used to place it. So there is exactly ONE clock here, the media
# timeline of the stream we actually deliver, and every number below is read off
# it rather than estimated from wall clock or file modification times.
#
# Caption audio is the DELIVERED audio: the packager's own CMAF audio segments,
# the same bytes the viewer's player decodes. Each segment carries a tfdt
# (baseMediaDecodeTime), which is the exact PTS its first sample sits at, so a
# window of segments has a known start PTS to the sample, and a cue found N
# seconds into that window belongs at start_pts + N. Nothing is inferred.
#
# What this replaced, and why: captions used to come from a SECOND, independent
# ffmpeg pull of the source URL, started seconds after the video ingest. Two
# independent joins to a live HLS edge land on different source segments, so the
# audio whisper heard was offset from the video being packaged by a random
# amount every run, and the two were reconciled afterwards by comparing file
# mtimes. That is the "sometimes ahead, sometimes way behind, sometimes never
# shown" behaviour: measured at a median of 15.7s out, with no run repeating the
# previous run's error. Reading the packaged audio makes the offset structurally
# zero instead of merely small, and removes a whole second pull of the source.
#
# LATENCY: a cue can only exist once its audio segment has been packaged, so the
# caption offset is (window length) + (transcribe time) + a margin. It is
# measured per window and reported as caption.offset, and it never delays the
# video path, which does not wait for captions at any point.
# ---------------------------------------------------------------------------
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
    PTS at which this segment's content starts on the media timeline."""
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


_TS_CACHE = {}    # init.mp4 path  -> timescale
_PTS_CACHE = {}   # segment path   -> media PTS in seconds
_EPOCH = {}       # out_dir        -> wall clock of media PTS 0
# the epoch is read by BOTH the caption worker and the companion refresher; anchoring it
# twice would give the two tracks two slightly different clocks for the first few seconds
_EPOCH_LOCK = threading.Lock()


def _seg_pts(out_dir, rel_uri):
    """Media-timeline PTS (seconds) a packaged segment starts at, from its own tfdt.

    Segment files never change after they are written, so this is memoised: a full
    DVR window is re-stamped every couple of seconds and re-reading every segment
    header each time would be pointless IO."""
    path = os.path.join(out_dir, rel_uri)
    hit = _PTS_CACHE.get(path)
    if hit is not None:
        return hit
    init = os.path.join(os.path.dirname(path), "init.mp4")
    ts = _TS_CACHE.get(init)
    if ts is None:
        ts = _mp4_timescale(init)
        if not ts:
            return None
        _TS_CACHE[init] = ts
    base = _mp4_tfdt_time(path)
    if base is None:
        return None
    val = base / ts
    if len(_PTS_CACHE) > 40000:          # 24/7 safety valve, not an expected path
        _PTS_CACHE.clear()
    _PTS_CACHE[path] = val
    return val


def _rendition_dirs(out_dir):
    try:
        return [os.path.join(out_dir, n) for n in sorted(os.listdir(out_dir))
                if os.path.isfile(os.path.join(out_dir, n, "init.mp4"))]
    except OSError:
        return []


def _seg_num(path):
    mo = re.search(r"seg_(\d+)\.m4s$", path)
    return int(mo.group(1)) if mo else -1


def _media_epoch(out_dir, seg_dur):
    """The wall clock that media PTS 0 corresponds to. Anchored ONCE per run.

    Every EXT-X-PROGRAM-DATE-TIME we publish is then epoch + that segment's own PTS,
    which means PDT advances by exactly EXTINF, is monotonic, and describes the same
    instant on the video track and the subtitle track because both are derived from
    the same two numbers.

    The previous scheme stamped each segment with its own file mtime instead. That
    looks safer (it "cannot accumulate drift") but it is stamping the encoder's write
    schedule rather than the media timeline: measured on a box that was not keeping up,
    nominally 4.000s segments were stamped 8.8s and 11.2s apart. Players align a
    subtitle rendition to video by PDT, so cues were being placed wherever the encoder
    happened to stutter. A single anchor plus real PTS cannot do that: it is exact by
    construction and the anchor only affects what the clock reads, never alignment."""
    hit = _EPOCH.get(out_dir)
    if hit is not None:
        return hit
    with _EPOCH_LOCK:
        hit = _EPOCH.get(out_dir)
        if hit is not None:
            return hit
        for rend in _rendition_dirs(out_dir):
            segs = sorted(glob.glob(os.path.join(rend, "seg_*.m4s")), key=_seg_num)
            if not segs:
                continue
            newest = segs[-1]
            pts = _seg_pts(out_dir, os.path.relpath(newest, out_dir))
            if pts is None:
                continue
            try:
                mt = os.path.getmtime(newest)
            except OSError:
                continue
            # that segment's content ENDS around the moment it was written, so its
            # content STARTED about one segment earlier:
            #   epoch = write time - duration - its PTS
            _EPOCH[out_dir] = mt - seg_dur - pts
            return _EPOCH[out_dir]
    return None


def _live_sub_playlist(entries, target_dur, media_seq):
    """A LIVE WebVTT media playlist. `entries` is [(idx, pdt_epoch, duration)] in order.

    Each subtitle segment carries the PDT of the media it describes, taken from the
    same epoch + PTS arithmetic the video companion uses, so the two tracks agree by
    construction rather than by two clocks happening to land close together."""
    import math
    longest = max([d for _i, _p, d in entries] + [target_dur])
    lines = ["#EXTM3U", "#EXT-X-VERSION:7",
             # TARGETDURATION must be >= every EXTINF listed. Real window durations vary
             # a little because the packager cuts segments on keyframes, so take the
             # ceiling of the longest one actually present.
             f"#EXT-X-TARGETDURATION:{int(math.ceil(longest - 0.001))}",
             f"#EXT-X-MEDIA-SEQUENCE:{media_seq}"]
    for idx, pdt, dur in entries:
        if pdt is not None:
            lines.append(f"#EXT-X-PROGRAM-DATE-TIME:{_iso(pdt)}")
        lines.append(f"#EXTINF:{dur:.3f},")
        lines.append(f"sub_{idx}.vtt")
    return "\n".join(lines) + "\n"


def _write_sub_segment(path, cues, seg_start, seg_end, mpegts=None):
    """One HLS WebVTT segment. Cues are written RELATIVE to the segment start.

    ALIGNMENT: players place WebVTT cues via the X-TIMESTAMP-MAP header, which must
    carry the media's REAL 90kHz PTS for this segment's start. A constant (like
    MPEGTS:0) maps every segment's cues to the same spot on the timeline, so captions
    show only while the playhead is near that one spot: the "worked for two chunks then
    stopped forever" failure. `mpegts` is the true PTS in 90kHz units, read from the
    delivered audio segment's tfdt; when unknown the map is omitted rather than guessed
    and players fall back to fragment-anchored placement.

    READABILITY (the anti-stacking rules):
      * a cue lives in EXACTLY ONE segment: the one containing its START. Writing a
        spanning cue into every overlapped segment created near-duplicate copies that
        STACKED on screen.
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
        # ...and never past the END of this segment, for the same reason across the
        # boundary. A cue's own words always finish inside the window (the window's audio
        # is all the recogniser was given), so an overrun is always the minimum-duration
        # clamp stretching the last cue, and it would sit on screen underneath the next
        # segment's first cue.
        span = seg_end - seg_start
        if rel_end > span:
            rel_end = max(rel_start + 0.2, span)
        body.append(cue_block(Cue(rel_start, rel_end, c.text, c.lang)))
        body.append("")
    _atomic_write(path, "\n".join(body).rstrip() + "\n")


def _pdt_companion_playlist(text, out_dir, seg_dur):
    """Copy a Shaka video media playlist and inject EXT-X-PROGRAM-DATE-TIME derived from
    each segment's OWN tfdt, so the video carries the same wall clock the subtitle track
    is stamped against.

    PDT = run epoch + segment PTS. Because both terms are exact, consecutive stamps are
    exactly EXTINF apart, the DVR window and the live edge are both exact, and the
    stamps never move between regenerations. A segment whose header cannot be read
    continues from the previous stamp (spec-compliant: players interpolate between PDT
    tags)."""
    epoch = _media_epoch(out_dir, seg_dur)
    lines = text.splitlines()
    out = []
    pend = None            # duration parsed from the preceding EXTINF
    prev_end = None        # wall clock end of the previous segment (continuity fallback)
    for l in lines:
        if l.startswith("#EXTINF:"):
            try:
                pend = float(l[len("#EXTINF:"):].split(",")[0])
            except ValueError:
                pend = None
            out.append(l)
        elif l and not l.startswith("#") and pend is not None:
            dur = pend or 0.0
            pts = _seg_pts(out_dir, l) if epoch is not None else None
            start_wall = (epoch + pts) if pts is not None else prev_end
            if start_wall is not None:
                out.append(f"#EXT-X-PROGRAM-DATE-TIME:{_iso(start_wall)}")
                prev_end = start_wall + dur
            out.append(l)
            pend = None
        else:
            out.append(l)
    return "\n".join(out) + "\n"


def _playout_pass(out_dir, src_lines, seg_dur):
    """One playout pass: feed every packager media playlist named in the master (video
    variants AND audio renditions) to the splicer, write the delivered `<name>_cc.m3u8`
    for each, and return {packager name: delivered name} for the master rewrite."""
    names, lead = [], None
    expect_uri = False
    for line in src_lines:
        if line.startswith("#EXT-X-STREAM-INF"):
            expect_uri = True
            continue
        if expect_uri and line and not line.startswith("#"):
            names.append(line)
            lead = lead or line
            expect_uri = False
        elif line.startswith("#EXT-X-MEDIA:") and "TYPE=AUDIO" in line:
            mo = re.search(r'URI="([^"]+)"', line)
            if mo:
                names.append(mo.group(1))
    texts = {}
    for n in names:
        try:
            texts[n] = open(os.path.join(out_dir, n)).read()
        except OSError:
            pass
    if lead is None:
        return {}
    epoch = _media_epoch(out_dir, seg_dur)

    def pdt_of(uri):
        if epoch is None:
            return None
        pts = _seg_pts(out_dir, uri)
        return (epoch + pts) if pts is not None else None

    _PLAYOUT.pdt_of = pdt_of
    _PLAYOUT.forced = _forced_filler()
    _PLAYOUT.update(time.time(), texts, lead)
    out = {}
    for n in names:
        txt = _PLAYOUT.render(n, _iso)
        if txt is None:
            continue
        base = n[:-len(".m3u8")] if n.endswith(".m3u8") else n
        _atomic_write(os.path.join(out_dir, f"{base}_cc.m3u8"), _with_triggers(txt))
        out[n] = f"{base}_cc.m3u8"
    # DASH: the same delivered timeline as a multi-Period MPD (live / loop / live)
    try:
        mpd = _PLAYOUT.render_mpd(_iso, _mpd_reps(out_dir), seg_dur, time.time())
        if mpd:
            _atomic_write(os.path.join(out_dir, "manifest_cc.mpd"), _with_trigger_events(mpd))
    except Exception as e:  # noqa: BLE001
        log(f"playout: DASH manifest not written this pass ({e})")
    return out


_MPD_INFO = {"mtime": None, "by_init": {}}


def _mpd_reps(out_dir):
    """Representation/AdaptationSet attributes, read from the PACKAGER's own MPD (it is
    the authority on codecs, bandwidth, sizes, language, roles), keyed by init segment.
    The loop's Representations reuse them with the loop's own codecs and bandwidth."""
    import xml.etree.ElementTree as ET
    import mp4util
    path = os.path.join(out_dir, "manifest.mpd")
    try:
        mt = os.path.getmtime(path)
    except OSError:
        mt = None
    if mt and mt != _MPD_INFO["mtime"]:
        try:
            root = ET.parse(path).getroot()
            for el in root.iter():
                if "}" in el.tag:
                    el.tag = el.tag.split("}", 1)[1]
            by = {}
            for aset in root.iter("AdaptationSet"):
                set_attrs = {k: v for k, v in aset.attrib.items() if k != "id"}
                kids = [ET.tostring(c, encoding="unicode") for c in aset
                        if c.tag in ("Role", "Accessibility", "ContentProtection")]
                for r in aset.iter("Representation"):
                    tpl = r.find("SegmentTemplate")
                    if tpl is None:
                        continue
                    rk = [ET.tostring(c, encoding="unicode") for c in r if c.tag == "AudioChannelConfiguration"]
                    by[tpl.get("initialization")] = {
                        "set": aset.get("id") or set_attrs.get("contentType"), "set_attrs": set_attrs,
                        "set_children": kids, "attrs": dict(r.attrib), "children": rk}
            _MPD_INFO.update(mtime=mt, by_init=by)
        except Exception:  # noqa: BLE001
            pass
    by = _MPD_INFO["by_init"]
    fmeta = _FILLER_META or {}

    def reps(kind, track):
        live = by.get(track.live_init)
        if not live:
            return None
        if kind != "filler":
            return live
        info = dict(live)
        attrs = dict(live["attrs"])
        f = track.filler or {}
        try:
            c = mp4util.codecs(os.path.join(out_dir, f.get("init", "")))
            if c:
                attrs["codecs"] = c
        except Exception:  # noqa: BLE001
            pass
        kb = ((fmeta.get("tracks") or {}).get(track.label if not track.label.startswith("audio") else "audio") or {}).get("bitrate_kbps")
        if kb:
            attrs["bandwidth"] = str(int(kb) * 1000)
        info["attrs"] = attrs
        return info
    return reps


def _write_companion(out_dir, langs, default_lang, seg_dur):
    """Build master_cc.m3u8 that (a) carries the SUBTITLES group and (b) points each
    video variant at a PDT-stamped companion playlist, so the player aligns subs to
    frames by wall clock. Writes master_cc.m3u8 + *_cc.m3u8."""
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
    spliced = _playout_pass(out_dir, src, seg_dur) if _PLAYOUT is not None else None
    if spliced is not None:
        # A player loads the master ONCE. With playout on, master_cc must never point
        # at a packager playlist, or a viewer who joins early is pinned to the
        # unspliced stream for the whole session. Publish it only once every variant
        # and audio rendition has its delivered playlist.
        wanted = [l for i, l in enumerate(src) if l and not l.startswith("#") and i and src[i - 1].startswith("#EXT-X-STREAM-INF")]
        wanted += re.findall(r'TYPE=AUDIO[^\n]*?URI="([^"]+)"', "\n".join(src))
        if not wanted or any(w not in spliced for w in wanted):
            return
    out, inserted, expect_uri = [], False, False
    for line in src:
        if spliced is not None and line.startswith("#EXT-X-MEDIA:") and "TYPE=AUDIO" in line:
            mo = re.search(r'URI="([^"]+)"', line)
            if mo and mo.group(1) in spliced:
                line = line.replace(f'URI="{mo.group(1)}"', f'URI="{spliced[mo.group(1)]}"')
            out.append(line)
            continue
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
            if spliced is not None:
                out.append(spliced.get(line, line))
                expect_uri = False
                continue
            try:
                vtext = open(os.path.join(out_dir, line)).read()
                # SOURCE SANITY (0f1a6cd): the packager's playlist could itself be
                # caught mid-write; publishing a copy of a truncated source would hand
                # players a broken window for a whole refresh cycle. Skip this cycle
                # (keep the previous good companion) unless the source is complete.
                vlines = [x for x in vtext.splitlines() if x.strip()]
                complete = (vlines and vlines[0].startswith("#EXTM3U")
                            and (vlines[-1].startswith("#") or vlines[-1].endswith((".m4s", ".mp4", ".ts"))))
                if complete:
                    _atomic_write(os.path.join(out_dir, cc_name),
                                  _with_triggers(_pdt_companion_playlist(vtext, out_dir, seg_dur)))
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
    """Best-effort: copy Shaka's manifest.mpd and add a text AdaptationSet per language."""
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
    if blocks:
        mpd = mpd.replace("</Period>", "".join(blocks) + "</Period>")
    _atomic_write(os.path.join(out_dir, "manifest_cc.mpd"), _with_trigger_events(mpd))


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


_COMPANION_STARTED = False

# In-stream graphic triggers (timed_events.py). None until the job config asks for
# them; every helper below is then a plain pass-through.
_TRIGGERS = None


def _with_triggers(text):
    """A delivered media playlist with this stream's EXT-X-DATERANGE triggers."""
    if _TRIGGERS is None:
        return text
    import timed_events
    return timed_events.inject_hls(text, _TRIGGERS.current())


def _with_trigger_events(mpd):
    """A delivered MPD with this stream's triggers as EventStreams per Period."""
    if _TRIGGERS is None:
        return mpd
    import timed_events
    return timed_events.inject_mpd(mpd, _TRIGGERS.current())


def start_trigger_feed(cfg):
    """Poll the control plane for this stream's triggers (programme boundaries and
    graphics such as Up next) so the companion refresher can write them."""
    global _TRIGGERS
    te = cfg.get("timed_events") or {}
    if not te.get("url") or _TRIGGERS is not None:
        return
    import timed_events
    _TRIGGERS = timed_events.TriggerFeed(te["url"], te.get("token"), te.get("poll_sec", 5), log=log).start()
    log(f"timed events: polling every {_TRIGGERS.poll_sec}s")


def start_companion_refresher(out_dir, langs, default_lang, chunk, seg_dur, interval=1.0):
    """Regenerate the caption COMPANION manifests on a FAST fixed cadence, DECOUPLED
    from caption production.

    The player watches the companion (master_cc.m3u8 -> stream_*_cc.m3u8) so it can see
    the subtitle group. If the companion only refreshed when a caption window finished,
    the companion VIDEO playlist would advance in bursts while Shaka's real playlist
    advances every segment: the player stalls then jumps, which shows as a stutter.
    Refreshing every ~2s tracks Shaka's live edge so video stays smooth. This is the
    single owner of the companion manifests; the caption worker only writes the subtitle
    segments and subs.m3u8."""
    global _COMPANION_STARTED
    if _COMPANION_STARTED:
        return
    _COMPANION_STARTED = True

    def loop():
        while True:
            try:
                if os.path.exists(os.path.join(out_dir, "master.m3u8")):
                    _write_companion(out_dir, langs, default_lang, seg_dur)
                    if (langs or _TRIGGERS is not None) and _PLAYOUT is None:
                        # with playout on, manifest_cc.mpd is the spliced multi-Period MPD
                        _write_companion_mpd(out_dir, langs, chunk, _subs_first_idx(out_dir, default_lang))
            except Exception as e:  # noqa: BLE001
                log(f"companion refresher error: {e}")
            time.sleep(interval)
    threading.Thread(target=loop, name="companion", daemon=True).start()
    log(f"captions: companion refresher every {interval}s (decoupled from transcribe)")


def _decode_delivered_audio(out_dir, seg_nums, wav_path):
    """Decode a run of DELIVERED audio segments to the 16 kHz mono WAV whisper wants.

    Returns (wav_start_pts, duration_sec) where wav_start_pts is the exact media PTS of
    the first sample, read from the first segment's tfdt. Returns None if the window is
    not readable, which simply means we try again on the next pass."""
    adir = os.path.join(out_dir, "audio")
    init = os.path.join(adir, "init.mp4")
    if not os.path.exists(init) or not seg_nums:
        return None
    paths = [os.path.join(adir, f"seg_{n}.m4s") for n in seg_nums]
    if not all(os.path.exists(p) for p in paths):
        return None
    start = _seg_pts(out_dir, os.path.relpath(paths[0], out_dir))
    if start is None:
        return None
    blob = wav_path + ".mp4"
    try:
        with open(blob, "wb") as out:
            out.write(open(init, "rb").read())
            for p in paths:
                out.write(open(p, "rb").read())
        # -vn: audio only. The CMAF timeline starts at a large tfdt; WAV has no
        # timestamps, so the samples land at 0 and `start` above is what maps them back.
        subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
                        "-i", blob, "-vn", "-ac", "1", "-ar", "16000", wav_path],
                       check=True, timeout=60)
    except Exception:  # noqa: BLE001
        return None
    finally:
        try:
            os.remove(blob)
        except OSError:
            pass
    try:
        dur = os.path.getsize(wav_path) / (16000 * 2)   # 16-bit mono
    except OSError:
        dur = 0.0
    return start, dur


# ---------------------------------------------------------------------------
# PLAYOUT: the pre-built, ladder-matched loop spliced into the delivered playlists
# (playout.py has the why). This part owns the IO: building or reusing the loop
# package, copying it next to the run, and lifting/forcing the splice.
# ---------------------------------------------------------------------------
_PLAYOUT = None
_FILLER_META = None


def playout_wanted(cfg):
    red = cfg.get("redundancy") or {}
    return bool(red.get("input_failover")) and red.get("input_loss_behavior", "slate") in ("slate", "vod_loop")


def _forced_filler():
    """The pre-flight failover panel writes `_failover_control.json` at the channel root;
    slate/loop there means DELIVER THE LOOP NOW, whatever the inputs are doing."""
    try:
        with open(os.path.join(BASE_OUT_DIR or OUT_DIR, "_failover_control.json")) as fh:
            return str(json.load(fh).get("mode") or "auto") in ("slate", "loop")
    except (OSError, ValueError):
        return False


def _filler_source(cfg):
    red = cfg.get("redundancy") or {}
    f = red.get("filler") or {}
    loop = f.get("vod_loop_url")
    if red.get("input_loss_behavior") == "vod_loop" and loop and os.path.exists(loop):
        return {"kind": "video", "path": loop}
    slate = f.get("slate_ref")
    if slate and os.path.exists(slate):
        return {"kind": "image", "path": slate}
    return None


def _live_rendition_spec(cfg, out_dir):
    """What the filler has to match: probed off our OWN output renditions, so it is
    exact for both workflows (package_only output is the source; transcode output is
    the ladder as actually encoded, including the width the source's aspect gave it)."""
    import source_probe
    video, audio = [], None
    ladder = {f"{r['height']}p": r for r in (cfg.get("ladder") or [])}
    for rdir in _rendition_dirs(out_dir):
        label = os.path.basename(rdir)
        if label.startswith("audio"):
            if label == "audio" and audio is None:
                pr = source_probe.probe_rendition(rdir)
                a = (pr or {}).get("audio") or {}
                if a:
                    audio = {"sample_rate": a.get("sample_rate"), "channels": a.get("channels"),
                             "bitrate_kbps": a.get("bitrate_kbps") or 128}
            continue
        pr = source_probe.probe_rendition(rdir)
        v = (pr or {}).get("video")
        if not v:
            return None
        kbps = (ladder.get(label) or {}).get("bitrate_kbps") or v.get("bitrate_kbps") or 1500
        video.append({"label": label, "width": v["width"], "height": v["height"],
                      "fps": v.get("fps") or cfg.get("fps", 25), "bitrate_kbps": max(200, int(kbps)),
                      "x264_profile": v.get("x264_profile"), "x264_level": v.get("x264_level"),
                      "pix_fmt": v.get("pix_fmt") or "yuv420p"})
    if not video:
        return None
    # package_only renditions that carry their own audio land in audio/ too; a
    # silent channel simply gets no audio filler
    return {"video": video, "audio": audio}


def _filler_matches(meta, spec):
    if not meta:
        return False
    tracks = meta.get("tracks") or {}
    for v in spec["video"]:
        t = tracks.get(v["label"])
        if not t or int(t.get("width") or 0) != int(v["width"]) or int(t.get("height") or 0) != int(v["height"]):
            return False
    if spec.get("audio") and "audio" not in tracks:
        return False
    if bool(meta.get("has_watermark")) != bool((spec.get("watermark") or {}).get("path")):
        return False                # the brand was added or removed since it was built
    return True


def start_playout(cfg):
    """Create the splicer now (so the delivered playlists exist from the first segment)
    and get its loop ready in the background: reuse the control plane's pre-build or an
    earlier run's when it matches, otherwise build it from the live renditions."""
    global _PLAYOUT
    import playout as playout_mod
    import filler_build
    seg = float(cfg["segment_seconds"])
    # HOLD: how late the live edge may be before a slot goes to the loop. A player
    # sitting N segments behind the edge survives a listing gap of a little under N
    # segments (it needs each one fetched before its playhead gets there). Measured:
    # a full segment of hold left a 3-segment player 0.76s short on a loaded box, so
    # three quarters of a segment: the longest gap is then 1.75 segments plus one
    # refresh pass, comfortably inside the buffer, and a source switch that recovers
    # inside it still never flashes the loop.
    hold = float((cfg.get("redundancy") or {}).get("splice_hold_sec") or max(2.0, 0.75 * seg))
    loss_kind = "loop" if (cfg.get("redundancy") or {}).get("input_loss_behavior") == "vod_loop" else "slate"

    def playout_event(etype, **d):
        """Every splice goes to the control plane AND to playout.jsonl in the run dir:
        the recording keeps only real source media (the loop is never packaged), so the
        stretch viewers spent on the loop is a hole in the recording, and this file is
        how the recording knows what that hole was and what was on air instead."""
        if etype == "playout.splice":
            at = d.get("at_pdt")
            line = {"type": "splice", "to": d.get("to"), "reason": d.get("reason"),
                    "filler": loss_kind, "splice": d.get("splice"),
                    "at_ms": int(round(at * 1000)) if at else int(time.time() * 1000),
                    "wall_ms": int(time.time() * 1000)}
            try:
                with open(os.path.join(OUT_DIR, "playout.jsonl"), "a") as fh:
                    fh.write(json.dumps(line) + "\n")
            except OSError:
                pass
            if at:
                d["at_ms"] = line["at_ms"]
                d.pop("at_pdt", None)
            d.setdefault("filler", loss_kind)
        if _events:
            _events.event(etype, **d)

    _PLAYOUT = playout_mod.Playout({}, window_sec=float(cfg.get("dvr_seconds", 300)), hold_sec=hold,
                                   pdt_of=lambda u: None, log=log, event=playout_event)
    import mp4util
    media_cache = {}

    def media_of(uri):
        """(decode time, duration, timescale) of a live segment, for DASH."""
        hit = media_cache.get(uri)
        if hit is not None:
            return hit
        path = os.path.join(OUT_DIR, uri)
        init = os.path.join(os.path.dirname(path), "init.mp4")
        try:
            val = (mp4util.tfdt(path), mp4util.frag_duration(path, init), mp4util.timescale(init))
        except Exception:  # noqa: BLE001
            return None
        if None in val:
            return None
        if len(media_cache) > 20000:
            media_cache.clear()
        media_cache[uri] = val
        return val

    def on_slot(src, dst, t):
        try:
            mp4util.rebase(os.path.join(OUT_DIR, src), os.path.join(OUT_DIR, dst), t)
        except Exception as e:  # noqa: BLE001
            log(f"playout: could not write loop slot {dst} ({e})")

    def on_drop(uri):
        try:
            os.remove(os.path.join(OUT_DIR, uri))
        except OSError:
            pass

    def on_link(src, dst):
        # DASH: a Period served from its own directory; the bytes are not copied
        try:
            p = os.path.join(OUT_DIR, dst)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            if not os.path.exists(p):
                try:
                    os.link(os.path.join(OUT_DIR, src), p)
                except OSError:
                    shutil.copyfile(os.path.join(OUT_DIR, src), p)
        except Exception as e:  # noqa: BLE001
            log(f"playout: could not link {dst} ({e})")

    def on_cut(src, dst, keep, init):
        try:
            p = os.path.join(OUT_DIR, dst)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            return mp4util.truncate(os.path.join(OUT_DIR, src), p, keep, os.path.join(OUT_DIR, init) if init else None)
        except Exception as e:  # noqa: BLE001
            log(f"playout: could not cut {dst} to its Period ({e})")
            return None

    _PLAYOUT.media_of, _PLAYOUT.on_slot, _PLAYOUT.on_drop = media_of, on_slot, on_drop
    _PLAYOUT.on_link, _PLAYOUT.on_cut = on_link, on_cut
    start_companion_refresher(OUT_DIR, [], "en", seg, seg)

    def prepare():
        src = _filler_source(cfg)
        if not src:
            log("playout: no slate or loop to splice in; delivered playlists are a plain copy")
            return
        spec = None
        for _ in range(120):                      # wait for the first live segments
            spec = _live_rendition_spec(cfg, OUT_DIR)
            if spec and all(len(glob.glob(os.path.join(OUT_DIR, v["label"], "seg_*.m4s"))) >= 2
                            for v in spec["video"]):
                break
            time.sleep(2)
        if not spec:
            log("playout: live renditions never appeared; no loop built")
            return
        spec.update({"segment_seconds": seg, "source": src})
        wm = cfg.get("watermark") if (cfg.get("watermark") or {}).get("url") else None
        wm_local = os.path.join(WORK_DIR, "watermark.img")
        if wm and cfg["workflow"] != "package_only" and os.path.exists(wm_local):
            # burn-in is a transcode feature: the loop gets it exactly when the live does
            spec["watermark"] = {"path": wm_local, **{k: wm.get(k) for k in
                                 ("position", "offset_x", "offset_y", "opacity", "scale")}}
        pre = ((cfg.get("redundancy") or {}).get("filler") or {}).get("prebuilt") or {}
        meta, built_dir = None, None
        cand = [pre.get("dir")] if pre.get("dir") else []
        h = filler_build.spec_hash(spec)
        cache = os.path.join(BASE_OUT_DIR or WORK_DIR, "filler", h)
        cand.append(cache)
        for d in cand:
            m = filler_build.load(d) if d else None
            if _filler_matches(m, spec):
                meta, built_dir = m, d
                log(f"playout: using the pre-built loop at {d}")
                break
        if meta is None:
            try:
                log(f"playout: building a {src['kind']} loop matched to "
                    + ", ".join(f"{v['label']} {v['width']}x{v['height']}@{v['fps']} {v['x264_profile']} {v['bitrate_kbps']}k"
                                for v in spec["video"]))
                meta, built_dir = filler_build.build(spec, cache), cache
            except Exception as e:  # noqa: BLE001
                log(f"playout: loop build failed ({e}); no splice available")
                if _events:
                    _events.event("playout.filler", state="failed", reason=str(e)[:200])
                return
        # next to the run, so the delivered playlists reference it by a plain relative
        # path wherever the run directory is served or uploaded
        dst = os.path.join(OUT_DIR, "filler")
        shutil.rmtree(dst, ignore_errors=True)
        shutil.copytree(built_dir, dst, ignore=shutil.ignore_patterns("*.m3u8"))
        global _FILLER_META
        fillers = {}
        for label, t in (meta.get("tracks") or {}).items():
            init_rel = f"filler/{t['init']}"
            init_abs = os.path.join(OUT_DIR, init_rel)
            segs = []
            for x in t["segments"]:
                rel = f"filler/{x['uri']}"
                segs.append({"uri": rel, "dur": x["dur"],
                             "d": mp4util.frag_duration(os.path.join(OUT_DIR, rel), init_abs)})
            fillers[label] = {"init": init_rel, "timescale": mp4util.timescale(init_abs), "segments": segs}
        _FILLER_META = meta
        _PLAYOUT.set_fillers(fillers)
        log(f"playout: loop ready ({meta.get('loop_seconds')}s, {len(fillers)} track(s)); splice armed")
        if _events:
            _events.event("playout.filler", state="ready", kind=src["kind"],
                          loop_sec=meta.get("loop_seconds"), tracks=sorted(fillers))

    threading.Thread(target=prepare, name="playout-filler", daemon=True).start()


def start_captions(cfg, out_dir):
    cap = cfg.get("captions")
    if not cap or not cap.get("enabled"):
        return
    seg = float(cfg.get("segment_seconds", 4))
    chunk = float(cap.get("chunk_seconds") or max(8.0, seg * 2))
    # a caption window is a whole number of DELIVERED audio segments, so its start and
    # end are exact points on the media timeline rather than an arbitrary cut
    per_win = max(1, int(round(chunk / seg)))
    win_sec = per_win * seg
    # segments of audio decoded BEFORE the window purely as context for the recogniser.
    # Whisper is far more accurate when a sentence does not begin at a hard cut, but
    # anything it finds in the preroll is discarded: those words belong to the previous
    # window and were already published there.
    preroll = max(0, int(cap.get("preroll_segments", 1)))
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
        # so the subtitle track must be advertised from the very first companion write,
        # otherwise a player that connects before the first cue exists never gets a
        # subtitle track for the whole session. This makes the track exist immediately
        # (no 404) and it fills in as cues arrive.
        _atomic_write(os.path.join(sub_root, l, "subs.m3u8"),
                          _live_sub_playlist([], win_sec, 0))
    tmp = os.path.join(WORK_DIR, "cap_audio")
    os.makedirs(tmp, exist_ok=True)
    log(f"captions: engine={engine} window={win_sec}s ({per_win} delivered audio "
        f"segment(s), {preroll} preroll) targets={targets} langs={langs}")

    def cap_event(etype, **detail):
        # surface caption lifecycle/errors to the control plane so the UI can show WHY
        # captions are (or are not) loading
        try:
            if _events:
                _events.event(etype, **detail)
        except Exception:  # noqa: BLE001
            pass

    def worker():
        cap_event("caption.status", state="starting", engine=engine, langs=langs, chunk_sec=win_sec)
        try:
            import captions as capmod
        except Exception as e:  # noqa: BLE001
            log(f"captions: engine import failed ({e}); worker not started")
            cap_event("caption.error", stage="import", reason=str(e),
                      hint="install faster-whisper (+ transformers/torch for translation) in the encoder's python")
            return
        # Build the engine ONCE and reuse across windows (one warm whisper model + one
        # NLLB translator), then just point it at each new audio window. Recreating it
        # per window would reload the models every time and never keep up live.
        reuse = None
        if engine == "whisper":
            try:
                mt = capmod.make_translator(targets, base_lang)
                reuse = capmod.WhisperAdapter("", src_lang, model_size, translator=mt)
                log(f"captions: whisper model '{reuse.model_size}' + translator initialised "
                    f"(warming on first window)")
            except Exception as e:  # noqa: BLE001
                log(f"captions: engine init failed ({e}); worker not started")
                cap_event("caption.error", stage="init", reason=str(e),
                          hint="whisper/NLLB model failed to load; check the model download + memory")
                return
        adir = os.path.join(out_dir, "audio")
        wav = os.path.join(tmp, "window.wav")
        store = {l: [] for l in langs}       # published cues, for the final VOD VTT
        published = []                       # [(idx, pdt, dur)] in the live window
        cursor = None                        # next audio segment number to start a window at
        errs = 0
        produced = False
        keep = max(3, int(round(float(cfg.get("dvr_seconds", 300)) / win_sec)))
        last_text = {}
        while True:
            try:
                nums = sorted(_seg_num(p) for p in glob.glob(os.path.join(adir, "seg_*.m4s")))
                nums = [n for n in nums if n >= 0]
                if len(nums) < 2:
                    time.sleep(0.5)
                    continue
                # the newest file may still be being written; a segment is only complete
                # once the one after it exists
                complete = set(nums[:-1])
                newest = max(complete)
                if cursor is None:
                    # START AT THE LIVE EDGE: begin with the newest complete window, not
                    # with whatever is still sitting in the DVR window from before the
                    # caption worker was ready
                    cursor = max(min(complete), newest - per_win + 1)
                # LIVE CURRENCY: if transcription falls behind (slow window, CPU
                # contention, heavy translation) processing in order means never catching
                # up and the offset only compounds, which ends with captions past the
                # player's hold point and invisible while burning maximum compute. So when
                # a backlog builds, jump to the newest full window and record the gap. A
                # live viewer loses a few seconds of captions once; they never lose
                # captions permanently.
                behind = (newest - cursor + 1) // per_win - 1
                if behind >= 2:
                    skipped = behind * per_win
                    cursor += skipped
                    log(f"captions: {behind} window(s) behind; skipping to the newest to stay live")
                    cap_event("caption.skip", skipped=skipped)
                window = list(range(cursor, cursor + per_win))
                if not all(n in complete for n in window):
                    time.sleep(0.5)
                    continue
                pre = [n for n in range(cursor - preroll, cursor) if n in complete]
                dec = _decode_delivered_audio(out_dir, pre + window, wav)
                if dec is None:
                    time.sleep(0.5)
                    continue
                wav_pts, wav_dur = dec
                win_start = _seg_pts(out_dir, f"audio/seg_{cursor}.m4s")
                if win_start is None:
                    win_start = wav_pts + len(pre) * seg
                # the window ENDS exactly where the next delivered segment begins. Taking
                # win_start + nominal duration instead left a gap or an overlap whenever
                # the packager cut a segment slightly short or long on a keyframe, and an
                # overlap means the same words published twice on two different segments.
                win_end = _seg_pts(out_dir, f"audio/seg_{cursor + per_win}.m4s")
                if win_end is None or win_end <= win_start:
                    win_end = win_start + win_sec
                win_dur = win_end - win_start
                t0 = time.time()
                try:
                    if reuse is not None:
                        reuse.audio_path = wav
                        # tell the recogniser where the context ends and this window
                        # begins, so a sentence crossing the boundary is cut there
                        # instead of being lost with the context it started in
                        reuse.split_at = max(0.0, win_start - wav_pts)
                        raw = reuse.transcribe(targets)
                    else:
                        ad = capmod.make_adapter({"engine": engine, "audio_path": wav,
                                                  "source_lang": src_lang, "targets": targets,
                                                  "model_size": model_size})
                        raw = ad.transcribe(targets)
                except Exception as e:  # noqa: BLE001
                    errs += 1
                    log(f"captions: window at seg {cursor} transcribe failed: {e}")
                    if errs == 1 or errs % 10 == 0:
                        cap_event("caption.error", stage="transcribe", chunk=cursor,
                                  reason=str(e), count=errs)
                    cursor += per_win
                    continue
                proc = time.time() - t0
                # cue times are relative to the WAV; wav_pts puts them on the media
                # timeline exactly, and offset_cfg is the optional playout offset
                cues = capmod.apply_offset(raw, wav_pts + offset_cfg)
                if not produced:
                    produced = True
                    cap_event("caption.status", state="producing", langs=langs)
                fresh = []
                for c in cues:
                    text = (c.text or "").strip()
                    if not text:
                        continue
                    # anything that STARTS in the preroll belongs to the previous window
                    # and was already published there. The recogniser cuts a cue at the
                    # boundary (split_at), so a cue that belongs to this window always
                    # starts at it or after it. Testing the END instead let a preroll cue
                    # through whenever its last word happened to finish a fraction after
                    # the boundary, and it was then clamped forward, which put a whole
                    # already-shown sentence on screen for a fraction of a second.
                    if c.start < win_start - 0.05:
                        continue
                    c.start = max(c.start, win_start)
                    if c.start >= win_end:
                        # a word that ran past the window edge: hold it at the edge rather
                        # than dropping it, the next window's preroll will not re-emit it
                        c.start = win_end - 0.001
                    c.end = max(c.end, c.start + 0.4)
                    # whisper repeats itself across boundaries and on hallucinated silence,
                    # which rendered as the same line stacked twice on screen
                    if last_text.get(c.lang) == text:
                        continue
                    last_text[c.lang] = text
                    c.text = text
                    fresh.append(c)
                    store.setdefault(c.lang, []).append(c)
                mpegts = int(round(win_start * 90000)) if win_start >= 0 else None
                epoch = _media_epoch(out_dir, seg)
                pdt = (epoch + win_start) if epoch is not None else None
                if pdt is not None and _PLAYOUT is not None:
                    # after a splice the delivered video clock is shifted so it runs on
                    # from the loop without a jump; the subtitles take the same shift
                    pdt += _PLAYOUT.shift_at(pdt)
                # SEARCHABLE TRANSCRIPT (2f29a5d, re-applied on the one clock): append this
                # window's cues to a durable per-run index. Times are WALL CLOCK ms on the
                # same media epoch the PDTs use (epoch + media PTS), so search and the
                # player agree on when a word was said.
                if fresh and epoch is not None:
                    try:
                        with open(os.path.join(out_dir, "transcript.jsonl"), "a", encoding="utf-8") as tf:
                            for c in fresh:
                                tf.write(json.dumps({
                                    "lang": c.lang,
                                    "start_ms": int(round((epoch + c.start) * 1000)),
                                    "end_ms": int(round((epoch + c.end) * 1000)),
                                    "text": (c.text or "").strip(),
                                }, ensure_ascii=False) + "\n")
                    except OSError:
                        pass
                published.append((cursor, pdt, win_dur))
                published[:] = published[-keep:]
                for l in langs:
                    _write_sub_segment(os.path.join(sub_root, l, f"sub_{cursor}.vtt"),
                                       [c for c in fresh if c.lang == l],
                                       win_start, win_end, mpegts=mpegts)
                    _atomic_write(os.path.join(sub_root, l, "subs.m3u8"),
                                      _live_sub_playlist(published, win_sec, published[0][0]))
                est = round(win_dur + proc + 1.0, 1)
                # HEADROOM WARNING: transcription that takes more than half the window it
                # covers has nothing left for a busy moment, and the next stall turns into
                # skipped windows (gaps in the captions). Say so once, plainly, with the
                # lever to pull, rather than letting it show up later as missing subtitles.
                windows_done = getattr(worker, "_n", 0) + 1
                worker._n = windows_done
                # the first couple of windows include model warm-up, which is not a
                # steady-state signal and should not raise an alarm on every start
                if windows_done > 2 and proc > 0.5 * win_dur and not getattr(worker, "_warned", False):
                    worker._warned = True
                    log(f"captions: transcribe is using {proc / win_dur:.0%} of the window "
                        f"(model={getattr(reuse, 'model_size', '?')}); this box has little "
                        f"headroom. Use a smaller model, a GPU, or a longer chunk_seconds.")
                    cap_event("caption.slow", proc_sec=round(proc, 1), window_sec=round(win_dur, 1),
                              model=getattr(reuse, "model_size", None))
                # TRACEABILITY: every window's full alignment story on one line. WHICH
                # delivered audio segments, the exact media PTS they occupy, and the PDT
                # the player will align them to. This is the answer to "do we know which
                # frames these words belong to".
                log(f"captions: seg {cursor}..{cursor + per_win - 1} pts "
                    f"{win_start:.3f}..{win_end:.3f}s -> {len(fresh)} cue(s) "
                    f"proc={proc:.1f}s pdt={_iso(pdt) if pdt else '?'}")
                if _events:
                    _events.event("caption.offset", est_offset_sec=est, proc_sec=round(proc, 1),
                                  chunk_sec=win_sec, realtime=bool(proc < win_sec), langs=langs,
                                  chunk=cursor, video_pts_sec=round(win_start, 2),
                                  wall_start=_iso(pdt) if pdt else None,
                                  cues=len(fresh),
                                  detected=getattr(reuse, "_last_lang", None))
                cursor += per_win
            except Exception as e:  # noqa: BLE001
                log(f"captions worker error: {e}")
                time.sleep(1)

    threading.Thread(target=worker, name="captions", daemon=True).start()
    # Fast, decoupled companion regeneration so the player's video stays smooth.
    start_companion_refresher(out_dir, langs, default_lang, win_sec, seg)


def shutdown(sig=None, *_):
    global _shutting_down
    _shutting_down = True   # stop every supervisor from respawning
    # HONEST STOP REASON: an operator pressing stop and a container being reclaimed look
    # identical in the log unless we say which happened. SIGINT is a person or a local
    # stop; SIGTERM is the scheduler or the orchestrator taking the task away.
    reason = {signal.SIGINT: "operator_stop",
              signal.SIGTERM: "terminated"}.get(sig, "server_window_closed")
    log(f"shutdown: terminating children (reason={reason})")
    if _events:
        _events.channel_stop(reason)
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
    # Packager log noise: Shaka's harmless AAC rounding warning is summarised, not
    # repeated every segment (packager_log.py). packager_log=all restores raw output.
    plog = resolve_packager_log_mode(cfg.get("packager_log"), os.environ.get("VOLT_PACKAGER_LOG"))
    log(f"packager log mode: {plog}")
    shaka = spawn("packager", build_shaka(cfg, keys),
                  log_filter=None if plog == "all" else PackagerLogFilter(plog))
    time.sleep(1)
    _events.packager(True)

    # Failover prep (no-op unless input_failover is on): make sure the filler slate is a
    # real local file so the filler can never fail to open it.
    prepare_filler_slate(cfg)

    if playout_wanted(cfg):
        # the loop is delivered by the playlists, not pushed through the packager
        cfg["redundancy"]["filler_via_manifest"] = True

    selector = None
    if cfg["workflow"] == "package_only":
        if redundancy_on(cfg):
            # The source-selector owns the bus ports Shaka reads: it runs the
            # primary + backup relays and the filler, and forwards the active
            # group to the bus with health-driven failover + filler-on-loss.
            prim, bak = primary_inputs(cfg), backup_inputs(cfg)
            prepare_failover_inputs(prim + bak)
            _segment_hints(cfg, prim + bak)
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
            for group, i, inp, pp in getattr(selector, "_relay_specs", []):
                _ingest_inputs.append((f"{group}:{inp.get('rendition_label') or i}", group, inp.get("rendition_label"), pp))
        else:
            _segment_hints(cfg, primary_inputs(cfg))
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
            for group, i, inp, pp in getattr(selector, "_relay_specs", []):
                _ingest_inputs.append((f"{group}:{inp.get('rendition_label') or i}", group, inp.get("rendition_label"), pp))
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

    if playout_wanted(cfg):
        try:
            start_playout(cfg)
        except Exception as e:  # noqa: BLE001
            log(f"playout: failed to start ({e}); delivered playlists are a plain copy")

    # IN-STREAM GRAPHIC TRIGGERS. The delivered copies (master_cc / *_cc / manifest_cc)
    # are written for EVERY video stream now, not only captioned or spliced ones: they
    # carry the wall clock and the triggers, and the packager's own files carry neither.
    # Started after captions and playout on purpose: either of those has already
    # started the companion refresher with its own settings, and this call is then a
    # no-op apart from the feed.
    if cfg.get("timed_events"):
        try:
            start_trigger_feed(cfg)
            seg_s = float(cfg.get("segment_seconds") or 4)
            start_companion_refresher(OUT_DIR, [], "en", seg_s, seg_s)
        except Exception as e:  # noqa: BLE001
            log(f"timed events: not started ({e}); manifests carry no triggers")

    # Supervise: if any critical child dies, tear the whole channel down so
    # ECS restarts a clean container (renditions must stay in lockstep).
    #
    # HEARTBEAT. The control plane judges a run by how fresh its last status report
    # is (monitoring, the Server gate, "stranded encoder record"). Radio stations have
    # always sent one every ten seconds; a TV channel only reported on a CHANGE, so a
    # channel quietly working for two minutes looked dead: Monitoring and the
    # Dashboard raised "has a stranded encoder record" on a healthy channel (seen
    # 9 Oct while capturing the demo). packager() only emits an event on a change,
    # so this is a status refresh, not log noise.
    last_beat = 0.0
    # CPU AND INGEST, read on the same ten-second beat (stream_metrics.py): the
    # kernel's accounting for this encoder's processes and the relays' own
    # -progress byte counts. Nothing new runs to produce them.
    metrics = stream_metrics.StreamMetrics(
        pids=lambda: [os.getpid()] + [p.pid for _n, p, _c in _children if p.poll() is None],
        inputs=lambda: list(_ingest_inputs))
    if os.environ.get("HEALTH_PORT"):
        try:
            import health_server
            health_server.start(int(os.environ["HEALTH_PORT"]), lambda: health_snapshot(cfg),
                                bind=os.environ.get("HEALTH_BIND", "0.0.0.0"))
            log(f"health endpoint on :{os.environ['HEALTH_PORT']} (/healthz /readyz /metrics /status)")
        except Exception as e:  # noqa: BLE001  monitoring never stops the stream
            log(f"health endpoint not started ({e})")
    try:
        while True:
            _health["loop_beat"] = time.time()
            for name, proc, critical in _children:
                if critical and proc.poll() is not None:
                    log(f"critical child {name} exited rc={proc.returncode}; "
                        f"tearing down channel")
                    shutdown()
            if _events is not None and time.time() - last_beat >= 10:
                last_beat = time.time()
                try:
                    _events.status["metrics"] = _health["metrics"] = metrics.sample()
                except Exception:  # noqa: BLE001  the meter never stops the stream
                    pass
                try:
                    _events.packager(shaka.poll() is None)
                except Exception:  # noqa: BLE001
                    pass
            time.sleep(2)
    except KeyboardInterrupt:
        shutdown()


if __name__ == "__main__":
    main()
