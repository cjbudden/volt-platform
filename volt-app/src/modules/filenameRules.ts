// ============================================================================
//  FILE-NAME RULES: the account's IF/THEN classification rules and settings.
//  Mounted at /api/ingest/filename-rules (Account settings permission, with the
//  rest of /api/ingest). The built-in rules (services/ingest/classify.ts) are
//  listed beside the account's and can be switched off, not edited.
//
//    GET    /api/ingest/filename-rules              built-in rules, the account's, the settings
//    POST   /api/ingest/filename-rules              add a rule
//    PATCH  /api/ingest/filename-rules/:id          change one
//    DELETE /api/ingest/filename-rules/:id          remove one
//    PUT    /api/ingest/filename-rules/builtin/:id  {enabled}
//    PUT    /api/ingest/filename-rules/settings     title case, episode template, what is automatic
//    POST   /api/ingest/filename-rules/test         {filename}: what the rules make of it
// ============================================================================
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db';
import { requireAuth, accountId } from '../auth/middleware';
import { asyncHandler, notFound, badRequest } from '../util/http';
import { actorLabel } from '../util/actor';
import { BUILTIN_RULES, checkRule, STANDARD_LABEL } from '../services/ingest/classify';
import { loadRules, loadSettings, readName, accountTypes, fieldValues, matchQuery } from '../services/ingest/filenameApply';
import { resolveEffectiveFields } from './metadataSchemas';

export const filenameRulesRouter = Router();
filenameRulesRouter.use(requireAuth);

const when = z.object({
  words: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  signal: z.enum(['promo', 'seasonEpisode', 'episode', 'season', 'year', 'date', 'language']).optional(),
  pattern: z.string().max(200).optional(),
}).strict();
const then = z.object({ typeKey: z.string().max(40).optional(), typeId: z.string().uuid().optional(), kind: z.string().max(40).optional() }).strict();
const body = z.object({
  name: z.string().trim().min(1).max(120), enabled: z.boolean().default(true), ordinal: z.number().int().min(0).max(10000).default(100),
  when, then, confidence: z.number().min(0.1).max(0.98).default(0.85),
});

const view = (r: any) => ({ id: r.id, name: r.name, enabled: r.enabled, ordinal: r.ordinal, when: r.when ?? {}, then: r.then ?? {}, confidence: Number(r.confidence), origin: 'account' as const, updatedAt: r.updated_at });

async function checkTypes(acct: string, t: z.infer<typeof then>) {
  const types = await accountTypes(acct);
  if (t.typeId && !types.ids.has(t.typeId)) throw badRequest('That content type is not one of this account\'s on-demand types.');
  if (t.typeKey && !types.byKey.has(t.typeKey)) throw badRequest(`Unknown content type "${t.typeKey}".`);
}
function check(r: any) { try { checkRule(r); } catch (e: any) { throw badRequest(e.message); } }

filenameRulesRouter.get('/', asyncHandler(async (req, res) => {
  const acct = accountId(req);
  const rows = await query<any>(`SELECT * FROM filename_rules WHERE account_id = $1 ORDER BY ordinal, created_at`, [acct]);
  const off = new Set(rows.filter((r: any) => r.builtin_id && !r.enabled).map((r: any) => r.builtin_id));
  const types = await accountTypes(acct);
  res.json({
    builtin: BUILTIN_RULES.map((r) => ({ ...r, enabled: !off.has(r.id), typeName: r.then.typeKey ? types.byKey.get(r.then.typeKey)?.name ?? STANDARD_LABEL[r.then.typeKey] : null })),
    rules: rows.filter((r: any) => !r.builtin_id).map((r: any) => ({ ...view(r), typeName: r.then?.typeId ? types.byId.get(r.then.typeId)?.name ?? null : r.then?.typeKey ? types.byKey.get(r.then.typeKey)?.name ?? null : null })),
    settings: await loadSettings(acct),
    types: [...types.byId.values()].map((t) => ({ id: t.id, name: t.name, key: t.key })),
  });
}));

filenameRulesRouter.post('/', asyncHandler(async (req, res) => {
  const b = body.parse(req.body);
  check(b); await checkTypes(accountId(req), b.then);
  const r = await one<any>(`INSERT INTO filename_rules(account_id, name, enabled, ordinal, "when", "then", confidence, created_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) RETURNING *`,
    [accountId(req), b.name, b.enabled, b.ordinal, JSON.stringify(b.when), JSON.stringify(b.then), b.confidence, await actorLabel(req)]);
  res.status(201).json(view(r));
}));

