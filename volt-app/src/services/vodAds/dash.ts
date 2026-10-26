// ============================================================================
//  ON-DEMAND ADS IN DASH: one stitched MPD per viewer session, multi-Period.
//
//  The asset's own MPD (a static one, as the VOD encoder writes it: one
//  Period, a SegmentTemplate per rendition) is cut at each break into content
//  Periods, with a Period per ad in between. A content Period keeps everything
//  of the asset's (AdaptationSets, Representations, ContentProtection, Roles,
//  captions) and only narrows its segment timeline: startNumber and
//  presentationTimeOffset move to where the Period starts, so the same files
//  play from the same CDN addresses. Breaks sit on the content's segment
//  starts (plan.ts), so no segment is split.
//
//  An ad Period is the ad's own fMP4 renditions (the same files the stitched
//  HLS plays) as a SegmentList: the init straight from the CDN, each segment
//  through the session's segment route (/vod-ads/s/<session>/seg/...), which
//  is how the server sends the ad's impression and quartiles for any player,
//  as in HLS. Ads are clear: an ad Period has no ContentProtection, so an
//  encrypted title plays its ads in the clear and its keys apply again in the
//  next content Period (Shaka and dash.js switch at the Period boundary).
//  Captions stay continuous: every text AdaptationSet of the content has its
//  twin in an ad Period, with a blank WebVTT for the length of the ad. A
//  sidecar WebVTT (one file for the whole title, as the packager writes it)
//  is cut per content Period, its cues moved to the Period's own clock
//  (cutVtt, served by the session): a whole-title file in a later Period would
//  show every caption late by that Period's start, and SegmentBase offsets on
//  a text file are not something players agree on (neither Shaka nor dash.js
//  showed a cue with one).
//
//  An ad with no fMP4 rendition (a TS-only creative) cannot be a DASH Period:
//  the caller then offers HLS only for that session.
//
//  PURE: text in, text out. test/vod-ads-dash.check.ts.
// ============================================================================
import { XmlStream, type XmlNode } from '../xmltvParse';
import { absUrl } from './hls';

export interface Mpd {
  attrs: Record<string, string>;
  /** The MPD's own BaseURL, if it has one. */
  baseUrl: string | null;
  period: XmlNode;
  durationSec: number;
}

const DUR = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;
/** An xs:duration (PT1H2M3.5S) in seconds, null when it is not one. */
export function parseDuration(s?: string | null): number | null {
  const m = s?.trim().match(DUR);
  if (!m || !s!.includes('T') && !m[1]) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}
export const isoDuration = (sec: number) => `PT${(Math.round(sec * 1000) / 1000).toFixed(3)}S`;

const kid = (n: XmlNode | null | undefined, name: string) => n?.children.find((c) => c.name === name) ?? null;
const kids = (n: XmlNode | null | undefined, name: string) => n?.children.filter((c) => c.name === name) ?? [];
const clone = (n: XmlNode): XmlNode => ({ name: n.name, attrs: { ...n.attrs }, text: n.text, children: n.children.map(clone) });

// ---------------------------------------------------------------- reading

interface Seg { t: number; d: number }
interface Template { attrs: Record<string, string>; timescale: number; pto: number; startNumber: number; segs: Seg[] }

