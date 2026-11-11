// ============================================================================
//  Find details: the general finder (build queue F1, decided 8 Nov 2026).
//
//  A person presses "Find details…" on an asset whose content type has no
//  specialist service (Songs and Music videos have the song finder). We ask
//  Wikidata, which is free, needs no key and is CC0 (its data may be used for
//  anything, no attribution required, though we show the link anyway so a
//  person can check what they are taking).
//
//  The results are mapped onto the content type's fields through each
//  field's schema.org name (`schemaOrg` on the field, services/contentTypes.ts),
//  never through field keys, so a type an account built for itself is
//  filled the same way as a standard one, and a field with no schema.org name
//  is simply never proposed.
//
//  Nothing here writes: the route shows what was found beside what the asset
//  has, and only what the person ticks is saved (modules/vodDetails.ts).
//
//  Two requests per search (the search, then the found items with their
//  statements in one call) plus one for the names of the things those
//  statements point at (directors, genres, languages...). One search at a
//  time across the process, a short gap between calls: Wikidata asks callers
//  to be gentle and to name themselves in the User-Agent.
// ============================================================================
import type { SchemaField } from '../metadataValidator';
import { dateAllowsYear } from '../metadataValidator';

const BASE = () => process.env.WIKIDATA_API_BASE ?? 'https://www.wikidata.org/w/api.php';
const UA = () => process.env.FIND_DETAILS_UA ?? process.env.TRACK_META_UA ?? 'VoltStream/0.1 ( https://github.com/volt-stream ) find-details';
const LANG = () => (process.env.FIND_DETAILS_LANG ?? 'en').toLowerCase();
const TIMEOUT_MS = () => Number(process.env.FIND_DETAILS_TIMEOUT_MS ?? 8000);
const GAP_MS = () => Number(process.env.FIND_DETAILS_MIN_GAP_MS ?? 250);

/** The values a Wikidata item gives, by schema.org property. */
export type SchemaValues = Record<string, { kind: 'text' | 'list' | 'date' | 'image' | 'url' | 'number'; value: any; precision?: number }>;

export interface FoundItem {
  id: string;
  label: string;
  description: string | null;
  /** What Wikidata says it is ("film", "television series episode"). */
  kinds: string[];
  link: string;
  imageUrl: string | null;
  values: SchemaValues;
  /** Its kind matches the content type's schema.org type: shown first. */
  likely: boolean;
}

// Wikidata properties -> schema.org names. Entity properties are read as the
// names of what they point at. The first property that has a value wins, so
// a more specific one goes first (P364 original language before P407).
type Kind = 'entity' | 'time' | 'string' | 'commons' | 'url' | 'quantity' | 'year';
const MAP: { schemaOrg: string; props: string[]; kind: Kind }[] = [
  { schemaOrg: 'genre', props: ['P136'], kind: 'entity' },
  { schemaOrg: 'director', props: ['P57'], kind: 'entity' },
  { schemaOrg: 'actor', props: ['P161'], kind: 'entity' },
  { schemaOrg: 'author', props: ['P50'], kind: 'entity' },
  { schemaOrg: 'byArtist', props: ['P175'], kind: 'entity' },
  { schemaOrg: 'performer', props: ['P175', 'P161'], kind: 'entity' },
  { schemaOrg: 'inAlbum', props: ['P361'], kind: 'entity' },
  { schemaOrg: 'recordLabel', props: ['P264'], kind: 'entity' },
  { schemaOrg: 'isrcCode', props: ['P1243'], kind: 'string' },
  { schemaOrg: 'datePublished', props: ['P577'], kind: 'time' },
  { schemaOrg: 'copyrightYear', props: ['P577'], kind: 'year' },
  { schemaOrg: 'dateCreated', props: ['P571', 'P577'], kind: 'time' },
  { schemaOrg: 'inLanguage', props: ['P364', 'P407'], kind: 'entity' },
  { schemaOrg: 'partOfSeries', props: ['P179'], kind: 'entity' },
  { schemaOrg: 'partOfSeason', props: ['P4908'], kind: 'entity' },
  { schemaOrg: 'image', props: ['P18'], kind: 'commons' },
  { schemaOrg: 'thumbnailUrl', props: ['P18'], kind: 'commons' },
  { schemaOrg: 'logo', props: ['P154'], kind: 'commons' },
  { schemaOrg: 'url', props: ['P856'], kind: 'url' },
  { schemaOrg: 'organizer', props: ['P664'], kind: 'entity' },
  { schemaOrg: 'location', props: ['P276'], kind: 'entity' },
  { schemaOrg: 'sport', props: ['P641'], kind: 'entity' },
  { schemaOrg: 'broadcaster', props: ['P449'], kind: 'entity' },
  { schemaOrg: 'about', props: ['P921'], kind: 'entity' },
  { schemaOrg: 'superEvent', props: ['P361'], kind: 'entity' },
  { schemaOrg: 'duration', props: ['P2047'], kind: 'quantity' },
];

