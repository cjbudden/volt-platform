// ============================================================================
//  FILE NAMES AS A METADATA SOURCE (docs/DESIGN_filename_metadata.md).
//
//  Pure. Turns `Movie_Title_2025_Official_Trailer_1080p.mp4` into signals
//  (resolution 1080p, promotional marker "Official Trailer" of kind Trailer,
//  year 2025) and what is left of the name as a title ("Movie Title").
//
//  EVERYTHING HERE IS A SIGNAL, NOT A FACT. Each one carries the token it came
//  from, a confidence and a sentence a person can read ("`S01E03`: season 1,
//  episode 3"). What is done with them (set a type, fill a field, look for the
//  film a trailer belongs to) is decided elsewhere, with precedence and
//  thresholds: services/ingest/classify.ts and services/contentLinks.ts.
//
//  HOW THE NAME IS READ
//   1. Drop the folder and the extension. Rewrite a few compound spellings
//      that separators would otherwise break (h.264, web-dl, 2026-10-28).
//   2. Split into tokens on separators: _ - . space + , ; brackets. A dot
//      between two digits is not a separator (5.1, 23.976).
//   3. Season and episode markers are found ANYWHERE: they divide the name
//      into the series (before) and the episode's own title (after).
//   4. Tags are peeled from the RIGHT end inward while they are recognised
//      (that is where 1080p, h264, v2, a year and "Official Trailer" pile up),
//      then a few kinds from the LEFT end (a date, a promo word, a house code).
//   5. What remains is the title, title cased. A peel that would leave no title
//      is not made: `1917.mp4` is titled "1917", not given the year 1917.
// ============================================================================

export type SignalKind =
  | 'resolution' | 'fps' | 'videoCodec' | 'audio' | 'source' | 'version' | 'language'
  | 'year' | 'date' | 'season' | 'episode' | 'part' | 'promo' | 'typeWord' | 'house';

export interface Signal {
  kind: SignalKind;
  /** The text in the file name, as written. */
  token: string;
  /** Normalised value: '1080p', 2025, 'Trailer', 3. */
  value: any;
  /** 0..1: how sure the reading is on its own. */
  confidence: number;
  /** One sentence a person can read. */
  reason: string;
  /** For typeWord and account words: the rule that recognised it. */
  ruleId?: string;
  /** Recognised but left in the title (a type word in the middle of a name). */
  inTitle?: boolean;
}

export type PromoKind = 'Trailer' | 'Teaser' | 'Promo' | 'Featurette' | 'Clip';

export interface FilenameParse {
  original: string;
  /** Without folder and extension. */
  base: string;
  extension: string | null;
  /** Lower case, separators collapsed to single spaces: what rules match against. */
  normalised: string;
  signals: Signal[];
  /** What is left once tags are taken off, title cased. Null if nothing is left. */
  title: string | null;
  /** Episodes: the text before the season/episode marker (the programme or series). */
  series: string | null;
  /** Episodes: the text after the marker, if there is any. */
  episodeTitle: string | null;
  season: number | null;
  episode: number | null;
  part: number | null;
  year: number | null;
  date: string | null;
  resolution: string | null;
  height: number | null;
  fps: number | null;
  language: string | null;
  /** A promotional marker was found (trailer, teaser, promo ...). */
  promo: { kind: PromoKind; token: string; confidence: number } | null;
  /** The tokens the title was built from, lower case (for matching). */
  titleWords: string[];
}

export interface ParseOptions {
  /** Extra words (or phrases) that are tags, not title: the account's rule words. */
  extraWords?: { words: string[]; ruleId: string; kind?: SignalKind }[];
  /** 'every' (default): capitalise every word. 'headline': keep short words lower case. */
  titleCase?: 'every' | 'headline';
  /** The year to treat as "now" (tests pin it). */
  nowYear?: number;
}

// ---- vocabularies -----------------------------------------------------------

