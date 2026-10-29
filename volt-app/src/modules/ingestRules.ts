// ============================================================================
//  /api/ingest — the rules ladder, webhooks, and "what would happen to this
//  file" for the panel to ask before a byte moves.
// ============================================================================
import { Router } from 'express';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound } from '../util/http';
import { defineList, parseList, whereSql, pageSql, finishPage } from '../util/listQuery';
import { actor, writeAudit } from '../services/audit';
import { BASELINE, INGEST_KEYS } from '../services/ingest/rules';
import { preview, completeMetadata, resolveDuplicate, failedMatches } from '../services/ingest/pipeline';
import { sanitise, applyNaming } from '../services/ingest/naming';
import { INGEST_EVENTS } from '../services/ingest/events';
import { openSession } from '../services/uploads';
import { enqueue } from '../services/jobs/queue';
import { REMOTE_INGEST } from '../services/jobs/handlers/remoteIngest';
import { sourcesFor, type RemoteRef, type LocateHit } from '../services/ingest/sources';
import { providerAccounts, accessTokenFor, authorizeUrl, linkOAuth, OAUTH, type OAuthProvider } from '../services/ingest/providerAccounts';
import { actorId } from '../util/actor';
import { config } from '../config';
import { createHmac } from 'node:crypto';
import { createTransfer, applyTransferEvent } from '../services/ingest/transfers';

export const ingestRouter = Router();

/** Provider callbacks (Aspera hook, MASV / Signiant webhook, an S3 event relay, or a client finish) name the transfer by its id. */
export const ingestCallbacksRouter = Router();
ingestCallbacksRouter.post('/transfers/:id/events', asyncHandler(async (req, res) => {
  const out = await applyTransferEvent(req.params.id, req.body, req.headers as any);
  res.json(out);
}));

ingestRouter.use(requireAuth);

const when = z.object({
  extensions: z.array(z.string().min(1).max(10)).optional(),
  kinds: z.array(z.enum(['video', 'audio', 'image', 'other'])).optional(),
  mimePrefixes: z.array(z.string().min(1).max(60)).optional(),
  namePattern: z.object({ type: z.enum(['glob', 'regex']), pattern: z.string().min(1).max(200) }).optional(),
  pathPrefix: z.string().max(500).optional(),
  minBytes: z.number().nonnegative().optional(), maxBytes: z.number().positive().optional(),
  minDurationSec: z.number().nonnegative().optional(), maxDurationSec: z.number().positive().optional(),
  minHeight: z.number().int().positive().optional(),
  hasTags: z.boolean().optional(),
}).strict();

const then = z.object({
  contentTypeId: z.string().uuid().nullable().optional(),
  targetKind: z.string().max(40).nullable().optional(),
  naming: z.enum(['honour', 'guid', 'guid_prefixed', 'template']).optional(),
  structure: z.enum(['flat', 'honour', 'minimal', 'template']).optional(),
  nameTemplate: z.string().max(200).nullable().optional(),
  pathTemplate: z.string().max(300).nullable().optional(),
  lowercase: z.boolean().optional(),
  duplicate: z.enum(['skip', 'replace', 'version', 'rename', 'ask']).optional(),
  nameCheck: z.boolean().optional(),
  transfer: z.enum(['auto', 'local', 'cloud']).optional(),
  metadataRequired: z.enum(['none', 'before_ingest', 'before_upload']).optional(),
  autoUpload: z.boolean().optional(),
  sidecar: z.enum(['none', 'json', 'xml']).optional(),
  webhooks: z.array(z.string().uuid()).optional(),
  ladderGroupId: z.string().uuid().nullable().optional(),
  reject: z.string().max(300).nullable().optional(),
  // Read the file name for type, fields and links (services/ingest/filenameApply.ts).
  filenameMetadata: z.enum(['auto', 'suggest', 'off']).optional(),
}).strict();

