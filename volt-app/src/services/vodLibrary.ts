// ============================================================================
//  THE MEDIA LIBRARY VIEW: target metadata, completeness and encode facts.
//
//  Three questions an operator brings to the library, answered in one place so
//  the list (SQL) and the asset page (TypeScript) can never disagree:
//
//    1. WHAT SHOULD THIS ASSET CARRY? Every content type (a metadata_schemas
//       row, services/contentTypes.ts) has TARGET fields: the ones a catalogue,
//       a guide or a schema.org consumer needs. Some are required, the rest are
//       recommended. They are the existing types' own field keys, never a
//       second taxonomy: Episode wants series, season and episode number,
//       a sports match wants competition and both teams, and so on.
//    2. HOW COMPLETE IS IT? Filled target fields over target fields, plus the
//       list of required ones still empty. A type with no standard key (a
//       client's own schema) targets all of its fields and requires the ones
//       the schema marks required.
//    3. HOW WAS IT ENCODED? See encodeDetails() below.
//
//  The SQL builders take trusted expressions only (column names written here),
//  never request input, so they can sit inside the list standard's field specs
//  (util/listQuery.ts) and be filtered and sorted like any other column.
// ============================================================================
import type { SchemaField } from './metadataValidator';

export interface TargetSpec {
  /** Field keys a catalogue cannot do without. */
  required: string[];
  /** Field keys that make the entry complete. */
  recommended: string[];
}

/**
 * Target metadata per standard content type, by standard_key. Keys are the
 * type's own field keys. A key the client's copy of the type does not have
 * (a standard edited after it was seeded, or seeded before the field existed)
 * is reported as "not on this type" rather than counted as missing.
 */
export const TARGETS: Record<string, TargetSpec> = {
  'clip': { required: ['headline', 'description'], recommended: ['keywords', 'thumbnail'] },
  'episode': { required: ['title', 'series', 'episodeNumber', 'description'], recommended: ['season', 'genre', 'rating', 'image'] },
  'movie': { required: ['title', 'description', 'year'], recommended: ['genre', 'cast', 'director', 'rating', 'image'] },
  'song': { required: ['title', 'artist'], recommended: ['album', 'genre', 'released', 'artwork'] },
  'interview': { required: ['title', 'guests'], recommended: ['interviewer', 'topic', 'description', 'image'] },
  'sports-match': { required: ['name', 'sport', 'competition', 'homeTeam', 'awayTeam'], recommended: ['venue', 'round', 'description', 'image'] },
  'multi-sport-event': { required: ['name', 'sports'], recommended: ['edition', 'venues', 'description', 'image'] },
  'broadcast-event': { required: ['name', 'description'], recommended: ['category', 'organizer', 'location', 'image'] },
  'town-hall': { required: ['name'], recommended: ['speakers', 'agenda', 'host', 'description'] },
  'worship-service': { required: ['name'], recommended: ['congregation', 'officiant', 'description'] },
  'tv-channel': { required: ['name'], recommended: ['description', 'genre', 'logo'] },
  'radio-station': { required: ['name'], recommended: ['description', 'genre', 'logo'] },
};

/** A value counts as filled when it says something: not null, not "", not [], not {}. */
export function isFilled(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}

export interface TargetField extends SchemaField {
  required: boolean;
  /** 'target' (from the type's target list) or 'schema' (the schema marks it required, or a custom type) */
  why: 'target' | 'schema';
}

export interface Completeness {
  /** 0..100, rounded. null when the asset has no content type. */
  pct: number | null;
  filled: number;
  total: number;
  missingRequired: string[];
  missingRecommended: string[];
  /** Target keys the type does not define (the client's copy predates them). */
  notOnType: string[];
}

