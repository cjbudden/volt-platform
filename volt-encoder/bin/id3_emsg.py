#!/usr/bin/env python3
"""
Now-playing inside the audio segments: ID3 in emsg (radio HLS and DASH).

WHY IN THE SEGMENTS. A station's now-playing arrives as ICY metadata on the
INGEST side and lands in the content log (services/radio/icyMeta.ts). Listeners
on Icecast get it as ICY again, but an HLS or DASH listener had nothing in the
stream: only the player's now-playing poll. Apple's timed metadata for HLS and
the DASH equivalent carry it in the media itself, as an ID3 tag inside an
`emsg` box with scheme https://aomedia.org/emsg/ID3 at the start of an fMP4
segment, so any standard player (Safari and AVPlayer, hls.js, Shaka, dash.js)
sees the title change at the moment it is heard, with no Volt code at all.

WHAT IS WRITTEN. One emsg (version 1, so the time is absolute on the track's
media timeline) per now-playing change, holding an ID3v2.4 tag with TIT2 (the
title) and TPE1 (the artist, when the title is "Artist - Title"). The title in
force is also repeated every REPEAT_SEC, so a listener who joins mid-song learns
it within that time instead of at the next song.

WHERE. Never in ffmpeg's own files, which the recording index, clipping and the
uploader read: a segment that carries a tag is a COPY under id3/ beside it, and
the delivered playlist copy (index_cc.m3u8 / manifest_cc.mpd) points at the
copy. HLS copies only the segments that carry a tag (one every REPEAT_SEC at
most, plus each change); a DASH SegmentTemplate names every segment by number,
so DASH keeps a full id3/ set for its rolling window, hard links for the
segments without a tag.

TIMING. The change time is the content log's (when the ICY reader saw the title
change), placed by the segment's own clock: PROGRAM-DATE-TIME in HLS,
availabilityStartTime plus the segment's media time in DASH. A change the
encoder learns about only after the segment holding it went out (the poll runs
every few seconds) is carried at the start of the next segment instead, so a
title can be up to one segment plus one poll late, never early.

FAILS OPEN like timed_events.py: anything unexpected about a segment leaves the
playlist pointing at ffmpeg's untouched file.
"""

import os
import re
import struct
import zlib

ID3_SCHEME = "https://aomedia.org/emsg/ID3"
REPEAT_SEC = 30
UNKNOWN_DURATION = 0xFFFFFFFF


# ---------------------------------------------------------------- ID3

def _syncsafe(n):
    return bytes([(n >> 21) & 0x7F, (n >> 14) & 0x7F, (n >> 7) & 0x7F, n & 0x7F])


def _unsyncsafe(b):
    return (b[0] << 21) | (b[1] << 14) | (b[2] << 7) | b[3]


def _text_frame(fid, text):
    # Encoding 3 is UTF-8 (ID3v2.4). Station titles are not ASCII often enough
    # (Malay, Chinese, accented artists) that Latin-1 would lose them.
    body = b"\x03" + text.encode("utf-8")
    return fid.encode("ascii") + _syncsafe(len(body)) + b"\x00\x00" + body


def id3_tag(title, artist=None):
    """An ID3v2.4 tag with TIT2 and, when given, TPE1."""
    frames = _text_frame("TIT2", str(title or ""))
    if artist:
        frames += _text_frame("TPE1", str(artist))
    return b"ID3\x04\x00\x00" + _syncsafe(len(frames)) + frames


def parse_id3(b):
    """{frame id: text} from an ID3v2.3/2.4 tag (text frames only), or None."""
    if len(b) < 10 or b[:3] != b"ID3":
        return None
    ver = b[3]
    end = 10 + _unsyncsafe(b[6:10])
    out = {}
    i = 10
    while i + 10 <= min(end, len(b)):
        fid = b[i:i + 4]
        if fid == b"\x00\x00\x00\x00":
            break
        size = _unsyncsafe(b[i + 4:i + 8]) if ver == 4 else struct.unpack(">I", b[i + 4:i + 8])[0]
        data = b[i + 10:i + 10 + size]
        if fid[:1] == b"T" and data:
            enc, raw = data[0], data[1:]
            codec = {0: "latin-1", 1: "utf-16", 2: "utf-16-be", 3: "utf-8"}.get(enc, "latin-1")
            out[fid.decode("ascii", "replace")] = raw.decode(codec, "replace").rstrip("\x00")
        i += 10 + size
    return out


# ---------------------------------------------------------------- ISO BMFF

def boxes(b, start=0, end=None):
    """Top-level boxes in b[start:end] as (type, offset, size)."""
    end = len(b) if end is None else end
    out = []
    i = start
    while i + 8 <= end:
        size, typ = struct.unpack(">I4s", b[i:i + 8])
        if size == 1:
            size = struct.unpack(">Q", b[i + 8:i + 16])[0]
        elif size == 0:
            size = end - i
        if size < 8 or i + size > end:
            break
        out.append((typ.decode("latin-1"), i, size))
        i += size
    return out


