#!/usr/bin/env python3
"""
In-stream graphic triggers, written into the manifests this encoder delivers.

WHY HERE. Viewers fetch playlists from S3 through the CDN; they never pass the
control plane. So the control plane OWNS the schedule and builds the triggers
(volt-app/src/services/graphicTriggers.ts, which also formats the HLS line), and
this encoder, which already rewrites the delivered copies (master_cc.m3u8,
stream_*_cc.m3u8, manifest_cc.mpd) every second, places them:

  HLS   EXT-X-DATERANGE lines in each delivered media playlist's header, chosen
        by the playlist's own PROGRAM-DATE-TIME window.
  DASH  an EventStream per scheme in each Period, presentationTime relative to
        that Period's wall-clock start (availabilityStartTime + Period@start).

FAILS OPEN, ALWAYS. A control plane that cannot be reached means the last good
list for up to ten minutes and then none. A manifest is never withheld, delayed
or broken because of a trigger: every function here returns its input untouched
when anything about it is unexpected.
"""

import json
import re
import threading
import time
import urllib.request
import zlib
from datetime import datetime, timezone

STALE_SEC = 600          # keep the last good list this long when the control plane is away
AHEAD_SEC = 90           # include triggers starting this soon after the window ends
SCHEME_PREFIX = "urn:com:boomlabs:volt:"


_OFFSET = re.compile(r"([+-])(\d{2})(\d{2})$")
_FRACTION = re.compile(r"\.(\d+)")


def _parse_iso(s):
    """ISO 8601 to epoch seconds, or None.

    PYTHON 3.10 IS THE ONE THAT SHIPS (Ubuntu 22.04, the radio and encoder
    images), and its fromisoformat only takes "+10:00" and 3 or 6 fraction
    digits. ffmpeg writes PROGRAM-DATE-TIME as "...47.592+1000" (and "+0000" in
    a UTC container), which 3.10 rejects: every radio playlist then had no
    window and so no triggers. Normalised here rather than trusted."""
    try:
        t = str(s).strip().replace("Z", "+00:00")
        t = _OFFSET.sub(r"\1\2:\3", t)
        t = _FRACTION.sub(lambda m: "." + (m.group(1) + "000000")[:6], t, count=1)
        return datetime.fromisoformat(t).timestamp()
    except Exception:  # noqa: BLE001
        return None


def _iso_ms(t):
    return datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(round((t % 1) * 1000)) % 1000:03d}Z"


def _dur_sec(v):
    """xs:duration as Shaka packager writes it (PT1H2M3.5S) to seconds."""
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?", (v or "").strip())
    if not m:
        return None
    d, h, mi, s = m.groups()
    return int(d or 0) * 86400 + int(h or 0) * 3600 + int(mi or 0) * 60 + float(s or 0)


class TriggerFeed:
    """Polls the control plane for this stream's triggers and holds the last good list."""

    def __init__(self, url, token=None, poll_sec=5, log=None, clock=time.time, fetch=None):
        self.url = url
        self.token = token
        self.poll_sec = max(2, int(poll_sec or 5))
        self.log = log or (lambda m: None)
        self.clock = clock
        self._fetch = fetch or self._http
        self._items = []
        self._at = 0.0
        self._lock = threading.Lock()
        self._warned = False

    def _http(self):
        req = urllib.request.Request(self.url, method="GET")
        if self.token:
            req.add_header("X-Volt-Ingest-Token", self.token)
        return json.loads(urllib.request.urlopen(req, timeout=4).read().decode("utf-8", "ignore"))

    def poll_once(self):
        try:
            body = self._fetch()
            items = []
            for t in body.get("triggers") or []:
                start = _parse_iso(t.get("start"))
                if start is None or not isinstance(t.get("hls"), str):
                    continue
                dur = t.get("duration")
                items.append({**t, "_start": start, "_end": (start + float(dur)) if dur is not None else float("inf")})
            with self._lock:
                self._items, self._at = items, self.clock()
            self._warned = False
            return True
        except Exception as e:  # noqa: BLE001
            if not self._warned:
                self.log(f"timed events: control plane not answering ({e}); keeping the last list")
                self._warned = True
            return False

    def current(self):
        with self._lock:
            if self._at and self.clock() - self._at > STALE_SEC:
                return []
            return list(self._items)

    def start(self):
        def loop():
            while True:
                self.poll_once()
                time.sleep(self.poll_sec)
        threading.Thread(target=loop, name="timed-events", daemon=True).start()
        return self


# ---------------------------------------------------------------- HLS

def playlist_window(text):
    """(from, to) in epoch seconds from the playlist's own PDT stamps, or None."""
    first = last = None
    after = 0.0
    for line in text.splitlines():
        if line.startswith("#EXT-X-PROGRAM-DATE-TIME:"):
            t = _parse_iso(line.split(":", 1)[1].strip())
            if t is None:
                continue
            if first is None:
                first = t
            last, after = t, 0.0
        elif line.startswith("#EXTINF:") and last is not None:
            try:
                after += float(line[8:].split(",", 1)[0])
            except ValueError:
                pass
    if first is None:
        return None
    return first, last + after


