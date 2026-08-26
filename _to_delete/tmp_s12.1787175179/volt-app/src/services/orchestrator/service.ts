import { query, one, tx } from '../../db';
import { config } from '../../config';
import { buildEncoderJobConfig, buildThumbnailerJobConfig, JobConfigCtx } from '../jobConfig';
import { resolveCaptionsPlan, buildCaptionsJobConfig } from '../captionsPlan';
import { createClipVod, deriveEventVod } from '../clips';
import { TaskLauncher, makeLauncher } from './launcher';

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
export class Orchestrator {
  constructor(private launcher: TaskLauncher = makeLauncher()) {}

  // ---- context loading -----------------------------------------------------
  private async loadContext(kind: 'channel' | 'event', id: string): Promise<JobConfigCtx | null> {
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
  async startStream(kind: 'channel' | 'event', id: string): Promise<{ taskArn: string }> {
    const ctx = await this.loadContext(kind, id);
    if (!ctx) throw new Error('stream not found');
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

    await tx(async (c) => {
      await c.query(
        `INSERT INTO instances(${col}, task_arn, is_gpu, lifecycle, role, state, launched_at)
         VALUES ($1,$2,$3,$4,'primary','running', now())`,
        [id, res.taskArn, isGpu, res.lifecycle]
      );
      if (capRes) {
        await c.query(
          `INSERT INTO instances(${col}, task_arn, is_gpu, instance_type, lifecycle, role, state, launched_at)
           VALUES ($1,$2,true,$3,$4,'captions','running', now())`,
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
      await c.query(
        `UPDATE ${kind === 'channel' ? 'channels' : 'events'} SET status='live', updated_at=now() WHERE id=$1`,
        [id]
      );
    });
    return { taskArn: res.taskArn };
  }

  /**
   * Stop a stream's encoder task(s). `origin` records WHO/WHY (operator click,
   * scheduler window, failover, shutdown) so the control-plane log and the
   * encoder's channel.stop reason are self-explaining instead of a mystery. This
   * is the difference between "the operator stopped it" and "it failed".
   */
  async stopStream(kind: 'channel' | 'event', id: string, origin = 'unknown'): Promise<void> {
    console.log(`[orchestrator] stopStream ${kind} ${id} — origin=${origin}`);
    const running = await query<any>(
      `SELECT * FROM instances WHERE ${kind === 'channel' ? 'channel_id' : 'event_id'}=$1 AND terminated_at IS NULL`,
      [id]
    );
    for (const inst of running) {
      if (inst.task_arn) {
        try {
          await this.launcher.stopTask(inst.task_arn, `${kind} ${id} stopped (${origin})`);
        } catch (e) {
          console.error('stopTask failed', inst.task_arn, e);
        }
      }
      await query(`UPDATE instances SET state='terminated', terminated_at=now() WHERE id=$1`, [inst.id]);
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
    // one recording per channel per UTC day; no-op if today's already exists
    await c.query(
      `INSERT INTO recordings(kind, channel_id, day_utc, status, hi_res_rendition, master_key,
                              start_epoch_ms, retention_days)
       SELECT 'channel_day', $1, (now() at time zone 'utc')::date, 'recording', $2,
              $3 || '/' || to_char((now() at time zone 'utc')::date,'YYYY-MM-DD'),
              (extract(epoch from now())*1000)::bigint, ch.recording_retention_days
         FROM channels ch WHERE ch.id=$1
       ON CONFLICT (channel_id, day_utc) WHERE kind='channel_day' DO NOTHING`,
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
    if (rec.event_id) {
      try {
        await deriveEventVod(rec);
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
      try { await this.startStream('event', e.id); } catch (err) { console.error('event start failed', e.id, err); }
    }
    // 2) stop events past their server window
    const over = await query<any>(
      `SELECT e.id FROM events e
        WHERE e.status='live' AND COALESCE(e.server_stop, e.scheduled_end) <= now()`
    );
    for (const e of over) {
      try { await this.stopStream('event', e.id, 'scheduler:event-window-ended'); } catch (err) { console.error('event stop failed', e.id, err); }
    }
    // 3) roll channel recordings at the UTC day boundary (close stale, open today's)
    await this.rollChannelRecordings();
    // 4) fire scheduled clips whose end time has passed
    await this.fireScheduledClips();
    return { started: due.length, stopped: over.length };
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
  async sweepRetention(): Promise<number> {
    // delete recordings past their expiry (S3 object cleanup is enqueued
    // separately; here we drop the index rows so they leave the library).
    const expired = await query<any>(
      `DELETE FROM recordings WHERE expires_at IS NOT NULL AND expires_at < now() RETURNING id, master_key`
    );
    if (expired.length) {
      console.log(`[retention] swept ${expired.length} expired recording(s)`);
      // TODO: enqueue S3 prefix deletion for each master_key.
    }
    return expired.length;
  }
}