/** The target fields of a type, in the type's own field order. */
export function targetFields(fields: SchemaField[], standardKey: string | null | undefined): { fields: TargetField[]; notOnType: string[] } {
  const spec = standardKey ? TARGETS[standardKey] : undefined;
  const byKey = new Map(fields.map((f) => [f.key, f]));
  if (!spec) {
    return { fields: fields.map((f) => ({ ...f, required: !!f.required, why: 'schema' as const })), notOnType: [] };
  }
  const wanted = new Set([...spec.required, ...spec.recommended]);
  const out: TargetField[] = [];
  for (const f of fields) {
    if (wanted.has(f.key)) out.push({ ...f, required: spec.required.includes(f.key) || !!f.required, why: 'target' });
    else if (f.required) out.push({ ...f, required: true, why: 'schema' });
  }
  const notOnType = [...wanted].filter((k) => !byKey.has(k));
  return { fields: out, notOnType };
}

export function completeness(fields: SchemaField[] | null | undefined, standardKey: string | null | undefined,
  metadata: Record<string, any> | null | undefined): Completeness {
  if (!fields) return { pct: null, filled: 0, total: 0, missingRequired: [], missingRecommended: [], notOnType: [] };
  const { fields: tf, notOnType } = targetFields(fields, standardKey);
  const m = metadata ?? {};
  const filled = tf.filter((f) => isFilled(m[f.key]));
  return {
    pct: tf.length ? Math.round((100 * filled.length) / tf.length) : 100,
    filled: filled.length,
    total: tf.length,
    missingRequired: tf.filter((f) => f.required && !isFilled(m[f.key])).map((f) => f.key),
    missingRecommended: tf.filter((f) => !f.required && !isFilled(m[f.key])).map((f) => f.key),
    notOnType,
  };
}

// ---------------------------------------------------------------------------
//  The same rules in SQL, for the list. `fields` is the jsonb array of the
//  type's EFFECTIVE fields (child plus parent: see VOD list joins), `std` the
//  standard_key expression and `meta` the asset's metadata expression.
// ---------------------------------------------------------------------------
const sqlArr = (a: string[]) => `ARRAY[${a.map((k) => `'${k.replace(/'/g, "''")}'`).join(',')}]::text[]`;

function targetCase(std: string, part: 'required' | 'all'): string {
  const whens = Object.entries(TARGETS).map(([k, t]) =>
    `WHEN '${k}' THEN ${sqlArr(part === 'required' ? t.required : [...t.required, ...t.recommended])}`).join(' ');
  return `(CASE ${std} ${whens} ELSE NULL END)`;
}

const FILLED = (meta: string, key: string) =>
  `(${meta} -> ${key} IS NOT NULL AND jsonb_typeof(${meta} -> ${key}) <> 'null'
     AND ${meta} -> ${key} NOT IN ('""'::jsonb, '[]'::jsonb, '{}'::jsonb)
     AND btrim(COALESCE(${meta} ->> ${key}, 'x')) <> '')`;

/** Required target keys still empty: count. NULL type counts as missing (the type is itself target metadata). */
export function missingRequiredCountSql(fields: string, std: string, meta: string): string {
  return `(CASE WHEN ${fields} IS NULL THEN 1 ELSE (
    SELECT count(DISTINCT f->>'key')::int FROM jsonb_array_elements(${fields}) f
     WHERE (COALESCE((f->>'required')::boolean, false) OR (f->>'key') = ANY(COALESCE(${targetCase(std, 'required')}, ARRAY[]::text[])))
       AND NOT ${FILLED(meta, "(f->>'key')")}
  ) END)`;
}

/** Completeness 0..100 (NULL with no type), matching completeness() above. */
export function completenessPctSql(fields: string, std: string, meta: string): string {
  const inTarget = `(CASE WHEN ${targetCase(std, 'all')} IS NULL THEN true
       ELSE (f->>'key') = ANY(${targetCase(std, 'all')}) OR COALESCE((f->>'required')::boolean, false) END)`;
  return `(CASE WHEN ${fields} IS NULL THEN NULL ELSE (
    SELECT CASE WHEN count(DISTINCT f->>'key') = 0 THEN 100
                ELSE round(100.0 * count(DISTINCT f->>'key') FILTER (WHERE ${FILLED(meta, "(f->>'key')")})
                           / count(DISTINCT f->>'key'))::int END
      FROM jsonb_array_elements(${fields}) f WHERE ${inTarget}
  ) END)`;
}

