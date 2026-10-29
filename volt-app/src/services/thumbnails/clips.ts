// ============================================================================
//  THUMBNAIL VTTs FOR RECORDINGS AND CLIPS, built from the hourly storyboards.
//
//  Nothing is re-rendered. A clip's VTT is the stream's hourly cues for the
//  clip's source ranges, re-timed to start at 0 and stitched in clip order
//  (clip_segments carries the exact mapping for composed clips), pointing at
//  the same sprite sheets the hours use.
// ============================================================================
import { one, query } from '../../db';
import { imageStore } from '../imageStore';
import { buildVtt, type UnitRecord } from './naming';
import { assetSpriteKey, recordSprite } from './spriteStore';
import { sheetUrl, streamInfo, unitsFor } from './builder';

export interface Piece { from: number; to: number; offset: number }

export async function vttForRange(streamId: string, pieces: Piece[]): Promise<{ vtt: string; cues: number; units: UnitRecord[] }> {
  if (!pieces.length) return { vtt: 'WEBVTT\n', cues: 0, units: [] };
  const from = Math.min(...pieces.map((p) => p.from)), to = Math.max(...pieces.map((p) => p.to));
  const units = await unitsFor(streamId, from, to);
  let cues = 0;
  const vtt = buildVtt(units, pieces, (k, v) => { cues++; return sheetUrl(k, v); });
  return { vtt, cues, units };
}

/** The stream and the stream-time pieces of a VOD asset, in clip order. */
export async function clipPieces(vodId: string, accountId?: string): Promise<{ streamId: string; pieces: Piece[]; title: string } | null> {
  const a = await one<any>(
    `SELECT v.id, v.title, v.channel_id, v.event_id, v.start_epoch_ms, v.end_epoch_ms
       FROM vod_assets v
       LEFT JOIN channels c ON c.id = v.channel_id
       LEFT JOIN events e ON e.id = v.event_id
       LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE v.id = $1 AND ($2::uuid IS NULL OR COALESCE(g.account_id, v.account_id) = $2)`, [vodId, accountId ?? null]);
  if (!a) return null;
  const streamId = a.channel_id ?? a.event_id;
  const segs = await query<any>(
    `SELECT source_from_ms, source_to_ms, clip_offset_ms FROM clip_segments WHERE vod_asset_id = $1 ORDER BY ordinal`, [vodId]);
  const pieces: Piece[] = segs.length
    ? segs.map((s) => ({ from: Number(s.source_from_ms), to: Number(s.source_to_ms), offset: Number(s.clip_offset_ms) }))
    : [{ from: Number(a.start_epoch_ms), to: Number(a.end_epoch_ms), offset: 0 }];
  return { streamId, pieces: pieces.filter((p) => p.to > p.from), title: a.title ?? 'clip' };
}

/** The pieces of a recording: one, from its start to its end (or now). */
export async function recordingPieces(recId: string, accountId?: string): Promise<{ streamId: string; pieces: Piece[] } | null> {
  const r = await one<any>(
    `SELECT r.channel_id, r.event_id, r.start_epoch_ms, r.end_epoch_ms
       FROM recordings r
       LEFT JOIN channels c ON c.id = r.channel_id
       LEFT JOIN events e ON e.id = r.event_id
       JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE r.id = $1 AND ($2::uuid IS NULL OR g.account_id = $2)`, [recId, accountId ?? null]);
  if (!r) return null;
  const from = Number(r.start_epoch_ms), to = r.end_epoch_ms ? Number(r.end_epoch_ms) : Date.now();
  return { streamId: r.channel_id ?? r.event_id, pieces: [{ from, to, offset: 0 }] };
}

/**
 * After a clip is built: write its VTT in the asset's sprite folder
 * (derived/{account}/sprites/assets/{asset}/thumbs.vtt, spriteStore.ts) and
 * point the asset at it, with the still nearest its start as the poster.
 * Best effort; the API serves a fresh VTT on request either way.
 */
export async function writeClipThumbnails(vodId: string): Promise<{ vttKey: string | null; cues: number }> {
  const c = await clipPieces(vodId);
  if (!c || !c.pieces.length) return { vttKey: null, cues: 0 };
  const s = await streamInfo(c.streamId);
  if (!s) return { vttKey: null, cues: 0 };
  const { vtt, cues } = await vttForRange(c.streamId, c.pieces);
  if (!cues) return { vttKey: null, cues: 0 };
  const vttKey = assetSpriteKey(s.accountId, vodId, 'thumbs.vtt');
  await imageStore().put(vttKey, Buffer.from(vtt), 'text/vtt');
  await recordSprite({ accountId: s.accountId, ownerKind: 'asset', kind: 'vtt', storeKey: vttKey, vodAssetId: vodId, sizeBytes: Buffer.byteLength(vtt) });
  const first = c.pieces[0].from;
  const poster = await one<{ store_key: string }>(
    `SELECT store_key FROM media_files WHERE channel_id = $1 AND source = 'encoder' AND kind = 'keyframe'
        AND captured_at BETWEEN $2 AND $3 ORDER BY abs(extract(epoch FROM captured_at - $4)) LIMIT 1`,
    [c.streamId, new Date(first - 120_000), new Date(first + 120_000), new Date(first)]);
  const firstSheet = vtt.match(/\n(https?:[^#\n]+|\/img\/[^#\n]+)#xywh/)?.[1] ?? null;
  await query(
    `UPDATE vod_assets SET thumbs_vtt_key = $2, storyboard_key = COALESCE($3, storyboard_key),
       poster_key = COALESCE(poster_key, $4), thumb_status = 'ready', updated_at = now() WHERE id = $1`,
    [vodId, vttKey, firstSheet, poster?.store_key ?? null]);
  return { vttKey, cues };
}