const PROMO_WORDS: Record<string, PromoKind> = {
  trailer: 'Trailer', trailers: 'Trailer', tlr: 'Trailer', trl: 'Trailer',
  teaser: 'Teaser', 'sneak peek': 'Teaser', 'first look': 'Teaser',
  promo: 'Promo', promos: 'Promo', 'tv spot': 'Promo', spot: 'Promo',
  featurette: 'Featurette', 'behind the scenes': 'Featurette', bts: 'Featurette', 'making of': 'Featurette',
};
/** Words that only belong to a promo marker when they sit right before it ("Official Trailer"). */
const PROMO_MODIFIERS = new Set(['official', 'final', 'international', 'theatrical', 'main', 'new', 'teaser', 'red', 'band', 'hd', 'extended', 'exclusive', 'us', 'uk']);

/** Words that suggest a content type on their own (lower confidence than markers). */
export const TYPE_WORDS: Record<string, { typeKey: string; confidence: number }> = {
  interview: { typeKey: 'interview', confidence: 0.7 },
  highlights: { typeKey: 'clip', confidence: 0.65 }, highlight: { typeKey: 'clip', confidence: 0.65 }, recap: { typeKey: 'clip', confidence: 0.6 },
  'music video': { typeKey: 'music-video', confidence: 0.75 }, 'lyric video': { typeKey: 'music-video', confidence: 0.75 }, mv: { typeKey: 'music-video', confidence: 0.55 },
  'full movie': { typeKey: 'movie', confidence: 0.6 }, 'feature film': { typeKey: 'movie', confidence: 0.6 },
  'sponsor bug': { typeKey: 'bug', confidence: 0.6 }, bug: { typeKey: 'bug', confidence: 0.55 },
};

const VIDEO_CODECS = new Set(['h264', 'h265', 'x264', 'x265', 'hevc', 'avc', 'av1', 'vp9', 'vp8', 'prores', 'dnxhd', 'dnxhr', 'xvid', 'divx', 'mpeg2', 'mpeg4', 'xdcam', 'xavc']);
const AUDIO = /^(aac|ac3|eac3|e-ac3|dts|truehd|flac|opus|pcm|lpcm|stereo|mono|atmos|(dd|ddp)?(2\.0|5\.1|7\.1))$/;
const SOURCES = new Set(['web', 'webdl', 'webrip', 'bluray', 'bdrip', 'brrip', 'hdtv', 'dvdrip', 'dvd', 'remux', 'hdr', 'hdr10', 'sdr', 'uhdbd']);
const VERSION_WORDS = new Set(['final', 'master', 'clean', 'textless', 'proper', 'repack', 'draft', 'approved', 'mezz', 'mezzanine', 'export']);
/**
 * Words that are also ordinary English (Charlotte's Web, The Master, Final Destination,
 * the Merry Month of May). They are tags only when written in capitals, in brackets,
 * or when at least two real title words would remain.
 */
const AMBIGUOUS = new Set(['web', 'dvd', 'hdr', 'sdr', 'stereo', 'mono', 'atmos', 'final', 'master', 'clean', 'proper', 'draft', 'approved', 'export', 'spot', 'bug', 'mv', 'recap', 'highlight', 'highlights', 'interview']);

// Two-letter codes are English words too (it, is, in, to, de, es ...), so a
// two-letter code counts only when written in capitals (EN, FR) or bracketed.
const LANG2: Record<string, string> = { en: 'en', fr: 'fr', de: 'de', es: 'es', it: 'it', th: 'th', zh: 'zh', ja: 'ja', ko: 'ko', pt: 'pt', ms: 'ms', id: 'id', vi: 'vi', ar: 'ar', hi: 'hi', tl: 'tl', nl: 'nl', ru: 'ru', sv: 'sv', da: 'da', no: 'no', fi: 'fi', pl: 'pl', tr: 'tr' };
const LANG3: Record<string, string> = {
  eng: 'en', english: 'en', fre: 'fr', fra: 'fr', french: 'fr', ger: 'de', deu: 'de', german: 'de', spa: 'es', spanish: 'es', ita: 'it', italian: 'it',
  tha: 'th', thai: 'th', chi: 'zh', zho: 'zh', chinese: 'zh', mandarin: 'zh', cantonese: 'yue', jpn: 'ja', japanese: 'ja', kor: 'ko', korean: 'ko',
  por: 'pt', portuguese: 'pt', may: 'ms', msa: 'ms', malay: 'ms', ind: 'id', indonesian: 'id', vie: 'vi', vietnamese: 'vi', ara: 'ar', arabic: 'ar',
  hin: 'hi', hindi: 'hi', fil: 'tl', tagalog: 'tl', filipino: 'tl', dut: 'nl', nld: 'nl', dutch: 'nl', rus: 'ru', russian: 'ru',
};

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on', 'or', 'the', 'to', 'vs', 'via', 'with']);
const ROMAN = /^(ii|iii|iv|vi|vii|viii|ix|xi|xii|xiii)$/i;

