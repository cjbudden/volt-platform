// ============================================================================
//  FILE NAME -> TYPE, FIELDS, TITLE AND LINKS (the database side).
//
//  filenameParse.ts reads the name, classify.ts suggests a type, relatedMatch.ts
//  and contentLinks.ts find what a trailer promotes. This file decides what is
//  applied and records why, in three situations:
//
//   INGEST (pipeline.ts). Automatic and careful: a type only when the operator
//     and the ingest rules left it at the default and the suggestion is
//     confident and uncontested; a field only when it is empty or was filled
//     by an earlier automatic step; a link only on a single clear match.
//   READ FROM FILE NAME, one asset (GET preview, POST apply). A person ticks
//     what to apply, like Fill from EPG. Values a person entered start unticked
//     and need their own Replace.
//   READ FROM FILE NAME, a selection (POST /api/vod/from-filename). The ingest
//     behaviour, run again: only what is safe to apply without asking.
//
//  "Set by a person" is the platform's existing convention: a field with a
//  value and no metadata_provenance entry was typed or confirmed by someone
//  (provenance is written by every automatic filler and removed by any edit
//  by hand). For the content type the entry is "@type".
// ============================================================================
import { query, one } from '../../db';
import type { SchemaField } from '../metadataValidator';
import { parseFilename, episodeTitleFrom, type FilenameParse } from './filenameParse';
import { classify, BUILTIN_RULES, KIND_FIELD, STANDARD_LABEL, type ClassRule, type Classification } from './classify';
import { contentFields, relationOf, autoLink, linkValue, type Candidate } from '../contentLinks';
import type { MatchQuery } from '../relatedMatch';

export interface FilenameSettings { titleCase: 'every' | 'headline'; episodeTemplate: string; autoType: boolean; autoLink: boolean }
export const DEFAULT_SETTINGS: FilenameSettings = { titleCase: 'every', episodeTemplate: 'Episode {episode} (S{season})', autoType: true, autoLink: true };

export async function loadSettings(account: string): Promise<FilenameSettings> {
  const r = await one<any>(`SELECT * FROM filename_settings WHERE account_id = $1`, [account]).catch(() => null);
  if (!r) return { ...DEFAULT_SETTINGS };
  return { titleCase: r.title_case === 'headline' ? 'headline' : 'every', episodeTemplate: r.episode_template || DEFAULT_SETTINGS.episodeTemplate, autoType: r.auto_type !== false, autoLink: r.auto_link !== false };
}

export interface AccountRules { rules: ClassRule[]; disabled: string[] }
export async function loadRules(account: string): Promise<AccountRules> {
  const rows = await query<any>(`SELECT * FROM filename_rules WHERE account_id = $1 ORDER BY ordinal, created_at`, [account]).catch(() => []);
  const rules: ClassRule[] = rows.filter((r: any) => !r.builtin_id).map((r: any) => ({
    id: r.id, name: r.name, enabled: r.enabled, origin: 'account', ordinal: r.ordinal, when: r.when ?? {}, then: r.then ?? {}, confidence: Number(r.confidence),
  }));
  const disabled = rows.filter((r: any) => r.builtin_id && !r.enabled).map((r: any) => r.builtin_id);
  return { rules, disabled };
}

/** The account's on-demand types: standard key -> id, and custom ids. */
export async function accountTypes(account: string): Promise<{ byKey: Map<string, { id: string; name: string }>; ids: Set<string>; byId: Map<string, { id: string; name: string; key: string | null }> }> {
  const { ensureStandardTypes } = await import('../contentTypes');
  await ensureStandardTypes(account);
  const rows = await query<any>(
    `SELECT ms.id, ms.name, COALESCE(ms.standard_key, p.standard_key) AS key, ms.standard_key AS own_key
       FROM metadata_schemas ms LEFT JOIN metadata_schemas p ON p.id = ms.extends_id
      WHERE ms.account_id = $1 AND (ms.applies_to IS NULL OR 'vod' = ANY(ms.applies_to) OR ms.target_kind IN ('vod', 'any'))`, [account]);
  const byKey = new Map<string, { id: string; name: string }>();
  for (const r of rows) if (r.own_key) byKey.set(r.own_key, { id: r.id, name: r.name });
  return { byKey, ids: new Set(rows.map((r: any) => r.id)), byId: new Map(rows.map((r: any) => [r.id, { id: r.id, name: r.name, key: r.key ?? null }])) };
}

