// ============================================================================
//  IMAGE TYPES FOR AN ASSET: the pure rules (docs/ASSET_IMAGES.md section 13).
//
//  An asset has one PRIMARY image (vod_assets.poster_key, picked automatically,
//  services/media/assetImage.ts). What that image is called depends on the
//  media: a THUMBNAIL for video, a COVER for audio. Beyond it, an asset can
//  carry more images, each of a TYPE: content images (what the asset is) and
//  publishing images (what portals, apps and feeds put around it: a poster, a
//  hero backdrop, a banner, title art, a social share card). An account can
//  rename, switch off or add types.
//
//  When a type has no image of its own, a portal still gets one of the right
//  shape: the first image in the type's fallback chain (ending at the primary),
//  cropped to the type's aspect by the image service with a smart focus, and
//  marked `derived`. Title art never falls back: a cropped frame is not a logo.
//
//  No database, no imports: pinned by test/asset-image-types.check.ts.
// ============================================================================

export type Media = 'video' | 'audio';
export type Purpose = 'content' | 'publishing';

export interface ImageType {
  key: string;
  label: string;
  description: string;
  purpose: Purpose;
  /** Width:height. Null = any shape (title art, logos). */
  aspectW: number | null;
  aspectH: number | null;
  /** The smallest image a portal should be given (a warning, not a refusal). */
  minWidth: number;
  minHeight: number;
  appliesTo: Media[];
  /** The type IS the primary image for this media (thumbnail: video, cover: audio). */
  primaryFor: Media[];
  /** Type keys tried in order when this type has no image; 'primary' is the asset's primary image. */
  fallback: string[];
  /** Transparent PNG/WebP is expected (title art). */
  transparent: boolean;
  isStandard: boolean;
  enabled: boolean;
  sort: number;
}

/** The types every account starts with. Keys are stable; labels can be renamed per account. */
export const STANDARD_IMAGE_TYPES: ImageType[] = [
  { key: 'thumbnail', label: 'Thumbnail', purpose: 'content', aspectW: 16, aspectH: 9, minWidth: 1280, minHeight: 720,
    appliesTo: ['video'], primaryFor: ['video'], fallback: ['primary'], transparent: false, isStandard: true, enabled: true, sort: 10,
    description: 'The still that stands for the video in lists, players and feeds. Picked automatically from the best frame unless someone chooses one.' },
  { key: 'cover', label: 'Cover', purpose: 'content', aspectW: 1, aspectH: 1, minWidth: 1400, minHeight: 1400,
    appliesTo: ['audio', 'video'], primaryFor: ['audio'], fallback: ['primary'], transparent: false, isStandard: true, enabled: true, sort: 20,
    description: 'Square artwork. For audio it is the main image (album cover, show or station art); for video it is optional square art for music and podcast apps.' },
  { key: 'poster', label: 'Poster', purpose: 'publishing', aspectW: 2, aspectH: 3, minWidth: 1000, minHeight: 1500,
    appliesTo: ['video', 'audio'], primaryFor: [], fallback: ['primary'], transparent: false, isStandard: true, enabled: true, sort: 30,
    description: 'Portrait key art with the title on it, for portal rows, TV apps and EPG tiles.' },
  { key: 'hero', label: 'Hero backdrop', purpose: 'publishing', aspectW: 16, aspectH: 9, minWidth: 1920, minHeight: 1080,
    appliesTo: ['video', 'audio'], primaryFor: [], fallback: ['thumbnail', 'primary'], transparent: false, isStandard: true, enabled: true, sort: 40,
    description: 'A large image without text for the top of a portal page or behind the player. Title art is laid over it.' },
  { key: 'banner', label: 'Banner', purpose: 'publishing', aspectW: 3, aspectH: 1, minWidth: 1920, minHeight: 640,
    appliesTo: ['video', 'audio'], primaryFor: [], fallback: ['hero', 'thumbnail', 'primary'], transparent: false, isStandard: true, enabled: true, sort: 50,
    description: 'A wide strip for carousels and promotional slots on a portal home page.' },
  { key: 'social', label: 'Social share card', purpose: 'publishing', aspectW: 40, aspectH: 21, minWidth: 1200, minHeight: 630,
    appliesTo: ['video', 'audio'], primaryFor: [], fallback: ['hero', 'thumbnail', 'primary'], transparent: false, isStandard: true, enabled: true, sort: 60,
    description: 'The picture shown when a link to the asset is shared (Open Graph and X cards, 1200 × 630).' },
  { key: 'title', label: 'Title art', purpose: 'publishing', aspectW: null, aspectH: null, minWidth: 800, minHeight: 0,
    appliesTo: ['video', 'audio'], primaryFor: [], fallback: [], transparent: true, isStandard: true, enabled: true, sort: 70,
    description: 'The title as a logo on a transparent background, laid over the hero backdrop. Never made from another image.' },
];

