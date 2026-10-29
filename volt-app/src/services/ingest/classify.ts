// ============================================================================
//  CLASSIFICATION RULES: from file-name signals to a suggested content type.
//
//  Pure. The rules are IF/THEN, kept per account (table filename_rules) on top
//  of the built-in set below, which is derived from the content taxonomy
//  (services/contentTypes.ts): the Trailer / promo type and its Kind list,
//  Programme / episode for season and episode markers, and the words that name
//  Interview, Clip / highlight, Music video, Movie and Bug.
//
//  PRECEDENCE, highest first, and what the result says about each:
//   1. A type a person chose (on upload, or later on the asset). Never changed
//      automatically: the caller does not ask (pipeline.ts, filenameApply.ts).
//   2. A type an ingest rule named explicitly. Same.
//   3. The account's own rules: if one matches, built-in rules only advise.
//   4. Built-in rules.
//
//  CONFLICTS
//   - A promotional marker at the END of the name outranks season and episode
//     markers: "Show_S01E03_Promo" is a promo for an episode. The episode
//     markers still help find what it promotes (contentLinks.ts).
//   - Otherwise two different types within CONFLICT_MARGIN of each other are a
//     conflict: nothing is set, both are offered with their reasons.
//
//  A suggestion is applied without asking only at AUTO_TYPE or above and with
//  no conflict. Below that it is shown for a person to accept.
// ============================================================================
import type { FilenameParse, Signal } from './filenameParse';

export const AUTO_TYPE = 0.8;
export const CONFLICT_MARGIN = 0.1;

export type SignalName = 'promo' | 'seasonEpisode' | 'episode' | 'season' | 'year' | 'date' | 'language';

export interface RuleWhen {
  /** Any of these words or phrases appears in the name (after normalising: case, separators, accents). */
  words?: string[];
  /** A signal the parser found. */
  signal?: SignalName;
  /** A regular expression tested on the normalised name (lower case, single spaces). */
  pattern?: string;
}

export interface RuleThen {
  /** A standard content type key (trailer, episode, movie ...). */
  typeKey?: string;
  /** Or an account content type id (a custom type). */
  typeId?: string;
  /** For a type with a Kind list (Trailer / promo): which kind. */
  kind?: string;
}

export interface ClassRule {
  id: string;
  name: string;
  enabled: boolean;
  origin: 'builtin' | 'account';
  ordinal: number;
  when: RuleWhen;
  then: RuleThen;
  /** 0..1, how strongly a match suggests the type. */
  confidence: number;
}

export interface TypeVote {
  typeKey: string | null;
  typeId: string | null;
  kind: string | null;
  confidence: number;
  origin: 'builtin' | 'account';
  ruleIds: string[];
  reasons: string[];
}

export interface Classification {
  /** The type this name suggests, or null. */
  best: TypeVote | null;
  /** Every type something pointed at, strongest first (best included). */
  votes: TypeVote[];
  /** Two types too close to call. */
  conflict: { between: TypeVote[]; reason: string } | null;
  /** True when best may be applied without asking (subject to precedence 1 and 2). */
  confident: boolean;
  /** Plain-English decision. */
  summary: string;
}

/** The Kind each promo word maps to, for the Trailer / promo type's trailerType field. */
const PROMO_KIND_FIELD = { trailer: 'trailerType' } as const;
export const KIND_FIELD: Record<string, string> = PROMO_KIND_FIELD;

/**
 * The built-in rules. Ids are stable (accounts switch them off by id), and every
 * one names a type from the standard taxonomy.
 */
