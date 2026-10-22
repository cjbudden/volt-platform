// ============================================================================
//  SETTINGS LOCK WHILE RUNNING.
//
//  Some channel settings are read by the encoder when it starts and never
//  again: the sources, the ladder, the DVR window, failover and filler, the
//  watermark, captions, the radio pipeline. Changing one while the encoder runs
//  used to save happily and then do nothing until the next restart, so the
//  form said one thing and the output did another, and the operator had no way
//  to tell which was true.
//
//  So while a channel has a live instance those fields are locked: the console
//  shows them read-only (still selectable, so a URL can be copied), and the API
//  refuses a CHANGE to any of them with 409 `locked_while_running`, naming the
//  fields. Sending the current value back is not a change and is allowed, so a
//  client that posts its whole form does not trip over fields it did not touch.
//
//  Everything else stays editable while running, because it takes effect
//  without a restart: name, content type and metadata, retention, geo (the
//  play gate reads it per request), the guide switch, brand image, auto connect.
//
//  "Running" is the same test the delete and failover routes use: an instance
//  row with no termination time.
// ============================================================================
import { one, query } from '../db';

/** Request-body keys that need a stopped encoder to change, with their labels. */
export const LOCKED_WHILE_RUNNING: Record<string, string> = {
  sources: 'Sources',
  outputLadder: 'Output ladder',
  dvrWindowSec: 'DVR window',
  dvrMode: 'DVR mode',
  inputFailoverEnabled: 'Input failover',
  autoFailback: 'Auto failback',
  inputLossBehavior: 'On total source loss',
  fillerSlateRef: 'Fallback slate or loop',
  fillerAssetId: 'Fallback slate or loop',
  fallbackTranscode: 'Fallback transcode',
  watermark: 'Watermark',
  captions: 'Subtitles',
  radio: 'Radio pipeline',
};

/** Body key -> the channel columns it writes (for comparing with what is stored). */
const COLUMNS: Record<string, string[]> = {
  outputLadder: ['output_ladder'],
  dvrWindowSec: ['dvr_window_sec'],
  dvrMode: ['dvr_mode'],
  inputFailoverEnabled: ['input_failover_enabled'],
  autoFailback: ['auto_failback'],
  inputLossBehavior: ['input_loss_behavior'],
  fillerSlateRef: ['filler_slate_ref'],
  fillerAssetId: ['filler_asset_id'],
  fallbackTranscode: ['fallback_transcode'],
  watermark: ['watermark_enabled', 'watermark_ref', 'watermark_position', 'watermark_offset_x',
    'watermark_offset_y', 'watermark_opacity', 'watermark_scale'],
  radio: ['radio_config'],
};

export async function encoderRunning(channelId: string, kind: 'channel' | 'event' = 'channel'): Promise<boolean> {
  const r = await one(`SELECT 1 FROM instances WHERE ${kind === 'event' ? 'event_id' : 'channel_id'} = $1 AND terminated_at IS NULL LIMIT 1`, [channelId]);
  return !!r;
}

/** Stable JSON: object keys sorted, so key order never reads as a change. */
export function canon(v: unknown): string {
  const norm = (x: any): any => {
    if (x === undefined) return null;
    if (x instanceof Date) return x.toISOString();
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') {
      const o: any = {};
      for (const k of Object.keys(x).sort()) if (x[k] !== undefined) o[k] = norm(x[k]);
      return o;
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

interface SourceLike {
  role?: string | null; protocol?: string | null; ingestUrl?: string | null; ingest_url?: string | null;
  streamKey?: string | null; stream_key?: string | null; renditionLabel?: string | null; rendition_label?: string | null;
  renditionBitrateKbps?: number | null; rendition_bitrate_kbps?: number | null;
}
/** Sources as a comparable set: order-free, empty and missing treated the same. */
export function sourcesKey(rows: SourceLike[]): string {
  const blank = (s: any) => (s == null || s === '' ? null : s);
  return canon(rows.map((s) => ({
    role: s.role ?? 'primary',
    protocol: String(s.protocol ?? '').toLowerCase(),
    url: blank(s.ingestUrl ?? s.ingest_url),
    key: blank(s.streamKey ?? s.stream_key),
    label: blank(s.renditionLabel ?? s.rendition_label),
    kbps: s.renditionBitrateKbps ?? s.rendition_bitrate_kbps ?? null,
  })).map((x) => canon(x)).sort());
}

/**
 * Which locked settings this edit would actually change. `patch` is the column
 * patch the route built; `body` the parsed request. Returns labels, de-duplicated.
 */
export async function lockedChanges(
  channelId: string, current: Record<string, any>, patch: Record<string, any>,
  body: Record<string, any>, has: (k: string) => boolean,
): Promise<string[]> {
  const out = new Set<string>();
  for (const [key, cols] of Object.entries(COLUMNS)) {
    if (!has(key)) continue;
    for (const c of cols) {
      if (!(c in patch)) continue;
      if (canon(patch[c] ?? null) !== canon(current[c] ?? null)) { out.add(LOCKED_WHILE_RUNNING[key]); break; }
    }
  }
  if (has('sources') && Array.isArray(body.sources)) {
    const stored = await query<any>(
      `SELECT role, protocol, ingest_url, stream_key, rendition_label, rendition_bitrate_kbps FROM stream_inputs WHERE channel_id = $1`,
      [channelId]);
    if (sourcesKey(body.sources) !== sourcesKey(stored)) out.add(LOCKED_WHILE_RUNNING.sources);
  }
  if (has('captions') && body.captions) {
    const p = await one<any>(
      `SELECT op.captions_enabled, op.caption_source_lang, op.caption_targets, op.caption_offset_sec
         FROM channels ch JOIN groups g ON g.id = ch.group_id JOIN output_profiles op ON op.id = g.output_profile_id
        WHERE ch.id = $1`, [channelId]);
    if (p) {
      const c = body.captions;
      const diff =
        (c.enabled !== undefined && !!c.enabled !== !!p.captions_enabled) ||
        (c.sourceLang !== undefined && c.sourceLang !== p.caption_source_lang) ||
        (c.targets !== undefined && canon([...c.targets].sort()) !== canon([...(p.caption_targets ?? [])].sort())) ||
        (c.offsetSec !== undefined && Number(c.offsetSec) !== Number(p.caption_offset_sec ?? 0));
      if (diff) out.add(LOCKED_WHILE_RUNNING.captions);
    }
  }
  return [...out];
}
