// ============================================================================
//  THE READ-ONLY GUIDE: what a front-end app asks of the EPG.
//
//  Every guide screen in a viewer app asks the same few questions:
//    what is on now, what is on next, what was just on,
//    what is on this channel today, what is on across these channels tonight.
//  This file answers them from the SAME programmes table the console writes,
//  the XMLTV import fills and a FAST lineup writes when it is activated or
//  topped up (services/fast/store.ts, source_ref 'fast:...'). So a FAST
//  channel's playback schedule IS its public guide, with nothing to publish
//  separately: activate the lineup and the guide answers.
//
//  CACHED, AND THE CACHE IS UPDATED BY WRITES, NOT BY CLOCKS.
//  Each channel's guide is held as one SLAB: every programme from a day back
//  to about three days ahead, already shaped for the public. Reads are served
//  from the slab in memory (scale/cache.ts: L1 in-process, L2 Valkey). The slab
//  carries the channel's tag, `asset:<channelId>`, which the programmes and
//  channels triggers (migration 0046) announce on every INSERT, UPDATE and
//  DELETE, so an edit in the console or a FAST re-apply drops the slab on
//  every API process within milliseconds. The TTL is only the backstop for a
//  missed notification. Now / next roll over by arithmetic on the slab, not by
//  a cache expiring: the time moves, the data does not.
//
//  WHAT IS NOT PUBLIC. A programme row carries operator material (ad breaks,
//  lineup slot ids, pad seconds, geo lists, clip bookkeeping). The public
//  shape below is a whitelist, so a field added to programmes later is private
//  until someone adds it here on purpose.
// ============================================================================
import { query, one } from '../db';
import { cached } from '../scale/cache';
import { scaleConfig } from '../scale/config';
import { config } from '../config';

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
/** Slabs start on a 6 hour boundary, a day before it: a stable cache key that moves four times a day. */
export const SLAB_ALIGN = 6 * HOUR;
export const SLAB_BACK = DAY;
export const SLAB_SPAN = 4 * DAY;
/** Most items either side of now a single request may ask for. */
export const MAX_AROUND = 20;
/** Longest window a single schedule request may cover. */
export const MAX_SCHEDULE_DAYS = 14;
/** Longest window and most channels a grid request may cover. */
export const MAX_GRID_HOURS = 48;
export const MAX_GRID_CHANNELS = 200;

export const API_BASE = '/api/public/epg';

// ------------------------------------------------------------------ shapes

export interface GuideChannel {
  id: string;
  xmltvId: string;
  name: string;
  kind: 'tv' | 'radio';
  /** The channel number viewers know it by, when the operator set one. */
  number: string | null;
  /** Absolute URL of the channel's guide icon. */
  icon: string | null;
  /** The channel's own IANA zone; times in responses are always UTC ISO strings. */
  timezone: string | null;
  /** True when the channel plays a FAST lineup (its guide is generated from the lineup). */
  fast: boolean;
  links: { self: string; now: string; schedule: string };
}

export interface PublicProgramme {
  id: string;
  channelId: string;
  title: string;
  subTitle: string | null;
  description: string | null;
  /** UTC ISO. A programme runs [start, end). */
  start: string;
  end: string;
  durationSec: number;
  categories: string[];
  series: string | null;
  season: number | null;
  episode: number | null;
  rating: string | null;
  language: string | null;
  /** Absolute URL of the programme's image, when there is one. */
  image: string | null;
  flags: { live: boolean; premiere: boolean; new: boolean; repeat: boolean; lastChance: boolean; captions: boolean };
  /** Where the listing came from: a FAST lineup, an imported feed, or the console's own schedule. */
  origin: 'fast' | 'import' | 'schedule';
  /** The published on-demand asset for this programme (a FAST title or the auto-VOD of a live slot). */
  onDemand: { assetId: string } | null;
  links: { self: string; channel: string };
}

/** A programme as answered: the cached shape plus where it stands against the asked time. */
export type AnsweredProgramme = PublicProgramme & {
  state: 'aired' | 'on-now' | 'upcoming';
  progress?: { elapsedSec: number; remainingSec: number; percent: number };
};

// ------------------------------------------------------------------ pure helpers

