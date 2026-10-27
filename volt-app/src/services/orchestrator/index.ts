import { config } from '../../config';
import { Orchestrator } from './service';
import { reconcileFleet } from '../fleet/reconcile';
import { meterOnce } from '../fleet/meter';
import { sampleFleet, pruneSamples } from '../fleet/metrics';
import { adviseConsolidation, pruneFleetPlans } from '../fleet/advisor';
import { resumeOnce } from './resume';
import { closeOrphanAirSessions } from '../airSessions';

export { Orchestrator } from './service';
export * from './launcher';

/** Shared orchestrator instance used by routes and the scheduler. */
export const orchestrator = new Orchestrator();

// ---------------------------------------------------------------------------
//  BOOT RECONCILIATION IS NOT INSTANT, AND SAYING SO IS PART OF BEING HEALTHY.
//
//  The process starts listening long before it has finished deciding what is
//  actually running: the boot chain below is four or five round trips against
//  the launcher and the database, and on a real fleet it is one launcher call
//  per open instance row. Until it settles, `status` columns are a cache of a
//  pre-crash world and open instance rows are unverified claims. Anything that
//  reads them in that window reads history.
//
//  So the readiness of the control plane is published separately from its
//  liveness. /health has always answered "the process is up"; it now also
//  answers "and it has finished working out the truth", which is what a load
//  balancer, a deploy gate, and a fixture that seeds rows all actually want.
//  A fixture that skips this races the reaper and watches its rows get closed
//  underneath it, which is exactly the failure this replaces.
// ---------------------------------------------------------------------------
let bootReconcileDone = false;

/** True once boot reconciliation has settled. Never resets. */
export function isBootReconciled(): boolean {
  return bootReconcileDone;
}

/**
 * Start the background scheduler: provision/stop scheduled events, roll channel
 * recordings at the day boundary, and sweep expired recordings. Returns a stop
 * fn. In production the event-scheduling half can be moved to EventBridge; the
 * retention sweep can move to a scheduled Lambda. The logic in service.ts is
 * unchanged either way.
 */
