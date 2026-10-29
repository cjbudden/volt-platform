// ============================================================================
//  CONTENT LINKS: one library record pointing at another.
//
//  A trailer's "Trailer for" names the film it promotes. It used to be a text
//  field; it is now a content-link field (metadataValidator type 'content'):
//
//    confirmed    {id, name}  the record's stable id; name is its title when linked
//    unresolved   {name}      a name nobody has matched to a record yet
//
//  The table content_links (migration 0117) is the source of truth, one row per
//  field per asset, with who decided (a person, the matcher, the migration),
//  how sure, why, and the records a person could choose from. The asset's
//  metadata keeps a copy of the value so the form, the EPG and schema.org keep
//  reading it as before. Every writer here writes both; a trigger keeps the
//  copy right when the target is deleted or restored; and readers heal a value
//  written straight into metadata by an older path (readLinks).
//
//  RELATIONSHIPS AND DIRECTION
//   trailer_for   a trailer or promo -> the record it promotes. Inverse: trailers
//                 (the film lists its trailers and promos).
//   related       anything -> anything. Inverse: related.
//  A field names its relation (SchemaField.relation); a content field without
//  one is 'related'.
//
//  RULES
//   - Only records of the same account can be linked, read or listed.
//   - Never to itself, and never back the other way on the same relation
//     (A trailer_for B and B trailer_for A), so following links cannot loop.
//   - The API expands ONE level, as summaries with no links of their own.
//   - A link a person made is never changed by the matcher.
// ============================================================================
import { query, one } from '../db';
import type { SchemaField } from './metadataValidator';
import { ApiError } from '../util/http';
import { decideMatch, normTitle, yearInTitle, scoreCandidate, type MatchCandidate, type MatchDecision, type MatchQuery } from './relatedMatch';

export interface Relation {
  key: string;
  label: string;
  inverse: string;
  inverseLabel: string;
  /** Standard type keys a target may NOT have. */
  excludeTypes: string[];
  /** The ingest matcher looks for a target. */
  autoMatch: boolean;
}

export const RELATIONS: Record<string, Relation> = {
  trailer_for: { key: 'trailer_for', label: 'Trailer for', inverse: 'trailers', inverseLabel: 'Trailers and promos', excludeTypes: ['trailer', 'bug'], autoMatch: true },
  related: { key: 'related', label: 'Related', inverse: 'related', inverseLabel: 'Related', excludeTypes: [], autoMatch: false },
};
export const relationOf = (f: SchemaField): Relation => RELATIONS[f.relation ?? 'related'] ?? RELATIONS.related;
export const contentFields = (fields: SchemaField[] | null | undefined): SchemaField[] => (fields ?? []).filter((f) => f.type === 'content');

export type LinkSource = 'person' | 'auto' | 'migration';
export interface LinkValue { id?: string; name: string }
export interface Candidate { assetId: string; title: string; score: number; reasons: string[] }

/** The tenant boundary, the same as modules/vod.ts. */
const OWNED = `
  FROM vod_assets v
  LEFT JOIN channels c ON c.id = v.channel_id
  LEFT JOIN events   e ON e.id = v.event_id
  LEFT JOIN groups   g ON g.id = COALESCE(c.group_id, e.group_id)
  LEFT JOIN metadata_schemas ms  ON ms.id = v.schema_id
  LEFT JOIN metadata_schemas pms ON pms.id = ms.extends_id`;
const ACCT = `COALESCE(g.account_id, v.account_id)`;
const TYPE_KEY = `COALESCE(ms.standard_key, pms.standard_key)`;

