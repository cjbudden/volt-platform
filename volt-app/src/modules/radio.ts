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
import { radioRunState, radioRunStates } from '../services/radio/state';
import { icyState, probeIcySource } from '../services/radio/icyMeta';
import { radioLevels } from '../services/radio/monitor';
import { loadRadioHealth, radioEventLog, radioQc, radioStatusBoard, radioHasValidContent } from '../services/radio/detail';
import { writeAudit, actor } from '../services/audit';
import {
  resolveNowPlaying, sourceCarriesTitles, scheduledNowTitle,
  listenerCounts, listenerCountsMany,
} from '../services/radio/nowPlaying';

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
function outputUrls(id: string, cfg: any, degraded: Record<string, string> = {}) {
  // THE CONFIG IS A REQUEST; THE RUNNING ENCODER HAS THE CASTING VOTE.
  //
  // A URL offered here is a promise that there is audio behind it. radio.py
  // drops the MP3 output when the Icecast relay is unreachable and goes on air
  // over HLS and DASH instead, so on a machine with no relay the configured MP3
  // URL leads nowhere. Advertising it regardless is what made a perfectly
  // healthy station play silence: the console tries MP3 first, and a URL with
  // nothing behind it is indistinguishable from a broken player.
  const outs: Record<string, boolean> = { mp3: true, hls: true, dash: true, ...(cfg?.outputs ?? {}) };
  const live = (k: string) => !!outs[k] && !degraded[k];
  return {
    mp3: live('mp3') ? `/radio/${id}/stream.mp3` : null,
    hls: live('hls') ? `/origin/${id}/live/master.m3u8` : null,
    dash: live('dash') ? `/origin/${id}/live/dash/manifest.mpd` : null,
    // Named, so the console can SAY why an output is missing rather than just
    // silently offering one fewer. Empty when the station is producing
    // everything its config asked for.
    degraded,
  };
}