/** A Representation's segments, from its own SegmentTemplate or its AdaptationSet's. Null when there is none to cut. */
function templateOf(as: XmlNode, rep: XmlNode, periodSec: number): Template | null {
  const a = kid(as, 'SegmentTemplate'), r = kid(rep, 'SegmentTemplate');
  if (!a && !r) return null;
  const attrs = { ...(a?.attrs ?? {}), ...(r?.attrs ?? {}) };
  const timescale = Number(attrs.timescale ?? 1) || 1;
  const pto = Number(attrs.presentationTimeOffset ?? 0) || 0;
  const startNumber = Number(attrs.startNumber ?? 1);
  const tl = kid(r, 'SegmentTimeline') ?? kid(a, 'SegmentTimeline');
  const segs: Seg[] = [];
  const end = pto + periodSec * timescale;
  if (tl) {
    let t = pto;
    const ss = kids(tl, 'S');
    ss.forEach((s, i) => {
      if (s.attrs.t != null) t = Number(s.attrs.t);
      const d = Number(s.attrs.d);
      if (!(d > 0)) return;
      let rep = Number(s.attrs.r ?? 0);
      // r=-1: repeat to the next S, or to the end of the Period
      if (rep < 0) {
        const next = ss[i + 1]?.attrs.t;
        rep = Math.max(0, Math.ceil(((next != null ? Number(next) : end) - t) / d) - 1);
      }
      for (let k = 0; k <= rep; k++) { segs.push({ t, d }); t += d; }
    });
  } else if (attrs.duration) {
    const d = Number(attrs.duration);
    if (!(d > 0)) return null;
    const n = Math.ceil((periodSec * timescale) / d - 1e-9);
    for (let i = 0; i < n; i++) segs.push({ t: pto + i * d, d });
  } else return null;
  if (!segs.length) return null;
  return { attrs, timescale, pto, startNumber, segs };
}

/**
 * The asset's MPD, when it is one this can stitch: static, one Period, every
 * Representation on a SegmentTemplate. Null otherwise (an on-demand profile
 * MPD on SegmentBase, a live one): that title is then offered in HLS only.
 */
export function parseMpd(text: string): Mpd | null {
  if (!/<MPD[\s>]/.test(text)) return null;
  let attrs: Record<string, string> = {};
  let baseUrl: string | null = null;
  const periods: XmlNode[] = [];
  try {
    const s = new XmlStream(new Set(['Period', 'BaseURL']), (n) => {
      if (n.name === 'Period') periods.push(n);
      else if (baseUrl == null) baseUrl = n.text.trim();
    }, (a) => { attrs = a; });
    s.write(text);
    s.end();
  } catch { return null; }
  if ((attrs.type ?? 'static') !== 'static' || periods.length !== 1) return null;
  const period = periods[0];
  const durationSec = parseDuration(attrs.mediaPresentationDuration) ?? parseDuration(period.attrs.duration);
  if (!durationSec) return null;
  const sets = kids(period, 'AdaptationSet');
  if (!sets.length) return null;
  for (const as of sets) {
    const reps = kids(as, 'Representation');
    if (!reps.length) return null;
    for (const rep of reps) if (contentType(as, rep) !== 'text' && !templateOf(as, rep, durationSec)) return null;
  }
  return { attrs, baseUrl, period, durationSec };
}

export function contentType(as: XmlNode, rep?: XmlNode): 'video' | 'audio' | 'text' | 'other' {
  const ct = as.attrs.contentType;
  if (ct === 'video' || ct === 'audio' || ct === 'text') return ct;
  const mime = as.attrs.mimeType ?? rep?.attrs.mimeType ?? kids(as, 'Representation')[0]?.attrs.mimeType ?? '';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('text/') || mime === 'application/ttml+xml' || /stpp|wvtt/.test(as.attrs.codecs ?? rep?.attrs.codecs ?? '')) return 'text';
  return 'other';
}

/** Content times (seconds) of a rendition's segment starts, for checking that breaks sit on them. */
export function segmentStarts(mpd: Mpd): number[] {
  const as = kids(mpd.period, 'AdaptationSet').find((x) => contentType(x) === 'video') ?? kids(mpd.period, 'AdaptationSet')[0];
  const rep = kids(as, 'Representation')[0];
  const t = rep ? templateOf(as, rep, mpd.durationSec) : null;
  return t ? t.segs.map((s) => Math.round(((s.t - t.pto) / t.timescale) * 1000) / 1000) : [];
}

