// ============================================================================
//  WATCHFOLDER DEFAULT RULES BY FILE TYPE (build queue H2b, Christian 5 Nov).
//
//  A new folder used to start with no rules, so every file went to review
//  until somebody wrote `*.png -> image` and `*.mp4 -> vod` by hand, which is
//  what nearly every folder wants. So every new folder now starts with one
//  rule per file type, as ORDINARY rules: shown in the console and the dry
//  run, editable, each switchable off. There is no hidden fallback, because a
//  rule the operator cannot see is a rule they cannot reason about.
//
//  THE DEFAULTS SIT AT THE BOTTOM. They are the "by type" catch-all, so a rule
//  the operator adds later (`loop_*.mp4 -> loop`) goes above them and wins.
//  Otherwise the first custom rule on a fresh folder would never fire, because
//  `*.mp4 -> vod` would already have taken the file. That is why they start at
//  a high ordinal and custom rules are placed below it (see `customOrdinal`).
//
//  A FILE NOTHING RECOGNISES STILL GOES TO REVIEW. The defaults name their
//  extensions; there is no `*` rule, so a `.prproj` or a `.pdf` is refused with
//  a reason exactly as before.
//
//  CAPTIONS AND SIDECARS (H2b-2) are taken in as `companion` files and
//  attached by name to the video they go with (companionIngest.ts), waiting up
//  to 24 hours for it.
//
//  AUDIO (H2b-4) goes to the Media Library as an AUDIO ASSET: the same VOD
//  path as a video, and the encode sees there is no picture and makes a
//  sound-only rendition instead of a video ladder (vodEncode.ts).
//
//  A FOLDER AT A SITE gets the same five (H2b-5): its agent uploads images,
//  audio and companions as well as video, and the cloud takes them in with
//  the same passes. Until then it had the video rule only. "Add default
//  rules" adds the other four to a site folder made before.
//
//  `builtin` marks a row as one of these, so "Add default rules" on an older
//  folder adds only the ones it lacks and the console can label them. Editing
//  a default keeps the mark: it is still the folder's rule for that type.
// ============================================================================

export type FileType = 'image' | 'video' | 'audio' | 'caption' | 'sidecar';

/** Extensions per type. The single list the rules, the rule check and the
 *  console's destination picker all read. */
export const TYPE_EXTENSIONS: Record<FileType, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'tif', 'tiff'],
  video: ['mp4', 'mov', 'm4v', 'mxf', 'mkv', 'ts', 'webm'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'flac'],
  caption: ['srt', 'vtt', 'ttml', 'dfxp'],
  sidecar: ['json', 'xml', 'nfo', 'csv'],
};

export function typeOfExtension(ext: string): FileType | null {
  const e = ext.toLowerCase().replace(/^\./, '');
  for (const [t, list] of Object.entries(TYPE_EXTENSIONS) as [FileType, string[]][]) {
    if (list.includes(e)) return t;
  }
  return null;
}

export function typeOfName(name: string): FileType | null {
  const base = name.split('/').pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? typeOfExtension(base.slice(dot + 1)) : null;
}

/** An `extension` rule's pattern as a list: `png, jpg` or `.png .jpg`. */
export function extensionList(pattern: string): string[] {
  return String(pattern ?? '').split(/[\s,;|]+/).map((x) => x.trim().replace(/^\.+/, '').toLowerCase()).filter(Boolean);
}

/**
 * The file types a rule's pattern can only ever match, when the pattern says.
 * `extension` rules name them; a glob or suffix ending in a plain extension
 * (`slate_*.png`, `_MASTER.mov`) does too. Anything else (`loop_*`, a regex)
 * could match any type, so it says nothing and is not checked.
 */
export function typesOfPattern(matchType: string, pattern: string): FileType[] | null {
  let exts: string[] = [];
  if (matchType === 'extension') exts = extensionList(pattern);
  else if (matchType === 'glob' || matchType === 'suffix') {
    const m = /\.([a-z0-9]+)$/i.exec(String(pattern ?? ''));
    if (!m) return null;
    exts = [m[1].toLowerCase()];
  } else return null;
  const types = exts.map(typeOfExtension);
  // An extension Volt does not know (`.pdf`) puts no constraint on the kind:
  // such a rule is refused or accepted as before.
  if (!types.length || types.some((t) => t == null)) return null;
  return [...new Set(types as FileType[])];
}

export interface DefaultRule {
  builtin: string;
  name: string;
  matchType: 'extension';
  pattern: string;
  targetKind: string;
}

const RULES: Record<'image' | 'video' | 'audio' | 'caption' | 'sidecar', DefaultRule> = {
  image: { builtin: 'images', name: 'Images to the Image Library', matchType: 'extension',
    pattern: TYPE_EXTENSIONS.image.join(', '), targetKind: 'image' },
  video: { builtin: 'video', name: 'Video to the Media Library', matchType: 'extension',
    pattern: TYPE_EXTENSIONS.video.join(', '), targetKind: 'vod' },
  audio: { builtin: 'audio', name: 'Audio to the Media Library', matchType: 'extension',
    pattern: TYPE_EXTENSIONS.audio.join(', '), targetKind: 'vod' },
  caption: { builtin: 'captions', name: 'Captions to their video', matchType: 'extension',
    pattern: TYPE_EXTENSIONS.caption.join(', '), targetKind: 'companion' },
  sidecar: { builtin: 'sidecars', name: 'Metadata files to their video', matchType: 'extension',
    pattern: TYPE_EXTENSIONS.sidecar.join(', '), targetKind: 'companion' },
};

/** The defaults a folder of this kind starts with, in order. */
// Every kind of folder (local, bucket, site) takes every type since H2b-5;
// the kind is still passed so a kind that cannot may say so here.
export function defaultRulesFor(_folderKind?: string): DefaultRule[] {
  return [RULES.image, RULES.video, RULES.audio, RULES.caption, RULES.sidecar];
}

/** Where the defaults start. Far above any hand-made set, so custom rules fit below. */
export const DEFAULTS_FROM = 100_000;

/**
 * The ordinal for a new custom rule: after the other custom rules, before the
 * defaults. Rules are spaced in tens; a gap that has run out falls back to
 * the end of the list rather than renumbering, which an operator would not
 * expect from adding one rule.
 */
export function customOrdinal(rules: { ordinal: number; builtin?: string | null }[]): number {
  const all = rules.map((r) => r.ordinal);
  const custom = rules.filter((r) => !r.builtin).map((r) => r.ordinal);
  const last = custom.length ? Math.max(...custom) : 0;
  const nextAbove = all.filter((o) => o > last).sort((a, b) => a - b)[0];
  const want = last + 10;
  if (nextAbove == null || want < nextAbove) return want;
  if (nextAbove - last > 1) return last + Math.floor((nextAbove - last) / 2);
  return Math.max(...all) + 10;
}

/** Ordinals for defaults being added: after everything already there. */
export function defaultOrdinals(rules: { ordinal: number }[], n: number): number[] {
  const top = Math.max(DEFAULTS_FROM - 10, ...rules.map((r) => r.ordinal));
  return Array.from({ length: n }, (_, i) => top + 10 * (i + 1));
}
