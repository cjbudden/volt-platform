// ============================================================================
//  VMAP: WHEN THE AD SERVER DECIDES WHERE THE BREAKS GO (SSAI.md 5.1, item 2).
//
//  Google Ad Manager ("ad rules"), FreeWheel and others can answer one request
//  for a whole title with a VMAP 1.0 document: a list of AdBreaks, each with
//  a timeOffset (start, end, a time, a percentage or the nth cue point) and an
//  AdSource that is either a VAST tag to ask (AdTagURI) or the VAST itself
//  (VASTAdData). Volt keeps doing what it does well, the stitching, the
//  conditioning and the beacons; it only takes the schedule from the ad
//  server instead of from its own rule.
//
//  WHAT THIS MODULE DOES, all of it pure apart from the injected fetch:
//    parseVmap    VMAP XML -> breaks (offset, type, id, source, tracking)
//    fetchVmap    one request within the ad server's time budget
//    offsetSec    where a break's offset lands in a title of a given length
//    sourceFetcher  a Fetcher that answers an inline VAST source itself, so
//                 fast/vast.ts `resolve` treats both kinds of source alike
//                 (wrappers, budget and error codes unchanged)
//
//  Namespaces vary by vendor (vmap:, none, another prefix): element names are
//  matched without their prefix. Only linear breaks are kept: a stitched or
//  guided title has nowhere to show an overlay or a companion.
//
//  PURE. test/vod-ads-vmap.check.ts.
// ============================================================================
import { decodeEntities } from '../xmltvParse';
import type { Fetcher } from '../fast/vast';

export type VmapOffset =
  | { kind: 'start' }
  | { kind: 'end' }
  | { kind: 'time'; sec: number }
  | { kind: 'percent'; pct: number }
  | { kind: 'position'; n: number };

export type VmapSource = { kind: 'tag'; url: string } | { kind: 'vast'; xml: string };

export interface VmapBreak {
  /** The offset as the ad server wrote it, for the console and the problems list. */
  timeOffset: string;
  offset: VmapOffset;
  breakId: string | null;
  source: VmapSource | null;
  /** VMAP's own trackers: breakStart and breakEnd are sent with the pod's first and last ad; error when a break ends up empty. */
  tracking: { breakStart: string[]; breakEnd: string[]; error: string[] };
}

export interface VmapDoc { version: string; breaks: VmapBreak[]; problems: string[] }

/** Strip the namespace prefix from every tag name, so vmap:AdBreak and AdBreak read alike. */
const unprefix = (xml: string) => xml.replace(/<(\/?)[A-Za-z_][\w.-]*:([A-Za-z_][\w.-]*)/g, '<$1$2');

function attrsOf(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]] = decodeEntities(m[3] ?? m[4] ?? '');
  return out;
}

/** Text of an element: CDATA as is, the rest with entities decoded, trimmed. */
function textOf(inner: string): string {
  let out = '';
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(inner))) { out += decodeEntities(inner.slice(last, m.index)) + m[1]; last = m.index + m[0].length; }
  return (out + decodeEntities(inner.slice(last))).trim();
}

