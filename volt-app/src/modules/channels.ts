import { encoderRunning, lockedChanges } from '../services/settingsLock';
import { Router } from 'express';
import { z } from 'zod';
import { query, one, tx } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, conflict, badRequest, ApiError } from '../util/http';
import { defineList, parseList, whereSql, pageSql, finishPage } from '../util/listQuery';
import { validateSource, cleanParams } from '../services/ingestProtocols';
import { requireMinRole } from '../auth/roles';
import { assertPlanRoom } from '../services/plan';
import { orchestrator } from '../services/orchestrator';
import { validateEntityMetadata } from './metadataSchemas';
import { defaultTypeId } from '../services/contentTypes';
import { actor, patchEntity, writeAudit, entityHistory, VersionConflict } from '../services/audit';
import { mintPreviewToken } from './sourcePreview';
import { buildChannelDetail, loadChannelHealthLite, DVR_MAX_SEC } from '../services/channelDetail';
import { startTestStream, stopTestStream, testStreamStatus, isTestStreamAvailable } from '../services/testStream';
import { outputHasValidContent } from './publicLive';
import { config } from '../config';
import { FAILOVER_MODES, setFailoverControl, currentFailoverControl } from '../services/failoverControl';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scheduleFillerPrep, FILLER_FIELDS, runFillerPrep, fillerStatus } from '../services/fillerPrep';
import { assertFillerAsset } from './fillerAssets';

export const channelsRouter = Router();
channelsRouter.use(requireAuth);