const ruleBody = z.object({
  rung: z.enum(['account', 'type', 'source']),
  scopeId: z.string().max(120).nullable().optional(),
  ordinal: z.number().int().optional(),
  name: z.string().min(1).max(120),
  enabled: z.boolean().optional(),
  when: when.nullable().optional(),
  then: then.default({}),
  metadataDefaults: z.record(z.any()).optional(),
});

function row(r: any) {
  return { id: r.id, rung: r.rung, scopeId: r.scope_id, ordinal: r.ordinal, name: r.name, enabled: r.enabled,
           when: r.when, then: r.then, metadataDefaults: r.metadata_defaults, createdAt: r.created_at, updatedAt: r.updated_at };
}

/** The baseline and the keys, so the editor can show inheritance without guessing. */
ingestRouter.get('/baseline', asyncHandler(async (_req, res) => {
  res.json({ baseline: BASELINE, keys: INGEST_KEYS, events: INGEST_EVENTS });
}));

ingestRouter.get('/rules', asyncHandler(async (req, res) => {
  const rows = await query<any>(`SELECT * FROM ingest_rules WHERE account_id = $1 ORDER BY rung, scope_id NULLS FIRST, ordinal`, [accountId(req)]);
  res.json(rows.map(row));
}));

ingestRouter.post('/rules', asyncHandler(async (req, res) => {
  const b = ruleBody.parse(req.body);
  const r = await one<any>(
    `INSERT INTO ingest_rules (account_id, rung, scope_id, ordinal, name, enabled, "when", "then", metadata_defaults)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [accountId(req), b.rung, b.rung === 'account' ? null : (b.scopeId ?? null), b.ordinal ?? 0, b.name, b.enabled ?? true,
     b.when ? JSON.stringify(b.when) : null, JSON.stringify(b.then), JSON.stringify(b.metadataDefaults ?? {})]);
  const who = actor(req);
  await writeAudit(null, { accountId: accountId(req), userId: who.userId, label: who.label,
    action: 'create', entityType: 'ingest_rule', entityId: r.id, changes: { rule: { from: null, to: b } } }).catch(() => {});
  res.status(201).json(row(r));
}));

ingestRouter.patch('/rules/:id', asyncHandler(async (req, res) => {
  const b = ruleBody.partial().parse(req.body);
  const cur = await one<any>(`SELECT * FROM ingest_rules WHERE id = $1 AND account_id = $2`, [req.params.id, accountId(req)]);
  if (!cur) throw notFound('ingest rule not found');
  const r = await one<any>(
    `UPDATE ingest_rules SET rung = $3, scope_id = $4, ordinal = $5, name = $6, enabled = $7, "when" = $8, "then" = $9, metadata_defaults = $10, updated_at = now()
      WHERE id = $1 AND account_id = $2 RETURNING *`,
    [cur.id, accountId(req), b.rung ?? cur.rung, 'scopeId' in b ? b.scopeId : cur.scope_id, b.ordinal ?? cur.ordinal, b.name ?? cur.name,
     b.enabled ?? cur.enabled, 'when' in b ? (b.when ? JSON.stringify(b.when) : null) : cur.when, JSON.stringify(b.then ?? cur.then),
     JSON.stringify(b.metadataDefaults ?? cur.metadata_defaults)]);
  res.json(row(r));
}));

ingestRouter.delete('/rules/:id', asyncHandler(async (req, res) => {
  const r = await one<any>(`DELETE FROM ingest_rules WHERE id = $1 AND account_id = $2 RETURNING id`, [req.params.id, accountId(req)]);
  if (!r) throw notFound('ingest rule not found');
  res.status(204).end();
}));

/**
 * What would happen to this file. The panel calls it at pick time with what
 * it knows (name, size, path); the answer carries the resolved settings, the
 * proposed key, the duplicate verdict and whether a later pass may differ.
 */
const previewBody = z.object({
  files: z.array(z.object({
    name: z.string().min(1).max(400), bytes: z.number().nonnegative().optional(), relativePath: z.string().max(1000).nullable().optional(),
    mime: z.string().max(120).nullable().optional(),
  })).min(1).max(500),
  source: z.string().max(80).default('panel'),
  contentTypeId: z.string().uuid().nullable().optional(),
  item: then.optional(),
});
ingestRouter.post('/preview', asyncHandler(async (req, res) => {
  const b = previewBody.parse(req.body);
  const out = [];
  for (const f of b.files) {
    const p = await preview(accountId(req), { name: f.name, bytes: f.bytes ?? null, relativePath: f.relativePath ?? null, mime: f.mime ?? null }, b.source, b.contentTypeId ?? null, b.item ?? null);
    out.push({
      name: f.name, key: p.naming.key, sanitised: p.naming.sanitised.name, changed: p.naming.sanitised.changed,
      settings: p.resolved.settings, sources: p.resolved.sources, matched: p.resolved.matched, deferred: p.resolved.deferred,
      duplicate: p.duplicate.outcome, duplicateOf: p.duplicate.match ? { assetId: p.duplicate.match.asset.id, strength: p.duplicate.match.strength } : null,
      reject: p.resolved.settings.reject,
      // A failed record this file looks like: the panel asks before it moves.
      failedMatch: (await failedMatches(accountId(req), f.name, f.bytes ?? null))[0] ?? null,
    });
  }
  res.json(out);
}));

/** Pure helper for anyone building an integration: how a name will be sanitised. */
ingestRouter.post('/sanitise', asyncHandler(async (req, res) => {
  const b = z.object({ names: z.array(z.string().max(400)).max(1000), lowercase: z.boolean().optional(),
                       naming: z.enum(['honour', 'guid', 'guid_prefixed', 'template']).optional(), nameTemplate: z.string().max(200).optional() }).parse(req.body);
  res.json(b.names.map((n) => ({ original: n, ...sanitise(n, { lowercase: b.lowercase }),
    example: applyNaming({ naming: b.naming ?? 'honour', nameTemplate: b.nameTemplate, lowercase: b.lowercase }, { originalName: n, accountId: accountId(req) }).key })));
}));

// ---------------------------------------------------------------------------
//  Webhooks
// ---------------------------------------------------------------------------
const hookBody = z.object({
  name: z.string().min(1).max(120), url: z.string().url().max(1000), enabled: z.boolean().optional(),
  events: z.array(z.enum(INGEST_EVENTS as unknown as [string, ...string[]])).optional(),
});
function hookRow(r: any, withSecret = false) {
  return { id: r.id, name: r.name, url: r.url, enabled: r.enabled, events: r.events, lastStatus: r.last_status, lastAt: r.last_at, lastError: r.last_error,
           createdAt: r.created_at, ...(withSecret ? { secret: r.secret } : {}) };
}
ingestRouter.get('/webhooks', asyncHandler(async (req, res) => {
  const rows = await query<any>(`SELECT * FROM ingest_webhooks WHERE account_id = $1 ORDER BY created_at`, [accountId(req)]);
  res.json(rows.map((r: any) => hookRow(r)));
}));
ingestRouter.post('/webhooks', asyncHandler(async (req, res) => {
  const b = hookBody.parse(req.body);
  // The secret is shown once, at creation, like an API key.
  const secret = 'whsec_' + randomBytes(24).toString('base64url');
  const r = await one<any>(
    `INSERT INTO ingest_webhooks (account_id, name, url, secret, enabled, events) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [accountId(req), b.name, b.url, secret, b.enabled ?? true, b.events ?? ['ingested']]);
  res.status(201).json(hookRow(r, true));
}));
ingestRouter.patch('/webhooks/:id', asyncHandler(async (req, res) => {
  const b = hookBody.partial().parse(req.body);
  const cur = await one<any>(`SELECT * FROM ingest_webhooks WHERE id = $1 AND account_id = $2`, [req.params.id, accountId(req)]);
  if (!cur) throw notFound('webhook not found');
  const r = await one<any>(`UPDATE ingest_webhooks SET name = $3, url = $4, enabled = $5, events = $6 WHERE id = $1 AND account_id = $2 RETURNING *`,
    [cur.id, accountId(req), b.name ?? cur.name, b.url ?? cur.url, b.enabled ?? cur.enabled, b.events ?? cur.events]);
  res.json(hookRow(r));
}));
ingestRouter.delete('/webhooks/:id', asyncHandler(async (req, res) => {
  const r = await one<any>(`DELETE FROM ingest_webhooks WHERE id = $1 AND account_id = $2 RETURNING id`, [req.params.id, accountId(req)]);
  if (!r) throw notFound('webhook not found');
  res.status(204).end();
}));