// ---- tokenising -------------------------------------------------------------

interface Tok { text: string; lower: string; bracketed: boolean; i: number }

const DOT = '․';     // a dot inside a number (5.1), so the split leaves it alone
const DATE_MARK = '⁣D';

function splitName(original: string): { base: string; extension: string | null } {
  const file = original.split(/[\\/]/).pop() ?? original;
  const m = /^(.*)\.([A-Za-z0-9]{2,5})$/.exec(file);
  // A name that IS an extension-looking thing ("5.1") keeps it.
  if (m && m[1] && !/^\d+$/.test(m[2])) return { base: m[1], extension: m[2].toLowerCase() };
  return { base: file, extension: null };
}

function tokenise(base: string, dates: string[]): Tok[] {
  let s = base.normalize('NFKC');
  // Dates before anything splits them: 2026-10-28, 2026_10_28, 28.10.2026.
  s = s.replace(/(?<![0-9])((?:19|20)\d{2})[-_.](0[1-9]|1[0-2])[-_.](0[1-9]|[12]\d|3[01])(?![0-9])/g, (_m, y, mo, d) => { dates.push(`${y}-${mo}-${d}`); return ` ${DATE_MARK}${dates.length - 1} `; });
  s = s.replace(/(?<![0-9])(0[1-9]|[12]\d|3[01])[-_.](0[1-9]|1[0-2])[-_.]((?:19|20)\d{2})(?![0-9])/g, (_m, d, mo, y) => { dates.push(`${y}-${mo}-${d}`); return ` ${DATE_MARK}${dates.length - 1} `; });
  // Compound spellings a separator would break.
  s = s.replace(/\b([hx])\.(26[45])\b/gi, '$1$2').replace(/\bweb[-_.]dl\b/gi, 'webdl').replace(/\be-ac3\b/gi, 'eac3');
  // Only the dotted numbers that are tags (5.1, 23.976); a dotted name (Blade.Runner.2049.2017) splits.
  s = s.replace(/(?<![\d.])(2\.0|5\.1|7\.1|23\.976|29\.97|59\.94)(?![\d.])/g, (m) => m.replace('.', DOT));
  const out: Tok[] = [];
  // Brackets mark their content as bracketed ("[EN]", "(2025)").
  const re = /[([{]([^)\]}]*)[)\]}]|[^\s_\-.+,;()[\]{}]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[1] !== undefined) {
      for (const p of m[1].split(/[\s_\-.+,;]+/).filter(Boolean)) out.push(mk(p, true, out.length));
    } else out.push(mk(m[0], false, out.length));
  }
  return out;
  function mk(t: string, bracketed: boolean, i: number): Tok {
    const text = t.split(DOT).join('.');
    return { text, lower: text.toLowerCase(), bracketed, i };
  }
}

// ---- recognisers --------------------------------------------------------------

type Hit = { signals: Signal[]; take: number };

function isYear(lower: string, nowYear: number): number | null {
  if (!/^(19|20)\d{2}$/.test(lower)) return null;
  const y = Number(lower);
  return y >= 1900 && y <= nowYear + 3 ? y : null;
}

