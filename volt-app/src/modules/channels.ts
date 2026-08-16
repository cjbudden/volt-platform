import { Router } from 'express';
import { z } from 'zod';
import { query, one, tx } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, conflict } from '../util/http';
import { orchestrator } from '../services/orchestrator';
import { validateEntityMetadata } from './metadataSchemas';
import { actor, patchEntity, writeAudit, entityHistory, VersionConflict } from '../services/audit';
import { buildChannelDetail, loadChannelHealthLite, DVR_MAX_SEC } from '../services/channelDetail';
import { startTestStream, stopTestStream, testStreamStatus, isTestStreamAvailable } from '../services/testStream';
import { outputHasValidContent } from './publicLive';

export const channelsRouter = Router();
channelsRouter.use(requireAuth);

const CHANNEL_EDITABLE = [
  'name', 'enabled', 'recording_retention_days', 'recording_retention_sec', 'schema_id', 'metadata',
  'dvr_window_sec', 'dvr_mode', 'geo_mode', 'geo_countries', 'epg_enabled',
  'output_ladder', 'input_failover_enabled', 'auto_failback', 'input_loss_behavior',
  'filler_slate_ref', 'filler_asset_id', 'fallback_transcode',
  'watermark_enabled', 'watermark_ref', 'watermark_position',
  'watermark_offset_x', 'watermark_offset_y', 'watermark_opacity', 'watermark_scale',
  'brand_ref', 'brand_colour', 'description', 'audio_only', 'audio_ladder',
];

// Watermark / channel brand overlay. `ref` is a library image URL (like filler_slate_ref);
// position is a corner/edge anchor; offsets + scale + opacity are how it sits.
const WATERMARK = z.object({
  enabled: z.boolean().optional(),
  ref: z.string().nullable().optional(),
  position: z.enum(['tl', 'tr', 'bl', 'br', 'tc', 'bc']).optional(),
  offsetX: z.number().int().min(0).max(4000).optional(),
  offsetY: z.number().int().min(0).max(4000).optional(),
  opacity: z.number().int().min(0).max(100).optional(),
  scale: z.number().int().min(1).max(100).optional(),  // % of the video height
}).optional();

/** List channels for the tenant (scoped via group -> account). */
channelsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await query<any>(
      `SELECT c.*, g.name AS group_name
         FROM channels c JOIN groups g ON g.id = c.group_id
        WHERE g.account_id = $1
        ORDER BY c.created_at DESC`,
      [accountId(req)]
    );
    // ONE consistent status: the LIST uses the SAME five-gate health as the detail page
    // (via the ground-truth manifest + events), rolled up to `overall`, so a channel is
    // never "Starting" in the list while it's actually READY on the detail.
    const now = Date.now();
    const ids = rows.map((r) => r.id);
    const sinceMap = new Map<string, number>();
    if (ids.length) {
      const insts = await query<any>(
        `SELECT channel_id, min(launched_at) AS since FROM instances
          WHERE channel_id = ANY($1) AND terminated_at IS NULL GROUP BY channel_id`, [ids]);
      for (const i of insts) if (i.since) sinceMap.set(i.channel_id, new Date(i.since).getTime());
    }
    const enriched = await Promise.all(rows.map(async (c) => {
      const live = c.status === 'live';
      const billable = live;
      const serverSince = live ? (sinceMap.get(c.id) ?? null) : null;
      const health = await loadChannelHealthLite(c, now);
      return { ...c, pipelineState: health.overall, onAir: c.on_air === true, billable, serverSince };
    }));
    res.json(enriched);
  })
);

channelsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await one(
      `SELECT c.* FROM channels c JOIN groups g ON g.id = c.group_id
        WHERE c.id = $1 AND g.account_id = $2`,
      [req.params.id, accountId(req)]
    );
    if (!row) throw notFound('Channel not found');
    const instances = await query('SELECT * FROM instances WHERE channel_id = $1 AND terminated_at IS NULL', [req.params.id]);
    const detail = await buildChannelDetail(row, Date.now());
    const testStream = { available: isTestStreamAvailable(), ...testStreamStatus(req.params.id) };
    res.json({ ...row, instances, ...detail, testStream });
  })
);

