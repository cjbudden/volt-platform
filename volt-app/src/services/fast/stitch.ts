// ============================================================================
//  PER-SESSION AD STITCHING of a FAST channel's HLS media playlists.
//
//  The channel's own playlists (written by fast_playout.py) are SHARED and
//  CDN-cached: every viewer gets the same content, and in each break the same
//  house fill, marked with SCTE-35 (DATERANGE SCTE35-OUT and CUE-OUT/CUE-IN).
//  A viewer who should see targeted ads gets a SESSION playlist instead: the
//  same playlist with each break's segments swapped for that viewer's pod.
//  Only playlists are per session. Every segment (content, house fill, ad
//  creatives) is a shared file the CDN caches once for everyone.
//
//  THE HARD PART IS NUMBERING. A pod rarely has the same number of segments,
//  or of discontinuities, as the house fill it replaces. HLS needs every
//  playlist refresh to agree on which segment is EXT-X-MEDIA-SEQUENCE n and how
//  many discontinuities came before it, or the player re-buffers or skips. So
//  per session and per break we remember:
//    chanFirstMsn   the channel media sequence of the break's first segment
//    chanSegs       how many channel segments the break had
//    chanItems      how many fill items (discontinuity runs) it had
//    podSegs/Items  the same for the pod we put there
//  and every later segment is shifted by the running difference. The numbers
//  are the same on every rendition, because the playout writes all renditions
//  in lockstep and the ad creatives are conditioned to the same segment length.
//
//  RULES THAT KEEP IT SAFE:
//    - A break is only replaced for a session that saw its FIRST segment
//      (joined before the break). A viewer joining mid-break sees the house
//      fill for the rest of that break; the next break is theirs.
//    - No decision ready when the break reaches the playlist = the house fill
//      plays. The manifest path never waits for an ad server.
//    - Anything unreadable = the channel playlist, unchanged (fail open).
//
//  PURE: text in, text out, with the session's small state object.
//  test/fast-stitch.check.ts plays a session through simulated refreshes.
// ============================================================================

export const CLASS_AD_BREAK = 'com.boomlabs.volt.ad';

export interface PodSegment { uri: string; dur: number; init: string }
/** One rendition's segments for a pod, in order. A change of `init` is a new item (a discontinuity). */
export type PodRendition = PodSegment[];

export interface BreakState {
  id: string;
  startMs: number;
  durationSec: number;
  chanFirstMsn?: number;
  chanLastMsn?: number;
  /** channel msns inside the break that open a new fill item (after the first) */
  chanItemStarts?: number[];
  /** the session saw the break's first segment, so it may be replaced */
  eligible?: boolean;
  /** pod shape, fixed the first time the pod is used */
  podSegs?: number;
  podItems?: number;
}

export interface SessionState {
  startedMs: number;
  breaks: Record<string, BreakState>;
}

interface Entry {
  msn: number;
  uri: string;
  dur: number;
  pdtMs: number | null;
  disc: boolean;
  map: string | null;
  tags: string[]; // other tags before the segment (DATERANGE, CUE, ...)
}

interface Parsed {
  header: string[];
  msn: number;
  dsn: number;
  entries: Entry[];
  endList: boolean;
  dateranges: { id: string; cls: string; startMs: number; durationSec: number; line: string }[];
}

const attr = (line: string, name: string) => {
  const m = line.match(new RegExp(`(?:^|[:,])${name}=("([^"]*)"|[^,]*)`));
  return m ? (m[2] ?? m[1]) : null;
};

