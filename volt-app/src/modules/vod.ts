import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest } from '../util/http';
import { validateMetadata, SchemaField } from '../services/metadataValidator';
import { videoObjectFromAsset } from '../services/schemaOrg';
import { traceClip } from '../services/clips/provenance';
import { enqueueClipBuild } from '../services/clips';
import { decide, historyOf as reviewHistory, publishGate, queue as reviewQueue, IllegalReview } from '../services/review';
import { qcFindings } from '../services/qc';
import { enqueue } from '../services/jobs/queue';
import { CLIP_EXTRACT } from '../services/jobs/handlers/clipExtract';
import { resolveRange, assessRange, segmentCount } from '../services/clips/resolve';
import { isAudioOnly } from '../services/localRecordingIndex';
import type { OutputFormat } from '../services/clips/extract';
import { QC_RUN } from '../services/jobs/handlers/qcRun';
import { originBaseFor } from '../services/liveOrigin';
import { actorId, actorLabel } from '../util/actor';
import { actor, writeAudit } from '../services/audit';
import { publish, withdraw, republish, NotPublishable } from '../services/availability';
import { resolveForAsset } from '../services/publishingRules';
import { cleanSettings } from './publishingRules';
import { defineList, parseList, whereSql, countWhereSql, countParams, pageSql, finishPage, onlyIdParam } from '../util/listQuery';
import { ORIGIN_SQL, ORIGINS, SOURCE_SQL, SOURCES, MEDIA_TYPE_SQL, MEDIA_TYPES, completenessPctSql, missingRequiredCountSql, completeness as metadataCompleteness, targetFields, encodeDetails } from '../services/vodLibrary';
import { previewFill, applyFill, pruneProvenance, typeOf } from '../services/epgFill';
import { usageStatusSql, USAGE_STATUSES } from '../services/assetReadiness';

/**
 * VOD Library — assets DERIVED from a recording (auto-published, clips, exports).
 * Carries publishing state, keyscreen/storyboard, and custom metadata validated
 * against an assigned named schema (modules/metadataSchemas.ts).
 */
export const vodRouter = Router();
vodRouter.use(requireAuth);

/**
 * The tenant boundary for an asset.
 *
 * IT USED TO BE AN INNER JOIN THROUGH THE CHANNEL OR EVENT, which was right
 * while every asset was derived from a recording and therefore had one. An
 * uploaded or watched-folder asset has neither: it belongs to the account
 * directly. Under the inner join those rows simply did not exist — every list,
 * every fetch, every permission check silently returned nothing, and a file
 * somebody uploaded would encode successfully and then never appear.
 *
 * So the join is LEFT and ownership is `COALESCE(g.account_id, v.account_id)`.
 * The COALESCE order matters: a recording-derived asset's account is still the
 * one that owns its channel, which is the existing behaviour unchanged, and
 * v.account_id only answers for rows that have no channel at all.
 */
const OWNED = `
  FROM vod_assets v
  LEFT JOIN channels c ON c.id = v.channel_id
  LEFT JOIN events   e ON e.id = v.event_id
  LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
`;

/** The account that owns the asset, whichever way it got here. */
const OWNER_ACCOUNT = `COALESCE(g.account_id, v.account_id)`;
/** Slates and loops rendered for FAST channels (services/fast/fillerBridge.ts) live in Loops & Fillers, not the Media Library. */
const HIDE_FAST_FILLER = `AND COALESCE(v.metadata->>'fastFiller', '') <> 'true'`;

/**
 * THE LIBRARY VIEW COLUMNS (services/vodLibrary.ts): the asset's content type
 * with its parent's fields (the list joins `ms` and its parent `msp`), the
 * target-metadata completeness, where the asset came from, and the encode
 * summary. Trusted SQL, used both as list fields and in the SELECT.
 */
const EFFECTIVE_FIELDS = `(CASE WHEN ms.id IS NULL THEN NULL ELSE COALESCE(msp.fields, '[]'::jsonb) || COALESCE(ms.fields, '[]'::jsonb) END)`;
const MISSING_REQUIRED_SQL = missingRequiredCountSql(EFFECTIVE_FIELDS, 'ms.standard_key', 'v.metadata');
const COMPLETENESS_SQL = completenessPctSql(EFFECTIVE_FIELDS, 'ms.standard_key', 'v.metadata');
const RENDITION_COUNT_SQL = `COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(v.encode_result->'kept') = 'array' THEN v.encode_result->'kept' END),
  (SELECT jsonb_array_length(op.rungs) FROM output_profiles op WHERE op.id = g.output_profile_id AND jsonb_typeof(op.rungs) = 'array'))`;
/** CAN IT BE USED (services/assetReadiness.ts). The list and facets join the encode job as `j`. */
const USAGE_SQL = usageStatusSql('v', 'j.state::text');
const LIBRARY_JOINS = `
       LEFT JOIN metadata_schemas ms ON ms.id = v.schema_id
       LEFT JOIN metadata_schemas msp ON msp.id = ms.extends_id`;

/**
 * THE LIBRARY LIST, searchable, filterable, sortable and paged the standard
 * way (util/listQuery.ts). Field names are the row's own property names.
 * It used to return every asset; without limit/cursor it still returns up to
 * 1000, so the library page keeps its data until it pages on the server.
 */
const VOD_LIST = defineList({
  path: '/api/vod',
  fields: {
    id: { sql: 'v.id', type: 'uuid' },
    title: { sql: 'v.title', type: 'string' },
    kind: { sql: 'v.kind', type: 'enum', values: ['clip', 'full_event', 'export'] },
    source_kind: { sql: 'v.source_kind', type: 'enum', values: ['recording', 'upload', 'watchfolder'], doc: 'Where the asset came from' },
    source_name: { sql: 'COALESCE(c.name, e.name)', type: 'string', doc: 'The channel or event it was cut from' },
    channel_id: { sql: 'v.channel_id', type: 'uuid' },
    event_id: { sql: 'v.event_id', type: 'uuid' },
    recording_id: { sql: 'v.recording_id', type: 'uuid' },
    schema_id: { sql: 'v.schema_id', type: 'uuid' },
    schema_name: { sql: 'ms.name', type: 'string' },
    published: { sql: 'v.published', type: 'boolean' },
    portal_visible: { sql: 'v.portal_visible', type: 'boolean' },
    output_kind: { sql: 'v.output_kind', type: 'enum', values: ['manifest', 'progressive', 'both'] },
    review_state: { sql: 'v.review_state', type: 'enum', values: ['draft', 'in_review', 'changes_requested', 'approved', 'rejected'] },
    qc_state: { sql: 'v.qc_state', type: 'string' },
    availability_state: { sql: 'v.availability_state', type: 'enum', values: ['draft', 'scheduled', 'available', 'expired', 'withdrawn'] },
    available_from: { sql: 'v.available_from', type: 'timestamp' },
    available_until: { sql: 'v.available_until', type: 'timestamp' },
    withdrawn_at: { sql: 'v.withdrawn_at', type: 'timestamp' },
    thumb_status: { sql: 'v.thumb_status', type: 'enum', values: ['uploading', 'processing', 'ready', 'error'] },
    original_filename: { sql: 'v.original_filename', type: 'string' },
    mime: { sql: 'v.mime', type: 'string' },
    start_epoch_ms: { sql: 'v.start_epoch_ms', type: 'number' },
    end_epoch_ms: { sql: 'v.end_epoch_ms', type: 'number' },
    duration_ms: { sql: 'v.duration_ms', type: 'number' },
    source_bytes: { sql: 'v.source_bytes', type: 'number' },
    source_coverage_pct: { sql: 'v.source_coverage_pct', type: 'number' },
    // Library views (DESIGN_media_library.md, "Library views, filters and target metadata")
    schema_key: { sql: 'ms.standard_key', type: 'string', doc: 'Standard content type key (episode, movie, clip, sports-match ...)' },
    schema_org_type: { sql: 'ms.schema_org_type', type: 'string', doc: 'schema.org type of the content type (Episode, Movie, VideoObject, SportsEvent ...)' },
    origin: { sql: ORIGIN_SQL, type: 'enum', values: ORIGINS, doc: 'How it was made: recording, clip, upload or watchfolder' },
    source: { sql: SOURCE_SQL, type: 'enum', values: SOURCES, doc: 'What it belongs to: channel, event, radio, upload, or none (its channel or event is gone)' },
    media_type: { sql: MEDIA_TYPE_SQL, type: 'enum', values: MEDIA_TYPES, doc: 'video, audio or song' },
    metadata_completeness: { sql: COMPLETENESS_SQL, type: 'number', doc: 'Target metadata filled, 0 to 100' },
    metadata_missing_required: { sql: `(${MISSING_REQUIRED_SQL} > 0)`, type: 'boolean', doc: 'A required target field is empty, or the asset has no content type' },
    top_height: { sql: 'v.top_height', type: 'number', doc: 'Height of the top rendition (2160, 1080, 720 ...)' },
    video_codec: { sql: 'v.video_codec', type: 'string', doc: 'h264, hevc or av1' },
    rendition_count: { sql: RENDITION_COUNT_SQL, type: 'number', sort: false },
    has_stale_publication: { sql: 'EXISTS (SELECT 1 FROM publications p WHERE p.vod_asset_id = v.id AND p.stale)', type: 'boolean', doc: 'A published copy is older than this asset' },
    publication_count: { sql: '(SELECT count(*) FROM publications p WHERE p.vod_asset_id = v.id)::int', type: 'number' },
    encode_state: { sql: 'j.state', type: 'enum', values: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] },
    usage_status: { sql: USAGE_SQL, type: 'enum', values: [...USAGE_STATUSES], doc: 'Can it be used: ready, unchecked, qc_failed, processing, failed, unplayable or no_media. Only ready is offered to FAST, loops and blocking' },
    media_state: { sql: 'v.media_state', type: 'enum', values: ['processing', 'ready', 'failed', 'missing', 'unplayable'] },
    encode_pct: { sql: 'j.progress_pct', type: 'number' },
    created_at: { sql: 'v.created_at', type: 'timestamp', notNull: true },
    updated_at: { sql: 'v.updated_at', type: 'timestamp' },
    built_at: { sql: 'v.built_at', type: 'timestamp' },
    reviewed_at: { sql: 'v.reviewed_at', type: 'timestamp' },
  },
  search: ['title', 'original_filename', 'source_name', 'schema_name', "v.metadata->>'description'"],
  defaultSort: '-created_at',
  // The hypermedia links (services/hypermedia.ts) and older callers use camelCase.
  aliases: { recordingId: 'recording_id', channelId: 'channel_id', eventId: 'event_id' },
  unpagedLimit: 1000,
  // COLLECTIONS (modules/collections.ts): collection=<id>[,<id>] keeps assets in
  // any of them; collection_deep=true includes their sub-collections;
  // not_in_collection=<id> leaves out what is already in one (the picker's
  // "not yet added" view). Applied by collectionWhere below.
  extraParams: ['collection', 'collection_deep', 'not_in_collection'],
});

