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

export function registerTrickPlayHandlers(): void {
  registerHandler('trickplay.build', handle);
}
