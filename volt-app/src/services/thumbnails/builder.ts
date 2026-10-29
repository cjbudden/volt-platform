// ============================================================================
//  THUMBNAIL BUILDER: library stills, sprite sheets and an hourly WebVTT for
//  every stream that has video, built from the encoder's own segments.
//
//  The stills go to the Image Library (people pick them as posters). The sheets
//  and the VTT do not: they are system files, kept in the sprite store with a
//  sprite_sheets row each (spriteStore.ts).
//
//  WHY FROM SEGMENTS. Our encoder cuts a closed GOP exactly one segment long,
//  so every segment opens on a keyframe that decodes alone: a frame is one
//  small read and one picture decode, not a seek through a stream. The
//  lightest rendition tall enough for the stills is used.
//
//  THE UNIT IS ONE LOCAL HOUR (naming.ts). A 24x7 channel never "ends", so
//  sheets are cut by the clock: ten-minute sheets, an hour's VTT, a folder
//  per hour. The scheduler fills the current hour in every pass, so hover
//  previews trail live by about one pass; finished hours are never touched
//  again. A pass has a time budget; whatever it does not reach, the next pass
//  picks up, because progress is recorded per tile.
//
//  Sheets are re-composited onto their previous image as tiles arrive, and
//  their image URLs carry the tile count as a version, so a CDN can cache
//  every version forever and a hover never shows a stale sheet.
// ============================================================================
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { config, type ThumbnailsConfig } from '../../config';
import { one, query } from '../../db';
import { imageStore } from '../imageStore';
import { originBaseFor } from '../liveOrigin';
import { listRuns, scanRun, type LocalSegment } from '../localRecordingIndex';
import { upsertMediaRow } from '../mediaLibrary';
import { signedImageUrl } from '../../modules/images';
import { isSpriteKey, recordSprite, streamSpriteKey, legacySpritesRemain, relocateLegacySprites } from './spriteStore';
import {
  buildVtt, frameName, hourUnit, safeTz, sheetName, slotsPerSheet, slugify, unitFolder, unitsBetween, vttName,
  type HourUnit, type Layout, type SheetRecord, type UnitRecord,
} from './naming';

export interface StreamInfo {
  kind: 'channel' | 'event';
  id: string;
  accountId: string;
  name: string;
  tz: string;
  slug: string;
}

const cfg = (): ThumbnailsConfig => config.thumbnails;

export function layoutOf(c: ThumbnailsConfig = cfg()): Layout {
  return { tileW: c.tileWidth, tileH: c.tileHeight, cols: c.cols, rows: c.rows, intervalMs: c.tileIntervalSec * 1000 };
}

// ---------------------------------------------------------------- streams
const slugCache = new Map<string, { at: number; names: { id: string; name: string }[] }>();

/** Folder name for a stream: its name, made unique inside the account. */
async function slugFor(accountId: string, id: string, name: string): Promise<string> {
  let c = slugCache.get(accountId);
  if (!c || Date.now() - c.at > 300_000) {
    const names = await query<{ id: string; name: string }>(
      `SELECT c.id, c.name FROM channels c JOIN groups g ON g.id = c.group_id WHERE g.account_id = $1
       UNION ALL SELECT e.id, e.name FROM events e JOIN groups g ON g.id = e.group_id WHERE g.account_id = $1`, [accountId]);
    c = { at: Date.now(), names };
    slugCache.set(accountId, c);
  }
  const base = slugify(name);
  const clash = c.names.some((n) => n.id !== id && slugify(n.name) === base);
  return clash ? `${base}-${id.slice(0, 8)}` : base;
}

export async function streamInfo(id: string): Promise<StreamInfo | null> {
  const r = await one<any>(
    `SELECT 'channel' AS kind, c.id, g.account_id, c.name, c.tz FROM channels c JOIN groups g ON g.id = c.group_id WHERE c.id = $1
     UNION ALL
     SELECT 'event', e.id, g.account_id, e.name, NULL FROM events e JOIN groups g ON g.id = e.group_id WHERE e.id = $1`, [id]);
  if (!r) return null;
  const tz = safeTz(r.tz, safeTz(cfg().defaultTz));
  return { kind: r.kind, id: r.id, accountId: r.account_id, name: r.name, tz, slug: await slugFor(r.account_id, r.id, r.name) };
}

