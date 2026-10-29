// ============================================================================
//  FAST CHANNELS, the database half: the library a lineup draws from, writing
//  a lineup into the guide (programmes + stream_breaks), keeping it topped up,
//  the timeline the playout plays, and break decisions.
//
//  THE GUIDE IS THE PLAYOUT'S SCRIPT. Applying a lineup writes ordinary
//  programmes (source_ref fast:<lineup>:...) and their breaks, so everything
//  that already reads the guide works on a FAST channel unchanged: the EPG
//  pages, XMLTV out, now/next, Up next, the timeline, reports, auto-VOD rules.
//  The playout then plays the guide, not the lineup, which means a manual fix
//  in the guide (swap tonight's 20:00 film) is what goes to air.
//
//  NEVER TOUCHES WHAT HAS STARTED. A re-apply replaces FAST programmes that
//  start after the programme on air ends, and nothing else: manual entries
//  are reported as conflicts, never deleted.
// ============================================================================
import { query, one, tx } from '../../db';
import { usageStatusSql } from '../assetReadiness';
import { existsSync } from 'node:fs';
import { planLineup, rebase, type AssetInfo, type Lineup, type Slot, type PlannedProgramme } from './lineup';
import { resolveAdPolicy, adRuleOf, type AdPolicy } from './adPlan';
import { houseFill, fillBreak, type HouseAd, type PodPlan } from './pod';
import { spliceInsert, toHex, eventIdFor } from './scte35';
import { resolve as resolveVast, expandTag, bestSource, type Fetcher, type TagContext } from './vast';
import { sourceQuality, type Role } from './ladder';

export const DEFAULT_HORIZON_DAYS = 7;
const SEGMENT_SEC = Number(process.env.FAST_SEGMENT_SEC ?? 2);

// ---------------------------------------------------------------- library

/** A FAST channel carries video or audio (channels.fast_media). */
export type FastMedia = 'video' | 'audio';

/** A library asset as the builder sees it: the engine's shape, plus what it is and whether it can air. */
export interface LibraryAsset extends AssetInfo {
  /** Audio only (same test as the Media Library's audio badge), else video. */
  media: FastMedia;
  /**
   * Can it go on a channel? Packaged with audio and video aligned for splicing,
   * or its source file is still on this server so activation can prepare it.
   * False is the readiness check's "No source" (services/fast/prepare.ts).
   */
  sourceOk: boolean;
  /**
   * Usage status (services/assetReadiness.ts). Only 'ready' is offered to the
   * builder or planned onto air: media built and confirmed by QC (or approved).
   */
  usageStatus: string;
  /** The source's picture and video bitrate (ladder.ts sourceQuality): what decides whether it can fill a channel's top rung. */
  quality?: { width: number | null; height: number | null; kbps: number | null };
}

/** Audio only: the Media Library's test (services/media/assetImage.ts isAudioAsset), kept here so the FAST store does not pull in sharp. */
export function isAudioRow(a: any): boolean {
  if (a.channel_kind === 'radio') return true;
  if (a.ingest?.probe && a.ingest.probe.hasVideo === false) return true;
  return !!(a.export_mp3_key || a.export_m4a_key) && !a.top_height && !a.progressive_key;
}

/** The source file is on this server (the encoder reads a local path only). */
export function sourceOnServer(key: string | null | undefined): boolean {
  if (!key || String(key).startsWith('s3://')) return false;
  try { return existsSync(String(key)); } catch { return false; }
}

/** Every playable on-demand asset the account owns, in the engine's shape. */
export async function libraryFor(accountId: string): Promise<Map<string, LibraryAsset>> {
  const rows = await query<any>(
    `SELECT v.id, v.title, v.duration_ms, v.metadata, v.master_key, v.available_from, v.available_until,
            v.availability_state, v.break_cues_ms, v.poster_key,
            v.source_key, v.encode_result, v.ingest, v.export_mp3_key, v.export_m4a_key, v.top_height, v.progressive_key,
            c.kind AS channel_kind, ${usageStatusSql('v')} AS usage_status
       FROM vod_assets v
       LEFT JOIN channels c ON c.id = v.channel_id
       LEFT JOIN events   e ON e.id = v.event_id
       LEFT JOIN groups   g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE (v.account_id = $1 OR g.account_id = $1)
        AND v.duration_ms > 0
        AND COALESCE(v.metadata->>'kind', '') <> 'ad'
        AND v.availability_state <> 'withdrawn'
      ORDER BY v.created_at DESC
      LIMIT 20000`, [accountId]);
  const m = new Map<string, LibraryAsset>();
  for (const r of rows) {
    const spliceReady = !!r.master_key && r.encode_result?.zeroStart === true;
    m.set(String(r.id), {
      ...assetFromRow(r),
      media: isAudioRow(r) ? 'audio' : 'video',
      sourceOk: spliceReady || sourceOnServer(r.source_key),
      usageStatus: String(r.usage_status ?? 'ready'),
      quality: sourceQuality(r),
    });
  }
  return m;
}

/** The assets a channel of this media may use: the right kind, and able to air. */
export function libraryForMedia(lib: Map<string, LibraryAsset>, media: FastMedia): Map<string, LibraryAsset> {
  return new Map([...lib].filter(([, a]) => a.media === media && a.sourceOk && a.usageStatus === 'ready'));
}

/**
 * What may be PLANNED ONTO AIR: ready assets only. A title in a run order that
 * has since failed QC, or whose build failed, is skipped with a notice and the
 * slot falls back to its rotation or backfill, instead of airing dead air.
 */