export const TYPE_KEY = /^[a-z][a-z0-9-]{1,39}$/;
export const RESERVED_KEYS = new Set(['primary', 'image', 'images', 'types', 'auto']);

/** The type that names an asset's primary image. */
export function primaryTypeKey(media: Media): 'thumbnail' | 'cover' {
  return media === 'audio' ? 'cover' : 'thumbnail';
}

/** The types an asset of this media offers, in order: enabled, applying to it, the primary type first. */
export function typesFor(types: ImageType[], media: Media): ImageType[] {
  const pk = primaryTypeKey(media);
  return types
    .filter((t) => t.enabled && t.appliesTo.includes(media))
    .sort((a, b) => (a.key === pk ? -1 : b.key === pk ? 1 : 0) || (a.purpose === b.purpose ? 0 : a.purpose === 'content' ? -1 : 1) || a.sort - b.sort || a.key.localeCompare(b.key));
}

/** "16:9", "2:3", or "any". 40:21 reads as "1.91:1". */
export function aspectLabel(t: Pick<ImageType, 'aspectW' | 'aspectH'>): string {
  if (!t.aspectW || !t.aspectH) return 'any';
  if (t.aspectW === 40 && t.aspectH === 21) return '1.91:1';
  return `${t.aspectW}:${t.aspectH}`;
}

/** Parse "16:9", "2x3", "1.91:1" into whole numbers, or null for "any". Throws on nonsense. */
export function parseAspect(s: string | null | undefined): { w: number; h: number } | null {
  const v = String(s ?? '').trim().toLowerCase();
  if (!v || v === 'any' || v === 'free') return null;
  const m = /^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/.exec(v);
  if (!m) throw new Error(`"${s}" is not a shape: write it like 16:9, 2:3 or 1.91:1`);
  let w = Number(m[1]), h = Number(m[2]);
  if (!(w > 0 && h > 0)) throw new Error('both sides of the shape must be more than 0');
  // 1.91:1 → 191:100 → reduced; keep within 1..400 so specs stay short.
  const scale = 10 ** Math.max(decimals(m[1]), decimals(m[2]));
  w = Math.round(w * scale); h = Math.round(h * scale);
  const g = gcd(w, h); w /= g; h /= g;
  if (w > 400 || h > 400) throw new Error('that shape is too finely divided: use whole numbers up to 400');
  if (w / h > 8 || h / w > 8) throw new Error('that shape is too extreme (more than 8 to 1)');
  return { w, h };
}
const decimals = (s: string) => (s.split('.')[1] ?? '').length;
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** Output box for a type at a given width (height follows the aspect; 0 = natural). */
export function boxFor(t: Pick<ImageType, 'aspectW' | 'aspectH'>, width: number): { w: number; h: number } {
  if (!t.aspectW || !t.aspectH) return { w: width, h: 0 };
  return { w: width, h: Math.round((width * t.aspectH) / t.aspectW) };
}

export interface Focus { x: number; y: number }

/**
 * The image-service spec that renders an image as this type (IMAGES.md
 * section 2). A shaped type is a cover crop on the focus point (a person's, or
 * smart); title art keeps its whole shape and its transparency.
 */
export function specFor(t: Pick<ImageType, 'aspectW' | 'aspectH' | 'transparent'>, width: number, focus?: Focus | null, opts: { format?: 'webp' | 'avif' | 'jpeg' | 'png'; version?: string } = {}): string {
  const { w, h } = boxFor(t, width);
  const parts = [`${w}x${h}`, h ? 'cover' : 'inside'];
  if (h) parts.push(focus ? `focus=${clampPct(focus.x)}-${clampPct(focus.y)}` : 'focus=smart');
  const fmt = opts.format ?? (t.transparent ? 'png' : 'webp');
  if (fmt !== 'webp') parts.push(`fmt=${fmt}`);
  if (opts.version) parts.push(`v=${opts.version.replace(/[^A-Za-z0-9]/g, '').slice(0, 32)}`);
  return parts.join(',');
}
const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

export interface Slot { key: string | null; width?: number | null; height?: number | null }

/**
 * Where a type's picture comes from when it has none of its own. `own` holds
 * the images an asset has, by type key; `primary` is vod_assets.poster_key.
 * Answers the type key it borrowed from ('primary' for the primary image), or null.
 */
export function resolveFallback(t: Pick<ImageType, 'key' | 'fallback'>, own: Record<string, Slot | undefined>, primary: string | null, primaryKey: string): { from: string; key: string } | null {
  for (const k of t.fallback) {
    if (k === t.key) continue;
    if (k === 'primary' || k === primaryKey) { if (primary) return { from: k === 'primary' ? primaryKey : k, key: primary }; continue; }
    const s = own[k];
    if (s?.key) return { from: k, key: s.key };
  }
  return null;
}

