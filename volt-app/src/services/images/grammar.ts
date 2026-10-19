// ============================================================================
//  IMAGE REQUEST GRAMMAR: what a URL after `/img/{sig}/` asks for.
//
//  Two spellings, one result (a ResizeSpec + a store key):
//
//  COMPACT (what the console, the SDK and POST /api/images/sign emit)
//    {W}x{H},{fit}[,token...]/{key}
//      640x360,cover,focus=30-20,gray,q=70/library/{acct}/slates/a.png
//
//  PATH STYLE (Thumbor-like, kept for URLs in the older glueapi shape)
//    {fit}/{W}x{H}[/smart][/filter(k:v,...)]/{key}
//      fit-in/1920x0/filter(sharpen:100,format:webp)/library/{acct}/a.png
//
//  Pure: no I/O, no sharp. Guards (max size, formats) are enforced HERE so a
//  request that would be refused never reaches the renderer or the cache, and
//  they REFUSE rather than clamp, so a caller learns about the limit instead of
//  silently getting a different image than the one it signed for.
// ============================================================================
import { accountOfKey } from './sdk';

export type Fit = 'cover' | 'inside' | 'contain' | 'fill';
export type Format = 'webp' | 'avif' | 'jpeg' | 'png';
export type Gravity =
  | 'center' | 'top' | 'bottom' | 'left' | 'right'
  | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  | 'smart' | 'entropy';

export interface ResizeSpec {
  /** 0 = auto from the other side and the source aspect. */
  w: number;
  h: number;
  fit: Fit;
  /** Hard crop, percent of the source, applied first. */
  crop?: { x: number; y: number; w: number; h: number };
  /** Focal point, percent of the source (cover only). */
  focus?: { x: number; y: number };
  /** Named gravity or a content-aware strategy (cover only). */
  gravity?: Gravity;
  gray?: boolean;
  blur?: number;
  bright?: number;
  sat?: number;
  /** Sharpen sigma. */
  sharpen?: number;
  /** Background, RRGGBB lower case. */
  bg?: string;
  enlarge: boolean;
  q: number;
  fmt: Format;
  version?: string;
}

export interface ImageLimits {
  maxDimension: number;
  maxOutputPixels: number;
  formats: string[];
}

export class ImageError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const bad = (m: string) => new ImageError(400, m);

const FITS: Fit[] = ['cover', 'inside', 'contain', 'fill'];
const FORMATS: Format[] = ['webp', 'avif', 'jpeg', 'png'];
const GRAVITIES: Gravity[] = ['center', 'top', 'bottom', 'left', 'right',
  'top-left', 'top-right', 'bottom-left', 'bottom-right', 'smart', 'entropy'];
export const SOURCE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'tif', 'tiff', 'svg', 'heic', 'heif'];

function num(v: string, name: string, min: number, max: number, integer = true): number {
  if (!/^\d+(\.\d+)?$/.test(v)) throw bad(`${name} must be a number`);
  const n = Number(v);
  if (integer && !Number.isInteger(n)) throw bad(`${name} must be a whole number`);
  if (n < min || n > max) throw bad(`${name} must be ${min}..${max}`);
  return n;
}

function dims(s: string): { w: number; h: number } {
  const m = /^(\d{0,5})x(\d{0,5})$/.exec(s);
  if (!m) throw bad(`size '${s}' must be WxH (0 = auto)`);
  const w = m[1] ? parseInt(m[1], 10) : 0, h = m[2] ? parseInt(m[2], 10) : 0;
  if (!w && !h) throw bad('width or height must be non-zero');
  return { w, h };
}

