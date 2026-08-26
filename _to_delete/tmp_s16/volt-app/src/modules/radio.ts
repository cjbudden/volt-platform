/**
 * RADIO — audio-only station management (see RADIO.md).
 *
 * Stations ARE channels (kind='radio'), so groups/recording/EPG/permissions all
 * apply unchanged; this module is the radio-shaped surface over them:
 *   GET  /            station list (+ live pipeline state, now-playing)
 *   GET  /:id         detail: config, sources, output URLs, ICY state, open recording
 *   POST /:id/start   start the audio pipeline (orchestrator branches on kind)
 *   POST /:id/stop    stop it (closes the recording like any channel)
 *   GET  /:id/nowplaying   live ICY state + the log entry currently open
 *   GET  /:id/log     the timed metadata log (programmes rows): ?from&to&q&class
 *
 * The public MP3 listener endpoint (/radio/:id/stream.mp3) is mounted unauthed
 * in server.ts, mirroring /origin for HLS/DASH.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest } from '../util/http';
import { orchestrator } from '../services/orchestrator';
import { radioStatus } from '../services/radio/pipeline';
import { icyState } from '../services/radio/icyMeta';
import { radioLevels } from '../services/radio/monitor';
import { loadRadioHealth, radioEventLog, radioQc, radioStatusBoard, radioHasValidContent } from '../services/radio/detail';
import { writeAudit, actor } from '../services/audit';

export const radioRouter = Router();
radioRouter.use(requireAuth);

async function ownedStation(req: any) {
  const row = await one<any>(
    `SELECT c.*, g.name AS group_name FROM channels c JOIN groups g ON g.id=c.group_id
      WHERE c.id=$1 AND g.account_id=$2 AND c.kind='radio'`,
    [req.params.id, accountId(req)]
  );
  if (!row) throw notFound('Station not found');
  return row;
}

/** PREVIEW urls: private monitoring paths, available as soon as the station runs
 *  (the radio equivalent of a channel's /origin preview). */
function outputUrls(id: string, cfg: any) {
  const outs = { mp3: true, hls: true, dash: true, ...(cfg?.outputs ?? {}) };
  return {
    mp3: outs.mp3 ? `/radio/${id}/stream.mp3` : null,
    hls: outs.hls ? `/origin/${id}/live/master.m3u8` : null,
    dash: outs.dash ? `/origin/${id}/live/dash/manifest.mpd` : null,
  };
}

/** PUBLIC urls: only serve once the station is ON AIR (see publicLive/radio gate). */
function publicUrls(id: string, cfg: any) {
  const outs = { mp3: true, hls: true, dash: true, ...(cfg?.outputs ?? {}) };
  return {
    mp3: outs.mp3 ? `/live/${id}/stream.mp3` : null,
    hls: outs.hls ? `/live/${id}/master.m3u8` : null,
    dash: outs.dash ? `/live/${id}/manifest.mpd` : null,
  };
}

radioRouter.get('/', asyncHandler(async (req, res) => {
  const rows = await query<any>(
    `SELECT c.id, c.name, c.status, c.group_id, g.name AS group_name, c.kind,
            c.radio_config, c.recording_enabled, c.recording_retention_sec, c.brand_ref,
            c.on_air, c.created_at, c.version
       FROM channels c JOIN groups g ON g.id=c.group_id
      WHERE g.account_id=$1 AND c.kind='radio' ORDER BY c.created_at DESC`,
    [accountId(req)]
  );
  const out = await Promise.all(rows.map(async (r) => {
    const rs = radioStatus(r.id);
    const icy = rs.running ? rs.icy : icyState(r.id);
    const health = await loadRadioHealth(r);
    return {
      ...r,
      pipeline: rs,
      nowPlaying: icy?.title ?? null,
      nowPlayingClass: icy?.class ?? null,
      outputs: outputUrls(r.id, r.radio_config),
      publicUrls: publicUrls(r.id, r.radio_config),
      // same roll-up the channels list uses, so radio and TV statuses agree
      pipelineState: health.overall,
      onAir: health.onAir,
      signal: radioQc(r.id).verdict,
    };
  }));
  res.json(out);
}));

