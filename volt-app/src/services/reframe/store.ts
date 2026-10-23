// ============================================================================
//  REFRAME STORE: settings, the analysis row, the format rows, and where the
//  files live. The analysis and the render themselves are in
//  services/jobs/handlers/reframe.ts; the pure parts in framing.ts and render.ts.
//
//  Files sit beside the asset's other media, under clips/vod/<id>/reframe/:
//    tracks.json   the track store (the sidecar every format reads)
//    9x16.mp4 ...  one rendered file per format
// ============================================================================
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { one, query } from '../../db';
import { config } from '../../config';
import { resolveSettings, type FormatKey, type ReframeSettings } from './formats';
import type { FramingPath, Overrides, TrackStore } from './framing';

export const reframeDir = (assetId: string) => join(config.clips.dir, 'vod', assetId, 'reframe');
export const reframeKey = (assetId: string, name: string) => `/clips/vod/${assetId}/reframe/${name}`;

/** A /clips/... key to the file on this box (null when it is not here). */
export function localPath(key: string | null | undefined): string | null {
  if (!key) return null;
  if (key.startsWith('/clips/')) { const p = join(config.clips.dir, key.slice('/clips/'.length)); return existsSync(p) ? p : null; }
  if (key.startsWith('/') && existsSync(key)) return key;
  return null;
}

/**
 * The best local picture source for an asset: the original upload when it is
 * kept, then the progressive MP4, an MP4 export, and last the HLS master
 * (ffmpeg reads a local playlist and its segments).
 */
export function videoSourceFor(a: any): string | null {
  try {
    const src = join(config.clips.dir, 'vod-src');
    const f = existsSync(src) ? readdirSync(src).find((n) => n.startsWith(String(a.id))) : undefined;
    if (f) return join(src, f);
  } catch { /* no originals kept */ }
  for (const k of [a.progressive_key, a.export_mp4_key, a.master_key]) { const p = localPath(k); if (p) return p; }
  return null;
}

/** An asset that is sound only has nothing to frame. Same test as the library's. */
export function isAudioOnlyAsset(a: any): boolean {
  return !!(a.export_mp3_key || a.export_m4a_key) && a.top_height == null && !a.progressive_key;
}

const OWNED = `FROM vod_assets v LEFT JOIN channels c ON c.id = v.channel_id LEFT JOIN events e ON e.id = v.event_id
               LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)`;

export async function assetWithAccount(assetId: string): Promise<any | null> {
  return one<any>(`SELECT v.*, COALESCE(g.account_id, v.account_id) AS owner_account ${OWNED} WHERE v.id = $1`, [assetId]);
}

export async function ownedAsset(assetId: string, accountId: string): Promise<any | null> {
  return one<any>(`SELECT v.*, COALESCE(g.account_id, v.account_id) AS owner_account ${OWNED}
                    WHERE v.id = $1 AND COALESCE(g.account_id, v.account_id) = $2`, [assetId, accountId]);
}

// ---------------------------------------------------------------- settings
export async function settingsFor(accountId: string | null | undefined): Promise<ReframeSettings> {
  if (!accountId) return resolveSettings({});
  const r = await one<{ settings: unknown }>(`SELECT settings FROM reframe_settings WHERE account_id = $1`, [accountId]).catch(() => null);
  return resolveSettings(r?.settings ?? {});
}