/** Where an asset came from, as one filterable value. */
export const ORIGIN_SQL = `(CASE WHEN v.kind = 'clip' THEN 'clip'
  WHEN v.source_kind = 'upload' THEN 'upload'
  WHEN v.source_kind = 'watchfolder' THEN 'watchfolder'
  ELSE 'recording' END)`;
export const ORIGINS = ['recording', 'clip', 'upload', 'watchfolder'] as const;

// ============================================================================
//  ENCODE DETAILS.
//
//  What is stored today, and where each value comes from:
//    - an uploaded or watch-folder asset: vod_assets.encode_result (the rungs
//      kept and dropped, segment length, frame rate, the source probe, the
//      ladder group) and formats (hls/dash/progressive). The ladder group row
//      gives the packaging and codec backend.
//    - a recording-derived asset: the live output profile of its channel or
//      event's group (rungs, packaging, workflow, codec backend, segment
//      length, DRM, captions), because the clip is cut from those renditions.
//  Values the encoder sets by contract but nothing records (audio is AAC
//  128 kb/s stereo 48 kHz per source track, video is H.264 from libx264 or
//  NVENC, segments are fMP4/CMAF) are marked `derived`, and anything nobody
//  knows is marked `unknown` and listed in `gaps`, so the screen never
//  presents a guess as a fact.
// ============================================================================
export type Prov = 'stored' | 'derived' | 'unknown';
export interface Fact<T> { value: T | null; source: Prov }

export interface EncodeRendition {
  height: number; width: number | null; bitrateKbps: number | null; codec: string; profile: string | null; fps: number | null;
}
export interface EncodeDetails {
  workflow: Fact<'transcode' | 'package_only'>;
  ladder: Fact<string>;
  renditions: { value: EncodeRendition[]; source: Prov };
  dropped: { height: number; why: string }[];
  audio: { value: { codec: string; channels: number | null; bitrateKbps: number | null; sampleRate: number | null; language: string | null }[]; source: Prov };
  captions: { value: { language: string; kind: 'captions' | 'subtitles'; source: string }[]; source: Prov };
  segmentSeconds: Fact<number>;
  packaging: { value: string[]; source: Prov };
  container: Fact<string>;
  drm: { value: string[]; source: Prov };
  source: { width: number | null; height: number | null; fps: number | null; durationMs: number | null; hasAudio: boolean | null; bytes: number | null; filename: string | null; mime: string | null; origin: string };
  summary: { topHeight: number | null; codec: string | null; renditions: number; label: string };
  gaps: string[];
}

export interface EncodeContext {
  /** The ladder group the file was encoded with (encode_ladder_groups row). */
  ladderGroup?: { name?: string | null; packaging?: string | null; codec_backend?: string | null; segment_dur?: number | string | null } | null;
  /** The live output profile of the source stream's group (recording-derived assets). */
  outputProfile?: {
    name?: string | null; rungs?: any[]; packaging?: string | null; workflow_type?: string | null; codec_backend?: string | null;
    segment_dur?: number | string | null; drm_enabled?: boolean | null; drm_systems?: string[] | null;
    captions_enabled?: boolean | null; caption_source_lang?: string | null; caption_targets?: string[] | null;
  } | null;
}