export function airable(lib: Map<string, LibraryAsset>): Map<string, LibraryAsset> {
  return new Map([...lib].filter(([, a]) => a.usageStatus === 'ready'));
}

export function assetFromRow(r: any): AssetInfo {
  const md = r.metadata ?? {};
  const n = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    id: String(r.id),
    title: String(md.title || r.title || 'Untitled'),
    durationSec: Number(r.duration_ms) / 1000,
    series: md.series ? String(md.series) : null,
    season: n(md.season),
    episode: n(md.episodeNumber ?? md.episode),
    availableFrom: r.available_from ? new Date(r.available_from) : null,
    availableUntil: r.available_until ? new Date(r.available_until) : null,
    breakCuesSec: Array.isArray(r.break_cues_ms) ? r.break_cues_ms.map((x: number) => x / 1000) : [],
    ready: !!r.master_key,
    imageUrl: md.image ?? null,
    genre: Array.isArray(md.genre) ? md.genre[0] ?? null : md.genre ?? null,
    adRule: adRuleOf(md),
  };
}

// ---------------------------------------------------------------- lineups

export interface LineupSettings {
  cycleShift?: number;
  anchor?: string | null;
  gridMin?: 0 | 5 | 15 | 30 | 60;
  backfill?: string[];
  seed?: string;
  horizonDays?: number;
}

export function lineupFromRow(row: any, ads: AdPolicy): Lineup {
  const s: LineupSettings = row.settings ?? {};
  return {
    epoch: new Date(row.epoch),
    epochCycle: Number(row.epoch_cycle ?? 0),
    epochSlot: Number(row.epoch_slot ?? 0),
    seriesStart: row.series_start ?? {},
    slots: (row.slots ?? []) as Slot[],
    cycleShift: s.cycleShift ?? 0,
    anchor: s.anchor ?? null,
    zone: row.zone || 'UTC',
    gridMin: s.gridMin ?? 0,
    segmentSec: SEGMENT_SEC,
    ads,
    backfill: s.backfill ?? [],
    seed: s.seed ?? String(row.channel_id),
    identSec: Number((ads as any)?.identBetweenSec ?? 0) || 0,
  };
}

/**
 * THE CHANNEL'S BRAND LOOP: short idents (stings, bumpers) and a longer brand
 * loop that play between programmes, like a broadcaster's channel idents.
 *
 *   off      no idents (gaps are house spots and slate, as before)
 *   pad      an ident opens any gap long enough for it (grid pad, the anchor
 *            restart), then house spots / slate / the brand loop fill the rest.
 *            The guide's times do not change.
 *   between  an ident between EVERY pair of programmes: the planner reserves
 *            the longest ident's time after each programme (lineup.ts identSec),
 *            so the run order moves later by that much per programme.
 *
 * `loopAssetId` is a seamless brand loop that fills what is left of a gap
 * instead of the slate (the slate stays the fallback for breaks nobody sold).
 * Stored in channel_ads.policy.brand; every ident is prepared like a house spot.
 */
export interface BrandIdent { assetId: string; title: string; durationSec: number }
export interface ChannelBrand {
  mode: 'off' | 'pad' | 'between';
  identIds: string[];
  idents: BrandIdent[];
  loopAssetId: string | null;
  /** Seconds the planner reserves per programme in 'between' mode: the longest ident, whole segments. */
  identBetweenSec: number;
}

export interface ChannelAds {
  mode: 'off' | 'markers' | 'stitched';
  policy: AdPolicy & { slateAssetId?: string | null; identBetweenSec?: number };
  brand: ChannelBrand;
  adServerId: string | null;
  house: HouseAd[];
  houseRefs: { assetId: string; weight?: number }[];
  scope: 'channel' | 'session';
  /** Slate and loop from Loops & Fillers (fillerBridge.ts): asset id -> filler asset id, and whether ad breaks play the loop instead of the slate. */
  filler: { sources: Record<string, string>; breaksUseLoop: boolean };
}