export async function saveSettings(accountId: string, s: ReframeSettings, by: string | null): Promise<void> {
  await query(`INSERT INTO reframe_settings(account_id, settings, updated_at, updated_by) VALUES ($1, $2::jsonb, now(), $3)
               ON CONFLICT (account_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [accountId, JSON.stringify(s), by]);
}

// ---------------------------------------------------------------- analysis
export interface TracksRow {
  vod_asset_id: string; state: 'queued' | 'running' | 'ready' | 'failed'; tracks_key: string | null;
  summary: any; error: string | null; job_id: string | null; analysed_at: string | null; updated_at: string;
}

export async function tracksRow(assetId: string): Promise<TracksRow | null> {
  return one<TracksRow>(`SELECT * FROM vod_tracks WHERE vod_asset_id = $1`, [assetId]);
}

export async function setTracksState(assetId: string, state: TracksRow['state'], extra: { error?: string | null; jobId?: string | null } = {}): Promise<void> {
  await query(`INSERT INTO vod_tracks(vod_asset_id, state, error, job_id, updated_at) VALUES ($1, $2, $3, $4, now())
               ON CONFLICT (vod_asset_id) DO UPDATE SET state = EXCLUDED.state, error = EXCLUDED.error,
                 job_id = COALESCE(EXCLUDED.job_id, vod_tracks.job_id), updated_at = now()`,
    [assetId, state, extra.error ?? null, extra.jobId ?? null]);
}

export async function saveTracks(assetId: string, key: string, summary: any): Promise<void> {
  await query(`INSERT INTO vod_tracks(vod_asset_id, state, tracks_key, summary, error, analysed_at, updated_at)
               VALUES ($1, 'ready', $2, $3::jsonb, NULL, now(), now())
               ON CONFLICT (vod_asset_id) DO UPDATE SET state = 'ready', tracks_key = EXCLUDED.tracks_key, summary = EXCLUDED.summary,
                 error = NULL, analysed_at = now(), updated_at = now()`, [assetId, key, JSON.stringify(summary)]);
}

/** The full track store, read from its sidecar. */
export function readTrackStore(row: TracksRow | null): TrackStore | null {
  const p = localPath(row?.tracks_key);
  if (!p) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

/** What the console lists: everything but the per-sample boxes. */
export function summarise(store: TrackStore): any {
  return { source: store.source, analysis: (store as any).analysis, shots: store.shots, subjects: store.subjects,
    trackCount: store.tracks.length };
}

// ---------------------------------------------------------------- formats
export interface FormatRow {
  vod_asset_id: string; format: FormatKey; path: FramingPath | Record<string, never>; overrides: Overrides; edited: boolean;
  review: 'pending' | 'approved'; approved_at: string | null; approved_by: string | null;
  render_state: 'none' | 'queued' | 'rendering' | 'ready' | 'failed' | 'stale'; output_key: string | null;
  width: number | null; height: number | null; bytes: string | null; render_seconds: string | null;
  render_error: string | null; rendered_at: string | null; updated_at: string;
}

export async function formatRows(assetId: string): Promise<FormatRow[]> {
  return query<FormatRow>(`SELECT * FROM vod_formats WHERE vod_asset_id = $1 ORDER BY array_position(ARRAY['9x16','1x1','4x5'], format)`, [assetId]);
}

export async function formatRow(assetId: string, format: FormatKey): Promise<FormatRow | null> {
  return one<FormatRow>(`SELECT * FROM vod_formats WHERE vod_asset_id = $1 AND format = $2`, [assetId, format]);
}

/**
 * Write a path. A change to the framing makes a rendered file stale and, when
 * approval is required, takes the approval away: what was approved is not what
 * would now be published.
 */
export async function writePath(assetId: string, format: FormatKey, path: FramingPath, o: {
  overrides?: Overrides; edited?: boolean; approve?: { by: string } | null; keepReview?: boolean;
}): Promise<FormatRow> {
  const prev = await formatRow(assetId, format);
  const changed = !prev || JSON.stringify(prev.path) !== JSON.stringify(path);
  const review = o.approve ? 'approved' : (!changed && prev ? prev.review : (o.keepReview && prev ? prev.review : 'pending'));
  const renderState = prev && changed && ['ready', 'failed'].includes(prev.render_state) ? 'stale' : (prev?.render_state ?? 'none');
  return (await one<FormatRow>(
    `INSERT INTO vod_formats(vod_asset_id, format, path, overrides, edited, review, approved_at, approved_by, render_state, updated_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9, now())
     ON CONFLICT (vod_asset_id, format) DO UPDATE SET path = EXCLUDED.path, overrides = EXCLUDED.overrides, edited = EXCLUDED.edited,
       review = EXCLUDED.review, approved_at = EXCLUDED.approved_at, approved_by = EXCLUDED.approved_by,
       render_state = EXCLUDED.render_state, updated_at = now()
     RETURNING *`,
    [assetId, format, JSON.stringify(path), JSON.stringify(o.overrides ?? prev?.overrides ?? {}), o.edited ?? prev?.edited ?? false,
     review, review === 'approved' ? (o.approve ? new Date() : prev?.approved_at ?? new Date()) : null,
     review === 'approved' ? (o.approve?.by ?? prev?.approved_by ?? null) : null, renderState]))!;
}

export async function setRender(assetId: string, format: FormatKey, state: FormatRow['render_state'], extra: {
  key?: string | null; width?: number; height?: number; bytes?: number; seconds?: number; error?: string | null;
} = {}): Promise<void> {
  await query(
    `UPDATE vod_formats SET render_state = $3, render_error = $4,
       output_key = CASE WHEN $3 = 'ready' THEN $5 ELSE output_key END,
       width = COALESCE($6, width), height = COALESCE($7, height), bytes = COALESCE($8, bytes),
       render_seconds = COALESCE($9, render_seconds), rendered_at = CASE WHEN $3 = 'ready' THEN now() ELSE rendered_at END,
       updated_at = now()
     WHERE vod_asset_id = $1 AND format = $2`,
    [assetId, format, state, extra.error ?? null, extra.key ?? null, extra.width ?? null, extra.height ?? null,
     extra.bytes ?? null, extra.seconds ?? null]);
}