/** A record as another record shows it: enough to show and to follow, no links of its own. */
export interface AssetSummary {
  id: string;
  title: string;
  contentType: { id: string; name: string; key: string | null } | null;
  durationMs: number | null;
  published: boolean;
  availabilityState: string | null;
  href: string;
}
const SUMMARY_COLS = `v.id, v.title, v.duration_ms, v.published, v.availability_state, v.metadata, ms.id AS type_id, ms.name AS type_name, ${TYPE_KEY} AS type_key`;
function summary(r: any): AssetSummary {
  return {
    id: r.id, title: r.title ?? r.metadata?.title ?? 'Untitled',
    contentType: r.type_id ? { id: r.type_id, name: r.type_name, key: r.type_key ?? null } : null,
    durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
    published: !!r.published, availabilityState: r.availability_state ?? null,
    href: `/api/vod/${r.id}`,
  };
}

export async function ownedSummaries(account: string, ids: string[]): Promise<Map<string, AssetSummary>> {
  if (!ids.length) return new Map();
  const rows = await query<any>(`SELECT ${SUMMARY_COLS} ${OWNED} WHERE v.id = ANY($1::uuid[]) AND ${ACCT} = $2`, [ids, account]);
  return new Map(rows.map((r: any) => [r.id, summary(r)]));
}

/** Normalise a stored value: {id,name} | {name} | 'text' (older) | null. */
export function linkValue(v: any): LinkValue | null {
  if (v == null || v === '') return null;
  if (typeof v === 'string') return v.trim() ? { name: v.trim() } : null;
  if (typeof v === 'object' && !Array.isArray(v)) {
    const name = typeof v.name === 'string' ? v.name.trim() : '';
    if (typeof v.id === 'string' && v.id) return { id: v.id.toLowerCase(), name };
    return name ? { name } : null;
  }
  return null;
}
const sameLink = (a: LinkValue | null, b: LinkValue | null) => (a?.id ?? null) === (b?.id ?? null) && (a?.id ? true : (a?.name ?? '') === (b?.name ?? ''));

/**
 * Check the content-link values about to be saved on an asset: each id is a record
 * of the same account, not the asset itself, of a type the relation allows, and not
 * linking back to this asset on the same relation. Returns the values with the
 * target's title filled in as the name where none was given.
 */
export async function checkContentValues(account: string, assetId: string | null, fields: SchemaField[], values: Record<string, any>): Promise<Record<string, any>> {
  const out = { ...values };
  for (const f of contentFields(fields)) {
    if (!(f.key in values)) continue;
    const v = linkValue(values[f.key]);
    if (!v) { delete out[f.key]; continue; }
    if (!v.id) { out[f.key] = { name: v.name }; continue; }
    await checkTarget(account, assetId, f, v.id);
    const t = await one<any>(`SELECT v.title, v.metadata ${OWNED} WHERE v.id = $1 AND ${ACCT} = $2`, [v.id, account]);
    out[f.key] = { id: v.id, name: v.name || t?.title || t?.metadata?.title || 'Untitled' };
  }
  return out;
}

async function checkTarget(account: string, assetId: string | null, f: SchemaField, targetId: string): Promise<void> {
  const rel = relationOf(f);
  if (assetId && targetId === assetId) throw new ApiError(422, `${f.label ?? f.key}: a record cannot be linked to itself`);
  const t = await one<any>(`SELECT v.id, ${TYPE_KEY} AS type_key ${OWNED} WHERE v.id = $1 AND ${ACCT} = $2`, [targetId, account]);
  if (!t) throw new ApiError(422, `${f.label ?? f.key}: no such record in this library`);
  const allowed = f.targetTypes?.length ? f.targetTypes : null;
  if (allowed && t.type_key && !allowed.includes(t.type_key)) throw new ApiError(422, `${f.label ?? f.key}: a ${t.type_key} record cannot be linked here`);
  if (!allowed && t.type_key && rel.excludeTypes.includes(t.type_key)) throw new ApiError(422, `${f.label ?? f.key}: a ${t.type_key} record cannot be linked here (a trailer is not the trailer for another trailer)`);
  if (assetId) {
    const back = await one<any>(`SELECT 1 AS x FROM content_links WHERE from_asset_id = $1 AND to_asset_id = $2 AND relation = $3`, [targetId, assetId, rel.key]);
    if (back) throw new ApiError(422, `${f.label ?? f.key}: that record already links to this one the same way; linking back would make a loop`);
  }
}

