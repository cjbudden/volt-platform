// ============================================================================
//  A FAST CHANNEL'S LADDER, AND EVERY ASSET PACKAGED TO IT.
//
//  WHY. The playout writes one live playlist per rung (v1080.m3u8, v720.m3u8,
//  audio.m3u8) and fills each from the assets' own segments. It took its rungs
//  from the FIRST asset and, for every other asset, the nearest height it had.
//  So a channel whose first film was encoded 1080/720/480 and whose second was
//  720/480 (a smaller source, or a wide film whose 800-line height dropped the
//  1080 rung) served 720p segments under a 1080p RESOLUTION and CODECS line:
//  players stalled or switched badly at every splice. Nothing told anyone.
//
//  WHAT NOW.
//    * The channel has a ladder: an encode ladder group (channels.
//      fast_ladder_group_id), the account's default when none is chosen.
//    * Every asset on it is packaged to exactly that ladder. When the asset's
//      own encode already is (same rungs, same segment length, splice-aligned,
//      16:9) that encode is used and recorded; otherwise a VARIANT is encoded
//      beside it from the source, every rung, letterboxed or pillarboxed into
//      the rung's 16:9 box so each rung is the same picture size on every
//      asset. The asset's own encode is never touched.
//    * vod_asset_ladders records which ladders each asset is packaged to, so
//      a second channel on the same ladder reuses it.
//    * The timeline hands the playout the channel's ladder and each asset's
//      master for it; the playout's tracks are the ladder's.
//    * The library offers a channel only sources at or above its top rung
//      (height, or width for a film wider than 16:9, and bitrate), so a
//      channel is not built from media that cannot fill its top rung.
//
//  All of it runs behind the scenes: adding a title, a house spot, the slate
//  or an ident queues what is missing (prepare.ts), and the On air tab says
//  what is being prepared.
// ============================================================================
import { one, query } from '../../db';
import { loadLadder, resolveLadderFor, NoLadderError } from '../encode/store';
import { boxWidth, type ResolvedLadder } from '../encode/ladder';

/** A rung of a FAST ladder: its 16:9 box and bitrate. */
export interface FastRung { height: number; width: number; bitrate_kbps: number }

export interface ChannelLadder {
  groupId: string;
  groupName: string;
  /** Highest first. */
  rungs: FastRung[];
  segmentSeconds: number;
  fps: number;
  packaging: 'hls' | 'dash' | 'both';
  codecBackend: 'x264' | 'nvenc';
  /** 'box': titles ingested with this ladder already have these sizes, so they air without another encode. */
  frameMode: 'scale' | 'box';
  /** True when the channel names no ladder and uses the account default. */
  inherited: boolean;
}

/** The 16:9 box for a rung height (shared with the encode ladder's fixed sizes). */
export { boxWidth };

export function toChannelLadder(l: ResolvedLadder, inherited: boolean): ChannelLadder {
  return {
    groupId: l.groupId, groupName: l.groupName,
    rungs: l.rungs.map((r) => ({ height: r.height, width: boxWidth(r.height), bitrate_kbps: r.bitrate_kbps })),
    segmentSeconds: l.segmentSeconds, fps: l.fps, packaging: l.packaging, codecBackend: l.codecBackend, frameMode: l.frameMode, inherited,
  };
}

/** The account's ladders as a channel would use them, for the picker. Unusable ones (no rungs) are left out. */
export async function fastLadders(accountId: string): Promise<(ChannelLadder & { isDefault: boolean })[]> {
  const groups = await query<any>(`SELECT id, is_default FROM encode_ladder_groups WHERE account_id = $1 ORDER BY is_default DESC, name`, [accountId]);
  const out: (ChannelLadder & { isDefault: boolean })[] = [];
  for (const g of groups) {
    try { out.push({ ...toChannelLadder(await loadLadder(g.id, accountId), false), isDefault: !!g.is_default }); } catch { /* a group with no rungs cannot carry a channel */ }
  }
  return out;
}

/** The channel's ladder: its own, else the account default; null when neither resolves (or an audio channel). */
export async function channelLadder(channelId: string): Promise<ChannelLadder | null> {
  const ch = await one<any>(
    `SELECT c.fast_ladder_group_id, COALESCE(c.fast_media, 'video') AS media, g.account_id
       FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id = $1`, [channelId]);
  if (!ch || ch.media === 'audio') return null;
  try {
    if (ch.fast_ladder_group_id) return toChannelLadder(await loadLadder(ch.fast_ladder_group_id, ch.account_id), false);
    return toChannelLadder(await resolveLadderFor(ch.account_id, null), true);
  } catch (e) {
    if (e instanceof NoLadderError || /no rungs|no renditions|not found/.test(String((e as any)?.message))) return null;
    throw e;
  }
}

