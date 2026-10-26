// ============================================================================
//  ON-DEMAND ADS (VOD SSAI and SGAI): sessions, decisions, playlists, beacons,
//  clicks. SSAI.md sections 5 to 7; the pure parts are plan.ts and hls.ts.
//
//  THE FLOW
//   1. The play gate (modules/apps.ts) asks `adsForPlay`: is there a rule for
//      this asset, is the viewer ad-free (paid, or a member, as the rule says),
//      and how should the ads arrive. Stitched: a session is opened and every
//      break is decided at once, in parallel, each within its ad server's time
//      budget; the gate answers straight away with the session's playlist.
//      Guided: the gate hands out the asset's shared interstitial playlist,
//      and a break is decided when the player asks for it (its asset list).
//   2. Decisions reuse FAST's decision engine as is: the VAST client with its
//      wrappers and one budget (fast/vast.ts), the pod fill with house ads
//      (fast/pod.ts), the conditioning cache, so an ad plays on the account's
//      own ladder (ad.condition). An on-demand pod needs no slate: nothing
//      waits on a clock, so a pod is as long as its ads.
//   3. The session's playlists: content from the CDN; ad segments through
//      /vod-ads/s/<session>/seg/..., a redirect to the CDN that tells the
//      server how far into each ad the viewer got. That is where impression,
//      start, quartiles and complete are sent from (server-side reporting),
//      for any player, ours or not.
//   4. What only the player can know (a click, pause, mute) it reports to the
//      session's click and events routes; the server sends the ad's pixels.
//
//  THE SESSION ID IS THE CAPABILITY for its playlists, segments, timeline,
//  events and click: random, unguessable, scoped to one asset.
// ============================================================================
import { randomBytes, createHash } from 'node:crypto';
import { query, one } from '../../db';
import { expandTag, resolve as resolveVast, bestSource, type Fetcher, type VastAd } from '../fast/vast';
import { fillBreak, type HouseAd, type PodItem } from '../fast/pod';
import { readKey, fastConfig } from '../fast/media';
import { defaultFetcher } from '../fast/store';
import { fetchTracker } from '../fast/beaconSender';
import { fillBeaconUrl, progressOffsetSec } from '../fast/beacons';
import { resolveVodAdPolicy, planVodBreaks, titleRule, stitchedStarts, type VodAdPolicy, type Position, type Delivery } from './plan';
import {
  masterEntries, rewriteMaster, parseMedia, stitchMedia, guidedMedia, boundariesOf, durationOf, matchEntry,
  type MasterEntry, type Media, type Segment,
} from './hls';
import { parseMpd, stitchMpd, contentEdges, sidecarText, cutVtt, type Mpd, type DashAd, type DashAdTrack } from './dash';

// ---------------------------------------------------------------- rules

export interface VodAdRuleRow {
  id: string; account_id: string; schema_id: string | null; mode: 'off' | 'on'; policy: any;
  ad_server_id: string | null; house_ads: { assetId: string; weight?: number }[]; updated_at: string;
}

/** The rule an asset plays under: its content type's, else the account default. Null when ads are off. */
export async function ruleForAsset(accountId: string, schemaId: string | null): Promise<(VodAdRuleRow & { resolved: VodAdPolicy }) | null> {
  const r = await one<VodAdRuleRow>(
    `SELECT * FROM vod_ad_rules WHERE account_id = $1 AND (schema_id = $2 OR schema_id IS NULL)
      ORDER BY (schema_id IS NULL) LIMIT 1`, [accountId, schemaId]);
  if (!r || r.mode !== 'on') return null;
  return { ...r, resolved: resolveVodAdPolicy(r.policy) };
}

async function houseAds(refs: { assetId: string; weight?: number }[]): Promise<HouseAd[]> {
  if (!refs?.length) return [];
  const rows = await query<any>(`SELECT id, title, duration_ms, metadata FROM vod_assets WHERE id = ANY($1::uuid[]) AND master_key IS NOT NULL`, [refs.map((x) => x.assetId)]);
  const out: HouseAd[] = [];
  for (const ref of refs) {
    const a = rows.find((x) => String(x.id) === ref.assetId);
    if (a) out.push({ assetId: ref.assetId, title: String(a.metadata?.title || a.title || 'House ad'), durationSec: Number(a.duration_ms) / 1000, weight: ref.weight });
  }
  return out;
}

// ---------------------------------------------------------------- the asset's playlists

