#!/usr/bin/env python3
"""
Volt source-selector — optional input failover + filler-on-loss.

Only used when a channel/event has redundancy.input_failover on. It sits
BETWEEN the network sources and the packager/encoder, and guarantees the
output never stalls:

    primary group  ---relay--->  udp 21000+i  \
    backup group   ---relay--->  udp 22000+i   >--[forwarder i]--> udp 20000+i (BUS, Shaka reads)
    filler         ---encode-->  udp 23000+i  /

Design principles
-----------------
* Everything reaches the packager as an ordinary TS on the BUS. There is ONE
  timeline through Shaka, so segment numbering stays continuous no matter which
  group is live — Shaka is the single continuity engine. The switch happens
  UPSTREAM of it.
* A "group" (primary / backup) is the WHOLE ladder. All renditions switch
  together — you never run 1080p on primary while 720p is on backup, or ABR
  alignment breaks. So health and failover are decided per GROUP, not per
  rendition: a group is healthy only when ALL its renditions are flowing.
* Candidate relays for every group run continuously to their own private ports;
  a per-rendition forwarder copies the ACTIVE group's private port to the bus.
  Switching = repoint the forwarders (fast, local UDP — no network handshake),
  so the gap is sub-second and absorbed by the player/DVR buffer. Because the
  ingest spec requires primary+backup to be time-aligned, a primary<->backup
  switch is near-seamless; a live<->filler switch may cost one segment.

The pure logic (Health, SelectorPolicy) takes an injected clock so it is fully
unit-testable; the process orchestration (SourceSelector) wraps it.
"""

import json
import os
import subprocess
import threading
import time

import gop_align
import ingest_args

BUS_BASE = 20000
PRIV_BASE = {"primary": 21000, "backup": 22000, "filler": 23000}
# Transcode failover: the selector feeds ONE chosen source to this port and the
# transcoder reads it (instead of the raw input URL), so a switch happens upstream of
# the encoder and the ladder it produces stays continuous.
SOURCE_FEED_PORT = 20500


# ---------------------------------------------------------------------------
# Pure logic — deterministic, injectable clock, no side effects.
# ---------------------------------------------------------------------------
class Health:
    """Debounce a noisy per-source liveness signal into up/down with
    hysteresis, so a brief blip doesn't trigger a failover and a flapping
    source doesn't oscillate. `sample(now, raw_alive)` returns the debounced
    state; `raw_alive` is 'the relay is running AND its output_time advanced
    since the last sample'."""

    def __init__(self, up_hold=3.0, down_hold=2.0, start_up=False):
        self.up_hold = up_hold
        self.down_hold = down_hold
        self.state = "up" if start_up else "down"
        self._alive_since = None
        self._dead_since = None

    def sample(self, now, raw_alive):
        if raw_alive:
            self._dead_since = None
            if self._alive_since is None:
                self._alive_since = now
            if self.state == "down" and (now - self._alive_since) >= self.up_hold:
                self.state = "up"
        else:
            self._alive_since = None
            if self._dead_since is None:
                self._dead_since = now
            if self.state == "up" and (now - self._dead_since) >= self.down_hold:
                self.state = "down"
        return self.state


class SelectorPolicy:
    """Decide the active source group. Priority is primary > backup > filler.

    Rules:
      * If the current source is DOWN, switch immediately to the best available
        (a lost source is never worth waiting on).
      * If the current source is UP, only ever move for a failback to primary,
        and only when auto_failback is on and primary has been healthy for
        failback_hold seconds (avoids bouncing back onto a still-flaky primary).
      * Filler is never a resting choice while any live group is up.
    """

    def __init__(self, has_backup, auto_failback=True, failback_hold=10.0,
                 start="primary"):
        self.has_backup = has_backup
        self.auto_failback = auto_failback
        self.failback_hold = failback_hold
        self.active = start
        self._primary_up_since = None

    def _best_available(self, primary_up, backup_up):
        if primary_up:
            return "primary"
        if self.has_backup and backup_up:
            return "backup"
        return "filler"

    def decide(self, now, primary_up, backup_up):
        # Track how long primary has been continuously up (for failback hold).
        if primary_up:
            if self._primary_up_since is None:
                self._primary_up_since = now
        else:
            self._primary_up_since = None

        active_up = (
            (self.active == "primary" and primary_up)
            or (self.active == "backup" and backup_up)
            # filler is a synthetic source: treat as "never healthy" so we
            # leave it the instant a real source returns.
        )

        if not active_up:
            self.active = self._best_available(primary_up, backup_up)
            return self.active

        # Current source is healthy — the only move is a failback to primary.
        if (self.active == "backup" and primary_up and self.auto_failback
                and self._primary_up_since is not None
                and (now - self._primary_up_since) >= self.failback_hold):
            self.active = "primary"
        return self.active


