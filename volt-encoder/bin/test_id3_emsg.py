#!/usr/bin/env python3
"""Now-playing as ID3 in emsg (id3_emsg.py), on fixed inputs.

The bytes (ID3v2.4, emsg version 1, where the box goes and the sidx it moves),
which segments get a tag (a change, the title in force, a repeat, a change
learnt late), and the radio delivered copies on real ffmpeg output: HLS points
only tagged segments at id3/, DASH keeps a full id3/ window, and anything
unexpected leaves ffmpeg's files in the playlist. The whole path against a
synthetic ICY source is volt-app/test/radio-id3.check.ts. Usage:
    python3 volt-encoder/bin/test_id3_emsg.py
"""
import os
import shutil
import struct
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import id3_emsg as m  # noqa: E402
import radio  # noqa: E402

ok = bad = 0


def check(msg, got, want):
    global ok, bad
    if got == want:
        ok += 1
        print(f"PASS {msg}")
    else:
        bad += 1
        print(f"FAIL {msg} -- expected [{want}] got [{got}]")


print("== ID3v2.4 ==")
tag = m.id3_tag("Neon Rain", "Aurora Skies")
check("starts ID3 v2.4, no flags", tag[:6], b"ID3\x04\x00\x00")
check("size is syncsafe and covers the frames", m._unsyncsafe(tag[6:10]), len(tag) - 10)
check("TIT2 then TPE1, UTF-8 (encoding 3)", (tag[10:14], tag[20], tag[10 + 10 + 1 + 9:10 + 10 + 1 + 9 + 4]), (b"TIT2", 3, b"TPE1"))
check("reads back", m.parse_id3(tag), {"TIT2": "Neon Rain", "TPE1": "Aurora Skies"})
check("no artist, no TPE1", m.parse_id3(m.id3_tag("News bulletin")), {"TIT2": "News bulletin"})
check("non-ASCII titles survive", m.parse_id3(m.id3_tag("Sorotan Berita 华语", "Siti Nurhaliza"))["TIT2"], "Sorotan Berita 华语")
big = m.id3_tag("x" * 300)
check("a frame over 127 bytes keeps a syncsafe size (no byte above 0x7F)", all(b < 0x80 for b in big[14:18]) and m.parse_id3(big)["TIT2"] == "x" * 300, True)

print("\n== emsg version 1 ==")
e = m.emsg_box(tag, 1234567890123, 48000, 42)
check("box type and size", (e[4:8], struct.unpack(">I", e[:4])[0]), (b"emsg", len(e)))
check("version 1, flags 0", e[8:12], b"\x01\x00\x00\x00")
p = m.parse_emsg(e, 0, len(e))
check("timescale, 64-bit presentation time, unknown duration, id",
      (p["timescale"], p["presentation_time"], p["duration"], p["id"]), (48000, 1234567890123, 0xFFFFFFFF, 42))
check("scheme https://aomedia.org/emsg/ID3, empty value", (p["scheme"], p["value"]), ("https://aomedia.org/emsg/ID3", ""))
check("the message is the ID3 tag", p["message"], tag)
check("ids differ per moment, same for the same moment",
      (m.event_id("p1", 10.0) != m.event_id("p1", 40.0), m.event_id("p1", 10.0) == m.event_id("p1", 10.0)), (True, True))


def box(typ, body):
    return struct.pack(">I4s", 8 + len(body), typ) + body


def fake_segment(tfdt=96000, sidx=True):
    tfhd = box(b"tfhd", b"\x00\x02\x00\x00" + struct.pack(">I", 1))
    tfdt_b = box(b"tfdt", b"\x01\x00\x00\x00" + struct.pack(">Q", tfdt))
    moof = box(b"moof", box(b"mfhd", b"\x00" * 8) + box(b"traf", tfhd + tfdt_b))
    mdat = box(b"mdat", b"\xAA" * 64)
    styp = box(b"styp", b"msdh\x00\x00\x00\x00msdhmsix")
    if not sidx:
        return styp + moof + mdat
    sidx_b = box(b"sidx", b"\x00\x00\x00\x00" + struct.pack(">IIII", 1, 48000, tfdt, 0) +
                 struct.pack(">HH", 0, 1) + struct.pack(">III", len(moof) + len(mdat), 96000, 0x90000000))
    return styp + sidx_b + moof + mdat