/**
 * The collection filters as SQL on `v`, with their params pushed (tenant-safe:
 * only the account's own collections count). Empty when not asked for.
 */
async function collectionWhere(q: Record<string, any>, params: unknown[], account: string): Promise<string> {
  const idsOf = (v: unknown) => String(v ?? '').split(',').map((s) => s.trim()).filter((s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)).slice(0, 50);
  const deep = q.collection_deep === 'true' || q.collection_deep === '1';
  let sql = '';
  const inSet = async (ids: string[]) => {
    if (!deep) return ids;
    const { subtreeIds } = await import('./collections');
    return [...new Set((await Promise.all(ids.map(subtreeIds))).flat())];
  };
  const want = idsOf(q.collection);
  if (q.collection != null && q.collection !== '' && !want.length) throw badRequest('collection must be a collection id');
  if (want.length) {
    params.push(await inSet(want), account);
    sql += ` AND EXISTS (SELECT 1 FROM collection_items ci JOIN collections cc ON cc.id = ci.collection_id
               WHERE ci.vod_asset_id = v.id AND ci.collection_id = ANY($${params.length - 1}::uuid[]) AND cc.account_id = $${params.length})`;
  }
  const not = idsOf(q.not_in_collection);
  if (not.length) {
    params.push(not);
    sql += ` AND NOT EXISTS (SELECT 1 FROM collection_items ci WHERE ci.vod_asset_id = v.id AND ci.collection_id = ANY($${params.length}::uuid[]))`;
  }
  return sql;
}

vodRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const params: unknown[] = [accountId(req)];
    const inCollection = await collectionWhere(req.query as any, params, accountId(req));
    const pl = parseList(VOD_LIST, req.query, params);
    const from = `${OWNED}${LIBRARY_JOINS}
       LEFT JOIN jobs j ON j.id = v.encode_job_id
       WHERE COALESCE(g.account_id, v.account_id) = $1 ${HIDE_FAST_FILLER}${inCollection}`;
    const fromCount = from + countWhereSql(pl);  // totals ignore the cursor
    const fromPage = from + whereSql(pl);
    const rows = await query(
      `SELECT v.*, ms.name AS schema_name, COALESCE(c.name, e.name) AS source_name,
              -- Whether the copy that went out is still the copy that is here.
              -- Computed in the list because it is a thing you filter on, and a
              -- library that cannot answer "what did I publish that has since
              -- changed" is a library you have to check by hand.
              EXISTS (SELECT 1 FROM publications p
                       WHERE p.vod_asset_id = v.id AND p.stale) AS has_stale_publication,
              (SELECT count(*) FROM publications p WHERE p.vod_asset_id = v.id)::int AS publication_count,
              -- THE ENCODE, for a file-sourced asset. An asset with no master
              -- yet is not broken, it is still being made, and the list has to
              -- be able to say which.
              j.state AS encode_state, j.progress_pct AS encode_pct,
              j.progress_note AS encode_note, j.last_error AS encode_error,
              -- THE LIBRARY VIEW: content type, completeness, origin, encode summary.
              ms.standard_key AS schema_key, ms.schema_org_type,
              ${ORIGIN_SQL} AS origin,
              ${SOURCE_SQL} AS source, ${MEDIA_TYPE_SQL} AS media_type,
              ${COMPLETENESS_SQL} AS metadata_completeness,
              (${MISSING_REQUIRED_SQL} > 0) AS metadata_missing_required,
              ${RENDITION_COUNT_SQL} AS rendition_count,
              -- AUDIO ONLY, for the grid's square artwork and audio badge
              -- (same test as services/media/assetImage.ts isAudioAsset).
              COALESCE(c.kind = 'radio', false) OR COALESCE(v.ingest -> 'probe' ->> 'hasVideo' = 'false', false)
                OR ((v.export_mp3_key IS NOT NULL OR v.export_m4a_key IS NOT NULL) AND v.top_height IS NULL AND v.progressive_key IS NULL) AS audio_only,
              -- THE COLOUR KEY when there is no image: music (a song), audio, or video.
              CASE WHEN ms.standard_key = 'song' OR v.metadata->>'class' = 'song' THEN 'music'
                   WHEN COALESCE(c.kind = 'radio', false) OR COALESCE(v.ingest -> 'probe' ->> 'hasVideo' = 'false', false)
                     OR ((v.export_mp3_key IS NOT NULL OR v.export_m4a_key IS NOT NULL) AND v.top_height IS NULL AND v.progressive_key IS NULL) THEN 'audio'
                   ELSE 'video' END AS media_kind,
              (v.export_mp3_key IS NOT NULL) AS has_mp3,
              ${USAGE_SQL} AS usage_status
       ${fromPage}
       ${pageSql(pl)}`,
      params
    );
    const total = pl.count ? Number((await one<any>(`SELECT count(*)::int AS n ${fromCount}`, countParams(pl, params)))?.n ?? 0) : undefined;
    res.json(finishPage(req, res, pl, rows as any[], total));
  })
);

/**
 * FACETS FOR THE LIBRARY FILTERS: how many assets each choice would show.
 *
 * Takes the same query as the list. Each facet is counted with every OTHER
 * filter applied and its own left out, so a chip's number is what ticking it
 * (alone, on top of the rest) would show. Declared before '/:id'.
 */