/**
 * Write one link: the table row, the metadata copy and the provenance, in that
 * order. `value` null removes it. A person's write clears the provenance entry
 * (a hand-made value is the person's), any other source records itself.
 */
export async function writeLink(o: {
  account: string; assetId: string; field: SchemaField; value: LinkValue | null; source: LinkSource; by: string | null;
  confidence?: number | null; reasons?: string[]; candidates?: Candidate[];
}): Promise<void> {
  const rel = relationOf(o.field);
  const k = o.field.key;
  if (!o.value) {
    await query(`DELETE FROM content_links WHERE from_asset_id = $1 AND field_key = $2`, [o.assetId, k]);
    await query(`UPDATE vod_assets SET metadata = COALESCE(metadata, '{}'::jsonb) - $2::text, metadata_provenance = COALESCE(metadata_provenance, '{}'::jsonb) - $2::text, updated_at = now() WHERE id = $1`, [o.assetId, k]);
    return;
  }
  if (o.value.id) await checkTarget(o.account, o.assetId, o.field, o.value.id);
  const reasons = (o.reasons ?? []).filter(Boolean).map((text) => ({ text }));
  await query(
    `INSERT INTO content_links (account_id, from_asset_id, field_key, relation, to_asset_id, to_name, source, confidence, reasons, candidates, decided_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)
     ON CONFLICT (from_asset_id, field_key) DO UPDATE SET relation = EXCLUDED.relation, to_asset_id = EXCLUDED.to_asset_id, to_name = EXCLUDED.to_name,
       source = EXCLUDED.source, confidence = EXCLUDED.confidence, reasons = EXCLUDED.reasons, candidates = EXCLUDED.candidates,
       decided_by = EXCLUDED.decided_by, updated_at = now()`,
    [o.account, o.assetId, k, rel.key, o.value.id ?? null, o.value.name, o.source, o.confidence ?? null, JSON.stringify(reasons), JSON.stringify(o.candidates ?? []), o.by]);
  const copy = o.value.id ? { id: o.value.id, name: o.value.name } : { name: o.value.name };
  const prov = o.source === 'person' ? null : { source: 'link', how: o.source, confidence: o.confidence ?? null, linked: !!o.value.id, at: new Date().toISOString() };
  await query(
    `UPDATE vod_assets SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), ARRAY[$2::text], $3::jsonb),
            metadata_provenance = CASE WHEN $4::jsonb IS NULL THEN COALESCE(metadata_provenance, '{}'::jsonb) - $2::text
                                       ELSE jsonb_set(COALESCE(metadata_provenance, '{}'::jsonb), ARRAY[$2::text], $4::jsonb) END,
            updated_at = now()
      WHERE id = $1`, [o.assetId, k, JSON.stringify(copy), prov ? JSON.stringify(prov) : null]);
}

/**
 * After the metadata form saved: bring the table in line with what the person saved.
 * Only fields whose value changed are touched, so a link the matcher made and the
 * person left alone keeps its reasons.
 */