export interface Reading {
  parse: FilenameParse;
  classification: Classification;
  /** The account type the suggestion resolves to. */
  suggestedType: { id: string; name: string; key: string | null } | null;
}

export async function readName(account: string, name: string, ctx?: { rules?: AccountRules; settings?: FilenameSettings; types?: Awaited<ReturnType<typeof accountTypes>> }): Promise<Reading> {
  const rules = ctx?.rules ?? await loadRules(account);
  const settings = ctx?.settings ?? await loadSettings(account);
  const types = ctx?.types ?? await accountTypes(account);
  const extraWords = rules.rules.filter((r) => r.enabled && r.when.words?.length).map((r) => ({ words: r.when.words!, ruleId: r.id }));
  const parse = parseFilename(name, { extraWords, titleCase: settings.titleCase });
  const classification = classify(parse, rules.rules, { disabledBuiltins: rules.disabled, known: { keys: new Set(types.byKey.keys()), ids: types.ids } });
  const b = classification.best;
  const t = b ? (b.typeId ? types.byId.get(b.typeId) : b.typeKey ? types.byKey.get(b.typeKey) : null) : null;
  const suggestedType = t ? { id: t.id, name: t.name, key: (types.byId.get(t.id)?.key ?? b?.typeKey) ?? null } : null;
  return { parse, classification, suggestedType };
}

/** The value of each field this name can fill, for a type's fields. */
export interface FieldValue { field: string; label: string; value: any; token: string | null; reason: string }

const TITLE_KEYS = ['title', 'headline', 'name'];
const DATE_KEYS = ['recordedAt', 'released', 'releaseDate', 'airDate', 'date'];

export function titleFor(p: FilenameParse, typeKey: string | null, template: string): string | null {
  const ep = episodeTitleFrom(p, template);
  if (p.season != null || p.episode != null) {
    // A promo for an episode is titled with the programme: "Show: Episode 3 (S1)".
    if (typeKey === 'trailer') return [p.series, p.episodeTitle ?? ep].filter(Boolean).join(': ') || p.title;
    return p.episodeTitle ?? ep ?? p.title;
  }
  return p.title;
}

export function fieldValues(p: FilenameParse, typeKey: string | null, fields: SchemaField[], settings: FilenameSettings): FieldValue[] {
  const out: FieldValue[] = [];
  const has = (k: string) => fields.find((f) => f.key === k);
  const sigTok = (kind: string) => p.signals.find((s) => s.kind === kind && !s.inTitle) ?? null;
  const titleField = TITLE_KEYS.map(has).find((f) => f && (f.type === 'string' || f.type === 'text'));
  const title = titleFor(p, typeKey, settings.episodeTemplate);
  if (titleField && title) {
    const isTemplate = p.episode != null && !p.episodeTitle;
    out.push({ field: titleField.key, label: titleField.label ?? titleField.key, value: title, token: null,
      reason: isTemplate ? `No episode title in the name, so it is built from the template "${settings.episodeTemplate}".` : `What is left of the file name once the tags are taken off.` });
  }
  const seriesF = has('series');
  if (seriesF && p.series && (seriesF.type === 'string' || seriesF.type === 'text')) out.push({ field: 'series', label: seriesF.label ?? 'Series', value: p.series, token: null, reason: 'The text before the season and episode marker.' });
  const num = (k: string, v: number | null, kind: string) => {
    const f = has(k);
    if (f && f.type === 'number' && v != null) { const s = sigTok(kind); out.push({ field: k, label: f.label ?? k, value: v, token: s?.token ?? null, reason: s?.reason ?? '' }); }
  };
  num('season', p.season, 'season');
  num('episodeNumber', p.episode, 'episode');
  num('year', p.year, 'year');
  const lang = has('language');
  if (lang && p.language && lang.type === 'string') { const s = sigTok('language'); out.push({ field: 'language', label: lang.label ?? 'Language', value: p.language, token: s?.token ?? null, reason: s?.reason ?? '' }); }
  if (p.date) {
    const df = DATE_KEYS.map(has).find((f) => f && f.type === 'date');
    const s = sigTok('date');
    if (df) out.push({ field: df.key, label: df.label ?? df.key, value: p.date, token: s?.token ?? null, reason: s?.reason ?? '' });
  }
  const kindKey = typeKey ? KIND_FIELD[typeKey] : undefined;
  const kf = kindKey ? has(kindKey) : undefined;
  if (kf && p.promo && kf.type === 'enum' && (kf.options ?? []).includes(p.promo.kind))
    out.push({ field: kf.key, label: kf.label ?? kf.key, value: p.promo.kind, token: p.promo.token, reason: `"${p.promo.token}": a ${p.promo.kind.toLowerCase()}.` });
  return out;
}

