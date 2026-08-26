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

BUS_BASE = 20000
PRIV_BASE = {"primary": 21000, "backup": 22000, "filler": 23000}


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


def _bus_url(idx):
    # the bus is read by Shaka Packager — use only Shaka-compatible UDP options
    # (reuse/buffer_size), never ffmpeg's pkt_size, or Shaka rejects the input.
    return f"udp://127.0.0.1:{BUS_BASE + idx}?reuse=1&buffer_size=2097152"


def relay_cmd(inp, group, idx, progress_url):
    """Pull one source (SRT/RTMP/HLS) and re-mux to its private TS port,
    no re-encode. `-progress` lets the poller watch out_time for liveness."""
    proto = inp["protocol"].lower()
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
           "-progress", progress_url, "-fflags", "+genpts"]
    cmd += ["-i", inp["url"]]
    cmd += ["-c", "copy", "-f", "mpegts", _priv_url(group, idx)]
    return cmd


def filler_slate_cmd(slate_ref, ladder, seg, fps, progress_url):
    """Loop a static slate image into a ladder-matched TS per rendition, GOP
    aligned so Shaka can segment filler like any live source. One ffmpeg,
    multiple outputs (one per rendition)."""
    gop = int(seg * fps)
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
           "-progress", progress_url,
           "-loop", "1", "-i", slate_ref,
           "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
    for i, r in enumerate(ladder):
        cmd += ["-map", "0:v:0", "-map", "1:a:0",
                "-vf", f"scale=-2:{r['height']},fps={fps}",
                "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage",
                "-b:v", f"{r['bitrate_kbps']}k",
                "-g", str(gop), "-keyint_min", str(gop), "-sc_threshold", "0",
                "-force_key_frames", f"expr:gte(t,n_forced*{seg})",
                "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-shortest_buf_duration", "0",
                "-f", "mpegts", _priv_url("filler", i)]
    return cmd


def filler_vod_cmd(vod_url, ladder, seg, fps, progress_url):
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
                "-c:a", "aac", "-b:a", "128k", "-ac", "2",
                "-f", "mpegts", _priv_url("filler", i)]
    return cmd


def autoloop_capture_cmd(master_playlist, out_path, seconds):
    """Capture a few seconds of the channel's OWN live output into a short, loopable
    MP4 — the auto-generated loop filler. We read the packaged output playlist at the
    live edge and copy it (no re-encode), so the clip is already at the exact ladder /
    bitrate the channel produces. On total input loss the loop filler replays this
    recent real content instead of a generic slate. faststart makes it seek-friendly
    for looping."""
    return ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-live_start_index", "-1", "-http_persistent", "0",
            "-i", master_playlist,
            "-t", str(seconds), "-c", "copy", "-movflags", "+faststart",
            out_path]


def forwarder_cmd(group, idx):
    """Copy the active group's private TS to the bus port Shaka reads. No
    re-encode; genpts keeps the bus timeline monotonic across a restart."""
    return ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
            "-fflags", "+genpts+nobuffer", "-flags", "low_delay",
            "-i", _priv_url(group, idx),
            "-c", "copy", "-muxdelay", "0", "-muxpreload", "0",
            "-f", "mpegts", _bus_url(idx)]


