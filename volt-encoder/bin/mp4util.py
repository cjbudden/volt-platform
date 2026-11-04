"""mp4util.py: the few fMP4 (CMAF) facts the playout splice needs, stdlib only.

* timescale(init)          the track's media timescale (mdhd)
* tfdt(seg)                a fragment's baseMediaDecodeTime
* frag_duration(seg, init) a fragment's exact duration in timescale units (trun/tfhd/trex)
* rebase(src, dst, t)      copy a fragment with its tfdt rewritten to `t`
* codecs(init)             the RFC 6381 codecs string (avc1.PPCCLL / mp4a.40.N)
* keyframe_fragment(d, n) a fragment's opening keyframe as a fragment of its own (DASH trick-mode)

Why rebase: the pre-built loop has a handful of segments that repeat for as long as an
outage lasts. Within one DASH Period the timeline has to keep increasing, so every slot
the loop fills is a copy of a loop segment whose decode time continues from the one
before. The copy is the same bytes with one 32/64-bit field changed.
"""
import struct

_CONTAINERS = {b"moov", b"trak", b"mdia", b"minf", b"stbl", b"moof", b"traf", b"mvex", b"stsd", b"avc1", b"avc3", b"mp4a", b"encv", b"enca"}
_SAMPLE_ENTRY_SKIP = {b"avc1": 78, b"avc3": 78, b"encv": 78, b"mp4a": 28, b"enca": 28, b"stsd": 8}


def _boxes(data, start=0, end=None):
    """Yield (type, payload_start, box_end, header_start) for boxes in data[start:end]."""
    end = len(data) if end is None else end
    i = start
    while i + 8 <= end:
        size, typ = struct.unpack(">I4s", data[i:i + 8])
        hdr = 8
        if size == 1:
            size = struct.unpack(">Q", data[i + 8:i + 16])[0]
            hdr = 16
        elif size == 0:
            size = end - i
        if size < hdr or i + size > end:
            return
        yield typ, i + hdr, i + size, i
        i += size


def _find(data, path, start=0, end=None):
    """First box along a path like [b'moov', b'trak', b'mdia', b'mdhd']: (payload, end, header)."""
    for typ, ps, pe, hs in _boxes(data, start, end):
        if typ != path[0]:
            continue
        if len(path) == 1:
            return ps, pe, hs
        inner = ps + _SAMPLE_ENTRY_SKIP.get(typ, 0)
        r = _find(data, path[1:], inner, pe)
        if r:
            return r
    return None


def _read(path, n=1 << 20):
    with open(path, "rb") as fh:
        return fh.read(n)


def timescale(init_path):
    d = _read(init_path)
    r = _find(d, [b"moov", b"trak", b"mdia", b"mdhd"])
    if not r:
        return None
    ps = r[0]
    ver = d[ps]
    off = ps + 4 + (16 if ver == 1 else 8)
    return struct.unpack(">I", d[off:off + 4])[0]


def _tfdt_at(d):
    r = _find(d, [b"moof", b"traf", b"tfdt"])
    if not r:
        return None
    ps = r[0]
    ver = d[ps]
    if ver == 1:
        return ps + 4, 8, struct.unpack(">Q", d[ps + 4:ps + 12])[0]
    return ps + 4, 4, struct.unpack(">I", d[ps + 4:ps + 8])[0]


def tfdt(seg_path):
    hit = _tfdt_at(_read(seg_path, 65536))
    return hit[2] if hit else None


def _trex_default_duration(init_path):
    if not init_path:
        return None
    d = _read(init_path)
    r = _find(d, [b"moov", b"mvex", b"trex"])
    if not r:
        return None
    ps = r[0]
    # version/flags(4) track_ID(4) default_sample_description_index(4) default_sample_duration(4)
    return struct.unpack(">I", d[ps + 12:ps + 16])[0]


