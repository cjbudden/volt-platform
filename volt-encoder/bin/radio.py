#!/usr/bin/env python3
# ============================================================================
#  VOLT RADIO — one container per station, audio only.
#
#  This exists so that radio follows the same deployment workflow as television
#  instead of being an ffmpeg the control plane spawns inside its own process.
#  The rule the encoder container obeys, and the reason it scales, is:
#
#      THE CONTAINER ACCEPTS NO INBOUND CONNECTIONS.
#
#  It pushes segments to storage and pushes status to the API. Viewers are
#  served by CloudFront from S3 and never touch it. This station does exactly
#  the same, with one addition: MP3 is PUSHED to an Icecast relay, which is
#  what Icecast is for. The station is a source client; the relay owns listener
#  fan-out and ICY metadata. Nothing in the control plane sits in the audio
#  path, so the control plane can be restarted, redeployed and replicated
#  without taking stations off air.
#
#  Outputs (all single bitrate, per the job config):
#    HLS  : audio-only fMP4 into the standard per-run origin namespace
#           <base>/runs/<runId>/audio/, with a hand-written master.m3u8 at the
#           run root. Using the SAME layout as a television run is what makes
#           the recording index, range playback and clipping work for radio
#           with no special cases anywhere.
#    DASH : manifest.mpd under <run>/dash/.
#    MP3  : pushed to icecast://…  ffmpeg speaks the protocol natively, so this
#           is configuration rather than code.
#
#  Cloud mode mirrors the run dir to S3 with the same s3-uploader.sh sidecar the
#  encoder uses. Local mode writes straight into the origin dir the control
#  plane serves, so a developer gets the identical pipeline with no AWS.
#
#  Reads JOB_CONFIG (path) or JOB_CONFIG_JSON (inline), exactly like encoder.py.
# ============================================================================
import json
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from events import EventLog  # noqa: E402  (same reporter the encoder uses)

WORK_DIR = os.environ.get("WORK_DIR", "/work")

_proc = None
_uploader = None
_events = None
_stopping = False
# Have we told anyone the source came up? A 'down' for an 'up' that was never
# claimed reads as a stream that failed, rather than one that never started.
_said_up = False


def log(msg):
    print(f"[volt-radio] {msg}", flush=True)


def die(msg, code=1):
    log(f"FATAL: {msg}")
    # A fatal BEFORE the pipeline starts still deserves to reach the console.
    # Without this the control plane sees a task that launched and never spoke,
    # which is indistinguishable from one still starting up.
    if _events:
        try:
            _events.channel_stop(reason=f"fatal: {msg}")
        except Exception:
            pass
    sys.exit(code)


def now_ms():
    return time.time() * 1000.0


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
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


def validate_config(cfg):
    for key in ("channel_id", "url"):
        if not cfg.get(key):
            die(f"job config missing required field: {key}")
    outs = resolve_outputs(cfg)
    if not any(outs.values()):
        die("job config turns every output off; there would be nothing to do")
    if not is_local(cfg) and not (cfg.get("s3") or {}).get("bucket"):
        die("s3.bucket is required unless output.mode is local")
    ice = cfg.get("icecast")
    if outs["mp3"] and ice:
        for key in ("host", "port", "mount", "username", "password"):
            if not ice.get(key):
                die(f"icecast.{key} is required when mp3 is pushed to a relay")


def is_local(cfg):
    out = cfg.get("output") or {}
    if str(out.get("mode", "")).lower() == "local":
        return True
    return os.environ.get("LOCAL_MODE") == "1"


# ---------------------------------------------------------------------------
# Argv — this MUST mirror volt-app/src/services/radio/args.ts.
#
# The control plane builds the same argv for its in-process development path.
# Two implementations of one pipeline is a drift risk, which is why the shape
# is a config rather than a set of flags spread across two codebases, and why
# args.check.ts pins the decisions this function also has to make.
# ---------------------------------------------------------------------------
DEFAULT_BITRATE_KBPS = 128


def clamp_bitrate(kbps):
    try:
        n = int(round(float(kbps)))
    except (TypeError, ValueError):
        return DEFAULT_BITRATE_KBPS
    return min(320, max(32, n))


# MP3 IS OPT-IN; HLS AND DASH ARE ON BY DEFAULT.
#
# Mirrors resolveOutputs() in volt-app/src/services/radio/args.ts, and see that
# function for why the three are not alike: HLS and DASH are files this process
# writes, MP3 is a live push to a relay whose bill is egress. An output nobody
# asked for should not reserve fan-out capacity or be able to degrade a station.
OUTPUT_DEFAULTS = {"mp3": False, "hls": True, "dash": True}


