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
import { actor, writeAudit } from '../services/audit';
import { BASELINE, INGEST_KEYS } from '../services/ingest/rules';
import { preview } from '../services/ingest/pipeline';
import { sanitise, applyNaming } from '../services/ingest/naming';
import { INGEST_EVENTS } from '../services/ingest/events';

export const ingestRouter = Router();
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