export async function syncAfterSave(account: string, assetId: string, fields: SchemaField[], before: Record<string, any> | null, after: Record<string, any> | null, by: string | null): Promise<void> {
  for (const f of contentFields(fields)) {
    const b = linkValue(before?.[f.key]), a = linkValue(after?.[f.key]);
    if (sameLink(b, a) && (await one<any>(`SELECT 1 AS x FROM content_links WHERE from_asset_id = $1 AND field_key = $2`, [assetId, f.key]))) continue;
    if (!a) { await query(`DELETE FROM content_links WHERE from_asset_id = $1 AND field_key = $2`, [assetId, f.key]); continue; }
    const rel = relationOf(f);
    await query(
      `INSERT INTO content_links (account_id, from_asset_id, field_key, relation, to_asset_id, to_name, source, reasons, decided_by)
       VALUES ($1,$2,$3,$4,$5,$6,'person',$7::jsonb,$8)
       ON CONFLICT (from_asset_id, field_key) DO UPDATE SET relation = EXCLUDED.relation, to_asset_id = EXCLUDED.to_asset_id, to_name = EXCLUDED.to_name,
         source = 'person', confidence = NULL, reasons = EXCLUDED.reasons,
         candidates = CASE WHEN EXCLUDED.to_asset_id IS NULL THEN content_links.candidates ELSE '[]'::jsonb END,
         decided_by = EXCLUDED.decided_by, updated_at = now()`,
      [account, assetId, f.key, rel.key, a.id ?? null, a.name, JSON.stringify([{ text: a.id ? 'Linked by a person.' : 'Name entered by a person; not linked to a record yet.' }]), by]);
  }
}

export interface OutgoingLink {
  field: string; fieldLabel: string; relation: string; relationLabel: string;
  state: 'linked' | 'unresolved';
  name: string;
  asset: AssetSummary | null;
  source: LinkSource; confidence: number | null; reasons: string[];
  candidates: (Candidate & { asset: AssetSummary | null })[];
  decidedBy: string | null; updatedAt: string | null;
}
export interface IncomingLink {
  field: string; relation: string; relationLabel: string; asset: AssetSummary; source: LinkSource; confidence: number | null;
}
export interface LinkedContent { links: OutgoingLink[]; linkedFrom: IncomingLink[] }

/**
 * Both directions for one asset, one level deep. Heals rows from metadata first:
 * a content value with no row (written by an older path) gets one, a row whose
 * field no longer has a value goes.
 */