/** Season/episode markers in one or two tokens at position i. */
function seasonEpisodeAt(t: Tok[], i: number): Hit | null {
  const a = t[i]?.lower ?? '', b = t[i + 1]?.lower ?? '';
  const num = (x: string) => (/^\d{1,3}$/.test(x) ? Number(x) : null);
  const se = (season: number, ep: number, take: number, tok: string): Hit => ({ take, signals: [
    { kind: 'season', token: tok, value: season, confidence: 0.95, reason: `"${tok}": season ${season}, episode ${ep}` },
    { kind: 'episode', token: tok, value: ep, confidence: 0.95, reason: `"${tok}": season ${season}, episode ${ep}` },
  ] });
  let m: RegExpExecArray | null;
  if ((m = /^s(\d{1,2})\s?e[p]?(\d{1,3})$/.exec(a))) return se(Number(m[1]), Number(m[2]), 1, t[i].text);
  if ((m = /^(\d{1,2})x(\d{2,3})$/.exec(a))) return se(Number(m[1]), Number(m[2]), 1, t[i].text);
  const season = (n: number, take: number, tok: string, conf = 0.9): Hit => ({ take, signals: [{ kind: 'season', token: tok, value: n, confidence: conf, reason: `"${tok}": season ${n}` }] });
  const episode = (n: number, take: number, tok: string, conf = 0.85): Hit => ({ take, signals: [{ kind: 'episode', token: tok, value: n, confidence: conf, reason: `"${tok}": episode ${n}` }] });
  if ((m = /^(?:s|season|series)(\d{1,2})$/.exec(a))) return season(Number(m[1]), 1, t[i].text, a.startsWith('series') ? 0.75 : 0.9);
  if ((a === 'season' || a === 'series') && num(b) != null) return season(num(b)!, 2, `${t[i].text} ${t[i + 1].text}`, a === 'series' ? 0.75 : 0.9);
  if ((m = /^(?:e|ep|eps|episode)(\d{1,3})$/.exec(a))) return episode(Number(m[1]), 1, t[i].text, a.startsWith('e') && a.length <= 3 ? 0.8 : 0.85);
  if (['ep', 'eps', 'episode', 'e'].includes(a) && num(b) != null && (a !== 'e' || /^\d{2,3}$/.test(b))) return episode(num(b)!, 2, `${t[i].text} ${t[i + 1].text}`);
  return null;
}

function promoAt(t: Tok[], i: number, words: Map<string, PromoKind>): { kind: PromoKind; len: number } | null {
  for (const len of [3, 2, 1]) {
    if (i + len > t.length) continue;
    const phrase = t.slice(i, i + len).map((x) => x.lower).join(' ');
    const k = words.get(phrase) ?? words.get(phrase.replace(/\d+$/, ''));
    if (k && (len > 1 || !/^\d/.test(phrase))) return { kind: k, len };
  }
  return null;
}