const FACET_PARAMS: Record<string, string[]> = {
  types: ['schema_id', 'schema_key', 'schema_org_type', 'schema_name'],
  availability: ['availability_state', 'published'],
  origins: ['origin', 'source_kind', 'kind'],
  sources: ['source', 'channel_id', 'event_id'],
  media_types: ['media_type'],
  resolutions: ['top_height'],
  codecs: ['video_codec'],
  metadata: ['metadata_missing_required', 'metadata_completeness'],
  usage: ['usage_status', 'media_state'],
};
const FACET_SQL: Record<string, { select: string; group: string }> = {
  types: { select: `ms.id AS id, ms.name AS name, ms.standard_key AS key, ms.schema_org_type AS schema_org_type`, group: 'ms.id, ms.name, ms.standard_key, ms.schema_org_type' },
  availability: { select: `v.availability_state AS value`, group: 'v.availability_state' },
  origins: { select: `${ORIGIN_SQL} AS value`, group: '1' },
  sources: { select: `${SOURCE_SQL} AS value`, group: '1' },
  media_types: { select: `${MEDIA_TYPE_SQL} AS value`, group: '1' },
  resolutions: { select: `v.top_height AS value`, group: 'v.top_height' },
  codecs: { select: `v.video_codec AS value`, group: 'v.video_codec' },
  metadata: { select: `(${MISSING_REQUIRED_SQL} > 0) AS value`, group: '1' },
  usage: { select: `${USAGE_SQL} AS value`, group: '1' },
};

vodRouter.get(
  '/facets',
  asyncHandler(async (req, res) => {
    const strip = (keys: string[]) => {
      const q: Record<string, any> = { ...req.query };
      for (const k of [...keys, 'cursor', 'offset', 'limit', 'count', 'sort']) delete q[k];
      return q;
    };
    const out: Record<string, any[]> = {};
    for (const [name, keys] of Object.entries(FACET_PARAMS)) {
      const params: unknown[] = [accountId(req)];
      const inCollection = await collectionWhere(req.query as any, params, accountId(req));
      const pl = parseList(VOD_LIST, strip(keys) as any, params);
      const f = FACET_SQL[name];
      const groupBy = f.group === '1' ? '1' : f.group;
      out[name] = await query(
        `SELECT ${f.select}, count(*)::int AS n
           FROM vod_assets v
           LEFT JOIN channels c ON c.id = v.channel_id
           LEFT JOIN events   e ON e.id = v.event_id
           LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)${LIBRARY_JOINS}
           LEFT JOIN jobs j ON j.id = v.encode_job_id
          WHERE COALESCE(g.account_id, v.account_id) = $1 ${HIDE_FAST_FILLER}${inCollection} ${countWhereSql(pl)}
          GROUP BY ${groupBy} ORDER BY n DESC`, countParams(pl, params));
    }
    const allParams: unknown[] = [accountId(req)];
    const allIn = await collectionWhere(req.query as any, allParams, accountId(req));
    const all = parseList(VOD_LIST, strip([]) as any, allParams);
    const total = await one<{ n: number }>(
      `SELECT count(*)::int AS n ${OWNED}${LIBRARY_JOINS} LEFT JOIN jobs j ON j.id = v.encode_job_id
        WHERE COALESCE(g.account_id, v.account_id) = $1 ${HIDE_FAST_FILLER}${allIn} ${countWhereSql(all)}`, countParams(all, allParams));
    res.json({ total: total?.n ?? 0, facets: out });
  })
);

/**
 * BULK EPG FILL. For each asset, the confident programme match only, empty
 * fields only: a bulk action never overwrites anything and never guesses
 * between two programmes. Reports per asset what it did and why not.
 */
vodRouter.post(
  '/epg-fill',
  asyncHandler(async (req, res) => {
    const b = z.object({
      ids: z.array(z.string().uuid()).min(1).max(200),
      title: z.boolean().default(false),
      applyType: z.boolean().default(false),
    }).parse(req.body);
    const acct = accountId(req);
    const who = actor(req);
    const results = [];
    for (const id of b.ids) {
      const a = await fetchOwned(id, acct);
      if (!a) { results.push({ assetId: id, applied: [], skipped: [], programmeId: null, typeChanged: false, titleChanged: false, reason: 'not found' }); continue; }
      results.push(await applyFill(a, acct, who, { requireConfident: true, title: b.title, applyType: b.applyType, overwrite: [] }));
    }
    res.json({
      results,
      filled: results.filter((r) => r.applied.length || r.titleChanged || r.typeChanged).length,
      unchanged: results.filter((r) => !r.applied.length && !r.titleChanged && !r.typeChanged).length,
    });
  })
);

/** The asset's content type, its target fields, completeness and where filled values came from. */
vodRouter.get(
  '/:id/target-metadata',
  onlyIdParam,
  asyncHandler(async (req, res) => {
    const a = await fetchOwned(req.params.id, accountId(req));
    if (!a) throw notFound('VOD asset not found');
    const type = await typeOf(a.schema_id, accountId(req));
    const tf = type ? targetFields(type.fields, type.standardKey) : { fields: [], notOnType: [] };
    res.json({
      type: type ? { id: type.id, name: type.name, key: type.standardKey, schemaOrgType: type.schemaOrgType } : null,
      fields: tf.fields.map((f) => ({ key: f.key, label: f.label ?? f.key, type: f.type, required: f.required, options: f.options, multiple: f.multiple, schemaOrg: f.schemaOrg ?? null, epg: f.epg ?? null })),
      completeness: metadataCompleteness(type?.fields ?? null, type?.standardKey, a.metadata),
      provenance: a.metadata_provenance ?? {},
    });
  })
);

/** Encode settings for the asset page: stored where stored, derived and marked where not. */
vodRouter.get(
  '/:id/encode',
  onlyIdParam,
  asyncHandler(async (req, res) => {
    const a = await fetchOwned(req.params.id, accountId(req));
    if (!a) throw notFound('VOD asset not found');
    const ladderGroup = a.ladder_group_id
      ? await one<any>(`SELECT name, packaging, codec_backend, segment_dur FROM encode_ladder_groups WHERE id = $1`, [a.ladder_group_id]).catch(() => null)
      : null;
    const outputProfile = (a.channel_id || a.event_id) ? await one<any>(
      `SELECT op.name, op.rungs, op.packaging::text AS packaging, op.workflow_type::text AS workflow_type, op.codec_backend::text AS codec_backend,
              op.segment_dur, op.drm_enabled, dc.systems AS drm_systems, op.captions_enabled, op.caption_source_lang, op.caption_targets
         FROM groups g JOIN output_profiles op ON op.id = g.output_profile_id
         LEFT JOIN drm_configs dc ON dc.id = op.drm_config_id
        WHERE g.id = COALESCE((SELECT group_id FROM channels WHERE id = $1), (SELECT group_id FROM events WHERE id = $2))`,
      [a.channel_id, a.event_id]) : null;
    // Audio: the station's encoder settings, and what the clip extract was asked to make (MP3, M4A).
    const ch = a.channel_id ? await one<any>(`SELECT kind, radio_config FROM channels WHERE id = $1`, [a.channel_id]).catch(() => null) : null;
    const job = await one<any>(`SELECT payload->'formats' AS formats, state FROM jobs WHERE type = 'clip.extract' AND payload->>'vodAssetId' = $1 ORDER BY created_at DESC LIMIT 1`, [a.id]).catch(() => null);
    const streamId = a.channel_id ?? a.event_id;
    // A RECORDING-DERIVED ASSET IS READ ONCE, here, from the recording's own
    // init segments (services/media/mediaFacts.ts): for a package-only stream
    // that is the only record of the contributor's codec and audio, and for a
    // transcoded one it is the real profile and level. Asked lazily, when the
    // tab is first opened, so assets made before this existed get it too and
    // making a clip never waits on ffprobe. Kept once read: init segments do
    // not change. Not on this disk (the S3 origin) leaves it NULL and the tab
    // says it is not recorded.
    if (!a.media_facts && streamId && a.source_kind !== 'upload' && a.source_kind !== 'watchfolder'
        && Number.isFinite(Number(a.start_epoch_ms)) && Number(a.end_epoch_ms) > Number(a.start_epoch_ms)) {
      try {
        const { initFilesInRange } = await import('../services/localRecordingIndex');
        const { probeFiles } = await import('../services/media/mediaFacts');
        const inits = initFilesInRange(streamId, Number(a.start_epoch_ms), Number(a.end_epoch_ms));
        const facts = inits ? await probeFiles(inits.files, 'recording') : null;
        if (facts && inits) {
          facts.run = inits.run; facts.runs = inits.runs;
          await query(`UPDATE vod_assets SET media_facts = $2::jsonb WHERE id = $1 AND media_facts IS NULL`, [a.id, JSON.stringify(facts)]);
          a.media_facts = facts;
        }
      } catch (e) {
        console.error(`[vod.encode] ${a.id}: media facts not read:`, e);
      }
    }
    res.json(encodeDetails(a, { ladderGroup, outputProfile, radioConfig: ch?.radio_config ?? null,
      audioOnly: ch?.kind === 'radio' || (streamId ? await Promise.resolve(isAudioOnly(streamId)).catch(() => false) : false),
      extract: job ? { formats: Array.isArray(job.formats) ? job.formats : [], state: String(job.state) } : null }));
  })
);