// ingest protocols must match the DB `ingest_protocol` enum exactly.
const PROTOCOL = z.enum(['srt', 'rtmp', 'rtmps', 'hls', 'dash', 'ndi', 'st2110']);
const RUNG = z.object({ height: z.number().int().positive(), bitrateKbps: z.number().int().positive() });
const SOURCE = z.object({
  role: z.enum(['primary', 'backup']).default('primary'),
  protocol: PROTOCOL,
  ingestUrl: z.string().optional(),
  streamKey: z.string().optional(),
  renditionLabel: z.string().optional(),        // package_only: which rung this input carries
  renditionBitrateKbps: z.number().int().optional(),
});
// filler-on-total-loss + input-failover (backup source) config shared by create/edit.
const FILLER = {
  inputFailoverEnabled: z.boolean().optional(),
  autoFailback: z.boolean().optional(),
  inputLossBehavior: z.enum(['none', 'slate', 'vod_loop', 'last_frame', 'black']).optional(),
  fillerSlateRef: z.string().nullable().optional(),   // image URL/ref for a slate
  fillerAssetId: z.string().uuid().nullable().optional(), // loop asset -> filler_assets
  fallbackTranscode: z.boolean().optional(),          // package_only: transcode fallback to all rungs
};

/** Audio rendition for a radio channel: an AAC bitrate, optionally named. */
const AUDIO_RUNG = z.object({
  label: z.string().optional(),
  bitrateKbps: z.number().int().min(24).max(512),
});

// Channel identity shared by create + edit. `brandRef` is a library image URL (like
// filler_slate_ref / watermark ref); it is the logo shown in the console and the guide,
// and the station art for audio-only channels. It is NEVER burned into the video.
const BRAND = {
  brandRef: z.string().nullable().optional(),
  brandColour: z.string().max(32).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
};

const createSchema = z.object({
  groupId: z.string().uuid(),
  name: z.string().min(1),
  purchasingMode: z.enum(['on_demand', 'reserved', 'spot_fallback']).default('reserved'),
  resilienceTier: z.enum(['standard', 'resilient_input', 'full_redundancy']).default('standard'),
  recordingRetentionDays: z.number().int().positive().nullable().optional(), // legacy days rule
  recordingRetentionSec: z.number().int().positive().nullable().optional(),  // retention (any unit -> seconds)
  dvrWindowSec: z.number().int().min(30).max(DVR_MAX_SEC).nullable().optional().default(3600), // DVR on, default 1h for 24x7 (≤4h)
  dvrMode: z.enum(['sliding', 'event_start']).default('sliding'),
  // NEW — source + ladder + fallback captured at setup
  outputLadder: z.array(RUNG).optional(),  // transcode: rungs to encode; package: mirror of inputs
  sources: z.array(SOURCE).optional(),     // primary (+ optional backup / per-rendition rows)
  ...FILLER,
  ...BRAND,
  watermark: WATERMARK,
  // audio-only (radio): no video ladder, an audio rendition list instead
  audioOnly: z.boolean().optional(),
  audioLadder: z.array(AUDIO_RUNG).optional(),
});