def _find(b, path, start=0, end=None):
    """Offset and size of the first box at a path like ['moov','trak','mdia','mdhd']."""
    for typ, off, size in boxes(b, start, end):
        if typ == path[0]:
            if len(path) == 1:
                return off, size
            return _find(b, path[1:], off + 8, off + size)
    return None


def track_timescale(init):
    """The audio track's timescale from an init segment's mdhd."""
    hit = _find(init, ["moov", "trak", "mdia", "mdhd"])
    if not hit:
        return None
    off = hit[0]
    ver = init[off + 8]
    return struct.unpack(">I", init[off + 28:off + 32] if ver == 1 else init[off + 20:off + 24])[0]


def first_tfdt(seg):
    """baseMediaDecodeTime of the first fragment, in track timescale units."""
    hit = _find(seg, ["moof", "traf", "tfdt"])
    if not hit:
        return None
    off = hit[0]
    ver = seg[off + 8]
    return struct.unpack(">Q", seg[off + 12:off + 20])[0] if ver == 1 else struct.unpack(">I", seg[off + 12:off + 16])[0]


def emsg_box(message, presentation_time, timescale, event_id, duration=UNKNOWN_DURATION,
             scheme=ID3_SCHEME, value=""):
    """An emsg version 1 box (ISO/IEC 23009-1 5.10.3.3): absolute presentation time."""
    body = struct.pack(">BxxxIQII", 1, timescale, presentation_time, duration, event_id & 0xFFFFFFFF)
    body += scheme.encode("utf-8") + b"\x00" + value.encode("utf-8") + b"\x00" + message
    return struct.pack(">I4s", 8 + len(body), b"emsg") + body


def parse_emsg(b, off, size):
    ver = b[off + 8]
    p = off + 12
    if ver == 1:
        ts, pt, dur, eid = struct.unpack(">IQII", b[p:p + 20])
        p += 20
        scheme_end = b.index(b"\x00", p)
        scheme = b[p:scheme_end].decode("utf-8")
        value_end = b.index(b"\x00", scheme_end + 1)
        value = b[scheme_end + 1:value_end].decode("utf-8")
        return {"version": 1, "timescale": ts, "presentation_time": pt, "duration": dur, "id": eid,
                "scheme": scheme, "value": value, "message": b[value_end + 1:off + size]}
    scheme_end = b.index(b"\x00", p)
    value_end = b.index(b"\x00", scheme_end + 1)
    ts, delta, dur, eid = struct.unpack(">IIII", b[value_end + 1:value_end + 17])
    return {"version": 0, "timescale": ts, "presentation_time_delta": delta, "duration": dur, "id": eid,
            "scheme": b[p:scheme_end].decode("utf-8"), "value": b[scheme_end + 1:value_end].decode("utf-8"),
            "message": b[value_end + 17:off + size]}


def read_emsgs(seg):
    return [parse_emsg(seg, off, size) for typ, off, size in boxes(seg) if typ == "emsg"]


def insert_emsgs(seg, emsgs):
    """The segment with the emsg boxes placed just before its first moof.

    ISO BMFF and CMAF want an emsg ahead of the moof it belongs to. ffmpeg's HLS
    segments run styp, sidx, moof, mdat: the sidx's first_offset counts from the
    end of the sidx to the first byte it indexes, so it grows by what is put in
    between. Fragment offsets need nothing: ffmpeg sets default-base-is-moof, so
    sample data is addressed from each moof, which does not move relative to its
    mdat. A segment that is not that shape is refused (ValueError)."""
    blob = b"".join(emsgs)
    if not blob:
        return seg
    top = boxes(seg)
    moof = next((x for x in top if x[0] == "moof"), None)
    if moof is None:
        raise ValueError("no moof")
    if sum(s for _, _, s in top) != len(seg):
        raise ValueError("segment does not parse to its end")
    out = bytearray(seg[:moof[1]] + blob + seg[moof[1]:])
    for typ, off, size in top:
        if typ == "sidx" and off < moof[1]:
            ver = out[off + 8]
            # version, flags, reference_ID, timescale, then earliest time and first_offset
            p = off + (28 if ver == 1 else 24)
            if ver == 1:
                cur = struct.unpack(">Q", out[p:p + 8])[0]
                out[p:p + 8] = struct.pack(">Q", cur + len(blob))
            else:
                cur = struct.unpack(">I", out[p:p + 4])[0]
                out[p:p + 4] = struct.pack(">I", cur + len(blob))
    return bytes(out)


# ---------------------------------------------------------------- what to write