radioRouter.get('/:id', asyncHandler(async (req, res) => {
  const c = await ownedStation(req);
  const sources = await query<any>(
    `SELECT id, role, protocol, ingest_url, stream_key, status FROM stream_inputs WHERE channel_id=$1 ORDER BY role`,
    [c.id]
  );
  const rs = radioStatus(c.id);
  const openRec = await one<any>(
    `SELECT id, start_epoch_ms, status FROM recordings
      WHERE channel_id=$1 AND status='recording' ORDER BY start_epoch_ms DESC LIMIT 1`, [c.id]);
  const recent = await query<any>(
    `SELECT id, title, starts_at, ends_at, status, metadata
       FROM programmes WHERE channel_id=$1 AND metadata->>'source'='icy'
      ORDER BY starts_at DESC LIMIT 20`, [c.id]);
  const health = await loadRadioHealth(c);
  const qc = radioQc(c.id);
  res.json({
    ...c,
    sources,
    pipeline: rs,
    icy: rs.running ? rs.icy : icyState(c.id),
    outputs: outputUrls(c.id, c.radio_config),
    publicUrls: publicUrls(c.id, c.radio_config),
    openRecording: openRec ?? null,
    recentLog: recent,
    // parity with the channel control page: gates, QC, event log, status board
    health,
    pipelineState: health.overall,
    onAir: health.onAir,
    qc,
    statusBoard: radioStatusBoard(health, qc),
    log: await radioEventLog(c.id),
    publicAvailable: c.on_air === true && radioHasValidContent(c.id),
  });
}));

radioRouter.post('/:id/start', asyncHandler(async (req, res) => {
  const c = await ownedStation(req);
  const { isRadioRunning } = await import('../services/radio/pipeline');
  if (c.status === 'live' && isRadioRunning(c.id)) throw badRequest('Station is already running');
  // status 'live' with no pipeline = orphan from a control-plane restart:
  // clean the stale instances/recording first, then start fresh.
  if (c.status === 'live') await orchestrator.stopStream('channel', c.id, 'reconcile-restart');
  await orchestrator.startStream('channel', c.id);
  res.json({ id: c.id, status: 'live', pipeline: radioStatus(c.id) });
}));

radioRouter.post('/:id/stop', asyncHandler(async (req, res) => {
  const c = await ownedStation(req);
  // Stopping the station also takes it off air: nothing public may outlive the run.
  if (c.on_air) {
    await query(`UPDATE channels SET on_air=false, updated_at=now() WHERE id=$1`, [c.id]);
    await query(`INSERT INTO stream_events(channel_id, type, detail, ts)
                 VALUES ($1,'channel.off_air','{"reason":"station stopped"}'::jsonb, now())`, [c.id]);
  }
  await orchestrator.stopStream('channel', c.id, 'operator');
  res.json({ id: c.id, status: 'ended', on_air: false });
}));

/**
 * GO ON AIR / TAKE OFF AIR — the second, explicit step (same contract as
 * channels). Starting a station only receives, encodes and records: the output
 * is a PRIVATE preview. Going on air is what opens the public URLs
 * (/live/:id/stream.mp3 | master.m3u8 | manifest.mpd).
 */
radioRouter.post('/:id/air', asyncHandler(async (req, res) => {
  const c = await ownedStation(req);
  const on = z.object({ on: z.boolean() }).parse(req.body).on;
  if (on) {
    if (c.status !== 'live') throw badRequest('Start the station before going on air');
    if (!radioHasValidContent(c.id)) throw badRequest('No valid output yet: wait for the first audio segments');
  }
  const row = await one<any>(
    `UPDATE channels SET on_air=$2, updated_at=now() WHERE id=$1 RETURNING id, name, on_air, status`,
    [c.id, on]);
  await query(`INSERT INTO stream_events(channel_id, type, detail, ts) VALUES ($1,$2,$3::jsonb, now())`,
    [c.id, on ? 'channel.air' : 'channel.off_air',
     JSON.stringify({ message: on ? 'public delivery opened' : 'public delivery closed' })]);
  const who = actor(req);
  await writeAudit(null, {
    accountId: accountId(req), userId: who.userId, label: who.label,
    action: 'update', entityType: 'channel', entityId: c.id,
    snapshot: { name: c.name, kind: 'radio', on_air: on },
  }).catch(() => {});
  res.json({ ...row, publicUrls: on ? publicUrls(c.id, c.radio_config) : null });
}));

