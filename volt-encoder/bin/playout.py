"""playout.py: manifest-level splicing of a pre-packaged loop into the DELIVERED HLS.

The problem this solves
-----------------------
Players follow a live playlist. When the live encoder stops producing segments (the
source died, the selector is mid-switch, the encoder is restarting), the playlist stops
growing, the player drains its buffer and stalls. Switching the filler in UPSTREAM of
the packager (the source selector's job) cannot close that gap: it can only act after
the loss is detected, and on a package_only channel the packager cannot take a filler
whose codec configuration differs from the source's at all, so it stopped and took the
channel down.

What this does instead
----------------------
The playlists a player reads (`<name>_cc.m3u8`, listed in `master_cc.m3u8`) are written
HERE, from the packager's own playlists. Normally that is a copy with EXT-X-PROGRAM-
DATE-TIME added. When the live edge is late by more than `hold` seconds, the next
segment slot is filled from the channel's pre-built loop (filler_build.py) instead:

    ...live 41, live 42, #EXT-X-DISCONTINUITY, #EXT-X-MAP loop init,
       loop 1, loop 2, loop 3, loop 1, ..., #EXT-X-DISCONTINUITY, #EXT-X-MAP live init,
       live 57, live 58...

A slot is added on the playlist's own cadence (one segment duration after the last),
so the delivered timeline never has a hole and never runs ahead: a player sitting a
few segments behind the edge always finds the next segment listed before it needs it.
The packager is never involved, nothing is encoded at failover time, and the same
splice works for transcode and package_only channels alike.

Rules that keep every rendition consistent
------------------------------------------
* ONE decision for the whole channel. The lead playlist (the first video variant)
  decides live vs loop; a loop SLOT is then added to every playlist at once, so all
  variants and the audio carry their discontinuities at the same places and ABR
  switching keeps working across a splice.
* Back to live as soon as the lead playlist lists a new live segment. Each playlist
  then appends its own live segments as they appear.
* PDT is continuous across a splice. Live segments carry `true PDT + shift`, where
  true PDT is the encoder's one clock (epoch + tfdt, see CAPTIONS.md) and `shift` is
  re-anchored at every return to live so the first live segment starts exactly where
  the loop ended. `shift_at()` exposes it so the subtitle track can apply the same
  shift and stay on the frames it belongs to.
* EXT-X-MEDIA-SEQUENCE and EXT-X-DISCONTINUITY-SEQUENCE advance as entries leave the
  DVR window, as the spec requires.

Pure logic: no files, no threads, an injected clock and an injected `pdt_of`. The
encoder owns the IO (see encoder._write_companion).
"""
import math
import re


def parse_media_playlist(text):
    """Shaka media playlist -> (init_uri, [(uri, dur)]). None if it looks truncated."""
    lines = [l for l in text.splitlines() if l.strip()]
    if not lines or not lines[0].startswith("#EXTM3U"):
        return None
    if not (lines[-1].startswith("#") or lines[-1].endswith((".m4s", ".mp4", ".ts"))):
        return None
    init, segs, pend, disc = None, [], None, False
    for l in lines:
        if l.startswith("#EXT-X-MAP:"):
            mo = re.search(r'URI="([^"]+)"', l)
            init = mo.group(1) if mo else init
        elif l.startswith("#EXT-X-DISCONTINUITY") and not l.startswith("#EXT-X-DISCONTINUITY-SEQUENCE"):
            # the packager's OWN discontinuity (a source whose timestamps jumped). It has
            # to survive into the delivered playlist or a player meets a timestamp jump
            # with nothing telling it to reset, and stalls.
            disc = True
        elif l.startswith("#EXTINF:"):
            try:
                pend = float(l[8:].split(",")[0])
            except ValueError:
                pend = None
        elif not l.startswith("#") and pend is not None:
            segs.append((l, pend, disc))
            pend, disc = None, False
    return init, segs


def _seg_key(uri):
    """Order of a live segment within its rendition: seg_<N>.m4s."""
    mo = re.search(r"(\d+)\.m4s$", uri)
    return int(mo.group(1)) if mo else -1


