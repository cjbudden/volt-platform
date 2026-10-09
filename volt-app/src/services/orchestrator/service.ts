import { query, one, tx, pool } from '../../db';
import { config } from '../../config';
import { buildEncoderJobConfig, buildThumbnailerJobConfig, JobConfigCtx } from '../jobConfig';
import { buildRadioJobConfig } from '../radio/jobConfig';
import { resolveCaptionsPlan, buildCaptionsJobConfig } from '../captionsPlan';
import { createClipVod, deriveEventVod, enqueueClipBuild } from '../clips';
import { convertProgramme } from '../epgVod';
import { clearGiveUp, clearArmed } from './resume';
import { startRadioMonitor, stopRadioMonitor } from '../radio/monitor';
import { assertStartable, NotStartable } from '../sourceReadiness';
import { TaskLauncher, makeLauncher, type Liveness } from './launcher';
import { backfillContainers, closeFinishedContainers } from '../containers';
import { sweep, ruleFor } from '../media/retention';
import { transition, locationsOf, pollRestores } from '../media/objects';
import { storageDriver } from '../media/storage';
import { reconcileAll } from '../media/reconcile';
import { sweepAnalytics } from '../analyticsRetention';
import { sweepUploads } from '../uploads';

/**
 * The orchestrator turns channel/event lifecycle into real running tasks and
 * recordings. On start it builds the encoder job config, launches an ECS task
 * (Spot + on-demand fallback), records the instance, and opens a recording. On
 * stop it terminates the task, closes the recording (stamping expiry from the
 * retention rule), and fires the CPU thumbnailer. `tick()` provisions scheduled
 * events, rolls channel recordings at the UTC day boundary, and sweeps expired
 * recordings — it's driven by a timer in index.ts (EventBridge can replace the
 * scheduling half in production without touching this logic).
 *
 * Time is handled server-side (SQL now()/current_date) so behaviour is
 * deterministic and tz-correct; the launcher is injected so it's testable
 * without AWS.
 */
/**
 * WHY A STREAM IS BEING STOPPED, which is not the same as who asked.
 *
 * Only two of these are a RECORDED STOP — a statement that this stream is
 * meant to be off. The other two are things that happened to it, and a stream
 * that had something happen to it is exactly what auto-connect exists to put
 * back.
 *
 *   operator  a person pressed Stop. Recorded.
 *   schedule  the event's window ended. Recorded: the schedule is intent.
 *   fault     the encoder reported a fatal error and the control plane is
 *             tearing down after it. NOT recorded — recording it would disable
 *             recovery for the single case recovery is for.
 *   internal  the platform is stopping something in order to restart it, or
 *             cleaning up an orphan. NOT recorded: nobody decided to stop.
 *
 * The default is `operator`, deliberately. A new call site added without
 * thinking about this will suppress auto-connect, which is a stream that stays
 * off until someone starts it. The opposite default would resurrect streams an
 * operator switched off, and a system that fights the operator is worse than
 * one that waits for them.
 */
export type StopIntent = 'operator' | 'schedule' | 'fault' | 'internal';

/**
 * WHO IS STARTING A STREAM.
 *
 * `operator` is a person's own act and is the only one that clears a recovery
 * give-up. `resume` is auto-connect retrying, and must NOT clear it or the
 * attempt counter can never reach its limit. `schedule` is the event
 * provisioner opening a window; it leaves the counters alone too, and a
 * successful start resets them through the ordinary bookkeeping anyway.
 */
export type StartIntent = 'operator' | 'resume' | 'schedule';

export class Orchestrator {
  constructor(private launcher: TaskLauncher = makeLauncher()) {}

  /**
   * The launcher, for the fleet pass to ask WHERE tasks landed.
   *
   * A read-only handle deliberately named for its one caller rather than a
   * public `launcher` field: the fleet pass observes and must never be able to
   * launch or stop anything, and a narrow accessor makes that visible at every
   * call site. The launcher itself is still the private constructor arg, so a
   * test that injects a mock gets the same object here.
   */
  launcherForFleet(): TaskLauncher { return this.launcher; }

  // ---- context loading -----------------------------------------------------
  async loadContext(kind: 'channel' | 'event', id: string): Promise<JobConfigCtx | null> {
    const ownerSql =
      kind === 'channel'
        ? `SELECT c.*, g.output_profile_id, g.account_id FROM channels c JOIN groups g ON g.id=c.group_id WHERE c.id=$1`
        : `SELECT e.*, g.output_profile_id, g.account_id FROM events e JOIN groups g ON g.id=e.group_id WHERE e.id=$1`;
    const owner = await one<any>(ownerSql, [id]);
    if (!owner) return null;
    // account row carries the captions master toggle (none|whisper|gladia)
    const account = owner.account_id
      ? await one<any>('SELECT captions_provider FROM accounts WHERE id=$1', [owner.account_id])
      : null;
    const profile = await one<any>('SELECT * FROM output_profiles WHERE id=$1', [owner.output_profile_id]);
    if (!profile) throw new Error(`No output profile attached to this ${kind}'s group`);
    const col = kind === 'channel' ? 'channel_id' : 'event_id';
    const inputs = await query<any>(`SELECT * FROM stream_inputs WHERE ${col}=$1 ORDER BY role, rendition_bitrate_kbps DESC NULLS LAST`, [id]);
    let drm = null;
    if (profile.drm_enabled && profile.drm_config_id) {
      drm = await one<any>('SELECT * FROM drm_configs WHERE id=$1', [profile.drm_config_id]);
    }
    // resolve filler asset (slate/loop) if redundancy filler references one
    let filler_ref: string | null = null;
    let filler_vod_url: string | null = null;
    if (owner.filler_asset_id) {
      const fa = await one<any>('SELECT * FROM filler_assets WHERE id=$1', [owner.filler_asset_id]);
      if (fa?.kind === 'loop') filler_vod_url = fa.source_key;
      else if (fa) filler_ref = fa.source_key;
    }
    if (!filler_ref && owner.filler_slate_ref) filler_ref = owner.filler_slate_ref;

    return {
      kind,
      owner: {
        id: owner.id,
        recording_enabled: owner.recording_enabled !== false,
        recording_retention_days: owner.recording_retention_days ?? null,
        recording_retention_sec: owner.recording_retention_sec ?? null,
        input_failover_enabled: owner.input_failover_enabled,
        auto_failback: owner.auto_failback,
        input_loss_behavior: owner.input_loss_behavior,
        filler_ref,
        filler_vod_url,
        output_ladder: owner.output_ladder,   // per-channel ladder override -> encoder
        filler_build: owner.filler_build ?? null,
        watermark_enabled: owner.watermark_enabled,
        watermark_ref: owner.watermark_ref,
        watermark_position: owner.watermark_position,
        watermark_offset_x: owner.watermark_offset_x,
        watermark_offset_y: owner.watermark_offset_y,
        watermark_opacity: owner.watermark_opacity,
        watermark_scale: owner.watermark_scale,
      },
      profile,
      inputs,
      drm,
      account,
    };
  }

  private topRendition(ctx: JobConfigCtx): string {
    if (ctx.profile.workflow_type === 'transcode' && ctx.profile.rungs?.length)
      return `${ctx.profile.rungs[0].height}p`;
    const primary = ctx.inputs.filter((i) => i.role === 'primary');
    return primary[0]?.rendition_label ?? 'source';
  }

  // ---- start / stop --------------------------------------------------------