def select(triggers, lo, hi, ahead=AHEAD_SEC):
    return [t for t in triggers if t["_end"] > lo and t["_start"] < hi + ahead]


def inject_hls(text, triggers, ahead=AHEAD_SEC):
    """Replace any DATERANGE in a media playlist with the triggers its window covers.

    Header placement: a DATERANGE after an #EXTINF is inside a segment declaration.
    Idempotent: existing DATERANGE lines are dropped first, so a renamed programme
    corrects itself on the next write rather than appearing twice."""
    try:
        win = playlist_window(text)
        if win is None:
            return text
        lines = [l for l in text.split("\n") if not l.startswith("#EXT-X-DATERANGE:")]
        tags = [t["hls"] for t in select(triggers, win[0], win[1], ahead)
                if t.get("hls", "").startswith("#EXT-X-DATERANGE:") and "\n" not in t["hls"]]
        if not tags:
            return "\n".join(lines)
        at = next((i for i, l in enumerate(lines) if l.startswith("#EXTINF:")), len(lines))
        while at > 0 and lines[at - 1].startswith("#EXT-X-PROGRAM-DATE-TIME:"):
            at -= 1
        return "\n".join(lines[:at] + tags + lines[at:])
    except Exception:  # noqa: BLE001
        return text


# ---------------------------------------------------------------- DASH

def _xml_attr(v):
    return (str(v).replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")
            .replace("\n", " ").replace("\r", " "))


def _event_id(s):
    # Event@id is xs:unsignedInt. A stable hash of the trigger id, which itself
    # travels in messageData for anyone who needs the real one.
    return zlib.crc32(str(s).encode()) & 0x7FFFFFFF


_OUR_STREAMS = re.compile(r'<EventStream[^>]*schemeIdUri="' + re.escape(SCHEME_PREFIX) + r'[^"]*"[^>]*>.*?</EventStream>', re.S)


def inject_mpd(mpd, triggers, now=None, ahead=AHEAD_SEC):
    """Put each trigger in the Period it falls in, as an EventStream per scheme.

    Wall clock of a Period's start = availabilityStartTime + Period@start, so an
    Event's presentationTime (ms, timescale 1000, no offset) is its start minus
    that. A trigger that began before the Period is clipped to the Period start.
    Only triggers that can still matter are written: ending after the time-shift
    window opens, starting before `ahead` seconds from now."""
    try:
        now = time.time() if now is None else now
        mpd = _OUR_STREAMS.sub("", mpd)
        ast_m = re.search(r'availabilityStartTime="([^"]+)"', mpd)
        if not ast_m:
            return mpd
        ast = _parse_iso(ast_m.group(1))
        if ast is None:
            return mpd
        tsbd = _dur_sec((re.search(r'timeShiftBufferDepth="([^"]+)"', mpd) or [None, "PT300S"])[1]) or 300
        live = [t for t in triggers if t["_end"] > now - tsbd - 10 and t["_start"] < now + ahead and isinstance(t.get("dash"), dict)]
        if not live:
            return mpd
        periods = list(re.finditer(r"<Period\b[^>]*>", mpd))
        if not periods:
            return mpd
        starts = []
        for m in periods:
            s = re.search(r'\bstart="([^"]+)"', m.group(0))
            starts.append(ast + (_dur_sec(s.group(1)) if s else 0.0))
        out, pos = [], 0
        for i, m in enumerate(periods):
            p_lo = starts[i]
            p_hi = starts[i + 1] if i + 1 < len(starts) else float("inf")
            groups = {}
            for t in live:
                lo, hi = max(t["_start"], p_lo), min(t["_end"], p_hi)
                if hi <= lo:
                    continue
                d = t["dash"]
                ev = f'<Event id="{_event_id(t.get("id"))}" presentationTime="{int(round((lo - p_lo) * 1000))}"'
                if hi != float("inf"):
                    ev += f' duration="{max(1, int(round((hi - lo) * 1000)))}"'
                ev += f' messageData="{_xml_attr(d.get("messageData", "{}"))}"/>'
                groups.setdefault((d.get("schemeIdUri", ""), d.get("value", "")), []).append(ev)
            block = "".join(
                f'<EventStream schemeIdUri="{_xml_attr(s)}" value="{_xml_attr(v)}" timescale="1000">{"".join(evs)}</EventStream>'
                for (s, v), evs in sorted(groups.items()) if s.startswith(SCHEME_PREFIX))
            out.append(mpd[pos:m.end()])
            out.append(block)
            pos = m.end()
        out.append(mpd[pos:])
        return "".join(out)
    except Exception:  # noqa: BLE001
        return mpd
