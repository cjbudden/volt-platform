// ============================================================================
//  filler.thumbs: a slate or loop's thumbnail, frames and sprite sheets
//  (services/media/fillerThumbs.ts, migration 0120).
//
//  Queued when an upload or a copy from the Image Library makes one ready, from
//  the details page ("Make thumbnails again"), and by the leader sweep for any
//  ready slate or loop without them (watch folder loops, and everything made
//  before thumbnails existed). Low priority: never ahead of encodes or clips.
// ============================================================================
import { registerHandler, type JobContext } from '../worker';
import { enqueue } from '../queue';
import { query } from '../../../db';
import { buildFillerThumbs } from '../../media/fillerThumbs';

export const FILLER_THUMBS = 'filler.thumbs';

export async function queueFillerThumbs(fillerAssetId: string): Promise<void> {
  try {
    await enqueue({ type: FILLER_THUMBS, payload: { fillerAssetId }, dedupeKey: `filler.thumbs:${fillerAssetId}`, priority: 80, maxAttempts: 2 });
  } catch (e) { console.error(`[filler.thumbs] ${fillerAssetId}: not queued:`, e); }
}

async function handle(ctx: JobContext): Promise<void> {
  const id = String((ctx.job.payload as any)?.fillerAssetId ?? '');
  if (!id) return;
  await ctx.progress(10, 'reading the file');
  try {
    const r = await buildFillerThumbs(id);
    await ctx.progress(100, r.frames ? `${r.frames} frames, ${r.sheets} sprite sheet${r.sheets === 1 ? '' : 's'}` : 'thumbnail made');
  } catch (e: any) {
    // Recorded, not retried for ever: the sweep only picks up rows never tried.
    const why = String(e?.message ?? e).slice(0, 300);
    await query(`UPDATE filler_assets SET thumb_status = 'failed', thumb_error = $2, thumbs_at = now() WHERE id = $1`, [id, why]);
    await ctx.progress(100, `failed: ${why}`);
  }
}

/** Ready slates and loops never given thumbnails. */
export async function sweepFillerThumbs(limit = 50): Promise<number> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM filler_assets
      WHERE status = 'ready' AND thumb_status IS NULL AND COALESCE(source_key, '') <> ''
      ORDER BY created_at DESC LIMIT $1`, [limit]);
  for (const r of rows) await queueFillerThumbs(r.id);
  return rows.length;
}

let timer: NodeJS.Timeout | null = null;
/** Leader only: every two minutes, like the asset image sweep. */
export function startFillerThumbsSweep(everyMs = 120_000): void {
  if (timer) return;
  const tick = () => { sweepFillerThumbs().catch((e) => console.error('[filler.thumbs] sweep failed:', e)); };
  setTimeout(tick, 20_000).unref?.();
  timer = setInterval(tick, everyMs); timer.unref?.();
}

export function registerFillerThumbsHandlers(): void {
  registerHandler(FILLER_THUMBS, handle);
}
