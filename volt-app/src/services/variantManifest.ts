// ============================================================================
//  THE VARIANT MANIFEST SERVICE (EDGE_RIGHTS_VARIANTS.md, build queue 1.14b).
//
//  A variant is one replace timeline: the windows in which an audience sees
//  the channel's loop instead of the programme (services/edgeRights.ts
//  reduceVariants). The edge, or the Mac's public route, sends that audience
//  to /<kind>/<id>/v/<key>/<file>; this file answers it by reading the
//  playlist the encoder delivered right now and swapping, inside each
//  window, the live segments for the pre-built loop (fillerPrep.ts, the same
//  package failover splices in, matched to the channel's ladder).
//
//  WHY ON THE DELIVERY SIDE. Nothing in the encoder, the origin's own
//  playlists, the segments or the recordings changes: recording, DVR,
//  clipping and auto-VOD keep reading the untouched output, and one source
//  serves every variant at once. Work grows with variants, not viewers: the
//  source read is shared through a short cache here, and the CDN caches each
//  variant playlist for about one segment.
//
//  STATELESS, SO EVERY ANSWER IS A PURE FUNCTION OF (source playlist,
//  timeline, loop). Two reloads a segment apart must agree on everything a
//  player already holds, so nothing is counted from "when the window
//  started being served":
//    * A segment is replaced when its start (PROGRAM-DATE-TIME) is inside a
//      window, so a switch always lands on a segment boundary.
//    * Which loop segment fills a slot comes from the slot's own time:
//      k = floor((t - from) / D + 0.5), pass = floor(k / N), index = k mod N,
//      with D the loop's segment length and N its segment count. A 5 minute
//      loop over a 20 minute window therefore plays four times and is cut at
//      the window end.
//    * A discontinuity goes in wherever the region changes (live to loop,
//      one pass of the loop to the next, loop to live), and those places are
//      known in advance: the window start, every from + (jN - 1/2) D, and
//      the window end. EXT-X-DISCONTINUITY-SEQUENCE is the source's own plus
//      the number of those points at or before the first listed segment, so
//      it moves exactly as the tags scroll out of the window.
//    * Every replaced slot keeps the live segment's duration and
//      PROGRAM-DATE-TIME, so the delivered clock stays continuous and a
//      player moving between the normal playlist and its variant (a window
//      opening or closing) finds the same media sequence and the same times.
//  DASH gets the same windows as Periods: the live Periods are cut at each
//  window edge, and each pass of the loop is a Period of its own starting at
//  loop time 0 (no rewritten segment copies needed).
//
//  NEVER LEAKS. A variant that cannot be built (no loop built for the
//  stream, a rendition the loop does not have, a manifest shape this does
//  not understand) is refused, never answered with the normal stream.
// ============================================================================
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config';
import { liveDirFor, liveUrlBase, originBaseFor } from './liveOrigin';
import type { Timeline } from './edgeRights';

export interface LoopTrack { kind?: string; init: string; segments: { uri: string; dur: number }[] }
/** The pre-built loop (filler_build.py's filler.json) and where its files are served. */
export interface Loop { segmentSeconds: number; base: string; tracks: Record<string, LoopTrack> }

export class VariantError extends Error {}

const ABS = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/)/i;
const absolute = (base: string, uri: string) => (ABS.test(uri) ? uri : base + uri);

/** The loop's grid: segment length D and segment count N of its first video track. */
function loopGrid(loop: Loop): { D: number; N: number } {
  const lead = Object.values(loop.tracks).find((t) => t.kind !== 'audio' && t.segments?.length) ?? Object.values(loop.tracks)[0];
  const D = Number(loop.segmentSeconds) || (lead?.segments?.[0]?.dur ?? 0);
  const N = lead?.segments?.length ?? 0;
  if (!(D > 0) || !(N > 0)) throw new VariantError('the loop has no segments');
  return { D, N };
}