export const BUILTIN_RULES: ClassRule[] = [
  { id: 'builtin:promo', name: 'Promotional markers (trailer, teaser, promo, featurette)', enabled: true, origin: 'builtin', ordinal: 10,
    when: { signal: 'promo' }, then: { typeKey: 'trailer' }, confidence: 0.9 },
  { id: 'builtin:season-episode', name: 'Season and episode markers (S01E03, 1x03)', enabled: true, origin: 'builtin', ordinal: 20,
    when: { signal: 'seasonEpisode' }, then: { typeKey: 'episode' }, confidence: 0.92 },
  { id: 'builtin:episode', name: 'Episode markers (E03, Ep 3, Episode 3)', enabled: true, origin: 'builtin', ordinal: 30,
    when: { signal: 'episode' }, then: { typeKey: 'episode' }, confidence: 0.82 },
  { id: 'builtin:season', name: 'Season markers alone (S1, Season 1, Series 1)', enabled: true, origin: 'builtin', ordinal: 40,
    when: { signal: 'season' }, then: { typeKey: 'episode' }, confidence: 0.65 },
  { id: 'builtin:interview', name: 'The word "interview"', enabled: true, origin: 'builtin', ordinal: 50,
    when: { words: ['interview'] }, then: { typeKey: 'interview' }, confidence: 0.7 },
  { id: 'builtin:highlights', name: 'Highlights and recaps', enabled: true, origin: 'builtin', ordinal: 60,
    when: { words: ['highlights', 'highlight', 'recap'] }, then: { typeKey: 'clip' }, confidence: 0.65 },
  { id: 'builtin:music-video', name: 'Music and lyric videos', enabled: true, origin: 'builtin', ordinal: 70,
    when: { words: ['music video', 'lyric video', 'official video'] }, then: { typeKey: 'music-video' }, confidence: 0.75 },
  { id: 'builtin:movie', name: 'Full movie, feature film', enabled: true, origin: 'builtin', ordinal: 80,
    when: { words: ['full movie', 'feature film'] }, then: { typeKey: 'movie' }, confidence: 0.6 },
  { id: 'builtin:bug', name: 'Sponsor bugs', enabled: true, origin: 'builtin', ordinal: 90,
    when: { words: ['sponsor bug', 'bug'] }, then: { typeKey: 'bug' }, confidence: 0.55 },
];

const has = (p: FilenameParse, k: Signal['kind']) => p.signals.some((s) => s.kind === k && !s.inTitle);
const sig = (p: FilenameParse, k: Signal['kind']) => p.signals.find((s) => s.kind === k && !s.inTitle);

/** Does a rule match, and why. Null when it does not. */
export function ruleMatches(rule: ClassRule, p: FilenameParse): { reason: string; confidence: number } | null {
  if (!rule.enabled) return null;
  const parts: string[] = [];
  let conf = rule.confidence;
  const w = rule.when ?? {};
  if (!w.words?.length && !w.signal && !w.pattern) return null;
  if (w.signal) {
    let s: Signal | undefined;
    if (w.signal === 'seasonEpisode') {
      if (!(has(p, 'season') && has(p, 'episode'))) return null;
      s = sig(p, 'episode');
    } else if (w.signal === 'episode') {
      if (!has(p, 'episode') || has(p, 'season')) return null;
      s = sig(p, 'episode');
    } else if (w.signal === 'season') {
      if (!has(p, 'season') || has(p, 'episode')) return null;
      s = sig(p, 'season');
    } else {
      s = sig(p, w.signal as Signal['kind']);
      if (!s) {
        // A weak promo word kept in the title still counts, at its own (low) confidence.
        const weak = w.signal === 'promo' ? p.signals.find((x) => x.kind === 'promo') : undefined;
        if (!weak) return null;
        s = weak;
      }
    }
    if (!s) return null;
    conf = Math.min(conf, s.confidence <= 0.7 ? s.confidence : conf);
    parts.push(s.reason);
  }
  if (w.words?.length) {
    const name = ` ${p.normalised} `;
    const hit = w.words.map((x) => normalisePhrase(x)).find((x) => x && name.includes(` ${x} `));
    if (!hit) return null;
    parts.push(`"${hit}" is in the name`);
  }
  if (w.pattern) {
    let ok = false;
    try { ok = w.pattern.length <= 200 && new RegExp(w.pattern, 'i').test(p.normalised); } catch { ok = false; }
    if (!ok) return null;
    parts.push(`the name matches /${w.pattern}/`);
  }
  return { reason: parts.join('; '), confidence: conf };
}