/** Create a channel — enforces the group's max_channels entitlement. */
channelsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    const group = await one<any>('SELECT id, max_channels FROM groups WHERE id = $1 AND account_id = $2', [
      body.groupId,
      accountId(req),
    ]);
    if (!group) throw notFound('Group not found');
    const count = await one<any>('SELECT count(*)::int AS n FROM channels WHERE group_id = $1', [body.groupId]);
    if (count.n >= group.max_channels) throw conflict(`Channel limit reached (${group.max_channels})`);

    const who = actor(req);
    const ladder = body.outputLadder?.length
      ? JSON.stringify(body.outputLadder.map((r) => ({ height: r.height, bitrate_kbps: r.bitrateKbps })))
      : null;

    // retention: seconds is the source of truth; derive the coarse day field in sync
    const retSec = body.recordingRetentionSec ?? (body.recordingRetentionDays != null ? body.recordingRetentionDays * 86400 : null);
    const retDays = retSec != null ? Math.max(1, Math.ceil(retSec / 86400)) : null;
    const row = await tx(async (c) => {
      const ch = (await c.query(
        `INSERT INTO channels(group_id, name, purchasing_mode, resilience_tier, recording_retention_days, recording_retention_sec,
           dvr_window_sec, dvr_mode, output_ladder,
           input_failover_enabled, auto_failback, input_loss_behavior, filler_slate_ref, filler_asset_id, fallback_transcode,
           created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$16) RETURNING *`,
        [body.groupId, body.name, body.purchasingMode, body.resilienceTier, retDays, retSec,
         body.dvrWindowSec ?? null, body.dvrMode, ladder,
         body.inputFailoverEnabled ?? false, body.autoFailback ?? true, body.inputLossBehavior ?? 'none',
         body.fillerSlateRef ?? null, body.fillerAssetId ?? null, body.fallbackTranscode ?? false,
         who.userId]
      )).rows[0];
      for (const s of body.sources ?? []) {
        await c.query(
          `INSERT INTO stream_inputs(channel_id, role, protocol, ingest_url, stream_key, rendition_label, rendition_bitrate_kbps)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [ch.id, s.role ?? 'primary', s.protocol, s.ingestUrl ?? null, s.streamKey ?? null,
           s.renditionLabel ?? null, s.renditionBitrateKbps ?? null]
        );
      }
      return ch;
    });

    // watermark / brand / audio-only (kept out of the positional insert): set them in
    // one follow-up update so create and edit persist the exact same columns.
    if (body.watermark) {
      const w = body.watermark;
      await query(
        `UPDATE channels SET watermark_enabled=$2, watermark_ref=$3, watermark_position=$4,
           watermark_offset_x=$5, watermark_offset_y=$6, watermark_opacity=$7, watermark_scale=$8 WHERE id=$1`,
        [row.id, w.enabled ?? false, w.ref ?? null, w.position ?? 'br',
         w.offsetX ?? 24, w.offsetY ?? 24, w.opacity ?? 100, w.scale ?? 12]
      );
    }
    if (body.brandRef !== undefined || body.brandColour !== undefined || body.description !== undefined) {
      await query(
        `UPDATE channels SET brand_ref=COALESCE($2, brand_ref), brand_colour=COALESCE($3, brand_colour),
           description=COALESCE($4, description) WHERE id=$1`,
        [row.id, body.brandRef ?? null, body.brandColour ?? null, body.description ?? null]
      );
    }
    if (body.audioOnly) {
      const audio = (body.audioLadder?.length ? body.audioLadder : [{ label: 'High', bitrateKbps: 128 }, { label: 'Low', bitrateKbps: 64 }])
        .map((a) => ({ label: a.label ?? `${a.bitrateKbps}k`, bitrate_kbps: a.bitrateKbps }));
      await query(`UPDATE channels SET audio_only=true, audio_ladder=$2::jsonb, output_ladder=NULL WHERE id=$1`,
        [row.id, JSON.stringify(audio)]);
    }
    // return the row as it now stands, not the pre-update snapshot
    const created = await one<any>(`SELECT * FROM channels WHERE id=$1`, [row.id]);

    await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
      action: 'create', entityType: 'channel', entityId: row.id,
      snapshot: { name: row.name, group_id: row.group_id, sources: (body.sources ?? []).length, ladder: body.outputLadder?.length ?? 0,
                  audio_only: !!body.audioOnly } });
    res.status(201).json(created ?? row);
  })
);

/**
 * Edit a channel. PATCH = partial (send only changed fields; null clears); PUT is
 * accepted as an alias. Optimistic concurrency: send the version you loaded via the
 * `If-Match` header (or a `version` field) and the write is rejected 409 if the row
 * changed underneath you. Every change is versioned + written to the audit log.
 */
const editSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  recordingRetentionDays: z.number().int().positive().nullable().optional(),
  schemaId: z.string().uuid().nullable().optional(),
  metadata: z.record(z.any()).optional(),
  // DVR: per-channel catch-up window. 24x7 sliding window is capped at 4h; events
  // scrub back to the event start (dvr_mode = 'event_start', no fixed cap needed).
  dvrWindowSec: z.number().int().min(30).max(DVR_MAX_SEC).nullable().optional(),
  dvrMode: z.enum(['sliding', 'event_start']).optional(),
  // source geo rules (edge-evaluated)
  geoMode: z.enum(['worldwide', 'allow', 'block']).optional(),
  geoCountries: z.array(z.string().length(2)).optional(),
  // show/hide the programme guide (EPG) panel for this channel
  epgEnabled: z.boolean().optional(),
  // output retention as seconds (UI picks a number + unit minutes..months). null = keep forever.
  recordingRetentionSec: z.number().int().positive().nullable().optional(),
  // sources (primary/backup ingest, per-rendition for package) — replaces inputs when provided
  sources: z.array(SOURCE).optional(),
  // output ladder (transcode rungs; package mirror)
  outputLadder: z.array(RUNG).nullable().optional(),
  // filler-on-loss + input failover
  ...FILLER,
  // watermark / channel brand overlay (burned into the video)
  watermark: WATERMARK,
  // channel identity (not burned in): logo, accent colour, description
  ...BRAND,
  audioOnly: z.boolean().optional(),
  audioLadder: z.array(AUDIO_RUNG).optional(),
  // subtitles / live captions (persisted to the group's shared output profile)
  captions: z.object({
    enabled: z.boolean().optional(),
    sourceLang: z.string().optional(),
    targets: z.array(z.string()).optional(),
  }).optional(),
  version: z.number().int().optional(),
});
const editChannel = asyncHandler(async (req, res) => {
  const body = editSchema.parse(req.body);
  const raw = (req.body ?? {}) as Record<string, unknown>;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k);

  const current = await one<any>(
    `SELECT c.* FROM channels c JOIN groups g ON g.id = c.group_id
      WHERE c.id = $1 AND g.account_id = $2`,
    [req.params.id, accountId(req)]
  );
  if (!current) throw notFound('Channel not found');

  const patch: Record<string, any> = {};
  if (has('name')) patch.name = body.name;
  if (has('enabled')) patch.enabled = body.enabled;
  if (has('recordingRetentionDays')) patch.recording_retention_days = body.recordingRetentionDays ?? null;
  if (has('recordingRetentionSec')) {
    let sec = body.recordingRetentionSec ?? null;
    // DVR floor: retention can never be shorter than the DVR window when DVR is on.
    const dvrOn = (has('dvrMode') ? body.dvrMode : current.dvr_mode) !== 'event_start' ? true : true; // DVR always has a window
    const dvrWin = (has('dvrWindowSec') ? body.dvrWindowSec : current.dvr_window_sec) ?? null;
    if (sec != null && dvrOn && dvrWin && sec < dvrWin) sec = dvrWin;
    patch.recording_retention_sec = sec;
    // keep the coarse day-based sweep field in sync (>=1 day) so recordings still expire
    patch.recording_retention_days = sec == null ? null : Math.max(1, Math.ceil(sec / 86400));
  }
  if (has('dvrWindowSec')) patch.dvr_window_sec = body.dvrWindowSec ?? null;
  if (has('dvrMode')) patch.dvr_mode = body.dvrMode;
  if (has('geoMode')) patch.geo_mode = body.geoMode;
  if (has('geoCountries')) patch.geo_countries = body.geoCountries ?? [];
  if (has('epgEnabled')) patch.epg_enabled = body.epgEnabled;
  if (has('outputLadder')) patch.output_ladder = body.outputLadder
    ? body.outputLadder.map((r) => ({ height: r.height, bitrate_kbps: r.bitrateKbps })) : null;
  if (has('inputFailoverEnabled')) patch.input_failover_enabled = body.inputFailoverEnabled;
  if (has('autoFailback')) patch.auto_failback = body.autoFailback;
  if (has('inputLossBehavior')) patch.input_loss_behavior = body.inputLossBehavior;
  if (has('fillerSlateRef')) patch.filler_slate_ref = body.fillerSlateRef ?? null;
  if (has('fillerAssetId')) patch.filler_asset_id = body.fillerAssetId ?? null;
  if (has('fallbackTranscode')) patch.fallback_transcode = body.fallbackTranscode;
  if (has('brandRef')) patch.brand_ref = body.brandRef ?? null;
  if (has('brandColour')) patch.brand_colour = body.brandColour ?? null;
  if (has('description')) patch.description = body.description ?? null;
  if (has('audioOnly')) patch.audio_only = body.audioOnly;
  if (has('audioLadder') && body.audioLadder) {
    patch.audio_ladder = JSON.stringify(body.audioLadder.map((a) => ({ label: a.label ?? `${a.bitrateKbps}k`, bitrate_kbps: a.bitrateKbps })));
  }
  if (has('watermark') && body.watermark) {
    const w = body.watermark;
    if (w.enabled !== undefined) patch.watermark_enabled = w.enabled;
    if (w.ref !== undefined) patch.watermark_ref = w.ref ?? null;
    if (w.position !== undefined) patch.watermark_position = w.position;
    if (w.offsetX !== undefined) patch.watermark_offset_x = w.offsetX;
    if (w.offsetY !== undefined) patch.watermark_offset_y = w.offsetY;
    if (w.opacity !== undefined) patch.watermark_opacity = w.opacity;
    if (w.scale !== undefined) patch.watermark_scale = w.scale;
  }
  const touchMeta = has('schemaId') || has('metadata');
  if (touchMeta) {
    const md = await validateEntityMetadata(accountId(req), body.schemaId ?? null,
      has('metadata') ? body.metadata : current.metadata, ['channel']);
    patch.schema_id = md.schemaId;
    patch.metadata = md.metadata;
  }

  const im = req.get('If-Match');
  const expectedVersion = im ? parseInt(im.replace(/"/g, ''), 10) : (has('version') ? Number(body.version) : null);
  const who = actor(req);
  try {
    const { row, changed } = await patchEntity({
      table: 'channels', id: req.params.id, accountId: accountId(req),
      current, patch, allowed: CHANNEL_EDITABLE, entityType: 'channel',
      userId: who.userId, label: who.label, expectedVersion,
      arrayColumns: ['geo_countries'],
    });

    // --- cross-entity side effects (audited separately) ---------------------
    // Sources: replace this channel's ingest inputs.
    if (has('sources') && body.sources) {
      await tx(async (c) => {
        await c.query('DELETE FROM stream_inputs WHERE channel_id = $1', [req.params.id]);
        for (const s of body.sources!) {
          await c.query(
            `INSERT INTO stream_inputs(channel_id, role, protocol, ingest_url, stream_key, rendition_label, rendition_bitrate_kbps)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [req.params.id, s.role ?? 'primary', s.protocol, s.ingestUrl ?? null, s.streamKey ?? null,
             s.renditionLabel ?? null, s.renditionBitrateKbps ?? null]
          );
        }
      });
      await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
        action: 'update', entityType: 'channel', entityId: req.params.id,
        snapshot: { sources: body.sources.map((s) => `${s.role}:${s.protocol}`) } });
    }

    // Subtitles/captions live on the group's shared output profile.
    if (has('captions') && body.captions) {
      const grp = await one<any>(
        `SELECT g.output_profile_id FROM channels ch JOIN groups g ON g.id = ch.group_id WHERE ch.id = $1`,
        [req.params.id]
      );
      if (grp?.output_profile_id) {
        const cap = body.captions;
        const sets: string[] = []; const vals: any[] = [];
        if (cap.enabled !== undefined) { sets.push(`captions_enabled = $${sets.length + 1}`); vals.push(cap.enabled); }
        if (cap.sourceLang !== undefined) { sets.push(`caption_source_lang = $${sets.length + 1}`); vals.push(cap.sourceLang); }
        if (cap.targets !== undefined) { sets.push(`caption_targets = $${sets.length + 1}::jsonb`); vals.push(JSON.stringify(cap.targets)); }
        if (sets.length) {
          vals.push(grp.output_profile_id);
          await query(`UPDATE output_profiles SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}`, vals);
          await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
            action: 'update', entityType: 'output_profile', entityId: grp.output_profile_id,
            snapshot: { captions: cap } });
        }
      }
    }

    res.set('ETag', String(row.version));
    res.json({ ...row, _changed: changed });
  } catch (e) {
    if (e instanceof VersionConflict) return res.status(409).json({ error: e.message, currentVersion: e.currentVersion });
    throw e;
  }
});
channelsRouter.patch('/:id', editChannel);
channelsRouter.put('/:id', editChannel);