/** Preview: the matching programme(s) and what they would fill. Nothing is written. */
vodRouter.get(
  '/:id/epg-fill',
  onlyIdParam,
  asyncHandler(async (req, res) => {
    const a = await fetchOwned(req.params.id, accountId(req));
    if (!a) throw notFound('VOD asset not found');
    const pid = typeof req.query.programmeId === 'string' && req.query.programmeId ? req.query.programmeId : null;
    res.json(await previewFill(a, accountId(req), pid));
  })
);

/**
 * Apply: the fields the operator ticked. A field that already holds a value
 * is changed only when it is named in `overwrite`. Audited with the programme id.
 */
vodRouter.post(
  '/:id/epg-fill',
  onlyIdParam,
  asyncHandler(async (req, res) => {
    const b = z.object({
      programmeId: z.string().uuid().optional(),
      fields: z.array(z.string()).max(100).optional(),
      overwrite: z.array(z.string()).max(100).default([]),
      applyType: z.boolean().default(false),
      title: z.boolean().default(false),
    }).parse(req.body ?? {});
    const a = await fetchOwned(req.params.id, accountId(req));
    if (!a) throw notFound('VOD asset not found');
    const r = await applyFill(a, accountId(req), actor(req), b);
    if (!r.programmeId) throw badRequest(r.reason ?? 'No programme to fill from.');
    res.json(r);
  })
);

async function fetchOwned(id: string, acct: string) {
  return one<any>(
    `SELECT v.*, ${usageStatusSql('v')} AS usage_status ${OWNED} WHERE v.id = $1 AND ${OWNER_ACCOUNT} = $2`, [id, acct]);
}

vodRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await fetchOwned(req.params.id, accountId(req));
    if (!row) throw notFound('VOD asset not found');
    let schema = null;
    if (row.schema_id) {
      schema = await one('SELECT id, name, fields FROM metadata_schemas WHERE id = $1', [
        row.schema_id,
      ]);
    }
    // The full publication row, not a summary: what was approved when it went
    // out, and whether the copy out there is still that one, are the two things
    // anyone asks about a published asset.
    const pubs = await query(
      `SELECT platform, external_url, views, published_at, status, stale,
              published_build_at, published_review_state, published_qc_state,
              published_by, published_duration_ms
         FROM publications WHERE vod_asset_id = $1
        ORDER BY published_at DESC NULLS LAST`, [req.params.id]);
    // WHAT KIND OF THING THIS IS, so the library can put up the right player.
    // The stream it was cut from knows (a radio station has no video
    // rendition); an uploaded file with no stream is judged by the files it
    // produced. Asked here, once, rather than guessed from a black rectangle.
    const streamId = row.channel_id ?? row.event_id;
    const audioOnly = streamId
      ? isAudioOnly(streamId)
      : !!(row.export_mp3_key || row.export_m4a_key) && !row.progressive_key;
    res.json({ ...row, audioOnly, schema, publications: pubs, jsonld: videoObjectFromAsset(row, pubs as any) });
  })
);

/**
 * HISTORY: one timeline for the asset's History tab. When and how it was made
 * (uploaded, cut from a recording, from an event), built or encoded, its image
 * and song details, review and QC, every place it was published, access
 * removed, and every change people made (the audit log), newest first.
 */
vodRouter.get(
  '/:id/history',
  asyncHandler(async (req, res) => {
    const acct = accountId(req);
    const row = await one<any>(`SELECT v.*, c.name AS channel_name, c.kind AS channel_kind, e.name AS event_name ${OWNED} WHERE v.id = $1 AND ${OWNER_ACCOUNT} = $2`, [req.params.id, acct]);
    if (!row) throw notFound('VOD asset not found');
    type Ev = { at: string; kind: string; title: string; detail?: string | null; by?: string | null; link?: string | null };
    const ev: Ev[] = [];
    const t = (v: any) => (v ? new Date(v).toISOString() : null);
    const clock = (ms: any) => (ms != null ? new Date(Number(ms)).toISOString().slice(11, 19) : null);
    // Made
    const how = row.source_kind === 'upload' ? `Uploaded${row.original_filename ? `: ${row.original_filename}` : ''}`
      : row.source_kind === 'watchfolder' ? `From a watch folder${row.original_filename ? `: ${row.original_filename}` : ''}`
      : row.event_id ? `Cut from the event ${row.event_name ?? ''}`.trim()
      : row.channel_id ? `Cut from a recording of ${row.channel_name ?? 'the channel'}` : 'Created';
    ev.push({ at: t(row.created_at)!, kind: 'created', title: how,
      detail: row.start_epoch_ms && row.channel_id ? `${new Date(Number(row.start_epoch_ms)).toISOString().slice(0, 10)}, ${clock(row.start_epoch_ms)} to ${clock(row.end_epoch_ms)} UTC` : null });
    if (row.built_at) ev.push({ at: t(row.built_at)!, kind: 'built', title: 'Built', detail: row.build_strategy ?? null });
    if (row.encode_result && (row.source_kind === 'upload' || row.source_kind === 'watchfolder')) {
      const kept = Array.isArray(row.encode_result?.kept) ? row.encode_result.kept.map((k: any) => `${k.height}p`).join(', ') : null;
      ev.push({ at: t(row.encode_result?.finishedAt ?? row.updated_at)!, kind: 'encoded', title: 'Encoded', detail: [kept, row.encode_result?.ladder?.name].filter(Boolean).join(' · ') || null });
    }
    if (row.music_lookup?.at) {
      const m = row.music_lookup;
      ev.push({ at: m.at, kind: 'song', title: m.state === 'hit' ? `Song details found (${m.provider ?? 'lookup'})` : m.state === 'error' ? 'Song lookup could not run' : 'Song looked up: no match',
        detail: m.state === 'hit' ? [m.album, m.released].filter(Boolean).join(' · ') || null : m.reason ?? null });
    }
    if (row.poster_picked_at && row.poster_source) ev.push({ at: t(row.poster_picked_at)!, kind: 'image', title: row.poster_locked ? 'Image chosen' : 'Image picked', detail: row.poster_reason ?? null });
    if (row.reviewed_at) ev.push({ at: t(row.reviewed_at)!, kind: 'review', title: `Review: ${row.review_state ?? 'reviewed'}`, by: row.reviewed_by ?? null });
    if (row.qc_at) ev.push({ at: t(row.qc_at)!, kind: 'qc', title: `QC: ${row.qc_state ?? 'run'}` });
    if (row.withdrawn_at) ev.push({ at: t(row.withdrawn_at)!, kind: 'withdrawn', title: 'Access removed', by: row.withdrawn_by ?? null });
    // Published
    const pubs = await query<any>(`SELECT platform, external_url, published_at, status, published_by FROM publications WHERE vod_asset_id = $1`, [row.id]);
    for (const p of pubs) if (p.published_at) ev.push({ at: t(p.published_at)!, kind: 'published', title: `Published to ${p.platform}`, detail: p.status ?? null, by: p.published_by ?? null, link: p.external_url ?? null });
    // People's changes
    const audits = await query<any>(
      `SELECT a.action, a.detail, a.created_at, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.entity_type = 'vod_asset' AND a.entity_id = $1 AND (a.account_id = $2 OR a.account_id IS NULL) ORDER BY a.created_at DESC LIMIT 200`, [row.id, acct]);
    const NAMES: Record<string, string> = { metadata: 'metadata', poster: 'the image', song_details: 'song details', title: 'title', schema_id: 'content type',
      availability_override: 'availability', published: 'publishing', review_state: 'review', clip_spec: 'the cut' };
    for (const a of audits) {
      if (a.action === 'create') continue;   // "Created" is above
      const keys = Object.keys(a.detail?.changes ?? {});
      const what = keys.map((k) => NAMES[k] ?? k.replace(/_/g, ' '));
      ev.push({ at: t(a.created_at)!, kind: a.action === 'delete' ? 'deleted' : 'edit',
        title: what.length ? `Changed ${what.slice(0, 3).join(', ')}${what.length > 3 ? ` and ${what.length - 3} more` : ''}` : 'Changed',
        by: a.email ?? (typeof a.detail?.actor === 'string' && !/^[0-9a-f-]{36}$/i.test(a.detail.actor) ? a.detail.actor : null) });
    }
    ev.sort((x, y) => (y.at < x.at ? -1 : y.at > x.at ? 1 : 0));
    res.json({ events: ev });
  })
);