  /**
   * A cross-process lock for one stream's start/stop, held for the life of a
   * database session.
   *
   * pg_try_advisory_lock returns immediately rather than queuing: a second
   * caller does not wait its turn and then launch a duplicate encoder a moment
   * later, it is told the stream is already being started. `hashtextextended`
   * turns the uuid into the bigint the lock namespace wants, and the constant
   * keeps this family of locks from colliding with any other advisory lock the
   * application might take later.
   */
  private async withStartLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const LOCK_NS = 0x0107;   // "orchestrator start"
    // ONE CONNECTION, HELD. An advisory lock belongs to the SESSION that took
    // it, and query() borrows an arbitrary connection from the pool — so
    // locking and unlocking through query() can easily happen on two different
    // sessions, leaving the lock held until that connection is recycled and
    // every later start refused. The client is checked out for the whole
    // critical section, and releasing it back to the pool would also drop the
    // lock even if the explicit unlock somehow failed.
    const client = await pool.connect();
    try {
      const got = await client.query(
        `SELECT pg_try_advisory_lock($1, (hashtextextended($2, 0) & 2147483647)::int) AS ok`,
        [LOCK_NS, id]
      );
      if (!got.rows[0]?.ok) {
        throw Object.assign(new Error('This stream is already being started'), { status: 409 });
      }
      try {
        return await fn();
      } finally {
        await client.query(
          `SELECT pg_advisory_unlock($1, (hashtextextended($2, 0) & 2147483647)::int)`,
          [LOCK_NS, id]
        ).catch(() => { /* releasing the client below drops it regardless */ });
      }
    } finally {
      client.release();
    }
  }

  /**
   * The task already running for this stream, if one genuinely is.
   *
   * Asked BEFORE launching. Without it, a double-clicked Start or two
   * overlapping orchestrator ticks each launched an encoder into the same
   * output namespace: two processes writing the same manifests and segments,
   * which corrupts the live edge rather than merely wasting money. Returning
   * the existing task makes start idempotent, which is what a caller that
   * retries on timeout actually needs.
   */
  private async existingTask(kind: 'channel' | 'event', id: string): Promise<string | null> {
    const col = kind === 'channel' ? 'channel_id' : 'event_id';
    const open = await query<any>(
      `SELECT id, task_arn FROM instances
        WHERE ${col} = $1 AND terminated_at IS NULL AND role = 'primary'`,
      [id]
    );
    for (const inst of open) {
      let state: Liveness = 'unknown';
      try { state = await this.launcher.isRunning(inst.task_arn); }
      catch { state = 'unknown'; }
      // `unknown` is treated as running, deliberately: launching a second
      // encoder on top of a possibly-live one is the worse mistake.
      if (state !== 'dead') return inst.task_arn;
      await query(`UPDATE instances SET state='terminated', terminated_at=now() WHERE id=$1`, [inst.id]);
      console.log(`[orchestrator] cleared dead instance ${inst.task_arn} before starting ${kind} ${id}`);
    }
    return null;
  }

  /**
   * @param intent WHO is starting this, which decides one thing: whether the
   * recovery counters are wiped first. Only an operator's own act clears them.
   *
   * This started as an unconditional clear at the top of the function and that
   * was a bug with no symptom until the counter was tested: the resume pass
   * calls start, so every failed retry wiped the very count it was about to
   * increment. Five attempts became one attempt, forever, and the give-up that
   * exists to stop a billable container relaunching every twenty seconds could
   * never fire.
   */
  async startStream(
    kind: 'channel' | 'event',
    id: string,
    intent: StartIntent = 'operator',
  ): Promise<{ taskArn: string }> {
    // A PERSON PRESSING START CLEARS A GIVE-UP.
    //
    // Auto-connect stops trying after five failed attempts and records why.
    // Without this, a stream the system has written off stays written off even
    // after the operator fixes whatever was wrong: they press Start, it works,
    // and the next reboot still refuses to bring it back. The only cure would
    // be a database edit, which is not a cure.
    if (intent === 'operator') {
      await clearGiveUp(kind, id).catch(() => { /* never block a start on this */ });
    }
    // A NEW RUN HAS TO PROVE ITSELF. Auto connect is armed by the health pass
    // the first time this run shows all four gates healthy, and not before:
    // a start that fails is left where it fell, not relaunched.
    if (intent === 'operator' || intent === 'schedule') {
      await clearArmed(kind, id).catch(() => { /* never block a start on this */ });
    }
    return this.withStartLock(id, () => this.startStreamLocked(kind, id));
  }

  private async startStreamLocked(kind: 'channel' | 'event', id: string): Promise<{ taskArn: string }> {
    // RADIO channels run the audio-only pipeline (radio/pipeline.ts) instead of
    // the video encoder task; instances/recording/status bookkeeping is shared.
    if (kind === 'channel') {
      const ch = await one<any>(`SELECT kind, radio_config FROM channels WHERE id=$1`, [id]);
      if (ch?.kind === 'radio') return this.startRadioChannel(id, ch.radio_config ?? {});
    }
    // Already running? Hand back the same task rather than starting a second.
    const already = await this.existingTask(kind, id);
    if (already) {
      console.log(`[orchestrator] ${kind} ${id} is already running as ${already}; start is a no-op`);
      return { taskArn: already };
    }
    const ctx = await this.loadContext(kind, id);
    if (!ctx) throw new Error('stream not found');
    // REFUSE BEFORE ANYTHING COSTS ANYTHING.
    //
    // Deliberately above launchEncoder, and above the recording and the
    // billable clock that follow it. A channel with no source used to get all
    // the way to STARTING with a running encoder listening on a URL that could
    // never match: it billed, it opened a recording, and its source card said
    // RECEIVING. Nothing downstream could tell that apart from a correctly
    // configured push channel whose encoder has not dialled in yet, which is
    // why the check has to be here rather than in whatever notices later.
    assertStartable(ctx.inputs, kind === 'event' ? 'This event' : 'This channel');
    const job = buildEncoderJobConfig(ctx);
    const res = await this.launcher.launchEncoder(id, job);
    const col = kind === 'channel' ? 'channel_id' : 'event_id';
    const isGpu = ctx.profile.workflow_type === 'transcode' && ctx.profile.codec_backend === 'nvenc';

    // Captions add-on: only WHISPER needs a separate GPU task launched here. Gladia
    // rides inside the encoder task (thin sidecar in the job config); 'none' skips it.
    // The base encoder image never carries the model weight — it comes in via this
    // separate `volt-captions` task, tracked as its own instances row so it counts
    // in projected-instances + sizing and is torn down with the stream.
    const plan = resolveCaptionsPlan({
      accountProvider: ctx.account?.captions_provider ?? 'none',
      captionsEnabled: ctx.profile.captions_enabled,
      sourceLang: ctx.profile.caption_source_lang,
      targets: ctx.profile.caption_targets,
      modelSize: (ctx.profile as any).caption_model_size,
    });
    let capRes: { taskArn: string; lifecycle: 'spot' | 'on_demand' } | null = null;
    if (plan.runsSeparateTask) {
      const capJob = buildCaptionsJobConfig(
        id, plan,
        `s3://${config.aws.s3Bucket}/${ctx.kind}/${id}/audio/index.m3u8`,
        ctx.profile.caption_offset_sec ?? 0,
        `${ctx.kind}/${id}/subtitles`
      );
      try {
        capRes = await this.launcher.launchCaptions(id, capJob);
      } catch (e) {
        // captions are best-effort: a failed add-on must not down the stream
        console.error('captions task launch failed for', id, e);
      }
    }

    // THE TASK IS ALREADY RUNNING BY THIS POINT.
    //
    // If the bookkeeping below fails, the launch does not roll back with it:
    // there is a live encoder writing to the origin and no instances row
    // naming it, which means nothing in the system can ever stop it. It would
    // keep running, keep costing, and keep writing over the live edge, and the
    // only cure would be someone finding it by hand. So a failure here stops
    // what we just started before it re-throws.
    try {
      await tx(async (c) => {
        await c.query(
          `INSERT INTO instances(${col}, task_arn, is_gpu, lifecycle, role, task_kind, state, launched_at)
           VALUES ($1,$2,$3,$4,'primary',$5,'running', now())`,
          // WHAT KIND OF WORK, recorded at launch. `role` cannot carry this:
          // a transcode and a package-only run are both 'primary' and differ
          // in cost by an order of magnitude, so a fleet split by role tells
          // an operator nothing about where the money went.
          [id, res.taskArn, isGpu, res.lifecycle,
           ctx.profile.workflow_type === 'package_only' ? 'package_only' : 'transcode']
        );
        if (capRes) {
          await c.query(
            `INSERT INTO instances(${col}, task_arn, is_gpu, instance_type, lifecycle, role, task_kind, state, launched_at)
             VALUES ($1,$2,true,$3,$4,'captions','captions','running', now())`,
            [id, capRes.taskArn, plan.instanceType, capRes.lifecycle]
          );
        }
        // open the recording
        if (kind === 'event') {
          await c.query(
            `INSERT INTO recordings(kind, event_id, title, status, hi_res_rendition, master_key,
                                    start_epoch_ms, retention_days)
             SELECT 'event', $1, e.name, 'recording', $2, $3,
                    (extract(epoch from now())*1000)::bigint, e.recording_retention_days
               FROM events e WHERE e.id=$1`,
            [id, this.topRendition(ctx), `${kind}/${id}`]
          );
        } else {
          await this.ensureChannelDayRecording(c, id, this.topRendition(ctx), `${kind}/${id}`);
        }
        // STATUS AND INTENT, TOGETHER AND IN ONE TRANSACTION.
        //
        // `status` is the observation; `desired_state` is the statement that
        // this stream is meant to be on air, and it is what survives a reboot
        // to tell auto-connect to put it back. Written here rather than at the
        // top of start so that a launch which fails leaves no intent behind
        // for the resume pass to act on.
        //
        // IT DOES NOT TOUCH THE RECOVERY COUNTERS, and that omission is the
        // whole point. Zeroing them here meant every relaunch wiped the record
        // of the relaunch before it, so a station crash-looping every twenty
        // seconds reported "attempt 1 of 5" for ever and the give-up cap could
        // never be reached. Launching is not recovering. An OPERATOR start does
        // clear them, one level up in startStream, because a person acting on
        // the stream is a real signal that the cause was addressed.
        await c.query(
          `UPDATE ${kind === 'channel' ? 'channels' : 'events'}
              SET status='live', updated_at=now(),
                  desired_state='running',
                  stop_requested_at=NULL, stop_requested_by=NULL
            WHERE id=$1`,
          [id]
        );
      });
    } catch (e) {
      console.error(`[orchestrator] bookkeeping failed after launching ${kind} ${id}; stopping the orphan`, e);
      for (const arn of [res.taskArn, capRes?.taskArn]) {
        if (!arn) continue;
        try { await this.launcher.stopTask(arn, `orphaned: bookkeeping failed for ${kind} ${id}`); }
        catch (stopErr) { console.error('[orchestrator] could not stop orphan', arn, stopErr); }
      }
      throw e;
    }
    return { taskArn: res.taskArn };
  }

  /** Start a RADIO channel: audio pipeline in-process, shared bookkeeping. */
  /**
   * THE OLD PATH: ffmpeg as a child of the control plane.
   *
   * Kept only until radio's read side stops asking an in-memory process table
   * whether a station is alive. It is not a fallback and not a supported
   * production mode: it cannot be deployed, replicated or reaped like any other
   * workload, and a control-plane restart takes every station off air. See
   * config.orchestrator.radioMode.
   */
  private async startRadioInProcess(id: string, radioConfig: any): Promise<{ taskArn: string }> {
    const src = await one<any>(
      `SELECT protocol, ingest_url FROM stream_inputs
        WHERE channel_id=$1 AND role='primary' AND ingest_url IS NOT NULL
        ORDER BY created_at LIMIT 1`, [id]);
    // A STATION IS A CHANNEL, so it gets the same refusal and the same 400.
    // This used to be a bare Error, which reached the console as a 500 reading
    // "Internal error" -- our fault, apparently, for a station the operator
    // simply had not finished filling in.
    if (!src?.ingest_url) {
      throw new NotStartable(
        'This station has no source URL. Open Settings, add the stream URL of the mount or playlist to pull, and start it again.');
    }
    const { startRadio } = await import('../radio/pipeline');
    const { runId, pid } = startRadio({
      channelId: id, protocol: src.protocol, url: src.ingest_url, cfg: radioConfig || {},
    });
    const taskArn = `radio:${pid}:${runId}`;
    await tx(async (c) => {
      await c.query(
        `INSERT INTO instances(channel_id, task_arn, is_gpu, lifecycle, role, task_kind, state, launched_at)
         VALUES ($1,$2,false,'on_demand','primary','radio','running', now())`, [id, taskArn]);
      const ch = await c.query(`SELECT recording_enabled FROM channels WHERE id=$1`, [id]);
      if (ch.rows[0]?.recording_enabled !== false) {
        await this.ensureChannelDayRecording(c, id, 'audio', `channel/${id}`);
      }
      await c.query(
        `UPDATE channels SET status='live', updated_at=now(),
                desired_state='running',
                stop_requested_at=NULL, stop_requested_by=NULL
          WHERE id=$1`, [id]);
    });
    return { taskArn };
  }

  /**
   * Start a radio station as a LAUNCHED TASK, exactly like a television channel.
   *
   * This used to spawn ffmpeg as a child of the control plane, which is the one
   * thing television never did and the reason radio could not be deployed,
   * replicated or reaped like anything else. A restart took every station off
   * air; the launcher could not answer whether a station lived; the instance
   * row metered forever afterwards.
   *
   * Now the only difference from startStreamLocked is the image and the job
   * config, which is exactly as much difference as there should be.
   */
  private async startRadioChannel(id: string, radioConfig: any): Promise<{ taskArn: string }> {
    if (config.orchestrator.radioMode !== 'container') {
      return this.startRadioInProcess(id, radioConfig);
    }
    // Already running? Hand back the same task rather than starting a rival
    // station pushing to the same relay mount, which would leave listeners
    // hearing whichever source Icecast happened to accept.
    const already = await this.existingTask('channel', id);
    if (already) {
      console.log(`[orchestrator] radio ${id} is already running as ${already}; start is a no-op`);
      return { taskArn: already };
    }
    const ch = await one<any>(`SELECT name, recording_enabled FROM channels WHERE id=$1`, [id]);
    const src = await one<any>(
      `SELECT protocol, ingest_url FROM stream_inputs
        WHERE channel_id=$1 AND role='primary' AND ingest_url IS NOT NULL
        ORDER BY created_at LIMIT 1`, [id]);
    // A STATION IS A CHANNEL, so it gets the same refusal and the same 400.
    // This used to be a bare Error, which reached the console as a 500 reading
    // "Internal error" -- our fault, apparently, for a station the operator
    // simply had not finished filling in.
    if (!src?.ingest_url) {
      throw new NotStartable(
        'This station has no source URL. Open Settings, add the stream URL of the mount or playlist to pull, and start it again.');
    }

    const job = await buildRadioJobConfig({
      channelId: id, channelName: ch?.name ?? null,
      protocol: src.protocol, url: src.ingest_url, radioConfig,
    });
    const res = await this.launcher.launchRadio(id, job);

    try {
      await tx(async (c) => {
        await c.query(
          `INSERT INTO instances(channel_id, task_arn, is_gpu, lifecycle, role, task_kind, state, launched_at)
           VALUES ($1,$2,false,$3,'primary','radio','running', now())`, [id, res.taskArn, res.lifecycle]);
        if (ch?.recording_enabled !== false) {
          await this.ensureChannelDayRecording(c, id, 'audio', `channel/${id}`);
        }
        await c.query(
          `UPDATE channels SET status='live', updated_at=now(),
                  desired_state='running',
                  stop_requested_at=NULL, stop_requested_by=NULL
            WHERE id=$1`, [id]);
      });
      // MEASURE THE OUTPUT. Without this a containerised station produces no
      // levels, so the console's waveform never moves, the QC verdict stays
      // 'unknown' and silence is never detected -- the meter that exists
      // precisely so an operator can see a station is working without
      // listening to it. It used to be started by the in-process pipeline and
      // was simply not carried across when radio moved into a container.
      //
      // No run id is passed because there is none to pass: the container picks
      // its own and writes current_run.txt, so the monitor follows that.
      try { startRadioMonitor(id); }
      catch (e) { console.error('[orchestrator] could not start the level monitor for', id, e); }

      // CAPTURE NOW-PLAYING. The second thing containerising radio dropped, and
      // it went the same way as the level monitor: the in-process pipeline
      // started it (radio/pipeline.ts line 193), the container path never did,
      // and a station's metadata log has been silently empty ever since. An
      // empty log reads as "this station sends no metadata", which is a claim
      // about the station rather than about us, so nothing looked broken.
      //
      // It cannot move into the container. ICY metadata arrives on a SECOND
      // connection to the source, negotiated with `Icy-MetaData: 1`, and the
      // titles have to be written to the database as they arrive. The container
      // has no database and must not be given one. So the control plane opens
      // its own metadata-only connection: one socket, no audio decoded.
      //
      // ICECAST ONLY, and not as a shortcut. HLS and SRT have no ICY channel to
      // negotiate at all. Opening one against a playlist URL would poll a server
      // that can never answer with a metadata frame, producing the same empty
      // log while looking like it was trying, which is worse.
      if (String(src.protocol).toLowerCase() === 'icecast' && radioConfig?.metadataCapture !== false) {
        try {
          const { startIcyCapture } = await import('../radio/icyMeta');
          startIcyCapture(id, src.ingest_url, true);
        } catch (e) { console.error('[orchestrator] could not start metadata capture for', id, e); }
      }
    } catch (e) {
      // Same rule as television: a task with no row is unreachable forever, so
      // it is stopped rather than left running and billing.
      console.error(`[orchestrator] bookkeeping failed after launching radio ${id}; stopping the orphan`, e);
      try { await this.launcher.stopTask(res.taskArn, `orphaned: bookkeeping failed for radio ${id}`); }
      catch (stopErr) { console.error('[orchestrator] could not stop orphan', res.taskArn, stopErr); }
      throw e;
    }
    return { taskArn: res.taskArn };
  }

  /**
   * Stop a stream's encoder task(s). `origin` records WHO/WHY (operator click,
   * scheduler window, failover, shutdown) so the control-plane log and the
   * encoder's channel.stop reason are self-explaining instead of a mystery. This
   * is the difference between "the operator stopped it" and "it failed".
   */
  async stopStream(
    kind: 'channel' | 'event',
    id: string,
    origin = 'unknown',
    intent: StopIntent = 'operator',
  ): Promise<void> {
    console.log(`[orchestrator] stopStream ${kind} ${id} — origin=${origin} intent=${intent}`);
    // WHETHER THIS COUNTS AS A RECORDED STOP.
    //
    // An explicit argument rather than something parsed out of `origin`,
    // because `origin` is a human-readable log string and the day somebody
    // rewords one is the day auto-connect silently stops working, or silently
    // starts resurrecting streams an operator switched off. See StopIntent.
    //
    // Done BEFORE the teardown: if stopping throws halfway through, the
    // operator's decision must still be on record, or the resume pass will
    // helpfully undo it a few seconds later.
    if (intent === 'operator' || intent === 'schedule') {
      await query(
        `UPDATE ${kind === 'channel' ? 'channels' : 'events'}
            SET desired_state = 'stopped',
                stop_requested_at = now(),
                stop_requested_by = $2,
                resume_attempts = 0,
                resume_last_error = NULL,
                resume_gave_up_at = NULL,
                resume_armed_at = NULL
          WHERE id = $1`,
        [id, `${intent}: ${origin}`.slice(0, 200)]
      ).catch((e) => console.error('[orchestrator] could not record the stop intent for', kind, id, e));
    }

    // ---- THE CRASH-LOOP BRAKE -------------------------------------------
    //
    // A fault leaves `desired_state='running'` on purpose, because recovering
    // from a fault is exactly what auto-connect is for. But that alone gives
    // an UNBOUNDED loop for a stream that starts successfully and then dies a
    // second later, and the five-attempt cap could not see it:
    //
    //   resume calls startStream  ->  the launcher launches fine, so the start
    //                                 SUCCEEDS and the bookkeeping resets
    //                                 resume_attempts to 0
    //   one second later          ->  the encoder dies, stopStream(fault)
    //   twenty seconds later      ->  resume tries again, from zero
    //
    // The counter only ever incremented when a start THREW, so a task that
    // launched and immediately crashed never spent an attempt. On a demo
    // machine with no Icecast relay running this produced ninety run
    // directories and a relaunch every twenty seconds, indefinitely.
    //
    // So a run that dies young is counted as a failed attempt. A run that
    // lasted longer than the flap window is a real session that ended badly
    // and is NOT counted: a station that plays for six hours and then loses its
    // source must still be recovered, however many times it happens.
    // (the flap accounting happens below, once the rows that were actually
    // running have been read — see countFlap)
    const running = await query<any>(
      `SELECT * FROM instances WHERE ${kind === 'channel' ? 'channel_id' : 'event_id'}=$1 AND terminated_at IS NULL`,
      [id]
    );

    // ---- THE CRASH-LOOP BRAKE -------------------------------------------
    //
    // Fed the rows that are ACTUALLY OPEN, which is the run that just died,
    // rather than looking up the newest launch afterwards. Those are not the
    // same thing: by the time this has finished, these rows are terminated and
    // a later start may already have inserted a newer one, so a lookup would
    // measure the wrong run's lifetime and could report a long session as a
    // flap or the reverse.
    if (intent === 'fault') {
      await this.countFlap(kind, id, origin, running).catch((e) =>
        console.error('[orchestrator] could not record the flap for', kind, id, e));
    }
    // A `radio:` arn is a legacy in-process station (config.orchestrator
    // .radioMode === 'inprocess'); the launcher has never heard of it and
    // cannot stop it. Once radio runs as a container this prefix stops being
    // minted and this whole branch becomes unreachable, which is the point:
    // it is scoped to the thing it describes rather than to "radio".
    // The level monitor is measurement, not transport: it stops whenever the
    // stream does, on either path, so a stopped station's meter goes quiet
    // instead of sitting on the last value it happened to read.
    // The metadata connection is the control plane's own socket to the source,
    // so nothing else closes it. Left open it keeps reading a station that is
    // off air and keeps appending titles to its log, which is the one way a
    // stopped station can look like it is still playing something.
    if (kind === 'channel') {
      try { stopRadioMonitor(id); } catch { /* never block a stop on the meter */ }
      // The on-demand MP3 transcode reads this station's origin. With the
      // station stopped there is nothing to read, so the ffmpeg would sit
      // failing against a playlist that has stopped advancing while its
      // listeners hear silence. Closing it tells them, and a player that sees
      // the connection close reconnects when the station comes back.
      try {
        const { stopFeed } = await import('../radio/mp3Gateway');
        stopFeed(id, 'station_stopped');
      } catch { /* nor on the mp3 gateway */ }
      try {
        const { stopIcyCapture } = await import('../radio/icyMeta');
        stopIcyCapture(id);
      } catch { /* nor on the metadata reader */ }
    }
    const legacy = running.filter((i) => String(i.task_arn ?? '').startsWith('radio:'));
    if (legacy.length) {
      const { stopRadio } = await import('../radio/pipeline');
      stopRadio(id, origin);
    }
    for (const inst of running) {
      if (inst.task_arn && !String(inst.task_arn).startsWith('radio:')) {
        try {
          await this.launcher.stopTask(inst.task_arn, `${kind} ${id} stopped (${origin})`);
        } catch (e) {
          console.error('stopTask failed', inst.task_arn, e);
        }
      }
      await query(`UPDATE instances SET state='terminated', terminated_at=now() WHERE id=$1`, [inst.id]);
      // SETTLE THE METER NOW, not on the next fleet pass.
      //
      // The pass would find it: the meter accrues to terminated_at whenever it
      // next runs, so the figure is eventually right either way. But an
      // operator who stops a channel and watches its usage figure sit still
      // for a minute concludes the meter is broken, and a correctness argument
      // does not survive contact with that. Best effort: a failure here is
      // picked up by the pass, so it must not fail the stop.
      try {
        const { meterInstanceNow } = await import('../fleet/meter');
        await meterInstanceNow(inst.id);
      } catch (e) {
        console.warn('[orchestrator] could not settle meter for', inst.id, e);
      }
    }
    // close any open recordings for this owner and fire the thumbnailer
    await this.closeOpenRecordings(kind, id);
    await query(
      `UPDATE ${kind === 'channel' ? 'channels' : 'events'} SET status=$2, updated_at=now() WHERE id=$1`,
      [id, kind === 'channel' ? 'ended' : 'ended']
    );
  }

  // ---- recordings ----------------------------------------------------------
  private async ensureChannelDayRecording(c: any, channelId: string, topRend: string, prefix: string) {
    // ONE recording per channel per UTC DAY — and the row describes the DAY,
    // not the run, so a restart inside the same day must REOPEN it.
    //
    // This used to be DO NOTHING. Stop a channel at 10:00 (the row is closed
    // 'complete') and start it again at 10:30, and the insert quietly did
    // nothing: the channel was live and writing segments with no open
    // recording row for the rest of the day. Everything keyed off recordings
    // then failed without saying so — programme and scheduled clips recorded
    // 'no recording covers the slot', the library showed the day as finished,
    // and the new run's media inherited no retention. It healed at the next
    // UTC midnight, which is a long time to be silently not recording.
    //
    // Reopening keeps start_epoch_ms at the day's original start. Holes inside
    // the day are already modelled where they belong: the segment index splits
    // a run at its discontinuities, so coverage stays honest.
    await c.query(
      `INSERT INTO recordings(kind, channel_id, day_utc, status, hi_res_rendition, master_key,
                              start_epoch_ms, retention_days)
       SELECT 'channel_day', $1, (now() at time zone 'utc')::date, 'recording', $2,
              $3 || '/' || to_char((now() at time zone 'utc')::date,'YYYY-MM-DD'),
              (extract(epoch from now())*1000)::bigint, ch.recording_retention_days
         FROM channels ch WHERE ch.id=$1
       ON CONFLICT (channel_id, day_utc) WHERE kind='channel_day' DO UPDATE
          SET status = 'recording', end_epoch_ms = NULL, duration_ms = NULL,
              hi_res_rendition = EXCLUDED.hi_res_rendition
        WHERE recordings.status <> 'recording'`,
      [channelId, topRend, prefix]
    );
  }

  /** Close recordings and enqueue a thumbnailer for each. rows: open recordings. */
  private async finalizeRecording(rec: any) {
    const dur = rec.duration_ms ?? 0;
    // fire the CPU thumbnailer against the recorded hi-res source
    const job = buildThumbnailerJobConfig({
      id: rec.id,
      kind: 'recording',
      source_master: `s3://${config.aws.s3Bucket}/${rec.master_key}/${rec.hi_res_rendition}/index.m3u8`,
      duration_sec: Math.max(1, Math.round(dur / 1000)),
      stream_id: rec.channel_id ?? rec.event_id,
    });
    try {
      await this.launcher.launchThumbnailer(job);
    } catch (e) {
      console.error('thumbnailer launch failed for recording', rec.id, e);
    }
    // Event recording → derive a full-event VOD, harvesting the event's metadata.
    // auto_vod is the event's explicit switch (settings form); default on.
    if (rec.event_id) {
      try {
        const ev = await one<any>('SELECT auto_vod FROM events WHERE id = $1', [rec.event_id]);
        if (ev?.auto_vod !== false) await deriveEventVod(rec);
        else console.log('auto-VOD skipped (disabled on event)', rec.event_id);
      } catch (e) {
        console.error('auto-VOD derive failed for recording', rec.id, e);
      }
    }
  }

  private async closeOpenRecordings(kind: 'channel' | 'event', id: string) {
    const col = kind === 'channel' ? 'channel_id' : 'event_id';
    const closed = await query<any>(
      `UPDATE recordings SET
         status='complete',
         end_epoch_ms = (extract(epoch from now())*1000)::bigint,
         duration_ms  = (extract(epoch from now())*1000)::bigint - start_epoch_ms,
         expires_at   = CASE WHEN retention_days IS NULL THEN NULL
                             ELSE now() + (retention_days || ' days')::interval END,
         thumb_status = 'processing'
       WHERE ${col}=$1 AND status='recording'
       RETURNING *`,
      [id]
    );
    for (const rec of closed) await this.finalizeRecording(rec);
  }

  // ---- scheduler tick ------------------------------------------------------
  async tick(): Promise<{ started: number; stopped: number }> {
    // 1) provision events whose server window has opened
    const due = await query<any>(
      `SELECT e.id FROM events e
        WHERE e.status='scheduled'
          AND COALESCE(e.server_start, e.scheduled_start) <= now()
          AND e.scheduled_end > now()`
    );
    for (const e of due) {
      try { await this.startStream('event', e.id, 'schedule'); } catch (err) { console.error('event start failed', e.id, err); }
    }
    // 2) stop events past their server window
    const over = await query<any>(
      `SELECT e.id FROM events e
        WHERE e.status='live' AND COALESCE(e.server_stop, e.scheduled_end) <= now()`
    );
    for (const e of over) {
      // The schedule IS intent: an event whose window closed is meant to be off,
      // and must not be resurrected by a reboot an hour later.
      try { await this.stopStream('event', e.id, 'scheduler:event-window-ended', 'schedule'); } catch (err) { console.error('event stop failed', e.id, err); }
    }
    // 3) roll channel recordings at the UTC day boundary (close stale, open today's)
    await this.rollChannelRecordings();
    // 4) fire scheduled clips whose end time has passed
    await this.fireScheduledClips();
    // 4b) post-airing EPG automation: cut a clip/VOD for ended programmes
    //     flagged auto_vod, named from the programme with its metadata
    await this.fireProgrammeClips();
    // 5) reconcile ORPHANED recordings: a row stays status='recording' forever
    //    if its channel/event stopped without passing through stopStream (encoder
    //    crash, process kill, control plane down at the time). The UI then shows
    //    'Recording' on a stopped channel. Close them, ending at the REAL last
    //    segment on disk rather than the sweep time.
    //
    //    ORDER MATTERS. The orphan-recording sweep refuses to close a recording
    //    while an un-terminated instance exists for that owner, so the claims
    //    have to be reaped first or the sweep finds nothing to do and the
    //    recording stays open forever. That was the deadlock.
    await this.reapOrphanInstances();
    await this.reconcileOrphanRecordings();
    // 6) file any recording that does not yet belong to a broadcast day.
    //    Filing used to happen only at boot, so a recording opened at 09:00
    //    stayed unfiled until the next restart: invisible to every question
    //    asked by broadcast day, and to the provenance chain that reaches a
    //    container through it. On the tick it is filed within thirty seconds,
    //    whatever path created it.
    await backfillContainers(200).catch((e) => console.error('[containers] tick backfill failed', e));
    // and close days that have ended and hold nothing still recording
    await closeFinishedContainers().catch((e) => console.error('[containers] close failed', e));
    // 7) bring the media lifecycle in line with what is on disk, and move
    //    outstanding restores forward. Both are cheap when there is nothing to
    //    do, and both are the difference between a lifecycle that describes the
    //    media and one that describes what it wishes were there.
    await reconcileAll({ actor: 'orchestrator:tick' })
      .catch((e) => console.error('[media] reconcile failed', e));
    await pollRestores().catch((e) => console.error('[media] restore poll failed', e));
    return { started: due.length, stopped: over.length };
  }

  /**
   * BOOT RECONCILIATION — make the stored status agree with reality.
   *
   * `channels.status` / `events.status` are a CACHE of a live fact: a process is
   * running, or it is not. The cache is only written on a clean start/stop, so a
   * crash, a kill, or the control plane going down mid-run leaves rows saying
   * 'live' forever. Everything downstream then lies in a different way:
   *   - the Radio list asks the pipeline and correctly says STOPPED;
   *   - Recordings trusts the flag and shows RECORDING on a dead station;
   *   - reconcileOrphanRecordings() is gated on the flag, so it never fires and
   *     the stale rows never get closed.
   *
   * So on boot we ask the truth (is anything actually running for this stream?)
   * and write it back. After this pass the orphan sweep does its job normally.
   * Returns the number of rows corrected.
   */
  /**
   * Check every un-terminated instance for one stream against the launcher,
   * close out the ones that are gone, and report whether anything survives.
   *
   * Closing the row is the half that stops the bleeding. `billable` is derived
   * from an open instance, so a crashed encoder that keeps its row keeps
   * metering — the operator is charged for compute that stopped existing. The
   * row is marked `terminated` with the same shape a clean stop writes, so
   * nothing downstream has to learn a new state.
   */
  private async reapDeadInstances(kind: 'channel' | 'event', id: string): Promise<boolean> {
    const col = kind === 'channel' ? 'channel_id' : 'event_id';
    const open = await query<any>(
      `SELECT id, task_arn, role FROM instances WHERE ${col} = $1 AND terminated_at IS NULL`,
      [id]
    );
    let alive = 0;
    for (const inst of open) {
      // Legacy in-process station: the launcher cannot answer for it, so the
      // process table has to. Note this still CLOSES the row when the pipeline
      // is gone rather than assuming it alive, which is the bug that let a
      // restarted control plane meter a station that no longer existed.
      if (String(inst.task_arn ?? '').startsWith('radio:')) {
        const { isRadioRunning } = await import('../radio/pipeline');
        if (kind === 'channel' && isRadioRunning(id)) { alive++; continue; }
        await query(
          `UPDATE instances SET state='terminated', terminated_at=now() WHERE id=$1`, [inst.id]
        );
        console.log(`[orchestrator] reaped dead in-process radio pipeline ${inst.task_arn} for channel ${id}`);
        continue;
      }
      let state: Liveness = 'unknown';
      try { state = await this.launcher.isRunning(inst.task_arn); }
      catch { state = 'unknown'; }
      if (state !== 'dead') { alive++; continue; }
      await query(
        `UPDATE instances SET state='terminated', terminated_at=now() WHERE id=$1`, [inst.id]
      );
      console.log(`[orchestrator] reaped dead instance ${inst.task_arn} (${inst.role}) for ${kind} ${id}`);
    }
    return alive > 0;
  }

  /**
   * Count a short-lived run against the auto-connect budget.
   *
   * "Short-lived" is measured from the newest instance row's launch, because
   * that is when the thing that just died was started. Anything inside
   * `resumeFlapSeconds` is a task that never really ran, which is the
   * signature of a broken configuration rather than a transient fault:
   * the source is gone, a required relay is not running, the credentials are
   * wrong. Retrying those forever burns CPU, fills the disk with empty run
   * directories, and on a real deployment launches a billable container every
   * twenty seconds for as long as the process lives.
   *
   * Hitting the cap records the reason and stops. The operator sees it on the
   * channel, and pressing Start clears it — so a stream is never written off
   * in a way they cannot undo once they have fixed the cause.
   */
  private async countFlap(
    kind: 'channel' | 'event',
    id: string,
    reason: string,
    dying: Array<{ launched_at: Date | null }>,
  ): Promise<void> {
    // The LONGEST-lived of the open runs. A stream can have several tasks (an
    // encoder plus a captions add-on); if any of them had been up a while, the
    // stream was genuinely running and this is not a flap.
    const launches = dying
      .map((r) => (r.launched_at ? new Date(r.launched_at).getTime() : null))
      .filter((t): t is number => t != null);
    if (!launches.length) return;
    const aliveSec = (Date.now() - Math.min(...launches)) / 1000;
    const table = kind === 'channel' ? 'channels' : 'events';

    // A RUN THAT PROVED ITSELF HANDS THE BUDGET BACK.
    //
    // This used to be a bare `return`, which left the counter wherever the last
    // flap had pushed it. That is wrong in the direction that matters: a busy
    // station that flapped four times last Tuesday, then aired without
    // interruption for a week, would give up on its very next incident and stay
    // off until somebody noticed. Outliving the flap window IS the evidence
    // that the configuration is sound, so the recovery budget is restored here
    // and nowhere else.
    if (aliveSec > config.orchestrator.resumeFlapSeconds) {
      await query(
        `UPDATE ${table} SET resume_attempts = 0, resume_last_error = NULL
          WHERE id = $1 AND resume_attempts > 0`, [id]);
      return;
    }

    // THE SHORT RUN. The reason is recorded here; the COUNT is not incremented
    // here. One attempt is one restart and the restart is counted by
    // stampAttempt in the resume pass, which is the only thing that performs
    // one. Counting in both places spent the budget twice per cycle and made
    // "five attempts" mean two and a half relaunches.
    const row = await one<any>(
      `UPDATE ${table}
          SET resume_last_error = $2,
              resume_gave_up_at = CASE
                WHEN resume_attempts >= $3 THEN now() ELSE resume_gave_up_at END
        WHERE id = $1
        RETURNING resume_attempts, resume_gave_up_at`,
      [id, `died after ${Math.round(aliveSec)}s: ${reason}`.slice(0, 300),
       config.orchestrator.resumeMaxAttempts]
    );
    if (row?.resume_gave_up_at) {
      console.error(
        `[orchestrator] ${kind} ${id} has crash-looped ${row.resume_attempts} times ` +
        `(last: ${reason}). Auto connect has stopped trying; start it by hand once the cause is fixed.`
      );
    } else {
      console.warn(`[orchestrator] ${kind} ${id} died after ${Math.round(aliveSec)}s ` +
                   `(attempt ${row?.resume_attempts} of ${config.orchestrator.resumeMaxAttempts})`);
    }
  }

  /**
   * RE-ATTACH TO A TASK THAT NEVER STOPPED.
   *
   * The cheap half of auto-connect, and the reason the reboot story is not
   * simply "start everything again". A task container takes no inbound
   * connections: it pulls from its source, pushes segments to storage and
   * pushes status to the API. A control plane that restarts in thirty seconds
   * therefore comes back to encoders that never missed a frame. All that is
   * actually stale is this database's opinion of them.
   *
   * So adoption writes the opinion back and touches nothing that is running.
   * It does NOT relaunch, does not stop, does not rebuild the job config, and
   * deliberately does not check whether the running task matches what the
   * profile says today: a channel whose ladder was edited while the control
   * plane was down should keep airing the ladder it is airing until somebody
   * restarts it on purpose. Surprising an operator with a mid-air re-encode is
   * a worse outcome than a stale ladder they can fix when they choose.
   *
   * The recording IS reopened, because the day may have rolled over while the
   * control plane was down and nothing else would open the new day's row.
   */
  async adoptRunning(kind: 'channel' | 'event', id: string): Promise<void> {
    const table = kind === 'channel' ? 'channels' : 'events';
    await tx(async (c) => {
      await c.query(
        `UPDATE ${table} SET status='live', updated_at=now(), desired_state='running'
          WHERE id=$1 AND status IS DISTINCT FROM 'live'`,
        [id]
      );
      if (kind === 'channel') {
        const ch = await c.query(
          `SELECT kind, recording_enabled FROM channels WHERE id=$1`, [id]);
        const row = ch.rows[0];
        if (row?.recording_enabled !== false) {
          await this.ensureChannelDayRecording(
            c, id, row?.kind === 'radio' ? 'audio' : '720p', `channel/${id}`);
        }
      }
    });
  }

  async reconcileStreamStatus(): Promise<number> {
    const live = await query<any>(
      `SELECT c.id, c.name, 'channel' AS kind FROM channels c WHERE c.status = 'live'
       UNION ALL
       SELECT e.id, e.name, 'event' AS kind FROM events e WHERE e.status = 'live'`
    );
    let fixed = 0;
    for (const row of live) {
      // A radio station's truth is its ffmpeg pipeline in THIS process. Anything
      // else is truthful only if it still has an un-terminated instance.
      // ONE PATH FOR BOTH KINDS. Radio used to branch here and ask an in-memory
      // map whether the station was alive, which was only ever true of the
      // process that happened to have started it. Now a station is a launched
      // task, so the same question reaches the same launcher, and this function
      // no longer knows or cares that radio exists.
      let running: boolean;
      {
        // ASK THE LAUNCHER, NOT THE ROW.
        //
        // This used to be `SELECT 1 FROM instances WHERE terminated_at IS NULL`
        // — but only stopStream ever writes terminated_at, so the row is a
        // CLAIM that something was started, never evidence that it is still
        // running. A crashed encoder left the claim standing, this check said
        // "running", and the channel stayed `live` and billing indefinitely.
        // The reconciler existed to catch exactly this and was asking the
        // claim to vouch for itself.
        //
        // Now every un-terminated instance is checked against the launcher.
        // `unknown` counts as running: an unreachable control plane must never
        // tear down a healthy channel. Only a definite `dead` reconciles, and
        // the dead row is closed out so billing stops with it.
        running = await this.reapDeadInstances(row.kind, row.id);
      }
      if (running) continue;
      const table = row.kind === 'channel' ? 'channels' : 'events';
      // 'ended' is what a clean stopStream() writes for both kinds, so a
      // reconciled row is indistinguishable from a properly stopped one.
      const next = 'ended';
      await query(`UPDATE ${table} SET status = $2::asset_status, updated_at = now() WHERE id = $1`,
        [row.id, next]);
      fixed++;
      console.log(`[orchestrator] reconciled ${row.kind} ${row.name} (${row.id}): live -> ${next} (nothing running)`);
    }
    if (fixed) {
      // Their recordings are now closeable by the normal path.
      await this.reconcileOrphanRecordings();
    }
    return fixed;
  }

  /**
   * REAP OPEN INSTANCE ROWS WHOSE OWNER IS NOT LIVE.
   *
   * This closes a deadlock that could not be escaped from inside the product.
   *
   * reconcileStreamStatus() only ever looks at channels and events whose
   * status is 'live'. That is the right work list for correcting a status, but
   * it is the wrong one for reaping a claim, and the difference bites whenever
   * an owner is set to 'ended' while its instance row is still open. Then:
   *
   *   - the owner is not 'live', so the reaper never visits it and the
   *     instance row is never closed;
   *   - reconcileOrphanRecordings() refuses to close a recording while an
   *     un-terminated instance exists for that owner, so the recording stays
   *     'recording';
   *   - and nothing else in the system looks at either row again.
   *
   * The result is a station that shows as recording with nothing running, and
   * no sequence of starting and stopping it clears the state, because start
   * finds the open row and treats the stream as already running.
   *
   * run-on-mac.sh reaches this state on EVERY run: it sets every live channel
   * to 'ended' before the API boots, precisely so the list is truthful, which
   * makes the leftover instance rows permanently invisible to the reaper.
   *
   * The fix is to work from the CLAIMS rather than from the owners. An open
   * instance whose owner is not live is not less suspicious than one whose
   * owner is live; it is more. So it is asked about directly, and the same
   * launcher answer decides, with the same rule: only a definite `dead`
   * reconciles, `unknown` leaves it alone.
   */
  async reapOrphanInstances(): Promise<number> {
    const owners = await query<any>(
      `SELECT DISTINCT COALESCE(i.channel_id, i.event_id) AS id,
              CASE WHEN i.channel_id IS NOT NULL THEN 'channel' ELSE 'event' END AS kind
         FROM instances i
         LEFT JOIN channels c ON c.id = i.channel_id
         LEFT JOIN events   e ON e.id = i.event_id
        WHERE i.terminated_at IS NULL
          AND COALESCE(c.status, e.status) IS DISTINCT FROM 'live'`
    );
    let closed = 0;
    for (const o of owners) {
      if (!o.id) continue;
      const col = o.kind === 'channel' ? 'channel_id' : 'event_id';
      const before = await query<any>(
        `SELECT id FROM instances WHERE ${col} = $1 AND terminated_at IS NULL`, [o.id]);
      try {
        // reapDeadInstances asks the launcher about every open row for this
        // owner and closes the definitely-dead ones. Reused rather than
        // reimplemented so the legacy in-process radio branch, the
        // `unknown`-means-leave-it rule and the log line all stay in one place.
        await this.reapDeadInstances(o.kind, o.id);
      } catch (e) {
        console.error('[orchestrator] orphan instance reap failed for', o.kind, o.id, e);
        continue;
      }
      const after = await query<any>(
        `SELECT id FROM instances WHERE ${col} = $1 AND terminated_at IS NULL`, [o.id]);
      const n = before.length - after.length;
      if (n > 0) {
        closed += n;
        console.log(`[orchestrator] reaped ${n} orphaned instance row(s) for ${o.kind} ${o.id} (owner is not live)`);
      }
    }
    return closed;
  }

  /** Close recording rows whose owner is not live any more. End time comes from
   *  the newest recorded segment on disk inside the recording window (falls back
   *  to now if nothing is on disk). Runs every tick; matches nothing normally. */
  async reconcileOrphanRecordings(): Promise<number> {
    const orphans = await query<any>(
      `SELECT r.* FROM recordings r
         LEFT JOIN channels c ON c.id = r.channel_id
         LEFT JOIN events   e ON e.id = r.event_id
        WHERE r.status = 'recording'
          AND COALESCE(c.status, e.status) IS DISTINCT FROM 'live'
          AND NOT EXISTS (SELECT 1 FROM instances i
                           WHERE (i.channel_id = r.channel_id OR i.event_id = r.event_id)
                             AND i.terminated_at IS NULL)`
    );
    for (const rec of orphans) {
      try {
        const streamId = rec.channel_id ?? rec.event_id;
        let endMs = Date.now();
        try {
          const { recordingSpans } = await import('../localRecordingIndex');
          const spans = recordingSpans(streamId)
            .filter((s) => s.endMs > Number(rec.start_epoch_ms));
          if (spans.length) endMs = Math.min(endMs, spans[spans.length - 1].endMs);
        } catch { /* no local index (S3 deploy) — close at now */ }
        endMs = Math.max(endMs, Number(rec.start_epoch_ms) + 1000);
        const closed = await one<any>(
          `UPDATE recordings SET
             status='complete',
             end_epoch_ms = $2,
             duration_ms  = $2 - start_epoch_ms,
             expires_at   = CASE WHEN retention_days IS NULL THEN NULL
                                 ELSE to_timestamp($2/1000.0) + make_interval(days => retention_days) END,
             thumb_status = 'processing'
           WHERE id = $1 AND status='recording' RETURNING *`,
          [rec.id, Math.round(endMs)]
        );
        if (closed) {
          console.log(`[orchestrator] closed orphaned recording ${rec.id} (owner not live), end=${new Date(endMs).toISOString()}`);
          await this.finalizeRecording(closed).catch((e: unknown) =>
            console.error('orphan recording close hooks failed', rec.id, e));
        }
      } catch (e) {
        console.error('orphan recording reconcile failed', rec.id, e);
      }
    }
    return orphans.length;
  }

  /**
   * POST-AIRING AUTOMATION from the EPG: for every programme flagged auto_vod
   * whose airing has ended, cut a clip/VOD of exactly that slot from the
   * owner's recording. The asset takes the PROGRAMME's identity: its title and
   * its metadata (harvested onto the vod asset), so the guide is the single
   * place the show's details are typed. As-run times win over scheduled when
   * the airing was observed. A claim guard (clip_status) makes firing
   * exactly-once across ticks; a missing recording is recorded as clip_error
   * rather than retried forever (7-day lookback window).
   */
  /**
   * Fire the post-airing conversion for every slot that is due.
   *
   * The conversion itself lives in services/epgVod.ts and is shared with the
   * manual "convert now" action on the schedule. It used to be inline here,
   * which meant the operator-triggered path either did not exist or would have
   * been a second copy: same claim, same recording lookup, same asset creation,
   * same metadata harvest, same build enqueue, and five chances to diverge.
   *
   * The seven-day floor stays. A slot older than that whose automatic
   * conversion never ran is not something to fire silently a week late; it is
   * shown on the schedule as convertible, with the operator deciding.
   */
  async fireProgrammeClips(): Promise<number> {
    const due = await query<any>(
      `SELECT id, title FROM programmes
        WHERE auto_vod AND clip_status='none'
          AND COALESCE(actual_end, ends_at) <= now()
          AND ends_at > now() - interval '7 days'`
    );
    let fired = 0;
    for (const p of due) {
      try {
        const r = await convertProgramme(p.id);
        if ('assetId' in r) {
          fired++;
          console.log(`[orchestrator] EPG auto-clip created for programme "${p.title}" (${p.id}) -> asset ${r.assetId}`);
        }
      } catch (e) {
        // convertProgramme has already recorded the reason on the row.
        console.error('programme auto-clip failed', p.id, e);
      }
    }
    return fired;
  }

  /** Cut a VOD asset for every scheduled clip whose end time has arrived. */
  async fireScheduledClips(): Promise<number> {
    const nowMs = `(extract(epoch from now())*1000)::bigint`;
    const due = await query<any>(
      `SELECT * FROM scheduled_clips WHERE status='scheduled' AND end_epoch_ms <= ${nowMs}`
    );
    for (const sc of due) {
      try {
        // claim it (avoid double-firing across ticks)
        const claimed = await one<any>(`UPDATE scheduled_clips SET status='firing' WHERE id=$1 AND status='scheduled' RETURNING id`, [sc.id]);
        if (!claimed) continue;
        const col = sc.channel_id ? 'channel_id' : 'event_id';
        const ownerId = sc.channel_id ?? sc.event_id;
        const rec = await one<any>(
          `SELECT * FROM recordings WHERE ${col}=$1
             AND start_epoch_ms <= $2 AND (end_epoch_ms IS NULL OR end_epoch_ms >= $3)
           ORDER BY start_epoch_ms DESC LIMIT 1`,
          [ownerId, sc.start_epoch_ms, sc.end_epoch_ms]
        );
        if (!rec) {
          await query(`UPDATE scheduled_clips SET status='error' WHERE id=$1`, [sc.id]);
          continue;
        }
        const vod = await createClipVod({
          ownerCol: col as 'channel_id' | 'event_id',
          ownerId,
          recordingId: rec.id,
          title: sc.title,
          startMs: sc.start_epoch_ms,
          endMs: sc.end_epoch_ms,
          outputKind: sc.output_kind,
          masterKeyBase: rec.master_key ?? 'vod',
        });
        // Same omission, same fix: 'done' has to mean the build was queued.
        await enqueueClipBuild({
          vodAssetId: (vod as any).id, streamId: ownerId,
          fromMs: sc.start_epoch_ms, toMs: sc.end_epoch_ms,
          outputKind: sc.output_kind,
          channelId: sc.channel_id ?? null, eventId: sc.event_id ?? null,
        });
        await query(`UPDATE scheduled_clips SET status='done', vod_asset_id=$2 WHERE id=$1`, [sc.id, (vod as any).id]);
      } catch (e) {
        console.error('[orchestrator] scheduled clip fire failed', sc.id, e);
        await query(`UPDATE scheduled_clips SET status='error' WHERE id=$1`, [sc.id]).catch(() => {});
      }
    }
    return due.length;
  }

  private async rollChannelRecordings() {
    // close channel_day recordings whose day is before today (still 'recording')
    const stale = await query<any>(
      `SELECT * FROM recordings
        WHERE kind='channel_day' AND status='recording'
          AND day_utc < (now() at time zone 'utc')::date`
    );
    for (const rec of stale) {
      const closed = await query<any>(
        `UPDATE recordings SET status='complete',
           end_epoch_ms=(extract(epoch from now())*1000)::bigint,
           duration_ms=(extract(epoch from now())*1000)::bigint - start_epoch_ms,
           expires_at = CASE WHEN retention_days IS NULL THEN NULL
                             ELSE now() + (retention_days || ' days')::interval END,
           thumb_status='processing'
         WHERE id=$1 AND status='recording' RETURNING *`,
        [rec.id]
      );
      for (const r of closed) await this.finalizeRecording(r);
    }
    // open today's recording for every live channel
    const liveChans = await query<any>(`SELECT id FROM channels WHERE status='live'`);
    for (const ch of liveChans) {
      await tx((c) => this.ensureChannelDayRecording(c, ch.id, 'source', `channel/${ch.id}`));
    }
  }

  // ---- retention sweep -----------------------------------------------------
  /**
   * Walk the retention ladder.
   *
   * This used to be `DELETE FROM recordings WHERE expires_at < now()` with a
   * TODO where the storage cleanup should be — which lost the record along with
   * the bytes, had exactly one action, and left the actual files on disk. It now
   * walks each object's ladder: cool it, archive it, or delete it, with every
   * transition logged and the row kept as a tombstone so "what happened to the
   * 3rd of March" has an answer.
   *
   * The legacy `expires_at` column is still honoured for recordings that have
   * one and no rule, so upgrading a deployment does not silently stop expiring
   * things that were already set to expire.
   */
  async sweepRetention(): Promise<number> {
    const result = await sweep({ actor: 'retention:sweep' });
    if (result.cooled || result.archived || result.deleted || result.failed
        || result.unavailable || result.orphaned) {
      console.log(
        `[retention] ${result.considered} considered: ${result.cooled} cooled, ` +
        `${result.archived} archived, ${result.deleted} deleted, ` +
        `${result.orphaned} orphaned reclaimed, ` +
        `${result.skippedOnHold} on hold, ${result.unavailable} unavailable, ${result.failed} failed`
      );
    }

    // LEGACY PATH. Recordings carrying an expires_at from before the ladder
    // existed, and governed by no rule, still expire — but they are now marked
    // rather than deleted outright, so the library keeps the knowledge that they
    // were there and the provenance chain still reaches them.
    const legacy = await query<any>(
      `SELECT r.id, r.channel_id, r.event_id FROM recordings r
        WHERE r.expires_at IS NOT NULL AND r.expires_at < now()
          AND r.storage_state IS DISTINCT FROM 'deleted'
        LIMIT 200`
    );
    let legacyDone = 0;
    for (const rec of legacy) {
      const rule = await ruleFor({ channelId: rec.channel_id, eventId: rec.event_id, appliesTo: 'recording' });
      if (rule) continue;            // the ladder owns it; leave it alone
      const objs = await query<any>(`SELECT id FROM media_objects WHERE recording_id = $1`, [rec.id]);
      for (const o of objs) {
        try {
          await transition(o.id, 'deleting', { action: 'delete', actor: 'retention:legacy-expiry' });
          for (const l of await locationsOf(o.id)) {
            await storageDriver().remove(l.uri);
            await query(`UPDATE media_locations SET present = false, removed_at = now() WHERE id = $1`, [l.id]);
          }
          await transition(o.id, 'deleted', {
            action: 'delete', actor: 'retention:legacy-expiry',
            detail: 'expires_at passed and no retention rule governs this channel',
          });
        } catch (e) { console.error('[retention] legacy expiry failed for', o.id, e); }
      }
      await query(`UPDATE recordings SET storage_state = 'deleted' WHERE id = $1`, [rec.id]);
      legacyDone++;
    }
    if (legacyDone) console.log(`[retention] ${legacyDone} recording(s) expired under the legacy expires_at column`);

    // ANALYTICS RETENTION, on the same sweep. Seal each finished day's figures
    // from complete raw data, then delete the raw data behind sealed days only.
    // Reports outlive the events they were computed from; that is the promise,
    // and the ordering is what keeps it.
    await sweepAnalytics().catch((e) => console.error('[analytics] sweep failed', e));

    // Abandoned uploads hold staged chunks on disk, and a half-uploaded loop is
    // the one thing nobody comes back for. The expiry is extended by every chunk
    // that arrives, so only a session that has been silent for the whole window
    // is swept.
    await sweepUploads().catch((e) => console.error('[uploads] sweep failed', e));

    return result.deleted + legacyDone;
  }
}
