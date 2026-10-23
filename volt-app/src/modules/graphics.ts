/**
 * HTML GRAPHICS. docs/REQ_graphics_overlays.md
 *
 * Templates (an HTML graphic, versioned), setups (a pinned version plus where
 * each field's content comes from, position and layer), assignments (a setup
 * on a channel or event: how it runs and where it is shown), live state, data
 * sources and event rundowns.
 *
 *   Templates
 *     GET    /api/graphics/templates                       library (own + Volt defaults)
 *     POST   /api/graphics/templates                       paste: { name, kind, html, files? }
 *     POST   /api/graphics/templates/import?name=&kind=     upload: raw .zip or .html body
 *     GET    /api/graphics/templates/:id                   detail, versions, used by
 *     PATCH  /api/graphics/templates/:id                   { name, kind }
 *     DELETE /api/graphics/templates/:id                   archive (refused while a setup uses it)
 *     POST   /api/graphics/templates/:id/duplicate         a new template from the latest version
 *     PUT    /api/graphics/templates/:id/draft             replace the draft (JSON paste or raw upload)
 *     POST   /api/graphics/templates/:id/draft/publish     freeze the draft as the next version
 *     DELETE /api/graphics/templates/:id/draft             discard the draft
 *     GET    /api/graphics/templates/:id/versions/:vid/files   file list
 *     GET    /api/graphics/templates/:id/versions/:vid/download  the version as a .zip
 *   Setups
 *     GET/POST /api/graphics/setups, GET/PATCH/DELETE /api/graphics/setups/:id
 *   Data sources
 *     GET/POST /api/graphics/sources, PATCH/DELETE /api/graphics/sources/:id
 *     POST   /api/graphics/sources/:id/test               fetch now, return the payload
 *     POST   /api/graphics/sources/:id/push               push a payload (kind push)       [operate]
 *   Assignments and live state
 *     GET    /api/graphics/assignments?channel_id=|event_id=|setup_id=
 *     POST   /api/graphics/assignments, PATCH/DELETE /api/graphics/assignments/:id
 *     GET    /api/graphics/live?channel_id=|event_id=      every graphic there, resolved, on or off now
 *     GET    /api/graphics/plan?channel_id=&from=&to=      day strip from the guide
 *     GET    /api/graphics/assignments/:id/state
 *     PATCH  /api/graphics/assignments/:id/state           { values, release? }  the live driving call  [operate]
 *     POST   /api/graphics/assignments/:id/air             { on, forSec? }                              [operate]
 *     GET    /api/graphics/log?assignment_id=|event_id=
 *   Event rundowns
 *     GET    /api/graphics/rundowns/:eventId
 *     POST   /api/graphics/rundowns/:eventId/items, PATCH/DELETE .../items/:itemId
 *     POST   /api/graphics/rundowns/:eventId/reorder       { ids }
 *     POST   /api/graphics/rundowns/:eventId/copy-from     { eventId }
 *     POST   /api/graphics/rundowns/:eventId/import-csv    text/csv body, ?tz=
 *     POST   /api/graphics/rundowns/:eventId/take          { itemId? }  next manual item when absent   [operate]
 *     POST   /api/graphics/rundowns/:eventId/take-off      { itemId? }                                   [operate]
 *     POST   /api/graphics/rundowns/:eventId/items/:itemId/(skip|restore)                              [operate]
 *
 * Template files are served from /gfx/<versionId>/<path> by graphicsFilesRouter,
 * sandboxed (no network, no Volt origin), immutable once published.
 * Gated by the `graphics` feature (auth/roles.ts).
 */
import express, { Router, Request } from 'express';
import { z } from 'zod';
import { PoolClient } from 'pg';
import { one, query, tx } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, badRequest, conflict, notFound } from '../util/http';
import { actor, writeAudit } from '../services/audit';
import { analyse, filesFromUpload, PackageError, safePath, type Analysed } from '../services/graphics/templatePackage';
import { ografHostPage } from '../services/graphics/ograf';
import { templateStatus } from '../services/graphics/status';
import { applyStyle, readStyle, StyleError } from '../services/graphics/style';
import { writeZip } from '../services/graphics/zip';
import {
  loadTarget, assertTargetsAllowed, liveFor, liveOne, planFor, setValues, setAir, takeItem, takeOffRundown,
  fetchFeed, acceptPayload, assertPublicUrl,
} from '../services/graphics/runtime';
import { describe as describeRun } from '../services/graphics/schedule';
import { nextManual, normCue, parseCsv, cueFromText } from '../services/graphics/rundown';
import { feedFor, recordStream, impressionCounts } from '../services/graphics/playerFeed';
import { publishGfx, publishForSetup, publishForSource } from '../services/graphics/livePush';
import { verifyKey, checkRestrictions, appForKey } from '../services/apiKeys';
import { assetKindFor } from '../services/viewerPath';
import { cached } from '../scale/cache';
import { ApiError } from '../util/http';

export const graphicsRouter = Router();
graphicsRouter.use(requireAuth);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidParam = (v: unknown, what = 'id') => { const s = String(v ?? ''); if (!UUID.test(s)) throw notFound(`No ${what} with that id`); return s; };
const KINDS = ['scorebug', 'lower_third', 'ticker', 'bug', 'full_frame', 'other'] as const;
const who = (req: Request) => { const a = actor(req); return a.label; };

// ---- templates ----------------------------------------------------------------

async function templateFor(acct: string, id: string, write = false) {
  const t = await one<any>(`SELECT * FROM gfx_templates WHERE id = $1 AND (account_id = $2 OR account_id IS NULL)`, [id, acct]);
  if (!t) throw notFound('No template with that id');
  if (write && t.account_id == null) throw badRequest('Volt templates are read-only. Duplicate it to change your copy.');
  return t;
}

async function insertVersion(c: PoolClient, templateId: string, a: Analysed, userId: string | null, note: string | null) {
  await c.query(`DELETE FROM gfx_template_versions WHERE template_id = $1 AND status = 'draft'`, [templateId]);
  const v = (await c.query(
    `INSERT INTO gfx_template_versions(template_id, status, manifest, checks, size_bytes, file_count, note, created_by)
     VALUES ($1,'draft',$2::jsonb,$3::jsonb,$4,$5,$6,(SELECT id FROM users WHERE id = $7)) RETURNING *`,
    [templateId, JSON.stringify(a.manifest), JSON.stringify(a.checks), a.sizeBytes, a.files.length, note, userId])).rows[0];
  for (const f of a.files) {
    await c.query(`INSERT INTO gfx_files(version_id, path, content_type, sha256, size_bytes, content) VALUES ($1,$2,$3,$4,$5,$6)`,
      [v.id, f.path, f.contentType, f.sha256, f.data.length, f.data]);
  }
  await c.query(`UPDATE gfx_templates SET updated_at = now() WHERE id = $1`, [templateId]);
  return v;
}

const versionJson = (v: any) => v && ({
  id: v.id, version: v.version, status: v.status, manifest: v.manifest, checks: v.checks,
  publishable: !(v.checks ?? []).some((c: any) => c.level === 'error'),
  sizeBytes: Number(v.size_bytes), fileCount: v.file_count, note: v.note, createdAt: v.created_at, publishedAt: v.published_at,
  url: `/gfx/${v.id}/index.html`,
});

function pastedFiles(body: any, base: { path: string; data: Buffer }[] = []): { path: string; data: Buffer }[] {
  const html = typeof body?.html === 'string' ? body.html : null;
  if (!html || !html.trim()) throw badRequest('Paste the template HTML.');
  // `path` names the file the text replaces (an OGraf package's graphic.mjs, say); index.html by default.
  let main = 'index.html';
  if (typeof body.path === 'string' && body.path.trim()) {
    try { main = safePath(body.path.trim()); } catch (e) { if (e instanceof PackageError) throw badRequest(e.message); throw e; }
  }
  const files = new Map<string, { path: string; data: Buffer }>(base.map((f) => [f.path.toLowerCase(), f]));
  files.set(main.toLowerCase(), { path: main, data: Buffer.from(html, 'utf8') });
  if (body.files && typeof body.files === 'object') {
    for (const [path, v] of Object.entries<any>(body.files)) {
      if (path.toLowerCase() === main.toLowerCase()) continue;
      if (typeof v === 'string') files.set(path.toLowerCase(), { path, data: Buffer.from(v, 'utf8') });
      else if (v && typeof v.base64 === 'string') files.set(path.toLowerCase(), { path, data: Buffer.from(v.base64, 'base64') });
    }
  }
  return [...files.values()];
}

function analyseOr400(raw: { path: string; data: Buffer }[]): Analysed {
  try { return analyse(raw); } catch (e) { if (e instanceof PackageError) throw badRequest(e.message); throw e; }
}

const createSchema = z.object({ name: z.string().trim().min(1).max(120).optional(), kind: z.enum(KINDS).optional(), html: z.string().max(900_000), files: z.record(z.any()).optional(), note: z.string().max(300).optional() });