# ---------------------------------------------------------------------------
# Command builders — pure functions, unit-testable without spawning anything.
# ---------------------------------------------------------------------------
def _priv_url(group, idx):
    # private ports are only ever touched by ffmpeg (relay writes, forwarder
    # reads), so ffmpeg-specific options are fine here.
    return f"udp://127.0.0.1:{PRIV_BASE[group] + idx}?pkt_size=1316&overrun_nonfatal=1"


def _bus_url(idx, bus_base=BUS_BASE):
    # the bus is read by Shaka Packager (package_only) or by the transcoder (transcode,
    # single source feed) — use only reader-compatible UDP options (reuse/buffer_size),
    # never ffmpeg's pkt_size, or Shaka rejects the input.
    return f"udp://127.0.0.1:{bus_base + idx}?reuse=1&buffer_size=2097152"


def relay_cmd(inp, group, idx, progress_url):
    """Pull one source (SRT/RTMP/HLS) and re-mux to its private TS port, no re-encode.
    `-progress` lets the poller watch out_time for liveness.

    Two things make the relay's liveness signal trustworthy:
      * `_edge_flags` (pre-computed by the parent for HLS) start the pull at the LIVE EDGE
        of the source playlist, not segment 0 of a bounded DVR window.
      * `-re` paces a pull-based source (HLS/HTTP) to realtime. Without it a `-c copy` pull
        reads a whole segment at once then idles, so out_time stair-steps: it jumps by a
        segment then sits flat for ~a segment interval. The health poller reads that flat
        stretch as 'source stopped' and flaps to filler every segment. `-re` makes out_time
        advance ~1x, so it only stops advancing when the source ACTUALLY stops. Push
        protocols (SRT/RTMP) already arrive at realtime, so they are left unpaced."""
    proto = inp["protocol"].lower()
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
           "-progress", progress_url]
    cmd += inp.get("_edge_flags") or ["-fflags", "+genpts"]
    if proto in ("hls", "http", "https") or inp.get("_pace"):
        cmd += ["-re"]
    if proto in ("hls", "http", "https"):
        cmd += ["-i", inp["url"]]
    else:
        # SRT / RTMP / DASH / NDI / ST 2110 with their settings (ingest_args.py)
        cmd += ingest_args.open_args(inp, os.environ.get("WORK_DIR", "/work"), idx=idx, env=os.environ)
    if ingest_args.needs_encode(inp):
        # uncompressed sources are encoded once to the rendition, not copied
        cmd += ingest_args.encode_rendition_args(inp) + ["-f", "mpegts", _priv_url(group, idx)]
        return cmd
    # EXPLICIT stream selection: a multi-variant master lists every rendition's streams
    # and ffmpeg probes them all (printing 'could not find codec parameters' for the
    # ones it never downloads). Map the first video + first audio deterministically so
    # the relay's choice never depends on probe luck.
    cmd += ["-map", "0:v:0", "-map", "0:a:0?"]
    cmd += ["-c", "copy",
            # Start the timeline at the first frame, not 1.4 s in (mpegts muxdelay +
            # preload). With the default, keyframes sat 1.44 s off the packager's
            # segment grid, so audio (cut on the grid) and video (cut on keyframes)
            # never shared boundaries, even with segments a whole GOP (gop_align.py).
            "-muxdelay", "0", "-muxpreload", "0", *gop_align.timeline_args(inp),
            "-f", "mpegts", _priv_url(group, idx)]
    return cmd


# ---------------------------------------------------------------------------
# Filler AUDIO must match the source's audio exactly on a package_only channel.
# There the filler's AAC goes straight into Shaka with no transcode between, and
# Shaka cannot change audio configuration mid-stream: a mono or 44.1kHz source
# followed by a stereo 48kHz filler stopped the packager with "Varying audio
# configurations are not supported", which tore the whole channel down at the
# exact moment the filler was meant to save it. The encoder probes the primary
# and passes {sample_rate, channels}; without that we keep the old 48kHz stereo.
# ---------------------------------------------------------------------------
def _audio_shape(audio):
    a = audio or {}
    try:
        sr = int(a.get("sample_rate") or 48000)
    except (TypeError, ValueError):
        sr = 48000
    try:
        ch = int(a.get("channels") or 2)
    except (TypeError, ValueError):
        ch = 2
    return sr, (1 if ch == 1 else 2)