// ---------------------------------------------------------------- writing

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function xml(n: XmlNode, depth = 1): string {
  const pad = '  '.repeat(depth);
  const at = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  const text = n.text.trim();
  if (!n.children.length && !text) return `${pad}<${n.name}${at}/>`;
  if (!n.children.length) return `${pad}<${n.name}${at}>${esc(text)}</${n.name}>`;
  return `${pad}<${n.name}${at}>${text ? esc(text) : ''}\n${n.children.map((c) => xml(c, depth + 1)).join('\n')}\n${pad}</${n.name}>`;
}
const el = (name: string, attrs: Record<string, string | number | undefined | null> = {}, children: XmlNode[] = [], text = ''): XmlNode =>
  ({ name, attrs: Object.fromEntries(Object.entries(attrs).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)])), children, text });

/**
 * S elements: <S t d r>, run-length unless `repeat` is false. A SegmentList's
 * timeline is written one S per segment: dash.js 4 counts a repeated S in a
 * SegmentList as one SegmentURL and asks for the first segment again.
 */
function timeline(segs: Seg[], repeat = true): XmlNode {
  const out: XmlNode[] = [];
  let prevEnd: number | null = null;
  for (const s of segs) {
    const last = out[out.length - 1];
    if (repeat && last && prevEnd === s.t && Number(last.attrs.d) === s.d) last.attrs.r = String(Number(last.attrs.r ?? 0) + 1);
    else out.push(el('S', prevEnd === s.t ? { d: s.d } : { t: s.t, d: s.d }));
    prevEnd = s.t + s.d;
  }
  return el('SegmentTimeline', {}, out);
}

export interface DashAdTrack {
  kind: 'video' | 'audio';
  /** Unique within the MPD: becomes the Representation id. */
  id: string;
  init: string;
  codecs: string;
  bandwidth: number;
  width?: number;
  height?: number;
  segments: { dur: number; url: string }[];
}
export interface DashAd { id: string; tracks: DashAdTrack[] }
export interface DashBreak { index: number; atSec: number; ads: DashAd[] }

const adSec = (a: DashAd) => {
  const v = a.tracks.find((t) => t.kind === 'video') ?? a.tracks[0];
  return v ? v.segments.reduce((n, s) => n + s.dur, 0) : 0;
};

/** Where a sidecar caption file of content Period `k` (Representation `repId`) is served. */
export type TextUrl = (k: number, repId: string) => string;

/** One content Period: the asset's own, its timelines narrowed to [from, to). */
function contentPeriod(mpd: Mpd, k: number, startSec: number, from: number, to: number, last: boolean, base: string, textUrl?: TextUrl): XmlNode {
  const id = `c${k}`;
  const src = mpd.period;
  const p = el('Period', { id, start: isoDuration(startSec), duration: isoDuration(to - from) });
  p.children.push(el('BaseURL', {}, [], base));
  for (const c of src.children) {
    if (c.name === 'BaseURL') continue;
    if (c.name !== 'AdaptationSet') { p.children.push(clone(c)); continue; }
    const as = clone(c);
    as.children = as.children.filter((x) => x.name !== 'SegmentTemplate');
    const reps: XmlNode[] = [];
    for (const rep0 of kids(c, 'Representation')) {
      const rep = clone(rep0);
      const tpl = templateOf(c, rep0, mpd.durationSec);
      if (!tpl) {
        // A sidecar caption file (one WebVTT for the whole title): this Period's
        // part of it, on the Period's clock (cutVtt), when the caller serves one.
        if (textUrl && rep.attrs.id && kid(rep, 'BaseURL')) {
          rep.children = rep.children.filter((x) => x.name !== 'BaseURL' && x.name !== 'SegmentBase');
          rep.children.push(el('BaseURL', {}, [], textUrl(k, rep.attrs.id)));
        }
        reps.push(rep);
        continue;
      }
      // A segment belongs to the Period its middle falls in: audio frames do not
      // land exactly on the video's boundaries, and no frame is played twice.
      const mid = (s: Seg) => (s.t + s.d / 2 - tpl.pto) / tpl.timescale;
      const idx: number[] = [];
      tpl.segs.forEach((s, i) => { const m = mid(s); if (m >= from && (last || m < to)) idx.push(i); });
      if (!idx.length) continue;
      const attrs: Record<string, string> = { ...tpl.attrs, startNumber: String(tpl.startNumber + idx[0]),
        presentationTimeOffset: String(Math.round(tpl.pto + from * tpl.timescale)) };
      delete attrs.duration;
      rep.children = rep.children.filter((x) => x.name !== 'SegmentTemplate');
      rep.children.push(el('SegmentTemplate', attrs, [timeline(idx.map((i) => tpl.segs[i]))]));
      reps.push(rep);
    }
    if (!reps.length) continue;
    as.children = [...as.children.filter((x) => x.name !== 'Representation'), ...reps];
    p.children.push(as);
  }
  return p;
}