export async function adsFor(channelId: string): Promise<ChannelAds> {
  const r = await one<any>(`SELECT * FROM channel_ads WHERE channel_id = $1`, [channelId]);
  const mode = (r?.mode ?? 'off') as ChannelAds['mode'];
  const policy = { ...resolveAdPolicy({ ...(r?.policy ?? {}), enabled: mode !== 'off' && (r?.policy?.enabled ?? true) }), slateAssetId: r?.policy?.slateAssetId ?? null };
  const refs: { assetId: string; weight?: number }[] = Array.isArray(r?.house_ads) ? r.house_ads : [];
  const house: HouseAd[] = [];
  if (refs.length) {
    const rows = await query<any>(`SELECT id, title, duration_ms, metadata FROM vod_assets WHERE id = ANY($1::uuid[]) AND master_key IS NOT NULL`, [refs.map((x) => x.assetId)]);
    for (const ref of refs) {
      const a = rows.find((x) => String(x.id) === ref.assetId);
      if (a) house.push({ assetId: ref.assetId, title: String(a.metadata?.title || a.title || 'House ad'), durationSec: Number(a.duration_ms) / 1000, weight: ref.weight });
    }
  }
  const brand = await brandOf(r?.policy?.brand);
  const withBrand = brand.identBetweenSec ? { ...policy, identBetweenSec: brand.identBetweenSec } : policy;
  // Which slate and loop came from Loops & Fillers (asset id -> filler asset id), and whether breaks play the loop.
  const filler = { sources: (r?.policy?.fillerSources && typeof r.policy.fillerSources === 'object') ? r.policy.fillerSources as Record<string, string> : {}, breaksUseLoop: r?.policy?.breaksUseLoop === true };
  return { mode, policy: withBrand, brand, adServerId: r?.ad_server_id ?? null, house, houseRefs: refs, scope: r?.decision_scope ?? 'session', filler };
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The stored brand settings, with the idents resolved (missing assets dropped). */
export async function brandOf(raw: any): Promise<ChannelBrand> {
  const mode: ChannelBrand['mode'] = raw?.mode === 'pad' || raw?.mode === 'between' ? raw.mode : 'off';
  const identIds: string[] = Array.isArray(raw?.identIds) ? raw.identIds.filter((x: unknown) => typeof x === 'string' && UUID_RX.test(x)).slice(0, 20) : [];
  const loopAssetId = typeof raw?.loopAssetId === 'string' && UUID_RX.test(raw.loopAssetId) ? raw.loopAssetId : null;
  const idents: BrandIdent[] = [];
  if (identIds.length) {
    const rows = await query<any>(`SELECT id, title, duration_ms, metadata FROM vod_assets WHERE id = ANY($1::uuid[]) AND master_key IS NOT NULL`, [identIds]);
    for (const id of identIds) {
      const a = rows.find((x) => String(x.id) === id);
      if (a) idents.push({ assetId: id, title: String(a.metadata?.title || a.title || 'Ident'), durationSec: Number(a.duration_ms) / 1000 });
    }
  }
  const longest = idents.reduce((m, i) => Math.max(m, i.durationSec), 0);
  const identBetweenSec = mode === 'between' && longest > 0 ? Math.ceil(longest / SEGMENT_SEC - 1e-6) * SEGMENT_SEC : 0;
  return { mode: idents.length ? mode : 'off', identIds, idents, loopAssetId, identBetweenSec };
}

/**
 * A gap's fill with the brand: the ident first (rotating by gap), then the
 * rest as before (house spots, slate) or the brand loop in place of the slate.
 * Pure, so the rules are testable.
 */
export function brandedFill(gapSec: number, gapIndex: number, brand: Pick<ChannelBrand, 'mode' | 'idents' | 'loopAssetId'>, rest: (sec: number) => TimelineFill[], loop: { assetId: string; master: string | null } | null): TimelineFill[] {
  const out: TimelineFill[] = [];
  let left = gapSec;
  if (brand.mode !== 'off' && brand.idents.length) {
    const id = brand.idents[((gapIndex % brand.idents.length) + brand.idents.length) % brand.idents.length];
    if (id.durationSec <= left + 0.25) {
      out.push({ kind: 'ident', assetId: id.assetId, master: null, durationSec: Math.min(id.durationSec, left), title: id.title });
      left = Math.round((left - id.durationSec) * 1000) / 1000;
    }
  }
  if (left > 0.25) {
    const tail = rest(left);
    // the brand loop takes the slate's place in a gap (it is elastic like the slate)
    out.push(...(loop ? tail.map((f) => (f.kind === 'slate' ? { ...f, kind: 'slate' as const, assetId: loop.assetId, master: loop.master, title: 'Brand loop' } : f)) : tail));
  }
  return out;
}

// ---------------------------------------------------------------- apply

export interface ApplyResult {
  from: string;
  until: string;
  inserted: number;
  replaced: number;
  breaks: number;
  conflicts: { programmeId: string; title: string; startsAt: string }[];
  notices: { at: string; message: string }[];
  dryRun: boolean;
  programmes?: ReturnType<typeof wireProgramme>[];
}

/**
 * AN ASSET RENAMED: the guide follows. FAST programmes already written for it
 * (on air now and ahead, every repeat) take its new title, so a channel does
 * not keep airing the old name until the lineup is applied again. Only those
 * still carrying the old title: a title someone set by hand in the guide stays.
 * Returns how many programmes changed.
 */
export async function retitleProgrammes(assetId: string, oldTitle: string, newTitle: string): Promise<number> {
  if (!newTitle || oldTitle === newTitle) return 0;
  const r = await query<any>(
    `UPDATE programmes SET title = $3, updated_at = now()
      WHERE metadata->>'vodAssetId' = $1 AND source_ref LIKE 'fast:%' AND ends_at > now()
        AND status <> 'cancelled' AND title = $2
      RETURNING id`, [assetId, oldTitle, newTitle]);
  return r.length;
}

export function wireProgramme(p: PlannedProgramme) {
  return {
    key: p.key, cycle: p.cycle, slotId: p.slotId, assetId: p.assetId, title: p.title,
    start: p.start.toISOString(), end: p.end.toISOString(), contentEnd: p.contentEnd.toISOString(),
    contentSec: p.contentSec, padSec: p.padSec, note: p.note ?? null, series: p.series ?? null, warnings: p.warnings,
    breaks: p.breaks.map((b) => ({ start: b.start!.toISOString(), durationSec: b.durationSec, position: b.position, atAssetSec: b.atAssetSec, source: b.source, fromPadSec: b.fromPadSec ?? 0, capped: !!b.capped })),
  };
}

/** Where a re-apply may start writing: after whatever is on air now. */
async function protectPoint(channelId: string, at: Date): Promise<Date> {
  const onAir = await one<any>(
    `SELECT ends_at FROM programmes WHERE channel_id = $1 AND starts_at <= $2 AND ends_at > $2 ORDER BY starts_at DESC LIMIT 1`,
    [channelId, at.toISOString()]);
  return onAir ? new Date(onAir.ends_at) : at;
}

/**
 * Write a lineup into the guide from `from` (default: when the programme on
 * air ends) to `from + days`. `dryRun` plans and reports without writing.
 */
export async function applyLineup(lineupId: string, opts: { from?: Date; days?: number; dryRun?: boolean; topUpOnly?: boolean } = {}): Promise<ApplyResult> {
  const row = await one<any>(`SELECT l.*, c.name AS channel_name FROM fast_lineups l JOIN channels c ON c.id = l.channel_id WHERE l.id = $1`, [lineupId]);
  if (!row) throw new Error('lineup not found');
  const ads = await adsFor(row.channel_id);
  const lineup = lineupFromRow(row, ads.policy);
  const acct = await one<any>(`SELECT g.account_id FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id = $1`, [row.channel_id]);
  const lib = airable(await libraryFor(acct.account_id));
  const days = Math.max(1, Math.min(14, opts.days ?? row.settings?.horizonDays ?? DEFAULT_HORIZON_DAYS));
  const now = new Date();
  let from = opts.from ?? (opts.topUpOnly && row.applied_until ? new Date(row.applied_until) : await protectPoint(row.channel_id, now));
  if (from < lineup.epoch) from = lineup.epoch;
  const until = new Date(Math.max(from.getTime(), now.getTime()) + days * 86400_000);
  let plan = planLineup(lineup, lib, from, until);
  // NO HOLE AFTER THE PROGRAMME ON AIR. When the guide's programme on air came
  // from an earlier plan (a policy change made breaks longer, a title was
  // swapped by hand), this plan's boundaries no longer meet `from`. The lineup
  // is then carried on from `from` exactly, and the new position is kept, so
  // the next top-up continues from it too.
  let rebased: ReturnType<typeof rebase> | null = null;
  if (!opts.topUpOnly && !plan.programmes.some((p) => Math.abs(p.start.getTime() - from.getTime()) < 500) && from.getTime() > lineup.epoch.getTime()) {
    rebased = rebase(lineup, lib, from);
    Object.assign(lineup, rebased);
    plan = planLineup(lineup, lib, from, until);
  }
  // Only what starts at or after `from`: the programme straddling it is the
  // one on air (or the last one written), and it stays as it is.
  const progs = plan.programmes.filter((p) => p.start.getTime() >= from.getTime() - 500);
  const result: ApplyResult = {
    from: from.toISOString(), until: until.toISOString(), inserted: 0, replaced: 0, breaks: 0, conflicts: [],
    notices: plan.notices.map((n) => ({ at: n.at.toISOString(), message: n.message })), dryRun: !!opts.dryRun,
  };
  const others = await query<any>(
    `SELECT id, title, starts_at FROM programmes
      WHERE channel_id = $1 AND COALESCE(source_ref, '') NOT LIKE 'fast:%' AND starts_at < $3 AND ends_at > $2
      ORDER BY starts_at LIMIT 200`, [row.channel_id, from.toISOString(), until.toISOString()]);
  result.conflicts = others.map((o) => ({ programmeId: o.id, title: o.title, startsAt: new Date(o.starts_at).toISOString() }));
  if (opts.dryRun) { result.programmes = progs.map(wireProgramme); return result; }

  await tx(async (c) => {
    if (rebased) {
      await c.query(`UPDATE fast_lineups SET epoch = $2, epoch_cycle = $3, epoch_slot = $4, series_start = $5::jsonb WHERE id = $1`,
        [row.id, rebased.epoch.toISOString(), rebased.epochCycle, rebased.epochSlot, JSON.stringify(rebased.seriesStart)]);
    }
    if (!opts.topUpOnly) {
      const del = await c.query(
        `DELETE FROM programmes WHERE channel_id = $1 AND source_ref LIKE 'fast:%' AND starts_at >= $2 AND status = 'scheduled'`,
        [row.channel_id, from.toISOString()]);
      result.replaced = del.rowCount ?? 0;
    }
    for (const p of progs) {
      const ref = `fast:${row.id}:v${row.version}:${p.key}`;
      const md = {
        kind: 'content', source: 'fast', lineupId: row.id, slotId: p.slotId, cycle: p.cycle, vodAssetId: p.assetId,
        contentSec: p.contentSec, padSec: p.padSec, note: p.note ?? null,
        ...(p.series ? { series: p.series.name, season: p.series.season, episodeNumber: p.series.episode } : {}),
      };
      const ins = await c.query(
        `INSERT INTO programmes (channel_id, source_ref, title, starts_at, ends_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (channel_id, source_ref) WHERE source_ref IS NOT NULL DO UPDATE
           SET title = EXCLUDED.title, starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, metadata = EXCLUDED.metadata, updated_at = now()
         RETURNING id`,
        [row.channel_id, ref, p.title, p.start.toISOString(), p.end.toISOString(), JSON.stringify(md)]);
      const pid = ins.rows[0].id;
      result.inserted++;
      await c.query(`DELETE FROM stream_breaks WHERE programme_id = $1`, [pid]);
      for (let i = 0; i < p.breaks.length; i++) {
        const b = p.breaks[i];
        await c.query(
          `INSERT INTO stream_breaks (channel_id, programme_id, source, source_ref, starts_at, duration_ms, position, at_asset_ms, scte_event_id, meta)
           VALUES ($1, $2, 'fast', $3, $4, $5, $6, $7, $8, $9::jsonb)
           ON CONFLICT (channel_id, source_ref) WHERE source_ref IS NOT NULL DO UPDATE
             SET programme_id = EXCLUDED.programme_id, starts_at = EXCLUDED.starts_at, duration_ms = EXCLUDED.duration_ms,
                 position = EXCLUDED.position, at_asset_ms = EXCLUDED.at_asset_ms, status = 'scheduled'`,
          [row.channel_id, pid, `${ref}:b${i}`, b.start!.toISOString(), Math.round(b.durationSec * 1000), b.position,
           Math.round(b.atAssetSec * 1000), eventIdFor(`${ref}:b${i}`), JSON.stringify({ source: b.source, ...(b.fromPadSec ? { fromPadSec: b.fromPadSec } : {}), ...(b.capped ? { capped: true } : {}) })]);
        result.breaks++;
      }
    }
    const lastEnd = progs.length ? progs[progs.length - 1].end : until;
    await c.query(
      `UPDATE fast_lineups SET applied_from = COALESCE(CASE WHEN $3 THEN applied_from END, $2), applied_until = $4, applied_at = now(), updated_at = now() WHERE id = $1`,
      [row.id, from.toISOString(), !!opts.topUpOnly, lastEnd.toISOString()]);
  });
  return result;
}

/**
 * Make `lineupId` the channel's active lineup. An already-active version is
 * archived and the new one is REBASED onto it, so the run order and every
 * series carry on from where they are instead of starting again.
 */
export async function activateLineup(lineupId: string): Promise<{ epoch: string; epochCycle: number }> {
  const row = await one<any>(`SELECT * FROM fast_lineups WHERE id = $1`, [lineupId]);
  if (!row) throw new Error('lineup not found');
  const prev = await one<any>(`SELECT * FROM fast_lineups WHERE channel_id = $1 AND status = 'active' AND id <> $2`, [row.channel_id, lineupId]);
  let epoch = new Date(row.epoch), epochCycle = Number(row.epoch_cycle ?? 0), epochSlot = 0, seriesStart = row.series_start ?? {};
  if (prev) {
    const ads = await adsFor(row.channel_id);
    const acct = await one<any>(`SELECT g.account_id FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id = $1`, [row.channel_id]);
    const lib = await libraryFor(acct.account_id);
    // the new run order starts from its top when the programme on air ends,
    // with the pass count and every series where the old version had them
    const at = await protectPoint(row.channel_id, new Date());
    const rb = rebase(lineupFromRow(prev, ads.policy), lib, at, false);
    epoch = rb.epoch; epochCycle = rb.epochCycle; epochSlot = rb.epochSlot; seriesStart = rb.seriesStart;
  } else if (epoch.getTime() < Date.now()) {
    // THE FIRST LINEUP ON A CHANNEL STARTS NOW (after anything already on air),
    // not when the draft was created: a run order "begun" days ago would open
    // part-way through a programme and leave a hole before the first full one.
    // An epoch in the future is kept: that is a scheduled launch.
    epoch = await protectPoint(row.channel_id, new Date());
  }
  await tx(async (c) => {
    if (prev) await c.query(`UPDATE fast_lineups SET status = 'archived', updated_at = now() WHERE id = $1`, [prev.id]);
    await c.query(
      `UPDATE fast_lineups SET status = 'active', epoch = $2, epoch_cycle = $3, epoch_slot = $7, series_start = $4::jsonb, previous_id = $5,
              version = COALESCE($6, version), updated_at = now() WHERE id = $1`,
      [lineupId, epoch.toISOString(), epochCycle, JSON.stringify(seriesStart), prev?.id ?? null, prev ? Number(prev.version) + 1 : null, epochSlot]);
  });
  return { epoch: epoch.toISOString(), epochCycle };
}

/** Scheduler tick: keep every active lineup's guide `horizonDays` ahead. */
export async function topUpFast(): Promise<number> {
  const rows = await query<any>(
    `SELECT l.id FROM fast_lineups l JOIN channels c ON c.id = l.channel_id
      WHERE l.status = 'active' AND c.origin = 'playlist'
        AND (l.applied_until IS NULL OR l.applied_until < now() + make_interval(days => GREATEST(1, COALESCE((l.settings->>'horizonDays')::int, ${DEFAULT_HORIZON_DAYS}) - 1)))`);
  let n = 0;
  for (const r of rows) {
    try { await applyLineup(r.id, { topUpOnly: true }); n++; } catch (e) { console.error('[fast] top-up failed', r.id, e); }
  }
  return n;
}

// ---------------------------------------------------------------- timeline

export interface TimelineFill { kind: 'house' | 'slate' | 'ad' | 'ident'; assetId: string | null; master: string | null; durationSec: number; title?: string }
export type TimelineItem =
  | { kind: 'content'; id: string; start: string; durationSec: number; assetId: string; master: string | null; inSec: number; outSec: number; title: string }
  | { kind: 'break'; id: string; start: string; durationSec: number; position: string; scte35Out: string; scte35In: string; eventId: number; hideGraphics: boolean; fill: TimelineFill[] }
  | { kind: 'filler'; id: string; start: string; durationSec: number; fill: TimelineFill[] };

/**
 * What the playout plays over a window, from the GUIDE (so a manual swap in
 * the guide is what airs): each programme cut into content parts around its
 * breaks, each break with its shared fill (house ads + slate) and SCTE-35,
 * and each grid pad as filler.
 */
export async function timelineFor(channelId: string, from: Date, to: Date) {
  const progs = await query<any>(
    `SELECT p.id, p.title, p.starts_at, p.ends_at, p.metadata, v.master_key, v.duration_ms
       FROM programmes p LEFT JOIN vod_assets v ON v.id = NULLIF(p.metadata->>'vodAssetId', '')::uuid
      WHERE p.channel_id = $1 AND p.ends_at > $2 AND p.starts_at < $3 AND p.status <> 'cancelled'
      ORDER BY p.starts_at LIMIT 500`, [channelId, from.toISOString(), to.toISOString()]);
  const brks = await query<any>(
    `SELECT * FROM stream_breaks WHERE channel_id = $1 AND status <> 'cancelled'
        AND starts_at < $3 AND starts_at + make_interval(secs => duration_ms / 1000.0) > $2 ORDER BY starts_at`,
    [channelId, new Date(from.getTime() - 6 * 3600_000).toISOString(), new Date(to.getTime() + 6 * 3600_000).toISOString()]);
  const ads = await adsFor(channelId);
  const slate = ads.policy.slateAssetId ? await one<any>(`SELECT id, master_key, duration_ms FROM vod_assets WHERE id = $1`, [ads.policy.slateAssetId]) : null;
  const masters = new Map<string, string | null>();
  if (ads.house.length) {
    for (const r of await query<any>(`SELECT id, master_key FROM vod_assets WHERE id = ANY($1::uuid[])`, [ads.house.map((h) => h.assetId)])) masters.set(String(r.id), r.master_key);
  }
  const fillOf = (plan: PodPlan): TimelineFill[] => plan.items.map((i) =>
    i.kind === 'slate' ? { kind: 'slate', assetId: breakFill?.id ?? null, master: breakFill?.master_key ?? null, durationSec: i.durationSec }
      : i.kind === 'house' ? { kind: 'house', assetId: i.assetId, master: masters.get(i.assetId) ?? null, durationSec: i.durationSec, title: i.title }
      : { kind: 'ad', assetId: i.assetId, master: null, durationSec: i.durationSec });

  // The brand: ident and loop media, looked up once for the window.
  const brand = ads.brand;
  const brandMasters = new Map<string, string | null>();
  const brandIds = [...brand.idents.map((i) => i.assetId), ...(brand.loopAssetId ? [brand.loopAssetId] : [])];
  if (brandIds.length) {
    for (const r of await query<any>(`SELECT id, master_key FROM vod_assets WHERE id = ANY($1::uuid[])`, [brandIds])) brandMasters.set(String(r.id), r.master_key);
  }
  // The loop fills gaps whenever one is set, idents or not (a brand loop, or a
  // loop from Loops & Fillers: fillerBridge.ts). With breaksUseLoop it also
  // plays where an ad break would show the slate.
  const loop = brand.loopAssetId && brandMasters.get(brand.loopAssetId) ? { assetId: brand.loopAssetId, master: brandMasters.get(brand.loopAssetId) ?? null } : null;
  const breakFill = ads.filler.breaksUseLoop && loop ? { id: loop.assetId, master_key: loop.master } : slate;
  // IDENT ROTATION, strictly in turn and the same on every read: each gap's
  // ident comes from its programme's ordinal within its UTC day (counted once
  // for the first day in the window; the window is contiguous, so a day that
  // starts inside it starts at 0). Not from the position in this window, which
  // moves with every read the playout makes.
  const gapFill = (sec: number, i: number, identIndex: number): TimelineFill[] =>
    brandedFill(sec, identIndex, brand, (left) => fillOf(houseFill(left, SEGMENT_SEC, ads.house, i)), loop)
      .map((f) => (f.kind === 'ident' ? { ...f, master: brandMasters.get(String(f.assetId)) ?? null } : f));

  const items: TimelineItem[] = [];
  let breakIndex = 0;
  let dayKey = '', ordinal = 0;
  for (const p of progs) {
    const start = new Date(p.starts_at).getTime();
    const dk = new Date(start).toISOString().slice(0, 10);
    if (dk !== dayKey) {
      ordinal = dayKey === '' && brand.mode !== 'off'
        ? Number((await one<any>(`SELECT count(*)::int AS n FROM programmes WHERE channel_id = $1 AND status <> 'cancelled' AND starts_at >= $2 AND starts_at < $3`,
          [channelId, `${dk}T00:00:00.000Z`, new Date(start).toISOString()]))?.n ?? 0)
        : 0;
      dayKey = dk;
    }
    const identIndex = ordinal++;
    const md = p.metadata ?? {};
    const contentSec = Number(md.contentSec ?? (p.duration_ms ? p.duration_ms / 1000 : (new Date(p.ends_at).getTime() - start) / 1000));
    const mine = brks.filter((b) => b.programme_id === p.id).sort((a, b) => +new Date(a.starts_at) - +new Date(b.starts_at));
    let t = start, at = 0;
    const push = (it: TimelineItem) => { items.push(it); };
    for (const b of mine) {
      const bAt = Number(b.at_asset_ms ?? 0) / 1000;
      if (bAt > at) {
        push({ kind: 'content', id: `${p.id}:${at}`, start: new Date(t).toISOString(), durationSec: bAt - at, assetId: md.vodAssetId, master: p.master_key, inSec: at, outSec: bAt, title: p.title });
        t += (bAt - at) * 1000; at = bAt;
      }
      const dur = Number(b.duration_ms) / 1000;
      const plan = houseFill(dur, SEGMENT_SEC, ads.house, breakIndex++);
      const pts = Math.round(bAt * 90000);
      push({
        kind: 'break', id: b.id, start: new Date(b.starts_at).toISOString(), durationSec: dur, position: b.position,
        scte35Out: toHex(spliceInsert({ eventId: Number(b.scte_event_id ?? eventIdFor(b.id)), out: true, pts, durationSec: dur })),
        scte35In: toHex(spliceInsert({ eventId: Number(b.scte_event_id ?? eventIdFor(b.id)), out: false, pts: pts + Math.round(dur * 90000) })),
        eventId: Number(b.scte_event_id ?? eventIdFor(b.id)), hideGraphics: b.hide_graphics !== false, fill: fillOf(plan),
      });
      t = new Date(b.starts_at).getTime() + dur * 1000;
    }
    if (contentSec > at) {
      push({ kind: 'content', id: `${p.id}:${at}`, start: new Date(t).toISOString(), durationSec: contentSec - at, assetId: md.vodAssetId, master: p.master_key, inSec: at, outSec: contentSec, title: p.title });
      t += (contentSec - at) * 1000;
    }
    const end = new Date(p.ends_at).getTime();
    if (end - t > 500) {
      push({ kind: 'filler', id: `${p.id}:pad`, start: new Date(t).toISOString(), durationSec: (end - t) / 1000, fill: gapFill((end - t) / 1000, breakIndex++, identIndex) });
    }
  }
  // THE CHANNEL'S LADDER (ladder.ts): every asset plays its packaging for the
  // ladder where it has one, and the playout takes its tracks from the ladder
  // instead of from whichever asset came first. An asset not packaged yet keeps
  // its own encode (prepare.ts is queuing it) rather than going silent.
  const { ladderMasters } = await import('./ladder');
  const used: string[] = [];
  for (const it of items) {
    if (it.kind === 'content' && it.assetId) used.push(String(it.assetId));
    if (it.kind !== 'content') for (const f of it.fill) if (f.assetId) used.push(String(f.assetId));
  }
  const lm = await ladderMasters(channelId, used);
  if (lm.ladder) {
    const roleOf = (f: TimelineFill): Role => (f.assetId && f.assetId === brand.loopAssetId ? 'loop' : f.kind === 'ad' ? 'house' : f.kind);
    for (const it of items) {
      if (it.kind === 'content') it.master = lm.masterFor(String(it.assetId), 'content') ?? it.master;
      else for (const f of it.fill) if (f.assetId && f.master) f.master = lm.masterFor(String(f.assetId), roleOf(f)) ?? f.master;
    }
  }
  const ladder = lm.ladder ? { groupId: lm.ladder.groupId, name: lm.ladder.groupName, segmentSeconds: lm.ladder.segmentSeconds, fps: lm.ladder.fps, rungs: lm.ladder.rungs } : null;
  return { channelId, segmentSec: SEGMENT_SEC, from: from.toISOString(), to: to.toISOString(), adsMode: ads.mode, ladder, items };
}

// ---------------------------------------------------------------- decisions

export interface DecideInput {
  channelId: string;
  breakId: string;
  sessionId: string;
  ctx?: Partial<TagContext>;
  fetcher?: Fetcher;
}

/** The plain HTTP fetch the ad decisions use (on-demand ads reuse it). */
export const defaultFetcher: Fetcher = async (url, timeoutMs) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { accept: 'application/xml, text/xml' } });
    return { status: r.status, body: await r.text() };
  } finally { clearTimeout(t); }
};