/** Every <name ...>inner</name> (or self-closed) directly findable in `xml`, in order. */
function elements(xml: string, name: string): { attrs: Record<string, string>; inner: string }[] {
  const out: { attrs: Record<string, string>; inner: string }[] = [];
  const re = new RegExp(`<${name}(\\s[^>]*?)?(/>|>([\\s\\S]*?)</${name}\\s*>)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push({ attrs: attrsOf(m[1] ?? ''), inner: m[3] ?? '' });
  return out;
}

/** A VMAP timeOffset to an offset, or null when it cannot be read. */
export function parseOffset(s: string): VmapOffset | null {
  const v = s.trim();
  if (v === 'start') return { kind: 'start' };
  if (v === 'end') return { kind: 'end' };
  let m = v.match(/^(\d+):([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/);
  if (m) return { kind: 'time', sec: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) };
  m = v.match(/^(\d+(?:\.\d+)?)%$/);
  if (m && Number(m[1]) <= 100) return { kind: 'percent', pct: Number(m[1]) };
  m = v.match(/^#(\d+)$/);
  if (m && Number(m[1]) >= 1) return { kind: 'position', n: Number(m[1]) };
  return null;
}

/**
 * Read a VMAP document. A break Volt cannot place (an unreadable offset) or
 * cannot play (a non-linear break) is left out and said in `problems`; a
 * document that is not VMAP at all throws.
 */
export function parseVmap(raw: string): VmapDoc {
  const xml = unprefix(raw.replace(/<!--[\s\S]*?-->/g, ''));
  const root = xml.match(/<VMAP(\s[^>]*)?>/);
  if (!root) throw new Error('Not a VMAP document (no VMAP element)');
  const version = attrsOf(root[1] ?? '').version ?? '';
  const breaks: VmapBreak[] = [];
  const problems: string[] = [];
  for (const b of elements(xml, 'AdBreak')) {
    const timeOffset = b.attrs.timeOffset ?? '';
    const types = (b.attrs.breakType ?? 'linear').split(',').map((t) => t.trim().toLowerCase());
    if (!types.includes('linear')) { problems.push(`Break ${b.attrs.breakId ?? timeOffset} is ${b.attrs.breakType}: only linear breaks can play in a stitched or guided title`); continue; }
    const offset = parseOffset(timeOffset);
    if (!offset) { problems.push(`Break ${b.attrs.breakId ?? ''} has an offset Volt cannot read: "${timeOffset}"`); continue; }
    let source: VmapSource | null = null;
    const src = elements(b.inner, 'AdSource')[0];
    if (src) {
      const tag = elements(src.inner, 'AdTagURI')[0];
      const data = elements(src.inner, 'VASTAdData')[0];
      if (tag && textOf(tag.inner)) source = { kind: 'tag', url: textOf(tag.inner) };
      else if (data && /<VAST[\s>]/.test(data.inner)) source = { kind: 'vast', xml: data.inner.trim() };
      else problems.push(`Break ${b.attrs.breakId ?? timeOffset} has an ad source Volt cannot use (custom ad data)`);
    }
    const tracking: VmapBreak['tracking'] = { breakStart: [], breakEnd: [], error: [] };
    for (const t of elements(b.inner.replace(/<AdSource[\s\S]*?<\/AdSource\s*>/g, ''), 'Tracking')) {
      const ev = t.attrs.event as keyof VmapBreak['tracking'];
      const u = textOf(t.inner);
      if (u && ev in tracking) tracking[ev].push(u);
    }
    breaks.push({ timeOffset, offset, breakId: b.attrs.breakId || null, source, tracking });
  }
  return { version, breaks, problems };
}

/**
 * Where an offset lands in a title of `contentSec`, before snapping. `cuesSec`
 * are the title's own cue points, which #n counts (1-based). Null when the
 * moment is not in the title.
 */
export function offsetSec(o: VmapOffset, contentSec: number, cuesSec: number[] = []): number | null {
  switch (o.kind) {
    case 'start': return 0;
    case 'end': return contentSec;
    case 'time': return o.sec <= contentSec ? o.sec : null;
    case 'percent': return (contentSec * o.pct) / 100;
    case 'position': {
      const c = [...cuesSec].filter((x) => x > 0 && x < contentSec).sort((a, b) => a - b)[o.n - 1];
      return c ?? null;
    }
  }
}

export interface VmapFetch { doc: VmapDoc | null; problem: 'timeout' | 'error' | null; message: string | null; elapsedMs: number }

/** One VMAP request within the ad server's budget. Never throws: a fault is a `problem`. */
export async function fetchVmap(url: string, fetcher: Fetcher, budgetMs: number, now: () => number = Date.now): Promise<VmapFetch> {
  const t0 = now();
  let timer: NodeJS.Timeout | undefined;
  try {
    // The fetcher is asked to keep to the budget; the race makes sure of it.
    const r = await Promise.race([
      fetcher(url, budgetMs),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), budgetMs + 50); }),
    ]);
    if (r.status >= 400) return { doc: null, problem: 'error', message: `The ad server answered HTTP ${r.status}`, elapsedMs: now() - t0 };
    // 204 or an empty body: the ad server has no breaks for this title.
    if (r.status === 204 || !r.body.trim()) return { doc: { version: '', breaks: [], problems: [] }, problem: null, message: null, elapsedMs: now() - t0 };
    return { doc: parseVmap(r.body), problem: null, message: null, elapsedMs: now() - t0 };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const timeout = /abort|timeout/i.test(msg) || now() - t0 >= budgetMs;
    return { doc: null, problem: timeout ? 'timeout' : 'error', message: timeout ? `The ad server did not answer within ${budgetMs} ms` : `The ad server's schedule could not be read: ${msg}`, elapsedMs: now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

/** The pseudo address an inline VAST source is resolved from. */
export const INLINE_URL = 'vmap-inline:vast';

/** A Fetcher that answers the inline VAST of `source` itself and asks the network for everything else (wrappers). */
export function sourceFetcher(source: VmapSource, fetcher: Fetcher): { url: string; fetcher: Fetcher } {
  if (source.kind === 'tag') return { url: source.url, fetcher };
  return { url: INLINE_URL, fetcher: (u, t) => (u === INLINE_URL ? Promise.resolve({ status: 200, body: source.xml }) : fetcher(u, t)) };
}