async function createTemplate(req: Request, raw: { path: string; data: Buffer }[], o: { name?: string; kind?: string; source: string; duplicatedFrom?: string | null; note?: string | null }) {
  const acct = accountId(req);
  const a = analyseOr400(raw);
  const name = (o.name || a.manifest.name || 'Untitled graphic').slice(0, 120);
  const { userId, label } = actor(req);
  const out = await tx(async (c) => {
    const t = (await c.query(`INSERT INTO gfx_templates(account_id, name, kind, source, duplicated_from, created_by)
       VALUES ($1,$2,$3,$4,$5,(SELECT id FROM users WHERE id = $6)) RETURNING *`,
      [acct, name, o.kind ?? 'other', o.source, o.duplicatedFrom ?? null, userId])).rows[0];
    const v = await insertVersion(c, t.id, a, userId, o.note ?? null);
    await writeAudit(c, { accountId: acct, userId, label, action: 'create', entityType: 'graphics_template', entityId: t.id, snapshot: { name, kind: t.kind, source: o.source } });
    return { t, v };
  });
  return { ...templateJson(out.t), status: templateStatus(null, out.v), draft: versionJson(out.v) };
}

const templateJson = (t: any) => ({
  id: t.id, name: t.name, kind: t.kind, source: t.source, owner: t.account_id ? 'account' : 'volt',
  duplicatedFrom: t.duplicated_from, archived: !!t.archived_at, createdAt: t.created_at, updatedAt: t.updated_at,
});

graphicsRouter.get('/templates', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const params: any[] = [acct];
  let where = `(t.account_id = $1 OR t.account_id IS NULL) AND t.archived_at IS NULL`;
  if (req.query.kind && KINDS.includes(String(req.query.kind) as any)) { params.push(String(req.query.kind)); where += ` AND t.kind = $${params.length}`; }
  if (req.query.source === 'volt') where += ` AND t.account_id IS NULL`;
  else if (req.query.source === 'imported') where += ` AND t.account_id IS NOT NULL`;
  if (req.query.q) { params.push('%' + String(req.query.q).replace(/[\\%_]/g, (c) => '\\' + c) + '%'); where += ` AND t.name ILIKE $${params.length}`; }
  const rows = await query<any>(`
    SELECT t.*,
      (SELECT row_to_json(v) FROM (SELECT id, version, manifest, checks, size_bytes, file_count, published_at, status, note, created_at FROM gfx_template_versions
         WHERE template_id = t.id AND status = 'published' ORDER BY version DESC LIMIT 1) v) AS latest,
      (SELECT row_to_json(d) FROM (SELECT id, version, manifest, checks, size_bytes, file_count, status, note, created_at, NULL AS published_at FROM gfx_template_versions
         WHERE template_id = t.id AND status = 'draft') d) AS draft,
      (SELECT count(*)::int FROM gfx_setups s WHERE s.template_id = t.id AND s.account_id = $1) AS setups,
      (SELECT count(*)::int FROM gfx_assignments a JOIN gfx_setups s ON s.id = a.setup_id LEFT JOIN gfx_state st ON st.assignment_id = a.id
         WHERE s.template_id = t.id AND a.account_id = $1 AND a.enabled) AS assignments
    FROM gfx_templates t WHERE ${where} ORDER BY t.account_id NULLS FIRST, t.name LIMIT 500`, params);
  res.json({ items: rows.map((r) => ({ ...templateJson(r), status: templateStatus(r.latest, r.draft), latest: versionJson(r.latest), draft: versionJson(r.draft), setups: r.setups, assignments: r.assignments })) });
}));

graphicsRouter.post('/templates', asyncHandler(async (req, res) => {
  const b = createSchema.parse(req.body ?? {});
  res.status(201).json(await createTemplate(req, pastedFiles(b), { name: b.name, kind: b.kind, source: 'paste', note: b.note ?? null }));
}));

const rawBody = express.raw({ type: () => true, limit: '26mb' });
graphicsRouter.post('/templates/import', rawBody, asyncHandler(async (req, res) => {
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!body.length) throw badRequest('Upload a .zip package or an .html file as the request body.');
  const kind = KINDS.includes(String(req.query.kind) as any) ? String(req.query.kind) : undefined;
  let raw;
  try { raw = filesFromUpload(body, String(req.query.filename ?? '')); } catch (e) { if (e instanceof PackageError) throw badRequest(e.message); throw e; }
  res.status(201).json(await createTemplate(req, raw, { name: req.query.name ? String(req.query.name).slice(0, 120) : undefined, kind, source: 'upload' }));
}));

graphicsRouter.get('/templates/:id', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const t = await templateFor(acct, uuidParam(req.params.id, 'template'));
  const versions = await query<any>(`SELECT * FROM gfx_template_versions WHERE template_id = $1 ORDER BY status = 'draft' DESC, version DESC`, [t.id]);
  const used = await query<any>(`
    SELECT s.id, s.name, s.version_id, v.version,
      (SELECT json_agg(json_build_object('id', a.id, 'channelId', a.channel_id, 'eventId', a.event_id, 'name', COALESCE(c.name, e.name),
         'onAir', COALESCE(st.on_air, false), 'runMode', a.run_mode)) FROM gfx_assignments a
         LEFT JOIN channels c ON c.id = a.channel_id LEFT JOIN events e ON e.id = a.event_id LEFT JOIN gfx_state st ON st.assignment_id = a.id
         WHERE a.setup_id = s.id) AS assignments
      FROM gfx_setups s JOIN gfx_template_versions v ON v.id = s.version_id
     WHERE s.template_id = $1 AND s.account_id = $2 ORDER BY s.name`, [t.id, acct]);
  res.json({ ...templateJson(t), status: templateStatus(versions.find((v) => v.status === 'published'), versions.find((v) => v.status === 'draft')), versions: versions.map(versionJson),
    usedBy: used.map((u) => ({ setupId: u.id, setupName: u.name, versionId: u.version_id, version: u.version, assignments: u.assignments ?? [] })) });
}));

graphicsRouter.patch('/templates/:id', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const t = await templateFor(acct, uuidParam(req.params.id, 'template'), true);
  const b = z.object({ name: z.string().trim().min(1).max(120).optional(), kind: z.enum(KINDS).optional() }).parse(req.body ?? {});
  const r = await one<any>(`UPDATE gfx_templates SET name = COALESCE($2, name), kind = COALESCE($3, kind), updated_at = now() WHERE id = $1 RETURNING *`, [t.id, b.name ?? null, b.kind ?? null]);
  const { userId, label } = actor(req);
  await writeAudit(null, { accountId: acct, userId, label, action: 'update', entityType: 'graphics_template', entityId: t.id,
    changes: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, { from: t[k], to: v }])) });
  res.json(templateJson(r));
}));

graphicsRouter.delete('/templates/:id', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const t = await templateFor(acct, uuidParam(req.params.id, 'template'), true);
  const n = await one<any>(`SELECT count(*)::int AS n FROM gfx_setups WHERE template_id = $1`, [t.id]);
  if (n?.n) throw conflict(`${n.n} setup${n.n === 1 ? ' uses' : 's use'} this template. Delete or move ${n.n === 1 ? 'it' : 'them'} first.`);
  await query(`UPDATE gfx_templates SET archived_at = now() WHERE id = $1`, [t.id]);
  const { userId, label } = actor(req);
  await writeAudit(null, { accountId: acct, userId, label, action: 'delete', entityType: 'graphics_template', entityId: t.id, snapshot: { name: t.name } });
  res.status(204).end();
}));

async function filesOf(versionId: string) {
  return query<any>(`SELECT path, content FROM gfx_files WHERE version_id = $1 ORDER BY path`, [versionId]);
}

graphicsRouter.post('/templates/:id/duplicate', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const t = await templateFor(acct, uuidParam(req.params.id, 'template'));
  const v = await one<any>(`SELECT * FROM gfx_template_versions WHERE template_id = $1 ORDER BY status = 'published' DESC, version DESC NULLS LAST LIMIT 1`, [t.id]);
  if (!v) throw conflict('This template has no files to copy.');
  const files = (await filesOf(v.id)).map((f) => ({ path: f.path, data: f.content as Buffer }));
  const name = String(req.body?.name ?? `${t.name} (copy)`).slice(0, 120);
  res.status(201).json(await createTemplate(req, files, { name, kind: t.kind, source: 'duplicate', duplicatedFrom: t.id }));
}));

graphicsRouter.put('/templates/:id/draft', rawBody, asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const t = await templateFor(acct, uuidParam(req.params.id, 'template'), true);
  let raw: { path: string; data: Buffer }[];
  if (!Buffer.isBuffer(req.body)) {
    // JSON (a paste) was already parsed by the app-wide JSON parser. With
    // keep: true (the console's code editor) the other files of the current
    // draft, or else the latest version, stay in the package.
    let base: { path: string; data: Buffer }[] = [];
    if (req.body?.keep === true) {
      const from = await one<any>(`SELECT id FROM gfx_template_versions WHERE template_id = $1 ORDER BY status = 'draft' DESC, version DESC NULLS LAST LIMIT 1`, [t.id]);
      if (from) base = (await filesOf(from.id)).map((f) => ({ path: f.path, data: f.content as Buffer }));
    }
    raw = pastedFiles(req.body, base);
  } else {
    try { raw = filesFromUpload(req.body as Buffer, String(req.query.filename ?? '')); } catch (e) { if (e instanceof PackageError) throw badRequest(e.message); throw e; }
  }
  const a = analyseOr400(raw);
  const { userId } = actor(req);
  const v = await tx((c) => insertVersion(c, t.id, a, userId, req.query.note ? String(req.query.note).slice(0, 300) : null));
  res.json(versionJson(v));
}));

// ---- style: change a template's colours and fonts (REQ section 15) -------------