def frag_duration(seg_path, init_path=None):
    """Sum of sample durations of every fragment in the segment file."""
    d = _read(seg_path, 1 << 24)
    total = 0
    found = False
    for typ, ps, pe, _hs in _boxes(d):
        if typ != b"moof":
            continue
        for t2, ps2, pe2, _ in _boxes(d, ps, pe):
            if t2 != b"traf":
                continue
            default_dur = None
            for t3, ps3, pe3, _ in _boxes(d, ps2, pe2):
                if t3 == b"tfhd":
                    flags = int.from_bytes(d[ps3 + 1:ps3 + 4], "big")
                    o = ps3 + 8                        # version/flags + track_ID
                    if flags & 0x01: o += 8            # base_data_offset
                    if flags & 0x02: o += 4            # sample_description_index
                    if flags & 0x08:
                        default_dur = struct.unpack(">I", d[o:o + 4])[0]
            if default_dur is None:
                default_dur = _trex_default_duration(init_path)
            for t3, ps3, pe3, _ in _boxes(d, ps2, pe2):
                if t3 != b"trun":
                    continue
                flags = int.from_bytes(d[ps3 + 1:ps3 + 4], "big")
                count = struct.unpack(">I", d[ps3 + 4:ps3 + 8])[0]
                o = ps3 + 8
                if flags & 0x001: o += 4               # data_offset
                if flags & 0x004: o += 4               # first_sample_flags
                per = 0
                for bit in (0x100, 0x200, 0x400, 0x800):
                    if flags & bit:
                        per += 4
                if flags & 0x100:
                    for k in range(count):
                        total += struct.unpack(">I", d[o + k * per:o + k * per + 4])[0]
                else:
                    total += count * (default_dur or 0)
                found = True
    return total if found else None


def rebase(src, dst, new_tfdt):
    """Write `src` to `dst` with its tfdt set to `new_tfdt` (same size, nothing else moves)."""
    data = bytearray(open(src, "rb").read())
    hit = _tfdt_at(bytes(data[:65536]))
    if not hit:
        raise ValueError(f"no tfdt in {src}")
    off, width, _old = hit
    if width == 4:
        if new_tfdt >= 1 << 32:
            raise ValueError("tfdt does not fit a version 0 box")
        data[off:off + 4] = struct.pack(">I", new_tfdt)
    else:
        data[off:off + 8] = struct.pack(">Q", new_tfdt)
    tmp = f"{dst}.tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
    import os
    os.replace(tmp, dst)


def codecs(init_path):
    d = _read(init_path)
    r = _find(d, [b"moov", b"trak", b"mdia", b"minf", b"stbl", b"stsd", b"avc1", b"avcC"]) \
        or _find(d, [b"moov", b"trak", b"mdia", b"minf", b"stbl", b"stsd", b"avc3", b"avcC"])
    if r:
        ps = r[0]
        return "avc1.%02x%02x%02x" % (d[ps + 1], d[ps + 2], d[ps + 3])
    if _find(d, [b"moov", b"trak", b"mdia", b"minf", b"stbl", b"stsd", b"mp4a"]):
        return "mp4a.40.2"
    return None


def _trun_layout(d, ps, pe):
    flags = int.from_bytes(d[ps + 1:ps + 4], "big")
    count = struct.unpack(">I", d[ps + 4:ps + 8])[0]
    o = ps + 8
    do_at = None
    if flags & 0x001:
        do_at = o
        o += 4
    if flags & 0x004:
        o += 4
    per = sum(4 for bit in (0x100, 0x200, 0x400, 0x800) if flags & bit)
    return flags, count, o, per, do_at