/**
 * The windows as HLS places them. A pass of the loop that would begin less
 * than one segment before the window end is not started: whether a segment
 * even starts in that sliver depends on where the live segments fall, which
 * a later playlist (once that segment has scrolled out) cannot see, so the
 * discontinuity count would not hold. Those last seconds show live instead
 * (less than one segment, the same as the segment that straddles the window
 * start); a window that follows directly takes them instead.
 */
function hlsWindows(tl: Timeline, D: number, N: number): [number, number][] {
  const out: [number, number][] = [];
  let carry: number | null = null;
  for (let w = 0; w < tl.length; w++) {
    const from = carry != null && carry < tl[w][0] && tl[w - 1]?.[1] === tl[w][0] ? carry : tl[w][0];
    const to = tl[w][1];
    let end = to;
    for (let j = 1; from + (j * N - 0.5) * D < to; j++) {
      const p = from + (j * N - 0.5) * D;
      if (to - p < D) { end = p; break; }
    }
    carry = end;
    out.push([from, end]);
  }
  return out;
}

/** Where a time falls: 'L' (live) or "<window>:<pass>", plus the loop index. */
function regionAt(t: number, wins: [number, number][], D: number, N: number): { r: string; idx: number } {
  for (let w = 0; w < wins.length; w++) {
    const [from, to] = wins[w];
    if (t >= from && t < to) {
      const k = Math.floor((t - from) / D + 0.5);
      return { r: `${w}:${Math.floor(k / N)}`, idx: k % N };
    }
  }
  return { r: 'L', idx: -1 };
}

/** The times at which the region changes: window start, each loop wrap, window end. */
export function discontinuityPoints(tl: Timeline, D: number, N: number): number[] {
  const out = new Set<number>();
  for (const [from, to] of hlsWindows(tl, D, N)) {
    out.add(from);
    for (let j = 1; from + (j * N - 0.5) * D < to; j++) out.add(from + (j * N - 0.5) * D);
    out.add(to);
  }
  return [...out].sort((a, b) => a - b);
}

