// ============================================================================
//  JOB HANDLER: ad.condition
//
//  An ad server's creative arrives as an MP4 (or a Mezzanine) at whatever size,
//  frame rate and loudness the advertiser's agency exported. A FAST channel is
//  stitched at the manifest level, so a creative can only play once it is on
//  the channel's own ladder: same renditions, same segment length, CMAF. This
//  job does that ONCE per creative (keyed by its Universal Ad ID):
//    download -> a vod_asset (metadata.kind = 'ad', hidden from the library)
//    -> the ordinary vod.encode job on the account's ladder.
//  From then on every break and every viewer that is offered the creative
//  plays the same packaged copy from the CDN.
//
//  The first time a creative is offered it is NOT playable (it is skipped and
//  the break fills with the next ad or a house spot). That is how every
//  server-side stitcher behaves; the alternative is waiting on an encode in
//  the middle of a break.
// ============================================================================
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { one, query } from '../../../db';
import { config } from '../../../config';
import { PermanentError, registerHandler, type JobContext } from '../worker';

export const AD_CONDITION = 'ad.condition';

export interface AdConditionPayload { accountId: string; creativeKey: string; channelId?: string }

const MAX_BYTES = 1024 * 1024 * 1024; // a 30 s mezzanine is far below this

export async function handleAdCondition(ctx: JobContext): Promise<Record<string, unknown>> {
  const p = ctx.job.payload as unknown as AdConditionPayload;
  const c = await one<any>(`SELECT * FROM ad_creatives WHERE account_id = $1 AND creative_key = $2`, [p.accountId, p.creativeKey]);
  if (!c) throw new PermanentError('the creative is no longer known', 'gone');
  if (c.status === 'ready' && c.vod_asset_id) return { already: true };
  if (!c.source_url || !/^https?:\/\//i.test(c.source_url)) {
    await query(`UPDATE ad_creatives SET status = 'rejected', error = 'no downloadable media file' WHERE id = $1`, [c.id]);
    throw new PermanentError('the creative has no downloadable media file', 'no_media');
  }
  await query(`UPDATE ad_creatives SET status = 'conditioning', error = NULL WHERE id = $1`, [c.id]);
  await ctx.progress(5, 'downloading the creative');
  const dir = join(config.clips.dir, 'ads', c.id);
  await mkdir(dir, { recursive: true });
  const src = join(dir, 'source.mp4');
  try {
    const r = await fetch(c.source_url);
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
    const len = Number(r.headers.get('content-length') ?? 0);
    if (len > MAX_BYTES) throw new PermanentError('the creative file is too large', 'too_large');
    await pipeline(Readable.fromWeb(r.body as any), createWriteStream(src));
  } catch (e: any) {
    await query(`UPDATE ad_creatives SET status = 'error', error = $2 WHERE id = $1`, [c.id, String(e?.message ?? e).slice(0, 300)]);
    throw e;
  }
  // The asset that holds the packaged copy. Account-owned, marked as an ad so
  // the library, lineups and portals never show it as content.
  const asset = await one<any>(
    `INSERT INTO vod_assets (account_id, source_kind, kind, title, start_epoch_ms, end_epoch_ms, duration_ms, metadata, original_filename)
     VALUES ($1, 'upload', 'clip', $2, 0, $3, $3, $4::jsonb, 'source.mp4') RETURNING id`,
    [p.accountId, c.title || `Ad ${c.creative_key}`, Math.max(1, Number(c.duration_ms ?? 1)),
     JSON.stringify({ kind: 'ad', creativeKey: c.creative_key, adSystem: c.ad_system ?? null, title: c.title ?? null })]);
  await query(`UPDATE ad_creatives SET vod_asset_id = $2 WHERE id = $1`, [c.id, asset.id]);
  const { enqueue } = await import('../queue');
  await enqueue({ type: 'vod.encode', payload: { vodAssetId: asset.id, accountId: p.accountId, sourcePath: src, loudnorm: true }, dedupeKey: `vodenc:${asset.id}`, channelId: p.channelId ?? null });
  return { vodAssetId: asset.id };
}

export function registerAdConditionHandlers(): void { registerHandler(AD_CONDITION, handleAdCondition); }