// ---------------------------------------------------------------- the source

/** What a source can carry: its picture size and video bitrate. Absent means not measured. */
export interface SourceQuality { width: number | null; height: number | null; kbps: number | null; codec?: string | null }

/**
 * BITRATE IS COMPARED AS H.264. The ladder's rates are H.264 rates; a VP9, HEVC
 * or AV1 source carries the same picture in far fewer bits, so its rate is
 * scaled up before it is compared (conservative figures: a 3.2 Mb/s VP9 file is
 * taken as about 5 Mb/s of H.264). Intra / mezzanine codecs (ProRes, DNxHD,
 * FFV1...) always clear the bar. Unknown codecs are taken at face value.
 */
const CODEC_GAIN: Record<string, number> = { h264: 1, avc: 1, avc1: 1, hevc: 1.6, h265: 1.6, hvc1: 1.6, hev1: 1.6, vp9: 1.6, av1: 2, vp8: 1.1, mpeg2video: 0.7, mpeg4: 0.8, theora: 0.9 }
const MEZZANINE = /^(prores|dnxhd|dnxhr|ffv1|rawvideo|v210|mjpeg|jpeg2000|cineform|cfhd|huffyuv|utvideo)/i
const codecName = (c?: string | null) => (c ? ({ h264: 'H.264', hevc: 'HEVC', vp9: 'VP9', av1: 'AV1', vp8: 'VP8', mpeg2video: 'MPEG-2', mpeg4: 'MPEG-4', theora: 'Theora' } as Record<string, string>)[c.toLowerCase()] ?? c.toUpperCase() : null)

const pos = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

/** From the asset row (ingest.probe, else the encode's own probe). */
export function sourceQuality(r: { ingest?: any; encode_result?: any; top_height?: number | null }): SourceQuality {
  const p = r.ingest?.probe ?? null;
  const v = p?.video ?? null;
  const ep = r.encode_result?.probe ?? null;
  const width = pos(v?.width) ?? pos(ep?.width);
  const height = pos(v?.height) ?? pos(ep?.height) ?? pos(r.top_height);
  // The video stream's own bitrate; a container that does not say (MKV, WebM)
  // gives the file's overall rate less its audio.
  let kbps = pos(v?.bitrateKbps);
  if (kbps == null && pos(p?.bitrateKbps) != null) {
    const audio = (Array.isArray(p?.audioTracks) ? p.audioTracks : []).reduce((s: number, t: any) => s + (pos(t?.bitrateKbps) ?? 0), 0);
    kbps = pos(Number(p.bitrateKbps) - audio);
  }
  const codec = (v?.codec ?? ep?.videoCodec ?? null) ? String(v?.codec ?? ep?.videoCodec).toLowerCase() : null;
  return { width, height, kbps, codec };
}

export type Fit = 'ok' | 'below' | 'unmeasured';
/** A little slack: a measured VBR rate and a nominal rung rate are not exact. */
const BITRATE_SLACK = 0.95;

/**
 * Can this source fill the ladder's top rung? Its picture is at least the
 * rung's (by height, or by width for a film wider than 16:9: a 1920x800 scope
 * film is a 1080p source) and its bitrate at least the rung's. A bitrate that
 * was never measured does not hide a title; it is said so.
 */
export function fitToTop(q: SourceQuality, top: FastRung | null | undefined): { fit: Fit; why: string | null } {
  if (!top) return { fit: 'ok', why: null };
  if (q.height == null && q.width == null) return { fit: 'unmeasured', why: 'the source picture size was never measured' };
  const bigEnough = (q.height != null && q.height >= top.height) || (q.width != null && q.width >= Math.round(top.width * 0.98));
  if (!bigEnough) return { fit: 'below', why: `its picture, ${q.width ?? '?'}x${q.height ?? '?'}, is smaller than the ${top.height}p top rendition` };
  if (q.codec && MEZZANINE.test(q.codec)) return { fit: 'ok', why: null };
  const gain = q.codec ? CODEC_GAIN[q.codec] ?? 1 : 1;
  if (q.kbps != null && q.kbps * gain < top.bitrate_kbps * BITRATE_SLACK) {
    const as = gain !== 1 ? ` ${codecName(q.codec)} (about ${fmtKbps(Math.round(q.kbps * gain))} as H.264)` : '';
    return { fit: 'below', why: `its bitrate, ${fmtKbps(q.kbps)}${as}, is below the ${top.height}p top rendition's ${fmtKbps(top.bitrate_kbps)}` };
  }
  if (q.kbps == null) return { fit: 'unmeasured', why: 'the source bitrate was never measured' };
  return { fit: 'ok', why: null };
}