// ---------------------------------------------------------------------------
//  Assets the pipeline is holding: the metadata gate and duplicates.
// ---------------------------------------------------------------------------
// The list standard (util/listQuery.ts). Names are the response's; key is the
// column the cursor reads before the row is reshaped.
const heldList = defineList({
  path: '/api/ingest/held',
  fields: {
    id: { sql: 'v.id', type: 'uuid' },
    title: { sql: 'v.title', type: 'string' },
    originalFilename: { sql: 'v.original_filename', type: 'string', key: 'original_filename' },
    bytes: { sql: 'v.source_bytes', type: 'number', key: 'source_bytes' },
    mime: { sql: 'v.mime', type: 'string' },
    schemaId: { sql: 'v.schema_id', type: 'uuid', key: 'schema_id' },
    status: { sql: "v.ingest->>'status'", type: 'enum', values: ['awaiting_metadata', 'duplicate', 'rejected'], key: 'held_status' },
    createdAt: { sql: 'v.created_at', type: 'timestamp', key: 'created_at', notNull: true },
  },
  search: ['title', 'originalFilename'],
  defaultSort: '-createdAt',
  defaultLimit: 200,
  maxLimit: 200,
});

ingestRouter.get('/held', asyncHandler(async (req, res) => {
  const base: unknown[] = [accountId(req)];
  const params = [...base];
  const pl = parseList(heldList, req.query, params);
  const from = `FROM vod_assets v WHERE v.account_id = $1 AND v.ingest->>'status' IN ('awaiting_metadata', 'duplicate', 'rejected')${whereSql(pl)}`;
  const fetched = await query<any>(
    `SELECT v.id, v.title, v.original_filename, v.source_bytes, v.mime, v.schema_id, v.awaiting_metadata, v.ingest, v.created_at,
            v.metadata, v.master_key, v.media_state, v.ingest->>'status' AS held_status
       ${from} ${pageSql(pl)}`, params);
  // SELF-HEALING: metadata filled in somewhere else (the asset's page, the API)
  // releases the hold here too. Each waiting asset is checked against its type
  // again; one with nothing required missing is completed and leaves the list.
  const { completeMetadata } = await import('../services/ingest/pipeline');
  const released = new Set<string>();
  for (const r of fetched) {
    if (r.held_status !== 'awaiting_metadata') continue;
    const c = await completeMetadata(accountId(req), r.id, {}).catch(() => null);
    if (c?.ingested) released.add(String(r.id));
    else if (c) r.awaiting_metadata = c.missing;
  }
  for (let i = fetched.length - 1; i >= 0; i--) if (released.has(String(fetched[i].id))) fetched.splice(i, 1);
  const cParams = [...base];
  const cWhere = pl.count ? whereSql(parseList(heldList, { ...req.query, cursor: undefined, offset: undefined }, cParams)) : '';
  const total = pl.count ? (await one<any>(`SELECT count(*)::int AS n FROM vod_assets v WHERE v.account_id = $1 AND v.ingest->>'status' IN ('awaiting_metadata', 'duplicate', 'rejected')${cWhere}`, cParams))?.n : undefined;
  const rows = finishPage(req, res, pl, fetched, total);
  res.json(rows.map((r: any) => ({ id: r.id, title: r.title, originalFilename: r.original_filename, bytes: r.source_bytes != null ? Number(r.source_bytes) : null, mime: r.mime,
    schemaId: r.schema_id, status: r.ingest?.status, awaitingMetadata: r.awaiting_metadata, duplicate: r.ingest?.duplicate ?? null, rules: r.ingest?.rules?.matched ?? [], createdAt: r.created_at,
    // what is already filled in (the Fill in form starts from it), and whether the media is built
    metadata: r.metadata ?? {}, encoded: !!r.master_key, mediaState: r.media_state ?? null })));
}));