def truncate(src, dst, keep, init_path=None):
    """Write `src` to `dst` keeping only its first samples (decode order) whose total
    duration fits in `keep` timescale units (at least one sample). Returns the kept
    duration. Used where a DASH Period ends inside a segment: a browser appends what it
    is given whole, so a segment that runs on past its Period must be cut, not trusted
    to the player's append window.

    Handles the fragments Shaka writes: [styp] [sidx] (moof + mdat)+, one traf each
    (sidx is dropped: its sizes would be wrong and MSE does not use it)."""
    d = open(src, "rb").read()
    out = bytearray()
    kept_total = 0
    boxes = list(_boxes(d))
    i = 0
    done = False
    while i < len(boxes) and not done:
        typ, ps, pe, hs = boxes[i]
        if typ == b"sidx":
            i += 1
            continue
        if typ != b"moof":
            if typ != b"mdat":
                out += d[hs:pe]
            i += 1
            continue
        mdat = boxes[i + 1] if i + 1 < len(boxes) and boxes[i + 1][0] == b"mdat" else None
        if mdat is None:
            raise ValueError("moof without mdat")
        traf = next((b for b in _boxes(d, ps, pe) if b[0] == b"traf"), None)
        default_dur = default_size = None
        trun = None
        for t3, ps3, pe3, hs3 in _boxes(d, traf[1], traf[2]):
            if t3 == b"tfhd":
                fl = int.from_bytes(d[ps3 + 1:ps3 + 4], "big")
                o = ps3 + 8
                if fl & 0x01: o += 8
                if fl & 0x02: o += 4
                if fl & 0x08:
                    default_dur = struct.unpack(">I", d[o:o + 4])[0]; o += 4
                if fl & 0x10:
                    default_size = struct.unpack(">I", d[o:o + 4])[0]
            elif t3 == b"trun":
                trun = (ps3, pe3, hs3)
        if default_dur is None:
            default_dur = _trex_default_duration(init_path)
        flags, count, eo, per, do_at = _trun_layout(d, trun[0], trun[1])
        durs, sizes = [], []
        for k in range(count):
            o = eo + k * per
            if flags & 0x100:
                durs.append(struct.unpack(">I", d[o:o + 4])[0]); o += 4
            else:
                durs.append(default_dur or 0)
            if flags & 0x200:
                sizes.append(struct.unpack(">I", d[o:o + 4])[0])
            else:
                sizes.append(default_size or 0)
        n, acc = 0, 0
        for dd in durs:
            if kept_total + acc + dd > keep and (n > 0 or kept_total > 0):
                break
            acc += dd
            n += 1
        if n == count:                       # the whole fragment fits: copy as is
            out += d[hs:mdat[2]]
            kept_total += acc
            i += 2
            continue
        if n == 0:
            break
        removed = (count - n) * per
        moof = bytearray(d[hs:pe])
        base = hs

        def put32(buf, at, v):
            buf[at - base:at - base + 4] = struct.pack(">I", v)
        # sizes of moof, traf, trun shrink by `removed`; trun count -> n
        put32(moof, hs, (pe - hs) - removed)
        put32(moof, traf[3], (traf[2] - traf[3]) - removed)
        put32(moof, trun[2], (trun[1] - trun[2]) - removed)
        put32(moof, trun[0] + 4, n)
        payload_at = None
        if do_at is not None:
            off = struct.unpack(">i", d[do_at:do_at + 4])[0]
            payload_at = hs + off
            moof[do_at - base:do_at - base + 4] = struct.pack(">i", off - removed)
        cut0 = eo + n * per
        moof = moof[:cut0 - base] + moof[(eo + count * per) - base:]
        if payload_at is None:
            payload_at = mdat[1]
        keep_bytes = sum(sizes[:n])
        out += moof
        out += struct.pack(">I4s", 8 + keep_bytes, b"mdat") + d[payload_at:payload_at + keep_bytes]
        kept_total += acc
        done = True
    tmp = f"{dst}.tmp"
    with open(tmp, "wb") as fh:
        fh.write(out)
    import os
    os.replace(tmp, dst)
    return kept_total


def _box(typ, *parts):
    body = b"".join(parts)
    return struct.pack(">I4s", 8 + len(body), typ) + body