const rendOf = (uri: string) => {
  const d = uri.replace(/[?#].*$/, '').split('/').filter(Boolean).slice(-2, -1)[0] ?? '';
  return d.startsWith('audio') ? 'audio' : d;
};

function loopTrackFor(loop: Loop, initUri: string): LoopTrack {
  const label = rendOf(initUri);
  const t = loop.tracks[label];
  if (!t || !t.segments?.length) throw new VariantError(`the loop has no rendition matching ${label || initUri}`);
  return t;
}

// ---------------------------------------------------------------------------
//  HLS
// ---------------------------------------------------------------------------
const HEADER_TAGS = /^#(EXTM3U|EXT-X-VERSION|EXT-X-TARGETDURATION|EXT-X-MEDIA-SEQUENCE|EXT-X-DISCONTINUITY-SEQUENCE|EXT-X-PLAYLIST-TYPE|EXT-X-INDEPENDENT-SEGMENTS|EXT-X-START|EXT-X-ALLOW-CACHE)\b/;
// Low-latency parts are dropped: a variant is served as plain HLS, so a
// player never meets a live part inside a window.
const LL_TAGS = /^#EXT-X-(PART|PART-INF|PRELOAD-HINT|RENDITION-REPORT|SERVER-CONTROL|SKIP)\b/;
const uriAttr = (line: string, f: (u: string) => string) => line.replace(/URI="([^"]*)"/, (_m, u) => `URI="${f(u)}"`);

export const isMaster = (text: string) => /#EXT-X-STREAM-INF/.test(text);

/**
 * The variant's multivariant playlist: the delivered one, with every child
 * playlist kept relative (so it resolves under /v/<key>/) and `carry`
 * (the tester's ?as=, &rc=, &at= or a vrc claim) passed on to each.
 * I-frame playlists go: they index the live segments directly.
 */
export function renderVariantMaster(text: string, carry = ''): string {
  const out: string[] = [];
  const add = (u: string) => (carry && !ABS.test(u) ? u + (u.includes('?') ? '&' + carry.slice(1) : carry) : u);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^#EXT-X-I-FRAME-STREAM-INF/.test(line)) continue;
    if (/^#EXT-X-MEDIA:/.test(line)) { out.push(uriAttr(line, add)); continue; }
    if (line && !line.startsWith('#')) { out.push(add(line)); continue; }
    out.push(line);
  }
  return out.join('\n').replace(/\n*$/, '\n');
}

interface Seg { tags: string[]; disc: boolean; map: string | null; key: string | null; pdt: number | null; pdtLine: string | null; inf: string; dur: number; uri: string }

/**
 * One media playlist of a variant.
 *   base     prefix for the source's relative URIs (its own directory)
 *   emptyVtt URI of an empty WebVTT document, for subtitle playlists
 *   shiftSec development `&at=`: the windows are tested at t + shift
 */
export function renderVariantMedia(text: string, o: { timeline: Timeline; loop: Loop | null; base: string; emptyVtt: string; shiftSec?: number }): string {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
  const header: string[] = [];
  const segs: Seg[] = [];
  const trailer: string[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (!l || l.startsWith('##')) continue;
    if (HEADER_TAGS.test(l)) { header.push(l); continue; }
    if (LL_TAGS.test(l)) continue;
    break;
  }
  let pend: string[] = [], disc = false, map: string | null = null, key: string | null = null, pdt: number | null = null, pdtLine: string | null = null, inf: string | null = null;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (!l || l.startsWith('##') || LL_TAGS.test(l)) continue;
    if (l === '#EXT-X-DISCONTINUITY') { disc = true; continue; }
    if (l.startsWith('#EXT-X-MAP:')) { map = l; continue; }
    if (l.startsWith('#EXT-X-KEY:')) { key = /METHOD=NONE/.test(l) ? null : l; continue; }
    if (l.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) { pdt = Date.parse(l.slice(25)) / 1000; pdtLine = l; continue; }
    if (l.startsWith('#EXTINF:')) { inf = l; continue; }
    if (l === '#EXT-X-ENDLIST') { trailer.push(l); continue; }
    if (l.startsWith('#')) { pend.push(l); continue; }
    if (inf == null) throw new VariantError('a segment without EXTINF');
    segs.push({ tags: pend, disc, map, key, pdt, pdtLine, inf, dur: parseFloat(inf.slice(8)) || 0, uri: l });
    pend = []; disc = false; pdt = null; pdtLine = null; inf = null;
  }
  if (!segs.length) return text;
  // Every segment needs a time: carry the clock forward (and back, for any
  // before the first PROGRAM-DATE-TIME).
  const first = segs.findIndex((s) => s.pdt != null);
  if (first < 0) throw new VariantError('the playlist has no PROGRAM-DATE-TIME, so windows cannot be placed');
  for (let j = first + 1; j < segs.length; j++) if (segs[j].pdt == null) segs[j].pdt = segs[j - 1].pdt! + segs[j - 1].dur;
  for (let j = first - 1; j >= 0; j--) segs[j].pdt = segs[j + 1].pdt! - segs[j].dur;

  const tl = o.timeline;
  const shift = o.shiftSec ?? 0;
  const subtitles = !segs.some((s) => s.map) && segs.every((s) => /\.(vtt|webvtt)(\?|$)/i.test(s.uri));
  if (!subtitles && !segs.every((s) => s.map)) throw new VariantError('only CMAF (fMP4) playlists can carry the loop');
  const anyReplaced = tl.length > 0 && segs.some((s) => regionAt(s.pdt! + shift, tl.map((w) => [w[0], w[1]] as [number, number]), 1, 1).r !== 'L');
  if (anyReplaced && !o.loop) throw new VariantError('no loop has been built for this stream');
  const { D, N } = o.loop ? loopGrid(o.loop) : { D: 1, N: 1 };
  const wins = hlsWindows(tl, D, N);

  const t0 = segs[0].pdt! + shift;
  const passed = tl.length ? discontinuityPoints(tl, D, N).filter((p) => p <= t0).length : 0;
  const out: string[] = [];
  let srcDiscSeq = 0;
  for (const h of header) {
    const m = /^#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/.exec(h);
    if (m) srcDiscSeq = Number(m[1]);
    else out.push(h);
  }
  // The source's own sequence plus every variant discontinuity that has
  // already scrolled out (the one on the first listed segment included, as
  // the encoder's playout folds it).
  const msIdx = out.findIndex((h) => h.startsWith('#EXT-X-MEDIA-SEQUENCE'));
  out.splice(msIdx >= 0 ? msIdx + 1 : out.length, 0, `#EXT-X-DISCONTINUITY-SEQUENCE:${srcDiscSeq + passed}`);

  let prevR: string | null = null, curMap: string | null = null, curKey: string | null = null;
  const abs = (u: string) => absolute(o.base, u);
  for (let j = 0; j < segs.length; j++) {
    const s = segs[j];
    const { r, idx } = wins.length ? regionAt(s.pdt! + shift, wins, D, N) : { r: 'L', idx: -1 };
    let cut = false;
    if (j > 0 && r !== prevR) { out.push('#EXT-X-DISCONTINUITY'); cut = true; }
    if (s.disc) { out.push('#EXT-X-DISCONTINUITY'); cut = true; }   // the source's own, kept so its count holds
    prevR = r;
    if (r === 'L') {
      if (s.key !== curKey) { out.push(s.key ? uriAttr(s.key, abs) : '#EXT-X-KEY:METHOD=NONE'); curKey = s.key; }
      if (s.map && (s.map !== curMap || cut)) { out.push(uriAttr(s.map, abs)); curMap = s.map; }
      if (s.pdtLine) out.push(s.pdtLine);
      out.push(...s.tags);
      out.push(s.inf, abs(s.uri));
      continue;
    }
    // Inside a window: the loop, clear (it was never encrypted), with the
    // slot's own duration and time; only guide date ranges stay (they say
    // what is scheduled, not what is shown), cues and other tags go.
    if (curKey) { out.push('#EXT-X-KEY:METHOD=NONE'); curKey = null; }
    if (s.pdtLine) out.push(s.pdtLine);
    else out.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(s.pdt! * 1000).toISOString()}`);
    out.push(...s.tags.filter((t) => t.startsWith('#EXT-X-DATERANGE')));
    if (subtitles) { out.push(s.inf, o.emptyVtt); continue; }
    const lt = loopTrackFor(o.loop!, s.map!.match(/URI="([^"]*)"/)?.[1] ?? '');
    const initLine = `#EXT-X-MAP:URI="${absolute(o.loop!.base, lt.init)}"`;
    if (initLine !== curMap || cut) { out.push(initLine); curMap = initLine; }
    out.push(s.inf, absolute(o.loop!.base, lt.segments[Math.min(idx, lt.segments.length - 1)].uri));
  }
  out.push(...trailer);
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
//  DASH
// ---------------------------------------------------------------------------
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
function setAttr(tag: string, name: string, val: string | null): string {
  const re = new RegExp(`\\s${name}="[^"]*"`);
  if (val == null) return tag.replace(re, '');
  if (re.test(tag)) return tag.replace(re, ` ${name}="${val}"`);
  return tag.replace(/\s*(\/?)>$/, ` ${name}="${val}"$1>`);
}
/** ISO 8601 duration (PT1H2M3.5S) to seconds. */
export function isoDur(s: string | null): number | null {
  if (!s) return null;
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s);
  if (!m) return null;
  return (Number(m[1] ?? 0) * 86400) + (Number(m[2] ?? 0) * 3600) + (Number(m[3] ?? 0) * 60) + Number(m[4] ?? 0);
}
const pt = (sec: number) => `PT${Math.max(0, sec).toFixed(3)}S`;

