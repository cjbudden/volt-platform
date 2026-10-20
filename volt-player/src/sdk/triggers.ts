// ============================================================================
//  IN-STREAM GRAPHIC TRIGGERS, player side.
//
//  The server writes them into the manifests (control plane builds them, the
//  encoder places them; see volt-app/src/services/graphicTriggers.ts):
//    HLS   #EXT-X-DATERANGE with CLASS com.boomlabs.volt.* and X- attributes
//    DASH  EventStream urn:com:boomlabs:volt:*:2026, JSON in messageData
//  and they reach this file in three shapes:
//    Shaka HLS    `metadataadded`: ONE region PER ATTRIBUTE (Shaka splits the tag
//                 and drops the ID), so they are regrouped by class + times
//    Shaka DASH   `timelineregionadded`: one region, payload in messageData
//    Safari HLS   DataCues on a metadata text track, one per attribute
//
//  TIMES ARE MEDIA TIMES (the same clock as video.currentTime), which is what all
//  three report. So "is it on screen" is just currentTime inside [start, end),
//  and that holds for a viewer behind live, one scrubbing the DVR, and VOD.
//
//  Pure: no DOM, no Shaka. Tested in node (test/player-sdk.check.ts).
// ============================================================================
import type { StreamGraphic, UpNext } from './types';

export const VOLT_CLASS_PREFIX = 'com.boomlabs.volt.';
export const VOLT_SCHEME_PREFIX = 'urn:com:boomlabs:volt:';

/** X-NEXT-TITLE -> next_title; TITLE -> title. One key style whatever the source. */
const key = (k: string) => String(k).replace(/^X-/i, '').toLowerCase().replace(/-/g, '_');

const graphicOf = (cls: string, data: Record<string, string>): string =>
  data.graphic || (cls.endsWith('.ad') ? 'ad' : cls.endsWith('.programme') ? 'programme' : cls.slice(VOLT_CLASS_PREFIX.length) || 'unknown');

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Shaka HLS metadata regions (one per attribute) to graphics. Unknown classes are ignored. */
export function fromHlsRegions(regions: Array<{ startTime: number; endTime: number; metadataType: string; payload: any }>): StreamGraphic[] {
  const groups = new Map<string, { cls: string; start: number; end: number | null; data: Record<string, string> }>();
  for (const r of regions) {
    const cls = String(r?.metadataType ?? '');
    if (!cls.startsWith(VOLT_CLASS_PREFIX)) continue;
    const start = num(r.startTime);
    if (start == null) continue;
    const end = num(r.endTime) != null && Number.isFinite(r.endTime) ? r.endTime : null;
    const gk = `${cls}|${start}|${end ?? ''}`;
    let g = groups.get(gk);
    if (!g) groups.set(gk, g = { cls, start, end, data: {} });
    const p = r.payload;
    if (p && typeof p.key === 'string') g.data[key(p.key)] = typeof p.data === 'string' ? p.data : String(p.data ?? '');
  }
  return [...groups.values()].map((g) => ({
    id: g.data.id || `${g.cls}@${g.start}`,
    graphic: graphicOf(g.cls, g.data),
    start: g.start, end: g.end, data: g.data,
  }));
}

/**
 * XML character references, decoded. Shaka's own XML parser hands attribute
 * values over still escaped (`&quot;` stays `&quot;`), so the JSON in
 * messageData would not parse. A parser that does decode leaves nothing for
 * this to do, unless a value genuinely contains an entity-like string, which a
 * JSON payload of titles does not.
 */
