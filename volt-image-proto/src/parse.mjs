// Parse our on-the-fly image URL grammar (Thumbor-inspired, our own cleaner form):
//
//   /{sig}/{fit}/{WxH}/{filter(...)}/{path...}
//
//   sig     optional. HMAC of everything after it, or the literal "unsafe" in dev.
//   fit     fit-in | fill | stretch | cover(=fill). default: fill.
//   WxH     1920x0  -> width 1920, height auto (keep aspect)
//           0x1080  -> height 1080, width auto
//           1920x1080 -> exact box
//   filter  optional: filter(sharpen:100,quality:80,format:webp,blur:2,grayscale,
//                              focus:top-right,background:0b1020)
//           (also accepts focus(...) as its own segment)
//   path    the source key, e.g. live_channel/TV1.png
//
// Matches the given examples:
//   /fit-in/1920x0/live_channel/TV1.png
//   /fit-in/1920x0/filter(sharpen:100)/live_channel/TV1.png
// Pure + unit-tested.

const FITS = new Set(['fit-in', 'fill', 'stretch', 'cover']);
const FOCI = new Set(['center', 'centre', 'top', 'bottom', 'left', 'right',
  'top-left', 'top-right', 'bottom-left', 'bottom-right', 'smart']);

export function parseImageUrl(pathname) {
  const parts = pathname.replace(/^\/+/, '').split('/').filter(Boolean);
  if (!parts.length) throw new Error('empty request');

  let sig = null;
  // a leading segment is the signature unless it is a known fit mode or looks like a size
  if (!FITS.has(parts[0]) && !/^\d*x\d*$/.test(parts[0]) && !parts[0].startsWith('filter(')) {
    sig = parts.shift();
  }

  let fit = 'fill';
  if (FITS.has(parts[0])) fit = parts.shift();
  if (fit === 'cover') fit = 'fill';

  const size = parts.shift() || '';
  const m = size.match(/^(\d*)x(\d*)$/);
  if (!m) throw new Error(`bad size '${size}' (want WxH, 0 = auto)`);
  const width = m[1] ? parseInt(m[1], 10) : 0;
  const height = m[2] ? parseInt(m[2], 10) : 0;
  if (!width && !height) throw new Error('at least one of width/height must be non-zero');

  const filters = { sharpen: null, blur: null, quality: null, format: null, grayscale: false, focus: 'center', background: null };
  if (parts[0] && parts[0].startsWith('filter(')) {
    const body = parts.shift().replace(/^filter\(/, '').replace(/\)$/, '');
    for (const tok of body.split(',').map(s => s.trim()).filter(Boolean)) {
      const [k, v] = tok.split(':').map(s => s.trim());
      if (k === 'sharpen') filters.sharpen = v == null ? 100 : Number(v);
      else if (k === 'blur') filters.blur = Number(v);
      else if (k === 'quality') filters.quality = Number(v);
      else if (k === 'format') filters.format = v;
      else if (k === 'grayscale' || k === 'greyscale') filters.grayscale = true;
      else if (k === 'focus') filters.focus = v;
      else if (k === 'background') filters.background = v;
      else throw new Error(`unknown filter '${k}'`);
    }
  }
  // a standalone focus(...) segment is also accepted
  if (parts[0] && parts[0].startsWith('focus(')) {
    filters.focus = parts.shift().replace(/^focus\(/, '').replace(/\)$/, '');
  }
  if (filters.focus === 'centre') filters.focus = 'center';
  if (!FOCI.has(filters.focus) && !/^[0-9.]+x[0-9.]+$/.test(filters.focus))
    throw new Error(`bad focus '${filters.focus}'`);

  const key = parts.join('/');
  if (!key) throw new Error('missing source path');

  return { sig, fit, width, height, filters, key,
    // the canonical string that gets signed / cached (everything after the sig)
    canonical: [fit, size, ...(hasFilters(filters) ? [reFilter(filters)] : []), key].join('/') };
}

function hasFilters(f) {
  return f.sharpen != null || f.blur != null || f.quality != null || f.format || f.grayscale || f.focus !== 'center' || f.background;
}
function reFilter(f) {
  const p = [];
  if (f.sharpen != null) p.push(`sharpen:${f.sharpen}`);
  if (f.blur != null) p.push(`blur:${f.blur}`);
  if (f.quality != null) p.push(`quality:${f.quality}`);
  if (f.format) p.push(`format:${f.format}`);
  if (f.grayscale) p.push('grayscale');
  if (f.focus && f.focus !== 'center') p.push(`focus:${f.focus}`);
  if (f.background) p.push(`background:${f.background}`);
  return `filter(${p.join(',')})`;
}