/**
 * PROVENANCE — what this asset was actually built from.
 *
 * The chain outward: clip -> contiguous blocks of source media -> the runs and
 * segment ranges on disk -> the recordings and broadcast days they belonged to.
 * It reports what is STILL PRESENT as well as what was used, because a clip
 * whose sources have been pruned cannot be re-cut at a different length and the
 * operator should learn that here, not from a job that fails an hour later.
 */
vodRouter.get(
  '/:id/provenance',
  asyncHandler(async (req, res) => {
    const row = await fetchOwned(req.params.id, accountId(req));
    if (!row) throw notFound('VOD asset not found');
    const trace = await traceClip(req.params.id, originBaseFor);
    if (!trace) throw notFound('VOD asset not found');
    res.json({
      ...trace,
      // A chain with no rows is not the same as a chain that says "no sources":
      // assets built before provenance existed have nothing recorded, and saying
      // so is more useful than reporting zero blocks as though it were a fact.
      recorded: trace.blocks.length > 0,
      note: trace.blocks.length > 0 ? null
        : 'This asset was produced before its sources were recorded. Re-cut it to establish the chain.',
    });
  })
);


/**
 * THE REVIEW QUEUE — what is waiting for somebody.
 *
 * Deliberately not "all clips filtered by state": the queue is a place of work,
 * ordered oldest first, carrying the QC counts so a reviewer can see what needs
 * attention before opening anything.
 */
vodRouter.get(
  '/review/queue',
  asyncHandler(async (req, res) => {
    const rows = await reviewQueue(accountId(req));
    res.json({ queue: rows, count: rows.length });
  })
);

/** A clip's review history, its QC findings, and whether it may be published. */
vodRouter.get(
  '/:id/review',
  asyncHandler(async (req, res) => {
    const row = await fetchOwned(req.params.id, accountId(req));
    if (!row) throw notFound('VOD asset not found');
    res.json({
      assetId: row.id,
      state: row.review_state ?? 'draft',
      reviewedAt: row.reviewed_at,
      qc: { state: row.qc_state ?? null, at: row.qc_at ?? null, findings: await qcFindings(row.id) },
      history: await reviewHistory(row.id),
      gate: await publishGate(row.id),
    });
  })
);

/**
 * Move a clip through review.
 *
 * The reason is required for anything that is not an approval, because a
 * rejection with no reason is a rejection somebody has to come and ask about.
 */
vodRouter.post(
  '/:id/review',
  asyncHandler(async (req, res) => {
    const row = await fetchOwned(req.params.id, accountId(req));
    if (!row) throw notFound('VOD asset not found');
    const body = z.object({
      to: z.enum(['draft', 'in_review', 'changes_requested', 'approved', 'rejected']),
      note: z.string().max(2000).optional(),
    }).parse(req.body);

    if (body.to !== 'approved' && body.to !== 'in_review' && !body.note?.trim()) {
      throw badRequest(`Say why: a decision of "${body.to.replace('_', ' ')}" needs a note.`);
    }
    try {
      const updated = await decide({
        assetId: row.id, to: body.to,
        actorId: actorId(req),
        actorLabel: await actorLabel(req),
        note: body.note ?? null,
      });
      res.json({
        ...updated,
        history: await reviewHistory(row.id),
        gate: await publishGate(row.id),
      });
    } catch (e: any) {
      if (e instanceof IllegalReview) throw badRequest(e.message);
      throw e;
    }
  })
);

/** Run QC again, on the queue. Used after a re-cut, or when a check was added. */
vodRouter.post(
  '/:id/qc',
  asyncHandler(async (req, res) => {
    const row = await fetchOwned(req.params.id, accountId(req));
    if (!row) throw notFound('VOD asset not found');
    const job = await enqueue({
      type: QC_RUN,
      payload: { vodAssetId: row.id },
      channelId: row.channel_id, eventId: row.event_id,
      dedupeKey: `qc.run:${row.id}`,
      priority: 40,
    });
    res.status(202).json({ jobId: job.id, state: job.state });
  })
);

/**
 * QC EVERYTHING NOT YET CHECKED. Assets made before QC ran on every build (and
 * uploads, which were never QC'd) read "not checked" and are not offered to
 * FAST, loops or blocking until they are. One call queues them all.
 */
vodRouter.post(
  '/qc-unchecked',
  asyncHandler(async (req, res) => {
    const rows = await query<any>(
      `SELECT v.id, v.channel_id, v.event_id ${OWNED}
        WHERE ${OWNER_ACCOUNT} = $1 AND ${usageStatusSql('v')} IN ('unchecked', 'qc_failed', 'unplayable', 'no_media')
        LIMIT 500`, [accountId(req)]);
    for (const r of rows) {
      await enqueue({ type: QC_RUN, payload: { vodAssetId: r.id }, channelId: r.channel_id, eventId: r.event_id,
                      dedupeKey: `qc.run:${r.id}`, priority: 30 });
    }
    res.status(202).json({ queued: rows.length });
  })
);

/**
 * BUILD IT AGAIN, over the same range. For a clip whose build failed or never
 * ran. Refuses with the coverage when the recording cannot cover the range at
 * the tolerance asked for, so the console can offer "accept the gaps".
 * An uploaded file is rebuilt by retrying its encode job (/api/jobs/:id/retry).
 */
vodRouter.post(
  '/:id/rebuild',
  asyncHandler(async (req, res) => {
    const b = z.object({ acceptGapsMs: z.number().int().nonnegative().max(600_000).default(0) }).parse(req.body ?? {});
    const asset = await fetchOwned(req.params.id, accountId(req));
    if (!asset) throw notFound('VOD asset not found');
    if (asset.source_kind !== 'recording' || asset.kind !== 'clip') {
      throw badRequest('Only a clip cut from a recording can be rebuilt here. An uploaded file is rebuilt by retrying its encode.');
    }
    const streamId = asset.channel_id ?? asset.event_id;
    const fromMs = Number(asset.start_epoch_ms), toMs = Number(asset.end_epoch_ms);
    const kind = isAudioOnly(streamId) ? 'audio' : 'video';
    const resolution = resolveRange(streamId, fromMs, toMs, kind);
    const verdict = assessRange(resolution, { maxGapMs: b.acceptGapsMs });
    if (!verdict.ok) {
      res.status(409).json({
        error: verdict.message, code: verdict.code,
        coveragePct: resolution.coveragePct,
        gapMs: resolution.gaps.reduce((n, g) => n + g.ms, 0),
        gaps: resolution.gaps.length,
      });
      return;
    }
    // New media will be judged afresh.
    await query(`UPDATE vod_assets SET qc_state = NULL, qc_at = NULL, built_at = NULL, updated_at = now() WHERE id = $1`, [asset.id]);
    await query(`DELETE FROM qc_events WHERE vod_asset_id = $1`, [asset.id]);
    const job = await enqueueClipBuild({
      vodAssetId: asset.id, streamId, fromMs, toMs, outputKind: asset.output_kind,
      channelId: asset.channel_id, eventId: asset.event_id, acceptGapsMs: b.acceptGapsMs,
    });
    { const who = actor(req); await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label, action: 'update', entityType: 'vod_asset', entityId: asset.id, changes: { rebuild: { from: asset.media_state ?? null, to: { acceptGapsMs: b.acceptGapsMs, jobId: job.id } } } }).catch(() => {}); }
    res.status(202).json({ jobId: job.id, state: job.state, coveragePct: resolution.coveragePct });
  })
);

/** schema.org VideoObject (JSON-LD) — for the portal, SEO, and social metadata. */
vodRouter.get(
  '/:id/schema.org',
  asyncHandler(async (req, res) => {
    const row = await fetchOwned(req.params.id, accountId(req));
    if (!row) throw notFound('VOD asset not found');
    const pubs = await query('SELECT platform, external_url, views, published_at, status FROM publications WHERE vod_asset_id=$1', [req.params.id]);
    res.type('application/ld+json').json(videoObjectFromAsset(row, pubs as any));
  })
);