class Entry:
    __slots__ = ("uri", "dur", "kind", "disc", "init", "pdt", "t", "d", "ts", "num", "run", "period")

    def __init__(self, uri, dur, kind, disc, init, pdt, t=None, d=None, ts=None, num=None, run=0):
        self.uri, self.dur, self.kind, self.disc, self.init, self.pdt = uri, dur, kind, disc, init, pdt
        # DASH needs the media clock, not just seconds: decode time and duration in the
        # track's own timescale, and the $Number$ the segment is addressed by
        self.t, self.d, self.ts, self.num, self.run = t, d, ts, num, run
        self.period = 0                     # the CHANNEL-wide DASH Period it belongs to


class Track:
    """One delivered playlist (a video variant or an audio rendition)."""

    def __init__(self, name, filler, window_sec):
        self.name = name                    # source playlist file name (stream_0.m3u8)
        self.filler = filler                # {"init": uri, "segments": [{"uri","dur"}]} or None
        self.window_sec = window_sec
        self.entries = []
        self.media_seq = 0
        self.disc_seq = 0
        self.last_live_key = -1
        self.live_init = None
        self.filler_idx = 0
        self.filler_slots = 0
        self.shift = 0.0
        self.shifts = [(float("-inf"), 0.0)]   # (true_pdt_from, shift) breakpoints
        self.run = 0                         # bumps at every discontinuity: one DASH Period each
        self.run_start = {}                  # period -> PDT of its first segment (kept after trim)
        self.hooks = None                    # Playout: media_of / on_slot / on_drop

    @property
    def label(self):
        return (self.live_init or "").split("/")[0]

    # -- appends ------------------------------------------------------------
    def edge(self):
        e = self.entries[-1] if self.entries else None
        return (e.pdt + e.dur) if e is not None and e.pdt is not None else None

    def add_live(self, uri, dur, true_pdt, src_disc=False):
        """Append a live segment. At every discontinuity (back from the loop, or one the
        packager declared) the PDT shift is RE-ANCHORED so this segment starts exactly
        at the delivered edge: the delivered clock never jumps or runs backwards, even
        when the source's own timestamps do."""
        prev = self.entries[-1] if self.entries else None
        disc = prev is not None and (prev.kind != "live" or src_disc)
        edge = self.edge()
        if disc and true_pdt is not None and edge is not None:
            self.shift = edge - true_pdt
            self.shifts.append((true_pdt, self.shift))
        pdt = (true_pdt + self.shift) if true_pdt is not None else edge
        if disc:
            self.run += 1
        m = self.hooks.media_of(uri) if self.hooks else None
        t, d, ts = m if m else (None, None, None)
        if src_disc and self.hooks and self.hooks.lead == self.name:
            self.hooks.period += 1           # the source's own timestamps jumped: new Period
        e = Entry(uri, dur, "live", disc, self.live_init, pdt, t, d, ts, _seg_key(uri), self.run)
        e.period = self.hooks.period if self.hooks else 0
        self.entries.append(e)
        self.last_live_key = _seg_key(uri)

    def add_filler(self):
        if not self.filler or not self.filler.get("segments"):
            return False
        prev = self.entries[-1] if self.entries else None
        if prev is None:
            return False
        disc = prev.kind != "filler"
        if disc:
            self.filler_idx = 0             # every outage starts the loop from its top
            self.run += 1
        segs = self.filler["segments"]
        s = segs[self.filler_idx % len(segs)]
        self.filler_idx += 1
        self.filler_slots += 1
        # EVERY SLOT IS ITS OWN FILE: s_<n>.m4s, a copy of the loop segment with its
        # decode time continuing from the slot before. A DASH Period needs a timeline
        # that keeps increasing (the loop's own segments restart at 0 every pass), and
        # players and caches that key fragments by URL never see the same URL twice.
        base = self.filler["init"].rsplit("/", 1)[0]
        uri = f"{base}/s_{self.filler_slots}.m4s"
        ts = self.filler.get("timescale")
        d = s.get("d")
        t = 0 if disc or prev.t is None or prev.kind != "filler" else prev.t + (prev.d or 0)
        if self.hooks:
            self.hooks.on_slot(s["uri"], uri, t)
        e = Entry(uri, float(s["dur"]), "filler", disc, self.filler["init"], self.edge(),
                  t, d, ts, self.filler_slots, self.run)
        e.period = self.hooks.period if self.hooks else 0
        self.entries.append(e)
        return True

    def trim(self):
        total = sum(e.dur for e in self.entries)
        while len(self.entries) > 3 and total - self.entries[0].dur >= self.window_sec:
            gone = self.entries.pop(0)
            total -= gone.dur
            self.media_seq += 1
            if gone.kind == "filler" and self.hooks:
                self.hooks.on_drop(gone.uri)        # a slot copy nobody can request any more
            # the next entry now opens the window: if it starts a discontinuity, that
            # discontinuity has not left the window yet, so the count is unchanged; the
            # count tracks discontinuity tags that have SCROLLED OUT.
            if self.entries and self.entries[0].disc:
                self.disc_seq += 1
                self.entries[0].disc = False

    # -- render -------------------------------------------------------------
    def render(self, iso):
        if not self.entries:
            return None
        td = max(1, int(math.ceil(max(e.dur for e in self.entries))))
        out = ["#EXTM3U", "#EXT-X-VERSION:6", f"#EXT-X-TARGETDURATION:{td}",
               f"#EXT-X-MEDIA-SEQUENCE:{self.media_seq}",
               f"#EXT-X-DISCONTINUITY-SEQUENCE:{self.disc_seq}"]
        cur_init = None
        for e in self.entries:
            if e.disc:
                out.append("#EXT-X-DISCONTINUITY")
            if e.init and (e.init != cur_init or e.disc):
                out.append(f'#EXT-X-MAP:URI="{e.init}"')
                cur_init = e.init
            if e.pdt is not None:
                out.append(f"#EXT-X-PROGRAM-DATE-TIME:{iso(e.pdt)}")
            out.append(f"#EXTINF:{e.dur:.3f},")
            out.append(e.uri)
        return "\n".join(out) + "\n"