def keyframe_fragment(data, dur, new_tfdt=None):
    """One DASH trick-mode segment: the keyframe that opens fragment `data` (its
    first moof's first sample) as a fragment of its own, one sample lasting `dur`
    timescale units, decode time `new_tfdt` (the fragment's own when None).

    The Python twin of keyframeFragment in volt-app services/trickplay/iframes.ts,
    for the playout loop (build queue 3.2b-8): same track id, so it plays with the
    rendition's own init. Clear tracks only (the loop is never encrypted); None for
    an encrypted fragment, sample groups, no moof, or a first sample that is not a
    sync sample. Nothing is decoded or encoded: the keyframe's bytes are copied."""
    moof = next(((ps, pe, hs) for t, ps, pe, hs in _boxes(data) if t == b"moof"), None)
    if moof is None:
        return None
    mps, mpe, mhs = moof
    traf = next(((ps, pe) for t, ps, pe, _h in _boxes(data, mps, mpe) if t == b"traf"), None)
    if traf is None:
        return None
    kids = {}
    for t, ps, pe, _h in _boxes(data, traf[0], traf[1]):
        kids.setdefault(t, (ps, pe))
    if b"senc" in kids or b"sbgp" in kids or b"tfhd" not in kids or b"trun" not in kids:
        return None
    ps, _pe = kids[b"tfhd"]
    tf = int.from_bytes(data[ps + 1:ps + 4], "big")
    track_id = struct.unpack(">I", data[ps + 4:ps + 8])[0]
    q = ps + 8
    base = mhs                                  # default-base-is-moof, and the first traf's rule
    if tf & 0x01:
        base = struct.unpack(">Q", data[q:q + 8])[0]
        q += 8
    if tf & 0x02:
        q += 4
    if tf & 0x08:
        q += 4
    def_size = def_flags = None
    if tf & 0x10:
        def_size = struct.unpack(">I", data[q:q + 4])[0]
        q += 4
    if tf & 0x20:
        def_flags = struct.unpack(">I", data[q:q + 4])[0]
    decode = 0
    if b"tfdt" in kids:
        ps, _pe = kids[b"tfdt"]
        decode = struct.unpack(">Q", data[ps + 4:ps + 12])[0] if data[ps] == 1 else struct.unpack(">I", data[ps + 4:ps + 8])[0]
    ps, _pe = kids[b"trun"]
    ver = data[ps]
    fl = int.from_bytes(data[ps + 1:ps + 4], "big")
    if struct.unpack(">I", data[ps + 4:ps + 8])[0] < 1:
        return None
    o = ps + 8
    doff = 0
    if fl & 0x001:
        doff = struct.unpack(">i", data[o:o + 4])[0]
        o += 4
    first_flags = None
    if fl & 0x004:
        first_flags = struct.unpack(">I", data[o:o + 4])[0]
        o += 4
    size, cto, sflags = def_size, 0, None
    if fl & 0x100:
        o += 4
    if fl & 0x200:
        size = struct.unpack(">I", data[o:o + 4])[0]
        o += 4
    if fl & 0x400:
        sflags = struct.unpack(">I", data[o:o + 4])[0]
        o += 4
    if fl & 0x800:
        cto = struct.unpack(">i" if ver == 1 else ">I", data[o:o + 4])[0]
    flags = first_flags if first_flags is not None else sflags if sflags is not None else def_flags
    if not size or (flags is not None and flags & 0x00010000):
        return None                             # no size, or not a sync sample
    start = base + doff
    if start < mpe or start + size > len(data):
        return None
    sample = data[start:start + size]
    tfdt = decode if new_tfdt is None else int(new_tfdt)

    def build(data_offset):
        trun = _box(b"trun", struct.pack(">I", (1 << 24) | 0x000f01), struct.pack(">I", 1),
                    struct.pack(">i", data_offset), struct.pack(">I", max(1, int(round(dur)))),
                    struct.pack(">I", size), struct.pack(">I", 0x02000000), struct.pack(">i", cto))
        traf_n = _box(b"traf", _box(b"tfhd", struct.pack(">I", 0x020000), struct.pack(">I", track_id)),
                      _box(b"tfdt", struct.pack(">I", 1 << 24), struct.pack(">Q", tfdt)), trun)
        return _box(b"moof", _box(b"mfhd", struct.pack(">I", 0), struct.pack(">I", 1)), traf_n)
    probe = build(0)                            # sizes do not depend on the offset
    return build(len(probe) + 8) + _box(b"mdat", sample)
