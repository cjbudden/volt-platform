// ============================================================================
//  FINDING WHAT A TRAILER OR PROMO BELONGS TO (pure scoring).
//
//  The question: for `Movie_Title_2025_Official_Trailer.mp4`, which record in
//  the library is "Movie Title (2025)"? The database step (contentLinks.ts)
//  fetches the plausible records; this file scores them and decides.
//
//  THE EVIDENCE, and what each is worth
//   - Title similarity, the backbone. The trailer's title with its promo
//     markers and tags already removed by the parser, against each candidate's
//     title, its metadata title and (for episodes) its series name. Exact after
//     normalising (case, accents, punctuation, "&" and "and") scores 1; else a
//     blend of word overlap and character-pair overlap.
//   - Year. The same year adds a little; a different year (more than one
//     apart, so a production year and a release year can differ) takes a lot
//     away: "Dune (1984)" is not the trailer for "Dune (2021)".
//   - Season and episode. A promo for S01E03 matches the episode with season 1
//     and episode 3, and is pushed away from other episodes and from films.
//
//  THE DECISION
//   - link: one candidate at AUTO_LINK or above, AUTO_GAP clear of the next.
//   - suggest: candidates at SUGGEST or above, best first, at most five; the
//     person chooses. Also when two are close.
//   - none: nothing good enough. No link is made on weak evidence.
// ============================================================================

export const AUTO_LINK = 0.85;
export const AUTO_GAP = 0.15;
export const SUGGEST = 0.5;

export interface MatchQuery {
  title: string;
  year?: number | null;
  season?: number | null;
  episode?: number | null;
  /** The text the markers were taken from, for the reason ("after removing ..."). */
  removed?: string[];
}

export interface MatchCandidate {
  id: string;
  title: string;
  /** Other names the record goes by: its metadata title, its series. */
  names?: string[];
  year?: number | null;
  typeKey?: string | null;
  season?: number | null;
  episode?: number | null;
}

export interface Scored { id: string; title: string; typeKey: string | null; score: number; reasons: string[] }

export interface MatchDecision {
  action: 'link' | 'suggest' | 'none';
  best: Scored | null;
  candidates: Scored[];
  reason: string;
}

/** Lower case, accents off, punctuation off, "&" as "and", a trailing "(2025)" taken off. */
export function normTitle(s: string): string {
  // Only a bracketed year is taken off: "Blade Runner 2049" keeps its 2049.
  return String(s ?? '').replace(/\s*[([]\s*(19|20)\d{2}\s*[)\]]\s*$/, '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
/** A year written into a title in brackets, "Movie Title (2025)". */
export function yearInTitle(s: string): number | null {
  const m = /[([]\s*(19\d{2}|20\d{2})\s*[)\]]\s*$/.exec(String(s ?? ''));
  return m ? Number(m[1]) : null;
}

const STOP = new Set(['the', 'a', 'an', 'of', 'and']);
const words = (s: string) => normTitle(s).split(' ').filter((w) => w && !STOP.has(w));
function dice<T>(a: T[], b: T[]): number {
  if (!a.length || !b.length) return 0;
  const m = new Map<T, number>();
  for (const x of a) m.set(x, (m.get(x) ?? 0) + 1);
  let both = 0;
  for (const x of b) { const n = m.get(x) ?? 0; if (n > 0) { both++; m.set(x, n - 1); } }
  return (2 * both) / (a.length + b.length);
}
const pairs = (s: string) => { const t = normTitle(s).replace(/ /g, ''); const out: string[] = []; for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2)); return out; };

/** 0..1 similarity of two titles. */
export function titleSimilarity(a: string, b: string): number {
  const na = normTitle(a), nb = normTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  // "the office" vs "office": articles do not make two titles different.
  if (words(a).join(' ') === words(b).join(' ') && words(a).length) return 0.97;
  return 0.6 * dice(words(a), words(b)) + 0.4 * dice(pairs(a), pairs(b));
}

