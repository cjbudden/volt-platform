// ============================================================================
//  SKIP MARKERS ON ON-DEMAND ASSETS: intro, recap and credits.
//
//  WHERE THEY COME FROM
//    Detection (job `vod.markers`) compares the asset with other episodes of
//    the same series (services/introDetect.ts): the stretch they share near the
//    start is the intro, near the end the credits. It runs after every build,
//    and a new episode also refreshes its peers' automatic markers, so the
//    first episode of a series gets its intro when the second one arrives.
//    A person can set, move, accept or remove any marker at any time. A marker
//    a person touched is `manual` and detection never changes it again.
//
//  WHERE THEY GO
//    Into the asset's own on-demand playlists, ANNOTATED WHEN A PLAYER ASKS for
//    them (annotateHls / annotateMpd, wired in server.ts ahead of the /clips
//    files): HLS gets EXT-X-DATERANGE (CLASS com.boomlabs.volt.skip) plus the
//    PROGRAM-DATE-TIME a DATERANGE needs, DASH an EventStream. Nothing is
//    rebuilt, so an edit reaches viewers on their next playlist fetch. The
//    segments keep their long cache; only the small playlists are short-lived.
//    Live and FAST manifests never carry them: Skip is for on-demand playback.
//
//  SERIES
//    Episodes are grouped by the series in their metadata (the `episode`
//    content type's `series`), else the guide programme they were recorded
//    from (its title on its channel), else their own title with episode
//    numbers and dates taken off.
// ============================================================================
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { query, one } from '../db';
import { config } from '../config';
import { detectAcross, fingerprint, type DetectOptions } from './introDetect';

export type MarkerKind = 'intro' | 'recap' | 'credits';
export const MARKER_KINDS: MarkerKind[] = ['intro', 'recap', 'credits'];

export interface VodMarker {
  kind: MarkerKind;
  startMs: number;
  endMs: number;
  source: 'auto' | 'manual';
  status: 'active' | 'suggested';
  confidence: number | null;
  detail: any;
  updatedAt: string;
}

const row2 = (r: any): VodMarker => ({
  kind: r.kind, startMs: r.start_ms, endMs: r.end_ms, source: r.source, status: r.status,
  confidence: r.confidence == null ? null : Number(r.confidence), detail: r.detail ?? {}, updatedAt: new Date(r.updated_at).toISOString(),
});

/** Every marker on an asset, cached and dropped on any edit (migration 0062's trigger). */
export async function listMarkers(assetId: string): Promise<VodMarker[]> {
  const { cached } = await import('../scale/cache');
  return cached(`vodmk:${assetId}`, { ttlSec: 300, tags: [`asset:${assetId}`] }, async () =>
    (await query<any>(`SELECT * FROM vod_markers WHERE vod_asset_id = $1 ORDER BY start_ms`, [assetId])).map(row2));
}

/** Set (or move) a marker by hand. It becomes manual and active. */
export async function setMarker(assetId: string, kind: MarkerKind, startMs: number, endMs: number, userId: string | null): Promise<VodMarker> {
  const a = await one<any>(`SELECT duration_ms FROM vod_assets WHERE id = $1`, [assetId]);
  if (!a) throw Object.assign(new Error('asset not found'), { status: 404 });
  const dur = Number(a.duration_ms) || 0;
  const s = Math.max(0, Math.round(startMs));
  const e = Math.round(dur > 0 ? Math.min(endMs, dur) : endMs);
  if (!(e > s)) throw Object.assign(new Error('the end must be after the start'), { status: 400 });
  if (e - s < 1000) throw Object.assign(new Error('a marker is at least one second long'), { status: 400 });
  const r = await one<any>(
    `INSERT INTO vod_markers (vod_asset_id, kind, start_ms, end_ms, source, status, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, 'manual', 'active', $5, now())
     ON CONFLICT (vod_asset_id, kind) DO UPDATE
       SET start_ms = EXCLUDED.start_ms, end_ms = EXCLUDED.end_ms, source = 'manual', status = 'active',
           updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING *`, [assetId, kind, s, e, userId]);
  return row2(r);
}