/** A plain tag on one token (resolution, codec, year, version ...), or null. */
function tagOf(tok: Tok, nowYear: number, allowLang: boolean): Signal | null {
  const l = tok.lower, s = tok.text;
  let m: RegExpExecArray | null;
  if ((m = /^(2160|1440|1080|720|576|480|360|240)([pi])$/.exec(l))) return { kind: 'resolution', token: s, value: `${m[1]}${m[2]}`, confidence: 0.95, reason: `"${s}": ${m[1]} lines (${m[2] === 'i' ? 'interlaced' : 'progressive'})` };
  if (/^(4k|8k|uhd|fhd|qhd)$/.test(l)) return { kind: 'resolution', token: s, value: l === 'fhd' ? '1080p' : l === 'qhd' ? '1440p' : l === '8k' ? '4320p' : '2160p', confidence: 0.85, reason: `"${s}": resolution` };
  if ((m = /^(\d{3,4})x(\d{3,4})$/.exec(l))) return { kind: 'resolution', token: s, value: `${m[2]}p`, confidence: 0.85, reason: `"${s}": ${m[1]} by ${m[2]}` };
  if ((m = /^(\d{2}(?:\.\d{1,3})?)fps$/.exec(l)) || (m = /^(23\.976|29\.97|59\.94)$/.exec(l)) || (m = /^(24|25|30|48|50|60)p$/.exec(l)))
    return { kind: 'fps', token: s, value: Number(m[1]), confidence: 0.8, reason: `"${s}": ${m[1]} frames a second` };
  if (VIDEO_CODECS.has(l)) return { kind: 'videoCodec', token: s, value: l.replace(/^x26/, 'h26').replace('avc', 'h264').replace('hevc', 'h265'), confidence: 0.9, reason: `"${s}": video codec` };
  if (AUDIO.test(l)) return { kind: 'audio', token: s, value: l, confidence: 0.85, reason: `"${s}": audio format` };
  if (SOURCES.has(l)) return { kind: 'source', token: s, value: l, confidence: 0.7, reason: `"${s}": source or release tag` };
  if ((m = /^(?:v|ver|version|rev|r)(\d{1,3})$/.exec(l))) return { kind: 'version', token: s, value: Number(m[1]), confidence: 0.85, reason: `"${s}": version ${m[1]}` };
  if (VERSION_WORDS.has(l) && l !== 'v') return { kind: 'version', token: s, value: l, confidence: 0.6, reason: `"${s}": a workflow word, not part of the title` };
  const y = isYear(l, nowYear);
  if (y != null) return { kind: 'year', token: s, value: y, confidence: tok.bracketed ? 0.9 : 0.75, reason: `"${s}": a year` };
  if (/^(19|20)\d{6}$/.test(l)) {
    const d = `${l.slice(0, 4)}-${l.slice(4, 6)}-${l.slice(6, 8)}`;
    if (!Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d))
      return { kind: 'date', token: s, value: d, confidence: 0.85, reason: `"${s}": the date ${d}` };
  }
  // Language codes are words too (may, it, de), so only in capitals or brackets.
  if (allowLang && (tok.bracketed || (/[A-Z]/.test(s) && s === s.toUpperCase()))) {
    if (LANG3[l]) return { kind: 'language', token: s, value: LANG3[l], confidence: 0.75, reason: `"${s}": language` };
    if (LANG2[l]) return { kind: 'language', token: s, value: LANG2[l], confidence: 0.7, reason: `"${s}": language` };
  }
  return null;
}

// ---- the parse ----------------------------------------------------------------