function hexColour(v: string): string {
  const c = v.replace(/^#/, '').toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(c)) throw bad('background must be RRGGBB');
  return c;
}

function gravity(v: string): Gravity {
  const g = (v === 'centre' ? 'center' : v) as Gravity;
  if (!GRAVITIES.includes(g)) throw bad(`focus '${v}' is not one of ${GRAVITIES.join(', ')}`);
  return g;
}

/** Compact spec: "640x360,cover,focus=30-20,gray,q=70". */
export function parseCompact(spec: string): ResizeSpec {
  const [size, ...tokens] = spec.split(',');
  const out: ResizeSpec = { ...dims(size), fit: 'cover', enlarge: false, q: 80, fmt: 'webp' };
  const seen = new Set<string>();
  for (const t of tokens) {
    const eq = t.indexOf('=');
    const name = eq < 0 ? t : t.slice(0, eq);
    const v = eq < 0 ? '' : t.slice(eq + 1);
    const slot = FITS.includes(name as Fit) ? 'fit' : name;
    if (seen.has(slot)) throw bad(`'${slot}' given twice`);
    seen.add(slot);
    if (FITS.includes(name as Fit) && eq < 0) out.fit = name as Fit;
    else if (name === 'gray' && eq < 0) out.gray = true;
    else if (name === 'sharp') out.sharpen = eq < 0 ? 1 : num(v, 'sharp', 0.3, 10, false);
    else if (name === 'up' && eq < 0) out.enlarge = true;
    else if (name === 'focus') {
      const p = /^(\d{1,3})-(\d{1,3})$/.exec(v);
      if (p) out.focus = { x: num(p[1], 'focus x', 0, 100), y: num(p[2], 'focus y', 0, 100) };
      else out.gravity = gravity(v);
    } else if (name === 'crop') {
      const c = /^(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})$/.exec(v);
      if (!c) throw bad('crop must be X-Y-W-H in percent');
      const [x, y, w, h] = c.slice(1).map(Number);
      if (w < 1 || h < 1 || x + w > 100 || y + h > 100) throw bad('crop must stay inside the image (x+w <= 100, y+h <= 100)');
      out.crop = { x, y, w, h };
    } else if (name === 'blur') out.blur = num(v, 'blur', 0.3, 50, false);
    else if (name === 'bright') out.bright = num(v, 'bright', 10, 300);
    else if (name === 'sat') out.sat = num(v, 'sat', 0, 300);
    else if (name === 'q') out.q = num(v, 'q', 1, 100);
    else if (name === 'fmt') {
      if (!FORMATS.includes(v as Format)) throw bad(`fmt must be one of ${FORMATS.join(', ')}`);
      out.fmt = v as Format;
    } else if (name === 'bg') out.bg = hexColour(v);
    else if (name === 'v') {
      if (!/^[A-Za-z0-9]{1,32}$/.test(v)) throw bad('v must be 1..32 letters or digits');
      out.version = v;
    } else throw bad(`unknown option '${t}'`);
  }
  return out;
}

const PATH_FITS: Record<string, Fit> = { 'fit-in': 'inside', fill: 'cover', cover: 'cover', stretch: 'fill' };

function formatFromKey(key: string): Format {
  const e = (key.split('.').pop() ?? '').toLowerCase();
  return e === 'png' ? 'png' : e === 'webp' ? 'webp' : e === 'avif' ? 'avif' : 'jpeg';
}

/** Path style: segments [fit] WxH [smart] [filter(...)]; returns how many it used.
 *  The format defaults from the source extension, so the caller passes the segments
 *  and gets the key start back. */