/** Accept a suggested marker as it is: it goes into the outputs and is now the person's. */
export async function acceptMarker(assetId: string, kind: MarkerKind, userId: string | null): Promise<VodMarker | null> {
  const r = await one<any>(
    `UPDATE vod_markers SET status = 'active', source = 'manual', updated_by = $3, updated_at = now()
      WHERE vod_asset_id = $1 AND kind = $2 RETURNING *`, [assetId, kind, userId]);
  return r ? row2(r) : null;
}

export async function deleteMarker(assetId: string, kind: MarkerKind): Promise<boolean> {
  const r = await query<any>(`DELETE FROM vod_markers WHERE vod_asset_id = $1 AND kind = $2 RETURNING id`, [assetId, kind]);
  return r.length > 0;
}

// ------------------------------------------------------------------ series
const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** A title without its episode part: "Show S02E05", "Show - Ep 12", "Show 20 Oct 2026". */
export function seriesTitle(title: string): string {
  return norm(title
    .replace(/\b(s\d{1,2}\s*e\d{1,3}|season\s*\d+|series\s*\d+|ep(isode)?\.?\s*\d+|part\s*\d+|edisi\s+\d{1,2}[:.]\d{2})\b/gi, ' ')
    .replace(/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(\s+\d{4})?\b/gi, ' ')
    .replace(/[#(\[].*$/, ' ')
    .replace(/\s+\d+\s*$/, ' '));
}

/** Which series an asset belongs to, or null when nothing says. */
export async function groupFor(a: any): Promise<string | null> {
  const md = a.metadata ?? {};
  const series = md.series ?? md.partOfSeries ?? md.series_title ?? md.seriesTitle;
  if (typeof series === 'string' && norm(series)) return `series:${norm(series)}`;
  const p = await one<any>(`SELECT title, channel_id, event_id FROM programmes WHERE clip_asset_id = $1 LIMIT 1`, [a.id]).catch(() => null);
  if (p?.title && seriesTitle(p.title)) return `prog:${p.channel_id ?? p.event_id ?? ''}:${seriesTitle(p.title)}`;
  if (a.title && seriesTitle(a.title)) return `title:${a.channel_id ?? a.event_id ?? ''}:${seriesTitle(a.title)}`;
  return null;
}

// ------------------------------------------------------------------ media
/** A local file ffmpeg can read the asset's audio from, smallest first. */
export function mediaPathFor(a: any): string | null {
  const dir = config.clips.dir;
  const local = (k?: string | null) => {
    if (!k || !k.startsWith('/clips/')) return null;
    const p = join(dir, k.slice('/clips/'.length));
    return existsSync(p) ? p : null;
  };
  for (const k of [a.export_m4a_key, a.export_mp3_key, a.progressive_key, a.export_mp4_key]) { const p = local(k); if (p) return p; }
  // an upload's original, kept beside the encode
  try {
    const src = join(dir, 'vod-src');
    const f = existsSync(src) ? readdirSync(src).find((n) => n.startsWith(String(a.id))) : undefined;
    if (f) return join(src, f);
  } catch { /* no originals kept */ }
  return local(a.master_key);
}

// ------------------------------------------------------------------ detection
export const INTRO: DetectOptions & { windowSec: number } = { minSec: 10, maxSec: 150, windowSec: 600 };
export const CREDITS: DetectOptions & { windowSec: number } = { minSec: 15, maxSec: 420, windowSec: 420 };
/** Confidence at or above this goes straight into the outputs; below, it waits as a suggestion. */
export const ACTIVE_AT = 0.5;
const MAX_PEERS = 4;

export interface DetectReport { assetId: string; group: string | null; peers: string[]; note: string; written: Array<{ assetId: string; kind: MarkerKind; startMs: number; endMs: number; status: string; confidence: number }> }

/**
 * Detect the intro and credits of an asset against its series, and refresh its
 * peers' automatic markers with the new evidence. Manual markers are never
 * changed. Safe to run again: the same audio gives the same answer.
 */
export async function detectMarkers(assetId: string, deps: { fp?: typeof fingerprint } = {}): Promise<DetectReport> {
  const fp = deps.fp ?? fingerprint;
  const a = await one<any>(`SELECT * FROM vod_assets WHERE id = $1`, [assetId]);
  if (!a) throw Object.assign(new Error('asset not found'), { status: 404 });
  const report: DetectReport = { assetId, group: null, peers: [], note: '', written: [] };
  const finish = async (note: string) => {
    report.note = note;
    await query(`UPDATE vod_assets SET marker_group = $2, markers_detected_at = now(), markers_note = $3 WHERE id = $1`, [assetId, report.group, note]);
    return report;
  };
  const group = await groupFor(a);
  report.group = group;
  if (!group) return finish('Not part of a series, so there is nothing to compare it with. Set the markers by hand.');
  const self = mediaPathFor(a);
  if (!self) return finish('The media is not available on this server yet.');

  // Episodes that have never been through detection (built before this existed,
  // or still queued) have no group yet: work theirs out now, for the recent ones
  // that could be in this series (same channel or event, or any with a series).
  const ungrouped = await query<any>(
    `SELECT * FROM vod_assets
      WHERE id <> $1 AND marker_group IS NULL AND COALESCE(account_id::text, '') = COALESCE($2::text, '')
        AND (channel_id IS NOT DISTINCT FROM $3 AND event_id IS NOT DISTINCT FROM $4 OR metadata ? 'series')
      ORDER BY created_at DESC LIMIT 50`, [assetId, a.account_id ?? null, a.channel_id ?? null, a.event_id ?? null]);
  for (const u of ungrouped) {
    const g = await groupFor(u);
    if (g) await query(`UPDATE vod_assets SET marker_group = $2 WHERE id = $1 AND marker_group IS NULL`, [u.id, g]);
  }

  const peers = await query<any>(
    `SELECT * FROM vod_assets
      WHERE id <> $1 AND marker_group = $2 AND COALESCE(account_id::text, '') = COALESCE($3::text, '')
      ORDER BY created_at DESC LIMIT 12`, [assetId, group, a.account_id ?? null]);
  const usable = peers.map((p) => ({ row: p, path: mediaPathFor(p) })).filter((p) => p.path).slice(0, MAX_PEERS);
  report.peers = usable.map((p) => p.row.id);
  if (!usable.length) {
    return finish('No other episode of this series yet. Markers are found when the next episode arrives.');
  }

  const all = [{ row: a, path: self }, ...usable];
  let fpError = '';
  const durSec = (r: any) => Math.max(0, Number(r.duration_ms) || 0) / 1000;
  for (const [kind, o] of [['intro', INTRO], ['credits', CREDITS]] as const) {
    const eps: Array<{ id: string; fp: Uint32Array; offsetSec: number }> = [];
    for (const e of all) {
      const d = durSec(e.row);
      // intro: the opening minutes (at most half); credits: the closing minutes (at most 40%)
      const win = kind === 'intro' ? Math.min(o.windowSec, d > 0 ? d * 0.5 : o.windowSec) : Math.min(o.windowSec, d > 0 ? d * 0.4 : o.windowSec);
      const from = kind === 'intro' ? 0 : Math.max(0, d - win);
      if (kind === 'credits' && d <= 0) continue;
      try { eps.push({ id: e.row.id, fp: await fp(e.path!, from, win), offsetSec: from }); } catch (err: any) { fpError ||= String(err?.message ?? err); /* unreadable: leave it out */ }
    }
    if (eps.length < 2 || !eps.some((x) => x.id === assetId)) continue;
    const res = detectAcross(eps, { ...o, peers: MAX_PEERS });
    for (const r of res) {
      if (!r.interval) continue;
      // The asset being detected always gets its answer; a peer only when this is news for it.
      const isSelf = r.id === assetId;
      const startMs = Math.round(r.interval.start * 1000), endMs = Math.round(r.interval.end * 1000);
      const status = r.confidence >= ACTIVE_AT ? 'active' : 'suggested';
      const detail = { comparedWith: r.comparedWith, agreed: r.agreed, group, peers: eps.map((x) => x.id).filter((x) => x !== r.id), at: new Date().toISOString() };
      const w = await one<any>(
        `INSERT INTO vod_markers (vod_asset_id, kind, start_ms, end_ms, source, status, confidence, detail)
         VALUES ($1, $2, $3, $4, 'auto', $5, $6, $7)
         ON CONFLICT (vod_asset_id, kind) DO UPDATE
           SET start_ms = EXCLUDED.start_ms, end_ms = EXCLUDED.end_ms, status = EXCLUDED.status,
               confidence = EXCLUDED.confidence, detail = EXCLUDED.detail, updated_at = now()
           WHERE vod_markers.source = 'auto'
             AND ($8 OR vod_markers.confidence IS NULL OR EXCLUDED.confidence >= vod_markers.confidence)
         RETURNING *`,
        [r.id, kind, startMs, endMs, status, r.confidence, detail, isSelf]);
      if (w) report.written.push({ assetId: r.id, kind, startMs, endMs, status, confidence: r.confidence });
    }
  }
  const mine = report.written.filter((w) => w.assetId === assetId);
  // Nothing could be fingerprinted at all: say why, rather than "nothing found".
  // The usual cause is an ffmpeg built without Chromaprint (the images have it).
  if (!mine.length && fpError) return finish(`The audio could not be fingerprinted: ${fpError.slice(0, 200)}. This needs an ffmpeg built with Chromaprint.`);
  return finish(mine.length
    ? `Compared with ${usable.length} other episode${usable.length === 1 ? '' : 's'}: ${mine.map((m) => `${m.kind}${m.status === 'suggested' ? ' (suggested)' : ''}`).join(', ')} found.`
    : `Compared with ${usable.length} other episode${usable.length === 1 ? '' : 's'}: no shared intro or credits found.`);
}

// ------------------------------------------------------------------ outputs
export const SKIP_CLASS = 'com.boomlabs.volt.skip';
export const SKIP_SCHEME = 'urn:com:boomlabs:volt:skip:2026';
/** Media time 0 for an asset with no wall clock of its own. Any fixed instant works: only differences matter. */
export const VOD_EPOCH_MS = Date.UTC(2000, 0, 1);

const iso = (ms: number) => new Date(ms).toISOString();
const q = (v: string) => String(v).replace(/"/g, "'").replace(/[\r\n]/g, ' ');

/** The playlist anchor: the recording's real start when it has one, else the fixed epoch. */
export function anchorFor(a: { start_epoch_ms?: number | string | null }): number {
  const s = Number(a?.start_epoch_ms) || 0;
  return s > 0 ? s : VOD_EPOCH_MS;
}

/**
 * An on-demand MEDIA playlist with the active markers in it. Masters (no
 * #EXTINF) come back untouched. PROGRAM-DATE-TIME is added before the first
 * segment when the playlist has none (an on-demand build has no wall clock),
 * because a player can only place a DATERANGE against one.
 */
export function annotateHls(text: string, markers: VodMarker[], anchorMs: number, assetId: string): string {
  if (!/#EXTINF:/.test(text)) return text;
  const lines = text.split('\n').filter((l) => !(l.startsWith('#EXT-X-DATERANGE:') && l.includes(SKIP_CLASS)));
  let at = lines.findIndex((l) => l.startsWith('#EXTINF:'));
  if (at < 0) return text;
  const hasPdt = lines.some((l) => l.startsWith('#EXT-X-PROGRAM-DATE-TIME:'));
  const add: string[] = [];
  for (const m of markers) {
    if (m.status !== 'active') continue;
    const id = `skip-${m.kind}:${assetId}`;
    add.push(`#EXT-X-DATERANGE:ID="${q(id)}",CLASS="${SKIP_CLASS}",START-DATE="${iso(anchorMs + m.startMs)}",DURATION=${((m.endMs - m.startMs) / 1000).toFixed(3)},X-ID="${q(id)}",X-GRAPHIC="skip-${m.kind}",X-KIND="${m.kind}",X-TO="${(m.endMs / 1000).toFixed(3)}"`);
  }
  // header placement: before the first segment (and before a PDT already sitting there)
  while (at > 0 && lines[at - 1].startsWith('#EXT-X-PROGRAM-DATE-TIME:')) at--;
  const pdt = hasPdt || !add.length ? [] : [`#EXT-X-PROGRAM-DATE-TIME:${iso(anchorMs)}`];
  return [...lines.slice(0, at), ...add, ...pdt, ...lines.slice(at)].join('\n');
}

const xmlAttr = (v: string) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const durSec = (v: string | undefined) => {
  if (!v) return 0;
  const m = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(v);
  return m ? (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) : 0;
};

/** An on-demand MPD with an EventStream of the active markers in each Period they fall in. */
export function annotateMpd(mpd: string, markers: VodMarker[], assetId: string): string {
  const clean = mpd.replace(new RegExp(`<EventStream[^>]*schemeIdUri="${SKIP_SCHEME.replace(/[.:]/g, '\\$&')}"[^>]*>[\\s\\S]*?</EventStream>`, 'g'), '');
  const active = markers.filter((m) => m.status === 'active');
  if (!active.length) return clean;
  const periods = [...clean.matchAll(/<Period\b[^>]*>/g)];
  if (!periods.length) return clean;
  const starts = periods.map((p) => durSec(/\bstart="([^"]+)"/.exec(p[0])?.[1]) * 1000);
  let out = '', pos = 0;
  periods.forEach((p, i) => {
    const lo = starts[i], hi = i + 1 < starts.length ? starts[i + 1] : Infinity;
    const evs = active.filter((m) => m.endMs > lo && m.startMs < hi).map((m) => {
      const s = Math.max(m.startMs, lo), e = Math.min(m.endMs, hi);
      const data = JSON.stringify({ graphic: `skip-${m.kind}`, kind: m.kind, to: (m.endMs / 1000).toFixed(3), id: `skip-${m.kind}:${assetId}` });
      return `<Event id="${MARKER_KINDS.indexOf(m.kind) + 1}" presentationTime="${Math.round(s - lo)}" duration="${Math.round(e - s)}" messageData="${xmlAttr(data)}"/>`;
    });
    const end = (p.index ?? 0) + p[0].length;
    out += clean.slice(pos, end) + (evs.length ? `<EventStream schemeIdUri="${SKIP_SCHEME}" value="skip" timescale="1000">${evs.join('')}</EventStream>` : '');
    pos = end;
  });
  return out + clean.slice(pos);
}

/** The asset a /clips path belongs to: /clips/<id>/... or /clips/vod/<id>/... */
export function assetIdFromClipsPath(p: string): string | null {
  const m = /^\/(?:vod\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i.exec(p);
  return m ? m[1] : null;
}

/** What a playlist route needs about an asset, cached with its markers. */
export async function playlistContext(assetId: string): Promise<{ markers: VodMarker[]; anchorMs: number } | null> {
  const { cached } = await import('../scale/cache');
  const a = await cached(`vodanchor:${assetId}`, { ttlSec: 600, tags: [`asset:${assetId}`] }, async () =>
    one<any>(`SELECT start_epoch_ms FROM vod_assets WHERE id = $1`, [assetId]));
  if (!a) return null;
  return { markers: await listMarkers(assetId), anchorMs: anchorFor(a) };
}