/** What to look for when finding what this file promotes. */
export function matchQuery(p: FilenameParse): MatchQuery {
  return {
    title: (p.season != null || p.episode != null) ? (p.series ?? p.title ?? '') : (p.title ?? ''),
    year: p.year, season: p.season, episode: p.episode,
    removed: p.signals.filter((s) => !s.inTitle && ['promo', 'resolution', 'videoCodec', 'audio', 'version', 'source', 'language'].includes(s.kind)).map((s) => s.token),
  };
}
const displayName = (q: MatchQuery) => `${q.title}${q.year ? ` (${q.year})` : ''}`;

// ---- the preview a person ticks ---------------------------------------------------

export type Action = 'fill' | 'same' | 'conflict' | 'replace';
export interface FieldPlan extends FieldValue { current: any; action: Action; byPerson: boolean }
export interface FilenamePreview {
  file: string;
  signals: FilenameParse['signals'];
  parsed: Pick<FilenameParse, 'title' | 'series' | 'episodeTitle' | 'season' | 'episode' | 'year' | 'date' | 'resolution' | 'fps' | 'language' | 'promo'>;
  classification: Classification;
  type: { current: { id: string; name: string } | null; suggested: { id: string; name: string; key: string | null } | null; action: 'set' | 'same' | 'conflict' | 'none'; byPerson: boolean; reasons: string[]; dropsFields: string[] };
  title: { current: string | null; value: string | null; action: Action; byPerson: boolean } | null;
  fields: FieldPlan[];
  link: { field: string; label: string; query: MatchQuery; current: any; byPerson: boolean } | null;
  /** The probe disagreeing with the name (1080p in the name, 720 lines measured). */
  mismatches: string[];
}