export const fmtKbps = (k: number) => (k >= 1000 ? `${(k / 1000).toFixed(k % 1000 ? 1 : 0)} Mb/s` : `${Math.round(k)} kb/s`);

// ---------------------------------------------------------------- per asset

export type Role = 'content' | 'house' | 'slate' | 'ident' | 'loop';

/** What a role needs from its packaging: the slate and loop are cut in 1 s segments; spots, idents and the loop at broadcast loudness. */
export function needFor(role: Role, ladder: ChannelLadder): { segmentSeconds: number; loudnorm: boolean } {
  return {
    segmentSeconds: role === 'slate' || role === 'loop' ? 1 : ladder.segmentSeconds,
    loudnorm: role === 'house' || role === 'ident' || role === 'loop',
  };
}

/** Where a variant lives under the asset's folder. */
export function variantRel(groupId: string, segmentSeconds: number, loudnorm: boolean): string {
  return `ladders/${groupId}/${Number(segmentSeconds)}s${loudnorm ? '-loud' : ''}`;
}

/**
 * Does the asset's own encode already carry this ladder? Same rungs (height
 * and bitrate), same segment length and frame rate, splice-aligned, loudness
 * when asked, and a 16:9 picture (any other shape was scaled to its own width,
 * so its rungs are not the ladder's picture sizes).
 */
export function mainMatches(r: { master_key?: string | null; encode_result?: any; ingest?: any }, ladder: ChannelLadder, need: { segmentSeconds: number; loudnorm: boolean }): boolean {
  const er = r.encode_result;
  if (!r.master_key || !er || er.zeroStart !== true) return false;
  if (need.loudnorm && er.loudnorm !== true) return false;
  if (Number(er.segmentSeconds) !== Number(need.segmentSeconds)) return false;
  if (er.fps != null && Math.abs(Number(er.fps) - ladder.fps) > 0.01) return false;
  const kept: { height: number; bitrate_kbps: number }[] = Array.isArray(er.kept) ? er.kept : [];
  const key = (x: { height: number; bitrate_kbps: number }) => `${Number(x.height)}@${Number(x.bitrate_kbps)}`;
  const a = kept.map(key).sort().join(','), b = ladder.rungs.map(key).sort().join(',');
  if (a !== b) return false;
  // encoded at fixed sizes (a 'box' ladder at ingest): every rung is the ladder's picture size
  if (er.frame === 'box') return true;
  const q = sourceQuality(r);
  if (q.width == null || q.height == null) return false;
  return Math.abs(q.width / q.height - 16 / 9) < 0.01;
}

/** A ready packaging made for an older version of the ladder (renditions or frame rate changed since). */
export function isStale(v: VariantRow, ladder: ChannelLadder): boolean {
  const rungs: { height: number; bitrate_kbps: number }[] = Array.isArray(v.rungs) ? v.rungs : [];
  if (!rungs.length) return false;   // rows from before the rungs were recorded
  const key = (x: { height: number; bitrate_kbps: number }) => `${Number(x.height)}@${Number(x.bitrate_kbps)}`;
  if (rungs.map(key).sort().join(',') !== ladder.rungs.map(key).sort().join(',')) return true;
  return (v as any).fps != null && Math.abs(Number((v as any).fps) - ladder.fps) > 0.01;
}

/** The FAST channels on this ladder: named on the channel, or by default (no ladder named and it is the account default). */
export async function channelsOnLadder(accountId: string, groupId: string): Promise<{ id: string; name: string; inherited: boolean }[]> {
  return (await query<any>(
    `SELECT c.id, c.name, (c.fast_ladder_group_id IS NULL) AS inherited
       FROM channels c JOIN groups g ON g.id = c.group_id
      WHERE g.account_id = $1 AND c.origin = 'playlist' AND COALESCE(c.fast_media, 'video') = 'video'
        AND (c.fast_ladder_group_id = $2
             OR (c.fast_ladder_group_id IS NULL AND EXISTS (SELECT 1 FROM encode_ladder_groups d WHERE d.id = $2 AND d.is_default)))
      ORDER BY c.name`, [accountId, groupId])).map((r) => ({ id: String(r.id), name: String(r.name), inherited: !!r.inherited }));
}