const updateSchema = z.object({
  title: z.string().min(1).optional(),
  published: z.boolean().optional(),
  schemaId: z.string().uuid().nullable().optional(),
  metadata: z.record(z.any()).optional(),
});

/**
 * Update a VOD asset. When metadata (or a schema change) is supplied, the values
 * are validated against the assigned schema before they are stored.
 */
vodRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const body = updateSchema.parse(req.body);
    const asset = await fetchOwned(req.params.id, accountId(req));
    if (!asset) throw notFound('VOD asset not found');

    // Resolve the schema in effect (new one if provided, else the current one).
    const schemaId = body.schemaId !== undefined ? body.schemaId : asset.schema_id;
    let cleanMeta: Record<string, any> | undefined;
    if (body.metadata !== undefined || body.schemaId !== undefined) {
      const values = body.metadata ?? asset.metadata ?? {};
      if (schemaId) {
        const schema = await one<{ fields: SchemaField[] }>(
          'SELECT fields FROM metadata_schemas WHERE id = $1 AND account_id = $2',
          [schemaId, accountId(req)]
        );
        if (!schema) throw badRequest('Assigned schema not found');
        // Image fields given as a web address go into the Image Library first,
        // in this asset's folder (services/media/libraryImages.ts).
        const { internaliseImages } = await import('../services/media/libraryImages');
        const { assetPlaceFolder } = await import('../services/media/assetImage');
        const folder = (await assetPlaceFolder(asset.id)) ?? 'media/assets';
        // CARRIED KEYS. The stored metadata can hold keys the type does not
        // define: provenance written by other paths (a song cut from a station
        // recording keeps the stream's ICY block: source, class, raw,
        // stream_url) or fields of the type it had before. The form sends them
        // back untouched, so a key already stored with the same value is kept
        // as it is; only a key this write adds or changes must be on the type.
        const stored = (asset.metadata ?? {}) as Record<string, any>;
        const known = new Set(schema.fields.map((f) => f.key));
        const carried: Record<string, any> = {};
        const checked: Record<string, any> = {};
        for (const [k, v] of Object.entries(values as Record<string, any>)) {
          if (!known.has(k) && k in stored && JSON.stringify(stored[k]) === JSON.stringify(v)) carried[k] = v;
          else checked[k] = v;
        }
        cleanMeta = { ...carried, ...validateMetadata(schema.fields, await internaliseImages(accountId(req), schema.fields, checked, folder)) };
      } else {
        // no schema assigned -> metadata must be empty (strict)
        if (Object.keys(values).length > 0)
          throw badRequest('Assign a metadata schema before setting metadata');
        cleanMeta = {};
      }
    }

    // THE PUBLISH GATE. Both blocking rules are per account and both default to
    // off, so this changes nothing for a deployment that has not asked for it.
    // Where it IS on, publishing over a QC finding is still allowed and is
    // recorded on the review trail: a check that blocks outright is a check
    // people learn to route around.
    if (body.published === true && !asset.published) {
      // THROUGH THE ONE DOOR. `published: true` used to flip a flag and mark
      // portal visibility; it now runs the asset's publishing plan (the
      // ladder), which creates the publications and the window as well.
      try { await publish(asset.id, await actorLabel(req)); }
      catch (e: any) { if (e instanceof NotPublishable) throw badRequest(e.message); throw e; }
      body.published = undefined;
    }
    if (body.published === false && asset.published) {
      await withdraw(asset.id, await actorLabel(req), 'unpublished from the library');
      body.published = undefined;
    }
    const row = await one(
      `UPDATE vod_assets SET
         title = COALESCE($3, title),
         published = COALESCE($4, published),
         schema_id = $5,
         metadata = COALESCE($6::jsonb, metadata),
         updated_at = now()
       WHERE id = $1
         AND EXISTS (SELECT 1 ${OWNED} WHERE v.id = $1 AND ${OWNER_ACCOUNT} = $2)
       RETURNING *`,
      [
        req.params.id,
        accountId(req),
        body.title ?? null,
        body.published ?? null,
        schemaId,
        cleanMeta !== undefined ? JSON.stringify(cleanMeta) : null,
      ]
    );
    if (!row) throw notFound('VOD asset not found');
    // RENAMED: the FAST guide's programmes for it (now and ahead, every repeat) follow.
    if (cleanMeta !== undefined || body.title != null) {
      const titleOf = (md: any, t: any) => String(md?.title || t || 'Untitled');   // as the FAST planner names it (store.ts assetFromRow)
      const before = titleOf(asset.metadata, asset.title), after = titleOf(row.metadata, row.title);
      if (before !== after) await (await import('../services/fast/store')).retitleProgrammes(row.id, before, after)
        .catch((e) => console.warn(`[vod] ${row.id}: guide titles not updated:`, e?.message ?? e));
    }
    // AN UPLOAD WAITING FOR METADATA is released by any save that fills it in,
    // not only by the ingest queue's Fill in (services/ingest/pipeline.ts).
    if (asset.ingest?.status === 'awaiting_metadata' && (cleanMeta !== undefined || body.title != null)) {
      await (await import('../services/ingest/pipeline')).completeMetadata(accountId(req), row.id, {})
        .then(() => one<any>(`SELECT ingest, awaiting_metadata FROM vod_assets WHERE id = $1`, [row.id]))
        .then((r) => { if (r) Object.assign(row, r); })
        .catch((e) => console.warn(`[vod] ${row.id}: ingest hold not re-checked:`, e?.message ?? e));
    }
    // New metadata can change the asset's image (an image set by hand, a song's
    // artist or title): pick again unless a person chose the image.
    // A field changed by hand is no longer the EPG's value: drop its provenance.
    if (cleanMeta !== undefined || body.title != null) {
      await pruneProvenance(row.id, asset.metadata, cleanMeta ?? asset.metadata, asset.title, body.title ?? asset.title);
    }
    // AN IMAGE FIELD A PERSON CHANGED IS THEIR CHOICE, applied now, during the
    // save, even over an image chosen earlier: the main image, or the type it is
    // named after (poster, hero...). It used to be only queued, and skipped when
    // locked, so a newly chosen image did not replace the old one
    // (services/media/assetImageSet.ts applyImageFieldChanges).
    let imageNow = false;
    if (cleanMeta !== undefined) {
      try {
        const r = await (await import('../services/media/assetImageSet')).applyImageFieldChanges(row.id, accountId(req), asset.metadata ?? {}, cleanMeta ?? {}, (await actorLabel(req)) ?? 'someone');
        imageNow = r.primary;
        if (r.primary || r.slots.length) Object.assign(row, await one<any>(`SELECT poster_key, poster_source, poster_shape, poster_reason, poster_locked, poster_picked_at, updated_at FROM vod_assets WHERE id = $1`, [row.id]));
      } catch (e) { console.error(`[vod] ${row.id}: image fields not applied:`, e); }
    }
    // Other new metadata can still change the image (a song's artist or title): pick again unless a person chose it.
    if (cleanMeta !== undefined && !imageNow && !row.poster_locked) await (await import('../services/jobs/handlers/vodImage')).queueAssetImage(row.id);
    res.json(row);
  })
);

/**
 * Non-destructive RE-TRIM of a clip. Updates the clip's in/out (and its manifest
 * key + duration) and marks it for re-derivation — the full source recording is
 * untouched, so a clip can be re-edited any number of times. Only clips.
 */
/** The extractor's format list for an output kind. Mirrors the clip route. */
function outputFormats(outputKind: string, audio: boolean): OutputFormat[] {
  const formats: OutputFormat[] = [];
  if (outputKind !== 'progressive') formats.push('hls');
  if (outputKind !== 'manifest') formats.push('mp4');
  if (!formats.length) formats.push('mp4');
  if (audio) formats.push('mp3', 'm4a');
  return formats;
}