function isEmpty(v: any) { return v == null || v === '' || (Array.isArray(v) && !v.length); }
const same = (a: any, b: any) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export async function preview(account: string, a: any): Promise<FilenamePreview> {
  const { resolveEffectiveFields } = await import('../../modules/metadataSchemas');
  const settings = await loadSettings(account);
  const types = await accountTypes(account);
  const file = String(a.original_filename || a.title || '');
  const r = await readName(account, file, { settings, types });
  const prov = a.metadata_provenance ?? {};
  const meta = a.metadata ?? {};
  const cur = a.schema_id ? types.byId.get(a.schema_id) ?? null : null;
  const typeByPerson = !!a.schema_id && !prov['@type'];
  let typeAction: FilenamePreview['type']['action'] = 'none';
  if (r.suggestedType) {
    if (cur?.id === r.suggestedType.id) typeAction = 'same';
    else if (typeByPerson || r.classification.conflict || !r.classification.confident) typeAction = 'conflict';
    else typeAction = 'set';
  }
  const targetTypeId = typeAction === 'same' || !r.suggestedType ? a.schema_id : r.suggestedType.id;
  const targetKey = targetTypeId ? types.byId.get(targetTypeId)?.key ?? null : null;
  const fields = targetTypeId ? (await resolveEffectiveFields(targetTypeId, account))?.fields ?? [] : [];
  const curFields = a.schema_id ? (await resolveEffectiveFields(a.schema_id, account))?.fields ?? [] : [];
  const dropsFields = r.suggestedType && r.suggestedType.id !== a.schema_id
    ? curFields.filter((f) => !isEmpty(meta[f.key]) && !fields.some((g) => g.key === f.key)).map((f) => f.label ?? f.key) : [];

  const plans: FieldPlan[] = fieldValues(r.parse, targetKey, fields, settings).map((v) => {
    const current = meta[v.field];
    const byPerson = !isEmpty(current) && !prov[v.field];
    const action: Action = isEmpty(current) ? 'fill' : same(current, v.value) ? 'same' : byPerson ? 'conflict' : 'replace';
    return { ...v, current, action, byPerson };
  });
  const tv = titleFor(r.parse, targetKey, settings.episodeTemplate);
  const titleByPerson = !!a.title && !prov.title && a.title !== a.original_filename;
  const title = tv ? { current: a.title ?? null, value: tv, action: (!a.title || a.title === a.original_filename ? 'fill' : a.title === tv ? 'same' : titleByPerson ? 'conflict' : 'replace') as Action, byPerson: titleByPerson } : null;
  const lf = contentFields(fields).find((f) => relationOf(f).autoMatch) ?? null;
  const link = lf ? { field: lf.key, label: lf.label ?? lf.key, query: matchQuery(r.parse), current: meta[lf.key] ?? null, byPerson: !isEmpty(meta[lf.key]) && !prov[lf.key] } : null;

  const mismatches: string[] = [];
  const probedH = a.top_height ?? a.ingest?.probe?.video?.height ?? null;
  if (r.parse.height && probedH && Math.abs(Number(probedH) - r.parse.height) > 8)
    mismatches.push(`The name says ${r.parse.resolution}, the file measures ${probedH} lines. The measured value is used.`);
  return {
    file, signals: r.parse.signals,
    parsed: { title: r.parse.title, series: r.parse.series, episodeTitle: r.parse.episodeTitle, season: r.parse.season, episode: r.parse.episode, year: r.parse.year, date: r.parse.date, resolution: r.parse.resolution, fps: r.parse.fps, language: r.parse.language, promo: r.parse.promo },
    classification: r.classification,
    type: { current: cur ? { id: cur.id, name: cur.name } : null, suggested: r.suggestedType, action: typeAction, byPerson: typeByPerson,
      reasons: [...(r.classification.best?.reasons ?? []), r.classification.conflict?.reason ?? '', typeByPerson && typeAction === 'conflict' ? 'The current type was chosen by a person, so it is only changed if you tick it.' : ''].filter(Boolean), dropsFields },
    title, fields: plans, link, mismatches,
  };
}

// ---- applying -----------------------------------------------------------------

export interface ApplyChoice {
  /** Change the content type to the suggested one. */
  type?: boolean;
  /** Use the title. */
  title?: boolean;
  /** Fields to write (empty ones, or ones in overwrite). Omitted: every field the plan would fill. */
  fields?: string[];
  /** Fields that already hold a value and may be replaced. */
  overwrite?: string[];
  /** The link: an asset id a person chose, null to leave it, 'auto' to let the matcher decide. */
  link?: string | 'auto' | null;
}

export interface ApplyResult {
  assetId: string;
  typeChanged: boolean;
  titleChanged: boolean;
  applied: string[];
  skipped: { field: string; reason: string }[];
  link: { action: string; reason: string } | null;
}

/**
 * Apply a reading to an asset. mode 'safe' (ingest re-run, bulk) applies only what
 * needs no one's decision; mode 'chosen' applies what a person ticked.
 */