def resolve_outputs(cfg):
    outs = cfg.get("outputs") or {}
    return {k: bool(outs.get(k, OUTPUT_DEFAULTS[k])) for k in ("mp3", "hls", "dash")}


def is_mp3_copy(cfg):
    return not cfg.get("transcode") and cfg.get("source_codec") == "mp3"


RECONNECT = ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"]


def looks_like_hls(protocol, url):
    """An HLS source is a playlist, not a byte stream, whatever the row says."""
    return str(protocol).lower() == "hls" or bool(
        re.search(r"\.m3u8(\?|$)", str(url), re.I))


def input_args(protocol, url):
    """
    Input flags for a station's SOURCE, by protocol. Mirrors inputArgs() in
    volt-app/src/services/radio/args.ts; radio-args.check.ts diffs the two.

    THREE DIFFERENT KINDS OF THING ARRIVE HERE and they are not interchangeable:

      Icecast / plain HTTP  One endless response body. It drops, and ffmpeg
                            exits when it does unless told to reconnect. There
                            is no playlist and no edge, so nothing else applies.

      HLS                   A PLAYLIST, refetched on a timer. ffmpeg's default
                            entry point is live_start_index = -3, three segments
                            back from the end, so a source with six second
                            segments puts the station EIGHTEEN SECONDS BEHIND
                            REAL TIME for the whole run. That is a permanent
                            offset, not a startup cost you wait out. -1 starts
                            at the newest complete segment, the closest to live
                            HLS allows.

                            -re and -2 since 11 Oct 2026. Read as fast as it
                            arrived, an HLS source came out in BURSTS: ABC Jazz
                            delivers 10 s segments, so every 10 s the station
                            wrote two or three output segments within 0.1 s
                            and then nothing. The Icecast relay drops a source
                            that sends nothing for 10 s (its default
                            source-timeout), so whenever a burst came a little
                            late the mp3 output broke its pipe, the whole
                            pipeline exited and auto-connect started a new
                            run: 28 runs in an hour, a recording in 2 minute
                            pieces. -re reads the source at real time, so the
                            audio leaves evenly; it needs one segment in hand
                            to do that, hence -2 rather than -1. The cost is
                            one source segment of latency.

                            -http_persistent 0 because these playlists are
                            normally behind a CDN that serves segments from a
                            different host than the manifest, and reusing the
                            connection then logs "Cannot reuse HTTP connection
                            for different host" on every single fetch.

      SRT                   A CONTRIBUTION feed carrying MPEG-TS, whose
                            timestamps can be missing or discontinuous across a
                            reconnect. +genpts is what encoder.py already does
                            for the same reason. Reconnect flags are HTTP-only:
                            libsrt reconnects itself.

    The station is always the CALLER on SRT, never a listener. A container that
    accepts an inbound connection cannot be scaled, moved or reaped like the
    rest of the fleet, and that rule is why radio became a container at all.
    """
    p = str(protocol).lower()
    http = str(url).startswith(("http://", "https://"))

    if looks_like_hls(p, url) and http:
        return RECONNECT + ["-re", "-fflags", "+genpts", "-live_start_index", "-2",
                            "-http_persistent", "0", "-i", url]
    if p == "icecast" or http:
        return RECONNECT + ["-i", url]
    if p == "srt":
        return ["-fflags", "+genpts", "-i", url]
    return ["-i", url]


def icecast_url(t):
    from urllib.parse import quote
    scheme = "icecast+https" if t.get("tls") else "icecast"
    mount = t["mount"] if str(t["mount"]).startswith("/") else "/" + str(t["mount"])
    user = quote(str(t["username"]), safe="")
    pw = quote(str(t["password"]), safe="")
    return f"{scheme}://{user}:{pw}@{t['host']}:{t['port']}{mount}"


def redact_icecast_url(t):
    scheme = "icecast+https" if t.get("tls") else "icecast"
    mount = t["mount"] if str(t["mount"]).startswith("/") else "/" + str(t["mount"])
    return f"{scheme}://{t['username']}:***@{t['host']}:{t['port']}{mount}"


def master_playlist(kbps):
    bw = (clamp_bitrate(kbps) + 8) * 1000
    return ("#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n"
            f"#EXT-X-STREAM-INF:BANDWIDTH={bw},CODECS=\"mp4a.40.2\"\naudio/index.m3u8\n")