def event_id(key, at):
    """Distinct per tag: DASH clients drop an emsg whose (scheme, value, id) they
    have already seen, so a repeat of the same title needs its own id."""
    return zlib.crc32(f"{key}@{int(round(at * 1000))}".encode("utf-8"))


class Stamper:
    """Decides which tags a segment carries. One per delivery timeline (HLS and
    DASH segment differently), so each keeps its own memory of what it sent."""

    def __init__(self, repeat_sec=REPEAT_SEC):
        self.repeat_sec = repeat_sec
        self.last_key = None
        self.last_at = None

    def plan(self, seg_start, seg_end, entries):
        """[(at, entry)] for a segment covering [seg_start, seg_end) in epoch
        seconds. entries carry _at (epoch seconds) and id, oldest first."""
        known = sorted((e for e in entries if e.get("_at") is not None), key=lambda e: e["_at"])
        cur = None
        for e in known:
            if e["_at"] <= seg_start:
                cur = e
        out = []
        if cur is not None and (cur["id"] != self.last_key or self.last_at is None
                                or seg_start - self.last_at >= self.repeat_sec - 0.001):
            out.append((seg_start, cur))
        for e in known:
            if seg_start < e["_at"] < seg_end:
                out.append((e["_at"], e))
        if out:
            self.last_at, last = out[-1][0], out[-1][1]
            self.last_key = last["id"]
        return out


def stamp(seg, timescale, seg_start, frames):
    """seg with one emsg per (at, entry) in frames, timed on the track's own
    media timeline: the first fragment's tfdt is the segment start."""
    base = first_tfdt(seg)
    if base is None or not timescale:
        raise ValueError("no tfdt or timescale")
    out = []
    for at, e in frames:
        pt = base + max(0, int(round((at - seg_start) * timescale)))
        out.append(emsg_box(id3_tag(e.get("title") or "", e.get("artist")), pt, timescale, event_id(e["id"], at)))
    return insert_emsgs(seg, out)


# ---------------------------------------------------------------- HLS

def hls_segments(text):
    """[(uri, start epoch, duration)] from ffmpeg's playlist, which writes the
    PROGRAM-DATE-TIME between #EXTINF and the segment line."""
    from timed_events import _parse_iso
    out = []
    pdt = dur = None
    last_end = None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("#EXT-X-PROGRAM-DATE-TIME:"):
            pdt = _parse_iso(line.split(":", 1)[1])
        elif line.startswith("#EXTINF:"):
            try:
                dur = float(line[8:].split(",", 1)[0])
            except ValueError:
                dur = None
        elif line and not line.startswith("#"):
            start = pdt if pdt is not None else last_end
            if start is not None and dur is not None:
                out.append((line, start, dur))
                last_end = start + dur
            pdt = dur = None
    return out


def refresh_hls(audio_dir, text, entries, state):
    """Stamp the segments ffmpeg has finished since the last cycle; return the
    playlist text with each stamped segment pointing at its id3/ copy."""
    segs = hls_segments(text)
    done = state.setdefault("hls_done", set())
    mapped = state.setdefault("hls_map", {})
    stamper = state.setdefault("hls_stamper", Stamper(state.get("repeat_sec", REPEAT_SEC)))
    if not state.get("hls_seen"):
        # Joining a run already under way: the old segments are past anyone's
        # live edge, so only the newest few are worth a tag.
        for uri, _, _ in segs[:-3]:
            done.add(uri)
        state["hls_seen"] = True
    ts = state.get("hls_timescale")
    if ts is None:
        try:
            with open(os.path.join(audio_dir, "init.mp4"), "rb") as fh:
                ts = state["hls_timescale"] = track_timescale(fh.read())
        except OSError:
            ts = None
    for uri, start, dur in segs:
        if uri in done:
            continue
        done.add(uri)
        if not ts or "/" in uri:
            continue
        frames = stamper.plan(start, start + dur, entries)
        if not frames:
            continue
        try:
            with open(os.path.join(audio_dir, uri), "rb") as fh:
                seg = fh.read()
            out = stamp(seg, ts, start, frames)
            os.makedirs(os.path.join(audio_dir, "id3"), exist_ok=True)
            _atomic_bytes(os.path.join(audio_dir, "id3", uri), out)
            mapped[uri] = "id3/" + uri
        except (OSError, ValueError, struct.error):
            continue
    if not mapped:
        return text
    return "\n".join(mapped.get(ln, ln) for ln in text.split("\n"))


# ---------------------------------------------------------------- DASH

_S = re.compile(r"<S\b([^>]*)/>")


def _attr(tag, name):
    m = re.search(r'\b' + name + r'="([^"]*)"', tag)
    return m.group(1) if m else None