/**
 * GET  /api/graphics/templates/:id/versions/:vid/style   the colours and fonts it uses
 * POST /api/graphics/templates/:id/style                 { versionId, changes: { tokenId: value }, addFonts: [{ family, filename, base64 }] }
 *      writes a new draft from that version with the changes applied, checked like any draft.
 *      Volt templates are read-only: duplicate first (the console's "Customise a copy").
 */
graphicsRouter.get('/templates/:id/versions/:vid/style', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const t = await templateFor(acct, uuidParam(req.params.id, 'template'));
  const v = await one<any>(`SELECT id FROM gfx_template_versions WHERE id = $1 AND template_id = $2`, [uuidParam(req.params.vid, 'version'), t.id]);
  if (!v) throw notFound('No version with that id');
  const files = (await filesOf(v.id)).map((f) => ({ path: f.path, data: f.content as Buffer }));
  res.json({ versionId: v.id, ...readStyle(files) });
}));

const styleSchema = z.object({
  versionId: z.string().uuid(),
  changes: z.record(z.string().max(120)).default({}),
  addFonts: z.array(z.object({ family: z.string().max(60), filename: z.string().max(120), base64: z.string().max(6_000_000) })).max(6).default([]),
});
graphicsRouter.post('/templates/:id/style', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const t = await templateFor(acct, uuidParam(req.params.id, 'template'), true);
  const b = styleSchema.parse(req.body ?? {});
  const v = await one<any>(`SELECT id, version, status FROM gfx_template_versions WHERE id = $1 AND template_id = $2`, [b.versionId, t.id]);
  if (!v) throw notFound('No version with that id');
  if (!Object.keys(b.changes).length && !b.addFonts.length) throw badRequest('Nothing to change.');
  const files = (await filesOf(v.id)).map((f) => ({ path: f.path, data: f.content as Buffer }));
  let raw;
  try { raw = applyStyle(files, b.changes, b.addFonts.map((f) => ({ family: f.family.trim(), filename: f.filename, data: Buffer.from(f.base64, 'base64') }))); }
  catch (e) { if (e instanceof StyleError) throw badRequest(e.message); throw e; }
  const a = analyseOr400(raw);
  const { userId, label } = actor(req);
  const nv = await tx(async (c) => {
    const row = await insertVersion(c, t.id, a, userId, `Style: ${Object.keys(b.changes).length} change${Object.keys(b.changes).length === 1 ? '' : 's'}${b.addFonts.length ? `, ${b.addFonts.length} font${b.addFonts.length === 1 ? '' : 's'} added` : ''} (from ${v.status === 'draft' ? 'the draft' : 'v' + v.version})`);
    await writeAudit(c, { accountId: acct, userId, label, action: 'update', entityType: 'graphics_template', entityId: t.id, snapshot: { style: b.changes, fontsAdded: b.addFonts.map((f) => f.family) } });
    return row;
  });
  res.json(versionJson(nv));
}));

graphicsRouter.delete('/templates/:id/draft', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const t = await templateFor(acct, uuidParam(req.params.id, 'template'), true);
  const used = await one<any>(`SELECT count(*)::int AS n FROM gfx_setups s JOIN gfx_template_versions v ON v.id = s.version_id WHERE v.template_id = $1 AND v.status = 'draft'`, [t.id]);
  if (used?.n) throw conflict('A setup is trying out this draft. Move it to a published version first.');
  await query(`DELETE FROM gfx_template_versions WHERE template_id = $1 AND status = 'draft'`, [t.id]);
  res.status(204).end();
}));

graphicsRouter.post('/templates/:id/draft/publish', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const t = await templateFor(acct, uuidParam(req.params.id, 'template'), true);
  const { userId, label } = actor(req);
  const v = await tx(async (c) => {
    const d = (await c.query(`SELECT * FROM gfx_template_versions WHERE template_id = $1 AND status = 'draft' FOR UPDATE`, [t.id])).rows[0];
    if (!d) throw notFound('There is no draft to publish.');
    const errors = (d.checks ?? []).filter((x: any) => x.level === 'error');
    if (errors.length) throw Object.assign(conflict(`Fix ${errors.length === 1 ? 'this' : 'these'} before publishing: ${errors.map((e: any) => e.title).join('; ')}.`), { checks: d.checks });
    const n = (await c.query(`SELECT COALESCE(max(version), 0) + 1 AS n FROM gfx_template_versions WHERE template_id = $1`, [t.id])).rows[0].n;
    const note = req.body?.note ? String(req.body.note).slice(0, 300) : d.note;
    const r = (await c.query(`UPDATE gfx_template_versions SET status = 'published', version = $2, note = $3, published_at = now(),
        published_by = (SELECT id FROM users WHERE id = $4) WHERE id = $1 RETURNING *`, [d.id, n, note, userId])).rows[0];
    await c.query(`UPDATE gfx_templates SET updated_at = now() WHERE id = $1`, [t.id]);
    await writeAudit(c, { accountId: acct, userId, label, action: 'update', entityType: 'graphics_template', entityId: t.id, changes: { version: { from: n - 1, to: n } } });
    return r;
  });
  res.json(versionJson(v));
}));

graphicsRouter.get('/templates/:id/versions/:vid/files', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const t = await templateFor(acct, uuidParam(req.params.id, 'template'));
  const rows = await query<any>(`SELECT f.path, f.content_type, f.size_bytes, f.sha256 FROM gfx_files f JOIN gfx_template_versions v ON v.id = f.version_id
                                  WHERE v.id = $1 AND v.template_id = $2 ORDER BY f.path`, [uuidParam(req.params.vid, 'version'), t.id]);
  res.json({ items: rows.map((r) => ({ path: r.path, contentType: r.content_type, sizeBytes: r.size_bytes, sha256: r.sha256 })) });
}));

graphicsRouter.get('/templates/:id/versions/:vid/source', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const t = await templateFor(acct, uuidParam(req.params.id, 'template'));
  const vid = uuidParam(req.params.vid, 'version');
  const v = await one<any>(`SELECT manifest FROM gfx_template_versions WHERE id = $1 AND template_id = $2`, [vid, t.id]);
  if (!v) throw notFound('No version with that id');
  // An OGraf package's code is its main module; Volt's host page is not stored.
  const path = typeof req.query.path === 'string' && req.query.path ? String(req.query.path)
    : v.manifest?.contract === 'ograf' && v.manifest?.ograf?.main ? v.manifest.ograf.main : 'index.html';
  const f = await one<any>(`SELECT f.content FROM gfx_files f WHERE f.version_id = $1 AND f.path = $2`, [vid, path]);
  if (!f) throw notFound(`No ${path} in that version`);
  res.json({ path, html: (f.content as Buffer).toString('utf8') });
}));

graphicsRouter.get('/templates/:id/versions/:vid/download', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const t = await templateFor(acct, uuidParam(req.params.id, 'template'));
  const v = await one<any>(`SELECT * FROM gfx_template_versions WHERE id = $1 AND template_id = $2`, [uuidParam(req.params.vid, 'version'), t.id]);
  if (!v) throw notFound('No such version');
  const zip = writeZip((await filesOf(v.id)).map((f) => ({ path: f.path, data: f.content })));
  const slug = t.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'graphic';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${slug}-${v.version ? 'v' + v.version : 'draft'}.zip"`);
  res.send(zip);
}));

// ---- setups -----------------------------------------------------------------------

const binding = z.object({
  source: z.enum(['text', 'image', 'feed', 'guide', 'operator', 'api']),
  value: z.any().optional(), imageId: z.string().uuid().optional(), sourceId: z.string().uuid().optional(),
  path: z.string().max(200).optional(),
  guide: z.enum(['now_title', 'next_title', 'now_subtitle', 'next_subtitle', 'now_start', 'next_start']).optional(),
});
const placement = z.object({
  anchor: z.enum(['top_left', 'top', 'top_right', 'left', 'center', 'right', 'bottom_left', 'bottom', 'bottom_right']).optional(),
  x: z.number().min(-4000).max(4000).optional(), y: z.number().min(-4000).max(4000).optional(),
  scale: z.number().min(0.25).max(4).optional(), layer: z.number().int().min(0).max(20).optional(),
}).partial();
const setupSchema = z.object({
  name: z.string().trim().min(1).max(120), note: z.string().max(300).optional().nullable(),
  versionId: z.string().uuid(), fields: z.record(binding).default({}), placement: placement.default({}),
});

async function versionForSetup(acct: string, versionId: string) {
  const v = await one<any>(`SELECT v.*, t.account_id FROM gfx_template_versions v JOIN gfx_templates t ON t.id = v.template_id
                             WHERE v.id = $1 AND (t.account_id = $2 OR t.account_id IS NULL)`, [versionId, acct]);
  if (!v) throw notFound('No template version with that id');
  return v;
}

async function validateBindings(acct: string, manifest: any, fields: Record<string, z.infer<typeof binding>>) {
  const known = new Set((manifest?.fields ?? []).map((f: any) => f.id));
  const errs: string[] = [];
  for (const [k, b] of Object.entries(fields)) {
    if (!known.has(k)) errs.push(`${k}: the template has no such field`);
    if (b.source === 'feed' && !b.sourceId) errs.push(`${k}: choose a data source`);
    if (b.source === 'image' && !b.imageId) errs.push(`${k}: choose an image`);
  }
  const srcIds = [...new Set(Object.values(fields).map((b) => b.sourceId).filter(Boolean))] as string[];
  if (srcIds.length) {
    const ok = await query<any>(`SELECT id FROM gfx_data_sources WHERE account_id = $1 AND id = ANY($2::uuid[])`, [acct, srcIds]);
    for (const id of srcIds) if (!ok.some((r) => r.id === id)) errs.push(`data source ${id} is not in this account`);
  }
  const imgIds = [...new Set(Object.values(fields).map((b) => b.imageId).filter(Boolean))] as string[];
  if (imgIds.length) {
    const ok = await query<any>(`SELECT id FROM media_files WHERE account_id = $1 AND id = ANY($2::uuid[])`, [acct, imgIds]);
    for (const id of imgIds) if (!ok.some((r) => r.id === id)) errs.push(`image ${id} is not in this account's Image Library`);
  }
  if (errs.length) throw badRequest(errs.join('; '));
}