/** Video streams (TV channels and events) with recorded runs on this origin. */
async function streamsWithMaterial(): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT c.id FROM channels c WHERE c.kind = 'tv'
     UNION ALL SELECT e.id FROM events e WHERE e.status IN ('live','ended','provisioning','scheduled')`);
  return rows.map((r) => r.id).filter((id) => { try { return listRuns(id).length > 0; } catch { return false; } });
}

// ---------------------------------------------------------------- frames
function renditionsOf(streamId: string, runId: string): string[] {
  try {
    return readdirSync(join(originBaseFor(streamId), 'runs', runId), { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+p?$/.test(d.name)).map((d) => d.name);
  } catch { return []; }
}

/** The lightest rendition at least `minH` tall (else the tallest). */
export function pickThumbRendition(rends: string[], minH: number): string | null {
  const v = rends.map((r) => ({ r, h: parseInt(r, 10) || 0 })).filter((x) => x.h > 0).sort((a, b) => a.h - b.h);
  if (!v.length) return null;
  return (v.find((x) => x.h >= minH) ?? v[v.length - 1]).r;
}

interface PlacedSegment extends LocalSegment { dir: string }

/** Video segments overlapping [from, to), every run, in time order. */
export function videoSegments(streamId: string, from: number, to: number, minH: number): PlacedSegment[] {
  const out: PlacedSegment[] = [];
  for (const runId of listRuns(streamId)) {
    const rend = pickThumbRendition(renditionsOf(streamId, runId), minH);
    if (!rend) continue;
    const dir = join(originBaseFor(streamId), 'runs', runId, rend);
    for (const s of scanRun(streamId, runId, rend)) {
      if (s.startMs + s.durMs > from && s.startMs < to) out.push({ ...s, dir });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** The segment showing instant `t` (binary search over a sorted list). */
export function segmentAt(segs: PlacedSegment[], t: number): PlacedSegment | null {
  let lo = 0, hi = segs.length - 1, best: PlacedSegment | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].startMs <= t) { best = segs[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return best && t < best.startMs + Math.max(best.durMs, 1) ? best : null;
}

/** Decode the opening keyframe of one segment to a JPEG, `height` tall. */
export function extractJpeg(seg: PlacedSegment, height: number, quality: number, timeoutMs = 8000): Promise<Buffer | null> {
  const init = join(seg.dir, 'init.mp4'), file = join(seg.dir, seg.file);
  if (!existsSync(init) || !existsSync(file)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const q = Math.max(2, Math.min(31, Math.round(31 - (quality / 100) * 29)));
    const ff = spawn(config.clips.ffmpegBin ?? 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', 'pipe:0', '-frames:v', '1',
      '-vf', `scale=-2:${height}`, '-q:v', String(q), '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (buf: Buffer | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ff.kill('SIGKILL'); } catch { /* gone */ }
      resolve(buf && buf.length ? buf : null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    ff.stdout.on('data', (c: Buffer) => chunks.push(c));
    ff.on('close', (code) => finish(code === 0 ? Buffer.concat(chunks) : null));
    ff.on('error', () => finish(null));
    ff.stdin.on('error', () => { /* close resolves */ });
    try { ff.stdin.write(readFileSync(init)); ff.stdin.write(readFileSync(file)); ff.stdin.end(); } catch { finish(null); }
  });
}

// ---------------------------------------------------------------- programmes
interface Prog { title: string; start: number; end: number }

async function programmesBetween(s: StreamInfo, from: number, to: number): Promise<Prog[]> {
  const col = s.kind === 'channel' ? 'channel_id' : 'event_id';
  const rows = await query<any>(
    `SELECT title, COALESCE(actual_start, starts_at) AS s, COALESCE(actual_end, ends_at) AS e
       FROM programmes WHERE ${col} = $1 AND COALESCE(actual_start, starts_at) < $3 AND COALESCE(actual_end, ends_at) > $2
      ORDER BY 2`, [s.id, new Date(from), new Date(to)]);
  return rows.map((r) => ({ title: r.title, start: new Date(r.s).getTime(), end: new Date(r.e).getTime() }));
}
const programmeAt = (ps: Prog[], t: number) => ps.find((p) => p.start <= t && t < p.end) ?? null;

// ---------------------------------------------------------------- one hour
export interface UnitResult { tilesAdded: number; framesAdded: number; status: string; reachedDeadline: boolean }

const libraryKey = (s: StreamInfo, rel: string) => `library/${s.accountId}/${rel}`;

/** Signed URL for a sheet at its full size; `v` is its tile count (cache version). */
export function sheetUrl(key: string, v: number, l: Layout = layoutOf()): string {
  return signedImageUrl(key, `${l.cols * l.tileW}x${l.rows * l.tileH},fill,fmt=jpeg,q=85,v=${v}`);
}

function toUnitRecord(row: any): UnitRecord {
  return {
    tileW: row.tile_w, tileH: row.tile_h, cols: row.cols, rows: row.rows, intervalMs: row.interval_ms,
    unitStart: new Date(row.unit_start).getTime(), unitEnd: new Date(row.unit_end).getTime(), sheets: row.sheets ?? [],
  };
}

/**
 * Bring one hour of one stream up to `upTo`.
 *
 * Only tiles not already filled (or known to be gaps) are extracted. Sheets
 * that gained tiles are re-composited onto their previous image. The hour's
 * VTT is rewritten. Library stills land on the minute (frameIntervalSec).
 */
export async function buildUnit(s: StreamInfo, u: HourUnit, upTo: number, deadline: number, now = Date.now()): Promise<UnitResult> {
  const c = cfg();
  const l = layoutOf(c);
  const res: UnitResult = { tilesAdded: 0, framesAdded: 0, status: 'building', reachedDeadline: false };
  const row = await one<any>(`SELECT * FROM storyboards WHERE stream_id = $1 AND unit_start = $2`, [s.id, new Date(u.start)]);
  if (row?.status === 'complete') return { ...res, status: 'complete' };
  const until = Math.min(upTo, u.end);
  const segs = videoSegments(s.id, u.start, until, c.frameHeight);
  if (!segs.length && !row) return { ...res, status: 'empty' };

  const folder: string = row?.folder ?? unitFolder(s.slug, u);
  const sheets: SheetRecord[] = row?.sheets ?? [];
  const per = slotsPerSheet(l);
  const progs = await programmesBetween(s, u.start, u.end);
  const frameEvery = c.frameIntervalSec * 1000;
  const extracted = new Map<string, Promise<Buffer | null>>();   // one decode per segment
  const touched = new Map<string, { start: number; bytes: number }>();   // sheets written this call (sprite_sheets rows)
  const grab = (seg: PlacedSegment) => {
    const k = `${seg.dir}/${seg.file}`;
    let p = extracted.get(k);
    if (!p) { p = extractJpeg(seg, c.frameHeight, c.frameQuality); extracted.set(k, p); }
    return p;
  };
  // A slot with no material this long after its time is a gap, not "not yet".
  const gapAfter = now - Math.max(10 * 60_000, c.lagSeconds * 1000 * 3);

  for (let si = 0; u.start + si * per * l.intervalMs < until; si++) {
    if (Date.now() > deadline) { res.reachedDeadline = true; break; }
    const sheetStart = u.start + si * per * l.intervalMs;
    let rec = sheets.find((x) => x.start_ms === sheetStart);
    if (!rec) {
      rec = { key: streamSpriteKey(s.accountId, folder, sheetName(s.slug, u, sheetStart, s.tz)), start_ms: sheetStart, slots: per, filled: [], skipped: [] };
      sheets.push(rec);
    }
    const filled = new Set(rec.filled), skipped = new Set(rec.skipped ?? []);
    const todo: { i: number; t: number; seg: PlacedSegment }[] = [];
    for (let i = 0; i < per; i++) {
      const t = sheetStart + i * l.intervalMs;
      if (t >= until || t >= u.end) break;
      if (filled.has(i) || skipped.has(i)) continue;
      const seg = segmentAt(segs, t);
      if (!seg) { if (t < gapAfter) skipped.add(i); continue; }
      todo.push({ i, t, seg });
    }
    if (!todo.length) { rec.skipped = [...skipped].sort((a, b) => a - b); continue; }

    // decode with bounded concurrency
    const frames: (Buffer | null)[] = new Array(todo.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(c.concurrency, todo.length) }, async () => {
      for (;;) {
        const k = next++;
        if (k >= todo.length) return;
        frames[k] = await grab(todo[k].seg);
      }
    }));

    const tiles: OverlayOptions[] = [];
    for (let k = 0; k < todo.length; k++) {
      const { i, t } = todo[k];
      const jpg = frames[k];
      if (!jpg) { if (t < gapAfter) skipped.add(i); continue; }
      const tile = await sharp(jpg).resize(l.tileW, l.tileH, { fit: 'cover' }).toBuffer();
      tiles.push({ input: tile, left: (i % l.cols) * l.tileW, top: Math.floor(i / l.cols) * l.tileH });
      filled.add(i);
      res.tilesAdded++;

      // The library still, on the minute.
      if (frameEvery > 0 && (t - u.start) % frameEvery === 0) {
        const prog = programmeAt(progs, t);
        const name = frameName(prog ? slugify(prog.title) : s.slug, t, s.tz);
        const rel = `${folder}/${name}`;
        const key = libraryKey(s, rel);
        const meta = await sharp(jpg).metadata().catch(() => null);
        await imageStore().put(key, jpg, 'image/jpeg');
        await upsertMediaRow({
          accountId: s.accountId, kind: 'keyframe', path: rel, folder, name, storeKey: key,
          sizeBytes: jpg.length, contentType: 'image/jpeg', tags: ['encoder', 'thumbnail'], source: 'encoder',
          channelId: s.id, capturedAt: new Date(t),
          facts: { width: meta?.width ?? null, height: meta?.height ?? null, contentType: 'image/jpeg', title: prog?.title ?? null },
          extra: { channel: s.name, stream_kind: s.kind, programme: prog?.title ?? null, captured_ms: t },
        });
        res.framesAdded++;
      }
    }

    if (tiles.length) {
      const W = l.cols * l.tileW, H = l.rows * l.tileH;
      // A sheet from before the sprite store (library/...) moves there as it gains tiles.
      const legacy = isSpriteKey(rec.key) ? null : rec.key;
      if (legacy) rec.key = streamSpriteKey(s.accountId, folder, legacy.split('/').pop()!);
      const prev = rec.filled.length ? (await imageStore().get(rec.key)) ?? (legacy ? await imageStore().get(legacy) : null) : null;
      const base = prev ?? await sharp({ create: { width: W, height: H, channels: 3, background: '#000000' } }).jpeg().toBuffer();
      const sheet = await sharp(base).composite(tiles).jpeg({ quality: c.sheetQuality, mozjpeg: true }).toBuffer();
      await imageStore().put(rec.key, sheet, 'image/jpeg');
      if (legacy) {
        await imageStore().delete(legacy).catch(() => { /* already gone */ });
        await query(`DELETE FROM media_files WHERE account_id = $1 AND store_key = $2`, [s.accountId, legacy]);
      }
      touched.set(rec.key, { start: sheetStart, bytes: sheet.length });
    }
    rec.filled = [...filled].sort((a, b) => a - b);
    rec.skipped = [...skipped].sort((a, b) => a - b);
  }

  sheets.sort((a, b) => a.start_ms - b.start_ms);
  const unit: UnitRecord = { ...l, unitStart: u.start, unitEnd: u.end, sheets };
  const vttKey = streamSpriteKey(s.accountId, folder, vttName(s.slug, u));
  const vtt = buildVtt([unit], [{ from: u.start, to: u.end, offset: 0 }], (k, v) => sheetUrl(k, v, l));
  await imageStore().put(vttKey, Buffer.from(vtt), 'text/vtt');
  if (row?.vtt_key && row.vtt_key !== vttKey) await imageStore().delete(row.vtt_key).catch(() => { /* already gone */ });

  const totalSlots = Math.ceil((u.end - u.start) / l.intervalMs);
  const settled = sheets.reduce((n, x) => n + x.filled.length + (x.skipped?.length ?? 0), 0);
  const tiles = sheets.reduce((n, x) => n + x.filled.length, 0);
  res.status = until >= u.end && settled >= totalSlots ? (tiles ? 'complete' : 'empty') : 'building';
  const saved = await one<{ id: string }>(
    `INSERT INTO storyboards (account_id, stream_kind, stream_id, unit_start, unit_end, folder, interval_ms,
       tile_w, tile_h, cols, rows, sheets, vtt_key, tiles, frames, status, built_through)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17)
     ON CONFLICT (stream_id, unit_start) DO UPDATE SET
       sheets = EXCLUDED.sheets, vtt_key = EXCLUDED.vtt_key, tiles = EXCLUDED.tiles,
       frames = storyboards.frames + $15, status = EXCLUDED.status,
       built_through = GREATEST(storyboards.built_through, EXCLUDED.built_through), updated_at = now()
     RETURNING id`,
    [s.accountId, s.kind, s.id, new Date(u.start), new Date(u.end), folder, l.intervalMs, l.tileW, l.tileH,
     l.cols, l.rows, JSON.stringify(sheets), vttKey, tiles, res.framesAdded, res.status, new Date(until)]);
  // The sprite inventory: each sheet written this call, and the hour's VTT.
  const base = { accountId: s.accountId, ownerKind: 'stream' as const, streamKind: s.kind, streamId: s.id, storyboardId: saved?.id ?? null };
  for (const sh of sheets) {
    const t = touched.get(sh.key);
    if (!t) continue;
    await recordSprite({ ...base, storeKey: sh.key, startMs: t.start, intervalMs: l.intervalMs, tileW: l.tileW, tileH: l.tileH,
      cols: l.cols, rows: l.rows, tiles: sh.filled.length, width: l.cols * l.tileW, height: l.rows * l.tileH, sizeBytes: t.bytes });
  }
  await recordSprite({ ...base, kind: 'vtt', storeKey: vttKey, startMs: u.start, sizeBytes: Buffer.byteLength(vtt) });
  return res;
}

// ---------------------------------------------------------------- passes
let passing = false;
const building = new Set<string>();

// Sheets made before the sprite store still in the Image Library: moved a batch per pass
// until none are left (spriteStore.ts relocateLegacySprites). null = not checked yet.
let legacyPending: boolean | null = null;
/** One relocation batch, when sheets with old keys remain. Streams being built are left for the next pass.
 *  Answers whether more remain. */
export async function relocateWhilePending(): Promise<boolean> {
  if (legacyPending === false) return false;
  try {
    if (legacyPending === null) legacyPending = await legacySpritesRemain();
    if (!legacyPending) return false;
    const r = await relocateLegacySprites({ skipStreams: building });
    if (r.hours || r.assets || r.clipVtts || r.libraryRows)
      console.log(`[sprites] moved out of the Image Library: ${r.hours} hour(s), ${r.assets} upload(s), ${r.clipVtts} clip VTT(s), ${r.objects} file(s), ${r.libraryRows} library row(s) dropped${r.missing ? `, ${r.missing} missing` : ''}${r.done ? ' (done)' : ''}`);
    legacyPending = !r.done;
  } catch (e) {
    console.warn('[sprites] relocation batch failed (retried next pass)', e);
    return false;
  }
  return !!legacyPending;
}

export interface PassReport { streams: number; units: number; tiles: number; frames: number; deadline: boolean; ms: number }

/** Build every hour in [from, to) for one stream. Newest hour first. */
export async function buildRange(streamId: string, from: number, to: number, deadline = Date.now() + 15 * 60_000): Promise<PassReport> {
  const t0 = Date.now();
  const r: PassReport = { streams: 1, units: 0, tiles: 0, frames: 0, deadline: false, ms: 0 };
  const s = await streamInfo(streamId);
  if (!s) return r;
  // Whole hours: a request for part of an hour finishes that hour, so it can
  // be marked complete and never revisited.
  const live = Date.now() - cfg().lagSeconds * 1000;
  for (const u of unitsBetween(from, Math.min(to, live), s.tz).reverse()) {
    const x = await buildUnit(s, u, Math.min(u.end, live), deadline);
    if (x.status !== 'empty') r.units++;
    r.tiles += x.tilesAdded; r.frames += x.framesAdded;
    if (x.reachedDeadline || Date.now() > deadline) { r.deadline = true; break; }
  }
  r.ms = Date.now() - t0;
  return r;
}

/** Background build for an operator's request; one per stream at a time. */
export function buildRangeInBackground(streamId: string, from: number, to: number): boolean {
  if (building.has(streamId)) return false;
  building.add(streamId);
  buildRange(streamId, from, to)
    .then((r) => console.log(`[thumbnails] build ${streamId}: ${r.units} hour(s), ${r.tiles} tile(s), ${r.frames} still(s) in ${r.ms} ms`))
    .catch((e) => console.error(`[thumbnails] build ${streamId} failed`, e))
    .finally(() => building.delete(streamId));
  return true;
}

/** The scheduler's pass: finish recent hours and fill the current one, every stream. */
export async function thumbnailPass(now = Date.now()): Promise<PassReport | null> {
  const c = cfg();
  if (!c.enabled || passing) return null;
  passing = true;
  const t0 = Date.now();
  const deadline = t0 + c.passBudgetSeconds * 1000;
  const r: PassReport = { streams: 0, units: 0, tiles: 0, frames: 0, deadline: false, ms: 0 };
  try {
    await relocateWhilePending();
    for (const id of await streamsWithMaterial()) {
      if (building.has(id)) continue;
      const x = await buildRange(id, now - c.lookbackMinutes * 60_000, now, deadline);
      r.streams++; r.units += x.units; r.tiles += x.tiles; r.frames += x.frames;
      if (x.deadline || Date.now() > deadline) { r.deadline = true; break; }
    }
  } finally {
    passing = false;
  }
  r.ms = Date.now() - t0;
  return r;
}

// ---------------------------------------------------------------- retention
/** Delete stills, sheets and VTTs for hours older than the retention period. */
export async function sweepThumbnails(now = Date.now()): Promise<{ hours: number; files: number }> {
  const days = cfg().retentionDays;
  if (!days) return { hours: 0, files: 0 };
  const old = await query<any>(
    // An hour a clip was cut from keeps its stills and sheets: they are the clip's picture
    // of its source, and recording retention keeps that source too (services/media/prune.ts).
    `SELECT sb.id, sb.account_id, sb.folder FROM storyboards sb WHERE sb.unit_end < $1
        AND NOT EXISTS (SELECT 1 FROM clip_segments cs JOIN vod_assets v ON v.id = cs.vod_asset_id
                         WHERE COALESCE(v.channel_id, v.event_id) = sb.stream_id
                           AND cs.source_from_ms < (extract(epoch FROM sb.unit_end) * 1000)
                           AND cs.source_to_ms > (extract(epoch FROM sb.unit_start) * 1000))
      ORDER BY sb.unit_end LIMIT 200`,
    [new Date(now - days * 86400_000)]);
  let files = 0;
  for (const sb of old) {
    // The hour's stills (Image Library) and its sheets and VTT (sprite store; their sprite_sheets rows go with the storyboard row).
    for (const prefix of [`library/${sb.account_id}/${sb.folder}`, streamSpriteKey(sb.account_id, sb.folder, '').replace(/\/$/, '')]) {
      for (const o of await imageStore().list(prefix + '/').catch(() => [])) {
        await imageStore().delete(o.key).catch(() => { /* already gone */ });
        files++;
      }
    }
    await query(
      `DELETE FROM media_files WHERE account_id = $1 AND source = 'encoder' AND (folder = $2 OR folder LIKE $3)`,
      [sb.account_id, sb.folder, sb.folder.replace(/[\\%_]/g, (ch: string) => '\\' + ch) + '/%']);
    await query(`DELETE FROM storyboards WHERE id = $1`, [sb.id]);
    // The hour's folder is empty now; so may be the day's and the channel's (libraryMoves.ts).
    await (await import('../media/libraryMoves')).pruneEmptyFolders(sb.account_id, [sb.folder]).catch((e) => console.warn('[thumbs] empty folders not removed', e));
  }
  // Empty directories anywhere in a local store's library, at most hourly.
  await (await import('../media/libraryMoves')).tidyEmptyDirs().catch(() => 0);
  return { hours: old.length, files };
}

// ---------------------------------------------------------------- reading
/** Storyboard rows for a stream overlapping [from, to). */
export async function unitsFor(streamId: string, from: number, to: number): Promise<(UnitRecord & { vttKey: string | null; status: string; folder: string })[]> {
  const rows = await query<any>(
    `SELECT * FROM storyboards WHERE stream_id = $1 AND unit_end > $2 AND unit_start < $3 ORDER BY unit_start`,
    [streamId, new Date(from), new Date(to)]);
  return rows.map((r) => ({ ...toUnitRecord(r), vttKey: r.vtt_key, status: r.status, folder: r.folder }));
}

export { hourUnit };