/** Change history for one channel (who created / changed what, newest first). */
channelsRouter.get(
  '/:id/history',
  asyncHandler(async (req, res) => {
    const owned = await one(
      `SELECT c.id FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id=$1 AND g.account_id=$2`,
      [req.params.id, accountId(req)]
    );
    if (!owned) throw notFound('Channel not found');
    res.json(await entityHistory(accountId(req), 'channel', req.params.id));
  })
);

channelsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    // In production: terminate any running encoder first, then delete.
    const row = await one<any>(
      `DELETE FROM channels c USING groups g
        WHERE c.group_id = g.id AND c.id = $1 AND g.account_id = $2 RETURNING c.id, c.name`,
      [req.params.id, accountId(req)]
    );
    if (!row) throw notFound('Channel not found');
    const who = actor(req);
    await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
      action: 'delete', entityType: 'channel', entityId: row.id, snapshot: { name: row.name } });
    res.status(204).end();
  })
);

/**
 * TEST BUILD — spin up a real local test stream (FFmpeg test card + live WebVTT)
 * for this channel and play it back in the app. GET returns playback URLs + state.
 */
channelsRouter.get(
  '/:id/test-stream',
  asyncHandler(async (req, res) => {
    const owned = await one<any>(
      `SELECT c.id FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id=$1 AND g.account_id=$2`,
      [req.params.id, accountId(req)]
    );
    if (!owned) throw notFound('Channel not found');
    res.json({ available: isTestStreamAvailable(), ...testStreamStatus(req.params.id) });
  })
);

