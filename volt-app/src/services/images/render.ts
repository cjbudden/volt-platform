// ============================================================================
//  RENDER: one source image + one ResizeSpec -> one derivative, with sharp.
//
//  Single decode, single encode. EXIF orientation is applied first so crop and
//  focus percentages refer to the picture as people see it. The hard crop and
//  the focal window are composed into ONE pre-resize extract, then resize, then
//  the colour filters, then the encoder.
//
//  Guards here are the ones only the decoder can see: pixel count of the source
//  (decompression bombs), a render timeout, and unreadable input. Size and
//  format guards are in grammar.ts, before any bytes are fetched.
// ============================================================================
import sharp, { type Metadata } from 'sharp';
import { ImageError, type Gravity, type ResizeSpec } from './grammar';

export interface RenderOptions {
  maxInputPixels: number;
  timeoutSeconds: number;
}
export interface Rendered { buffer: Buffer; contentType: string; width: number; height: number }

const POSITION: Record<string, string> = {
  center: 'centre', top: 'top', bottom: 'bottom', left: 'left', right: 'right',
  'top-left': 'left top', 'top-right': 'right top', 'bottom-left': 'left bottom', 'bottom-right': 'right bottom',
};

function position(g: Gravity | undefined): string | number {
  if (g === 'smart') return sharp.strategy.attention;
  if (g === 'entropy') return sharp.strategy.entropy;
  return POSITION[g ?? 'center'];
}

function rgb(hex: string, alpha = 1) {
  return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), alpha };
}

// libvips is told how many threads it may use per render, and how much of its
// operation cache to keep. Renders are independent (different sources), so a
// large operation cache only costs memory.
let tuned = false;
function tune() {
  if (tuned) return;
  tuned = true;
  sharp.cache({ memory: 64, files: 0, items: 200 });
  const threads = Number(process.env.IMAGE_VIPS_THREADS);
  if (Number.isFinite(threads) && threads > 0) sharp.concurrency(threads);
}

export async function renderImage(source: Buffer, spec: ResizeSpec, opts: RenderOptions): Promise<Rendered> {
  tune();
  const base = { limitInputPixels: opts.maxInputPixels, animated: false, failOn: 'error' as const };
  let meta: Metadata;
  try {
    meta = await sharp(source, base).metadata();
  } catch (e: any) {
    throw classify(e);
  }
  if ((meta.width ?? 0) * (meta.height ?? 0) > opts.maxInputPixels) {
    throw new ImageError(413, 'source image has too many pixels');
  }

  // Vector art: rasterise at a density that reaches the requested size without
  // blur.
  // The cap is the input pixel budget, so a tiny viewBox cannot be blown up
  // into a huge bitmap either.
  let density: number | undefined;
  if (meta.format === 'svg' && meta.width && meta.height) {
    const want = Math.max(spec.w / meta.width, spec.h / meta.height, 1);
    const budget = Math.sqrt(opts.maxInputPixels / (meta.width * meta.height));
    density = Math.max(1, Math.min(72 * want, 72 * budget));
  }

  let img = sharp(source, { ...base, ...(density ? { density } : {}) }).rotate().timeout({ seconds: opts.timeoutSeconds });

  // Oriented source dimensions (EXIF 5..8 swap the sides).
  const swap = (meta.orientation ?? 1) >= 5;
  const sw = (swap ? meta.height : meta.width) ?? 0;
  const sh = (swap ? meta.width : meta.height) ?? 0;
  const k = density ? density / 72 : 1;            // svg rasterises at k x its nominal size
  const SW = Math.round(sw * k), SH = Math.round(sh * k);

  // Region left after the hard crop, in source pixels.
  const R = spec.crop && SW && SH
    ? (() => {
        const left = Math.round((spec.crop!.x / 100) * SW), top = Math.round((spec.crop!.y / 100) * SH);
        return {
          left, top,
          width: Math.max(1, Math.min(SW - left, Math.round((spec.crop!.w / 100) * SW))),
          height: Math.max(1, Math.min(SH - top, Math.round((spec.crop!.h / 100) * SH))),
        };
      })()
    : { left: 0, top: 0, width: SW, height: SH };

  const w = spec.w || null, h = spec.h || null;
  const bg = spec.bg ? rgb(spec.bg) : { r: 0, g: 0, b: 0, alpha: 0 };

  if (spec.fit === 'cover' && spec.focus && spec.w && spec.h && R.width && R.height) {
    // AREA OF FOCUS: the largest window with the target aspect, centred on the
    // focal point (given in SOURCE percent) and clamped inside the crop region.
    const scale = Math.max(spec.w / R.width, spec.h / R.height);
    const cw = Math.min(R.width, Math.round(spec.w / scale));
    const ch = Math.min(R.height, Math.round(spec.h / scale));
    const fx = (spec.focus.x / 100) * SW, fy = (spec.focus.y / 100) * SH;
    const left = Math.max(R.left, Math.min(R.left + R.width - cw, Math.round(fx - cw / 2)));
    const top = Math.max(R.top, Math.min(R.top + R.height - ch, Math.round(fy - ch / 2)));
    img = img.extract({ left, top, width: cw, height: ch })
      .resize(spec.w, spec.h, { fit: 'fill', withoutEnlargement: !spec.enlarge });
  } else {
    if (spec.crop && R.width && R.height) img = img.extract(R);
    img = img.resize(w, h, {
      fit: spec.fit,
      position: spec.fit === 'cover' ? position(spec.gravity) : 'centre',
      background: bg,
      withoutEnlargement: !spec.enlarge,
    });
  }

  if (spec.bright !== undefined || spec.sat !== undefined) {
    img = img.modulate({ brightness: (spec.bright ?? 100) / 100, saturation: (spec.sat ?? 100) / 100 });
  }
  if (spec.gray) img = img.grayscale();
  if (spec.blur) img = img.blur(spec.blur);
  if (spec.sharpen) img = img.sharpen({ sigma: spec.sharpen });

  switch (spec.fmt) {
    case 'jpeg': img = img.flatten({ background: spec.bg ? rgb(spec.bg) : '#ffffff' }).jpeg({ quality: spec.q, mozjpeg: true }); break;
    case 'png': img = img.png({ compressionLevel: 8, adaptiveFiltering: true }); break;
    case 'avif': img = img.avif({ quality: spec.q, effort: 3 }); break;
    default: img = img.webp({ quality: spec.q, effort: 4 });
  }

  try {
    const { data, info } = await img.toBuffer({ resolveWithObject: true });
    return { buffer: data, contentType: `image/${spec.fmt}`, width: info.width, height: info.height };
  } catch (e: any) {
    throw classify(e);
  }
}

function classify(e: any): ImageError {
  const m = String(e?.message ?? e);
  if (/pixel limit/i.test(m)) return new ImageError(413, 'source image has too many pixels');
  if (/timeout/i.test(m)) return new ImageError(503, 'render timed out');
  if (/unsupported image format|Input buffer contains unsupported/i.test(m)) return new ImageError(415, 'source is not a supported image');
  if (/extract_area|bad extract area/i.test(m)) return new ImageError(400, 'crop is outside the image');
  return new ImageError(422, 'source image could not be decoded');
}
