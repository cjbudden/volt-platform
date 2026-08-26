// On-the-fly image derivatives for the library. Reads the original from the
// image store, produces a derivative with sharp, and caches it under the
// store's `derived/thumbs/` prefix so repeat loads are instant. This is the
// resize service pointed at the library directory (curated `library/` in,
// generated `derived/` out). Production hardening (HMAC-signed URLs + CDN)
// layers on top; same-origin app previews use it unsigned in dev.
//
// SPEC GRAMMAR (the URL builder in the image library composes these):
//   /img/<WxH>[,fit][,token...]/<store-key>
//     fit          cover | inside | contain | fill        (default cover)
//     crop=X-Y-W-H hard crop applied FIRST, percent of the source
//                  (e.g. crop=25-0-50-100 keeps the middle half)
//     focus=X-Y    area of focus for cover crops, percent of the source
//                  (e.g. focus=30-20 keeps the top-left third in frame);
//                  honoured inside the crop when both are set
//     gray         grayscale
//     blur=N       gaussian blur sigma 0.3..50
//     bright=N     brightness percent 10..300 (100 = unchanged)
//     sat=N        saturation percent 0..300 (100 = unchanged; 0 = grayscale-ish)
//     sharp        light sharpen
//     q=N          quality 1..100 (default 80)
//     fmt=F        webp | jpeg | png (default webp)
//   e.g. /img/640x360,cover,focus=30-20,gray,q=70/library/<acct>/slates/x.png
import sharp from 'sharp';
import { imageStore, safeKey } from './imageStore';

export interface ResizeSpec {
  w: number; h: number; fit: 'cover' | 'inside' | 'contain' | 'fill'
  crop?: { x: number; y: number; w: number; h: number }   // percent of source, applied first
  focus?: { x: number; y: number }        // percent of source, cover only
  gray?: boolean
  blur?: number
  bright?: number                          // percent
  sat?: number                             // percent
  sharpen?: boolean
  q: number
  fmt: 'webp' | 'jpeg' | 'png'
}

const MAX_DIM = 2000;
export function parseSpec(spec: string): ResizeSpec | null {
  const [dims, ...tokens] = spec.split(',');
  const m = dims.match(/^(\d{1,4})x(\d{1,4})$/);
  if (!m) return null;
  const out: ResizeSpec = {
    w: Math.min(MAX_DIM, Math.max(1, parseInt(m[1], 10))),
    h: Math.min(MAX_DIM, Math.max(1, parseInt(m[2], 10))),
    fit: 'cover', q: 80, fmt: 'webp',
  };
  for (const t of tokens) {
    if (['cover', 'inside', 'contain', 'fill'].includes(t)) out.fit = t as ResizeSpec['fit'];
    else if (t === 'gray') out.gray = true;
    else if (t === 'sharp') out.sharpen = true;
    else if (t.startsWith('focus=')) {
      const f = t.slice(6).match(/^(\d{1,3})-(\d{1,3})$/);
      if (f) out.focus = { x: Math.min(100, +f[1]), y: Math.min(100, +f[2]) };
    } else if (t.startsWith('crop=')) {
      const c = t.slice(5).match(/^(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})$/);
      if (c) {
        const x = Math.min(99, +c[1]), y = Math.min(99, +c[2]);
        const cw = Math.max(1, Math.min(100 - x, +c[3])), ch = Math.max(1, Math.min(100 - y, +c[4]));
        out.crop = { x, y, w: cw, h: ch };
      }
    } else if (t.startsWith('blur=')) {
      const v = parseFloat(t.slice(5));
      if (Number.isFinite(v)) out.blur = Math.min(50, Math.max(0.3, v));
    } else if (t.startsWith('bright=')) {
      const v = parseInt(t.slice(7), 10);
      if (Number.isFinite(v)) out.bright = Math.min(300, Math.max(10, v));
    } else if (t.startsWith('sat=')) {
      const v = parseInt(t.slice(4), 10);
      if (Number.isFinite(v)) out.sat = Math.min(300, Math.max(0, v));
    } else if (t.startsWith('q=')) {
      const v = parseInt(t.slice(2), 10);
      if (Number.isFinite(v)) out.q = Math.min(100, Math.max(1, v));
    } else if (t.startsWith('fmt=')) {
      const v = t.slice(4);
      if (['webp', 'jpeg', 'png'].includes(v)) out.fmt = v as ResizeSpec['fmt'];
    }
    // unknown tokens are ignored (forwards-compatible URLs)
  }
  return out;
}