/** What the RUNNING encoder has dropped, as {output: reason}. */
async function degradedOutputs(id: string): Promise<Record<string, string>> {
  const row = await one<{ degraded_outputs: Record<string, string> }>(
    `SELECT degraded_outputs FROM stream_status WHERE channel_id = $1`, [id]);
  return row?.degraded_outputs ?? {};
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

/**
 * PROBE a source URL before it is saved — "what does this stream say it is?"
 *
 * The settings form calls this while the operator is still typing the URL, so
 * they can see the station's own name, genre, homepage, bitrate, codec, what is
 * playing and any artwork it publishes, and choose which of those to adopt
 * rather than retyping them. Nothing is written and no pipeline starts: this
 * reads the ICY headers plus one metadata block and hangs up.
 *
 * It is registered BEFORE '/:id' so the literal path wins over the parameter.
 */
radioRouter.post('/probe', asyncHandler(async (req, res) => {
  const body = z.object({ url: z.string().min(4) }).parse(req.body);
  const url = body.url.trim();
  if (!/^https?:\/\//i.test(url)) throw badRequest('Source URL must start with http:// or https://');
  res.json(await probeIcySource(url));
}));

radioRouter.get('/', asyncHandler(async (req, res) => {
  const rows = await query<any>(
    `SELECT c.id, c.name, c.status, c.group_id, g.name AS group_name, c.kind,
            c.radio_config, c.recording_enabled, c.recording_retention_sec, c.brand_ref,
            c.on_air, c.created_at, c.version
       FROM channels c JOIN groups g ON g.id=c.group_id
      WHERE g.account_id=$1 AND c.kind='radio' ORDER BY c.created_at DESC`,
    [accountId(req)]
  );
  // ONE query for the whole list. This used to be a Map lookup per row, which
  // was free; against the database it would be a query per station, so the
  // batch form exists for exactly this caller.
  const states = await radioRunStates(rows.map((r: any) => r.id));
  // EVERYONE RECEIVING THE STATION, not only the MP3 clients. One query for the
  // page; see nowPlaying.ts for why the MP3-only count could not keep the name.
  const counts = await listenerCountsMany(
    rows.map((r: any) => r.id),
    new Map(rows.map((r: any) => [r.id, states.get(r.id)?.listeners ?? null]))
  );
  const out = await Promise.all(rows.map(async (r) => {
    const rs = states.get(r.id)!;
    const icy = rs.running ? rs.icy : icyState(r.id);
    const health = await loadRadioHealth(r);
    const cfg = r.radio_config || {};
    return {
      ...r,
      pipeline: rs,
      listeners: counts.get(r.id) ?? { mp3: 0, players: 0, total: 0 },
      nowPlaying: icy?.title ?? null,
      nowPlayingClass: icy?.class ?? null,
      // The list shows the same resolved line as the detail page. It does not
      // consult the EPG: that is a query per row, and a station with a schedule
      // and no ICY title is the one case the list gets slightly thinner than
      // the detail, which is worth one query rather than N.
      carriesTitles: sourceCarriesTitles(cfg.protocol, cfg.url),
      nowPlayingView: resolveNowPlaying({
        live: !!rs.running,
        stationName: r.name,
        icyTitle: icy?.title ?? null,
        epgTitle: null,
        carriesTitles: sourceCarriesTitles(cfg.protocol, cfg.url),
      }),
      outputs: outputUrls(r.id, r.radio_config, await degradedOutputs(r.id)),
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
  const rs = await radioRunState(c.id);
  const openRec = await one<any>(
    `SELECT id, start_epoch_ms, status FROM recordings
      WHERE channel_id=$1 AND status='recording' ORDER BY start_epoch_ms DESC LIMIT 1`, [c.id]);
  const recent = await query<any>(
    `SELECT id, title, starts_at, ends_at, status, metadata
       FROM programmes WHERE channel_id=$1 AND metadata->>'source'='icy'
      ORDER BY starts_at DESC LIMIT 20`, [c.id]);
  const health = await loadRadioHealth(c);
  const qc = radioQc(c.id);
  const icyNow = rs.running ? rs.icy : icyState(c.id);
  const cfg = c.radio_config || {};
  // The detail page CAN afford the schedule lookup, so an HLS station with a
  // programme entered against it shows the programme rather than its own name.
  const carries = sourceCarriesTitles(cfg.protocol ?? sources[0]?.protocol, cfg.url ?? sources[0]?.ingest_url);
  const epgTitle = icyNow?.title ? null : await scheduledNowTitle(c.id);
  res.json({
    ...c,
    sources,
    pipeline: rs,
    listeners: await listenerCounts(c.id, rs.running ? rs.listeners : 0),
    // ONE ANSWER TO "CAN THIS SOURCE SEND A TITLE", sent to the console rather
    // than re-derived there. The console had its own copy as
    // `protocol === 'icecast'`, which is the weaker rule: it misses a station
    // whose protocol column was left at the default and whose URL is an .m3u8,
    // and that station is exactly the one the empty panels were confusing.
    carriesTitles: carries,
    nowPlayingView: resolveNowPlaying({
      live: !!rs.running, stationName: c.name,
      icyTitle: icyNow?.title ?? null, epgTitle, carriesTitles: carries,
    }),
    icy: icyNow,
    outputs: outputUrls(c.id, c.radio_config, await degradedOutputs(c.id)),
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
  if (c.status === 'live' && (await radioRunState(c.id)).running) {
    throw badRequest('Station is already running');
  }
  // status 'live' with no pipeline = orphan from a control-plane restart:
  // clean the stale instances/recording first, then start fresh.
  // Stopping in order to start again. Not a decision to be off.
  if (c.status === 'live') await orchestrator.stopStream('channel', c.id, 'reconcile-restart', 'internal');
  await orchestrator.startStream('channel', c.id);
  res.json({ id: c.id, status: 'live', pipeline: await radioRunState(c.id) });
}));

radioRouter.post('/:id/stop', asyncHandler(async (req, res) => {
  const c = await ownedStation(req);
  // Stopping the station also takes it off air: nothing public may outlive the run.
  if (c.on_air) {
    // The ledger and the column move together; the event stays because the
    // station page's own log reads it. See services/airSessions.ts.
    const { setOnAir } = await import('../services/airSessions');
    await setOnAir('radio', c.id, false, { actor: actor(req).label, reason: 'stream stopped' });
    await query(`INSERT INTO stream_events(channel_id, type, detail, ts)
                 VALUES ($1,'channel.off_air','{"reason":"station stopped"}'::jsonb, now())`, [c.id]);
  }
  await orchestrator.stopStream('channel', c.id, 'operator', 'operator');
  res.json({ id: c.id, status: 'ended', on_air: false });
}));

/**
 * DISMISS THE GIVE-UP NOTICE, without starting the station.
 *
 * The banner exists to say that nothing will bring this stream back on its own.
 * Until now the only way to clear it was to press Start, which is fine when the
 * source has been fixed and wrong when it has not: an operator who has read the
 * message, understood it and does not want the station running had no way to
 * put the notice down.
 *
 * IT ALSO STANDS THE STREAM DOWN, and that is the part that matters.
 * `resume_gave_up_at IS NULL` is one of the four conditions that make a stream
 * eligible for auto-connect; the others include `desired_state = 'running'`,
 * which a failed stream still carries because a fault deliberately does not
 * change intent. So clearing the give-up alone would re-arm the retry loop
 * against a source that is still broken, and hand back the exact crash loop the
 * cap exists to stop -- five more attempts, another give-up, another banner.
 *
 * Dismissing is therefore an ACKNOWLEDGEMENT, not a retry: it forgets the
 * give-up and records that the operator no longer wants this stream running.
 * Pressing Start afterwards sets the intent back and clears the state again on
 * its own, so nothing is lost.
 */
radioRouter.post('/:id/clear-recovery', asyncHandler(async (req, res) => {
  const c = await ownedStation(req);
  const { clearGiveUp } = await import('../services/orchestrator/resume');

  // Order matters: stand the intent down FIRST. If the process died between the
  // two writes, a stream with its give-up cleared and its intent still running
  // is the crash loop; a stream still flagged as given up is merely unchanged.
  await query(
    `UPDATE channels SET desired_state = 'stopped', updated_at = now() WHERE id = $1`, [c.id]);
  await clearGiveUp('channel', c.id);

  // The banner goes; the FACT that it was there does not. An operator looking
  // later at a station that quietly stopped retrying deserves to find out why
  // from the log rather than from nowhere.
  const who = actor(req);
  await query(
    `INSERT INTO stream_events(channel_id, type, detail, ts) VALUES ($1,'recovery.cleared',$2::jsonb, now())`,
    [c.id, JSON.stringify({
      message: 'auto reconnect notice dismissed; the station was stood down',
      actor: who.label,
      gave_up_at: c.resume_gave_up_at ?? null,
      last_error: c.resume_last_error ?? null,
    })]);
  await writeAudit(null, {
    accountId: accountId(req), userId: who.userId, label: who.label,
    action: 'update', entityType: 'radio_station', entityId: c.id,
    changes: {
      resume_gave_up_at: { from: c.resume_gave_up_at ?? null, to: null },
      desired_state: { from: c.desired_state ?? null, to: 'stopped' },
    },
  });

  const { resumeStatus } = await import('../services/orchestrator/resume');
  res.json({ id: c.id, recovery: await resumeStatus('channel', c.id) });
}));

/**
 * CLEAR THIS STATION'S EVENT LOG.
 *
 * Scoped to one station, never the fleet: a route that could empty
 * `stream_events` wholesale is one mistyped id away from destroying every other
 * stream's history, and no screen in the product asks for that.
 *
 * A CLEARED LOG IS NOT AN EMPTY LOG. The delete is immediately followed by one
 * `log.cleared` entry naming who did it and how many rows went, so the log can
 * never be silently blank: "nothing has ever happened here" and "somebody
 * cleared this at 07:15" look identical otherwise, and only one of them is a
 * reason to go looking elsewhere. The audit trail gets its own row too, because
 * the event log is the thing being deleted and cannot be its own witness.
 */
radioRouter.delete('/:id/events', asyncHandler(async (req, res) => {
  const c = await ownedStation(req);
  const who = actor(req);
  const gone = await query<any>(
    `DELETE FROM stream_events WHERE channel_id = $1 RETURNING 1`, [c.id]);
  const removed = gone.length;
  await query(
    `INSERT INTO stream_events(channel_id, type, detail, ts) VALUES ($1,'log.cleared',$2::jsonb, now())`,
    [c.id, JSON.stringify({ message: `event log cleared, ${removed} entr${removed === 1 ? 'y' : 'ies'} removed`, actor: who.label, removed })]);
  await writeAudit(null, {
    accountId: accountId(req), userId: who.userId, label: who.label,
    action: 'delete', entityType: 'stream_events', entityId: c.id,
    snapshot: { removed },
  });
  res.json({ id: c.id, removed, log: await radioEventLog(c.id) });
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
  const { setOnAir } = await import('../services/airSessions');
  await setOnAir('radio', c.id, on, {
    actor: actor(req).label,
    reason: on ? undefined : 'operator',
  });
  const row = await one<any>(
    `SELECT id, name, on_air, status FROM channels WHERE id=$1`, [c.id]);
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

/** AUTO CONNECT, BY HAND. See channels.ts: off halts retries and leaves the
 *  evidence alone; on makes the station eligible again once it is seen healthy. */
radioRouter.post('/:id/auto-connect', asyncHandler(async (req, res) => {
  const c = await ownedStation(req);
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body ?? {});
  const { setAutoConnect } = await import('../services/orchestrator/resume');
  const who = actor(req);
  await setAutoConnect('channel', c.id, enabled, who.label);
  await writeAudit(null, {
    accountId: accountId(req), userId: who.userId, label: who.label,
    action: 'update', entityType: 'radio_station', entityId: c.id,
    changes: { auto_connect: { from: c.auto_connect, to: enabled } },
  }).catch(() => {});
  const row = await one('SELECT * FROM channels WHERE id = $1', [c.id]);
  res.json(row);
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
    running: (await radioRunState(c.id)).running,
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
  const rs = await radioRunState(c.id);
  const icy = rs.running ? rs.icy : icyState(c.id);
  const open = await one<any>(
    `SELECT id, title, starts_at, metadata FROM programmes
      WHERE channel_id=$1 AND metadata->>'source'='icy' AND status='live'
      ORDER BY starts_at DESC LIMIT 1`, [c.id]);
  const cfg = c.radio_config || {};
  const epgTitle = icy?.title ? null : await scheduledNowTitle(c.id);
  const counts = await listenerCounts(c.id, rs.running ? rs.listeners : 0);
  res.json({
    running: rs.running,
    // `listeners` IS THE TOTAL NOW. The breakdown stays available for the
    // tooltip and for anyone who needs the delivery split, but the bare word
    // never again means "MP3 only".
    listeners: counts.total,
    listenerCounts: counts,
    nowPlayingView: resolveNowPlaying({
      live: !!rs.running, stationName: c.name,
      icyTitle: icy?.title ?? null, epgTitle,
      carriesTitles: sourceCarriesTitles(cfg.protocol, cfg.url),
    }),
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
