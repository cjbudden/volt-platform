// ============================================================================
//  FILL AN ASSET'S METADATA FROM THE EPG.
//
//  A clip cut from a channel or an event already has a description somewhere:
//  the programme that was on air when it was recorded. This finds that
//  programme and turns it into SUGGESTIONS for the asset's target fields
//  (services/vodLibrary.ts), each one carrying the programme it came from.
//
//  THE RULES, because this is the kind of feature that quietly damages data:
//   - Nothing is written without a confirm. The single-asset route previews,
//     then applies the fields the operator ticked.
//   - A field somebody already filled is NEVER overwritten unless that field is
//     named in `overwrite` by the operator, field by field. Bulk apply has no
//     overwrite at all: it fills empty fields and leaves everything else.
//   - Every value written records its provenance (programme id, when, who) on
//     vod_assets.metadata_provenance and in the audit log.
//
//  MATCHING. A programme linked to the asset (programmes.clip_asset_id, set
//  when the guide's auto-VOD made the clip) wins outright. Otherwise the
//  programmes of the same channel or event that overlap the asset's window,
//  ranked by overlap, using the as-run times when the guide has them. A match
//  is CONFIDENT when the best programme covers at least half of the asset and
//  no other programme comes close (the runner-up overlaps less than half as
//  much). Bulk apply only uses confident matches. An asset with no wall-clock
//  window (an uploaded file) or a stream with no guide gets no suggestions and
//  says why.
//
//  The programme metadata is read tolerantly: XMLTV import keys (subTitle,
//  description, genre/categories, season, episodeNumber, episode, rating,
//  icon, date, credits[], tags), the content-type mapping's flat
//  `credits.<role>` keys, and whatever else the EPG core adds later under the
//  same names. Missing keys are simply not suggested.
// ============================================================================
import { query, one } from '../db';
import type { SchemaField } from './metadataValidator';
import { validateMetadata } from './metadataValidator';
import { isFilled, targetFields } from './vodLibrary';
import { writeAudit } from './audit';

export interface ProgrammeRow {
  id: string;
  title: string;
  starts_at: string | Date;
  ends_at: string | Date;
  actual_start?: string | Date | null;
  actual_end?: string | Date | null;
  clip_asset_id?: string | null;
  series_title?: string | null;
  metadata?: Record<string, any> | null;
}

export interface Candidate {
  programmeId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  overlapMs: number;
  /** share of the asset the programme covers, 0..1 */
  assetCoverage: number;
  /** share of the programme the asset covers, 0..1 */
  programmeCoverage: number;
  linked: boolean;
}

export interface MatchResult {
  candidates: Candidate[];
  best: Candidate | null;
  confident: boolean;
  reason: string | null;
}

const ms = (d: string | Date | null | undefined) => (d == null ? NaN : d instanceof Date ? d.getTime() : Date.parse(d));