// A content type's schema.org type -> the Wikidata classes a matching item is
// an instance of, so the likely ones come first. Only a ranking: nothing is
// left out for being of another kind (a documentary may be filed as a film).
const CLASSES: Record<string, string[]> = {
  Movie: ['Q11424', 'Q24869', 'Q506240', 'Q202866', 'Q93204'],
  Episode: ['Q21191270', 'Q1983062'],
  TVEpisode: ['Q21191270'],
  TVSeries: ['Q5398426'],
  MusicRecording: ['Q7366', 'Q134556', 'Q105543609'],
  MusicVideoObject: ['Q193977'],
  SportsEvent: ['Q16510064', 'Q46190676', 'Q27020041'],
  PodcastEpisode: ['Q61855877'],
  Person: ['Q5'],
};

/** schema.org names this finder can fill (for the type check and the guide). */
export const FILLABLE = new Set(['name', 'headline', 'description', ...MAP.map((m) => m.schemaOrg)]);

export class WikidataUnavailable extends Error {}

let chain: Promise<unknown> = Promise.resolve();
let last = 0;
/** One call at a time, a short gap between them, a timeout on each. */
async function call(params: Record<string, string>): Promise<any> {
  const run = async () => {
    const wait = last + GAP_MS() - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const u = new URL(BASE());
    for (const [k, v] of Object.entries({ ...params, format: 'json', formatversion: '2' })) u.searchParams.set(k, v);
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), TIMEOUT_MS());
    try {
      const res = await fetch(u, { signal: ac.signal, headers: { 'User-Agent': UA(), Accept: 'application/json' } });
      // 429: Wikimedia limits anonymous API clients per address, and more tightly
      // when the User-Agent names no contact (FIND_DETAILS_UA should, on a deployment).
      if (res.status === 429) throw new WikidataUnavailable('Wikidata is busy (too many searches from this server just now)');
      if (!res.ok) throw new WikidataUnavailable(`Wikidata answered ${res.status}`);
      const j: any = await res.json();
      if (j?.error) throw new WikidataUnavailable(`Wikidata: ${j.error.info ?? j.error.code ?? 'error'}`);
      return j;
    } catch (e: any) {
      if (e instanceof WikidataUnavailable) throw e;
      throw new WikidataUnavailable(e?.name === 'AbortError' ? 'Wikidata did not answer in time' : `Wikidata could not be reached (${String(e?.message ?? e).slice(0, 120)})`);
    } finally { clearTimeout(t); }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  return p;
}

const text = (o: any, lang: string): string | null => {
  if (!o) return null;
  const v = o[lang]?.value ?? o.en?.value ?? (o.mul?.value) ?? null;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};
