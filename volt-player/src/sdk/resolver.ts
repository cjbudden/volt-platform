// ============================================================================
//  TALKING TO THE CONTROL PLANE: asset ids, the guide, now playing.
//
//  Every call carries the publishable key and nothing secret. The play gate
//  (POST /api/availability) decides per asset and per viewer country, and
//  answers with the URLs to play and a short-lived playback token for the
//  beacons; items are resolved when they come up, not all at once, so a
//  long playlist never plays on an expired token.
// ============================================================================
import type { EventInfo, PlaylistItem, Product, Programme, Source, TrackInfo } from './types';
import { cleanSchedule } from './schedule';
import type { ItemAds } from './ads';

/** The origin the bundle was served from, captured while the script runs. */
const SCRIPT_ORIGIN: string | null = (() => {
  try {
    const s = (typeof document !== 'undefined' ? document.currentScript : null) as HTMLScriptElement | null;
    return s?.src ? new URL(s.src).origin : null;
  } catch { return null; }
})();

export function defaultApiBase(given?: string): string {
  if (given) return given.replace(/\/$/, '');
  return SCRIPT_ORIGIN ?? (typeof location !== 'undefined' ? location.origin : '');
}

export class GateError extends Error {
  status: number;
  mode: string | null;
  /** The paywall's offers, when it is one. */
  products: Product[];
  /** What is behind the gate (title, artwork), when the gate says. */
  meta: Record<string, any> | null;
  constructor(status: number, message: string, mode: string | null, products: Product[] = [], meta: Record<string, any> | null = null) {
    super(message); this.status = status; this.mode = mode; this.products = products; this.meta = meta;
  }
}

/** What a viewer is told when the gate says no. */
export function gateMessage(status: number, mode: string | null): string {
  if (mode === 'paywall' || status === 402) return 'This needs a subscription or purchase.';
  if (mode === 'sign_in') return 'Sign in to watch this.';
  if (status === 451) return 'This is not available in your region.';
  if (status === 403) return 'This player is not allowed here.';
  if (status === 404) return 'This could not be found.';
  if (status === 401) return 'This player key is not valid.';
  return 'This is not available right now.';
}

export interface ResolvedItem {
  source: Source | null;
  token: string | null;
  title?: string | null;
  description?: string | null;
  artworkUrl?: string | null;
  durationMs?: number | null;
  live?: boolean;
  kind?: string;
  /** On-demand ads for this play (volt-app services/vodAds), when the gate gave any. */
  ads?: ItemAds | null;
  /** The channel's brand mark (a FAST channel's watermark), when it has one. */
  brandMark?: import('./types').BrandMark | null;
}

/**
 * Ask the play gate. `sid` is the play attempt's CMCD session id: the gate
 * puts it in the playback token, so its decision, the beacons and the CDN logs
 * join on one id.
 */