/** LEVELS FEED — server-measured audio levels for the visualiser. This is what
 *  makes the meter move whether or not anyone is listening: it is measured from
 *  the broadcast output, not from the operator's speakers. */
radioRouter.get('/:id/levels', asyncHandler(async (req, res) => {
  const c = await ownedStation(req);
  const limit = Math.min(120, Math.max(1, parseInt(String(req.query.limit ?? '30'), 10) || 30));
  const l = radioLevels(c.id, limit);
  const qc = radioQc(c.id);
  res.json({
    stationId: c.id,
    running: radioStatus(c.id).running,
    verdict: l.verdict,
    lastSampleAt: l.lastSampleAt,
    level: qc.level,
    samples: l.samples,
  });
}));

/** QC panel: verdict, invariant checks, issues, gates. */
radioRouter.get('/:id/qc', asyncHandler(async (req, res) => {
  const c = await ownedStation(req);
  const health = await loadRadioHealth(c);
  res.json({ stationId: c.id, health, qc: radioQc(c.id), statusBoard: radioStatusBoard(health, radioQc(c.id)) });
}));

/** Event log (lifecycle + errors + QC), newest first. Distinct from /log, which
 *  is the station's now-playing METADATA log. */
radioRouter.get('/:id/events', asyncHandler(async (req, res) => {
  const c = await ownedStation(req);
  res.json({ stationId: c.id, entries: await radioEventLog(c.id) });
}));

radioRouter.get('/:id/nowplaying', asyncHandler(async (req, res) => {
  const c = await ownedStation(req);
  const rs = radioStatus(c.id);
  const icy = rs.running ? rs.icy : icyState(c.id);
  const open = await one<any>(
    `SELECT id, title, starts_at, metadata FROM programmes
      WHERE channel_id=$1 AND metadata->>'source'='icy' AND status='live'
      ORDER BY starts_at DESC LIMIT 1`, [c.id]);
  res.json({
    running: rs.running,
    listeners: rs.running ? rs.listeners : 0,
    station: icy?.station ?? null,
    title: icy?.title ?? null,
    class: icy?.class ?? null,
    since: icy?.since ?? null,
    streamUrl: icy?.streamUrl ?? null,
    entry: open ?? null,
  });
}));

/** Timed metadata log — the station's as-received content history. */
const logQuery = z.object({
  from: z.string().optional(),           // ISO; default 24h back
  to: z.string().optional(),
  q: z.string().optional(),              // title search
  class: z.enum(['song', 'ad', 'content']).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});
radioRouter.get('/:id/log', asyncHandler(async (req, res) => {
  const c = await ownedStation(req);
  const p = logQuery.parse(req.query);
  const from = p.from ? new Date(p.from) : new Date(Date.now() - 24 * 3600_000);
  const to = p.to ? new Date(p.to) : new Date(Date.now() + 60_000);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) throw badRequest('bad from/to');
  const rows = await query<any>(
    `SELECT id, title, starts_at, ends_at, status,
            metadata->>'class' AS class, metadata->>'stream_url' AS stream_url
       FROM programmes
      WHERE channel_id=$1 AND metadata->>'source'='icy'
        AND ends_at > $2 AND starts_at < $3
        AND ($4::text IS NULL OR title ILIKE '%'||$4||'%')
        AND ($5::text IS NULL OR metadata->>'class' = $5)
      ORDER BY starts_at DESC LIMIT $6`,
    [c.id, from.toISOString(), to.toISOString(), p.q?.trim() || null, p.class ?? null, p.limit]
  );
  const counts = await query<any>(
    `SELECT COALESCE(metadata->>'class','content') AS class, count(*)::int AS n
       FROM programmes
      WHERE channel_id=$1 AND metadata->>'source'='icy' AND ends_at > $2 AND starts_at < $3
      GROUP BY 1`, [c.id, from.toISOString(), to.toISOString()]);
  res.json({
    stationId: c.id,
    from: from.toISOString(), to: to.toISOString(),
    counts: Object.fromEntries(counts.map((r: any) => [r.class, r.n])),
    entries: rows,
  });
}));