const SETUP_SQL = `SELECT s.*, t.name AS template_name, t.kind AS template_kind, v.version, v.status AS version_status, v.manifest,
   (SELECT max(version) FROM gfx_template_versions WHERE template_id = s.template_id AND status = 'published') AS latest_version,
   (SELECT id FROM gfx_template_versions WHERE template_id = s.template_id AND status = 'published' ORDER BY version DESC LIMIT 1) AS latest_version_id,
   (SELECT json_agg(json_build_object('id', a.id, 'channelId', a.channel_id, 'eventId', a.event_id, 'name', COALESCE(c.name, e.name), 'runMode', a.run_mode,
       'targets', a.targets, 'onAir', COALESCE(st.on_air, false)) ORDER BY a.created_at)
      FROM gfx_assignments a LEFT JOIN channels c ON c.id = a.channel_id LEFT JOIN events e ON e.id = a.event_id LEFT JOIN gfx_state st ON st.assignment_id = a.id
     WHERE a.setup_id = s.id) AS assignments
  FROM gfx_setups s JOIN gfx_templates t ON t.id = s.template_id JOIN gfx_template_versions v ON v.id = s.version_id`;

const setupJson = (s: any) => ({
  id: s.id, name: s.name, note: s.note, templateId: s.template_id, templateName: s.template_name, templateKind: s.template_kind,
  versionId: s.version_id, version: s.version, versionStatus: s.version_status, latestVersion: s.latest_version, latestVersionId: s.latest_version_id,
  upgradeAvailable: s.latest_version != null && (s.version == null || s.latest_version > s.version),
  fields: s.fields, placement: s.placement, templateFields: s.manifest?.fields ?? [], canvas: s.manifest?.canvas ?? [1920, 1080],
  sources: [...new Set(Object.values<any>(s.fields ?? {}).map((b) => b.source))],
  assignments: s.assignments ?? [], createdAt: s.created_at, updatedAt: s.updated_at,
  templateUrl: `/gfx/${s.version_id}/index.html`,
});

graphicsRouter.get('/setups', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const params: any[] = [acct]; let where = 's.account_id = $1';
  if (req.query.template_id) { params.push(uuidParam(req.query.template_id, 'template')); where += ` AND s.template_id = $${params.length}`; }
  const rows = await query<any>(`${SETUP_SQL} WHERE ${where} ORDER BY s.updated_at DESC LIMIT 500`, params);
  res.json({ items: rows.map(setupJson) });
}));

graphicsRouter.get('/setups/:id', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const s = await one<any>(`${SETUP_SQL} WHERE s.account_id = $1 AND s.id = $2`, [acct, uuidParam(req.params.id, 'setup')]);
  if (!s) throw notFound('No setup with that id');
  res.json(setupJson(s));
}));

graphicsRouter.post('/setups', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const b = setupSchema.parse(req.body ?? {});
  const v = await versionForSetup(acct, b.versionId);
  await validateBindings(acct, v.manifest, b.fields);
  const { userId, label } = actor(req);
  const s = await one<any>(`INSERT INTO gfx_setups(account_id, name, note, template_id, version_id, fields, placement, created_by)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,(SELECT id FROM users WHERE id = $8)) RETURNING id`,
    [acct, b.name, b.note ?? null, v.template_id, v.id, JSON.stringify(b.fields), JSON.stringify(b.placement), userId]);
  await writeAudit(null, { accountId: acct, userId, label, action: 'create', entityType: 'graphics_setup', entityId: s!.id, snapshot: { name: b.name, versionId: v.id } });
  res.status(201).json(setupJson(await one<any>(`${SETUP_SQL} WHERE s.id = $1`, [s!.id])));
}));

graphicsRouter.patch('/setups/:id', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const cur = await one<any>(`SELECT * FROM gfx_setups WHERE id = $1 AND account_id = $2`, [uuidParam(req.params.id, 'setup'), acct]);
  if (!cur) throw notFound('No setup with that id');
  const b = setupSchema.partial().parse(req.body ?? {});
  let versionId = cur.version_id; let templateId = cur.template_id; let manifest: any;
  if (b.versionId && b.versionId !== cur.version_id) {
    const v = await versionForSetup(acct, b.versionId);
    if (v.template_id !== cur.template_id) throw badRequest('A setup can move between versions of its template, not to another template.');
    versionId = v.id; templateId = v.template_id; manifest = v.manifest;
  } else manifest = (await one<any>(`SELECT manifest FROM gfx_template_versions WHERE id = $1`, [cur.version_id]))?.manifest;
  const fields = b.fields ?? cur.fields;
  // Moving version: bindings for fields the new version no longer has are dropped, and said so.
  const known = new Set((manifest?.fields ?? []).map((f: any) => f.id));
  const dropped = Object.keys(fields).filter((k) => !known.has(k));
  const kept = Object.fromEntries(Object.entries(fields).filter(([k]) => known.has(k)));
  if (!b.versionId || b.versionId === cur.version_id) await validateBindings(acct, manifest, fields as any);
  else await validateBindings(acct, manifest, kept as any);
  await query(`UPDATE gfx_setups SET name = $2, note = $3, version_id = $4, template_id = $5, fields = $6::jsonb, placement = $7::jsonb, updated_at = now() WHERE id = $1`,
    [cur.id, b.name ?? cur.name, b.note !== undefined ? b.note : cur.note, versionId, templateId, JSON.stringify(kept), JSON.stringify(b.placement ?? cur.placement)]);
  const { userId, label } = actor(req);
  await writeAudit(null, { accountId: acct, userId, label, action: 'update', entityType: 'graphics_setup', entityId: cur.id,
    changes: Object.fromEntries(Object.keys(b).map((k) => [k, { from: k === 'versionId' ? cur.version_id : cur[k], to: (b as any)[k] }])) });
  await publishForSetup(acct, cur.id);
  res.json({ ...setupJson(await one<any>(`${SETUP_SQL} WHERE s.id = $1`, [cur.id])), droppedFields: dropped });
}));

graphicsRouter.delete('/setups/:id', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const cur = await one<any>(`SELECT * FROM gfx_setups WHERE id = $1 AND account_id = $2`, [uuidParam(req.params.id, 'setup'), acct]);
  if (!cur) throw notFound('No setup with that id');
  const r = await one<any>(`SELECT count(*)::int AS n FROM gfx_rundown_items WHERE setup_id = $1`, [cur.id]);
  if (r?.n) throw conflict(`${r.n} rundown item${r.n === 1 ? ' uses' : 's use'} this setup. Remove ${r.n === 1 ? 'it' : 'them'} first.`);
  const onAir = await one<any>(`SELECT count(*)::int AS n FROM gfx_assignments a JOIN gfx_state st ON st.assignment_id = a.id WHERE a.setup_id = $1 AND st.on_air`, [cur.id]);
  if (onAir?.n) throw conflict('This setup is on air. Take it off first.');
  await query(`DELETE FROM gfx_setups WHERE id = $1`, [cur.id]);
  const { userId, label } = actor(req);
  await writeAudit(null, { accountId: acct, userId, label, action: 'delete', entityType: 'graphics_setup', entityId: cur.id, snapshot: { name: cur.name } });
  res.status(204).end();
}));

// ---- data sources ---------------------------------------------------------------

const sourceSchema = z.object({
  name: z.string().trim().min(1).max(120), kind: z.enum(['json', 'rss', 'push']),
  url: z.string().url().max(2000).optional().nullable(), everySec: z.number().int().min(1).max(3600).optional(),
  onStale: z.enum(['hold', 'hide']).optional(), staleAfterSec: z.number().int().min(5).max(86400).optional(),
});
const sourceJson = (s: any) => ({
  id: s.id, name: s.name, kind: s.kind, url: s.url, everySec: s.every_sec, onStale: s.on_stale, staleAfterSec: s.stale_after_sec,
  lastOkAt: s.last_ok_at, lastError: s.last_error, lastPolledAt: s.last_polled_at, payload: s.payload,
  status: s.last_error ? 'error' : s.kind === 'push' ? (s.last_ok_at ? 'ok' : 'waiting') : !s.last_ok_at ? 'waiting'
    : Date.now() - new Date(s.last_ok_at).getTime() > s.stale_after_sec * 1000 ? 'stale' : 'ok',
});

graphicsRouter.get('/sources', asyncHandler(async (req, res) => {
  const rows = await query<any>(`SELECT * FROM gfx_data_sources WHERE account_id = $1 ORDER BY name`, [accountId(req)]);
  res.json({ items: rows.map(sourceJson) });
}));