/** Decide one break: ask the ad server (within its budget), then fill. Logged; never throws for an ad server fault. */
export async function decideBreak(i: DecideInput): Promise<PodPlan & { breakId: string; elapsedMs: number }> {
  const b = await one<any>(`SELECT b.*, p.title AS programme_title, p.metadata AS pmeta FROM stream_breaks b LEFT JOIN programmes p ON p.id = b.programme_id WHERE b.id = $1 AND b.channel_id = $2`, [i.breakId, i.channelId]);
  if (!b) throw new Error('break not found');
  const ads = await adsFor(i.channelId);
  const breakSec = Number(b.duration_ms) / 1000;
  const acct = await one<any>(`SELECT g.account_id, COALESCE(c.fast_media, 'video') AS media FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id = $1`, [i.channelId]);
  const media: 'video' | 'audio' = acct?.media === 'audio' ? 'audio' : 'video';
  const breakIndex = Number((await one<any>(`SELECT count(*)::int AS n FROM stream_breaks WHERE channel_id = $1 AND starts_at < $2`, [i.channelId, b.starts_at]))?.n ?? 0);
  let serverProblem: 'timeout' | 'error' | null = null;
  let vastAds: any[] = [];
  let problems: any[] = [];
  let elapsedMs = 0, requests = 0;
  const server = ads.mode === 'stitched' && ads.adServerId ? await one<any>(`SELECT * FROM ad_servers WHERE id = $1 AND enabled`, [ads.adServerId]) : null;
  if (server) {
    const tag = expandTag(server.tag_template, {
      sessionId: i.sessionId, breakId: b.id, breakIndex, durationSec: breakSec, channelId: i.channelId,
      contentId: b.pmeta?.vodAssetId ?? null, contentTitle: b.programme_title ?? null, series: b.pmeta?.series ?? null,
      ...i.ctx,
      // pod shape and placement for the ad server ([POD_MAX_ADS], [MAX_AD_DURATION], [BREAK_POSITION])
      extra: {
        POD_MAX_ADS: String(ads.policy.podMaxAds || ''), MAX_AD_DURATION: String(ads.policy.maxAdSec || ''),
        // what the inventory is: [MEDIA_TYPE] / [AD_TYPE] = audio or video, so one ad server can serve both kinds of channel
        MEDIA_TYPE: media, AD_TYPE: media, INVENTORY_TYPE: media === 'audio' ? 'audio_streaming' : 'ctv',
        BREAK_POSITION: b.position === 'end' ? 'between' : 'mid',
        ...((i.ctx as any)?.extra ?? {}),
      },
    });
    const r = await resolveVast(tag, i.fetcher ?? defaultFetcher, { budgetMs: server.timeout_ms, maxDepth: server.max_wrappers });
    vastAds = r.ads; problems = r.problems; elapsedMs = r.elapsedMs; requests = r.requests;
    if (!r.ads.length && r.problems.some((p) => p.code === 301)) serverProblem = 'timeout';
    else if (!r.ads.length && r.problems.length) serverProblem = 'error';
  }
  // the conditioning cache
  const keys = vastAds.map((a) => a.creativeKey);
  const cache = keys.length ? await query<any>(
    `SELECT c.creative_key, c.vod_asset_id, v.duration_ms, v.master_key FROM ad_creatives c LEFT JOIN vod_assets v ON v.id = c.vod_asset_id
      WHERE c.account_id = $1 AND c.creative_key = ANY($2::text[])`, [acct.account_id, keys]) : [];
  const ready = new Map(cache.filter((c) => c.master_key && c.duration_ms).map((c) => [c.creative_key, { assetId: String(c.vod_asset_id), durationSec: Number(c.duration_ms) / 1000 }]));
  const plan = fillBreak({ breakSec, segmentSec: SEGMENT_SEC, ads: vastAds, conditioned: (k) => ready.get(k) ?? null, house: ads.house, breakIndex, serverProblem, adsOff: ads.mode !== 'stitched',
    maxAds: ads.policy.podMaxAds || undefined, maxAdSec: ads.policy.maxAdSec || undefined,
    separate: (ad) => (ad.advertiser ? `adv:${ad.advertiser.toLowerCase()}` : ad.categories?.length ? `cat:${ad.categories[0].toLowerCase()}` : null) });
  // remember every creative we were offered; queue the ones not yet packaged
  for (const a of vastAds) {
    await query(
      `INSERT INTO ad_creatives (account_id, creative_key, source_url, ad_system, title, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (account_id, creative_key) DO UPDATE SET last_seen_at = now()`,
      [acct.account_id, a.creativeKey, bestSource(a, media), a.adSystem ?? null, a.title ?? null, Math.round(a.durationSec * 1000)]).catch(() => null);
  }
  if (plan.toCondition.length) {
    const { enqueue } = await import('../jobs/queue');
    for (const c of plan.toCondition) {
      await enqueue({ type: 'ad.condition', payload: { accountId: acct.account_id, creativeKey: c.creativeKey, channelId: i.channelId }, dedupeKey: `adcond:${acct.account_id}:${c.creativeKey}`, channelId: i.channelId }).catch(() => null);
    }
  }
  for (const it of plan.items) if (it.kind === 'ad') await query(`UPDATE ad_creatives SET plays = plays + 1 WHERE account_id = $1 AND creative_key = $2`, [acct.account_id, it.creativeKey]).catch(() => null);
  await query(
    `INSERT INTO ad_decisions (channel_id, break_id, session_id, ad_server_id, elapsed_ms, requests, break_ms, ad_ms, house_ms, slate_ms, fallback, problems)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [i.channelId, b.id, i.sessionId, server?.id ?? null, Math.round(elapsedMs), requests, Math.round(breakSec * 1000), Math.round(plan.adSec * 1000),
     Math.round(plan.houseSec * 1000), Math.round(plan.slateSec * 1000), plan.fallback, JSON.stringify(problems.map((p) => ({ code: p.code, message: p.message })))]).catch(() => null);
  return { ...plan, breakId: b.id, elapsedMs };
}

/** Fill rate and fallbacks per channel over a window, for the console. */
export async function adReport(channelId: string, since: Date) {
  const r = await one<any>(
    `SELECT count(*)::int AS decisions,
            COALESCE(sum(break_ms), 0)::bigint AS break_ms, COALESCE(sum(ad_ms), 0)::bigint AS ad_ms,
            COALESCE(sum(house_ms), 0)::bigint AS house_ms, COALESCE(sum(slate_ms), 0)::bigint AS slate_ms,
            count(*) FILTER (WHERE fallback = 'ad-server-timeout')::int AS timeouts,
            count(*) FILTER (WHERE fallback = 'ad-server-error')::int AS errors,
            count(*) FILTER (WHERE fallback = 'no-ads')::int AS empty,
            count(*) FILTER (WHERE fallback = 'not-conditioned')::int AS not_conditioned,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY elapsed_ms) AS p95_ms
       FROM ad_decisions WHERE channel_id = $1 AND created_at >= $2`, [channelId, since.toISOString()]);
  const breakMs = Number(r?.break_ms ?? 0);
  return {
    decisions: r?.decisions ?? 0,
    fillRate: breakMs ? Math.round((Number(r.ad_ms) / breakMs) * 1000) / 1000 : null,
    houseShare: breakMs ? Math.round((Number(r.house_ms) / breakMs) * 1000) / 1000 : null,
    slateShare: breakMs ? Math.round((Number(r.slate_ms) / breakMs) * 1000) / 1000 : null,
    timeouts: r?.timeouts ?? 0, errors: r?.errors ?? 0, empty: r?.empty ?? 0, notConditioned: r?.not_conditioned ?? 0,
    p95Ms: r?.p95_ms != null ? Math.round(Number(r.p95_ms)) : null,
  };
}