vodRouter.patch(
  '/:id/trim',
  asyncHandler(async (req, res) => {
    const b = z.object({
      startMs: z.number().int().nonnegative(),
      endMs: z.number().int().positive(),
      // Same escape hatch the clip route offers: a re-cut across an encoder
      // restart is a thing an editor legitimately asks for.
      acceptGapsMs: z.number().int().nonnegative().max(600_000).default(0),
    }).parse(req.body);
    if (b.endMs <= b.startMs) throw badRequest('endMs must be after startMs');
    const asset = await fetchOwned(req.params.id, accountId(req));
    if (!asset) throw notFound('VOD asset not found');
    if (asset.kind !== 'clip') throw badRequest('only clips can be re-trimmed');
    // REFUSE A RANGE THE MEDIA CANNOT COVER, before promising anything. The
    // same rule creation applies: a row naming files nobody can write is how
    // an operator finds out at playback time instead of now.
    const streamId = asset.channel_id ?? asset.event_id;
    const kind = isAudioOnly(streamId) ? 'audio' : 'video';
    const resolution = resolveRange(streamId, b.startMs, b.endMs, kind);
    const verdict = assessRange(resolution, { maxGapMs: b.acceptGapsMs });
    if (!verdict.ok) throw badRequest(verdict.message);

    // THE KEY IS REWRITTEN, NOT PATCHED. The old regexp_replace only matched a
    // key already shaped `clip-<a>-<b>`, so a clip built by compose-clip (whose
    // key is `vod/compose-<ts>/…`) silently kept pointing at the OLD media
    // while the row advertised the new range. Building the key from the range
    // is the same thing createClipVod does, and it cannot miss.
    const stem = `clip-${b.startMs}-${b.endMs}`;
    const row = await one<any>(
      `UPDATE vod_assets SET
         start_epoch_ms=$3::bigint, end_epoch_ms=$4::bigint, duration_ms=$4::bigint-$3::bigint,
         master_key = 'clips/' || id::text || '/' || $5::text || '/master.m3u8',
         progressive_key = CASE WHEN progressive_key IS NULL THEN NULL
                                ELSE 'clips/' || id::text || '/' || $5::text || '/clip.mp4' END,
         export_mp4_key = NULL,           -- stale export invalidated
         export_mp3_key = NULL, export_m4a_key = NULL,
         thumb_status='processing',       -- re-derive keyscreens
         -- A RE-CUT IS NEW MEDIA, SO IT IS UNREVIEWED MEDIA.
         -- These four columns were left alone, which meant an approved clip
         -- could be re-trimmed to a completely different range and still
         -- publish carrying its old approval and its old QC pass, stamped
         -- against footage nobody had looked at. services/review.ts says this
         -- in its own header as the thing that must not happen.
         review_state = 'draft'::review_state,
         reviewed_by = NULL, reviewed_at = NULL,
         qc_state = NULL, qc_at = NULL,
         built_at = NULL,
         updated_at = now()
       WHERE id=$1 AND EXISTS (SELECT 1 ${OWNED} WHERE v.id=$1 AND ${OWNER_ACCOUNT}=$2)
       RETURNING *`,
      [req.params.id, accountId(req), b.startMs, b.endMs, stem]
    );
    if (!row) throw notFound('VOD asset not found');

    // The QC findings belong to media that no longer exists.
    await query(`DELETE FROM qc_events WHERE vod_asset_id = $1`, [row.id]);

    // Anywhere this asset is already published is now serving an older cut
    // than the row describes. That is precisely what `stale` is for.
    await query(`UPDATE publications SET stale = true WHERE vod_asset_id = $1`, [row.id]);

    // AND ACTUALLY BUILD IT. This line used to be a comment saying the
    // extractor should be re-enqueued. Nothing was, so every re-trim left the
    // asset at thumb_status 'processing' forever, pointing at a manifest that
    // would never be written.
    // Through the shared helper, so the three callers that build a clip cannot
    // disagree about formats or dedupe key again.
    const job = await enqueueClipBuild({
      vodAssetId: row.id, streamId, fromMs: b.startMs, toMs: b.endMs,
      outputKind: row.output_kind,
      channelId: asset.channel_id, eventId: asset.event_id,
      acceptGapsMs: b.acceptGapsMs,
    });

    res.json({
      ...row,
      jobId: job.id,
      state: job.state,
      resolution: {
        coveragePct: resolution.coveragePct,
        gaps: resolution.gaps.length,
        segments: segmentCount(resolution),
      },
    });
  })
);

/**
 * AVAILABILITY. The asset's own rung of the ladder, the resolved plan (what a
 * publish would do and why), and the three actions: publish through the
 * plan (optionally to a subset of its targets for this one publish),
 * withdraw (remove access, keep the asset), republish.
 */
vodRouter.get('/:id/availability', asyncHandler(async (req, res) => {
  const asset = await fetchOwned(req.params.id, accountId(req));
  if (!asset) throw notFound('VOD asset not found');
  const plan = await resolveForAsset(accountId(req), asset);
  const pubs = await query(
    `SELECT p.id, p.platform, p.status, p.external_url, p.published_at, p.app_id, a.name AS app_name, t.name AS target_name
       FROM publications p LEFT JOIN apps a ON a.id = p.app_id LEFT JOIN publish_targets t ON t.id = p.target_id
      WHERE p.vod_asset_id = $1 ORDER BY p.created_at DESC`, [asset.id]);
  res.json({
    state: asset.availability_state ?? 'draft',
    availableFrom: asset.available_from, availableUntil: asset.available_until,
    withdrawnAt: asset.withdrawn_at, withdrawnBy: asset.withdrawn_by,
    applied: asset.availability ?? null, appliedSources: asset.availability_sources ?? null,
    override: asset.availability_override ?? {},
    plan, publications: pubs,
  });
}));

vodRouter.patch('/:id/availability', asyncHandler(async (req, res) => {
  const asset = await fetchOwned(req.params.id, accountId(req));
  if (!asset) throw notFound('VOD asset not found');
  // The asset's rung: replace it wholesale (an empty object = back to the ladder).
  const override = await cleanSettings(accountId(req), req.body?.override ?? req.body ?? {});
  await query(`UPDATE vod_assets SET availability_override = $2::jsonb, updated_at = now() WHERE id = $1`, [asset.id, JSON.stringify(override)]);
  // A published asset re-applies its plan so the change takes effect now.
  let outcome: any = null;
  if (['available', 'scheduled'].includes(asset.availability_state)) {
    try { outcome = await publish(asset.id, await actorLabel(req)); }
    catch (e: any) { if (e instanceof NotPublishable) throw badRequest(e.message); throw e; }
    await query(`DELETE FROM publications WHERE vod_asset_id = $1 AND status = 'published' AND id <> ALL($2::uuid[])`,
      [asset.id, outcome.publications.map((p: any) => p.id)]).catch(() => {});
  }
  const who = actor(req);
  await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
    action: 'update', entityType: 'vod_asset', entityId: asset.id,
    changes: { availability_override: { from: asset.availability_override ?? {}, to: override } } }).catch(() => {});
  res.json({ override, reapplied: !!outcome, state: outcome?.state ?? asset.availability_state });
}));

vodRouter.post('/:id/publish', asyncHandler(async (req, res) => {
  const asset = await fetchOwned(req.params.id, accountId(req));
  if (!asset) throw notFound('VOD asset not found');
  const b = z.object({ targets: z.array(z.any()).optional() }).parse(req.body ?? {});
  const targets = b.targets ? (await cleanSettings(accountId(req), { targets: b.targets })).targets : undefined;
  try {
    const out = ['withdrawn', 'expired'].includes(asset.availability_state)
      ? await republish(asset.id, await actorLabel(req))
      : await publish(asset.id, await actorLabel(req), { targets });
    res.status(201).json({ state: out.state, asset: out.asset, publications: out.publications, sources: out.plan.sources });
  } catch (e: any) {
    if (e instanceof NotPublishable) return res.status(409).json({ error: e.message, code: e.code });
    throw e;
  }
}));

// ---------------------------------------------------------------- skip markers
// Intro, recap and credits (services/vodMarkers.ts). Any change reaches the
// on-demand playlists on the next fetch: they are annotated when served.
const markerKind = z.enum(['intro', 'recap', 'credits']);

vodRouter.get('/:id/markers', asyncHandler(async (req, res) => {
  const asset = await fetchOwned(req.params.id, accountId(req));
  if (!asset) throw notFound('VOD asset not found');
  const { listMarkers } = await import('../services/vodMarkers');
  const job = await one<any>(
    `SELECT state, progress_note FROM jobs WHERE type = 'vod.markers' AND payload->>'vodAssetId' = $1 ORDER BY created_at DESC LIMIT 1`,
    [asset.id]).catch(() => null);
  res.json({
    markers: await listMarkers(asset.id),
    durationMs: Number(asset.duration_ms) || 0,
    detection: {
      group: asset.marker_group ?? null, at: asset.markers_detected_at ?? null, note: asset.markers_note ?? null,
      running: !!job && ['queued', 'running'].includes(String(job.state)),
    },
  });
}));

