// ============================================================================
//  filler.preview: a slate or loop's house preview and its QC
//  (services/media/fillerPreview.ts, migration 0161).
//
//  Queued after its thumbnails (handlers/fillerThumbs.ts), from the details
//  page ("Build the preview again"), and by the leader sweep for any ready
//  slate or loop without one (watch folder and site drops, copies from the
//  Image Library, and everything added before previews existed). Registered
//  and swept from the thumbnails module so the preview follows every path a
//  thumbnail already follows. Low priority: never ahead of encodes or clips.
// ============================================================================
import { registerHandler, type JobContext } from '../worker';
import { enqueue } from '../queue';
import { query } from '../../../db';
import { buildFillerPreview } from '../../media/fillerPreview';

export const FILLER_PREVIEW = 'filler.preview';

export async function queueFillerPreview(fillerAssetId: string): Promise<void> {
  try {
    await query(`UPDATE filler_assets SET preview_status = 'queued', preview_error = NULL WHERE id = $1 AND preview_status IS DISTINCT FROM 'building'`, [fillerAssetId]);
    await enqueue({ type: FILLER_PREVIEW, payload: { fillerAssetId }, dedupeKey: `filler.preview:${fillerAssetId}`, priority: 85, maxAttempts: 2 });
  } catch (e) { console.error(`[filler.preview] ${fillerAssetId}: not queued:`, e); }
}

async function handle(ctx: JobContext): Promise<void> {
  const id = String((ctx.job.payload as any)?.fillerAssetId ?? '');
  if (!id) return;
  await ctx.progress(10, 'building the house preview');
  try {
    const r = await buildFillerPreview(id);
    await ctx.progress(100, r.status === 'ready' ? `preview ready, QC ${r.qc.state}` : `failed: ${r.error}`);
  } catch (e: any) {
    const why = String(e?.message ?? e).slice(0, 300);
    await query(`UPDATE filler_assets SET preview_status = 'failed', preview_error = $2, preview_at = now() WHERE id = $1`, [id, why]);
    await ctx.progress(100, `failed: ${why}`);
  }
}

/** Ready slates and loops never given a house preview. */
export async function sweepFillerPreviews(limit = 20): Promise<number> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM filler_assets
      WHERE status = 'ready' AND preview_status IS NULL AND COALESCE(source_key, '') <> ''
      ORDER BY created_at DESC LIMIT $1`, [limit]);
  for (const r of rows) await queueFillerPreview(r.id);
  return rows.length;
}

export function registerFillerPreviewHandlers(): void {
  registerHandler(FILLER_PREVIEW, handle);
}
