// ============================================================================
//  MIRROR AND ARCHIVE: ASSET SIDECARS AND NIGHTLY COPIES (build queue H3-8,
//  HYBRID_SITES.md "Copy rules": "optionally packaged outputs and sidecars
//  (captions, thumbnails, metadata as JSON)" and "When: ... on a schedule").
//
//  SIDECARS. A copy rule can ask for `what: ['source', 'sidecars']` (or
//  sidecars alone). Beside the original, each target then gets:
//    - `<name>.json`: the asset's metadata, written by Volt, readable by a
//      MAM or an archivist without Volt (kind `volt.asset`);
//    - `<name>.<lang>.<ext>`: each caption file as it was delivered (SRT,
//      WebVTT, TTML), so the archive holds what the customer gave us;
//    - `<name>.<other>`: any other companion file that came with it (an XML
//      or CSV metadata sidecar);
//    - `<name>.<jpg|png|webp>`: the poster.
//  `<name>` is the original's own file name without its extension, so the
//  set sorts together in a folder listing.
//
//  The files are made in the cloud's build folder (as recordings are, H3-7)
//  and handed to the target as ordinary `archive.copy` jobs: same agent code,
//  same read-back and checksum before a copy counts. The cloud's file goes
//  once every copy of it is verified (recordings.ts releaseBuilt).
//
//  One copy of each file per target, as for originals: a sidecar already
//  verified at a target is not copied again when the metadata later changes
//  (archive mode keeps what was copied; mirror mode, H3-10 mirror.ts, follows
//  deletes but not edits).
//
//  NIGHTLY. A rule moment `schedule` copies, once a day, everything the rule
//  governs that the target does not hold yet: what came in before the rule
//  existed, and anything an ingest or publish copy missed. A pass every half
//  hour walks each licensed account's assets in a bounded batch from a
//  cursor (`archive_sweeps`); a whole walk is done once per UTC day, and each
//  copy it queues waits for the rule's off-peak window like any other.
// ============================================================================
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { one, query } from '../../db';
import { imageStore } from '../imageStore';
import { ownedTarget, queueCopyJob, validTimeZone } from './archive';
import { buildDir, sha256File } from './recordings';
import { nameValue, safeFileName, recordingFileName } from './naming';

/** What a copy rule can copy for an asset (clips: H3-9, clips.ts; packages: H3-11, packages.ts). */
export const COPY_WHATS = ['source', 'sidecars', 'clips', 'packages'] as const;
export type CopyWhat = typeof COPY_WHATS[number];