export function parsePlaylist(text: string): Parsed | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') return null;
  const header: string[] = [];
  let msn = 0, dsn = 0, endList = false;
  const entries: Entry[] = [];
  const dateranges: Parsed['dateranges'] = [];
  let pend: Partial<Entry> & { tags: string[] } = { tags: [] };
  let map: string | null = null;
  let inBody = false;
  for (const l of lines.slice(1)) {
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) { msn = Number(l.split(':')[1]); continue; }
    if (l.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) { dsn = Number(l.split(':')[1]); continue; }
    if (l === '#EXT-X-ENDLIST') { endList = true; continue; }
    if (l.startsWith('#EXT-X-MAP:')) { map = attr(l, 'URI'); pend.map = map; inBody = true; continue; }
    if (l === '#EXT-X-DISCONTINUITY') { pend.disc = true; inBody = true; continue; }
    if (l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) { pend.pdtMs = Date.parse(l.slice(25)); inBody = true; continue; }
    if (l.startsWith('#EXTINF:')) { pend.dur = Number(l.slice(8).split(',')[0]); inBody = true; continue; }
    if (l.startsWith('#EXT-X-DATERANGE:')) {
      const id = attr(l, 'ID') ?? '';
      const cls = attr(l, 'CLASS') ?? '';
      const sd = attr(l, 'START-DATE');
      const d = Number(attr(l, 'DURATION') ?? attr(l, 'PLANNED-DURATION') ?? 'NaN');
      if (sd) dateranges.push({ id, cls, startMs: Date.parse(sd), durationSec: d, line: l });
      pend.tags.push(l);
      inBody = true;
      continue;
    }
    if (l.startsWith('#')) {
      if (!inBody && !/^#EXT-X-(CUE|OATCLS)/.test(l)) header.push(l);
      else pend.tags.push(l);
      continue;
    }
    if (pend.dur == null) return null;
    entries.push({ msn: msn + entries.length, uri: l, dur: pend.dur, pdtMs: pend.pdtMs ?? null, disc: !!pend.disc, map: pend.map ?? map, tags: pend.tags });
    pend = { tags: [] };
  }
  // carry PDT forward for segments without their own tag
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].pdtMs == null && entries[i - 1].pdtMs != null) entries[i].pdtMs = entries[i - 1].pdtMs! + entries[i - 1].dur * 1000;
  }
  return { header, msn, dsn, entries, endList, dateranges };
}

const iso = (ms: number) => new Date(ms).toISOString();
const isCueTag = (t: string) => /^#EXT-X-CUE-OUT-CONT|^#EXT-X-CUE-OUT|^#EXT-X-CUE-IN|^#EXT-OATCLS/.test(t);

/**
 * Stitch one rendition's playlist for a session.
 * `podFor(breakId)` returns this rendition's pod segments, or null when there
 * is no decision yet (the house fill then plays).
 */
