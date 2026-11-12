#!/usr/bin/env python3
"""The stable playlists of a cloud run (build queue 2.2: per-run S3 prefixes).

WHY. On AWS the encoder used to mirror its output straight to
s3://bucket/<kind>/<id>/. Segment and playlist names repeat across runs
(seg_N.m4s, master.m3u8), so a restart wrote over the previous run's media,
and two encoders on one stream, even for a minute, overwrote each other's
segments. That is what made a make-before-break move between servers unsafe
(CONSOLIDATION.md, blocker 1), and it is the opposite of what the Mac does:
there every run has its own runs/<runId>/ folder and current_run.txt points
at the live one.

THE LAYOUT. Each run now uploads everything it makes under its own prefix:

    <kind>/<id>/runs/<runId>/...          the run's media AND its own playlists

and, at the stream's root, the STABLE copies viewers, the CDN and the edge
already use (/channel/<id>/master_cc.m3u8 and so on):

    <kind>/<id>/<same relative path>.m3u8|.mpd   every playlist of the live run,
                                                 its media URIs pointed into
                                                 runs/<runId>/
    <kind>/<id>/current_run.txt                  the live run's id, written last

Playlist-to-playlist references are left as they are: the root tree of
playlists mirrors the run's tree, so master_cc.m3u8 still names
720p/index_cc.m3u8 next to it. Only media (segments, init segments, caption
cues, the loop's segments) is pointed into the run, and only when the run
itself made it: a URI whose folder does not exist in the run's output (the
separate captions task writes subtitles/ at the root, for example) or that
climbs out of the run is left alone. So the play URL never changes, a
restart moves the pointer at the run boundary, and no run ever writes over
another's media.

THE POINTER NEVER GOES BACKWARDS. Run ids sort by time (20261112T192200Z,
the Mac's format). A run publishes only while no NEWER run holds the pointer;
an older encoder still shutting down, or a shadow in a later handoff, cannot
take the stream back.

CLI (used by s3-uploader.sh):
    run_pointer.py build <run_dir> <run_id> <stage_dir>   stable copies + current_run.txt
    run_pointer.py may-publish <run_id> <pointer_file>     exit 0 if this run may publish
"""
import os
import posixpath
import re
import shutil
import sys

RUN_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
_URI_ATTR = re.compile(r'(URI=")([^"]*)(")')
_MPD_ATTR = re.compile(r'(\b(?:media|initialization|sourceURL)=")([^"]*)(")')
_MPD_BASE = re.compile(r"(<BaseURL[^>]*>)([^<]*)(</BaseURL>)")


def valid_run_id(s):
    return bool(s) and bool(RUN_ID_RE.match(s)) and ".." not in s


def may_publish(run_id, current):
    """True when this run may write the stable playlists: no pointer yet, an
    unreadable one, its own, or an older run's. Never over a newer run."""
    cur = (current or "").strip()
    if not valid_run_id(cur):
        return True
    return cur <= run_id


def _split_query(u):
    for sep in ("?", "#"):
        if sep in u:
            i = u.index(sep)
            return u[:i], u[i:]
    return u, ""


def rewrite_uri(u, pdir, run_dir, run_id, playlist_ext=(".m3u8", ".mpd")):
    """The URI as seen from the stable copy of a playlist in folder `pdir`
    (relative to the stream root), or u unchanged when it is not this run's
    media. A template ($Number$) is judged by its folder, as the segments it
    names come and go."""
    if not u or u.startswith("/") or _SCHEME.match(u) or u.startswith("data:"):
        return u
    path, tail = _split_query(u)
    if not path or path.lower().endswith(playlist_ext):
        return u
    target = posixpath.normpath(posixpath.join(pdir, path)) if pdir else posixpath.normpath(path)
    if target.startswith("..") or target.startswith("/"):
        return u
    folder = posixpath.dirname(target)
    if not os.path.isdir(os.path.join(run_dir, folder) if folder else run_dir):
        return u
    moved = posixpath.join("runs", run_id, target)
    rel = posixpath.relpath(moved, pdir or ".")
    return rel + tail


def rewrite_hls(text, pdir, run_dir, run_id):
    out = []
    for line in text.split("\n"):
        s = line.strip()
        if not s:
            out.append(line)
        elif s.startswith("#"):
            out.append(_URI_ATTR.sub(lambda m: m.group(1) + rewrite_uri(m.group(2), pdir, run_dir, run_id) + m.group(3), line))
        else:
            out.append(rewrite_uri(s, pdir, run_dir, run_id))
    return "\n".join(out)


def rewrite_mpd(text, pdir, run_dir, run_id):
    """Segment templates and segment URLs point into the run. When the MPD
    carries its own BaseURL, the BaseURL is what moves (the attributes under it
    are relative to it), so the two are never both prefixed."""
    if _MPD_BASE.search(text):
        def base(m):
            v = m.group(2).strip()
            if not v or v.startswith("/") or _SCHEME.match(v):
                return m.group(0)
            target = posixpath.normpath(posixpath.join(pdir, v)) if pdir else posixpath.normpath(v)
            if target.startswith("..") or not os.path.isdir(os.path.join(run_dir, target) if target != "." else run_dir):
                return m.group(0)
            rel = posixpath.relpath(posixpath.join("runs", run_id, target if target != "." else ""), pdir or ".")
            return m.group(1) + rel.rstrip("/") + "/" + m.group(3)
        return _MPD_BASE.sub(base, text)
    return _MPD_ATTR.sub(lambda m: m.group(1) + rewrite_uri(m.group(2), pdir, run_dir, run_id) + m.group(3), text)


def build(run_dir, run_id, stage):
    """Write the stable copies of every playlist in run_dir into stage, then
    current_run.txt. Returns the playlists written (relative paths). Nothing at
    all is staged when the run has no playlist yet: the pointer must not move
    to a run that cannot be played."""
    if not valid_run_id(run_id):
        raise ValueError(f"bad run id {run_id!r}")
    if os.path.isdir(stage):
        shutil.rmtree(stage)
    os.makedirs(stage)
    written = []
    for root, dirs, files in os.walk(run_dir):
        dirs[:] = sorted(d for d in dirs if d != "runs")
        rel_dir = os.path.relpath(root, run_dir)
        pdir = "" if rel_dir == "." else rel_dir.replace(os.sep, "/")
        for f in sorted(files):
            if not f.endswith((".m3u8", ".mpd")):
                continue
            try:
                with open(os.path.join(root, f), encoding="utf-8") as fh:
                    text = fh.read()
            except (OSError, UnicodeDecodeError):
                continue   # being rewritten this instant: the next pass takes it
            new = rewrite_hls(text, pdir, run_dir, run_id) if f.endswith(".m3u8") \
                else rewrite_mpd(text, pdir, run_dir, run_id)
            rel = posixpath.join(pdir, f) if pdir else f
            dest = os.path.join(stage, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "w", encoding="utf-8") as fh:
                fh.write(new)
            written.append(rel)
    if written:
        with open(os.path.join(stage, "current_run.txt"), "w") as fh:
            fh.write(run_id)
    return written


def main(argv):
    if len(argv) == 4 and argv[0] == "build":
        n = build(argv[1], argv[2], argv[3])
        print(len(n))
        return 0
    if len(argv) == 3 and argv[0] == "may-publish":
        try:
            with open(argv[2]) as fh:
                cur = fh.read()
        except OSError:
            cur = ""
        return 0 if may_publish(argv[1], cur) else 1
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