ingestRouter.post('/assets/:id/metadata', asyncHandler(async (req, res) => {
  const b = z.object({ metadata: z.record(z.any()) }).parse(req.body);
  res.json(await completeMetadata(accountId(req), req.params.id, b.metadata));
}));

ingestRouter.post('/assets/:id/duplicate', asyncHandler(async (req, res) => {
  const b = z.object({ action: z.enum(['skip', 'version', 'replace']) }).parse(req.body);
  res.json(await resolveDuplicate(accountId(req), req.params.id, b.action));
}));

// ---------------------------------------------------------------------------
//  Remote sources: cloud to cloud.
// ---------------------------------------------------------------------------
const remoteRef = z.object({
  provider: z.enum(['url', 'dropbox', 'onedrive', 'gdrive']), ref: z.string().min(1).max(4000),
  token: z.string().max(4000).nullable().optional(), headers: z.record(z.string()).optional(),
});

/** Start a cloud to cloud ingest. Answers at once with the session; the worker does the moving. */
ingestRouter.post('/remote', asyncHandler(async (req, res) => {
  const b = z.object({
    ref: remoteRef, name: z.string().max(400).optional(), bytes: z.number().nonnegative().optional(),
    relativePath: z.string().max(1000).nullable().optional(), schemaId: z.string().uuid().nullable().optional(),
    metadata: z.record(z.any()).optional(), ladderGroupId: z.string().uuid().nullable().optional(), providerAccountId: z.string().uuid().nullable().optional(),
  }).parse(req.body);
  // Describe first so the session has a real name and size, and so a bad link fails here, not in a job.
  const src = sourcesFor()[b.ref.provider];
  let auth = null as { accessToken: string } | null;
  if (b.ref.provider !== 'url' && !b.ref.token) {
    const accts = await providerAccounts(accountId(req), b.ref.provider);
    const pa = b.providerAccountId ? accts.find((a) => a.id === b.providerAccountId) : accts[0];
    if (!pa) return res.status(409).json({ error: `${b.ref.provider} is not linked to this account. Link it under Ingest Rules, or use the picker.` });
    auth = { accessToken: await accessTokenFor(pa) };
  }
  let d;
  try { d = await src.describe(b.ref, auth); } catch (e: any) { return res.status(e?.status && e.status < 500 ? e.status : 502).json({ error: e?.message ?? 'could not read the source' }); }
  const name = b.name || d.name;
  const { session, assetId } = await openSession({
    accountId: accountId(req), openedBy: actorId(req), purpose: 'vod', name: name.replace(/\.[^.]+$/, '').slice(0, 200), filename: name,
    contentType: d.mime ?? 'application/octet-stream', totalBytes: Math.max(1, d.bytes ?? b.bytes ?? 1),
    ladderGroupId: b.ladderGroupId ?? null, relativePath: b.relativePath ?? null, schemaId: b.schemaId ?? null, metadata: b.metadata ?? null, source: b.ref.provider,
  });
  await query(`UPDATE upload_sessions SET chunk_count = 0 WHERE id = $1`, [session.id]);
  const job = await enqueue({ type: REMOTE_INGEST, payload: { sessionId: session.id, ref: b.ref, providerAccountId: b.providerAccountId ?? null }, dedupeKey: `ingest.remote:${session.id}`, maxAttempts: 3 });
  res.status(202).json({ sessionId: session.id, assetId, jobId: job.id, name, bytes: d.bytes, ranges: d.ranges, transfer: 'cloud' });
}));