export async function applyReading(account: string, assetId: string, choice: ApplyChoice, by: { userId: string | null; label: string } | null, mode: 'safe' | 'chosen'): Promise<ApplyResult> {
  const a = await one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [assetId]);
  if (!a) throw new Error('asset not found');
  const p = await preview(account, a);
  const settings = await loadSettings(account);
  const res: ApplyResult = { assetId, typeChanged: false, titleChanged: false, applied: [], skipped: [], link: null };
  const at = new Date().toISOString();
  let meta: Record<string, any> = { ...(a.metadata ?? {}) };
  const prov: Record<string, any> = { ...(a.metadata_provenance ?? {}) };
  let schemaId = a.schema_id;

  // Type
  const wantType = mode === 'safe' ? p.type.action === 'set' && settings.autoType : !!choice.type && !!p.type.suggested && p.type.action !== 'same';
  if (wantType && p.type.suggested) {
    const { resolveEffectiveFields } = await import('../../modules/metadataSchemas');
    const nf = (await resolveEffectiveFields(p.type.suggested.id, account))?.fields ?? [];
    const of = a.schema_id ? (await resolveEffectiveFields(a.schema_id, account))?.fields ?? [] : [];
    // Fields of the old type with no place on the new one go (the preview lists them);
    // keys that were never type fields (provenance other paths keep, such as a
    // station's ICY block) are carried, as the metadata form carries them.
    meta = Object.fromEntries(Object.entries(meta).filter(([k]) => nf.some((f) => f.key === k) || !of.some((f) => f.key === k)));
    schemaId = p.type.suggested.id;
    prov['@type'] = { source: 'filename', file: p.file, confidence: p.classification.best?.confidence ?? null, reasons: p.type.reasons, by: by?.label ?? null, at, was: a.schema_id };
    res.typeChanged = true;
  } else if (p.type.action === 'conflict' && mode === 'safe') res.skipped.push({ field: '@type', reason: p.type.reasons.join(' ') });

  // After a type change the plan's fields are the new type's: read them again.
  const plan = res.typeChanged ? await preview(account, { ...a, schema_id: schemaId, metadata: meta, metadata_provenance: prov }) : p;
  const pick = choice.fields ? new Set(choice.fields) : null;
  const over = new Set(choice.overwrite ?? []);
  const fill: Record<string, any> = {};
  for (const f of plan.fields) {
    if (f.action === 'same') continue;
    const allowed = mode === 'safe'
      ? f.action === 'fill' || (f.action === 'replace' && prov[f.field]?.source === 'filename')
      : (f.action === 'fill' && (!pick || pick.has(f.field))) || ((f.action === 'replace' || f.action === 'conflict') && over.has(f.field));
    if (!allowed) { if (f.action === 'conflict') res.skipped.push({ field: f.field, reason: `${f.label} holds a value a person entered.` }); continue; }
    fill[f.field] = f.value;
  }
  if (Object.keys(fill).length) {
    const { resolveEffectiveFields } = await import('../../modules/metadataSchemas');
    const { validateMetadata } = await import('../metadataValidator');
    const fields = schemaId ? (await resolveEffectiveFields(schemaId, account))?.fields ?? [] : [];
    const touched = fields.filter((f) => f.key in fill).map((f) => ({ ...f, required: false }));
    const ok = validateMetadata(touched, fill, 'keep');
    for (const [k, v] of Object.entries(ok)) {
      meta[k] = v;
      const fv = plan.fields.find((x) => x.field === k);
      prov[k] = { source: 'filename', file: plan.file, token: fv?.token ?? null, reason: fv?.reason ?? null, by: by?.label ?? null, at, was: a.metadata?.[k] ?? null };
      res.applied.push(k);
    }
  }
  // Title
  let title = a.title;
  if (plan.title && plan.title.action !== 'same') {
    const ok = mode === 'safe' ? plan.title.action === 'fill' || (plan.title.action === 'replace' && prov.title?.source === 'filename') : !!choice.title;
    if (ok && plan.title.value) { title = plan.title.value; prov.title = { source: 'filename', file: plan.file, by: by?.label ?? null, at, was: a.title ?? null }; res.titleChanged = true; }
  }

  const analysis = { at, by: by?.label ?? null, file: plan.file, mode, signals: plan.signals, parsed: plan.parsed,
    classification: { summary: plan.classification.summary, best: plan.classification.best, conflict: plan.classification.conflict, confident: plan.classification.confident },
    applied: { type: res.typeChanged, title: res.titleChanged, fields: res.applied }, skipped: res.skipped, mismatches: plan.mismatches,
    match: plan.link ? { query: plan.link.query } : null };
  await query(
    `UPDATE vod_assets SET schema_id = $2, metadata = $3::jsonb, metadata_provenance = $4::jsonb, title = $5, filename_analysis = $6::jsonb, updated_at = now() WHERE id = $1`,
    [assetId, schemaId, JSON.stringify(meta), JSON.stringify(prov), title, JSON.stringify(analysis)]);

  // Link
  if (plan.link && choice.link !== null) {
    const { resolveEffectiveFields } = await import('../../modules/metadataSchemas');
    const fields = schemaId ? (await resolveEffectiveFields(schemaId, account))?.fields ?? [] : [];
    const f = contentFields(fields).find((x) => x.key === plan.link!.field)!;
    if (choice.link && choice.link !== 'auto' && mode === 'chosen') {
      const { writeLink } = await import('../contentLinks');
      const t = await one<any>(`SELECT title FROM vod_assets WHERE id = $1`, [choice.link]);
      await writeLink({ account, assetId, field: f, value: { id: choice.link, name: t?.title ?? 'Untitled' }, source: 'person', by: by?.label ?? null, reasons: ['Chosen by a person from Read from file name.'] });
      res.link = { action: 'linked', reason: 'Chosen by you.' };
    } else if (plan.link.query.title) {
      const r = await autoLink({ account, assetId, field: f, query: plan.link.query, allowLink: settings.autoLink, displayName: displayName(plan.link.query) });
      res.link = { action: r.action, reason: r.reason };
    }
    await query(`UPDATE vod_assets SET filename_analysis = jsonb_set(filename_analysis, '{link}', $2::jsonb) WHERE id = $1`, [assetId, JSON.stringify(res.link)]);
  }

  if (by && (res.typeChanged || res.titleChanged || res.applied.length)) {
    const { writeAudit } = await import('../audit');
    const changes: Record<string, { from: any; to: any }> = {};
    if (res.typeChanged) changes.schema_id = { from: a.schema_id, to: schemaId };
    if (res.titleChanged) changes.title = { from: a.title, to: title };
    for (const k of res.applied) changes[`metadata.${k}`] = { from: a.metadata?.[k] ?? null, to: meta[k] };
    await writeAudit(null, { accountId: account, userId: by.userId, label: by.label, action: 'update', entityType: 'vod_asset', entityId: assetId, changes, snapshot: { via: 'filename', file: plan.file } }).catch(() => {});
  }
  try { (await import('../../scale/cache')).invalidateTag(`asset:${assetId}`); } catch { /* no cache */ }
  return res;
}