/** Plain-language warnings about an image chosen for a type. Empty when it fits. */
export function fitWarnings(t: ImageType, w: number | null | undefined, h: number | null | undefined): string[] {
  const out: string[] = [];
  if (!w || !h) return out;
  if (t.minWidth && w < t.minWidth || t.minHeight && h < t.minHeight)
    out.push(`Smaller than the recommended ${t.minWidth}${t.minHeight ? ` × ${t.minHeight}` : ' wide'} (this one is ${w} × ${h}); it will look soft on large screens.`);
  if (t.aspectW && t.aspectH) {
    const want = t.aspectW / t.aspectH, got = w / h;
    if (Math.abs(got - want) / want > 0.04) out.push(`Not ${aspectLabel(t)} (this one is ${shapeOf(w, h)}); portals will crop it around the focus point.`);
  }
  return out;
}
function shapeOf(w: number, h: number): string {
  const r = w / h;
  const known: [number, string][] = [[16 / 9, '16:9'], [1, '1:1'], [2 / 3, '2:3'], [3, '3:1'], [4 / 3, '4:3'], [3 / 4, '3:4'], [1.91, '1.91:1'], [9 / 16, '9:16'], [21 / 9, '21:9']];
  const k = known.find(([v]) => Math.abs(r - v) / v < 0.03);
  return k ? k[1] : `${r.toFixed(2)}:1`;
}

/**
 * Clean a type an account defines or edits. Standard types keep their key,
 * shape rules and primary role; only the label, description, minimum size,
 * fallback and on/off can change, and a primary type cannot be switched off.
 */
export function cleanType(input: Partial<ImageType> & { aspect?: string | null }, existing: ImageType | null, allKeys: Set<string>): ImageType {
  const std = existing?.isStandard ? existing : null;
  const key = existing?.key ?? String(input.key ?? '').trim().toLowerCase();
  if (!existing) {
    if (!TYPE_KEY.test(key)) throw new Error('the key must start with a letter and use lower-case letters, digits and hyphens (2 to 40)');
    if (RESERVED_KEYS.has(key)) throw new Error(`"${key}" is reserved`);
    if (allKeys.has(key)) throw new Error(`there is already an image type "${key}"`);
  }
  const label = String(input.label ?? existing?.label ?? '').trim();
  if (!label || label.length > 60) throw new Error('give the type a name of 1 to 60 characters');
  let aspectW = existing?.aspectW ?? null, aspectH = existing?.aspectH ?? null;
  if (!std && input.aspect !== undefined) { const a = parseAspect(input.aspect); aspectW = a?.w ?? null; aspectH = a?.h ?? null; }
  const int = (v: unknown, d: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 ? Math.min(n, 8192) : d; };
  const appliesTo = std ? std.appliesTo : uniq((input.appliesTo ?? existing?.appliesTo ?? ['video', 'audio']).filter((m): m is Media => m === 'video' || m === 'audio'));
  if (!appliesTo.length) throw new Error('say whether the type is for video, audio or both');
  const fallback = uniq((input.fallback ?? existing?.fallback ?? ['primary']).map((k) => String(k).trim().toLowerCase()).filter((k) => k && k !== key));
  for (const k of fallback) if (k !== 'primary' && !allKeys.has(k)) throw new Error(`the fallback "${k}" is not an image type`);
  if (fallback.length > 5) throw new Error('at most 5 fallbacks');
  const primaryFor = std ? std.primaryFor : [];
  const enabled = input.enabled ?? existing?.enabled ?? true;
  if (!enabled && primaryFor.length) throw new Error(`${std!.label} is the main image for ${primaryFor.join(' and ')} and cannot be switched off`);
  const purpose: Purpose = std ? std.purpose : input.purpose === 'content' ? 'content' : input.purpose === 'publishing' ? 'publishing' : existing?.purpose ?? 'publishing';
  return {
    key, label,
    description: String(input.description ?? existing?.description ?? '').trim().slice(0, 400),
    purpose, aspectW, aspectH,
    minWidth: int(input.minWidth, existing?.minWidth ?? 0), minHeight: int(input.minHeight, existing?.minHeight ?? 0),
    appliesTo, primaryFor,
    fallback: std?.key === 'title' && input.fallback === undefined ? [] : fallback,
    transparent: std ? std.transparent : !!(input.transparent ?? existing?.transparent ?? false),
    isStandard: !!std, enabled,
    sort: int(input.sort, existing?.sort ?? 100),
  };
}
const uniq = <T,>(a: T[]) => [...new Set(a)];