const testStreamSchema = z.object({
  action: z.enum(['start', 'stop']),
  langs: z.array(z.string()).optional(),
  dvrSec: z.number().int().min(0).max(DVR_MAX_SEC).optional(),
  dash: z.boolean().optional(),
  inputUrl: z.string().url().nullable().optional(), // ingest external HLS instead of test card
});
channelsRouter.post(
  '/:id/test-stream',
  asyncHandler(async (req, res) => {
    const chan = await one<any>(
      `SELECT c.* FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id=$1 AND g.account_id=$2`,
      [req.params.id, accountId(req)]
    );
    if (!chan) throw notFound('Channel not found');
    const body = testStreamSchema.parse(req.body);
    if (body.action === 'stop') { res.json(await stopTestStream(req.params.id)); return; }
    if (!isTestStreamAvailable()) throw conflict('Test stream generator not available (ffmpeg/encoder scripts missing on the API host)');
    const dvrSec = body.dvrSec ?? (chan.dvr_mode === 'event_start' ? 0 : (chan.dvr_window_sec ?? 60));
    const status = await startTestStream(req.params.id, chan.name, {
      langs: body.langs ?? ['en', 'ms', 'zh', 'ta'], dvrSec, dash: body.dash ?? false,
      inputUrl: body.inputUrl ?? null,
    });
    res.json(status);
  })
);

