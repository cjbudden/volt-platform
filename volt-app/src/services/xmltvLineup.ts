// ============================================================================
//  XMLTV IMPORT LINEUP: which of a feed's channels are used, and where they go.
//
//  Every channel a feed lists is recorded per source (epg_channel_aliases)
//  with its name, logo, channel number (<lcn>), how many programmes it has and
//  the span they cover. Each is in one of three states:
//
//    used      mapped to one Volt channel; its programmes are imported there
//    not used  `ignored`; skipped quietly, no warning on every run
//    waiting   new and undecided; skipped, and the run names it
//
//  A channel the feed has never listed before starts as waiting, or as not
//  used when the source says new channels are ignored (big lineups where only
//  a few channels matter).
//
//  AUTOMATIC MATCHING only ever takes an unambiguous match, and never touches
//  a channel somebody decided about (not used, or mapped by hand):
//    - our channel's XMLTV id equals theirs, and exactly one channel has it
//    - exactly one of OUR channels has the same name AND exactly one of THEIR
//      channels has that name. xmltv.net's Sydney feed lists "7 Sydney" three
//      times (7, 70, 71): none of the three is matched by name.
//  And one feed channel per Volt channel within a source: two of their
//  channels writing into one of ours would interleave two schedules.
//
//  SUGGESTIONS are softer and only shown, never applied on their own: the
//  feed's regional words ("Sydney", "NSW", words most of its channel names
//  share) are set aside and the rest compared with our channel names.
// ============================================================================
import { query, one } from '../db';
import type { XmltvChannelIn } from './xmltvParse';

export interface FeedChannelStats { count: number; from: number | null; to: number | null }

/** Lower case, accents and punctuation to spaces, single spaces. */
export function normName(s: string | null | undefined): string {
  return (s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9+!]+/g, ' ').trim();
}

/**
 * The words most of a feed's channel names share ("sydney", "nsw"): regional
 * suffixes, not identity. A word counts when it is in at least a quarter of
 * the names and the feed has at least 8 channels.
 */
export function commonWords(names: string[]): Set<string> {
  if (names.length < 8) return new Set();
  const n = new Map<string, number>();
  for (const name of names) for (const w of new Set(normName(name).split(' ').filter(Boolean))) n.set(w, (n.get(w) ?? 0) + 1);
  return new Set([...n].filter(([, c]) => c >= names.length / 4).map(([w]) => w));
}

/** A name with the feed's common words removed; the whole name if nothing would be left. */
export function coreName(name: string, common: Set<string>): string {
  const words = normName(name).split(' ').filter(Boolean);
  const core = words.filter((w) => !common.has(w));
  return (core.length ? core : words).join(' ');
}

const VARIANT_WORDS = ['hd', 'sd', 'uhd', '4k', '+1', 'tv'];
const stripVariants = (core: string) => core.split(' ').filter((w) => !VARIANT_WORDS.includes(w)).join(' ');

export interface FeedForSuggest { id: string; name: string | null; lcn?: string | null; count?: number }

/**
 * Pure: the suggested Volt channel for each feed channel, ONE TO ONE. A feed
 * often carries the same channel several times (SD and HD simulcasts, a second
 * number for the same service); only the best candidate is suggested for each
 * of our channels: one that actually has programmes, then an exact core-name
 * match before one that only matches without "HD"/"SD"/"+1", then the lowest
 * channel number. The others stay unsuggested, so accepting every
 * suggestion never puts two feed channels on one Volt channel.
 */
export function suggest(feed: FeedForSuggest[], ours: { id: string; name: string }[]): Map<string, string> {
  const common = commonWords(feed.map((f) => f.name ?? ''));
  const oursCore = ours.map((o) => ({ id: o.id, core: coreName(o.name, common) }));
  const cands = new Map<string, { f: FeedForSuggest; exact: boolean }[]>();   // our id -> candidates
  for (const f of feed) {
    if (!f.name) continue;
    const fc = coreName(f.name, common);
    let hits = oursCore.filter((o) => o.core === fc);
    let exact = true;
    if (!hits.length) {
      exact = false;
      const t = stripVariants(fc);
      hits = t ? oursCore.filter((o) => stripVariants(o.core) === t) : [];
    }
    if (hits.length !== 1) continue;   // two of ours look alike: no suggestion
    cands.set(hits[0].id, [...(cands.get(hits[0].id) ?? []), { f, exact }]);
  }
  const num = (v?: string | null) => { const n = parseFloat(v ?? ''); return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER; };
  const out = new Map<string, string>();
  for (const [ourId, list] of cands) {
    list.sort((x, y) => Number((y.f.count ?? 1) > 0) - Number((x.f.count ?? 1) > 0) || Number(y.exact) - Number(x.exact) || num(x.f.lcn) - num(y.f.lcn));
    out.set(list[0].f.id, ourId);
  }
  return out;
}

/**
 * Record the channels a feed lists (new ones as waiting or not used, per the
 * source), refresh what is known about each, then auto-match what is safe.
 */