export async function readLinks(account: string, assetId: string, fields: SchemaField[]): Promise<LinkedContent> {
  const a = await one<any>(`SELECT v.metadata, v.metadata_provenance ${OWNED} WHERE v.id = $1 AND ${ACCT} = $2`, [assetId, account]);
  if (!a) return { links: [], linkedFrom: [] };
  const cf = contentFields(fields);
  let rows = await query<any>(`SELECT * FROM content_links WHERE from_asset_id = $1`, [assetId]);
  const byField = new Map(rows.map((r: any) => [r.field_key, r]));
  let healed = false;
  for (const f of cf) {
    const v = linkValue(a.metadata?.[f.key]);
    const r = byField.get(f.key);
    if (v && !r) {
      let id = v.id ?? null;
      if (id && !(await ownedSummaries(account, [id])).has(id)) id = null;
      await query(`INSERT INTO content_links (account_id, from_asset_id, field_key, relation, to_asset_id, to_name, source, reasons)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (from_asset_id, field_key) DO NOTHING`,
        [account, assetId, f.key, relationOf(f).key, id, v.name || 'Untitled', a.metadata_provenance?.[f.key] ? 'auto' : 'person',
         JSON.stringify([{ text: 'Recorded from the value already on the asset.' }])]);
      healed = true;
    } else if (!v && r) { await query(`DELETE FROM content_links WHERE id = $1`, [r.id]); healed = true; }
  }
  if (healed) rows = await query<any>(`SELECT * FROM content_links WHERE from_asset_id = $1`, [assetId]);
  // Rows for fields the asset's current type no longer has are not shown (and are kept, in case the type comes back).
  const keys = new Set(cf.map((f) => f.key));
  rows = rows.filter((r: any) => keys.has(r.field_key));

  const ids = new Set<string>();
  for (const r of rows) { if (r.to_asset_id) ids.add(r.to_asset_id); for (const c of r.candidates ?? []) if (c?.assetId) ids.add(c.assetId); }
  const incomingRows = await query<any>(`SELECT * FROM content_links WHERE to_asset_id = $1 AND account_id = $2 ORDER BY created_at`, [assetId, account]);
  for (const r of incomingRows) ids.add(r.from_asset_id);
  const sums = await ownedSummaries(account, [...ids]);

  const links: OutgoingLink[] = rows.map((r: any) => {
    const f = cf.find((x) => x.key === r.field_key)!;
    const rel = RELATIONS[r.relation] ?? RELATIONS.related;
    const target = r.to_asset_id ? sums.get(r.to_asset_id) ?? null : null;
    return {
      field: r.field_key, fieldLabel: f.label ?? f.key, relation: rel.key, relationLabel: rel.label,
      state: target ? 'linked' : 'unresolved',
      name: target?.title ?? r.to_name,
      asset: target,
      source: r.source, confidence: r.confidence != null ? Number(r.confidence) : null,
      reasons: (r.reasons ?? []).map((x: any) => String(x?.text ?? x)),
      candidates: target ? [] : (r.candidates ?? []).filter((c: any) => sums.has(c.assetId)).map((c: any) => ({ ...c, asset: sums.get(c.assetId) ?? null })),
      decidedBy: r.decided_by ?? null, updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
  });
  const linkedFrom: IncomingLink[] = incomingRows.filter((r: any) => sums.has(r.from_asset_id)).map((r: any) => {
    const rel = RELATIONS[r.relation] ?? RELATIONS.related;
    return { field: r.field_key, relation: rel.inverse, relationLabel: rel.inverseLabel, asset: sums.get(r.from_asset_id)!, source: r.source, confidence: r.confidence != null ? Number(r.confidence) : null };
  });
  return { links, linkedFrom };
}

// ---- finding the record a trailer promotes --------------------------------------

/** Records in the account that could be the target, prefiltered by the title's most telling words. */
export async function fetchCandidates(account: string, excludeId: string | null, q: MatchQuery, rel: Relation, opts: { text?: string; limit?: number } = {}): Promise<MatchCandidate[]> {
  const words = normTitle(opts.text ?? q.title).split(' ').filter((w) => w.length >= 3 && !['the', 'and'].includes(w)).sort((a, b) => b.length - a.length).slice(0, 3);
  const pats = (words.length ? words : [normTitle(opts.text ?? q.title)]).filter(Boolean).map((w) => `%${w.replace(/[%_\\]/g, '\\$&')}%`);
  if (!pats.length) return [];
  const rows = await query<any>(
    `SELECT v.id, v.title, v.metadata, ${TYPE_KEY} AS type_key ${OWNED}
      WHERE ${ACCT} = $1 AND ($2::uuid IS NULL OR v.id <> $2)
        AND COALESCE(v.metadata->>'fastFiller', '') <> 'true'
        AND (${TYPE_KEY} IS NULL OR NOT (${TYPE_KEY} = ANY($3::text[])))
        AND lower(COALESCE(v.title, '') || ' ' || COALESCE(v.metadata->>'title', '') || ' ' || COALESCE(v.metadata->>'series', '') || ' ' || COALESCE(v.metadata->>'headline', '')) LIKE ANY($4::text[])
      ORDER BY v.created_at DESC LIMIT $5`,
    [account, excludeId, rel.excludeTypes, pats, opts.limit ?? 300]);
  return rows.map((r: any) => {
    const m = r.metadata ?? {};
    const year = typeof m.year === 'number' ? m.year : /^\d{4}$/.test(String(m.year ?? '')) ? Number(m.year) : yearInTitle(r.title ?? '');
    return {
      id: r.id, title: r.title ?? m.title ?? 'Untitled',
      names: [m.title, m.series, m.headline].filter((x: any) => typeof x === 'string' && x.trim()),
      year, typeKey: r.type_key ?? null,
      season: typeof m.season === 'number' ? m.season : null,
      episode: typeof m.episodeNumber === 'number' ? m.episodeNumber : null,
    };
  });
}

export async function findRelated(account: string, assetId: string | null, q: MatchQuery, rel: Relation): Promise<MatchDecision> {
  return decideMatch(q, await fetchCandidates(account, assetId, q, rel));
}

/** What a person searching by name sees in the link field: records ranked by title. */
export async function searchCandidates(account: string, assetId: string | null, field: SchemaField | null, text: string, limit = 12): Promise<(Candidate & { asset: AssetSummary })[]> {
  const rel = field ? relationOf(field) : RELATIONS.related;
  const q: MatchQuery = { title: text, year: yearInTitle(text) };
  const cands = await fetchCandidates(account, assetId, q, rel, { text: text.replace(/\(\s*\d{4}\s*\)\s*$/, ''), limit: 200 });
  const scored = cands.map((c) => scoreCandidate(q, c)).sort((a, b) => b.score - a.score).slice(0, limit);
  const sums = await ownedSummaries(account, scored.map((s) => s.id));
  const allowed = field?.targetTypes?.length ? new Set(field.targetTypes) : null;
  return scored.filter((s) => sums.has(s.id) && (!allowed || !s.typeKey || allowed.has(s.typeKey)))
    .map((s) => ({ assetId: s.id, title: s.title, score: s.score, reasons: s.reasons, asset: sums.get(s.id)! }));
}

/**
 * The automatic step for one content field: link on a single clear match, keep
 * suggestions when it is close, fill only the name when the evidence is weak.
 * Never touches a value a person set. Returns what it did, for the analysis.
 */
export async function autoLink(o: {
  account: string; assetId: string; field: SchemaField; query: MatchQuery; allowLink: boolean; displayName: string;
}): Promise<{ action: 'linked' | 'suggested' | 'named' | 'kept' | 'none'; decision: MatchDecision | null; reason: string }> {
  const row = await one<any>(`SELECT source, to_asset_id FROM content_links WHERE from_asset_id = $1 AND field_key = $2`, [o.assetId, o.field.key]);
  const a = await one<any>(`SELECT metadata, metadata_provenance FROM vod_assets WHERE id = $1`, [o.assetId]);
  const cur = linkValue(a?.metadata?.[o.field.key]);
  const byPerson = row?.source === 'person' || (cur && !a?.metadata_provenance?.[o.field.key] && row?.source !== 'auto' && row?.source !== 'migration');
  if (byPerson) return { action: 'kept', decision: null, reason: 'A person set this link: it is left as it is.' };
  if (row?.to_asset_id && row.source !== 'auto') return { action: 'kept', decision: null, reason: 'Already linked.' };
  const rel = relationOf(o.field);
  const d = await findRelated(o.account, o.assetId, o.query, rel);
  const cands: Candidate[] = d.candidates.map((c) => ({ assetId: c.id, title: c.title, score: c.score, reasons: c.reasons }));
  if (d.action === 'link' && d.best && o.allowLink) {
    await writeLink({ account: o.account, assetId: o.assetId, field: o.field, value: { id: d.best.id, name: d.best.title }, source: 'auto', by: null,
      confidence: d.best.score, reasons: [d.reason, ...d.best.reasons], candidates: cands });
    return { action: 'linked', decision: d, reason: d.reason };
  }
  const reasons = d.action === 'link' ? [`${d.reason} Linking without asking is switched off for this account, so it is offered instead.`] : [d.reason];
  if (d.action === 'none') reasons.push('The name is taken from the file name and is not linked to a record.');
  await writeLink({ account: o.account, assetId: o.assetId, field: o.field, value: { name: o.displayName }, source: 'auto', by: null,
    confidence: d.best?.score ?? null, reasons, candidates: d.action === 'none' ? [] : cands });
  return { action: d.action === 'none' ? 'named' : 'suggested', decision: d, reason: reasons.join(' ') };
}

/**
 * A new record arrived: unresolved links in the account that name it are looked at
 * again. Links the matcher made are re-decided (and may link now); a name a person
 * typed only gains the new record as a suggestion, never a link.
 */
export async function rematchFor(account: string, newAssetId: string): Promise<number> {
  const t = await one<any>(`SELECT v.id, v.title, v.metadata, ${TYPE_KEY} AS type_key ${OWNED} WHERE v.id = $1 AND ${ACCT} = $2`, [newAssetId, account]);
  if (!t) return 0;
  const titles = [t.title, t.metadata?.title, t.metadata?.series].filter((x: any) => typeof x === 'string' && x.trim());
  if (!titles.length) return 0;
  const rows = await query<any>(
    `SELECT cl.*, v.filename_analysis, v.schema_id FROM content_links cl JOIN vod_assets v ON v.id = cl.from_asset_id
      WHERE cl.account_id = $1 AND cl.to_asset_id IS NULL AND cl.from_asset_id <> $2 ORDER BY cl.updated_at DESC LIMIT 200`, [account, newAssetId]);
  let changed = 0;
  for (const r of rows) {
    const rel = RELATIONS[r.relation] ?? RELATIONS.related;
    if (!rel.autoMatch || (t.type_key && rel.excludeTypes.includes(t.type_key))) continue;
    // A name a person typed is matched as typed; the matcher's own name by what it read from the file.
    const fromName: MatchQuery = { title: r.to_name.replace(/\s*\(\s*\d{4}\s*\)\s*$/, ''), year: yearInTitle(r.to_name) };
    const q: MatchQuery = r.source === 'person' ? fromName : r.filename_analysis?.match?.query ?? fromName;
    const sc = scoreCandidate(q, { id: t.id, title: t.title ?? '', names: titles, typeKey: t.type_key, year: typeof t.metadata?.year === 'number' ? t.metadata.year : yearInTitle(t.title ?? ''), season: t.metadata?.season ?? null, episode: t.metadata?.episodeNumber ?? null });
    if (sc.score < 0.5) continue;
    if (r.source === 'person') {
      const cands = (r.candidates ?? []).filter((c: any) => c.assetId !== t.id);
      cands.unshift({ assetId: t.id, title: t.title ?? 'Untitled', score: sc.score, reasons: [...sc.reasons, 'Added to the library after this name was entered.'] });
      await query(`UPDATE content_links SET candidates = $2::jsonb, updated_at = now() WHERE id = $1`, [r.id, JSON.stringify(cands.slice(0, 5))]);
      changed++;
      continue;
    }
    const fields = (await import('../modules/metadataSchemas')).resolveEffectiveFields;
    const ef = r.schema_id ? await fields(r.schema_id, account) : null;
    const f = contentFields(ef?.fields).find((x) => x.key === r.field_key);
    if (!f) continue;
    const s = await one<any>(`SELECT auto_link FROM filename_settings WHERE account_id = $1`, [account]);
    const res = await autoLink({ account, assetId: r.from_asset_id, field: f, query: q, allowLink: s?.auto_link !== false, displayName: r.to_name });
    if (res.action === 'linked' || res.action === 'suggested') changed++;
  }
  return changed;
}

/** Parse ?include=, keeping the API's default response unchanged when it is absent. */
export const INCLUDES = ['linkedContent'] as const;
export function parseInclude(raw: unknown): Set<string> {
  if (raw == null || raw === '') return new Set();
  const vals = (Array.isArray(raw) ? raw : [raw]).flatMap((x) => String(x).split(',')).map((s) => s.trim()).filter(Boolean);
  const bad = vals.filter((v) => !(INCLUDES as readonly string[]).includes(v));
  if (bad.length) throw new ApiError(400, `include: unknown value ${bad.map((b) => `"${b}"`).join(', ')}; allowed: ${INCLUDES.join(', ')}`);
  return new Set(vals);
}
