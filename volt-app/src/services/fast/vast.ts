// ============================================================================
//  VAST: asking a commercial ad server what to play in a break.
//
//  We do not build an ad engine. Google Ad Manager, FreeWheel, SpringServe,
//  Magnite, Publica, Beachfront and the rest all answer the same question the
//  same way: an HTTP GET of a VAST tag URL with macros filled in, answered with
//  a VAST 2/3/4 document. That is the one integration, and every vendor is a
//  tag URL template plus a few vendor-specific macros.
//
//  WHAT THIS MODULE DOES, all of it pure apart from the injected fetch:
//    expandTag     fill the tag URL's macros for one break and one viewer
//    parseVast     VAST XML -> ads (InLine or Wrapper), creatives, media files,
//                  impressions, quartile trackers, error URLs
//    resolve       follow Wrappers to the InLine (depth limit, one overall
//                  time budget), merging each wrapper's trackers into the ad
//    errorUrl      fill [ERRORCODE] for the error pixels we owe the server
//
//  THE TIME BUDGET IS THE CONTRACT. A break never waits for an ad server: the
//  whole decision, wrappers included, has `budgetMs` (default 1500), and what
//  has not answered by then is a timeout (VAST error 301) and the break falls
//  back to house ads. See pod.ts.
// ============================================================================
import { XmlStream, type XmlNode } from '../xmltvParse';

export interface VastMediaFile {
  url: string;
  type: string;
  width?: number;
  height?: number;
  bitrateKbps?: number;
  delivery?: string;
  codec?: string;
}

export interface VastAd {
  id: string;
  /** Position in the pod. Absent = a buffet ad (a stand-by the server offers). */
  sequence: number | null;
  adSystem?: string;
  title?: string;
  /** VAST 3+ <Advertiser> and <Category>: what competitive separation keys on. */
  advertiser?: string;
  categories?: string[];
  /** The creative's identity for the conditioning cache (UniversalAdId, else creative id, else media URL). */
  creativeKey: string;
  durationSec: number;
  mediaFiles: VastMediaFile[];
  mezzanine?: string | null;
  impressions: string[];
  tracking: Record<string, string[]>;
  errors: string[];
  clickThrough?: string | null;
  /** Wrapper only: where the next VAST document is. */
  wrapperUri?: string | null;
}

export interface VastDoc {
  version: string;
  ads: VastAd[];
  /** VAST-level <Error> (sent when the response is empty). */
  errors: string[];
}

// ---------------------------------------------------------------- macros

export interface TagContext {
  sessionId: string;
  breakId: string;
  breakIndex: number;
  durationSec: number;
  channelId: string;
  contentId?: string | null;
  contentTitle?: string | null;
  series?: string | null;
  genre?: string | null;
  rating?: string | null;
  country?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  deviceType?: string | null;
  appId?: string | null;
  appBundle?: string | null;
  ifa?: string | null;
  limitAdTracking?: boolean;
  gdpr?: string | null;
  usPrivacy?: string | null;
  cacheBuster?: string;
  extra?: Record<string, string>;
}

/**
 * Fill a VAST tag template. Macros are written [UPPER_CASE] (the IAB VAST 4.x
 * style) or {lower_case}; both are accepted so a vendor's documented tag can
 * be pasted as is. Unknown macros are left in place, which is what the IAB
 * spec asks for, so a vendor macro we do not know survives to the vendor.
 */
export function expandTag(template: string, c: TagContext): string {
  const v: Record<string, string> = {
    SESSION_ID: c.sessionId, BREAK_ID: c.breakId, BREAK_INDEX: String(c.breakIndex), POD_INDEX: String(c.breakIndex),
    BREAK_DURATION: String(Math.round(c.durationSec)), POD_DURATION: String(Math.round(c.durationSec)),
    BREAK_DURATION_MS: String(Math.round(c.durationSec * 1000)),
    CHANNEL_ID: c.channelId, CONTENT_ID: c.contentId ?? '', CONTENT_TITLE: c.contentTitle ?? '',
    SERIES: c.series ?? '', GENRE: c.genre ?? '', RATING: c.rating ?? '', COUNTRY: c.country ?? '',
    IP: c.ip ?? '', CLIENTUA: c.userAgent ?? '', USER_AGENT: c.userAgent ?? '', DEVICE_TYPE: c.deviceType ?? '',
    APP_ID: c.appId ?? '', APP_BUNDLE: c.appBundle ?? '', IFA: c.ifa ?? '',
    LIMITADTRACKING: c.limitAdTracking ? '1' : '0', LMT: c.limitAdTracking ? '1' : '0',
    GDPRCONSENT: c.gdpr ?? '', US_PRIVACY: c.usPrivacy ?? '',
    CACHEBUSTING: c.cacheBuster ?? String(Math.floor(Math.random() * 1e9)), CACHEBUSTER: c.cacheBuster ?? '',
    TIMESTAMP: new Date().toISOString(),
    ...Object.fromEntries(Object.entries(c.extra ?? {}).map(([k, x]) => [k.toUpperCase(), x])),
  };
  if (!c.cacheBuster) v.CACHEBUSTER = v.CACHEBUSTING;
  const fill = (name: string, whole: string) => {
    const k = name.toUpperCase();
    return Object.prototype.hasOwnProperty.call(v, k) ? encodeURIComponent(v[k]) : whole;
  };
  return template
    .replace(/\[([A-Z][A-Z0-9_]*)\]/g, (w, n) => fill(n, w))
    .replace(/\{([a-z][a-z0-9_]*)\}/g, (w, n) => fill(n, w));
}