// ---- ingest ---------------------------------------------------------------------

/**
 * Before the type is final: may the file name choose it? Only when nobody chose
 * one (the operator) and no ingest rule named one, and the suggestion is
 * confident, uncontested and switched on.
 */
export async function typeForIngest(account: string, name: string, mode: 'auto' | 'suggest' | 'off'): Promise<{ typeId: string | null; reading: Reading | null }> {
  if (mode === 'off') return { typeId: null, reading: null };
  const settings = await loadSettings(account);
  const reading = await readName(account, name, { settings });
  const ok = mode === 'auto' && settings.autoType && reading.classification.confident && !reading.classification.conflict && reading.suggestedType;
  return { typeId: ok ? reading.suggestedType!.id : null, reading };
}

/** Values from the name for fields still empty after embedded metadata and rules (or filled by a rule default). */
export function ingestFill(reading: Reading, typeKey: string | null, fields: SchemaField[], merged: { metadata: Record<string, any>; sources: Record<string, string> }, settings: FilenameSettings): { values: Record<string, any>; provenance: Record<string, any> } {
  const values: Record<string, any> = {}, provenance: Record<string, any> = {};
  const at = new Date().toISOString();
  for (const v of fieldValues(reading.parse, typeKey, fields, settings)) {
    const src = merged.sources[v.field];
    if (!isEmpty(merged.metadata[v.field]) && src !== 'rule') continue;     // embedded tags and the operator win
    values[v.field] = v.value;
    provenance[v.field] = { source: 'filename', file: reading.parse.original, token: v.token, reason: v.reason, at };
  }
  // A content-link field the matcher will look after: its name now, so a required
  // "Trailer for" does not hold the file at the metadata gate; the link follows.
  for (const f of contentFields(fields)) {
    if (!relationOf(f).autoMatch || !isEmpty(merged.metadata[f.key])) continue;
    const q = matchQuery(reading.parse);
    if (q.title) { values[f.key] = { name: displayName(q) }; provenance[f.key] = { source: 'link', how: 'auto', linked: false, at }; }
  }
  return { values, provenance };
}

