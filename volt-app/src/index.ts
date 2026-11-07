import { createServer } from './server';
import { config } from './config';
import { pool } from './db';
import { startScheduler } from './services/orchestrator';
import { migrate } from './services/migrate';
import { startWorker } from './services/jobs/worker';
import { registerClipHandlers } from './services/jobs/handlers/clipExtract';
import { registerQcHandlers } from './services/jobs/handlers/qcRun';
import { registerVodEncodeHandlers } from './services/jobs/handlers/vodEncode';
import { registerVodMarkerHandlers } from './services/jobs/handlers/vodMarkers';
import { registerVodImageHandlers, startAssetImageSweep } from './services/jobs/handlers/vodImage';
import { registerFillerHandlers } from './services/fillerPrep';
import { registerRemoteIngestHandlers } from './services/jobs/handlers/remoteIngest';
import { backfillContainers } from './services/containers';
import { reconcileAll } from './services/media/reconcile';
import { reapAllEncoders } from './services/orchestrator/encoderCleanup';
import { stopAllRadio } from './services/radio/pipeline';
import { stopAllFeeds } from './services/radio/mp3Gateway';
import { scaleConfig, runsScheduler, runsWorker } from './scale/config';
import { runAsLeader, type Leadership } from './scale/leader';
import { startScale, stopScale, runsSchemaWork, waitForSchema, withBootLock } from './scale/boot';
import { markBooted, setLeaderCheck } from './scale/health';
import { startPrewarm } from './scale/prewarm';
import { startMetrics } from './scale/metrics';
import { startGraphicsRuntime } from './services/graphics/runtime';
import { ensureSchema } from './services/bootSchema';

const app = createServer();

// BOOT ORDER MATTERS. Migrations run to completion BEFORE anything that reads
// or writes the new tables: the scheduler, the worker and the first request all
// assume the schema they were written against. A failure here is fatal rather
// than logged, because a half-migrated database serving traffic is worse than a
// process that refuses to start.
async function boot(): Promise<void> {
  // ONLY THE SCHEMA-OWNING ROLES MIGRATE. Every ALTER in ensureSchema takes an
  // exclusive lock on its table even when there is nothing to add, so thirty
  // viewer tasks starting together at kick-off would each lock `channels` in
  // turn, in front of the viewers. api-public and worker wait for the schema
  // instead (scale/boot.ts). RUN_MIGRATIONS=true|false overrides.
  if (!runsSchemaWork()) {
    await waitForSchema();
    return;
  }
  await withBootLock(async () => {
    await migrate();
    await ensureSchema();
    // Default admin roles for every account (auth/defaultRoles.ts). Idempotent.
    const n = await (await import('./auth/defaultRoles')).ensureDefaultRoles();
    if (n) console.log(`[access] default roles created or refreshed: ${n}`);
    // Volt's shipped graphics templates (assets/graphics), read-only in every account.
    // Inside the boot lock so two instances starting together add them once.
    await (await import('./services/graphics/defaults')).ensureDefaultTemplates()
      .then((g) => { if (g) console.log(`[graphics] default templates added or updated: ${g}`); })
      .catch((e) => console.error('[graphics] default templates not loaded', e));
  });
  // Give existing recordings their broadcast-day container. Additive and
  // idempotent: it only fills container_id where it is NULL, and no row's
  // day_utc or unique index is touched, so the old roll logic keeps working.
  await backfillContainers().catch((e) => console.error('[containers] backfill failed', e));
  // Register what is on disk into the media lifecycle before anything reads it.
  // Retention governs media_objects, so a deployment that has never reconciled
  // has a ladder pointed at an empty set while the disk fills.
  await reconcileAll({ actor: 'boot' }).catch((e) => console.error('[media] boot reconcile failed', e));
}

const server = app.listen(config.port, () => {
  console.log(`Volt control plane listening on :${config.port} (${config.env}, role ${scaleConfig.role})`);
});

// BOOT CLEANUP: a control-plane (re)start reaps any orphaned encoder/ffmpeg/
// packager from a previous run so nothing is left holding the bus ports. Only
// meaningful for the local/docker launcher; a no-op with mock/ecs.
//
// Done by the SCHEDULER LEADER, not by every process at listen: with several
// processes, a viewer task restarting would otherwise kill every encoder the
// others had started. In a single process (ROLE=all) the leader is this
// process, a moment after boot, which is the old behaviour.
function bootReap(): void {
  if (config.orchestrator.launcher === 'local' || config.orchestrator.launcher === 'docker') {
    try { reapAllEncoders(config.testStream.encoderBin, config.testStream.originDir); }
    catch (e) { console.error('[encoder-cleanup] boot reap failed', e); }
  }
}