vodRouter.put('/:id/markers/:kind', asyncHandler(async (req, res) => {
  const asset = await fetchOwned(req.params.id, accountId(req));
  if (!asset) throw notFound('VOD asset not found');
  const kind = markerKind.parse(req.params.kind);
  const b = z.object({ startMs: z.number().int().min(0), endMs: z.number().int().positive() }).parse(req.body ?? {});
  const { setMarker } = await import('../services/vodMarkers');
  try {
    const m = await setMarker(asset.id, kind, b.startMs, b.endMs, actorId(req));
    { const who = actor(req); await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label, action: 'update', entityType: 'vod_asset', entityId: asset.id, changes: { [`marker_${kind}`]: { from: null, to: { startMs: m.startMs, endMs: m.endMs } } } }).catch(() => {}); }
    res.json(m);
  } catch (e: any) {
    if (e?.status === 400) throw badRequest(e.message);
    throw e;
  }
}));

vodRouter.post('/:id/markers/:kind/accept', asyncHandler(async (req, res) => {
  const asset = await fetchOwned(req.params.id, accountId(req));
  if (!asset) throw notFound('VOD asset not found');
  const kind = markerKind.parse(req.params.kind);
  const { acceptMarker } = await import('../services/vodMarkers');
  const m = await acceptMarker(asset.id, kind, actorId(req));
  if (!m) throw notFound('no such marker');
  { const who = actor(req); await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label, action: 'update', entityType: 'vod_asset', entityId: asset.id, changes: { [`marker_${kind}`]: { from: 'suggested', to: 'active' } } }).catch(() => {}); }
  res.json(m);
}));

vodRouter.delete('/:id/markers/:kind', asyncHandler(async (req, res) => {
  const asset = await fetchOwned(req.params.id, accountId(req));
  if (!asset) throw notFound('VOD asset not found');
  const kind = markerKind.parse(req.params.kind);
  const { deleteMarker } = await import('../services/vodMarkers');
  const gone = await deleteMarker(asset.id, kind);
  if (gone) { const who = actor(req); await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label, action: 'update', entityType: 'vod_asset', entityId: asset.id, changes: { [`marker_${kind}`]: { from: 'set', to: null } } }).catch(() => {}); }
  res.status(gone ? 204 : 404).end();
}));

vodRouter.post('/:id/markers/detect', asyncHandler(async (req, res) => {
  const asset = await fetchOwned(req.params.id, accountId(req));
  if (!asset) throw notFound('VOD asset not found');
  const { queueMarkerDetection } = await import('../services/jobs/handlers/vodMarkers');
  await queueMarkerDetection(asset.id, { channelId: asset.channel_id, eventId: asset.event_id });
  res.status(202).json({ queued: true });
}));

vodRouter.post('/:id/withdraw', asyncHandler(async (req, res) => {
  const asset = await fetchOwned(req.params.id, accountId(req));
  if (!asset) throw notFound('VOD asset not found');
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
  const row = await withdraw(asset.id, await actorLabel(req), reason);
  const who = actor(req);
  await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
    action: 'update', entityType: 'vod_asset', entityId: asset.id,
    changes: { availability_state: { from: asset.availability_state, to: 'withdrawn' } }, snapshot: { reason } }).catch(() => {});
  res.json(row);
}));

// WHAT A DELETE WOULD TAKE, shown by the console's delete dialog before anything goes (the
// same workflow as removing a channel or station: DeleteChannelDialog). `blocker` says why
// it would be refused now; the delete checks it again.
async function assetDeleteImpact(id: string, acc: string) {
  const a = await fetchOwned(id, acc);
  if (!a) throw notFound('VOD asset not found');
  const n = await one<any>(
    `SELECT (SELECT count(*)::int FROM vod_markers WHERE vod_asset_id = $1) AS markers,
            (SELECT count(*)::int FROM vod_formats WHERE vod_asset_id = $1) AS formats,
            (SELECT count(*)::int FROM asset_reviews WHERE vod_asset_id = $1) AS reviews,
            (SELECT count(*)::int FROM publications WHERE vod_asset_id = $1 AND platform IN ('portal','app') AND status <> 'removed') AS publishing_points,
            (SELECT count(*)::int FROM publications WHERE vod_asset_id = $1 AND platform NOT IN ('portal','app') AND status = 'published') AS social_posts`, [a.id]);
  // Airing in a FAST channel's active lineup: the playout would hit a missing asset.
  const fast = await query<{ name: string }>(
    `SELECT c.name FROM fast_lineups l JOIN channels c ON c.id = l.channel_id
      WHERE l.status = 'active' AND l.slots::text LIKE '%' || $1 || '%' ORDER BY c.name`, [a.id]).catch(() => [] as { name: string }[]);
  const names = fast.map((f) => f.name);
  const blocker = names.length
    ? `It is in the active lineup of FAST ${names.length === 1 ? 'channel' : 'channels'} ${names.join(', ')}. Take it out of the lineup first.`
    : null;
  const { TRASH_DAYS } = await import('../services/media/trash');
  return {
    id: a.id, name: (a.title as string | null)?.trim() || 'Untitled', availability: a.availability_state ?? null,
    binDays: TRASH_DAYS, blocker, fastChannels: names, counts: n,
  };
}

vodRouter.get('/:id/delete-impact', asyncHandler(async (req, res) => {
  res.json(await assetDeleteImpact(req.params.id, accountId(req)));
}));

vodRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    // INTO THE RESTORE BIN, not gone: the row and what cascades from it, its encode output
    // and an uploaded source move to the bin for VOLT_TRASH_DAYS (services/vodRemove.ts).
    // This also covers uploaded assets, which the old join-on-group delete never found
    // (a failed sintel_4k.mov could not be deleted at all).
    const own = await fetchOwned(req.params.id, accountId(req));
    if (!own) throw notFound('VOD asset not found');
    const { blocker } = await assetDeleteImpact(own.id, accountId(req));
    if (blocker) throw badRequest(blocker);
    const who = actor(req);
    const { removeVodAsset } = await import('../services/vodRemove');
    const binId = await removeVodAsset(own.id, { reason: `deleted from the Media Library by ${who.label}`, by: who.label });
    await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label, action: 'delete', entityType: 'vod_asset', entityId: own.id,
      snapshot: { title: own.title, source: own.source_kind, bin: binId } }).catch(() => {});
    // Say where it went, so the console can offer Undo (POST /api/vod/:id/restore) and
    // name how long it can wait.
    const { TRASH_DAYS } = await import('../services/media/trash');
    const held = binId ? await one<{ purge_after: string }>(`SELECT purge_after FROM trash_items WHERE id = $1`, [binId]) : null;
    res.json({ id: own.id, bin: binId, binDays: TRASH_DAYS, purgeAfter: held?.purge_after ?? null });
  })
);

// UNDELETE: put a deleted asset back from the restore bin, with the same permission as the
// delete (vod: manage). The bin's own restore (POST /api/storage/bin/:id/restore) needs the
// storage permission, which an editor who deleted by mistake may not have. Restores the
// asset's latest held bin item; 404 once the bin has purged it.
vodRouter.post(
  '/:id/restore',
  asyncHandler(async (req, res) => {
    const item = await one<{ id: string; label: string; purge_after: string }>(
      `SELECT id, label, purge_after FROM trash_items
        WHERE kind = 'vod_asset' AND subject_id = $1 AND account_id = $2 AND state = 'held'
        ORDER BY created_at DESC LIMIT 1`, [req.params.id, accountId(req)]);
    if (!item) throw notFound('This asset is not in the restore bin (it was never deleted, is already back, or has been purged)');
    const who = actor(req);
    const { restoreItem } = await import('../services/media/trash');
    const r = await restoreItem(item.id, { accountId: accountId(req), by: who.label });
    await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label, action: 'update', entityType: 'vod_asset', entityId: req.params.id,
      changes: { restored: { from: false, to: true } }, snapshot: { title: item.label, bin: item.id } }).catch(() => {});
    res.json({ id: req.params.id, title: item.label, bin: item.id, files: r.files, rows: r.rows });
  })
);