export function parseFilename(original: string, opts: ParseOptions = {}): FilenameParse {
  const nowYear = opts.nowYear ?? new Date().getUTCFullYear();
  const { base, extension } = splitName(original);
  const dates: string[] = [];
  const t = tokenise(base, dates);
  const used = new Array(t.length).fill(false);
  const signals: Signal[] = [];
  const promoWords = new Map(Object.entries(PROMO_WORDS));
  const typeWords = new Map<string, { typeKey?: string; confidence: number; ruleId?: string; kind?: SignalKind }>(Object.entries(TYPE_WORDS));
  for (const w of opts.extraWords ?? []) for (const word of w.words) {
    const k = normaliseWords(word);
    if (k && !promoWords.has(k)) typeWords.set(k, { confidence: 0.8, ruleId: w.ruleId, kind: w.kind });
  }
  let promo: FilenameParse['promo'] = null;
  const nameCase = wholeCase(t);
  const emphasised = (tok: Tok) => tok.bracketed || (nameCase !== 'upper' && /[A-Z]/.test(tok.text) && tok.text === tok.text.toUpperCase());
  /** Title words that would be left if tokens [s, s+n) were taken: small words do not count. */
  const realLeft = (s: number, n: number) => t.filter((x, k) => !used[k] && (k < s || k >= s + n) && !SMALL_WORDS.has(x.lower)).length;
  /**
   * May tokens [s, s+n) be taken as a tag? Never if no real title word would be left.
   * An ambiguous word (web, final, master, spot ...) also needs capitals, brackets, or
   * two real title words left: "Charlottes_Web" keeps its web, "News_At_Six_final" loses final.
   */
  const canPeel = (s: number, n: number) => {
    const left = realLeft(s, n);
    if (left < 1) return false;
    const toks = t.slice(s, s + n);
    if (toks.some((x) => AMBIGUOUS.has(x.lower)) && !toks.every(emphasised) && left < 2) return false;
    return true;
  };

  // 1. Dates found before splitting.
  t.forEach((tok, i) => {
    if (!tok.text.startsWith(DATE_MARK)) return;
    const d = dates[Number(tok.text.slice(DATE_MARK.length))];
    signals.push({ kind: 'date', token: d, value: d, confidence: 0.9, reason: `"${d}": the date ${d}` });
    used[i] = true;
  });

  // 2. Season and episode markers, anywhere.
  let seStart = -1, seEnd = -1;
  for (let i = 0; i < t.length; i++) {
    if (used[i]) continue;
    const h = seasonEpisodeAt(t, i);
    if (!h) continue;
    for (let k = 0; k < h.take; k++) used[i + k] = true;
    signals.push(...h.signals);
    if (seStart < 0) seStart = i;
    seEnd = i + h.take - 1;
    i += h.take - 1;
  }

  // 3. Peel tags from the right, where they pile up.
  const lastFree = () => { for (let i = t.length - 1; i >= 0; i--) if (!used[i]) return i; return -1; };
  const firstFree = () => { for (let i = 0; i < t.length; i++) if (!used[i]) return i; return -1; };
  let guard = 0;
  while (guard++ < 40) {
    const i = lastFree();
    if (i < 0) break;
    const tok = t[i];
    // "Trailer 2": a number after a promo word belongs to it.
    if (/^\d{1,2}$/.test(tok.lower) && i > 0 && !used[i - 1] && promoAt(t, i - 1, promoWords)?.len === 1 && canPeel(i - 1, 2)) {
      const p = promoAt(t, i - 1, promoWords)!;
      used[i] = true; takePromo(i - 1, 1, p.kind, 0.9, `${t[i - 1].text} ${tok.text}`); continue;
    }
    // A promo phrase ending here (up to three words), with its modifiers before it.
    let hit = false;
    for (const len of [3, 2, 1]) {
      const s = i - len + 1;
      if (s < 0 || used.slice(s, i + 1).some(Boolean)) continue;
      const p = promoAt(t, s, promoWords);
      if (p && p.len === len && canPeel(s, len)) { takePromo(s, len, p.kind, 0.9); hit = true; break; }
    }
    if (hit) continue;
    const tw = typeWordEnding(i);
    if (tw && canPeel(tw.start, tw.len)) { takeType(tw.start, tw.len, tw.def); continue; }
    const sig = tagOf(tok, nowYear, true);
    if (sig && canPeel(i, 1)) { used[i] = true; signals.push(sig); continue; }
    break;
  }

  // 4. A few kinds from the left: a date, a numbered version, a resolution, a
  //    promo or type word, an account word ("ABC_interview_jane-smith").
  guard = 0;
  while (guard++ < 10) {
    const i = firstFree();
    if (i < 0) break;
    const p = promoAt(t, i, promoWords);
    if (p && seStart < 0 && canPeel(i, p.len)) { takePromo(i, p.len, p.kind, 0.7); continue; }
    const tw = typeWordStarting(i);
    if (tw && canPeel(i, tw.len)) { takeType(i, tw.len, tw.def); continue; }
    const sig = tagOf(t[i], nowYear, false);
    if (sig && canPeel(i, 1) && (sig.kind === 'date' || sig.kind === 'resolution' || (sig.kind === 'version' && typeof sig.value === 'number'))) { used[i] = true; signals.push(sig); continue; }
    break;
  }

  // 5. A promo marker stranded in the middle ("Movie_Trailer_Title") is taken too,
  //    at lower confidence: a title rarely contains "trailer", and the reading is
  //    recorded with its reason. Ambiguous words (spot) are never taken here.
  for (let i = 0; i < t.length && !promo; i++) {
    if (used[i] || AMBIGUOUS.has(t[i].lower)) continue;
    const p = promoAt(t, i, promoWords);
    if (!p) continue;
    if (seStart < 0 && canPeel(i, p.len)) takePromo(i, p.len, p.kind, 0.65);
    else {
      // Beside season and episode markers a promo word at the start is more often
      // part of the name (Trailer Park Boys S01E01): noted, left in the title.
      const text = t.slice(i, i + p.len).map((x) => x.text).join(' ');
      signals.push({ kind: 'promo', token: text, value: p.kind, confidence: 0.45, inTitle: true,
        reason: `"${text}": could be a promotional marker, but it starts a name with season and episode markers, so it is kept in the title` });
    }
  }
  // 5b. Type words still in the title count as signals, without being stripped.
  for (let i = 0; i < t.length; i++) {
    if (used[i]) continue;
    for (const len of [2, 1]) {
      if (i + len > t.length || used.slice(i, i + len).some(Boolean)) continue;
      const phrase = t.slice(i, i + len).map((x) => x.lower).join(' ');
      const def = typeWords.get(phrase);
      if (!def || signals.some((x) => x.token.toLowerCase() === phrase)) continue;
      const text = t.slice(i, i + len).map((x) => x.text).join(' ');
      signals.push({ kind: def.kind ?? (def.typeKey ? 'typeWord' : 'house'), token: text, value: def.typeKey ?? text, confidence: Math.max(0.3, def.confidence - 0.15), ruleId: def.ruleId, inTitle: true,
        reason: `"${text}": a word that names a kind of content, kept in the title because it is not at either end` });
      break;
    }
  }

  const first = <T,>(k: SignalKind) => signals.find((x) => x.kind === k && !x.inTitle)?.value as T | undefined;
  // 6. What is left is the title; split around the season/episode marker.
  const words = (from: number, to: number) => t.slice(Math.max(0, from), to + 1).filter((x) => !used[x.i]);
  let series: string | null = null, episodeTitle: string | null = null, title: string | null;
  const caseAll = wholeCase(t.filter((x) => !used[x.i]));
  if (seStart >= 0) {
    const before = words(0, seStart - 1), after = words(seEnd + 1, t.length - 1);
    series = before.length ? titleCase(before, caseAll, opts.titleCase) : null;
    episodeTitle = after.length ? titleCase(after, caseAll, opts.titleCase) : null;
    title = episodeTitle ?? episodeTitleFrom({ season: first<number>('season') ?? null, episode: first<number>('episode') ?? null });
  } else {
    const rest = t.filter((x) => !used[x.i]);
    title = rest.length ? titleCase(rest, caseAll, opts.titleCase) : null;
  }
  // Never strip to nothing: a name that was only tags keeps its first token as the title.
  if (!title && !series && t.length) {
    const keep = t.find((x) => !x.text.startsWith(DATE_MARK)) ?? t[0];
    title = titleCase([keep], wholeCase([keep]), opts.titleCase);
    // and the signal for that token no longer stands
    const idx = signals.findIndex((s) => s.token === keep.text);
    if (idx >= 0 && !['season', 'episode'].includes(signals[idx].kind)) signals.splice(idx, 1);
  }

  const resolution = first<string>('resolution') ?? null;
  return {
    original, base, extension,
    normalised: normaliseWords(base),
    signals,
    title, series, episodeTitle,
    season: first<number>('season') ?? null,
    episode: first<number>('episode') ?? null,
    part: first<number>('part') ?? null,
    year: first<number>('year') ?? null,
    date: first<string>('date') ?? null,
    resolution,
    height: resolution ? Number(String(resolution).replace(/\D/g, '')) || null : null,
    fps: first<number>('fps') ?? null,
    language: first<string>('language') ?? null,
    promo,
    titleWords: t.filter((x) => !used[x.i]).map((x) => x.lower),
  };

  function takePromo(s: number, len: number, kind: PromoKind, confidence: number, label?: string) {
    // Modifiers right before the marker ("Official", "Final") go with it.
    let start = s;
    while (start - 1 >= 0 && !used[start - 1] && PROMO_MODIFIERS.has(t[start - 1].lower) && realLeft(start - 1, s - start + 1 + len) >= 1) start--;
    const n = s - start + len;
    const text = label ?? t.slice(start, start + n).map((x) => x.text).join(' ');
    for (let k = start; k < start + n; k++) used[k] = true;
    if (!promo) promo = { kind, token: text, confidence };
    signals.push({ kind: 'promo', token: text, value: kind, confidence,
      reason: `"${text}": a promotional marker (${kind.toLowerCase()})${confidence < 0.85 ? ', not at the end of the name, so less certain' : ''}` });
  }
  function typeWordEnding(i: number) {
    for (const len of [2, 1]) {
      const s = i - len + 1;
      if (s < 0 || used.slice(s, i + 1).some(Boolean)) continue;
      const phrase = t.slice(s, i + 1).map((x) => x.lower).join(' ');
      const def = typeWords.get(phrase);
      if (def) return { start: s, len, def, phrase };
    }
    return null;
  }
  function typeWordStarting(i: number) {
    for (const len of [2, 1]) {
      if (i + len > t.length || used.slice(i, i + len).some(Boolean)) continue;
      const phrase = t.slice(i, i + len).map((x) => x.lower).join(' ');
      const def = typeWords.get(phrase);
      if (def) return { len, def, phrase };
    }
    return null;
  }
  function takeType(s0: number, len0: number, def: { typeKey?: string; confidence: number; ruleId?: string; kind?: SignalKind }) {
    // "Official Music Video": the modifier goes with it.
    let s = s0, len = len0;
    if (s - 1 >= 0 && !used[s - 1] && t[s - 1].lower === 'official' && realLeft(s - 1, len + 1) >= 1) { s--; len++; }
    const text = t.slice(s, s + len).map((x) => x.text).join(' ');
    for (let k = s; k < s + len; k++) used[k] = true;
    const kind: SignalKind = def.kind ?? (def.typeKey ? 'typeWord' : 'house');
    signals.push({ kind, token: text, value: def.typeKey ?? text, confidence: def.confidence, ruleId: def.ruleId,
      reason: def.ruleId ? `"${text}": a word your rules recognise` : `"${text}": a word that names a kind of content` });
  }
}