print("\n== placement in a segment ==")
seg = fake_segment()
out = m.stamp(seg, 48000, 100.0, [(100.0, {"id": "a", "title": "One"}), (101.5, {"id": "b", "title": "Two", "artist": "Band"})])
order = [t for t, _, _ in m.boxes(out)]
check("styp, sidx, the emsgs, then moof and mdat", order, ["styp", "sidx", "emsg", "emsg", "moof", "mdat"])
sidx_off = m.boxes(out)[1][1]
first_offset = struct.unpack(">I", out[sidx_off + 24:sidx_off + 28])[0]
moof_off = next(o for t, o, _ in m.boxes(out) if t == "moof")
check("the sidx first_offset now lands exactly on the moof", sidx_off + m.boxes(out)[1][2] + first_offset, moof_off)
check("moof and mdat bytes unchanged", out[moof_off:], seg[seg.index(b"moof") - 4:])
ev = m.read_emsgs(out)
check("first tag at the segment start: tfdt", ev[0]["presentation_time"], 96000)
check("second 1.5 s in on the 48 kHz timeline", ev[1]["presentation_time"], 96000 + 72000)
check("their tags", [m.parse_id3(x["message"]) for x in ev], [{"TIT2": "One"}, {"TIT2": "Two", "TPE1": "Band"}])
out2 = m.stamp(fake_segment(sidx=False), 48000, 100.0, [(100.0, {"id": "a", "title": "One"})])
check("a segment without sidx (ffmpeg's DASH chunks) gets it after styp", [t for t, _, _ in m.boxes(out2)], ["styp", "emsg", "moof", "mdat"])
for name, bad_seg in (("no moof", box(b"styp", b"x" * 8) + box(b"mdat", b"x")), ("a truncated segment", fake_segment()[:-10])):
    try:
        m.stamp(bad_seg, 48000, 0, [(0, {"id": "a", "title": "x"})])
        check(f"{name} is refused", "accepted", "refused")
    except ValueError:
        check(f"{name} is refused", "refused", "refused")

print("\n== which segments carry a tag ==")
E = lambda id_, at, title: {"id": id_, "_at": at, "title": title}
log = [E("p1", 90.0, "Song A"), E("p2", 103.0, "Song B")]
s = m.Stamper(repeat_sec=30)
check("the first segment carries the title in force at its start", [(a, e["id"]) for a, e in s.plan(100, 102, log)], [(100, "p1")])
check("the next segment, same title, nothing", s.plan(102, 103, log), [])
s = m.Stamper(repeat_sec=30)
s.plan(100, 102, log)
check("a change inside a segment at its own moment", [(a, e["id"]) for a, e in s.plan(102, 104, log)], [(103.0, "p2")])
check("then quiet", s.plan(104, 106, log), [])
check("the same title again after the repeat time", [(a, e["id"]) for a, e in s.plan(133, 135, log)], [(133, "p2")])
s = m.Stamper(repeat_sec=30)
s.plan(100, 102, [log[0]])
s.plan(102, 104, [log[0]])          # p2 not known yet when this segment went out
check("a change learnt late goes on the next segment's start", [(a, e["id"]) for a, e in s.plan(104, 106, log)], [(104, "p2")])
check("never early: nothing before the log has a change", m.Stamper().plan(80, 82, log), [])
check("no log, no tags", m.Stamper().plan(100, 102, []), [])
check("wire entries: ISO start to epoch, bad ones dropped",
      [(x["id"], x["_at"]) for x in m.entries_from_wire([{"id": "p1", "start": "2026-10-23T00:00:00.000Z", "title": "A"}, {"id": "x"}, {"start": "2026-10-23T00:00:00Z"}, "junk"])],
      [("p1", 1792713600.0)])

print("\n== the radio delivered copies, on real ffmpeg output ==")
if not shutil.which("ffmpeg"):
    print("SKIP ffmpeg not installed")