def probe_audio_codec(url):
    """Best effort. A source we cannot probe is simply never treated as MP3,
    so an unprobed station re-encodes rather than copying garbage through."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "quiet", "-select_streams", "a:0",
             "-show_entries", "stream=codec_name", "-of", "csv=p=0",
             "-analyzeduration", "2000000", "-i", url],
            capture_output=True, text=True, timeout=8)
        return (r.stdout or "").strip().splitlines()[0] or None
    except Exception:
        return None


def relay_reachable(ice, timeout=3.0):
    """
    Can we open a TCP connection to the Icecast relay?

    THIS EXISTS BECAUSE ONE FFMPEG CARRIES EVERY OUTPUT.

    ffmpeg opens all of its outputs before it encodes anything, so a refused
    icecast:// connection does not cost you the MP3 — it kills the process, and
    HLS and DASH are never written either. A station with no relay running
    therefore produces NOTHING, exits rc=195 about a second after start, and
    gets restarted by auto-connect twenty seconds later, forever. That is not a
    hypothetical: it filled a demo machine with ninety run directories.

    A TCP probe is deliberately shallow. It does not authenticate and does not
    check the mount, because the question being answered is only "is it worth
    including this output at all". A relay that accepts the connection and then
    rejects the credentials is a real error and SHOULD fail loudly; a relay that
    is not running at all is an environment that simply has no MP3, and the
    station should still go on air over HLS and DASH.
    """
    host = str(ice.get("host") or "").strip()
    port = int(ice.get("port") or 0)
    if not host or not port:
        return False
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


#  ffmpeg's own words, promoted from a log file to the stop reason.
#
#  "encoder exited rc=251" tells an operator nothing they can act on. The line
#  that matters is three lines above it in radio.log and says "Failed to resolve
#  hostname ice5.somafm.com", or "Connection refused", or "Server returned 403".
#  That file lives on the task's disk, and on a real deployment the task is gone
#  by the time anybody looks. So the reason travels with the stop event.
#
#  ffmpeg prints the ROOT CAUSE first and the consequences after it: a failed
#  DNS lookup is followed by "Error opening input" and then "Error opening input
#  files", each less specific than the last. Taking the last line would reliably
#  report the least useful one, so known causes are matched in order and the
#  earliest match wins.
_CAUSES = (
    "failed to resolve", "name or service not known", "nodename nor servname",
    "connection refused", "connection timed out", "network is unreachable",
    "no route to host", "server returned 4", "server returned 5",
    "401 unauthorized", "403 forbidden", "404 not found",
    "protocol not found", "no such file or directory", "permission denied",
    # BEFORE "invalid data found", deliberately. A geo-redirecting HLS URL hands
    # the demuxer a master playlist where it expected a variant, and ffmpeg 7
    # rejects it; ffmpeg then says "Invalid data found when processing input",
    # which sends an operator looking for a corrupt stream. The specific line is
    # three above it and names the actual problem, so it has to be matched first.
    "master playlist tag found in a media playlist",
    "invalid data found", "end of file", "handshake", "tls", "certificate",
)


def failure_hint(log_path, limit=200):
    """The most explanatory line ffmpeg wrote, or None if it wrote nothing."""
    try:
        with open(log_path, "rb") as fh:
            try:
                fh.seek(-8192, os.SEEK_END)
            except OSError:
                fh.seek(0)
            tail = fh.read().decode("utf-8", "replace")
    except OSError:
        return None
    # Drop ffmpeg's "[tcp @ 0x600000840080] " component prefixes: they are noise
    # to everyone except someone debugging ffmpeg itself.
    lines = [re.sub(r"^\[[^\]]+\]\s*", "", ln).strip()
             for ln in tail.splitlines() if ln.strip()]
    if not lines:
        return None
    for ln in lines:
        low = ln.lower()
        if any(c in low for c in _CAUSES):
            return ln[:limit]
    return lines[-1][:limit]


def build_args(cfg, paths):
    outs = resolve_outputs(cfg)
    kbps = clamp_bitrate(cfg.get("bitrate_kbps"))
    br = f"{kbps}k"
    seg = int(cfg.get("segment_seconds") or 4)

    args = ["-hide_banner", "-loglevel", "warning", "-nostdin"]
    args += input_args(cfg.get("protocol", ""), cfg["url"])

    if outs["hls"]:
        args += [
            "-map", "0:a:0", "-c:a", "aac", "-b:a", br, "-ac", "2",
            "-f", "hls", "-hls_time", str(seg), "-hls_list_size", "0",
            "-hls_flags", "program_date_time+independent_segments",
            "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
            "-hls_segment_filename", os.path.join(paths["audio"], "seg_%05d.m4s"),
            os.path.join(paths["audio"], "index.m3u8"),
        ]
    if outs["dash"]:
        args += [
            "-map", "0:a:0", "-c:a", "aac", "-b:a", br, "-ac", "2",
            "-f", "dash", "-seg_duration", str(seg), "-streaming", "1",
            "-window_size", "20", "-extra_window_size", "10", "-remove_at_exit", "0",
            os.path.join(paths["dash"], "manifest.mpd"),
        ]
    if outs["mp3"]:
        if is_mp3_copy(cfg):
            args += ["-map", "0:a:0", "-c:a", "copy"]
        else:
            args += ["-map", "0:a:0", "-c:a", "libmp3lame", "-b:a", br, "-ac", "2"]
        ice = cfg.get("icecast")
        if not ice:
            # There is no relay to push to, and this container has nobody to
            # pipe stdout to either. Refuse rather than silently run a station
            # whose MP3 goes nowhere.
            die("mp3 output is on but no icecast relay is configured")
        if ice.get("station_name"):
            args += ["-ice_name", str(ice["station_name"])]
        if ice.get("description"):
            args += ["-ice_description", str(ice["description"])]
        if ice.get("genre"):
            args += ["-ice_genre", str(ice["genre"])]
        args += ["-ice_public", "1", "-content_type", "audio/mpeg"]
        args += ["-f", "mp3", icecast_url(ice)]
    return args


# ---------------------------------------------------------------------------
# Output layout — identical to a television run, on purpose.
# ---------------------------------------------------------------------------
def resolve_paths(cfg):
    out = cfg.get("output") or {}
    if is_local(cfg):
        base = os.path.abspath(out.get("dir") or os.environ.get("OUTPUT_DIR") or
                               os.path.join(WORK_DIR, "origin", cfg["channel_id"]))
    else:
        base = os.path.join(WORK_DIR, "out")
    run_id = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    run = os.path.join(base, "runs", run_id)
    paths = {"base": base, "run": run,
             "audio": os.path.join(run, "audio"),
             "dash": os.path.join(run, "dash"),
             "run_id": run_id}
    os.makedirs(paths["audio"], exist_ok=True)
    if resolve_outputs(cfg)["dash"]:
        os.makedirs(paths["dash"], exist_ok=True)
    return paths


def start_uploader(cfg, local_dir):
    s3 = cfg["s3"]
    prefix = str(s3.get("prefix") or cfg["channel_id"]).rstrip("/")
    dest = f"s3://{s3['bucket']}/{prefix}/"
    cmd = ["/app/bin/s3-uploader.sh", local_dir, dest,
           str(cfg.get("upload_interval_seconds", 2))]
    log(f"mirroring {local_dir} -> {dest}")
    return subprocess.Popen(cmd)


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
def shutdown(signum, _frame):
    """SIGTERM is how the launcher stops a station. Bring ffmpeg down first so
    the last segments and the closing manifest are written, then let the
    uploader do its final sync."""
    global _stopping
    if _stopping:
        return
    _stopping = True
    log(f"signal {signum} received, stopping")
    if _events:
        _events.channel_stop(reason="stopped by launcher")
    # ESCALATE WELL INSIDE THE STOP GRACE.
    #
    # ffmpeg pushing to a relay does not always go on the first SIGTERM, and
    # waiting the full ten seconds for it put this right on Docker's default
    # stop timeout: the container was killed as often as it exited, so the
    # recorded exit code was 137 rather than 0 and an orchestrator could not
    # tell an ordinary stop from a crash. Give it a real chance, then insist,
    # and be finished with several seconds to spare.
    TERM_GRACE = 5.0
    KILL_GRACE = 3.0
    for p in (_proc, _uploader):
        if p and p.poll() is None:
            try:
                p.terminate()
            except Exception:
                pass
    for p in (_proc, _uploader):
        if not p:
            continue
        try:
            p.wait(timeout=TERM_GRACE)
        except Exception:
            log("child did not stop on SIGTERM; killing it")
            try:
                p.kill()
                p.wait(timeout=KILL_GRACE)
            except Exception:
                pass


def main():
    global _proc, _uploader, _events
    cfg = load_config()
    outs = resolve_outputs(cfg)

    # Probe here rather than in the control plane: the container is the thing
    # that can actually reach the source, and on ECS the control plane often
    # cannot.
    if "source_codec" not in cfg:
        cfg["source_codec"] = probe_audio_codec(cfg["url"])
    log(f"source codec: {cfg['source_codec'] or 'unknown'} "
        f"({'copy' if is_mp3_copy(cfg) else 're-encode'} for mp3)")

    paths = resolve_paths(cfg)
    if outs["hls"]:
        with open(os.path.join(paths["run"], "master.m3u8"), "w") as fh:
            fh.write(master_playlist(cfg.get("bitrate_kbps")))
    # The live pointer: /origin/<id>/live/... resolves through this, so player
    # and share URLs survive a restart.
    with open(os.path.join(paths["base"], "current_run.txt"), "w") as fh:
        fh.write(paths["run_id"])

    report = cfg.get("status_report") or {}
    _events = EventLog(cfg["channel_id"], now_ms,
                       report_url=report.get("url"),
                       report_token=report.get("token"),
                       status_path=os.path.join(paths["run"], "status.json"),
                       emit=log)

    # ---- the relay preflight -------------------------------------------
    #
    # Dropped from THIS RUN's config, before build_args sees it, so the argv
    # builder stays a pure function of the config and keeps its parity with
    # services/radio/args.ts. Given the same config both still produce the same
    # arguments; what changed is the config.
    #
    # The station is degraded, not failed: HLS and DASH go out, MP3 does not,
    # and the control plane is told so explicitly rather than being left to
    # infer it from silence.
    ice = cfg.get("icecast")
    if outs["mp3"] and ice and not relay_reachable(ice):
        log(f"MP3 relay unreachable at {ice.get('host')}:{ice.get('port')} — "
            f"going on air over HLS/DASH without it")
        cfg.setdefault("outputs", {})["mp3"] = False
        outs = resolve_outputs(cfg)
        # Carry the ADDRESS into the reason. "mp3 relay unreachable" is true and
        # useless: it names a component the operator may not know exists and
        # gives them nowhere to go. The host and port are the whole diagnosis,
        # and by the time anybody reads the event the container is gone.
        _relay_down = f"no Icecast relay listening at {ice.get('host')}:{ice.get('port')}"
        ice = None
    else:
        _relay_down = False

    args = build_args(cfg, paths)
    log(f"run {paths['run_id']} -> {paths['run']}")
    if ice:
        log(f"mp3 -> {redact_icecast_url(ice)}")

    # A station with NO outputs left is a real failure and must not pretend to
    # be on air. This can only happen if mp3 was the only output configured.
    if not (outs["hls"] or outs["dash"] or outs["mp3"]):
        die("no outputs remain: mp3 was the only one configured and the relay "
            "is unreachable")

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    logf = open(os.path.join(paths["run"], "radio.log"), "ab")
    _proc = subprocess.Popen(["ffmpeg"] + args, stdout=subprocess.DEVNULL, stderr=logf)

    if not is_local(cfg):
        _uploader = start_uploader(cfg, paths["run"])

    _events.channel_start(workflow="package" if is_mp3_copy(cfg) else "transcode",
                          renditions=1)
    if _relay_down:
        # Reported as an input/output fault rather than swallowed. An operator
        # looking at a station whose MP3 URL 404s needs to find the reason here
        # rather than in a log file on a container that has since been replaced.
        # MP3 IS THE ONLY OUTPUT THAT NEEDS A SECOND PIECE OF INFRASTRUCTURE.
        #
        # HLS and DASH are files this process writes to the origin. MP3 is a
        # live PUSH to an Icecast relay, so it is the one output that can be
        # missing while the station is otherwise perfectly healthy — and it is
        # missing for a reason that has nothing to do with the source. A station
        # whose source is already MP3 would COPY those bytes to the relay for
        # almost no CPU at all, and it is still the output that goes first,
        # because copying costs nothing and having somewhere to copy TO costs a
        # running relay.
        _events.event("output.degraded", output="mp3", reason=_relay_down)
    # SOURCE UP IS A CLAIM, AND IT NEEDS EVIDENCE.
    #
    # This used to fire the instant Popen returned, which is a statement about
    # having launched ffmpeg rather than about the source. A station whose
    # hostname does not resolve reported "source.up" and then died 37ms later,
    # so the console showed a healthy source for a stream that never had one,
    # and every restart flickered it green again. That is the single reason an
    # operator watching a broken station saw no error.
    #
    # The evidence that a source is up is a segment on disk. Nothing else in
    # this pipeline proves audio actually arrived and was packaged.
    def watch_for_first_segment():
        global _said_up
        # AN MP3-ONLY STATION WRITES NOTHING TO DISK. Its audio goes straight to
        # the relay, so there is no segment to wait for and the only evidence
        # available is that ffmpeg is still alive with its outputs open, which
        # it would not be if the source had failed: a bad input kills it inside
        # a second. Waiting a few of them is weaker evidence than a segment, and
        # it is the strongest this configuration has.
        dirs = []
        if outs.get("hls") and paths.get("audio"):
            dirs.append(paths["audio"])
        if outs.get("dash") and paths.get("dash"):
            dirs.append(paths["dash"])
        deadline = time.time() + 5 if not dirs else None
        while not _stopping and _proc and _proc.poll() is None:
            for d in dirs:
                try:
                    if any(f.endswith(".m4s") for f in os.listdir(d)):
                        _said_up = True
                        _events.source_state("primary", up=True)
                        _events.packager(True)
                        return True
                except OSError:
                    pass
            if deadline is not None and time.time() >= deadline:
                _said_up = True
                _events.source_state("primary", up=True)
                _events.packager(True)
                return True
            time.sleep(0.25)
        return False

    # Heartbeat: the control plane's five-gate model reads report freshness, so
    # silence has to mean something is wrong rather than something is quiet. It
    # only starts once there is something to be healthy ABOUT, so a station that
    # never produced a segment never sends a reassuring packager.up either.
    def beat():
        if not watch_for_first_segment():
            return
        while not _stopping and _proc and _proc.poll() is None:
            time.sleep(10)
            if not _stopping:
                _events.packager(True)
    threading.Thread(target=beat, daemon=True).start()

    rc = _proc.wait()
    if not _stopping:
        # A CLEAN END IS NOT A FAULT, and the two must not be reported the same
        # way. rc=0 means the source went away or the stream finished, which is
        # what a station whose upstream shuts down for the night looks like;
        # anything else is a real failure. Reporting both as errors is the exact
        # mistake the in-process pipeline used to make in the other direction,
        # and an operator who is told everything is an error stops reading.
        #
        # Either way the container exits and the control plane reaps on
        # liveness rather than on a message from us, so a dead station cannot
        # hide by staying quiet.
        if rc == 0:
            log("ffmpeg finished cleanly (source ended)")
            if _said_up:
                _events.source_state("primary", up=False)
            _events.channel_stop(reason="source ended (rc=0)")
        else:
            hint = failure_hint(os.path.join(paths["run"], "radio.log"))
            log(f"ffmpeg exited unexpectedly (rc={rc})"
                + (f": {hint}" if hint else ""))
            if _said_up:
                _events.source_state("primary", up=False)
            # The reason travels with the event so it survives the container.
            # An operator reading "encoder exited rc=251" has to go and find a
            # log file that no longer exists; reading "encoder exited rc=251:
            # Failed to resolve hostname ice5.somafm.com" they already know it
            # is DNS and not the station.
            _events.channel_stop(
                reason=f"encoder exited rc={rc}" + (f": {hint}" if hint else ""))
        if _uploader and _uploader.poll() is None:
            _uploader.terminate()
            try:
                _uploader.wait(timeout=15)
            except Exception:
                _uploader.kill()
    logf.close()
    return 0 if rc == 0 or _stopping else rc


if __name__ == "__main__":
    # FLUSH ON THE WAY OUT, ALWAYS.
    #
    # Reports go out on daemon threads so the media path never waits for the
    # control plane, and daemon threads die with the interpreter. Anything
    # emitted in the last moments of a run -- source.down, packager.down, the
    # closing status snapshot -- was therefore posted into a thread that was
    # destroyed a microsecond later. channel_stop no longer relies on this (it
    # posts synchronously, because it is the one whose loss made a dead station
    # look like a starting one), but its neighbours still do.
    #
    # `finally` and not just the happy path: a station that dies of an unhandled
    # exception is exactly when somebody needs the last thing it said.
    _rc = 1
    try:
        _rc = main()
    finally:
        if _events:
            try:
                _events.flush(timeout=5.0)
            except Exception:
                pass
    sys.exit(_rc)