def dash_segments(mpd):
    """(template, rep_id, [(number, start epoch, duration)]) for ffmpeg's
    single-Representation radio MPD, or None for anything else."""
    from timed_events import _parse_iso, _dur_sec
    if mpd.count("<Representation ") != 1 or mpd.count("<SegmentTemplate") != 1:
        return None
    ast = _parse_iso(_attr(re.search(r"<MPD\b[^>]*>", mpd).group(0), "availabilityStartTime") or "")
    if ast is None:
        return None
    period = re.search(r"<Period\b[^>]*>", mpd)
    pstart = _dur_sec(_attr(period.group(0), "start") or "PT0S") or 0.0 if period else 0.0
    st = re.search(r"<SegmentTemplate\b[^>]*>", mpd).group(0)
    media = _attr(st, "media")
    rep = _attr(re.search(r"<Representation\b[^>]*>", mpd).group(0), "id")
    ts = int(_attr(st, "timescale") or 1)
    num = int(_attr(st, "startNumber") or 1)
    pto = int(_attr(st, "presentationTimeOffset") or 0)
    tl = re.search(r"<SegmentTimeline>(.*?)</SegmentTimeline>", mpd, re.S)
    if not media or tl is None:
        return None
    out = []
    t = None
    for m in _S.finditer(tl.group(1)):
        a = m.group(1)
        d = int(_attr(a, "d"))
        if _attr(a, "t") is not None:
            t = int(_attr(a, "t"))
        t = 0 if t is None else t
        for _ in range(int(_attr(a, "r") or 0) + 1):
            out.append((num, ast + pstart + (t - pto) / ts, d / ts))
            num += 1
            t += d
    return media, rep, out


def _media_name(template, rep, number):
    name = template.replace("$RepresentationID$", rep or "")
    return re.sub(r"\$Number(?:%0(\d+)d)?\$", lambda m: str(number).zfill(int(m.group(1) or 0)), name)


def refresh_dash(dash_dir, mpd, entries, state):
    """Keep id3/ holding every segment the MPD lists, tagged where a change or a
    repeat falls; return the MPD pointing there, or unchanged until it can."""
    parsed = dash_segments(mpd)
    if parsed is None:
        return mpd
    media, rep, segs = parsed
    if "/" in media or not segs:
        return mpd
    done = state.setdefault("dash_done", set())
    stamper = state.setdefault("dash_stamper", Stamper(state.get("repeat_sec", REPEAT_SEC)))
    ts = int(_attr(re.search(r"<SegmentTemplate\b[^>]*>", mpd).group(0), "timescale") or 1)
    out_dir = os.path.join(dash_dir, "id3")
    os.makedirs(out_dir, exist_ok=True)
    complete = True
    for number, start, dur in segs:
        name = _media_name(media, rep, number)
        dst = os.path.join(out_dir, name)
        if number in done and os.path.exists(dst):
            continue
        src = os.path.join(dash_dir, name)
        frames = stamper.plan(start, start + dur, entries) if number not in done else []
        done.add(number)
        try:
            if frames:
                with open(src, "rb") as fh:
                    _atomic_bytes(dst, stamp(fh.read(), ts, start, frames))
            else:
                _link_or_copy(src, dst)
        except (OSError, ValueError, struct.error):
            try:
                _link_or_copy(src, dst)
            except OSError:
                complete = False
    # The rolling window: ffmpeg drops its old segments, so do the copies.
    first = segs[0][0]
    for n in [n for n in done if n < first - 10]:
        done.discard(n)
        try:
            os.remove(os.path.join(out_dir, _media_name(media, rep, n)))
        except OSError:
            pass
    if not complete:
        return mpd
    mpd = mpd.replace(f'media="{media}"', f'media="id3/{media}"', 1)
    if ID3_SCHEME not in mpd:
        mpd = re.sub(r"(<AdaptationSet\b[^>]*>)",
                     lambda m: m.group(1) + f'\n\t\t\t<InbandEventStream schemeIdUri="{ID3_SCHEME}" value=""/>', mpd, count=1)
    return mpd


# ---------------------------------------------------------------- files

def _atomic_bytes(path, data):
    tmp = path + ".tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)


def _link_or_copy(src, dst):
    tmp = dst + ".tmp"
    try:
        os.remove(tmp)
    except OSError:
        pass
    try:
        os.link(src, tmp)
    except OSError:
        with open(src, "rb") as fh:
            data = fh.read()
        with open(tmp, "wb") as fh:
            fh.write(data)
    os.replace(tmp, dst)


def entries_from_wire(items):
    """The control plane's now_playing list (start ISO, id, title, artist) with
    _at in epoch seconds; malformed entries dropped."""
    from timed_events import _parse_iso
    out = []
    for e in items or []:
        if not isinstance(e, dict) or not e.get("id"):
            continue
        at = _parse_iso(e.get("start"))
        if at is None:
            continue
        out.append({**e, "_at": at})
    return out