export function startScheduler(): () => void {
  const o = config.orchestrator;
  // FIRST, before any tick: the stored 'live' flags are a cache of a running
  // process, and a crash leaves them stale. Reconcile them against what is
  // actually running so nothing downstream reports a status that is not true.
  //
  // TWO PASSES, IN THIS ORDER, AND BOTH ARE NEEDED.
  //
  // reconcileStreamStatus corrects owners that say 'live' when nothing is
  // running. reapOrphanInstances handles the mirror case it cannot see: an
  // owner already marked 'ended' whose instance row is still open. That row is
  // invisible to the status reconciler (it only visits 'live' owners) and it
  // blocks the orphan-recording sweep, which is how a station ends up showing
  // as recording forever with nothing running. Done at boot rather than left
  // to the first tick so the very first screen an operator sees is truthful.
  orchestrator.reconcileStreamStatus()
    .then((n) => { if (n) console.log(`[orchestrator] boot reconcile corrected ${n} stream status row(s)`); })
    .then(() => orchestrator.reapOrphanInstances())
    .then((n) => { if (n) console.log(`[orchestrator] boot reconcile closed ${n} orphaned instance row(s)`); })
    .then(() => orchestrator.reconcileOrphanRecordings())
    .then((n) => { if (n) console.log(`[orchestrator] boot reconcile closed ${n} orphaned recording(s)`); })
    // AND THE AIR LEDGER, for the same reason and in the same place. An open
    // air window grows on its own: a control plane killed mid-broadcast leaves
    // one, and every later read of "hours on air" would include the time since
    // the process died. Closed AFTER the instance reaper above, so the
    // "is anything running" test it makes is asked of a settled fleet.
    .then(() => closeOrphanAirSessions())
    // AND THEN PUT THE FLEET BACK. Last, because it depends on everything
    // above having settled: a stream cannot be adopted or restarted while a
    // stale claim still says something is running for it.
    .then(() => (o.resumeEnabled ? resumeOnce(orchestrator) : null))
    .then((r) => {
      if (!r) return;
      if (r.adopted || r.started || r.waiting || r.failed || r.gaveUp) {
        console.log(`[resume] boot: ${r.adopted} adopted, ${r.started} started, ${r.waiting} waiting, ${r.failed} retrying, ${r.gaveUp} gave up`);
      }
    })
    .catch((e) => console.error('[orchestrator] boot reconcile failed', e))
    // READY EVEN IF IT FAILED. A reconcile that threw leaves us no better
    // informed, but staying "not ready" forever would take the control plane
    // out of service over a pass whose whole job is tidying. The error is
    // logged above; readiness means "we are no longer going to change these
    // rows out from under you", and that is true either way.
    .finally(() => { bootReconcileDone = true; });
  const tick = setInterval(
    () => orchestrator.tick().catch((e) => console.error('[orchestrator] tick error', e))
      // AN ENCODER THAT DIES WITHOUT SAYING SO. A crash, an OOM kill or a SIGKILL
      // sends no channel.stop, and reconcileStreamStatus only ran at boot, so the
      // channel stayed 'live' with nothing behind it (measured: still 'live' 80s
      // after the encoder was killed, auto connect never fired, the origin kept
      // serving the last manifest). Reconciling on the tick marks it ended within
      // one tick, and the resume pass then brings an armed stream straight back.
      .then(() => orchestrator.reconcileStreamStatus())
      .then((n) => { if (n) console.log(`[orchestrator] tick reconcile: ${n} stream(s) had no running task`); })
      .catch((e) => console.error('[orchestrator] tick reconcile error', e)),
    o.tickSeconds * 1000
  );
  const sweep = setInterval(
    () => orchestrator.sweepRetention().catch((e) => console.error('[orchestrator] sweep error', e)),
    o.retentionSweepSeconds * 1000
  );
  // THE AVAILABILITY CLOCK: open scheduled windows, close expired ones. Once a
  // minute is plenty; the windows are set in days and hours, not seconds.
  const avail = setInterval(
    () => import('../availability').then((m) => m.sweepAvailability())
      .then((r) => { if (r.opened || r.expired) console.log(`[availability] opened ${r.opened}, expired ${r.expired}`); })
      .catch((e) => console.error('[availability] sweep error', e)),
    60_000
  );
  avail.unref?.();

  // FAST LINEUPS: keep every active lineup's guide (and its breaks) a week
  // ahead. Deterministic, so a top-up only appends what comes next.
  const fast = setInterval(
    () => import('../fast/store').then((m) => m.topUpFast())
      .then((n) => { if (n) console.log(`[fast] topped up ${n} lineup(s)`); })
      .catch((e) => console.error('[fast] top-up error', e)),
    10 * 60_000
  );
  fast.unref?.();
  // and a playout for every FAST channel on air (local launcher; see playoutRunner.ts)
  const fastPlay = setInterval(
    () => import('../fast/playoutRunner').then((m) => m.reconcilePlayouts()).catch((e) => console.error('[fast] playout reconcile error', e)),
    30_000
  );
  fastPlay.unref?.();
  import('../fast/playoutRunner').then((m) => m.reconcilePlayouts()).catch(() => null);

  // THE FLEET PASS, kept on its own interval and its own error boundary.
  //
  // It observes and meters; it can start nothing and stop nothing. Keeping it
  // out of orchestrator.tick() means a throttled AWS describe or a slow meter
  // batch can never delay or fail the pass that actually keeps channels on
  // air. The reverse is also true and also wanted: a stream that fails to
  // start does not cost us the usage record for the forty that are running.
  const fleet = setInterval(
    () => fleetPass().catch((e) => console.error('[fleet] pass error', e)),
    o.fleetTickSeconds * 1000
  );
  // EDGE RIGHTS (services/edgeRights.ts): keep the CloudFront KeyValueStore the
  // manifest function reads in step with geo settings and programme
  // blackouts. Every minute, and only what changed is written (memo). Off
  // unless EDGE_RIGHTS_KVS_ARN is set (Terraform output edge_rights_kvs_arn).
  const kvsArn = process.env.EDGE_RIGHTS_KVS_ARN || '';
  const edgeMemo = new Map<string, string | null>();
  const edgeRights = kvsArn ? setInterval(() => {
    (async () => {
      const er = await import('../edgeRights');
      const store = await er.cloudFrontKvsStore(kvsArn);
      // the key the function checks rights-class claims with (written once, then only on change)
      await er.syncClaimKey(store, edgeMemo);
      const r = await er.syncEdgeRights(store, await er.allStreams(), undefined, edgeMemo);
      if (r.put || r.deleted || r.failed) console.log(`[edge-rights] ${r.put} written, ${r.deleted} removed, ${r.failed} failed`);
    })().catch((e) => console.error('[edge-rights] sync error', e));
  }, 60_000) : null;
  edgeRights?.unref?.();

  // PLAN VS AS-RUN (services/asRun.ts): stamp what actually aired onto the
  // guide, from the encoders' run and splice events, for TV channels that ran
  // in the last six hours. Writes only rows that changed.
  const asRun = setInterval(() => {
    import('../asRun').then((m) => m.asRunPass())
      .then((r) => { if (r.changed) console.log(`[as-run] ${r.changed} programme(s) updated across ${r.channels} channel(s)`); })
      .catch((e) => console.error('[as-run] pass error', e));
  }, 60_000);
  asRun.unref?.();

  // Prune telemetry on the same schedule as retention; the ledger is never
  // pruned, because it is the billable record.
  const prune = setInterval(
    () => { pruneSamples(o.sampleRetentionDays).catch((e) => console.error('[fleet] prune error', e)); pruneFleetPlans(o.sampleRetentionDays).catch((e) => console.error('[fleet] plan prune error', e)); },
    o.retentionSweepSeconds * 1000
  );

  // THE RETRY LOOP, on its own interval at the retry interval itself.
  //
  // Not folded into the orchestrator tick: that runs every thirty seconds and
  // the requirement is twenty, and more importantly a resume pass that shares
  // an error boundary with provisioning could take provisioning down with it.
  // Each pass only acts on candidates whose cooldown has elapsed, so running
  // it often is cheap and running it late costs only latency.
  const resume = o.resumeEnabled ? setInterval(
    () => resumeOnce(orchestrator)
      .then((r) => {
        if (r.started || r.adopted || r.gaveUp) {
          console.log(`[resume] ${r.adopted} adopted, ${r.started} started, ${r.gaveUp} gave up`);
        }
      })
      .catch((e) => console.error('[resume] pass error', e)),
    o.resumeRetrySeconds * 1000
  ) : null;

  // WATCHFOLDER SCANS, on their own interval and their own error boundary, for
  // the same reason the fleet pass is: a watched path that has been unmounted,
  // or a folder holding ten thousand files, must not be able to delay the pass
  // that keeps channels on air. It starts nothing and stops nothing.
  //
  // Sixty seconds rather than the thirty-second tick because an ingest folder is
  // not a real-time surface and every pass hashes files it has already seen; the
  // operator who wants it now has a Scan button.
  // ENCODER THUMBNAILS: library stills, sprite sheets and hourly VTTs
  // (services/thumbnails). Own interval, own error boundary: a slow decode can
  // never delay the pass that keeps channels on air. The pass has a time budget
  // and resumes where it stopped. Retention runs with it, at most once an hour.
  let lastThumbSweep = 0;
  const thumbs = config.thumbnails.enabled ? setInterval(
    () => import('../thumbnails/builder').then(async (m) => {
      const r = await m.thumbnailPass();
      if (r && (r.tiles || r.frames)) console.log(`[thumbnails] ${r.streams} stream(s): ${r.tiles} tile(s), ${r.frames} still(s) in ${r.ms} ms${r.deadline ? ' (budget reached)' : ''}`);
      if (Date.now() - lastThumbSweep > 3600_000) {
        lastThumbSweep = Date.now();
        const sw = await m.sweepThumbnails();
        if (sw.hours) console.log(`[thumbnails] retention: removed ${sw.hours} hour(s), ${sw.files} file(s)`);
      }
    }).catch((e) => console.error('[thumbnails] pass error', e)),
    config.thumbnails.passSeconds * 1000
  ) : null;
  thumbs?.unref?.();

  const watch = setInterval(
    () => import('../watchfolder/store').then(async (m) => {
      const rs = await m.scanAllFolders();
      for (const r of rs) {
        if (r.error) { console.error(`[watchfolder] ${r.folderId} scan failed: ${r.error}`); continue; }
        const a = r.result?.accepted.length ?? 0;
        const q = r.result?.quarantined.length ?? 0;
        if (a || q) console.log(`[watchfolder] ${r.folderId}: ${a} accepted, ${q} sent to review`);
      }
      // INGEST RUNS AFTER THE SCAN, IN THE SAME TICK, and deliberately not on its
      // own interval. Two independent timers over one queue is how a file gets
      // ingested twice: the status guard in pgIngestStore would catch it, but the
      // right answer is not to hold the race in the first place. Accepting and
      // ingesting are one pass; the scan just happens to go first.
      // Accelerated transfers that report through a poll (Aspera node) ride the
      // same tick: a transfer is a drop that has not landed yet.
      await import('../ingest/transfers').then((t) => t.pollTransfers()).catch((e) => console.error('[transfers] poll error', e));
      const is = await m.ingestAllFolders();
      for (const r of is) {
        if (r.error) { console.error(`[watchfolder] ${r.folderId} ingest failed: ${r.error}`); continue; }
        const s = r.summary;
        if (s && (s.ingested || s.failed)) {
          console.log(`[watchfolder] ${r.folderId}: ${s.ingested} ingested, ${s.failed} failed` +
            (s.deferred ? `, ${s.deferred} left for other workflows` : ''));
        }
      }
    }).catch((e) => console.error('[watchfolder] pass error', e)),
    60_000
  );
  watch.unref?.();

  // S3 WATCH FOLDERS, EVENT-DRIVEN (build queue 2.6): with a drop queue set,
  // the leader long-polls it and fetches each new object as the bucket
  // reports it, instead of waiting for the walk above. Its own loop and error
  // boundary, like every pass here.
  let stopS3Events: (() => Promise<void>) | null = null;
  if (config.ingest.s3EventsQueueUrl) {
    import('../watchfolder/s3events').then((m) => m.startFromConfig())
      .then((stop) => { stopS3Events = stop; })
      .catch((e) => console.error('[s3 watch] could not start the drop queue loop', e));
  }

  // CDN EDGE LOGS (build queue 2.9): with a log stream set (AWS), the leader
  // reads CloudFront's real-time logs into reporting and keeps their
  // sampling rate at what the reports need (services/qoe/cdnStream.ts).
  let stopCdnLogs: (() => Promise<void>) | null = null;
  if (process.env.CDN_LOG_STREAM) {
    import('../qoe/cdnStream').then((m) => m.startFromConfig())
      .then((stop) => { stopCdnLogs = stop; })
      .catch((e) => console.error('[cdn logs] could not start the log reader', e));
  }

  tick.unref?.();
  sweep.unref?.();
  fleet.unref?.();
  prune.unref?.();
  resume?.unref?.();
  console.log(`[orchestrator] scheduler up (tick ${o.tickSeconds}s, retention sweep ${o.retentionSweepSeconds}s, fleet ${o.fleetTickSeconds}s, auto-connect ${o.resumeEnabled ? `${o.resumeRetrySeconds}s x${o.resumeMaxAttempts}` : 'off'}, launcher=${o.launcher})`);
  return () => {
    clearInterval(tick);
    clearInterval(sweep); clearInterval(avail);
    clearInterval(fleet);
    clearInterval(prune);
    if (edgeRights) clearInterval(edgeRights);
    clearInterval(asRun);
    clearInterval(watch);
    void stopS3Events?.();
    void stopCdnLogs?.();
    if (thumbs) clearInterval(thumbs);
    if (resume) clearInterval(resume);
  };
}