# ---------------------------------------------------------------------------
# Orchestration — process management around the pure logic above.
# ---------------------------------------------------------------------------
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
                 tick=1.0, event_log=None, control_dir=None):
        self.cfg = cfg
        self.ladder = ladder            # [{height,bitrate_kbps}] — rendition shape
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
        # Auto-generated loop: the encoder captures a few seconds of the real output here.
        # It is preferred over slate for the loop filler when no explicit loop was uploaded.
        self.autoloop_path = os.path.join(control_dir or work_dir, "_autoloop.mp4")

        red = cfg.get("redundancy", {})
        self.auto_failback = red.get("auto_failback", True)
        self.loss_behavior = red.get("input_loss_behavior", "slate")
        self.filler = red.get("filler", {}) or {}

        self.n = len(ladder)
        self._forwarders = {}           # idx -> Popen
        self._watch = {"primary": [], "backup": [], "filler": []}
        self.health = {
            "primary": Health(start_up=False),
            "backup": Health(start_up=False),
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
        # candidate relays (primary + backup), one per rendition
        for group, inputs in (("primary", self.primary), ("backup", self.backup)):
            for i, inp in enumerate(inputs):
                pp = self._progress_path(group, i)
                self.spawn(f"relay:{group}:{i}", relay_cmd(inp, group, i, pp))
                self._watch[group].append(_ProgressWatcher(pp))

        # filler (one ffmpeg, all renditions) — slate or vod_loop
        if self.loss_behavior in ("slate", "vod_loop"):
            pp = self._progress_path("filler", 0)
            loop_src = self._loop_source() if self.loss_behavior == "vod_loop" else None
            if loop_src:
                cmd = filler_vod_cmd(loop_src, self.ladder,
                                     self.cfg["segment_seconds"],
                                     self.cfg.get("fps", 25), pp)
                self._filler_kind = "loop"
            else:
                slate = self.filler.get("slate_ref", "/app/assets/slate.png")
                cmd = filler_slate_cmd(slate, self.ladder,
                                       self.cfg["segment_seconds"],
                                       self.cfg.get("fps", 25), pp)
                self._filler_kind = "slate"
            self._filler_proc = self.spawn("filler", cmd)
            if self.events:
                self.events.filler_ready(True)

        # forwarders point at primary to begin with
        for i in range(self.n):
            self._start_forwarder(i, "primary")

        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _start_forwarder(self, idx, group):
        self._forwarders[idx] = self.spawn(
            f"fwd:{idx}<-{group}", forwarder_cmd(group, idx))

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

    def _loop_source(self):
        """Resolve the loop filler source, in precedence order: an explicitly uploaded
        loop VOD, else the auto-generated loop captured from this channel's own output,
        else None (caller falls back to slate)."""
        url = self.filler.get("vod_loop_url")
        if url:
            return url
        if os.path.exists(self.autoloop_path):
            return self.autoloop_path
        return None

    def _ensure_filler(self, kind):
        """Make the requested filler kind (slate|loop) the running filler, respawning it
        if we currently have the other kind. Falls back to slate if no loop source (an
        uploaded loop or an auto-generated loop) is available yet."""
        loop_src = self._loop_source()
        if kind == "loop" and not loop_src:
            kind = "slate"
        if kind == self._filler_kind and self._filler_proc and self._filler_proc.poll() is None:
            return
        if self._filler_proc and self._filler_proc.poll() is None:
            try: self._filler_proc.terminate()
            except Exception: pass  # noqa: BLE001
        pp = self._progress_path("filler", 0)
        if kind == "loop":
            cmd = filler_vod_cmd(loop_src, self.ladder,
                                 self.cfg["segment_seconds"], self.cfg.get("fps", 25), pp)
        else:
            slate = self.filler.get("slate_ref", "/app/assets/slate.png")
            cmd = filler_slate_cmd(slate, self.ladder, self.cfg["segment_seconds"],
                                   self.cfg.get("fps", 25), pp)
        self._filler_proc = self.spawn("filler", cmd)
        self._filler_kind = kind

    # -- health + decision loop --------------------------------------------
    def _group_alive(self, group, now):
        watchers = self._watch[group]
        if not watchers:
            return False
        # a group is alive only if EVERY rendition relay is advancing
        raw = all(w.raw_alive() for w in watchers)
        up = self.health[group].sample(now, raw) == "up"
        # emit a source.up / source.down event on a real state change
        if self.events and up != self._last_group_up[group]:
            self._last_group_up[group] = up
            self.events.source_state(group, up, renditions=len(watchers))
        return up

    def _run(self):
        while not self._stop.is_set():
            now = time.monotonic()
            primary_up = self._group_alive("primary", now)
            backup_up = self._group_alive("backup", now) if self.backup else False

            # MANUAL FAILOVER TEST override (pre-on-air validation). When set, it wins over
            # the health-driven policy so an operator can force each failover path and watch
            # the real output switch, then clear it to resume normal behaviour.
            override = self._read_override()
            if override != self._override:
                self.log(f"source-selector: failover-test override -> {override}")
                if self.events:
                    self.events.event("failover.test", mode=override)
                self._override = override

            # STANDBY UPGRADE: once the auto-generated loop exists, promote the idle
            # filler from slate to loop so a real total-loss failover shows recent output,
            # not a static card. Only while filler is NOT on air, so there is no blip.
            if (self.loss_behavior == "vod_loop" and self.active != "filler"
                    and self._filler_kind != "loop" and self._loop_source()):
                self._ensure_filler("loop")

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

            if want != self.active:
                self._switch(want, self._switch_reason(self.active, want))
            self._stop.wait(self.tick)

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)


if __name__ == "__main__":  # pragma: no cover
    print("source_selector is a library used by encoder.py; nothing to run.")