export function xmlUnescape(v: string): string {
  if (!v.includes('&')) return v;
  return v.replace(/&(#x[0-9a-f]+|#[0-9]+|quot|apos|lt|gt|amp);/gi, (_m, e: string) => {
    const k = e.toLowerCase();
    if (k[0] === '#') { const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : _m; }
    return ({ quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' } as Record<string, string>)[k] ?? _m;
  });
}

/** A Shaka DASH timeline region to a graphic, or null when it is not ours. */
export function fromDashRegion(r: { schemeIdUri?: string; value?: string; startTime?: number; endTime?: number; id?: string; eventElement?: any; eventNode?: any }): StreamGraphic | null {
  const scheme = String(r?.schemeIdUri ?? '');
  if (!scheme.startsWith(VOLT_SCHEME_PREFIX)) return null;
  const start = num(r.startTime);
  if (start == null) return null;
  const raw = r.eventElement?.getAttribute?.('messageData') ?? r.eventNode?.attributes?.messageData ?? '{}';
  let data: Record<string, string> = {};
  try {
    const j = JSON.parse(xmlUnescape(String(raw)));
    if (j && typeof j === 'object') for (const [k, v] of Object.entries(j)) data[key(k)] = String(v);
  } catch { data = {}; }
  const end = num(r.endTime) != null && Number.isFinite(r.endTime!) ? r.endTime! : null;
  return { id: `${scheme}#${r.id ?? start}`, graphic: data.graphic || r.value || 'unknown', start, end, data };
}

/** Safari's DataCues (one per attribute) to graphics. */
export function fromNativeCues(cues: Array<{ id?: string; type?: string; startTime: number; endTime: number; value?: any }>): StreamGraphic[] {
  return fromHlsRegions(cues.map((c) => ({
    startTime: c.startTime, endTime: c.endTime, metadataType: String(c.type ?? ''),
    payload: { key: c.value?.key, data: c.value?.data ?? c.value?.info },
  })));
}

/** Keep graphics by id; a later report of the same one replaces it (a corrected title). */
export function mergeGraphics(into: Map<string, StreamGraphic>, list: StreamGraphic[], horizon?: number): void {
  for (const g of list) into.set(g.id, g);
  // Forget what has long passed so a 24 h session does not grow without limit.
  if (horizon != null) for (const [id, g] of into) if (g.end != null && g.end < horizon) into.delete(id);
}

/** What is on screen at media time t. */
export function activeAt(all: Iterable<StreamGraphic>, t: number): StreamGraphic[] {
  const out: StreamGraphic[] = [];
  for (const g of all) if (t >= g.start && (g.end == null || t < g.end)) out.push(g);
  return out.sort((a, b) => a.start - b.start);
}

/**
 * The Up next card from an active up-next graphic. The countdown runs to the
 * next programme's start when the stream has a wall clock, else to the card's
 * own end (which the server places before the programme change).
 */
export function upNextFromGraphic(g: StreamGraphic, t: number, wallClock: number | null): UpNext {
  const starts = g.data.starts ? Date.parse(g.data.starts) : NaN;
  const inMs = Number.isFinite(starts) && wallClock != null ? Math.max(0, starts - wallClock)
    : Math.max(0, ((g.end ?? t) - t) * 1000);
  return {
    kind: 'programme',
    title: g.data.title || 'Up next',
    subtitle: g.data.subtitle || null,
    artworkUrl: g.data.image || null,
    inMs: Math.round(inMs),
    autoAdvance: false,
    totalMs: Math.round(((g.end ?? g.start + 12) - g.start) * 1000),
  };
}

/**
 * The ad break at media time t, if one is on and asks for graphics to be
 * hidden. A break is a STATE, not a graphic: it is reported whether or not
 * graphics are switched on, so a host page can pause its own overlays too.
 * The server sends HIDE-GRAPHICS=all on every break unless a break was set up
 * to keep them (a sponsored break that wants its bug, say).
 */
export function adBreakAt(all: Iterable<StreamGraphic>, t: number): StreamGraphic | null {
  for (const g of all) {
    if (g.graphic !== 'ad-break') continue;
    if (t < g.start || (g.end != null && t >= g.end)) continue;
    if ((g.data.hide_graphics ?? 'all') === 'none') continue;
    return g;
  }
  return null;
}
