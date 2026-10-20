// ============================================================================
//  vod.markers: find an on-demand asset's intro and credits against the other
//  episodes of its series (services/vodMarkers.ts). Queued after every build
//  (clip.extract, vod.encode) and by "Detect now" in the console.
//
//  Cheap: audio only, the opening ten and closing seven minutes, a few seconds
//  per episode. Never fails a build: a missing file or an unreadable peer is a
//  note on the asset, not a retry storm.
// ============================================================================
import { registerHandler, type JobContext } from '../worker';
import { enqueue } from '../queue';
import { detectMarkers } from '../../vodMarkers';

export const VOD_MARKERS = 'vod.markers';

export async function queueMarkerDetection(vodAssetId: string, extra: { channelId?: string | null; eventId?: string | null } = {}): Promise<void> {
  try {
    await enqueue({
      type: VOD_MARKERS, payload: { vodAssetId },
      channelId: extra.channelId ?? undefined, eventId: extra.eventId ?? undefined,
      dedupeKey: `vod.markers:${vodAssetId}`, priority: 60, maxAttempts: 2,
    });
  } catch (e) {
    console.error(`[vod.markers] ${vodAssetId}: not queued:`, e);
  }
}

async function handle(ctx: JobContext): Promise<void> {
  const id = String((ctx.job.payload as any)?.vodAssetId ?? '');
  if (!id) return;
  await ctx.progress(5, 'comparing with the series');
  const r = await detectMarkers(id);
  await ctx.progress(100, r.note);
}

export function registerVodMarkerHandlers(): void {
  registerHandler(VOD_MARKERS, handle);
}