/**
 * One fleet pass: observe placement, then meter, then measure.
 *
 * THE ORDER IS LOAD-BEARING. Placement first, because the meter reads the
 * host's instance type to price the window and a task with no host yet is
 * metered unpriced. Metering second, so the seconds are captured even if the
 * metrics provider is unreachable. Measurement last, because it is the only
 * part nobody is billed for.
 *
 * Each stage has its own try/catch for the same reason they are in this order:
 * a failure in a later, less important stage must not discard the work of an
 * earlier, more important one.
 */
export async function fleetPass(): Promise<void> {
  try {
    await reconcileFleet(orchestrator.launcherForFleet());
  } catch (e) { console.error('[fleet] placement reconcile failed', e); }
  try {
    const m = await meterOnce();
    if (m.windows) console.log(`[fleet] metered ${m.windows} window(s), ${m.seconds}s across ${m.considered} task(s)`);
  } catch (e) { console.error('[fleet] meter failed', e); }
  try {
    await sampleFleet();
  } catch (e) { console.error('[fleet] telemetry sample failed', e); }
  // Last: it reads the samples just taken, and it only ever ADVISES. A
  // failure here leaves the fleet exactly as it was.
  try {
    await adviseConsolidation();
  } catch (e) { console.error('[fleet] consolidation advice failed', e); }
}
