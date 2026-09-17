// ============================================================================
//  EXTRACTED METADATA — what the file says about itself, and how it lands in a
//  content type.
//
//  Three layers, merged in a fixed order:
//    1. extracted   (ffprobe, ID3 / container tags, image facts, file facts)
//    2. rule        (defaults a rule sets, e.g. a folder that is always Sport)
//    3. operator    (what a person typed or an API caller sent)
//  Later wins. Nothing extracted ever overwrites something a person said.
//
//  MAPPING IS PER FIELD KEY, NOT PER TYPE. A content type has field keys
//  (name, performer, album, duration ...). The default map says which
//  extracted value fills which key when the type has that key. A type that
//  lacks 'performer' simply never receives it. Accounts can extend the map on
//  a rule, but the default covers the standard types.
// ============================================================================
import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { readId3v2, type Id3Tags } from './id3';
import { sniff, SNIFF_BYTES, type Sniffed } from './sniff';
import type { MediaKind } from './rules';
import type { SchemaField } from '../metadataValidator';

export interface Extracted {
  file: { originalName: string; bytes: number; sha256?: string | null; mtime?: string | null; sourcePath?: string | null };
  type: Sniffed & { kind: MediaKind; declaredMime?: string | null; extensionMismatch: boolean };
  probe?: {
    format?: string; durationSec?: number | null; bitrateKbps?: number | null;
    video?: { codec?: string; width?: number; height?: number; fps?: number | null; fieldOrder?: string | null; pixFmt?: string | null } | null;
    audio?: { codec?: string; channels?: number; sampleRate?: number; count: number } | null;
    tags?: Record<string, string>;
  } | null;
  id3?: Id3Tags | null;
  image?: { width: number; height: number } | null;
}

function kindFromMime(m: string): MediaKind {
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('image/')) return 'image';
  return 'other';
}

/** Common declared-vs-real mismatches worth flagging (a .mp4 that is QuickTime is fine). */
function mismatch(ext: string, s: Sniffed): boolean {
  if (s.unknown) return false;
  const ok: Record<string, string[]> = {
    mp4: ['mp4', 'quicktime', 'm4a'], m4v: ['mp4'], mov: ['quicktime', 'mp4'], m4a: ['m4a', 'mp4'],
    mxf: ['mxf'], mkv: ['matroska'], webm: ['webm', 'matroska'], avi: ['avi'], ts: ['mpeg-ts'], m2ts: ['mpeg-ts'], mpg: ['mpeg-ps'], mpeg: ['mpeg-ps'],
    mp3: ['mp3'], aac: ['aac'], wav: ['wav'], flac: ['flac'], ogg: ['ogg', 'opus'], opus: ['opus'], aif: ['aiff'], aiff: ['aiff'],
    png: ['png'], jpg: ['jpeg'], jpeg: ['jpeg'], gif: ['gif'], webp: ['webp'], tif: ['tiff'], tiff: ['tiff'], bmp: ['bmp'], svg: ['svg'], heic: ['heic'], avif: ['avif'],
  };
  const allowed = ok[ext];
  return allowed ? !allowed.includes(s.container) : false;
}

export async function readHead(path: string, bytes: number): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

function ffprobe(path: string, timeoutMs = 20000): Promise<any | null> {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => { if (err) return resolve(null); try { resolve(JSON.parse(stdout)); } catch { resolve(null); } });
  });
}

function fpsOf(s: any): number | null {
  const r = s?.avg_frame_rate || s?.r_frame_rate; if (!r || typeof r !== 'string') return null;
  const [n, d] = r.split('/').map(Number); if (!d) return null; const v = n / d;
  return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) / 1000 : null;
}