const num = (v: unknown): number | null => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? null : n; };
export const codecLabel = (c: string | null | undefined): string | null => {
  if (!c) return null;
  const k = String(c).toLowerCase();
  if (k === 'x264' || k === 'nvenc' || k === 'h264' || k === 'avc' || k === 'avc1') return 'H.264';
  if (k === 'x265' || k === 'hevc' || k === 'h265' || k === 'hvc1') return 'HEVC';
  if (k === 'av1') return 'AV1';
  return String(c).toUpperCase();
};
const packList = (p: string | null | undefined): string[] => p === 'both' ? ['HLS', 'DASH'] : p ? [p.toUpperCase()] : [];
export const resLabel = (h: number | null | undefined): string => !h ? '' : h >= 2160 ? '2160p' : `${h}p`;
const widthFor = (h: number) => Math.round((h * 16) / 9 / 2) * 2;

export function encodeDetails(a: Record<string, any>, ctx: EncodeContext = {}): EncodeDetails {
  const er = (a.encode_result && typeof a.encode_result === 'object') ? a.encode_result : null;
  const prof = ctx.outputProfile ?? null;
  const lg = ctx.ladderGroup ?? null;
  const fromFile = a.source_kind === 'upload' || a.source_kind === 'watchfolder';
  const gaps: string[] = [];

  // ---- renditions
  let renditions: EncodeRendition[] = [];
  let rendSource: Prov = 'unknown';
  const backend = er?.codecBackend ?? lg?.codec_backend ?? prof?.codec_backend ?? null;
  const codecDefault = codecLabel(er?.codec ?? backend) ?? (fromFile || prof?.workflow_type !== 'package_only' ? 'H.264' : null);
  if (er?.kept?.length) {
    rendSource = 'stored';
    renditions = er.kept.map((r: any) => ({
      height: Number(r.height), width: num(r.width) ?? widthFor(Number(r.height)), bitrateKbps: num(r.bitrate_kbps),
      codec: codecLabel(r.codec) ?? codecDefault ?? 'H.264', profile: r.profile ?? null, fps: num(r.fps) ?? num(er.fps),
    }));
  } else if (prof?.rungs?.length) {
    rendSource = 'stored';
    renditions = prof.rungs.map((r: any) => ({
      height: Number(r.height), width: num(r.width) ?? widthFor(Number(r.height)), bitrateKbps: num(r.bitrate_kbps),
      codec: codecLabel(r.codec) ?? codecDefault ?? 'unknown', profile: r.profile ?? null, fps: num(r.fps),
    }));
  } else {
    gaps.push('Renditions: no encode result and no live output profile to read them from.');
  }
  renditions.sort((x, y) => y.height - x.height || (y.bitrateKbps ?? 0) - (x.bitrateKbps ?? 0));
  if (renditions.length && renditions.every((r) => !r.profile)) gaps.push('Video profile (High, Main) is not recorded; libx264 and NVENC use High by default.');

  // ---- workflow
  const workflow: Fact<'transcode' | 'package_only'> = er ? { value: 'transcode', source: 'stored' }
    : prof?.workflow_type ? { value: prof.workflow_type as any, source: 'stored' } : { value: null, source: 'unknown' };

  // ---- audio
  const hasAudio = er?.probe?.hasAudio ?? (a.audioOnly ? true : null);
  const audioFromEncoder = workflow.value === 'transcode';
  const audio = hasAudio === false
    ? { value: [], source: 'stored' as Prov }
    : audioFromEncoder
      ? { value: [{ codec: 'AAC', channels: 2, bitrateKbps: 128, sampleRate: 48000, language: prof?.caption_source_lang && prof.caption_source_lang !== 'auto' ? prof.caption_source_lang : null }], source: 'derived' as Prov }
      : { value: [], source: 'unknown' as Prov };
  if (audio.source === 'derived') gaps.push('Audio tracks are not recorded per asset; shown from the encoder contract (AAC 128 kb/s, stereo, 48 kHz per source track). Languages are not recorded.');
  if (audio.source === 'unknown' && hasAudio !== false) gaps.push('Audio tracks: a package-only source passes audio through and nothing records its codec or channels.');

  // ---- captions
  const caps: { language: string; kind: 'captions' | 'subtitles'; source: string }[] = [];
  let capSource: Prov = 'unknown';
  if (prof && prof.captions_enabled != null) {
    capSource = 'stored';
    if (prof.captions_enabled) {
      caps.push({ language: prof.caption_source_lang || 'auto', kind: 'captions', source: 'live transcription' });
      for (const t of prof.caption_targets ?? []) caps.push({ language: t, kind: 'subtitles', source: 'translation' });
    }
  } else if (fromFile) {
    gaps.push('Caption and subtitle tracks are not recorded for file encodes.');
  }

  // ---- packaging, segments, DRM
  const fmts = (a.formats && typeof a.formats === 'object') ? a.formats : null;
  let packaging: { value: string[]; source: Prov } = { value: [], source: 'unknown' };
  if (fmts) packaging = { value: [fmts.hls ? 'HLS' : '', fmts.dash ? 'DASH' : '', fmts.progressive ? 'MP4' : ''].filter(Boolean), source: 'stored' };
  else if (lg?.packaging || prof?.packaging) packaging = { value: packList(lg?.packaging ?? prof?.packaging), source: 'stored' };
  else if (a.master_key) packaging = { value: ['HLS'], source: 'derived' };
  if (!fmts && a.progressive_key && !packaging.value.includes('MP4')) packaging.value.push('MP4');
  const seg = num(er?.segmentSeconds) ?? num(lg?.segment_dur) ?? num(prof?.segment_dur);
  const segmentSeconds: Fact<number> = seg != null ? { value: seg, source: 'stored' } : { value: null, source: 'unknown' };
  const drm = prof && prof.drm_enabled != null
    ? { value: prof.drm_enabled ? (prof.drm_systems?.length ? prof.drm_systems.map((s) => s[0].toUpperCase() + s.slice(1)) : ['Widevine', 'PlayReady', 'FairPlay']) : [], source: 'stored' as Prov }
    : fromFile ? { value: [] as string[], source: 'derived' as Prov } : { value: [] as string[], source: 'unknown' as Prov };
  if (fromFile) gaps.push('DRM is not applied to file encodes today; they are packaged in the clear.');

  const top = renditions[0] ?? null;
  const topHeight = top?.height ?? num(a.top_height);
  const codec = top?.codec ?? codecLabel(a.video_codec);
  return {
    workflow,
    ladder: er?.ladder?.name ? { value: er.ladder.name, source: 'stored' } : lg?.name ? { value: lg.name, source: 'stored' }
      : prof?.name ? { value: `${prof.name} (live output profile)`, source: 'stored' } : { value: null, source: 'unknown' },
    renditions: { value: renditions, source: rendSource },
    dropped: (er?.dropped ?? []).map((d: any) => ({ height: Number(d.height), why: d.why === 'above_source_height' ? 'above the source height' : d.why === 'duplicate_height' ? 'duplicate height' : String(d.why ?? '') })),
    audio,
    captions: { value: caps, source: capSource },
    segmentSeconds,
    packaging,
    container: fromFile || er ? { value: 'fMP4 (CMAF)', source: 'derived' } : prof ? { value: 'fMP4 (CMAF)', source: 'derived' } : { value: null, source: 'unknown' },
    drm,
    source: {
      width: num(er?.probe?.width), height: num(er?.probe?.height), fps: num(er?.probe?.fps), durationMs: num(er?.probe?.durationMs) ?? num(a.duration_ms),
      hasAudio: hasAudio ?? null, bytes: num(a.source_bytes), filename: a.original_filename ?? null, mime: a.mime ?? null,
      origin: fromFile ? (a.source_kind === 'watchfolder' ? 'Watch folder file' : 'Uploaded file') : 'Live recording (the channel or event renditions)',
    },
    summary: { topHeight: topHeight ?? null, codec: codec ?? null, renditions: renditions.length, label: [resLabel(topHeight), codec, renditions.length ? `${renditions.length} rendition${renditions.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') },
    gaps,
  };
}