graphicsRouter.post('/sources', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const b = sourceSchema.parse(req.body ?? {});
  if (b.kind !== 'push') { if (!b.url) throw badRequest('A JSON or RSS source needs a URL.'); await assertPublicUrl(b.url); }
  const r = await one<any>(`INSERT INTO gfx_data_sources(account_id, name, kind, url, every_sec, on_stale, stale_after_sec)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [acct, b.name, b.kind, b.kind === 'push' ? null : b.url, b.everySec ?? (b.kind === 'rss' ? 60 : 5), b.onStale ?? 'hold', b.staleAfterSec ?? 60]);
  const { userId, label } = actor(req);
  await writeAudit(null, { accountId: acct, userId, label, action: 'create', entityType: 'graphics_source', entityId: r!.id, snapshot: { name: b.name, kind: b.kind } });
  res.status(201).json(sourceJson(r));
}));

graphicsRouter.patch('/sources/:id', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const cur = await one<any>(`SELECT * FROM gfx_data_sources WHERE id = $1 AND account_id = $2`, [uuidParam(req.params.id, 'data source'), acct]);
  if (!cur) throw notFound('No data source with that id');
  const b = sourceSchema.partial().parse(req.body ?? {});
  if (b.url && cur.kind !== 'push') await assertPublicUrl(b.url);
  const r = await one<any>(`UPDATE gfx_data_sources SET name = $2, url = $3, every_sec = $4, on_stale = $5, stale_after_sec = $6, updated_at = now() WHERE id = $1 RETURNING *`,
    [cur.id, b.name ?? cur.name, cur.kind === 'push' ? null : (b.url ?? cur.url), b.everySec ?? cur.every_sec, b.onStale ?? cur.on_stale, b.staleAfterSec ?? cur.stale_after_sec]);
  // hold or hide on a stale feed changes what its graphics show now
  if (b.onStale !== undefined || b.staleAfterSec !== undefined) await publishForSource(acct, cur.id);
  res.json(sourceJson(r));
}));

graphicsRouter.delete('/sources/:id', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const cur = await one<any>(`SELECT * FROM gfx_data_sources WHERE id = $1 AND account_id = $2`, [uuidParam(req.params.id, 'data source'), acct]);
  if (!cur) throw notFound('No data source with that id');
  const used = await one<any>(`SELECT count(*)::int AS n FROM gfx_setups WHERE account_id = $1 AND fields::text LIKE '%' || $2 || '%'`, [acct, cur.id]);
  if (used?.n) throw conflict(`${used.n} setup${used.n === 1 ? ' reads' : 's read'} from this source. Change ${used.n === 1 ? 'it' : 'them'} first.`);
  await query(`DELETE FROM gfx_data_sources WHERE id = $1`, [cur.id]);
  res.status(204).end();
}));

graphicsRouter.post('/sources/:id/test', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const cur = await one<any>(`SELECT * FROM gfx_data_sources WHERE id = $1 AND account_id = $2`, [uuidParam(req.params.id, 'data source'), acct]);
  if (!cur) throw notFound('No data source with that id');
  if (cur.kind === 'push') return res.json({ ok: !!cur.payload, payload: cur.payload, note: 'A push source shows the last payload it was sent.' });
  try {
    const payload = await fetchFeed(cur.kind, cur.url);
    await acceptPayload(acct, cur.id, payload, who(req));
    res.json({ ok: true, payload });
  } catch (e: any) {
    await query(`UPDATE gfx_data_sources SET last_error = $2, last_polled_at = now() WHERE id = $1`, [cur.id, String(e?.message ?? e).slice(0, 300)]);
    res.json({ ok: false, error: String(e?.message ?? e) });
  }
}));

graphicsRouter.post('/sources/:id/push', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const cur = await one<any>(`SELECT * FROM gfx_data_sources WHERE id = $1 AND account_id = $2`, [uuidParam(req.params.id, 'data source'), acct]);
  if (!cur) throw notFound('No data source with that id');
  if (cur.kind !== 'push') throw badRequest('Only a push source accepts pushed data. This one is polled.');
  if (req.body == null || typeof req.body !== 'object') throw badRequest('Send the payload as a JSON object.');
  res.json(await acceptPayload(acct, cur.id, req.body, who(req)));
}));

// ---- assignments and live state ----------------------------------------------

const ruleSchema = z.object({
  genre: z.union([z.string().max(80), z.array(z.string().max(80)).max(20)]).optional(),
  titleContains: z.string().max(120).optional(),
  days: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  from: z.string().regex(/^\d{1,2}:\d{2}$/).optional(), to: z.string().regex(/^\d{1,2}:\d{2}$/).optional(),
  tz: z.string().max(64).optional(),
  at: z.enum(['programme_start', 'programme_end']).optional(),
  offsetSec: z.number().int().min(0).max(21600).optional(), durationSec: z.number().int().min(1).max(3600).optional(),
}).strict();
const assignSchema = z.object({
  setupId: z.string().uuid(), channelId: z.string().uuid().optional().nullable(), eventId: z.string().uuid().optional().nullable(),
  targets: z.enum(['player', 'burn', 'both']).default('player'),
  runMode: z.enum(['always', 'rule', 'trigger', 'manual']).default('manual'),
  rule: ruleSchema.default({}), clearInAds: z.boolean().default(true), enabled: z.boolean().default(true),
});

const assignmentJson = (a: any) => ({
  id: a.id, setupId: a.setup_id, setupName: a.setup_name, templateName: a.template_name, version: a.version,
  channelId: a.channel_id, eventId: a.event_id, targetName: a.target_name, targets: a.targets, runMode: a.run_mode, rule: a.rule,
  clearInAds: a.clear_in_ads, enabled: a.enabled, describe: describeRun({ run_mode: a.run_mode, rule: a.rule ?? {}, clear_in_ads: a.clear_in_ads }),
  onAir: !!a.on_air, createdAt: a.created_at,
});
const ASSIGN_LIST_SQL = `SELECT a.*, s.name AS setup_name, t.name AS template_name, v.version, COALESCE(c.name, e.name) AS target_name, st.on_air
  FROM gfx_assignments a JOIN gfx_setups s ON s.id = a.setup_id JOIN gfx_templates t ON t.id = s.template_id JOIN gfx_template_versions v ON v.id = s.version_id
  LEFT JOIN channels c ON c.id = a.channel_id LEFT JOIN events e ON e.id = a.event_id LEFT JOIN gfx_state st ON st.assignment_id = a.id`;

graphicsRouter.get('/assignments', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const params: any[] = [acct]; let where = 'a.account_id = $1';
  for (const [q, col, what] of [['channel_id', 'a.channel_id', 'channel'], ['event_id', 'a.event_id', 'event'], ['setup_id', 'a.setup_id', 'setup']] as const) {
    if (req.query[q]) { params.push(uuidParam(req.query[q], what)); where += ` AND ${col} = $${params.length}`; }
  }
  const rows = await query<any>(`${ASSIGN_LIST_SQL} WHERE ${where} ORDER BY COALESCE(c.name, e.name), a.created_at LIMIT 1000`, params);
  const shown = await impressionCounts(acct, rows.filter((r) => r.targets !== 'burn').map((r) => r.id));
  res.json({ items: rows.map((r) => ({ ...assignmentJson(r), impressions24h: r.targets === 'burn' ? null : shown.get(r.id) ?? 0 })) });
}));

graphicsRouter.post('/assignments', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const b = assignSchema.parse(req.body ?? {});
  const setup = await one<any>(`SELECT id FROM gfx_setups WHERE id = $1 AND account_id = $2`, [b.setupId, acct]);
  if (!setup) throw notFound('No setup with that id');
  const target = await loadTarget(acct, { channelId: b.channelId, eventId: b.eventId });
  assertTargetsAllowed(target, b.targets);
  if (b.runMode === 'trigger' && !b.rule.at) b.rule.at = 'programme_start';
  const r = await one<any>(`INSERT INTO gfx_assignments(account_id, setup_id, channel_id, event_id, targets, run_mode, rule, clear_in_ads, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING id`,
    [acct, b.setupId, target.kind === 'channel' ? target.id : null, target.kind === 'event' ? target.id : null, b.targets, b.runMode, JSON.stringify(b.rule), b.clearInAds, b.enabled]);
  const { userId, label } = actor(req);
  await writeAudit(null, { accountId: acct, userId, label, action: 'create', entityType: 'graphics_assignment', entityId: r!.id, snapshot: { setupId: b.setupId, target: target.name, runMode: b.runMode } });
  publishGfx(acct, { channelId: target.kind === 'channel' ? target.id : null, eventId: target.kind === 'event' ? target.id : null }, 'assignment', r!.id);
  res.status(201).json(assignmentJson(await one<any>(`${ASSIGN_LIST_SQL} WHERE a.id = $1`, [r!.id])));
}));

graphicsRouter.patch('/assignments/:id', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const cur = await one<any>(`SELECT * FROM gfx_assignments WHERE id = $1 AND account_id = $2`, [uuidParam(req.params.id, 'assignment'), acct]);
  if (!cur) throw notFound('No graphic assignment with that id');
  const b = assignSchema.omit({ setupId: true, channelId: true, eventId: true }).partial().parse(req.body ?? {});
  if (b.targets) assertTargetsAllowed(await loadTarget(acct, { channelId: cur.channel_id, eventId: cur.event_id }), b.targets);
  await query(`UPDATE gfx_assignments SET targets = $2, run_mode = $3, rule = $4::jsonb, clear_in_ads = $5, enabled = $6, updated_at = now() WHERE id = $1`,
    [cur.id, b.targets ?? cur.targets, b.runMode ?? cur.run_mode, JSON.stringify(b.rule ?? cur.rule), b.clearInAds ?? cur.clear_in_ads, b.enabled ?? cur.enabled]);
  const { userId, label } = actor(req);
  await writeAudit(null, { accountId: acct, userId, label, action: 'update', entityType: 'graphics_assignment', entityId: cur.id,
    changes: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, { from: cur[k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase())], to: v }])) });
  publishGfx(acct, { channelId: cur.channel_id, eventId: cur.event_id }, 'assignment', cur.id);
  res.json(assignmentJson(await one<any>(`${ASSIGN_LIST_SQL} WHERE a.id = $1`, [cur.id])));
}));

graphicsRouter.delete('/assignments/:id', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const cur = await one<any>(`SELECT a.*, st.on_air FROM gfx_assignments a LEFT JOIN gfx_state st ON st.assignment_id = a.id WHERE a.id = $1 AND a.account_id = $2`, [uuidParam(req.params.id, 'assignment'), acct]);
  if (!cur) throw notFound('No graphic assignment with that id');
  if (cur.on_air) throw conflict('This graphic is on air. Take it off first.');
  await query(`DELETE FROM gfx_assignments WHERE id = $1`, [cur.id]);
  const { userId, label } = actor(req);
  await writeAudit(null, { accountId: acct, userId, label, action: 'delete', entityType: 'graphics_assignment', entityId: cur.id, snapshot: { setupId: cur.setup_id } });
  publishGfx(acct, { channelId: cur.channel_id, eventId: cur.event_id }, 'assignment', cur.id);
  res.status(204).end();
}));

function targetQuery(req: Request) {
  return { channelId: req.query.channel_id ? uuidParam(req.query.channel_id, 'channel') : null, eventId: req.query.event_id ? uuidParam(req.query.event_id, 'event') : null };
}

graphicsRouter.get('/live', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const target = await loadTarget(acct, targetQuery(req));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ target: { kind: target.kind, id: target.id, name: target.name, live: target.live, workflow: target.workflow }, at: new Date(), items: await liveFor(acct, target) });
}));

graphicsRouter.get('/plan', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const target = await loadTarget(acct, targetQuery(req));
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(new Date().setUTCHours(0, 0, 0, 0));
  const to = req.query.to ? new Date(String(req.query.to)) : new Date(from.getTime() + 86400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw badRequest('from and to must be dates, to after from');
  if (to.getTime() - from.getTime() > 8 * 86400_000) throw badRequest('a plan covers at most 8 days');
  res.json({ from, to, ...(await planFor(acct, target, from, to)) });
}));

graphicsRouter.get('/assignments/:id/state', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await liveOne(accountId(req), uuidParam(req.params.id, 'assignment')));
}));

graphicsRouter.patch('/assignments/:id/state', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const b = z.object({ values: z.record(z.any()).default({}), release: z.array(z.string().max(64)).max(100).default([]) }).parse(req.body ?? {});
  const id = uuidParam(req.params.id, 'assignment');
  const r = await setValues(acct, id, b.values, who(req), b.release);
  const state = await liveOne(acct, id);
  if (r.changed) void recordStream(acct, { channelId: state.channelId, eventId: state.eventId });
  res.json({ ...r, state });
}));

graphicsRouter.post('/assignments/:id/air', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const b = z.object({ on: z.boolean(), forSec: z.number().int().min(1).max(3600).optional() }).parse(req.body ?? {});
  const id = uuidParam(req.params.id, 'assignment');
  const r = await setAir(acct, id, b.on, who(req), { forSec: b.forSec ?? null });
  const state = await liveOne(acct, id);
  if (r.changed) void recordStream(acct, { channelId: state.channelId, eventId: state.eventId });
  res.json({ ...r, state });
}));

graphicsRouter.get('/log', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const params: any[] = [acct]; let where = 'l.account_id = $1';
  if (req.query.assignment_id) { params.push(uuidParam(req.query.assignment_id, 'assignment')); where += ` AND l.assignment_id = $${params.length}`; }
  else if (req.query.event_id) { params.push(uuidParam(req.query.event_id, 'event')); where += ` AND (l.event_id = $${params.length})`; }
  else if (req.query.channel_id) { params.push(uuidParam(req.query.channel_id, 'channel')); where += ` AND l.assignment_id IN (SELECT id FROM gfx_assignments WHERE channel_id = $${params.length})`; }
  const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 50) || 50));
  const rows = await query<any>(`SELECT l.*, s.name AS setup_name, u.email AS actor_email FROM gfx_state_log l
    LEFT JOIN gfx_assignments a ON a.id = l.assignment_id LEFT JOIN gfx_setups s ON s.id = a.setup_id
    LEFT JOIN users u ON u.id::text = l.actor
    WHERE ${where} ORDER BY l.at DESC, l.id DESC LIMIT ${limit}`, params);
  res.json({ items: rows.map((r) => ({ at: r.at, actor: r.actor_email ?? r.actor, action: r.action, field: r.field, old: r.old_value, new: r.new_value, assignmentId: r.assignment_id, setupName: r.setup_name })) });
}));

// ---- rundowns -------------------------------------------------------------------

const itemSchema = z.object({
  segment: z.string().max(80).default(''), title: z.string().trim().min(1).max(160), setupId: z.string().uuid(),
  values: z.record(z.any()).default({}), cue: z.any().default({ kind: 'manual' }),
  staysSec: z.number().int().min(1).max(86400).nullable().optional(), position: z.number().int().optional(),
});
const itemJson = (i: any) => ({
  id: i.id, position: i.position, segment: i.segment, title: i.title, setupId: i.setup_id, setupName: i.setup_name, templateName: i.template_name,
  values: i.values, cue: i.cue, staysSec: i.stays_sec, status: i.status, takenAt: i.taken_at,
  needsContent: (i.required ?? []).some((f: string) => i.values?.[f] == null || i.values?.[f] === ''),
});
const ITEMS_SQL = `SELECT i.*, s.name AS setup_name, t.name AS template_name,
   ARRAY(SELECT k FROM jsonb_each(s.fields) AS f(k, b) WHERE b->>'source' IN ('operator','api') AND COALESCE(b->>'value','') = '') AS required
  FROM gfx_rundown_items i JOIN gfx_setups s ON s.id = i.setup_id JOIN gfx_templates t ON t.id = s.template_id`;

async function rundownJson(acct: string, eventId: string) {
  const target = await loadTarget(acct, { eventId });
  const rows = await query<any>(`${ITEMS_SQL} WHERE i.event_id = $1 AND i.account_id = $2 ORDER BY i.position, i.created_at`, [eventId, acct]);
  const items = rows.map(itemJson);
  const nm = nextManual(rows.map((r) => ({ ...r, cue: r.cue, taken_at: r.taken_at })));
  return { event: { id: target.id, name: target.name, live: target.live, start: target.start, end: target.end, workflow: target.workflow },
    items, nextId: nm?.id ?? null, onAir: items.filter((i) => i.status === 'on_air').map((i) => i.id) };
}

/** A rundown edit: announce it (other operators' rundowns re-read), then answer with the rundown. */
async function rundownChanged(acct: string, eventId: string) {
  publishGfx(acct, { eventId }, 'rundown');
  return rundownJson(acct, eventId);
}

async function assertSetup(acct: string, setupId: string) {
  const s = await one<any>(`SELECT id FROM gfx_setups WHERE id = $1 AND account_id = $2`, [setupId, acct]);
  if (!s) throw badRequest('No setup with that id in this account');
}
function cueOr400(raw: any) { try { return normCue(raw); } catch (e: any) { throw badRequest(e.message); } }

graphicsRouter.get('/rundowns/:eventId', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await rundownJson(accountId(req), uuidParam(req.params.eventId, 'event')));
}));

graphicsRouter.post('/rundowns/:eventId/items', asyncHandler(async (req, res) => {
  const acct = accountId(req); const eventId = uuidParam(req.params.eventId, 'event');
  await loadTarget(acct, { eventId });
  const b = itemSchema.parse(req.body ?? {});
  await assertSetup(acct, b.setupId);
  const cue = cueOr400(b.cue);
  if (cue.kind === 'repeat' && !b.staysSec) throw badRequest('A repeating graphic needs how long it stays on.');
  await tx(async (c) => {
    let pos = b.position;
    if (pos == null) pos = (await c.query(`SELECT COALESCE(max(position), 0) + 1 AS n FROM gfx_rundown_items WHERE event_id = $1`, [eventId])).rows[0].n;
    else await c.query(`UPDATE gfx_rundown_items SET position = position + 1 WHERE event_id = $1 AND position >= $2`, [eventId, pos]);
    await c.query(`INSERT INTO gfx_rundown_items(account_id, event_id, position, segment, title, setup_id, values, cue, stays_sec)
                   VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`, [acct, eventId, pos, b.segment, b.title, b.setupId, JSON.stringify(b.values), JSON.stringify(cue), b.staysSec ?? null]);
  });
  res.status(201).json(await rundownChanged(acct, eventId));
}));

graphicsRouter.patch('/rundowns/:eventId/items/:itemId', asyncHandler(async (req, res) => {
  const acct = accountId(req); const eventId = uuidParam(req.params.eventId, 'event');
  const cur = await one<any>(`SELECT * FROM gfx_rundown_items WHERE id = $1 AND event_id = $2 AND account_id = $3`, [uuidParam(req.params.itemId, 'rundown item'), eventId, acct]);
  if (!cur) throw notFound('No rundown item with that id');
  const b = itemSchema.partial().parse(req.body ?? {});
  if (b.setupId) await assertSetup(acct, b.setupId);
  const cue = b.cue !== undefined ? cueOr400(b.cue) : cur.cue;
  const stays = b.staysSec !== undefined ? b.staysSec : cur.stays_sec;
  if (cue.kind === 'repeat' && !stays) throw badRequest('A repeating graphic needs how long it stays on.');
  await query(`UPDATE gfx_rundown_items SET segment = $2, title = $3, setup_id = $4, values = $5::jsonb, cue = $6::jsonb, stays_sec = $7, updated_at = now() WHERE id = $1`,
    [cur.id, b.segment ?? cur.segment, b.title ?? cur.title, b.setupId ?? cur.setup_id, JSON.stringify(b.values ?? cur.values), JSON.stringify(cue), stays]);
  res.json(await rundownChanged(acct, eventId));
}));

graphicsRouter.delete('/rundowns/:eventId/items/:itemId', asyncHandler(async (req, res) => {
  const acct = accountId(req); const eventId = uuidParam(req.params.eventId, 'event');
  const cur = await one<any>(`SELECT * FROM gfx_rundown_items WHERE id = $1 AND event_id = $2 AND account_id = $3`, [uuidParam(req.params.itemId, 'rundown item'), eventId, acct]);
  if (!cur) throw notFound('No rundown item with that id');
  if (cur.status === 'on_air') throw conflict('This item is on air. Take it off first.');
  await query(`DELETE FROM gfx_rundown_items WHERE id = $1`, [cur.id]);
  res.json(await rundownChanged(acct, eventId));
}));

graphicsRouter.post('/rundowns/:eventId/reorder', asyncHandler(async (req, res) => {
  const acct = accountId(req); const eventId = uuidParam(req.params.eventId, 'event');
  const b = z.object({ ids: z.array(z.string().uuid()).max(1000), segments: z.record(z.string().max(80)).optional() }).parse(req.body ?? {});
  await tx(async (c) => {
    const have = (await c.query(`SELECT id FROM gfx_rundown_items WHERE event_id = $1 AND account_id = $2`, [eventId, acct])).rows.map((r) => r.id);
    if (have.length !== b.ids.length || !have.every((id) => b.ids.includes(id))) throw badRequest('Send every item of the rundown, each once, in the new order.');
    for (const [i, id] of b.ids.entries()) {
      await c.query(`UPDATE gfx_rundown_items SET position = $2, segment = COALESCE($3, segment), updated_at = now() WHERE id = $1`, [id, i + 1, b.segments?.[id] ?? null]);
    }
  });
  res.json(await rundownChanged(acct, eventId));
}));

graphicsRouter.post('/rundowns/:eventId/copy-from', asyncHandler(async (req, res) => {
  const acct = accountId(req); const eventId = uuidParam(req.params.eventId, 'event');
  const from = uuidParam(req.body?.eventId, 'event');
  await loadTarget(acct, { eventId }); await loadTarget(acct, { eventId: from });
  const n = await tx(async (c) => {
    const base = (await c.query(`SELECT COALESCE(max(position), 0) AS n FROM gfx_rundown_items WHERE event_id = $1`, [eventId])).rows[0].n;
    const r = await c.query(`INSERT INTO gfx_rundown_items(account_id, event_id, position, segment, title, setup_id, values, cue, stays_sec)
       SELECT account_id, $1, $3 + position, segment, title, setup_id, values,
              CASE WHEN cue->>'kind' = 'time' THEN '{"kind":"manual"}'::jsonb ELSE cue END, stays_sec
         FROM gfx_rundown_items WHERE event_id = $2 AND account_id = $4 ORDER BY position`, [eventId, from, base, acct]);
    return r.rowCount ?? 0;
  });
  res.json({ copied: n, note: n ? 'Clock-time cues were set to manual: check them against this event’s times.' : 'That event has no rundown.', ...(await rundownChanged(acct, eventId)) });
}));

graphicsRouter.post('/rundowns/:eventId/import-csv', express.text({ type: () => true, limit: '1mb' }), asyncHandler(async (req, res) => {
  const acct = accountId(req); const eventId = uuidParam(req.params.eventId, 'event');
  const target = await loadTarget(acct, { eventId });
  const rows = parseCsv(String(req.body ?? ''));
  if (!rows.length) throw badRequest('The CSV is empty. Columns: segment, title, setup, cue, stays, values.');
  const setups = await query<any>(`SELECT id, name FROM gfx_setups WHERE account_id = $1`, [acct]);
  const byName = new Map(setups.map((s) => [s.name.trim().toLowerCase(), s.id]));
  const errors: string[] = [];
  const tz = String(req.query.tz ?? 'UTC');
  const items = rows.map((r, i) => {
    const line = i + 2;
    const setupId = UUID.test(r.setup) ? r.setup : byName.get(r.setup.toLowerCase());
    if (!r.title) errors.push(`line ${line}: no title`);
    if (!setupId) errors.push(`line ${line}: no setup called "${r.setup}"`);
    let cue: any = { kind: 'manual' };
    try { cue = cueFromText(r.cue, target.start ?? new Date(), tz); } catch (e: any) { errors.push(`line ${line}: ${e.message}`); }
    const stays = r.stays ? Number(r.stays.replace(/s$/i, '')) : null;
    if (r.stays && (!Number.isFinite(stays) || stays! <= 0)) errors.push(`line ${line}: stays "${r.stays}" is not a number of seconds`);
    if (cue.kind === 'repeat' && !stays) errors.push(`line ${line}: a repeating graphic needs stays`);
    return { ...r, setupId, cue, stays };
  });
  if (errors.length) throw badRequest(errors.slice(0, 10).join('; ') + (errors.length > 10 ? ` (and ${errors.length - 10} more)` : ''));
  await tx(async (c) => {
    let pos = (await c.query(`SELECT COALESCE(max(position), 0) AS n FROM gfx_rundown_items WHERE event_id = $1`, [eventId])).rows[0].n;
    for (const it of items) {
      pos++;
      await c.query(`INSERT INTO gfx_rundown_items(account_id, event_id, position, segment, title, setup_id, values, cue, stays_sec)
                     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`, [acct, eventId, pos, it.segment, it.title, it.setupId, JSON.stringify(it.values), JSON.stringify(it.cue), it.stays]);
    }
  });
  res.status(201).json({ imported: items.length, ...(await rundownChanged(acct, eventId)) });
}));

graphicsRouter.post('/rundowns/:eventId/take', asyncHandler(async (req, res) => {
  const acct = accountId(req); const eventId = uuidParam(req.params.eventId, 'event');
  let itemId = req.body?.itemId ? uuidParam(req.body.itemId, 'rundown item') : null;
  if (!itemId) {
    const rows = await query<any>(`SELECT id, position, status, cue, stays_sec, taken_at FROM gfx_rundown_items WHERE event_id = $1 AND account_id = $2`, [eventId, acct]);
    itemId = nextManual(rows)?.id ?? null;
    if (!itemId) throw conflict('Nothing left to take: every manual item is done or skipped.');
  }
  const r = await takeItem(acct, eventId, itemId, who(req));
  void recordStream(acct, { eventId });
  res.json({ taken: r, ...(await rundownJson(acct, eventId)) });
}));

graphicsRouter.post('/rundowns/:eventId/take-off', asyncHandler(async (req, res) => {
  const acct = accountId(req); const eventId = uuidParam(req.params.eventId, 'event');
  const r = await takeOffRundown(acct, eventId, who(req), req.body?.itemId ? uuidParam(req.body.itemId, 'rundown item') : undefined);
  void recordStream(acct, { eventId });
  res.json({ ...r, ...(await rundownJson(acct, eventId)) });
}));

graphicsRouter.post('/rundowns/:eventId/items/:itemId/:action(skip|restore)', asyncHandler(async (req, res) => {
  const acct = accountId(req); const eventId = uuidParam(req.params.eventId, 'event');
  const cur = await one<any>(`SELECT * FROM gfx_rundown_items WHERE id = $1 AND event_id = $2 AND account_id = $3`, [uuidParam(req.params.itemId, 'rundown item'), eventId, acct]);
  if (!cur) throw notFound('No rundown item with that id');
  if (cur.status === 'on_air') throw conflict('This item is on air. Take it off first.');
  await query(`UPDATE gfx_rundown_items SET status = $2, updated_at = now() WHERE id = $1`, [cur.id, req.params.action === 'skip' ? 'skipped' : 'ready']);
  res.json(await rundownChanged(acct, eventId));
}));

// ---- serving template files (public, sandboxed) ----------------------------------

/**
 * The bridge lets the console and the player drive a template they cannot
 * reach into: the page is sandboxed without allow-same-origin, so the parent
 * posts { type: 'volt-gfx', op: 'update'|'play'|'next'|'stop', data } and the
 * bridge calls the template's own CasparCG functions. Injected at serve time,
 * never stored, so the stored files stay exactly what was uploaded.
 */
export const BRIDGE = `<script>(function(){var q=[],ready=false;
var bb=null;function own(e){for(var k=e.firstChild;k;k=k.nextSibling)if(k.nodeType===3&&k.nodeValue.trim())return true;return false}function seen(root){var n=0,els=root.querySelectorAll('*');for(var i=0;i<els.length&&n<200;i++){var e=els[i];if(e.shadowRoot)n+=seen(e.shadowRoot);var t=String(e.tagName).toUpperCase();if(t==='HTML'||t==='BODY'||t==='SCRIPT'||t==='STYLE'||t==='LINK'||t==='META'||t==='HEAD')continue;var r=e.getBoundingClientRect();if(r.width<2||r.height<2||r.right<0||r.bottom<0||r.left>innerWidth||r.top>innerHeight)continue;var c=getComputedStyle(e);if(c.visibility==='hidden'||c.display==='none'||parseFloat(c.opacity)<0.05)continue;var paints=own(e)||t==='IMG'||t==='CANVAS'||t==='SVG'||t==='VIDEO'||(c.backgroundColor!=='rgba(0, 0, 0, 0)'&&c.backgroundColor!=='transparent')||c.backgroundImage!=='none'||(parseFloat(c.borderTopWidth)>0&&c.borderTopStyle!=='none'&&c.borderTopColor!=='rgba(0, 0, 0, 0)');if(!paints)continue;n++;var x0=Math.max(0,r.left),y0=Math.max(0,r.top),x1=Math.min(innerWidth,r.right),y1=Math.min(innerHeight,r.bottom);bb=bb?[Math.min(bb[0],x0),Math.min(bb[1],y0),Math.max(bb[2],x1),Math.max(bb[3],y1)]:[x0,y0,x1,y1]}return n}
function call(m){if(m.op==='probe'){var v=0;bb=null;try{v=seen(document)}catch(_){}parent.postMessage({type:'volt-gfx-probe',visible:v,box:bb&&[Math.round(bb[0]),Math.round(bb[1]),Math.round(bb[2]-bb[0]),Math.round(bb[3]-bb[1])]},'*');return}try{var f=window[m.op];if(typeof f!=='function')return;if(m.op==='update'){f(JSON.stringify(m.data||{}))}else{f()}}catch(e){parent.postMessage({type:'volt-gfx-error',message:String(e&&e.message||e)},'*')}}
addEventListener('message',function(e){var m=e.data;if(!m||m.type!=='volt-gfx')return;if(ready)call(m);else q.push(m)});
addEventListener('load',function(){ready=true;q.splice(0).forEach(call);parent.postMessage({type:'volt-gfx-ready'},'*')});
addEventListener('error',function(e){parent.postMessage({type:'volt-gfx-error',message:String(e.message||'script error')},'*')});
try{document.documentElement.style.background='transparent'}catch(_){}})();</script>`;

export function injectBridge(html: string): string {
  const m = /<head\b[^>]*>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + BRIDGE + html.slice(m.index + m[0].length);
  return BRIDGE + html;
}

export const SANDBOX_CSP = "sandbox allow-scripts; default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; worker-src blob:";

/**
 * The CSP a template file is served with. connect-src allows the template's
 * own package and nothing else, so a graphic can fetch() its bundled JSON (a
 * Lottie animation, a lookup table) but still reach no network, no other
 * template and no Volt API. The page is sandboxed without allow-same-origin,
 * so even its own package is a cross-origin read, answered with CORS headers.
 */
export function sandboxCsp(req: Request, versionId: string): string {
  const host = String(req.get('host') ?? '').replace(/[^A-Za-z0-9.:\[\]-]/g, '');
  const own = host ? `${req.protocol === 'https' ? 'https' : 'http'}://${host}/gfx/${versionId}/` : "'none'";
  return SANDBOX_CSP.replace("connect-src 'none'", `connect-src ${own}`);
}

const ografPage = new Map<string, string>();

export const graphicsFilesRouter = Router();
graphicsFilesRouter.get('/gfx/:versionId/*', asyncHandler(async (req, res) => {
  const vid = String(req.params.versionId);
  if (!UUID.test(vid)) return res.status(404).end();
  const path = decodeURIComponent(String((req.params as any)[0] ?? '')) || 'index.html';
  if (path === 'index.html') {
    // An OGraf package has no index.html of Volt's: the host page is generated from its manifest.
    const v = await one<any>(`SELECT status, manifest FROM gfx_template_versions WHERE id = $1`, [vid]);
    if (!v) return res.status(404).type('text/plain').send('Not in this template');
    if (v.manifest?.contract === 'ograf' && v.manifest?.ograf) {
      let page = v.status === 'published' ? ografPage.get(vid) : undefined;
      if (!page) {
        page = injectBridge(ografHostPage(v.manifest));
        if (v.status === 'published') { if (ografPage.size > 500) ografPage.clear(); ografPage.set(vid, page); }
      }
      res.setHeader('Content-Security-Policy', sandboxCsp(req, vid));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Cache-Control', v.status === 'published' ? 'public, max-age=31536000, immutable' : 'no-store');
      return res.type('text/html; charset=utf-8').send(page);
    }
  }
  const f = await one<any>(`SELECT f.content, f.content_type, f.sha256, v.status FROM gfx_files f JOIN gfx_template_versions v ON v.id = f.version_id
                             WHERE f.version_id = $1 AND f.path = $2`, [vid, path]);
  if (!f) return res.status(404).type('text/plain').send('Not in this template');
  res.setHeader('Content-Security-Policy', sandboxCsp(req, vid));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', f.status === 'published' ? 'public, max-age=31536000, immutable' : 'no-store');
  res.setHeader('ETag', `"${f.sha256}"`);
  res.type(f.content_type);
  if (path === 'index.html') return res.send(injectBridge((f.content as Buffer).toString('utf8')));
  res.send(f.content);
}));


// ---- the player's side (public, publishable key) ------------------------------

/**
 * GET  /api/player/graphics?appKey=pk_…&streamId=<channel or event>&since=<ms>
 *      The graphics this stream shows in the player, and their state over time
 *      from the snapshot in force at `since` (the player's playhead wall clock,
 *      a little earlier). Cached per stream and 10 s window for a second, so
 *      the cost does not grow with the audience.
 * POST /api/player/graphics/impressions  { appKey, streamId, sessionId, items: [{ id, at?, ms? }] }
 *      A graphic came on screen for a viewer (FR-17).
 * Same rules as every player route: publishable key, the app's restrictions
 * (referrer, origin, IP), and the stream must belong to the key's account,
 * answered exactly like a missing one when it does not.
 */
export const graphicsPlayerRouter = Router();

async function playerKey(req: Request, appKey: unknown, streamId: unknown) {
  const key = await verifyKey(String(appKey ?? ''));
  if (!key || key.kind !== 'publishable') throw new ApiError(401, 'invalid publishable key');
  const app = await appForKey(key);
  if (!app) throw new ApiError(401, 'app not found for key');
  const reason = checkRestrictions(app, { referrer: req.get('referer') || undefined, origin: req.get('origin') || undefined, ip: req.ip });
  if (reason) throw new ApiError(403, reason);
  const id = String(streamId ?? '');
  if (!UUID.test(id)) throw notFound('Stream not found');
  const kind = await assetKindFor(key.account_id, id);
  if (kind !== 'channel' && kind !== 'event') throw notFound('Stream not found');
  return { accountId: key.account_id as string, appId: app.id as string, kind: kind as 'channel' | 'event', id };
}

graphicsPlayerRouter.get('/', asyncHandler(async (req, res) => {
  const k = await playerKey(req, req.query.appKey, req.query.streamId);
  const now = Date.now();
  let since = Number(req.query.since);
  if (!Number.isFinite(since) || since > now) since = now;
  since = Math.max(since, now - 48 * 3600_000);
  const bucket = Math.floor(since / 10_000) * 10_000;
  const feed = await cached(`player-gfx:${k.id}:${bucket}:${Math.floor(now / 1000)}`, { ttlSec: 2, tags: [`asset:${k.id}`] },
    () => feedFor(k.accountId, k.kind, k.id, bucket));
  res.set('cache-control', 'public, max-age=1');
  res.json(feed);
}));

const impressionSchema = z.object({
  appKey: z.string().min(8), streamId: z.string().uuid(), sessionId: z.string().min(6).max(64),
  items: z.array(z.object({ id: z.string().uuid(), at: z.number().optional(), ms: z.number().int().min(0).max(86_400_000).optional() })).min(1).max(20),
});
graphicsPlayerRouter.post('/impressions', asyncHandler(async (req, res) => {
  const b = impressionSchema.parse(req.body ?? {});
  const k = await playerKey(req, b.appKey, b.streamId);
  const ok = await query<any>(`SELECT id FROM gfx_assignments WHERE account_id = $1 AND ${k.kind === 'channel' ? 'channel_id' : 'event_id'} = $2 AND id = ANY($3::uuid[])`,
    [k.accountId, k.id, b.items.map((i) => i.id)]);
  const known = new Set(ok.map((r) => r.id));
  const origin = (req.get('origin') || req.get('referer') || '').slice(0, 300) || null;
  for (const i of b.items) {
    if (!known.has(i.id)) continue;   // not this stream's: dropped, not recorded against the wrong tenant
    const at = i.at && Math.abs(i.at - Date.now()) < 86_400_000 ? new Date(i.at) : new Date();
    await query(`INSERT INTO gfx_impressions(account_id, assignment_id, channel_id, event_id, app_id, session_id, origin, shown_at, on_screen_ms)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [k.accountId, i.id, k.kind === 'channel' ? k.id : null, k.kind === 'event' ? k.id : null, k.appId, b.sessionId, origin, at, i.ms ?? null]);
  }
  res.status(204).end();
}));
