#!/usr/bin/env python3
"""
Volt stream metrics: what the encoder costs and what it receives, read from
numbers the system already keeps, so measuring adds no load of its own.

  CPU     the kernel's own accounting for this encoder's processes
          (/proc/<pid>/stat utime + stime, for the encoder and every child it
          spawned: relays, transcoder, packager). Shown as a share of the CPU
          this encoder may use: its container's quota when it has one
          (cgroup cpu.max), else the machine's cores. One small read per
          process every heartbeat (ten seconds).

  INGEST  bytes received per input. Every relay ffmpeg already writes a
          -progress file (the failover health watcher reads it every second);
          its total_size is the bytes relayed, which for a -c copy relay is the
          bytes received. Only the last few KB of each file are read. A relay
          that restarts begins again from zero, so totals are carried across.
          A transcode reading its source directly has no relay: inside its own
          container the network interface counters say what arrived (all
          inputs together); outside one there is no honest number and none is
          reported.

A missing reading is None, never 0: "we could not measure" must not look like
"idle". On a machine without /proc (a Mac running the encoder natively) the
CPU is simply absent.

Pure-ish: the clock and the file readers are injectable for tests.
"""

import os
import re
import time

_TAIL = 4096
_TOTAL_RE = re.compile(rb"total_size=(\d+)")


def _read_tail(path, n=_TAIL):
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - n))
            return fh.read()
    except OSError:
        return None


def progress_total_bytes(path):
    """The newest total_size in an ffmpeg -progress file, or None."""
    tail = _read_tail(path)
    if not tail:
        return None
    hits = _TOTAL_RE.findall(tail)
    if not hits:
        return None
    try:
        return int(hits[-1])
    except ValueError:
        return None


def _proc_ticks(pid):
    """utime + stime of one process, in clock ticks, or None."""
    try:
        with open(f"/proc/{pid}/stat", "rb") as fh:
            raw = fh.read().decode("ascii", "replace")
    except OSError:
        return None
    # the command name is in parentheses and may itself contain spaces
    rest = raw[raw.rfind(")") + 2:].split()
    try:
        return int(rest[11]) + int(rest[12])   # fields 14 and 15 of the whole line
    except (IndexError, ValueError):
        return None


def available_cores():
    """The CPU this encoder may use: its cgroup quota, else the machine's cores."""
    try:
        with open("/sys/fs/cgroup/cpu.max") as fh:          # cgroup v2
            q, p = fh.read().split()[:2]
            if q != "max":
                return max(0.01, int(q) / int(p))
    except (OSError, ValueError):
        pass
    try:
        with open("/sys/fs/cgroup/cpu/cpu.cfs_quota_us") as fh:   # cgroup v1
            q = int(fh.read().strip())
        with open("/sys/fs/cgroup/cpu/cpu.cfs_period_us") as fh:
            p = int(fh.read().strip())
        if q > 0 and p > 0:
            return max(0.01, q / p)
    except (OSError, ValueError):
        pass
    return float(os.cpu_count() or 1)


def in_own_container():
    return os.path.exists("/.dockerenv") or bool(os.environ.get("ECS_CONTAINER_METADATA_URI_V4")
                                                 or os.environ.get("ECS_CONTAINER_METADATA_URI"))


def net_rx_bytes():
    """Bytes received on every interface but loopback, or None."""
    try:
        with open("/proc/net/dev") as fh:
            lines = fh.read().splitlines()[2:]
    except OSError:
        return None
    total = 0
    for ln in lines:
        name, _, data = ln.partition(":")
        if name.strip() == "lo":
            continue
        parts = data.split()
        if parts:
            total += int(parts[0])
    return total


class StreamMetrics:
    """Call sample() on the heartbeat; it returns the metrics block for the
    status report. `pids()` lists the encoder's live processes; `inputs()`
    lists (key, role, label, progress_path) for every relay that has one."""

    def __init__(self, pids, inputs, clock=time.monotonic, clk_tck=None,
                 ticks=_proc_ticks, total=progress_total_bytes, rx=net_rx_bytes,
                 cores=available_cores, own_netns=in_own_container):
        self._pids = pids
        self._inputs = inputs
        self._clock = clock
        self._tck = clk_tck or (os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100)
        self._ticks = ticks
        self._total = total
        self._rx = rx
        self._cores = cores
        self._own_netns = own_netns
        self._last_t = None
        self._last_ticks = {}       # pid -> ticks
        self._bytes = {}            # key -> {"raw": last raw total, "base": carried}
        self._last_bytes = {}       # key -> cumulative at the last sample
        self._rx_first = None

    def sample(self):
        now = self._clock()
        dt = (now - self._last_t) if self._last_t is not None else None
        self._last_t = now

        # ---- CPU: positive deltas only (a process that exited takes its time with it)
        used = 0
        seen = {}
        measured = False
        for pid in self._pids():
            t = self._ticks(pid)
            if t is None:
                continue
            measured = True
            seen[pid] = t
            prev = self._last_ticks.get(pid)
            if prev is not None and t >= prev:
                used += t - prev
        self._last_ticks = seen
        cores = self._cores()
        cpu_pct = None
        if measured and dt and dt > 0 and cores:
            cpu_pct = round(min(100.0 * 64, used / self._tck / dt / cores * 100.0), 1)

        # ---- INGEST per input
        ingest = {}
        inputs = list(self._inputs())
        for key, role, label, path in inputs:
            raw = self._total(path)
            if raw is None:
                continue
            st = self._bytes.setdefault(key, {"raw": 0, "base": 0})
            if raw < st["raw"]:          # the relay restarted: carry what it had
                st["base"] += st["raw"]
            st["raw"] = raw
            cum = st["base"] + raw
            prev = self._last_bytes.get(key)
            bps = int((cum - prev) * 8 / dt) if (prev is not None and dt and dt > 0 and cum >= prev) else None
            self._last_bytes[key] = cum
            ingest[key] = {"role": role, "label": label, "bytes": cum, "bps": bps}
        if not inputs and self._own_netns():
            rx = self._rx()
            if rx is not None:
                if self._rx_first is None:
                    self._rx_first = rx
                cum = rx - self._rx_first
                prev = self._last_bytes.get("network")
                bps = int((cum - prev) * 8 / dt) if (prev is not None and dt and dt > 0 and cum >= prev) else None
                self._last_bytes["network"] = cum
                ingest["network"] = {"role": "all", "label": None, "bytes": cum, "bps": bps}

        return {"cpu_pct": cpu_pct, "cpu_cores": round(cores, 2) if cores else None, "ingest": ingest}