def _anullsrc(audio):
    sr, ch = _audio_shape(audio)
    return f"anullsrc=channel_layout={'mono' if ch == 1 else 'stereo'}:sample_rate={sr}"


def _filler_audio_args(audio):
    sr, ch = _audio_shape(audio)
    return ["-c:a", "aac", "-b:a", "128k", "-ac", str(ch), "-ar", str(sr)]


def filler_slate_cmd(slate_ref, ladder, seg, fps, progress_url, audio=None):
    """Loop a static slate image into a ladder-matched TS per rendition, GOP
    aligned so Shaka can segment filler like any live source. One ffmpeg,
    multiple outputs (one per rendition)."""
    gop = int(seg * fps)
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
           "-progress", progress_url,
           # -re on BOTH inputs: an image loop and anullsrc are infinite and free to
           # read, so unpaced this filler encoded as fast as the CPU allowed for the
           # whole life of the channel (measured: 80 slate segments, 320s of media, in
           # ~50s on air), burning a core next to the live transcode and, once
           # forwarded, pushing the output timeline minutes ahead of the clock.
           "-re", "-framerate", str(fps), "-loop", "1", "-i", slate_ref,
           "-re", "-f", "lavfi", "-i", _anullsrc(audio)]
    for i, r in enumerate(ladder):
        cmd += ["-map", "0:v:0", "-map", "1:a:0",
                "-vf", f"scale=-2:{r['height']},fps={fps}",
                "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage",
                "-b:v", f"{r['bitrate_kbps']}k",
                "-g", str(gop), "-keyint_min", str(gop), "-sc_threshold", "0",
                "-force_key_frames", f"expr:gte(t,n_forced*{seg})",
                *_filler_audio_args(audio), "-shortest_buf_duration", "0",
                "-f", "mpegts", _priv_url("filler", i)]
    return cmd


def filler_vod_cmd(vod_url, ladder, seg, fps, progress_url, audio=None):
    """Loop a VOD asset into a ladder-matched TS per rendition (same alignment
    as the slate path). `-stream_loop -1` loops forever; `-re` paces to realtime."""
    gop = int(seg * fps)
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
           "-progress", progress_url,
           "-stream_loop", "-1", "-re", "-i", vod_url]
    for i, r in enumerate(ladder):
        cmd += ["-map", "0:v:0", "-map", "0:a:0?",
                "-vf", f"scale=-2:{r['height']},fps={fps}",
                "-c:v", "libx264", "-preset", "veryfast",
                "-b:v", f"{r['bitrate_kbps']}k",
                "-g", str(gop), "-keyint_min", str(gop), "-sc_threshold", "0",
                "-force_key_frames", f"expr:gte(t,n_forced*{seg})",
                *_filler_audio_args(audio),
                "-f", "mpegts", _priv_url("filler", i)]
    return cmd