// ---------------------------------------------------------------- parse

const kids = (n: XmlNode | undefined, name: string) => (n ? n.children.filter((c) => c.name === name) : []);
const kid = (n: XmlNode | undefined, name: string) => kids(n, name)[0];
const text = (n: XmlNode | undefined) => (n ? n.text.trim() : '');
const urls = (ns: XmlNode[]) => ns.map(text).filter(Boolean);

/** "00:00:15", "00:00:15.250", "15" -> seconds. */
export function parseDuration(s: string | undefined | null): number {
  const t = (s ?? '').trim();
  if (!t) return 0;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = t.match(/^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(`0.${m[4]}`) : 0);
}

export function parseVast(xml: string): VastDoc {
  let version = '';
  const ads: VastAd[] = [];
  const errors: string[] = [];
  const s = new XmlStream(new Set(['Ad', 'Error']), (n) => {
    if (n.name === 'Error') { const u = text(n); if (u) errors.push(u); return; }
    const inline = kid(n, 'InLine');
    const wrapper = kid(n, 'Wrapper');
    const body = inline ?? wrapper;
    if (!body) return;
    const creative = kids(kid(body, 'Creatives'), 'Creative').find((c) => kid(c, 'Linear')) ?? kids(kid(body, 'Creatives'), 'Creative')[0];
    const linear = kid(creative, 'Linear');
    const tracking: Record<string, string[]> = {};
    for (const t of kids(kid(linear, 'TrackingEvents'), 'Tracking')) {
      const ev = t.attrs.event || 'unknown';
      const u = text(t);
      if (!u) continue;
      // VAST 4 progress events carry an offset; keep them distinct
      const key = ev === 'progress' && t.attrs.offset ? `progress@${t.attrs.offset}` : ev;
      (tracking[key] ??= []).push(u);
    }
    const mfNode = kid(linear, 'MediaFiles');
    const mediaFiles: VastMediaFile[] = kids(mfNode, 'MediaFile').map((m) => ({
      url: text(m), type: m.attrs.type ?? '', delivery: m.attrs.delivery,
      width: m.attrs.width ? Number(m.attrs.width) : undefined, height: m.attrs.height ? Number(m.attrs.height) : undefined,
      bitrateKbps: m.attrs.bitrate ? Number(m.attrs.bitrate) : m.attrs.maxBitrate ? Number(m.attrs.maxBitrate) : undefined,
      codec: m.attrs.codec,
    })).filter((m) => m.url);
    const mezz = text(kid(mfNode, 'Mezzanine')) || null;
    const uai = kid(creative, 'UniversalAdId');
    const uaiVal = text(uai);
    const creativeKey = uaiVal && uaiVal.toLowerCase() !== 'unknown'
      ? `${uai!.attrs.idRegistry ?? 'uai'}:${uaiVal}`
      : creative?.attrs.adId ? `adid:${creative.attrs.adId}` : creative?.attrs.id ? `cr:${creative.attrs.id}` : mediaFiles[0]?.url ? `url:${mediaFiles[0].url}` : `ad:${n.attrs.id ?? ads.length}`;
    ads.push({
      id: n.attrs.id ?? `ad${ads.length + 1}`,
      sequence: n.attrs.sequence ? Number(n.attrs.sequence) : null,
      adSystem: text(kid(body, 'AdSystem')) || undefined,
      title: text(kid(body, 'AdTitle')) || undefined,
      advertiser: text(kid(body, 'Advertiser')) || undefined,
      categories: kids(body, 'Category').map((c) => text(c)).filter(Boolean),
      creativeKey,
      durationSec: parseDuration(text(kid(linear, 'Duration'))),
      mediaFiles, mezzanine: mezz,
      impressions: urls(kids(body, 'Impression')),
      tracking,
      errors: urls(kids(body, 'Error')),
      clickThrough: text(kid(kid(linear, 'VideoClicks'), 'ClickThrough')) || null,
      wrapperUri: wrapper ? text(kid(wrapper, 'VASTAdTagURI')) || null : null,
    });
  }, (attrs) => { version = attrs.version ?? ''; });
  s.write(xml);
  s.end();
  return { version, ads, errors };
}

// ---------------------------------------------------------------- resolve

export type Fetcher = (url: string, timeoutMs: number) => Promise<{ status: number; body: string }>;

export interface ResolveResult {
  ads: VastAd[];
  /** What went wrong, as VAST error codes, for the console and the error pixels. */
  problems: { code: number; message: string; adId?: string; errorUrls: string[] }[];
  elapsedMs: number;
  requests: number;
}