/** A key as a URL: local keys are served at /clips, the bucket's through the CDN. */
export function keyUrl(key: string): string {
  if (key.startsWith('/clips/')) return key;
  const cdn = fastConfig.cdn ?? '';
  return `${cdn}/${key.replace(/^\//, '')}`;
}
/** Back from a URL to the key it was read from. */
function urlKey(url: string): string {
  if (url.startsWith('/clips/')) return url.split('?')[0];
  const cdn = fastConfig.cdn;
  const path = cdn && url.startsWith(cdn) ? url.slice(cdn.length) : url.replace(/^https?:\/\/[^/]+/, '');
  return path.split('?')[0].replace(/^\//, '');
}

interface AssetHls { masterText: string; masterUrl: string; entries: MasterEntry[]; media: Map<string, Media>; at: number }
const hlsCache = new Map<string, AssetHls>();

/** An asset's master and media playlists, read once and kept ten minutes. */
export async function assetHls(masterKey: string): Promise<AssetHls> {
  const hit = hlsCache.get(masterKey);
  if (hit && Date.now() - hit.at < 600_000) return hit;
  const masterUrl = keyUrl(masterKey);
  const masterText = await readKey(masterKey);
  const entries = masterEntries(masterText, masterUrl);
  const media = new Map<string, Media>();
  await Promise.all(entries.map(async (e) => {
    const m = parseMedia(await readKey(urlKey(e.url)), e.url);
    if (m) media.set(e.track, m);
  }));
  const v: AssetHls = { masterText, masterUrl, entries, media, at: Date.now() };
  hlsCache.set(masterKey, v);
  if (hlsCache.size > 500) hlsCache.delete(hlsCache.keys().next().value!);
  return v;
}

const firstVideo = (h: AssetHls) => h.entries.find((e) => e.kind === 'video' && h.media.has(e.track)) ?? h.entries.find((e) => h.media.has(e.track));

// ---------------------------------------------------------------- assets

interface AssetRow { id: string; account_id: string; title: string | null; master_key: string | null; duration_ms: number | null; metadata: any; break_cues_ms: number[] | null; schema_id: string | null; formats?: { hls?: boolean; dash?: boolean } | null }

export async function assetFor(assetId: string, accountId?: string): Promise<AssetRow | null> {
  return one<AssetRow>(
    `SELECT v.id, COALESCE(g.account_id, v.account_id) AS account_id, v.title, v.master_key, v.duration_ms, v.metadata, v.break_cues_ms, v.schema_id, v.formats
       FROM vod_assets v LEFT JOIN channels c ON c.id = v.channel_id LEFT JOIN events e ON e.id = v.event_id
       LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE v.id = $1 ${accountId ? 'AND COALESCE(g.account_id, v.account_id) = $2' : ''}`, accountId ? [assetId, accountId] : [assetId]);
}

/** The breaks a title gets under a rule: on its segment boundaries, with its cue points. */
export async function breaksFor(asset: AssetRow, policy: VodAdPolicy) {
  const h = await assetHls(asset.master_key!);
  const v = firstVideo(h);
  const media = v ? h.media.get(v.track)! : null;
  const contentSec = media ? durationOf(media) : Number(asset.duration_ms ?? 0) / 1000;
  return {
    contentSec,
    breaks: planVodBreaks(contentSec, policy, {
      cuesSec: (asset.break_cues_ms ?? []).map((ms) => ms / 1000),
      boundaries: media ? boundariesOf(media) : undefined,
      titleRule: titleRule(asset.metadata),
    }),
  };
}

// ---------------------------------------------------------------- sessions

export interface PodEntry {
  kind: 'ad' | 'house';
  adId: string | null;
  creativeKey: string | null;
  assetId: string;
  masterKey: string;
  title: string | null;
  durationSec: number;
  impressions: string[];
  tracking: Record<string, string[]>;
  clickThrough: string | null;
  clickTracking: string[];
}
export interface SessionBreak {
  index: number; position: Position; atSec: number; plannedSec: number;
  /** null until decided; [] = decided, nothing to play (the break is dropped). */
  pod: PodEntry[] | null;
}
export interface SessionPlan { contentSec: number; snapback: boolean; prerollOnResume: boolean; breaks: SessionBreak[] }
export interface SessionCtx { ip?: string | null; userAgent?: string | null; country?: string | null; appId?: string | null; ifa?: string | null; lmt?: boolean; gdpr?: string | null; usPrivacy?: string | null }

export const newSessionId = () => `va${randomBytes(18).toString('base64url')}`;
const SID_RE = /^va[A-Za-z0-9_-]{20,40}$/;
export const validSid = (s: string) => SID_RE.test(s);

/** Decisions in flight in this process, so a playlist request here can wait on them. */
const inflight = new Map<string, Promise<void>>();

export interface OpenInput {
  accountId: string; assetId: string; delivery: 'stitched' | 'guided'; playSid?: string | null; ctx: SessionCtx;
  rule: VodAdRuleRow & { resolved: VodAdPolicy }; fetcher?: Fetcher;
  /** guided sessions are opened per break as the player reaches it; stitched decide everything now. */
  decide?: 'all' | 'none';
  id?: string;
}

/** Open a session: plan its breaks, and (stitched) start deciding every one of them. */
export async function openSession(i: OpenInput): Promise<{ id: string; plan: SessionPlan }> {
  const asset = await assetFor(i.assetId, i.accountId);
  if (!asset?.master_key) throw new Error('asset has no playlist');
  const { contentSec, breaks } = await breaksFor(asset, i.rule.resolved);
  const plan: SessionPlan = {
    contentSec, snapback: i.rule.resolved.snapback, prerollOnResume: i.rule.resolved.prerollOnResume,
    breaks: breaks.map((b) => ({ index: b.index, position: b.position, atSec: b.atSec, plannedSec: b.durationSec, pod: null })),
  };
  const id = i.id ?? newSessionId();
  await query(
    `INSERT INTO vod_ad_sessions (id, account_id, vod_asset_id, app_id, play_sid, delivery, state, plan, ctx)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) ON CONFLICT (id) DO NOTHING`,
    [id, i.accountId, i.assetId, i.ctx.appId ?? null, i.playSid ?? null, i.delivery, breaks.length && i.decide !== 'none' ? 'deciding' : 'ready', JSON.stringify(plan), JSON.stringify(i.ctx)]);
  if (breaks.length && (i.decide ?? 'all') === 'all') {
    const p = (async () => {
      await Promise.all(plan.breaks.map(async (b) => { b.pod = await decideVodBreak({ sessionId: id, asset, brk: b, rule: i.rule, ctx: i.ctx, fetcher: i.fetcher }).catch(() => []); }));
      await query(`UPDATE vod_ad_sessions SET plan = $2::jsonb, state = 'ready' WHERE id = $1`, [id, JSON.stringify(plan)]);
    })();
    inflight.set(id, p);
    p.finally(() => inflight.delete(id));
  }
  return { id, plan };
}

export async function sessionRow(id: string): Promise<any | null> {
  if (!validSid(id)) return null;
  return one<any>(`SELECT * FROM vod_ad_sessions WHERE id = $1`, [id]);
}

/**
 * A session once its decisions are in, or after `maxMs` with whatever is
 * decided (an undecided break is then played without ads: the playlist never
 * waits longer than the ad servers' budget).
 */
export async function readySession(id: string, maxMs = 4000): Promise<any | null> {
  const p = inflight.get(id);
  if (p) await Promise.race([p, new Promise((r) => setTimeout(r, maxMs))]);
  const t0 = Date.now();
  let row = await sessionRow(id);
  while (row && row.state === 'deciding' && Date.now() - t0 < maxMs) {
    await new Promise((r) => setTimeout(r, 100));
    row = await sessionRow(id);
  }
  if (row) query(`UPDATE vod_ad_sessions SET last_seen_at = now() WHERE id = $1`, [id]).catch(() => null);
  return row;
}

// ---------------------------------------------------------------- deciding one break

interface DecideInput { sessionId: string; asset: AssetRow; brk: SessionBreak; rule: VodAdRuleRow & { resolved: VodAdPolicy }; ctx: SessionCtx; fetcher?: Fetcher }

/** Ask the ad server for one break (within its budget), fill it, record it. Never throws for an ad server fault. */
export async function decideVodBreak(i: DecideInput): Promise<PodEntry[]> {
  const pol = i.rule.resolved;
  const breakSec = i.brk.plannedSec;
  let serverProblem: 'timeout' | 'error' | null = null;
  let vastAds: VastAd[] = [];
  let problems: { code: number; message: string }[] = [];
  let elapsedMs = 0;
  const server = i.rule.ad_server_id ? await one<any>(`SELECT * FROM ad_servers WHERE id = $1 AND account_id = $2 AND enabled`, [i.rule.ad_server_id, i.asset.account_id]) : null;
  if (server) {
    const md = i.asset.metadata ?? {};
    const tag = expandTag(server.tag_template, {
      sessionId: i.sessionId, breakId: `${i.sessionId}-${i.brk.index}`, breakIndex: i.brk.index, durationSec: breakSec,
      channelId: i.asset.id, contentId: i.asset.id, contentTitle: i.asset.title ?? md.title ?? null, series: md.series ?? null,
      genre: md.genre ?? null, rating: md.rating ?? md.contentRating ?? null, country: i.ctx.country ?? null, ip: i.ctx.ip ?? null,
      userAgent: i.ctx.userAgent ?? null, appId: i.ctx.appId ?? null, ifa: i.ctx.ifa ?? null, limitAdTracking: !!i.ctx.lmt,
      gdpr: i.ctx.gdpr ?? null, usPrivacy: i.ctx.usPrivacy ?? null,
      extra: {
        POD_MAX_ADS: String(pol.podMaxAds || ''), MAX_AD_DURATION: String(pol.maxAdSec || ''),
        // IAB placement: preroll, midroll, postroll
        BREAK_POSITION: i.brk.position === 'pre' ? 'preroll' : i.brk.position === 'post' ? 'postroll' : 'midroll',
        CONTENT_DURATION: String(Math.round(i.asset.duration_ms ? i.asset.duration_ms / 1000 : 0)), CONTENT_POSITION: String(Math.round(i.brk.atSec)),
      },
    });
    const r = await resolveVast(tag, i.fetcher ?? defaultFetcher, { budgetMs: server.timeout_ms, maxDepth: server.max_wrappers });
    vastAds = r.ads; problems = r.problems.map((p) => ({ code: p.code, message: p.message })); elapsedMs = r.elapsedMs;
    if (!r.ads.length && r.problems.some((p) => p.code === 301)) serverProblem = 'timeout';
    else if (!r.ads.length && r.problems.length) serverProblem = 'error';
  }
  const keys = vastAds.map((a) => a.creativeKey);
  const cache = keys.length ? await query<any>(
    `SELECT c.creative_key, c.vod_asset_id, v.duration_ms, v.master_key FROM ad_creatives c LEFT JOIN vod_assets v ON v.id = c.vod_asset_id
      WHERE c.account_id = $1 AND c.creative_key = ANY($2::text[])`, [i.asset.account_id, keys]) : [];
  const ready = new Map(cache.filter((c) => c.master_key && c.duration_ms).map((c) => [c.creative_key, { assetId: String(c.vod_asset_id), durationSec: Number(c.duration_ms) / 1000 }]));
  const house = await houseAds(i.rule.house_ads);
  const plan = fillBreak({
    breakSec, segmentSec: 2, ads: vastAds,
    conditioned: (k) => ready.get(k) ?? null, house, breakIndex: i.brk.index, serverProblem,
    maxAds: pol.podMaxAds || undefined, maxAdSec: pol.maxAdSec || undefined,
    separate: (ad) => (ad.advertiser ? `adv:${ad.advertiser.toLowerCase()}` : ad.categories?.length ? `cat:${ad.categories[0].toLowerCase()}` : null),
  });
  for (const a of vastAds) {
    await query(
      `INSERT INTO ad_creatives (account_id, creative_key, source_url, ad_system, title, duration_ms) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (account_id, creative_key) DO UPDATE SET last_seen_at = now()`,
      [i.asset.account_id, a.creativeKey, bestSource(a), a.adSystem ?? null, a.title ?? null, Math.round(a.durationSec * 1000)]).catch(() => null);
  }
  if (plan.toCondition.length) {
    const { enqueue } = await import('../jobs/queue');
    for (const c of plan.toCondition) {
      await enqueue({ type: 'ad.condition', payload: { accountId: i.asset.account_id, creativeKey: c.creativeKey }, dedupeKey: `adcond:${i.asset.account_id}:${c.creativeKey}` }).catch(() => null);
    }
  }
  // No slate: nothing waits on a clock in an on-demand title, so a pod is as long as its ads and house spots.
  const items = plan.items.filter((x): x is Exclude<PodItem, { kind: 'slate' }> => x.kind !== 'slate');
  const masters = items.length ? await query<any>(`SELECT id, master_key FROM vod_assets WHERE id = ANY($1::uuid[])`, [items.map((x) => x.assetId)]) : [];
  const pod: PodEntry[] = [];
  for (const it of items) {
    const mk = masters.find((m) => String(m.id) === it.assetId)?.master_key;
    if (!mk) continue;
    if (it.kind === 'ad') {
      await query(`UPDATE ad_creatives SET plays = plays + 1 WHERE account_id = $1 AND creative_key = $2`, [i.asset.account_id, it.creativeKey]).catch(() => null);
      pod.push({ kind: 'ad', adId: it.adId, creativeKey: it.creativeKey, assetId: it.assetId, masterKey: mk, title: it.title ?? null, durationSec: it.durationSec,
        impressions: it.impressions, tracking: it.tracking, clickThrough: it.clickThrough ?? null, clickTracking: it.clickTracking ?? [] });
    } else {
      pod.push({ kind: 'house', adId: null, creativeKey: null, assetId: it.assetId, masterKey: mk, title: it.title, durationSec: it.durationSec,
        impressions: [], tracking: {}, clickThrough: null, clickTracking: [] });
    }
  }
  const adMs = Math.round(pod.filter((p) => p.kind === 'ad').reduce((n, p) => n + p.durationSec, 0) * 1000);
  const houseMs = Math.round(pod.filter((p) => p.kind === 'house').reduce((n, p) => n + p.durationSec, 0) * 1000);
  await query(
    `INSERT INTO vod_ad_breaks (session_id, account_id, vod_asset_id, break_index, position, content_ms, break_ms, ad_ms, house_ms, ad_server_id, elapsed_ms, fallback, problems)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) ON CONFLICT (session_id, break_index) DO NOTHING`,
    [i.sessionId, i.asset.account_id, i.asset.id, i.brk.index, i.brk.position, Math.round(i.brk.atSec * 1000), Math.round(breakSec * 1000), adMs, houseMs,
     server?.id ?? null, Math.round(elapsedMs), pod.length ? plan.fallback : (plan.fallback ?? 'no-ads'), JSON.stringify(problems)]).catch(() => null);
  return pod;
}

// ---------------------------------------------------------------- stitched playlists

export const sessionBase = (sid: string) => `/vod-ads/s/${sid}`;
export const BLANK_VTT = '/vod-ads/blank.vtt';

/** The breaks that will actually play (decided, with something in them). */
export const playedBreaks = (plan: SessionPlan) => plan.breaks.filter((b) => b.pod && b.pod.length);

export async function sessionMaster(row: any): Promise<string> {
  const asset = await assetFor(row.vod_asset_id);
  const h = await assetHls(asset!.master_key!);
  return rewriteMaster(h.masterText, h.masterUrl, (e) => `${sessionBase(row.id)}/${e.track}.m3u8`);
}

/** One ad's segments for a content track, each through the session's segment route. */
async function adSegments(sid: string, b: SessionBreak, p: number, want: MasterEntry): Promise<Segment[]> {
  const entry = b.pod![p];
  const ah = await assetHls(entry.masterKey);
  const m = matchEntry(ah.entries, want);
  const media = m ? ah.media.get(m.track) : null;
  if (!media) return [];
  return media.segments.map((s, n) => ({ ...s, url: `${sessionBase(sid)}/seg/${b.index}/${p}/${m!.track}/${n}` }));
}

export async function sessionMedia(row: any, track: string): Promise<string | null> {
  const asset = await assetFor(row.vod_asset_id);
  const h = await assetHls(asset!.master_key!);
  const entry = h.entries.find((e) => e.track === track);
  const content = entry ? h.media.get(track) : null;
  if (!entry || !content) return null;
  const plan = row.plan as SessionPlan;
  const breaks = [];
  for (const b of playedBreaks(plan)) {
    const podSec = b.pod!.reduce((n, x) => n + x.durationSec, 0);
    let segs: Segment[] = [];
    if (entry.kind === 'subtitles') segs = [{ dur: podSec, url: BLANK_VTT, init: '', tags: [] }];
    else for (let p = 0; p < b.pod!.length; p++) segs.push(...await adSegments(row.id, b, p, entry));
    breaks.push({ index: b.index, atSec: b.atSec, segments: segs });
  }
  return stitchMedia(content, breaks);
}

// ---------------------------------------------------------------- stitched DASH

/** Where an asset's MPD is: beside master.m3u8 when it was encoded with DASH (shareLinks.manifestUrls). */
export function mpdKeyOf(asset: AssetRow): string | null {
  if (!asset.master_key || !asset.formats?.dash || !/\/master\.m3u8$/i.test(asset.master_key)) return null;
  return asset.master_key.replace(/master\.m3u8$/i, 'manifest.mpd');
}

const mpdCache = new Map<string, { mpd: Mpd | null; at: number }>();
/** The asset's MPD when it can be stitched (dash.ts parseMpd), read once and kept ten minutes. */
export async function assetMpd(asset: AssetRow): Promise<Mpd | null> {
  const key = mpdKeyOf(asset);
  if (!key) return null;
  const hit = mpdCache.get(key);
  if (hit && Date.now() - hit.at < 600_000) return hit.mpd;
  const mpd = parseMpd(await readKey(key).catch(() => ''));
  mpdCache.set(key, { mpd, at: Date.now() });
  if (mpdCache.size > 500) mpdCache.delete(mpdCache.keys().next().value!);
  return mpd;
}

/**
 * One ad as a DASH Period's renditions: its fMP4 video and audio, each
 * segment through the session's segment route (the beacons). Null when the ad
 * has a rendition with no init segment (TS): it cannot be a DASH Period.
 */
async function dashAd(sid: string, b: SessionBreak, p: number): Promise<DashAd | null> {
  const entry = b.pod![p];
  const ah = await assetHls(entry.masterKey);
  const tracks: DashAdTrack[] = [];
  for (const e of ah.entries) {
    if (e.kind === 'subtitles') continue;
    const m = ah.media.get(e.track);
    if (!m?.segments.length) continue;
    if (!m.segments[0].init) return null;
    tracks.push({ kind: e.kind, id: `ad${b.index}-${p}-${e.track}`, init: m.segments[0].init,
      codecs: e.codecs ?? (e.kind === 'audio' ? 'mp4a.40.2' : 'avc1.64001f'), bandwidth: e.bandwidth ?? 0, width: e.width, height: e.height || undefined,
      segments: m.segments.map((s, n) => ({ dur: s.dur, url: `${sessionBase(sid)}/seg/${b.index}/${p}/${e.track}/${n}` })) });
  }
  return tracks.length ? { id: `ad-${b.index}-${p}`, tracks } : null;
}

/** The session's stitched MPD, or null when the asset or one of its ads cannot be DASH. */
export async function sessionMpd(row: any): Promise<string | null> {
  const asset = await assetFor(row.vod_asset_id);
  if (!asset) return null;
  const mpd = await assetMpd(asset);
  if (!mpd) return null;
  const breaks = [];
  for (const b of playedBreaks(row.plan as SessionPlan)) {
    const ads: DashAd[] = [];
    for (let p = 0; p < b.pod!.length; p++) {
      const a = await dashAd(row.id, b, p);
      if (!a) return null;
      ads.push(a);
    }
    breaks.push({ index: b.index, atSec: b.atSec, ads });
  }
  return stitchMpd(mpd, keyUrl(mpdKeyOf(asset)!), breaks, BLANK_VTT, (k, rep) => `${sessionBase(row.id)}/text/${k}/${encodeURIComponent(rep)}.vtt`);
}

/** A content Period's part of the asset's sidecar WebVTT, on that Period's clock (dash.ts cutVtt). */
export async function sessionText(row: any, k: number, repId: string): Promise<string | null> {
  const asset = await assetFor(row.vod_asset_id);
  if (!asset) return null;
  const mpd = await assetMpd(asset);
  if (!mpd) return null;
  const url = sidecarText(mpd, keyUrl(mpdKeyOf(asset)!), repId);
  if (!url) return null;
  const edges = contentEdges(mpd, playedBreaks(row.plan as SessionPlan).map((b) => b.atSec));
  if (k < 0 || k >= edges.length - 1) return null;
  const text = await readKey(urlKey(url)).catch(() => null);
  return text == null ? null : cutVtt(text, edges[k], edges[k + 1]);
}

// ---------------------------------------------------------------- guided playlists

/** The guided playlists' version: changes when the rule or the asset's cues change, so a CDN copy is never stale. */
export async function guidedVersion(asset: AssetRow, rule: VodAdRuleRow): Promise<string> {
  return createHash('sha256').update(`${rule.id}|${new Date(rule.updated_at).getTime()}|${(asset.break_cues_ms ?? []).join(',')}|${titleRule(asset.metadata)}`).digest('base64url').slice(0, 10);
}
export const guidedBase = (assetId: string, ver: string) => `/vod-ads/g/${assetId}/${ver}`;

export async function guidedMaster(asset: AssetRow, ver: string): Promise<string> {
  const h = await assetHls(asset.master_key!);
  return rewriteMaster(h.masterText, h.masterUrl, (e) => `${guidedBase(asset.id, ver)}/${e.track}.m3u8`);
}

export async function guidedPlaylist(asset: AssetRow, rule: VodAdRuleRow & { resolved: VodAdPolicy }, ver: string, track: string): Promise<string | null> {
  const h = await assetHls(asset.master_key!);
  const content = h.media.get(track);
  if (!content) return null;
  const { breaks } = await breaksFor(asset, rule.resolved);
  return guidedMedia(content, breaks.map((b) => ({ index: b.index, atSec: b.atSec, durationSec: b.durationSec, position: b.position })),
    (b) => `${guidedBase(asset.id, ver)}/list/${b.index}.json`);
}

/**
 * The asset list for one break (HLS Interstitials): decided now, for the
 * player's session. The player names its playback with _HLS_primary_id (our
 * SDK also sends its sid); one Volt session per playback of the asset.
 */
export async function guidedAssetList(asset: AssetRow, rule: VodAdRuleRow & { resolved: VodAdPolicy }, breakIndex: number, primaryId: string, ctx: SessionCtx, fetcher?: Fetcher) {
  const sid = `va${createHash('sha256').update(`${asset.id}|${primaryId}`).digest('base64url').slice(0, 30)}`;
  let row = await sessionRow(sid);
  if (!row) {
    await openSession({ accountId: asset.account_id, assetId: asset.id, delivery: 'guided', playSid: primaryId, ctx, rule, decide: 'none', id: sid });
    row = await sessionRow(sid);
  }
  const plan = row.plan as SessionPlan;
  const b = plan.breaks.find((x) => x.index === breakIndex);
  if (!b) return { ASSETS: [] as { URI: string; DURATION: number }[], sessionId: sid };
  if (b.pod == null) {
    b.pod = await decideVodBreak({ sessionId: sid, asset, brk: b, rule, ctx, fetcher }).catch(() => []);
    // another break of the same session may have been decided meanwhile: merge, do not overwrite
    await query(`UPDATE vod_ad_sessions SET plan = jsonb_set(plan, ARRAY['breaks', $2::text, 'pod'], $3::jsonb), last_seen_at = now() WHERE id = $1`,
      [sid, String(plan.breaks.indexOf(b)), JSON.stringify(b.pod)]);
  }
  return {
    sessionId: sid,
    ASSETS: b.pod.map((x, p) => ({ URI: `${sessionBase(sid)}/ad/${b.index}/${p}/master.m3u8`, DURATION: Math.round(x.durationSec * 1000) / 1000 })),
  };
}

/** A guided session's ad as its own small HLS stream, its segments through the segment route. */
export async function adMaster(row: any, b: number, p: number): Promise<string | null> {
  const e = podEntry(row, b, p);
  if (!e) return null;
  const ah = await assetHls(e.masterKey);
  return rewriteMaster(ah.masterText, ah.masterUrl, (x) => `${sessionBase(row.id)}/ad/${b}/${p}/${x.track}.m3u8`);
}
export async function adMedia(row: any, b: number, p: number, track: string): Promise<string | null> {
  const e = podEntry(row, b, p);
  if (!e) return null;
  const ah = await assetHls(e.masterKey);
  const media = ah.media.get(track);
  if (!media) return null;
  return stitchMedia({ ...media, segments: media.segments.map((s, n) => ({ ...s, url: `${sessionBase(row.id)}/seg/${b}/${p}/${track}/${n}` })) }, []);
}

const podEntry = (row: any, b: number, p: number): PodEntry | null =>
  (row.plan as SessionPlan).breaks.find((x) => x.index === b)?.pod?.[p] ?? null;

// ---------------------------------------------------------------- segments, beacons

const SERVER_FRACTIONS: [string, number][] = [['impression', 0], ['creativeView', 0], ['start', 0], ['firstQuartile', 0.25], ['midpoint', 0.5], ['thirdQuartile', 0.75], ['complete', 1]];

/**
 * The events a request for segment `n` of an ad makes due: every event whose
 * moment is at or before the START of that segment (asking for a segment
 * means the one before it is playing out), and complete with the last one.
 * A player fetches a little ahead of what it shows, so an event can go a
 * segment early; a viewer who leaves stops fetching, and what is after that
 * point is never sent, which is what quartiles are for.
 */
export function eventsDueAt(entry: PodEntry, segStartSec: number, isLast: boolean): { event: string; offsetSec: number; urls: string[] }[] {
  const out: { event: string; offsetSec: number; urls: string[] }[] = [];
  const d = entry.durationSec;
  for (const [ev, f] of SERVER_FRACTIONS) {
    const off = f * d;
    if (ev === 'complete' ? !isLast : off > segStartSec + 1e-6) continue;
    const urls = ev === 'impression' ? entry.impressions : entry.tracking?.[ev] ?? [];
    out.push({ event: ev, offsetSec: off, urls });
  }
  for (const [k, urls] of Object.entries(entry.tracking ?? {})) {
    if (!k.startsWith('progress@')) continue;
    const off = progressOffsetSec(k.slice(9), d);
    if (off != null && off <= segStartSec + 1e-6) out.push({ event: k, offsetSec: off, urls });
  }
  return out;
}

/** Where segment `n` of an ad really is, and the beacons it makes due (sent after the answer). */
export async function segmentRedirect(row: any, b: number, p: number, track: string, n: number): Promise<string | null> {
  const e = podEntry(row, b, p);
  if (!e) return null;
  const ah = await assetHls(e.masterKey);
  const entry = ah.entries.find((x) => x.track === track);
  const media = ah.media.get(track);
  const seg = media?.segments[n];
  if (!entry || !media || !seg) return null;
  // Only the picture drives the beacons (audio and subtitle segments come along with it).
  if (e.kind === 'ad' && entry.kind === 'video') {
    const start = media.segments.slice(0, n).reduce((t, s) => t + s.dur, 0);
    const due = eventsDueAt(e, start, n === media.segments.length - 1);
    void sendSessionEvents(row, b, p, e, due).catch(() => null);
  }
  return seg.url;
}

const chains = new Map<string, Promise<void>>();

/** Claim and send events in order, per session (one chain), each URL once. */
export function sendSessionEvents(row: any, b: number, p: number, e: PodEntry, due: { event: string; offsetSec: number; urls: string[] }[]): Promise<void> {
  if (!due.length) return Promise.resolve();
  const ctx = (row.ctx ?? {}) as SessionCtx;
  const prev = chains.get(row.id) ?? Promise.resolve();
  const next = prev.then(async () => {
    for (const ev of due) {
      const urls = ev.urls.length ? ev.urls : [null];
      await Promise.all(urls.map(async (raw, urlIndex) => {
        const url = raw ? fillBeaconUrl(raw, { nowMs: Date.now(), adPlayheadSec: ev.offsetSec, breakPosition: positionCode(row, b) }) : null;
        const claimed = await one<{ id: string }>(
          `INSERT INTO vod_ad_events (session_id, account_id, vod_asset_id, break_index, pod_index, ad_id, creative_key, event, url_index, url)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (session_id, break_index, pod_index, event, url_index) DO NOTHING RETURNING id`,
          [row.id, row.account_id, row.vod_asset_id, b, p, e.adId, e.creativeKey, ev.event, raw ? urlIndex : -1, url]).catch(() => null);
        if (!claimed || !url) return;
        const t0 = Date.now();
        const r = await fetchTracker(url, { ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null });
        await query(`UPDATE vod_ad_events SET status = $2, ok = $3, error = $4, elapsed_ms = $5, sent_at = now() WHERE id = $1`,
          [claimed.id, r.status, r.error == null, r.error, Date.now() - t0]).catch(() => null);
      }));
    }
  });
  chains.set(row.id, next);
  next.finally(() => { if (chains.get(row.id) === next) chains.delete(row.id); });
  return next;
}

/** [BREAKPOSITION]: 1 pre-roll, 2 mid-roll, 3 post-roll (IAB). */
function positionCode(row: any, b: number): number {
  const pos = (row.plan as SessionPlan).breaks.find((x) => x.index === b)?.position;
  return pos === 'pre' ? 1 : pos === 'post' ? 3 : 2;
}

// ---------------------------------------------------------------- what the player reports

/** Player events the server sends on the viewer's behalf (VAST tracking events a server cannot see). */
export const PLAYER_EVENTS = ['pause', 'resume', 'mute', 'unmute', 'rewind', 'fullscreen', 'exitFullscreen', 'playerExpand', 'playerCollapse', 'skip', 'closeLinear'] as const;

export async function playerEvents(row: any, events: { b: number; p: number; event: string }[]): Promise<number> {
  let n = 0;
  for (const ev of events) {
    if (!(PLAYER_EVENTS as readonly string[]).includes(ev.event)) continue;
    const e = podEntry(row, ev.b, ev.p);
    if (!e || e.kind !== 'ad') continue;
    await sendSessionEvents(row, ev.b, ev.p, e, [{ event: ev.event, offsetSec: 0, urls: e.tracking?.[ev.event] ?? [] }]);
    n++;
  }
  return n;
}

/**
 * A click on an ad: recorded, its click trackers sent with the viewer's
 * address and player, and the viewer sent on to the advertiser's page.
 * Null when the ad has no click-through (nothing to open).
 */
export async function clickThrough(row: any, b: number, p: number): Promise<string | null> {
  const e = podEntry(row, b, p);
  if (!e || e.kind !== 'ad' || !e.clickThrough || !/^https?:\/\//i.test(e.clickThrough)) return null;
  void sendSessionEvents(row, b, p, e, [{ event: 'click', offsetSec: 0, urls: e.clickTracking ?? [] }]).catch(() => null);
  return e.clickThrough;
}

// ---------------------------------------------------------------- the ad timeline

export function timelineOf(row: any) {
  const plan = row.plan as SessionPlan;
  const played = playedBreaks(plan);
  const clock = played.map((b) => ({ index: b.index, atSec: b.atSec, durationSec: b.pod!.reduce((n, x) => n + x.durationSec, 0) }));
  const starts = stitchedStarts(clock);
  return {
    sessionId: row.id, assetId: row.vod_asset_id, delivery: row.delivery as 'stitched' | 'guided', ready: row.state === 'ready',
    contentSec: plan.contentSec, snapback: plan.snapback, prerollOnResume: plan.prerollOnResume,
    breaks: played.map((b, i) => {
      let t = 0;
      return {
        index: b.index, position: b.position, contentSec: b.atSec, stitchedStartSec: row.delivery === 'stitched' ? starts[i] : null, durationSec: clock[i].durationSec,
        ads: b.pod!.map((x, p) => {
          const o = { podIndex: p, kind: x.kind, title: x.title, startSec: t, durationSec: x.durationSec,
            clickUrl: x.kind === 'ad' && x.clickThrough ? `${sessionBase(row.id)}/click/${b.index}/${p}` : null };
          t += x.durationSec;
          return o;
        }),
      };
    }),
    eventsUrl: `${sessionBase(row.id)}/events`,
  };
}

// ---------------------------------------------------------------- the play gate

export interface PlayAds {
  delivery: 'stitched' | 'guided';
  hls: string;
  /** Stitched only, when the asset has a DASH encode it can cut: the session's multi-Period MPD. */
  dash: string | null;
  sessionId: string | null;
  timelineUrl: string | null;
}

/**
 * What the play gate hands a viewer of an on-demand asset: null to play it
 * as it is (no rule, rule off, the title opts out, or the viewer is ad-free),
 * else the playlist with ads and how they arrive.
 *
 * `preferred` is the app's ask (auto, stitched, guided); `caps` what the
 * player says it can do. Guided needs 'hls-interstitials'; auto picks guided
 * when the player has it and the rule allows, stitched otherwise, which plays
 * on every player.
 */
export async function adsForPlay(i: {
  accountId: string; assetId: string; via?: string | null; preferred?: Delivery | null; caps?: string[];
  playSid?: string | null; ctx: SessionCtx; fetcher?: Fetcher;
}): Promise<PlayAds | null> {
  const asset = await assetFor(i.assetId, i.accountId);
  if (!asset?.master_key) return null;
  const rule = await ruleForAsset(i.accountId, asset.schema_id);
  if (!rule) return null;
  if (titleRule(asset.metadata) === 'none') return null;
  const pol = rule.resolved;
  if (i.via === 'entitlement' && pol.adFreeFor.includes('entitlement')) return null;
  if (i.via === 'members' && pol.adFreeFor.includes('members')) return null;
  const canGuided = (i.caps ?? []).includes('hls-interstitials');
  const want = i.preferred && i.preferred !== 'auto' ? i.preferred : pol.delivery;
  const delivery: 'stitched' | 'guided' = want === 'guided' ? (canGuided ? 'guided' : 'stitched')
    : want === 'stitched' ? 'stitched' : canGuided ? 'guided' : 'stitched';
  const { breaks } = await breaksFor(asset, pol);
  if (!breaks.length) return null;
  if (delivery === 'guided') {
    // Guided DASH (alternative content) is not built: a guided viewer gets HLS only.
    return { delivery, hls: `${guidedBase(asset.id, await guidedVersion(asset, rule))}/master.m3u8`, dash: null, sessionId: null, timelineUrl: null };
  }
  const s = await openSession({ accountId: i.accountId, assetId: asset.id, delivery: 'stitched', playSid: i.playSid, ctx: i.ctx, rule, fetcher: i.fetcher });
  const dash = await assetMpd(asset).catch(() => null) ? `${sessionBase(s.id)}/manifest.mpd` : null;
  return { delivery, hls: `${sessionBase(s.id)}/master.m3u8`, dash, sessionId: s.id, timelineUrl: `${sessionBase(s.id)}/timeline.json` };
}

// ---------------------------------------------------------------- the report

export async function vodAdReport(accountId: string, since: Date, assetId?: string | null) {
  const p: unknown[] = [accountId, since.toISOString()];
  const assetSql = assetId ? (p.push(assetId), `AND vod_asset_id = $3`) : '';
  const b = await one<any>(
    `SELECT count(DISTINCT session_id)::int AS sessions, count(*)::int AS breaks,
            COALESCE(sum(break_ms),0)::bigint AS break_ms, COALESCE(sum(ad_ms),0)::bigint AS ad_ms, COALESCE(sum(house_ms),0)::bigint AS house_ms,
            count(*) FILTER (WHERE fallback = 'ad-server-timeout')::int AS timeouts,
            count(*) FILTER (WHERE fallback = 'ad-server-error')::int AS errors,
            count(*) FILTER (WHERE fallback = 'not-conditioned')::int AS not_conditioned,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY elapsed_ms) AS p95_ms
       FROM vod_ad_breaks WHERE account_id = $1 AND created_at >= $2 ${assetSql}`, p);
  const ev = await query<any>(
    `SELECT event, count(DISTINCT (session_id, break_index, pod_index))::int AS ads,
            count(*) FILTER (WHERE ok = false)::int AS failed
       FROM vod_ad_events WHERE account_id = $1 AND created_at >= $2 ${assetSql} GROUP BY event`, p);
  const by: Record<string, { ads: number; failed: number }> = {};
  for (const r of ev) by[r.event] = { ads: r.ads, failed: r.failed };
  const breakMs = Number(b?.break_ms ?? 0);
  const imp = by.impression?.ads ?? 0;
  const clicks = by.click?.ads ?? 0;
  return {
    sessions: b?.sessions ?? 0, breaks: b?.breaks ?? 0,
    fillRate: breakMs ? Math.round((Number(b.ad_ms) / breakMs) * 1000) / 1000 : null,
    houseShare: breakMs ? Math.round((Number(b.house_ms) / breakMs) * 1000) / 1000 : null,
    timeouts: b?.timeouts ?? 0, errors: b?.errors ?? 0, notConditioned: b?.not_conditioned ?? 0,
    p95Ms: b?.p95_ms != null ? Math.round(Number(b.p95_ms)) : null,
    impressions: imp, completes: by.complete?.ads ?? 0,
    completionRate: imp ? Math.round(((by.complete?.ads ?? 0) / imp) * 1000) / 1000 : null,
    clicks, clickRate: imp ? Math.round((clicks / imp) * 10000) / 10000 : null,
    events: by,
  };
}