/** Rank programmes against an asset window. Pure, so every case is testable. */
export function rankProgrammes(assetId: string, window: { startMs: number; endMs: number } | null, programmes: ProgrammeRow[]): MatchResult {
  const linked = programmes.filter((p) => p.clip_asset_id && p.clip_asset_id === assetId);
  if (!window || !(window.endMs > window.startMs)) {
    if (!linked.length) return { candidates: [], best: null, confident: false, reason: 'This asset has no recorded time window, so there is no guide slot to match.' };
  }
  const dur = window ? Math.max(1, window.endMs - window.startMs) : 1;
  const cands: Candidate[] = [];
  for (const p of programmes) {
    const s = Number.isFinite(ms(p.actual_start)) ? ms(p.actual_start) : ms(p.starts_at);
    const e = Number.isFinite(ms(p.actual_end)) ? ms(p.actual_end) : ms(p.ends_at);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    const isLinked = !!p.clip_asset_id && p.clip_asset_id === assetId;
    const ov = window ? Math.max(0, Math.min(e, window.endMs) - Math.max(s, window.startMs)) : 0;
    if (ov <= 0 && !isLinked) continue;
    cands.push({
      programmeId: p.id, title: p.title, startsAt: new Date(s).toISOString(), endsAt: new Date(e).toISOString(),
      overlapMs: ov, assetCoverage: Math.min(1, ov / dur), programmeCoverage: Math.min(1, ov / (e - s)), linked: isLinked,
    });
  }
  cands.sort((a, b) => Number(b.linked) - Number(a.linked) || b.overlapMs - a.overlapMs || a.startsAt.localeCompare(b.startsAt));
  if (!cands.length) return { candidates: [], best: null, confident: false, reason: 'No programme in the guide overlaps this asset.' };
  const best = cands[0];
  if (best.linked) return { candidates: cands, best, confident: true, reason: null };
  const second = cands[1];
  const coversEnough = best.assetCoverage >= 0.5 || best.programmeCoverage >= 0.9;
  const clear = !second || second.overlapMs < best.overlapMs * 0.5;
  const confident = coversEnough && clear;
  return {
    candidates: cands, best, confident,
    reason: confident ? null : !coversEnough
      ? 'The best programme covers less than half of this asset.'
      : 'More than one programme overlaps this asset by a similar amount. Pick one.',
  };
}

// ---------------------------------------------------------------------------
//  Programme facts, read tolerantly.
// ---------------------------------------------------------------------------
export interface ProgrammeFacts {
  title: string | null; subTitle: string | null; series: string | null; description: string | null;
  genres: string[]; season: number | null; episodeNumber: number | null; episodeLabel: string | null;
  rating: string | null; image: string | null; year: number | null; language: string | null;
  keywords: string[]; credits: { role: string; name: string }[];
  homeTeam: string | null; awayTeam: string | null; competition: string | null; sport: string | null; venue: string | null;
}

const s1 = (v: any): string | null => {
  if (v == null) return null;
  if (Array.isArray(v)) return v.length ? s1(v[0]) : null;
  if (typeof v === 'object') return v.name ? String(v.name) : null;
  const t = String(v).trim();
  return t || null;
};
const list = (v: any): string[] => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map((x) => s1(x)).filter((x): x is string => !!x);
const n1 = (v: any): number | null => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? null : n; };

export function programmeFacts(p: ProgrammeRow): ProgrammeFacts {
  const m = p.metadata ?? {};
  const credits: { role: string; name: string }[] = [];
  if (Array.isArray(m.credits)) for (const c of m.credits) { if (c?.name) credits.push({ role: String(c.role ?? 'guest').toLowerCase(), name: String(c.name) }); }
  else if (m.credits && typeof m.credits === 'object') for (const [r, names] of Object.entries(m.credits)) for (const n of list(names)) credits.push({ role: r.toLowerCase(), name: n });
  for (const [k, v] of Object.entries(m)) { const mm = k.match(/^credits\.(\w+)$/); if (mm) for (const n of list(v)) credits.push({ role: mm[1].toLowerCase(), name: n }); }
  // episode: numbers first, then an onscreen label like "S2E5" or "Ep 5"
  let season = n1(m.season ?? m.seasonNumber ?? m.partOfSeason);
  let episodeNumber = n1(m.episodeNumber ?? m.episode_number ?? (typeof m.episode === 'number' ? m.episode : null));
  const episodeLabel = typeof m.episode === 'string' ? m.episode.trim() || null : null;
  if (episodeLabel && (season == null || episodeNumber == null)) {
    const se = episodeLabel.match(/S(\d+)\s*E(\d+)/i) ?? episodeLabel.match(/(\d+)\s*x\s*(\d+)/i);
    if (se) { season = season ?? Number(se[1]); episodeNumber = episodeNumber ?? Number(se[2]); }
    else { const e = episodeLabel.match(/^(?:ep(?:isode)?\.?\s*)?(\d+)$/i); if (e) episodeNumber = episodeNumber ?? Number(e[1]); }
  }
  const genres = [...new Set([...list(m.genre), ...list(m.categories), ...list(m.category)])];
  const dateStr = s1(m.date ?? m.year ?? m.released);
  const year = dateStr && /^\d{4}/.test(dateStr) ? Number(dateStr.slice(0, 4)) : null;
  const subTitle = s1(m.subTitle ?? m.sub_title ?? m.subtitle ?? m.episodeTitle);
  const series = s1(p.series_title ?? m.series ?? m.seriesTitle ?? m.partOfSeries);
  return {
    title: s1(p.title), subTitle, series, description: s1(m.description ?? m.desc ?? m.synopsis),
    genres, season, episodeNumber, episodeLabel, rating: s1(m.rating ?? m.contentRating),
    image: s1(m.icon ?? m.image ?? m.poster), year, language: s1(m.language ?? m.inLanguage),
    keywords: list(m.tags ?? m.keywords), credits,
    homeTeam: s1(m.homeTeam), awayTeam: s1(m.awayTeam), competition: s1(m.competition ?? m.superEvent),
    sport: s1(m.sport), venue: s1(m.venue ?? m.location),
  };
}