/** VAST error codes we report (IAB VAST 4.2, section 2.3.6). */
export const VAST_ERR = {
  XML_PARSE: 100, WRAPPER_LIMIT: 302, WRAPPER_TIMEOUT: 301, WRAPPER_NO_ADS: 303,
  NO_SUPPORTED_MEDIA: 403, UNDEFINED: 900,
} as const;

/**
 * Fetch a tag and follow its wrappers. Every request shares one budget, so a
 * slow first hop leaves less for the next and the total never exceeds it.
 */
export async function resolve(tagUrl: string, fetcher: Fetcher, opts: { budgetMs?: number; maxDepth?: number; now?: () => number } = {}): Promise<ResolveResult> {
  const now = opts.now ?? Date.now;
  const t0 = now();
  const budget = opts.budgetMs ?? 1500;
  const maxDepth = opts.maxDepth ?? 5;
  const problems: ResolveResult['problems'] = [];
  let requests = 0;
  const left = () => budget - (now() - t0);

  async function load(url: string): Promise<VastDoc | null> {
    if (left() <= 0) return null;
    requests++;
    try {
      const r = await fetcher(url, Math.max(1, left()));
      if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
      if (r.status === 204 || !r.body.trim()) return { version: '', ads: [], errors: [] };
      return parseVast(r.body);
    } catch (e: any) {
      if (left() <= 0 || /abort|timeout/i.test(String(e?.message ?? e))) return null;
      problems.push({ code: VAST_ERR.XML_PARSE, message: `The ad server's response could not be read: ${e?.message ?? e}`, errorUrls: [] });
      return { version: '', ads: [], errors: [] };
    }
  }

  async function follow(ad: VastAd, depth: number, inherited: { impressions: string[]; tracking: Record<string, string[]>; errors: string[] }): Promise<VastAd[]> {
    const merged = {
      impressions: [...inherited.impressions, ...ad.impressions],
      tracking: mergeTracking(inherited.tracking, ad.tracking),
      errors: [...inherited.errors, ...ad.errors],
    };
    if (!ad.wrapperUri) return [{ ...ad, ...merged }];
    if (depth >= maxDepth) { problems.push({ code: VAST_ERR.WRAPPER_LIMIT, message: `More than ${maxDepth} wrappers`, adId: ad.id, errorUrls: merged.errors }); return []; }
    const doc = await load(ad.wrapperUri);
    if (!doc) { problems.push({ code: VAST_ERR.WRAPPER_TIMEOUT, message: 'A wrapper did not answer in time', adId: ad.id, errorUrls: merged.errors }); return []; }
    if (!doc.ads.length) { problems.push({ code: VAST_ERR.WRAPPER_NO_ADS, message: 'A wrapper returned no ads', adId: ad.id, errorUrls: [...merged.errors, ...doc.errors] }); return []; }
    const out: VastAd[] = [];
    for (const inner of doc.ads) {
      // the outer ad's place in the pod wins over the inner document's
      const got = await follow({ ...inner, sequence: ad.sequence ?? inner.sequence }, depth + 1, merged);
      out.push(...got);
    }
    return out;
  }

  const top = await load(tagUrl);
  if (!top) {
    problems.push({ code: VAST_ERR.WRAPPER_TIMEOUT, message: `The ad server did not answer within ${budget} ms`, errorUrls: [] });
    return { ads: [], problems, elapsedMs: now() - t0, requests };
  }
  // pod ads in sequence order, then buffet ads
  const ordered = [...top.ads].sort((a, b) => (a.sequence ?? 1e9) - (b.sequence ?? 1e9));
  const ads: VastAd[] = [];
  for (const a of ordered) ads.push(...(await follow(a, 0, { impressions: [], tracking: {}, errors: [] })));
  if (!top.ads.length && top.errors.length) problems.push({ code: VAST_ERR.WRAPPER_NO_ADS, message: 'No ads', errorUrls: top.errors });
  return { ads, problems, elapsedMs: now() - t0, requests };
}

function mergeTracking(a: Record<string, string[]>, b: Record<string, string[]>) {
  const o: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(a)) o[k] = [...v];
  for (const [k, v] of Object.entries(b)) o[k] = [...(o[k] ?? []), ...v];
  return o;
}

/** An error pixel with its code filled in. */
export function errorUrl(u: string, code: number): string {
  return u.replace(/\[ERRORCODE\]/g, String(code)).replace(/%5BERRORCODE%5D/gi, String(code));
}

/**
 * The media file we condition from: the Mezzanine when there is one (it is
 * there for exactly this), else the largest progressive MP4.
 */
export function bestSource(ad: VastAd): string | null {
  if (ad.mezzanine) return ad.mezzanine;
  const mp4 = ad.mediaFiles.filter((m) => /mp4|quicktime|mov/i.test(m.type) && (m.delivery ?? 'progressive') !== 'streaming');
  const pick = (mp4.length ? mp4 : ad.mediaFiles).sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bitrateKbps ?? 0) - (a.bitrateKbps ?? 0))[0];
  return pick?.url ?? null;
}