def filler_motion_slate_cmd(slate_ref, ladder, seg, fps, progress_url, audio=None):
    """Loop a slate image but give it a slow BREATHING ZOOM (a gentle scale in and out)
    so the loop is not a dead-static frame. This is the 'loop made from a slate image'
    option: same ladder-matched, GOP-aligned output as the static slate, plus a subtle
    ~25s zoom cycle via zoompan (z oscillates around 1.06 by +/-0.05). The image is
    pre-upscaled so the zoom stays sharp."""
    gop = int(seg * fps)
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
           "-progress", progress_url,
           # -re on BOTH inputs: an image loop and anullsrc are infinite and free to
           # read, so unpaced this filler encoded as fast as the CPU allowed for the
           # whole life of the channel (measured: 80 slate segments, 320s of media, in
           # ~50s on air), burning a core next to the live transcode and, once
           # forwarded, pushing the output timeline minutes ahead of the clock.
           "-re", "-framerate", str(fps), "-loop", "1", "-i", slate_ref,
           "-re", "-f", "lavfi", "-i", _anullsrc(audio)]
    for i, r in enumerate(ladder):
        h = int(r["height"]); w = (int(round(h * 16 / 9)) // 2) * 2
        period = max(1, int(fps * 4))   # ~25s breath at typical fps
        vf = (f"scale={w * 2}:{h * 2},"
              f"zoompan=z='1.06+0.05*sin(on/{period})':d=1:"
              f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={w}x{h}:fps={fps}")
        cmd += ["-map", "0:v:0", "-map", "1:a:0",
                "-vf", vf,
                "-c:v", "libx264", "-preset", "veryfast",
                "-b:v", f"{r['bitrate_kbps']}k",
                "-g", str(gop), "-keyint_min", str(gop), "-sc_threshold", "0",
                "-force_key_frames", f"expr:gte(t,n_forced*{seg})",
                *_filler_audio_args(audio),
                "-f", "mpegts", _priv_url("filler", i)]
    return cmd


def forwarder_cmd(group, idx, bus_base=BUS_BASE):
    """Copy the active group's private TS to the bus port the reader consumes (Shaka for
    package_only, the transcoder for transcode). No re-encode.

    -copyts IS THE POINT (24 Oct 2026). A forwarder is spawned fresh on every switch,
    and without it ffmpeg starts each one's output at zero. The packager then saw the
    timeline jump back by the whole uptime on every failback ("audio segment 29 starts
    99.64s before the previous one ends") and the delivered stream went back in time.
    genpts, which this used to rely on, only fills in MISSING timestamps; it never kept
    anything monotonic. With -copyts the bus carries the relay's own clock (the
    source's, see gop_align.timeline_args), which kept running while we were away, so a
    failback is a step FORWARD over the gap the filler covered."""
    return ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
            "-fflags", "+genpts+nobuffer", "-flags", "low_delay",
            # SHORT PROBE: a forwarder is spawned fresh on every switch, and with
            # ffmpeg's default 5s analyse window that is 5s of nothing on the bus
            # after the decision was already made. The private port is our own
            # relay/filler output (one H.264 + one AAC, PAT/PMT every packet burst),
            # so 1s is ample to see both streams.
            "-analyzeduration", "1000000", "-probesize", "1000000",
            "-i", _priv_url(group, idx),
            "-c", "copy", "-copyts", "-muxdelay", "0", "-muxpreload", "0",
            "-f", "mpegts", _bus_url(idx, bus_base)]


# ---------------------------------------------------------------------------
# Orchestration — process management around the pure logic above.
# ---------------------------------------------------------------------------
class _PlaylistWatcher:
    """Is a live HLS source's PLAYLIST still advancing?

    Relay byte-flow alone cannot answer that: a dead origin behind a CDN keeps serving
    the STALE playlist, and a (re)spawned relay happily replays the old window, so the
    source read 'up' while actually looping stale content. The truth for live HLS is
    that the playlist document keeps CHANGING. Poll it cheaply, hash it, and call the
    source advancing only while the hash keeps moving (stale_after covers sources with
    long segments, e.g. 10s Wowza chunklists)."""

    def __init__(self, url, interval=4.0, stale_after=15.0):
        self.url = url
        self.interval = interval
        self.stale_after = stale_after
        self._last_hash = None
        self._last_change = None
        self._last_poll = 0.0

    def advancing(self, now):
        if now - self._last_poll >= self.interval:
            self._last_poll = now
            try:
                import hashlib
                import urllib.request
                req = urllib.request.Request(self.url, headers={"User-Agent": "volt-selector/1.0"})
                body = urllib.request.urlopen(req, timeout=3).read()
                h = hashlib.sha1(body).hexdigest()
                if h != self._last_hash:
                    self._last_hash = h
                    self._last_change = now
            except Exception:  # noqa: BLE001
                pass  # unreachable playlist: _last_change ages out below
        return self._last_change is not None and (now - self._last_change) < self.stale_after


def read_out_time(path):
    """Seconds of output an ffmpeg -progress file last reported (excludes any
    -output_ts_offset), or None."""
    try:
        with open(path) as fh:
            data = fh.read()
    except OSError:
        return None
    out = None
    for line in data.splitlines():
        if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
            v = line.split("=", 1)[1].strip()
            if v.isdigit():
                out = int(v)
    return None if out is None else out / 1_000_000


def continue_offset(prev_offset, out_time, gone_s, seg):
    """Where a respawned relay's timeline starts: past the end of the last one,
    plus the wall-clock time nothing was arriving, rounded UP to whole segments
    so its first keyframe is on the packager's grid. Never backwards."""
    end = float(prev_offset or 0.0) + max(0.0, float(out_time or 0.0)) + max(0.0, float(gone_s or 0.0))
    seg = float(seg or 0) or 4.0
    import math
    return round(math.ceil(end / seg + 1e-9) * seg, 6)


class _ProgressWatcher:
    """Tail an ffmpeg `-progress` stream (written to a file we poll) and report
    whether out_time advanced since the last check == the source is alive."""

    def __init__(self, path):
        self.path = path
        self._last_out = -1

    def raw_alive(self):
        try:
            with open(self.path) as fh:
                data = fh.read()
        except OSError:
            return False
        out = None
        for line in data.splitlines():
            if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
                v = line.split("=", 1)[1].strip()
                if v.isdigit():
                    out = int(v)
        if out is None:
            return False
        advanced = out > self._last_out
        self._last_out = out
        return advanced


class SourceSelector:
    """Owns the bus ports Shaka reads. Runs candidate relays + filler, drives
    per-rendition forwarders, and switches the active group per SelectorPolicy.
    `on_log` is the parent's logger; `spawn`/`terminate` are injected so this
    is testable and shares the parent's child registry."""

    def __init__(self, cfg, ladder, primary, backup, spawn, log, work_dir="/work",
                 tick=1.0, event_log=None, control_dir=None, bus_base=BUS_BASE):
        self.cfg = cfg
        self.ladder = ladder            # [{height,bitrate_kbps}] — rendition shape
        # Where the active source is delivered: Shaka's per-rendition bus (package_only)
        # or the single transcoder feed port (transcode single-source failover).
        self.bus_base = bus_base
        self.primary = primary          # list of primary-role inputs
        self.backup = backup            # list of backup-role inputs (may be empty)
        self.spawn = spawn
        self.log = log
        self.events = event_log         # EventLog | None (status + failover events)
        self.work_dir = work_dir
        self.tick = tick
        self._last_group_up = {"primary": None, "backup": None}
        # MANUAL FAILOVER TEST: the control plane can drop a small JSON file here to force
        # a failover for pre-on-air validation (force slate / loop / backup / simulate a
        # primary loss), then clear it to resume health-driven behaviour. We poll it each
        # tick. control_dir defaults to the output dir so the control plane (which serves
        # that dir) can write it without a live control channel to the encoder.
        self.control_path = os.path.join(control_dir or work_dir, "_failover_control.json")
        self._override = "auto"
        self._filler_proc = None        # current filler ffmpeg (so we can swap slate<->loop)
        self._filler_kind = None

        red = cfg.get("redundancy", {})
        self.auto_failback = red.get("auto_failback", True)
        self.loss_behavior = red.get("input_loss_behavior", "slate")
        # MANIFEST FILLER: the loop is spliced into the delivered playlists (playout.py)
        # from a pre-built, ladder-matched package, so the selector runs NO filler
        # encoder and forwards nothing on total loss. That removes a full extra encode
        # that ran for the whole life of every failover channel, and on package_only it
        # is the only filler the packager survives (it cannot take a stream whose codec
        # configuration differs from the source's).
        self.manifest_filler = bool(red.get("filler_via_manifest"))
        self.filler = red.get("filler", {}) or {}
        # STARTUP GRACE: at channel start every source is 'down' simply because the relays
        # have not connected yet. Failing over to filler (and reporting source.down) in that
        # window is wrong twice over: the operator sees a scary INPUT ERROR on every start,
        # and the output opens with filler frames then lurches to the primary. So until a
        # source has been up ONCE, or the grace expires, we hold on the primary quietly.
        # A real dead source still engages the filler once the grace runs out.
        self.start_grace = float(red.get("start_grace_sec", 20.0))
        # LOSS DETECTION TIME is the biggest part of what a viewer sees on a failover.
        # Measured on a transcode channel with HLS sources: 5.0s here made a total of
        # ~9s from the source dying to the switch (the relay plays out what it already
        # buffered first), and 16s without new segments at the output, longer than a
        # player's live buffer, so viewers stalled. 3.0s still rides over the pacing
        # jitter the 5.0 was protecting against (-progress reports every 0.5s and the
        # relays are -re paced), and is configurable per channel.
        self.down_hold = float(red.get("loss_detect_sec", 3.0))
        self._started = None            # set in start()
        self._ever_up = {"primary": False, "backup": False}

        self.n = len(ladder)
        self._forwarders = {}           # idx -> Popen
        self._watch = {"primary": [], "backup": [], "filler": []}
        # down_hold has margin over a single segment fetch: even with -re pacing the relay,
        # network jitter can briefly pause out_time between segments, and we must not read
        # that as a loss and flap to filler. A genuine total loss still trips within ~5s and
        # the player/DVR buffer covers the gap.
        self.health = {
            "primary": Health(up_hold=3.0, down_hold=self.down_hold, start_up=False),
            "backup": Health(up_hold=3.0, down_hold=self.down_hold, start_up=False),
        }
        self.policy = SelectorPolicy(
            has_backup=bool(backup), auto_failback=self.auto_failback, start="primary")
        self.active = "primary"
        self._stop = threading.Event()
        self._thread = None

    # -- process wiring -----------------------------------------------------
    def _progress_path(self, group, idx=0):
        return f"{self.work_dir}/progress-{group}-{idx}.txt"

    def start(self):
        # candidate relays (primary + backup), one per rendition. Handles + specs are
        # KEPT so a dead relay can be respawned: an HLS source that 404s for a while
        # kills its relay ffmpeg, and without respawn the source could come back with
        # nothing listening — primary read 'down' forever and recovery never happened.
        self._relay_specs = []           # (group, idx, inp, progress_path)
        self._relay_procs = {}           # (group, idx) -> Popen
        self._relay_retry = {}           # (group, idx) -> last respawn monotonic
        self._plwatch = {"primary": [], "backup": []}
        for group, inputs in (("primary", self.primary), ("backup", self.backup)):
            for i, inp in enumerate(inputs):
                pp = self._progress_path(group, i)
                self._relay_specs.append((group, i, inp, pp))
                self._relay_procs[(group, i)] = self.spawn(
                    f"relay:{group}:{i}", relay_cmd(inp, group, i, pp))
                self._watch[group].append(_ProgressWatcher(pp))
                # pull sources: also require the source PLAYLIST itself to advance, or a
                # stale CDN cache + relay respawns would read as a healthy source
                if (inp.get("protocol") or "").lower() in ("hls", "http", "https"):
                    self._plwatch[group].append(_PlaylistWatcher(inp["url"]))

        # filler (one ffmpeg, all renditions) — slate (static) or loop. The loop is
        # either an uploaded video, or the slate image with a gentle breathing zoom.
        if self.loss_behavior in ("slate", "vod_loop") and self.manifest_filler:
            self._filler_proc = None
            if self.events:
                self.events.filler_ready(True)
        elif self.loss_behavior in ("slate", "vod_loop"):
            self._filler_proc = self.spawn("filler", self._filler_cmd(
                "loop" if self.loss_behavior == "vod_loop" else "slate"))
            if self.events:
                self.events.filler_ready(True)

        # forwarders point at primary to begin with
        for i in range(self.n):
            self._start_forwarder(i, "primary")

        self._started = time.monotonic()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _in_start_grace(self, now):
        """True while we are still waiting for the FIRST sign of life from any source."""
        return (self._started is not None
                and (now - self._started) < self.start_grace
                and not any(self._ever_up.values()))

    def _start_forwarder(self, idx, group):
        if group == "filler" and self.manifest_filler:
            self._forwarders[idx] = None    # nothing to forward: the playlists carry the loop
            return
        self._forwarders[idx] = self.spawn(
            f"fwd:{idx}<-{group}", forwarder_cmd(group, idx, self.bus_base))

    def _switch(self, new_group, reason="source_change"):
        self.log(f"source-selector: switching {self.active} -> {new_group} ({reason})")
        old = self.active
        for idx in range(self.n):
            fwd = self._forwarders.get(idx)
            if fwd and fwd.poll() is None:
                fwd.terminate()
        for idx in range(self.n):
            self._start_forwarder(idx, new_group)
        self.active = new_group
        if self.events:
            self.events.switch(old, new_group, reason)

    @staticmethod
    def _switch_reason(old, new):
        if new == "filler":
            return "all_inputs_lost"
        if new == "primary" and old != "primary":
            return "primary_recovered"
        if new == "backup":
            return "primary_lost" if old == "primary" else "primary_unavailable"
        return "source_change"

    # -- manual failover test (pre-on-air validation) -----------------------
    def _read_override(self):
        """Read the failover-test control file, if present. Returns one of:
        'auto' (health-driven, the default), 'primary_down' (pretend primary failed),
        'backup', 'slate', 'loop'. Any read/parse problem falls back to 'auto'."""
        try:
            with open(self.control_path) as fh:
                mode = str((json.load(fh) or {}).get("mode", "auto")).lower()
            return mode if mode in ("auto", "primary_down", "backup", "slate", "loop") else "auto"
        except FileNotFoundError:
            return "auto"
        except Exception:  # noqa: BLE001
            return "auto"

    def _slate_ref(self):
        return self.filler.get("slate_ref", "/app/assets/slate.png")

    def _filler_cmd(self, kind):
        """Build the filler ffmpeg command for the requested kind and record which kind
        actually runs. The loop is an admin choice, resolved deterministically:
          loop  -> an uploaded loop video if provided, else the slate image with a gentle
                   breathing zoom (a loop made from the slate). Never a still frame.
          slate -> the static slate image held on screen.
        The filler is always ladder-matched and GOP-aligned. `_filler_kind` records the
        concrete result ('loop', 'motion_slate' or 'slate') so the UI/logs are clear."""
        pp = self._progress_path("filler", 0)
        seg, fps = self.cfg["segment_seconds"], self.cfg.get("fps", 25)
        if kind == "loop":
            url = self.filler.get("vod_loop_url")
            if url:
                self._filler_kind = "loop"
                return filler_vod_cmd(url, self.ladder, seg, fps, pp, audio=self.filler.get("audio"))
            self._filler_kind = "motion_slate"
            return filler_motion_slate_cmd(self._slate_ref(), self.ladder, seg, fps, pp, audio=self.filler.get("audio"))
        self._filler_kind = "slate"
        return filler_slate_cmd(self._slate_ref(), self.ladder, seg, fps, pp, audio=self.filler.get("audio"))

    def _ensure_filler(self, kind):
        """Make the requested filler kind (slate|loop) the running filler, respawning only
        if it is not already what is running."""
        want = "loop" if kind == "loop" else "slate"
        running_is_loop = self._filler_kind in ("loop", "motion_slate")
        if ((want == "loop" and running_is_loop) or (want == "slate" and self._filler_kind == "slate")) \
                and self._filler_proc and self._filler_proc.poll() is None:
            return
        if self._filler_proc and self._filler_proc.poll() is None:
            try: self._filler_proc.terminate()
            except Exception: pass  # noqa: BLE001
        self._filler_proc = self.spawn("filler", self._filler_cmd(want))

    # -- child resilience ---------------------------------------------------
    def _respawn_dead_children(self, now):
        """Respawn any dead relay/filler/forwarder (with a 5s per-child backoff).
        Children die for environmental reasons (source outage kills a relay, a decode
        error kills the filler); staying dead turned a transient outage into a
        permanent one. Respawning is always safe: relays re-pull the source, the
        filler regenerates, forwarders re-point at the active group's bus port."""
        for group, idx, inp, pp in getattr(self, "_relay_specs", []):
            p = self._relay_procs.get((group, idx))
            if p is not None and p.poll() is None:
                continue
            if now - self._relay_retry.get((group, idx), 0) < 5.0:
                continue
            self._relay_retry[(group, idx)] = now
            # CARRY THE TIMELINE ON. A new relay starts its output at zero; the
            # packager behind the bus must never see time go backwards, so the
            # new one starts where the old one stopped plus the time it was gone.
            try:
                gone = max(0.0, time.time() - os.path.getmtime(pp))
            except OSError:
                gone = 0.0
            # The furthest any relay of this group has got: renditions restarted
            # one at a time must still land on the same clock as their siblings.
            ends = []
            for g2, _i2, inp2, pp2 in self._relay_specs:
                if g2 != group:
                    continue
                try:
                    gone2 = 0.0 if pp2 != pp else max(0.0, time.time() - os.path.getmtime(pp2))
                except OSError:
                    gone2 = 0.0
                ends.append(continue_offset(inp2.get("_ts_offset"), read_out_time(pp2), gone2, self.cfg.get("segment_seconds", 4)))
            inp["_ts_offset"] = max(ends + [continue_offset(inp.get("_ts_offset"), read_out_time(pp), gone, self.cfg.get("segment_seconds", 4))])
            self.log(f"source-selector: relay {group}:{idx} died; respawning (timeline continues at {inp['_ts_offset']:.1f}s)")
            self._relay_procs[(group, idx)] = self.spawn(
                f"relay:{group}:{idx}", relay_cmd(inp, group, idx, pp))
        # filler (only when this channel runs one)
        if self.loss_behavior in ("slate", "vod_loop") and self._filler_proc is not None \
                and self._filler_proc.poll() is not None:
            if now - getattr(self, "_filler_retry", 0) >= 5.0:
                self._filler_retry = now
                self.log("source-selector: filler died; respawning")
                self._filler_proc = self.spawn("filler", self._filler_cmd(
                    "loop" if self._filler_kind in ("loop", "motion_slate") else "slate"))
        # forwarders always point at the ACTIVE group
        for idx, fwd in list(self._forwarders.items()):
            if fwd is not None and fwd.poll() is None:
                continue
            if fwd is None and self.active == "filler" and self.manifest_filler:
                continue
            if now - getattr(self, "_fwd_retry", {}).get(idx, 0) < 5.0:
                continue
            self._fwd_retry = getattr(self, "_fwd_retry", {})
            self._fwd_retry[idx] = now
            self.log(f"source-selector: forwarder {idx} died; respawning -> {self.active}")
            self._start_forwarder(idx, self.active)

    # -- health + decision loop --------------------------------------------
    def _group_alive(self, group, now):
        watchers = self._watch[group]
        if not watchers:
            return False
        # a group is alive only if EVERY rendition relay is advancing AND (for pull
        # sources) every source playlist is still advancing
        raw = all(w.raw_alive() for w in watchers) \
            and all(pw.advancing(now) for pw in getattr(self, "_plwatch", {}).get(group, []))
        up = self.health[group].sample(now, raw) == "up"
        if up:
            self._ever_up[group] = True
        # emit a source.up / source.down event on a real state change — but never a DOWN
        # during the startup grace: 'not connected yet' is not a loss, and reporting it
        # paints an INPUT ERROR on every clean start.
        if self.events and up != self._last_group_up[group]:
            if up or not self._in_start_grace(now):
                self._last_group_up[group] = up
                self.events.source_state(group, up, renditions=len(watchers))
        return up

    def _run(self):
        while not self._stop.is_set():
            now = time.monotonic()
            self._respawn_dead_children(now)
            primary_up = self._group_alive("primary", now)
            backup_up = self._group_alive("backup", now) if self.backup else False

            # MANUAL FAILOVER TEST override (pre-on-air validation). When set, it wins over
            # the health-driven policy so an operator can force each failover path and watch
            # the real output switch, then clear it to resume normal behaviour.
            override = self._read_override()
            if self.manifest_filler and override in ("slate", "loop"):
                # a forced slate/loop is a PLAYOUT action now (the encoder splices the
                # loop into the playlists); the inputs keep flowing so the return is instant
                override = "auto"
            if override != self._override:
                self.log(f"source-selector: failover-test override -> {override}")
                if self.events:
                    self.events.event("failover.test", mode=override)
                self._override = override

            if override in ("slate", "loop"):
                self._ensure_filler(override)
                want = "filler"
                self.policy.active = want  # keep policy state in sync so failback is clean
            elif override == "backup":
                want = "backup" if self.backup else "filler"
                self.policy.active = want
            elif override == "primary_down":
                # pretend the primary group is gone: let the policy pick the best of the rest.
                want = self.policy.decide(now, False, backup_up)
            else:
                want = self.policy.decide(now, primary_up, backup_up)
                # STARTUP GRACE: no source has EVER been up yet, so 'down' just means the
                # relays are still connecting. Hold on the primary rather than opening the
                # broadcast with filler and then lurching to the live feed seconds later.
                if want == "filler" and self._in_start_grace(now):
                    want = self.active
                    self.policy.active = self.active

            if want != self.active:
                # A switch driven by the control file is a manual/test action, not a
                # health failover — record it as such so the log and status reflect WHY.
                reason = (f"manual:{override}" if override in ("slate", "loop", "backup", "primary_down")
                          else self._switch_reason(self.active, want))
                self._switch(want, reason)
            self._stop.wait(self.tick)

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)


if __name__ == "__main__":  # pragma: no cover
    print("source_selector is a library used by encoder.py; nothing to run.")