/** formatversion=2 lists claims under each property; skip deprecated ones, prefer preferred. */
const claimsOf = (ent: any, p: string): any[] => {
  const all = (ent?.claims?.[p] ?? []).filter((c: any) => c?.rank !== 'deprecated' && c?.mainsnak?.snaktype === 'value');
  const pref = all.filter((c: any) => c.rank === 'preferred');
  return (pref.length ? pref : all).map((c: any) => c.mainsnak.datavalue?.value).filter((v: any) => v != null);
};
const commonsUrl = (file: string) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file.replace(/ /g, '_'))}?width=1200`;

/** A Wikidata time ("+1975-11-21T00:00:00Z", precision 11 day, 10 month, 9 year) as a date or a year. */
export function wikidataTime(v: { time?: string; precision?: number } | null | undefined): { date: string; precision: number } | null {
  const m = /^[+]?(\d{4})-(\d{2})-(\d{2})/.exec(String(v?.time ?? ''));
  if (!m) return null;
  const precision = Number(v?.precision ?? 11);
  if (precision < 9) return null;
  if (precision === 9 || m[2] === '00') return { date: m[1], precision: 9 };
  if (precision === 10 || m[3] === '00') return { date: `${m[1]}-${m[2]}`, precision: 10 };
  return { date: `${m[1]}-${m[2]}-${m[3]}`, precision: 11 };
}

/**
 * Search Wikidata for `term` and read the best few items in full.
 * `schemaOrgType` (the content type's) only decides the order.
 */
export async function findOnWikidata(term: string, schemaOrgType: string | null, limit = 6): Promise<FoundItem[]> {
  const lang = LANG();
  const s = await call({ action: 'wbsearchentities', search: term.slice(0, 250), language: lang, uselang: lang, type: 'item', limit: String(Math.min(limit, 10)) });
  const ids: string[] = (s?.search ?? []).map((r: any) => String(r.id)).filter((id: string) => /^Q\d+$/.test(id));
  if (!ids.length) return [];
  const g = await call({ action: 'wbgetentities', ids: ids.join('|'), props: 'labels|descriptions|claims', languages: `${lang}|en|mul` });
  const ents: any[] = ids.map((id) => g?.entities?.[id]).filter(Boolean);

  // The names of everything the statements point at, in one call (at most 50).
  const refs = new Set<string>();
  for (const e of ents) {
    for (const c of claimsOf(e, 'P31')) if (c?.id) refs.add(c.id);
    for (const m of MAP) if (m.kind === 'entity') for (const p of m.props) for (const c of claimsOf(e, p).slice(0, 12)) if (c?.id) refs.add(c.id);
  }
  const names = new Map<string, string>();
  const list = [...refs].slice(0, 50);
  if (list.length) {
    const r = await call({ action: 'wbgetentities', ids: list.join('|'), props: 'labels', languages: `${lang}|en|mul` });
    for (const id of list) { const t = text(r?.entities?.[id]?.labels, lang); if (t) names.set(id, t); }
  }

  const want = new Set(CLASSES[schemaOrgType ?? ''] ?? []);
  const items = ents.map((e): FoundItem => {
    const label = text(e.labels, lang) ?? e.id;
    const description = text(e.descriptions, lang);
    const values: SchemaValues = {};
    values.name = { kind: 'text', value: label };
    values.headline = { kind: 'text', value: label };
    if (description) values.description = { kind: 'text', value: description };
    for (const m of MAP) {
      if (values[m.schemaOrg]) continue;
      for (const p of m.props) {
        const cs = claimsOf(e, p);
        if (!cs.length) continue;
        if (m.kind === 'entity') {
          const ns = [...new Set(cs.slice(0, 12).map((c: any) => names.get(c?.id)).filter(Boolean) as string[])];
          if (ns.length) values[m.schemaOrg] = { kind: 'list', value: ns };
        } else if (m.kind === 'time' || m.kind === 'year') {
          const t = cs.map(wikidataTime).filter(Boolean).sort((a: any, b: any) => a.date.localeCompare(b.date))[0];
          if (t) values[m.schemaOrg] = m.kind === 'year' ? { kind: 'number', value: Number(t.date.slice(0, 4)) } : { kind: 'date', value: t.date, precision: t.precision };
        } else if (m.kind === 'commons') {
          if (typeof cs[0] === 'string') values[m.schemaOrg] = { kind: 'image', value: commonsUrl(cs[0]) };
        } else if (m.kind === 'url') {
          if (typeof cs[0] === 'string' && /^https?:\/\//.test(cs[0])) values[m.schemaOrg] = { kind: 'url', value: cs[0] };
        } else if (m.kind === 'quantity') {
          const n = Number(cs[0]?.amount);
          if (Number.isFinite(n)) values[m.schemaOrg] = { kind: 'number', value: n };
        } else if (typeof cs[0] === 'string') values[m.schemaOrg] = { kind: 'text', value: cs[0] };
        if (values[m.schemaOrg]) break;
      }
    }
    const kindIds = claimsOf(e, 'P31').map((c: any) => c?.id).filter(Boolean) as string[];
    return {
      id: e.id, label, description, kinds: kindIds.map((k) => names.get(k)).filter(Boolean).slice(0, 3) as string[],
      link: `https://www.wikidata.org/wiki/${e.id}`, imageUrl: values.image?.value ?? null, values,
      likely: kindIds.some((k) => want.has(k)),
    };
  });
  // Likely kinds first; otherwise Wikidata's own order (its search ranks by relevance).
  return items.map((it, i) => ({ it, i })).sort((a, b) => Number(b.it.likely) - Number(a.it.likely) || a.i - b.i).map((x) => x.it);
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * What an item would put in each of the type's fields, by schema.org name,
 * shaped as the field holds it (tags a list, a number a number, a date an ISO
 * date or a year where the field takes one, an enum one of its options). A
 * field with no schema.org name, or a value that does not fit, is left out.
 */
export function mapToFields(values: SchemaValues, fields: SchemaField[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const f of fields) {
    const so = f.schemaOrg;
    if (!so) continue;
    const v = values[so];
    if (!v || v.value == null || v.value === '') continue;
    const asList: string[] = Array.isArray(v.value) ? v.value.map(String) : [String(v.value)];
    switch (f.type) {
      case 'string': out[f.key] = asList.join(', '); break;
      case 'text': out[f.key] = asList.join(', '); break;
      case 'tags': out[f.key] = asList; break;
      case 'url': if (/^https?:\/\//.test(asList[0])) out[f.key] = asList[0]; break;
      case 'image': if (v.kind === 'image') out[f.key] = String(v.value); break;
      case 'number': {
        const n = typeof v.value === 'number' ? v.value : Number(/\d+(\.\d+)?/.exec(asList[0])?.[0]);
        if (Number.isFinite(n)) out[f.key] = n;
        break;
      }
      case 'date': {
        if (v.kind !== 'date') break;
        const d = String(v.value);
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) out[f.key] = d;
        else if (dateAllowsYear(f)) out[f.key] = d.slice(0, 4);
        // A month or year on a field that needs a full date: not guessed.
        break;
      }
      case 'enum': {
        const opts = f.options ?? [];
        const hits = asList.map((x) => opts.find((o) => norm(o) === norm(x)) ?? opts.find((o) => norm(x).includes(norm(o)) && norm(o).length > 2)).filter(Boolean) as string[];
        const uniq = [...new Set(hits)];
        if (uniq.length) out[f.key] = f.multiple ? uniq : uniq[0];
        break;
      }
      default: break; // boolean, reference, content: nothing to say from here
    }
  }
  return out;
}