else:
    d = tempfile.mkdtemp()
    paths = {"run": d, "audio": os.path.join(d, "audio"), "dash": os.path.join(d, "dash")}
    os.makedirs(paths["audio"]); os.makedirs(paths["dash"])
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=12",
                    "-map", "0:a:0", "-c:a", "aac", "-b:a", "96k", "-ac", "2",
                    "-f", "hls", "-hls_time", "2", "-hls_list_size", "0", "-hls_flags", "program_date_time+independent_segments",
                    "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
                    "-hls_segment_filename", os.path.join(paths["audio"], "seg_%05d.m4s"), os.path.join(paths["audio"], "index.m3u8"),
                    "-map", "0:a:0", "-c:a", "aac", "-b:a", "96k", "-ac", "2",
                    "-f", "dash", "-seg_duration", "2", "-streaming", "1", "-window_size", "20", "-extra_window_size", "10",
                    "-remove_at_exit", "0", os.path.join(paths["dash"], "manifest.mpd")], check=True)
    with open(os.path.join(d, "master.m3u8"), "w") as fh:
        fh.write(radio.master_playlist(96))
    text = open(os.path.join(paths["audio"], "index.m3u8")).read()
    segs = m.hls_segments(text)
    # AAC frames are 1024 samples, so ffmpeg cuts near 2 s, not on it.
    check("ffmpeg's playlist read: about 2 s segments with PROGRAM-DATE-TIME, 12 s in all",
          (len(segs) >= 6, all(abs(x[2] - 2) < 0.6 for x in segs[:-1]), round(sum(x[2] for x in segs))), (True, True, 12))
    names = [x[0] for x in segs]
    k = next(i for i, x in enumerate(segs) if x[1] <= segs[0][1] + 5.0 < x[1] + x[2])   # the segment holding +5 s
    t0 = segs[0][1]
    now = [{"id": "p1", "_at": t0 - 5, "title": "Neon Rain", "artist": "Aurora Skies"},
           {"id": "p2", "_at": t0 + 5.0, "title": "Paper Boats", "artist": "The Midnight Owls"}]
    outs = {"hls": True, "dash": True, "mp3": False}

    before = {f: open(os.path.join(paths["audio"], f), "rb").read() for f in os.listdir(paths["audio"])}
    state = {}
    wrote = radio.refresh_delivered(paths, outs, 96, [], state, now)
    cc = open(os.path.join(paths["audio"], "index_cc.m3u8")).read()
    uris = [x[0] for x in m.hls_segments(cc)]
    # Joining a run in progress: only the newest three are looked at, so the
    # title in force (the change at +5 s is older than them) goes on the first.
    j = names[-3]
    check("joining a run: the delivered copy points the first of the newest three at id3/, the rest at ffmpeg's", uris,
          [("id3/" + n if n == j else n) for n in names])
    tagged = open(os.path.join(paths["audio"], "id3", j), "rb").read()
    check("the tag in it is the title in force, at the segment start",
          [(x["presentation_time"] - m.first_tfdt(tagged), m.parse_id3(x["message"])) for x in m.read_emsgs(tagged)],
          [(0, {"TIT2": "Paper Boats", "TPE1": "The Midnight Owls"})])
    after = {f: open(os.path.join(paths["audio"], f), "rb").read() for f in before}
    check("ffmpeg's files are byte-identical after the cycle", after == before, True)
    check("the master leads to the delivered copy", "audio/index_cc.m3u8" in open(os.path.join(d, "master.m3u8")).read(), True)
    cat = os.path.join(d, "cat.mp4")
    with open(cat, "wb") as fh:
        fh.write(open(os.path.join(paths["audio"], "init.mp4"), "rb").read() + tagged)
    ref = os.path.join(d, "ref.mp4")
    with open(ref, "wb") as fh:
        fh.write(open(os.path.join(paths["audio"], "init.mp4"), "rb").read() + before[j])
    md5 = lambda f: subprocess.run(["ffmpeg", "-v", "error", "-i", f, "-f", "md5", "-"], capture_output=True, text=True).stdout.strip()
    check("ffmpeg decodes the tagged copy to the same audio", (md5(cat) != "", md5(cat) == md5(ref)), (True, True))

    # From the start of a run (a fresh state that has seen nothing yet).
    state2 = {"hls_seen": True}
    shutil.rmtree(os.path.join(paths["audio"], "id3"))
    radio.refresh_delivered(paths, {"hls": True}, 96, [], state2, now)
    cc = open(os.path.join(paths["audio"], "index_cc.m3u8")).read()
    check("from a run's start: the first segment has the title in force, the one holding +5 s the change",
          [x[0] for x in m.hls_segments(cc) if x[0].startswith("id3/")], ["id3/" + names[0], "id3/" + names[k]])
    s2 = open(os.path.join(paths["audio"], "id3", names[k]), "rb").read()
    ev2 = m.read_emsgs(s2)
    ts = m.track_timescale(open(os.path.join(paths["audio"], "init.mp4"), "rb").read())
    seg2_start = segs[k][1]
    check("the change at its own moment inside that segment, on its timeline", [(round((x["presentation_time"] - m.first_tfdt(s2)) / ts, 3), m.parse_id3(x["message"])["TIT2"]) for x in ev2],
          [(round(t0 + 5.0 - seg2_start, 3), "Paper Boats")])
    check("a second cycle stamps nothing new and keeps the mapping", (radio.refresh_delivered(paths, {"hls": True}, 96, [], state2, now), sorted(os.listdir(os.path.join(paths["audio"], "id3")))),
          (["audio/index_cc.m3u8"], sorted([names[0], names[k]])))

    print("\n== DASH ==")
    mpd_own = open(os.path.join(paths["dash"], "manifest.mpd")).read()
    # ffmpeg ended the run, so its MPD is static: give it the live run's clock.
    mpd_live = mpd_own.replace('type="static"', f'type="dynamic" availabilityStartTime="{radio.time.strftime("%Y-%m-%dT%H:%M:%S", radio.time.gmtime(int(t0)))}.000Z"')
    with open(os.path.join(paths["dash"], "manifest.mpd"), "w") as fh:
        fh.write(mpd_live)
    parsed = m.dash_segments(mpd_live)
    nums = [n for n, _, _ in parsed[2]]
    check("ffmpeg's MPD read: template, representation, segments numbered from 1", (parsed[0], parsed[1], len(nums) >= 6, nums == list(range(1, len(nums) + 1))),
          ("chunk-stream$RepresentationID$-$Number%05d$.m4s", "0", True, True))
    dk = next(n for n, st, du in parsed[2] if st <= t0 + 5.0 < st + du)
    state3 = {}
    radio.refresh_delivered(paths, {"dash": True}, 96, [], state3, now)
    cc = open(os.path.join(paths["dash"], "manifest_cc.mpd")).read()
    check("the delivered MPD names the id3/ copies", 'media="id3/chunk-stream$RepresentationID$-$Number%05d$.m4s"' in cc, True)
    check("and declares the ID3 InbandEventStream in the AdaptationSet", '<InbandEventStream schemeIdUri="https://aomedia.org/emsg/ID3" value=""/>' in cc
          and cc.index("<AdaptationSet") < cc.index("InbandEventStream") < cc.index("<Representation"), True)
    listed = sorted(os.listdir(os.path.join(paths["dash"], "id3")))
    check("every listed segment is in id3/", listed, [f"chunk-stream0-{n:05d}.m4s" for n in nums])
    tags = {n: m.read_emsgs(open(os.path.join(paths["dash"], "id3", f"chunk-stream0-{n:05d}.m4s"), "rb").read()) for n in nums}
    check("tags on the first segment (title in force) and the one holding +5 s (the change), none elsewhere",
          {n: [m.parse_id3(x["message"])["TIT2"] for x in v] for n, v in tags.items() if v}, {1: ["Neon Rain"], dk: ["Paper Boats"]})
    st1 = os.stat(os.path.join(paths["dash"], "id3", "chunk-stream0-00002.m4s"))
    st0 = os.stat(os.path.join(paths["dash"], "chunk-stream0-00002.m4s"))
    check("untagged segments are hard links, not copies", st1.st_ino == st0.st_ino, True)
    check("ffmpeg's MPD is untouched", open(os.path.join(paths["dash"], "manifest.mpd")).read() == mpd_live, True)

    print("\n== fails open ==")
    paths4 = {"run": d, "audio": paths["audio"]}
    broken = tempfile.mkdtemp()
    shutil.copy(os.path.join(paths["audio"], "index.m3u8"), broken)
    shutil.copy(os.path.join(paths["audio"], "init.mp4"), broken)
    for f in os.listdir(paths["audio"]):
        if f.startswith("seg_"):
            open(os.path.join(broken, f), "wb").write(b"\x00\x00\x00\x10junkjunkjunk")
    r = "audio/index_cc.m3u8" in radio.refresh_delivered({"run": broken, "audio": broken}, {"hls": True}, 96, [], {"hls_seen": True}, now)
    check("segments that do not parse: the delivered copy keeps ffmpeg's names", ("id3/" in open(os.path.join(broken, "index_cc.m3u8")).read(), r), (False, True))
    r = radio.refresh_delivered(paths, {"hls": True}, 96, [], {}, None)
    check("no now-playing (television, or an old control plane): no id3/ references", "id3/" in open(os.path.join(paths["audio"], "index_cc.m3u8")).read(), False)
    mpd_odd = mpd_live.replace("</Representation>", "</Representation><Representation id=\"1\"></Representation>")
    check("an MPD that is not the radio shape is passed through", m.refresh_dash(paths["dash"], mpd_odd, now, {}), mpd_odd)

print("\n== the radio image ships what radio.py imports ==")
import re as _re  # noqa: E402
here = os.path.dirname(os.path.abspath(__file__))
local = {f[:-3] for f in os.listdir(here) if f.endswith(".py")}
wanted = set()
for f in ("radio.py", "timed_events.py", "id3_emsg.py", "events.py"):
    src = open(os.path.join(here, f)).read()
    wanted |= {x for x in _re.findall(r"^\s*(?:import|from)\s+(\w+)", src, _re.M) if x in local}
docker = open(os.path.join(here, "..", "Dockerfile.radio")).read()
check("every local module the radio container imports is copied into Dockerfile.radio",
      sorted(x for x in wanted if f"COPY bin/{x}.py" not in docker), [])

print(f"\n{ok} passed, {bad} failed")
sys.exit(1 if bad else 0)