interface DSeg { t: number; d: number; n: number }
function segmentsOf(tpl: string): { ts: number; pto: number; start: number; segs: DSeg[] } {
  const ts = Number(attr(tpl, 'timescale') ?? 1), pto = Number(attr(tpl, 'presentationTimeOffset') ?? 0);
  const start = Number(attr(tpl, 'startNumber') ?? 1);
  const segs: DSeg[] = [];
  let t = 0, n = start;
  for (const m of tpl.matchAll(/<S\b[^>]*\/>/g)) {
    const tt = attr(m[0], 't'), d = Number(attr(m[0], 'd')), r = Number(attr(m[0], 'r') ?? 0);
    if (r < 0) throw new VariantError('open-ended SegmentTimeline repeats are not supported');
    if (tt != null) t = Number(tt);
    for (let k = 0; k <= r; k++) { segs.push({ t, d, n: n++ }); t += d; }
  }
  if (!segs.length && !/<SegmentTimeline/.test(tpl)) throw new VariantError('only SegmentTimeline DASH is supported');
  return { ts, pto, start, segs };
}
function timelineXml(segs: { t: number; d: number }[]): string {
  // runs of equal, back-to-back segments as one S with a repeat count
  const runs: { t: number; d: number; r: number; tAttr: boolean }[] = [];
  let prevEnd: number | null = null;
  for (const g of segs) {
    const last = runs[runs.length - 1];
    if (last && prevEnd === g.t && last.d === g.d) last.r++;
    else runs.push({ t: g.t, d: g.d, r: 0, tAttr: prevEnd !== g.t });
    prevEnd = g.t + g.d;
  }
  return `<SegmentTimeline>${runs.map((x) => `<S${x.tAttr ? ` t="${x.t}"` : ''} d="${x.d}"${x.r ? ` r="${x.r}"` : ''}/>`).join('')}</SegmentTimeline>`;
}
const TPL_RE = /<SegmentTemplate\b[^>]*?(?:\/>|>[\s\S]*?<\/SegmentTemplate>)/g;
const tplOpen = (tpl: string) => tpl.match(/^<SegmentTemplate\b[^>]*?(?=\/?>)/)![0] + '>';