/** Pure part: interpret ffprobe JSON. Exported so tests can feed captured output. */
export function interpretProbe(j: any): NonNullable<Extracted['probe']> {
  const streams: any[] = j?.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition?.attached_pic));
  const a = streams.filter((s) => s.codec_type === 'audio');
  const dur = Number(j?.format?.duration); const br = Number(j?.format?.bit_rate);
  const tags: Record<string, string> = {};
  for (const [k, val] of Object.entries(j?.format?.tags ?? {})) tags[k.toLowerCase()] = String(val);
  return {
    format: j?.format?.format_name,
    durationSec: Number.isFinite(dur) ? Math.round(dur * 1000) / 1000 : null,
    bitrateKbps: Number.isFinite(br) ? Math.round(br / 1000) : null,
    video: v ? { codec: v.codec_name, width: v.width, height: v.height, fps: fpsOf(v), fieldOrder: v.field_order ?? null, pixFmt: v.pix_fmt ?? null } : null,
    audio: a.length ? { codec: a[0].codec_name, channels: a[0].channels, sampleRate: Number(a[0].sample_rate) || undefined, count: a.length } : null,
    tags,
  };
}

/** Everything the file can tell us. ffprobe failure is not an error: the type is still recorded. */
export async function extract(path: string, file: Extracted['file'], declaredMime?: string | null): Promise<Extracted> {
  const head = await readHead(path, Math.max(SNIFF_BYTES, 256 * 1024)); // enough for most ID3 tags without cover art
  const s = sniff(head.subarray(0, SNIFF_BYTES), file.originalName);
  const ext = /\.([a-z0-9]+)$/i.exec(file.originalName)?.[1]?.toLowerCase() ?? '';
  const out: Extracted = {
    file,
    type: { ...s, kind: kindFromMime(s.mime), declaredMime: declaredMime ?? null, extensionMismatch: mismatch(ext, s) },
    probe: null, id3: null, image: null,
  };
  if (s.id3Bytes) {
    const tagBuf = head.length >= s.id3Bytes ? head : await readHead(path, s.id3Bytes);
    out.id3 = readId3v2(tagBuf);
  }
  if (out.type.kind !== 'other' || !s.unknown) {
    const j = await ffprobe(path);
    if (j) {
      out.probe = interpretProbe(j);
      if (out.type.kind === 'image' && out.probe.video) out.image = { width: out.probe.video.width ?? 0, height: out.probe.video.height ?? 0 };
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------
 *  MAPPING INTO A CONTENT TYPE
 * ------------------------------------------------------------------------ */

/** Flatten what was extracted into candidate values keyed by well-known names. */
export function candidates(x: Extracted): Record<string, any> {
  const c: Record<string, any> = {};
  const t = x.probe?.tags ?? {};
  const id3 = x.id3 ?? {};
  const pick = (...vals: (string | undefined | null)[]) => vals.find((v) => v && String(v).trim()) ?? undefined;
  c.name = pick(id3.title, t.title);
  c.performer = pick(id3.artist, t.artist);
  c.album = pick(id3.album, t.album);
  c.albumArtist = pick(id3.albumArtist, t.album_artist);
  c.composer = pick(id3.composer, t.composer);
  c.genre = pick(id3.genre, t.genre);
  c.track = pick(id3.track, t.track);
  c.year = pick(id3.year, t.date, t.year);
  c.description = pick(id3.comment, t.comment, t.description);
  c.language = pick(t.language);
  c.copyright = pick(t.copyright);
  c.encoder = pick(t.encoder);
  if (x.probe?.durationSec != null) c.durationSec = x.probe.durationSec;
  if (x.probe?.video) { c.width = x.probe.video.width; c.height = x.probe.video.height; c.fps = x.probe.video.fps ?? undefined; c.videoCodec = x.probe.video.codec; }
  if (x.probe?.audio) { c.audioCodec = x.probe.audio.codec; c.channels = x.probe.audio.channels; c.sampleRate = x.probe.audio.sampleRate; }
  if (x.image) { c.width = x.image.width; c.height = x.image.height; }
  if (c.width && c.height) c.resolution = `${c.width}x${c.height}`;
  c.container = x.type.container; c.mime = x.type.mime; c.bytes = x.file.bytes; c.originalName = x.file.originalName;
  for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k];
  return c;
}

/** Default field-key mapping: a type field key on the left takes the candidate on the right. */
export const DEFAULT_FIELD_MAP: Record<string, string[]> = {
  name: ['name'], title: ['name'], headline: ['name'],
  performer: ['performer'], artist: ['performer'], byArtist: ['performer'],
  album: ['album'], inAlbum: ['album'], albumArtist: ['albumArtist'],
  composer: ['composer'], genre: ['genre'], track: ['track'], trackNumber: ['track'],
  year: ['year'], datePublished: ['year'], description: ['description'], abstract: ['description'],
  language: ['language', 'inLanguage'], inLanguage: ['language'], copyright: ['copyright'],
  duration: ['durationSec'], durationSec: ['durationSec'],
  width: ['width'], height: ['height'], resolution: ['resolution'],
};

/** Coerce a candidate to a field's declared type where obvious. */
function coerce(field: SchemaField, v: any): any {
  const t = (field as any).type as string | undefined;
  if (t === 'number' || t === 'integer') {
    // '1/5' (track of total) and '25 fps' both mean their leading number.
    const n = typeof v === 'number' ? v : parseFloat(String(v).trim());
    return Number.isFinite(n) ? (t === 'integer' ? Math.round(n) : n) : undefined;
  }
  if (t === 'boolean') return typeof v === 'boolean' ? v : undefined;
  if (t === 'list' || t === 'array' || t === 'multiselect') return Array.isArray(v) ? v : String(v).split(/[;,/]/).map((s) => s.trim()).filter(Boolean);
  if (t === 'select' || t === 'enum') {
    const opts: any[] = (field as any).options ?? [];
    const hit = opts.find((o) => String(typeof o === 'string' ? o : o?.value ?? o?.key).toLowerCase() === String(v).toLowerCase());
    return hit ? (typeof hit === 'string' ? hit : hit.value ?? hit.key) : undefined;
  }
  return typeof v === 'string' ? v : String(v);
}

export interface Merged {
  metadata: Record<string, any>;
  /** Where each key came from. */
  sources: Record<string, 'extracted' | 'rule' | 'operator'>;
  /** Extracted values that had no field to land in (kept in the sidecar, not on the asset). */
  unmapped: Record<string, any>;
}

/**
 * Pure. Merge extracted candidates, rule defaults and operator values into
 * the type's fields. Only keys the type defines are produced, so the strict
 * asset validator accepts the result.
 */
export function mergeMetadata(
  fields: SchemaField[],
  extracted: Record<string, any>,
  ruleDefaults: Record<string, any> | null | undefined,
  operator: Record<string, any> | null | undefined,
  fieldMap: Record<string, string[]> = DEFAULT_FIELD_MAP
): Merged {
  const metadata: Record<string, any> = {};
  const sources: Merged['sources'] = {};
  const used = new Set<string>();
  for (const f of fields) {
    const cands = fieldMap[f.key] ?? [f.key];
    for (const c of cands) {
      if (extracted[c] !== undefined) {
        const v = coerce(f, extracted[c]);
        if (v !== undefined && v !== '') { metadata[f.key] = v; sources[f.key] = 'extracted'; used.add(c); break; }
      }
    }
  }
  const known = new Set(fields.map((f) => f.key));
  for (const [k, v] of Object.entries(ruleDefaults ?? {})) if (known.has(k) && v !== undefined && v !== null && v !== '') { metadata[k] = v; sources[k] = 'rule'; }
  for (const [k, v] of Object.entries(operator ?? {})) if (known.has(k) && v !== undefined && v !== null && v !== '') { metadata[k] = v; sources[k] = 'operator'; }
  const unmapped: Record<string, any> = {};
  for (const [k, v] of Object.entries(extracted)) if (!used.has(k)) unmapped[k] = v;
  return { metadata, sources, unmapped };
}

/** Which required fields are still empty after the merge. */
export function missingRequired(fields: SchemaField[], metadata: Record<string, any>): string[] {
  return fields.filter((f) => f.required && (metadata[f.key] === undefined || metadata[f.key] === null || metadata[f.key] === '')).map((f) => f.key);
}