const str = (v: unknown): string | null => {
  if (typeof v === 'string') { const s = v.trim(); return s ? s : null; }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
};
const firstOf = (m: Record<string, any>, ...keys: string[]): string | null => {
  for (const k of keys) { const s = str(m[k]); if (s) return s; }
  return null;
};
const listOf = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map((x) => str(typeof x === 'object' && x ? (x as any).name ?? (x as any).value : x)).filter((x): x is string => !!x);
  const s = str(v);
  return s ? s.split(/\s*[,;|]\s*/).filter(Boolean) : [];
};
const intOf = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : null;
};
const flag = (v: unknown): boolean => v === true || v === 1 || (typeof v === 'string' && /^(true|yes|1)$/i.test(v.trim()));
const uniq = (a: string[]) => [...new Set(a)];

/** Store reference or URL -> absolute URL, for posters and programme images. */
export function absoluteUrl(ref: unknown, resolve?: (r: string) => string | null): string | null {
  const r = str(ref);
  if (!r) return null;
  if (/^https?:\/\//i.test(r)) return r;
  return resolve ? resolve(r) : null;
}

const cdnUrl = (key: string | null | undefined): string | null =>
  key ? `${config.aws.cdnBaseUrl.replace(/\/$/, '')}/${String(key).replace(/^\//, '')}` : null;

export interface ProgrammeRowIn {
  id: string;
  channel_id: string;
  title: string;
  starts_at: string | Date;
  ends_at: string | Date;
  source_ref: string | null;
  metadata: Record<string, any> | null;
  clip_asset_id?: string | null;
}
export interface AssetIn {
  id: string;
  title: string | null;
  metadata: Record<string, any> | null;
  poster_key: string | null;
  published: boolean;
}

/**
 * One programme row (+ the VOD asset a FAST slot plays, if any) in the public
 * shape. Pure, so every rule is testable without a database.
 *
 * A FAST slot's own metadata is operator bookkeeping (lineup, slot, cycle,
 * pad). Its description, image, genre and rating live on the VOD asset it
 * plays, so they are read from there, with anything set on the programme
 * itself winning.
 */
export function toPublicProgramme(p: ProgrammeRowIn, asset: AssetIn | null, clip: AssetIn | null, resolveImage?: (r: string) => string | null): PublicProgramme {
  const m = (p.metadata ?? {}) as Record<string, any>;
  const am = (asset?.metadata ?? {}) as Record<string, any>;
  const pick = (...keys: string[]) => firstOf(m, ...keys) ?? firstOf(am, ...keys);
  const startMs = new Date(p.starts_at).getTime();
  const endMs = new Date(p.ends_at).getTime();
  const ref = p.source_ref ?? '';
  const origin: PublicProgramme['origin'] = ref.startsWith('fast:') || m.source === 'fast' ? 'fast'
    : ref.startsWith('xmltv:') || ref.startsWith('import:') || !!m.importSourceId ? 'import' : 'schedule';
  const image = absoluteUrl(firstOf(m, 'image', 'icon', 'thumbnail'), resolveImage)
    ?? (asset?.poster_key ? cdnUrl(asset.poster_key) : null)
    ?? absoluteUrl(firstOf(am, 'image', 'posterUrl', 'artworkUrl'), resolveImage);
  const onDemandId = asset?.published ? asset.id : clip?.published ? clip.id : null;
  return {
    id: p.id,
    channelId: p.channel_id,
    title: p.title,
    subTitle: pick('subTitle', 'sub_title', 'subtitle', 'episodeTitle'),
    description: pick('description', 'desc', 'synopsis'),
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    durationSec: Math.max(0, Math.round((endMs - startMs) / 1000)),
    categories: uniq([...listOf(m.genre), ...listOf(m.category), ...listOf(m.categories), ...(origin === 'fast' ? [...listOf(am.genre), ...listOf(am.categories)] : [])]),
    series: pick('series', 'seriesTitle', 'series_title'),
    season: intOf(m.season ?? am.season),
    episode: intOf(m.episodeNumber ?? m.episode ?? am.episodeNumber ?? am.episode),
    rating: pick('rating', 'contentRating'),
    language: pick('language', 'inLanguage'),
    image,
    flags: {
      live: origin !== 'fast' && (flag(m.live) || flag(m.isLive)),
      premiere: flag(m.premiere),
      new: flag(m.isNew) || flag(m.new),
      repeat: flag(m.previouslyShown) || flag(m.repeat) || (origin === 'fast' && intOf(m.cycle) !== null && (intOf(m.cycle) as number) > 0),
      lastChance: flag(m.lastChance),
      captions: flag(m.subtitles) || flag(m.captions) || flag(am.captions),
    },
    origin,
    onDemand: onDemandId ? { assetId: onDemandId } : null,
    links: { self: `${API_BASE}/programmes/${p.id}`, channel: `${API_BASE}/channels/${p.channel_id}` },
  };
}

const ms = (iso: string) => Date.parse(iso);

/** Where a programme stands against `at`, with progress when it is on. */
export function answer(p: PublicProgramme, at: number): AnsweredProgramme {
  const s = ms(p.start), e = ms(p.end);
  if (e <= at) return { ...p, state: 'aired' };
  if (s > at) return { ...p, state: 'upcoming' };
  const elapsed = Math.max(0, Math.floor((at - s) / 1000));
  const total = Math.max(1, (e - s) / 1000);
  return { ...p, state: 'on-now', progress: { elapsedSec: elapsed, remainingSec: Math.max(0, Math.ceil((e - at) / 1000)), percent: Math.min(100, Math.round((elapsed / total) * 1000) / 10) } };
}

export interface Around {
  previous: PublicProgramme[];
  now: PublicProgramme | null;
  next: PublicProgramme[];
  /** When this answer next changes: the end of now or the start of the next one. */
  nextChangeAt: number | null;
}

/**
 * Now, the n before it and the n after it, from a list sorted by start.
 *
 * NOW is the LATEST-starting programme that contains `at`. Overlaps are soft
 * in this guide (they are shown to the operator, not blocked), and when one
 * programme runs over the next the one that started later is the one that
 * has taken the air, which matches how the scheduler resolves the overlap.
 */
export function aroundOf(list: PublicProgramme[], at: number, nPrev: number, nNext: number): Around {
  let nowIdx = -1;
  for (let i = 0; i < list.length; i++) {
    const s = ms(list[i].start);
    if (s > at) break;
    if (ms(list[i].end) > at) nowIdx = i;
  }
  const now = nowIdx >= 0 ? list[nowIdx] : null;
  const cut = now ? ms(now.start) : at;
  const previous = list.filter((p, i) => i !== nowIdx && ms(p.start) < cut && ms(p.end) <= at).slice(-Math.max(0, nPrev)).reverse();
  const upcoming = list.filter((p) => ms(p.start) > at);
  const next = upcoming.slice(0, Math.max(0, nNext));
  const candidates = [now ? ms(now.end) : null, upcoming.length ? ms(upcoming[0].start) : null].filter((x): x is number => x != null && x > at);
  return { previous, now, next, nextChangeAt: candidates.length ? Math.min(...candidates) : null };
}

/** Programmes overlapping [from, to) from a sorted list. */
export const inWindow = (list: PublicProgramme[], from: number, to: number) =>
  list.filter((p) => ms(p.start) < to && ms(p.end) > from);

export function slabStartFor(at: number): number {
  return Math.floor(at / SLAB_ALIGN) * SLAB_ALIGN - SLAB_BACK;
}

// ------------------------------------------------------------------ channels

interface ChannelRow {
  id: string; name: string; kind: string | null; xmltv_id: string | null; tz: string | null;
  brand_ref: string | null; guide_icon_ref: string | null; metadata: any; fast: boolean;
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNEL_SQL = `
  SELECT c.id, c.name, c.kind, c.xmltv_id, c.tz, c.brand_ref, c.guide_icon_ref, c.metadata,
         EXISTS (SELECT 1 FROM fast_lineups l WHERE l.channel_id = c.id AND l.status = 'active') AS fast
    FROM channels c JOIN groups g ON g.id = c.group_id
   WHERE g.account_id = $1 AND COALESCE(c.epg_enabled, true)`;

function channelOut(r: ChannelRow, resolveImage?: (r: string) => string | null): GuideChannel {
  const md = r.metadata ?? {};
  const iconRef = r.guide_icon_ref || r.brand_ref || str(md.logo);
  return {
    id: r.id,
    xmltvId: r.xmltv_id || r.id,
    name: r.name,
    kind: r.kind === 'radio' ? 'radio' : 'tv',
    number: str(md.channelNumber ?? md.broadcastChannelId),
    icon: absoluteUrl(iconRef, resolveImage),
    timezone: r.tz ?? null,
    fast: !!r.fast,
    links: { self: `${API_BASE}/channels/${r.id}`, now: `${API_BASE}/channels/${r.id}/now`, schedule: `${API_BASE}/channels/${r.id}/schedule` },
  };
}

/** Every guide channel of the account (epg_enabled), by name. */
export function guideChannels(account: string, resolveImage?: (r: string) => string | null): Promise<GuideChannel[]> {
  // A channel created after this was cached carries a tag nobody holds yet,
  // so the list also expires on a short clock; the account tag covers suspension.
  return cached<GuideChannel[]>(`epgpub:chs:${account}`,
    { ttlSec: 30, tags: (v) => [`acct:${account}`, ...v.map((c) => `asset:${c.id}`)], l2: true },
    async () => (await query<ChannelRow>(`${CHANNEL_SQL} ORDER BY lower(c.name), c.id`, [account])).map((r) => channelOut(r, resolveImage)));
}

/** One guide channel by Volt id or XMLTV id, inside the account. */
export function guideChannel(account: string, ref: string, resolveImage?: (r: string) => string | null): Promise<GuideChannel | null> {
  const key = String(ref).slice(0, 128);
  return cached<GuideChannel | null>(`epgpub:ch:${account}:${key}`,
    { ttlSec: (v) => (v ? scaleConfig.cache.assetTtlSec : 10), tags: (v) => (v ? [`acct:${account}`, `asset:${v.id}`] : [`acct:${account}`]), l2: true },
    async () => {
      const r = UUID_RX.test(key)
        ? await one<ChannelRow>(`${CHANNEL_SQL} AND (c.id = $2::uuid OR c.xmltv_id = $3)`, [account, key, key])
        : await one<ChannelRow>(`${CHANNEL_SQL} AND c.xmltv_id = $2`, [account, key]);
      return r ? channelOut(r, resolveImage) : null;
    });
}

// ------------------------------------------------------------------ programmes

/** Load and shape a channel's programmes overlapping [from, to). Uncached. */
export async function loadRange(channelId: string, from: number, to: number, resolveImage?: (r: string) => string | null): Promise<{ list: PublicProgramme[]; assetIds: string[] }> {
  const rows = await query<ProgrammeRowIn>(
    `SELECT p.id, p.channel_id, p.title, p.starts_at, p.ends_at, p.source_ref, p.metadata, p.clip_asset_id
       FROM programmes p
      WHERE p.channel_id = $1 AND p.status <> 'cancelled' AND p.span && tstzrange($2, $3, '[)')
      ORDER BY p.starts_at, p.id`,
    [channelId, new Date(from).toISOString(), new Date(to).toISOString()]);
  const ids = uniq(rows.flatMap((r) => [str(r.metadata?.vodAssetId), r.clip_asset_id ?? null]).filter((x): x is string => !!x && UUID_RX.test(x)));
  const assets = new Map<string, AssetIn>();
  if (ids.length) {
    for (const a of await query<AssetIn>(`SELECT id, title, metadata, poster_key, published FROM vod_assets WHERE id = ANY($1::uuid[])`, [ids])) assets.set(a.id, a);
  }
  const list = rows.map((r) => toPublicProgramme(r, assets.get(str(r.metadata?.vodAssetId) ?? '') ?? null, r.clip_asset_id ? assets.get(r.clip_asset_id) ?? null : null, resolveImage));
  return { list, assetIds: ids };
}

interface Slab { from: number; to: number; list: PublicProgramme[]; assetIds: string[] }

/** The channel's cached slab around `at` (a day back, about three ahead). */
export function slabFor(channelId: string, at: number, resolveImage?: (r: string) => string | null): Promise<Slab> {
  const from = slabStartFor(at);
  const to = from + SLAB_SPAN;
  return cached<Slab>(`epgpub:slab:${channelId}:${from}`,
    // The asset tags make a poster or description edited on a FAST title show in the guide at once.
    { ttlSec: 600, tags: (v) => [`asset:${channelId}`, ...v.assetIds.map((id) => `asset:${id}`)], l2: true },
    async () => ({ from, to, ...(await loadRange(channelId, from, to, resolveImage)) }));
}

/** A channel's programmes overlapping [from, to): from the slab when it covers the window, else a cached range load. */
export async function programmesIn(channelId: string, from: number, to: number, resolveImage?: (r: string) => string | null): Promise<PublicProgramme[]> {
  const slab = await slabFor(channelId, Date.now(), resolveImage);
  if (from >= slab.from && to <= slab.to) return inWindow(slab.list, from, to);
  const r = await cached<{ list: PublicProgramme[]; assetIds: string[] }>(`epgpub:win:${channelId}:${from}:${to}`,
    { ttlSec: 300, tags: (v) => [`asset:${channelId}`, ...v.assetIds.map((id) => `asset:${id}`)], l2: true },
    () => loadRange(channelId, from, to, resolveImage));
  return r.list;
}

/**
 * Previous / now / next for a channel at `at`. Served from the slab; when the
 * asked counts reach past the slab's edge (a far-off `at`, or twenty items
 * after a sparse guide) the missing side is read from the table.
 */
export async function aroundFor(channelId: string, at: number, nPrev: number, nNext: number, resolveImage?: (r: string) => string | null): Promise<Around> {
  const slab = await slabFor(channelId, at, resolveImage);
  const a = aroundOf(slab.list, at, nPrev, nNext);
  if (a.next.length < nNext && slab.to - at < 2 * DAY) {
    const more = await programmesAfter(channelId, slab.to - 1, nNext - a.next.length + 1, resolveImage);
    const seen = new Set([...a.next.map((p) => p.id), a.now?.id]);
    a.next = [...a.next, ...more.filter((p) => !seen.has(p.id) && ms(p.start) > at)].slice(0, nNext);
  }
  if (a.previous.length < nPrev && at - slab.from < 12 * HOUR) {
    const more = await programmesBefore(channelId, slab.from + 1, nPrev - a.previous.length + 1, resolveImage);
    const seen = new Set([...a.previous.map((p) => p.id), a.now?.id]);
    a.previous = [...a.previous, ...more.filter((p) => !seen.has(p.id) && ms(p.end) <= at)].slice(0, nPrev);
  }
  return a;
}

async function neighbours(channelId: string, sql: string, at: number, n: number, resolveImage?: (r: string) => string | null): Promise<PublicProgramme[]> {
  const rows = await query<{ id: string; starts_at: Date; ends_at: Date }>(sql, [channelId, new Date(at).toISOString(), Math.min(n, MAX_AROUND + 1)]);
  if (!rows.length) return [];
  const lo = Math.min(...rows.map((r) => new Date(r.starts_at).getTime()));
  const hi = Math.max(...rows.map((r) => new Date(r.ends_at).getTime()));
  const want = new Set(rows.map((r) => r.id));
  const { list } = await loadRange(channelId, lo, hi, resolveImage);
  return list.filter((p) => want.has(p.id));
}
const programmesAfter = (ch: string, at: number, n: number, ri?: (r: string) => string | null) =>
  neighbours(ch, `SELECT id, starts_at, ends_at FROM programmes WHERE channel_id = $1 AND status <> 'cancelled' AND starts_at > $2 ORDER BY starts_at, id LIMIT $3`, at, n, ri);
const programmesBefore = async (ch: string, at: number, n: number, ri?: (r: string) => string | null) =>
  (await neighbours(ch, `SELECT id, starts_at, ends_at FROM programmes WHERE channel_id = $1 AND status <> 'cancelled' AND ends_at <= $2 ORDER BY starts_at DESC, id LIMIT $3`, at, n, ri)).reverse();

/** One programme by id inside the account, with its neighbours on the same channel. */
export async function programmeWithNeighbours(account: string, id: string, resolveImage?: (r: string) => string | null): Promise<{ programme: PublicProgramme; previous: PublicProgramme | null; next: PublicProgramme | null } | null> {
  if (!UUID_RX.test(id)) return null;
  const row = await one<{ channel_id: string; starts_at: Date; ends_at: Date }>(
    `SELECT p.channel_id, p.starts_at, p.ends_at FROM programmes p
       JOIN channels c ON c.id = p.channel_id JOIN groups g ON g.id = c.group_id
      WHERE p.id = $1 AND g.account_id = $2 AND p.status <> 'cancelled' AND COALESCE(c.epg_enabled, true)`, [id, account]);
  if (!row) return null;
  const s = new Date(row.starts_at).getTime(), e = new Date(row.ends_at).getTime();
  const list = await programmesIn(row.channel_id, s - 1, e + 1, resolveImage);
  const programme = list.find((p) => p.id === id);
  if (!programme) return null;
  const [before] = (await programmesBefore(row.channel_id, s, 1, resolveImage)).slice(-1);
  const [after] = await programmesAfter(row.channel_id, s, 1, resolveImage);
  return { programme, previous: before ?? null, next: after && after.id !== id ? after : null };
}
