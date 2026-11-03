// ============================================================================
//  trickplay.build: the I-frame playlists of an on-demand asset (build queue
//  3.2b, services/trickplay). Queued by frames.index after every build when
//  the asset's switch is on, and by the first master served with the switch on
//  and nothing made. Reads box headers only; nothing is decoded or encoded.
// ============================================================================
import { registerHandler, type JobContext } from '../worker';
import { buildAssetTrickPlay } from '../../trickplay/store';

async function handle(ctx: JobContext): Promise<Record<string, unknown>> {
  const id = String((ctx.job.payload as any)?.vodAssetId ?? '');
  if (!id) return {};
  await ctx.progress(5, 'reading the segments');
  const r = await buildAssetTrickPlay(id);
  await ctx.progress(100, r.state === 'ready' ? `${r.renditions} I-frame playlist(s)` : (r.note ?? r.state));
  return { ...r };
}

/** trickplay.ladder: the DASH trick track of a packaged asset a FAST channel airs (3.2b-6, trickplay/ladder.ts). */
async function handleLadder(ctx: JobContext): Promise<Record<string, unknown>> {
  const key = String((ctx.job.payload as any)?.masterKey ?? '');
  if (!key) return {};
  await ctx.progress(5, 'making the trick track');
  const { buildLadderTrick } = await import('../../trickplay/ladder');
  const r = await buildLadderTrick(key);
  await ctx.progress(100, r.state === 'exists' ? 'already made' : `${r.trick.segments} trick segments`);
  return { state: r.state, segments: r.trick.segments, rep: r.trick.rep };
}

export function registerTrickPlayHandlers(): void {
  registerHandler('trickplay.build', handle);
  registerHandler('trickplay.ladder', handleLadder);
}