/** Is this file already in a linked cloud account? For transfer = auto before a byte moves. */
ingestRouter.post('/locate', asyncHandler(async (req, res) => {
  const b = z.object({ files: z.array(z.object({ name: z.string().min(1).max(400), bytes: z.number().nonnegative().optional(), relativePath: z.string().max(1000).nullable().optional() })).min(1).max(200) }).parse(req.body);
  const accts = await providerAccounts(accountId(req));
  const srcs = sourcesFor();
  const out: { name: string; hit: (LocateHit & { providerAccountId: string; label: string }) | null }[] = [];
  for (const f of b.files) {
    let hit: (LocateHit & { providerAccountId: string; label: string }) | null = null;
    for (const pa of accts) {
      const src = (srcs as any)[pa.provider];
      if (!src?.locate) continue;
      try {
        const h = await src.locate({ name: f.name, bytes: f.bytes ?? null, relativePath: f.relativePath ?? null }, { accessToken: await accessTokenFor(pa) });
        if (h && (!hit || h.strength === 'path' || (h.strength === 'name_and_size' && hit.strength === 'name'))) hit = { ...h, providerAccountId: pa.id, label: pa.label };
      } catch (e) { /* one provider down is not a reason to stop looking */ }
    }
    out.push({ name: f.name, hit });
  }
  res.json(out);
}));