/** After the asset row is written: record the reading, link, and look again at names waiting for this record. */
export async function afterIngest(account: string, assetId: string, reading: Reading | null, extraProvenance: Record<string, any>, typeChosenBy: 'filename' | 'rule' | 'operator' | 'baseline'): Promise<void> {
  if (extraProvenance && Object.keys(extraProvenance).length)
    await query(`UPDATE vod_assets SET metadata_provenance = COALESCE(metadata_provenance, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [assetId, JSON.stringify(extraProvenance)]);
  if (reading) {
    // The type is the file name's to revisit only when nobody chose it.
    if (typeChosenBy === 'filename' || typeChosenBy === 'baseline')
      await query(`UPDATE vod_assets SET metadata_provenance = jsonb_set(COALESCE(metadata_provenance, '{}'::jsonb), '{@type}', $2::jsonb) WHERE id = $1`,
        [assetId, JSON.stringify({ source: typeChosenBy === 'filename' ? 'filename' : 'default', confidence: reading.classification.best?.confidence ?? null, reasons: reading.classification.best?.reasons ?? [], at: new Date().toISOString() })]);
    const a = await one<any>(`SELECT schema_id FROM vod_assets WHERE id = $1`, [assetId]);
    const { resolveEffectiveFields } = await import('../../modules/metadataSchemas');
    const fields = a?.schema_id ? (await resolveEffectiveFields(a.schema_id, account))?.fields ?? [] : [];
    const settings = await loadSettings(account);
    const lf = contentFields(fields).find((f) => relationOf(f).autoMatch);
    let link: any = null;
    const q = matchQuery(reading.parse);
    if (lf && q.title) {
      const r = await autoLink({ account, assetId, field: lf, query: q, allowLink: settings.autoLink, displayName: displayName(q) });
      link = { action: r.action, reason: r.reason };
    }
    const analysis = { at: new Date().toISOString(), by: null, file: reading.parse.original, mode: 'ingest', signals: reading.parse.signals,
      parsed: { title: reading.parse.title, series: reading.parse.series, episodeTitle: reading.parse.episodeTitle, season: reading.parse.season, episode: reading.parse.episode, year: reading.parse.year, date: reading.parse.date, resolution: reading.parse.resolution, fps: reading.parse.fps, language: reading.parse.language, promo: reading.parse.promo },
      classification: { summary: reading.classification.summary, best: reading.classification.best, conflict: reading.classification.conflict, confident: reading.classification.confident },
      typeChosenBy, match: lf ? { query: q } : null, link };
    await query(`UPDATE vod_assets SET filename_analysis = $2::jsonb WHERE id = $1`, [assetId, JSON.stringify(analysis)]);
  }
  // A record arriving may be the one an unresolved trailer is waiting for.
  const { rematchFor } = await import('../contentLinks');
  await rematchFor(account, assetId).catch((e) => console.warn('[filename] rematch failed', e));
}

export { BUILTIN_RULES, STANDARD_LABEL, linkValue };
export type { Candidate };