/** One ad's Period: its renditions as SegmentLists, blank captions beside them, no protection. */
function adPeriod(mpd: Mpd, ad: DashAd, startSec: number, blankVtt: string): XmlNode {
  const dur = adSec(ad);
  const p = el('Period', { id: ad.id, start: isoDuration(startSec), duration: isoDuration(dur) });
  for (const c of kids(mpd.period, 'AdaptationSet')) {
    const kind = contentType(c);
    // Labels and roles travel, so players match the tracks across Periods.
    const keep = c.children.filter((x) => x.name === 'Role' || x.name === 'Label' || x.name === 'Accessibility').map(clone);
    if (kind === 'text') {
      const rep = kids(c, 'Representation')[0];
      p.children.push(el('AdaptationSet', { id: c.attrs.id, contentType: 'text', mimeType: 'text/vtt', lang: c.attrs.lang ?? rep?.attrs.lang }, [
        ...keep, el('Representation', { id: `${ad.id}-${rep?.attrs.id ?? c.attrs.id ?? 'text'}`, bandwidth: 256 }, [el('BaseURL', {}, [], blankVtt)])]));
      continue;
    }
    if (kind !== 'video' && kind !== 'audio') continue;
    const tracks = ad.tracks.filter((t) => t.kind === kind);
    if (!tracks.length) continue;
    p.children.push(el('AdaptationSet', { id: c.attrs.id, contentType: kind, mimeType: `${kind}/mp4`, lang: kind === 'audio' ? c.attrs.lang : undefined,
      segmentAlignment: 'true', startWithSAP: '1' }, [
      ...keep,
      ...tracks.map((t) => {
        let at = 0;
        const segs = t.segments.map((s) => { const x = { t: at, d: Math.round(s.dur * 1000) }; at += x.d; return x; });
        return el('Representation', { id: t.id, codecs: t.codecs, bandwidth: t.bandwidth || 1, width: t.width, height: t.height, audioSamplingRate: undefined }, [
          el('SegmentList', { timescale: 1000 }, [el('Initialization', { sourceURL: t.init }), timeline(segs, false), ...t.segments.map((s) => el('SegmentURL', { media: s.url }))]),
        ]);
      }),
    ]));
  }
  return p;
}

/**
 * The stitched MPD: content Periods cut at each break, the break's ads as
 * Periods between them (a pre-roll before the first, a post-roll after the
 * last). `mpdUrl` is where the asset's MPD lives, to resolve its segments.
 */
