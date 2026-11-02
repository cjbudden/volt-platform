// ============================================================================
//  frames.index: the frame index of an on-demand asset (services/frames).
//  Queued after every build (clip.extract, vod.encode), by the console when an
//  asset is asked for a frame and has no index, and by the sweep below for
//  media made before indexes existed.
//
//  Cheap: box headers of each segment, no decode, so it never holds a worker
//  for long. A missing or audio-only asset is a state on the row, not a retry.
//
//  The sweep (leader only) also removes frame stills past their TTL.
// ============================================================================
import { registerHandler, type JobContext } from '../worker';
import { enqueue } from '../queue';
import { assetsWithoutFrameIndex, buildAssetFrameIndex, pruneFrameStills } from '../../frames/store';

export const FRAMES_INDEX = 'frames.index';

export async function queueFrameIndex(vodAssetId: string): Promise<void> {
  try {
    await enqueue({
      type: FRAMES_INDEX, payload: { vodAssetId },
      dedupeKey: `frames.index:${vodAssetId}`, priority: 70, maxAttempts: 2,
    });
  } catch (e) {
    console.error(`[frames.index] ${vodAssetId}: not queued:`, e);
  }
}

async function handle(ctx: JobContext): Promise<Record<string, unknown>> {
  const id = String((ctx.job.payload as any)?.vodAssetId ?? '');
  if (!id) return {};
  await ctx.progress(5, 'reading the segments');
  const r = await buildAssetFrameIndex(id);
  await ctx.progress(100, r.state === 'ready' ? `${r.index!.totalFrames} frames` : (r.error ?? r.state));
  return { state: r.state, frames: r.index?.totalFrames ?? null, note: r.error };
}

/** One sweep pass: queue indexes for assets without one, prune old stills. */
export async function sweepFrameIndexes(batch = 20): Promise<{ queued: number; pruned: number }> {
  const ids = await assetsWithoutFrameIndex(batch);
  for (const id of ids) await queueFrameIndex(id);
  const pruned = await pruneFrameStills();
  return { queued: ids.length, pruned };
}

let timer: NodeJS.Timeout | null = null;

export function startFrameIndexSweep(everyMs = 10 * 60_000): void {
  if (timer) return;
  const tick = () => { sweepFrameIndexes().catch((e) => console.error('[frames.index] sweep failed:', e)); };
  setTimeout(tick, 45_000).unref?.();
  timer = setInterval(tick, everyMs); timer.unref?.();
}

export function registerFrameIndexHandlers(): void {
  registerHandler(FRAMES_INDEX, handle);
}