function parsePathStyle(seg: string[]): { spec: ResizeSpec; used: number } {
  let i = 0;
  let fit: Fit = 'cover';
  if (PATH_FITS[seg[0]]) fit = PATH_FITS[seg[i++]];
  const spec: ResizeSpec = { ...dims(seg[i++] ?? ''), fit, enlarge: true, q: 82, fmt: 'jpeg' };
  if (seg[i] === 'smart') { spec.gravity = 'smart'; i++; }
  let format: Format | null = null;
  if (seg[i]?.startsWith('filter(') && seg[i].endsWith(')')) {
    const body = seg[i++].slice(7, -1);
    for (const tok of body.split(',').map((s) => s.trim()).filter(Boolean)) {
      const c = tok.indexOf(':');
      const k = c < 0 ? tok : tok.slice(0, c);
      const v = c < 0 ? '' : tok.slice(c + 1);
      if (k === 'sharpen') spec.sharpen = 0.5 + num(v || '100', 'sharpen', 0, 1000) / 100;
      else if (k === 'blur') spec.blur = num(v, 'blur', 0.3, 50, false);
      else if (k === 'quality') spec.q = num(v, 'quality', 1, 100);
      else if (k === 'format') {
        const f = (v === 'jpg' ? 'jpeg' : v) as Format;
        if (!FORMATS.includes(f)) throw bad(`format must be one of ${FORMATS.join(', ')}`);
        format = f;
      } else if (k === 'grayscale' || k === 'greyscale') spec.gray = true;
      else if (k === 'background') spec.bg = hexColour(v);
      else if (k === 'focus') {
        const p = /^(0(?:\.\d+)?|1(?:\.0+)?)x(0(?:\.\d+)?|1(?:\.0+)?)$/.exec(v);
        if (p) spec.focus = { x: Math.round(Number(p[1]) * 100), y: Math.round(Number(p[2]) * 100) };
        else spec.gravity = gravity(v);
      } else throw bad(`unknown filter '${k}'`);
    }
  }
  // fit-in with a background and a full box letterboxes (the old service did).
  if (spec.fit === 'inside' && spec.bg && spec.w && spec.h) spec.fit = 'contain';
  spec.fmt = format ?? formatFromKey(seg.slice(i).join('/'));
  return { spec, used: i };
}

/** Validate a store key: an account's library/ or derived/ image, nothing else. */
export function checkKey(key: string): string {
  if (!key) throw bad('missing image path');
  if (key.length > 1024) throw bad('image path too long');
  if (/[\u0000-\u001f\u007f\\]/.test(key)) throw bad('image path has invalid characters');
  const parts = key.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) throw bad('image path has an empty or relative segment');
  if (!accountOfKey(key)) throw new ImageError(404, 'not an image library path');
  const ext = (key.split('.').pop() ?? '').toLowerCase();
  if (!SOURCE_EXTENSIONS.includes(ext)) throw new ImageError(415, `source type .${ext} is not an image the service reads`);
  return key;
}

export function enforceLimits(spec: ResizeSpec, limits: ImageLimits): void {
  const max = limits.maxDimension;
  if (spec.w > max || spec.h > max) throw bad(`size exceeds the ${max}px limit`);
  if (spec.w && spec.h && spec.w * spec.h > limits.maxOutputPixels) throw bad(`size exceeds the ${limits.maxOutputPixels} pixel limit`);
  if (!limits.formats.includes(spec.fmt)) throw bad(`format ${spec.fmt} is not enabled on this service`);
}

export interface ParsedRequest { spec: ResizeSpec; key: string; style: 'compact' | 'path' }

/** Parse the decoded text after the signature: "{spec}/{key}". */
export function parseImageRequest(rest: string, limits: ImageLimits): ParsedRequest {
  const seg = rest.split('/');
  if (seg.length < 2) throw bad('expected {spec}/{image path}');
  let spec: ResizeSpec, used: number, style: ParsedRequest['style'];
  if (PATH_FITS[seg[0]] || seg[1] === 'smart' || seg[1]?.startsWith('filter(')) {
    ({ spec, used } = parsePathStyle(seg)); style = 'path';
  } else {
    spec = parseCompact(seg[0]); used = 1; style = 'compact';
  }
  const key = checkKey(seg.slice(used).join('/'));
  enforceLimits(spec, limits);
  return { spec, key, style };
}

/** Content type for a format. */
export const contentTypeOf = (f: Format) => `image/${f}`;