const CHANNEL_EDITABLE = [
  'name', 'enabled', 'recording_enabled', 'recording_retention_days', 'recording_retention_sec', 'schema_id', 'metadata',
  'dvr_window_sec', 'dvr_mode', 'geo_mode', 'geo_countries', 'epg_enabled',
  'output_ladder', 'input_failover_enabled', 'auto_failback', 'input_loss_behavior',
  'filler_slate_ref', 'filler_asset_id', 'fallback_transcode',
  'watermark_enabled', 'watermark_ref', 'watermark_position',
  'watermark_offset_x', 'watermark_offset_y', 'watermark_opacity', 'watermark_scale',
  'brand_ref', 'guide_icon_ref', 'radio_config',
  // AUTO CONNECT. Whether a reboot puts this channel back on air if it was
  // running and nobody recorded a stop. Default true; see migration 0017.
  'auto_connect',
  // In-stream graphics settings (migration 0060).
  'graphics',
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
// The list standard (util/listQuery.ts): search, filter, sort and page. kind
// keeps its old meaning (tv = no kind or tv). Everything used to come back in
// one go; without a limit it still returns up to 1000, so the console's lists
// are unchanged until they page on the server.
const channelList = defineList({
  path: '/api/channels',
  fields: {
    id: { sql: 'c.id', type: 'uuid' },
    name: { sql: 'c.name', type: 'string' },
    kind: { sql: "COALESCE(c.kind,'tv')", type: 'enum', values: ['tv', 'radio'], doc: 'tv or radio' },
    // live = fed by a source through an encoder; playlist = a FAST channel built
    // from the library (managed under /api/fast). The Channels page asks for live.
    origin: { sql: "COALESCE(c.origin,'live')", type: 'enum', values: ['live', 'playlist'], doc: 'live (source + encoder) or playlist (FAST)' },
    status: { sql: 'c.status', type: 'enum', values: ['scheduled', 'provisioning', 'testing', 'live', 'stopping', 'ended', 'error'] },
    group_id: { sql: 'c.group_id', type: 'uuid' },
    group_name: { sql: 'g.name', type: 'string' },
    enabled: { sql: 'c.enabled', type: 'boolean' },
    on_air: { sql: 'c.on_air', type: 'boolean' },
    recording_enabled: { sql: 'c.recording_enabled', type: 'boolean' },
    auto_connect: { sql: 'c.auto_connect', type: 'boolean' },
    resilience_tier: { sql: 'c.resilience_tier', type: 'enum', values: ['standard', 'resilient_input', 'full_redundancy'] },
    desired_state: { sql: 'c.desired_state', type: 'string' },
    xmltv_id: { sql: 'c.xmltv_id', type: 'string' },
    tz: { sql: 'c.tz', type: 'string' },
    created_at: { sql: 'c.created_at', type: 'timestamp', notNull: true },
    updated_at: { sql: 'c.updated_at', type: 'timestamp' },
  },
  search: ['name', 'group_name', 'xmltv_id'],
  defaultSort: '-created_at',
  unpagedLimit: 1000,
  aliases: { groupId: 'group_id', createdAt: 'created_at', updatedAt: 'updated_at', onAir: 'on_air' },
});

channelsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    // ?kind=tv|radio scopes the list (Channels page = tv, Radio page = radio);
    // no param returns everything (back-compat for scripts and search).
    const base: unknown[] = [accountId(req)];
    const params = [...base];
    const pl = parseList(channelList, req.query, params);
    const fetched = await query<any>(
      `SELECT c.*, g.name AS group_name
         FROM channels c JOIN groups g ON g.id = c.group_id
        WHERE g.account_id = $1${whereSql(pl)}
        ${pageSql(pl)}`,
      params
    );
    const cParams = [...base];
    const cWhere = pl.count ? whereSql(parseList(channelList, { ...req.query, cursor: undefined, offset: undefined }, cParams)) : '';
    const total = pl.count ? (await one<any>(`SELECT count(*)::int AS n FROM channels c JOIN groups g ON g.id = c.group_id WHERE g.account_id = $1${cWhere}`, cParams))?.n : undefined;
    // Health is per row, so it runs for this page only.
    const rows = finishPage(req, res, pl, fetched, total);
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

/**
 * CLEAR QC: reset a channel's health to a clean slate.
 *
 * A crash or a source fault from an earlier run keeps the channel red ("SERVER
 * ERROR") until it runs cleanly again, which is right while nobody has looked
 * and wrong once somebody has. This records a `qc.reset` event, the boundary
 * the health model judges from (pipelineHealth.ts), and clears the auto
 * connect give-up. Nothing is deleted: the faults stay in the event log, with
 * this entry after them saying who cleared them. A fault that is still real
 * comes straight back from its next event or the output ground truth.
 * A stopped channel is also stood down (desired stopped), so clearing a
 * give-up never starts a retry loop by itself.
 */
channelsRouter.post('/:id/reset-health', asyncHandler(async (req, res) => {
  const c = await one<any>(
    `SELECT c.* FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id = $1 AND g.account_id = $2`,
    [req.params.id, accountId(req)]);
  if (!c) throw notFound('Channel not found');
  res.json(await clearQc(req, 'channel', c));
}));

/**
 * The body of Clear QC, shared by channels and events (events.ts) so the two
 * cannot drift: the same qc.reset event, the same give-up clear, the same
 * stand-down of a stopped stream and the same answer. Only the table, the
 * stream_events column and the detail builder differ by kind.
 */
export async function clearQc(req: any, kind: 'channel' | 'event', c: any) {
  const { buildStreamDetail } = await import('../services/channelDetail');
  const detailOf = (row: any) => kind === 'event' ? buildStreamDetail(row, Date.now(), 'event') : buildChannelDetail(row, Date.now());
  const table = kind === 'event' ? 'events' : 'channels';
  const before = await detailOf(c);
  const who = actor(req);
  const name = who.userId ? (await one<{ email: string }>('SELECT email FROM users WHERE id = $1', [who.userId]))?.email ?? who.label : who.label;
  const { clearGiveUp } = await import('../services/orchestrator/resume');
  if (c.status !== 'live') await query(`UPDATE ${table} SET desired_state = 'stopped', updated_at = now() WHERE id = $1`, [c.id]);
  await clearGiveUp(kind, c.id);
  await query(
    `INSERT INTO stream_events(${kind === 'event' ? 'event_id' : 'channel_id'}, type, detail, ts) VALUES ($1,'qc.reset',$2::jsonb, now())`,
    [c.id, JSON.stringify({
      message: before.health?.primaryError ? `QC cleared by ${name}: was ${before.health.primaryError.label} error (${before.health.primaryError.message})` : `QC cleared by ${name}`,
      actor: name, was: before.health?.overall ?? null, error: before.health?.primaryError ?? null,
      gave_up_at: c.resume_gave_up_at ?? null, last_error: c.resume_last_error ?? null,
    })]);
  await writeAudit(null, {
    accountId: accountId(req), userId: who.userId, label: who.label,
    action: 'update', entityType: kind, entityId: c.id,
    changes: { health: { from: before.health?.overall ?? null, to: 'reset' } },
  });
  const after = await one<any>(`SELECT * FROM ${table} WHERE id = $1`, [c.id]);
  const detail = await detailOf(after);
  return { id: c.id, was: before.health?.overall ?? null, overall: detail.health?.overall ?? null, primaryError: detail.health?.primaryError ?? null };
}

/**
 * VIEW AS A VIEWER ELSEWHERE: what would someone in this country get from the
 * play gate for this channel right now? The same decision the apps and the
 * public URL make (services/rights.ts), with the layer that made it, so the
 * operator can check the account's geo, the channel's geo, the access rules
 * and the programme blackout without travelling. viewer: anonymous (default),
 * member (signed in to the client's app), entitled (has bought access).
 */
channelsRouter.get('/:id/access-check', asyncHandler(async (req, res) => {
  const c = await one<any>(
    `SELECT c.id, c.name, c.geo_mode, c.geo_countries, g.account_id FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id = $1 AND g.account_id = $2`,
    [req.params.id, accountId(req)]);
  if (!c) throw notFound('Channel not found');
  res.json(await accessCheckFor(c, req.query));
}));

/**
 * The answer of VIEW AS A VIEWER ELSEWHERE for any live owner the caller has
 * already been shown to own (channel or event: evaluateAccess finds which).
 * Shared with GET /events/:id/access-check so both answer in one shape.
 */
export async function accessCheckFor(c: { id: string; account_id: string }, q: any) {
  const country = String(q.country ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw badRequest('country must be a two-letter code');
  const kind = String(q.viewer ?? 'anonymous');
  const { evaluateAccess } = await import('../services/rights');
  const viewerCtx = {
    country,
    viewerId: kind === 'anonymous' ? null : 'preview-viewer',
    groups: [] as string[],
    entitlements: kind === 'entitled' ? [{ grants: { ownerIds: [c.id], scopes: ['this', 'live', 'ondemand'] as any } }] : [],
  };
  const d: any = await evaluateAccess(c.id, country, { accountId: c.account_id, entitled: kind === 'entitled', viewerCtx });
  let replacement: { id: string; title: string } | null = null;
  if (d.replacementAssetId) {
    const r = await one<any>(`SELECT id, title FROM vod_assets WHERE id = $1`, [d.replacementAssetId]);
    replacement = r ? { id: r.id, title: r.title } : { id: d.replacementAssetId, title: 'replacement' };
  }
  return {
    country, viewer: kind, allowed: !!d.allowed, layer: d.layer ?? 'none', reason: d.reason ?? null,
    via: d.rule?.via ?? null, ruleId: d.rule?.ruleId ?? null,
    products: (d.products ?? []).map((p: any) => ({ name: p.name ?? p.productKey, priceCents: p.priceCents, currency: p.currency })),
    replacement,
  };
}

// A preview address for one of the channel's HLS inputs, relayed by the
// control plane for sources that refuse playback from other sites
// (modules/sourcePreview.ts). Viewing the channel is enough.
channelsRouter.get('/:id/inputs/:inputId/preview', asyncHandler(async (req, res) => {
  const row = await one<{ protocol: string; ingest_url: string | null }>(
    `SELECT si.protocol, si.ingest_url FROM stream_inputs si JOIN channels c ON c.id = si.channel_id JOIN groups g ON g.id = c.group_id
      WHERE si.id = $1 AND c.id = $2 AND g.account_id = $3`, [req.params.inputId, req.params.id, accountId(req)]);
  if (!row) throw notFound('Input not found');
  if (!/^https?:\/\//i.test(row.ingest_url ?? '')) { res.status(400).json({ error: 'Only an http or https input can be previewed through Volt' }); return; }
  res.json({ url: `/api/source-preview/${mintPreviewToken(accountId(req), req.params.id, req.params.inputId)}/index.m3u8`, expiresInSec: 7200 });
}));

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
const PROTOCOL = z.enum(['srt', 'rtmp', 'rtmps', 'hls', 'dash', 'ndi', 'st2110', 'icecast']);

// RADIO (audio-only) workflow options — see RADIO.md. Single bitrate by design.
const RADIO_CFG = z.object({
  outputs: z.object({
    mp3: z.boolean().optional(), hls: z.boolean().optional(), dash: z.boolean().optional(),
  }).optional(),
  bitrateKbps: z.number().int().min(32).max(320).optional(),
  metadataCapture: z.boolean().optional(),   // icecast: ICY now-playing → timed EPG log
  transcode: z.boolean().optional(),         // packaging is the default; transcode changes bitrate/format
  transcription: z.boolean().optional(),     // icecast only: transcribe 'content' segments
}).optional();
const RUNG = z.object({ height: z.number().int().positive(), bitrateKbps: z.number().int().positive() });
const SOURCE = z.object({
  role: z.enum(['primary', 'backup']).default('primary'),
  protocol: PROTOCOL,
  ingestUrl: z.string().optional(),
  streamKey: z.string().optional(),
  renditionLabel: z.string().optional(),        // package_only: which rung this input carries
  renditionBitrateKbps: z.number().int().optional(),
  // per-protocol settings (SRT mode/latency/passphrase, NDI discovery, 2110 SDP…), docs/SOURCES.md
  params: z.record(z.union([z.string(), z.number()])).optional(),
});

/**
 * Every source of a TV channel must be complete for its protocol, and a TV
 * channel never takes Icecast. Refused with the reason (422) before anything
 * is saved. Radio stations keep their own looser rules (radio module).
 */
export function checkVideoSources(sources: Array<{ role?: string; protocol: string; ingestUrl?: string; streamKey?: string; renditionLabel?: string; params?: Record<string, unknown> }> | undefined): void {
  for (const s of sources ?? []) {
    const why = validateSource({ protocol: s.protocol, ingestUrl: s.ingestUrl, streamKey: s.streamKey, params: s.params }, 'video');
    if (why) {
      const which = s.renditionLabel ? `${s.role === 'backup' ? 'Backup ' : ''}${s.renditionLabel}` : s.role === 'backup' ? 'Backup source' : 'Primary source';
      throw new ApiError(422, `${which}: ${why}`);
    }
  }
}
// filler-on-total-loss + input-failover (backup source) config shared by create/edit.
const FILLER = {
  inputFailoverEnabled: z.boolean().optional(),
  autoFailback: z.boolean().optional(),
  inputLossBehavior: z.enum(['none', 'slate', 'vod_loop', 'last_frame', 'black']).optional(),
  fillerSlateRef: z.string().nullable().optional(),   // image URL/ref for a slate
  fillerAssetId: z.string().uuid().nullable().optional(), // loop asset -> filler_assets
  fallbackTranscode: z.boolean().optional(),          // package_only: transcode fallback to all rungs
};

const createSchema = z.object({
  groupId: z.string().uuid(),
  name: z.string().min(1),
  purchasingMode: z.enum(['on_demand', 'reserved', 'spot_fallback']).default('reserved'),
  resilienceTier: z.enum(['standard', 'resilient_input', 'full_redundancy']).default('standard'),
  recordingRetentionDays: z.number().int().positive().nullable().optional(), // legacy days rule
  recordingEnabled: z.boolean().optional(),   // keep run segments as recordings (default on)
  recordingRetentionSec: z.number().int().positive().nullable().optional(),  // retention (any unit -> seconds)
  dvrWindowSec: z.number().int().min(30).max(DVR_MAX_SEC).nullable().optional().default(3600), // DVR on, default 1h for 24x7 (≤4h)
  dvrMode: z.enum(['sliding', 'event_start']).default('sliding'),
  // NEW — source + ladder + fallback captured at setup
  outputLadder: z.array(RUNG).optional(),  // transcode: rungs to encode; package: mirror of inputs
  sources: z.array(SOURCE).optional(),     // primary (+ optional backup / per-rendition rows)
  ...FILLER,
  watermark: WATERMARK,
  brandRef: z.string().nullable().optional(),   // channel brand/logo image (identity)
  guideIconRef: z.string().max(2048).nullable().optional(), // guide icon; null = use brandRef
  kind: z.enum(['tv', 'radio']).default('tv'),  // radio = audio-only workflows
  radio: RADIO_CFG,
  // CONTENT TYPE. A station or channel always has one: it is the base
  // metadata entry the guide and public now/next fall back to. Omitted =
  // the standard type for the kind (Radio station / TV channel).
  schemaId: z.string().uuid().optional(),
  metadata: z.record(z.any()).optional(),
});

/** Create a channel — enforces the group's max_channels entitlement. */
channelsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = createSchema.parse(req.body);
    if (body.kind !== 'radio') checkVideoSources(body.sources);
    const group = await one<any>('SELECT id, max_channels FROM groups WHERE id = $1 AND account_id = $2', [
      body.groupId,
      accountId(req),
    ]);
    if (!group) throw notFound('Group not found');
    // THE PLAN FIRST: the account's allowance of channels and stations in all
    // (services/plan.ts), then the group's share of it below.
    await assertPlanRoom(accountId(req));
    // THE GROUP'S LIMIT COUNTS TV CHANNELS AND RADIO STATIONS TOGETHER. Say so,
    // with the numbers: "limit reached (10)" alone left people looking for ten
    // TV channels when the group held two and eight stations.
    const count = await one<any>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE kind = 'radio')::int AS radio
         FROM channels WHERE group_id = $1`, [body.groupId]);
    if (count.n >= group.max_channels) {
      const tv = count.n - count.radio;
      const parts = [`${tv} TV channel${tv === 1 ? '' : 's'}`];
      if (count.radio) parts.push(`${count.radio} radio station${count.radio === 1 ? '' : 's'}`);
      throw conflict(`This group is full: it is given ${group.max_channels} channels and stations of the plan and has ${parts.join(' and ')}. ` +
        'Remove one, choose another group, or give this group a bigger share of the plan.');
    }

    const who = actor(req);
    const ladder = body.outputLadder?.length
      ? JSON.stringify(body.outputLadder.map((r) => ({ height: r.height, bitrate_kbps: r.bitrateKbps })))
      : null;
    const typeId = body.schemaId ?? await defaultTypeId(accountId(req), body.kind === 'radio' ? 'radio' : 'tv');
    const md = await validateEntityMetadata(accountId(req), typeId,
      // THE METADATA NAME IS THE CHANNEL'S NAME. The type's required `name` is
      // not a second field to keep in step: it is always the channel's own name,
      // which wins over any `name` sent inside metadata.
      { ...(body.metadata ?? {}), name: body.name }, ['channel']);

    await assertFillerAsset(accountId(req), body.fillerAssetId);
    // retention: seconds is the source of truth; derive the coarse day field in sync
    const retSec = body.recordingRetentionSec ?? (body.recordingRetentionDays != null ? body.recordingRetentionDays * 86400 : null);
    const retDays = retSec != null ? Math.max(1, Math.ceil(retSec / 86400)) : null;
    const row = await tx(async (c) => {
      const ch = (await c.query(
        `INSERT INTO channels(group_id, name, purchasing_mode, resilience_tier, recording_enabled, recording_retention_days, recording_retention_sec,
           dvr_window_sec, dvr_mode, output_ladder,
           input_failover_enabled, auto_failback, input_loss_behavior, filler_slate_ref, filler_asset_id, fallback_transcode,
           kind, radio_config,
           created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$19) RETURNING *`,
        [body.groupId, body.name, body.purchasingMode, body.resilienceTier, body.recordingEnabled ?? true, retDays, retSec,
         body.dvrWindowSec ?? null, body.dvrMode, ladder,
         body.inputFailoverEnabled ?? false, body.autoFailback ?? true, body.inputLossBehavior ?? 'none',
         body.fillerSlateRef ?? null, body.fillerAssetId ?? null, body.fallbackTranscode ?? false,
         body.kind, body.kind === 'radio' ? JSON.stringify(body.radio ?? {}) : null,
         who.userId]
      )).rows[0];
      await c.query(`UPDATE channels SET schema_id = $2, metadata = $3::jsonb WHERE id = $1`,
        [ch.id, md.schemaId, JSON.stringify(md.metadata)]);
      for (const s of body.sources ?? []) {
        await c.query(
          `INSERT INTO stream_inputs(channel_id, role, protocol, ingest_url, stream_key, rendition_label, rendition_bitrate_kbps, params)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
          [ch.id, s.role ?? 'primary', s.protocol, s.ingestUrl ?? null, s.streamKey ?? null,
           s.renditionLabel ?? null, s.renditionBitrateKbps ?? null, JSON.stringify(cleanParams(s.protocol, s.params))]
        );
      }
      return ch;
    });

    // watermark (kept out of the positional insert): set it in one follow-up update so
    // create and edit persist the exact same columns.
    if (body.watermark) {
      const w = body.watermark;
      await query(
        `UPDATE channels SET watermark_enabled=$2, watermark_ref=$3, watermark_position=$4,
           watermark_offset_x=$5, watermark_offset_y=$6, watermark_opacity=$7, watermark_scale=$8 WHERE id=$1`,
        [row.id, w.enabled ?? false, w.ref ?? null, w.position ?? 'br',
         w.offsetX ?? 24, w.offsetY ?? 24, w.opacity ?? 100, w.scale ?? 12]
      );
    }
    if (body.brandRef !== undefined) {
      await query('UPDATE channels SET brand_ref=$2 WHERE id=$1', [row.id, body.brandRef ?? null]);
    }
    if (body.guideIconRef !== undefined) {
      await query('UPDATE channels SET guide_icon_ref=$2 WHERE id=$1', [row.id, body.guideIconRef?.trim() || null]);
    }

    await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
      action: 'create', entityType: 'channel', entityId: row.id,
      snapshot: { name: row.name, group_id: row.group_id, sources: (body.sources ?? []).length, ladder: body.outputLadder?.length ?? 0 } });
    // what the sources are, and the fallback loop built to match them (async: a job)
    void scheduleFillerPrep('channel', row.id, 'created');
    res.status(201).json(row);
  })
);