/** One sidecar file of an asset, before it is made. */
export interface SidecarPlan { what: string; fileName: string; make: (dest: string) => Promise<void> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The original's file name without its extension, or the title when there is no original. */
export function baseNameFor(a: { source_key?: string | null; title?: string | null }): string {
  const src = a.source_key ? safeFileName(basename(String(a.source_key).replace(/^s3:\/\/[^/]+\//, '')), a.title || 'asset') : '';
  const base = src ? src.replace(/\.[a-z0-9]{1,10}$/, '') : nameValue(a.title);
  return base || 'asset';
}

// ---- clips (H3-9) -----------------------------------------------------------------

/**
 * A clip is an asset cut from a recording (a clip, a full-event replay or an
 * export): it has no original of its own, only the file clip.extract made
 * under `/clips/<asset id>/`. An upload or a watch folder file is never one.
 */
export const isClipAsset = (a: any) => !!a && !a.source_key && (a.source_kind ?? 'recording') === 'recording';

/**
 * The clip's single file as made: the MP4, or for an audio clip the M4A or
 * MP3, relative to the clips folder. Null while it is being built, when the
 * build failed, or when only the HLS package was asked for (packaged outputs
 * are a copy source of their own). Pure.
 */
export function clipFileOf(a: any): { rel: string; ext: string } | null {
  if (!isClipAsset(a)) return null;
  for (const k of [a.progressive_key, a.export_mp4_key, a.export_m4a_key, a.export_mp3_key]) {
    const m = typeof k === 'string' ? /^\/clips\/([0-9a-f-]{36})\/([A-Za-z0-9._-]+)$/i.exec(k) : null;
    if (m && m[1].toLowerCase() === String(a.id).toLowerCase()) return { rel: `${m[1]}/${m[2]}`, ext: extOf(m[2]) || 'mp4' };
  }
  return null;
}

/**
 * A clip's name at the target follows Christian's rule for recordings,
 * `Title-Channel-YYYYMMDD-HHMM` in the channel's time zone, from where the
 * clip starts: two clips with the same title stay apart, and a clip sorts
 * beside the programme file it was cut from.
 */
export async function clipBaseName(a: any): Promise<string> {
  const s = await one<any>(
    `SELECT name, tz FROM channels WHERE id = $1 UNION ALL SELECT name, NULL::text AS tz FROM events WHERE id = $2 LIMIT 1`,
    [a.channel_id ?? null, a.event_id ?? null]).catch(() => null);
  const name = recordingFileName({
    title: a.title, channel: s?.name ?? '', start: Number(a.start_epoch_ms) || 0,
    timeZone: s?.tz && validTimeZone(s.tz) ? s.tz : 'UTC', ext: 'x',
  }).replace(/\.x$/, '');
  return name || baseNameFor(a);
}

/** The metadata sidecar: what the asset is, in words that need no Volt to read. */
export function assetSidecar(a: any, files: any[], baseName: string) {
  const md = a.metadata && typeof a.metadata === 'object' ? a.metadata : {};
  return {
    kind: 'volt.asset', version: 1,
    asset: {
      id: a.id, title: a.title ?? null,
      description: md.description ?? md.synopsis ?? null,
      durationMs: a.duration_ms ?? null,
      sourceKind: a.source_kind ?? null,
      createdAt: a.created_at ? new Date(a.created_at).toISOString() : null,
      original: a.source_key ? { fileName: safeFileName(basename(String(a.source_key).replace(/^s3:\/\/[^/]+\//, '')), a.title || 'asset'), sha256: a.sha256 ?? null } : null,
    },
    // A clip (H3-9) says which file it describes and where it was cut from.
    ...(clipFileOf(a) ? { clip: {
      fileName: `${baseName}.${clipFileOf(a)!.ext}`,
      stream: a.channel_id ? { kind: 'channel', id: a.channel_id } : a.event_id ? { kind: 'event', id: a.event_id } : null,
      from: Number.isFinite(Number(a.start_epoch_ms)) && Number(a.start_epoch_ms) > 0 ? new Date(Number(a.start_epoch_ms)).toISOString() : null,
      to: Number.isFinite(Number(a.end_epoch_ms)) && Number(a.end_epoch_ms) > 0 ? new Date(Number(a.end_epoch_ms)).toISOString() : null,
    } } : {}),
    metadata: md,
    captions: files.filter((f) => f.kind === 'captions').map((f) => ({
      fileName: captionName(baseName, f), language: f.language ?? null, label: f.label ?? null, format: f.format,
      default: !!f.is_default, forced: !!f.forced, sdh: !!f.sdh, offsetMs: f.offset_ms ?? 0,
    })),
    madeAt: new Date().toISOString(),
  };
}

const extOf = (s: string) => { const m = /\.([a-z0-9]{1,10})$/i.exec(s); return m ? m[1].toLowerCase() : ''; };

/** `<base>.<lang>.<format>`, with a short id when two caption files share a language and format. */
function captionName(base: string, f: any): string {
  const lang = nameValue(f.language) || 'und';
  const ext = nameValue(f.format) && f.format !== 'unknown' ? nameValue(f.format).toLowerCase() : (extOf(f.name) || 'txt');
  return `${base}.${lang}${f._dup ? '.' + String(f.id).slice(0, 8) : ''}.${ext}`;
}

/**
 * The sidecar files an asset has: always its metadata, then its captions and
 * companion files and its poster when it has them. Pure apart from the
 * database reads; nothing is written until `make` is called.
 */
export async function planSidecars(a: any): Promise<SidecarPlan[]> {
  // A clip's sidecars are named after the clip's file (H3-9), so they sort together.
  const base = clipFileOf(a) ? await clipBaseName(a) : baseNameFor(a);
  const files = await query<any>(
    `SELECT id, kind, format, name, store_key, language, label, is_default, forced, sdh, offset_ms
       FROM vod_asset_files WHERE asset_id = $1 ORDER BY created_at, id`, [a.id]).catch(() => [] as any[]);
  const seen = new Map<string, number>();
  for (const f of files) if (f.kind === 'captions') { const k = `${f.language}|${f.format}`; seen.set(k, (seen.get(k) ?? 0) + 1); }
  for (const f of files) if (f.kind === 'captions' && (seen.get(`${f.language}|${f.format}`) ?? 0) > 1) f._dup = true;

  const fromStore = (key: string) => async (dest: string) => {
    const buf = await imageStore().get(key);
    if (!buf) throw new Error(`${key} is not in the image store`);
    writeFileSync(dest, buf);
  };
  const plans: SidecarPlan[] = [{
    what: 'metadata', fileName: `${base}.json`,
    make: async (dest) => { writeFileSync(dest, JSON.stringify(assetSidecar(a, files, base), null, 2) + '\n'); },
  }];
  for (const f of files) {
    if (!f.store_key) continue;
    if (f.kind === 'captions') plans.push({ what: `captions:${f.id}`, fileName: captionName(base, f), make: fromStore(f.store_key) });
    else plans.push({ what: `companion:${f.id}`, fileName: `${base}.${safeFileName(f.name, 'companion')}`, make: fromStore(f.store_key) });
  }
  if (a.poster_key) {
    const ext = extOf(String(a.poster_key)) || 'jpg';
    plans.push({ what: 'poster', fileName: `${base}.${ext}`, make: fromStore(String(a.poster_key)) });
  }
  return plans;
}

export async function ownedAsset(accountId: string, assetId: string) {
  if (!UUID.test(String(assetId))) return null;
  return one<any>(
    `SELECT v.*
       FROM vod_assets v
       LEFT JOIN channels c ON c.id = v.channel_id
       LEFT JOIN events e ON e.id = v.event_id
       LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
      WHERE v.id = $1 AND COALESCE(g.account_id, v.account_id) = $2`, [assetId, accountId]);
}

/**
 * Copy an asset's sidecars to one target. A sidecar already verified there,
 * or on its way, is left alone; one that failed, changed or went missing is
 * made and copied afresh. Returns the copies queued and the ones skipped.
 */
export async function requestSidecarCopies(accountId: string, targetId: string, assetId: string, opts: { runAfter?: Date | null; userId?: string | null; only?: string[] } = {}) {
  const t = await ownedTarget(accountId, targetId);
  if (t.status !== 'active') throw Object.assign(new Error('This storage target is disabled'), { code: 'target_disabled' });
  if (t.site_status !== 'active') throw Object.assign(new Error('The site of this storage target is disabled'), { code: 'site_disabled' });
  const a = await ownedAsset(accountId, assetId);
  if (!a) throw Object.assign(new Error('asset not found'), { code: 'not_found' });

  const queued: string[] = [], kept: string[] = [];
  const dir = join(buildDir(), 'assets', a.id);
  for (const p of await planSidecars(a)) {
    // A clip copy (H3-9) brings only its metadata file; the rest is "sidecars".
    if (opts.only && !opts.only.includes(p.what)) continue;
    const existing = await one<any>(
      `SELECT c.id, c.state, j.state AS job_state FROM archive_copies c LEFT JOIN jobs j ON j.id = c.job_id
        WHERE c.target_id = $1 AND c.vod_asset_id = $2 AND c.what = $3`, [t.id, a.id, p.what]);
    if (existing && (existing.state === 'verified' || (existing.state === 'queued' && ['queued', 'running'].includes(existing.job_state)))) { kept.push(existing.id); continue; }
    // One build folder per file, so two targets fetching the same sidecar
    // read the same bytes and a re-made file never replaces one in flight.
    const fileDir = join(dir, nameValue(p.what.replace(':', '-')) || 'file');
    mkdirSync(fileDir, { recursive: true });
    const path = join(fileDir, p.fileName);
    try { await p.make(path); } catch (e: any) { console.warn(`[archive] sidecar ${p.what} of ${a.id} not made:`, e?.message ?? e); continue; }
    const facts = { bytes: statSync(path).size, sha256: await sha256File(path) };
    const row = await one<any>(
      `INSERT INTO archive_copies (account_id, target_id, vod_asset_id, what, source_uri, file_name, expected_sha256, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT id FROM users WHERE id = $8))
       ON CONFLICT (target_id, vod_asset_id, what) DO UPDATE
         SET source_uri = EXCLUDED.source_uri, file_name = EXCLUDED.file_name, expected_sha256 = EXCLUDED.expected_sha256,
             state = 'queued', stored_path = NULL, sha256 = NULL, bytes = NULL, error = NULL, error_code = NULL,
             copied_at = NULL, verified_at = NULL, checked_at = NULL, verify_job_id = NULL, updated_at = now()
       RETURNING id`,
      [accountId, t.id, a.id, p.what, path, p.fileName, facts.sha256, opts.userId ?? null]);
    await queueCopyJob(t, row.id, { fileName: p.fileName, uri: path, bytes: facts.bytes, sha256: facts.sha256 }, opts.userId ?? null, opts.runAfter ?? null);
    queued.push(row.id);
  }
  return { queued, kept };
}

// ---- nightly (schedule) -------------------------------------------------------------

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * One bounded step of the nightly copies for every licensed account that has
 * an active storage target: the next `limit` assets after the account's
 * cursor, each through `copyOnRule(..., 'schedule')`, which reads the asset's
 * own rule (so only assets whose rule says `schedule` are copied, and an
 * asset's own rung can switch it off). When an account's walk reaches the
 * end it is done for the UTC day; the next day starts again from the top.
 */
export async function scheduledSweep(opts: { now?: Date; limit?: number; accountId?: string } = {}): Promise<{ accounts: number; assets: number; queued: number }> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 200;
  const today = utcDay(now);
  const out = { accounts: 0, assets: 0, queued: 0 };
  const accounts = await query<any>(
    `SELECT a.id FROM accounts a
      WHERE 'mirror_archive' = ANY(COALESCE(a.licences, '{}'))
        AND EXISTS (SELECT 1 FROM archive_targets t JOIN sites s ON s.id = t.site_id WHERE t.account_id = a.id AND t.status = 'active' AND s.status = 'active')
        AND ($1::uuid IS NULL OR a.id = $1)`, [opts.accountId ?? null]);
  const { copyOnRule } = await import('./archive');
  for (const { id: accountId } of accounts) {
    try {
      let cur = await one<any>(`SELECT * FROM archive_sweeps WHERE account_id = $1`, [accountId]);
      if (!cur || utcDay(new Date(cur.day)) !== today) {
        cur = await one<any>(
          `INSERT INTO archive_sweeps (account_id, day, after_created, after_id, done) VALUES ($1, $2::date, NULL, NULL, false)
           ON CONFLICT (account_id) DO UPDATE SET day = EXCLUDED.day, after_created = NULL, after_id = NULL, done = false, updated_at = now()
           RETURNING *`, [accountId, today]);
      }
      if (cur.done) continue;
      out.accounts++;
      const rows = await query<any>(
        `SELECT v.id, v.created_at
           FROM vod_assets v
           LEFT JOIN channels c ON c.id = v.channel_id
           LEFT JOIN events e ON e.id = v.event_id
           LEFT JOIN groups g ON g.id = COALESCE(c.group_id, e.group_id)
           -- The cursor is compared in SQL, at the database's own precision.
           JOIN archive_sweeps sw ON sw.account_id = $1
          WHERE COALESCE(g.account_id, v.account_id) = $1
            AND (sw.after_created IS NULL OR (v.created_at, v.id) > (sw.after_created, sw.after_id))
          ORDER BY v.created_at, v.id
          LIMIT $2`, [accountId, limit]);
      for (const r of rows) {
        out.assets++;
        out.queued += (await copyOnRule(accountId, r.id, 'schedule', now)).queued.length;
      }
      const last = rows[rows.length - 1];
      // The cursor's time is read from the row itself in SQL (and compared
      // in SQL above): a JavaScript Date keeps milliseconds only, and the
      // database's microseconds would put the last asset back after the
      // cursor on the next step.
      await query(
        `UPDATE archive_sweeps SET after_created = COALESCE((SELECT created_at FROM vod_assets WHERE id = $2::uuid), after_created),
                after_id = COALESCE($2::uuid, after_id), done = $3, updated_at = now() WHERE account_id = $1`,
        [accountId, last?.id ?? null, rows.length < limit]);
    } catch (e: any) {
      console.warn(`[archive] nightly copies for account ${accountId} not run:`, e?.message ?? e);
    }
  }
  return out;
}