/** Go on air / take off air — the PUBLIC publish toggle, decoupled from the encoder.
 *  Going on air is only allowed once the output has valid content, so the public URL
 *  never points at a dead stream. Taking off air keeps the encoder up (private preview
 *  still plays); it just closes the public URL. */
const airSchema = z.object({ on: z.boolean() });
channelsRouter.post(
  '/:id/air',
  asyncHandler(async (req, res) => {
    const chan = await one<any>(
      `SELECT c.* FROM channels c JOIN groups g ON g.id = c.group_id
        WHERE c.id = $1 AND g.account_id = $2`,
      [req.params.id, accountId(req)]
    );
    if (!chan) throw notFound('Channel not found');
    const { on } = airSchema.parse(req.body);
    if (on && (chan.status !== 'live' || !outputHasValidContent(chan.id))) {
      throw conflict('Output is not ready: cannot go on air until the packaged output is producing valid content.');
    }
    await query('UPDATE channels SET on_air = $1 WHERE id = $2', [on, chan.id]);
    const row = await one('SELECT * FROM channels WHERE id = $1', [chan.id]);
    res.json(row);
  })
);

/** Start / stop — the orchestrator provisions/terminates the encoder task. */
channelsRouter.post(
  '/:id/:action(start|stop)',
  asyncHandler(async (req, res) => {
    // enforce tenant ownership before the orchestrator (which loads by id)
    const owned = await one<any>(
      `SELECT c.id FROM channels c JOIN groups g ON g.id = c.group_id
        WHERE c.id = $1 AND g.account_id = $2`,
      [req.params.id, accountId(req)]
    );
    if (!owned) throw notFound('Channel not found');
    if (req.params.action === 'start') await orchestrator.startStream('channel', req.params.id);
    else {
      await orchestrator.stopStream('channel', req.params.id, `api:operator (user ${accountId(req)})`);
      // stopping the encoder also takes the channel off air (the public URL closes)
      await query('UPDATE channels SET on_air = false WHERE id = $1', [req.params.id]);
    }
    const row = await one('SELECT * FROM channels WHERE id = $1', [req.params.id]);
    res.json(row);
  })
);