class Playout:
    """The channel-wide splice decision over a set of tracks."""

    def __init__(self, fillers, window_sec, hold_sec, pdt_of, log=None, event=None):
        self.fillers = fillers or {}        # rendition dir ("360p", "audio") -> filler track
        self.window_sec = window_sec
        self.hold = hold_sec
        self.pdt_of = pdt_of                # uri -> true PDT (epoch + tfdt) or None
        self.log = log or (lambda m: None)
        self.event = event or (lambda *a, **k: None)
        self.tracks = {}                    # playlist name -> Track
        self.lead = None
        self.mode = "live"
        self.slot_due = None                # wall clock the next lead segment is due by
        self.splices = 0
        # FORCED (pre-flight failover test, or an operator taking the channel to the
        # loop): live segments keep arriving and are consumed, but the loop is what is
        # delivered until the force is lifted. Same splice, same return path.
        self.forced = False
        # IO hooks, injected by the encoder (no-ops in tests)
        self.media_of = lambda uri: None    # live uri -> (tfdt, duration, timescale)
        self.on_slot = lambda src, dst, t: None
        self.on_drop = lambda uri: None
        # DASH only: a live segment that runs on past the end of its Period is served
        # from a per-Period directory where every other segment is a hard link and that
        # one is cut to the Period (see render_mpd)
        self.on_link = lambda src, dst: None
        self.on_cut = lambda src, dst, keep, init: keep
        self.ast = None                     # DASH availabilityStartTime (wall clock)
        # ONE Period counter for the whole channel, bumped at every switch to or from
        # the loop (and when the source's own timestamps jump). Every segment of every
        # track is stamped with it when appended, so a segment can never move from one
        # Period to another between MPD updates, which players do not forgive.
        self.period = 0

    @staticmethod
    def _rendition_of(init_uri):
        """'360p/init.mp4' -> '360p'; 'audio_1/init.mp4' -> 'audio'."""
        d = (init_uri or "").split("/")[0]
        return "audio" if d.startswith("audio") else d

    def set_fillers(self, fillers):
        self.fillers = fillers or {}
        for t in self.tracks.values():
            if t.live_init:
                t.filler = self.fillers.get(self._rendition_of(t.live_init))

    def has_filler(self):
        return any(t.filler for t in self.tracks.values())

    def shift_at(self, true_pdt):
        """Shift applied to the LEAD track's live media at true PDT `true_pdt`, for the
        subtitle track to apply too."""
        t = self.tracks.get(self.lead)
        if t is None or true_pdt is None:
            return 0.0
        s = 0.0
        for frm, sh in t.shifts:
            if true_pdt >= frm:
                s = sh
        return s

    def update(self, now, playlists, lead_name):
        """playlists: {name: text} of the packager's media playlists for this pass."""
        self.lead = lead_name
        order = [lead_name] + [n for n in playlists if n != lead_name]
        for name in order:
            text = playlists.get(name)
            if text is None:
                continue
            parsed = parse_media_playlist(text)
            if parsed is None:
                continue                    # caught mid-write: keep last pass's state
            t = self.tracks.get(name)
            if t is None:
                t = self.tracks[name] = Track(name, None, self.window_sec)
                t.hooks = self
            init, segs = parsed
            if init and t.live_init != init:
                t.live_init = init
                t.filler = self.fillers.get(self._rendition_of(init))
            new = [(u, d, dc) for u, d, dc in segs if _seg_key(u) > t.last_live_key]
            if not new:
                continue
            if self.forced and t.filler:
                t.last_live_key = _seg_key(new[-1][0])     # consumed, not delivered
                if name == lead_name and self.slot_due is None and t.entries:
                    self.slot_due = now
                continue
            if name == lead_name:
                if self.mode == "filler":
                    self.mode = "live"
                    self.period += 1
                    self.log(f"playout: live is back -> leaving the loop after splice {self.splices}")
                    # at_pdt: the instant on the DELIVERED timeline the switch happens (the
                    # end of the last loop slot), which is what a recording is marked by
                    self.event("playout.splice", to="live", splice=self.splices, at_pdt=t.edge())
                for u, d, dc in new:
                    t.add_live(u, d, self.pdt_of(u), dc)
                self.slot_due = now + t.entries[-1].dur
            elif self.mode == "live":
                for u, d, dc in new:
                    t.add_live(u, d, self.pdt_of(u), dc)
            # else: a follower's live segment while the lead is still on the loop is held
            # back (not consumed) so every playlist leaves the loop in the same slot

        lead = self.tracks.get(lead_name)
        if lead is not None and lead.entries and self.slot_due is not None and self.has_filler():
            # a slot is late: fill it from the loop, on every track at once
            while now > self.slot_due + (0.0 if self.forced else self.hold):
                if self.mode != "filler":
                    self.mode = "filler"
                    self.period += 1
                    self.splices += 1
                    why = "forced" if self.forced else f"live edge {now - self.slot_due:.1f}s late"
                    self.log(f"playout: {why} -> loop (splice {self.splices})")
                    self.event("playout.splice", to="loop", reason="forced" if self.forced else "late",
                               late_sec=round(now - self.slot_due, 1), splice=self.splices,
                               at_pdt=lead.edge())
                for tr in self.tracks.values():
                    tr.add_filler()
                self.slot_due += lead.entries[-1].dur

        for t in self.tracks.values():
            # each track remembers where each of its runs began, so a Period keeps its
            # start after its first segments scroll out of the window. Per TRACK, so the
            # Periods always follow the lead's own clock whichever pass first saw it.
            for e in t.entries:
                if e.pdt is not None:
                    t.run_start.setdefault(e.period, e.pdt)
            t.trim()
        lead = self.tracks.get(lead_name)
        if self.ast is None and lead is not None and lead.run_start:
            self.ast = math.floor(min(lead.run_start.values()))

    def render(self, name, iso):
        t = self.tracks.get(name)
        return t.render(iso) if t else None

    # -- DASH ---------------------------------------------------------------
    def periods(self):
        """The lead track's runs as DASH Periods: [(run, kind, start_pdt, end_pdt)]."""
        lead = self.tracks.get(self.lead)
        if lead is None or not lead.entries:
            return []
        out = []
        for e in lead.entries:
            if e.pdt is None:
                continue
            if not out or out[-1][0] != e.period:
                out.append([e.period, e.kind, lead.run_start.get(e.period, e.pdt), e.pdt + e.dur])
            else:
                out[-1][3] = e.pdt + e.dur
        return [tuple(p) for p in out]

    @staticmethod
    def _timeline(pairs):
        tl, cur = [], None
        for t, d in pairs:
            if cur and cur[1] == d and cur[0] + cur[1] * (cur[2] + 1) == t:
                cur[2] += 1
            else:
                cur = [t, d, 0]
                tl.append(cur)
        return tl

    def _cut_dir(self, t, pid, keep, pend):
        """Make (once) d<id>/ for track t's live segments in Period `pid`: hard links,
        and the last one cut to end at `pend`. Returns (media template, cut duration)."""
        key = (t.name, pid)
        last = keep[-1]
        base = last.uri.rsplit("/", 1)[0]
        ddir = f"{base}/d{pid[1:]}"
        have = self._dash_cuts.setdefault(key, {"files": [], "linked": set(), "d_last": None})
        for e in keep[:-1]:
            if e.num not in have["linked"]:
                dst = f"{ddir}/seg_{e.num}.m4s"
                self.on_link(e.uri, dst)
                have["files"].append(dst)
                have["linked"].add(e.num)
        if have["d_last"] is None:
            want = int(round((pend - last.pdt) * last.ts))
            dst = f"{ddir}/seg_{last.num}.m4s"
            got = self.on_cut(last.uri, dst, want, last.init)
            if not got:
                return None
            have["d_last"] = int(got)
            have["files"].append(dst)
        return f"{ddir}/seg_$Number$.m4s", have["d_last"]

    def _loop_slots(self, t, run, pstart, pend, lead):
        """Track t's loop content for loop Period `run`, from `pstart` until it covers
        the Period (closed) or as far as the lead has delivered the loop (open).
        Returns (timescale, init, base, startNumber, [[t, d, r]]) or None."""
        f = t.filler
        if not f or not f.get("segments") or not f.get("timescale"):
            return None
        ts = int(f["timescale"])
        if pend is None:
            les = [e for e in (lead.entries if lead else []) if e.period == run and e.kind == "filler" and e.pdt is not None]
            if not les:
                return None
            cover = les[-1].pdt + les[-1].dur
        else:
            cover = pend
        need = cover - pstart
        segs = f["segments"]
        base = f["init"].rsplit("/", 1)[0]
        made = self._dash_made.setdefault((t.name, run), [])
        tl, cur, tt, k = [], None, 0, 0
        while tt / ts < need - 1e-3:
            s = segs[k % len(segs)]
            d = int(s.get("d") or round(float(s["dur"]) * ts))
            if pend is None and (tt + d) / ts > need + 1e-3:
                break                        # open: never past the lead (see render_mpd)
            k += 1
            last_one = pend is not None and (tt + d) / ts > need + 0.02
            if k > len(made):
                uri = f"{base}/p{run}_{k}.m4s"
                self.on_slot(s["uri"], uri, tt)
                if last_one:                 # the Period ends inside it: cut it there
                    got = self.on_cut(uri, uri, int(round(need * ts)) - tt, f["init"])
                    self._dash_cutlen[(t.name, run, k)] = int(got) if got else d
                made.append(uri)
            if last_one:
                d = self._dash_cutlen.get((t.name, run, k), d)
            if cur and cur[1] == d and cur[0] + cur[1] * (cur[2] + 1) == tt:
                cur[2] += 1
            else:
                cur = [tt, d, 0]
                tl.append(cur)
            tt += d
        if not tl:
            return None
        return ts, f["init"], base, 1, tl

    def render_mpd(self, iso, reps, seg_dur, now, avail_lag=None):
        """A multi-Period dynamic MPD over the same delivered content as the HLS.

        reps(kind, track) -> {"set": adaptation-set key, "set_attrs": {...},
                              "set_children": [xml], "attrs": {...}, "children": [xml]}
        or None to leave a track out.

        WHY THE PERIODS ARE NOT SIMPLY THE HLS RUNS. Audio and video segments do not end
        at the same instant (the packager cuts audio on a fixed grid and video at
        keyframes; here they sit ~1.4s apart). HLS does not mind: each playlist has its
        own clock. A DASH Period is one window for every track, and a track that ends
        before its Period does leaves a hole in the browser's buffer, which dash.js
        waits on and then jumps (measured: a 1.4s freeze at every switch). So:
          * live -> loop: the loop Period starts where the FIRST track runs out of live
            media; a track that has more is cut there by the player (append window).
          * loop -> live: the live Period starts where the LAST track has live media
            again; a track that is back sooner is cut there.
          * the loop Period's content is laid out per track from that start, slot after
            slot, until it covers the Period (DASH-only copies, p<run>_<k>.m4s), so no
            track is ever short.
        Every boundary is fixed the first time it can be computed, so a Period never
        moves between MPD updates."""
        pers = self.periods()
        if not pers or self.ast is None:
            return None
        if not hasattr(self, "_dash_bounds"):
            self._dash_bounds = {}           # run -> fixed Period start (PDT)
            self._dash_made = {}             # (track name, run) -> [slot uris]
            self._dash_cutlen = {}           # (track name, run, k) -> cut slot duration
            self._dash_cuts = {}             # (track name, run) -> d<run>/ links + cut
        tracks = [t for t in self.tracks.values() if t.entries]

        if not hasattr(self, "_dash_splits"):
            self._dash_splits = {}           # live run -> PDTs where some track's media clock jumps

        def live_all(t):
            return [e for e in t.entries if e.kind == "live" and e.pdt is not None]

        def live_before_filler(t, frun):
            """t's live entries before its first loop slot of run `frun` (None: not yet)."""
            out = []
            for e in t.entries:
                if e.kind == "filler" and e.period == frun:
                    return out
                if e.kind == "live" and e.pdt is not None:
                    out.append(e)
            return None

        def live_after_filler(t, frun):
            idx = max((k for k, e in enumerate(t.entries) if e.kind == "filler" and e.period == frun), default=None)
            if idx is None:
                return None
            return [e for e in t.entries[idx + 1:] if e.kind == "live" and e.pdt is not None]

        # 1. one boundary per switch on the lead (to or from the loop, or the source's
        #    own clock jumping), placed so no track is ever short (see above)
        starts, usable = [], len(pers)
        for i, (run, kind, pstart, _pend) in enumerate(pers):
            if run in self._dash_bounds:
                starts.append(self._dash_bounds[run])
                continue
            if i == 0:
                # the first Period starts once EVERY track has begun (each track keeps
                # where its runs began, so this stays put as segments scroll out)
                firsts = [t.run_start[run] for t in tracks if run in t.run_start]
                starts.append(max(firsts) if firsts else pstart)
                continue
            prun, pkind = pers[i - 1][0], pers[i - 1][1]
            b = pstart
            if kind == "filler" and pkind == "live":
                ends = []
                for t in tracks:
                    lb = live_before_filler(t, run)
                    if lb:
                        ends.append(lb[-1].pdt + lb[-1].dur)
                if ends:
                    b = min(ends)
            elif kind == "live" and pkind == "filler":
                firsts, ready = [], True
                for t in tracks:
                    la = live_after_filler(t, prun)
                    if la:
                        firsts.append(la[0].pdt)
                    elif la is not None or t.filler:
                        ready = False        # this track is not back yet
                if not ready:
                    usable = i               # hold this Period back until it is
                    break
                b = max(firsts) if firsts else pstart
            b = max(b, starts[-1])
            self._dash_bounds[run] = b
            starts.append(b)
        pers = pers[:usable]

        # 2. inside a live run, a track whose media clock jumps (a source switch the
        #    packager declared on that track) needs a Period boundary there too: one
        #    Representation is one continuous timeline. Each jump is a split, kept.
        dps = []                             # [pid, run, kind, start]
        for i, (run, kind, _ps, _pe) in enumerate(pers):
            s0 = starts[i]
            e0 = starts[i + 1] if i + 1 < len(pers) else float("inf")
            dps.append([f"p{run}", run, kind, s0])
            if kind != "live":
                continue
            sp = self._dash_splits.setdefault(run, set())
            for t in tracks:
                prev = None
                for e in live_all(t):
                    if e.pdt + e.dur <= s0 + 1e-3 or e.pdt >= e0 - 1e-3:
                        prev = None
                        continue
                    if prev is not None and prev.t is not None and e.t is not None and e.ts \
                            and abs(e.t - (prev.t + prev.d)) > 0.01 * e.ts:
                        sp.add(round(e.pdt, 3))
                    prev = e
            for x in sorted(sp):
                if s0 + 0.05 < x < e0 - 0.05:
                    dps.append([f"p{run}_{int(round(x * 1000)) % 10 ** 9}", run, kind, x])
        alive = {d[0] for d in dps}
        live_runs = {p[0] for p in pers}
        for (name, run), uris in list(self._dash_made.items()):
            if run not in live_runs:         # the Period has left the window
                for u in uris:
                    self.on_drop(u)
                del self._dash_made[(name, run)]
        for (name, pid), c in list(self._dash_cuts.items()):
            if pid not in alive:
                for u in c["files"]:
                    self.on_drop(u)
                del self._dash_cuts[(name, pid)]
        if live_runs:
            for run in [r for r in self._dash_bounds if r < min(live_runs)]:
                del self._dash_bounds[run]
            for run in [r for r in self._dash_splits if r < min(live_runs)]:
                del self._dash_splits[run]

        def live_in(t, s_, e_):
            return [e for e in live_all(t) if e.pdt < (e_ if e_ is not None else float("inf")) - 1e-3
                    and e.pdt + e.dur > s_ + 1e-3]

        lead = self.tracks.get(self.lead)
        body, body_sets = [], []
        for i, (pid, run, kind, pstart) in enumerate(dps):
            pend = dps[i + 1][3] if i + 1 < len(dps) else None
            open_cap = None
            if pend is None and kind != "filler":
                ends = [es[-1].pdt + es[-1].dur for es in (live_in(t, pstart, None) for t in tracks) if es]
                open_cap = min(ends) if ends else None
            sets = {}
            for t in self.tracks.values():
                info = reps(kind, t)
                if not info:
                    continue
                if kind == "filler":
                    sl = self._loop_slots(t, run, pstart, pend, lead)
                    if not sl:
                        continue
                    ts, init, base, first_num, tl = sl
                    pto = 0
                    media = f"{base}/p{run}_$Number$.m4s"
                else:
                    es = live_in(t, pstart, pend)
                    if pend is None and open_cap is not None:
                        # OPEN Period: nothing may reach past where the shortest track
                        # ends. A browser appends media while a Period is open with no
                        # end to cut it at, so a segment that runs on past the eventual
                        # boundary would sit in the buffer beyond it (dash.js then never
                        # fetches the next Period's audio: measured, a 145s freeze). It
                        # is listed once the Period has closed and the player cuts it.
                        es = [e for e in es if e.pdt + e.dur <= open_cap + 1e-3]
                    if not es or es[0].t is None or not es[0].ts:
                        continue
                    # one Representation needs consecutive $Number$s: keep the first such run
                    keep = [es[0]]
                    for e in es[1:]:
                        if e.num != keep[-1].num + 1 or e.t is None:
                            break
                        keep.append(e)
                    if pend is not None:
                        keep = [e for e in keep if e.pdt < pend - 1e-3]
                        if not keep:
                            continue
                    first = keep[0]
                    ts, init, first_num = first.ts, first.init, first.num
                    pto = max(0, first.t - int(round((first.pdt - pstart) * ts)))
                    tl, cur = [], None
                    for e in keep:
                        if cur and cur[1] == e.d and cur[0] + cur[1] * (cur[2] + 1) == e.t:
                            cur[2] += 1
                        else:
                            cur = [e.t, e.d, 0]
                            tl.append(cur)
                    media = first.uri.rsplit("/", 1)[0] + "/seg_$Number$.m4s"
                    last = keep[-1]
                    if pend is not None and last.pdt + last.dur > pend + 0.02:
                        # the Period ends inside this track's last segment: serve this
                        # Period from d<run>/, every segment a hard link but that one,
                        # which is cut to end with the Period. (A browser appends a
                        # segment whole, whatever the Period says: measured with dash.js,
                        # audio left running 2.5s past a Period end froze playback.)
                        cut = self._cut_dir(t, pid, keep, pend)
                        if cut:
                            media, d_last = cut
                            tl = self._timeline([(e.t, e.d) for e in keep[:-1]] + [(last.t, d_last)])
                stimes = "".join(f'<S t="{a}" d="{b}"' + (f' r="{r}"' if r else "") + "/>" for a, b, r in tl)
                attrs = " ".join(f'{k}="{v}"' for k, v in info["attrs"].items())
                rep_xml = (f"<Representation {attrs}>" + "".join(info.get("children", []))
                           + f'<SegmentTemplate timescale="{ts}" presentationTimeOffset="{pto}" '
                             f'initialization="{init}" media="{media}" startNumber="{first_num}">'
                           f"<SegmentTimeline>{stimes}</SegmentTimeline></SegmentTemplate></Representation>")
                st = sets.setdefault(info["set"], {"attrs": info["set_attrs"], "children": info.get("set_children", []), "reps": []})
                st["reps"].append(rep_xml)
            shape = {k: len(v["reps"]) for k, v in sets.items()}
            if body_sets and i == len(dps) - 1 and any(shape.get(k, 0) < n for k, n in body_sets[-1].items()):
                # the newest Period is missing a track the one before had (its first
                # segment is not there yet): publish it on a later pass, whole. An
                # AdaptationSet must not appear in a Period after the fact.
                break
            body_sets.append(shape)
            ad = []
            for k, (key, st) in enumerate(sets.items()):
                attrs = " ".join(f'{a}="{v}"' for a, v in st["attrs"].items())
                ad.append(f'<AdaptationSet id="{k}" {attrs}>' + "".join(st["children"]) + "".join(st["reps"]) + "</AdaptationSet>")
            if not ad:
                continue
            # a closed Period says how long it is, so a client that walks Periods in
            # order (gpac, ExoPlayer) knows it has ended without waiting for more
            dur_attr = f' duration="PT{max(0.0, pend - pstart):.3f}S"' if pend is not None else ""
            body.append(f'<Period id="{pid}" start="PT{max(0.0, pstart - self.ast):.3f}S"{dur_attr}>' + "".join(ad) + "</Period>")
        if not body:
            return None
        win = int(self.window_sec)
        # AVAILABILITY. A DASH client computes when a segment exists from the clock:
        # AST + Period@start + the segment's end. Ours are listed a little after that
        # (packaging, the refresh pass) and a loop slot only once the live edge is late
        # by the hold, so AST is published that much later; a clock-driven client then
        # never asks for a segment before it is there. Period@start is relative to it.
        # (Period@start stays relative to the media clock; only AST moves, so every
        # segment's availability moves later by `shift` and nothing else changes.)
        lag = float(avail_lag if avail_lag is not None else seg_dur + self.hold + 2.0)
        shift = math.ceil(lag)
        return ('<?xml version="1.0" encoding="UTF-8"?>\n'
                '<!-- delivered by volt playout: live and the channel loop as Periods -->\n'
                '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011" '
                f'type="dynamic" availabilityStartTime="{iso(self.ast + shift)}" publishTime="{iso(now)}" '
                f'minimumUpdatePeriod="PT{int(seg_dur)}S" minBufferTime="PT2S" '
                f'suggestedPresentationDelay="PT{int(3 * seg_dur)}S" timeShiftBufferDepth="PT{win}S">'
                + "".join(body) + "</MPD>\n")
