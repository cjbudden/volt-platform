"""Packager log filter: keep Shaka's output useful by summarising one known-harmless warning.

THE WARNING. Shaka prints, once per audio segment:

    representation.cc:435] Representation (id=1,codec='mp4a.40.2',frequency=44100,...)
    Found a gap of size 137 > kRoundingErrorGrace (5). The new segment starts at
    289801084 but the previous segment ends at 289800947.

WHY IT IS HARMLESS (measured on a live run, 17 Oct 2026). Shaka writes audio from
MPEG-TS on a 90 kHz clock. A 1024-sample AAC frame at 44.1 kHz lasts 2089.796
ticks there, but a sample duration must be a whole number, so every frame is
written as 2089. Over ~172 frames per 4 s segment that comes to ~137 ticks
(~1.5 ms) short. The NEXT segment's start time is still the true PTS, so the
shortfall never accumulates and nothing is audible. It is bookkeeping, not
missing audio.

The transcode path now resamples to 48 kHz (ladder_args.audio_track_args), where
a frame is exactly 1920 ticks and the warning cannot occur. It remains possible
on package_only channels whose source audio is 44.1 kHz, which Volt passes
through untouched. That is what this filter is for.

WHAT STAYS VISIBLE. A gap is treated as the rounding case only when it is
positive, smaller than one audio frame, and close to the gaps seen before it.
A gap of a frame or more means samples really are missing, and a gap that
suddenly changes size means something upstream changed. Both are passed through
every time, whatever the mode. Every other packager line passes through as-is.

MODES (channel config `packager_log`, or env VOLT_PACKAGER_LOG):
    summary  (default) first occurrence shown, then one summary line a minute
    all      every line, unfiltered, for troubleshooting
    quiet    individual lines hidden, one summary line every 15 minutes
"""
import re
import statistics
import time

MODES = ("summary", "all", "quiet")
DEFAULT_MODE = "summary"
SUMMARY_INTERVAL = {"summary": 60.0, "quiet": 900.0}

TS_TIMESCALE = 90000          # Shaka's timescale for MPEG-TS input
AAC_FRAME_SAMPLES = 1024
# A gap that moves more than this fraction of a frame away from the recent
# typical gap is reported, not summarised: the pattern has changed.
DRIFT_FRACTION = 0.10

_GAP_RE = re.compile(
    r"Representation \((?P<rep>[^)]*)\) Found a gap of size (?P<gap>-?\d+) > kRoundingErrorGrace")
_FREQ_RE = re.compile(r"frequency=(\d+)")


def resolve_mode(cfg_value=None, env_value=None):
    """Env wins over channel config (handy for a one-off diagnostic run); an
    unknown value falls back to the default rather than failing the channel."""
    for v in (env_value, cfg_value):
        if v and str(v).strip().lower() in MODES:
            return str(v).strip().lower()
    return DEFAULT_MODE


def frame_ticks(frequency):
    """Length of one AAC frame on the 90 kHz clock, e.g. 2089.8 at 44.1 kHz."""
    return AAC_FRAME_SAMPLES * TS_TIMESCALE / float(frequency)


class PackagerLogFilter:
    """Feed it raw packager lines; it returns the lines to write (possibly none)."""

    def __init__(self, mode=DEFAULT_MODE, clock=time.monotonic, prefix="[volt-encoder] packager:"):
        self.mode = mode if mode in MODES else DEFAULT_MODE
        self.clock = clock
        self.prefix = prefix
        self._recent = {}        # rep -> recent benign gaps (for the drift check)
        self._window = {}        # rep -> gaps summarised since the last summary
        self._announced = set()  # reps whose first occurrence was already shown
        self._total = 0
        self._last_summary = clock()

    # -- classification -----------------------------------------------------
    def _is_rounding(self, rep, gap):
        m = _FREQ_RE.search(rep)
        if not m or gap <= 0:
            return False
        frame = frame_ticks(int(m.group(1)))
        if gap >= frame:
            return False                     # at least a whole frame: real loss
        recent = self._recent.get(rep)
        if recent and abs(gap - statistics.median(recent)) > DRIFT_FRACTION * frame:
            return False                     # pattern changed: report it
        return True

    def feed(self, line):
        out = []
        if self.mode != "all":
            m = _GAP_RE.search(line)
            if m:
                rep, gap = m.group("rep"), int(m.group("gap"))
                if self._is_rounding(rep, gap):
                    self._recent.setdefault(rep, []).append(gap)
                    del self._recent[rep][:-20]
                    self._total += 1
                    if self.mode == "summary" and rep not in self._announced:
                        self._announced.add(rep)
                        out.append(line)
                        out.append(f"{self.prefix} the gap above is AAC timestamp rounding "
                                   f"(under one audio frame, nothing missing). Repeats are "
                                   f"summarised; set packager_log=all to see each one.")
                    else:
                        self._window.setdefault(rep, []).append(gap)
                    out.extend(self.tick())
                    return out
                # not the rounding case: fall through and show it
        out.append(line)
        out.extend(self.tick())
        return out

    def tick(self):
        """Emit a summary if one is due. Called on every line and by a timer."""
        interval = SUMMARY_INTERVAL.get(self.mode)
        if not interval or self.clock() - self._last_summary < interval:
            return []
        self._last_summary = self.clock()
        return self.flush()

    def flush(self):
        lines = []
        for rep, gaps in self._window.items():
            if gaps:
                lines.append(f"{self.prefix} {len(gaps)} audio rounding gaps of "
                             f"{min(gaps)}-{max(gaps)} ticks summarised ({rep}), harmless")
        self._window = {}
        return lines

    @property
    def total_summarised(self):
        return self._total