/**
 * Edit a channel. PATCH = partial (send only changed fields; null clears); PUT is
 * accepted as an alias. Optimistic concurrency: send the version you loaded via the
 * `If-Match` header (or a `version` field) and the write is rejected 409 if the row
 * changed underneath you. Every change is versioned + written to the audit log.
 */
const editSchema = z.object({
  // In-stream graphic triggers (services/graphicTriggers.ts): overrides only.
  graphics: z.object({
    upNext: z.object({
      enabled: z.boolean().optional(),
      leadSec: z.number().int().min(15).max(900).optional(),
      durationSec: z.number().int().min(5).max(60).optional(),
    }).optional(),
  }).optional(),
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  // Put this channel back on air after a control-plane reboot, if it was
  // running and nobody recorded a stop. Default true (migration 0017).
  autoConnect: z.boolean().optional(),
  recordingRetentionDays: z.number().int().positive().nullable().optional(),
  recordingEnabled: z.boolean().optional(),
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
  // watermark / channel brand overlay
  watermark: WATERMARK,
  brandRef: z.string().nullable().optional(),
  guideIconRef: z.string().max(2048).nullable().optional(),
  // subtitles / live captions (persisted to the group's shared output profile)
  captions: z.object({
    enabled: z.boolean().optional(),
    sourceLang: z.string().optional(),
    targets: z.array(z.string()).optional(),
    // lip-sync trim in seconds (positive = cues later), clamped to a sane range
    offsetSec: z.number().min(-30).max(30).optional(),
  }).optional(),
  // radio (audio-only) workflow options — merged into radio_config
  radio: RADIO_CFG,
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
  if (has('sources') && current.kind !== 'radio') checkVideoSources(body.sources);

  const patch: Record<string, any> = {};
  if (has('name')) patch.name = body.name;
  if (has('enabled')) patch.enabled = body.enabled;
  if (has('autoConnect')) patch.auto_connect = body.autoConnect;
  if (has('recordingEnabled')) patch.recording_enabled = body.recordingEnabled;
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
  if (has('fillerAssetId')) { await assertFillerAsset(accountId(req), body.fillerAssetId); patch.filler_asset_id = body.fillerAssetId ?? null; }
  if (has('fallbackTranscode')) patch.fallback_transcode = body.fallbackTranscode;
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
  // Graphics: merged over what is stored, so a partial change keeps the rest.
  // Not locked while running: the encoder re-reads triggers every few seconds.
  if (has('graphics') && body.graphics) {
    const cur = (current.graphics && typeof current.graphics === 'object') ? current.graphics : {};
    patch.graphics = { ...cur, ...(body.graphics.upNext ? { upNext: { ...(cur.upNext ?? {}), ...body.graphics.upNext } } : {}) };
  }
  if (has('brandRef')) patch.brand_ref = body.brandRef ?? null;
  if (has('guideIconRef')) patch.guide_icon_ref = body.guideIconRef?.trim() || null;
  if (has('radio') && body.radio && current.kind === 'radio') {
    // shallow-merge over the stored config so partial patches keep other keys
    const cur = current.radio_config ?? {};
    patch.radio_config = { ...cur, ...body.radio,
      outputs: { ...(cur.outputs ?? {}), ...(body.radio.outputs ?? {}) } };
  }
  // A rename rewrites metadata.name too: it is the same value (see create).
  const touchMeta = has('schemaId') || has('metadata') || has('name');
  if (touchMeta) {
    // A type is required: clearing it is refused, changing it is allowed.
    if (has('schemaId') && body.schemaId == null) throw badRequest('A content type is required. Choose another type instead of clearing it.');
    const md = await validateEntityMetadata(accountId(req), (has('schemaId') ? body.schemaId : current.schema_id) ?? null,
      { ...((has('metadata') ? body.metadata : current.metadata) ?? {}), name: has('name') ? body.name : current.name }, ['channel']);
    patch.schema_id = md.schemaId;
    patch.metadata = md.metadata;
  }

  // SETTINGS LOCK: what the encoder reads at start cannot change under it.
  // See services/settingsLock.ts. Re-sending the stored value is not a change.
  if (await encoderRunning(req.params.id)) {
    const locked = await lockedChanges(req.params.id, current, patch, body as any, has);
    if (locked.length) {
      return res.status(409).json({
        error: `Stop the channel to change ${locked.join(', ')}. These are read by the encoder when it starts.`,
        code: 'locked_while_running', fields: locked,
      });
    }
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
            `INSERT INTO stream_inputs(channel_id, role, protocol, ingest_url, stream_key, rendition_label, rendition_bitrate_kbps, params)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
            [req.params.id, s.role ?? 'primary', s.protocol, s.ingestUrl ?? null, s.streamKey ?? null,
             s.renditionLabel ?? null, s.renditionBitrateKbps ?? null, JSON.stringify(cleanParams(s.protocol, s.params))]
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
        if (cap.offsetSec !== undefined) { sets.push(`caption_offset_sec = $${sets.length + 1}`); vals.push(cap.offsetSec); }
        if (sets.length) {
          vals.push(grp.output_profile_id);
          await query(`UPDATE output_profiles SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}`, vals);
          await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
            action: 'update', entityType: 'output_profile', entityId: grp.output_profile_id,
            snapshot: { captions: cap } });
        }
      }
    }

    if (FILLER_FIELDS.some((k) => has(k))) void scheduleFillerPrep('channel', req.params.id, 'settings changed');
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

/**
 * WHAT A DELETE WOULD TAKE WITH IT. The console shows this before an
 * administrator confirms: deleting a channel removes its recordings, clips,
 * guide and schedules with it (all ON DELETE CASCADE).
 */
channelsRouter.get(
  '/:id/delete-impact',
  asyncHandler(async (req, res) => {
    res.json(await deleteImpact(req.params.id, accountId(req)));
  })
);

async function deleteImpact(id: string, acc: string) {
  const ch = await one<any>(
    `SELECT c.id, c.name, c.kind, c.status, g.name AS group_name,
            EXISTS (SELECT 1 FROM instances i WHERE i.channel_id = c.id AND i.terminated_at IS NULL) AS running
       FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id = $1 AND g.account_id = $2`, [id, acc]);
  if (!ch) throw notFound('Channel not found');
  const n = await one<any>(
    `SELECT (SELECT count(*)::int FROM recordings WHERE channel_id = $1) AS recordings,
            (SELECT count(*)::int FROM vod_assets WHERE channel_id = $1) AS clips,
            (SELECT count(*)::int FROM vod_assets WHERE channel_id = $1 AND availability_state IN ('available','scheduled')) AS published_clips,
            (SELECT count(*)::int FROM programmes WHERE channel_id = $1) AS programmes,
            (SELECT count(*)::int FROM scheduled_clips WHERE channel_id = $1) AS scheduled_clips,
            (SELECT count(*)::int FROM stream_inputs WHERE channel_id = $1) AS sources`, [id]);
  const blocker = ch.status === 'live' ? 'Stop the channel before deleting it'
    : ch.running ? 'This channel still has a running encoder. Stop it before deleting.' : null;
  return { id: ch.id, name: ch.name, kind: ch.kind, group: ch.group_name, status: ch.status, blocker, counts: n };
}

/** Delete a channel or station. ADMINISTRATORS ONLY; every attempt is in the audit log. */
channelsRouter.delete(
  '/:id',
  requireMinRole('admin'),
  asyncHandler(async (req, res) => {
    // STOP IT FIRST. The comment here used to say "in production: terminate any
    // running encoder first" and then delete anyway.
    //
    // That was survivable while the instances FK was ON DELETE SET NULL, since
    // the row lingered. Migration 0013 made it CASCADE, which is right — but it
    // means deleting a live channel now takes the ONLY record of its encoder
    // with it. The task keeps running, keeps writing to the origin, and keeps
    // costing, and nothing in the system can reach it any more: stopStream
    // looks up instances by channel_id and the channel is gone.
    //
    // Events already refuse this. Channels now do too, with the same words.
    const owned = await one<any>(
      `SELECT c.id, c.status FROM channels c JOIN groups g ON g.id = c.group_id
        WHERE c.id = $1 AND g.account_id = $2`,
      [req.params.id, accountId(req)]
    );
    if (!owned) throw notFound('Channel not found');
    if (owned.status === 'live') throw badRequest('Stop the channel before deleting it');
    // A channel that is not `live` can still have an instance the reconciler
    // has not caught up with yet. Deleting that is the same orphan by a slower
    // route, so it is refused for the same reason.
    const running = await one<any>(
      `SELECT 1 FROM instances WHERE channel_id = $1 AND terminated_at IS NULL LIMIT 1`,
      [req.params.id]
    );
    if (running) throw badRequest('This channel still has a running encoder. Stop it before deleting.');

    const impact = await deleteImpact(req.params.id, accountId(req));
    const row = await one<any>(
      `DELETE FROM channels c USING groups g
        WHERE c.group_id = g.id AND c.id = $1 AND g.account_id = $2 RETURNING c.id, c.name`,
      [req.params.id, accountId(req)]
    );
    if (!row) throw notFound('Channel not found');
    const who = actor(req);
    await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
      action: 'delete', entityType: 'channel', entityId: row.id,
      snapshot: { name: row.name, kind: impact.kind, group: impact.group, removed: impact.counts } });
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

/** Pre-on-air FAILOVER TEST. Writes a small control file into the channel's output dir
 *  that the running encoder's source-selector polls, letting an admin force a failover
 *  (slate / loop / backup / simulate a primary loss) and watch the REAL output switch,
 *  then clear it (mode=auto) to resume health-driven behaviour. The real switch only
 *  happens on redundancy-enabled package channels (where the selector runs); the UI
 *  offers a preview simulation elsewhere. */
const failoverModes = FAILOVER_MODES;
const failoverTestSchema = z.object({ mode: z.enum(failoverModes) });
function failoverControlPath(channelId: string) {
  return join(resolve(config.testStream.originDir, channelId), '_failover_control.json');
}
function channelFailoverCapability(chan: any) {
  // The selector is now wired for BOTH transcode and package_only, so a real failover
  // runs whenever input failover is enabled on the channel.
  const real = !!chan.input_failover_enabled;
  // What the loop filler will be, so the admin knows before testing: an uploaded loop
  // asset wins; otherwise a loop is made from the slate image with a gentle motion.
  const lossBehavior = chan.input_loss_behavior ?? null;
  const loopKind = lossBehavior === 'vod_loop'
    ? (chan.filler_asset_id ? 'uploaded' : (chan.filler_slate_ref ? 'motion_slate' : 'slate'))
    : null;
  return { realFailover: real, workflowType: chan.workflow_type ?? null,
    autoFailback: chan.auto_failback ?? null, lossBehavior, loopKind,
    hasSlate: !!chan.filler_slate_ref };
}
channelsRouter.post(
  '/:id/failover-test',
  asyncHandler(async (req, res) => {
    const chan = await one<any>(
      `SELECT c.*, p.workflow_type FROM channels c JOIN groups g ON g.id = c.group_id
         LEFT JOIN output_profiles p ON p.id = g.output_profile_id
        WHERE c.id = $1 AND g.account_id = $2`,
      [req.params.id, accountId(req)]
    );
    if (!chan) throw notFound('Channel not found');
    const { mode } = failoverTestSchema.parse(req.body);
    // Failover acts on the RUNNING encoder's source selector: before the channel is
    // started there is nothing to switch, so refuse instead of writing a control file
    // nothing reads (a stale forced mode is also cleared at every encoder start).
    const running = await one(
      `SELECT 1 FROM instances WHERE channel_id=$1 AND terminated_at IS NULL LIMIT 1`,
      [req.params.id]);
    if (!running) {
      res.status(409).json({ error: 'Channel is not running. Start the channel first: failover acts on the running encoder.' });
      return;
    }
    const dir = resolve(config.testStream.originDir, req.params.id);
    try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    writeFileSync(failoverControlPath(req.params.id), JSON.stringify({ mode, at: Date.now() }));
    // ...and the encoder wherever it runs: it picks this up on its timed-events
    // poll (services/failoverControl.ts). The local file above serves an encoder
    // on this machine at once.
    const control = await setFailoverControl('channel', req.params.id, mode, actor(req).label);
    const hasBackup = !!(await one(`SELECT 1 FROM stream_inputs WHERE channel_id=$1 AND role='backup' LIMIT 1`, [req.params.id]));
    res.json({ mode, hasBackup, control, ...channelFailoverCapability(chan) });
  })
);
channelsRouter.get(
  '/:id/failover-test',
  asyncHandler(async (req, res) => {
    const chan = await one<any>(
      `SELECT c.input_failover_enabled, c.auto_failback, c.input_loss_behavior, p.workflow_type
         FROM channels c JOIN groups g ON g.id = c.group_id
         LEFT JOIN output_profiles p ON p.id = g.output_profile_id
        WHERE c.id = $1 AND g.account_id = $2`,
      [req.params.id, accountId(req)]
    );
    if (!chan) throw notFound('Channel not found');
    // The run's control is the stream event (it reaches a remote encoder too);
    // the local file is only consulted when no event says anything.
    const control = await currentFailoverControl('channel', req.params.id);
    let mode: string = control.mode;
    if (!control.at) {
      try { mode = String(JSON.parse(readFileSync(failoverControlPath(req.params.id), 'utf8')).mode || 'auto'); } catch { /* no file yet */ }
    }
    const hasBackup = !!(await one(`SELECT 1 FROM stream_inputs WHERE channel_id=$1 AND role='backup' LIMIT 1`, [req.params.id]));
    res.json({ mode, hasBackup, control, ...channelFailoverCapability(chan) });
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
    // The column and the ledger move together. See services/airSessions.ts:
    // this used to be a bare UPDATE and it left no record at all, which is why
    // "total hours on air" had no source for channels.
    const { setOnAir } = await import('../services/airSessions');
    await setOnAir('channel', chan.id, on, {
      actor: actor(req).label,
      reason: on ? undefined : 'operator',
    });
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
      await orchestrator.stopStream('channel', req.params.id, `api:operator (user ${accountId(req)})`, 'operator');
      // Stopping the encoder also takes the channel off air (the public URL
      // closes). Recorded with its own reason: an availability report has to be
      // able to separate "the operator ended the broadcast" from "the stream
      // fell over", and both arrive here as on_air going false.
      const { setOnAir } = await import('../services/airSessions');
      await setOnAir('channel', req.params.id, false, {
        actor: actor(req).label, reason: 'stream stopped',
      });
    }
    const row = await one('SELECT * FROM channels WHERE id = $1', [req.params.id]);
    res.json(row);
  })
);

/**
 * AUTO CONNECT, BY HAND. `{ enabled: false }` stops the retry loop right now
 * and leaves the counters, the last error and the log exactly as they are, so
 * the operator can read why the stream fell over without it being relaunched
 * underneath them. `{ enabled: true }` puts it back; the stream still has to
 * be seen healthy before it is armed.
 */
channelsRouter.post(
  '/:id/auto-connect',
  asyncHandler(async (req, res) => {
    const owned = await one<any>(
      `SELECT o.id, o.auto_connect FROM channels o JOIN groups g ON g.id = o.group_id
        WHERE o.id = $1 AND g.account_id = $2`,
      [req.params.id, accountId(req)]
    );
    if (!owned) throw notFound('Channel not found');
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body ?? {});
    const { setAutoConnect } = await import('../services/orchestrator/resume');
    const who = actor(req);
    await setAutoConnect('channel', req.params.id, enabled, who.label);
    await writeAudit(null, {
      accountId: accountId(req), userId: who.userId, label: who.label,
      action: 'update', entityType: 'channel', entityId: req.params.id,
      changes: { auto_connect: { from: owned.auto_connect, to: enabled } },
    }).catch(() => {});
    const row = await one('SELECT * FROM channels WHERE id = $1', [req.params.id]);
    res.json(row);
  })
);


/** What each source is (its stored probe) and the state of the pre-built fallback loop. */
channelsRouter.get(
  '/:id/filler',
  asyncHandler(async (req, res) => {
    const own = await one<any>(
      `SELECT o.id FROM channels o JOIN groups g ON g.id = o.group_id WHERE o.id = $1 AND g.account_id = $2`,
      [req.params.id, accountId(req)]);
    if (!own) throw notFound('Not found');
    const inputs = await query<any>(
      `SELECT id, role, protocol, rendition_label, ingest_url, probe, probed_at FROM stream_inputs WHERE channel_id = $1 ORDER BY role`,
      [req.params.id]);
    res.json({ build: await fillerStatus('channel', req.params.id), inputs });
  })
);

/** Probe the sources and (re)build the loop NOW, waiting for the result. */
channelsRouter.post(
  '/:id/filler',
  asyncHandler(async (req, res) => {
    const own = await one<any>(
      `SELECT o.id FROM channels o JOIN groups g ON g.id = o.group_id WHERE o.id = $1 AND g.account_id = $2`,
      [req.params.id, accountId(req)]);
    if (!own) throw notFound('Not found');
    res.json({ build: await runFillerPrep('channel', req.params.id) });
  })
);
