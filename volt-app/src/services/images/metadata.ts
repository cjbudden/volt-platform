// ============================================================================
//  IMAGE METADATA: what a file says about itself, read once at upload.
//
//  sharp gives the technical facts (format, size, colour space, alpha, pages).
//  exifr reads EXIF (camera, lens, exposure, date taken), GPS, IPTC and XMP
//  (title, description, keywords, creator, copyright, place names). The result
//  is a small set of columns the library searches and filters on, plus the
//  full normalised record in media_files.metadata for display.
//
//  Never throws: an image with no or broken metadata is still an image.
//  Location is what the FILE says: GPS coordinates, and any place names a
//  camera or editor wrote (IPTC City / State / Country, XMP photoshop:City...).
//  There is no reverse geocoding (no outbound call per upload); see
//  docs/IMAGES.md "Metadata" for adding it as a workflow add-on.
// ============================================================================
import { createHash } from 'node:crypto';
import sharp, { type Metadata } from 'sharp';
import exifr from 'exifr';

export interface ImageFacts {
  contentType: string | null;
  width: number | null;
  height: number | null;
  checksum: string;
  takenAt: Date | null;
  gpsLat: number | null;
  gpsLng: number | null;
  gpsAlt: number | null;
  location: string | null;
  camera: string | null;
  title: string | null;
  description: string | null;
  keywords: string[];
  creator: string | null;
  copyright: string | null;
  /** Everything worth showing, JSON-safe. */
  metadata: Record<string, unknown>;
}

const FORMAT_TYPES: Record<string, string> = {
  jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
  heif: 'image/heif', tiff: 'image/tiff', svg: 'image/svg+xml',
};

const text = (v: unknown): string | null => {
  if (v == null) return null;
  if (Array.isArray(v)) v = v.filter(Boolean).join(', ');
  if (typeof v === 'object') {
    // XMP language alternatives: { value: 'x', lang: 'x-default' } or { 'x-default': 'x' }
    const o = v as any;
    v = o.value ?? o['x-default'] ?? Object.values(o).find((x) => typeof x === 'string') ?? null;
  }
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).replace(/\u0000/g, '').trim();
  return s ? s.slice(0, 2000) : null;
};

const list = (v: unknown): string[] => {
  if (v == null) return [];
  const raw = Array.isArray(v) ? v : String(v).split(/[;,]/);
  const out = new Set<string>();
  for (const k of raw) { const t = text(k); if (t) out.add(t.slice(0, 120)); }
  return [...out].slice(0, 100);
};

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * EXIF dates carry no zone ("2024:05:01 10:22:33"). With OffsetTimeOriginal
 * ("+10:00") the instant is exact; without one the camera's wall clock is kept
 * as written (stored as if UTC), never re-read in this server's time zone.
 */
function date(v: unknown, offset?: unknown): Date | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v;
  if (typeof v === 'string') {
    const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/.exec(v.trim());
    if (m) {
      const off = m[8] ?? (typeof offset === 'string' && /^[+-]\d{2}:\d{2}$/.test(offset.trim()) ? offset.trim() : 'Z');
      const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ?? ''}${off}`);
      if (!Number.isNaN(d.getTime())) return d;
    }
    const d = new Date(v);
    if (/\d{4}/.test(v) && !Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/** Keep the record JSON-safe and small: no binary blobs, no huge strings. */
function plain(v: unknown, depth = 0): unknown {
  if (v == null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v.replace(/\u0000/g, '').slice(0, 500);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (ArrayBuffer.isView(v)) return undefined;
  if (Array.isArray(v)) return depth > 2 ? undefined : v.slice(0, 50).map((x) => plain(x, depth + 1));
  if (typeof v === 'object') {
    if (depth > 2) return undefined;
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as object)) { const p = plain(x, depth + 1); if (p !== undefined) o[k] = p; }
    return o;
  }
  return undefined;
}

export async function readImageFacts(buf: Buffer): Promise<ImageFacts> {
  const checksum = createHash('sha256').update(buf).digest('hex');
  let meta: Metadata | null = null;
  try { meta = await sharp(buf, { limitInputPixels: 300_000_000 }).metadata(); } catch { /* not an image sharp reads */ }

  let tags: any = null;
  try {
    tags = await exifr.parse(buf, {
      tiff: true, exif: true, gps: true, iptc: true, xmp: true, icc: false, jfif: false, ihdr: true,
      mergeOutput: true, translateValues: true, reviveValues: false, sanitize: true,
    });
  } catch { /* no metadata, or an unsupported container */ }
  const t = tags ?? {};

  // Orientation 5..8 swaps the sides people see.
  const swap = (meta?.orientation ?? 1) >= 5;
  const width = meta?.width ? (swap ? meta.height ?? null : meta.width) : null;
  const height = meta?.height ? (swap ? meta.width ?? null : meta.height) : null;

  const lat = finite(t.latitude), lng = finite(t.longitude);
  const valid = lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

  const place = [
    t.Sublocation ?? t['Sub-location'] ?? t.Location,
    t.City, t['Province-State'] ?? t.State, t['Country-PrimaryLocationName'] ?? t.Country,
  ].map(text).filter(Boolean);
  const make = text(t.Make), model = text(t.Model);
  const camera = model && make && model.toLowerCase().startsWith(make.toLowerCase()) ? model : [make, model].filter(Boolean).join(' ') || null;

  const metadata = plain({
    format: meta?.format ?? null,
    space: meta?.space ?? null,
    channels: meta?.channels ?? null,
    depth: meta?.depth ?? null,
    density: meta?.density ?? null,
    hasAlpha: meta?.hasAlpha ?? null,
    hasProfile: meta?.hasProfile ?? null,
    orientation: meta?.orientation ?? null,
    pages: meta?.pages ?? null,
    lens: text(t.LensModel ?? t.Lens),
    exposure: Number(t.ExposureTime) > 0 ? (Number(t.ExposureTime) >= 1 ? `${Number(t.ExposureTime)}s` : `1/${Math.round(1 / Number(t.ExposureTime))}s`) : null,
    fNumber: finite(t.FNumber),
    iso: finite(t.ISO),
    focalLength: finite(t.FocalLength),
    software: text(t.Software),
    rating: finite(t.Rating),
    headline: text(t.Headline),
    credit: text(t.Credit),
    source: text(t.Source),
    exif: t,
  }) as Record<string, unknown>;

  return {
    contentType: meta?.format ? FORMAT_TYPES[meta.format] ?? `image/${meta.format}` : null,
    width, height, checksum,
    takenAt: date(t.DateTimeOriginal ?? t.CreateDate ?? t.DateCreated ?? t.DateTimeDigitized, t.OffsetTimeOriginal ?? t.OffsetTime),
    gpsLat: valid ? lat : null,
    gpsLng: valid ? lng : null,
    gpsAlt: valid ? finite(t.GPSAltitude) : null,
    location: place.length ? [...new Set(place)].join(', ') : null,
    camera,
    title: text(t.title ?? t.ObjectName ?? t.Headline ?? t.XPTitle),
    description: text(t.description ?? t.ImageDescription ?? t['Caption-Abstract'] ?? t.XPComment),
    keywords: list(t.subject ?? t.Keywords ?? t.XPKeywords),
    creator: text(t.creator ?? t.Artist ?? t['By-line'] ?? t.XPAuthor),
    copyright: text(t.rights ?? t.Copyright ?? t.CopyrightNotice),
    metadata,
  };
}