// ---------------------------------------------------------------------------
//  Linked provider accounts.
// ---------------------------------------------------------------------------
ingestRouter.get('/providers', asyncHandler(async (req, res) => {
  const rows = await providerAccounts(accountId(req));
  res.json({
    linked: rows.map((r) => ({ id: r.id, provider: r.provider, label: r.label, expiresAt: r.expires_at, config: { ...r.config, apiKey: undefined, password: undefined } })),
    available: (Object.keys(OAUTH) as OAuthProvider[]).map((p) => ({ provider: p, configured: !!OAUTH[p].clientId() })),
  });
}));

function oauthState(accountId: string, provider: string, userId: string | null): string {
  const payload = Buffer.from(JSON.stringify({ a: accountId, p: provider, u: userId, t: Date.now() })).toString('base64url');
  return payload + '.' + createHmac('sha256', config.jwt.accessSecret).update(payload).digest('base64url');
}
function readState(state: string): { a: string; p: string; u: string | null; t: number } {
  const [payload, sig] = state.split('.');
  if (createHmac('sha256', config.jwt.accessSecret).update(payload ?? '').digest('base64url') !== sig) throw Object.assign(new Error('bad state'), { status: 400 });
  const j = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (Date.now() - j.t > 15 * 60 * 1000) throw Object.assign(new Error('the link request expired, start again'), { status: 400 });
  return j;
}
function redirectUri(req: any, provider: string): string {
  return `${config.publicBaseUrl}/api/ingest/providers/${provider}/callback`;
}

/** Where to send the browser to link a provider. */
ingestRouter.get('/providers/:provider/authorize', asyncHandler(async (req, res) => {
  const provider = req.params.provider as OAuthProvider;
  if (!(provider in OAUTH)) throw notFound('unknown provider');
  res.json({ url: authorizeUrl(provider, redirectUri(req, provider), oauthState(accountId(req), provider, actorId(req))) });
}));

/** The provider sends the browser back here. No session cookie is needed: the signed state names the account. */
ingestRouter.get('/providers/:provider/callback', asyncHandler(async (req, res) => {
  const provider = req.params.provider as OAuthProvider;
  const code = String(req.query.code ?? ''); const st = readState(String(req.query.state ?? ''));
  if (st.p !== provider || !code) throw Object.assign(new Error('bad callback'), { status: 400 });
  await linkOAuth(st.a, provider, code, redirectUri(req, provider), `${provider} (linked ${new Date().toISOString().slice(0, 10)})`, st.u);
  res.type('html').send(`<!doctype html><title>Linked</title><p style="font-family:system-ui">${provider} is linked to Volt. You can close this window.</p><script>try{window.opener&&window.opener.postMessage({voltProviderLinked:'${provider}'},'*')}catch(e){}</script>`);
}));