export async function resolveAsset(apiBase: string, appKey: string, assetId: string, viewerToken?: string | null, sid?: string | null,
  ads?: { delivery?: 'auto' | 'stitched' | 'guided'; caps?: string[] }): Promise<ResolvedItem> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // A signed-in viewer: purchases and memberships are checked against them.
  if (viewerToken) headers.authorization = `Bearer ${viewerToken}`;
  const r = await fetch(`${apiBase}/api/availability`, {
    method: 'POST', credentials: 'omit', headers,
    // How on-demand ads should arrive, and what this player can do (guided needs HLS Interstitials).
    body: JSON.stringify({ appKey, assetId, ...(sid ? { sid } : {}), ...(ads ? { adDelivery: ads.delivery ?? 'auto', caps: ads.caps ?? [] } : {}) }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.available === false) {
    const products = Array.isArray(j.products) ? j.products.filter((p: any) => p && typeof p.productKey === 'string') : [];
    throw new GateError(r.status, gateMessage(r.status, j.mode ?? null), j.mode ?? null, products, j.meta ?? null);
  }
  const d = j.delivery ?? null;
  const m = j.meta ?? {};
  return {
    source: d ? { hls: d.hls ?? null, dash: d.dash ?? null, mp3: d.mp3 ?? null } : null,
    token: j.playbackToken ?? null,
    title: m.title ?? null, description: m.description ?? null, artworkUrl: m.artworkUrl ?? null,
    durationMs: m.durationMs ?? null, live: m.live ?? undefined, kind: m.kind,
    brandMark: m.brandMark && typeof m.brandMark.url === 'string' ? m.brandMark : null,
    ads: j.ads && (j.ads.delivery === 'stitched' || j.ads.delivery === 'guided') ? { delivery: j.ads.delivery, sessionId: j.ads.sessionId ?? null, timelineUrl: j.ads.timelineUrl ?? null } : null,
  };
}

export async function fetchSchedule(apiBase: string, appKey: string, channelId: string): Promise<Programme[]> {
  const u = `${apiBase}/api/player/epg?appKey=${encodeURIComponent(appKey)}&channelId=${encodeURIComponent(channelId)}`;
  const r = await fetch(u, { credentials: 'omit' });
  if (!r.ok) return [];
  const j: any = await r.json().catch(() => ({}));
  return cleanSchedule(j.programmes);
}

export interface NowPlayingAnswer { nowPlaying: TrackInfo | null; history: TrackInfo[]; next: TrackInfo | null; onAir: boolean }

export async function fetchNowPlaying(apiBase: string, appKey: string, stationId: string): Promise<NowPlayingAnswer | null> {
  const r = await fetch(`${apiBase}/api/player/now-playing`, {
    method: 'POST', credentials: 'omit',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appKey, channelId: stationId }),
  });
  if (!r.ok) return null;
  const j: any = await r.json().catch(() => null);
  if (!j) return null;
  const track = (x: any): TrackInfo | null => x && (x.title || x.primary) ? {
    title: String(x.title ?? x.primary), artist: x.artist ?? x.secondary ?? null, album: x.album ?? null,
    year: x.year ?? null, artworkUrl: x.artworkUrl ?? null, startedAt: x.startedAt ?? x.since ?? null,
    listen: x.listen && typeof x.listen.url === 'string' ? { service: String(x.listen.service ?? 'Apple Music'), url: x.listen.url } : null,
  } : null;
  return {
    nowPlaying: track(j),
    history: Array.isArray(j.history) ? j.history.map(track).filter(Boolean).slice(0, 5) as TrackInfo[] : [],
    next: track(j.next),
    onAir: j.onAir !== false,
  };
}

/** Apply what the gate said onto the playlist item, without losing what the caller set. */
export function mergeResolved(item: PlaylistItem, r: ResolvedItem): PlaylistItem {
  return {
    ...item,
    source: item.source && (item.source.hls || item.source.dash || item.source.url || item.source.mp3) ? item.source : r.source,
    playbackToken: r.token ?? item.playbackToken ?? null,
    title: item.title ?? r.title ?? null,
    description: item.description ?? r.description ?? null,
    artworkUrl: item.artworkUrl ?? r.artworkUrl ?? null,
    durationMs: item.durationMs ?? r.durationMs ?? null,
    live: item.live ?? r.live,
    ads: r.ads ?? item.ads ?? null,
    brandMark: item.brandMark ?? r.brandMark ?? null,
  };
}

/** An event's phase, times and promo (GET /api/player/event). */
export async function fetchEvent(apiBase: string, appKey: string, eventId: string): Promise<EventInfo | null> {
  const u = `${apiBase}/api/player/event?appKey=${encodeURIComponent(appKey)}&eventId=${encodeURIComponent(eventId)}`;
  const r = await fetch(u, { credentials: 'omit' });
  if (!r.ok) return null;
  const j: any = await r.json().catch(() => null);
  return j && typeof j.title === 'string' ? (j as EventInfo) : null;
}

/** Fill a purchase / sign-in URL template. Values are URL-encoded. */
export function fillUrl(tpl: string, vars: Record<string, string | number | null | undefined>): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, k) => encodeURIComponent(vars[k] != null ? String(vars[k]) : ''));
}

/** "A$4.99", in the viewer's own locale. */
export function fmtPrice(cents: number, currency: string): string {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100); }
  catch { return `${(cents / 100).toFixed(2)} ${currency}`; }
}

/** "24 hours", "1 month", or "This event" for the item's own dates. */
export function fmtTerm(p: Product): string {
  if (p.kind !== 'period' || !p.count || !p.unit) return 'This event';
  if (p.unit === 'day' && p.count === 1) return '24 hours';
  return `${p.count} ${p.unit}${p.count === 1 ? '' : 's'}`;
}