export function scoreCandidate(q: MatchQuery, c: MatchCandidate): Scored {
  const reasons: string[] = [];
  const names = [c.title, ...(c.names ?? [])].filter(Boolean);
  let sim = 0, via = c.title;
  for (const n of names) { const s = titleSimilarity(q.title, n); if (s > sim) { sim = s; via = n; } }
  const removed = q.removed?.length ? ` after taking ${q.removed.map((r) => `"${r}"`).join(', ')} out of the file name` : '';
  if (sim === 1) reasons.push(`The title matches "${via}" exactly${removed}.`);
  else if (sim >= 0.97) reasons.push(`The title matches "${via}" apart from "the" or "a".`);
  else reasons.push(`The title is ${Math.round(sim * 100)}% similar to "${via}".`);
  let score = sim;

  const cy = c.year ?? yearInTitle(c.title);
  if (q.year && cy) {
    if (q.year === cy) { score += 0.08; reasons.push(`Same year (${cy}).`); }
    else if (Math.abs(q.year - cy) === 1) reasons.push(`Years one apart (${q.year} and ${cy}): a production and a release year can differ.`);
    else { score -= 0.4; reasons.push(`Different year: the file says ${q.year}, the record ${cy}.`); }
  }

  const qse = q.season != null || q.episode != null;
  if (qse) {
    if (c.typeKey === 'episode' || c.season != null || c.episode != null) {
      const sOk = q.season == null || c.season == null || q.season === c.season;
      const eOk = q.episode == null || c.episode == null || q.episode === c.episode;
      const known = (q.season == null || c.season != null) && (q.episode == null || c.episode != null);
      if (sOk && eOk && known) { score += 0.1; reasons.push(`Same season and episode (${se(q)}).`); }
      else if (!sOk || !eOk) { score -= 0.5; reasons.push(`A different episode: the file says ${se(q)}, the record ${se(c)}.`); }
    } else if (c.typeKey === 'movie') { score -= 0.15; reasons.push('The file names an episode, the record is a film.'); }
  } else if (c.typeKey === 'episode' && (c.season != null || c.episode != null)) {
    // A promo for a whole series cannot pick one of its episodes by itself.
    score -= 0.2; reasons.push('The record is one episode, the file names no episode.');
  }
  return { id: c.id, title: c.title, typeKey: c.typeKey ?? null, score: Math.max(0, Math.min(1, Math.round(score * 1000) / 1000)), reasons };
}

function se(x: { season?: number | null; episode?: number | null }) {
  return [x.season != null ? `season ${x.season}` : null, x.episode != null ? `episode ${x.episode}` : null].filter(Boolean).join(', ') || 'no episode';
}

export function decideMatch(q: MatchQuery, cands: MatchCandidate[]): MatchDecision {
  if (!normTitle(q.title)) return { action: 'none', best: null, candidates: [], reason: 'The file name leaves no title to look for.' };
  const scored = cands.map((c) => scoreCandidate(q, c)).sort((a, b) => b.score - a.score);
  const best = scored[0] ?? null;
  if (!best || best.score < SUGGEST) {
    return { action: 'none', best: null, candidates: [], reason: best ? `The closest record, "${best.title}", is only ${Math.round(best.score * 100)}% alike: not enough to suggest it.` : 'No record in the library has a title like it.' };
  }
  const second = scored[1];
  const shortlist = scored.filter((s) => s.score >= Math.max(SUGGEST, best.score - 0.25)).slice(0, 5);
  if (best.score >= AUTO_LINK && (!second || best.score - second.score >= AUTO_GAP)) {
    return { action: 'link', best, candidates: shortlist, reason: `One record matches clearly: "${best.title}" (${Math.round(best.score * 100)}%).` };
  }
  const why = best.score >= AUTO_LINK && second
    ? `Two records are close: "${best.title}" (${Math.round(best.score * 100)}%) and "${second.title}" (${Math.round(second.score * 100)}%). Choose one.`
    : `The best match, "${best.title}", is ${Math.round(best.score * 100)}% alike: below the level that links without asking.`;
  return { action: 'suggest', best, candidates: shortlist, reason: why };
}
