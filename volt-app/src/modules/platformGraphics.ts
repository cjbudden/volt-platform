/**
 * SYSTEM ADMIN: VOLT'S GRAPHICS LIBRARY. docs/GRAPHICS_TEMPLATE_STANDARD.md section 9.
 *
 * Volt's own templates (gfx_templates.account_id NULL) and the SETS they belong to, managed
 * by SaaS staff without a code deploy. A set is on or off for each client account: its
 * default covers every account without a choice of its own, and an account can be switched
 * on or off on its own. What clients see: services/graphics/sets.ts. Setups stay per account.
 *
 *   Sets
 *     GET    /api/platform/graphics/sets                       sets, template counts, accounts on
 *     POST   /api/platform/graphics/sets                       { key, name, description?, defaultEnabled?, sort? }
 *     PATCH  /api/platform/graphics/sets/:id                   { name?, description?, defaultEnabled?, sort?, archived?, clearOverrides? }
 *   Templates
 *     GET    /api/platform/graphics/templates?set=&retired=1   Volt templates with set, versions and use
 *     GET    /api/platform/graphics/templates/:id              detail: versions, accounts using it
 *     POST   /api/platform/graphics/templates                  paste { setId?, name?, kind?, html, files? }
 *     POST   /api/platform/graphics/templates/import?setId=&kind=&name=&filename=   raw .zip or .html
 *     PATCH  /api/platform/graphics/templates/:id              { name?, kind?, setId?, retired? }
 *     PUT    /api/platform/graphics/templates/:id/draft        new draft (raw upload or JSON paste)
 *     POST   /api/platform/graphics/templates/:id/draft/publish   { note? }
 *     DELETE /api/platform/graphics/templates/:id/draft
 *   Accounts
 *     GET    /api/platform/graphics/accounts/:id/sets          each set: default, the account's choice, on or off
 *     PUT    /api/platform/graphics/accounts/:id/sets/:setId   { enabled: true | false | null }  (null follows the default)
 *
 * Publishing a new version never moves anyone: setups are pinned to a version, and clients see
 * "update available". Retiring hides a template from new use; setups already on it keep running.
 */
import express, { Router, Request } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../db';
import { requirePlatform } from '../auth/platform';
import { asyncHandler, badRequest, conflict, notFound } from '../util/http';
import { actor, writeAudit } from '../services/audit';
import { filesFromUpload, PackageError } from '../services/graphics/templatePackage';
import { templateStatus } from '../services/graphics/status';
import { setsForAccount } from '../services/graphics/sets';
import { insertVersion, versionJson, pastedFiles, analyseOr400 } from './graphics';

export const platformGraphicsRouter = Router();
const KINDS = ['scorebug', 'lower_third', 'ticker', 'bug', 'full_frame', 'other'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v: unknown, what: string) => { const s = String(v ?? ''); if (!UUID.test(s)) throw notFound(`No ${what} with that id`); return s; };
const audit = (req: Request, action: 'create' | 'update' | 'delete', entityType: string, entityId: string, extra: { changes?: any; snapshot?: any } = {}) => {
  const { userId, label } = actor(req);
  return writeAudit(null, { accountId: null, userId, label: `${label} (System Admin)`, action, entityType, entityId, ...extra });
};

// ---- sets ------------------------------------------------------------------------------

const SET_SQL = `
  SELECT gs.*,
    (SELECT count(*)::int FROM gfx_templates t WHERE t.set_id = gs.id AND t.account_id IS NULL AND t.archived_at IS NULL AND t.retired_at IS NULL) AS templates,
    (SELECT count(*)::int FROM gfx_templates t WHERE t.set_id = gs.id AND t.account_id IS NULL AND t.archived_at IS NULL AND t.retired_at IS NOT NULL) AS retired,
    (SELECT count(*)::int FROM accounts a LEFT JOIN gfx_account_sets x ON x.account_id = a.id AND x.set_id = gs.id
      WHERE gs.archived_at IS NULL AND COALESCE(x.enabled, gs.default_enabled)) AS accounts_on,
    (SELECT count(*)::int FROM accounts) AS accounts_total,
    (SELECT count(*)::int FROM gfx_account_sets x WHERE x.set_id = gs.id AND x.enabled) AS overrides_on,
    (SELECT count(*)::int FROM gfx_account_sets x WHERE x.set_id = gs.id AND NOT x.enabled) AS overrides_off
  FROM gfx_template_sets gs`;