/** Is this programme shaped like an episode of a series? (XMLTV puts the series in <title> and the episode in <sub-title>.) */
const episodic = (f: ProgrammeFacts) => f.season != null || f.episodeNumber != null || !!f.series;
const SPORT_RX = /\b(sport|sports|football|soccer|rugby|cricket|tennis|basketball|hockey|baseball|golf|motorsport|athletics|afl|nrl)\b/i;
const MOVIE_RX = /\b(movie|film|feature film|cinema)\b/i;

/** The standard content type a programme looks like, or null when nothing says so. */
export function suggestTypeKey(f: ProgrammeFacts): string | null {
  if (f.homeTeam && f.awayTeam) return 'sports-match';
  if (episodic(f)) return 'episode';
  if (f.genres.some((g) => MOVIE_RX.test(g))) return 'movie';
  if (f.genres.some((g) => SPORT_RX.test(g)) && /\bv(s)?\.?\s/i.test(f.title ?? '')) return 'sports-match';
  return null;
}

/** The programme's value for one target field, typed for the field, or undefined. */
export function valueForField(field: SchemaField, f: ProgrammeFacts): unknown {
  const ep = episodic(f);
  const k = field.key;
  const slot = field.epg ?? '';
  // Keyed first: these keys mean the same thing on every standard type.
  let raw: unknown;
  if (k === 'series') raw = f.series ?? (ep ? f.title : null);
  else if (k === 'season') raw = f.season;
  else if (k === 'episodeNumber') raw = f.episodeNumber;
  else if (k === 'rating') raw = f.rating;
  else if (k === 'year') raw = f.year;
  else if (k === 'cast') raw = f.credits.filter((c) => c.role === 'actor').map((c) => c.name);
  else if (k === 'director') raw = f.credits.find((c) => c.role === 'director')?.name ?? null;
  else if (k === 'keywords') raw = f.keywords;
  else if (k === 'homeTeam') raw = f.homeTeam;
  else if (k === 'awayTeam') raw = f.awayTeam;
  else if (k === 'competition') raw = f.competition ?? (slot === 'sub-title' ? f.subTitle : null);
  else if (k === 'sport') raw = f.sport ?? f.genres.find((g) => SPORT_RX.test(g)) ?? null;
  else if (k === 'venue' || k === 'location') raw = f.venue;
  else if (slot === 'title') raw = ep && f.subTitle ? f.subTitle : f.title;
  else if (slot === 'sub-title') raw = f.subTitle;
  else if (slot === 'description') raw = f.description;
  else if (slot === 'category') raw = f.genres;
  else if (slot === 'episode') raw = f.episodeLabel ?? (f.episodeNumber != null ? String(f.episodeNumber) : null);
  else if (slot === 'icon' || field.type === 'image' || (field.type === 'url' && /image|thumbnail|artwork|poster/i.test(k))) raw = f.image;
  else if (slot === 'language') raw = f.language;
  else if (slot.startsWith('credits.')) { const role = slot.slice(8); raw = f.credits.filter((c) => c.role === role).map((c) => c.name); }
  else return undefined;
  return coerce(field, raw);
}

