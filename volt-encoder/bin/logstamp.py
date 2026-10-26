"""WHEN IT HAPPENED, on every line of encoder.log and radio.log.

ffmpeg and the packager write their errors with no time on them, and the
encoder's own lines had none either, so the console's Connection Log could say
WHAT went wrong but never WHEN: five identical "Error while decoding stream"
rows could be one burst an hour ago or a fault happening right now.

Every line now starts with a UTC timestamp, `2026-10-27T09:31:02.123Z `, which
the control plane reads (services/channelDetail.ts, services/radio/detail.ts)
and shows in the viewer's own time. A child's lines also carry its name
(`[relay:primary] ...`) so the log says which part of the pipeline failed.

ffmpeg 4.x prints its progress report ("frame= ... time= ...", ended by \\r)
even at -loglevel warning. Read through a pipe, each report would become a
stamped line twice a second per process, so those are dropped here.
"""
import re
import sys
import threading
from datetime import datetime, timezone

_PROGRESS = re.compile(rb"^\s*(frame|size)=\s*\S+.*\btime=")
_lock = threading.Lock()


def stamp():
    """UTC with milliseconds and a Z, so it parses the same anywhere."""
    d = datetime.now(timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"


def stamped(text, tag=None):
    return f"{stamp()} [{tag}] {text}" if tag else f"{stamp()} {text}"


def write_line(text, out=None, tag=None):
    """One stamped line to `out` (a text stream, default stderr), whole lines only."""
    out = out or sys.stderr
    with _lock:
        out.write(stamped(text, tag) + "\n")
        out.flush()


def pieces(raw):
    """A raw stderr line as bytes -> the text pieces worth keeping.

    Splits on \\r too (progress reports overwrite themselves with it) and drops
    the progress reports themselves."""
    out = []
    for part in raw.rstrip(b"\n").split(b"\r"):
        if not part.strip() or _PROGRESS.match(part):
            continue
        out.append(part.decode("utf-8", "replace").rstrip())
    return out


def pump(stream, tag=None, out=None, binary_out=False):
    """Read a child's stderr (opened in binary) until it closes, stamping each line.

    It must never stop reading: a pipe left unread fills and blocks the child.
    A failure writing one line is skipped, not fatal."""
    for raw in iter(stream.readline, b""):
        for text in pieces(raw):
            try:
                if binary_out:
                    line = stamped(text, tag) + "\n"
                    with _lock:
                        out.write(line.encode("utf-8", "replace"))
                        out.flush()
                else:
                    write_line(text, out, tag)
            except Exception:  # noqa: BLE001
                pass


def start_pump(stream, tag=None, out=None, binary_out=False, name=None):
    t = threading.Thread(target=pump, args=(stream, tag, out, binary_out),
                         name=name or f"log:{tag or 'child'}", daemon=True)
    t.start()
    return t
