// ============================================================================
//  vod.image: pick the image that represents an asset (services/media/assetImage.ts).
//
//  Queued after an upload's encode (with frames already extracted), from the
//  console ("Pick automatically", "Look up song"), and by the leader sweep for
//  any asset that has never had an image picked, however it was created.
//  Song lookups share MusicBrainz's one-request-a-second budget, so these jobs
//  run at a low priority and never hold up encodes or clips.
// ============================================================================
import { registerHandler, type JobContext } from '../worker';
import { enqueue } from '../queue';
import { query } from '../../../db';
import { pickAssetImage, prepareFileFrames } from '../../media/assetImage';

export const VOD_IMAGE = 'vod.image';

export async function queueAssetImage(vodAssetId: string, opts: { force?: boolean; by?: string; rebuild?: boolean } = {}): Promise<void> {
  try {
    await enqueue({ type: VOD_IMAGE, payload: { vodAssetId, force: !!opts.force, by: opts.by ?? null, rebuild: !!opts.rebuild }, dedupeKey: `vod.image:${vodAssetId}`, priority: 80, maxAttempts: 3 });
  } catch (e) { console.error(`[vod.image] ${vodAssetId}: not queued:`, e); }
}

async function handle(ctx: JobContext): Promise<void> {
  const p = (ctx.job.payload ?? {}) as any;
  if (!p.vodAssetId) return;
  await ctx.progress(10, 'choosing the image');
  try {
    if (await prepareFileFrames(String(p.vodAssetId), { force: !!p.rebuild })) await ctx.progress(50, 'frames and sprite sheets built from the source file');
    const r = await pickAssetImage(String(p.vodAssetId), { force: !!p.force, by: p.by ?? undefined });
    await ctx.progress(100, `${r.source}: ${r.reason}`.slice(0, 300));
  } catch (e: any) {
    // Recorded, not retried: the sweep would otherwise queue it again every two
    // minutes forever. "Pick automatically" in the console tries again.
    await query(`UPDATE vod_assets SET poster_source = COALESCE(poster_source, 'none'), poster_reason = $2, poster_picked_at = now() WHERE id = $1 AND NOT poster_locked`,
      [p.vodAssetId, `Could not pick an image: ${String(e?.message ?? e).slice(0, 200)}`]);
    await ctx.progress(100, `failed: ${String(e?.message ?? e)}`.slice(0, 300));
  }
}

/**
 * Assets nobody has picked an image for. Uploads wait for their encode (their
 * frames come from it); everything else is ready as soon as it exists.
 */
export async function sweepUnpicked(limit = 100): Promise<number> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM vod_assets
      WHERE (poster_source IS NULL
              AND (source_kind IS NULL OR source_kind = 'recording' OR encode_result IS NOT NULL))
         -- a song whose creation lookup could not run (provider busy or down): again after six hours, three tries in all
         OR (NOT poster_locked AND music_lookup ->> 'state' = 'error' AND COALESCE((music_lookup ->> 'attempts')::int, 1) < 3
             AND poster_picked_at < now() - interval '6 hours')
      ORDER BY created_at DESC LIMIT $1`, [limit]);
  for (const r of rows) await queueAssetImage(r.id);
  // Images saved under older names (poster.jpg, poster-<hash>.jpg, 1970-01-01 folders, a file
  // extension in the folder) move to <asset>-<hash>.jpg in the asset's folder, a batch a pass.
  await (await import('../../media/libraryMoves')).tidyAssetImageNames(50).catch((e) => console.warn('[vod.image] image names not tidied', e));
  return rows.length;
}

let timer: NodeJS.Timeout | null = null;
/** Leader only: every two minutes. */
export function startAssetImageSweep(everyMs = 120_000): void {
  if (timer) return;
  const tick = () => { sweepUnpicked().catch((e) => console.error('[vod.image] sweep failed:', e)); };
  setTimeout(tick, 15_000).unref?.();
  timer = setInterval(tick, everyMs); timer.unref?.();
}

export function registerVodImageHandlers(): void {
  registerHandler(VOD_IMAGE, handle);
}