function coerce(field: SchemaField, raw: unknown): unknown {
  if (!isFilled(raw)) return undefined;
  const arr = Array.isArray(raw) ? raw.map(String) : [String(raw)];
  switch (field.type) {
    case 'number': { const n = Number(Array.isArray(raw) ? raw[0] : raw); return Number.isFinite(n) ? n : undefined; }
    case 'tags': return arr;
    case 'enum': {
      const opts = field.options ?? [];
      const hits = arr.map((v) => opts.find((o) => o.toLowerCase() === v.toLowerCase())).filter((x): x is string => !!x);
      if (!hits.length) return undefined;
      return field.multiple ? [...new Set(hits)] : hits[0];
    }
    case 'url': { const u = arr[0]; return /^https?:\/\//i.test(u) ? u : undefined; }
    case 'image': { const u = arr[0]; return /^https?:\/\//i.test(u) || /^\/library\//.test(u) ? u : undefined; }
    case 'date': { const d = arr[0]; return /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : /^\d{4}$/.test(d) ? `${d}-01-01` : undefined; }
    case 'boolean': return undefined;
    case 'reference': return { id: arr[0], name: arr[0] };
    // A guide gives a name, never a library record: it stays unresolved until linked.
    case 'content': return arr[0] ? { name: arr[0] } : undefined;
    default: return Array.isArray(raw) ? arr.join(', ') : String(raw);
  }
}

export interface Suggestion {
  field: string;
  label: string;
  value: unknown;
  current: unknown;
  /** fill: the field is empty. same: it already holds this. conflict: it holds something else (kept unless overwritten). */
  action: 'fill' | 'same' | 'conflict';
  required: boolean;
  programmeId: string;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Suggestions for every target field the programme can say something about. */
export function suggestionsFor(fields: SchemaField[], standardKey: string | null, metadata: Record<string, any>, p: ProgrammeRow): Suggestion[] {
  const facts = programmeFacts(p);
  const { fields: tf } = targetFields(fields, standardKey);
  // Every field of the type is offered (not only the targets): a programme that
  // knows the language should say so even if language is not a target.
  const order = [...tf, ...fields.filter((f) => !tf.some((t) => t.key === f.key)).map((f) => ({ ...f, required: !!f.required, why: 'schema' as const }))];
  const out: Suggestion[] = [];
  for (const f of order) {
    const v = valueForField(f, facts);
    if (v === undefined) continue;
    const cur = metadata?.[f.key];
    out.push({
      field: f.key, label: f.label ?? f.key, value: v, current: cur ?? null,
      action: !isFilled(cur) ? 'fill' : same(cur, v) ? 'same' : 'conflict',
      required: f.required, programmeId: p.id,
    });
  }
  return out;
}

/**
 * Merge chosen suggestions into metadata. `fields` limits which (default: all
 * fills); a conflict is applied only when its key is in `overwrite`. Returns
 * the new metadata and the keys actually changed.
 */
export function mergeSuggestions(metadata: Record<string, any>, suggestions: Suggestion[], opts: { fields?: string[] | null; overwrite?: string[] | null } = {}):
  { metadata: Record<string, any>; changed: string[]; skipped: { field: string; why: string }[] } {
  const next = { ...(metadata ?? {}) };
  const changed: string[] = [];
  const skipped: { field: string; why: string }[] = [];
  const pick = opts.fields ? new Set(opts.fields) : null;
  const over = new Set(opts.overwrite ?? []);
  for (const s of suggestions) {
    if (pick && !pick.has(s.field)) continue;
    if (s.action === 'same') continue;
    if (s.action === 'conflict' && !over.has(s.field)) { skipped.push({ field: s.field, why: 'already filled' }); continue; }
    next[s.field] = s.value;
    changed.push(s.field);
  }
  return { metadata: next, changed, skipped };
}

// ---------------------------------------------------------------------------
//  Database side.
// ---------------------------------------------------------------------------
export interface AssetForFill {
  id: string; channel_id: string | null; event_id: string | null; start_epoch_ms: string | number | null; end_epoch_ms: string | number | null;
  source_kind?: string | null; schema_id: string | null; metadata: Record<string, any> | null; title: string | null;
}

/** Programmes that could describe this asset: linked to it, or overlapping its window on the same stream. */
export async function programmesFor(a: AssetForFill): Promise<ProgrammeRow[]> {
  const start = Number(a.start_epoch_ms), end = Number(a.end_epoch_ms);
  const hasWindow = (a.channel_id || a.event_id) && a.source_kind !== 'upload' && a.source_kind !== 'watchfolder'
    && Number.isFinite(start) && Number.isFinite(end) && end > start && start > 946684800000; // a wall clock, not 0..duration
  try {
    return await query<ProgrammeRow>(
      `SELECT p.id, p.title, p.starts_at, p.ends_at, p.actual_start, p.actual_end, p.clip_asset_id, p.metadata,
              ps.title AS series_title
         FROM programmes p LEFT JOIN programme_series ps ON ps.id = p.series_id
        WHERE p.status IS DISTINCT FROM 'cancelled'
          AND (p.clip_asset_id = $1
               OR ($2::boolean AND (p.channel_id = $3 OR p.event_id = $4)
                   AND tstzrange(COALESCE(p.actual_start, p.starts_at), COALESCE(p.actual_end, p.ends_at), '[)')
                       && tstzrange(to_timestamp($5::float8 / 1000), to_timestamp($6::float8 / 1000), '[)')))
        ORDER BY p.starts_at LIMIT 50`,
      [a.id, !!hasWindow, a.channel_id, a.event_id, hasWindow ? start : 0, hasWindow ? end : 0]);
  } catch (e: any) {
    // No guide tables (a deployment without the EPG core): no suggestions, not an error.
    if (/relation .* does not exist/i.test(String(e?.message))) return [];
    throw e;
  }
}

export function windowOf(a: AssetForFill): { startMs: number; endMs: number } | null {
  const start = Number(a.start_epoch_ms), end = Number(a.end_epoch_ms);
  if (a.source_kind === 'upload' || a.source_kind === 'watchfolder') return null;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 946684800000) return null;
  return { startMs: start, endMs: end };
}

/** The asset's effective type: fields (with the parent's), standard key and name. */
export async function typeOf(schemaId: string | null, account: string): Promise<{ id: string; name: string; standardKey: string | null; schemaOrgType: string | null; fields: SchemaField[] } | null> {
  if (!schemaId) return null;
  const s = await one<any>(
    `SELECT ms.id, ms.name, ms.standard_key, ms.schema_org_type, ms.fields, parent.fields AS parent_fields
       FROM metadata_schemas ms LEFT JOIN metadata_schemas parent ON parent.id = ms.extends_id
      WHERE ms.id = $1 AND ms.account_id = $2`, [schemaId, account]);
  if (!s) return null;
  const byKey = new Map<string, SchemaField>();
  for (const f of (s.parent_fields ?? []) as SchemaField[]) byKey.set(f.key, f);
  for (const f of (s.fields ?? []) as SchemaField[]) byKey.set(f.key, f);
  return { id: s.id, name: s.name, standardKey: s.standard_key ?? null, schemaOrgType: s.schema_org_type ?? null, fields: [...byKey.values()] };
}

export interface FillPreview {
  match: MatchResult;
  programme: { id: string; title: string; startsAt: string; endsAt: string } | null;
  suggestions: Suggestion[];
  /** A different content type the programme looks like, offered, never applied without asking. */
  suggestedType: { key: string; id: string; name: string; dropsFields: string[] } | null;
  titleSuggestion: { value: string; current: string | null; action: 'fill' | 'same' | 'conflict' } | null;
}

export async function previewFill(a: AssetForFill, account: string, programmeId?: string | null): Promise<FillPreview> {
  const progs = await programmesFor(a);
  const match = rankProgrammes(a.id, windowOf(a), progs);
  const chosen = programmeId ? progs.find((p) => p.id === programmeId) ?? null : (match.best ? progs.find((p) => p.id === match.best!.programmeId) ?? null : null);
  if (programmeId && !chosen) {
    return { match: { ...match, reason: 'That programme does not overlap this asset.' }, programme: null, suggestions: [], suggestedType: null, titleSuggestion: null };
  }
  if (!chosen) return { match, programme: null, suggestions: [], suggestedType: null, titleSuggestion: null };
  const type = await typeOf(a.schema_id, account);
  const facts = programmeFacts(chosen);
  let suggestedType: FillPreview['suggestedType'] = null;
  const key = suggestTypeKey(facts);
  if (key && key !== type?.standardKey) {
    const t = await one<any>(`SELECT id, name FROM metadata_schemas WHERE account_id = $1 AND standard_key = $2`, [account, key]);
    if (t) {
      const nt = await typeOf(t.id, account);
      const keep = new Set((nt?.fields ?? []).map((f) => f.key));
      suggestedType = { key, id: t.id, name: t.name, dropsFields: Object.keys(a.metadata ?? {}).filter((k) => isFilled(a.metadata?.[k]) && !keep.has(k)) };
    }
  }
  const suggestions = type ? suggestionsFor(type.fields, type.standardKey, a.metadata ?? {}, chosen) : [];
  const ttl = facts.subTitle && episodic(facts) ? facts.subTitle : facts.title;
  const titleSuggestion = ttl ? { value: ttl, current: a.title, action: (!a.title ? 'fill' : a.title === ttl ? 'same' : 'conflict') as 'fill' | 'same' | 'conflict' } : null;
  return {
    match,
    programme: { id: chosen.id, title: chosen.title, startsAt: new Date(ms(chosen.starts_at)).toISOString(), endsAt: new Date(ms(chosen.ends_at)).toISOString() },
    suggestions, suggestedType, titleSuggestion,
  };
}

export interface ApplyOptions {
  programmeId?: string | null;
  fields?: string[] | null;
  overwrite?: string[] | null;
  /** switch to the suggested content type first (then suggest for it) */
  applyType?: boolean;
  /** set the asset title from the programme (only when empty, unless 'title' is in overwrite) */
  title?: boolean;
  /** bulk: only act on a confident match */
  requireConfident?: boolean;
}

export interface ApplyResult {
  assetId: string;
  applied: string[];
  skipped: { field: string; why: string }[];
  programmeId: string | null;
  typeChanged: boolean;
  titleChanged: boolean;
  reason: string | null;
}

export async function applyFill(a: AssetForFill, account: string, actorInfo: { userId: string | null; label: string }, opts: ApplyOptions): Promise<ApplyResult> {
  const base: ApplyResult = { assetId: a.id, applied: [], skipped: [], programmeId: null, typeChanged: false, titleChanged: false, reason: null };
  let preview = await previewFill(a, account, opts.programmeId);
  if (!preview.programme) return { ...base, reason: preview.match.reason ?? 'No programme to fill from.' };
  if (opts.requireConfident && !opts.programmeId && !preview.match.confident) return { ...base, reason: preview.match.reason };
  let schemaId = a.schema_id;
  let metadata = { ...(a.metadata ?? {}) };
  let typeChanged = false;
  if (opts.applyType && preview.suggestedType) {
    schemaId = preview.suggestedType.id;
    const nt = await typeOf(schemaId, account);
    const keep = new Set((nt?.fields ?? []).map((f) => f.key));
    metadata = Object.fromEntries(Object.entries(metadata).filter(([k]) => keep.has(k)));
    typeChanged = true;
    preview = await previewFill({ ...a, schema_id: schemaId, metadata }, account, preview.programme.id);
  }
  const prog = preview.programme;
  if (!prog) return { ...base, reason: preview.match.reason ?? 'No programme to fill from.' };
  const type = await typeOf(schemaId, account);
  if (!type) return { ...base, programmeId: prog.id, reason: 'Give the asset a content type first.' };
  const merged = mergeSuggestions(metadata, preview.suggestions, { fields: opts.fields, overwrite: opts.overwrite });
  // Validate like a save, but do not refuse because some OTHER required field is still empty:
  // filling part of a record is the point. Types and options are still checked.
  const lenient = type.fields.map((f) => ({ ...f, required: false }));
  const clean = validateMetadata(lenient, merged.metadata);
  let title = a.title;
  let titleChanged = false;
  const t = preview.titleSuggestion;
  if (opts.title && t && (t.action === 'fill' || (t.action === 'conflict' && (opts.overwrite ?? []).includes('title')))) { title = t.value; titleChanged = true; }
  if (!merged.changed.length && !typeChanged && !titleChanged) {
    return { ...base, programmeId: prog.id, skipped: merged.skipped, reason: merged.skipped.length ? 'Every suggested field is already filled.' : 'Nothing to fill.' };
  }
  const at = new Date().toISOString();
  const prov: Record<string, any> = {};
  for (const k of merged.changed) prov[k] = { source: 'epg', programmeId: prog.id, programmeTitle: prog.title, at, by: actorInfo.label };
  if (titleChanged) prov.title = { source: 'epg', programmeId: prog.id, programmeTitle: prog.title, at, by: actorInfo.label };
  await query(
    `UPDATE vod_assets SET schema_id = $2, metadata = $3::jsonb, title = $4,
            metadata_provenance = COALESCE(metadata_provenance, '{}'::jsonb) || $5::jsonb, updated_at = now()
      WHERE id = $1`,
    [a.id, schemaId, JSON.stringify(clean), title, JSON.stringify(prov)]);
  const changes: Record<string, { from: any; to: any }> = {};
  for (const k of merged.changed) changes[`metadata.${k}`] = { from: a.metadata?.[k] ?? null, to: clean[k] ?? null };
  if (typeChanged) changes.schema_id = { from: a.schema_id, to: schemaId };
  if (titleChanged) changes.title = { from: a.title, to: title };
  await writeAudit(null, {
    accountId: account, userId: actorInfo.userId, label: actorInfo.label, action: 'update', entityType: 'vod_asset', entityId: a.id,
    changes, snapshot: { source: 'epg', programmeId: prog.id, programmeTitle: prog.title, fields: merged.changed },
  }).catch(() => { /* the fill stands; the audit write is best effort like the other vod audit writes */ });
  return { ...base, applied: merged.changed, skipped: merged.skipped, programmeId: prog.id, typeChanged, titleChanged };
}

/** Drop provenance for fields whose value changed by hand (called after a metadata save). */
export async function pruneProvenance(assetId: string, before: Record<string, any> | null, after: Record<string, any> | null, titleBefore?: string | null, titleAfter?: string | null): Promise<void> {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const gone = [...keys].filter((k) => !same(before?.[k] ?? null, after?.[k] ?? null));
  if (titleAfter !== undefined && titleBefore !== titleAfter) gone.push('title');
  if (!gone.length) return;
  await query(`UPDATE vod_assets SET metadata_provenance = COALESCE(metadata_provenance, '{}'::jsonb) - $2::text[] WHERE id = $1`, [assetId, gone]);
}