filenameRulesRouter.put('/builtin/:id', asyncHandler(async (req, res) => {
  const b = z.object({ enabled: z.boolean() }).parse(req.body);
  if (!BUILTIN_RULES.some((r) => r.id === req.params.id)) throw notFound('No such built-in rule');
  await query(`INSERT INTO filename_rules(account_id, builtin_id, name, enabled, created_by) VALUES ($1,$2,$2,$3,$4)
               ON CONFLICT (account_id, builtin_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`, [accountId(req), req.params.id, b.enabled, await actorLabel(req)]);
  res.json({ id: req.params.id, enabled: b.enabled });
}));

filenameRulesRouter.put('/settings', asyncHandler(async (req, res) => {
  const b = z.object({
    titleCase: z.enum(['every', 'headline']).optional(),
    episodeTemplate: z.string().trim().min(1).max(80).refine((s) => s.includes('{episode}'), 'The template needs {episode}').optional(),
    autoType: z.boolean().optional(), autoLink: z.boolean().optional(),
  }).strict().parse(req.body);
  const cur = await loadSettings(accountId(req));
  const n = { ...cur, ...b };
  await query(`INSERT INTO filename_settings(account_id, title_case, episode_template, auto_type, auto_link) VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (account_id) DO UPDATE SET title_case = EXCLUDED.title_case, episode_template = EXCLUDED.episode_template,
                 auto_type = EXCLUDED.auto_type, auto_link = EXCLUDED.auto_link, updated_at = now()`,
    [accountId(req), n.titleCase, n.episodeTemplate, n.autoType, n.autoLink]);
  res.json(n);
}));

filenameRulesRouter.post('/test', asyncHandler(async (req, res) => {
  const b = z.object({ filename: z.string().trim().min(1).max(400) }).parse(req.body);
  const acct = accountId(req);
  const settings = await loadSettings(acct);
  const r = await readName(acct, b.filename, { settings, rules: await loadRules(acct) });
  const fields = r.suggestedType ? (await resolveEffectiveFields(r.suggestedType.id, acct))?.fields ?? [] : [];
  res.json({
    filename: b.filename, signals: r.parse.signals,
    parsed: { title: r.parse.title, series: r.parse.series, episodeTitle: r.parse.episodeTitle, season: r.parse.season, episode: r.parse.episode, year: r.parse.year, date: r.parse.date, resolution: r.parse.resolution, language: r.parse.language, promo: r.parse.promo },
    classification: r.classification, suggestedType: r.suggestedType,
    fields: fieldValues(r.parse, r.suggestedType?.key ?? null, fields, settings),
    lookFor: r.suggestedType?.key === 'trailer' ? matchQuery(r.parse) : null,
  });
}));

filenameRulesRouter.patch('/:id', asyncHandler(async (req, res) => {
  const b = body.partial().parse(req.body);
  const acct = accountId(req);
  const cur = await one<any>(`SELECT * FROM filename_rules WHERE id = $1 AND account_id = $2 AND builtin_id IS NULL`, [req.params.id, acct]).catch(() => null);
  if (!cur) throw notFound('No such rule');
  const next = { name: b.name ?? cur.name, enabled: b.enabled ?? cur.enabled, ordinal: b.ordinal ?? cur.ordinal, when: b.when ?? cur.when, then: b.then ?? cur.then, confidence: b.confidence ?? Number(cur.confidence) };
  check(next); await checkTypes(acct, next.then);
  const r = await one<any>(`UPDATE filename_rules SET name=$3, enabled=$4, ordinal=$5, "when"=$6::jsonb, "then"=$7::jsonb, confidence=$8, updated_at=now() WHERE id=$1 AND account_id=$2 RETURNING *`,
    [req.params.id, acct, next.name, next.enabled, next.ordinal, JSON.stringify(next.when), JSON.stringify(next.then), next.confidence]);
  res.json(view(r));
}));

filenameRulesRouter.delete('/:id', asyncHandler(async (req, res) => {
  const r = await one<any>(`DELETE FROM filename_rules WHERE id = $1 AND account_id = $2 AND builtin_id IS NULL RETURNING id`, [req.params.id, accountId(req)]).catch(() => null);
  if (!r) throw notFound('No such rule');
  res.status(204).end();
}));
