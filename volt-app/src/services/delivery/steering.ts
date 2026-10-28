// ============================================================================
//  CONTENT STEERING (build queue 2.10).
//
//  Several delivery paths (pathways) serve the same files: CloudFront, its
//  Origin Shield path, a second CDN, or on the Mac two addresses of the same
//  origin. The player is given every pathway in one master (HLS
//  `EXT-X-CONTENT-STEERING` with each variant listed once per `PATHWAY-ID`,
//  DASH `ContentSteering` with a `BaseURL` per `serviceLocation`) and asks
//  the steering service which pathway to use, again every TTL seconds. A
//  move happens at the next segment, from the same media sequence on the
//  other path, so the viewer does not see it.
//
//  This keeps delivery standard and cacheable: the media itself never goes
//  through Volt, only one small JSON answer per viewer every few minutes,
//  and a player that knows nothing of steering simply plays the first
//  pathway (the HLS variants carry absolute addresses, the DASH BaseURLs
//  resolve as ordinary BaseURLs).
//
//  WHICH PATHWAY FIRST, per viewer country:
//    1. the configured order: a region's own list (`regions.AU`), else
//       `regions['*']`, else the order the pathways are listed in;
//    2. a pathway an operator drained (DELIVERY_PATHWAYS_DRAIN) goes last;
//    3. a pathway CLEARLY worse for viewers in that country over the last
//       ten minutes goes last too: the players' own reports (the QoE minute
//       aggregates, build queue 1.14d and 1.14e, keyed by the host that
//       served the segments) with enough playing time to mean something,
//       stalling or failing at least twice as much as the best pathway
//       there and above 2 %. "Clearly" is deliberate: a pathway that is only
//       a little worse is left where it is, so viewers are not moved back
//       and forth on noise.
//
//  Off unless DELIVERY_PATHWAYS names at least two pathways.
// ============================================================================

export interface Pathway { id: string; base: string }
export interface SteeringConfig { pathways: Pathway[]; regions: Record<string, string[]>; ttlSec: number; drain: string[] }

const ID_RE = /^[A-Za-z0-9._-]{1,32}$/;

/** DELIVERY_PATHWAYS: `{"pathways":[{"id":"cf","base":"https://..."}, ...],"regions":{"AU":["b","cf"]},"ttlSec":300}` (or just the pathways array). */
export function steeringConfig(env = process.env): SteeringConfig | null {
  const raw = env.DELIVERY_PATHWAYS;
  if (!raw) return null;
  let j: any;
  try { j = JSON.parse(raw); } catch { return null; }
  const list: any[] = Array.isArray(j) ? j : Array.isArray(j?.pathways) ? j.pathways : [];
  const pathways: Pathway[] = [];
  for (const p of list) {
    if (!p || !ID_RE.test(String(p.id)) || !/^https?:\/\/[^/\s]+/.test(String(p.base))) continue;
    if (pathways.some((x) => x.id === p.id)) continue;
    pathways.push({ id: String(p.id), base: String(p.base).replace(/\/+$/, '') });
  }
  if (pathways.length < 2) return null;
  const regions: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(Array.isArray(j) ? {} : j?.regions ?? {})) {
    if ((/^[A-Z]{2}$/.test(k) || k === '*') && Array.isArray(v)) regions[k] = (v as any[]).map(String).filter((id) => pathways.some((p) => p.id === id));
  }
  const ttl = Number(Array.isArray(j) ? NaN : j?.ttlSec);
  const drain = String(env.DELIVERY_PATHWAYS_DRAIN ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return { pathways, regions, ttlSec: Number.isFinite(ttl) && ttl >= 1 ? Math.floor(ttl) : 300, drain };
}

/** The same file on another pathway: the pathway's base in place of the default's host. */
export function pathwayUrl(url: string, p: Pathway): string {
  const path = /^https?:\/\//i.test(url) ? url.replace(/^https?:\/\/[^/]+/i, '') : url;
  return p.base + (path.startsWith('/') ? path : '/' + path);
}

export function hostOf(p: Pathway): string { try { return new URL(p.base).hostname.toLowerCase(); } catch { return ''; } }

// ---- the masters --------------------------------------------------------------------------------