const setJson = (r: any) => ({
  id: r.id, key: r.key, name: r.name, description: r.description, defaultEnabled: r.default_enabled, shipped: r.shipped, sort: r.sort,
  archived: !!r.archived_at, templates: r.templates, retired: r.retired, accountsOn: r.accounts_on, accountsTotal: r.accounts_total,
  overridesOn: r.overrides_on, overridesOff: r.overrides_off, createdAt: r.created_at, updatedAt: r.updated_at,
});

platformGraphicsRouter.get('/sets', ...requirePlatform('read_only'), asyncHandler(async (_req, res) => {
  const rows = await query<any>(`${SET_SQL} ORDER BY gs.archived_at NULLS FIRST, gs.sort, gs.name`);
  res.json({ items: rows.map(setJson) });
}));

const setCreate = z.object({
  key: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, 'Use 2 to 41 lowercase letters, digits and dashes'),
  name: z.string().trim().min(1).max(80), description: z.string().trim().max(400).optional().nullable(),
  defaultEnabled: z.boolean().default(false), sort: z.number().int().min(0).max(10_000).default(100),
});
platformGraphicsRouter.post('/sets', ...requirePlatform('saas_admin'), asyncHandler(async (req, res) => {
  const b = setCreate.parse(req.body ?? {});
  if (await one(`SELECT 1 FROM gfx_template_sets WHERE key = $1`, [b.key])) throw conflict(`A set with the key ${b.key} already exists.`);
  const r = await one<any>(`INSERT INTO gfx_template_sets(key, name, description, default_enabled, sort) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [b.key, b.name, b.description ?? null, b.defaultEnabled, b.sort]);
  await audit(req, 'create', 'graphics_set', r!.id, { snapshot: b });
  res.status(201).json(setJson(await one<any>(`${SET_SQL} WHERE gs.id = $1`, [r!.id])));
}));

const setPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(), description: z.string().trim().max(400).nullable().optional(),
  defaultEnabled: z.boolean().optional(), sort: z.number().int().min(0).max(10_000).optional(), archived: z.boolean().optional(),
  // With a new default: drop every account's own choice so the default applies to all of them.
  clearOverrides: z.boolean().optional(),
});
platformGraphicsRouter.patch('/sets/:id', ...requirePlatform('saas_admin'), asyncHandler(async (req, res) => {
  const sid = id(req.params.id, 'set');
  const cur = await one<any>(`SELECT * FROM gfx_template_sets WHERE id = $1`, [sid]);
  if (!cur) throw notFound('No set with that id');
  const b = setPatch.parse(req.body ?? {});
  await tx(async (c) => {
    await c.query(`UPDATE gfx_template_sets SET name = COALESCE($2, name), description = CASE WHEN $3::boolean THEN $4 ELSE description END,
        default_enabled = COALESCE($5, default_enabled), sort = COALESCE($6, sort),
        archived_at = CASE WHEN $7::boolean IS NULL THEN archived_at WHEN $7 THEN COALESCE(archived_at, now()) ELSE NULL END, updated_at = now()
      WHERE id = $1`, [sid, b.name ?? null, b.description !== undefined, b.description ?? null, b.defaultEnabled ?? null, b.sort ?? null, b.archived ?? null]);
    if (b.clearOverrides) await c.query(`DELETE FROM gfx_account_sets WHERE set_id = $1`, [sid]);
  });
  await audit(req, 'update', 'graphics_set', sid, { changes: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, { from: k === 'defaultEnabled' ? cur.default_enabled : k === 'archived' ? !!cur.archived_at : cur[k], to: v }])) });
  res.json(setJson(await one<any>(`${SET_SQL} WHERE gs.id = $1`, [sid])));
}));

// ---- templates ---------------------------------------------------------------------------

const TPL_SQL = `
  SELECT t.*, gs.key AS set_key, gs.name AS set_name,
    (SELECT row_to_json(v) FROM (SELECT id, version, manifest, checks, size_bytes, file_count, published_at, status, note, created_at FROM gfx_template_versions
       WHERE template_id = t.id AND status = 'published' ORDER BY version DESC LIMIT 1) v) AS latest,
    (SELECT row_to_json(d) FROM (SELECT id, version, manifest, checks, size_bytes, file_count, status, note, created_at, NULL AS published_at FROM gfx_template_versions
       WHERE template_id = t.id AND status = 'draft') d) AS draft,
    (SELECT count(DISTINCT s.account_id)::int FROM gfx_setups s WHERE s.template_id = t.id) AS accounts_using,
    (SELECT count(*)::int FROM gfx_setups s WHERE s.template_id = t.id) AS setups
  FROM gfx_templates t LEFT JOIN gfx_template_sets gs ON gs.id = t.set_id`;
const tplJson = (r: any) => ({
  id: r.id, name: r.name, kind: r.kind, source: r.source, shipped: !!(r.latest?.manifest?.voltKey ?? r.draft?.manifest?.voltKey),
  set: r.set_id ? { id: r.set_id, key: r.set_key, name: r.set_name } : null, retired: !!r.retired_at, retiredAt: r.retired_at,
  status: templateStatus(r.latest, r.draft), latest: versionJson(r.latest), draft: versionJson(r.draft),
  accountsUsing: r.accounts_using, setups: r.setups, createdAt: r.created_at, updatedAt: r.updated_at,
});

async function voltTemplate(tid: string) {
  const t = await one<any>(`SELECT * FROM gfx_templates WHERE id = $1 AND account_id IS NULL AND archived_at IS NULL`, [id(tid, 'template')]);
  if (!t) throw notFound('No Volt template with that id');
  return t;
}
async function setIdOr400(v: unknown): Promise<string | null> {
  if (v == null || v === '') return null;
  const s = await one<any>(`SELECT id FROM gfx_template_sets WHERE id::text = $1 OR key = $1`, [String(v)]);
  if (!s) throw badRequest('No set with that id or key');
  return s.id;
}

platformGraphicsRouter.get('/templates', ...requirePlatform('read_only'), asyncHandler(async (req, res) => {
  const params: any[] = []; let where = `t.account_id IS NULL AND t.archived_at IS NULL`;
  if (!req.query.retired) where += ` AND t.retired_at IS NULL`;
  if (req.query.set === 'none') where += ` AND t.set_id IS NULL`;
  else if (req.query.set) { params.push(String(req.query.set)); where += ` AND (gs.key = $1 OR gs.id::text = $1)`; }
  const rows = await query<any>(`${TPL_SQL} WHERE ${where} ORDER BY gs.sort NULLS LAST, t.name LIMIT 1000`, params);
  res.json({ items: rows.map(tplJson) });
}));

platformGraphicsRouter.get('/templates/:id', ...requirePlatform('read_only'), asyncHandler(async (req, res) => {
  const t = await voltTemplate(req.params.id);
  const r = await one<any>(`${TPL_SQL} WHERE t.id = $1`, [t.id]);
  const versions = await query<any>(`SELECT * FROM gfx_template_versions WHERE template_id = $1 ORDER BY status = 'draft' DESC, version DESC`, [t.id]);
  const using = await query<any>(`SELECT a.id, a.name, count(s.id)::int AS setups FROM gfx_setups s JOIN accounts a ON a.id = s.account_id
                                   WHERE s.template_id = $1 GROUP BY a.id, a.name ORDER BY a.name`, [t.id]);
  res.json({ ...tplJson(r), versions: versions.map(versionJson), accounts: using });
}));

async function createVolt(req: Request, raw: { path: string; data: Buffer }[], o: { name?: string; kind?: string; setId: string | null; source: 'paste' | 'upload' }) {
  const a = analyseOr400(raw);
  const name = (o.name || a.manifest.name || 'Untitled graphic').slice(0, 120);
  const { userId } = actor(req);
  const out = await tx(async (c) => {
    const t = (await c.query(`INSERT INTO gfx_templates(account_id, name, kind, source, set_id, created_by) VALUES (NULL,$1,$2,'volt',$3,(SELECT id FROM users WHERE id = $4)) RETURNING *`,
      [name, o.kind ?? 'other', o.setId, userId])).rows[0];
    await insertVersion(c, t.id, a, userId, `Added by System Admin (${o.source})`);
    return t;
  });
  await audit(req, 'create', 'graphics_template', out.id, { snapshot: { name, kind: out.kind, setId: o.setId, platform: true } });
  return tplJson(await one<any>(`${TPL_SQL} WHERE t.id = $1`, [out.id]));
}

const pasteSchema = z.object({ setId: z.string().optional().nullable(), name: z.string().trim().min(1).max(120).optional(), kind: z.enum(KINDS).optional(),
  html: z.string().max(900_000), files: z.record(z.any()).optional(), path: z.string().max(200).optional() });
platformGraphicsRouter.post('/templates', ...requirePlatform('saas_admin'), asyncHandler(async (req, res) => {
  const b = pasteSchema.parse(req.body ?? {});
  res.status(201).json(await createVolt(req, pastedFiles(b), { name: b.name, kind: b.kind, setId: await setIdOr400(b.setId), source: 'paste' }));
}));

const rawBody = express.raw({ type: () => true, limit: '26mb' });
function uploaded(req: Request) {
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!body.length) throw badRequest('Upload a .zip package or an .html file as the request body.');
  try { return filesFromUpload(body, String(req.query.filename ?? '')); } catch (e) { if (e instanceof PackageError) throw badRequest(e.message); throw e; }
}
platformGraphicsRouter.post('/templates/import', ...requirePlatform('saas_admin'), rawBody, asyncHandler(async (req, res) => {
  const kind = KINDS.includes(String(req.query.kind) as any) ? String(req.query.kind) : undefined;
  res.status(201).json(await createVolt(req, uploaded(req), { name: req.query.name ? String(req.query.name).slice(0, 120) : undefined, kind,
    setId: await setIdOr400(req.query.setId), source: 'upload' }));
}));

const tplPatch = z.object({ name: z.string().trim().min(1).max(120).optional(), kind: z.enum(KINDS).optional(),
  setId: z.string().nullable().optional(), retired: z.boolean().optional() });
platformGraphicsRouter.patch('/templates/:id', ...requirePlatform('saas_admin'), asyncHandler(async (req, res) => {
  const t = await voltTemplate(req.params.id);
  const b = tplPatch.parse(req.body ?? {});
  const setId = b.setId !== undefined ? await setIdOr400(b.setId) : undefined;
  await query(`UPDATE gfx_templates SET name = COALESCE($2, name), kind = COALESCE($3, kind),
      set_id = CASE WHEN $4::boolean THEN $5::uuid ELSE set_id END,
      retired_at = CASE WHEN $6::boolean IS NULL THEN retired_at WHEN $6 THEN COALESCE(retired_at, now()) ELSE NULL END, updated_at = now()
    WHERE id = $1`, [t.id, b.name ?? null, b.kind ?? null, setId !== undefined, setId ?? null, b.retired ?? null]);
  await audit(req, 'update', 'graphics_template', t.id, { changes: Object.fromEntries(Object.entries(b).map(([k, v]) => [k,
    { from: k === 'setId' ? t.set_id : k === 'retired' ? !!t.retired_at : t[k], to: k === 'setId' ? setId : v }])) });
  res.json(tplJson(await one<any>(`${TPL_SQL} WHERE t.id = $1`, [t.id])));
}));

platformGraphicsRouter.put('/templates/:id/draft', ...requirePlatform('saas_admin'), rawBody, asyncHandler(async (req, res) => {
  const t = await voltTemplate(req.params.id);
  let raw: { path: string; data: Buffer }[];
  if (Buffer.isBuffer(req.body) && req.body.length && !/json/i.test(String(req.headers['content-type'] ?? ''))) raw = uploaded(req);
  else {
    let body: any = req.body;
    if (Buffer.isBuffer(body)) { try { body = JSON.parse(body.toString('utf8')); } catch { throw badRequest('Send the package as the body, or JSON { html }.'); } }
    raw = pastedFiles(body);
  }
  const a = analyseOr400(raw);
  const { userId } = actor(req);
  const v = await tx((c) => insertVersion(c, t.id, a, userId, req.query.note ? String(req.query.note).slice(0, 300) : 'Draft by System Admin'));
  res.json(versionJson(v));
}));

platformGraphicsRouter.delete('/templates/:id/draft', ...requirePlatform('saas_admin'), asyncHandler(async (req, res) => {
  const t = await voltTemplate(req.params.id);
  const used = await one<any>(`SELECT count(*)::int AS n FROM gfx_setups s JOIN gfx_template_versions v ON v.id = s.version_id WHERE v.template_id = $1 AND v.status = 'draft'`, [t.id]);
  if (used?.n) throw conflict('A setup is on this draft. It has to move to a published version first.');
  await query(`DELETE FROM gfx_template_versions WHERE template_id = $1 AND status = 'draft'`, [t.id]);
  res.status(204).end();
}));

platformGraphicsRouter.post('/templates/:id/draft/publish', ...requirePlatform('saas_admin'), asyncHandler(async (req, res) => {
  const t = await voltTemplate(req.params.id);
  const { userId } = actor(req);
  const v = await tx(async (c) => {
    const d = (await c.query(`SELECT * FROM gfx_template_versions WHERE template_id = $1 AND status = 'draft' FOR UPDATE`, [t.id])).rows[0];
    if (!d) throw notFound('There is no draft to publish.');
    const errors = (d.checks ?? []).filter((x: any) => x.level === 'error');
    if (errors.length) throw Object.assign(conflict(`Fix ${errors.length === 1 ? 'this' : 'these'} before publishing: ${errors.map((e: any) => e.title).join('; ')}.`), { checks: d.checks });
    const n = (await c.query(`SELECT COALESCE(max(version), 0) + 1 AS n FROM gfx_template_versions WHERE template_id = $1`, [t.id])).rows[0].n;
    const note = req.body?.note ? String(req.body.note).slice(0, 300) : d.note;
    const r = (await c.query(`UPDATE gfx_template_versions SET status = 'published', version = $2, note = $3, published_at = now(),
        published_by = (SELECT id FROM users WHERE id = $4) WHERE id = $1 RETURNING *`, [d.id, n, note, userId])).rows[0];
    // A template made in System Admin takes its name from its first published manifest unless renamed.
    await c.query(`UPDATE gfx_templates SET updated_at = now() WHERE id = $1`, [t.id]);
    return r;
  });
  await audit(req, 'update', 'graphics_template', t.id, { changes: { version: { from: v.version - 1, to: v.version } } });
  res.json(versionJson(v));
}));

// ---- accounts ------------------------------------------------------------------------------

async function accountOr404(aid: string) {
  const a = await one<any>(`SELECT id, name FROM accounts WHERE id = $1`, [id(aid, 'account')]);
  if (!a) throw notFound('account not found');
  return a;
}
platformGraphicsRouter.get('/accounts/:id/sets', ...requirePlatform('read_only'), asyncHandler(async (req, res) => {
  const a = await accountOr404(req.params.id);
  res.json({ account: a, items: await setsForAccount(a.id) });
}));

platformGraphicsRouter.put('/accounts/:id/sets/:setId', ...requirePlatform('saas_admin'), asyncHandler(async (req, res) => {
  const a = await accountOr404(req.params.id);
  const sid = id(req.params.setId, 'set');
  if (!(await one(`SELECT 1 FROM gfx_template_sets WHERE id = $1`, [sid]))) throw notFound('No set with that id');
  const b = z.object({ enabled: z.boolean().nullable() }).parse(req.body ?? {});
  const before = await one<any>(`SELECT enabled FROM gfx_account_sets WHERE account_id = $1 AND set_id = $2`, [a.id, sid]);
  const { userId } = actor(req);
  if (b.enabled === null) await query(`DELETE FROM gfx_account_sets WHERE account_id = $1 AND set_id = $2`, [a.id, sid]);
  else await query(`INSERT INTO gfx_account_sets(account_id, set_id, enabled, updated_by) VALUES ($1,$2,$3,(SELECT id FROM users WHERE id = $4))
      ON CONFLICT (account_id, set_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now(), updated_by = EXCLUDED.updated_by`, [a.id, sid, b.enabled, userId]);
  const { label } = actor(req);
  await writeAudit(null, { accountId: a.id, userId, label: `${label} (System Admin)`, action: 'update', entityType: 'graphics_set', entityId: sid,
    changes: { enabled: { from: before?.enabled ?? 'default', to: b.enabled ?? 'default' } } });
  res.json({ account: a, items: await setsForAccount(a.id) });
}));
