// On-the-fly image resize for library previews. Reads the original from the image
// store, produces a WebP derivative with sharp, and caches it under the store's
// `derived/thumbs/` prefix so repeat loads are instant. This is the resize service
// pointed at the library directory (curated `library/` in, generated `derived/` out).
// Production hardening (HMAC-signed URLs + CDN) layers on top; same-origin app
// previews use it unsigned in dev.
import sharp from 'sharp';
import { imageStore, safeKey } from './imageStore';

export interface ResizeSpec { w: number; h: number; fit: 'cover' | 'inside' | 'contain' | 'fill' }

const MAX_DIM = 2000;
export function parseSpec(spec: string): ResizeSpec | null {
  // "320x200" or "320x200,inside"
  const [dims, fitRaw] = spec.split(',');
  const m = dims.match(/^(\d{1,4})x(\d{1,4})$/);
  if (!m) return null;
  const w = Math.min(MAX_DIM, Math.max(1, parseInt(m[1], 10)));
  const h = Math.min(MAX_DIM, Math.max(1, parseInt(m[2], 10)));
  const fit = (['cover', 'inside', 'contain', 'fill'].includes(fitRaw) ? fitRaw : 'cover') as ResizeSpec['fit'];
  return { w, h, fit };
}

export interface ResizeResult { buffer: Buffer; contentType: string }

export async function resizeFromStore(key: string, spec: ResizeSpec): Promise<ResizeResult | null> {
  const src = safeKey(key);
  // vector art doesn't need rasterising for a preview — serve as-is
  if (src.toLowerCase().endsWith('.svg')) {
    const svg = await imageStore().get(src);
    return svg ? { buffer: svg, contentType: 'image/svg+xml' } : null;
  }
  const derivedKey = `derived/thumbs/${spec.w}x${spec.h}-${spec.fit}/${src}.webp`;
  const cached = await imageStore().get(derivedKey);
  if (cached) return { buffer: cached, contentType: 'image/webp' };

  const original = await imageStore().get(src);
  if (!original) return null;
  try {
    const out = await sharp(original, { animated: false })
      .rotate() // respect EXIF orientation
      .resize(spec.w, spec.h, { fit: spec.fit, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    await imageStore().put(derivedKey, out, 'image/webp').catch(() => {});
    return { buffer: out, contentType: 'image/webp' };
  } catch {
    // not a raster image sharp can handle → fall back to the original bytes
    return { buffer: original, contentType: 'application/octet-stream' };
  }
}