/** Non-OAuth providers (Aspera node, MASV key, Signiant) are entered directly. */
ingestRouter.post('/providers', asyncHandler(async (req, res) => {
  const b = z.object({ provider: z.enum(['aspera', 'masv', 'signiant']), label: z.string().min(1).max(120), config: z.record(z.any()) }).parse(req.body);
  const r = await one<any>(`INSERT INTO ingest_provider_accounts (account_id, provider, label, config, linked_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, provider, label`, [accountId(req), b.provider, b.label, JSON.stringify(b.config), actorId(req)]);
  res.status(201).json(r);
}));
ingestRouter.delete('/providers/:id', asyncHandler(async (req, res) => {
  const r = await one<any>(`DELETE FROM ingest_provider_accounts WHERE id = $1 AND account_id = $2 RETURNING id`, [req.params.id, accountId(req)]);
  if (!r) throw notFound('provider account not found');
  res.status(204).end();
}));

// ---------------------------------------------------------------------------
//  Accelerated transfers: Aspera, MASV, Signiant, S3 acceleration.
// ---------------------------------------------------------------------------
// The list standard (util/listQuery.ts). Same rows as listTransfers(), which
// the rest of the pipeline keeps using; this one searches, filters and pages.
const transferList = defineList({
  path: '/api/ingest/transfers',
  fields: {
    id: { sql: 't.id', type: 'uuid' },
    provider: { sql: 't.provider', type: 'enum', values: ['aspera', 'masv', 'signiant', 's3accel'] },
    state: { sql: 't.state', type: 'string', doc: 'created, running, landed, failed...' },
    externalId: { sql: 't.external_id', type: 'string', key: 'external_id' },
    error: { sql: 't.error', type: 'string', sort: false },
    createdAt: { sql: 't.created_at', type: 'timestamp', key: 'created_at', notNull: true },
    updatedAt: { sql: 't.updated_at', type: 'timestamp', key: 'updated_at' },
  },
  search: ['externalId', 'error', "t.files::text"],
  defaultSort: '-createdAt',
  defaultLimit: 100,
  maxLimit: 100,
});

ingestRouter.get('/transfers', asyncHandler(async (req, res) => {
  const base: unknown[] = [accountId(req)];
  const params = [...base];
  const pl = parseList(transferList, req.query, params);
  const from = `FROM ingest_transfers t WHERE t.account_id = $1${whereSql(pl)}`;
  const rows = await query<any>(`SELECT t.* ${from} ${pageSql(pl)}`, params);
  const cParams = [...base];
  const cWhere = pl.count ? whereSql(parseList(transferList, { ...req.query, cursor: undefined, offset: undefined }, cParams)) : '';
  const total = pl.count ? (await one<any>(`SELECT count(*)::int AS n FROM ingest_transfers t WHERE t.account_id = $1${cWhere}`, cParams))?.n : undefined;
  res.json(finishPage(req, res, pl, rows, total).map(viewTransfer));
}));
ingestRouter.post('/transfers', asyncHandler(async (req, res) => {
  const b = z.object({
    provider: z.enum(['aspera', 'masv', 'signiant', 's3accel']),
    files: z.array(z.object({ name: z.string().min(1).max(400), bytes: z.number().nonnegative().nullable().optional(), relativePath: z.string().max(1000).nullable().optional() })).min(1).max(500),
    providerAccountId: z.string().uuid().nullable().optional(),
  }).parse(req.body);
  const t = await createTransfer(accountId(req), actorId(req), b.provider, b.files, b.providerAccountId ?? null);
  res.status(201).json(viewTransfer(t));
}));
function viewTransfer(t: any) { return { id: t.id, provider: t.provider, state: t.state, externalId: t.external_id, files: t.files, destination: t.destination, launch: t.spec?.launch ?? null, progress: t.progress, error: t.error, landedPaths: t.landed_paths, createdAt: t.created_at }; }
