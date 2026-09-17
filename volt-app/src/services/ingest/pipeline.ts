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
      LIMIT 50`,
    [accountId, sha256, name, sanitised, bytes]);
  return rows.map((r: any) => ({ id: r.id, name: r.source_key ? r.source_key.split('/').pop() : r.title, originalName: r.original_filename ?? r.title, bytes: r.source_bytes != null ? Number(r.source_bytes) : null, sha256: r.sha256 }));
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
  item?: IngestSettings | null;
}

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
  const first = resolveIngest(applicable(all, f.contentTypeId ?? null, f.source), facts, item);
  // A type rule may have picked the type, which may bring its own type-rung rules.
  const resolved = first.settings.contentTypeId && first.settings.contentTypeId !== f.contentTypeId
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
    account: f.accountId, assetId: f.assetId, kind: extracted.type.kind, contentTypeId: s.contentTypeId, title: merged.metadata.name ?? merged.metadata.title ?? f.originalName,
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
  const a = await one<any>(`SELECT id, account_id, source_key, ladder_group_id FROM vod_assets WHERE id = $1`, [assetId]);
  if (!a?.source_key) return null;
  const { enqueue } = await import('../jobs/queue');
  const { VOD_ENCODE } = await import('../jobs/handlers/vodEncode');
  const job = await enqueue({ type: VOD_ENCODE, payload: { vodAssetId: a.id, accountId: a.account_id, sourcePath: a.source_key, ladderGroupId: a.ladder_group_id ?? null }, dedupeKey: `vod.encode:${a.id}`, maxAttempts: 2 });
  await query(`UPDATE vod_assets SET encode_job_id = $2 WHERE id = $1`, [a.id, job.id]);
  return job.id;
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
