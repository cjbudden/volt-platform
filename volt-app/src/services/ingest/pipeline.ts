// ============================================================================
//  THE INGEST PIPELINE, database-backed: classify, name, verify, merge, emit.
//
//  ingest-core (naming, rules, duplicates, metadata, payload) is pure. This is
//  the thin layer that loads an account's rules, runs the pure parts over a
//  file that has landed, and writes the outcome: the object's final key, the
//  asset's metadata, the sidecar, the webhooks. Called by the upload finish
//  today and by the watchfolder and remote-source workers next.
// ============================================================================
import { renameSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { query, one } from '../../db';
import { resolveEffectiveFields } from '../../modules/metadataSchemas';
import { resolveIngest, kindOf, type IngestRule, type FileFacts, type IngestSettings, type Resolved } from './rules';
import { applyNaming, type NamingResult } from './naming';
import { findMatch, decideDuplicate, type Decision } from './duplicates';
import { extract, candidates, mergeMetadata, missingRequired, type Extracted } from './metadata';
import { typeForIngest, ingestFill, afterIngest, loadSettings, type Reading } from './filenameApply';
import { buildPayload, sidecarKey, toXml, signWebhook, type IngestPayload } from './payload';
import { config } from '../../config';
import { S3Destination, type Destination } from './destinations';
import { realS3 } from './s3';

let s3dest: Destination | null = null;
/** The configured object destination, or null when objects stay local. Injectable for tests. */
export async function objectDestination(): Promise<Destination | null> {
  if (config.ingest.destination !== 's3') return null;
  if (!s3dest) s3dest = new S3Destination(await realS3({ region: config.aws.region, accelerate: config.ingest.s3Accelerate, endpoint: config.ingest.s3Endpoint }),
                                          { bucket: config.ingest.s3Bucket, prefix: config.ingest.s3Prefix });
  return s3dest;
}
export function setObjectDestination(d: Destination | null) { s3dest = d; }

export async function loadRules(accountId: string): Promise<(IngestRule & { metadataDefaults: Record<string, any> })[]> {
  const rows = await query<any>(
    `SELECT id, rung, scope_id, ordinal, name, enabled, "when", "then", metadata_defaults
       FROM ingest_rules WHERE account_id = $1 ORDER BY rung, ordinal`, [accountId]);
  return rows.map((r: any) => ({
    id: r.id, rung: r.rung, scopeId: r.scope_id, ordinal: r.ordinal, name: r.name, enabled: r.enabled,
    when: r.when ?? null, then: r.then ?? {}, metadataDefaults: r.metadata_defaults ?? {},
  }));
}

/** Rules that apply to this file: the account rung, the type rung for its type, the source rung for its source. */
function applicable(all: IngestRule[], contentTypeId: string | null | undefined, source: string | null | undefined): IngestRule[] {
  return all.filter((r) =>
    r.rung === 'account' ||
    (r.rung === 'type' && (!r.scopeId || r.scopeId === contentTypeId)) ||
    (r.rung === 'source' && (!r.scopeId || r.scopeId === source)));
}

/** Pick-time resolution for the panel and the API: what would happen to this file. */
export async function preview(accountId: string, facts: FileFacts, source: string, contentTypeId: string | null, item?: IngestSettings | null) {
  const all = await loadRules(accountId);
  const resolved = resolveIngest(applicable(all, contentTypeId ?? item?.contentTypeId ?? null, source), { ...facts, kind: facts.kind ?? kindOf(facts.mime, facts.name) }, item);
  const naming = applyNaming(resolved.settings, { originalName: facts.name, relativePath: facts.relativePath, accountId, kind: facts.kind ?? kindOf(facts.mime, facts.name) });
  const existing = resolved.settings.nameCheck ? await libraryCandidates(accountId, facts.name, naming.sanitised.name, facts.bytes ?? null, null) : [];
  const match = findMatch({ name: facts.name, sanitisedName: naming.sanitised.name, bytes: facts.bytes ?? null }, existing);
  const duplicate = decideDuplicate(resolved.settings.duplicate, match, naming.filename);
  return { resolved, naming, duplicate };
}

async function libraryCandidates(accountId: string, name: string, sanitised: string, bytes: number | null, sha256: string | null) {
  const rows = await query<any>(
    `SELECT id, title, original_filename, source_bytes, sha256, source_key
       FROM vod_assets
      WHERE account_id = $1 AND (
            ($2::text IS NOT NULL AND sha256 = $2)
         OR lower(original_filename) IN (lower($3), lower($4))
         OR lower(title) IN (lower($3), lower($4))
         OR ($5::bigint IS NOT NULL AND source_bytes = $5))
        -- An asset whose encode FAILED and that has nothing playable is not a copy
        -- already in the library: uploading the file again is how people retry, so it
        -- must not be held as a duplicate of the failure (sintel_4k.mov, 25 Oct 2026).
        AND NOT (master_key IS NULL AND EXISTS (SELECT 1 FROM jobs j WHERE j.id = vod_assets.encode_job_id AND j.state = 'failed'))
      LIMIT 50`,
    [accountId, sha256, name, sanitised, bytes]);
  return rows.map((r: any) => ({ id: r.id, name: r.source_key ? r.source_key.split('/').pop() : r.title, originalName: r.original_filename ?? r.title, bytes: r.source_bytes != null ? Number(r.source_bytes) : null, sha256: r.sha256 }));
}

/** A library record whose encode FAILED and that has nothing playable, matching a file by
 *  name or size (or content, when the hash is known). The upload panel asks what to do
 *  with one before the file moves: make the new file its source, replace it, or keep both. */
export interface FailedMatch { assetId: string; title: string; originalName: string | null; bytes: number | null; createdAt: string;
  error: string | null; metadataFields: number; sameSize: boolean; sameName: boolean }
export async function failedMatches(accountId: string, name: string, bytes: number | null, sha256: string | null = null): Promise<FailedMatch[]> {
  const rows = await query<any>(
    `SELECT v.id, v.title, v.original_filename, v.source_bytes, v.created_at, v.metadata, j.last_error
       FROM vod_assets v JOIN jobs j ON j.id = v.encode_job_id
      WHERE v.account_id = $1 AND v.master_key IS NULL AND j.state = 'failed'
        AND (($2::text IS NOT NULL AND v.sha256 = $2)
          OR lower(v.original_filename) = lower($3) OR lower(v.title) = lower($3)
          OR ($4::bigint IS NOT NULL AND v.source_bytes = $4))
      ORDER BY v.created_at DESC LIMIT 5`,
    [accountId, sha256, name, bytes]);
  return rows.map((r: any) => ({
    assetId: r.id, title: r.title, originalName: r.original_filename ?? null, bytes: r.source_bytes != null ? Number(r.source_bytes) : null,
    createdAt: r.created_at, error: r.last_error ?? null,
    metadataFields: Object.values(r.metadata ?? {}).filter((v) => v != null && v !== '').length,
    sameSize: bytes != null && r.source_bytes != null && Number(r.source_bytes) === bytes,
    sameName: [r.original_filename, r.title].some((n) => n && String(n).toLowerCase() === name.toLowerCase()),
  }));
}

export interface LandedFile {
  accountId: string;
  assetId: string;           // vod_assets id already created for the upload
  path: string;              // where the assembled file is now
  originalName: string;
  relativePath?: string | null;
  bytes: number;
  sha256: string;
  declaredMime?: string | null;
  source: string;            // 'panel' | 'api' | watchfolder id | provider key
  sessionId?: string | null;
  uploadedBy?: string | null;
  contentTypeId?: string | null;
  operatorMetadata?: Record<string, any> | null;
  /** The name the upload was opened with (`POST /api/uploads` name). It titles the
   *  asset when it is a real title, see givenTitle(). */
  givenName?: string | null;
  item?: IngestSettings | null;
}

/**
 * The upload's own name, when it is a title someone chose. The console opens an
 * upload with the file's name minus its extension, which says nothing the file
 * name does not, so that one is ignored and the title read from the file name
 * still applies. A name that differs from the file name was typed on purpose
 * (an API caller naming "Evening news" for evening-news.mp4) and must not be
 * replaced by a guess from the file name (build queue 1.14-G6a).
 */
export function givenTitle(given: string | null | undefined, originalName: string): string | null {
  const g = typeof given === 'string' ? given.trim() : '';
  if (!g) return null;
  const file = (originalName ?? '').trim();
  const stem = file.replace(/\.[^./]+$/, '');
  return g === file || g === stem ? null : g;
}

/** A non-empty string, trimmed, or null. */
const textOf = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v.trim() : null;

export interface IngestOutcome {
  resolved: Resolved;
  naming: NamingResult;
  duplicate: Decision;
  extracted: Extracted;
  metadata: Record<string, any>;
  missing: string[];
  path: string;              // final path of the object
  payload: IngestPayload;
  status: 'ingested' | 'awaiting_metadata' | 'duplicate' | 'rejected';
}

/**
 * Run the whole thing for a file that has landed. Never throws for a rule
 * outcome (duplicate, reject, gate): those are statuses. Throws only when the
 * file itself cannot be read.
 */
export async function ingestLanded(f: LandedFile): Promise<IngestOutcome> {
  const all = await loadRules(f.accountId);
  const extracted = await extract(f.path, { originalName: f.originalName, bytes: f.bytes, sha256: f.sha256, sourcePath: f.relativePath ?? null }, f.declaredMime);
  const facts: FileFacts = {
    name: f.originalName, relativePath: f.relativePath, bytes: f.bytes, mime: extracted.type.mime, kind: extracted.type.kind,
    durationSec: extracted.probe?.durationSec ?? null, height: extracted.probe?.video?.height ?? null, hasTags: !!(extracted.id3 && Object.keys(extracted.id3).length > 1),
  };
  const item: IngestSettings = { ...(f.item ?? {}), ...(f.contentTypeId ? { contentTypeId: f.contentTypeId } : {}) };
  let first = resolveIngest(applicable(all, f.contentTypeId ?? null, f.source), facts, item);
  // THE FILE NAME (filenameApply.ts) may choose the type, but only when the
  // operator chose none and no rule named one, and only when it is confident and
  // uncontested. Its reading is kept either way, for the fields, title and links.
  // Only library media: a slate, a loop or a plain file keeps its name as it is.
  const fnMode = (first.settings.targetKind ?? 'vod') === 'vod' ? first.settings.filenameMetadata ?? 'auto' : 'off';
  let reading: Reading | null = null;
  let typeChosenBy: 'filename' | 'rule' | 'operator' | 'baseline' = f.contentTypeId ? 'operator' : first.sources.contentTypeId !== 'baseline' ? 'rule' : 'baseline';
  try {
    const t = await typeForIngest(f.accountId, f.originalName, fnMode);
    reading = t.reading;
    if (t.typeId && typeChosenBy === 'baseline') {
      item.contentTypeId = t.typeId;
      first = resolveIngest(applicable(all, t.typeId, f.source), facts, item);
      typeChosenBy = 'filename';
    }
  } catch (e) { console.warn('[ingest] reading the file name failed', e); }
  // A type rule may have picked the type, which may bring its own type-rung rules.
  const resolved = first.settings.contentTypeId && first.settings.contentTypeId !== item.contentTypeId
    ? resolveIngest(applicable(all, first.settings.contentTypeId, f.source), facts, item) : first;
  const s = resolved.settings;

  const naming = applyNaming(s, { originalName: f.originalName, relativePath: f.relativePath, accountId: f.accountId, kind: extracted.type.kind, contentTypeKey: null });

  // Content-level duplicate check on the real hash.
  const existing = await libraryCandidates(f.accountId, f.originalName, naming.sanitised.name, f.bytes, f.sha256);
  const match = findMatch({ name: f.originalName, sanitisedName: naming.sanitised.name, bytes: f.bytes, sha256: f.sha256 }, existing.filter((e: any) => e.id !== f.assetId));
  const duplicate = decideDuplicate(s.duplicate, match, naming.filename);

  // Metadata for the type, if there is one.
  let fields: any[] = [];
  if (s.contentTypeId) {
    const r = await resolveEffectiveFields(s.contentTypeId, f.accountId).catch(() => null);
    fields = r?.fields ?? [];
  }
  const ruleDefaults = Object.assign({}, ...resolved.matched.map((m) => (all.find((r) => r.id === m.ruleId) as any)?.metadataDefaults ?? {}));
  const merged = mergeMetadata(fields, candidates(extracted), ruleDefaults, f.operatorMetadata);
  // The file name fills what embedded tags, the operator and the rules left empty.
  let fnProvenance: Record<string, any> = {};
  let fnTitle: string | null = null;
  if (reading && fnMode !== 'off') {
    const settings = await loadSettings(f.accountId).catch(() => null);
    if (settings) {
      const typeKey = s.contentTypeId ? (await one<any>(`SELECT COALESCE(ms.standard_key, p.standard_key) AS k FROM metadata_schemas ms LEFT JOIN metadata_schemas p ON p.id = ms.extends_id WHERE ms.id = $1`, [s.contentTypeId]).catch(() => null))?.k ?? null : null;
      const fill = ingestFill(reading, typeKey, fields, merged as any, settings);
      Object.assign(merged.metadata, fill.values);
      fnProvenance = fill.provenance;
      const { titleFor } = await import('./filenameApply');
      fnTitle = titleFor(reading.parse, typeKey, settings.episodeTemplate);
    }
  }
  const missing = s.metadataRequired === 'none' ? [] : missingRequired(fields, merged.metadata);

  // Final resting place: keep the file where a re-encode finds it, under the
  // rule's key relative to the vod-src root, and record the key on the asset.
  let finalPath = f.path;
  let status: IngestOutcome['status'] = 'ingested';
  if (s.reject) status = 'rejected';
  else if (duplicate.outcome === 'skip' || duplicate.outcome === 'ask') status = 'duplicate';
  else if (missing.length) status = 'awaiting_metadata';

  if (status !== 'rejected' && duplicate.outcome !== 'skip') {
    const root = dirname(f.path);
    const key = duplicate.outcome === 'version' || duplicate.outcome === 'rename' ? (naming.dir ? `${naming.dir}/${duplicate.name}` : duplicate.name) : naming.key;
    const target = join(root, key);
    if (target !== f.path) {
      mkdirSync(dirname(target), { recursive: true });
      renameSync(f.path, target);
      finalPath = target;
    }
    naming.key = key; naming.filename = key.split('/').pop()!;
  }

  // Object store: the local vod-src copy stays for the encoder; when S3 is
  // the destination the object and its sidecar go there too and the library
  // records the S3 uri as the object key.
  let store = 'local'; let objectUri: string | null = null;
  const dest = status === 'ingested' || status === 'awaiting_metadata' ? await objectDestination().catch(() => null) : null;
  if (dest) {
    try { const put = await dest.put(finalPath, `${f.accountId}/${naming.key}`, extracted.type.mime); objectUri = put.uri; store = dest.store; }
    catch (e) { console.warn('[ingest] destination put failed, object stays local', e); }
  }

  const payload = buildPayload({
    event: status === 'ingested' ? 'ingested' : status === 'awaiting_metadata' ? 'awaiting_metadata' : status === 'duplicate' ? 'duplicate' : 'quarantined',
    account: f.accountId, assetId: f.assetId, kind: extracted.type.kind, contentTypeId: s.contentTypeId,
    // Title, best first: the content type's title field; a name or title sent with the
    // upload even when no content type keeps it as a field (the merge drops fields a
    // type does not have, which used to drop these too); the upload's own name when it
    // is a chosen one; a title inside the file; the file name read as a title.
    title: merged.metadata.name ?? merged.metadata.title
      ?? textOf(f.operatorMetadata?.name) ?? textOf(f.operatorMetadata?.title)
      ?? givenTitle(f.givenName, f.originalName)
      ?? candidates(extracted).name ?? fnTitle ?? f.originalName,
    naming, store, bytes: f.bytes, sha256: f.sha256, source: f.source, sessionId: f.sessionId ?? null, uploadedBy: f.uploadedBy ?? null,
    resolved, duplicate, metadata: merged.metadata, metadataSources: merged.sources, extracted, unmapped: merged.unmapped,
  });

  await query(
    `UPDATE vod_assets
        SET original_filename = $2, original_path = $3, sha256 = $4, mime = $5, ingest = $6,
            metadata = $7, schema_id = COALESCE($8, schema_id), title = COALESCE($9, title),
            source_key = $10, awaiting_metadata = $11, updated_at = now()
      WHERE id = $1`,
    [f.assetId, f.originalName, f.relativePath ?? null, f.sha256, extracted.type.mime,
     JSON.stringify({ status, rules: payload.rules, naming: payload.naming, duplicate: payload.duplicate, type: extracted.type, probe: extracted.probe, id3: extracted.id3, metadataSources: merged.sources, unmapped: merged.unmapped, objectUri, store }),
     JSON.stringify(merged.metadata), s.contentTypeId, payload.asset.title, finalPath, missing.length ? missing : null]);

  if (status !== 'rejected' && duplicate.outcome !== 'skip' && s.sidecar !== 'none') {
    const text = s.sidecar === 'xml' ? toXml(payload) : JSON.stringify(payload, null, 2);
    try {
      const sc = join(dirname(finalPath), sidecarKey(finalPath.split('/').pop()!, s.sidecar));
      writeFileSync(sc, text);
      if (dest && objectUri) await dest.putText(`${f.accountId}/${sidecarKey(naming.key, s.sidecar)}`, text, s.sidecar === 'xml' ? 'application/xml' : 'application/json');
    } catch (e) { console.warn('[ingest] sidecar not written', e); }
  }
  void deliverWebhooks(f.accountId, payload, s.webhooks);

  // What the file name said, why, and the record a trailer promotes. Best effort:
  // a failure here leaves the asset ingested, with what was already written.
  if (status !== 'rejected' && duplicate.outcome !== 'skip') {
    const usedTitle = payload.asset.title === fnTitle && fnTitle && !merged.metadata.name && !merged.metadata.title;
    if (usedTitle) fnProvenance.title = { source: 'filename', file: f.originalName, at: new Date().toISOString() };
    try { await afterIngest(f.accountId, f.assetId, fnMode === 'off' ? null : reading, fnProvenance, typeChosenBy); }
    catch (e) { console.warn('[ingest] file-name follow-up failed', e); }
  }

  return { resolved, naming, duplicate, extracted, metadata: merged.metadata, missing, path: finalPath, payload, status };
}

/** POST the payload to every enabled webhook that wants this event. Best effort, recorded. */
export async function deliverWebhooks(accountId: string, payload: IngestPayload, only: string[] = []): Promise<void> {
  const rows = await query<any>(
    `SELECT id, url, secret, events FROM ingest_webhooks WHERE account_id = $1 AND enabled
        AND ($2::text[] = '{}' OR id::text = ANY($2))`, [accountId, only]);
  const body = JSON.stringify(payload);
  for (const w of rows) {
    if (Array.isArray(w.events) && w.events.length && !w.events.includes(payload.event)) continue;
    const sig = signWebhook(w.secret, body);
    try {
      const res = await fetch(w.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-volt-signature': sig.header, 'x-volt-event': payload.event }, body, signal: AbortSignal.timeout(15000) });
      await query(`UPDATE ingest_webhooks SET last_status = $2, last_at = now(), last_error = $3 WHERE id = $1`, [w.id, res.status, res.ok ? null : `HTTP ${res.status}`]);
    } catch (e: any) {
      await query(`UPDATE ingest_webhooks SET last_status = NULL, last_at = now(), last_error = $2 WHERE id = $1`, [w.id, String(e?.message ?? e).slice(0, 300)]);
    }
  }
}

// ---------------------------------------------------------------------------
//  Later decisions: the metadata gate lifting, and a duplicate being resolved.
// ---------------------------------------------------------------------------

/** Queue the encode for an asset whose ingest is now complete. Idempotent by dedupe key. */
export async function queueEncodeFor(assetId: string): Promise<string | null> {
  const a = await one<any>(`SELECT v.id, v.account_id, v.source_key, v.ladder_group_id, v.encode_job_id, j.state AS job_state
                              FROM vod_assets v LEFT JOIN jobs j ON j.id = v.encode_job_id WHERE v.id = $1`, [assetId]);
  if (!a?.source_key) return null;
  // Encoded (or encoding) already, because the metadata gate no longer holds the
  // media: filling the field later must not encode the same file twice.
  if (a.encode_job_id && ['queued', 'running', 'succeeded'].includes(String(a.job_state))) return a.encode_job_id;
  const { enqueue } = await import('../jobs/queue');
  const { VOD_ENCODE } = await import('../jobs/handlers/vodEncode');
  const job = await enqueue({ type: VOD_ENCODE, payload: { vodAssetId: a.id, accountId: a.account_id, sourcePath: a.source_key, ladderGroupId: a.ladder_group_id ?? null }, dedupeKey: `vod.encode:${a.id}`, maxAttempts: 2 });
  await query(`UPDATE vod_assets SET encode_job_id = $2 WHERE id = $1`, [a.id, job.id]);
  return job.id;
}

/**
 * Uploads that the metadata gate held BEFORE it stopped holding the media:
 * waiting for metadata, with a source, never encoded. Queued once at boot by
 * the scheduler leader (index.ts), so assets uploaded under the old rule play.
 */
export async function encodeHeldUploads(): Promise<number> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM vod_assets
      WHERE ingest->>'status' = 'awaiting_metadata' AND source_key IS NOT NULL AND encode_job_id IS NULL
        AND source_kind IN ('upload', 'watchfolder')
      ORDER BY created_at LIMIT 500`);
  let n = 0;
  for (const r of rows) { if (await queueEncodeFor(r.id).catch((e) => { console.warn('[ingest] held upload not queued', r.id, e?.message ?? e); return null; })) n++; }
  if (n) console.log(`[ingest] queued ${n} upload(s) that were waiting for metadata`);
  return n;
}

async function markIngested(assetId: string, extra: Record<string, any> = {}): Promise<void> {
  await query(`UPDATE vod_assets SET ingest = COALESCE(ingest, '{}'::jsonb) || $2::jsonb, awaiting_metadata = NULL, updated_at = now() WHERE id = $1`,
    [assetId, JSON.stringify({ status: 'ingested', ...extra })]);
}

/**
 * The operator (or an API caller) supplied metadata for an asset the gate is
 * holding. Validates against the type, and if nothing required is missing
 * any more, completes the ingest: status, encode, webhooks.
 */
export async function completeMetadata(accountId: string, assetId: string, values: Record<string, any>): Promise<{ missing: string[]; ingested: boolean }> {
  const a = await one<any>(`SELECT * FROM vod_assets WHERE id = $1 AND account_id = $2`, [assetId, accountId]);
  if (!a) throw Object.assign(new Error('asset not found'), { status: 404 });
  const { validateMetadata } = await import('../metadataValidator');
  let fields: any[] = [];
  if (a.schema_id) { const r = await resolveEffectiveFields(a.schema_id, accountId).catch(() => null); fields = r?.fields ?? []; }
  const merged = { ...(a.metadata ?? {}), ...values };
  const clean = validateMetadata(fields, merged, 'keep');
  const missing = missingRequired(fields, clean);
  const wasWaiting = a.ingest?.status === 'awaiting_metadata';
  await query(`UPDATE vod_assets SET metadata = $2, title = COALESCE($3, title), awaiting_metadata = $4, updated_at = now() WHERE id = $1`,
    [assetId, JSON.stringify(clean), clean.name ?? clean.title ?? null, missing.length ? missing : null]);
  if (!missing.length && wasWaiting) {
    await markIngested(assetId, { metadataCompletedAt: new Date().toISOString() });
    await queueEncodeFor(assetId).catch((e) => console.warn('[ingest] encode not queued', e));
    void notifyIngested(assetId);
    return { missing, ingested: true };
  }
  return { missing, ingested: false };
}

/** Resolve a held duplicate. */
export async function resolveDuplicate(accountId: string, assetId: string, action: 'skip' | 'version' | 'replace'): Promise<{ status: string }> {
  const a = await one<any>(`SELECT * FROM vod_assets WHERE id = $1 AND account_id = $2`, [assetId, accountId]);
  if (!a) throw Object.assign(new Error('asset not found'), { status: 404 });
  if (a.ingest?.status !== 'duplicate') throw Object.assign(new Error('this asset is not a held duplicate'), { status: 409 });
  if (action === 'skip') {
    try { if (a.source_key && !String(a.source_key).startsWith('s3://')) require('node:fs').rmSync(a.source_key, { force: true }); } catch { /* */ }
    await query(`DELETE FROM vod_assets WHERE id = $1`, [assetId]);
    return { status: 'skipped' };
  }
  const ofId = a.ingest?.duplicate?.ofAssetId ?? null;
  await markIngested(assetId, { duplicate: { ...(a.ingest?.duplicate ?? {}), outcome: action, resolvedAt: new Date().toISOString() } });
  if (action === 'replace' && ofId) {
    // The older asset stays for retention to sweep, but points at its successor.
    await query(`UPDATE vod_assets SET ingest = COALESCE(ingest, '{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1 AND account_id = $3`,
      [ofId, JSON.stringify({ replacedBy: assetId }), accountId]);
  }
  if (a.awaiting_metadata?.length) {
    await query(`UPDATE vod_assets SET ingest = COALESCE(ingest, '{}'::jsonb) || '{"status":"awaiting_metadata"}'::jsonb WHERE id = $1`, [assetId]);
    return { status: 'awaiting_metadata' };
  }
  await queueEncodeFor(assetId).catch((e) => console.warn('[ingest] encode not queued', e));
  void notifyIngested(assetId);
  return { status: 'ingested' };
}