export function stitchHls(text: string, state: SessionState, podFor: (breakId: string) => PodRendition | null): string {
  const p = parsePlaylist(text);
  if (!p || !p.entries.length) return text;

  // 1. learn the breaks from the DATERANGE tags and where they sit in this window
  for (const d of p.dateranges) {
    if (d.cls !== CLASS_AD_BREAK || !Number.isFinite(d.durationSec)) continue;
    const b = (state.breaks[d.id] ??= { id: d.id, startMs: d.startMs, durationSec: d.durationSec });
    b.startMs = d.startMs; b.durationSec = d.durationSec;
  }
  const breakOf = (e: Entry): BreakState | null => {
    if (e.pdtMs == null) return null;
    for (const b of Object.values(state.breaks)) {
      if (e.pdtMs >= b.startMs - 20 && e.pdtMs < b.startMs + b.durationSec * 1000 - 20) return b;
    }
    return null;
  };
  for (const e of p.entries) {
    const b = breakOf(e);
    if (!b) continue;
    if (b.chanFirstMsn == null) {
      // the first segment we see of this break: only eligible if it IS the break's first segment
      b.chanFirstMsn = e.msn;
      b.eligible = Math.abs((e.pdtMs ?? 0) - b.startMs) < 50;
      b.chanItemStarts = [];
    }
    if (e.msn > (b.chanLastMsn ?? -1)) b.chanLastMsn = e.msn;
    if (e.disc && e.msn !== b.chanFirstMsn && !b.chanItemStarts!.includes(e.msn)) b.chanItemStarts!.push(e.msn);
  }

  // 2. fix each eligible break's pod shape the first time we have one
  const pods = new Map<string, PodRendition>();
  for (const b of Object.values(state.breaks)) {
    if (!b.eligible) continue;
    const raw = podFor(b.id);
    if (!raw || !raw.length) continue;
    // NEVER LONGER THAN THE BREAK. Content resumes on the channel's clock; a pod
    // that ran on would put this viewer's timeline behind every later segment's
    // PROGRAM-DATE-TIME. Segments that would start in the last quarter second
    // of the break are dropped.
    const pod: PodRendition = [];
    let acc = 0;
    for (const sg of raw) { if (acc >= b.durationSec - 0.25) break; pod.push(sg); acc += sg.dur; }
    const items = pod.reduce((n, s, i) => n + (i === 0 || s.init !== pod[i - 1].init ? 1 : 0), 0);
    if (b.podSegs == null) { b.podSegs = pod.length; b.podItems = items; }
    if (b.podSegs !== pod.length) continue; // a rendition with a different shape: leave the break alone
    pods.set(b.id, pod);
  }
  const stitched = (b: BreakState | null) => !!b && b.eligible && pods.has(b.id) && b.chanFirstMsn != null;
  const done = (b: BreakState) => b.chanLastMsn != null; // shape of the channel side known so far

  // running deltas from stitched breaks that END before a channel msn
  const deltaBefore = (msn: number) => {
    let ds = 0, dd = 0;
    for (const b of Object.values(state.breaks)) {
      if (!stitched(b) || !done(b) || b.chanLastMsn! >= msn) continue;
      const chanSegs = b.chanLastMsn! - b.chanFirstMsn! + 1;
      ds += b.podSegs! - chanSegs;
      dd += b.podItems! - (1 + b.chanItemStarts!.length);
    }
    return { ds, dd };
  };

  // 3. rebuild the window. `d` is each segment's discontinuity number counted
  //    INCLUSIVELY (discontinuity tags at or before it), in session terms; the
  //    header's DISCONTINUITY-SEQUENCE is the first segment's, because its own
  //    tag is not written.
  type Out = { msn: number; d: number; disc: boolean; map: string; pdtMs: number | null; dur: number; uri: string; tags: string[] };
  const out: Out[] = [];
  const lastEntry = p.entries[p.entries.length - 1];
  const edgeMs = (lastEntry.pdtMs ?? 0) + lastEntry.dur * 1000;
  const chanD = (msn: number) => p.dsn + p.entries.filter((e) => e.msn <= msn && e.disc).length;

  for (let i = 0; i < p.entries.length; i++) {
    const e = p.entries[i];
    const b = breakOf(e);
    if (!stitched(b)) {
      const { ds, dd } = deltaBefore(e.msn);
      out.push({ msn: e.msn + ds, d: chanD(e.msn) + dd, disc: e.disc, map: e.map ?? '', pdtMs: e.pdtMs, dur: e.dur, uri: e.uri, tags: e.tags });
      continue;
    }
    const br = b!;
    const pod = pods.get(br.id)!;
    let j = i;
    while (j + 1 < p.entries.length && breakOf(p.entries[j + 1]) === br) j++;
    const visFrom = e.pdtMs!;
    // channel discontinuity number of the break's first segment, even when it
    // has scrolled out of this window: count back over the item starts we saw
    const scrolled = (br.chanItemStarts ?? []).filter((m) => m > br.chanFirstMsn! && m <= e.msn).length;
    const dFirst = (br.chanFirstMsn! >= p.msn ? chanD(br.chanFirstMsn!) : chanD(e.msn) - scrolled);
    const { ds, dd } = deltaBefore(br.chanFirstMsn!);
    const base = br.chanFirstMsn! + ds;
    let t = br.startMs;
    let item = 0;
    for (let k = 0; k < pod.length; k++) {
      const sg = pod[k];
      const newItem = k === 0 || sg.init !== pod[k - 1].init;
      if (k > 0 && newItem) item++;
      const segStart = t, segEnd = t + sg.dur * 1000;
      t = segEnd;
      if (segEnd <= visFrom + 1) continue;      // before the visible part of the break
      if (segStart >= edgeMs - 1) break;        // not past the channel's live edge
      const tags = k === 0 ? e.tags.filter((x) => !/CUE-OUT-CONT/.test(x)) : [`#EXT-X-CUE-OUT-CONT:ElapsedTime=${((segStart - br.startMs) / 1000).toFixed(3)},Duration=${br.durationSec.toFixed(3)}`];
      out.push({ msn: base + k, d: dFirst + dd + item, disc: newItem, map: sg.init, pdtMs: segStart, dur: sg.dur, uri: sg.uri, tags });
    }
    i = j; // the segment after the break keeps its own CUE-IN and discontinuity
  }

  if (!out.length) return text;
  // 4. write it
  const lines: string[] = ['#EXTM3U'];
  for (const h of p.header) lines.push(h);
  lines.push(`#EXT-X-MEDIA-SEQUENCE:${out[0].msn}`);
  lines.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${Math.max(0, out[0].d)}`);
  let curMap = '';
  for (let i = 0; i < out.length; i++) {
    const o = out[i];
    if (i > 0 && o.disc) lines.push('#EXT-X-DISCONTINUITY');
    if (o.map && o.map !== curMap) { lines.push(`#EXT-X-MAP:URI="${o.map}"`); curMap = o.map; }
    for (const t of o.tags) if (!(i === 0 && isCueTag(t) && /CUE-IN/.test(t))) lines.push(t);
    if (o.pdtMs != null) lines.push(`#EXT-X-PROGRAM-DATE-TIME:${iso(o.pdtMs)}`);
    lines.push(`#EXTINF:${o.dur.toFixed(3)},`);
    lines.push(o.uri);
  }
  if (p.endList) lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}
