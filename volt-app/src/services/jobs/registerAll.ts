// ============================================================================
//  Every job handler, registered in one place.
//
//  Two processes need the same list: the control plane's worker (index.ts)
//  and, on AWS, the media-jobs task that runs one media job and exits
//  (tools/run-media-job.ts, build queue 2.1a-4). Keeping one list means a new
//  handler cannot be added to one and forgotten in the other.
// ============================================================================
import { registerClipHandlers } from './handlers/clipExtract';
import { registerQcHandlers } from './handlers/qcRun';
import { registerVodEncodeHandlers } from './handlers/vodEncode';
import { registerVodMarkerHandlers } from './handlers/vodMarkers';
import { registerVodImageHandlers } from './handlers/vodImage';
import { registerRemoteIngestHandlers } from './handlers/remoteIngest';
import { registerFillerHandlers } from '../fillerPrep';

export async function registerAllJobHandlers(): Promise<void> {
  // Handlers are registered BEFORE the worker starts polling: the worker only
  // claims types it can handle, so an unregistered type would sit queued.
  registerClipHandlers();
  registerQcHandlers();
  registerVodEncodeHandlers();
  (await import('./handlers/adCondition')).registerAdConditionHandlers();
  registerVodMarkerHandlers();
  (await import('./handlers/reframe')).registerReframeHandlers();
  registerVodImageHandlers();
  (await import('./handlers/fillerThumbs')).registerFillerThumbsHandlers();
  (await import('./handlers/songArtwork')).registerSongArtworkHandlers();
  registerRemoteIngestHandlers();
  (await import('./handlers/frameIndex')).registerFrameIndexHandlers();
  (await import('./handlers/trickPlay')).registerTrickPlayHandlers();
  (await import('../archive/recordings')).registerArchiveRecordingHandlers();
  (await import('../workflows/runs')).registerAddonHandlers();
  (await import('../media/postProcess')).registerPostProcessHandlers();
  await registerFillerHandlers();
  await (await import('../social')).registerSocialHandlers();
}