/** Re-send the ingested payload for an asset from what the row recorded. */
async function notifyIngested(assetId: string): Promise<void> {
  const a = await one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [assetId]);
  if (!a) return;
  const payload: IngestPayload = {
    version: 1, event: 'ingested', at: new Date().toISOString(), account: a.account_id,
    asset: { id: a.id, kind: a.ingest?.type?.kind ?? 'other', contentType: { id: a.schema_id }, title: a.title },
    object: { key: a.ingest?.objectUri ?? a.source_key, bytes: Number(a.source_bytes ?? 0), sha256: a.sha256, mime: a.mime, container: a.ingest?.type?.container ?? '', store: a.ingest?.store ?? 'local' },
    origin: { source: 'panel', originalName: a.original_filename ?? a.title, originalPath: a.original_path },
    naming: a.ingest?.naming ?? { mode: 'guid', structure: 'flat', guid: '', renamed: false },
    rules: a.ingest?.rules ?? { matched: [], sources: {} as any, deferred: false },
    duplicate: a.ingest?.duplicate ?? null, metadata: a.metadata ?? {}, metadataSources: a.ingest?.metadataSources ?? {},
    extracted: { file: { originalName: a.original_filename ?? '', bytes: Number(a.source_bytes ?? 0), sha256: a.sha256 }, type: a.ingest?.type, probe: a.ingest?.probe ?? null, id3: a.ingest?.id3 ?? null, image: null },
    unmapped: a.ingest?.unmapped ?? {},
  };
  await deliverWebhooks(a.account_id, payload);
}
