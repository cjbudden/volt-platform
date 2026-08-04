// Apply a parsed transform with sharp. Maps our fit modes + focus onto sharp's
// resize/position/strategy, then the filter chain, then the output format.
import sharp from 'sharp';

const GRAVITY = {
  center: 'centre', top: 'top', bottom: 'bottom', left: 'left', right: 'right',
  'top-left': 'left top', 'top-right': 'right top',
  'bottom-left': 'left bottom', 'bottom-right': 'right bottom',
};

export async function renderImage(inputBuf, spec) {
  const { fit, width, height, filters } = spec;
  let img = sharp(inputBuf, { failOn: 'none' }).rotate(); // honour EXIF orientation

  const w = width || null, h = height || null;
  if (fit === 'stretch') {
    img = img.resize(w, h, { fit: 'fill' });                       // ignore aspect
  } else if (fit === 'fit-in') {
    img = img.resize(w, h, { fit: 'inside', withoutEnlargement: false }); // whole image inside box
  } else { // fill: cover the box, cropping by focus. needs both dims; if one is 0, behaves like fit-in on that axis.
    if (w && h) {
      const opts = { fit: 'cover' };
      if (filters.focus === 'smart') opts.position = sharp.strategy.attention;
      else opts.position = GRAVITY[filters.focus] || 'centre';
      img = img.resize(w, h, opts);
    } else {
      img = img.resize(w, h, { fit: 'inside' });
    }
  }

  // letterbox background for fit-in when a solid colour is requested
  if (fit === 'fit-in' && filters.background && w && h) {
    img = img.resize(w, h, { fit: 'contain', background: hex(filters.background) });
  }

  if (filters.grayscale) img = img.grayscale();
  if (filters.blur) img = img.blur(Math.max(0.3, filters.blur));
  if (filters.sharpen != null) img = img.sharpen({ sigma: 0.5 + filters.sharpen / 100 });

  const fmt = filters.format || detectFormat(spec.key);
  const q = filters.quality || 82;
  if (fmt === 'webp') img = img.webp({ quality: q });
  else if (fmt === 'avif') img = img.avif({ quality: q });
  else if (fmt === 'png') img = img.png();
  else img = img.jpeg({ quality: q, mozjpeg: true });

  const data = await img.toBuffer({ resolveWithObject: true });
  return { buffer: data.data, format: data.info.format, width: data.info.width, height: data.info.height };
}

function detectFormat(key) {
  const e = (key.split('.').pop() || '').toLowerCase();
  return ['jpg', 'jpeg', 'png', 'webp', 'avif'].includes(e) ? (e === 'jpg' ? 'jpeg' : e) : 'jpeg';
}
function hex(s) {
  const v = s.replace('#', '');
  return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16), alpha: 1 };
}