interface Period { open: string; body: string; id: string; start: number; end: number; leadTpl: string }

/**
 * A DASH variant: the delivered MPD with each window as Periods of the loop.
 * Live Periods are cut at the window edges (presentationTimeOffset moved so
 * every kept segment is where it was); each pass of the loop is its own
 * Period starting at loop time 0, the last one cut at the window end.
 * Only what is already available is listed: loop segments past the live
 * edge come with the next MPD, as live ones do.
 */
export function renderVariantMpd(text: string, o: { timeline: Timeline; loop: Loop | null; base: string; key: string; shiftSec?: number }): string {
  if (/<BaseURL/.test(text)) throw new VariantError('BaseURL in the MPD is not supported');
  const mpdOpen = text.match(/<MPD\b[^>]*>/)?.[0];
  if (!mpdOpen) throw new VariantError('not an MPD');
  const ast = Date.parse(attr(mpdOpen, 'availabilityStartTime') ?? '') / 1000;
  if (!Number.isFinite(ast)) throw new VariantError('the MPD has no availabilityStartTime');
  const pm = [...text.matchAll(/<Period\b[^>]*>[\s\S]*?<\/Period>/g)];
  if (!pm.length) return text;
  const head = text.slice(0, pm[0].index!).replace(/<Location>[\s\S]*?<\/Location>\s*/g, '');
  const tail = text.slice(pm[pm.length - 1].index! + pm[pm.length - 1][0].length);
  const shift = o.shiftSec ?? 0;
  // windows on the wall clock of the MPD
  const wins = o.timeline.map(([f, t]) => [f - shift, t - shift] as [number, number]);
  const periods: Period[] = pm.map((m, i) => {
    const open = m[0].match(/^<Period\b[^>]*>/)![0];
    const start = ast + (isoDur(attr(open, 'start')) ?? 0);
    const dur = isoDur(attr(open, 'duration'));
    const leadSet = m[0].match(/<AdaptationSet\b[^>]*(?:contentType="video"|mimeType="video\/)[\s\S]*?<\/AdaptationSet>/)?.[0] ?? m[0];
    const leadTpl = leadSet.match(TPL_RE)?.[0];
    if (!leadTpl) throw new VariantError('only Representation SegmentTemplates are supported');
    return { open, body: m[0].slice(open.length), id: attr(open, 'id') ?? `p${i}`, start, end: dur != null ? start + dur : Infinity, leadTpl };
  });
  for (let i = 0; i + 1 < periods.length; i++) periods[i].end = Math.min(periods[i].end, periods[i + 1].start);
  const wall = (p: Period, s: { ts: number; pto: number }, t: number) => p.start + (t - s.pto) / s.ts;
  // the live edge: where the lead representation's segments end
  const lastP = periods[periods.length - 1];
  const ls = segmentsOf(lastP.leadTpl);
  const edge = ls.segs.length ? wall(lastP, ls, ls.segs[ls.segs.length - 1].t + ls.segs[ls.segs.length - 1].d) : lastP.start;
  const earliest = (() => { const s = segmentsOf(periods[0].leadTpl); return s.segs.length ? wall(periods[0], s, s.segs[0].t) : periods[0].start; })();
  const abs = (u: string) => absolute(o.base, u);
  const out: { start: number; xml: string }[] = [];

  // 1. the live Periods, minus the windows
  for (const p of periods) {
    let pieces: [number, number][] = [[p.start, p.end]];
    for (const [f, t] of wins) pieces = pieces.flatMap(([a, b]) => (t <= a || f >= b ? [[a, b]] : [...(f > a ? [[a, f]] : []), ...(t < b ? [[t, b]] : [])] as [number, number][]));
    for (const [a, b] of pieces) {
      let leadHas = false;
      const body = p.body.replace(TPL_RE, (tpl) => {
        const s = segmentsOf(tpl);
        const keep = s.segs.filter((g) => wall(p, s, g.t) < b - 1e-6 && wall(p, s, g.t + g.d) > a + 1e-6);
        if (tpl === p.leadTpl && keep.length) leadHas = true;
        let open = tplOpen(tpl);
        if (a > p.start) open = setAttr(open, 'presentationTimeOffset', String(Math.round(s.pto + (a - p.start) * s.ts)));
        if (keep.length) open = setAttr(open, 'startNumber', String(keep[0].n));
        for (const n of ['initialization', 'media']) { const v = attr(open, n); if (v) open = setAttr(open, n, abs(v)); }
        return `${open}${timelineXml(keep)}</SegmentTemplate>`;
      });
      if (!leadHas) continue;
      let open = p.open;
      if (a > p.start) { open = setAttr(open, 'id', `${p.id}-${Math.round(a * 1000)}`); open = setAttr(open, 'start', pt(a - ast)); }
      open = setAttr(open, 'duration', Number.isFinite(b) && b <= edge ? pt(b - a) : null);
      out.push({ start: a, xml: open + body });
    }
  }

  // 2. the loop, one Period per pass
  const anyWin = wins.some(([f, t]) => t > earliest && f < edge);
  if (anyWin && !o.loop) throw new VariantError('no loop has been built for this stream');
  if (anyWin) {
    const { D, N } = loopGrid(o.loop!);
    const L = N * D;
    const tmpl = periods.find((p) => p.start <= edge) ?? periods[0];
    for (const [f, t] of wins) {
      for (let j = 0; f + j * L < Math.min(t, edge); j++) {
        const ps = f + j * L, pe = Math.min(f + (j + 1) * L, t);
        if (pe <= earliest) continue;
        let leadHas = false;
        // every AdaptationSet the loop can fill; text tracks and event streams stay out
        const sets = [...tmpl.body.matchAll(/<AdaptationSet\b[^>]*>[\s\S]*?<\/AdaptationSet>/g)].map((m) => m[0])
          .filter((a) => !/contentType="text"|mimeType="(text|application)\//.test(a));
        const body = sets.map((set) => set.replace(TPL_RE, (tpl) => {
          const lt = loopTrackFor(o.loop!, attr(tpl, 'initialization') ?? '');
          const mm = /^(.*?)(\d+)(\.m4s)$/.exec(lt.segments[0].uri);
          if (!mm) throw new VariantError(`loop segment names are not numbered: ${lt.segments[0].uri}`);
          const segs: { t: number; d: number }[] = [];
          let c = 0;
          for (let k = 0; k < N && ps + c < pe - 1e-6; k++) {
            const d = lt.segments[Math.min(k, lt.segments.length - 1)].dur;
            if (ps + c + d > edge + 1e-3) break;        // not available yet
            segs.push({ t: Math.round(c * 1000), d: Math.round(d * 1000) });
            c += d;
          }
          if (tpl === tmpl.leadTpl && segs.length) leadHas = true;
          const open = `<SegmentTemplate timescale="1000" presentationTimeOffset="0" initialization="${absolute(o.loop!.base, lt.init)}" media="${absolute(o.loop!.base, mm[1] + '$Number$' + mm[3])}" startNumber="${Number(mm[2])}">`;
          return `${open}${timelineXml(segs)}</SegmentTemplate>`;
        })).join('');
        if (!leadHas) continue;
        const done = pe <= edge;
        out.push({ start: ps, xml: `<Period id="${o.key}-${Math.round(ps * 1000)}" start="${pt(ps - ast)}"${done ? ` duration="${pt(pe - ps)}"` : ''}>${body}</Period>` });
      }
    }
  }
  out.sort((x, y) => x.start - y.start);
  // only the last Period may be open-ended
  const xml = out.map((p, i) => (i < out.length - 1 && !/^<Period\b[^>]*\sduration=/.test(p.xml)
    ? p.xml.replace(/^<Period\b[^>]*>/, (o2) => setAttr(o2, 'duration', pt(out[i + 1].start - p.start))) : p.xml));
  return head + xml.join('') + tail;
}

// ---------------------------------------------------------------------------
//  Reading the delivered output (shared by every variant through a short cache)
// ---------------------------------------------------------------------------
export const SOURCE_FILE = /^(?:[A-Za-z0-9_-]+\/)?[A-Za-z0-9_.-]+\.(m3u8|mpd|json)$/;
const SOURCE_CACHE_MS = () => Math.max(0, Number(process.env.VARIANT_SOURCE_CACHE_MS ?? 1000));
const sourceCache = new Map<string, { at: number; p: Promise<string | null> }>();
/** Counts real reads of the delivered output (the load test reads it). */
export const variantSourceStats = { reads: 0 };

let s3: any = null;
async function s3Get(key: string): Promise<string | null> {
  const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
  if (!s3) s3 = new S3Client({ region: config.aws.region, endpoint: process.env.AWS_ENDPOINT_URL || undefined, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1' });
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: config.aws.s3Bucket, Key: key }));
    return await (r.Body as any).transformToString();
  } catch (e: any) {
    if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

/** This box can read the stream's output from disk (the Mac), or it is in S3 (the cloud). */
export const localOutput = (id: string) => existsSync(liveDirFor(id));

/** One delivered file as the encoder wrote it, at most a second old. */
export function readDelivered(kind: 'channel' | 'event', id: string, file: string): Promise<string | null> {
  if (!SOURCE_FILE.test(file) || file.includes('..')) return Promise.resolve(null);
  const k = `${kind}/${id}/${file}`;
  const hit = sourceCache.get(k);
  const ttl = SOURCE_CACHE_MS();
  if (hit && Date.now() - hit.at < ttl) return hit.p;
  const p = (async () => {
    variantSourceStats.reads++;
    if (localOutput(id)) return readFile(join(liveDirFor(id), file), 'utf8').catch(() => null);
    if (config.env === 'production' && config.aws?.s3Bucket) return s3Get(`${kind}/${id}/${file}`);
    return null;
  })();
  if (ttl > 0) {
    sourceCache.set(k, { at: Date.now(), p });
    if (sourceCache.size > 5000) for (const [kk, v] of sourceCache) if (Date.now() - v.at > ttl) sourceCache.delete(kk);
  }
  return p;
}

/** Where the variant's playlists point for the stream's own files. */
export function segmentBase(kind: 'channel' | 'event', id: string): string {
  // On the Mac the output is served at /origin/<id>/live/; behind the CDN the
  // variant lives at /<kind>/<id>/v/<key>/, two levels below the files.
  return localOutput(id) ? `${liveUrlBase(id)}/` : '../../';
}

/** The stream's pre-built loop: the copy the encoder keeps beside its output, else fillerPrep's. */
export async function loadLoop(kind: 'channel' | 'event', id: string): Promise<Loop | null> {
  const parse = (s: string | null, base: string): Loop | null => {
    if (!s) return null;
    try {
      const j = JSON.parse(s);
      if (!j?.tracks || !Object.keys(j.tracks).length) return null;
      return { segmentSeconds: Number(j.segment_seconds), base, tracks: j.tracks };
    } catch { return null; }
  };
  const run = parse(await readDelivered(kind, id, 'filler/filler.json'), segmentBase(kind, id) + 'filler/');
  if (run) return run;
  if (!localOutput(id)) return null;
  const pre = join(originBaseFor(id), 'filler', 'prebuilt', 'filler.json');
  return parse(await readFile(pre, 'utf8').catch(() => null), `/origin/${id}/filler/prebuilt/`);
}

/** The delivered file behind a public name: the encoder's delivered copies when it writes them. */
export async function deliveredText(kind: 'channel' | 'event', id: string, file: string): Promise<string | null> {
  const alt = file === 'master.m3u8' ? 'master_cc.m3u8' : file === 'manifest.mpd' ? 'manifest_cc.mpd' : null;
  if (alt) { const t = await readDelivered(kind, id, alt); if (t != null) return t; }
  return readDelivered(kind, id, file);
}

/** Render one file of a variant. Throws VariantError when it cannot be built safely. */
export async function renderVariant(inp: {
  kind: 'channel' | 'event'; id: string; key: string; file: string; timeline: Timeline; shiftSec?: number; carry?: string;
}): Promise<{ body: string; type: string } | null> {
  const text = await deliveredText(inp.kind, inp.id, inp.file);
  if (text == null) return null;
  const base = segmentBase(inp.kind, inp.id);
  if (inp.file.endsWith('.mpd')) {
    const loop = inp.timeline.length ? await loadLoop(inp.kind, inp.id) : null;
    return { body: renderVariantMpd(text, { timeline: inp.timeline, loop, base, key: inp.key, shiftSec: inp.shiftSec }), type: 'application/dash+xml' };
  }
  if (isMaster(text)) return { body: renderVariantMaster(text, inp.carry ?? ''), type: 'application/vnd.apple.mpegurl' };
  const loop = inp.timeline.length ? await loadLoop(inp.kind, inp.id) : null;
  return {
    body: renderVariantMedia(text, { timeline: inp.timeline, loop, base, emptyVtt: 'empty.vtt', shiftSec: inp.shiftSec }),
    type: 'application/vnd.apple.mpegurl',
  };
}

/** An empty WebVTT document: what a subtitle track shows inside a window. */
export const EMPTY_VTT = 'WEBVTT\n\n';