// orchestrator background scheduler (event provisioning, recording roll, retention
// sweep) and the job worker, both started only once the schema is in place.
let leadership: Leadership | null = null;
let worker: { stop: () => Promise<void> } | null = null;
boot().then(async () => {
  await startScale();
  markBooted();
  // THE SCHEDULER RUNS IN ONE PROCESS. Every process whose role allows it
  // competes for the leader lock; the winner reaps, reconciles and schedules,
  // the rest stand by and take over if it dies (scale/leader.ts).
  if (runsScheduler()) {
    leadership = runAsLeader('scheduler', 1, () => {
      bootReap();
      const stopSched = startScheduler();
      const stopPrewarm = startPrewarm();
      const stopMetrics = startMetrics();
      // Graphics: feed polling, timed take-offs, rundown cues (services/graphics/runtime.ts).
      const stopGraphics = startGraphicsRuntime();
      // Asset images: queue a pick for every asset that has none yet (services/media/assetImage.ts).
      startAssetImageSweep();
      // Frame indexes for assets made before they existed, and old frame stills (services/frames).
      void import('./services/jobs/handlers/frameIndex').then((m) => m.startFrameIndexSweep()).catch((e) => console.warn('[frames.index] sweep not started', e));
      // Slates and loops: thumbnails, frames and sprites for any without (services/media/fillerThumbs.ts).
      void import('./services/jobs/handlers/fillerThumbs').then((m) => m.startFillerThumbsSweep()).catch((e) => console.warn('[filler.thumbs] sweep not started', e));
      // Uploads held for metadata before the gate stopped holding the media: encode them once.
      void import('./services/ingest/pipeline').then((m) => m.encodeHeldUploads()).catch((e) => console.warn('[ingest] held uploads not checked', e));
      // The workflow report's minute and day rollups (services/workflows/rollup.ts, build queue W1).
      let stopWfRollup = () => {};
      void import('./services/workflows/rollup').then((m) => { stopWfRollup = m.startWorkflowRollup(); }).catch((e) => console.warn('[workflows] report rollup not started', e));
      return () => { stopSched(); stopPrewarm(); stopMetrics(); stopGraphics(); stopWfRollup(); };
    });
    setLeaderCheck(() => !!leadership?.isLeader());
  }
  if (runsWorker()) {
    // Handlers are registered BEFORE the worker starts polling: the worker only
    // claims types it can handle, so an unregistered type would sit queued.
    registerClipHandlers();
    registerQcHandlers();
    registerVodEncodeHandlers();
    (await import('./services/jobs/handlers/adCondition')).registerAdConditionHandlers();
    registerVodMarkerHandlers();
    (await import('./services/jobs/handlers/reframe')).registerReframeHandlers();
    registerVodImageHandlers();
    (await import('./services/jobs/handlers/fillerThumbs')).registerFillerThumbsHandlers();
    (await import('./services/jobs/handlers/songArtwork')).registerSongArtworkHandlers();
    registerRemoteIngestHandlers();
    (await import('./services/jobs/handlers/frameIndex')).registerFrameIndexHandlers();
    (await import('./services/jobs/handlers/trickPlay')).registerTrickPlayHandlers();
    (await import('./services/archive/recordings')).registerArchiveRecordingHandlers();
    (await import('./services/workflows/runs')).registerAddonHandlers();
    await registerFillerHandlers();
    await (await import('./services/social')).registerSocialHandlers();
    worker = startWorker({ concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2) });
  }
}).catch((e) => {
  console.error('[boot] schema preparation failed — refusing to serve', e);
  process.exit(1);
});

async function shutdown(signal: string) {
  console.log(`\n${signal} received — shutting down`);
  // Leave the load balancer first (readiness goes 503 as the server closes),
  // then hand leadership on and flush what is buffered in memory.
  if (leadership) await leadership.stop();
  if (worker) await worker.stop();   // let in-flight jobs unwind; the reaper covers the rest
  await stopScale();
  stopAllRadio();   // detached ffmpeg trees would otherwise outlive the control plane
  // On-demand MP3 transcodes are our children too, and a listener holding an
  // open socket would keep the server from closing. Ending them lets the
  // shutdown proceed and records each session with `shutdown` as its reason,
  // which is honestly different from a listener who chose to leave.
  stopAllFeeds();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