const attr = (line: string, name: string, f: (v: string) => string) =>
  line.replace(new RegExp(`([:,])${name}="([^"]*)"`), (_m, sep, v) => `${sep}${name}="${f(v)}"`);
const GROUP_REFS = ['AUDIO', 'VIDEO', 'SUBTITLES', 'CLOSED-CAPTIONS'];
const escQ = (s: string) => s.replace(/"/g, '%22');

/**
 * An HLS master with every rendition group and variant once per pathway.
 * Group ids get the pathway as a suffix so each pathway's variants name
 * their own renditions; every address is absolute on its own pathway.
 */
export function steerHlsMaster(text: string, masterUrl: string, pathways: Pathway[], serverUri: string): string {
  const lines = text.split(/\r?\n/);
  const head: string[] = [], body: { line: string; uri?: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (l.startsWith('#EXT-X-CONTENT-STEERING')) continue;
    if (l.startsWith('#EXT-X-STREAM-INF')) {
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || lines[j].startsWith('#'))) j++;
      body.push({ line: l, uri: lines[j] });
      i = j;
    } else if (l.startsWith('#EXT-X-MEDIA:') || l.startsWith('#EXT-X-I-FRAME-STREAM-INF')) body.push({ line: l });
    else head.push(l);
  }
  const out = [...head];
  const at = out[0] === '#EXTM3U' ? 1 : 0;
  out.splice(at + (out[at]?.startsWith('#EXT-X-VERSION') ? 1 : 0), 0,
    `#EXT-X-CONTENT-STEERING:SERVER-URI="${escQ(serverUri)}",PATHWAY-ID="${pathways[0].id}"`);
  for (const p of pathways) {
    const base = pathwayUrl(masterUrl, p);
    const abs = (u: string) => escQ(new URL(u, base).toString());
    for (const b of body) {
      let l = b.line;
      if (l.startsWith('#EXT-X-MEDIA:')) {
        l = attr(l, 'GROUP-ID', (g) => `${g}-${p.id}`);
        l = attr(l, 'URI', abs);
        out.push(l);
        continue;
      }
      for (const g of GROUP_REFS) l = attr(l, g, (v) => (g === 'CLOSED-CAPTIONS' && v === 'NONE' ? v : `${v}-${p.id}`));
      l = attr(l, 'URI', abs);
      l = l.replace(/^(#EXT-X-(?:I-FRAME-)?STREAM-INF:)/, `$1PATHWAY-ID="${p.id}",`);
      out.push(l);
      if (b.uri != null) out.push(abs(b.uri.trim()));
    }
  }
  return out.join('\n') + '\n';
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/**
 * A DASH MPD with a BaseURL per pathway and the ContentSteering element.
 * Null when the MPD already sets its own MPD-level BaseURL: rebasing that
 * safely needs the packager's intent, so such an MPD is served as it is.
 */
export function steerMpd(xml: string, mpdUrl: string, pathways: Pathway[], serverUri: string): string | null {
  const open = /<MPD\b[^>]*>/.exec(xml);
  if (!open) return null;
  const firstPeriod = xml.indexOf('<Period', open.index);
  const headPart = xml.slice(open.index, firstPeriod < 0 ? xml.length : firstPeriod);
  if (/<BaseURL\b/.test(headPart) || /<ContentSteering\b/.test(headPart)) return null;
  const dirOf = (u: string) => u.replace(/[^/]*$/, '');
  const ins = '\n  ' + pathways.map((p) => `<BaseURL serviceLocation="${p.id}">${xmlEsc(dirOf(pathwayUrl(mpdUrl, p)))}</BaseURL>`).join('\n  ')
    + `\n  <ContentSteering defaultServiceLocation="${pathways[0].id}" queryBeforeStart="true">${xmlEsc(serverUri)}</ContentSteering>`;
  // inside an MPD, after ProgramInformation if there is one (the schema's order)
  const pi = /<\/ProgramInformation>|<ProgramInformation\b[^>]*\/>/.exec(headPart);
  const cut = pi ? open.index + pi.index + pi[0].length : open.index + open[0].length;
  return xml.slice(0, cut) + ins + xml.slice(cut);
}

// ---- the priority -------------------------------------------------------------------------------

export interface PathwayQuality { playingMs: number; rebufferMs: number; attempts: number; failures: number }

export const QUALITY_WINDOW_MIN = 10;
const MIN_PLAYING_MS = Number(process.env.STEERING_MIN_PLAYING_MS ?? 5 * 60_000);

/** Stalls plus failures, as a share: rebuffer time of watch time, failed attempts of attempts. */
export function badness(q: PathwayQuality): number {
  const watch = q.playingMs + q.rebufferMs;
  return (watch > 0 ? q.rebufferMs / watch : 0) + (q.attempts > 0 ? q.failures / q.attempts : 0);
}

/** The order for a viewer in `cc` (see the top of this file). */
export function pathwayPriority(cfg: SteeringConfig, cc: string, quality: Map<string, PathwayQuality> = new Map()): string[] {
  const all = cfg.pathways.map((p) => p.id);
  const pref = cfg.regions[cc] ?? cfg.regions['*'] ?? [];
  let order = [...pref.filter((id) => all.includes(id)), ...all.filter((id) => !pref.includes(id))];
  const scored = order.filter((id) => (quality.get(id)?.playingMs ?? 0) >= MIN_PLAYING_MS).map((id) => ({ id, b: badness(quality.get(id)!) }));
  const best = scored.length ? Math.min(...scored.map((s) => s.b)) : 0;
  const worse = new Set(scored.filter((s) => s.b >= 0.02 && s.b > 2 * best).map((s) => s.id));
  const last = (set: Set<string>) => { order = [...order.filter((id) => !set.has(id)), ...order.filter((id) => set.has(id))]; };
  last(worse);
  last(new Set(cfg.drain));
  return order;
}

// ---- the quality, from the players' own reports -------------------------------------------------

const qCache = new Map<string, { at: number; q: Map<string, PathwayQuality> }>();

/** Per pathway, for viewers in `cc`, over the last ten minutes (cached 30 s; empty when unreadable). */
export async function pathwayQuality(cfg: SteeringConfig, cc: string): Promise<Map<string, PathwayQuality>> {
  const key = cc + '|' + cfg.pathways.map((p) => p.id + '=' + p.base).join(',');
  const c = qCache.get(key);
  if (c && Date.now() - c.at < 30_000) return c.q;
  const q = new Map<string, PathwayQuality>();
  try {
    const { aquery } = await import('../qoe/analyticsDb');
    const hosts = cfg.pathways.map(hostOf);
    const rows = await aquery<any>(
      `SELECT cdn, SUM(playing_ms)::float8 AS p, SUM(rebuffer_ms)::float8 AS r, SUM(attempts)::float8 AS a, SUM(failures)::float8 AS f
         FROM qoe_minutes WHERE minute >= now() - ($1 || ' minutes')::interval AND country = $2 AND cdn = ANY($3) GROUP BY cdn`,
      [String(QUALITY_WINDOW_MIN), cc, hosts]);
    for (const r of rows) {
      // two pathways on one host cannot be told apart by the reports: neither is judged
      const ids = cfg.pathways.filter((p) => hostOf(p) === r.cdn);
      if (ids.length === 1) q.set(ids[0].id, { playingMs: r.p ?? 0, rebufferMs: r.r ?? 0, attempts: r.a ?? 0, failures: r.f ?? 0 });
    }
  } catch { /* no analytics: the configured order */ }
  qCache.set(key, { at: Date.now(), q });
  return q;
}
export function clearQualityCache(): void { qCache.clear(); }

/** The steering manifest (version 1) a player asks for every TTL seconds. */
export async function steeringManifest(cfg: SteeringConfig, cc: string, reloadUri?: string):
  Promise<{ VERSION: 1; TTL: number; 'RELOAD-URI'?: string; 'PATHWAY-PRIORITY': string[] }> {
  // RELOAD-URI without the player's own _HLS_/_DASH_ parameters: a player
  // that reuses the address it was answered on would otherwise add them again
  // every time (Shaka does)
  return { VERSION: 1, TTL: cfg.ttlSec, ...(reloadUri ? { 'RELOAD-URI': reloadUri } : {}), 'PATHWAY-PRIORITY': pathwayPriority(cfg, cc, await pathwayQuality(cfg, cc)) };
}