/** Canonical cache-key fragment for a spec (stable across param order). */
function specKey(s: ResizeSpec): string {
  const parts = [`${s.w}x${s.h}`, s.fit];
  if (s.crop) parts.push(`c${s.crop.x}-${s.crop.y}-${s.crop.w}-${s.crop.h}`);
  if (s.focus) parts.push(`f${s.focus.x}-${s.focus.y}`);
  if (s.gray) parts.push('g');
  if (s.blur) parts.push(`b${s.blur}`);
  if (s.bright && s.bright !== 100) parts.push(`br${s.bright}`);
  if (s.sat != null && s.sat !== 100) parts.push(`s${s.sat}`);
  if (s.sharpen) parts.push('sh');
  parts.push(`q${s.q}`, s.fmt);
  return parts.join('_');
}

export interface ResizeResult { buffer: Buffer; contentType: string }

export async function resizeFromStore(key: string, spec: ResizeSpec): Promise<ResizeResult | null> {
  const src = safeKey(key);
  // vector art doesn't need rasterising for a preview — serve as-is
  if (src.toLowerCase().endsWith('.svg')) {
    const svg = await imageStore().get(src);
    return svg ? { buffer: svg, contentType: 'image/svg+xml' } : null;
  }
  const derivedKey = `derived/thumbs/${specKey(spec)}/${src}.${spec.fmt}`;
  const contentType = `image/${spec.fmt}`;
  const cached = await imageStore().get(derivedKey);
  if (cached) return { buffer: cached, contentType };

  const original = await imageStore().get(src);
  if (!original) return null;
  try {
    // normalise EXIF orientation FIRST so crop/focal math sees true dimensions
    const upright = await sharp(original, { animated: false }).rotate().toBuffer();
    let img = sharp(upright);

    // HARD CROP first (percent of the source). Focus coordinates are given in
    // SOURCE percent too (that is what the builder overlay shows), so remap
    // them into the cropped frame before the focal cover-crop below.
    let focus = spec.focus;
    if (spec.crop) {
      const meta0 = await img.metadata();
      const sw0 = meta0.width ?? 0, sh0 = meta0.height ?? 0;
      if (sw0 > 0 && sh0 > 0) {
        const left = Math.round((spec.crop.x / 100) * sw0);
        const top = Math.round((spec.crop.y / 100) * sh0);
        const cw = Math.max(1, Math.min(sw0 - left, Math.round((spec.crop.w / 100) * sw0)));
        const ch = Math.max(1, Math.min(sh0 - top, Math.round((spec.crop.h / 100) * sh0)));
        img = sharp(await img.extract({ left, top, width: cw, height: ch }).toBuffer());
        if (focus) {
          focus = {
            x: Math.max(0, Math.min(100, ((focus.x - spec.crop.x) / spec.crop.w) * 100)),
            y: Math.max(0, Math.min(100, ((focus.y - spec.crop.y) / spec.crop.h) * 100)),
          };
        }
      }
    }

    if (spec.fit === 'cover' && focus) {
      // AREA OF FOCUS: crop the largest window with the target aspect whose
      // centre sits at the focal point (clamped inside the frame), then scale.
      const meta = await img.metadata();
      const sw = meta.width ?? 0, sh = meta.height ?? 0;
      if (sw > 0 && sh > 0) {
        const scale = Math.max(spec.w / sw, spec.h / sh);
        const cw = Math.min(sw, Math.round(spec.w / scale));
        const ch = Math.min(sh, Math.round(spec.h / scale));
        const cx = Math.round((focus.x / 100) * sw - cw / 2);
        const cy = Math.round((focus.y / 100) * sh - ch / 2);
        img = img.extract({
          left: Math.max(0, Math.min(sw - cw, cx)),
          top: Math.max(0, Math.min(sh - ch, cy)),
          width: cw, height: ch,
        }).resize(spec.w, spec.h, { fit: 'fill' });
      } else {
        img = img.resize(spec.w, spec.h, { fit: spec.fit, withoutEnlargement: true });
      }
    } else {
      img = img.resize(spec.w, spec.h, { fit: spec.fit, withoutEnlargement: true });
    }

    if (spec.bright !== undefined || spec.sat !== undefined) {
      img = img.modulate({
        brightness: (spec.bright ?? 100) / 100,
        saturation: (spec.sat ?? 100) / 100,
      });
    }
    if (spec.gray) img = img.grayscale();
    if (spec.blur) img = img.blur(spec.blur);
    if (spec.sharpen) img = img.sharpen();

    const out = await (spec.fmt === 'jpeg' ? img.jpeg({ quality: spec.q })
      : spec.fmt === 'png' ? img.png()
      : img.webp({ quality: spec.q })).toBuffer();
    await imageStore().put(derivedKey, out, contentType).catch(() => {});
    return { buffer: out, contentType };
  } catch {
    // not a raster image sharp can handle → fall back to the original bytes
    return { buffer: original, contentType: 'application/octet-stream' };
  }
}