export function normalisePhrase(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Classify a parsed name with the account's rules and the built-ins.
 * `known` limits suggestions to types the account has (by standard key, or custom ids).
 */
export function classify(p: FilenameParse, accountRules: ClassRule[], opts: { disabledBuiltins?: string[]; known?: { keys: Set<string>; ids?: Set<string> } } = {}): Classification {
  const disabled = new Set(opts.disabledBuiltins ?? []);
  const rules = [
    ...accountRules.filter((r) => r.enabled).sort((a, b) => a.ordinal - b.ordinal),
    ...BUILTIN_RULES.filter((r) => !disabled.has(r.id)),
  ];
  const byType = new Map<string, TypeVote>();
  for (const r of rules) {
    const m = ruleMatches(r, p);
    if (!m) continue;
    const typeKey = r.then.typeKey ?? null, typeId = r.then.typeId ?? null;
    if (!typeKey && !typeId) continue;
    if (opts.known && typeKey && !opts.known.keys.has(typeKey)) continue;
    if (opts.known?.ids && typeId && !opts.known.ids.has(typeId)) continue;
    const k = typeId ?? typeKey!;
    const kind = r.then.kind ?? (typeKey === 'trailer' && p.promo ? p.promo.kind : null);
    const cur = byType.get(k);
    const reason = `${m.reason} (${r.origin === 'account' ? 'your rule' : 'built-in rule'} "${r.name}")`;
    if (!cur) byType.set(k, { typeKey, typeId, kind, confidence: m.confidence, origin: r.origin, ruleIds: [r.id], reasons: [reason] });
    else {
      cur.ruleIds.push(r.id); cur.reasons.push(reason);
      // Two rules agreeing raise it a little, never past 0.98.
      cur.confidence = Math.min(0.98, Math.max(cur.confidence, m.confidence) + 0.03);
      if (r.origin === 'account') cur.origin = 'account';
      if (!cur.kind && kind) cur.kind = kind;
    }
  }
  const votes = [...byType.values()].sort((a, b) => rank(b) - rank(a));
  if (!votes.length) return { best: null, votes, conflict: null, confident: false, summary: 'Nothing in the name suggests a content type.' };

  // 3. The account's rules beat the built-ins.
  const account = votes.filter((v) => v.origin === 'account');
  let pool = account.length ? account : votes;
  const notes: string[] = [];
  if (account.length && votes.length > account.length) notes.push('Your rules take precedence over the built-in rules.');

  // A promo marker at the end of the name outranks season/episode markers.
  const promo = pool.find((v) => v.typeKey === 'trailer');
  const episode = pool.find((v) => v.typeKey === 'episode');
  if (promo && episode && (p.promo?.confidence ?? 0) >= 0.85) {
    pool = [promo, ...pool.filter((v) => v !== promo && v !== episode)];
    notes.push('A promotional marker at the end of the name outranks season and episode markers: a promo for an episode is still a promo. The episode markers are used to find what it promotes.');
  }

  const best = pool[0];
  const rival = pool.find((v) => v !== best && v.confidence >= best.confidence - CONFLICT_MARGIN);
  if (rival) {
    return {
      best, votes, confident: false,
      conflict: { between: [best, rival], reason: `Signals point to two types: ${label(best)} (${pct(best.confidence)}) and ${label(rival)} (${pct(rival.confidence)}). Choose one.` },
      summary: `Not decided: ${label(best)} or ${label(rival)}.`,
    };
  }
  const confident = best.confidence >= AUTO_TYPE;
  return {
    best, votes, conflict: null, confident,
    summary: `${label(best)}${best.kind ? ` (${best.kind})` : ''}, ${pct(best.confidence)}${confident ? '' : ', below the level that is applied without asking'}. ${notes.join(' ')}`.trim(),
  };
}

const rank = (v: TypeVote) => v.confidence + (v.origin === 'account' ? 0.001 : 0);
const pct = (c: number) => `${Math.round(c * 100)}% sure`;
const label = (v: TypeVote) => v.typeKey ? STANDARD_LABEL[v.typeKey] ?? v.typeKey : 'your custom type';

export const STANDARD_LABEL: Record<string, string> = {
  clip: 'Clip / highlight', song: 'Song', interview: 'Interview', episode: 'Programme / episode', movie: 'Movie / feature film',
  trailer: 'Trailer / promo', 'music-video': 'Music video', bug: 'Bug / sponsor graphic',
};

/** Validate an account rule from the API. Throws a message for a person. */
export function checkRule(r: Partial<ClassRule>): void {
  const w = r.when ?? {};
  if (!w.words?.length && !w.signal && !w.pattern) throw new Error('A rule needs at least one condition: words, a signal or a pattern.');
  if (w.pattern) {
    if (w.pattern.length > 200) throw new Error('The pattern is longer than 200 characters.');
    try { new RegExp(w.pattern, 'i'); } catch (e: any) { throw new Error(`The pattern is not a valid regular expression: ${e.message}`); }
  }
  if (!r.then?.typeKey && !r.then?.typeId) throw new Error('A rule needs a content type to suggest.');
  if (r.confidence != null && (r.confidence < 0.1 || r.confidence > 0.98)) throw new Error('Confidence is between 0.1 and 0.98.');
}
