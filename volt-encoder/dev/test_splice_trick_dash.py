#!/usr/bin/env python3
"""DASH trick-mode that follows the playout splice (build queue 3.2b-8 (c2)). Offline.

WHAT THIS GUARDS:
  * The loop's keyframes are re-wrapped once when the loop is prepared, only for the
    rendition the packager cuts its trick track from: each one a fragment of its own
    that decodes alone to the loop segment's first picture.
  * While playout splices the loop in (the source is late, or an operator forces the
    loop), the delivered multi-Period MPD has a trick-mode AdaptationSet in every
    Period, marked with the dashif trickmode property naming THAT Period's video set:
      - live Periods list the packager's own trick segments over exactly the media
        time of the video they were cut from (same offset, consecutive numbers, never
        one consumed while the loop was forced);
      - loop Periods list the loop's keyframes slot for slot, re-timed (tfdt) into
        the Period, the last one cut to end with a closed Period, every one decoding
        alone to a loop picture and never to the programme the break replaced.
  * Entries roll with the window and slot copies are dropped with their Period.
  * A Period first published without a trick set keeps none. Switched off (no trick
    set from the packager), nothing is listed or written.

Media is made here with ffmpeg (fMP4, 4 s segments). The packager's live trick
segments are stood in for by keyframe fragments of the live segments (one keyframe
lasting the segment, as Shaka Packager writes with trick_play_factor=1); Shaka's
own live layout is not available here: see BUILD_QUEUE.md 3.2b-8.

Run: python3 test_splice_trick_dash.py   (from volt-encoder/dev)
For the player check (splice_trick_dash_shaka.mjs, Chromium has no H.264):
    SPLICE_TRICK_CODEC=vp9 SPLICE_TRICK_KEEP=<dir> python3 test_splice_trick_dash.py
keeps the media and the mid-break MPD (manifest_mid.mpd) in <dir>.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "bin"))
import encoder  # noqa: E402
import mp4util  # noqa: E402
import playout as P  # noqa: E402

p = f = 0
NS = "{urn:mpeg:dash:schema:mpd:2011}"


def ok(c, m):
    global p, f
    if c:
        p += 1
        print("PASS", m)
    else:
        f += 1
        print("FAIL", m)


def sh(*a):
    return subprocess.run(list(a), check=True, capture_output=True)


SEGD = 4.0
VP9 = os.environ.get("SPLICE_TRICK_CODEC") == "vp9"
KEEP = os.environ.get("SPLICE_TRICK_KEEP")
CODECS = ("vp09.00.30.08", "vp09.00.20.08") if VP9 else ("avc1.64001e", "avc1.64000d")


def make(d, folder, w, h, secs, colour):
    out = os.path.join(d, folder)
    os.makedirs(out, exist_ok=True)
    enc = (["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-lag-in-frames", "0",
            "-auto-alt-ref", "0", "-b:v", "400k"] if VP9 else
           ["-c:v", "libx264", "-preset", "ultrafast", "-sc_threshold", "0"])
    sh("ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"testsrc2=size={w}x{h}:rate=25:duration={secs}",
       "-vf", f"drawbox=c={colour}:t=10", *enc, "-g", "50", "-keyint_min", "50",
       "-pix_fmt", "yuv420p", "-f", "hls", "-hls_time", "4", "-hls_playlist_type", "vod",
       "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4", "-start_number", "1",
       "-hls_segment_filename", os.path.join(out, "seg_%d.m4s"), os.path.join(out, "ffmpeg.m3u8"))
    return sorted(int(x[4:-4]) for x in os.listdir(out) if x.startswith("seg_"))


def frame_md5s(path, n=None):
    a = ["ffmpeg", "-v", "error", "-i", path, "-map", "0:v:0"] + (["-frames:v", str(n)] if n else []) + ["-f", "framemd5", "-"]
    return [l.split(",")[-1].strip() for l in sh(*a).stdout.decode().splitlines() if l and not l.startswith("#")]


def key_flags(path):
    o = sh("ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=flags", "-of", "csv=p=0", path).stdout.decode()
    return [l.strip() for l in o.splitlines() if l.strip()]


def alone(d, init, seg, tmp):
    """(packets, keyframe?, md5 of its picture) of init + seg."""
    path = os.path.join(d, tmp)
    with open(path, "wb") as fh:
        fh.write(open(os.path.join(d, init), "rb").read() + open(os.path.join(d, seg), "rb").read())
    fl = key_flags(path)
    md = frame_md5s(path)
    return len(fl), bool(fl) and fl[0].startswith("K"), (md[0] if len(md) == 1 else None)


def first_pic(d, init, seg, tmp="full.mp4"):
    path = os.path.join(d, tmp)
    with open(path, "wb") as fh:
        fh.write(open(os.path.join(d, init), "rb").read() + open(os.path.join(d, seg), "rb").read())
    return frame_md5s(path, 1)[0]


def hls(label, first, last):
    out = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-TARGETDURATION:4", f'#EXT-X-MAP:URI="{label}/init.mp4"']
    for n in range(first, last + 1):
        out += [f"#EXTINF:{SEGD:.3f},", f"{label}/seg_{n}.m4s"]
    return "\n".join(out) + "\n"


def tl_xml(d, label, first, last):
    s = []
    for n in range(first, last + 1):
        seg = os.path.join(d, label, f"seg_{n}.m4s")
        s.append(f'<S t="{mp4util.tfdt(seg)}" d="{mp4util.frag_duration(seg, os.path.join(d, label, "init.mp4"))}"/>')
    return "".join(s)


def packager_mpd(d, first, last, with_trick):
    """The packager's own live MPD, as Shaka writes it: SegmentTimeline per Representation,
    and (switch on) the keyframe-only set marked with the dashif trickmode property."""
    trick = ""
    if with_trick:
        trick = ('<AdaptationSet id="1" contentType="video" maxWidth="640" maxHeight="360" mimeType="video/mp4">'
                 '<EssentialProperty schemeIdUri="http://dashif.org/guidelines/trickmode" value="0"/>'
                 f'<Representation id="2" bandwidth="60000" codecs="{CODECS[0]}" width="640" height="360" maxPlayoutRate="1" codingDependency="false">'
                 f'<SegmentTemplate timescale="{TS}" initialization="360p_trick/init.mp4" media="360p_trick/seg_$Number$.m4s" startNumber="{first}">'
                 f'<SegmentTimeline>{tl_xml(d, "360p_trick", first, last)}</SegmentTimeline></SegmentTemplate></Representation></AdaptationSet>')
    return ('<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic"><Period id="0">'
            '<AdaptationSet id="0" contentType="video" mimeType="video/mp4" segmentAlignment="true">'
            f'<Representation id="0" bandwidth="900000" codecs="{CODECS[0]}" width="640" height="360">'
            f'<SegmentTemplate timescale="{TS}" initialization="360p/init.mp4" media="360p/seg_$Number$.m4s" startNumber="{first}">'
            f'<SegmentTimeline>{tl_xml(d, "360p", first, last)}</SegmentTimeline></SegmentTemplate></Representation>'
            f'<Representation id="1" bandwidth="300000" codecs="{CODECS[1]}" width="320" height="180">'
            f'<SegmentTemplate timescale="{TS}" initialization="180p/init.mp4" media="180p/seg_$Number$.m4s" startNumber="{first}">'
            f'<SegmentTimeline>{tl_xml(d, "180p", first, last)}</SegmentTimeline></SegmentTemplate></Representation>'
            '</AdaptationSet>' + trick + '</Period></MPD>')


MASTER = """#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=900000,CODECS="avc1.64001e",RESOLUTION=640x360
stream_0.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=300000,CODECS="avc1.64000d",RESOLUTION=320x180
stream_1.m3u8
"""
TS = None


def expand(tpl):
    """[(number, t, d)] of a SegmentTemplate element."""
    out, n, t = [], int(tpl.get("startNumber")), None
    for s in tpl.find(NS + "SegmentTimeline"):
        t = int(s.get("t")) if s.get("t") is not None else t
        for _ in range(int(s.get("r") or 0) + 1):
            out.append((n, t, int(s.get("d"))))
            n += 1
            t += int(s.get("d"))
    return out


def periods(mpd_text):
    """[{id, start, dur, sets: [{id, trick_of, reps: [{media, init, pto, ts, segs, attrs}]}]}]"""
    root = ET.fromstring(mpd_text)
    out = []
    for per in root.findall(NS + "Period"):
        sets = []
        for a in per.findall(NS + "AdaptationSet"):
            ep = a.find(NS + "EssentialProperty")
            reps = []
            for r in a.findall(NS + "Representation"):
                tpl = r.find(NS + "SegmentTemplate")
                reps.append({"media": tpl.get("media"), "init": tpl.get("initialization"),
                             "pto": int(tpl.get("presentationTimeOffset")), "ts": int(tpl.get("timescale")),
                             "segs": expand(tpl), "attrs": dict(r.attrib)})
            sets.append({"id": a.get("id"), "trick_of": ep.get("value") if ep is not None and "trickmode" in (ep.get("schemeIdUri") or "") else None,
                         "reps": reps})
        dur = per.get("duration")
        out.append({"id": per.get("id"), "start": float(per.get("start")[2:-1]),
                    "dur": float(dur[2:-1]) if dur else None, "sets": sets})
    return out


def seg_path(media, n):
    return media.replace("$Number$", str(n))


def main():
    global p, f, TS
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        print("SKIP: ffmpeg and ffprobe are needed")
        return 0
    d = KEEP or tempfile.mkdtemp(prefix="splicetrickdash-")
    os.makedirs(d, exist_ok=True)
    live = {"360p": make(d, "360p", 640, 360, 160, "red"), "180p": make(d, "180p", 320, 180, 160, "red")}
    make(d, "filler/360p", 640, 360, 12, "blue")
    make(d, "filler/180p", 320, 180, 12, "blue")
    TS = mp4util.timescale(os.path.join(d, "360p", "init.mp4"))
    # the packager's live trick track: one keyframe lasting each segment, same numbers
    os.makedirs(os.path.join(d, "360p_trick"))
    shutil.copy(os.path.join(d, "360p", "init.mp4"), os.path.join(d, "360p_trick", "init.mp4"))
    for n in live["360p"]:
        src = os.path.join(d, "360p", f"seg_{n}.m4s")
        frag = mp4util.keyframe_fragment(open(src, "rb").read(), mp4util.frag_duration(src, os.path.join(d, "360p", "init.mp4")))
        open(os.path.join(d, "360p_trick", f"seg_{n}.m4s"), "wb").write(frag)
    live_pics = {first_pic(d, "360p/init.mp4", f"360p/seg_{n}.m4s") for n in live["360p"]}
    ok(len(live["360p"]) >= 39 and live["360p"] == live["180p"], f"(live media made: {len(live['360p'])} segments a rendition)")

    def fil(label):
        ts = mp4util.timescale(os.path.join(d, "filler", label, "init.mp4"))
        return {"init": f"filler/{label}/init.mp4", "timescale": ts,
                "segments": [{"uri": f"filler/{label}/seg_{i}.m4s", "dur": SEGD,
                              "d": mp4util.frag_duration(os.path.join(d, "filler", label, f"seg_{i}.m4s"),
                                                         os.path.join(d, "filler", label, "init.mp4"))} for i in (1, 2, 3)]}

    print("== the loop's keyframes, prepared once ==")
    fillers = {"360p": fil("360p"), "180p": fil("180p")}
    done = encoder.prepare_loop_trick(fillers, d)
    tk = fillers["360p"].get("trick") or {}
    ok(done == ["360p"] and "trick" not in fillers["180p"], f"only the rendition the packager cuts its trick track from: {done}")
    ok(len(tk.get("segments") or []) == 3 and [s["d"] for s in tk["segments"]] == [s["d"] for s in fillers["360p"]["segments"]],
       "one keyframe fragment per loop segment, each lasting its segment")
    good = 0
    loop_pics = set()
    for i, s in enumerate(tk.get("segments") or []):
        n, key, md = alone(d, "filler/360p/init.mp4", s["uri"], "k.mp4")
        pic = first_pic(d, "filler/360p/init.mp4", fillers["360p"]["segments"][i]["uri"])
        loop_pics.add(pic)
        good += n == 1 and key and md == pic
    ok(good == 3, f"each decodes alone to one keyframe, the loop segment's first picture ({good}/3)")
    ok(int(tk.get("bandwidth") or 0) > 0 and int(tk["bandwidth"]) < 900000, f"a keyframe bitrate for the MPD ({tk.get('bandwidth')} bit/s)")
    ok(not (loop_pics & live_pics), "(the loop's pictures are not the programme's)")

    E0 = 1_000_000.0
    po = P.Playout(fillers, window_sec=80, hold_sec=2.4, pdt_of=lambda uri: E0 + (P._seg_key(uri) - 1) * SEGD)

    def media_of(uri):
        path = os.path.join(d, uri)
        init = os.path.join(os.path.dirname(path), "init.mp4")
        return (mp4util.tfdt(path), mp4util.frag_duration(path, init), mp4util.timescale(init))
    dropped = []

    def on_drop(uri):
        dropped.append(uri)
        try:
            os.remove(os.path.join(d, uri))
        except OSError:
            pass

    def on_link(src, dst):
        pth = os.path.join(d, dst)
        os.makedirs(os.path.dirname(pth), exist_ok=True)
        if not os.path.exists(pth):
            os.link(os.path.join(d, src), pth)

    def on_cut(src, dst, keep, init):
        pth = os.path.join(d, dst)
        os.makedirs(os.path.dirname(pth), exist_ok=True)
        return mp4util.truncate(os.path.join(d, src), pth, keep, os.path.join(d, init) if init else None)
    po.media_of = media_of
    po.on_slot = lambda src, dst, t: mp4util.rebase(os.path.join(d, src), os.path.join(d, dst), t)
    po.on_drop, po.on_link, po.on_cut = on_drop, on_link, on_cut
    po.on_trick = lambda src, dst, t, dd: encoder.write_trick_slot(d, src, dst, t, dd)
    encoder._PLAYOUT = po
    encoder._TRIGGERS = None
    encoder._with_triggers = lambda text: text
    encoder._with_trigger_events = lambda text: text
    encoder._KF_RANGES.clear()

    def deliver(last, trick_on=True):
        # the packager names a shorter window than playout delivers (after a break the
        # delivered window reaches further back): older trick segments are remembered
        first = max(1, last - 10)
        open(os.path.join(d, "manifest.mpd"), "w").write(packager_mpd(d, first, last, trick_on))
        encoder._MPD_INFO.update(mtime=None)
        real, clock = po.update, po.pdt_of
        po.update = lambda *a, **k: None
        encoder._playout_pass(d, MASTER.splitlines(), SEGD)
        po.update, po.pdt_of = real, clock      # the pass sets the encoder's own clock
        return open(os.path.join(d, "manifest_cc.mpd")).read()

    now, last, nxt = 0.0, 0, SEGD
    forced_consumed = set()
    snaps = {}
    for sec in range(175):
        now += 1.0
        up = not (40 <= sec < 70)
        po.forced = 100 <= sec < 130
        if not up:
            nxt = now + SEGD
        elif now >= nxt and last < len(live["360p"]):
            last += 1
            nxt += SEGD
            if po.forced:
                forced_consumed.add(last)
        if last:
            first = max(1, last - 20)
            po.update(now, {"stream_0.m3u8": hls("360p", first, last), "stream_1.m3u8": hls("180p", first, last)}, "stream_0.m3u8")
            # the packager's MPD names its trick set from 20 s in: the first Period has
            # been published without one by then
            if sec % 2 == 0 or sec in (55, 120):
                snaps[sec] = deliver(last, trick_on=sec >= 20)

    final = deliver(last)
    pers = periods(final)
    kinds = [k for _, k, _, _ in po.periods()]
    print("\n== every Period has a trick set naming its video set ==")
    ok(po.splices >= 2 and "filler" in kinds, f"(the run spliced the loop in {po.splices} times; Periods in the window {kinds})")
    ok(encoder._mpd_trick(d) and encoder._mpd_trick(d)["track"] == "stream_0.m3u8", "the packager's trick set is matched to the 360p video track")
    named = 0
    for per in pers:
        tricks = [s for s in per["sets"] if s["trick_of"] is not None]
        main = [s for s in per["sets"] if s["trick_of"] is None and any(r["init"].endswith("360p/init.mp4") for r in s["reps"])]
        named += len(tricks) == 1 and len(main) == 1 and tricks[0]["trick_of"] == main[0]["id"] and tricks[0]["id"] != main[0]["id"]
    ok(pers and named == len(pers), f"one trick-mode set per Period, its property naming that Period's video set ({named}/{len(pers)})")
    ok(all(s["reps"][0]["attrs"].get("maxPlayoutRate") == "1" and s["reps"][0]["attrs"].get("codingDependency") == "false"
           for per in pers for s in per["sets"] if s["trick_of"] is not None),
       "(the packager's trick Representation attributes are kept)")

    def rep_of(per, trick):
        for s in per["sets"]:
            if (s["trick_of"] is not None) == trick:
                for r in s["reps"]:
                    if r["init"].endswith("360p/init.mp4") or (trick and r["init"].endswith("360p_trick/init.mp4")):
                        return r
        return None

    print("\n== live Periods: the packager's trick segments over the same media time ==")
    lv = [per for per in pers if not rep_of(per, False)["media"].startswith("filler/")]
    lp = [per for per in pers if rep_of(per, False)["media"].startswith("filler/")]
    same = cover = exist = 0
    for per in lv:
        m, t = rep_of(per, False), rep_of(per, True)
        same += t["media"] == "360p_trick/seg_$Number$.m4s" and t["pto"] == m["pto"] and t["ts"] == m["ts"]
        mt0 = m["segs"][0][1]
        mt1 = m["segs"][-1][1] + m["segs"][-1][2]
        nums = [x[0] for x in t["segs"]]
        cover += (all(mt0 <= x[1] < mt1 for x in t["segs"]) and nums == list(range(nums[0], nums[0] + len(nums)))
                  and [x[0] for x in m["segs"]] == nums)
        exist += all(os.path.exists(os.path.join(d, seg_path(t["media"], n))) for n in nums)
    ok(len(lv) >= 2 and same == len(lv), f"same presentation offset and timescale as the video ({same}/{len(lv)} live Periods)")
    ok(cover == len(lv), f"exactly the video's segments, by media time, consecutive numbers ({cover}/{len(lv)})")
    ok(exist == len(lv), "every listed trick segment is there")
    listed_live = {x[0] for per in lv for x in rep_of(per, True)["segs"]}
    ok(not (listed_live & forced_consumed), f"none of the {len(forced_consumed)} live trick segments from under the forced loop is listed")
    ok(min(listed_live) > 1, f"entries roll with the window (oldest listed: {min(listed_live)})")
    ok(min(listed_live) < last - 10, f"including trick segments older than the packager's own MPD still names (from {min(listed_live)}; it names {last - 10} on)")

    print("\n== loop Periods: the loop's keyframes, slot for slot ==")
    slot_ok = cut_ok = 0
    checked = keyok = notprog = 0
    for per in lp:
        m, t = rep_of(per, False), rep_of(per, True)
        slot_ok += (t["media"].startswith("filler/360p/trick/p") and t["init"] == "filler/360p/init.mp4" and t["pto"] == 0
                    and len(t["segs"]) == len(m["segs"]) and [x[1] for x in t["segs"]] == [x[1] for x in m["segs"]]
                    and int(t["attrs"]["bandwidth"]) == int(tk["bandwidth"]))
        if per["dur"] is not None:
            tot = sum(x[2] for x in t["segs"])
            cut_ok += abs(tot - per["dur"] * t["ts"]) <= 0.002 * t["ts"]
        else:
            cut_ok += 1
        for n, tt, dd in t["segs"]:
            fp = seg_path(t["media"], n)
            cnt, key, md = alone(d, t["init"], fp, "s.mp4")
            checked += 1
            keyok += cnt == 1 and key and mp4util.tfdt(os.path.join(d, fp)) == tt and mp4util.frag_duration(os.path.join(d, fp)) == dd
            notprog += md in loop_pics and md not in live_pics
    ok(len(lp) >= 1 and slot_ok == len(lp), f"one keyframe slot per loop slot, same start times, the loop's keyframe bitrate ({slot_ok}/{len(lp)} loop Periods)")
    ok(cut_ok == len(lp), "a closed loop Period's trick slots end exactly with it (the last one cut)")
    ok(checked >= 3 and keyok == checked, f"every slot decodes alone to one keyframe, at its listed time and length ({keyok}/{checked})")
    ok(notprog == checked, f"and it is a loop picture, never the programme's ({notprog}/{checked})")

    print("\n== mid-break and mid-force, as a viewer would read them ==")
    for sec, what in ((55, "outage"), (120, "forced loop")):
        sp = periods(snaps[sec])
        newest = sp[-1]
        t = rep_of(newest, True)
        ok(rep_of(newest, False)["media"].startswith("filler/") and t and t["media"].startswith("filler/360p/trick/")
           and all(os.path.exists(os.path.join(d, seg_path(t["media"], n))) or seg_path(t["media"], n) in dropped for n, *_ in t["segs"]),
           f"{what}: the newest Period is the loop's, with its keyframe slots listed ({len(t['segs']) if t else 0})")
    sp55 = periods(snaps[55])
    ok(sp55[0]["id"] == "p0" and not any(s["trick_of"] for s in sp55[0]["sets"]) and any(s["trick_of"] for s in sp55[-1]["sets"]),
       "a Period first published without a trick set keeps none; the next one has it")
    sp120 = periods(snaps[120])
    ok(not ({x[0] for per in sp120 for s in per["sets"] if s["trick_of"] for r in s["reps"] if r["media"].startswith("360p_trick") for x in r["segs"]} & forced_consumed),
       "mid-force: no programme trick segment from under the forced loop")

    print("\n== slots leave with their Period ==")
    gone_trick = [u for u in dropped if "/trick/p" in u]
    ok(gone_trick and not any(os.path.exists(os.path.join(d, u)) for u in gone_trick),
       f"trick slots of Periods that left the window are dropped ({len(gone_trick)})")
    ok(all(os.path.exists(os.path.join(d, s["uri"])) for s in tk["segments"]), "(the prepared keyframes stay for the next break)")

    print("\n== the packager's own MPD ==")
    tln = ET.fromstring('<SegmentTemplate startNumber="7"><SegmentTimeline><S t="100" d="10" r="2"/><S d="12"/><S t="200" d="5"/></SegmentTimeline></SegmentTemplate>')
    ok(encoder._mpd_timeline(tln) == [(7, 100, 10), (8, 110, 10), (9, 120, 10), (10, 130, 12), (11, 200, 5)],
       "a SegmentTimeline is read as numbered segments (r and implicit t)")
    ok(encoder._mpd_timeline(ET.fromstring('<SegmentTemplate startNumber="1"/>')) == [], "(no timeline: no segments, so nothing is guessed)")
    old_n = min(listed_live)
    gone = os.path.join(d, f"360p_trick/seg_{old_n}.m4s")
    os.rename(gone, gone + ".x")
    again = deliver(last)
    os.rename(gone + ".x", gone)
    rel = {x[0] for per in periods(again) for st in per["sets"] if st["trick_of"] for r in st["reps"] if r["media"].startswith("360p_trick") for x in r["segs"]}
    ok(old_n not in rel and rel, f"a remembered trick segment whose file is gone is not listed (seg {old_n})")

    print("\n== switched off ==")
    off = deliver(last, trick_on=False)
    ok("trickmode" not in off and "_trick/" not in off and "/trick/" not in off, "no trick set from the packager: none listed in any Period")
    ok(re.search(r"<Period ", off) and "360p/" in off, "(the MPD is otherwise delivered)")
    fl2 = {"360p": fil("360p")}
    d2 = tempfile.mkdtemp(prefix="splicetrickdash-off-")
    os.symlink(os.path.join(d, "filler"), os.path.join(d2, "filler"))
    ok(encoder.prepare_loop_trick(fl2, d2) == [] and "trick" not in fl2["360p"], "no <label>_trick/ from the packager: no loop keyframes prepared")

    print(f"\ntest_splice_trick_dash: {p} passed, {f} failed")
    if KEEP:
        open(os.path.join(d, "manifest_mid.mpd"), "w").write(snaps[120])
        print(f"kept {d} (manifest_mid.mpd: mid-force)")
    else:
        shutil.rmtree(d, ignore_errors=True)
    shutil.rmtree(d2, ignore_errors=True)
    return 1 if f else 0


if __name__ == "__main__":
    sys.exit(main())