// ---- helpers ------------------------------------------------------------------

/** Lower case, accents off, separators to single spaces. What rules and matching compare. */
export function normaliseWords(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^a-z0-9.]+/g, ' ').replace(/(?<!\d)\.|\.(?!\d)/g, ' ').replace(/\s+/g, ' ').trim();
}

function wholeCase(toks: Tok[]): 'lower' | 'upper' | 'mixed' {
  const letters = toks.map((x) => x.text).join('').replace(/[^A-Za-z]/g, '');
  if (!letters) return 'lower';
  if (letters === letters.toLowerCase()) return 'lower';
  if (letters === letters.toUpperCase()) return 'upper';
  return 'mixed';
}

/** Title case: every word capitalised; mixed-case words kept (McDonald, iPhone); 7th stays 7th. */
export function titleCase(toks: { text: string }[], whole: 'lower' | 'upper' | 'mixed', style: 'every' | 'headline' = 'every'): string {
  return toks.map((x, idx) => {
    const w = x.text;
    if (/^\d/.test(w)) return w.toLowerCase();
    if (ROMAN.test(w)) return w.toUpperCase();
    // In a name typed in mixed case, a word with capitals inside is kept as written (iPhone, McDonald).
    if (whole === 'mixed' && /[A-Z]/.test(w.slice(1))) return w;
    if (whole === 'mixed' && w !== w.toLowerCase()) return w.charAt(0).toUpperCase() + w.slice(1);
    const lw = w.toLowerCase();
    if (style === 'headline' && idx > 0 && SMALL_WORDS.has(lw)) return lw;
    return lw.charAt(0).toUpperCase() + lw.slice(1);
  }).join(' ');
}

/** Title from an episode template: "Episode {episode} (S{season})". */
export function episodeTitleFrom(p: Pick<FilenameParse, 'season' | 'episode'>, template = 'Episode {episode} (S{season})'): string | null {
  if (p.episode == null) return p.season != null ? `Season ${p.season}` : null;
  let out = template.replace('{episode}', String(p.episode)).replace('{season}', p.season != null ? String(p.season) : '');
  if (p.season == null) out = out.replace(/\s*\(S\)\s*/g, '').replace(/\s*\(\s*\)\s*/g, '').trim();
  return out;
}
