// ============================================================================
//  IMAGE TYPES FROM THE FILE NAME OR THE RULE (build queue H2b-3, Christian 5 Nov).
//
//  Bulk ingest names its artwork after the episode it belongs to, with a word
//  at the end saying what the picture is: `Scrubs-s1-e1-thumbnail.jpg`,
//  `Scrubs-s1-e1_poster.png`. So an image a watchfolder takes into the Image
//  Library is read for that word, after `-`, `_`, `.` or a space, ignoring
//  case, and becomes that asset's image of that type (vod_asset_images, or the
//  main image for the primary type), matched to the asset the way a caption is
//  (companionIngest.ts: longest name that fits at a word break, same folder).
//
//  THE WORDS ARE THE ACCOUNT'S TYPES. The standard words below map to the
//  standard types; an account's own type matches by its key or its label
//  (`Partner tile` matches `_partner-tile`, `_partnertile`). A word whose type
//  the account has switched off is not a type word.
//
//  A FOLDER WITH NO TYPE WORDS, or its own words (`*_key_art.jpg`), sets the
//  type on the rule instead (`imageType`). The name wins over the rule only
//  when the rule says so (`imageTypeFromName`, on by default).
//
//  SOME WORDS ARE NOT ASSET IMAGES. `brand`, `logo`, `watermark` and `slate`
//  at the end of a name say what the image is in the library, as the rule
//  targets of the same names do, and attach to nothing.
//
//  Pure, no imports: the dry run, the ingest pass and the suite ask the same
//  function, and the site agent may compile it later (H2b-4).
// ============================================================================

/** Library kinds (media_files.kind) this can say. Same names as ingest.ts MediaKind. */
export type LibraryKind = 'watermark' | 'slate' | 'poster' | 'brand' | 'keyframe' | 'other';

/** The standard words, each to a standard type key. */
export const TYPE_WORDS: Record<string, string> = {
  thumbnail: 'thumbnail', thumb: 'thumbnail',
  poster: 'poster',
  cover: 'cover',
  hero: 'hero', backdrop: 'hero', background: 'hero', fanart: 'hero',
  banner: 'banner',
  social: 'social', share: 'social',
  title: 'title', titleart: 'title', clearlogo: 'title', 'logo-title': 'title',
};

/** Words that set the library kind only (no asset). */
export const KIND_WORDS: Record<string, LibraryKind> = {
  brand: 'brand', logo: 'brand', watermark: 'watermark', slate: 'slate',
};

/** The library kind an image of a type is filed as, when the rule did not say. */
export function libraryKindOfType(typeKey: string): LibraryKind {
  if (typeKey === 'poster') return 'poster';
  if (typeKey === 'thumbnail') return 'keyframe';
  return 'other';
}

export interface TypeChoice { key: string; label: string }

export interface NameWord {
  /** The asset image type the word names, or null for a kind word. */
  typeKey: string | null;
  /** The library kind the word implies. */
  libraryKind: LibraryKind;
  /** The word as it was in the name. */
  word: string;
  /** The name before the word (what the asset is matched on), '' when none. */
  stem: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const stemOf = (name: string) => (name.split('/').pop() ?? name).replace(/\.[^.]+$/, '');

/**
 * The type word at the end of an image's name, or null. Longest word first
 * (`logo-title` before `title`, an account's `key-art` before `art`), so
 * `Show_logo-title.png` is title art and not a brand logo.
 */
export function typeWordOf(name: string, types: TypeChoice[]): NameWord | null {
  const stem = stemOf(name);
  // Tokens with the separators kept, so the stem before the word is exact.
  const parts = stem.split(/([-_.\s]+)/);
  const words = parts.filter((_, i) => i % 2 === 0);
  if (words.length < 1) return null;
  const known = new Set(types.map((t) => t.key));
  const own = new Map<string, string>();
  for (const t of types) { own.set(norm(t.key), t.key); own.set(norm(t.label), t.key); }
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    const tail = words.slice(-n);
    // The word itself as written, separators included (`logo-title`, `key_art`).
    const written = parts.slice(parts.length - (2 * n - 1)).join('');
    const before = parts.slice(0, parts.length - (2 * n - 1));
    const rest = before.length ? before.slice(0, -1).join('') : '';
    const joined = tail.join('-').toLowerCase();
    const flat = norm(tail.join(''));
    if (!flat) continue;
    // The standard words first, then the account's types by key or label
    // (which also covers a standard type the account renamed).
    const std = TYPE_WORDS[joined] ?? TYPE_WORDS[flat];
    const key = std && known.has(std) ? std : own.get(flat) ?? null;
    if (key) return { typeKey: key, libraryKind: libraryKindOfType(key), word: written, stem: rest };
    if (n === 1 && KIND_WORDS[flat]) return { typeKey: null, libraryKind: KIND_WORDS[flat], word: written, stem: rest };
  }
  return null;
}

export interface ResolvedType {
  /** The asset image type, or null when only the library kind is known. */
  typeKey: string | null;
  label: string | null;
  from: 'name' | 'rule';
  word: string | null;
  libraryKind: LibraryKind;
  /** Whether the image is to be matched to an asset (a type, and a name to match on). */
  attach: boolean;
}

/**
 * What type an accepted image is: the word in its name (when the rule lets
 * the name decide, the default), else the rule's type, else nothing.
 */
export function resolveImageType(
  name: string,
  rule: { imageType?: string | null; imageTypeFromName?: boolean | null },
  types: TypeChoice[],
): ResolvedType | null {
  const label = (k: string) => types.find((t) => t.key === k)?.label ?? k;
  const fromName = rule.imageTypeFromName !== false;
  const w = fromName ? typeWordOf(name, types) : null;
  if (w?.typeKey) return { typeKey: w.typeKey, label: label(w.typeKey), from: 'name', word: w.word, libraryKind: w.libraryKind, attach: !!w.stem };
  const ruleType = rule.imageType && types.some((t) => t.key === rule.imageType) ? rule.imageType : null;
  if (ruleType) return { typeKey: ruleType, label: label(ruleType), from: 'rule', word: null, libraryKind: libraryKindOfType(ruleType), attach: !!stemOf(name) };
  if (w) return { typeKey: null, label: null, from: 'name', word: w.word, libraryKind: w.libraryKind, attach: false };
  return null;
}