export async function recordLineup(src: any, channels: Map<string, XmltvChannelIn>, stats: Map<string, FeedChannelStats>): Promise<void> {
  const ids = new Set([...channels.keys(), ...stats.keys()]);
  const ignoreNew = src.new_channels === 'ignore';
  for (const id of ids) {
    const c = channels.get(id);
    const st = stats.get(id);
    await query(
      `INSERT INTO epg_channel_aliases(account_id, source_id, external_id, display_name, icon, lcn, ignored, programmes_in_feed, feed_from, feed_to, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (source_id, external_id) DO UPDATE SET
             display_name = COALESCE(EXCLUDED.display_name, epg_channel_aliases.display_name),
             icon = COALESCE(EXCLUDED.icon, epg_channel_aliases.icon),
             lcn = COALESCE(EXCLUDED.lcn, epg_channel_aliases.lcn),
             programmes_in_feed = EXCLUDED.programmes_in_feed, feed_from = EXCLUDED.feed_from, feed_to = EXCLUDED.feed_to,
             last_seen_at = now()`,
      [src.account_id, src.id, id, c?.displayNames[0] ?? null, c?.icon ?? null, c?.lcn ?? null, ignoreNew,
       st?.count ?? 0, st?.from != null ? new Date(st.from).toISOString() : null, st?.to != null ? new Date(st.to).toISOString() : null]);
  }
  if (src.auto_map) await autoMap(src, channels);
}

/** The unambiguous matches, for channels nobody has decided about yet. */
export async function autoMap(src: any, channels: Map<string, XmltvChannelIn>): Promise<number> {
  const all = await query<any>(`SELECT id, external_id, display_name, channel_id, ignored FROM epg_channel_aliases WHERE source_id = $1`, [src.id]);
  // How many of THEIR channels carry each name: a name two of them share proves nothing.
  const feedNames = new Map<string, number>();
  for (const a of all) {
    const names = new Set([a.display_name, ...(channels.get(a.external_id)?.displayNames ?? [])].map(normName).filter(Boolean));
    for (const n of names) feedNames.set(n, (feedNames.get(n) ?? 0) + 1);
  }
  const ours = await query<any>(
    `SELECT c.id, c.name, c.xmltv_id FROM channels c JOIN groups g ON g.id = c.group_id WHERE g.account_id = $1`, [src.account_id]);
  const taken = new Set(all.filter((a) => a.channel_id).map((a) => a.channel_id));
  let n = 0;
  for (const a of all) {
    if (a.channel_id || a.ignored) continue;
    let target: string | null = null, how = '';
    const byId = ours.filter((o) => o.xmltv_id && o.xmltv_id.toLowerCase() === a.external_id.toLowerCase());
    if (byId.length === 1) { target = byId[0].id; how = 'auto:xmltv_id'; }
    else {
      const names = [...new Set([a.display_name, ...(channels.get(a.external_id)?.displayNames ?? [])].map(normName).filter(Boolean))];
      for (const nm of names) {
        if ((feedNames.get(nm) ?? 0) !== 1) continue;
        const byName = ours.filter((o) => normName(o.name) === nm);
        if (byName.length === 1) { target = byName[0].id; how = 'auto:name'; break; }
      }
    }
    if (!target || taken.has(target)) continue;
    taken.add(target);
    await query(`UPDATE epg_channel_aliases SET channel_id = $2, mapped_by = $3 WHERE id = $1 AND channel_id IS NULL`, [a.id, target, how]);
    n++;
  }
  return n;
}

/** Same-named channels in this source, keyed by alias id: the others' numbers, so the console can say "also on 70, 71". */
export function duplicateNames(rows: { id: string; display_name: string | null; lcn: string | null; external_id: string }[]): Map<string, string[]> {
  const by = new Map<string, typeof rows>();
  for (const r of rows) { const k = normName(r.display_name); if (!k) continue; by.set(k, [...(by.get(k) ?? []), r]); }
  const out = new Map<string, string[]>();
  for (const group of by.values()) {
    if (group.length < 2) continue;
    const num = (v: string | null) => { const n = parseFloat(v ?? ''); return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER; };
    const sorted = [...group].sort((x, y) => num(x.lcn) - num(y.lcn) || x.external_id.localeCompare(y.external_id));
    for (const r of group) out.set(r.id, sorted.filter((x) => x.id !== r.id).map((x) => x.lcn ?? x.external_id));
  }
  return out;
}

/** Which other import sources also feed a Volt channel, by name. */
export async function otherFeeders(sourceId: string, channelIds: string[]): Promise<Map<string, string[]>> {
  if (!channelIds.length) return new Map();
  const rows = await query<any>(
    `SELECT a.channel_id, s.name FROM epg_channel_aliases a JOIN epg_import_sources s ON s.id = a.source_id
      WHERE a.channel_id = ANY($1::uuid[]) AND a.source_id <> $2`, [channelIds, sourceId]);
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.channel_id, [...(out.get(r.channel_id) ?? []), r.name]);
  return out;
}

export async function aliasOf(aliasId: string, accountId: string) {
  return one<any>(`SELECT * FROM epg_channel_aliases WHERE id = $1 AND account_id = $2`, [aliasId, accountId]);
}