export function stitchMpd(mpd: Mpd, mpdUrl: string, breaks: DashBreak[], blankVtt: string, textUrl?: TextUrl): string {
  const contentBase = contentBaseOf(mpd, mpdUrl);
  const sorted = [...breaks].filter((b) => b.ads.length).sort((a, b) => a.atSec - b.atSec || a.index - b.index);
  const edges = contentEdges(mpd, sorted.map((b) => b.atSec));
  const periods: XmlNode[] = [];
  let at = 0;
  const ads = (b: DashBreak) => { for (const a of b.ads) { periods.push(adPeriod(mpd, a, at, blankVtt)); at += adSec(a); } };
  let k = 0;
  for (let i = 0; i < edges.length - 1; i++) {
    const from = edges[i], to = edges[i + 1];
    while (k < sorted.length && sorted[k].atSec <= from + 0.01) ads(sorted[k++]);
    periods.push(contentPeriod(mpd, i, at, from, to, i === edges.length - 2, contentBase, textUrl));
    at += to - from;
  }
  while (k < sorted.length) ads(sorted[k++]);
  const root: Record<string, string> = { ...mpd.attrs, type: 'static', mediaPresentationDuration: isoDuration(at) };
  if (!root.xmlns) root.xmlns = 'urn:mpeg:dash:schema:mpd:2011';
  delete root.availabilityStartTime;
  // An ad's segments may be longer than the content's.
  delete root.maxSegmentDuration;
  const at2 = Object.entries(root).map(([k2, v]) => ` ${k2}="${esc(v)}"`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<MPD${at2}>\n${periods.map((p) => xml(p)).join('\n')}\n</MPD>\n`;
}

/** Where the asset's segments are: its MPD's folder, or the BaseURLs it names. */
export function contentBaseOf(mpd: Mpd, mpdUrl: string): string {
  const base = absUrl(mpdUrl, mpd.baseUrl || './');
  const periodBase = kid(mpd.period, 'BaseURL')?.text.trim();
  return periodBase ? absUrl(base, periodBase) : base;
}

/** Content Period edges (seconds of content): 0, each break inside the title, the end. */
export function contentEdges(mpd: Mpd, breakAts: number[]): number[] {
  const total = mpd.durationSec;
  const cuts = [...new Set(breakAts.filter((t) => t > 0.01 && t < total - 0.01))].sort((a, b) => a - b);
  return [0, ...cuts, total];
}

/** A sidecar caption Representation of the asset: its id and where its file is. */
export function sidecarText(mpd: Mpd, mpdUrl: string, repId: string): string | null {
  for (const as of kids(mpd.period, 'AdaptationSet')) {
    if (contentType(as) !== 'text') continue;
    const rep = kids(as, 'Representation').find((r) => r.attrs.id === repId);
    const b = rep && !templateOf(as, rep, mpd.durationSec) ? kid(rep, 'BaseURL')?.text.trim() : null;
    if (b) return absUrl(contentBaseOf(mpd, mpdUrl), b);
  }
  return null;
}

// ---------------------------------------------------------------- captions per Period

const TS = /(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})/;
const toSec = (m: RegExpMatchArray) => Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
const vttTime = (sec: number) => {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, x = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};

/**
 * The part of a WebVTT file between `from` and `to` (seconds), its cue times
 * moved back by `from`: a content Period's captions on that Period's clock. A
 * cue that crosses an edge is kept with its time clipped to the Period. The
 * header (WEBVTT line, STYLE and REGION blocks) is kept; NOTE blocks are not.
 */
export function cutVtt(text: string, from: number, to: number): string {
  const blocks = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').split(/\n{2,}/);
  const out: string[] = [];
  let header = true;
  for (const b0 of blocks) {
    const b = b0.replace(/\s+$/, '');
    if (!b) continue;
    const lines = b.split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) {
      // the WEBVTT line itself, and the header's STYLE and REGION blocks
      if (header && !/^NOTE(\s|$)/.test(lines[0])) out.push(b.replace(/^WEBVTT[^\n]*/, 'WEBVTT'));
      continue;
    }
    header = false;
    const [a, rest] = lines[ti].split('-->');
    const ma = a.match(TS), mb = rest?.match(TS);
    if (!ma || !mb) continue;
    const s = toSec(ma), e = toSec(mb);
    if (e <= from || s >= to) continue;
    const settings = rest.replace(TS, '').trim();
    lines[ti] = `${vttTime(Math.max(s, from) - from)} --> ${vttTime(Math.min(e, to) - from)}${settings ? ' ' + settings : ''}`;
    out.push(lines.join('\n'));
  }
  if (!out.length || !out[0].startsWith('WEBVTT')) out.unshift('WEBVTT');
  return out.join('\n\n') + '\n';
}