/** A ladder changed (its renditions, frame rate, sizes or segments): its channels re-package behind the scenes. */
export function ladderChanged(accountId: string, groupId: string): void {
  void (async () => {
    const { prepare } = await import('./prepare');
    for (const c of await channelsOnLadder(accountId, groupId)) await prepare(c.id, { auto: true }).catch(() => null);
  })().catch((e) => console.error('[fast] re-packaging after a ladder change:', e?.message ?? e));
}

export interface VariantRow {
  id: string; vod_asset_id: string; ladder_group_id: string; segment_seconds: string | number; loudnorm: boolean;
  origin: 'main' | 'variant'; state: 'queued' | 'encoding' | 'ready' | 'failed'; master_key: string | null; mpd_key: string | null;
  error: string | null; job_id: string | null; rungs: FastRung[]; notes: string[];
}

export async function variantsOf(assetIds: string[], groupId: string): Promise<VariantRow[]> {
  if (!assetIds.length) return [];
  return query<VariantRow>(`SELECT * FROM vod_asset_ladders WHERE ladder_group_id = $1 AND vod_asset_id = ANY($2::uuid[])`, [groupId, assetIds]);
}

export const sameNeed = (v: VariantRow, need: { segmentSeconds: number; loudnorm: boolean }) =>
  Number(v.segment_seconds) === Number(need.segmentSeconds) && !!v.loudnorm === need.loudnorm;

/** Record that the asset's own encode is this ladder (nothing is encoded). */
export async function recordMain(assetId: string, ladder: ChannelLadder, need: { segmentSeconds: number; loudnorm: boolean }, masterKey: string): Promise<void> {
  await query(
    `INSERT INTO vod_asset_ladders (vod_asset_id, ladder_group_id, segment_seconds, loudnorm, origin, state, rungs, fps, master_key, mpd_key, zero_start)
     VALUES ($1,$2,$3,$4,'main','ready',$5::jsonb,$6,$7,$8,true)
     ON CONFLICT (vod_asset_id, ladder_group_id, segment_seconds, loudnorm)
     DO UPDATE SET origin = 'main', state = 'ready', rungs = EXCLUDED.rungs, fps = EXCLUDED.fps, master_key = EXCLUDED.master_key,
                   mpd_key = EXCLUDED.mpd_key, zero_start = true, error = NULL, updated_at = now()`,
    [assetId, ladder.groupId, need.segmentSeconds, need.loudnorm, JSON.stringify(ladder.rungs), ladder.fps, masterKey, masterKey.replace(/master\.m3u8$/, 'manifest.mpd')]);
}

/** A variant was queued: the row says so until the job writes its result. */
export async function recordQueued(assetId: string, groupId: string, need: { segmentSeconds: number; loudnorm: boolean }, jobId: string | null): Promise<void> {
  await query(
    `INSERT INTO vod_asset_ladders (vod_asset_id, ladder_group_id, segment_seconds, loudnorm, origin, state, job_id)
     VALUES ($1,$2,$3,$4,'variant','queued',$5)
     ON CONFLICT (vod_asset_id, ladder_group_id, segment_seconds, loudnorm)
     DO UPDATE SET origin = 'variant', state = 'queued', job_id = EXCLUDED.job_id, error = NULL, updated_at = now()`,
    [assetId, groupId, need.segmentSeconds, need.loudnorm, jobId]);
}

/**
 * Each asset's master for the channel's ladder, by role, for the timeline.
 * Null when the channel has no ladder (then every asset plays its own encode,
 * as before) or the asset has nothing ready for it yet.
 */
export async function ladderMasters(channelId: string, assetIds: string[]): Promise<{ ladder: ChannelLadder | null; masterFor: (assetId: string, role: Role) => string | null }> {
  const ladder = await channelLadder(channelId);
  if (!ladder || !assetIds.length) return { ladder, masterFor: () => null };
  const rows = (await variantsOf([...new Set(assetIds)], ladder.groupId)).filter((v) => v.state === 'ready' && v.master_key);
  const by = new Map<string, VariantRow[]>();
  for (const v of rows) by.set(String(v.vod_asset_id), [...(by.get(String(v.vod_asset_id)) ?? []), v]);
  return {
    ladder,
    masterFor: (assetId, role) => {
      const list = by.get(String(assetId));
      if (!list?.length) return null;
      const need = needFor(role, ladder);
      // the exact packaging first; any packaging of the ladder beats the asset's own (wrong) rungs
      return (list.find((v) => sameNeed(v, need)) ?? list.find((v) => Number(v.segment_seconds) === need.segmentSeconds) ?? list[0]).master_key;
    },
  };
}
